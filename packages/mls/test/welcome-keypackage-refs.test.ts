import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { commitInvite, createGroup, createInvite, createKeyPackageBundle } from '../src/group.js'
import { keyPackageRef } from '../src/key-package-codec.js'
import { welcomeKeyPackageRefs } from '../src/welcome-refs.js'

describe('welcomeKeyPackageRefs', () => {
  test('names the ref of the package the Welcome was built for', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group } = await createGroup(alice, 'group:welcome-refs')
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bundle = await createKeyPackageBundle(bob)
    const added = await commitInvite(group, bundle.publicPackage, invite)

    const refs = welcomeKeyPackageRefs(added.welcomeMessage)

    expect(refs).toEqual([await keyPackageRef(bundle.publicPackage)])
  })

  test('rejects bytes that are not a framed Welcome', () => {
    expect(() => welcomeKeyPackageRefs(new Uint8Array([1, 2, 3]))).toThrow(
      /expected a framed MLSMessage\(Welcome\)/,
    )
  })

  test('rejects an object that is not a Welcome', () => {
    expect(() => welcomeKeyPackageRefs({ nope: true })).toThrow(/not a Welcome/)
  })
})
