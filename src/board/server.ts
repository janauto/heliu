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
import { runDoctor } from "../core/doctor.ts";
import { readCodexTasks, type CodexTaskOptions } from "../core/codex-tasks.ts";
import { ProjectError, resolveProject, type ProjectConfig } from "../core/project.ts";
import type { BoardEnvelope, BoardMeta, DoctorData, UpdateData, UpdateRunData } from "./api-types.ts";
import { checkUpdate, headOf, runUpdate, UpdateError, type UpdateCheck, type UpdateResult } from "../core/selfupdate.ts";
import { DIST_DIR, ensureWebBuild } from "./build.ts";
import type { BoardService } from "./data.ts";
import { BoardHub } from "./hub.ts";
import { addForBoard, detectForBoard } from "./onboard.ts";
import { HELIU_ROOT } from "./root.ts";
import { VERSION } from "../version.ts";

export const DEFAULT_PORT = 7788;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface BoardAppOptions {
  paths: HeliuPaths;
  /** 默认项目；null / 不传 = 没有默认，页面里选（M6） */
  project?: ProjectConfig | null;
  ttlMs?: number;
  now?: () => Date;
  distDir?: string;
  /** F-0004 检查更新作用的代码目录（默认合流自己的代码目录；测试指向临时克隆） */
  updateRoot?: string;
  /** 检查更新结果缓存多久（默认 30 分钟；页面「再检查」带 fresh=1 绕过） */
  updateTtlMs?: number;
  /** 可覆盖本机数据源以进行隔离测试；不通过 HTTP 接受任意文件路径。 */
  codex?: CodexTaskOptions;
}

function hostAllowed(host: string | undefined): boolean {
  if (!host) return true; // 非浏览器客户端（curl 总会带 Host；app.request 测试可能不带）
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
  return LOCAL_HOSTS.has(name.toLowerCase());
}

const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "yes";

