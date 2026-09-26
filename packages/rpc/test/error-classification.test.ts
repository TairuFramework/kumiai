import { expect, test } from 'vitest'

import { FrameEpochError, isAppFrameStorageError, isFrameAhead } from '../src/crypto.js'

// Another installed copy of this package throws errors of its own classes.
class ForeignFrameEpochError extends Error {
  #frameEpoch: number
  #handleEpoch: number

  constructor(frameEpoch: number, handleEpoch: number) {
    super('frame epoch differs')
    this.name = 'FrameEpochError'
    this.#frameEpoch = frameEpoch
    this.#handleEpoch = handleEpoch
  }

  get frameEpoch(): number {
    return this.#frameEpoch
  }

  get handleEpoch(): number {
    return this.#handleEpoch
  }
}

class ForeignAppFrameStorageError extends Error {
  constructor() {
    super('write failed')
    this.name = 'AppFrameStorageError'
  }
}

test('frame and storage errors from another copy of the package are classified', () => {
  expect(isFrameAhead(new ForeignFrameEpochError(3, 2))).toBe(true)
  expect(isFrameAhead(new ForeignFrameEpochError(1, 2))).toBe(false)
  expect(isAppFrameStorageError(new ForeignAppFrameStorageError())).toBe(true)
})

test('unrelated errors are not classified', () => {
  expect(isFrameAhead(new FrameEpochError(1, 2))).toBe(false)
  expect(isFrameAhead(Object.assign(new Error('x'), { name: 'FrameEpochError' }))).toBe(false)
  expect(isFrameAhead({ name: 'FrameEpochError', frameEpoch: 3, handleEpoch: 2 })).toBe(false)
  expect(isAppFrameStorageError(new Error('write failed'))).toBe(false)
})
