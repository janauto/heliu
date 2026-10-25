/**
 * heliu board：本机看板服务（Hono on Bun，只监听 127.0.0.1）。
 *
 * - /api/*：JSON，外壳 = JsonEnvelope + meta（数据时间/用时/是否命中缓存）。
 * - 写接口只动台账（features/*.md、milestones.yaml、releases/*.md 草稿），绝不动被管理仓库；
 *   合并只预演（merge-tree 在对象隔离区 + 沙箱里试合），执行留给 M4。
 * - 防 DNS rebinding：Host 必须是 127.0.0.1 / localhost / [::1]；写接口必须是 application/json（浏览器跨站表单发不出来）。
 * - createBoardApp 不监听端口，测试直接用 app.request()；runBoard 才起服务。
 */
import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { SCHEMA_VERSION } from "../types.ts";
import type { HeliuPaths } from "../core/paths.ts";
import { Ledger } from "../core/ledger.ts";
import { ProjectError, resolveProject, type ProjectConfig } from "../core/project.ts";
import type { BoardEnvelope, BoardMeta } from "./api-types.ts";
import { DIST_DIR, ensureWebBuild } from "./build.ts";
import { BoardService } from "./data.ts";

export const DEFAULT_PORT = 7788;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface BoardAppOptions {
  paths: HeliuPaths;
  project: ProjectConfig;
  ttlMs?: number;
  now?: () => Date;
  distDir?: string;
}

function hostAllowed(host: string | undefined): boolean {
  if (!host) return true; // 非浏览器客户端（curl 总会带 Host；app.request 测试可能不带）
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
  return LOCAL_HOSTS.has(name.toLowerCase());
}

const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "yes";

export function createBoardApp(opts: BoardAppOptions): { app: Hono; service: BoardService } {
  const service = new BoardService({ paths: opts.paths, project: opts.project, ttlMs: opts.ttlMs, now: opts.now });
  const dist = opts.distDir ?? DIST_DIR;
  const app = new Hono();

  const send = <T>(c: Context, command: string, data: T, meta: BoardMeta | null = null, status: 200 | 201 = 200) => {
    const p = service.project;
    const body: BoardEnvelope<T> = {
      schemaVersion: SCHEMA_VERSION,
      command,
      generatedAt: new Date().toISOString(),
      project: { name: p.name, source: p.source },
      data,
      meta,
    };
    c.header("Cache-Control", "no-store");
    return c.json(body, status);
  };

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* 落到下面的报错 */
    }
    throw new ProjectError("请求体必须是 JSON 对象");
  };

  app.use("*", async (c, next) => {
    if (!hostAllowed(c.req.header("host"))) return c.json({ error: "只接受本机访问（Host 必须是 127.0.0.1 / localhost）" }, 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const ct = c.req.header("content-type") ?? "";
      if (!ct.toLowerCase().startsWith("application/json")) return c.json({ error: "写接口只接受 Content-Type: application/json" }, 415);
    }
    await next();
  });

  app.onError((err, c) => {
    const status = err instanceof ProjectError ? 400 : 500;
    if (status === 500) console.error(`heliu board：${err.stack ?? err}`);
    return c.json({ error: err.message }, status);
  });

  /* ───────────── 只读 ───────────── */

  app.get("/api/status", async (c) => {
    const r = await service.status(truthy(c.req.query("precheck")), truthy(c.req.query("fresh")));
    return send(c, "status", r.data, r.meta);
  });
  app.get("/api/sessions", async (c) => {
    const r = await service.sessions();
    return send(c, "sessions", r.data, r.meta);
  });
  app.get("/api/hygiene", async (c) => {
    const r = await service.hygiene();
    return send(c, "hygiene", r.data, r.meta);
  });
  app.get("/api/milestones", (c) => send(c, "milestone.list", service.milestones()));
  app.get("/api/features", async (c) => {
    // 版本列默认试合（灯色要分出「有冲突」）；precheck=0 时冲突「未检查」
    const pc = c.req.query("precheck");
    const r = await service.features(c.req.query("milestone") ?? null, pc === undefined ? true : truthy(pc));
    return send(c, "feature.list", r.data, r.meta);
  });
  app.get("/api/features/:id/baseline", async (c) => send(c, "feature.baseline", await service.baseline(c.req.param("id"))));
  app.get("/api/todo", async (c) => {
    const r = await service.todo(c.req.query("milestone") ?? "下一版", truthy(c.req.query("precheck")));
    return send(c, "milestone.todo", r.data, r.meta);
  });
  app.get("/api/overview", async (c) => {
    const r = await service.overview(truthy(c.req.query("precheck")));
    return send(c, "overview", r.data, r.meta);
  });
  app.get("/api/release/preview", async (c) => {
    const r = await service.releasePreview(c.req.query("milestone") ?? "下一版");
    return send(c, "release.preview", r.data, r.meta);
  });

  /* ───────────── 写台账 ───────────── */

  app.post("/api/features", async (c) => send(c, "feature.add", service.addFeature(await body(c)), null, 201));
  app.patch("/api/features/:id", async (c) => send(c, "feature.update", service.patchFeature(c.req.param("id"), await body(c))));
  app.post("/api/sync", async (c) => {
    const b = await body(c);
    const dry = b.dry_run ?? b.dryRun;
    return send(c, "sync", await service.sync(dry === true || dry === "true" || dry === 1));
  });
  app.post("/api/release/plan", async (c) => {
    const b = await body(c);
    const ms = typeof b.milestone === "string" && b.milestone.trim() ? b.milestone : "下一版";
    return send(c, "release.plan", await service.releasePlan(ms), null, 201);
  });

  app.all("/api/*", (c) => c.json({ error: `没有这个接口：${c.req.method} ${c.req.path}` }, 404));

  /* ───────────── 前端静态文件 ───────────── */

  const file = (name: string, type: string) => (c: Context) => {
    const p = join(dist, name);
    if (!existsSync(p)) return c.text("看板前端还没有打包：请用 heliu board 启动（会自动打包）", 503);
    return new Response(Bun.file(p), { headers: { "Content-Type": type, "Cache-Control": "no-cache" } });
  };
  app.get("/", file("index.html", "text/html; charset=utf-8"));
  app.get("/index.html", file("index.html", "text/html; charset=utf-8"));
  app.get("/app.js", file("app.js", "text/javascript; charset=utf-8"));
  app.get("/app.css", file("app.css", "text/css; charset=utf-8"));

  return { app, service };
}

