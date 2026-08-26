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

/**
 * The on-chain record, exactly as `WritRegistry.getWrit` returns it.
 *
 * Note what is NOT here: an archive pointer. The TEE signs the request and response hashes and
 * never a pointer to an archive, so a root is a claim by whoever published it rather than part
 * of the record. Candidates live in `transcriptRoots` and are resolved by re-derivation.
 */
export type WritRecord = {
  id: string
  provider: string
  modelHash: string
  reqHash: string
  respHash: string
  notarizedAt: number
  notarizedBy: string
  isRouting: boolean
  routing?: RoutingFields
}

/** One published archive pointer, and the address whose claim it is. */
export type TranscriptCandidate = {
  root: string
  /** `WritRegistry` attributes every root to its submitter. Attribution, not endorsement. */
  submitter: string
}

/**
 * What happened when a candidate was tried.
 *
 * `rejected` is not evidence against the writ. Anyone may publish a root for any writ, so a
 * candidate that does not re-derive says something about whoever published it and nothing at
 * all about the proof — which was verified by signature recovery, independently of every
 * pointer. That is why a bad candidate never fails the transcript row.
 */
export type CandidateOutcome = TranscriptCandidate & {
  index: number
  /** `untried` means an earlier candidate already re-derived, so this one was never fetched. */
  state: 'accepted' | 'rejected' | 'unreachable' | 'untried'
  reason?: string
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
  /** Every candidate root that was tried, in submission order, and how each one fared. */
  candidates: CandidateOutcome[]
  /** The candidate whose bytes actually re-derived, if any did. */
  acceptedRoot: string | null
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
      claim:
        'one of the archive pointers published for this writ leads to bytes that re-derive it, question and answer both',
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
  /** Every candidate archive pointer published for this writ, in submission order. */
  listTranscriptRoots(id: string): Promise<TranscriptCandidate[]>
  /** Returns the archived bytes, already checked against the merkle root. Throws with a reason. */
  getTranscript(root: string): Promise<{ bytes: Uint8Array; source: string }>
}

export type ProgressFn = (rows: ProofRow[]) => void

export type ResolvedTranscript = {
  transcript: Transcript | null
  root: string | null
  source: string | null
  byteLength: number
  reqDigest: string
  respDigest: string
  candidates: CandidateOutcome[]
}

/**
 * Walks the published archive pointers and takes the first whose bytes actually re-derive.
 *
 * This is the whole reason `Writ` no longer carries a root. Notarization is permissionless, so
 * whoever learned a chat id could once notarize first with a junk root and fix the archive
 * pointer forever. Now anyone may append a candidate, and a reader settles the question by
 * arithmetic rather than by trusting the first publisher: fetch the bytes a candidate points
 * at, sha256 the request and the response, and accept it only if both match what the writ
 * committed to on chain. A junk root is then self-evidently junk, and front-running becomes
 * noise.
 *
 * Every candidate is tried in submission order and the first that re-derives wins. There is no
 * fallback: if none of them re-derive, this returns no transcript and the reasons why, and the
 * caller reports that as `unavailable`.
 */
