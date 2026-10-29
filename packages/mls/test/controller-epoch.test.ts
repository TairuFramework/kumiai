import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

test.each(['saturatedLog', 'saturatedRegistry'] as const)(
  '%s refuses a missing run path',
  async (name) => {
    vi.stubEnv('KUMIAI_MLS_SATURATED_FIXTURE_PATH', undefined)
    const fixture = await import('./fixtures/controller-epoch.js')
    await expect(fixture[name]()).rejects.toThrow('Missing saturated fixture path')
  },
)

test.each(['saturatedLog', 'saturatedRegistry'] as const)(
  '%s refuses a missing cache file without rebuilding',
  async (name) => {
    const path = process.env.KUMIAI_MLS_SATURATED_FIXTURE_PATH
    if (path == null) throw new Error('Missing saturated fixture path')
    vi.stubEnv('KUMIAI_MLS_SATURATED_FIXTURE_PATH', join(path, 'missing.bin'))
    const fixture = await import('./fixtures/controller-epoch.js')
    await expect(fixture[name]()).rejects.toThrow()
  },
)
