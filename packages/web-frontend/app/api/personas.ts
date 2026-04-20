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

export function usePersonasApi() {
  const { apiFetch } = useApi()

  const listPersonas = () => apiFetch<PersonaListItem[]>('/api/personas')

  const getPersona = (id: string) => apiFetch<PersonaDetail>(`/api/personas/${encodeURIComponent(id)}`)

  const updatePersona = (id: string, files: Partial<PersonaFiles>) =>
    apiFetch<PersonaDetail>(`/api/personas/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ files }),
    })

  const createPersona = (id: string) =>
    apiFetch<PersonaDetail>('/api/personas', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })

  const deletePersona = (id: string) =>
    apiFetch<{ message: string }>(`/api/personas/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })

  return {
    listPersonas,
    getPersona,
    updatePersona,
    createPersona,
    deletePersona,
  }
}
