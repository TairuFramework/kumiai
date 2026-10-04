import {
  createControllerIdentity,
  createInception,
  createReset,
  createRevoke,
  createRotate,
  didFromInception,
  foldLog,
  type SignedEvent,
} from '@kokuin/controller'
import { createIdentity, encodeMultibase, now, stringifyToken } from '@kokuin/token'
import { sha256 } from '@noble/hashes/sha2.js'
import { createCommit, defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'

import { mintLeafCapability, mintTrustedGrant } from '../../src/capability.js'
import { encodeControlEnvelope } from '../../src/envelope.js'
import { createGroup } from '../../src/group-create.js'
import { createKeyPackageBundle } from '../../src/group-credential.js'
import { deriveGroup } from '../../src/group-handle.js'
import { exportGroupInfo } from '../../src/group-info.js'
import { buildLedgerHeadExtension, computeHead } from '../../src/head.js'
import { ledgerEntryDigest, signLedgerEntry } from '../../src/ledger.js'

export function printTable(rows: Array<Record<string, unknown>>) {
  if (process.env.KUMIAI_PROBE_REPORT !== '1') return
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  process.stdout.write(`| ${keys.join(' | ')} |\n| ${keys.map(() => '---').join(' | ')} |\n`)
  for (const row of rows)
    process.stdout.write(`| ${keys.map((key) => String(row[key] ?? '')).join(' | ')} |\n`)
}

export const seed = new Uint8Array(32).fill(31)
export const inception = createInception(seed, 0)
export const controllerID = didFromInception(inception.event)
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
export const historyBytes = (log: Array<SignedEvent>) =>
  log.reduce((n, event) => n + jsonBytes(event).length, 0)
export const base64Chars = (n: number) => 4 * Math.ceil(n / 3)

export async function peer(byte: number) {
  return createIdentity({
    didMethod: 'peer:4',
    keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: new Uint8Array(32).fill(byte) }],
  })
}

export function buildLog(count: number, target: string, mixed = false) {
  const log: Array<SignedEvent> = [inception]
  let keySeq = 0
  for (let i = 1; i < count; i++) {
    const prior = log.at(-1)
    if (prior == null) throw new Error('Missing prior')
    const position = { gen: 0, seq: keySeq }
    if (mixed && i % 4 === 0) {
      log.push(
        createRevoke({
          seed,
          profile: 0,
          did: controllerID,
          prior: prior.event,
          target,
          keyPosition: position,
        }),
      )
    } else {
      log.push(
        createRotate({
          seed,
          profile: 0,
          did: controllerID,
          prior: prior.event,
          options: { keyPosition: position },
        }),
      )
      keySeq++
    }
  }
  return log
}

export async function logMeasurements() {
  const target = (await peer(71)).id
  const rows = []
  for (const mixed of [false, true]) {
    const log = buildLog(1000, target, mixed)
    const folded = foldLog(controllerID, log)
    if (!folded.ok) throw new Error(folded.reason)
    for (const count of [10, 50, 100, 256]) {
      const bytes = historyBytes(log.slice(0, count))
      rows.push({
        kind: mixed ? 'mixed (3 rotations/revoke)' : 'rotation-only',
        events: count,
        historyBytes: bytes,
        average: bytes / count,
      })
    }
    let running = 0
    const firstOver = log.findIndex((event) => {
      running += jsonBytes(event).length
      return running > 393216
    })
    const prefix = historyBytes(log.slice(0, 50))
    rows.push({
      kind: mixed ? 'mixed maximum within horizon' : 'rotation maximum within horizon',
      events: firstOver,
      historyBytes: historyBytes(log.slice(0, firstOver)),
      average: historyBytes(log.slice(0, firstOver)) / firstOver,
    })
    rows.push({
      kind: mixed ? 'mixed 10 agents x 50' : 'rotation 10 agents x 50',
      events: 500,
      historyBytes: 10 * prefix,
      average: prefix / 50,
    })
    rows.push({
      kind: mixed
        ? 'mixed copies x 50 first over horizon'
        : 'rotation copies x 50 first over horizon',
      events: (Math.floor(393216 / prefix) + 1) * 50,
      historyBytes: (Math.floor(393216 / prefix) + 1) * prefix,
      average: prefix / 50,
    })
  }
  const reset = createReset(seed, 0, 1)
  rows.push({
    kind: '[icp, reset]',
    events: 2,
    historyBytes: historyBytes([inception, reset]),
    average: historyBytes([inception, reset]) / 2,
  })
  printTable(rows)
  printTable(
    [inception, buildLog(2, target)[1], buildLog(5, target, true)[4], reset].map((event) => ({
      event: event?.event.t,
      generation: event?.event.g,
      bytes: jsonBytes(event).length,
    })),
  )
  return rows
}

