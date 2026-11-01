export class FrameDecodeError extends Error {
  override name = 'FrameDecodeError'
}

export class EnvelopeDecodeError extends Error {
  override name = 'EnvelopeDecodeError'
}

export class DecryptError extends Error {
  override name = 'DecryptError'
}

/**
 * Thrown by an `Encryptor.decrypt` for a ciphertext this reader has already opened. A hub
 * redelivers a frame whose ack was lost, and a ratcheting cipher cannot open it twice: that is a
 * duplicate, not a lost frame.
 */
export class DuplicateFrameError extends Error {
  override name = 'DuplicateFrameError'
}

export class EncryptError extends Error {
  override name = 'EncryptError'
}

export class BackpressureError extends Error {
  override name = 'BackpressureError'
}

export class HubReconnectingError extends Error {
  override name = 'HubReconnectingError'
}

export class SessionNotEstablishedError extends Error {
  override name = 'SessionNotEstablishedError'
}
