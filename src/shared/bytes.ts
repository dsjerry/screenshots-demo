/**
 * IPC 传过来的 Uint8Array 类型是 `Uint8Array<ArrayBufferLike>`，
 * 直接塞给 Blob 会因为 `SharedArrayBuffer` 而类型不符。
 * 这里先复制成一个确定的 `ArrayBuffer`，顺便也保证后续异步编码期间数据不被改写。
 */
export function toBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}
