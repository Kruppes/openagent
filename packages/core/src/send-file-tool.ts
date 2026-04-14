import fs from 'node:fs'
import nodePath from 'node:path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'

/**
 * Callback signature for sending files to users.
 * Implementations (e.g. Telegram bot) should send the file to the appropriate chat.
 *
 * @param path - Absolute path to the file on disk
 * @param caption - Optional caption/description for the file
 * @param isImage - Whether the file should be sent as a photo (true) or document (false)
 * @returns true on success, error message string on failure
 */
export type FileSenderCallback = (
  path: string,
  caption: string | undefined,
  isImage: boolean,
) => Promise<true | string>

/**
 * Image file extensions that should be sent as photos rather than documents
 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/**
 * Check if a file path points to an image based on its extension
 */
function isImageFile(filePath: string): boolean {
  const ext = nodePath.extname(filePath).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

export interface SendFileToolOptions {
  /**
   * Returns the file sender callback for the current context.
   * Returns null if file sending is not available (e.g., no Telegram bot configured).
   */
  getFileSender: () => FileSenderCallback | null
}

/**
 * Create the `send_file` agent tool that allows sending files (images, documents)
 * to the current user's Telegram chat.
 */
export function createSendFileTool(options: SendFileToolOptions): AgentTool {
  return {
    name: 'send_file',
    label: 'Send File',
    description:
      'Send a file (image, document) to the user via Telegram. ' +
      'Images (png, jpg, gif, webp) are sent as photos; other files are sent as documents. ' +
      'The file must exist on disk at the given path.',
    parameters: Type.Object({
      path: Type.String({
        description: 'Absolute path to the file to send',
      }),
      caption: Type.Optional(
        Type.String({
          description: 'Caption/description for the file',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, caption } = params as { path: string; caption?: string }

      // Validate the file exists
      try {
        const resolved = nodePath.isAbsolute(filePath) ? filePath : nodePath.resolve(filePath)

        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${resolved}` }],
            details: { error: true },
          }
        }

        const stat = fs.statSync(resolved)
        if (!stat.isFile()) {
          return {
            content: [{ type: 'text' as const, text: `Error: Path is not a file: ${resolved}` }],
            details: { error: true },
          }
        }

        // Check file size (Telegram limit: 50MB for bots)
        const maxSize = 50 * 1024 * 1024
        if (stat.size > maxSize) {
          return {
            content: [{ type: 'text' as const, text: `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.` }],
            details: { error: true },
          }
        }

        if (stat.size === 0) {
          return {
            content: [{ type: 'text' as const, text: `Error: File is empty: ${resolved}` }],
            details: { error: true },
          }
        }

        // Get the file sender
        const fileSender = options.getFileSender()
        if (!fileSender) {
          return {
            content: [{ type: 'text' as const, text: 'Error: File sending is not available. No Telegram bot configured or no linked Telegram account for the current user.' }],
            details: { error: true },
          }
        }

        const isImage = isImageFile(resolved)
        const result = await fileSender(resolved, caption, isImage)

        if (result === true) {
          const fileName = nodePath.basename(resolved)
          const typeLabel = isImage ? 'image' : 'document'
          return {
            content: [{ type: 'text' as const, text: `Successfully sent ${typeLabel} "${fileName}" to the user via Telegram.` }],
            details: { path: resolved, fileName, isImage, size: stat.size },
          }
        } else {
          return {
            content: [{ type: 'text' as const, text: `Error sending file: ${result}` }],
            details: { error: true },
          }
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error sending file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }
}
