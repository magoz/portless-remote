import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['development', 'node'] },
  test: { include: ['src/**/*.test.ts'] }
})
