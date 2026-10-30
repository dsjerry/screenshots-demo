/**
 * GIF89a 编码器。
 *
 * 为什么自己写：录制动图要**离线**、零额外依赖（与 OCR 走系统引擎的取舍
 * 一致）。这里只做两件事 —— LZW 压缩与容器封装；颜色量化在渲染进程侧做
 * （要先拿到帧像素才能统计颜色，见 `src/record/quantize.ts`）。
 *
 * ## 两个必须牢记的坑（都是实测踩出来的）
 *
 * 1. **全局色表尺寸字段**：`packed` 低 3 位 N 表示表大小为 `2^(N+1)`。
 *    2 色表要写 `N=0`（`0x80`）。写错不会报错，但真实解码器（Chrome /
 *    Quick Look）会**静默拒绝渲染**，而自写解码器因为不校验色表长度照样
 *    能解 —— 所以容器格式只能用真实解码器验证。
 * 2. **GCE flags 写 0x00**：bit0 为 0 表示不启用透明色。写成 `bit0 = 1` 会
 *    让解码器把「透明色索引」那一字节（0）当成生效索引，调色板 0 号色整块
 *    变成透明 —— 症状是画面里所有 0 号色像素显示为背景色（白），
 *    而其余颜色完全正确，极易误判成量化问题。
 * 3. **码宽时序**：编码端写完一个码 → 登记词条 → 判位宽，且只影响下一个码；
 *    解码端是每读完一个码才登记并判位宽。两边必须逐码对齐（`gif-decode.ts`
 *    的解码器与这里做过逐像素对拍）。
 */

export interface Palette {
  /** 调色板颜色数量（2 — 256） */
  size: number;
  /** RGB 三元组连续排布，长度 = size × 3 */
  rgb: Uint8Array;
}

/** 一帧：索引图（每个像素一个调色板下标） */
export interface GifFrame {
  /** 显示时长（毫秒）；编码时按 1/100 秒取整 */
  delay: number;
  /** 索引图，长度 = width × height（行优先） */
  indices: Uint8Array;
}

/** 拼接字节流的小工具（比一连串 push / 展开直观） */
class ByteSink {
  private readonly chunks: Buffer[] = [];
  private length = 0;

  bytes(data: Uint8Array): void {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this.chunks.push(buf);
    this.length += buf.length;
  }

  u8(value: number): void {
    this.chunks.push(Buffer.from([value & 0xff]));
    this.length += 1;
  }

  u16le(value: number): void {
    this.u8(value);
    this.u8(value >> 8);
  }

