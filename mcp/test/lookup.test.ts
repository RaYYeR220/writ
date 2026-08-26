import { ethers } from 'ethers'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, textOf, type Harness } from './helpers/client.js'
import { GATE, PROVIDER, RECIPIENT, REGISTRY, makeWorld, type WorldOptions } from './helpers/world.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function seeded(opts: WorldOptions = {}) {
  const world = makeWorld(opts)
  harness = await connect(world.deps)
  const seed = await world.seedWrit({ to: RECIPIENT, amountWei: ethers.parseEther('0.01') })
  return { world, ...seed }
}

describe('writ_lookup', () => {
  it('returns the on-chain record with every re-verification step passing', async () => {
    const { world, writId, transcriptRoot } = await seeded({ answer: 'ALLOW:12' })

    const res = await harness!.call('writ_lookup', { writId })

    expect(res.isError, textOf(res)).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>

    expect(out['verified']).toBe(true)
    expect(out['writId']).toBe(writId)
    expect(out['registry']).toBe(REGISTRY)
    expect(out['provider']).toBe(PROVIDER)
    expect(out['teeSigner']).toBe(world.tee.address)
    expect(out['transcriptRoot']).toBe(transcriptRoot)
    expect(out['verdict']).toBe('ALLOW')
    expect(out['risk']).toBe(12)
    expect(out['kind']).toBe('chat')

    expect(out['checks']).toEqual({
      onChainRecordExists: true,
      writIdMatchesItsContents: true,
      aPublishedTranscriptCandidateReDerivesTheWrit: true,
      transcriptRetrievedFrom0gStorage: true,
      transcriptMerkleRootMatches: true,
      requestRehashesToOnChainHash: true,
      responseRehashesToOnChainHash: true,
      signedTextRebuildsFromThoseHashes: true,
      signatureRecoversToRegisteredTeeSigner: true,
    })

    // The pointer is reported as somebody's claim that happened to survive, with their name on
    // it — not as a field of the record, which carries none.
    expect(out['transcriptSubmitter']).toBe(world.agent.address)
    expect(out['transcriptCandidates']).toEqual([
      { root: transcriptRoot, submitter: world.agent.address, state: 'accepted', reason: 're-derives this writ' },
    ])
  })

  it('returns the archived question and answer, so a reader can judge for themselves', async () => {
    const { writId } = await seeded({ answer: 'DENY:96' })

    const out = (await harness!.call('writ_lookup', { writId })).structuredContent as Record<string, unknown>

    expect(out['question']).toContain(`recipient=${RECIPIENT.toLowerCase()}`)
    expect(out['question']).toContain('amount=10000000000000000')
    expect(out['answer']).toContain('"content":"DENY:96"')
    expect(out['verdict']).toBe('DENY')
  })

  it('reports the nine facts as they stood when the question was asked', async () => {
    const world = makeWorld({ treasuryBalance: ethers.parseEther('20'), answer: 'ALLOW:7' })
    harness = await connect(world.deps)
    const { writId } = await world.seedWrit({ to: RECIPIENT, amountWei: ethers.parseEther('2') })

    // The treasury moves after the question was pinned; the writ still records the old state.
    world.deposit(ethers.parseEther('80'))

    const out = (await harness.call('writ_lookup', { writId })).structuredContent as Record<string, unknown>

    expect(out['facts']).toMatchObject({
      recipient: RECIPIENT,
      amount: '2000000000000000000',
      amountOg: '2.0',
      nonce: '0',
      treasuryBalance: '20000000000000000000',
      amountPctOfBalance: 10,
      priorApprovals: '0',
      priorRefusals: '0',
      recipientPriorPayments: '0',
      recipientPriorTotal: '0',
      treasuryCoversAmount: true,
      recipientIsNew: true,
    })
    expect((out['notes'] as string[]).join(' ')).toMatch(/as it stood when the question was asked/i)
  })

  it('reports a centralized provider’s routing attribution', async () => {
    const routing = {
      providerType: 'centralized',
      providerIdentity: 'openai',
      tlsFingerprint: '0x' + 'ef'.repeat(32),
    }
    const { writId } = await seeded({ routing })

    const res = await harness!.call('writ_lookup', { writId })

    expect(res.isError, textOf(res)).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>
    expect(out['kind']).toBe('routing')
    expect(out['routing']).toEqual(routing)
  })

  it('reads back a writ that writ_attest produced in this session', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '0.01' })
    const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string

    const res = await harness.call('writ_lookup', { writId })

    expect(res.isError, textOf(res)).toBeFalsy()
    expect((res.structuredContent as Record<string, unknown>)['verified']).toBe(true)
  })

  it('sends nothing', async () => {
    const { world, writId } = await seeded()
    const before = world.settled.length

    await harness!.call('writ_lookup', { writId })

    expect(world.settled).toHaveLength(before)
  })
})

