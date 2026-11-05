import { createNapiCrypto } from '@kokuin/crypto-napi'

export * from '@kokuin/crypto'

const crypto = createNapiCrypto()
// A silent fallback would put the suite back on noble, which is what this exists to prevent.
if (crypto.backend !== 'napi') {
  throw new Error(`Native crypto binding did not load: ${crypto.failure?.reason}`)
}

export const nobleCrypto = crypto
