/**
 * 子进程探针：用当前环境变量（如 HELIU_NO_SANDBOX=1 模拟「建不了写保护沙箱」）建看板 app，
 * 依次请求给定接口，把 JSON 一次性打印到 stdout。用法：bun tests/helpers/board-probe.ts <项目名> <路径>...
 */
import { writeSync } from "node:fs";
import { createBoardApp } from "../../src/board/server.ts";
import { heliuPaths } from "../../src/core/paths.ts";
import { loadProject } from "../../src/core/project.ts";

const [name, ...urls] = process.argv.slice(2);
const paths = heliuPaths();
const { app } = createBoardApp({ paths, project: loadProject(paths, name!) });
const out: Record<string, unknown> = {};
for (const u of urls) out[u] = await (await app.request(u)).json();
// 管道写是异步的，process.exit 会截断 >64KB 的输出：按字节偏移同步写完（同 CLI 的 flushOut）
const buf = Buffer.from(JSON.stringify(out), "utf8");
let off = 0;
while (off < buf.length) {
  try {
    off += writeSync(1, buf, off, buf.length - off);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EAGAIN") break;
    await Bun.sleep(2);
  }
}
process.exit(0);
