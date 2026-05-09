import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@axiom/core/contracts': path.resolve(__dirname, 'packages/core/src/contracts/index.ts'),
      '@axiom/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@axiom/telegram': path.resolve(__dirname, 'packages/telegram/src/index.ts'),
      '@axiom/web-backend': path.resolve(__dirname, 'packages/web-backend/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/web-frontend/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
