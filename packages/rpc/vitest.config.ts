import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    experimental: { diagnostics: false },
  },
})
