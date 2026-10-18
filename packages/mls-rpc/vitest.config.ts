import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Real MLS crypto needs the same runner budget as the MLS and RPC suites.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
