/**
 * 索引缓存（事实，ADR-3）：~/Library/Application Support/heliu/cache/<项目名>.sqlite
 * - 可删可重建：只存 hook 观察到的事实（会话最后一次 Stop、首次见到的 worktree），台账不依赖它。
 * - 绝不放 iCloud：HELIU_HOME 若落在 iCloud Drive 里直接拒绝打开。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { looksLikeICloud, type HeliuPaths } from "./paths.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS session_activity (
  session_id   TEXT PRIMARY KEY,
  cwd          TEXT,
  last_stop_at INTEGER NOT NULL,
  stops        INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS worktree_seen (
  path          TEXT PRIMARY KEY,
  name          TEXT,
  first_seen_at INTEGER NOT NULL,
  session_id    TEXT,
  via           TEXT
);
`;

export function cacheFile(paths: HeliuPaths, projectName: string): string {
  // 项目名可能含 /：替换掉，避免写到子目录
  return join(paths.heliuHome, "cache", `${projectName.replace(/[/\\:]/g, "-")}.sqlite`);
}

export interface StopRecord {
  sessionId: string;
  cwd: string | null;
  at: number;
  stops: number;
}

export interface WorktreeSeen {
  path: string;
  name: string | null;
  firstSeenAt: number;
  sessionId: string | null;
  via: string | null;
}

export class Cache {
  readonly file: string;
  private readonly db: Database;

  private constructor(file: string, db: Database) {
    this.file = file;
    this.db = db;
  }

  /** 打开（不存在则建）；readonly=true 时文件不存在返回 null */
  static open(paths: HeliuPaths, projectName: string, opts: { readonly?: boolean } = {}): Cache | null {
    const file = cacheFile(paths, projectName);
    if (looksLikeICloud(file)) throw new Error(`缓存路径在 iCloud 内（${file}），拒绝打开：sqlite 不能放 iCloud`);
    if (opts.readonly) {
      try {
        const db = new Database(file, { readonly: true });
        return new Cache(file, db);
      } catch {
        return null;
      }
    }
    mkdirSync(join(paths.heliuHome, "cache"), { recursive: true });
    const db = new Database(file, { create: true });
    db.exec("PRAGMA busy_timeout = 500;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1')");
    return new Cache(file, db);
  }

  recordStop(sessionId: string, cwd: string | null, at: number = Date.now()): void {
    this.db
      .query(
        `INSERT INTO session_activity (session_id, cwd, last_stop_at, stops) VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(session_id) DO UPDATE SET cwd = COALESCE(?2, cwd), last_stop_at = MAX(last_stop_at, ?3), stops = stops + 1`,
      )
      .run(sessionId, cwd, at);
  }

  /** 首次见到某个 worktree（SessionStart 时记录；已有则不覆盖） */
  recordWorktree(path: string, name: string | null, sessionId: string | null, via: string, at: number = Date.now()): void {
    this.db
      .query("INSERT OR IGNORE INTO worktree_seen (path, name, first_seen_at, session_id, via) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(path, name, at, sessionId, via);
  }

  stops(): StopRecord[] {
    return this.db
      .query("SELECT session_id, cwd, last_stop_at, stops FROM session_activity")
      .all()
      .map((r) => {
        const o = r as { session_id: string; cwd: string | null; last_stop_at: number; stops: number };
        return { sessionId: o.session_id, cwd: o.cwd, at: o.last_stop_at, stops: o.stops };
      });
  }

  worktrees(): WorktreeSeen[] {
    return this.db
      .query("SELECT path, name, first_seen_at, session_id, via FROM worktree_seen")
      .all()
      .map((r) => {
        const o = r as { path: string; name: string | null; first_seen_at: number; session_id: string | null; via: string | null };
        return { path: o.path, name: o.name, firstSeenAt: o.first_seen_at, sessionId: o.session_id, via: o.via };
      });
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }
}
