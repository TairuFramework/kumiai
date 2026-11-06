import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    execArgv: [
      '--import',
      new URL('../../scripts/vitest-native-crypto.mjs', import.meta.url).pathname,
    ],
    experimental: { diagnostics: false },
    // Heal tests are CPU-bound; a fully uncached CI run starves them well past the 5s default.
    testTimeout: 30_000,
  },
})
