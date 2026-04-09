import type { Database } from '@openagent/core'
import crypto from 'node:crypto'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  content: string
  session_id: string
  role: string
  created_at: string
  rank: number
}

export interface MemoryRecord {
  id: string
  user_id: string | null
  session_id: string | null
  content: string
  created_at: number
  updated_at: number
  access_count: number
  last_accessed_at: number | null
}

export interface ObsidianIndexRecord {
  id: string
  file_path: string
  project: string | null
  content: string
  last_synced_at: number
}

export interface RRFResult {
  content: string
  source: 'chat' | 'memory' | 'obsidian'
  sourceId: string
  score: number
  metadata?: Record<string, unknown>
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
 * Initialises the FTS5 virtual table, the digests table, the memories table,
 * the obsidian_index table, and the auto-sync triggers.
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

  // ── Memories table (Schicht 2: episodic memory) ───────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      session_id TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER DEFAULT 0,
      last_accessed_at INTEGER
    );
  `)

  // FTS5 over memories
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='rowid'
    );
  `)

  // ── Obsidian index table (Schicht 3: Zettelkasten) ───────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS obsidian_index (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      project TEXT,
      content TEXT NOT NULL,
      last_synced_at INTEGER NOT NULL
    );
  `)

  // FTS5 over obsidian_index
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS obsidian_fts USING fts5(
      content,
      content='obsidian_index',
      content_rowid='rowid'
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

// ── Memories (Schicht 2) ──────────────────────────────────────────────────────

/**
 * Search the memories table using FTS5 BM25.
 */
export function searchMemories(
  db: Database,
  query: string,
  limit = 10,
): Array<{ content: string; id: string; session_id: string | null; rank: number }> {
  if (!query || !query.trim()) return []
  try {
    return db.prepare(`
      SELECT
        m.content,
        m.id,
        m.session_id,
        mf.rank
      FROM memories_fts mf
      JOIN memories m ON mf.rowid = m.rowid
      WHERE memories_fts MATCH ?
      ORDER BY mf.rank
      LIMIT ?
    `).all(query.trim(), limit) as Array<{ content: string; id: string; session_id: string | null; rank: number }>
  } catch (err) {
    console.error('[sales-memory] searchMemories error:', err)
    return []
  }
}

/**
 * Insert or update a memory record. If a very similar memory already exists
 * (FTS5 search returns high overlap), update the existing one instead of
 * creating a duplicate.
 *
 * @returns 'inserted' | 'updated'
 */
export function upsertMemory(
  db: Database,
  content: string,
  userId: string | null,
  sessionId: string | null,
  similarityThreshold = 0.8,
): 'inserted' | 'updated' {
  const now = Date.now()

  // FTS5 dedup: search for similar existing memory
  const existing = searchMemories(db, content, 5)
  if (existing.length > 0) {
    // Compute simple word-overlap ratio for dedup
    const contentWords = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 3))
    for (const mem of existing) {
      const memWords = new Set(mem.content.toLowerCase().split(/\s+/).filter(w => w.length > 3))
      let intersection = 0
      for (const w of contentWords) {
        if (memWords.has(w)) intersection++
      }
      const union = contentWords.size + memWords.size - intersection
      const similarity = union > 0 ? intersection / union : 0

      if (similarity >= similarityThreshold) {
        // Update existing memory
        db.prepare(`
          UPDATE memories SET content = ?, updated_at = ?, session_id = ? WHERE id = ?
        `).run(content, now, sessionId, mem.id)

        // Sync FTS5 (content table — need to rebuild the row)
        db.prepare(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`).run()

        return 'updated'
      }
    }
  }

  // Insert new memory
  const id = `mem-${crypto.randomUUID()}`
  const result = db.prepare(`
    INSERT INTO memories (id, user_id, session_id, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, sessionId, content, now, now)

  // Sync FTS5
  db.prepare(`
    INSERT INTO memories_fts(rowid, content) VALUES (?, ?)
  `).run(result.lastInsertRowid, content)

  return 'inserted'
}

/**
 * Get all memories for a user, ordered by updated_at DESC.
 */
export function getUserMemories(
  db: Database,
  userId: string | null,
  limit = 50,
): MemoryRecord[] {
  return db.prepare(`
    SELECT id, user_id, session_id, content, created_at, updated_at, access_count, last_accessed_at
    FROM memories
    WHERE user_id = ? OR (user_id IS NULL AND ? IS NULL)
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(userId, userId, limit) as MemoryRecord[]
}

// ── Obsidian Index (Schicht 3) ────────────────────────────────────────────────

/**
 * Search the obsidian_index using FTS5 BM25.
 */
export function searchObsidian(
  db: Database,
  query: string,
  limit = 10,
): Array<{ content: string; id: string; file_path: string; project: string | null; rank: number }> {
  if (!query || !query.trim()) return []
  try {
    return db.prepare(`
      SELECT
        oi.content,
        oi.id,
        oi.file_path,
        oi.project,
        of_.rank
      FROM obsidian_fts of_
      JOIN obsidian_index oi ON of_.rowid = oi.rowid
      WHERE obsidian_fts MATCH ?
      ORDER BY of_.rank
      LIMIT ?
    `).all(query.trim(), limit) as Array<{ content: string; id: string; file_path: string; project: string | null; rank: number }>
  } catch (err) {
    console.error('[sales-memory] searchObsidian error:', err)
    return []
  }
}

