/**
 * A peer that has been disposed refused an operation. A caller branches on this: retry against a
 * fresh peer, versus surface to the user. Lifecycle conditions a caller acts on get a named class;
 * programmer errors (`Unknown protocol`, no-MLS-port) stay bare `Error`.
 */
export class PeerDisposedError extends Error {
  override name = 'PeerDisposedError'
}

export class AppOutboxFullError extends Error {
  override name = 'AppOutboxFullError'
}

export class AppEntryTooLargeError extends Error {
  override name = 'AppEntryTooLargeError'
}

export class SendNotAdmissibleError extends Error {
  override name = 'SendNotAdmissibleError'
  #reason: 'lapsed'

  constructor(reason: 'lapsed') {
    super(`Send is not admissible: ${reason}`)
    this.#reason = reason
  }

  get reason(): 'lapsed' {
    return this.#reason
  }
}
