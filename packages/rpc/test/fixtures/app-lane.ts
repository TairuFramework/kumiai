import type { BusEvents } from '@kumiai/broadcast'
import { EventEmitter } from '@sozai/event'

import type { AppLaneParams } from '../../src/app-lane.js'
import type { PendingAppFrame } from '../../src/crypto.js'
import type { GroupTransaction } from '../../src/handler-completion.js'
import {
  adaptBusHandlers,
  type GroupProcedureHandlers,
  groupHandlerMetadata,
} from '../../src/handlers.js'
import {
  createOpenedAppHandler,
  createOpenedRecordHandler,
  normaliseOpenedAppHandler,
} from '../../src/opened-delivery.js'
import type { GroupProtocolDefinition } from '../../src/protocol.js'
import { createTestCompletion } from './fake-crypto.js'
import { openedDeliveryContext } from './opened-delivery.js'

type Params = Omit<
  AppLaneParams,
  'completion' | 'openedHandler' | 'eventHandlers' | 'protocols'
> & {
  protocols: Record<string, GroupProtocolDefinition>
  eventHandlers?: AppLaneParams['eventHandlers']
  handlers?: Record<string, Record<string, unknown>>
  deliver?: (record: PendingAppFrame) => Promise<void>
}

export function testAppLaneParams(params: Params): AppLaneParams {
  const completion = createTestCompletion(params.groupKey, params.crypto.pending)
  const handlers = params.handlers as
    | Record<string, GroupProcedureHandlers<GroupProtocolDefinition, GroupTransaction>>
    | undefined
  const eventHandlers =
    handlers === undefined
      ? (params.eventHandlers ?? new Map())
      : new Map(
          Object.entries(params.protocols).map(([name, protocol]) => [
            name,
            adaptBusHandlers(protocol, (handlers[name] ?? {}) as never, { completion }).events,
          ]),
        )
  const openedHandler =
    handlers === undefined
      ? normaliseOpenedAppHandler({
          completion,
          openedDeliveryContext,
          deliver:
            params.deliver ??
            createOpenedRecordHandler({
              localDID: params.localDID,
              protocols: params.protocols,
              events: eventHandlers,
            }),
        })
      : {
          completion,
          openedDeliveryContext,
          deliver: (record: PendingAppFrame) =>
            createOpenedAppHandler({
              localDID: params.localDID,
              protocols: params.protocols,
              handlers: handlers as never,
              completion,
              openedDeliveryContext,
            }).deliver(record),
        }
  return { ...params, completion, eventHandlers, openedHandler }
}

export function laneEventObservers(
  handlers: Record<string, Record<string, (context: never) => unknown>>,
  key: AppLaneParams['groupKey'],
): AppLaneParams['eventHandlers'] {
  return new Map(
    Object.entries(handlers).map(([name, procedures]) => {
      const events = new EventEmitter<BusEvents>()
      for (const [procedure, handle] of Object.entries(procedures)) {
        events.on(procedure, async (event) => {
          await handle({
            data: event.data,
            message: { payload: { iss: event.senderDID } },
            ...groupHandlerMetadata(event, key),
          } as never)
        })
      }
      return [name, events]
    }),
  )
}
