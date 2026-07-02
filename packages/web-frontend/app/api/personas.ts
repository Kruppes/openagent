import type {
  PersonaFilesContract,
  PersonaListItemContract,
  PersonaDetailContract,
} from '@axiom/core/contracts'

export type PersonaFiles = PersonaFilesContract
export type PersonaListItem = PersonaListItemContract
export type PersonaDetail = PersonaDetailContract

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
