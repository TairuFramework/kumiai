import type { DIDCache, DIDResolver } from '@kokuin/token'
import type {
  Capabilities,
  CryptoProvider,
  GroupContextExtension,
  IncomingMessageCallback,
  KeyPackage,
  PrivateKeyPackage,
} from 'ts-mls'

import type { VerifiedLedgerEntry } from './ledger.js'

export type GroupOptions = {
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
   * processMessage/decrypt for each incoming commit; return 'reject' to refuse
   * a commit (the handle stays at its pre-commit epoch and processMessage
   * throws CommitRejectedError). Overridable per call.
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
   * Surface the notarized non-`group.role` ledger entries an accepted commit
   * carried, in envelope order. Never read by kumiai — `group.role` entries fold
   * into the roster, everything else is handed to the consumer here.
   */
  onLedgerEntries?: (entries: Array<VerifiedLedgerEntry>) => void
  /** Optional DID cache for resolving did:peer:4 issuers in capability chains. Default: in-memory. */
  cache?: DIDCache
  /** Optional resolver for did:peer:4 short forms not in cache. */
  resolver?: DIDResolver
}

export type GroupSyncScope = {
  groupID: string
  models: Array<{ modelID: string; filter?: Record<string, unknown> }>
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
