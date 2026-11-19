import { describe, expect, it } from 'vitest';
import { alignFrame, appendRange, MATCH_THRESHOLD, probeStartFor, rowSig, type AccView } from '../src/scroll/match';

// 合成页面：每行在横向也有纹理（像真实网页的文字 / 色块），行与行的签名可区分
const W = 64;

function pixel(r: number, x: number): [number, number, number] {
  return [(r * 7 + x * 13) & 255, (r * 3 + x * 29 + (r >> 4)) & 255, (r * r + x * 5) & 255];
}

function makePage(rows: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(rows * W * 4);
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < W; x++) {
      const [R, G, B] = pixel(r, x);
      const i = (r * W + x) * 4;
      data[i] = R;
      data[i + 1] = G;
      data[i + 2] = B;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** 行内容指纹：整行像素，用来反查它在页面中的行号 */
function rowKey(data: Uint8ClampedArray, row: number): string {
  return Array.from(data.subarray(row * W * 4, (row + 1) * W * 4)).join(',');
}

/** 视口帧：页面 [top, top+h) 行的副本（与控制条收到的 RGBA 帧一样） */
function frameAt(page: Uint8ClampedArray, top: number, h: number): Uint8ClampedArray {
  return page.slice(top * W * 4, (top + h) * W * 4);
}

/**
 * 复刻控制条的帧处理：首帧直接入缓冲；之后对位，失配丢帧，
 * 否则只追加新内容行。返回累积缓冲（像素 + 每行签名）。
 */
function accumulate(frames: Uint8ClampedArray[], h: number): AccView {
  const acc: AccView = { data: new Uint8ClampedArray(0), width: W, height: 0, sigs: [] };
  const append = (strip: Uint8ClampedArray, srcRow: number, count: number): void => {
    const next = new Uint8ClampedArray((acc.height + count) * W * 4);
    next.set(acc.data);
    next.set(strip.subarray(srcRow * W * 4, (srcRow + count) * W * 4), acc.height * W * 4);
    acc.data = next;
    for (let r = 0; r < count; r++) acc.sigs.push(rowSig(strip, srcRow + r, W));
    acc.height += count;
  };

  append(frames[0], 0, h);
  for (let t = 1; t < frames.length; t++) {
    const strip = frames[t];
    const stripSigs: Float32Array[] = [];
    for (let r = 0; r < h; r++) stripSigs.push(rowSig(strip, r, W));
    const probe = probeStartFor(acc.height, h);
    const { bestT, best } = alignFrame(acc, probe, strip, stripSigs, h);
    if (best > MATCH_THRESHOLD) continue; // 失配：丢帧，绝不追加
    const { start, rows } = appendRange(acc.height, probe, bestT, h);
    if (rows > 0) append(strip, start, rows);
  }
  return acc;
}

/** 从累积缓冲读出每一行对应的页面行号（整行内容反查） */
function indicesOf(acc: AccView, page: Uint8ClampedArray, pageRows: number): number[] {
  const lookup = new Map<string, number>();
  for (let r = 0; r < pageRows; r++) lookup.set(rowKey(page, r), r);
  const out: number[] = [];
  for (let r = 0; r < acc.height; r++) {
    const idx = lookup.get(rowKey(acc.data, r));
    if (idx === undefined) throw new Error(`第 ${r} 行不是页面的任何一行`);
    out.push(idx);
  }
  return out;
}

describe('长图拼接：不重复、不乱序', () => {
  const H = 120;
  const PAGE_ROWS = 800;
  const page = makePage(PAGE_ROWS);

  it('慢速滚动：累积结果逐行对应页面，没有重复也没有缺口', () => {
    const frames: Uint8ClampedArray[] = [];
    for (let top = 0; top + H <= 500; top += 30) frames.push(frameAt(page, top, H));
    const acc = accumulate(frames, H);
    const idx = indicesOf(acc, page, PAGE_ROWS);
    expect(idx).toEqual(Array.from({ length: idx.length }, (_, i) => i));
    // 最后一帧覆盖页面 360..479，所以 0..479 行各出现一次
    expect(idx.length).toBe(480);
  });

  it('同一帧反复到达（页面没动）不会追加任何行', () => {
    const f = frameAt(page, 0, H);
    const frames = [f, f, f, f, f];
    const acc = accumulate(frames, H);
    expect(acc.height).toBe(H);
  });

  it('滚动过快导致失配时，丢帧但绝不重复写入已有内容', () => {
    // 步长大到相邻帧几乎不重叠：部分帧会失配被丢弃，允许出现缺口，不允许重复或乱序
    const frames: Uint8ClampedArray[] = [];
    for (let top = 0; top + H <= 700; top += 100) frames.push(frameAt(page, top, H));
    const acc = accumulate(frames, H);
    const idx = indicesOf(acc, page, PAGE_ROWS);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    }
    expect(new Set(idx).size).toBe(idx.length);
  });
});
