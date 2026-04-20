/**
 * Persona contracts — shared types and validation for the personas API.
 * Used by both web-backend and web-frontend.
 */

/* ── Constants ── */

export const PERSONA_FILE_NAMES = [
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'AGENTS.md',
  'HEARTBEAT.md',
] as const

export type PersonaFileName = (typeof PERSONA_FILE_NAMES)[number]

export const PERSONA_FILE_KEYS = ['identity', 'soul', 'user', 'tools', 'agents', 'heartbeat'] as const
export type PersonaFileKey = (typeof PERSONA_FILE_KEYS)[number]

/** Maximum size of a single persona file in bytes (256 KB) */
export const PERSONA_FILE_MAX_BYTES = 262_144

/** Agent ID regex: lowercase alphanumeric + hyphens, 2-50 chars, starts with letter */
const AGENT_ID_REGEX = /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/

/* ── Types ── */

export interface PersonaFilesContract {
  identity: string
  soul: string
  user: string
  tools: string
  agents: string
  heartbeat: string
}

export interface PersonaListItemContract {
  id: string
  hasTelegramBinding: boolean
  telegramBotName?: string
  fileCount: number
}

export interface PersonaDetailContract {
  id: string
  files: PersonaFilesContract
  hasTelegramBinding: boolean
}

export interface CreatePersonaPayloadContract {
  id: string
}

export interface UpdatePersonaPayloadContract {
  files: Partial<PersonaFilesContract>
}

/* ── Validation helpers ── */

interface ParseSuccess<T> {
  ok: true
  value: T
}

interface ParseFailure {
  ok: false
  error: string
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure

/**
 * Parse and validate an agent ID.
 * 'main' is always valid. Otherwise must match AGENT_ID_REGEX.
 */
export function parseAgentId(id: unknown): ParseResult<string> {
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: 'id must be a non-empty string' }
  }
  if (id === 'main') {
    return { ok: true, value: 'main' }
  }
  if (id.length < 2 || id.length > 50) {
    return { ok: false, error: 'id must be between 2 and 50 characters' }
  }
  if (!AGENT_ID_REGEX.test(id)) {
    return { ok: false, error: 'id must be lowercase alphanumeric (hyphens allowed, must start with a letter)' }
  }
  return { ok: true, value: id }
}

/**
 * Parse and validate persona file updates.
 * Each key must be a valid PersonaFileKey; each value must be a string
 * not exceeding PERSONA_FILE_MAX_BYTES.
 */
export function parsePersonaFiles(files: unknown): ParseResult<Partial<PersonaFilesContract>> {
  if (!files || typeof files !== 'object') {
    return { ok: false, error: 'files must be an object' }
  }

  const obj = files as Record<string, unknown>
  const result: Partial<PersonaFilesContract> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (!(PERSONA_FILE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown file key: "${key}". Valid keys: ${PERSONA_FILE_KEYS.join(', ')}` }
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `files.${key} must be a string` }
    }
    if (Buffer.byteLength(value, 'utf-8') > PERSONA_FILE_MAX_BYTES) {
      return {
        ok: false,
        error: `files.${key} exceeds maximum size of ${PERSONA_FILE_MAX_BYTES} bytes (${Math.round(PERSONA_FILE_MAX_BYTES / 1024)} KB)`,
      }
    }
    result[key as PersonaFileKey] = value
  }

  return { ok: true, value: result }
}

/**
 * Parse a create-persona request body.
 */
export function parseCreatePersonaPayload(body: unknown): ParseResult<CreatePersonaPayloadContract> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be an object with an "id" field' }
  }
  const obj = body as Record<string, unknown>
  const idResult = parseAgentId(obj.id)
  if (!idResult.ok) return idResult
  return { ok: true, value: { id: idResult.value } }
}

/**
 * Parse an update-persona request body.
 */
export function parseUpdatePersonaPayload(body: unknown): ParseResult<UpdatePersonaPayloadContract> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be an object with a "files" field' }
  }
  const obj = body as Record<string, unknown>
  if (!obj.files) {
    return { ok: false, error: 'Request body must include "files" object' }
  }
  const filesResult = parsePersonaFiles(obj.files)
  if (!filesResult.ok) return filesResult
  return { ok: true, value: { files: filesResult.value } }
}
