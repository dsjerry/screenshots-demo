import type { HistoryEntryInfo } from '../shared/types';

/**
 * 截图历史窗口：列表 + 每条的 复制 / 贴图 / 保存 / 删除。
 * 缩略图按条目惰性拉取（dataURL），操作走 history:action。
 * 列表按天分组（今天 / 昨天 / 日期），条目带尺寸、时间与来源应用。
 */

const listEl = document.getElementById('list') as HTMLDivElement;
const emptyEl = document.getElementById('empty') as HTMLDivElement;

function button(label: string, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  return b;
}

function dayLabel(time: number): string {
  const d = new Date(time);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return '今天';
  if (same(d, yesterday)) return '昨天';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

async function refresh(): Promise<void> {
  const entries: HistoryEntryInfo[] = await window.api.history.boot();
  emptyEl.hidden = entries.length > 0;
  const nodes: Node[] = [];
  let lastDay = '';
  for (const entry of entries) {
    const day = dayLabel(entry.time);
    if (day !== lastDay) {
      // 按天分组：跨天时插一条组头
      lastDay = day;
      const header = document.createElement('div');
      header.className = 'day-header';
      header.textContent = day;
      nodes.push(header);
    }

    const item = document.createElement('div');
    item.className = 'item';

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    void window.api.history.thumb(entry.id).then((url) => {
      img.src = url;
    });
    item.append(img);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = `${entry.width} × ${entry.height}`;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = (entry.app ? `${entry.app} · ` : '') + new Date(entry.time).toLocaleTimeString();
    meta.append(dims, time);
    item.append(meta);

    const ops = document.createElement('div');
    ops.className = 'ops';
    const copy = button('复制');
    copy.addEventListener('click', () => {
      void window.api.history.action({ kind: 'copy', id: entry.id });
    });
    const pin = button('贴图');
    pin.addEventListener('click', () => {
      void window.api.history.action({ kind: 'pin', id: entry.id });
    });
    const save = button('保存');
    save.addEventListener('click', () => {
      void window.api.history.action({ kind: 'save', id: entry.id });
    });
    const del = button('删除', 'danger');
    del.addEventListener('click', () => {
      void window.api.history.action({ kind: 'delete', id: entry.id }).then(refresh);
    });
    ops.append(copy, pin, save, del);
    item.append(ops);

    nodes.push(item);
  }
  listEl.replaceChildren(...nodes);
}

void refresh();
