#!/usr/bin/env python3
"""重新截取 README 用的看板截图（Playwright，只做页面跳转，不点任何按钮）。

用法（在仓库根目录）：
    bin/heliu board --project 磁吸背夹 --port 7788 --no-open   # 另开一个终端先把看板跑起来
    python3 docs/assets/shots.py                                # 默认截 http://127.0.0.1:7788
    python3 docs/assets/shots.py --base-url http://127.0.0.1:7790

依赖：pip install playwright pillow；浏览器优先用本机 Google Chrome（channel=chrome），
没有就用 Playwright 自带的 chromium（需先 playwright install chromium）。

只读说明：脚本只通过 URL 的 #/overview（总览）、#/board（版本列）、#/release（合并预演）切换页面，触发的都是 GET 请求；
不点「登记」「生成合并单」「同步」，也不拖卡片，所以不会写台账。
"""
import argparse
import pathlib
import tempfile

from PIL import Image
from playwright.sync_api import sync_playwright

ASSETS = pathlib.Path(__file__).resolve().parent

# 文件名, 页面, 视口宽, 视口高, 配色
SHOTS = [
    ("board-overview-light.png", "overview", 1280, 800, "light"),
    ("board-overview-dark.png", "overview", 1280, 800, "dark"),
    ("board-columns-dark.png", "board", 1280, 800, "dark"),
    ("board-release-light.png", "release", 1280, 800, "light"),
    ("board-mobile-375.png", "overview", 375, 640, "light"),
]


def launch(p):
    try:
        return p.chromium.launch(channel="chrome")
    except Exception:
        return p.chromium.launch()


def compress(src: pathlib.Path, dst: pathlib.Path, max_edge: int) -> None:
    """缩到最长边 max_edge，再量化为 256 色 PNG（界面截图色块少，肉眼看不出差别）。"""
    im = Image.open(src).convert("RGB")
    scale = min(1.0, max_edge / max(im.size))
    if scale < 1.0:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    im = im.quantize(colors=256, method=Image.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG)
    im.save(dst, optimize=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:7788")
    ap.add_argument("--wait", type=int, default=5000, help="页面加载后再等多少毫秒（看板打开时会自动试合一次）")
    a = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        browser = launch(p)
        for name, tab, w, h, scheme in SHOTS:
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, color_scheme=scheme)
            page = ctx.new_page()
            page.goto(f"{a.base_url}/#/{tab}", wait_until="networkidle")
            page.wait_for_timeout(a.wait)
            raw = pathlib.Path(tmp) / name
            page.screenshot(path=str(raw))
            ctx.close()
            out = ASSETS / name
            compress(raw, out, max_edge=1600 if w > 600 else 1100)
            print(f"已保存 {out.relative_to(ASSETS.parent.parent)}（{out.stat().st_size // 1024} KB）")
        browser.close()


if __name__ == "__main__":
    main()