export function createBoardApp(opts: BoardAppOptions): { app: Hono; service: BoardService | null; hub: BoardHub } {
  const hub = new BoardHub({ paths: opts.paths, project: opts.project ?? null, ttlMs: opts.ttlMs, now: opts.now });
  const dist = opts.distDir ?? DIST_DIR;
  const app = new Hono();
  /** 项目级接口：?project=<名> 选项目，不带时用默认项目 */
  const svc = (c: Context) => hub.service(c.req.query("project"));

  const send = <T>(c: Context, command: string, data: T, meta: BoardMeta | null = null, status: 200 | 201 = 200, service: BoardService | null = null) => {
    const p = service?.project ?? null;
    const body: BoardEnvelope<T> = {
      schemaVersion: SCHEMA_VERSION,
      command,
      generatedAt: new Date().toISOString(),
      project: p ? { name: p.name, source: p.source } : null,
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

  /* ───────────── M6：项目中枢 / 环境检查 / 接入向导（不分项目） ───────────── */

  app.get("/api/projects", (c) => send(c, "project.list", hub.projects()));
  app.get("/api/doctor", async (c) => {
    const full = truthy(c.req.query("full"));
    const t0 = performance.now();
    const checks = await runDoctor(opts.paths, c.req.query("project") || undefined, 8000, { skipClaude: !full });
    const counts = { ok: 0, warn: 0, fail: 0 };
    for (const k of checks) counts[k.level] += 1;
    return send<DoctorData>(c, "doctor", { checks, full, ms: Math.round(performance.now() - t0), counts });
  });
  app.post("/api/projects/detect", async (c) => send(c, "project.detect", await detectForBoard(opts.paths, await body(c))));
  app.post("/api/projects", async (c) => {
    const r = await addForBoard(opts.paths, await body(c));
    hub.forget(r.project.name);
    return send(c, "project.add", r, null, 201);
  });

  /* ───────────── F-0004：检查更新 / 一键更新（只作用于合流自己的代码目录，不碰被管理仓库） ───────────── */

  // HELIU_UPDATE_ROOT：演练用，让看板对一份临时克隆检查 / 更新，不碰真的代码目录
  const updateRoot = opts.updateRoot ?? (process.env.HELIU_UPDATE_ROOT || HELIU_ROOT);
  const updateTtl = opts.updateTtlMs ?? 30 * 60_000;
  const updateAudit = join(opts.paths.heliuHome, "self-update.log");
  // 看板启动时的提交 = 正在运行的代码；之后磁盘上的代码变了（一键更新或终端 git pull）就提示重启
  const running = headOf(updateRoot);
  let lastCheck: { at: number; data: UpdateCheck } | null = null;
  let checking: Promise<UpdateCheck> | null = null;
  let updating = false;
  let lastResult: UpdateResult | null = null;
  const getCheck = async (fresh: boolean): Promise<UpdateCheck> => {
    if (!fresh && lastCheck && Date.now() - lastCheck.at < updateTtl) return lastCheck.data;
    checking ??= checkUpdate(updateRoot)
      .then((data) => {
        lastCheck = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        checking = null;
      });
    return checking;
  };
  app.get("/api/update", async (c) => {
    const [check, run, onDisk] = await Promise.all([getCheck(truthy(c.req.query("fresh"))), running, headOf(updateRoot)]);
    const needsRestart = !!run && !!onDisk && run !== onDisk;
    return send<UpdateData>(c, "update.check", { check, running: run, onDisk, needsRestart, updating, last: lastResult });
  });
  app.post("/api/update/run", async (c) => {
    await body(c);
    if (updating) throw new ProjectError("正在更新，等这一次做完");
    updating = true;
    try {
      const result = await runUpdate(updateRoot, { auditFile: updateAudit });
      lastResult = result;
      lastCheck = null;
      return send<UpdateRunData>(c, "update.run", { result });
    } catch (e) {
      if (e instanceof UpdateError) throw new ProjectError(e.message);
      throw e;
    } finally {
      updating = false;
    }
  });

  /* ───────────── 只读（项目级） ───────────── */

  app.get("/api/codex-tasks", async (c) => {
    const s = svc(c);
    return send(c, "codex.tasks", await readCodexTasks(s.project, opts.codex), null, 200, s);
  });

  app.get("/api/status", async (c) => {
    const s = svc(c);
    const r = await s.status(truthy(c.req.query("precheck")), truthy(c.req.query("fresh")));
    return send(c, "status", r.data, r.meta, 200, s);
  });
  app.get("/api/sessions", async (c) => {
    const s = svc(c);
    const r = await s.sessions();
    return send(c, "sessions", r.data, r.meta, 200, s);
  });
  app.get("/api/hygiene", async (c) => {
    const s = svc(c);
    const r = await s.hygiene();
    return send(c, "hygiene", r.data, r.meta, 200, s);
  });
  app.get("/api/milestones", (c) => {
    const s = svc(c);
    return send(c, "milestone.list", s.milestones(), null, 200, s);
  });
  app.get("/api/features", async (c) => {
    // 版本列默认试合（灯色要分出「有冲突」）；precheck=0 时冲突「未检查」
    const s = svc(c);
    const pc = c.req.query("precheck");
    const r = await s.features(c.req.query("milestone") ?? null, pc === undefined ? true : truthy(pc));
    return send(c, "feature.list", r.data, r.meta, 200, s);
  });
  app.get("/api/features/:id/baseline", async (c) => {
    const s = svc(c);
    return send(c, "feature.baseline", await s.baseline(c.req.param("id")), null, 200, s);
  });
  app.get("/api/todo", async (c) => {
    const s = svc(c);
    const r = await s.todo(c.req.query("milestone") ?? "下一版", truthy(c.req.query("precheck")));
    return send(c, "milestone.todo", r.data, r.meta, 200, s);
  });
  app.get("/api/overview", async (c) => {
    const s = svc(c);
    const r = await s.overview(truthy(c.req.query("precheck")));
    return send(c, "overview", r.data, r.meta, 200, s);
  });
  app.get("/api/release/preview", async (c) => {
    const s = svc(c);
    const r = await s.releasePreview(c.req.query("milestone") ?? "下一版");
    return send(c, "release.preview", r.data, r.meta, 200, s);
  });

  /* ───────────── 写台账（项目级） ───────────── */

  app.post("/api/features", async (c) => {
    const s = svc(c);
    const b = await body(c);
    // M7：带 bind: {repo, branch} = 从分支建卡（星图把没卡的分支拖到版本行星）
    if (b.bind && typeof b.bind === "object") {
      return send(c, "feature.add", await s.addFeatureFromBranch({ title: b.title, milestone: b.milestone, bind: b.bind as Record<string, unknown>, type: b.type, module: b.module }), null, 201, s);
    }
    return send(c, "feature.add", s.addFeature(b), null, 201, s);
  });
  app.post("/api/features/:id/bind", async (c) => {
    const s = svc(c);
    return send(c, "feature.bind", await s.bindFeature(c.req.param("id"), await body(c)), null, 200, s);
  });
  /* M8：合并闭环 */
  app.post("/api/release/prompt", async (c) => {
    const s = svc(c);
    const b = await body(c);
    const ms = typeof b.milestone === "string" && b.milestone.trim() ? b.milestone : "下一版";
    return send(c, "release.prompt", await s.releasePrompt(ms), null, 200, s);
  });
  app.get("/api/merged", async (c) => {
    const s = svc(c);
    return send(c, "merged", await s.merged(true, null), null, 200, s);
  });
  app.post("/api/merged", async (c) => {
    const s = svc(c);
    const b = await body(c);
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => String(x)) : null;
    if (!ids || !ids.length) throw new ProjectError("请给出要同步的卡号 ids（先 GET /api/merged 看建议）");
    return send(c, "merged", await s.merged(false, ids), null, 200, s);
  });
  // M9 跨仓配对：建议（从缓存现算）、分析对话记录（后台）、确认写入（只写台账）
  app.get("/api/pairings", async (c) => {
    const s = svc(c);
    return send(c, "pairings", await s.pairings(), null, 200, s);
  });
  app.post("/api/pairings/analyze", async (c) => {
    const s = svc(c);
    const b = await body(c);
    return send(c, "pairings.analyze", s.analyzePairings(b.force === true), null, 200, s);
  });
  app.post("/api/pairings", async (c) => {
    const s = svc(c);
    return send(c, "pairings.confirm", await s.confirmPairings(await body(c)), null, 200, s);
  });
  app.post("/api/project/label", async (c) => {
    const s = svc(c);
    return send(c, "project.label", s.setLabel(await body(c)), null, 200, s);
  });
  app.post("/api/release/decision", async (c) => {
    const s = svc(c);
    return send(c, "release.decision", await s.releaseDecision(await body(c)), null, 200, s);
  });
  app.patch("/api/features/:id", async (c) => {
    const s = svc(c);
    return send(c, "feature.update", s.patchFeature(c.req.param("id"), await body(c)), null, 200, s);
  });
  app.post("/api/sync", async (c) => {
    const s = svc(c);
    const b = await body(c);
    const dry = b.dry_run ?? b.dryRun;
    return send(c, "sync", await s.sync(dry === true || dry === "true" || dry === 1), null, 200, s);
  });
  app.post("/api/release/plan", async (c) => {
    const s = svc(c);
    const b = await body(c);
    const ms = typeof b.milestone === "string" && b.milestone.trim() ? b.milestone : "下一版";
    return send(c, "release.plan", await s.releasePlan(ms), null, 201, s);
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

  return { app, service: hub.defaultService(), hub };
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
  // M6：指定了 --project 就必须能加载；没指定时识别不出项目也照常启动，页面「开始」里选项目或接入新项目
  let project: ProjectConfig | null = null;
  if (opts.projectName) project = await resolveProject(opts.paths, opts.projectName, opts.cwd);
  else {
    try {
      project = await resolveProject(opts.paths, undefined, opts.cwd);
    } catch (e) {
      if (!(e instanceof ProjectError)) throw e;
      dbg(`没有默认项目：${e.message}`);
    }
  }
  if (project) {
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
  }
  const port = opts.port ?? DEFAULT_PORT;
  const base = `http://127.0.0.1:${port}/`;
  /** 打开浏览器；返回是否真的发起了打开（--no-open 时不打开，返回 false） */
  const openUrl = (u: string): boolean => {
    if (opts.open === false) return false;
    try {
      Bun.spawn({ cmd: ["open", u], stdout: "ignore", stderr: "ignore" });
      return true;
    } catch {
      log(`  （没能自动打开浏览器，请手动打开 ${u}）`);
      return false;
    }
  };
  const withProject = (b: string) => (opts.projectName && project ? `${b}?project=${encodeURIComponent(project.name)}` : b);
  // M6：端口上已经是合流看板（例如双击了两次启动脚本）→ 直接打开它，不报错。
  // 它和这条命令的版本 / 代码目录不同时如实写出来；只有真的打开了浏览器才说「已为你打开浏览器」。
  const reuse = (running: RunningBoard) => {
    const u = withProject(base);
    for (const l of runningBoardLines({ url: u, port, running, current: { version: VERSION, root: HELIU_ROOT } })) log(l);
    if (openUrl(u)) log("  已为你打开浏览器。");
  };
  // 先探测端口、再决定打不打包：旧看板每次请求都从磁盘读前端文件，在同一个目录里先重新打包，
  // 会把旧看板正在用的前端换成新代码的（后端却还是旧的）。
  dbg(`探测 127.0.0.1:${port} 上是否已有合流看板…`);
  const already = await probeBoard(base);
  if (already) {
    dbg(`已有合流看板（版本 ${already.version ?? "未报"}），复用，不打包`);
    reuse(already);
    return;
  }
  dbg("检查前端打包…");
  const build = await ensureWebBuild();
  dbg(`前端${build.built ? `已重新打包（${build.ms} ms）` : "沿用已有打包"}：${build.dir}`);
  const { app, hub } = createBoardApp({ paths: opts.paths, project });
  dbg(`监听 127.0.0.1:${port}…`);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, idleTimeout: 120 });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    dbg(`监听失败：${msg}`);
    if (/EADDRINUSE|in use/i.test(msg)) {
      // 探测和监听之间别的看板刚好起来了（例如同时双击两次）
      const running = await probeBoard(base);
      if (running) {
        reuse(running);
        return;
      }
      throw new ProjectError(`端口 ${port} 已被别的程序占用：换一个端口（heliu board --port ${port + 1}），或先关掉占用它的程序`);
    }
    throw e;
  }
  dbg(`已监听 127.0.0.1:${server.port}`);
  dbg("预热开始（后台扫描：不预检 + 预检）");
  hub.warm();
  const url = `http://127.0.0.1:${server.port}/`;
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  log(project ? `合流看板 · ${project.name}` : `合流看板 · 未指定项目（已注册 ${hub.projects().projects.length} 个，页面「开始」里选择或接入）`);
  log(`  地址：${url}（只监听本机）`);
  log(`  前端：${build.built ? `已重新打包（${build.ms} ms）` : "沿用已有打包"} · app.js ${kb(build.sizes["app.js"] ?? 0)} · app.css ${kb(build.sizes["app.css"] ?? 0)}`);
  log("  只读为主：接入项目、登记卡片、改预约只写注册表与台账；合并只预演，执行在终端。按 Ctrl+C（或关掉这个窗口）退出。");
  openUrl(withProject(url));
  const parent = Number(process.env.HELIU_BOARD_PARENT_PID);
  await new Promise<void>((resolve) => {
    let stopped = false;
    let unwatch = () => {};
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unwatch();
      server.stop(true);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (Number.isInteger(parent) && parent > 1) {
      dbg(`跟随父进程 ${parent}：它退出后看板也退出`);
      unwatch = watchParent(parent, () => {
        log("  启动这个看板的合流 App 已经退出，看板跟着退出。");
        stop();
      });
    }
  });
}

