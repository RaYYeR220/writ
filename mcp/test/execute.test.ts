import { ethers } from 'ethers'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, textOf, type Harness } from './helpers/client.js'
import { GATE, OTHER_GATE, PROVIDER, RECIPIENT, makeWorld, type World, type WorldOptions } from './helpers/world.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

/** Attests first, then settles — the flow an agent actually runs. */
async function attestThenExecute(opts: WorldOptions = {}, amount = '0.01') {
  const world = makeWorld(opts)
  harness = await connect(world.deps)

  const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount })
  expect(attested.isError, textOf(attested)).toBeFalsy()
  const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string

  const res = await harness.call('writ_execute', { gate: GATE, writId })
  return { world, writId, res, attested }
}

describe('writ_execute', () => {
  it('approves when the model allows within the ceiling', async () => {
    const { world, res } = await attestThenExecute({ answer: 'ALLOW:12', maxRisk: 40 })

    expect(res.isError, textOf(res)).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>

    expect(out['outcome']).toBe('approved')
    expect(out['refusedBy']).toBe('none')
    expect(out['risk']).toBe(12)
    expect(out['txHash']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(out['explorerTx']).toContain('chainscan.0g.ai/tx/')
    expect(world.settled).toHaveLength(1)
  })

  it('treats a model refusal as a successful outcome, not an error', async () => {
    const { res } = await attestThenExecute({ answer: 'DENY:88' })

    expect(res.isError).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>

    expect(out['outcome']).toBe('refused')
    expect(out['refusedBy']).toBe('model')
    expect(out['risk']).toBe(88)
    expect(out['reason']).toMatch(/answered DENY/i)
    expect(out['txHash']).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('treats a policy refusal as a successful outcome and names the ceiling', async () => {
    const { res } = await attestThenExecute({ answer: 'ALLOW:77', maxRisk: 40 })

    expect(res.isError).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>

    expect(out['outcome']).toBe('refused')
    expect(out['refusedBy']).toBe('policy')
    expect(out['risk']).toBe(77)
    expect(out['reason']).toMatch(/above the gate's ceiling/i)
  })

  it('reports the recipient and amount the settled question actually named', async () => {
    const { res } = await attestThenExecute({}, '2.5')

    const out = res.structuredContent as Record<string, unknown>
    expect(out['to']).toBe(RECIPIENT)
    expect(out['amount']).toBe('2.5')
    expect(out['amountWei']).toBe(ethers.parseEther('2.5').toString())
    expect(out['source']).toBe('session')
  })

  it('settles a centralized provider’s routing proof on the routing entry point', async () => {
    const routing = {
      providerType: 'centralized',
      providerIdentity: 'openai',
      tlsFingerprint: '0x' + 'cd'.repeat(32),
    }
    const { world, res } = await attestThenExecute({ routing })

    expect(res.isError, textOf(res)).toBeFalsy()
    expect((res.structuredContent as Record<string, unknown>)['kind']).toBe('routing')
    expect(world.settled[0]?.kind).toBe('routing')
  })
})

describe('writ_execute refuses to guess', () => {
  it('errors rather than settling the same writ twice', async () => {
    const { res: first, writId, world } = await attestThenExecute()
    expect(first.isError).toBeFalsy()

    const again = await harness!.call('writ_execute', { gate: GATE, writId })

    expect(again.isError).toBe(true)
    // Settling advanced the nonce and the counts, so the question has already moved on.
    expect(textOf(again)).toMatch(/settled another decision in the meantime/i)
    expect(textOf(again)).toMatch(/writ_attest/)
    expect(world.settled).toHaveLength(1)
  })

  it('errors when the same decision was already spent through the other proof format', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '0.01' })
    const out = attested.structuredContent as Record<string, unknown>

    world.spend(world.writIdOf(PROVIDER, out['requestHash'] as string, out['responseHash'] as string))

    const res = await harness.call('writ_execute', { gate: GATE, writId: out['writId'] as string })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/already been acted on/i)
    expect(world.settled).toHaveLength(0)
  })

  it('errors when the gate has moved on to a different question', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '0.01' })
    const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string

    // Something else settled at this gate in the meantime.
    world.nonce = 9n

    const res = await harness.call('writ_execute', { gate: GATE, writId })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/settled another decision in the meantime/i)
    expect(textOf(res)).toMatch(/nonce 0 -> 9/)
    expect(world.settled).toHaveLength(0)
  })

  it('errors when the writ was attested against a different gate', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '0.01' })
    const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string

    const res = await harness.call('writ_execute', { gate: OTHER_GATE, writId })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/was attested against gate/i)
  })

  it('errors on a writ that is not on chain and not in this session', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    const res = await harness.call('writ_execute', { gate: GATE, writId: '0x' + '11'.repeat(32) })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/NotNotarized/i)
    expect(world.settled).toHaveLength(0)
  })

  it('surfaces a decoded revert instead of claiming an outcome', async () => {
    const world = makeWorld({ settleRevert: { name: 'BadSignature', args: ['0xdead', '0xbeef'] } })
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '0.01' })
    const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string

    const res = await harness.call('writ_execute', { gate: GATE, writId })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
    expect(textOf(res)).toMatch(/BadSignature\(0xdead, 0xbeef\)/)
  })

  it('errors when the transaction mines but says nothing about the decision', async () => {
    const { res } = await attestThenExecute({ emitDecisionEvent: false })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/emitted no TransferApproved or TransferRefused event/i)
    expect(textOf(res)).toMatch(/refusing to claim an outcome/i)
  })

  it('rejects a writ id that is not 32 bytes', async () => {
    harness = await connect(makeWorld().deps)

    const res = await harness.call('writ_execute', { gate: GATE, writId: '0xabc' })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/32-byte hex value/i)
  })

  it('errors when the server does not hold the gate’s appointed agent key', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '0.01' })
    const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string

    const stranger = ethers.Wallet.createRandom()
    world.deps.agentAddress = async () => stranger.address

    const res = await harness.call('writ_execute', { gate: GATE, writId })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/only accepts calls from its agent/i)
    expect(world.settled).toHaveLength(0)
  })

  it('names the missing environment variable when there is no key to sign with', async () => {
    const world = makeWorld()
    world.deps.agentAddress = async () => {
      throw new Error('this tool signs a transaction, but WRIT_PRIVATE_KEY is not set in the server environment')
    }
    harness = await connect(world.deps)

    const res = await harness.call('writ_execute', { gate: GATE, writId: '0x' + '44'.repeat(32) })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/WRIT_PRIVATE_KEY/)
  })
})

