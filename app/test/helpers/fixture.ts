import { Wallet, keccak256, toUtf8Bytes } from 'ethers'
import { sha256Hex, signedText, utf8 } from '@/lib/hashes'
import type { ServiceRecord, TranscriptCandidate, VerifySources, WritRecord } from '@/lib/verify'
import { writId } from '@/lib/verify'
import type { Transcript } from '@/lib/transcript'

/**
 * A real proof, built the way the pipeline builds one.
 *
 * Nothing here is a mock of the cryptography — the hashes are real sha256 over real bytes, and
 * the signature is a real EIP-191 signature by a real key. Only the *sources* are injected, so
 * the tests exercise the same code path the browser runs, and a test that passes because the
 * arithmetic was stubbed out is not possible.
 */

/** Stands in for the provider's TEE key. Fixed so the fixtures are reproducible. */
export const TEE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
/** A key the registry has never heard of. */
export const STRANGER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'

export const PROVIDER = '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9'
export const MODEL = '0GM-1.0-35B-A3B'

/** The pointer the honest archivist published, and the address that published it. */
export const GOOD_ROOT = '0x' + '11'.repeat(32)
export const ARCHIVIST = '0x2e6b8Dc19A05F34Eb7c0d5a8F2913e6bC47a0D82'

/**
 * A pointer someone else got in first with.
 *
 * Notarization is permissionless, so anyone who learns a chat id can publish a root before the
 * real archivist does. The reader's job is to make that irrelevant.
 */
export const JUNK_ROOT = '0x' + '99'.repeat(32)
export const FRONT_RUNNER = '0x000000000000000000000000000000000000dEaD'

export const QUESTION = JSON.stringify({
  model: MODEL,
  messages: [
    {
      role: 'system',
      content: 'You are the risk officer. Answer on ONE line, exactly: ALLOW:<risk 00-99> or DENY:<risk 00-99>.',
    },
    {
      role: 'user',
      content:
        'Transfer request. recipient=0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae amount=250000000000000000000 nonce=0 treasuryBalance=412608400000000000000 amountPctOfBalance=60 priorApprovals=0 priorRefusals=0 recipientPriorPayments=0 recipientPriorTotal=0. Recipient was first seen 41 minutes ago and has no prior relationship with this treasury.',
    },
  ],
})

export const ANSWER = JSON.stringify({
  id: 'chatcmpl-writ-fixture',
  object: 'chat.completion',
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'DENY:87' }, finish_reason: 'stop' }],
})

export type Fixture = {
  writ: WritRecord
  transcript: Transcript
  service: ServiceRecord
  teeSigner: string
}

export async function buildFixture(
  opts: { signWith?: string; question?: string; answer?: string } = {},
): Promise<Fixture> {
  const question = opts.question ?? QUESTION
  const answer = opts.answer ?? ANSWER

  const reqHash = '0x' + (await sha256Hex(utf8(question)))
  const respHash = '0x' + (await sha256Hex(utf8(answer)))
  const text = signedText(reqHash, respHash)

  const registered = new Wallet(TEE_KEY)
  const signing = new Wallet(opts.signWith ?? TEE_KEY)
  const signature = await signing.signMessage(text)

  const transcript: Transcript = {
    chatId: 'chatcmpl-writ-fixture',
    provider: PROVIDER,
    model: MODEL,
    request: question,
    response: answer,
    reqHash,
    respHash,
    signedText: text,
    signature,
    signingAddress: signing.address,
    capturedAt: '2026-08-26T14:02:51.000Z',
  }

  const writ: WritRecord = {
    id: writId(PROVIDER, reqHash, respHash),
    provider: PROVIDER,
    modelHash: keccak256(toUtf8Bytes(MODEL)),
    reqHash,
    respHash,
    notarizedAt: 1_787_000_000,
    notarizedBy: ARCHIVIST,
    isRouting: false,
  }

  const service: ServiceRecord = {
    provider: PROVIDER,
    serviceType: 'chatbot',
    url: 'https://provider.example/v1/proxy',
    updatedAt: 1_786_000_000,
    model: MODEL,
    verifiability: 'TeeML',
    teeSignerAddress: registered.address,
    teeSignerAcknowledged: true,
  }

  return { writ, transcript, service, teeSigner: registered.address }
}

/**
 * Turns a fixture into the four public reads the verifier makes, with overrides for the tests.
 *
 * `roots` is the candidate list the registry would return, in submission order, and `archive`
 * says what each root actually leads to. By default there is one candidate, published by the
 * honest archivist, holding the fixture's own transcript — so a test only has to describe the
 * part of the world it cares about.
 */
export function sourcesFor(
  fixture: Fixture,
  overrides: {
    writ?: Partial<WritRecord>
    service?: Partial<ServiceRecord> | 'unreachable'
    /** What `GOOD_ROOT` holds. `'unavailable'` makes 0G Storage refuse to serve it. */
    transcript?: Transcript | 'unavailable'
    /** The published candidates. `'unreadable'` makes the registry itself refuse to list them. */
    roots?: TranscriptCandidate[] | 'unreadable'
    /** What any other root leads to. Anything unlisted is simply not in 0G Storage. */
    archive?: Record<string, Transcript | 'unavailable'>
  } = {},
): VerifySources {
  const writ = { ...fixture.writ, ...overrides.writ }
  const archive: Record<string, Transcript | 'unavailable'> = {
    [GOOD_ROOT.toLowerCase()]: overrides.transcript ?? fixture.transcript,
    ...Object.fromEntries(
      Object.entries(overrides.archive ?? {}).map(([root, value]) => [root.toLowerCase(), value]),
    ),
  }

  return {
    async getWrit() {
      return writ
    },
    async getService() {
      if (overrides.service === 'unreachable') throw new Error('the registry did not answer')
      return { ...fixture.service, ...overrides.service }
    },
    async listTranscriptRoots() {
      if (overrides.roots === 'unreadable') throw new Error('the node refused the call')
      return overrides.roots ?? [{ root: GOOD_ROOT, submitter: ARCHIVIST }]
    },
    async getTranscript(root: string) {
      const held = archive[root.toLowerCase()]
      if (held === undefined || held === 'unavailable') {
        throw new Error('0G Storage indexer answered: File not found (code 101)')
      }
      return { bytes: new TextEncoder().encode(JSON.stringify(held, null, 2)), source: 'a test fixture' }
    },
  }
}
