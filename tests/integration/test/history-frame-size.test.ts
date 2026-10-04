import { expect, test } from 'vitest'

test('measures real MLS and sealed ledger-bearing frame sizes', async () => {
  const fixturePath = new URL(
    '../../../packages/mls/test/fixtures/history-probe.ts',
    import.meta.url,
  ).href
  const probe = (await import(fixturePath)) as { frameMeasurements: () => Promise<boolean> }
  expect(await probe.frameMeasurements()).toBe(true)
}, 600_000)
