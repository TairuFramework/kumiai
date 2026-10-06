import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Real MLS crypto across several members; shared CI runners run it 10-20x slower.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
