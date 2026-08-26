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
      transcriptRetrievedFrom0gStorage: true,
      transcriptMerkleRootMatches: true,
      requestRehashesToOnChainHash: true,
      responseRehashesToOnChainHash: true,
      signedTextRebuildsFromThoseHashes: true,
      signatureRecoversToRegisteredTeeSigner: true,
    })
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