/**
 * 合流 App 启动的看板带着环境变量 HELIU_BOARD_PARENT_PID：App 被强退 / 崩溃、没来得及发 TERM 时，
 * 看板发现父进程不在了就跟着退出，不留一个没人管的看板占着端口。返回停止监视的函数。
 */
export function watchParent(pid: number, onGone: () => void, everyMs = 2000): () => void {
  const t = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (e) {
      // EPERM：进程还在，只是不归我们管；只有 ESRCH 才算没了
      if ((e as { code?: string }).code !== "ESRCH") return;
      clearInterval(t);
      onGone();
    }
  }, everyMs);
  return () => clearInterval(t);
}

/** 端口上已在运行的合流看板：它自己报的版本与代码目录（加上版本上报之前的看板 version 为 null） */
export interface RunningBoard {
  version: string | null;
  root: string | null;
}

/** 某个地址上跑的是不是合流看板（/api/projects 返回 project.list）；是就带回它的版本与代码目录，不是返回 null */
async function probeBoard(base: string): Promise<RunningBoard | null> {
  try {
    const r = await fetch(`${base}api/projects`, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json()) as { command?: string; data?: { version?: unknown; heliuRoot?: unknown } };
    if (j?.command !== "project.list") return null;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return { version: str(j.data?.version), root: str(j.data?.heliuRoot) };
  } catch {
    return null;
  }
}

