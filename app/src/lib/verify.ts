import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers'
import { recoverSigner, sameAddress, sha256Hex, signedText, signedTextRouting, utf8, type RoutingFields } from './hashes'
import { parseTranscript, type Transcript } from './transcript'
import { isZeroRoot } from './zg-merkle'

/**
 * The four checks, and the rule they all obey.
 *
 * `pass` means the check ran and the claim held. `fail` means the check ran and the claim did
 * not hold. `unavailable` means the check could not be run at all, and carries the reason.
 *
 * Those last two are kept apart everywhere, in the types and on the screen, because they mean
 * opposite things: a `fail` is evidence, an `unavailable` is a missing measurement. Collapsing
 * them into one "not green" would let a flaky network read as a broken proof.
 */
export type ProofState = 'idle' | 'running' | 'pass' | 'fail' | 'unavailable'

export type ProofRow = {
  key: 'record' | 'provider' | 'transcript' | 'signature'
  /** What is being checked. */
  name: string
  /** What passing it proves, in one clause. */
  claim: string
  state: ProofState
  /** Machine-checkable facts, one line each. */
  evidence: string[]
  /** Why it failed, or why it could not be run. Never populated on a pass. */
  reason?: string
  /** Facts worth knowing that are not failures. */
  notes?: string[]
  ms?: number
}

/** The on-chain record, exactly as `WritRegistry.getWrit` returns it. */
export type WritRecord = {
  id: string
  provider: string
  modelHash: string
  reqHash: string
  respHash: string
  transcriptRoot: string
  notarizedAt: number
  notarizedBy: string
  isRouting: boolean
  routing?: RoutingFields
}

/** A 0G `InferenceServing` entry, as the registry reports it right now. */
export type ServiceRecord = {
  provider: string
  model: string
  url: string
  serviceType: string
  verifiability: string
  teeSignerAddress: string
  teeSignerAcknowledged: boolean
  updatedAt: number
}

export type ProofChain = {
  rows: ProofRow[]
  writ: WritRecord
  service: ServiceRecord | null
  transcript: Transcript | null
  transcriptSource: string | null
  /** The signer `ecrecover` landed on, if the arithmetic could be done at all. */
  recovered: string | null
}

export function emptyRows(): ProofRow[] {
  return [
    {
      key: 'record',
      name: 'The record',
      claim: 'a writ under this identifier exists on chain, and the identifier is a hash of its own contents',
      state: 'idle',
      evidence: [],
    },
    {
      key: 'provider',
      name: 'The provider',
      claim: "0G's own registry publishes this provider as a TEE service, and names the key it signs with",
      state: 'idle',
      evidence: [],
    },
    {
      key: 'transcript',
      name: 'The transcript',
      claim: 'the archived bytes are the ones this writ committed to, question and answer both',
      state: 'idle',
      evidence: [],
    },
    {
      key: 'signature',
      name: 'The signature',
      claim: 'one signature covers that exact question and that exact answer, made by that registered key',
      state: 'idle',
      evidence: [],
    },
  ]
}

/** What the verifier needs from the outside world. Injectable, so the tests need no chain. */
export type VerifySources = {
  /** Reads the writ. Throws if there is no such record. */
  getWrit(id: string): Promise<WritRecord>
  /** Reads 0G's live provider registry. Throws if it cannot answer. */
  getService(provider: string): Promise<ServiceRecord>
  /** Returns the archived bytes, already checked against the merkle root. Throws with a reason. */
  getTranscript(root: string): Promise<{ bytes: Uint8Array; source: string }>
}

export type ProgressFn = (rows: ProofRow[]) => void

function since(t0: number): number {
  return Math.max(1, Math.round(performance.now() - t0))
}

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Runs all four checks, reporting after each so the page can show them landing one at a time.
 *
 * Order matters and the dependencies are real: the signature cannot be checked without both the
 * registered key (row two) and the archived bytes (row three). When a dependency is missing the
 * signature row goes `unavailable` and says which one — it does not guess, and it does not pass.
 */
