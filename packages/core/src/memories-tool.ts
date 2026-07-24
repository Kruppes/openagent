import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { searchMemories, getMemoryById } from './memories-store.js'
import type { MemoryFact } from './memories-store.js'
import { searchMemoriesByEmbedding } from './memory-embeddings.js'

/**
 * Hybrid retrieval: lexical FTS5 hits + semantic embedding hits merged via
 * Reciprocal Rank Fusion. Degrades to pure FTS when embeddings are disabled
 * or the endpoint is unreachable (semantic list is simply empty).
 */
async function searchMemoriesHybrid(
  db: Database,
  query: string,
  options: { userId?: number; limit: number; agentId?: string },
): Promise<{ facts: MemoryFact[]; semantic: boolean }> {
  // Overfetch both lists so fusion has material to work with.
  const poolSize = Math.min(options.limit * 3, 50)
  const ftsFacts = searchMemories(db, query, { userId: options.userId, limit: poolSize, agentId: options.agentId })

  let embeddingHits: Array<{ id: number }> = []
  try {
    embeddingHits = (await searchMemoriesByEmbedding(db, query, {
      userId: options.userId,
      limit: poolSize,
    })) ?? []
  } catch {
    // semantic path is strictly best-effort
  }

  if (embeddingHits.length === 0) {
    return { facts: ftsFacts.slice(0, options.limit), semantic: false }
  }

  // RRF: score(id) = Σ 1 / (60 + rank) over both rankings.
  const K = 60
  const scores = new Map<number, number>()
  ftsFacts.forEach((fact, rank) => scores.set(fact.id, (scores.get(fact.id) ?? 0) + 1 / (K + rank)))
  embeddingHits.forEach((hit, rank) => scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (K + rank)))

  const factById = new Map<number, MemoryFact>(ftsFacts.map((f) => [f.id, f]))
  const merged: MemoryFact[] = []
  for (const [id] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
    const fact = factById.get(id) ?? getMemoryById(db, id) ?? undefined
    // Enforce the agent scope on embedding hits too: getMemoryById bypasses
    // the SQL agent filter, so a semantic match could otherwise leak another
    // persona's fact into a scoped search.
    if (fact && options.agentId !== undefined && fact.agentId !== null
      && fact.agentId !== options.agentId && fact.agentId !== 'shared') {
      continue
    }
    if (fact) merged.push(fact)
    if (merged.length >= options.limit) break
  }
  return { facts: merged, semantic: true }
}

export interface SearchMemoriesToolOptions {
  db: Database
  getCurrentUserId?: () => number | undefined
  /**
   * Supplies the persona (agentId) the calling runtime belongs to.
   * Non-'main' personas only see their own facts plus 'shared' facts;
   * 'main' (and legacy callers without this option) see everything.
   */
  getCurrentAgentId?: () => string | undefined
}

export function createSearchMemoriesTool(options: SearchMemoriesToolOptions): AgentTool {
  return {
    name: 'search_memories',
    label: 'Search Memories',
    description:
      'Search the agent\'s fact memory for previously learned information. ' +
      'Returns atomic facts extracted from past conversations. ' +
      'Use this when the user asks about past decisions, preferences, or details discussed in earlier sessions. ' +
      'Supports FTS5 query syntax: word matching, prefix queries (e.g. "config*"), ' +
      'phrase matching (e.g. "postgres port"), and boolean operators (e.g. "docker OR container").',
    parameters: Type.Object({
      query: Type.String({
        description: 'Search query for finding relevant facts from memory.',
      }),
      limit: Type.Optional(
        Type.Number({
          description: 'Maximum number of facts to return (default: 10, max: 50).',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { query, limit: rawLimit } = params as { query?: string; limit?: number }

      if (typeof query !== 'string' || query.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: query must be a non-empty string.' }],
          details: { error: true },
        }
      }

      if (rawLimit !== undefined && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
        return {
          content: [{ type: 'text' as const, text: 'Error: limit must be a positive number.' }],
          details: { error: true },
        }
      }

      try {
        const limit = Math.min(Math.max(Math.floor(rawLimit ?? 10), 1), 50)
        const userId = options.getCurrentUserId?.()
        // Persona scoping: non-'main' personas only search their own facts
        // (+ 'shared'). Main stays unscoped — it is the orchestrator and
        // legacy facts are labeled 'main'.
        const callerAgentId = options.getCurrentAgentId?.()
        const agentScope = callerAgentId && callerAgentId !== 'main' ? callerAgentId : undefined
        const { facts, semantic } = await searchMemoriesHybrid(options.db, query, {
          userId,
          limit,
          agentId: agentScope,
        })

        if (facts.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No memories found for query "${query}".` }],
            details: {
              count: 0,
              query,
              limit,
              userId,
            },
          }
        }

        const formatted = facts.map((fact, index) => {
          const header = `${index + 1}. [${fact.timestamp}] [${fact.source}]`
          const sessionLine = fact.sessionId ? `Session: ${fact.sessionId}\n` : ''
          return `${header}\n${sessionLine}${fact.content}`
        }).join('\n\n')

        return {
          content: [{ type: 'text' as const, text: formatted }],
          details: {
            count: facts.length,
            query,
            limit,
            userId,
            semantic,
            facts,
          },
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error searching memories: ${errorMessage}` }],
          details: { error: true },
        }
      }
    },
  }
}
