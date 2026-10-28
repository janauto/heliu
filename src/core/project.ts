/**
 * 项目注册表：~/Library/Application Support/heliu/projects/<name>/project.yaml；
 * 若某仓库内存在 <repo>/.heliu/project.yaml 且同名，则以仓库内版本为准（ADR-3）。
 * 本模块只写 heliu 自己的注册表目录，绝不写被管理仓库。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { runGit, lines } from "./git.ts";
import { canonicalPath, isUnder, looksLikeICloud, type HeliuPaths } from "./paths.ts";

export const RepoConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  path: z.string().min(1),
  main: z.string().min(1).default("main"),
  integration: z.string().nullish(),
  remote: z.string().nullish(),
  icloud: z.boolean().optional(),
});

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  repos: z.array(RepoConfigSchema).min(1),
  /** 主仓库 id（台账默认放 <主仓库>/.heliu/）；缺省为第一个仓库 */
  primary: z.string().nullish(),
  /** 台账目录覆盖（支持 ~ 与相对 project.yaml 的路径） */
  ledger: z.string().nullish(),
  /** M4 用：合并时按 union 策略处理的文件（M2 只解析不使用） */
  union_files: z.array(z.string()).nullish(),
  /** M4：union 合并后是否按「新日期在前」排序冲突段落（默认 true；false = 保持 merge-file --union 原样） */
  union_sort_by_date: z.boolean().nullish(),
  /** M4 用：合并后要跑的检查命令（M2 只解析不使用） */
  checks: z.array(z.string()).nullish(),
});

export interface RepoConfig {
  id: string;
  label: string;
  path: string;
  main: string;
  integration: string | null;
  remote: string | null;
  icloud: boolean;
}

export interface ProjectConfig {
  name: string;
  repos: RepoConfig[];
  /** 实际读取的 project.yaml 路径 */
  source: string;
  /** 主仓库 id；缺省为 repos[0] */
  primary?: string | null;
  /** project.yaml 里写的台账目录（已展开 ~、相对路径按 project.yaml 所在目录解析）；null = 默认 <主仓库>/.heliu */
  ledger?: string | null;
  /** M4 用，M2 只解析 */
  unionFiles?: string[];
  /** M4 用，M2 只解析 */
  checks?: string[];
  /** M4：union 冲突段落按新日期在前排序（缺省 true） */
  unionSortByDate?: boolean;
}

/** 展开 ~ 与相对路径（相对 project.yaml 所在目录） */
export function expandPath(p: string, baseDir: string): string {
  let out = p.trim();
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  return isAbsolute(out) ? out : resolve(baseDir, out);
}

/** 主仓库：primary 指定的仓库，否则第一个 */
export function primaryRepo(project: ProjectConfig): RepoConfig {
  const byId = project.primary ? project.repos.find((r) => r.id === project.primary) : undefined;
  return byId ?? (project.repos[0] as RepoConfig);
}

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

export function parseProjectYaml(text: string, source: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new ProjectError(`${source} 不是合法 YAML：${(e as Error).message}`);
  }
  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；");
    throw new ProjectError(`${source} 字段校验失败：${msg}`);
  }
  const ids = new Set<string>();
  const repos: RepoConfig[] = parsed.data.repos.map((r) => {
    if (ids.has(r.id)) throw new ProjectError(`${source} 中仓库 id 重复：${r.id}`);
    ids.add(r.id);
    return {
      id: r.id,
      label: r.label ?? r.id,
      path: r.path,
      main: r.main,
      integration: r.integration ?? null,
      remote: r.remote ?? null,
      icloud: r.icloud ?? looksLikeICloud(r.path),
    };
  });
  const d = parsed.data;
  if (d.primary && !repos.some((r) => r.id === d.primary)) {
    throw new ProjectError(`${source} 中 primary=${d.primary} 不是任何仓库的 id`);
  }
  const baseDir = source.startsWith("(") ? process.cwd() : dirname(source);
  return {
    name: d.name,
    repos,
    source,
    primary: d.primary ?? null,
    ledger: d.ledger ? expandPath(d.ledger, baseDir) : null,
    unionFiles: d.union_files ?? [],
    checks: d.checks ?? [],
    unionSortByDate: d.union_sort_by_date ?? true,
  };
}

export function projectFile(paths: HeliuPaths, name: string): string {
  return join(paths.projectsDir, name, "project.yaml");
}

/** 列出注册表里的项目名 */
export function listProjectNames(paths: HeliuPaths): string[] {
  if (!existsSync(paths.projectsDir)) return [];
  return readdirSync(paths.projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(paths.projectsDir, d.name, "project.yaml")))
    .map((d) => d.name)
    .sort();
}

/** 仓库内 .heliu/project.yaml（只 stat + 读这一个小文件） */
function repoLocalProject(repoPath: string, name: string): ProjectConfig | null {
  const f = join(repoPath, ".heliu", "project.yaml");
  if (!existsSync(f)) return null;
  try {
    const p = parseProjectYaml(readFileSync(f, "utf8"), f);
    return p.name === name ? p : null;
  } catch {
    return null;
  }
}

