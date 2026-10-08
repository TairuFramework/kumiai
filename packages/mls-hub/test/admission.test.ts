import { expect, test } from 'vitest'

import { judgeWelcomeAdmission } from '../src/admission.js'

test.each([
  { held: null, epoch: 10, want: 'join' },
  { held: { epoch: 10, deleted: false }, epoch: 10, want: 'alreadyJoined' },
  { held: { epoch: 10, deleted: false }, epoch: 9, want: 'alreadyJoined' },
  { held: { epoch: 10, deleted: false }, epoch: 13, want: 'replace' },
  { held: { epoch: 10, deleted: true }, epoch: 9, want: 'refused' },
  { held: { epoch: 10, deleted: true }, epoch: 10, want: 'refused' },
  { held: { epoch: 10, deleted: true }, epoch: 11, want: 'join' },
])('Welcome admission: $held, epoch $epoch → $want', ({ held, epoch, want }) => {
  expect(judgeWelcomeAdmission(held, epoch)).toBe(want)
})
