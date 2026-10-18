import { relinquishSend } from '@kumiai/mls'

import type { ControlHandleAccess } from './access.js'
import { registryCapturedReplacements } from './registry/access.js'
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
      const captured = await relinquishSend(next)
      const replace = registryCapturedReplacements.get(access)
      if (replace === undefined) throw new TypeError('Unknown registry access')
      if (await replace(captured, adoption, prepare)) next.confirmAdopted()
    },
  }
}
