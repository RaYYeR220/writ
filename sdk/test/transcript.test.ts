import { describe, it, expect, vi } from 'vitest'
import {
  explainNoCandidate,
  listTranscriptCandidates,
  rederivesWrit,
  resolveTranscript,
  type TranscriptCandidate,
} from '../src/transcript.js'
import { sha256Hex } from '../src/hashes.js'

/**
 * A writ points at no transcript, so a reader resolves one by arithmetic.
 *
 * These tests are about the one property that matters: being first to publish a pointer buys
 * nothing. The candidate that wins is the one whose bytes re-derive the writ, wherever it sits
 * in the list, and a list of nothing but junk is an unavailable transcript rather than either a
 * pass or a verdict about the proof.
 */

const enc = new TextEncoder()

const ARCHIVIST = '0x2e6b8Dc19A05F34Eb7c0d5a8F2913e6bC47a0D82'
const FRONT_RUNNER = '0x000000000000000000000000000000000000dEaD'
const GOOD_ROOT = '0x' + '11'.repeat(32)
const JUNK_ROOT = '0x' + '99'.repeat(32)

const QUESTION = '{"messages":[{"role":"user","content":"approve this?"}]}'
const ANSWER = '{"choices":[{"message":{"content":"DENY:87"}}]}'

const WRIT = {
  reqHash: '0x' + sha256Hex(enc.encode(QUESTION)),
  respHash: '0x' + sha256Hex(enc.encode(ANSWER)),
}

function transcriptBytes(over: { request?: string; response?: string } = {}): Uint8Array {
  return enc.encode(
    JSON.stringify({
      chatId: 'chat-1',
      request: over.request ?? QUESTION,
      response: over.response ?? ANSWER,
      reqHash: WRIT.reqHash,
      respHash: WRIT.respHash,
    }),
  )
}

/** 0G Storage, reduced to what it holds. Anything unlisted is simply not there. */
function storage(held: Record<string, Uint8Array>) {
  return vi.fn(async (root: string) => {
    const bytes = held[root.toLowerCase()]
    if (!bytes) throw new Error('0G Storage indexer answered: File not found (code 101)')
    return bytes
  })
}