export async function runProofChain(
  id: string,
  sources: VerifySources,
  onProgress: ProgressFn = () => {},
): Promise<ProofChain> {
  const rows = emptyRows()
  const emit = () => onProgress(rows.map((r) => ({ ...r })))

  const row = (key: ProofRow['key']): ProofRow => rows.find((r) => r.key === key)!

  // ── 1. the record ────────────────────────────────────────────────────────────
  const r1 = row('record')
  r1.state = 'running'
  emit()
  let t0 = performance.now()

  const writ = await sources.getWrit(id)
  const recomputed = writ.isRouting
    ? routingWritId(writ.provider, writ.reqHash, writ.respHash, writ.routing!)
    : writId(writ.provider, writ.reqHash, writ.respHash)

  r1.ms = since(t0)
  r1.evidence = [
    `notarized at block time ${new Date(writ.notarizedAt * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`,
    `submitted by ${writ.notarizedBy}`,
    `id recomputes from (provider, reqHash, respHash)${writ.isRouting ? ' and the routing attribution' : ''}`,
  ]
  if (recomputed.toLowerCase() !== id.toLowerCase()) {
    r1.state = 'fail'
    r1.reason = `This record is filed under ${id} but its own contents hash to ${recomputed}. The identifier does not describe the record.`
  } else {
    r1.state = 'pass'
  }
  emit()

  // ── 2. the provider ──────────────────────────────────────────────────────────
  const r2 = row('provider')
  r2.state = 'running'
  emit()
  t0 = performance.now()

  let service: ServiceRecord | null = null
  try {
    service = await sources.getService(writ.provider)
    r2.ms = since(t0)
    r2.evidence = [
      `model "${service.model}"`,
      `verifiability "${service.verifiability}"`,
      `teeSignerAcknowledged ${service.teeSignerAcknowledged}`,
      `teeSignerAddress ${service.teeSignerAddress}`,
    ]

    const notes: string[] = []
    const currentModelHash = keccak256(toUtf8Bytes(service.model))
    if (currentModelHash.toLowerCase() !== writ.modelHash.toLowerCase()) {
      notes.push(
        `The writ recorded modelHash ${writ.modelHash}, which is not keccak256 of the model this provider serves today. The provider re-registered after this writ was notarized; the recorded hash is still what the gate enforced.`,
      )
    }
    if (notes.length) r2.notes = notes

    if (service.verifiability !== 'TeeML') {
      r2.state = 'fail'
      r2.reason = `0G's registry reports verifiability "${service.verifiability}", not "TeeML". This provider is not running inside an enclave today.`
    } else if (!service.teeSignerAcknowledged) {
      r2.state = 'fail'
      r2.reason = 'This provider has not acknowledged its TEE signer, so the registry publishes no key to check against.'
    } else if (/^0x0{40}$/i.test(service.teeSignerAddress)) {
      r2.state = 'fail'
      r2.reason = 'The registry publishes the zero address as this provider’s TEE signer, which no signature can recover to.'
    } else {
      r2.state = 'pass'
    }
  } catch (e) {
    r2.ms = since(t0)
    r2.state = 'unavailable'
    r2.reason = `0G's InferenceServing registry could not be read for ${writ.provider}: ${why(e)}`
  }
  emit()

  // ── 3. the transcript ────────────────────────────────────────────────────────
  const r3 = row('transcript')
  r3.state = 'running'
  emit()
  t0 = performance.now()

  let transcript: Transcript | null = null
  let transcriptSource: string | null = null

  if (isZeroRoot(writ.transcriptRoot)) {
    r3.ms = since(t0)
    r3.state = 'unavailable'
    r3.reason =
      'This writ carries an empty transcript root. The signature was notarized without archiving what was said, so there are no bytes to check.'
  } else {
    try {
      const fetched = await sources.getTranscript(writ.transcriptRoot)
      transcriptSource = fetched.source
      transcript = parseTranscript(fetched.bytes)

      const [reqDigest, respDigest] = await Promise.all([
        sha256Hex(utf8(transcript.request)),
        sha256Hex(utf8(transcript.response)),
      ])
      r3.ms = since(t0)

      const reqOk = '0x' + reqDigest === writ.reqHash.toLowerCase()
      const respOk = '0x' + respDigest === writ.respHash.toLowerCase()

      r3.evidence = [
        `${fetched.bytes.length} bytes, merkle root rebuilt from ${fetched.source}`,
        `sha256(question) ${reqDigest}`,
        `sha256(answer)   ${respDigest}`,
      ]

      if (!reqOk || !respOk) {
        r3.state = 'fail'
        const broken = !reqOk && !respOk ? 'question and answer' : !reqOk ? 'question' : 'answer'
        r3.reason = `The archived ${broken} does not hash to what this writ committed to on chain. These bytes are not the ones that were signed.`
      } else {
        r3.state = 'pass'
      }
    } catch (e) {
      r3.ms = since(t0)
      r3.state = 'unavailable'
      r3.reason = why(e)
    }
  }
  emit()

  // ── 4. the signature ─────────────────────────────────────────────────────────
  const r4 = row('signature')
  r4.state = 'running'
  emit()
  t0 = performance.now()

  let recovered: string | null = null

  if (!transcript) {
    r4.state = 'unavailable'
    r4.reason = 'The signature is inside the transcript, and the transcript could not be checked. Nothing to recover.'
  } else if (!service) {
    r4.state = 'unavailable'
    r4.reason =
      "Recovery works, but the address it should equal comes from 0G's registry, which did not answer. An unverified match against a self-declared key would prove nothing."
  } else {
    // Rebuilt from the ON-CHAIN hashes, never from the transcript's own claim about them.
    // Otherwise a doctored transcript could hand us the hashes that make its own signature fit.
    const rebuilt = writ.isRouting
      ? signedTextRouting(writ.reqHash, writ.respHash, writ.routing!)
      : signedText(writ.reqHash, writ.respHash)

    recovered = recoverSigner(rebuilt, transcript.signature)
    r4.ms = since(t0)
    r4.evidence = [
      `signed text rebuilt from the chain: ${rebuilt}`,
      `ecrecover → ${recovered ?? 'nothing — the signature is not well formed'}`,
      `registry publishes ${service.teeSignerAddress}`,
    ]

    if (rebuilt !== transcript.signedText) {
      r4.state = 'fail'
      r4.reason = `The transcript claims the TEE signed "${transcript.signedText}", but the chain's own hashes rebuild to "${rebuilt}".`
    } else if (!recovered) {
      r4.state = 'fail'
      r4.reason = 'The signature is not a well-formed 65-byte secp256k1 signature, so no address can be recovered from it.'
    } else if (!sameAddress(recovered, service.teeSignerAddress)) {
      r4.state = 'fail'
      r4.reason = `Recovery lands on ${recovered}, which is not the key 0G's registry publishes for this provider. Whoever signed this was not the enclave.`
    } else {
      r4.state = 'pass'
      if (!sameAddress(recovered, transcript.signingAddress)) {
        r4.notes = [
          `The transcript names ${transcript.signingAddress} as the signer. That claim is ignored — the address checked against is the one the registry publishes.`,
        ]
      }
    }
  }
  emit()

  return { rows, writ, service, transcript, transcriptSource, recovered }
}

