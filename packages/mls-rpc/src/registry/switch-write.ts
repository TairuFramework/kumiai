import type {
  AdoptionWrite,
  AdoptionWriteFactory,
  CapturedRejoinRecord,
  StagedAdoption,
} from '@kumiai/rpc'

import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import type { RegistrySwitchWrite } from './types.js'

function exactFields(value: object, fields: Array<string>): boolean {
  return (
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

function adopted(record: CapturedRejoinRecord, staged: StagedAdoption): CapturedRejoinRecord {
  if (
    record.format !== 2 ||
    record.stage !== 'confirmed' ||
    (record.trigger === 'automatic' ? record.authorisationID !== null : !record.authorisationID) ||
    record.destinationKey !== null ||
    typeof record.switchMutationID !== 'string' ||
    record.switchMutationID.length === 0 ||
    typeof record.position !== 'string' ||
    record.position.length === 0 ||
    staged.incarnation !== record.source.key.incarnation + 1 ||
    staged.epochAfter !== record.epochAfter ||
    staged.removed
  )
    throw new TypeError('Confirmed saved recovery switch required')
  return {
    ...record,
    stage: 'adopted',
    destinationKey: { groupID: record.source.key.groupID, incarnation: staged.incarnation },
  }
}

export function createRecoverySwitchFactory(input: CapturedRejoinRecord): AdoptionWriteFactory {
  if (typeof input.switchMutationID !== 'string' || input.switchMutationID.length === 0)
    throw new TypeError('Recovery switch mutation ID required')
  const record = copyStoredValue(input)
  const mutationID = input.switchMutationID
  return (staged) => ({
    mutationID,
    changes: {
      putRejoin: copyStoredValue(adopted(record, staged)),
      cursor: {
        position: record.position as NonNullable<CapturedRejoinRecord['position']>,
        epoch: staged.epochAfter,
      },
    },
  })
}

export function toRegistrySwitchWrite(params: {
  record: CapturedRejoinRecord
  write: AdoptionWrite
  staged: StagedAdoption
}): RegistrySwitchWrite {
  const { record, write, staged } = params
  const next = adopted(record, staged)
  const cursor = {
    position: record.position as NonNullable<CapturedRejoinRecord['position']>,
    epoch: staged.epochAfter,
  }
  if (
    !exactFields(write, ['mutationID', 'changes']) ||
    write.mutationID !== record.switchMutationID ||
    !exactFields(write.changes, ['putRejoin', 'cursor']) ||
    !sameStoredValue(write.changes.putRejoin, next) ||
    !sameStoredValue(write.changes.cursor, cursor)
  )
    throw new TypeError('Restricted recovery adoption write required')
  return {
    mutationID: write.mutationID,
    source: {
      rejoinID: record.id,
      ...(record.trigger === 'manual' ? { authorisationID: record.authorisationID as string } : {}),
    },
    destination: { control: { cursor } },
  }
}
