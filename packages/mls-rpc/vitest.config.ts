import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    execArgv: [
      '--import',
      new URL('../../scripts/vitest-native-crypto.mjs', import.meta.url).pathname,
    ],
  },
})
