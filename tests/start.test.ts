/**
 * M6：图形化上手入口（看板「开始」页背后的接口）。
 * - 项目中枢：/api/projects、?project= 路由、没有默认项目时的中文报错
 * - 接入向导：detect 只读不写；add 只写 HELIU_HOME（注册表 + 台账），被管理仓库零写入；重复接入保留显示名
 * - doctor 接口：默认跳过无头 claude 探测
 * - runBoard：端口上已经是合流看板时直接复用，不报错、不挂起
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectData, DoctorData, OnboardResult, ProjectsData, SyncView } from "../src/board/api-types.ts";
import { createBoardApp, runBoard } from "../src/board/server.ts";
import { heliuPaths, type HeliuPaths } from "../src/core/paths.ts";
import { addRepoToProject, listProjectNames, loadProject, projectFile, stringifyProject } from "../src/core/project.ts";
import { buildFixture, type Fixture } from "./helpers/fixture.ts";

let fx: Fixture;
let paths: HeliuPaths;
let dist: string;
let app: ReturnType<typeof createBoardApp>["app"];
let before: string;

function treeSnapshot(root: string): string {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const s = statSync(p);
      if (e.isDirectory()) {
        out.push(`${r}/|${s.mtimeMs}`);
        walk(p, r);
      } else out.push(`${r}|${s.mtimeMs}|${s.size}`);
    }
  };
  walk(root, "");
  return out.sort().join("\n");
}

async function get<T>(path: string): Promise<{ status: number; body: { data: T; project: { name: string } | null; error?: string } }> {
  const r = await app.request(path);
  return { status: r.status, body: (await r.json()) as never };
}
async function post<T>(path: string, body: unknown, ct = "application/json"): Promise<{ status: number; body: { data: T; error?: string } }> {
  const r = await app.request(path, { method: "POST", headers: { "Content-Type": ct }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as never };
}

beforeAll(async () => {
  fx = buildFixture();
  paths = heliuPaths({ ...process.env, ...fx.env });
  const reg = await addRepoToProject(paths, { path: fx.repo, name: "演示", integration: "integ", label: "文档仓" });
  writeFileSync(projectFile(paths, "演示"), stringifyProject("演示", reg.project.repos, { ledger: join(fx.root, "演示台账") }));
  dist = mkdtempSync(join(tmpdir(), "heliu-dist-"));
  // 没有默认项目：模拟「heliu board」在仓库外启动、识别不出项目
  ({ app } = createBoardApp({ paths, project: null, distDir: dist }));
  before = treeSnapshot(fx.repo);
});
afterAll(() => {
  fx.cleanup();
  rmSync(dist, { recursive: true, force: true });
});

describe("项目中枢", () => {
  test("/api/projects：列出注册表项目、默认项目为 null、带合流安装目录", async () => {
    const r = await get<ProjectsData>("/api/projects");
    expect(r.status).toBe(200);
    expect(r.body.data.default).toBeNull();
    expect(r.body.data.projects.map((p) => p.name)).toEqual(["演示"]);
    const p = r.body.data.projects[0]!;
    expect(p.repos[0]!.label).toBe("文档仓");
    expect(p.repos[0]!.integration).toBe("integ");
    expect(p.features).toBeNull(); // 台账还没建
    expect(existsSync(join(r.body.data.heliuRoot, "bin", "heliu"))).toBe(true);
  });

  test("没有默认项目时，项目级接口给中文提示（400），不崩", async () => {
    const r = await get<unknown>("/api/status");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("还没选项目");
    expect(r.body.error).toContain("演示");
  });

  test("?project= 选项目；不存在的项目 400", async () => {
    const ok = await get<{ repos: unknown[] }>(`/api/status?project=${encodeURIComponent("演示")}`);
    expect(ok.status).toBe(200);
    expect(ok.body.project!.name).toBe("演示");
    const bad = await get<unknown>(`/api/status?project=${encodeURIComponent("没有这个")}`);
    expect(bad.status).toBe(400);
  });

  test("写接口仍然只收 JSON（415）", async () => {
    const r = await post<unknown>("/api/projects", { path: fx.repo }, "text/plain");
    expect(r.status).toBe(415);
  });
});

describe("接入向导", () => {
  test("detect：只读检测，返回主线 / 集成候选 / 建议项目名，不写任何文件", async () => {
    const regBefore = listProjectNames(paths);
    const r = await post<DetectData>("/api/projects/detect", { path: `  "${fx.repo}"  ` }); // 带引号和空格也能认
    expect(r.status).toBe(200);
    expect(r.body.data.detection.root).toBe(fx.repo);
    expect(r.body.data.detection.main).toBe("main");
    expect(Array.isArray(r.body.data.detection.candidates)).toBe(true);
    expect(r.body.data.detection.branches).toBeGreaterThan(3);
    expect(r.body.data.suggestedName).toBe("磁吸 仓库");
    expect(r.body.data.registryExists).toBe(false);
    expect(r.body.data.ledgerDir).toBe(join(paths.projectsDir, "磁吸 仓库", "ledger"));
    expect(listProjectNames(paths)).toEqual(regBefore);
    expect(treeSnapshot(fx.repo)).toBe(before);
  });

  test("detect：路径不存在 / 不是绝对路径 → 中文报错 400", async () => {
    const a = await post<unknown>("/api/projects/detect", { path: join(fx.root, "没有这个目录") });
    expect(a.status).toBe(400);
    expect(a.body.error).toContain("不存在");
    const b = await post<unknown>("/api/projects/detect", { path: "相对/路径" });
    expect(b.status).toBe(400);
    expect(b.body.error).toContain("绝对路径");
    const c = await post<unknown>("/api/projects/detect", { path: "" });
    expect(c.status).toBe(400);
  });

  test("add：新建项目，注册表 + 台账都在 HELIU_HOME，被管理仓库零写入", async () => {
    const r = await post<OnboardResult>("/api/projects", { path: fx.repo, name: "第二个", integration: "" });
    expect(r.status).toBe(201);
    expect(r.body.data.created).toBe(true);
    expect(r.body.data.repo.integration).toBeNull();
    expect(r.body.data.ledger.dir).toBe(join(paths.projectsDir, "第二个", "ledger"));
    expect(existsSync(join(r.body.data.ledger.dir, "milestones.yaml"))).toBe(true);
    expect(readFileSync(projectFile(paths, "第二个"), "utf8")).toContain("ledger:");
    expect(r.body.data.project.features).toBe(0);
    expect(treeSnapshot(fx.repo)).toBe(before);
    expect(existsSync(join(fx.repo, ".heliu"))).toBe(false);
    const list = await get<ProjectsData>("/api/projects");
    expect(list.body.data.projects.map((p) => p.name).sort()).toEqual(["演示", "第二个"].sort());
  });

  test("add：同一个仓库再接入已有项目 → 保留原来的 id 与显示名，改集成分支，沿用原台账位置", async () => {
    const r = await post<OnboardResult>("/api/projects", { path: fx.repo, name: "演示", integration: "integ" });
    expect(r.status).toBe(201);
    expect(r.body.data.created).toBe(false);
    expect(r.body.data.repo.label).toBe("文档仓");
    expect(r.body.data.ledger.dir).toBe(join(fx.root, "演示台账"));
    const p = loadProject(paths, "演示");
    expect(p.repos).toHaveLength(1);
    expect(p.repos[0]!.integration).toBe("integ");
    expect(treeSnapshot(fx.repo)).toBe(before);
  });

  test("add 后立刻能用：sync 预览走新项目", async () => {
    const r = await post<SyncView>(`/api/sync?project=${encodeURIComponent("第二个")}`, { dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body.data.dryRun).toBe(true);
    expect(Array.isArray(r.body.data.drafts)).toBe(true);
    expect(treeSnapshot(fx.repo)).toBe(before);
  });

  test("项目名里有 / → 400，不写注册表", async () => {
    const r = await post<unknown>("/api/projects", { path: fx.repo, name: "a/b" });
    expect(r.status).toBe(400);
    expect(listProjectNames(paths)).not.toContain("a/b");
  });
});

describe("环境检查接口", () => {
  test("/api/doctor：默认跳过无头 claude（不等 20 秒），给出分级计数", async () => {
    const t0 = performance.now();
    const r = await get<DoctorData>("/api/doctor");
    expect(r.status).toBe(200);
    expect(r.body.data.full).toBe(false);
    const claude = r.body.data.checks.find((c) => c.id === "headless-claude")!;
    expect(claude.message).toContain("这次没检查");
    expect(r.body.data.checks.some((c) => c.id === "git")).toBe(true);
    const { ok, warn, fail } = r.body.data.counts;
    expect(ok + warn + fail).toBe(r.body.data.checks.length);
    expect(performance.now() - t0).toBeLessThan(15_000);
  });
});

describe("runBoard 复用已在运行的看板", () => {
  test("端口上已是合流看板 → 打印「已经在运行」并返回，不报端口占用", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const logs: string[] = [];
      await runBoard({ paths, cwd: fx.root, port: server.port, open: false, log: (l) => logs.push(l) });
      expect(logs.join("\n")).toContain("已经在运行");
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