type RpcCodecs = {
  encodeLedgerEntries: (tokens: Array<string>) => Uint8Array
  encodeCommitFrame: (commit: Uint8Array, entries: Uint8Array) => Uint8Array
  encodeHandshakeFrame: (kind: number, payload: Uint8Array) => Uint8Array
  encodeRecoveryReply: (id: string, bytes: Uint8Array) => Uint8Array
}
type EntrySeal = {
  deriveEntryKey: (group: Awaited<ReturnType<typeof createGroup>>['group']) => Promise<Uint8Array>
  sealEntries: (key: Uint8Array, bytes: Uint8Array) => Uint8Array
}

export async function frameMeasurements() {
  // Runtime loading keeps the probe outside each sibling package's TypeScript rootDir.
  const rpcPath = new URL('../../../rpc/src/index.ts', import.meta.url).href
  const sealPath = new URL('../../../mls-rpc/src/crypto.ts', import.meta.url).href
  const rpc = (await import(rpcPath)) as RpcCodecs
  const entrySeal = (await import(sealPath)) as EntrySeal
  const alice = await peer(41)
  const bob = await peer(51)
  const target = await peer(71)
  const log = buildLog(2000, target.id)
  const sums = [0]
  for (const event of log) sums.push((sums.at(-1) ?? 0) + jsonBytes(event).length)
  const groupID = 'history-probe'
  const requestID = 'e871e04b-e0dc-4a4d-a3ae-c050360d5c22'
  const signer = createControllerIdentity({ seed, profile: 0, log: [inception] })
  const binding = async (identity: typeof alice, prefix: Array<SignedEvent>) => {
    const authority = createControllerIdentity({ seed, profile: 0, log: prefix })
    return {
      id: controllerID,
      prefix,
      capability: await mintLeafCapability({
        signer: authority,
        controllerID,
        audience: identity.id,
        leafKey: identity.publicKey,
        exp: now() + 3600,
      }),
    }
  }
  const parent = await mintTrustedGrant({
    signer,
    controllerID,
    audience: bob.id,
    leafKey: bob.publicKey,
    exp: now() + 7200,
  })
  const child = await mintLeafCapability({
    signer: bob,
    controllerID,
    audience: alice.id,
    leafKey: alice.publicKey,
    exp: now() + 3600,
    parent,
  })
  printTable(
    [parent, child, (await binding(alice, [inception])).capability].map((token, i) => ({
      kind: ['trusted grant', 'chained leaf', 'direct leaf'][i],
      tokenBytes: token.length,
      payloadRawBytes: Buffer.from(token.split('.')[1] ?? '', 'base64url').length,
      payloadBase64urlChars: token.split('.')[1]?.length,
    })),
  )
  type Measurement = {
    history: number
    frames: Record<string, { rawBytes: number; base64Chars: number }>
    proofBytes: number
    proofTokenBytes: number
    consumer: boolean
    count: number
    distribution: string
  }
  const cache = new Map<string, Measurement>()
  async function measure(
    count: number,
    distribution: 'tree' | 'proof',
    consumer: boolean,
    exactHorizon = false,
  ): Promise<Measurement> {
    const key = `${count}/${distribution}/${consumer}/${exactHorizon}`
    const cached = cache.get(key)
    if (cached != null) return cached
    const prefix = distribution === 'tree' ? log.slice(0, count) : [inception]
    if (exactHorizon && distribution === 'tree') {
      const prior = prefix.at(-2)
      if (prior == null) throw new Error('Missing rotation prior')
      const gap = (393216 - 2 * historyBytes(prefix)) / 2
      prefix[count - 1] = createRotate({
        seed,
        profile: 0,
        did: controllerID,
        prior: prior.event,
        options: { keyPosition: { gen: 0, seq: count - 2 }, seal: 's'.repeat(gap - 7) },
      })
    }
    const { group } = await createGroup(alice, groupID, {
      controller: await binding(alice, prefix),
      commitPolicy: () => 'accept',
    })
    const bundle = await createKeyPackageBundle(bob, { controller: await binding(bob, prefix) })
    const tokens: Array<string> = []
    let proof: Array<SignedEvent> = []
    if (distribution === 'proof') {
      const rotations = log.slice(0, count)
      const prior = rotations.at(-1)
      if (prior == null) throw new Error('Missing proof prior')
      proof = [
        ...rotations,
        createRevoke({
          seed,
          profile: 0,
          did: controllerID,
          prior: prior.event,
          target: target.id,
          keyPosition: { gen: 0, seq: count - 1 },
        }),
      ]
      if (exactHorizon) {
        const priorRotate = rotations.at(-2)
        if (priorRotate == null) throw new Error('Missing proof rotation prior')
        const sealSize = 393216 - 2 * historyBytes(prefix) - historyBytes(proof) - 7
        let matched = false
        for (let offset = -2; offset <= 2; offset++) {
          const rotation = createRotate({
            seed,
            profile: 0,
            did: controllerID,
            prior: priorRotate.event,
            options: {
              keyPosition: { gen: 0, seq: count - 2 },
              seal: 's'.repeat(sealSize + offset),
            },
          })
          proof = [
            ...rotations.slice(0, -1),
            rotation,
            createRevoke({
              seed,
              profile: 0,
              did: controllerID,
              prior: rotation.event,
              target: target.id,
              keyPosition: { gen: 0, seq: count - 1 },
            }),
          ]
          if (2 * historyBytes(prefix) + historyBytes(proof) === 393216) {
            matched = true
            break
          }
        }
        if (!matched) throw new Error('Cannot reach exact history horizon')
      }
      tokens.push(
        await signLedgerEntry(alice, {
          type: 'kumiai.device',
          groupID,
          subject: target.id,
          value: { op: 'revoke', subject: target.id, proof, revoked: [{ did: target.id }] },
        }),
      )
    }
    if (consumer)
      tokens.push(
        await signLedgerEntry(alice, {
          type: 'consumer.data',
          groupID,
          subject: bob.id,
          value: { data: 'a'.repeat(64 * 1024), label: '組合 café 🚀' },
        }),
      )
    const ids = tokens.map(ledgerEntryDigest)
    const head = buildLedgerHeadExtension(computeHead(groupID, ids))
    const result = await createCommit({
      context: group.context,
      state: group.state,
      ratchetTreeExtension: true,
      authenticatedData: encodeControlEnvelope({ v: 1, entries: ids }),
      extraProposals: [
        { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
        {
          proposalType: defaultProposalTypes.group_context_extensions,
          groupContextExtensions: {
            extensions: group.state.groupContext.extensions.map((ext) =>
              ext.extensionType === head.extensionType ? head : ext,
            ),
          },
        },
      ],
    })
    if (result.welcome == null) throw new Error('Missing Welcome')
    const commit = encode(mlsMessageEncoder, result.commit)
    const welcome = encode(mlsMessageEncoder, result.welcome)
    const ledger = rpc.encodeLedgerEntries(tokens)
    const sealedEntries = entrySeal.sealEntries(await entrySeal.deriveEntryKey(group), ledger)
    const commitFrame = rpc.encodeHandshakeFrame(0, rpc.encodeCommitFrame(commit, sealedEntries))
    const derived = deriveGroup(group, result.newState)
    const { groupInfo } = await exportGroupInfo({ group: derived })
    const attestation = stringifyToken(
      await alice.signToken(
        {
          type: 'kumiai.recovery-groupinfo',
          groupID,
          requestID,
          groupInfoDigest: encodeMultibase(sha256(groupInfo)),
        },
        { embedLongForm: true },
      ),
    )
    const tokenBytes = new TextEncoder().encode(attestation)
    const plaintext = new Uint8Array(8 + tokenBytes.length + groupInfo.length + ledger.length)
    new DataView(plaintext.buffer).setUint32(0, tokenBytes.length)
    plaintext.set(tokenBytes, 4)
    new DataView(plaintext.buffer).setUint32(4 + tokenBytes.length, groupInfo.length)
    plaintext.set(groupInfo, 8 + tokenBytes.length)
    plaintext.set(ledger, 8 + tokenBytes.length + groupInfo.length)
    const hpke = group.context.cipherSuite.hpke
    const ephemeral = await hpke.generateKeyPair()
    const info = new TextEncoder().encode('kumiai/mls/recovery/v1')
    const field = (text: string) => {
      const bytes = new TextEncoder().encode(text)
      const out = new Uint8Array(4 + bytes.length)
      new DataView(out.buffer).setUint32(0, bytes.length)
      out.set(bytes, 4)
      return out
    }
    const aad = Buffer.concat([
      new TextEncoder().encode('kumiai/mls/recovery-aad/v1'),
      field(groupID),
      field(bob.id),
      field(requestID),
    ])
    const { ct, enc } = await hpke.seal(ephemeral.publicKey, plaintext, info, aad)
    const opened = await hpke.open(ephemeral.privateKey, enc, ct, info, aad)
    if (!Buffer.from(opened).equals(Buffer.from(plaintext)))
      throw new Error('HPKE round trip failed')
    const sealed = Uint8Array.from([1, ...enc, ...ct])
    const reply = rpc.encodeHandshakeFrame(2, rpc.encodeRecoveryReply(requestID, sealed))
    const invite = jsonBytes({
      groupID,
      inviterID: alice.id,
      recipientDID: bob.id,
      ledgerEntries: tokens,
    })
    const verdictToken = stringifyToken(
      await alice.signToken(
        {
          groupID,
          requestID,
          position: '1',
          commitDigest: ledgerEntryDigest(attestation),
          verdict: 'confirmed',
          epoch: '1',
          tag: encodeMultibase(sha256(commit)),
        },
        { embedLongForm: true },
      ),
    )
    const verdictSeal = await hpke.seal(
      ephemeral.publicKey,
      new TextEncoder().encode(verdictToken),
      new TextEncoder().encode('kumiai/mls/recovery-verdict/v1'),
      aad,
    )
    const verdict = rpc.encodeHandshakeFrame(
      6,
      rpc.encodeRecoveryReply(
        requestID,
        Uint8Array.from([1, ...verdictSeal.enc, ...verdictSeal.ct]),
      ),
    )
    const frames = {
      commit: commitFrame,
      Welcome: welcome,
      'Welcome + ledger (provisional binary attachment)': Buffer.concat([welcome, ledger]),
      'invite (JSON fixture)': invite,
      'sealed GroupInfo + ledger (provisional)': reply,
      'verdict (estimated shape)': verdict,
    }
    const history = 2 * historyBytes(prefix) + historyBytes(proof)
    const measured = {
      history,
      frames: Object.fromEntries(
        Object.entries(frames).map(([name, bytes]) => [
          name,
          { rawBytes: bytes.length, base64Chars: Buffer.from(bytes).toString('base64').length },
        ]),
      ),
      proofBytes: historyBytes(proof),
      proofTokenBytes: distribution === 'proof' ? (tokens[0]?.length ?? 0) : 0,
      consumer,
      count,
      distribution,
    }
    cache.set(key, measured)
    return measured
  }
  const rows = []
  const ceilings = []
  for (const distribution of ['tree', 'proof'] as const) {
    for (const consumer of [false, true]) {
      let near = 1
      while (
        (distribution === 'tree'
          ? 2 * (sums[near + 1] ?? 0)
          : 2 * jsonBytes(inception).length + (sums[near + 1] ?? 0) + 337) <= 393216
      )
        near++
      const horizon = await measure(near, distribution, consumer, true)
      if (horizon.history !== 393216) throw new Error('Horizon sample is not exact')
      for (const [frame, size] of Object.entries(horizon.frames))
        rows.push({
          distribution,
          consumerBytes: consumer ? 65536 : 0,
          frame,
          events: near,
          historyBytes: horizon.history,
          ...size,
          rawMargin: 786432 - size.rawBytes,
          base64Margin: 1048576 - size.base64Chars,
        })
      printTable([
        {
          distribution,
          consumer,
          proofRawBytes: horizon.proofBytes,
          proofTokenBytes: horizon.proofTokenBytes,
          expansion: horizon.proofBytes === 0 ? null : horizon.proofTokenBytes / horizon.proofBytes,
        },
      ])
      for (const frame of Object.keys(horizon.frames)) {
        const independent =
          frame === 'verdict (estimated shape)' ||
          (distribution === 'tree' && frame === 'invite (JSON fixture)') ||
          (distribution === 'proof' && frame === 'Welcome')
        if (independent) {
          ceilings.push({
            distribution,
            consumerBytes: consumer ? 65536 : 0,
            frame,
            ceiling: 'no history-dependent ceiling in this fixture shape',
            rawBytes: horizon.frames[frame]?.rawBytes,
            base64Chars: horizon.frames[frame]?.base64Chars,
          })
          continue
        }
        const sample = await measure(near, distribution, consumer)
        const slope = distribution === 'tree' ? 912 : 608
        let low = Math.min(
          1998,
          near + Math.floor((786432 - (sample.frames[frame]?.rawBytes ?? 0)) / slope),
        )
        let high = low + 1
        let bracketed = false
        for (let attempt = 0; attempt < 12; attempt++) {
          const lower = await measure(low, distribution, consumer)
          const upper = await measure(high, distribution, consumer)
          if (
            (lower.frames[frame]?.rawBytes ?? Number.POSITIVE_INFINITY) <= 786432 &&
            (upper.frames[frame]?.rawBytes ?? 0) > 786432
          ) {
            bracketed = true
            break
          }
          if ((lower.frames[frame]?.rawBytes ?? Number.POSITIVE_INFINITY) > 786432) {
            low--
            high--
          } else {
            low++
            high++
          }
        }
        if (!bracketed) throw new Error(`No empirical ceiling bracket for ${distribution}/${frame}`)
        const fits = await measure(low, distribution, consumer)
        const fails = await measure(high, distribution, consumer)
        if (
          (fits.frames[frame]?.base64Chars ?? Number.POSITIVE_INFINITY) > 1048576 ||
          (fails.frames[frame]?.base64Chars ?? 0) <= 1048576
        )
          throw new Error('Ceiling does not bracket frame cap')
        ceilings.push({
          distribution,
          consumerBytes: consumer ? 65536 : 0,
          frame,
          maxFitHistoryBytes: fits.history,
          events: low,
          rawBytes: fits.frames[frame]?.rawBytes,
          base64Chars: fits.frames[frame]?.base64Chars,
          nextHistoryBytes: fails.history,
          nextRawBytes: fails.frames[frame]?.rawBytes,
          nextBase64Chars: fails.frames[frame]?.base64Chars,
        })
      }
    }
  }
  printTable(rows)
  printTable(ceilings)
  if (process.env.KUMIAI_PROBE_REPORT === '1')
    process.stdout.write(`PROBE_JSON ${JSON.stringify({ rows, ceilings })}\n`)
  return rows.length > 0 && ceilings.length > 0
}
