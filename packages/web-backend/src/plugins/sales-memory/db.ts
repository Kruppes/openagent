import type { Database } from '@openagent/core'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  content: string
  session_id: string
  role: string
  created_at: string
  rank: number
}

export interface DigestRow {
  id: number
  date: string
  content: string
  model: string | null
  created_at: string
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Initialises the FTS5 virtual table, the digests table, and the auto-sync
 * triggers that keep the FTS index in sync with chat_messages.
 */
export function initSalesMemoryDb(db: Database): void {
  // FTS5 virtual table backed by chat_messages
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS salesmemory_fts USING fts5(
      content,
      session_id UNINDEXED,
      user_id UNINDEXED,
      role UNINDEXED,
      content=chat_messages,
      content_rowid=id
    );
  `)

  // Digest / daily summary table
  db.exec(`
    CREATE TABLE IF NOT EXISTS salesmemory_digests (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // Trigger: INSERT on chat_messages → add to FTS
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS salesmemory_fts_insert
    AFTER INSERT ON chat_messages BEGIN
      INSERT INTO salesmemory_fts(rowid, content, session_id, user_id, role)
        VALUES (new.id, new.content, new.session_id, new.user_id, new.role);
    END;
  `)

  // Trigger: DELETE on chat_messages → remove from FTS
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS salesmemory_fts_delete
    AFTER DELETE ON chat_messages BEGIN
      INSERT INTO salesmemory_fts(salesmemory_fts, rowid, content, session_id, user_id, role)
        VALUES ('delete', old.id, old.content, old.session_id, old.user_id, old.role);
    END;
  `)

  // Trigger: UPDATE on chat_messages → update FTS (delete old, insert new)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS salesmemory_fts_update
    AFTER UPDATE ON chat_messages BEGIN
      INSERT INTO salesmemory_fts(salesmemory_fts, rowid, content, session_id, user_id, role)
        VALUES ('delete', old.id, old.content, old.session_id, old.user_id, old.role);
      INSERT INTO salesmemory_fts(rowid, content, session_id, user_id, role)
        VALUES (new.id, new.content, new.session_id, new.user_id, new.role);
    END;
  `)

  console.log('[sales-memory] Database tables and triggers initialised')
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Full-text search over chat_messages using FTS5 BM25 ranking.
 * Returns results ordered by relevance (best rank = most negative value).
 */
export function searchMemory(
  db: Database,
  query: string,
  limit = 10,
): SearchResult[] {
  if (!query || !query.trim()) return []

  try {
    const rows = db.prepare(`
      SELECT
        m.content,
        m.session_id,
        m.role,
        m.timestamp AS created_at,
        rank
      FROM salesmemory_fts
      JOIN chat_messages m ON salesmemory_fts.rowid = m.id
      WHERE salesmemory_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query.trim(), limit) as SearchResult[]

    return rows
  } catch (err) {
    console.error('[sales-memory] searchMemory error:', err)
    return []
  }
}

// ── Digest ────────────────────────────────────────────────────────────────────

/**
 * Returns the most recently created digest, or null if none exist.
 */
export function getLatestDigest(db: Database): DigestRow | null {
  const row = db.prepare(`
    SELECT id, date, content, model, created_at
    FROM salesmemory_digests
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as DigestRow | undefined

  return row ?? null
}

/**
 * Saves a digest to the database.
 */
export function saveDigest(
  db: Database,
  date: string,
  content: string,
  model: string | null,
): DigestRow {
  const result = db.prepare(`
    INSERT INTO salesmemory_digests (date, content, model)
    VALUES (?, ?, ?)
  `).run(date, content, model)

  return db.prepare(
    'SELECT id, date, content, model, created_at FROM salesmemory_digests WHERE id = ?'
  ).get(result.lastInsertRowid) as DigestRow
}

/**
 * Returns messages from the given calendar day (YYYY-MM-DD) from chat_messages.
 */
export function getMessagesForDate(
  db: Database,
  date: string,
): Array<{ role: string; content: string; timestamp: string }> {
  return db.prepare(`
    SELECT role, content, timestamp
    FROM chat_messages
    WHERE date(timestamp) = date(?)
    ORDER BY timestamp ASC
  `).all(date) as Array<{ role: string; content: string; timestamp: string }>
}

/**
 * Returns counts for the status endpoint.
 */
export function getSalesMemoryStats(db: Database): {
  fts_count: number
  digest_count: number
  last_digest_date: string | null
} {
  // Use the shadow table to count FTS rows efficiently
  const ftsCount = (db.prepare(
    'SELECT COUNT(*) as count FROM chat_messages'
  ).get() as { count: number } | undefined)?.count ?? 0

  const digestCount = (db.prepare(
    'SELECT COUNT(*) as count FROM salesmemory_digests'
  ).get() as { count: number }).count

  const lastDigest = db.prepare(
    'SELECT date FROM salesmemory_digests ORDER BY created_at DESC LIMIT 1'
  ).get() as { date: string } | undefined

  return {
    fts_count: ftsCount,
    digest_count: digestCount,
    last_digest_date: lastDigest?.date ?? null,
  }
}
