import { sha256Hex } from './hashes.js'

/**
 * Resolving which archived bytes a writ actually points at.
 *
 * A writ has no transcript root. The TEE signs the request and response hashes and never a
 * pointer to an archive, so a root is a claim by whoever published it — and because notarizing
 * is permissionless, anyone who learned a chat id could once notarize first with a junk root and
 * fix that claim forever. `WritRegistry` therefore keeps an append-only list of candidates, each
 * attributed to its submitter and each bounded by a per-address quota.
 *
 * That moves the question from "who got there first" to arithmetic, which is where it belongs.
 * A reader walks the candidates in submission order and accepts the first whose bytes re-derive
 * the writ: `sha256(request) === reqHash` and `sha256(response) === respHash`. A junk root is
 * then self-evidently junk, and front-running becomes noise.
 *
 * If none of them re-derive, that is an unavailable transcript with the reasons — never a pass,
 * and never a quiet fallback to the first candidate. Nothing about the proof itself depends on
 * the outcome: it was verified by signature recovery when it was notarized, independently of
 * every pointer.
 */

/** One published archive pointer, and the address whose claim it is. */
export type TranscriptCandidate = {
  root: string
  /** Attribution, not endorsement: who to disbelieve if the root turns out to be junk. */
  submitter: string
}

/** What happened when a candidate was tried. */
export type CandidateOutcome = TranscriptCandidate & {
  index: number
  /** `untried` means an earlier candidate already re-derived, so this one was never fetched. */
  state: 'accepted' | 'rejected' | 'unreachable' | 'untried'
  reason?: string
}

export type TranscriptResolution<T> =
  | { ok: true; root: string; submitter: string; index: number; bytes: Uint8Array; value: T; candidates: CandidateOutcome[] }
  | { ok: false; reason: string; candidates: CandidateOutcome[] }

/** The slice of `WritRegistry` this module reads. */
export type TranscriptRegistry = {
  transcriptRoots(id: string): Promise<readonly string[]>
  transcriptSubmitter(id: string, root: string): Promise<string>
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_ROOT = /^0x0{64}$/i

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Every candidate published for a writ, in submission order, each with its submitter.
 *
 * The submitter is read back per root because `transcriptRoots` returns pointers alone, and the
 * pair a reader wants is the pointer to try plus whose claim it is if it does not re-derive.
 */
export async function listTranscriptCandidates(
  registry: TranscriptRegistry,
  id: string,
): Promise<TranscriptCandidate[]> {
  const roots = await registry.transcriptRoots(id)
  return Promise.all(
    roots.map(async (root) => ({
      root: String(root),
      submitter: await registry.transcriptSubmitter(id, String(root)).catch(() => ZERO_ADDRESS),
    })),
  )
}

/**
 * Walks candidates in order and returns the first whose bytes `accept` is willing to take.
 *
 * `accept` is the whole check and it is the caller's, because different readers can afford
 * different amounts of it: re-deriving the two hashes is the minimum, and a caller that also
 * wants the TEE signature recovered passes something stricter. It rejects by throwing, and the
 * message it throws becomes that candidate's reason.
 *
 * Nothing is inferred from a rejection except that this candidate is not the one.
 */
export async function resolveTranscript<T>(o: {
  candidates: readonly TranscriptCandidate[]
  /** Fetches the bytes behind a root, having checked them against it. Throws with a reason. */
  download: (root: string) => Promise<Uint8Array>
  accept: (bytes: Uint8Array, root: string) => T | Promise<T>
}): Promise<TranscriptResolution<T>> {
  const tried: CandidateOutcome[] = []

  for (const [index, candidate] of o.candidates.entries()) {
    const outcome = { ...candidate, index }

    if (ZERO_ROOT.test(candidate.root)) {
      // The registry never lists the zero root — it is the absence of a pointer, not one — so
      // a zero here came from somewhere that is not the registry.
      tried.push({ ...outcome, state: 'unreachable', reason: 'the zero root is not a pointer to anything' })
      continue
    }

    let bytes: Uint8Array
    try {
      bytes = await o.download(candidate.root)
    } catch (e) {
      tried.push({ ...outcome, state: 'unreachable', reason: why(e) })
      continue
    }

    try {
      const value = await o.accept(bytes, candidate.root)
      tried.push({ ...outcome, state: 'accepted' })
      return {
        ok: true,
        root: candidate.root,
        submitter: candidate.submitter,
        index,
        bytes,
        value,
        candidates: [
          ...tried,
          // Candidates after the accepted one are never fetched: the first that re-derives is
          // the answer and the rest would cost bandwidth to learn nothing.
          ...o.candidates.slice(index + 1).map((c, i) => ({
            ...c,
            index: index + 1 + i,
            state: 'untried' as const,
            reason: 'not fetched — an earlier candidate already re-derived',
          })),
        ],
      }
    } catch (e) {
      tried.push({ ...outcome, state: 'rejected', reason: why(e) })
    }
  }

  return { ok: false, reason: explainNoCandidate(tried), candidates: tried }
}

/** Why there is no transcript, in a sentence, naming whose claims failed. */
export function explainNoCandidate(candidates: readonly CandidateOutcome[]): string {
  if (candidates.length === 0) {
    return 'no archive pointer has been published for this writ, so there are no bytes to re-derive it from; anyone can publish one with addTranscript'
  }
  const detail = candidates
    .map((c) => `candidate ${c.index + 1} (${c.root}, published by ${c.submitter}): ${c.reason}`)
    .join('; ')
  return (
    `none of the ${candidates.length} archive pointer${candidates.length === 1 ? '' : 's'} published for this writ ` +
    `lead${candidates.length === 1 ? 's' : ''} to bytes that re-derive it — ${detail}. ` +
    'This says nothing about the proof itself, which was verified against the TEE signature when it was notarized.'
  )
}

/**
 * The minimum check: the archived bytes are the ones this writ committed to.
 *
 * Re-derives both hashes from the bytes rather than reading the transcript's own claims about
 * them, because a doctored transcript would otherwise hand over the hashes that make it fit.
 */
export function rederivesWrit(expected: { reqHash: string; respHash: string }) {
  return (bytes: Uint8Array): { request: string; response: string } => {
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new Error('the archived bytes are not JSON, so nothing can be re-derived from them')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the archived bytes are JSON, but not a transcript object')
    }
    const t = parsed as Record<string, unknown>
    if (typeof t['request'] !== 'string' || typeof t['response'] !== 'string') {
      throw new Error('the archived transcript has no request/response text to re-derive from')
    }

    const enc = new TextEncoder()
    const reqHash = '0x' + sha256Hex(enc.encode(t['request']))
    const respHash = '0x' + sha256Hex(enc.encode(t['response']))
    const reqOk = reqHash === expected.reqHash.toLowerCase()
    const respOk = respHash === expected.respHash.toLowerCase()

    if (!reqOk || !respOk) {
      const broken = !reqOk && !respOk ? 'question and answer' : !reqOk ? 'question' : 'answer'
      throw new Error(`the archived ${broken} does not hash to what this writ committed to on chain`)
    }
    return { request: t['request'], response: t['response'] }
  }
}
