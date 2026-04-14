import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSendFileTool } from './send-file-tool.js'
import type { FileSenderCallback } from './send-file-tool.js'

describe('createSendFileTool', () => {
  let tmpDir: string
  let testImagePath: string
  let testDocPath: string
  let testEmptyPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-test-'))
    testImagePath = path.join(tmpDir, 'test.png')
    testDocPath = path.join(tmpDir, 'report.pdf')
    testEmptyPath = path.join(tmpDir, 'empty.txt')

    // Create test files
    fs.writeFileSync(testImagePath, 'fake-png-data')
    fs.writeFileSync(testDocPath, 'fake-pdf-data')
    fs.writeFileSync(testEmptyPath, '')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('has correct name and description', () => {
    const tool = createSendFileTool({ getFileSender: () => null })
    expect(tool.name).toBe('send_file')
    expect(tool.label).toBe('Send File')
    expect(tool.description).toContain('Send a file')
    expect(tool.description).toContain('Telegram')
  })

  it('returns error when file does not exist', async () => {
    const tool = createSendFileTool({ getFileSender: () => null })
    const result = await tool.execute('call-1', { path: '/nonexistent/file.txt' })
    expect(((result.content[0] as any).text)).toContain('Error: File not found')
    expect(result.details?.error).toBe(true)
  })

  it('returns error when path is a directory', async () => {
    const tool = createSendFileTool({ getFileSender: () => null })
    const result = await tool.execute('call-2', { path: tmpDir })
    expect(((result.content[0] as any).text)).toContain('Error: Path is not a file')
    expect(result.details?.error).toBe(true)
  })

  it('returns error when file is empty', async () => {
    const tool = createSendFileTool({ getFileSender: () => null })
    const result = await tool.execute('call-3', { path: testEmptyPath })
    expect(((result.content[0] as any).text)).toContain('Error: File is empty')
    expect(result.details?.error).toBe(true)
  })

  it('returns error when no file sender is available', async () => {
    const tool = createSendFileTool({ getFileSender: () => null })
    const result = await tool.execute('call-4', { path: testImagePath })
    expect(((result.content[0] as any).text)).toContain('Error: File sending is not available')
    expect(result.details?.error).toBe(true)
  })

  it('sends image files via sendPhoto', async () => {
    const mockSender: FileSenderCallback = vi.fn().mockResolvedValue(true)
    const tool = createSendFileTool({ getFileSender: () => mockSender })

    const result = await tool.execute('call-5', { path: testImagePath, caption: 'A test image' })

    expect(((result.content[0] as any).text)).toContain('Successfully sent image')
    expect(((result.content[0] as any).text)).toContain('test.png')
    expect(result.details?.isImage).toBe(true)
    expect(result.details?.error).toBeUndefined()
    expect(mockSender).toHaveBeenCalledWith(testImagePath, 'A test image', true)
  })

  it('sends non-image files as documents', async () => {
    const mockSender: FileSenderCallback = vi.fn().mockResolvedValue(true)
    const tool = createSendFileTool({ getFileSender: () => mockSender })

    const result = await tool.execute('call-6', { path: testDocPath })

    expect(((result.content[0] as any).text)).toContain('Successfully sent document')
    expect(((result.content[0] as any).text)).toContain('report.pdf')
    expect(result.details?.isImage).toBe(false)
    expect(result.details?.error).toBeUndefined()
    expect(mockSender).toHaveBeenCalledWith(testDocPath, undefined, false)
  })

  it('handles sender errors', async () => {
    const mockSender: FileSenderCallback = vi.fn().mockResolvedValue('Telegram API error: 400')
    const tool = createSendFileTool({ getFileSender: () => mockSender })

    const result = await tool.execute('call-7', { path: testImagePath })

    expect(((result.content[0] as any).text)).toContain('Error sending file')
    expect(((result.content[0] as any).text)).toContain('Telegram API error: 400')
    expect(result.details?.error).toBe(true)
  })

  it('handles sender exceptions', async () => {
    const mockSender: FileSenderCallback = vi.fn().mockRejectedValue(new Error('Connection refused'))
    const tool = createSendFileTool({ getFileSender: () => mockSender })

    const result = await tool.execute('call-8', { path: testImagePath })

    expect(((result.content[0] as any).text)).toContain('Error sending file')
    expect(((result.content[0] as any).text)).toContain('Connection refused')
    expect(result.details?.error).toBe(true)
  })

  it('recognizes various image extensions', async () => {
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
    const mockSender: FileSenderCallback = vi.fn().mockResolvedValue(true)

    for (const ext of imageExtensions) {
      const filePath = path.join(tmpDir, `photo${ext}`)
      fs.writeFileSync(filePath, 'image-data')

      const tool = createSendFileTool({ getFileSender: () => mockSender })
      const result = await tool.execute(`call-img-${ext}`, { path: filePath })

      expect(((result.content[0] as any).text)).toContain('Successfully sent image')
      expect(result.details?.isImage).toBe(true)
    }
  })

  it('treats non-image extensions as documents', async () => {
    const docExtensions = ['.txt', '.csv', '.zip', '.html', '.json', '.mp4']
    const mockSender: FileSenderCallback = vi.fn().mockResolvedValue(true)

    for (const ext of docExtensions) {
      const filePath = path.join(tmpDir, `file${ext}`)
      fs.writeFileSync(filePath, 'file-data')

      const tool = createSendFileTool({ getFileSender: () => mockSender })
      const result = await tool.execute(`call-doc-${ext}`, { path: filePath })

      expect(((result.content[0] as any).text)).toContain('Successfully sent document')
      expect(result.details?.isImage).toBe(false)
    }
  })

  it('returns file metadata on success', async () => {
    const mockSender: FileSenderCallback = vi.fn().mockResolvedValue(true)
    const tool = createSendFileTool({ getFileSender: () => mockSender })

    const result = await tool.execute('call-meta', { path: testDocPath })

    expect(result.details?.path).toBe(testDocPath)
    expect(result.details?.fileName).toBe('report.pdf')
    expect(result.details?.isImage).toBe(false)
    expect(result.details?.size).toBeGreaterThan(0)
  })
})
