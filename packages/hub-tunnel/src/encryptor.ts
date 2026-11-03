export type Encryptor = {
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  /**
   * Rejects with `DuplicateFrameError` for a ciphertext this reader has already opened, and with
   * `ExpiredFrameError` for one whose key it no longer holds.
   */
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>
}
