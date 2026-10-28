/**
 * 看板接入向导（M6）：与 `heliu project add` 同一套规则，只是把"问答"换成网页表单。
 *
 * - detect：只读检测（detectRepo 走 git 白名单），不写任何文件。
 * - add：写注册表（addRepoToProject）并建台账（Ledger.init）。台账一律放 heliu 数据目录；
 *   项目已存在时沿用它原来的 ledger 设置。被管理仓库零写入。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import YAML from "yaml";
import { Ledger } from "../core/ledger.ts";
import { listLocalBranches } from "../core/branches.ts";
import { detectRepo } from "../core/onboard.ts";
import { canonicalPath, type HeliuPaths } from "../core/paths.ts";
import { addRepoToProject, expandPath, listProjectNames, loadProject, ProjectError, projectFile } from "../core/project.ts";
import type { DetectData, OnboardResult } from "./api-types.ts";
import { summarizeProject } from "./hub.ts";

const tildify = (p: string) => (p === homedir() || p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** 把用户粘贴的路径整理一下：去掉引号、首尾空白、file:// 前缀，展开 ~ */
export function cleanPath(raw: unknown): string {
  let p = typeof raw === "string" ? raw.trim() : "";
  if (!p) throw new ProjectError("请先填一个 git 仓库的路径（在 Finder 里选中文件夹，按 ⌥⌘C 可以复制路径）");
  p = p.replace(/^['"]+|['"]+$/g, "").trim();
  if (p.startsWith("file://")) p = decodeURIComponent(p.slice("file://".length));
  if (!p.startsWith("/") && !p.startsWith("~")) throw new ProjectError(`请填绝对路径（以 / 或 ~ 开头）：${p}`);
  return expandPath(p, homedir());
}

/** 名字里不能有路径分隔符（注册表按名字建目录） */
function cleanName(raw: string): string {
  const n = raw.trim();
  if (!n) throw new ProjectError("项目名不能为空");
  if (/[/\\]/.test(n) || n === "." || n === "..") throw new ProjectError(`项目名里不能有 / 或 \\：${n}`);
  return n;
}

function existingLedger(paths: HeliuPaths, name: string): string | null {
  const f = projectFile(paths, name);
  if (!existsSync(f)) return null;
  try {
    const raw = YAML.parse(readFileSync(f, "utf8")) as { ledger?: unknown };
    return typeof raw?.ledger === "string" ? raw.ledger : null;
  } catch {
    return null;
  }
}

function ledgerPlan(paths: HeliuPaths, name: string): { dir: string; setting: string | null; note: string } {
  const old = existingLedger(paths, name);
  if (old) return { dir: expandPath(old, join(paths.projectsDir, name)), setting: null, note: "沿用这个项目原来的台账位置" };
  if (existsSync(projectFile(paths, name))) {
    // 已有项目但 project.yaml 没写 ledger：只有 <主仓库>/.heliu/ 已经在用时才沿用；否则放数据目录，绝不在仓库里新建
    try {
      const L = Ledger.of(loadProject(paths, name));
      if (L.exists()) return { dir: L.dir, setting: null, note: "沿用这个项目已经在用的台账（在仓库的 .heliu/ 里）" };
    } catch {
      /* 落到下面 */
    }
  }
  const dir = join(paths.projectsDir, name, "ledger");
  return { dir, setting: tildify(dir), note: "放在 heliu 数据目录，不往你的仓库里写任何文件" };
}

export async function detectForBoard(paths: HeliuPaths, body: Record<string, unknown>): Promise<DetectData> {
  const path = cleanPath(body.path);
  if (!existsSync(path)) throw new ProjectError(`这个路径不存在：${path}`);
  const detection = await detectRepo(path, { main: str(body.main), integration: str(body.integration), remote: str(body.remote) });
  const suggestedName = cleanName(str(body.name) ?? basename(detection.root));
  const lp = ledgerPlan(paths, suggestedName);
  const lb = await listLocalBranches(detection.root, { timeoutMs: 8000 });
  const localBranches = lb.branches
    .map((b) => ({ name: b.name, lastCommitAt: b.committedAt !== null ? new Date(b.committedAt * 1000).toISOString() : null }))
    .sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""));
  return {
    detection,
    localBranches,
    suggestedName,
    existingProjects: listProjectNames(paths),
    registryExists: existsSync(projectFile(paths, suggestedName)),
    ledgerDir: lp.dir,
    ledgerNote: lp.note,
  };
}

export async function addForBoard(paths: HeliuPaths, body: Record<string, unknown>): Promise<OnboardResult> {
  const path = cleanPath(body.path);
  if (!existsSync(path)) throw new ProjectError(`这个路径不存在：${path}`);
  const name = cleanName(str(body.name) ?? basename(path));
  // integration：字符串 = 用它；null / "" = 不设；不传 = 按检测结果猜
  let integration: string | undefined;
  if (typeof body.integration === "string") integration = body.integration.trim() || undefined;
  else if (body.integration === undefined) integration = (await detectRepo(path, { main: str(body.main), remote: str(body.remote) })).integration ?? undefined;
  const lp = ledgerPlan(paths, name);
  // 同一个仓库再接入一次（例如改集成分支）：保留它原来的 id 和显示名（如「文档仓」）
  let keep: { id?: string; label?: string } = {};
  if (existsSync(projectFile(paths, name))) {
    try {
      const root = canonicalPath(path);
      const old = loadProject(paths, name).repos.find((r) => { const rp = canonicalPath(r.path); return root === rp || root.startsWith(`${rp}/`); });
      if (old) keep = { id: old.id, label: old.label };
    } catch {
      /* 注册表坏了交给 addRepoToProject 报错 */
    }
  }
  const res = await addRepoToProject(paths, {
    path,
    name,
    ...keep,
    main: str(body.main),
    integration,
    remote: str(body.remote),
    ledger: lp.setting,
  });
  const ledger = Ledger.of(loadProject(paths, name)).init();
  return { project: summarizeProject(paths, name), created: res.created, repo: res.repo, ledger };
}