/** `WritRegistry.writId`, recomputed locally. */
export function writId(provider: string, reqHash: string, respHash: string): string {
  return keccak256(encodeAbi(['address', 'bytes32', 'bytes32'], [provider, reqHash, respHash]))
}

const ROUTING_PROOF_DOMAIN = keccak256(toUtf8Bytes('writ.routingProof.v1'))

/** `WritRegistry.routingWritId`, recomputed locally. */
export function routingWritId(
  provider: string,
  reqHash: string,
  respHash: string,
  routing: RoutingFields,
): string {
  return keccak256(
    encodeAbi(
      ['bytes32', 'address', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        ROUTING_PROOF_DOMAIN,
        provider,
        reqHash,
        respHash,
        keccak256(toUtf8Bytes(routing.providerType)),
        keccak256(toUtf8Bytes(routing.providerIdentity)),
        routing.tlsFingerprint,
      ],
    ),
  )
}

function encodeAbi(types: string[], values: unknown[]): string {
  return AbiCoder.defaultAbiCoder().encode(types, values)
}

/**
 * The tamper case, computed rather than illustrated.
 *
 * Given the real transcript and an edited question, this re-derives what would actually happen:
 * a different sha256, a different signed text, and a recovery that lands on an address 0G has
 * never published. Nothing is hard-coded, so the numbers on screen are the numbers.
 */
export async function tamperCase(
  writ: WritRecord,
  transcript: Transcript,
  editedRequest: string,
): Promise<{
  originalReqHash: string
  tamperedReqHash: string
  originalSignedText: string
  tamperedSignedText: string
  recovered: string | null
  changed: boolean
}> {
  const tamperedDigest = '0x' + (await sha256Hex(utf8(editedRequest)))
  const original = writ.isRouting
    ? signedTextRouting(writ.reqHash, writ.respHash, writ.routing!)
    : signedText(writ.reqHash, writ.respHash)
  const tampered = writ.isRouting
    ? signedTextRouting(tamperedDigest, writ.respHash, writ.routing!)
    : signedText(tamperedDigest, writ.respHash)

  return {
    originalReqHash: writ.reqHash,
    tamperedReqHash: tamperedDigest,
    originalSignedText: original,
    tamperedSignedText: tampered,
    recovered: recoverSigner(tampered, transcript.signature),
    changed: tamperedDigest.toLowerCase() !== writ.reqHash.toLowerCase(),
  }
}

/** How the page summarises a finished run in one sentence. */
export function chainSummary(rows: ProofRow[]): { state: ProofState; sentence: string } {
  const failed = rows.filter((r) => r.state === 'fail')
  const missing = rows.filter((r) => r.state === 'unavailable')
  if (failed.length > 0) {
    return {
      state: 'fail',
      sentence: `${failed.length === 1 ? 'One check' : `${failed.length} checks`} did not hold. This proof is broken, which is a different thing from a refused transfer.`,
    }
  }
  if (missing.length > 0) {
    return {
      state: 'unavailable',
      sentence: `${missing.length === 1 ? 'One check' : `${missing.length} checks`} could not be run, so the chain is incomplete. An unrun check is not a passed one.`,
    }
  }
  if (rows.every((r) => r.state === 'pass')) {
    return { state: 'pass', sentence: 'All four checks held, re-derived in this browser from public sources.' }
  }
  return { state: 'idle', sentence: 'Not checked yet.' }
}
