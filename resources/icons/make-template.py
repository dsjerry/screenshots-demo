#!/usr/bin/env python3
"""从 app.png 派生托盘/菜单栏单色模板图标（一次性工具，换图标后重跑）。

推导规则（与 tray.ts 注释保持一致）：
1. 原图分辨率上按「白度」取软 alpha：白度 = min(R,G,B)/255，
   alpha = smoothstep(0.55, 0.68, 白度) × 原 alpha —— 白卡片/太阳/星光
   不透明，蓝色底与照片透明；
2. **按最大连通域裁剪**：星光悬在卡片右上、与卡片不相连，按全局 bbox
   缩放会被星光撑高 —— 卡片本体只占 bbox 高度 ~78%，托盘里看着小一圈。
   取最大块（卡片）裁剪，星光在 16pt 下只是 2px 噪点，主动舍弃；
3. **满幅**缩放到 32px 画布：macOS 对状态栏图像不做任何内缩，条目间距
   由系统布局负责 —— 图内留白只会缩小墨迹（别套图标设计网格的
   「呼吸边」惯例）。降采样的平均效应顺带把取景框角标、外圈辉光融进卡片；
- app-template.png          白色字形（mac 模板图 + Windows 深色任务栏）；
- app-template-inverse.png  黑色字形（Windows 浅色任务栏）。

用法：python3 make-template.py（需 pillow：python3 -m pip install pillow）
"""

from PIL import Image
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'app.png')
CANVAS = 32
LO, HI = 0.55, 0.68
LABEL_SIZE = 256  # 连通域标记在缩略图上跑，够分开「卡片 vs 星光」且快


def smoothstep(x: float) -> float:
    t = max(0.0, min(1.0, (x - LO) / (HI - LO)))
    return t * t * (3 - 2 * t)


def largest_component_bbox(soft: Image.Image) -> tuple[int, int, int, int]:
    """软 alpha 缩略图上最大 4 邻接连通域的包围盒（原图坐标）。"""
    small = soft.resize((LABEL_SIZE, LABEL_SIZE), Image.LANCZOS)
    solid = small.point(lambda v: 255 if v > 64 else 0)
    data = solid.load()
    seen = [[False] * LABEL_SIZE for _ in range(LABEL_SIZE)]
    best: tuple[int, int, int, int, int] | None = None  # (面积, x0, y0, x1, y1)
    for sy in range(LABEL_SIZE):
        for sx in range(LABEL_SIZE):
            if not data[sx, sy] or seen[sy][sx]:
                continue
            stack = [(sx, sy)]
            seen[sy][sx] = True
            x0 = x1 = sx
            y0 = y1 = sy
            count = 0
            while stack:
                x, y = stack.pop()
                count += 1
                x0, x1 = min(x0, x), max(x1, x)
                y0, y1 = min(y0, y), max(y1, y)
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < LABEL_SIZE and 0 <= ny < LABEL_SIZE and data[nx, ny] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            if best is None or count > best[0]:
                best = (count, x0, y0, x1, y1)
    assert best is not None, '掩码为空：阈值或图标不对'
    _, x0, y0, x1, y1 = best
    k = soft.size[0] / LABEL_SIZE
    return (round(x0 * k), round(y0 * k), round((x1 + 1) * k), round((y1 + 1) * k))


def derive() -> Image.Image:
    im = Image.open(SRC).convert('RGBA')
    px = im.load()
    w, h = im.size
    soft = Image.new('L', (w, h), 0)
    sp = soft.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            sp[x, y] = int(smoothstep(min(r, g, b) / 255.0) * a)
    ink = soft.crop(largest_component_bbox(soft))
    scale = CANVAS / max(ink.size)
    ink = ink.resize((max(1, round(ink.size[0] * scale)), max(1, round(ink.size[1] * scale))), Image.LANCZOS)
    out = Image.new('L', (CANVAS, CANVAS), 0)
    out.paste(ink, ((CANVAS - ink.size[0]) // 2, (CANVAS - ink.size[1]) // 2))
    return out


def main() -> None:
    alpha = derive()
    white = Image.merge('RGBA', [Image.new('L', alpha.size, 255)] * 3 + [alpha])
    white.save(os.path.join(HERE, 'app-template.png'))
    black = Image.merge('RGBA', [Image.new('L', alpha.size, 0)] * 3 + [alpha])
    black.save(os.path.join(HERE, 'app-template-inverse.png'))
    print('written: app-template.png / app-template-inverse.png')


if __name__ == '__main__':
    main()
