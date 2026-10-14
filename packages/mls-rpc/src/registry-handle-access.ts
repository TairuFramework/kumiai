import type { ControlHandleAccess } from './access.js'
import { RegistryRecoveryReplacementError } from './persistence-errors.js'
import type { RegistryHandleAccess } from './registry/types.js'

export function createRegistryHandleAccess(params: {
  access: RegistryHandleAccess
}): ControlHandleAccess {
  const { access } = params
  return {
    epoch: () => access.epoch(),
    admission: () => access.admission(),
    read: (fn) => access.read(fn),
    readControl: (fn) => access.readControl(fn),
    mutate: (fn, adoption) => access.mutate(fn, adoption),
    async replace(next, adoption, prepare) {
      if (prepare !== undefined) {
        const current = await access.readControl(async ({ handle, source }) => ({ handle, source }))
        if (!(await prepare(current.handle, current.source))) return
      }
      const write = adoption?.({
        incarnation: access.key.incarnation,
        epochAfter: Number(next.epoch),
        removed: next.state.groupActiveState.kind === 'removedFromGroup',
        epochAuthenticator: next.state.keySchedule.epochAuthenticator.slice(),
      })
      if (write?.expected === undefined)
        throw new RegistryRecoveryReplacementError('Ordinary replacement requires provenance')
      const { key, identity, stateVersion } = write.expected
      const result = await access.adopt(next, { key, identity, stateVersion }, write)
      if (result === 'moved') {
        const error = new Error('Ordinary adoption source or candidate moved')
        error.name = 'ControlAdoptionMovedError'
        throw error
      }
      next.confirmAdopted()
    },
  }
}
