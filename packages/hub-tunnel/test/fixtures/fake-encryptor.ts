import type { Encryptor } from '../../src/encryptor.js'

const DEFAULT_KEY = new Uint8Array([0x42, 0x13, 0x37, 0x99])
const TAG_LENGTH = 4

/**
 * WHY: the tag is derived from the key, so a ciphertext produced under a DIFFERENT key fails the
 * check — the way an AEAD refuses a foreign key rather than handing back garbage plaintext. A
 * key-independent constant made the fake MORE permissive than the port it stands in for, which let
 * cross-group isolation tests pass against a cipher that does not actually authenticate.
 *
 * Not a MAC: it covers the key only, not the ciphertext. That is enough for the fixture, because
 * tamper is simulated by flipping a tag byte (see `corruptNextCiphertexts`), and being stricter
 * than the port is safe where being more permissive is not.
 */
function deriveTag(key: Uint8Array): Uint8Array {
  // FNV-1a over the key bytes.
  let hash = 0x811c9dc5
  for (const byte of key) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  const tag = new Uint8Array(TAG_LENGTH)
  for (let i = 0; i < TAG_LENGTH; i++) {
    tag[i] = (hash >>> (i * 8)) & 0xff
  }
  return tag
}

export type FakeEncryptorOptions = {
  key?: Uint8Array
}

export class FakeEncryptor implements Encryptor {
  #key: Uint8Array
  #tag: Uint8Array
  #pendingEncryptFailures = 0
  #pendingDecryptFailures = 0
  #pendingCorruptions = 0

  constructor(options: FakeEncryptorOptions = {}) {
    const key = options.key ?? DEFAULT_KEY
    if (key.length === 0) {
      throw new Error('FakeEncryptor: key must be non-empty')
    }
    this.#key = key
    this.#tag = deriveTag(key)
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.#pendingEncryptFailures > 0) {
      this.#pendingEncryptFailures--
      throw new Error('FakeEncryptor: encrypt failure')
    }

    const out = new Uint8Array(plaintext.length + TAG_LENGTH)
    for (let i = 0; i < plaintext.length; i++) {
      out[i] = plaintext[i] ^ this.#key[i % this.#key.length]
    }
    out.set(this.#tag, plaintext.length)

    if (this.#pendingCorruptions > 0) {
      this.#pendingCorruptions--
      // WHY: flip a tag byte to simulate wire tamper that decrypt's tag check catches deterministically
      out[out.length - 1] ^= 0xff
    }

    return out
  }

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (this.#pendingDecryptFailures > 0) {
      this.#pendingDecryptFailures--
      throw new Error('FakeEncryptor: decrypt failure')
    }

    if (ciphertext.length < TAG_LENGTH) {
      throw new Error('FakeEncryptor: invalid tag')
    }
    const bodyLength = ciphertext.length - TAG_LENGTH
    for (let i = 0; i < TAG_LENGTH; i++) {
      if (ciphertext[bodyLength + i] !== this.#tag[i]) {
        throw new Error('FakeEncryptor: invalid tag')
      }
    }

    const out = new Uint8Array(bodyLength)
    for (let i = 0; i < bodyLength; i++) {
      out[i] = ciphertext[i] ^ this.#key[i % this.#key.length]
    }
    return out
  }

  failNextEncrypts(n: number): void {
    this.#pendingEncryptFailures += n
  }

  failNextDecrypts(n: number): void {
    this.#pendingDecryptFailures += n
  }

  corruptNextCiphertexts(n: number): void {
    this.#pendingCorruptions += n
  }
}