export function loadProject(paths: HeliuPaths, name: string): ProjectConfig {
  const f = projectFile(paths, name);
  if (!existsSync(f)) {
    const names = listProjectNames(paths);
    throw new ProjectError(
      `未找到项目「${name}」（${f}）。已注册：${names.length ? names.join("、") : "无"}；可用 heliu project add <path> --name <名字> 注册`,
    );
  }
  const reg = parseProjectYaml(readFileSync(f, "utf8"), f);
  for (const r of reg.repos) {
    const local = repoLocalProject(r.path, name);
    if (local) return local;
  }
  return reg;
}

/**
 * 自动识别当前目录所属项目：
 * 1. 向上查找 .heliu/project.yaml；
 * 2. 当前目录位于某注册仓库（含 .claude/worktrees）之下；
 * 3. 当前目录是某注册仓库的关联 worktree（比对 git common dir）。
 */
export async function detectProject(paths: HeliuPaths, cwd: string): Promise<ProjectConfig | null> {
  let dir = canonicalPath(cwd);
  for (let i = 0; i < 40; i++) {
    const f = join(dir, ".heliu", "project.yaml");
    if (existsSync(f)) {
      try {
        return parseProjectYaml(readFileSync(f, "utf8"), f);
      } catch {
        break;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const here = canonicalPath(cwd);
  const projects: ProjectConfig[] = [];
  for (const n of listProjectNames(paths)) {
    try {
      projects.push(loadProject(paths, n));
    } catch {
      /* 坏的注册项交给 doctor 报 */
    }
  }
  for (const p of projects) {
    if (p.repos.some((r) => isUnder(here, canonicalPath(r.path)))) return p;
  }
  const r = await runGit(here, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 3000 });
  if (r.ok) {
    const common = canonicalPath(lines(r.stdout)[0] ?? "");
    for (const p of projects) {
      if (p.repos.some((repo) => canonicalPath(join(repo.path, ".git")) === common)) return p;
    }
  }
  return null;
}

/** 解析 --project；缺省时自动识别，注册表只有一个项目时直接用它 */
export async function resolveProject(paths: HeliuPaths, name: string | undefined, cwd: string): Promise<ProjectConfig> {
  if (name) return loadProject(paths, name);
  const detected = await detectProject(paths, cwd);
  if (detected) return detected;
  const names = listProjectNames(paths);
  if (names.length === 1 && names[0]) return loadProject(paths, names[0]);
  throw new ProjectError(
    names.length
      ? `当前目录不在任何已注册项目内，请用 --project 指定：${names.join("、")}`
      : "尚未注册任何项目：heliu project add <仓库路径> --name <项目名>",
  );
}

/** project.yaml 中除 name/repos 外需要原样保留的字段（project add 重写文件时不丢） */
export interface ProjectExtras {
  primary?: string | null;
  ledger?: string | null;
  union_files?: string[] | null;
  union_sort_by_date?: boolean | null;
  checks?: string[] | null;
}

/** 生成 project.yaml 文本（带注释头） */
export function stringifyProject(name: string, repos: RepoConfig[], extras: ProjectExtras = {}): string {
  const doc: Record<string, unknown> = {
    name,
    repos: repos.map((r) => {
      const o: Record<string, unknown> = { id: r.id, label: r.label, path: r.path, main: r.main };
      if (r.integration) o.integration = r.integration;
      if (r.remote) o.remote = r.remote;
      o.icloud = r.icloud;
      return o;
    }),
  };
  if (extras.primary) doc.primary = extras.primary;
  if (extras.ledger) doc.ledger = extras.ledger;
  if (extras.union_files?.length) doc.union_files = extras.union_files;
  if (typeof extras.union_sort_by_date === "boolean") doc.union_sort_by_date = extras.union_sort_by_date;
  if (extras.checks?.length) doc.checks = extras.checks;
  return `# heliu 项目注册表（由 heliu project add 生成/更新；可手工编辑）\n${YAML.stringify(doc)}`;
}

function slugId(p: string): string {
  return (
    basename(p)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

export interface AddRepoInput {
  path: string;
  name?: string;
  id?: string;
  label?: string;
  main?: string;
  integration?: string;
  remote?: string;
  /** 台账位置原文（M5 向导）：项目还没设 ledger 时写进 project.yaml；已设则保留原值 */
  ledger?: string | null;
}

/**
 * heliu project add：只读探测仓库（主线、远端），写入 heliu 注册表。
 * 项目已存在则追加/替换同 path 的仓库条目。
 */
export async function addRepoToProject(paths: HeliuPaths, input: AddRepoInput): Promise<{ file: string; project: ProjectConfig; repo: RepoConfig; created: boolean }> {
  const repoPath = canonicalPath(input.path);
  if (!existsSync(repoPath)) throw new ProjectError(`路径不存在：${repoPath}`);
  const top = await runGit(repoPath, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { timeoutMs: 5000 });
  if (!top.ok) throw new ProjectError(`不是 git 仓库：${repoPath}`);
  const root = canonicalPath(lines(top.stdout)[0] ?? repoPath);

  let remote = input.remote ?? null;
  if (!remote) {
    const rr = await runGit(root, ["remote"], { timeoutMs: 5000 });
    const remotes = rr.ok ? lines(rr.stdout) : [];
    remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  }
  let main = input.main ?? null;
  if (!main && remote) {
    const sr = await runGit(root, ["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`], { timeoutMs: 5000 });
    const v = lines(sr.stdout)[0];
    if (sr.ok && v) main = v.slice(remote.length + 1);
  }
  if (!main) {
    for (const cand of ["main", "master"]) {
      const sr = await runGit(root, ["show-ref", "--verify", "-q", `refs/heads/${cand}`], { timeoutMs: 5000 });
      if (sr.ok) {
        main = cand;
        break;
      }
    }
  }
  if (!main) {
    const sr = await runGit(root, ["symbolic-ref", "-q", "--short", "HEAD"], { timeoutMs: 5000 });
    main = (sr.ok && lines(sr.stdout)[0]) || "main";
  }

  const name = input.name ?? basename(root);
  const file = projectFile(paths, name);
  const existingText = existsSync(file) ? readFileSync(file, "utf8") : null;
  const existing = existingText !== null ? parseProjectYaml(existingText, file) : null;
  // 原样保留 ledger 等字段（ledger 用文件里的原文，不写展开后的绝对路径）
  let extras: ProjectExtras = {};
  if (existingText !== null) {
    try {
      const raw = YAML.parse(existingText) as Record<string, unknown>;
      extras = { primary: raw.primary as string, ledger: raw.ledger as string, union_files: raw.union_files as string[], union_sort_by_date: raw.union_sort_by_date as boolean, checks: raw.checks as string[] };
    } catch {
      /* 上面已校验过，不会到这里 */
    }
  }
  if (input.ledger && !extras.ledger) extras = { ...extras, ledger: input.ledger };
  const repos = existing ? existing.repos.filter((r) => canonicalPath(r.path) !== root) : [];
  let id = input.id ?? slugId(root);
  while (repos.some((r) => r.id === id)) id = `${id}-2`;
  const repo: RepoConfig = {
    id,
    label: input.label ?? basename(root),
    path: root,
    main,
    integration: input.integration ?? null,
    remote,
    icloud: looksLikeICloud(root),
  };
  repos.push(repo);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifyProject(name, repos, extras), "utf8");
  return { file, project: { ...(existing ?? {}), name, repos, source: file }, repo, created: !existing };
}

/**
 * M9：改仓库的显示名。只替换 project.yaml 里该仓库那一块的 `label:` 一行（不整文件重写，手写注释原样保留）；
 * 找不到那一行就报错让用户手动改。写完重新解析一遍，读回来的名字不对就恢复原文件。
 */
export function setRepoLabel(paths: HeliuPaths, name: string, repoId: string, label: string): { file: string; from: string; to: string } {
  const to = label.trim();
  if (!to) throw new ProjectError("新名字不能为空");
  if (/[\r\n]/.test(to)) throw new ProjectError("新名字不能换行");
  const file = projectFile(paths, name);
  if (!existsSync(file)) throw new ProjectError(`项目「${name}」的 project.yaml 不存在：${file}`);
  const before = readFileSync(file, "utf8");
  const ls = before.split("\n");
  const idRe = new RegExp(`^(\\s*)-\\s+id:\\s*["']?${repoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*(#.*)?$`);
  const start = ls.findIndex((l) => idRe.test(l));
  if (start < 0) throw new ProjectError(`project.yaml 里没找到仓库 ${repoId}（${file}），请手动编辑`);
  const indent = idRe.exec(ls[start]!)![1]!.length;
  let at = -1;
  for (let i = start + 1; i < ls.length; i++) {
    const l = ls[i]!;
    if (!l.trim() || l.trimStart().startsWith("#")) continue;
    const ind = l.length - l.trimStart().length;
    if (ind <= indent) break; // 下一个仓库或别的字段
    if (/^\s*label:/.test(l)) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ProjectError(`project.yaml 里仓库 ${repoId} 没有 label 这一行（${file}），请手动加上：label: ${to}`);
  const m = /^(\s*label:\s*)(.*?)(\s+#.*)?$/.exec(ls[at]!)!;
  const plain = /^[^\s"'#&*!|>%@`{}[\],:?-][^#:]*$/.test(to) && !/\s$/.test(to);
  ls[at] = `${m[1]}${plain ? to : JSON.stringify(to)}${m[3] ?? ""}`;
  writeFileSync(file, ls.join("\n"));
  try {
    const p = loadProject(paths, name);
    const got = p.repos.find((r) => r.id === repoId)?.label;
    if (got !== to) throw new Error(`读回来是「${got}」`);
    const from = (YAML.parse(before) as { repos?: Array<{ id?: string; label?: string }> })?.repos?.find((r) => r.id === repoId)?.label ?? "";
    return { file, from, to };
  } catch (e) {
    writeFileSync(file, before);
    throw new ProjectError(`改名没成功，已恢复原文件（${(e as Error).message}）`);
  }
}