/**
 * 「看板已经在运行」时打印的几行：先写事实（版本、代码目录），再写建议（怎么换成当前代码）。
 * 不含「已为你打开浏览器」——那一行只在真的打开了浏览器之后由 runBoard 补上。
 */
export function runningBoardLines(o: { url: string; port: number; running: RunningBoard; current: { version: string; root: string } }): string[] {
  const lines = [`合流看板已经在运行：${o.url}`];
  const stale = o.running.version !== o.current.version;
  if (stale) {
    lines.push(
      o.running.version
        ? `  正在运行的看板是 ${o.running.version}，这条命令的代码是 ${o.current.version}。`
        : `  正在运行的看板没有报版本号（是加上版本上报之前的旧代码），这条命令的代码是 ${o.current.version}。`,
    );
  }
  if (o.running.root && o.running.root !== o.current.root) lines.push(`  它的代码目录：${o.running.root}（这条命令的：${o.current.root}）`);
  if (stale) {
    lines.push(`  要换成这条命令的代码：先停掉正在运行的看板（在启动它的终端按 Ctrl+C；找不到那个窗口时运行 kill $(lsof -tiTCP:${o.port} -sTCP:LISTEN)），再重新运行这条命令。`);
  }
  lines.push(`  要换端口另起一个：heliu board --port ${o.port + 1}`);
  return lines;
}
