import { ethers } from 'ethers'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, textOf, type Harness } from './helpers/client.js'
import { GATE, PROVIDER, RECIPIENT, makeWorld, type WorldOptions } from './helpers/world.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function attest(opts: WorldOptions = {}, args: Record<string, unknown> = {}) {
  const world = makeWorld(opts)
  harness = await connect(world.deps)
  const res = await harness.call('writ_attest', {
    gate: GATE,
    to: RECIPIENT,
    amount: '0.01',
    ...args,
  })
  return { world, res }
}

describe('writ_attest', () => {
  it('returns a notarized writ with the verdict the model gave', async () => {
    const { world, res } = await attest({ answer: 'ALLOW:12' })

    expect(res.isError).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>

    expect(out['writId']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(out['txHash']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(out['transcriptRoot']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(out['verdict']).toBe('ALLOW')
    expect(out['risk']).toBe(12)
    expect(out['kind']).toBe('chat')
    expect(out['teeSigner']).toBe(world.tee.address)
    expect(world.notarized).toHaveLength(1)
    expect(world.archived).toHaveLength(1)
  })

  it('reports a DENY as a verdict, not as a failure', async () => {
    const { res } = await attest({ answer: 'DENY:91' })

    expect(res.isError).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>
    expect(out['verdict']).toBe('DENY')
    expect(out['risk']).toBe(91)
    expect(out['expectedOutcome']).toBe('refuse-model')
  })

  it('predicts a policy refusal when the model allows above the ceiling', async () => {
    const { res } = await attest({ answer: 'ALLOW:77', maxRisk: 40 })

    const out = res.structuredContent as Record<string, unknown>
    expect(out['verdict']).toBe('ALLOW')
    expect(out['expectedOutcome']).toBe('refuse-policy')
    expect(out['maxRisk']).toBe(40)
  })

  it('archives a transcript that re-derives to the same proof', async () => {
    const { world } = await attest()

    const t = world.archived[0]!
    const enc = new TextEncoder()
    expect(ethers.sha256(enc.encode(t.request))).toBe(t.reqHash)
    expect(ethers.sha256(enc.encode(t.response))).toBe(t.respHash)
    expect(t.signingAddress).toBe(world.tee.address)
  })

  it('notarizes a centralized provider’s routing proof under the routing format', async () => {
    const routing = {
      providerType: 'centralized',
      providerIdentity: 'openai',
      tlsFingerprint: '0x' + 'ab'.repeat(32),
    }
    const { res } = await attest({ routing })

    expect(res.isError).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>
    expect(out['kind']).toBe('routing')
    expect(out['routing']).toEqual(routing)
  })

  it('remembers the writ so writ_execute can settle it by id alone', async () => {
    const { world, res } = await attest()
    const out = res.structuredContent as Record<string, unknown>

    const held = world.deps.store.get(out['writId'] as string)
    expect(held?.gate).toBe(GATE)
    expect(held?.to).toBe(RECIPIENT)
    expect(held?.amountWei).toBe(ethers.parseEther('0.01'))
  })
})

describe('writ_attest refuses to fabricate', () => {
  it('errors when the proof cannot be fetched at all', async () => {
    const { world, res } = await attest({ proofMode: 'unavailable' })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
    expect(textOf(res)).toMatch(/chat_id_not_found|proof unavailable/i)

    // Nothing was archived and nothing was recorded: an unprovable run leaves no trace.
    expect(world.archived).toHaveLength(0)
    expect(world.notarized).toHaveLength(0)
  })

  it('errors when the signature is by a key that is not the registered TEE signer', async () => {
    const { world, res } = await attest({ proofMode: 'wrong-key' })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
    expect(textOf(res)).toMatch(/does not verify against the registered TEE signer/i)
    expect(world.archived).toHaveLength(0)
    expect(world.notarized).toHaveLength(0)
  })

  it('errors when the TEE signed a different question', async () => {
    const { world, res } = await attest({ proofMode: 'wrong-question' })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/not this request and response/i)
    expect(world.notarized).toHaveLength(0)
  })

  it('errors on a signed text in a format it does not understand', async () => {
    const { world, res } = await attest({ proofMode: 'garbled-text' })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/unsupported signed text format/i)
    expect(world.notarized).toHaveLength(0)
  })

  it('errors when the provider is not a TEE service', async () => {
    const { world, res } = await attest({ verifiability: 'OpML' })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/not TeeML/i)
    // Refused before inference: no proof was even attempted.
    expect(world.archived).toHaveLength(0)
  })

  it('errors when the provider has not acknowledged its TEE signer', async () => {
    const { res } = await attest({ teeSignerAcknowledged: false })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/has not acknowledged its TEE signer/i)
  })

  it('errors when the provider serves a model the gate does not allow', async () => {
    const { world, res } = await attest({
      allowedModelHash: ethers.keccak256(ethers.toUtf8Bytes('some-other-model')),
    })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/nothing this provider signs can settle at this gate/i)
    expect(world.archived).toHaveLength(0)
  })

  it('errors when a gate accepts any provider and none is configured', async () => {
    const { res } = await attest({ allowedProvider: ethers.ZeroAddress })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/set WRIT_PROVIDER/i)
  })

  it('still reports the writ when the answer does not parse, but predicts a revert', async () => {
    const { res } = await attest({ answer: 'maybe?' })

    expect(res.isError).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>
    expect(out['verdict']).toBe('UNPARSEABLE')
    expect(out['risk']).toBeNull()
    expect(out['expectedOutcome']).toBe('revert-malformed')
  })

  it('validates its arguments before doing anything', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    const res = await harness.call('writ_attest', { gate: GATE, to: PROVIDER, amount: '-1' })

    expect(res.isError).toBe(true)
    expect(world.archived).toHaveLength(0)
  })
})
