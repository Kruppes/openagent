/**
 * Persona validation — delegates to @axiom/core/contracts for single-source-of-truth.
 *
 * Re-exports the contract parsers so existing imports from this module keep working.
 */

export {
  parseAgentId,
  parsePersonaFiles,
  parseCreatePersonaPayload,
  parseUpdatePersonaPayload,
  PERSONA_FILE_MAX_BYTES,
} from '@axiom/core/contracts'
