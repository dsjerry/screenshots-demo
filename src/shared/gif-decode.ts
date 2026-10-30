/**
 * GIF LZW **解码器** —— 参考实现与自测工具。
 *
 * 存在的意义：编码器的唯一正确性依据是「别的解码器能解回来」。这个解码器
 * 按规范附录 F 逐条转写（码表登记时机、码宽增长时机、KwKwK 情况），编码器
 * 写完先用它逐像素对拍，再用真实解码器（Chrome / Quick Look）验证容器格式。
 *
 * 踩过的坑记在这：`packed` 字节的低 3 位 N 表示全局色表大小为 2^(N+1)，
 * 2 色表必须写 N=0（0x80）；写成别的会**静默**变成「色表大小不符」，
 * Chrome 直接拒绝渲染，而自写解码器因为不校验色表长度照样能解 ——
 * 所以容器格式一定要用真实解码器验证。
 */

export interface LzwDecodeResult {
  indices: Uint8Array;
  /** `eoi` = 正常读完结束码；其余是异常原因 */
  ended: 'eoi' | 'truncated' | 'bad-code';
  badCode?: number;
}

/**
 * 解码一段 GIF LZW 数据（已按子块拼好的连续字节流）。
 *
 * @param data        LZW 数据字节
 * @param minCodeSize 图像描述符里的「最小码长」（2 … 8）
 * @param pixelCount  期望像素数；> 0 时达到即停（容忍末尾多余数据）
 */
export function decodeLzw(data: Uint8Array, minCodeSize: number, pixelCount = 0): LzwDecodeResult {
  const minBits = Math.max(2, Math.min(8, minCodeSize));
  const clearCode = 1 << minBits;
  const eoiCode = clearCode + 1;

  // 词条用「前缀 + 尾字节」表示，展开时沿链回溯 —— 不复制字节串，
  // 否则大图会退化成 O(n²) 的内存增长
  let prefix: number[] = [];
  let suffix: number[] = [];
  let nextCode = 0;
  let width = 0;
  let prevCode = -1;

  // 单独的「已登记」标记：suffix[i] >= 0 不够用 —— 基本码 0..clearCode-1 里
  // 本身就含 0，而清码/结束码这两个槽位的 suffix 也是 -1，靠数值判断会混淆
  let known: boolean[] = [];
  const reset = (): void => {
    prefix = new Array(4096).fill(-1);
    suffix = new Array(4096).fill(-1);
    known = new Array(4096).fill(false);
    for (let i = 0; i < clearCode; i++) {
      suffix[i] = i;
      known[i] = true;
    }
    nextCode = eoiCode + 1;
    width = minBits + 1;
    prevCode = -1;
  };
  reset();

  /**
   * 顺着前缀链展开一个词条。
   *
   * 终止条件必须是「这个码没有前缀」（基本码 prefix = -1），而不是 `cur >= 0`：
   * 基本码 0 的 prefix 是 -1，恰好终止；但若写成 `cur >= 0`，对 prefix 为
   * -1 的槽位就会去读 suffix[-1]（undefined），把词条首字节漏掉。
   */
  const expand = (code: number): number[] => {
    const chain: number[] = [];
    let cur = code;
    let guard = 0;
    while (cur >= 0 && cur < 4096 && guard++ <= 4096) {
      chain.push(suffix[cur]);
      cur = prefix[cur];
    }
    return chain.reverse();
  };

  const out = new Uint8Array(pixelCount > 0 ? pixelCount : data.length * 3);
  let written = 0;
  const push = (bytes: number[]): void => {
    for (const b of bytes) {
      if (written < out.length) out[written++] = b;
      // 超出预期长度说明数据比声明的像素多 —— 截断（真实解码器也这么做）
      else break;
    }
  };

  let bit = 0;
  const totalBits = data.length * 8;
  for (;;) {
    if (bit + width > totalBits) return { indices: out.slice(0, written), ended: 'truncated' };
    let code = 0;
    for (let i = 0; i < width; i++) {
      const pos = bit + i;
      code |= ((data[pos >> 3] >> (pos & 7)) & 1) << i;
    }
    bit += width;

    if (code === clearCode) {
      reset();
      continue;
    }
    if (code === eoiCode) return { indices: out.slice(0, written), ended: 'eoi' };

    let entry: number[];
    // 判断「码表里有没有这个码」用显式的 known 标记（suffix 数值会与基本码 0 混淆），
    // 不能同时要求 `code < nextCode`：nextCode 是「下一个要登记的空位」，
    // 而清码后的基本码 0..clearCode-1 虽然 < nextCode，却是在 nextCode
    // 之外的登记顺序 —— 两条件混用会让紧挨着 2 的幂边界的合法码被判成坏码
    if (code < 4096 && known[code]) {
      entry = expand(code);
    } else if (code === nextCode && prevCode >= 0) {
      // KwKwK：码值恰好等于「下一个要登记的空位」
      const prev = expand(prevCode);
      entry = [...prev, prev[0]];
    } else {
      return { indices: out.slice(0, written), ended: 'bad-code', badCode: code };
    }
    // 注：`suffix[code] >= 0` 已覆盖基本码 0..clearCode-1 与已登记词条
    push(entry);

    // 读完第 n 个码才登记 (prevCode + 首字节)，首码不登记 ——
    // 与编码端「emit 一个码就登记一条」逐码对齐（编码端那条词条的首字节
    // 正是它接下来要读到的字节，所以两边码表大小在任一时刻相等）。
    if (prevCode >= 0 && nextCode < 4096) {
      prefix[nextCode] = prevCode;
      suffix[nextCode] = entry[0];
      known[nextCode] = true;
      nextCode += 1;
      // ★ 解码端的条件与编码端**不同**：这里是规范附录 F 的写法
      // `nextCode == 2^width`，编码端是 `> 2^width`。穷举对拍（enc/dec 各四种
      // 阈值）证明只有这组搭配能闭环；写成同一条会让位宽差一拍。
      if (nextCode === 1 << width && width < 12) width += 1;
    }
    prevCode = code;

    if (pixelCount > 0 && written >= pixelCount) return { indices: out, ended: 'eoi' };
  }
}

/** 把连续字节流切成 GIF 子块（每块 ≤ 255 字节） */
export function splitSubBlocks(data: Uint8Array): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 255) {
    blocks.push(data.subarray(i, Math.min(i + 255, data.length)));
  }
  return blocks;
}