describe('writ_lookup never reports an unverified writ as verified', () => {
  it('errors on a writ id that was never notarized', async () => {
    await seeded()

    const res = await harness!.call('writ_lookup', { writId: '0x' + '22'.repeat(32) })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
    expect(textOf(res)).toMatch(/NotNotarized/i)
  })

  it('errors when the archived transcript cannot be retrieved from 0G Storage', async () => {
    const { world, writId } = await seeded()
    world.options.transcriptMode = 'missing'

    const res = await harness!.call('writ_lookup', { writId })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
    expect(textOf(res)).toMatch(/could not return transcript/i)
  })

  it('errors when the archived response no longer hashes to what the chain pinned', async () => {
    const { world, writId } = await seeded({ answer: 'DENY:90' })
    world.options.transcriptMode = 'tampered'

    const res = await harness!.call('writ_lookup', { writId })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
    expect(textOf(res)).toMatch(/hash/i)
  })

  it('errors when the signature no longer recovers to the registered TEE signer', async () => {
    const { world, writId } = await seeded()

    // The provider rotated its TEE key after this writ was notarized.
    const rotated = ethers.Wallet.createRandom()
    const original = world.deps.getService
    world.deps.getService = async (p) => ({ ...(await original(p)), teeSignerAddress: rotated.address })

    const res = await harness!.call('writ_lookup', { writId })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/does not recover to the provider's registered TEE signer/i)
    expect(textOf(res)).toMatch(/proves nothing/i)
  })

  it('flags a provider that re-registered under a different model, without failing', async () => {
    const { world, writId } = await seeded()

    const original = world.deps.getService
    world.deps.getService = async (p) => ({ ...(await original(p)), model: 'a-different-model' })

    const res = await harness!.call('writ_lookup', { writId })

    expect(res.isError).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>
    expect(out['modelHashMatchesCurrentRegistration']).toBe(false)
    expect(out['notes']).toEqual(expect.arrayContaining([expect.stringMatching(/re-registered/i)]))
    // The signature still verifies, which is what "verified" claims.
    expect(out['verified']).toBe(true)
  })

  it('rejects a writ id that is not 32 bytes', async () => {
    await seeded()

    const res = await harness!.call('writ_lookup', { writId: 'nope' })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/32-byte hex value/i)
  })

  it('says which environment variable is missing when no registry is configured', async () => {
    const world = makeWorld()
    world.deps.configuredRegistry = () => {
      throw new Error('no registry to read: set WRIT_REGISTRY, or pass one explicitly')
    }
    harness = await connect(world.deps)

    const res = await harness.call('writ_lookup', { writId: '0x' + '33'.repeat(32) })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/WRIT_REGISTRY/)
  })
})

/**
 * A writ points at no transcript, so `writ_lookup` finds one instead of fetching one.
 *
 * Anyone may publish a candidate pointer for any writ — that is deliberate, and it is what stops
 * whoever notarizes first from fixing the archive pointer forever. The cost is that the list can
 * contain anything, so the tool decides by arithmetic and reports whose claim it rejected.
 */
