import { AsyncLocalStorage } from 'node:async_hooks'
import type { OpenedDeliveryContext } from '@kumiai/rpc'

const storage = new AsyncLocalStorage<object>()
export const openedDeliveryContext: OpenedDeliveryContext = {
  run: (token, fn) => storage.run(token, fn),
  get: () => storage.getStore(),
}
