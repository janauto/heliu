/**
 * 看板项目中枢（M6）：一个看板服务多个项目。
 *
 * - 每个项目一个 BoardService（各自的 20 秒对账缓存），按需创建。
 * - 项目级接口用 `?project=<名>` 选项目；不带时用 default（启动时 --project 指定或按目录识别出的项目）。
 * - 识别不出项目时 default 为 null：看板照常启动，页面「开始」里选项目或接入新项目。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HeliuPaths } from "../core/paths.ts";
import { Ledger } from "../core/ledger.ts";
import { listProjectNames, loadProject, ProjectError, type ProjectConfig } from "../core/project.ts";
import type { ProjectsData, ProjectSummary } from "./api-types.ts";
import { BoardService } from "./data.ts";

const OPEN = new Set(["想法", "开发中", "待合并"]);
/** 合流仓库根目录（src/board/ 往上两级） */
export const HELIU_ROOT = join(import.meta.dir, "..", "..");

export interface BoardHubOptions {
  paths: HeliuPaths;
  /** 默认项目；null = 没有默认（页面里选） */
  project?: ProjectConfig | null;
  ttlMs?: number;
  now?: () => Date;
}

export class BoardHub {
  readonly paths: HeliuPaths;
  private readonly ttlMs?: number;
  private readonly now?: () => Date;
  private readonly services = new Map<string, BoardService>();
  readonly defaultName: string | null;

  constructor(opts: BoardHubOptions) {
    this.paths = opts.paths;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now;
    this.defaultName = opts.project?.name ?? null;
    if (opts.project) this.services.set(opts.project.name, this.make(opts.project));
  }

  private make(project: ProjectConfig): BoardService {
    return new BoardService({ paths: this.paths, project, ttlMs: this.ttlMs, now: this.now });
  }

  /** 默认项目的服务（没有默认时为 null） */
  defaultService(): BoardService | null {
    return this.defaultName ? this.service(this.defaultName) : null;
  }

  /** 取某个项目的服务；name 为空时用默认项目，都没有就报中文错误（HTTP 400） */
  service(name?: string | null): BoardService {
    const want = (name ?? "").trim() || this.defaultName;
    if (!want) {
      const names = listProjectNames(this.paths);
      throw new ProjectError(
        names.length
          ? `还没选项目：在「开始」页选一个（已有：${names.join("、")}），或在地址后加 ?project=<项目名>`
          : "还没有接入任何项目：在「开始」页的接入向导里粘贴一个 git 仓库的路径",
      );
    }
    const hit = this.services.get(want);
    if (hit) return hit;
    const project = loadProject(this.paths, want); // 不存在时抛 ProjectError
    const svc = this.make(project);
    this.services.set(want, svc);
    return svc;
  }

  /** 新接入的项目：丢掉旧缓存，下次按新的 project.yaml 重建 */
  forget(name: string): void {
    this.services.delete(name);
  }

  warm(): void {
    this.defaultService()?.warm();
  }

  /** 注册表里每个项目的摘要（只读文件，不扫 git） */
  projects(): ProjectsData {
    const projects = listProjectNames(this.paths).map((n) => summarizeProject(this.paths, n));
    return { registry: this.paths.projectsDir, heliuRoot: HELIU_ROOT, default: this.defaultName, projects };
  }
}

export function summarizeProject(paths: HeliuPaths, name: string): ProjectSummary {
  let p: ProjectConfig;
  try {
    p = loadProject(paths, name);
  } catch (e) {
    return { name, source: "", error: (e as Error).message, repos: [], ledgerDir: null, features: null, open: null, next: null };
  }
  const repos = p.repos.map((r) => ({ id: r.id, label: r.label, path: r.path, main: r.main, integration: r.integration, remote: r.remote, icloud: r.icloud, exists: existsSync(r.path) }));
  let ledgerDir: string | null = null;
  let features: number | null = null;
  let open: number | null = null;
  let next: string | null = null;
  try {
    const L = Ledger.of(p);
    ledgerDir = L.dir;
    if (L.exists()) {
      const fs = L.load().features;
      features = fs.length;
      open = fs.filter((f) => OPEN.has(f.status)).length;
      next = L.listMilestones().find((m) => m.status === "规划中")?.id ?? null;
    }
  } catch {
    /* 台账坏了：数字留空，页面里打开项目时会看到具体报错 */
  }
  return { name: p.name, source: p.source, error: null, repos, ledgerDir, features, open, next };
}
