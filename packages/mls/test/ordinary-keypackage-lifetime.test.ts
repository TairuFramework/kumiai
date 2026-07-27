import { randomIdentity } from '@kokuin/token'
import { createKeyPackageBundle, ORDINARY_KEY_PACKAGE_LIFETIME_DAYS } from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

describe('ordinary key package lifetime', () => {
  test('is pinned here rather than inherited from ts-mls', () => {
    expect(ORDINARY_KEY_PACKAGE_LIFETIME_DAYS).toBe(30)
  })

  test('createKeyPackageBundle stamps the pinned lifetime, in SECONDS', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const lifetime = bundle.publicPackage.leafNode.lifetime

    // Pinned in seconds and at the real magnitude. A milliseconds regression here would make every
    // minted package look decades-fresh, the pool would never refresh, and every other test in the
    // suite would stay green — the exact failure shape the last-resort branch hit on `notAfter`.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const expectedNotAfter = nowSeconds + ORDINARY_KEY_PACKAGE_LIFETIME_DAYS * 86_400
    expect(Number(lifetime.notAfter)).toBeGreaterThan(expectedNotAfter - 3600)
    expect(Number(lifetime.notAfter)).toBeLessThan(expectedNotAfter + 3600)

    // Back-dated a day, so a peer with a slow clock cannot reject a package minted seconds ago.
    expect(Number(lifetime.notBefore)).toBeGreaterThan(nowSeconds - 86_400 - 3600)
    expect(Number(lifetime.notBefore)).toBeLessThan(nowSeconds - 86_400 + 3600)
  })
})
