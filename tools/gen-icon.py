"""生成 App 图标（无第三方依赖时退回纯色圆角 + 书本图形）"""
from PIL import Image, ImageDraw
import os

BASE = 512
SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ROOT = os.path.join(os.path.dirname(__file__), "..", "android", "app", "src", "main", "res")


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make():
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 渐变底
    top, bottom = (47, 62, 99), (76, 103, 158)
    for y in range(BASE):
        d.line([(0, y), (BASE, y)], fill=lerp(top, bottom, y / BASE) + (255,))
    # 圆角遮罩
    mask = Image.new("L", (BASE, BASE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, BASE, BASE], radius=110, fill=255)
    img.putalpha(mask)

    d = ImageDraw.Draw(img)
    # 光晕
    d.ellipse([300, -120, 640, 220], fill=(255, 255, 255, 22))

    # 书本
    cx, cy = BASE // 2, BASE // 2 + 6
    w, h = 250, 176
    left = cx - w // 2
    top_y = cy - h // 2
    spine = 14

    # 左页
    d.polygon([
        (left, top_y + 16), (cx - spine, top_y), (cx - spine, top_y + h - 6), (left + 10, top_y + h)
    ], fill=(255, 255, 255, 255))
    # 右页
    d.polygon([
        (cx + spine, top_y), (left + w, top_y + 16), (left + w - 10, top_y + h), (cx + spine, top_y + h - 6)
    ], fill=(255, 244, 238, 255))
    # 书脊
    d.rounded_rectangle([cx - spine, top_y + 6, cx + spine, top_y + h - 10], radius=8, fill=(255, 122, 89, 255))
    # 文字线
    for i in range(3):
        y = top_y + 44 + i * 34
        d.rounded_rectangle([cx - 104, y, cx - 26, y + 10], radius=5, fill=(150, 168, 200, 190))
        d.rounded_rectangle([cx + 26, y, cx + 104 - i * 16, y + 10], radius=5, fill=(214, 196, 186, 220))
    # 星点
    for (sx, sy, r) in [(120, 118, 9), (392, 138, 7), (352, 96, 5)]:
        d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=(255, 214, 107, 255))
    return img


def main():
    img = make()
    for dpi, size in SIZES.items():
        p = os.path.join(ROOT, "mipmap-" + dpi)
        os.makedirs(p, exist_ok=True)
        img.resize((size, size), Image.LANCZOS).save(os.path.join(p, "ic_launcher.png"))
        img.resize((size, size), Image.LANCZOS).save(os.path.join(p, "ic_launcher_round.png"))
    print("icons ok")


if __name__ == "__main__":
    main()