describe('writ_execute and a treasury that moved underneath the proof', () => {
  async function attestThen(change: (w: World) => void) {
    const world = makeWorld({ treasuryBalance: ethers.parseEther('10') })
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '1' })
    expect(attested.isError, textOf(attested)).toBeFalsy()
    const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string

    change(world)

    return { world, res: await harness.call('writ_execute', { gate: GATE, writId }) }
  }

  it('names an unrelated deposit as the reason, and says to re-attest rather than retry', async () => {
    const { world, res } = await attestThen((w) => w.deposit(ethers.parseEther('5')))

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()

    const text = textOf(res)
    expect(text).toMatch(/without this gate settling anything/i)
    expect(text).toMatch(/deposited into it/i)
    expect(text).toMatch(/treasuryBalance 10000000000000000000 -> 15000000000000000000/)
    expect(text).toMatch(/amountPctOfBalance 10 -> 6/)
    expect(text).toMatch(/Nothing about the transfer changed/i)
    expect(text).toMatch(/Ask the question again/i)
    expect(text).toMatch(/Re-submitting this writ cannot work/i)

    expect(world.settled).toHaveLength(0)
  })

  it('does not blame a stranger when it was this gate that moved', async () => {
    const { res } = await attestThen((w) => {
      w.nonce = 3n
    })

    expect(textOf(res)).toMatch(/settled another decision in the meantime/i)
    expect(textOf(res)).not.toMatch(/deposited into it/i)
  })

  it('settles happily when nothing moved in between', async () => {
    const { world, res } = await attestThen(() => {})

    expect(res.isError, textOf(res)).toBeFalsy()
    expect((res.structuredContent as Record<string, unknown>)['outcome']).toBe('approved')
    expect(world.settled).toHaveLength(1)
  })

  it('explains a revert that a last-second state change caused', async () => {
    const world = makeWorld({ treasuryBalance: ethers.parseEther('10') })
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '1' })
    const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string

    // The preflight passes, and the treasury moves as the transaction is being sent.
    world.options.settleRevert = { name: 'BadSignature', args: ['0xdead', '0xbeef'] }
    const original = world.deps.gate
    world.deps.gate = (address) => {
      const g = original(address)
      let calls = 0
      return {
        ...g,
        previewRequestBody: async (to, amountWei) => {
          if (++calls > 1) world.deposit(ethers.parseEther('2'))
          return g.previewRequestBody(to, amountWei)
        },
      }
    }

    const res = await harness.call('writ_execute', { gate: GATE, writId })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/settlement reverted because/i)
    expect(textOf(res)).toMatch(/without this gate settling anything/i)
  })

  it('still reports a plain revert when the question did not move', async () => {
    const world = makeWorld({ settleRevert: { name: 'BadSignature', args: ['0xdead', '0xbeef'] } })
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '0.01' })
    const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string

    const res = await harness.call('writ_execute', { gate: GATE, writId })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/BadSignature\(0xdead, 0xbeef\)/)
    expect(textOf(res)).not.toMatch(/reverted because/i)
  })
})

