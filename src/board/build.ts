/**
 * 前端打包：web/（Preact + TSX）→ dist/web/{index.html, app.js, app.css}。
 * 启动看板时检查：dist 缺失或 web/ 下任何文件比上次打包新 → 用 Bun.build 重新打包（进程内，约 0.1 s）。
 * 产物不依赖任何 CDN，离线可用；dist/ 已在 .gitignore。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const WEB_DIR = join(REPO_ROOT, "web");
export const DIST_DIR = join(REPO_ROOT, "dist", "web");
const OUTPUTS = ["index.html", "app.js", "app.css"];
const STAMP = ".build-stamp";

function newestMtime(dir: string): number {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) max = Math.max(max, newestMtime(p));
    else max = Math.max(max, statSync(p).mtimeMs);
  }
  return max;
}

export interface BuildResult {
  built: boolean;
  ms: number;
  dir: string;
  /** 各产物字节数 */
  sizes: Record<string, number>;
}

export async function ensureWebBuild(opts: { force?: boolean; webDir?: string; distDir?: string } = {}): Promise<BuildResult> {
  const web = opts.webDir ?? WEB_DIR;
  const dist = opts.distDir ?? DIST_DIR;
  const started = performance.now();
  const sizes = () => Object.fromEntries(OUTPUTS.map((f) => [f, existsSync(join(dist, f)) ? statSync(join(dist, f)).size : 0]));
  const stamp = join(dist, STAMP);
  const fresh =
    !opts.force && existsSync(stamp) && OUTPUTS.every((f) => existsSync(join(dist, f))) && statSync(stamp).mtimeMs >= newestMtime(web);
  if (fresh) return { built: false, ms: Math.round(performance.now() - started), dir: dist, sizes: sizes() };

  mkdirSync(dist, { recursive: true });
  const r = await Bun.build({
    entrypoints: [join(web, "main.tsx")],
    outdir: dist,
    naming: "app.js",
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!r.success) {
    throw new Error(`看板前端打包失败：\n${r.logs.map((l) => String(l)).join("\n")}`);
  }
  copyFileSync(join(web, "index.html"), join(dist, "index.html"));
  copyFileSync(join(web, "styles.css"), join(dist, "app.css"));
  writeFileSync(stamp, new Date().toISOString());
  return { built: true, ms: Math.round(performance.now() - started), dir: dist, sizes: sizes() };
}