/**
 * Upsert an Obsidian file into the index.
 * Uses file_path as the unique key.
 */
export function upsertObsidianIndex(
  db: Database,
  filePath: string,
  project: string | null,
  content: string,
): void {
  const now = Date.now()
  const existing = db.prepare(`SELECT id, rowid FROM obsidian_index WHERE file_path = ?`)
    .get(filePath) as { id: string; rowid: number } | undefined

  if (existing) {
    db.prepare(`
      UPDATE obsidian_index SET project = ?, content = ?, last_synced_at = ? WHERE id = ?
    `).run(project, content, now, existing.id)
    // Rebuild FTS
    db.prepare(`INSERT INTO obsidian_fts(obsidian_fts) VALUES('rebuild')`).run()
  } else {
    const id = `obs-${crypto.randomUUID()}`
    const result = db.prepare(`
      INSERT INTO obsidian_index (id, file_path, project, content, last_synced_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, filePath, project, content, now)
    db.prepare(`
      INSERT INTO obsidian_fts(rowid, content) VALUES (?, ?)
    `).run(result.lastInsertRowid, content)
  }
}

/**
 * Get all indexed Obsidian files.
 */
export function getObsidianIndex(db: Database): ObsidianIndexRecord[] {
  return db.prepare(`
    SELECT id, file_path, project, content, last_synced_at FROM obsidian_index ORDER BY last_synced_at DESC
  `).all() as ObsidianIndexRecord[]
}

// ── RRF Hybrid Retrieval (Schicht 4) ─────────────────────────────────────────

/**
 * Reciprocal Rank Fusion search over all three sources:
 * 1. FTS5 BM25 over chat_messages → Top-20
 * 2. FTS5 BM25 over memories      → Top-10
 * 3. FTS5 BM25 over obsidian_index → Top-10
 *
 * RRF formula: score(doc) = Σ 1/(60 + rank_i)
 *
 * @returns Top-N results by RRF score
 */
export function rrfSearch(
  db: Database,
  query: string,
  topK = 5,
): RRFResult[] {
  if (!query || !query.trim()) return []

  const scores = new Map<string, RRFResult & { rrfScore: number }>()

  // Helper to apply RRF scoring
  function applyRRF<T extends { content: string; rank: number }>(
    results: Array<T>,
    source: RRFResult['source'],
    getId: (r: T, i: number) => string,
    getMeta: (r: T) => Record<string, unknown>,
  ): void {
    results.forEach((r, i) => {
      const id = getId(r, i)
      const rrfContrib = 1 / (60 + i)
      const existing = scores.get(id)
      if (existing) {
        existing.rrfScore += rrfContrib
      } else {
        scores.set(id, {
          content: r.content,
          source,
          sourceId: id,
          score: rrfContrib,
          rrfScore: rrfContrib,
          metadata: getMeta(r),
        })
      }
    })
  }

  // 1. Chat messages
  try {
    const chatResults = db.prepare(`
      SELECT m.content, m.session_id, m.role, m.timestamp AS created_at, rank
      FROM salesmemory_fts
      JOIN chat_messages m ON salesmemory_fts.rowid = m.id
      WHERE salesmemory_fts MATCH ?
      ORDER BY rank
      LIMIT 20
    `).all(query.trim()) as Array<{ content: string; session_id: string; role: string; created_at: string; rank: number }>

    applyRRF(
      chatResults,
      'chat',
      (r, i) => `chat-${i}-${r.content.slice(0, 20)}`,
      r => ({ session_id: r.session_id, role: r.role, created_at: r.created_at }),
    )
  } catch (err) {
    console.error('[rrf] chat search error:', err)
  }

  // 2. Memories
  try {
    const memResults = db.prepare(`
      SELECT m.content, m.id, m.session_id, mf.rank
      FROM memories_fts mf
      JOIN memories m ON mf.rowid = m.rowid
      WHERE memories_fts MATCH ?
      ORDER BY mf.rank
      LIMIT 10
    `).all(query.trim()) as Array<{ content: string; id: string; session_id: string | null; rank: number }>

    applyRRF(
      memResults,
      'memory',
      r => `memory-${r.id}`,
      r => ({ id: r.id, session_id: r.session_id }),
    )
  } catch (err) {
    console.error('[rrf] memories search error:', err)
  }

  // 3. Obsidian
  try {
    const obsResults = db.prepare(`
      SELECT oi.content, oi.id, oi.file_path, oi.project, of_.rank
      FROM obsidian_fts of_
      JOIN obsidian_index oi ON of_.rowid = oi.rowid
      WHERE obsidian_fts MATCH ?
      ORDER BY of_.rank
      LIMIT 10
    `).all(query.trim()) as Array<{ content: string; id: string; file_path: string; project: string | null; rank: number }>

    applyRRF(
      obsResults,
      'obsidian',
      r => `obsidian-${r.id}`,
      r => ({ id: r.id, file_path: r.file_path, project: r.project }),
    )
  } catch (err) {
    console.error('[rrf] obsidian search error:', err)
  }

  // Sort by RRF score descending, return top-K
  return [...scores.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK)
    .map(({ rrfScore: _, ...rest }) => rest)
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
