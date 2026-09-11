/**
 * Regression test for the sessions-table rebuild during the upstream 0.27.0
 * merge (conflict database.ts §4.3).
 *
 * Risk: the CHECK-constraint recreation of `sessions` copies columns explicitly
 * via `INSERT INTO sessions (...) SELECT ... FROM sessions_old`. The fork adds
 * `agent_id`; upstream 0.27.0 adds `cache_read`/`cache_write`. A naive merge of
 * that INSERT would silently DROP one side's column (and its data) because the
 * rebuild is destructive (DROP TABLE sessions_old).
 *
 * This test builds a legacy DB whose `sessions.type` column has NO CHECK
 * constraint (so initDatabase MUST rebuild the table) and pre-seeds a row with
 * a non-'main' agent_id plus cache counters, then asserts:
 *   - all three columns exist after migration, and
 *   - the persona attribution AND the cache counters survived the rebuild.
 *
 * Against the buggy merge (agent_id dropped from the rebuild INSERT) the
 * agent_id assertion fails: the column is recreated with its DEFAULT 'main',
 * losing the persona attribution of every historical session.
 */
import { describe, it, expect, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { initDatabase } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('database sessions rebuild — persona + cache column preservation', () => {
  const tmpFiles: string[] = []
  afterEach(() => {
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${f}${suffix}`) } catch { /* ignore */ }
      }
    }
    tmpFiles.length = 0
  })

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-persona-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  it('preserves agent_id AND cache_read/cache_write when the sessions table is rebuilt', () => {
    const dbPath = tmpDbPath()
    const legacy = new BetterSqlite3(dbPath)
    legacy.pragma('foreign_keys = ON')
    // A sessions table that already carries agent_id + cache columns but whose
    // `type` column has NO CHECK constraint → forces the recreation path.
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user'
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        source TEXT NOT NULL DEFAULT 'web',
        type TEXT NOT NULL DEFAULT 'interactive',
        parent_session_id TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        summary_written INTEGER NOT NULL DEFAULT 0,
        last_activity TEXT,
        session_user TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT NOT NULL DEFAULT 'main',
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `)
    // UUID id so the legacy-id remap does not rewrite it.
    const sid = '11111111-2222-4333-8444-555555555555'
    legacy.prepare(
      `INSERT INTO sessions (id, source, type, prompt_tokens, completion_tokens, cache_read, cache_write, agent_id)
       VALUES (?, 'telegram', 'interactive', 10, 5, 111, 222, 'bob')`,
    ).run(sid)
    legacy.close()

    const db = initDatabase(dbPath)

    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('agent_id')
    expect(cols).toContain('cache_read')
    expect(cols).toContain('cache_write')

    const row = db.prepare(
      'SELECT agent_id, cache_read, cache_write, prompt_tokens, completion_tokens FROM sessions WHERE id = ?',
    ).get(sid) as {
      agent_id: string; cache_read: number; cache_write: number
      prompt_tokens: number; completion_tokens: number
    }
    // Persona attribution survived the destructive rebuild.
    expect(row.agent_id).toBe('bob')
    // Cache counters survived too.
    expect(row.cache_read).toBe(111)
    expect(row.cache_write).toBe(222)
    expect(row.prompt_tokens).toBe(10)
    expect(row.completion_tokens).toBe(5)

    db.close()
  })
})
