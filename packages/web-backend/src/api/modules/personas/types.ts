/**
 * Persona types — re-exported from @openagent/core/contracts.
 */

export {
  PERSONA_FILE_NAMES,
  PERSONA_FILE_KEYS,
  PERSONA_FILE_MAX_BYTES,
} from '@openagent/core/contracts'

export type {
  PersonaFileName,
  PersonaFileKey,
  PersonaFilesContract as PersonaFiles,
  PersonaListItemContract as PersonaListItem,
  PersonaDetailContract as PersonaDetail,
  CreatePersonaPayloadContract as CreatePersonaBody,
  UpdatePersonaPayloadContract as UpdatePersonaBody,
} from '@openagent/core/contracts'
