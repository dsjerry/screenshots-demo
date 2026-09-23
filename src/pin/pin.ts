import { stitch } from '../shared/stitch';
import { drawShape } from '../annotations/shapes';
import type { PinInitPayload } from '../shared/types';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const closeBtn = document.getElementById('close') as HTMLButtonElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('无法创建 canvas 2d 上下文');

async function exportPng(): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) throw new Error('导出 PNG 失败');
  return new Uint8Array(await blob.arrayBuffer());
}

async function main(): Promise<void> {
  const payload: PinInitPayload | null = await window.api.pin.boot();
  if (!payload) {
    console.warn('[pin] boot 返回 null');
    return;
  }
  console.log(
    `[pin] boot ok selection=${Math.round(payload.selection.width)}x${Math.round(payload.selection.height)}` +
      ` outScale=${payload.outScale} shapes=${payload.initialShapes.length}` +
      ` pad=${JSON.stringify(payload.padding)}`,
  );

  const base = await stitch(payload);
  console.log(`[pin] 拼接完成 ${base.width}x${base.height}`);

  // 四边阴影留白：主进程算的，渲染进程只负责让开画布位置（pin.css 用它做 calc）
  const pad = payload.padding;
  const vars = document.documentElement.style;
  vars.setProperty('--pad-top', `${pad.top}px`);
  vars.setProperty('--pad-right', `${pad.right}px`);
  vars.setProperty('--pad-bottom', `${pad.bottom}px`);
  vars.setProperty('--pad-left', `${pad.left}px`);

  // 画布 backing store = 图像像素（固定不变）；CSS 尺寸 = 窗口 - 四边留白。
  // devicePixelRatio 完全不参与换算，拖到别的 DPI 的屏上也不会错位。
  canvas.width = base.width;
  canvas.height = base.height;

  // 标注直接**烘进画布**：钉图是只读贴图，没有工具条，也就没有「继续编辑」
  ctx.drawImage(base, 0, 0);
  for (const shape of payload.initialShapes) drawShape(ctx, shape);
  if (payload.initialShapes.length > 0) {
    console.log(`[pin] 已绘制标注 ${payload.initialShapes.length} 条`);
  }

  const close = (): void => {
    void window.api.pin.action({ kind: 'close' });
  };
  const copy = async (): Promise<void> => {
    try {
      const res = await window.api.pin.action({
        kind: 'copy',
        png: await exportPng(),
      });
      console.log(res.ok ? '[pin] 已复制' : `[pin] 复制失败 ${res.error}`);
    } catch (err) {
      console.error('[pin] 复制失败', err);
    }
  };

  closeBtn.addEventListener('click', close);
  window.addEventListener('keydown', (event) => {
    // 工具条没了，这两个快捷键搬到这里
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'c'
    ) {
      event.preventDefault();
      void copy();
    }
  });

  // 主进程收到 ready 后才会收起遮罩并显示本窗口（同 tick，不闪白）
  await window.api.pin.ready({ width: base.width, height: base.height });
  console.log('[pin] ready 已发送');
}

void main().catch((err) => {
  console.error('[pin] 初始化失败', err);
});
