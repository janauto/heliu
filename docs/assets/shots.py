#!/usr/bin/env python3
"""重新截取 README 用的看板截图（Playwright，只做页面跳转，不点任何按钮）。

用法（在仓库根目录）：
    bin/heliu board --project 磁吸背夹 --port 7788 --no-open   # 另开一个终端先把看板跑起来
    python3 docs/assets/shots.py                                # 默认截 http://127.0.0.1:7788
    python3 docs/assets/shots.py --base-url http://127.0.0.1:7790

依赖：pip install playwright pillow；浏览器优先用本机 Google Chrome（channel=chrome），
没有就用 Playwright 自带的 chromium（需先 playwright install chromium）。

只读说明：脚本只通过 URL 的 #/start、#/home、#/kanban、#/timeline、#/assembly、#/structure、#/galaxy 切换页面，触发的都是 GET 请求；
不点「登记」「生成合并单」「同步」，也不拖卡片，所以不会写台账。
"""
import argparse
from urllib.parse import quote
import pathlib
import tempfile

from PIL import Image
from playwright.sync_api import sync_playwright

ASSETS = pathlib.Path(__file__).resolve().parent

# 文件名, 页面, 视口宽, 视口高, 配色
SHOTS = [
    ("start-page-light.png", "start", 1280, 820, "light"),
    ("home-light.png", "home", 1440, 900, "light"),
    ("home-dark.png", "home", 1440, 900, "dark"),
    ("kanban-dark.png", "kanban", 1440, 900, "dark"),
    ("timeline-light.png", "timeline", 1440, 900, "light"),
    ("assembly-light.png", "assembly", 1440, 900, "light"),
    ("structure-light.png", "structure", 1440, 900, "light"),
    ("galaxy-dark.png", "galaxy", 1440, 900, "dark"),
    ("board-mobile-375.png", "home", 375, 740, "light"),
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
    ap.add_argument("--project", default="磁吸背夹", help="截哪个项目（看板支持多项目，地址带 ?project=）")
    ap.add_argument("--wait", type=int, default=5000, help="页面加载后再等多少毫秒（看板打开时会自动试合一次）")
    a = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        browser = launch(p)
        for name, tab, w, h, scheme in SHOTS:
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, color_scheme=scheme)
            page = ctx.new_page()
            page.goto(f"{a.base_url}/?project={quote(a.project)}#/{tab}", wait_until="networkidle")
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
