/**
 * Persona file names and their corresponding keys.
 */
export const PERSONA_FILE_NAMES = [
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'AGENTS.md',
  'HEARTBEAT.md',
] as const

export type PersonaFileName = typeof PERSONA_FILE_NAMES[number]

export interface PersonaFiles {
  identity: string
  soul: string
  user: string
  tools: string
  agents: string
  heartbeat: string
}

export interface PersonaListItem {
  id: string
  hasTelegramBinding: boolean
  telegramBotName?: string
  fileCount: number
}

export interface PersonaDetail {
  id: string
  files: PersonaFiles
  hasTelegramBinding: boolean
}

export interface CreatePersonaBody {
  id: string
}

export interface UpdatePersonaBody {
  files: Partial<PersonaFiles>
}
