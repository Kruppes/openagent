import express, { Router } from 'express'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createPersonasController } from './controller.js'

export function createPersonasRouter(): Router {
  const router = Router()
  const controller = createPersonasController()

  // Persona-specific body size limit (2 MB — supports up to 6 files × 256 KB + overhead)
  router.use(express.json({ limit: '2mb' }))

  // All persona endpoints require admin auth
  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  router.get('/', controller.list)
  router.post('/', controller.create)
  router.get('/:id', controller.get)
  router.put('/:id', controller.update)
  router.delete('/:id', controller.remove)

  return router
}
