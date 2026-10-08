import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    experimental: { diagnostics: false },
    // Heal tests are CPU-bound; a fully uncached CI run starves them well past the 5s default.
    testTimeout: 30_000,
  },
})
