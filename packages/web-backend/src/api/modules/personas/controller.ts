import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { validateAgentId, validatePersonaFiles } from './schema.js'
import * as service from './service.js'

export interface PersonasController {
  list: (req: AuthenticatedRequest, res: Response) => void
  get: (req: AuthenticatedRequest, res: Response) => void
  update: (req: AuthenticatedRequest, res: Response) => void
  create: (req: AuthenticatedRequest, res: Response) => void
  remove: (req: AuthenticatedRequest, res: Response) => void
}

export function createPersonasController(): PersonasController {
  return {
    list(_req, res) {
      try {
        const personas = service.listPersonas()
        res.json(personas)
      } catch (err) {
        res.status(500).json({ error: `Failed to list personas: ${(err as Error).message}` })
      }
    },

    get(req, res) {
      const { id } = req.params
      const err = validateAgentId(id)
      if (err) {
        res.status(400).json({ error: err })
        return
      }

      try {
        const persona = service.getPersona(id)
        res.json(persona)
      } catch (error) {
        res.status(500).json({ error: `Failed to get persona: ${(error as Error).message}` })
      }
    },

    update(req, res) {
      const { id } = req.params
      const idErr = validateAgentId(id)
      if (idErr) {
        res.status(400).json({ error: idErr })
        return
      }

      const body = req.body as { files?: unknown }
      if (!body.files) {
        res.status(400).json({ error: 'Request body must include "files" object' })
        return
      }

      const filesErr = validatePersonaFiles(body.files)
      if (filesErr) {
        res.status(400).json({ error: filesErr })
        return
      }

      try {
        const persona = service.updatePersona(id, body.files as Record<string, string>)
        res.json(persona)
      } catch (error) {
        res.status(500).json({ error: `Failed to update persona: ${(error as Error).message}` })
      }
    },

    create(req, res) {
      const body = req.body as { id?: unknown }
      const idErr = validateAgentId(body.id)
      if (idErr) {
        res.status(400).json({ error: idErr })
        return
      }

      try {
        const persona = service.createPersona(body.id as string)
        res.status(201).json(persona)
      } catch (error) {
        const msg = (error as Error).message
        if (msg.includes('already exists')) {
          res.status(409).json({ error: msg })
        } else {
          res.status(500).json({ error: `Failed to create persona: ${msg}` })
        }
      }
    },

    remove(req, res) {
      const { id } = req.params
      const idErr = validateAgentId(id)
      if (idErr) {
        res.status(400).json({ error: idErr })
        return
      }

      try {
        service.deletePersona(id)
        res.json({ message: `Persona "${id}" deleted` })
      } catch (error) {
        const msg = (error as Error).message
        if (msg.includes('Cannot delete the main')) {
          res.status(403).json({ error: msg })
        } else if (msg.includes('not found')) {
          res.status(404).json({ error: msg })
        } else {
          res.status(500).json({ error: `Failed to delete persona: ${msg}` })
        }
      }
    },
  }
}
