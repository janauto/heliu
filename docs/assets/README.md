# README 素材：怎么重新生成

本目录存放根目录 `README.md` 用到的截图与终端输出，以及生成它们的脚本。项目界面或输出改了之后，按下面的命令重新生成即可。所有命令都在**仓库根目录**执行。

| 文件 | 内容 | 怎么来的 |
|---|---|---|
| `start-page-light.png` | 看板「开始」页，浅色（README「不碰终端就能上手」） | `shots.py` |
| `galaxy-dark.png` | 看板「星图」，深色 1440 宽（README 与教程） | `shots.py` |
| `board-overview-light.png` / `board-overview-dark.png` | 看板「总览」，浅色 / 深色（README 首图，随系统配色切换） | `shots.py` |
| `board-columns-dark.png` | 看板「版本列」，深色 | `shots.py` |
| `board-release-light.png` | 看板「合并预演」，浅色 | `shots.py` |
| `board-mobile-375.png` | 看板「总览」，手机宽度 375 | `shots.py` |
| `board-drag-reserve.jpg` | 拖卡片改预约后的提示条 | 复制自 `docs/04-验收记录/截图/M3-拖拽改预约.jpg`（M3 验收时手测截图，顶栏文案是当时的旧版） |
| `cli-status.txt` | `bin/heliu status --project 磁吸背夹` 的真实输出（截到「现在最该做的」） | `cli-status.sh` |

## 1. 看板截图（`shots.py`）

```bash
# 终端 A：启动看板（已经在跑就跳过；端口被占时换一个，并把下面的 --base-url 改成同一端口）
bin/heliu board --project 磁吸背夹 --port 7788 --no-open

# 终端 B：截图（约 40 秒）
pip3 install playwright pillow     # 已装过可跳过
python3 docs/assets/shots.py --base-url http://127.0.0.1:7788 --project 磁吸背夹
```

- 浏览器优先用本机 Google Chrome；没有 Chrome 时先跑 `python3 -m playwright install chromium`。
- 截图按 2 倍像素截取，再缩到最长边 1600（手机图 1100）并量化成 256 色 PNG，单张约 50–120 KB。
- 脚本只通过 URL 切换页面（`#/overview`、`#/board`、`#/release`），不点「登记」「生成合并单」「同步」，也不拖卡片，因此不会写台账。
- 拖拽改预约会写台账，脚本不重拍 `board-drag-reserve.jpg`；要更新这张图，请在测试项目上手动拖一次再截。

## 2. 终端输出（`cli-status.sh`）

```bash
sh docs/assets/cli-status.sh            # 缺省项目「磁吸背夹」；其他项目：sh docs/assets/cli-status.sh <项目名>
```

生成后把 `cli-status.txt` 的内容贴回 README「终端里也能看」一节的代码块。`heliu status` 对被管理仓库只读。

## 3. 没有用到的工具

- **vhs / asciinema**：本机未安装，所以终端演示用静态代码块（真实输出），没有录 GIF。装了 vhs 之后可以补一个 `.tape` 脚本。
- **Mermaid**：架构图直接写在 README 里，GitHub 原生渲染，不需要导出图片。