  ascii(text: string): void {
    this.bytes(Buffer.from(text, 'ascii'));
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

/**
 * LZW 编码（GIF 变体）。
 *
 * 字典用「前缀码 × 256 + 字节」直接当下标 —— 只有 4096 个码位，键 < 2^20，
 * Int32Array 直址表既省内存也没有字符串键的开销（1080p 一帧约 200 万像素，
 * 拼字符串 key 会把编码拖成秒级）。空槽用 -1 标记：码值 0 与 255 都合法。
 */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  // 不能少于 2 位：GIF 规范只允许 ≥ 2
  const minBits = Math.max(2, minCodeSize);
  const clearCode = 1 << minBits;
  const eoiCode = clearCode + 1;

  const table = new Int32Array(1 << 20).fill(-1);
  const out: number[] = [];
  let acc = 0;
  let accBits = 0;
  let width = minBits + 1;
  let nextCode = eoiCode + 1;

  const emit = (code: number): void => {
    acc |= code << accBits;
    accBits += width;
    while (accBits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const byte = indices[i];
    const key = (prefix << 8) | byte;
    const known = table[key];
    if (known >= 0) {
      prefix = known;
      continue;
    }
    emit(prefix);
    if (nextCode < 4096) {
      table[key] = nextCode;
      nextCode += 1;
      // 编码端用 textbook 条件 `nxt > 2^w`；解码端用的是规范写法
      // `nxt == 2^w`（见 gif-decode.ts）。**两边条件必须不同** —— 穷举对拍
      // 证明只有这一组合自洽：否则位宽会比对方早/晚一拍，整条流错位。
      if (nextCode > 1 << width && width < 12) width += 1;
    } else {
      // 码表满：清码重置（清码按当前位宽发出）
      emit(clearCode);
      table.fill(-1);
      width = minBits + 1;
      nextCode = eoiCode + 1;
    }
    prefix = byte;
  }
  emit(prefix);
  emit(eoiCode);
  if (accBits > 0) out.push(acc & 0xff);
  return Uint8Array.from(out);
}

/**
 * 把索引图与调色板封装成完整的 GIF89a。
 *
 * @param width  逻辑屏幕宽度（像素）
 * @param height 逻辑屏幕高度（像素）
 * @param loops  循环次数（0 = 无限循环）
 */
export function encodeGif(width: number, height: number, palette: Palette, frames: GifFrame[], loops = 0): Buffer {
  if (width <= 0 || height <= 0) throw new Error('GIF 尺寸非法');
  if (frames.length === 0) throw new Error('GIF 没有帧');
  // 调色板长度必须与 size 严格一致：少给会让后面的块整体错位一字节，
  // 真实解码器只会报「渲染失败」，极难定位（这里当场拦下）
  if (palette.rgb.length !== palette.size * 3) {
    throw new Error(`调色板长度不符：rgb=${palette.rgb.length} 字节，size=${palette.size} 应为 ${palette.size * 3}`);
  }

  // 全局色表必须是 2 的幂且 ≥ 2：不足的部分补黑
  const tableBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, Math.min(256, palette.size)))));
  const tableSize = 1 << tableBits;
  const minCodeSize = Math.max(2, tableBits);

  const sink = new ByteSink();
  // ---- 文件头 + 逻辑屏幕描述符
  sink.ascii('GIF89a');
  sink.u16le(width);
  sink.u16le(height);
  // bit7 = 有全局色表 | bit6-4 颜色分辨率（这里与表大小同值）| bit3 排序=0
  // | bit2-0 = N，表大小 = 2^(N+1)（★ 写错就静默不渲染，见文件头注释）
  sink.u8(0x80 | ((tableBits - 1) << 4) | (tableBits - 1));
  sink.u8(0); // 背景色索引
  sink.u8(0); // 像素宽高比（0 = 不指定）
  const table = new Uint8Array(tableSize * 3);
  table.set(palette.rgb);
  sink.bytes(table);

  // ---- NETSCAPE 循环扩展（loops = 0 表示无限循环）
  sink.u8(0x21);
  sink.u8(0xff);
  sink.u8(11);
  sink.ascii('NETSCAPE2.0');
  sink.u8(3);
  sink.u8(1);
  sink.u16le(loops);
  sink.u8(0);

  // ---- 逐帧：图形控制扩展 + 图像描述符 + LZW 数据
  for (const frame of frames) {
    if (frame.indices.length !== width * height) throw new Error('GIF 帧尺寸与逻辑屏幕不符');
    sink.u8(0x21);
    sink.u8(0xf9);
    sink.u8(4);
    // flags：**0x00 = 不启用透明色**（实测确认，见文件头第 2 条）。处置方式
    // 0 = 不处置，整帧覆盖即可。
    sink.u8(0x00);
    // 延迟单位是 1/100 秒；0 会被解码器按「尽快」处理（≈100ms），最低给 1
    sink.u16le(Math.max(1, Math.round(frame.delay / 10)));
    sink.u8(0); // 透明色索引（未启用）
    // ★ 子块终止符：GCE = 21 f9 04 + 4 字节负载 + 00，少这一字节会把终止符
    // 当成图像描述符的 0x2C，整条链从这儿错位（真实解码器只会说「渲染失败」）
    sink.u8(0);
    sink.u8(0x2c);
    sink.u16le(0);
    sink.u16le(0);
    sink.u16le(width);
    sink.u16le(height);
    sink.u8(0); // 无局部色表、不交错

    sink.u8(minCodeSize);
    const packed = lzwEncode(frame.indices, minCodeSize);
    // 数据子块每块最多 255 字节，必须以 0 结尾
    for (let i = 0; i < packed.length; i += 255) {
      const chunk = packed.subarray(i, Math.min(i + 255, packed.length));
      sink.u8(chunk.length);
      sink.bytes(chunk);
    }
    sink.u8(0);
  }

  sink.u8(0x3b);
  return sink.finish();
}