describe('resolveTranscript', () => {
  it('accepts the first candidate that re-derives, whoever published it', async () => {
    const candidates: TranscriptCandidate[] = [{ root: GOOD_ROOT, submitter: ARCHIVIST }]
    const result = await resolveTranscript({
      candidates,
      download: storage({ [GOOD_ROOT.toLowerCase()]: transcriptBytes() }),
      accept: rederivesWrit(WRIT),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.root).toBe(GOOD_ROOT)
    expect(result.submitter).toBe(ARCHIVIST)
    expect(result.index).toBe(0)
    expect(result.value.response).toBe(ANSWER)
  })

  it('walks past a front-runner’s junk root to the real one', async () => {
    // The attack the candidate list exists to defeat: someone learns a chat id and publishes
    // first. Being first is worth nothing, because the bytes decide.
    const result = await resolveTranscript({
      candidates: [
        { root: JUNK_ROOT, submitter: FRONT_RUNNER },
        { root: GOOD_ROOT, submitter: ARCHIVIST },
      ],
      download: storage({
        [JUNK_ROOT.toLowerCase()]: transcriptBytes({ request: 'an entirely different question' }),
        [GOOD_ROOT.toLowerCase()]: transcriptBytes(),
      }),
      accept: rederivesWrit(WRIT),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.root).toBe(GOOD_ROOT)
    expect(result.candidates.map((c) => c.state)).toEqual(['rejected', 'accepted'])
    expect(result.candidates[0]!.reason).toMatch(/question/)
    expect(result.candidates[0]!.submitter).toBe(FRONT_RUNNER)
  })

  it('stops at the first that re-derives instead of fetching the rest', async () => {
    const download = storage({ [GOOD_ROOT.toLowerCase()]: transcriptBytes() })
    const result = await resolveTranscript({
      candidates: [
        { root: GOOD_ROOT, submitter: ARCHIVIST },
        { root: JUNK_ROOT, submitter: FRONT_RUNNER },
      ],
      download,
      accept: rederivesWrit(WRIT),
    })

    expect(download).toHaveBeenCalledTimes(1)
    if (!result.ok) throw new Error('unreachable')
    expect(result.candidates.map((c) => c.state)).toEqual(['accepted', 'untried'])
  })

  it('reports no transcript — never a fallback — when every candidate is junk', async () => {
    const result = await resolveTranscript({
      candidates: [
        { root: JUNK_ROOT, submitter: FRONT_RUNNER },
        { root: GOOD_ROOT, submitter: FRONT_RUNNER },
      ],
      download: storage({
        [JUNK_ROOT.toLowerCase()]: transcriptBytes({ request: 'wrong question' }),
        [GOOD_ROOT.toLowerCase()]: transcriptBytes({ response: 'wrong answer' }),
      }),
      accept: rederivesWrit(WRIT),
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.candidates.map((c) => c.state)).toEqual(['rejected', 'rejected'])
    // Both claims are named, with who made each, and the proof is explicitly left alone.
    expect(result.reason).toContain(FRONT_RUNNER)
    expect(result.reason).toMatch(/says nothing about the proof itself/)
  })

  it('separates a pointer nobody can fetch from one that leads to the wrong bytes', async () => {
    const result = await resolveTranscript({
      candidates: [
        { root: JUNK_ROOT, submitter: FRONT_RUNNER },
        { root: GOOD_ROOT, submitter: ARCHIVIST },
      ],
      download: storage({ [GOOD_ROOT.toLowerCase()]: transcriptBytes() }),
      accept: rederivesWrit(WRIT),
    })

    if (!result.ok) throw new Error('unreachable')
    expect(result.candidates[0]!.state).toBe('unreachable')
    expect(result.candidates[0]!.reason).toMatch(/File not found/)
  })

  it('says plainly when nobody has published a pointer at all', async () => {
    const result = await resolveTranscript({
      candidates: [],
      download: storage({}),
      accept: rederivesWrit(WRIT),
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/no archive pointer has been published/)
    expect(result.reason).toMatch(/addTranscript/)
    expect(explainNoCandidate([])).toBe(result.reason)
  })

  it('never follows the zero root, which is the absence of a pointer', async () => {
    const download = storage({})
    const result = await resolveTranscript({
      candidates: [{ root: '0x' + '00'.repeat(32), submitter: FRONT_RUNNER }],
      download,
      accept: rederivesWrit(WRIT),
    })

    expect(download).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it('lets a stricter caller reject bytes that merely re-hash', async () => {
    // `accept` is the caller's, so a reader that also wants the signature recovered gets to
    // refuse a candidate this module would otherwise have taken.
    const result = await resolveTranscript({
      candidates: [{ root: GOOD_ROOT, submitter: ARCHIVIST }],
      download: storage({ [GOOD_ROOT.toLowerCase()]: transcriptBytes() }),
      accept: () => {
        throw new Error('the archived signature does not recover to the registered TEE signer')
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.candidates[0]!.reason).toMatch(/does not recover/)
  })
})

describe('rederivesWrit', () => {
  it('refuses bytes that are not a transcript rather than filling in blanks', () => {
    const check = rederivesWrit(WRIT)
    expect(() => check(enc.encode('not json'))).toThrow(/not JSON/)
    expect(() => check(enc.encode('[1,2,3]'))).toThrow(/not a transcript object/)
    expect(() => check(enc.encode('{"request":"x"}'))).toThrow(/no request\/response text/)
  })

  it('re-derives from the bytes, not from the transcript’s claims about itself', () => {
    // A doctored transcript that names the right hashes but carries the wrong text is exactly
    // what a naive reader would accept.
    const lying = enc.encode(
      JSON.stringify({ request: 'tampered', response: ANSWER, reqHash: WRIT.reqHash, respHash: WRIT.respHash }),
    )
    expect(() => rederivesWrit(WRIT)(lying)).toThrow(/question does not hash/)
  })
})

describe('listTranscriptCandidates', () => {
  it('pairs every root with the address that published it, in submission order', async () => {
    const registry = {
      transcriptRoots: vi.fn(async () => [JUNK_ROOT, GOOD_ROOT]),
      transcriptSubmitter: vi.fn(async (_id: string, root: string) =>
        root === JUNK_ROOT ? FRONT_RUNNER : ARCHIVIST,
      ),
    }

    expect(await listTranscriptCandidates(registry, '0xid')).toEqual([
      { root: JUNK_ROOT, submitter: FRONT_RUNNER },
      { root: GOOD_ROOT, submitter: ARCHIVIST },
    ])
  })

  it('still lists a root whose submitter cannot be read', async () => {
    // Attribution is a nicety; the pointer is the thing worth trying.
    const registry = {
      transcriptRoots: vi.fn(async () => [GOOD_ROOT]),
      transcriptSubmitter: vi.fn(async () => {
        throw new Error('node refused the call')
      }),
    }

    const [only] = await listTranscriptCandidates(registry, '0xid')
    expect(only!.root).toBe(GOOD_ROOT)
    expect(only!.submitter).toBe('0x0000000000000000000000000000000000000000')
  })
})
