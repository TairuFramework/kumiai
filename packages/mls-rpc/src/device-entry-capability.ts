import type { EntryReads, Prepared } from './entry-capability.js'
import type {
  DevicePersistence,
  DeviceRecord,
  DeviceStores,
  GroupTransaction,
} from './persistence-types.js'

export type DeviceEntryReads = { device(): Promise<DeviceRecord>; group: EntryReads }
export type PreparedDevice<TPrepared> = Prepared<TPrepared> & { expectedDeviceRevision: number }
export type DeviceEntryCapability<TTx extends GroupTransaction> = {
  assertRoot(): void
  read<TValue>(work: (stores: DeviceStores<TTx>) => Promise<TValue>): Promise<TValue>
  runCombined<TPrepared, TResult>(
    request: { groupID: string; mutationID: string; signal?: AbortSignal },
    prepare: (reads: DeviceEntryReads) => Promise<PreparedDevice<TPrepared>>,
    work: (stores: DeviceStores<TTx>, prepared: TPrepared) => Promise<TResult>,
  ): Promise<TResult>
}

const bindings = new WeakMap<object, { capability: unknown; coordinatorBinding: object }>()

export function bindDeviceEntryCapability<TTx extends GroupTransaction>(params: {
  device: DevicePersistence<TTx>
  capability: DeviceEntryCapability<TTx>
  coordinatorBinding: object
}): void {
  bindings.set(params.device, params)
}

export function deviceEntryCapability<TTx extends GroupTransaction>(
  device: DevicePersistence<TTx>,
): DeviceEntryCapability<TTx> | null {
  return (bindings.get(device)?.capability as DeviceEntryCapability<TTx> | undefined) ?? null
}
