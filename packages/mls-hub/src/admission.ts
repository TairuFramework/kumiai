/** Judge an authenticated Welcome epoch against the host's held state. */
export function judgeWelcomeAdmission(
  held: { epoch: number; deleted: boolean } | null,
  welcomeEpoch: number,
): 'join' | 'alreadyJoined' | 'replace' | 'refused' {
  if (held == null) return 'join'
  if (held.deleted) return welcomeEpoch > held.epoch ? 'join' : 'refused'
  return welcomeEpoch > held.epoch ? 'replace' : 'alreadyJoined'
}
