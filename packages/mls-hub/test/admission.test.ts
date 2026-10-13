import { expect, test } from 'vitest'

import { judgeWelcomeAdmission, type WelcomeAdmissionParams } from '../src/index.js'

const authenticator = new Uint8Array([1, 2, 3])
const live = { incarnation: 1, epoch: 10, deleted: false, forkHalted: false }

function params(overrides: Partial<WelcomeAdmissionParams> = {}): WelcomeAdmissionParams {
  return {
    held: live,
    spentEpochAuthenticators: [],
    welcome: { epoch: 10, epochAuthenticator: authenticator },
    ...overrides,
  }
}

test.each([
  { held: null, epoch: 10, want: 'join' },
  { held: live, epoch: 10, want: 'alreadyJoined' },
  { held: live, epoch: 9, want: 'alreadyJoined' },
  { held: live, epoch: 13, want: 'replace' },
  { held: { ...live, deleted: true }, epoch: 9, want: 'join' },
  { held: { ...live, deleted: true }, epoch: 10, want: 'join' },
  { held: { ...live, deleted: true }, epoch: 11, want: 'join' },
  { held: { ...live, epoch: null, deleted: true }, epoch: 0, want: 'join' },
  { held: { ...live, forkHalted: true }, epoch: 13, want: 'refused' },
  { held: { ...live, deleted: true, forkHalted: true }, epoch: 13, want: 'refused' },
  { held: { ...live, epoch: null }, epoch: 13, want: 'refused' },
])('Welcome admission: $held, epoch $epoch → $want', ({ held, epoch, want }) => {
  expect(
    judgeWelcomeAdmission(
      params({
        held,
        welcome: { epoch, epochAuthenticator: authenticator },
      }),
    ),
  ).toBe(want)
})

test.each([9, 10, 13])('spent precedes epoch comparison at epoch %s', (epoch) => {
  expect(
    judgeWelcomeAdmission(
      params({
        spentEpochAuthenticators: [authenticator.slice()],
        welcome: { epoch, epochAuthenticator: authenticator },
      }),
    ),
  ).toBe('refused')
})

test.each([null, { ...live, deleted: true }])(
  'spent refuses absent or deleted state: %s',
  (held) => {
    expect(
      judgeWelcomeAdmission(params({ held, spentEpochAuthenticators: [authenticator.slice()] })),
    ).toBe('refused')
  },
)

test('alternate Welcome identity representation is refused by authenticator bytes', () => {
  expect(
    judgeWelcomeAdmission(
      params({
        spentEpochAuthenticators: [new Uint8Array([9]), authenticator.slice()],
        welcome: { epoch: 20, epochAuthenticator: new Uint8Array([1, 2, 3]) },
      }),
    ),
  ).toBe('refused')
  expect(
    judgeWelcomeAdmission(
      params({
        spentEpochAuthenticators: [new Uint8Array([1, 2]), new Uint8Array([1, 2, 4])],
      }),
    ),
  ).toBe('alreadyJoined')
})

test.each([
  undefined,
  null,
  {},
  { ...params(), spentEpochAuthenticators: undefined },
  { ...params(), spentEpochAuthenticators: null },
  { ...params(), spentEpochAuthenticators: {} },
  { ...params(), spentEpochAuthenticators: [new Uint8Array()] },
  { ...params(), spentEpochAuthenticators: [[1, 2, 3]] },
  { ...params(), spentEpochAuthenticators: new Array(1) },
  { ...params(), welcome: null },
  { ...params(), welcome: { epoch: 10, epochAuthenticator: [] } },
  { ...params(), welcome: { epoch: 10, epochAuthenticator: new Uint8Array() } },
  ...[-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '10', null].map(
    (epoch) => ({
      ...params(),
      welcome: { epoch, epochAuthenticator: authenticator },
    }),
  ),
  { ...params(), held: undefined },
  { ...params(), held: {} },
  ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1'].map(
    (incarnation) => ({
      ...params(),
      held: { ...live, incarnation },
    }),
  ),
  ...[
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '10',
    undefined,
  ].map((epoch) => ({
    ...params(),
    held: { ...live, epoch },
  })),
  { ...params(), held: { ...live, deleted: 0 } },
  { ...params(), held: { ...live, forkHalted: undefined } },
  { ...params(), held: { ...live, deleted: true, incarnation: 0 } },
])('malformed admission inputs throw TypeError: %j', (input) => {
  expect(() => judgeWelcomeAdmission(input as WelcomeAdmissionParams)).toThrow(TypeError)
})
