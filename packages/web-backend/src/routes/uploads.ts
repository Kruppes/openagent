import express, { type Router } from 'express'
import { sendUploadedFile } from '../uploads.js'

export function createUploadsRouter(): Router {
  const router = express.Router()
  router.get('/*path', sendUploadedFile)
  return router
}