export interface RunBoardOptions {
  paths: HeliuPaths;
  projectName?: string;
  cwd: string;
  port?: number;
  open?: boolean;
  log?: (line: string) => void;
}

/**
 * HELIU_DEBUG=1 时逐步往 stderr 打点（同步写，进程卡住也能看到最后一步）：
 * 用来定位桌面应用 launch.json 启动时「进程在、端口没监听、连横幅都没打」的挂起（M5 排查）。
 */
export function debugLogger(env: NodeJS.ProcessEnv = process.env): (step: string) => void {
  if (env.HELIU_DEBUG !== "1") return () => undefined;
  const t0 = performance.now();
  return (step: string) => {
    try {
      writeSync(2, `[heliu board +${Math.round(performance.now() - t0)}ms] ${step}\n`);
    } catch {
      /* stderr 不可写就算了 */
    }
  };
}

/** 起服务并一直运行到 Ctrl+C（main.ts 在 main() 返回后会 process.exit，所以这里不能提前返回） */
export async function runBoard(opts: RunBoardOptions): Promise<void> {
  // 无论是否 HELIU_DEBUG，先往 stderr 打一行：桌面 launch.json 预览下至少能看到进程活着（M5）
  try {
    writeSync(2, "合流看板启动中…（HELIU_DEBUG=1 可看详细阶段）\n");
  } catch {
    /* stderr 不可写就算了 */
  }
  const dbg = debugLogger();
  dbg(`开始：pid=${process.pid} cwd=${opts.cwd} bun=${Bun.version} HELIU_HOME=${opts.paths.heliuHome}`);
  const log = opts.log ?? ((l: string) => console.log(l));
  dbg(`加载项目…（--project=${opts.projectName ?? "未指定，按目录识别"}）`);
  const project = await resolveProject(opts.paths, opts.projectName, opts.cwd);
  dbg(`项目已加载：${project.name}（${project.repos.length} 个仓库，${project.source}）`);
  dbg("读台账…");
  try {
    const ledger = Ledger.of(project);
    const ms = ledger.listMilestones().length;
    const n = ledger.load().features.length;
    dbg(`台账可读：${ledger.dir}（${ms} 个里程碑、${n} 张卡）`);
  } catch (e) {
    dbg(`台账读取失败（不影响启动，页面里会报错）：${(e as Error).message}`);
  }
  dbg("检查前端打包…");
  const build = await ensureWebBuild();
  dbg(`前端${build.built ? `已重新打包（${build.ms} ms）` : "沿用已有打包"}：${build.dir}`);
  const { app, service } = createBoardApp({ paths: opts.paths, project });
  const port = opts.port ?? DEFAULT_PORT;
  dbg(`监听 127.0.0.1:${port}…`);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, idleTimeout: 120 });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    dbg(`监听失败：${msg}`);
    if (/EADDRINUSE|in use/i.test(msg)) throw new ProjectError(`端口 ${port} 已被占用：换一个端口（heliu board --port ${port + 1}），或先关掉占用它的程序`);
    throw e;
  }
  dbg(`已监听 127.0.0.1:${server.port}`);
  dbg("预热开始（后台扫描：不预检 + 预检）");
  service.warm();
  const url = `http://127.0.0.1:${server.port}/`;
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  log(`合流看板 · ${project.name}`);
  log(`  地址：${url}（只监听本机）`);
  log(`  前端：${build.built ? `已重新打包（${build.ms} ms）` : "沿用已有打包"} · app.js ${kb(build.sizes["app.js"] ?? 0)} · app.css ${kb(build.sizes["app.css"] ?? 0)}`);
  log("  只读为主：改预约/改名/放弃只写台账；合并只预演，不执行（M4）。按 Ctrl+C 退出。");
  if (opts.open !== false) {
    try {
      Bun.spawn({ cmd: ["open", url], stdout: "ignore", stderr: "ignore" });
    } catch {
      log(`  （没能自动打开浏览器，请手动打开 ${url}）`);
    }
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop(true);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
