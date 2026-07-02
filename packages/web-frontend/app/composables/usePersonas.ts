import { usePersonasApi } from '~/api/personas'
import type { PersonaListItem, PersonaDetail, PersonaFiles } from '~/api/personas'

export type { PersonaListItem, PersonaDetail, PersonaFiles }

export function usePersonas() {
  const api = usePersonasApi()

  const personas = ref<PersonaListItem[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchPersonas(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      personas.value = await api.listPersonas()
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function getPersona(id: string): Promise<PersonaDetail | null> {
    try {
      return await api.getPersona(id)
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function updatePersona(id: string, files: Partial<PersonaFiles>): Promise<PersonaDetail | null> {
    try {
      const result = await api.updatePersona(id, files)
      // Refresh list
      await fetchPersonas()
      return result
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function createPersona(id: string): Promise<PersonaDetail | null> {
    try {
      const result = await api.createPersona(id)
      await fetchPersonas()
      return result
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function deletePersona(id: string): Promise<boolean> {
    try {
      await api.deletePersona(id)
      await fetchPersonas()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  return {
    personas,
    loading,
    error,
    fetchPersonas,
    getPersona,
    updatePersona,
    createPersona,
    deletePersona,
  }
}
