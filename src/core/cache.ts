/**
 * 索引缓存（事实，ADR-3）：~/Library/Application Support/heliu/cache/<项目名>.sqlite
 * - 可删可重建：只存 hook 观察到的事实（会话最后一次 Stop、首次见到的 worktree），台账不依赖它。
 * - M9：对话记录里提取的跨仓证据（只有路径、计数、时间戳，不存对话内容），按文件 mtime / 大小增量更新。
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
CREATE TABLE IF NOT EXISTS transcript_files (
  file           TEXT PRIMARY KEY,
  cli_session_id TEXT NOT NULL,
  mtime_ms       INTEGER NOT NULL,
  size           INTEGER NOT NULL,
  targets_sig    TEXT NOT NULL,
  extracted_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_evidence (
  file           TEXT NOT NULL,
  cli_session_id TEXT NOT NULL,
  worktree_path  TEXT NOT NULL,
  reads          INTEGER NOT NULL,
  writes         INTEGER NOT NULL,
  commits        INTEGER NOT NULL,
  last_seen_at   TEXT,
  PRIMARY KEY (file, worktree_path)
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

export interface TranscriptFileRow {
  file: string;
  cliSessionId: string;
  mtimeMs: number;
  size: number;
  targetsSig: string;
  extractedAt: number;
}

export interface EvidenceRow {
  file: string;
  cliSessionId: string;
  worktree: string;
  reads: number;
  writes: number;
  commits: number;
  lastSeenAt: string | null;
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

  /* ───────────── M9：对话记录证据 ───────────── */

  transcriptFile(file: string): TranscriptFileRow | null {
    const o = this.db.query("SELECT file, cli_session_id, mtime_ms, size, targets_sig, extracted_at FROM transcript_files WHERE file = ?1").get(file) as {
      file: string;
      cli_session_id: string;
      mtime_ms: number;
      size: number;
      targets_sig: string;
      extracted_at: number;
    } | null;
    return o ? { file: o.file, cliSessionId: o.cli_session_id, mtimeMs: o.mtime_ms, size: o.size, targetsSig: o.targets_sig, extractedAt: o.extracted_at } : null;
  }

  /** 一份对话记录的提取结果整体替换（同一事务） */
  saveTranscript(f: TranscriptFileRow, rows: Array<Omit<EvidenceRow, "file" | "cliSessionId">>): void {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM transcript_evidence WHERE file = ?1").run(f.file);
      const ins = this.db.query(
        "INSERT INTO transcript_evidence (file, cli_session_id, worktree_path, reads, writes, commits, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      );
      for (const r of rows) ins.run(f.file, f.cliSessionId, r.worktree, r.reads, r.writes, r.commits, r.lastSeenAt);
      this.db
        .query(
          `INSERT INTO transcript_files (file, cli_session_id, mtime_ms, size, targets_sig, extracted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(file) DO UPDATE SET cli_session_id = ?2, mtime_ms = ?3, size = ?4, targets_sig = ?5, extracted_at = ?6`,
        )
        .run(f.file, f.cliSessionId, f.mtimeMs, f.size, f.targetsSig, f.extractedAt);
    });
    tx();
  }

  evidence(): EvidenceRow[] {
    return this.db
      .query("SELECT file, cli_session_id, worktree_path, reads, writes, commits, last_seen_at FROM transcript_evidence")
      .all()
      .map((r) => {
        const o = r as { file: string; cli_session_id: string; worktree_path: string; reads: number; writes: number; commits: number; last_seen_at: string | null };
        return { file: o.file, cliSessionId: o.cli_session_id, worktree: o.worktree_path, reads: o.reads, writes: o.writes, commits: o.commits, lastSeenAt: o.last_seen_at };
      });
  }

  getMeta(key: string): string | null {
    const o = this.db.query("SELECT value FROM meta WHERE key = ?1").get(key) as { value: string } | null;
    return o?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2").run(key, value);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }
}