describe('writ_lookup resolves the transcript among the published candidates', () => {
  const JUNK = '0x' + 'ba'.repeat(32)

  it('walks past a junk candidate to the one that re-derives', async () => {
    const { world, writId, transcriptRoot } = await seeded({ answer: 'ALLOW:12' })

    // The front-runner's pointer leads to a real transcript — of a completely different
    // exchange. It re-hashes internally and still says nothing about this writ.
    world.publishTranscript({
      writId,
      root: JUNK,
      bytes: new TextEncoder().encode(
        JSON.stringify({ chatId: 'other', request: 'a different question', response: 'a different answer' }),
      ),
    })
    // Published second, so the resolution has to reject the first to get here.
    expect(world.transcriptRootsOf(writId)).toEqual([transcriptRoot, JUNK])

    const out = (await harness!.call('writ_lookup', { writId })).structuredContent as Record<string, unknown>
    expect(out['verified']).toBe(true)
    expect(out['transcriptRoot']).toBe(transcriptRoot)

    const candidates = out['transcriptCandidates'] as { root: string; state: string }[]
    expect(candidates.map((c) => c.state)).toEqual(['accepted', 'untried'])
  })

  it('accepts the real pointer even when a front-runner published first', async () => {
    const world = makeWorld({ answer: 'ALLOW:12' })
    harness = await connect(world.deps)
    const seed = await world.seedWrit({ to: RECIPIENT, amountWei: ethers.parseEther('0.02') })

    // Re-order the list so the junk claim genuinely comes first — the shape of the attack, where
    // someone learns a chat id from the public signature endpoint and publishes before the
    // archivist does.
    const roots = world.transcriptRootsOf(seed.writId)
    const real = roots[0]!
    roots.length = 0
    roots.push(JUNK, real)

    world.storage.set(
      JUNK.toLowerCase(),
      new TextEncoder().encode(JSON.stringify({ chatId: 'other', request: 'not this', response: 'not this' })),
    )

    const out = (await harness.call('writ_lookup', { writId: seed.writId })).structuredContent as Record<
      string,
      unknown
    >

    // Second in the list, and it wins anyway: being first buys the front-runner nothing.
    expect(out['verified']).toBe(true)
    expect(out['transcriptRoot']).toBe(real)
    const candidates = out['transcriptCandidates'] as { root: string; state: string }[]
    expect(candidates.map((c) => c.state)).toEqual(['rejected', 'accepted'])
    expect((out['notes'] as string[]).join(' ')).toMatch(/noise rather than evidence/)
  })

  it('is an error — never a pass — when no candidate re-derives', async () => {
    const { world, writId } = await seeded({ answer: 'ALLOW:12' })

    // Wipe the real bytes out of 0G Storage and leave only somebody's junk claim beside it.
    world.storage.clear()
    world.publishTranscript({ writId, root: JUNK })

    const res = await harness!.call('writ_lookup', { writId })
    expect(res.isError).toBe(true)

    const text = textOf(res)
    expect(text).toMatch(/no usable archived transcript/)
    // Named claims, and an explicit refusal to blame the proof for them.
    expect(text).toMatch(/says nothing about the proof itself/)
    expect(text).toContain(JUNK)
  })

  it('says plainly when nobody published a pointer at all', async () => {
    const world = makeWorld({ answer: 'ALLOW:12' })
    harness = await connect(world.deps)
    const seed = await world.seedWrit({ to: RECIPIENT, amountWei: ethers.parseEther('0.03') })

    // Forget every candidate, as a writ notarized with a zero root would have from the start.
    world.transcriptRootsOf(seed.writId).length = 0

    const res = await harness.call('writ_lookup', { writId: seed.writId })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/no archive pointer has been published/)
    expect(textOf(res)).toMatch(/addTranscript/)
  })
})
