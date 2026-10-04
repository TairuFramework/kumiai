import type {
  Capabilities,
  CryptoProvider,
  GroupContextExtension,
  IncomingMessageCallback,
  KeyPackage,
  PrivateKeyPackage,
} from 'ts-mls'

import type { ControllerBinding } from './credential.js'
import type { VerifiedLedgerEntry } from './ledger.js'

export type GroupOptions = {
  /** Creator or key-package leaf binding. Creates a lifecycle group when passed to createGroup. */
  controller?: ControllerBinding
  /** Lifecycle leaf lifetime in seconds. Defaults to 86,400; maximum 604,800. */
  leafLifetime?: number
  /** Lifecycle trusted grant lifetime in seconds. Defaults to 2,592,000; maximum 31,536,000. */
  trustedGrantLifetime?: number
  /** Custom CryptoProvider for ts-mls. Defaults to nobleCryptoProvider. */
  cryptoProvider?: CryptoProvider
  /** Ciphersuite name. Defaults to MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519. */
  ciphersuiteName?: string
  /** Group extensions. */
  extensions?: Array<GroupContextExtension>
  /**
   * Raw ts-mls leaf-node capabilities. At createGroup, overrides the
   * auto-derived capabilities; at createKeyPackageBundle, sets the invitee
   * leaf's capabilities (default: defaultCapabilities()).
   */
  capabilities?: Capabilities
  /**
   * Default commit policy for the resulting GroupHandle. Invoked during
   * processMessage for each incoming commit or standalone proposal; return
   * 'reject' to refuse it (the handle stays at its pre-commit epoch and
   * processMessage throws CommitRejectedError). Overridable per call.
   *
   * Replaces the default role rules after mandatory credential and lifecycle gates accept.
   * A caller policy cannot admit a change rejected by those gates. To extend the default
   * role rules, call defaultCommitPolicy from the callback.
   */
  commitPolicy?: IncomingMessageCallback
  /**
   * Fetch control-ledger entry bodies the local ledger lacks. Invoked in the
   * commit pre-pass with the content ids an incoming commit's envelope names but
   * the handle does not hold. Returns signed tokens; the pre-pass keeps only a
   * token whose content-addressed digest matches the requested id and whose
   * signature verifies, so the resolver is untrusted. When absent, a commit that
   * names an unheld entry throws MissingLedgerEntriesError.
   */
  resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
  /**
   * Surface the notarized non-`kumiai.role` ledger entries an accepted commit
   * carried, in envelope order. Never read by kumiai — `kumiai.role` entries fold
   * into the roster, everything else is handed to the consumer here.
   */
  onLedgerEntries?: (entries: Array<VerifiedLedgerEntry>) => void
}

export type Invite = {
  /** Group ID the invite is for */
  groupID: string
  /** Inviter's DID */
  inviterID: string
  /** The group's whole signed control ledger, in application order, so the joiner
   *  folds the same roster as everyone else. The invitee's own role entry is last. */
  ledgerEntries: Array<string>
}

export type KeyPackageBundle = {
  /** MLS key package (binary) */
  publicPackage: KeyPackage
  /** Private key material (keep secret) */
  privatePackage: PrivateKeyPackage
  /** The DID of the key package owner */
  ownerDID: string
}
