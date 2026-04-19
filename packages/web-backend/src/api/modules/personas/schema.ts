/**
 * Validation helpers for the personas API.
 */

const AGENT_ID_REGEX = /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/

/**
 * Validate an agent ID string.
 * Must be lowercase alphanumeric with hyphens, 2-50 chars, starting with a letter.
 */
export function validateAgentId(id: unknown): string | null {
  if (typeof id !== 'string' || !id) {
    return 'id must be a non-empty string'
  }
  if (id === 'main') {
    return null // 'main' is always valid
  }
  if (id.length < 2 || id.length > 50) {
    return 'id must be between 2 and 50 characters'
  }
  if (!AGENT_ID_REGEX.test(id)) {
    return 'id must be lowercase alphanumeric (hyphens allowed, must start with a letter)'
  }
  return null
}

/**
 * Validate persona file content (each file value in the update body).
 */
export function validatePersonaFiles(files: unknown): string | null {
  if (!files || typeof files !== 'object') {
    return 'files must be an object'
  }

  const validKeys = ['identity', 'soul', 'user', 'tools', 'agents', 'heartbeat']
  const obj = files as Record<string, unknown>

  for (const [key, value] of Object.entries(obj)) {
    if (!validKeys.includes(key)) {
      return `Unknown file key: "${key}". Valid keys: ${validKeys.join(', ')}`
    }
    if (typeof value !== 'string') {
      return `files.${key} must be a string`
    }
  }

  return null
}
