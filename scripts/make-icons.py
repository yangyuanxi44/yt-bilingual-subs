#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成扩展图标。

流程：1024x1024 RGBA 源图（深色圆角方块 + 白色 A + 黄/蓝字幕线条）
      → LANCZOS 缩放到 16 / 32 / 48 / 128 → 写入 src/assets/icons/。

可重复运行（直接覆盖已有文件）：
    python scripts/make-icons.py
或使用 package.json 里的脚本：
    npm run icons
"""
from __future__ import annotations

import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - 环境缺少 Pillow 时给人话提示
    sys.stderr.write('需要 Pillow：请先执行 `python -m pip install pillow`\n')
    raise SystemExit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'src', 'assets', 'icons')
SIZES = (16, 32, 48, 128)
MASTER_SIZE = 1024

# 视觉变量（与扩展主色一致）
COLOR_TOP = (30, 41, 56)       # #1e2938
COLOR_BOTTOM = (10, 14, 21)    # #0a0e15
COLOR_BORDER = (62, 80, 102)
COLOR_LETTER = (247, 250, 252)  # 近白
COLOR_YELLOW = (255, 209, 102)  # #ffd166
COLOR_BLUE = (142, 205, 247)    # #8ecdf7

# 加粗字体候选（Windows 优先，其次 macOS / Linux）
FONT_CANDIDATES = (
    r'C:\Windows\Fonts\arialbd.ttf',
    r'C:\Windows\Fonts\segoeuib.ttf',
    r'C:\Windows\Fonts\msyhbd.ttc',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
)


def load_bold_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """加载一个可用的加粗字体；全部缺失时退回 Pillow 内置位图字体。"""
    for path in FONT_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """竖直线性渐变（先生成 1px 宽的列再横向拉伸，速度快且无接缝）。"""
    column = Image.new('RGB', (1, size))
    pixels = column.load()
    for y in range(size):
        t = y / float(size - 1)
        pixels[0, y] = (
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
        )
    return column.resize((size, size), Image.Resampling.BICUBIC)


def draw_letter(img: Image.Image, draw: ImageDraw.ImageDraw) -> None:
    """居中的白色 A：先画半透明投影，再画主体，保证小尺寸下依然立体。"""
    size = MASTER_SIZE
    font = load_bold_font(628)
    cx, cy = size / 2.0, 398.0
    shadow = (0, 0, 0, 110)
    # 投影：向右下偏移一点，圆润的暗边
    draw.text((cx + 12, cy + 14), 'A', font=font, fill=shadow, anchor='mm')
    draw.text((cx, cy), 'A', font=font, fill=COLOR_LETTER + (255,), anchor='mm')


def draw_subtitle_bars(draw: ImageDraw.ImageDraw) -> None:
    """底部两条字幕线：黄色主行 + 蓝色次行，象征双语字幕。"""
    # 黄色主字幕行
    draw.rounded_rectangle((196, 690, 828, 806), radius=58, fill=COLOR_YELLOW + (255,))
    # 蓝色翻译行（稍短）
    draw.rounded_rectangle((312, 838, 712, 932), radius=47, fill=COLOR_BLUE + (235,))


def build_master() -> Image.Image:
    """构建 1024 源图。"""
    size = MASTER_SIZE
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    # 深色圆角底 + 渐变
    img.paste(vertical_gradient(size, COLOR_TOP, COLOR_BOTTOM), (0, 0), rounded_mask(size, 208))
    draw = ImageDraw.Draw(img, 'RGBA')
    # 细描边让图标在深色/浅色背景下都有边界
    draw.rounded_rectangle((9, 9, size - 10, size - 10), radius=200, outline=COLOR_BORDER + (150,), width=9)
    draw_letter(img, draw)
    draw_subtitle_bars(draw)
    return img


def main() -> int:
    master = build_master()
    os.makedirs(OUT_DIR, exist_ok=True)
    written = []
    for px in SIZES:
        icon = master.resize((px, px), Image.Resampling.LANCZOS)
        path = os.path.join(OUT_DIR, f'icon{px}.png')
        icon.save(path, 'PNG', optimize=True)
        written.append((path, os.path.getsize(path)))
    for path, size in written:
        # 只用 ASCII 输出，避免 Windows 中文控制台（GBK）编码报错
        print(f'[ok] {os.path.relpath(path, ROOT)}  {size} bytes')
    print(f'[ok] generated {len(written)} icons in {os.path.relpath(OUT_DIR, ROOT)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
