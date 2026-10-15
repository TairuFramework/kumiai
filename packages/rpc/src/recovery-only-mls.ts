import { RecoveryRequiredError } from './commit.js'
import type { GroupMLS } from './crypto.js'

export function recoveryOnlyMLS(port: GroupMLS): GroupMLS {
  const refuse = (): never => {
    throw new RecoveryRequiredError('Private MLS state is unavailable during recovery')
  }
  // Requester recovery uses retained trust and raw candidates, never the lost handle.
  return {
    ownCommitDigest: port.ownCommitDigest,
    onSafetyHold: port.onSafetyHold,
    sendAdmission: port.sendAdmission,
    exportRecoverySecret: port.exportRecoverySecret,
    prepareRecovery: refuse,
    createRecoveryRequest: port.createRecoveryRequest,
    applyRecovery: refuse,
    restoreRecovery: refuse,
    signRecoveryConfirmation: port.signRecoveryConfirmation,
    openRecoveryVerdict: port.openRecoveryVerdict,
    capturedRecovery:
      port.capturedRecovery == null
        ? undefined
        : { ...port.capturedRecovery, sealGroupInfo: refuse },
    validateRecoveryCommit: refuse,
    verifyRecoveryRequest: refuse,
    verifyRecoveryConfirmation: refuse,
    confirmationKey: refuse,
    sealRecoveryVerdict: refuse,
    readEpoch: refuse,
    readRecoverySource: refuse,
    rosterEntries: refuse,
    readCommitHeader: refuse,
    processCommit: refuse,
    sealGroupInfo: refuse,
    isLedgerComplete: refuse,
    getLedger: refuse,
    sealLedger: refuse,
    openSealedLedger: refuse,
    bootstrapLedger: refuse,
  }
}