describe('writ_execute rebuilds from public data when the session did not produce the writ', () => {
  async function seeded(opts: WorldOptions = {}): Promise<{ world: World; writId: string }> {
    const world = makeWorld(opts)
    harness = await connect(world.deps)
    const { writId } = await world.seedWrit({ to: RECIPIENT, amountWei: ethers.parseEther('0.01') })
    return { world, writId }
  }

  it('settles a writ it never attested, using the transcript from 0G Storage', async () => {
    const { world, writId } = await seeded({ answer: 'ALLOW:5' })

    const res = await harness!.call('writ_execute', { gate: GATE, writId })

    expect(res.isError, textOf(res)).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>
    expect(out['source']).toBe('reconstructed')
    expect(out['outcome']).toBe('approved')
    expect(out['to']).toBe(RECIPIENT)
    expect(world.settled).toHaveLength(1)
  })

  it('errors when the archived transcript cannot be retrieved', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)
    const { writId } = await world.seedWrit({ to: RECIPIENT, amountWei: ethers.parseEther('0.01') })

    world.options.transcriptMode = 'missing'

    const res = await harness.call('writ_execute', { gate: GATE, writId })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/0G Storage could not return transcript/i)
    expect(world.settled).toHaveLength(0)
  })

  it('errors when the archived bytes do not hash to what the chain pinned', async () => {
    const world = makeWorld({ answer: 'DENY:90' })
    harness = await connect(world.deps)
    const { writId } = await world.seedWrit({ to: RECIPIENT, amountWei: ethers.parseEther('0.01') })

    world.options.transcriptMode = 'tampered'

    const res = await harness.call('writ_execute', { gate: GATE, writId })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
    expect(textOf(res)).toMatch(/hash|does not match/i)
    expect(world.settled).toHaveLength(0)
  })
})

/**
 * Settling a writ this session did not produce, from public data alone.
 *
 * The response bytes are not on chain — only their hash is — so they come out of the archive.
 * Which archive is the question the candidate list answers, and it answers it by arithmetic
 * rather than by trusting whoever published first.
 */
describe('writ_execute rebuilds settlement material from the published candidates', () => {
  const JUNK = '0x' + 'ba'.repeat(32)

  it('settles past a front-runner’s junk pointer', async () => {
    const world = makeWorld({ answer: 'ALLOW:12', maxRisk: 40 })
    harness = await connect(world.deps)
    const { writId } = await world.seedWrit({ to: RECIPIENT, amountWei: ethers.parseEther('0.01') })

    const roots = world.transcriptRootsOf(writId)
    const real = roots[0]!
    roots.length = 0
    roots.push(JUNK, real)
    world.storage.set(
      JUNK.toLowerCase(),
      new TextEncoder().encode(JSON.stringify({ chatId: 'other', request: 'not this', response: 'not this' })),
    )

    const res = await harness.call('writ_execute', { gate: GATE, writId })

    expect(res.isError, textOf(res)).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>
    expect(out['source']).toBe('reconstructed')
    expect(out['outcome']).toBe('approved')
    expect(world.settled).toHaveLength(1)
  })

  it('refuses to settle when no candidate re-derives, and sends nothing', async () => {
    const world = makeWorld({ answer: 'ALLOW:12' })
    harness = await connect(world.deps)
    const { writId } = await world.seedWrit({ to: RECIPIENT, amountWei: ethers.parseEther('0.01') })

    // Every published pointer is now a claim nobody can check.
    world.storage.clear()
    world.publishTranscript({ writId, root: JUNK })

    const res = await harness.call('writ_execute', { gate: GATE, writId })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/no usable archived transcript/)
    // No response bytes means no decision to settle — and, above all, no transaction.
    expect(world.settled).toHaveLength(0)
  })
})

describe('the gate settles a record it did not make', () => {
  it('hands back WritNotNotarized rather than notarizing on the way past', async () => {
    // Inline notarization is gone: an approval whose payout reverted would otherwise roll the
    // record back with it, leaving only refusals permanent. `writ_attest` records the proof in
    // its own transaction, and `writ_execute` acts on a record that already exists.
    const world = makeWorld({ answer: 'ALLOW:12' })
    harness = await connect(world.deps)

    const attested = await harness.call('writ_attest', { gate: GATE, to: RECIPIENT, amount: '0.01' })
    const writId = (attested.structuredContent as Record<string, unknown>)['writId'] as string
    expect(world.notarized).toContain(writId)

    // Nothing the settle call carries could put it back: no signature, no root.
    expect(world.settled).toHaveLength(0)
    const res = await harness.call('writ_execute', { gate: GATE, writId })
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(world.settled[0]).not.toHaveProperty('signature')
    expect(world.settled[0]).not.toHaveProperty('transcriptRoot')
  })
})
