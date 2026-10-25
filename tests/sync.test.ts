/**
 * sync：fixture 仓库 + 会话 JSON fixture → 草稿卡。
 * 只给「worktree 分支、无功能卡、未进主线」的分支建卡；标题取会话标题；状态按会话；同一分支只建一次；dry-run 不写。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../src/core/ledger.ts";
import { heliuPaths } from "../src/core/paths.ts";
import type { ProjectConfig } from "../src/core/project.ts";
import { syncLedger } from "../src/core/sync.ts";
import { B, buildFixture, gitSnapshot, type Fixture } from "./helpers/fixture.ts";

let fx: Fixture;
let project: ProjectConfig;
const NOW = new Date("2026-10-26T10:00:00+08:00");

beforeAll(() => {
  fx = buildFixture();
  // 让 behind 分支的会话（已归档）带上 completed 状态 → 草稿应为「待合并」
  const f = join(fx.claudeApp, "claude-code-sessions", "acct", "org", "local_archived_old.json");
  const s = JSON.parse(readFileSync(f, "utf8"));
  s.postTurnSummary = { status_category: "completed", status_detail: "做完了" };
  writeFileSync(f, JSON.stringify(s));
  project = {
    name: "演示",
    source: "(内存)",
    repos: [{ id: "main", label: "主仓", path: fx.repo, main: "main", integration: "integ", remote: "origin", icloud: false }],
    ledger: join(fx.root, "台账"),
  };
});
afterAll(() => fx.cleanup());

describe("sync 自动草稿", () => {
  test("dry-run：只列出，不写任何文件（不建台账目录、不建 vNext）", async () => {
    const before = gitSnapshot(fx.repo);
    const r = await syncLedger(project, heliuPaths(fx.env), { dryRun: true, now: NOW });
    expect(r.dryRun).toBe(true);
    expect(r.drafts.map((d) => d.branch).sort()).toEqual([B.behind, B.standalone].sort());
    expect(r.milestone).toBeNull();
    expect(r.milestoneWillBeCreated).toBe(true);
    expect(r.created).toEqual([]);
    expect(existsSync(project.ledger!)).toBe(false);
    expect(gitSnapshot(fx.repo)).toBe(before);
  }, 30_000);

  test("跳过：已进主线的 worktree、无 worktree 的分支、主线/集成分支", async () => {
    const r = await syncLedger(project, heliuPaths(fx.env), { dryRun: true, now: NOW });
    expect(r.drafts.some((d) => d.branch === B.mergedMain || d.branch === B.atTip)).toBe(false); // 已进主线
    expect(r.drafts.some((d) => d.branch === B.conflict || d.branch === B.inInteg)).toBe(false); // 没有 worktree
    expect(r.skipped).toEqual({ hasCard: 0, inMain: 2, noWorktree: 2, notFeature: 2 });
  }, 30_000);

  test("写入：标题取会话标题、状态按会话、绑定带 worktree/会话/PR、预约下一版（自动建 vNext）", async () => {
    const before = gitSnapshot(fx.repo);
    const r = await syncLedger(project, heliuPaths(fx.env), { dryRun: false, now: NOW });
    expect(r.created.length).toBe(2);
    expect(r.milestone).toBe("vNext");
    const byBranch = new Map(r.created.map((f) => [f.bindings[0]!.branch, f]));
    const epp = byBranch.get(B.standalone)!;
    expect(epp.title).toBe("实现 EPP 网关 v0（代调 MCP / CLI）");
    expect(epp.status).toBe("开发中"); // 会话 blocked → 开发中
    expect(epp.source).toBe("sync");
    expect(epp.milestone).toBe("vNext");
    expect(epp.bindings[0]).toEqual({ repo: "main", branch: B.standalone, worktree: fx.wt.standalone!, session: "local_full", pr: 3 });
    const old = byBranch.get(B.behind)!;
    expect(old.title).toBe("已归档的旧会话：老分支调研");
    expect(old.status).toBe("待合并"); // 会话 completed → 待合并
    expect(old.bindings[0]!.session).toBe("local_archived"); // 记录（branch 字段）优先于写入/目录
    expect(readFileSync(epp.file, "utf8")).toContain("由 heliu sync 自动生成的草稿");
    // 被管理仓库零写入（台账在仓库外）
    expect(gitSnapshot(fx.repo)).toBe(before);
  }, 30_000);

  test("去重：再跑一次不重复建卡（按 仓库 + 分支）", async () => {
    const r = await syncLedger(project, heliuPaths(fx.env), { dryRun: false, now: NOW });
    expect(r.drafts).toEqual([]);
    expect(r.skipped.hasCard).toBe(2);
    expect(new Ledger(project.ledger!).load().features.length).toBe(2);
  }, 30_000);

  test("已放弃的卡也算「已有卡」，不会被 sync 复活", async () => {
    const l = new Ledger(project.ledger!);
    const f = l.load().features[0]!;
    l.setStatus(f.id, "已放弃", NOW);
    const r = await syncLedger(project, heliuPaths(fx.env), { dryRun: true, now: NOW });
    expect(r.drafts).toEqual([]);
  }, 30_000);
});