export async function resolveTranscript(
  writ: Pick<WritRecord, 'reqHash' | 'respHash'>,
  candidates: CandidateOutcome[],
  sources: Pick<VerifySources, 'getTranscript'>,
): Promise<ResolvedTranscript> {
  const tried: CandidateOutcome[] = []
  const empty = {
    transcript: null,
    root: null,
    source: null,
    byteLength: 0,
    reqDigest: '',
    respDigest: '',
  }

  for (const candidate of candidates) {
    if (isZeroRoot(candidate.root)) {
      // The registry never lists the zero root, so one here means a source that is not the
      // registry. It is the absence of a pointer, not a pointer, so it cannot be followed.
      tried.push({ ...candidate, state: 'unreachable', reason: 'the zero root is not a pointer to anything' })
      continue
    }

    let fetched: { bytes: Uint8Array; source: string }
    try {
      fetched = await sources.getTranscript(candidate.root)
    } catch (e) {
      tried.push({ ...candidate, state: 'unreachable', reason: why(e) })
      continue
    }

    let parsed: Transcript
    try {
      parsed = parseTranscript(fetched.bytes)
    } catch (e) {
      tried.push({ ...candidate, state: 'rejected', reason: why(e) })
      continue
    }

    const [reqDigest, respDigest] = await Promise.all([
      sha256Hex(utf8(parsed.request)),
      sha256Hex(utf8(parsed.response)),
    ])
    const reqOk = '0x' + reqDigest === writ.reqHash.toLowerCase()
    const respOk = '0x' + respDigest === writ.respHash.toLowerCase()

    if (!reqOk || !respOk) {
      const broken = !reqOk && !respOk ? 'question and answer' : !reqOk ? 'question' : 'answer'
      tried.push({
        ...candidate,
        state: 'rejected',
        reason: `the archived ${broken} does not hash to what this writ committed to on chain`,
      })
      continue
    }

    tried.push({ ...candidate, state: 'accepted' })
    return {
      transcript: parsed,
      root: candidate.root,
      source: fetched.source,
      byteLength: fetched.bytes.length,
      reqDigest,
      respDigest,
      // Candidates after the accepted one are never fetched: the first that re-derives is the
      // answer, and the rest would cost a reader bandwidth to learn nothing.
      candidates: [
        ...tried,
        ...candidates.slice(tried.length).map((c) => ({
          ...c,
          state: 'untried' as const,
          reason: 'not fetched — an earlier candidate already re-derived',
        })),
      ],
    }
  }

  return { ...empty, candidates: tried }
}

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
  let acceptedRoot: string | null = null
  let candidates: CandidateOutcome[] = []

  try {
    candidates = (await sources.listTranscriptRoots(id)).map((c, index) => ({
      ...c,
      index,
      state: 'rejected' as const,
    }))
  } catch (e) {
    r3.ms = since(t0)
    r3.state = 'unavailable'
    r3.reason = `The list of archive pointers for this writ could not be read from the registry: ${why(e)}`
  }

  if (r3.state === 'running') {
    const resolved = await resolveTranscript(writ, candidates, sources)
    transcript = resolved.transcript
    transcriptSource = resolved.source
    acceptedRoot = resolved.root
    candidates = resolved.candidates
    r3.ms = since(t0)

    if (candidates.length === 0) {
      r3.state = 'unavailable'
      r3.reason =
        'Nobody has published an archive pointer for this writ. The proof was verified from the signature alone, so it stands — but without archived bytes there is nothing here to re-derive it from. Anyone can publish one with addTranscript.'
    } else if (transcript && acceptedRoot) {
      const accepted = candidates.find((c) => c.state === 'accepted')!
      r3.state = 'pass'
      r3.evidence = [
        `candidate ${accepted.index + 1} of ${candidates.length} re-derives: ${acceptedRoot}`,
        `published by ${accepted.submitter}`,
        `${resolved.byteLength} bytes, merkle root rebuilt from ${resolved.source}`,
        `sha256(question) ${resolved.reqDigest}`,
        `sha256(answer)   ${resolved.respDigest}`,
      ]
      const discarded = candidates.filter((c) => c.state === 'rejected' || c.state === 'unreachable')
      if (discarded.length > 0) {
        r3.notes = [
          `${discarded.length === 1 ? 'One earlier pointer was' : `${discarded.length} earlier pointers were`} published for this writ and did not re-derive. That is noise, not evidence: anyone may publish a root for any writ, and this proof was verified by signature recovery independently of all of them.`,
          ...discarded.map((c) => `candidate ${c.index + 1} · ${c.root} · published by ${c.submitter} · ${c.reason}`),
        ]
      }
    } else {
      // Never a pass, and never a fail either. A pointer nobody can re-derive is a claim by
      // whoever published it — treating it as evidence would let a front-runner make a sound
      // writ read as broken by publishing junk before the real archivist got there.
      const only = candidates.length === 1 ? candidates[0]! : null
      r3.state = 'unavailable'
      r3.reason = only
        ? `The one archive pointer published for this writ, by ${only.submitter}, could not be used: ${only.reason}. ` +
          'That says nothing about the proof itself, which was verified against the TEE signature when it was notarized. Anyone can publish a better pointer with addTranscript.'
        : `None of the ${candidates.length} archive pointers published for this writ lead to bytes that re-derive it, so there is nothing here to check the signature against. ` +
          'That says nothing about the proof itself, which was verified against the TEE signature when it was notarized. Anyone can publish a better pointer with addTranscript.'
      r3.notes = candidates.map(
        (c) => `candidate ${c.index + 1} · ${c.root} · published by ${c.submitter} · ${c.reason}`,
      )
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

  return { rows, writ, service, transcript, transcriptSource, candidates, acceptedRoot, recovered }
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
