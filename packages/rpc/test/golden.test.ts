import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'

import { checkGolden, type GoldenCase } from '../../../scripts/golden.ts'
import { decodeCommitFrame, encodeCommitFrame } from '../src/commit-frame.js'
import { assertFrameFits } from '../src/frame-size.js'

const file = fileURLToPath(new URL('./golden/commit-frame.json', import.meta.url))

function commitCases(): Array<GoldenCase> {
  const cases: Array<GoldenCase> = [
    { name: 'empty halves', input: { commit: '', sealedEntries: '' }, expected: '0100000000' },
    {
      name: 'binary halves',
      input: { commit: '00017f80ff', sealedEntries: 'deadbeef00' },
      expected: '010500000000017f80ffdeadbeef00',
    },
    {
      name: 'empty sealed entries',
      input: { commit: 'ff', sealedEntries: '' },
      expected: '0101000000ff',
    },
    {
      name: 'empty commit',
      input: { commit: '', sealedEntries: '00ff' },
      expected: '010000000000ff',
    },
    {
      name: 'multi-byte little-endian length',
      input: { commit: 'ab'.repeat(256), sealedEntries: 'cd' },
      expected: `0100010000${'ab'.repeat(256)}cd`,
    },
  ].map(({ name, input, expected }) => {
    const frame = encodeCommitFrame({
      commit: Buffer.from(input.commit, 'hex'),
      sealedEntries: Buffer.from(input.sealedEntries, 'hex'),
    })
    expect(Buffer.from(frame).toString('hex')).toBe(expected)
    // Decode independently specified bytes, rather than relying only on a round trip.
    const decoded = decodeCommitFrame(Buffer.from(expected, 'hex'))
    const halves = {
      commit: Buffer.from(decoded.commit).toString('hex'),
      sealedEntries: Buffer.from(decoded.sealedEntries).toString('hex'),
    }
    expect(halves).toEqual(input)
    return { name, input, expected: { frame: Buffer.from(frame).toString('hex'), decoded: halves } }
  })

  for (const [name, frame, error, message] of [
    [
      'version 2',
      '0200000000',
      'UnsupportedCommitFrameVersionError',
      'unsupported commit frame version: 2',
    ],
    ['truncated length field', '01010000', 'Error', 'commit frame is too short'],
    [
      'truncated commit',
      '0104000000aabb',
      'Error',
      'commit frame is truncated: the commit runs past the end of the frame',
    ],
  ] as const) {
    const expected = failure(() => decodeCommitFrame(Buffer.from(frame, 'hex')))
    expect(expected).toEqual({ error, message })
    cases.push({ name, input: { frame }, expected })
  }

  for (const rawBytes of [786_432, 786_433]) {
    const bytes = new Uint8Array(rawBytes)
    const base64Chars = Buffer.from(bytes).toString('base64').length
    expect(base64Chars).toBe(4 * Math.ceil(rawBytes / 3))
    const result = failure(() => assertFrameFits(bytes))
    expect(result).toEqual(
      rawBytes === 786_432
        ? { accepted: true }
        : {
            error: 'FrameTooLargeError',
            message: 'Frame of 786433 raw bytes exceeds the 1,048,576-character base64 limit',
          },
    )
    cases.push({
      name: `frame size ${rawBytes}`,
      input: { rawBytes },
      expected: { base64Chars, ...result },
    })
  }
  return cases
}

function failure(action: () => unknown): { accepted: true } | { error: string; message: string } {
  try {
    action()
    return { accepted: true }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { error: error.name, message: error.message }
  }
}

test('golden: commit frames and base64 size limit', () => checkGolden(file, commitCases()))

test('golden: does not write without UPDATE_GOLDEN', () => {
  vi.stubEnv('UPDATE_GOLDEN', '')
  try {
    const before = statSync(file).mtimeMs
    checkGolden(file, commitCases())
    expect(statSync(file).mtimeMs).toBe(before)
  } finally {
    vi.unstubAllEnvs()
  }
})

test('golden: matches by name and rejects changed, missing, extra and duplicate cases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kumiai-golden-'))
  const path = join(dir, 'vectors.json')
  const first = { name: 'first', input: '00', expected: '01' }
  const second = { name: 'second', input: '02', expected: '03' }
  const cases = [first, second]
  vi.stubEnv('UPDATE_GOLDEN', '1')
  try {
    checkGolden(path, cases)
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify({ version: 1, cases }, null, 2)}\n`)
    vi.stubEnv('UPDATE_GOLDEN', '')
    checkGolden(path, [...cases].reverse())
    expect(() =>
      checkGolden(path, [{ name: 'first', input: '00', expected: 'ff' }, second]),
    ).toThrow()
    expect(() =>
      checkGolden(path, [{ name: 'first', input: 'ff', expected: '01' }, second]),
    ).toThrow()
    expect(() => checkGolden(path, cases.slice(1))).toThrow()
    expect(() =>
      checkGolden(path, [...cases, { name: 'extra', input: '', expected: '' }]),
    ).toThrow()
    expect(() => checkGolden(path, [first, first])).toThrow()
    writeFileSync(path, JSON.stringify({ version: 2, cases }))
    expect(() => checkGolden(path, cases)).toThrow()
    writeFileSync(path, JSON.stringify({ version: 1, cases: [first, first] }))
    expect(() => checkGolden(path, cases)).toThrow()
    rmSync(path)
    expect(() => checkGolden(path, cases)).toThrow(/ENOENT/)
    expect(() => statSync(path)).toThrow(/ENOENT/)
  } finally {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  }
})
