import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    execArgv: [
      '--import',
      new URL('../../scripts/vitest-native-crypto.mjs', import.meta.url).pathname,
    ],
    globalSetup: ['./test/global-setup.ts'],
    // Process Kokuin and the Sozai yielder through Vite even when installed from the
    // registry, so yield-policy tests observe Kokuin's cooperative pauses too. Kokuin crypto stays
    // external so the native-crypto resolve hook still applies.
    server: { deps: { inline: [/@kokuin\/(?!crypto)/, /@sozai\/async/] } },
    // Real MLS crypto across several members; shared CI runners run it 10-20x slower.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
