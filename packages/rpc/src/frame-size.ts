export class FrameTooLargeError extends Error {
  override name = 'FrameTooLargeError'

  constructor(params: { rawBytes: number }) {
    super(`Frame of ${params.rawBytes} raw bytes exceeds the 1,048,576-character base64 limit`)
  }
}

/** Check the final sealed and framed bytes before persistence or publication. */
export function assertFrameFits(payload: Uint8Array): void {
  if (4 * Math.ceil(payload.length / 3) > 1_048_576) {
    throw new FrameTooLargeError({ rawBytes: payload.length })
  }
}
