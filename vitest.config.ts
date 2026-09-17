import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Integration tests share one database. Running files in parallel would make
    // them fight over the same rows and fail for reasons that have nothing to do
    // with the code.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // lib/domain holds the ledger rules. Everything else is orchestration and
      // is covered by integration and Playwright tests instead.
      include: ['lib/domain/**/*.ts'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
})
