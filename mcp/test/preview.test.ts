import { ethers } from 'ethers'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '@writ/sdk'
import { connect, textOf, type Harness } from './helpers/client.js'
import { GATE, PROVIDER, RECIPIENT, makeWorld } from './helpers/world.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('writ_preview_question', () => {
  it('returns the exact bytes the gate will pin, and their sha256', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    const res = await harness.call('writ_preview_question', {
      gate: GATE,
      to: RECIPIENT,
      amount: '0.01',
    })

    expect(res.isError).toBeFalsy()
    const out = res.structuredContent as Record<string, unknown>

    const expected = world.buildRequestBody(RECIPIENT, ethers.parseEther('0.01'))
    expect(out['question']).toBe(new TextDecoder().decode(expected))
    expect(out['questionHex']).toBe(ethers.hexlify(expected))
    expect(out['questionBytes']).toBe(expected.length)
    expect(out['requestHash']).toBe('0x' + sha256Hex(expected))
  })

  it('reports the amount in both units, so nothing downstream has to guess', async () => {
    harness = await connect(makeWorld().deps)

    const res = await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '1.5' })
    const out = res.structuredContent as Record<string, unknown>

    expect(out['amount']).toBe('1.5')
    expect(out['amountWei']).toBe('1500000000000000000')
    expect(out['question']).toContain('amount=1500000000000000000')
  })

  it('carries the policy the answer will be judged against', async () => {
    harness = await connect(makeWorld({ maxRisk: 25 }).deps)

    const out = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '0.01' }))
      .structuredContent as Record<string, unknown>

    expect(out['maxRisk']).toBe(25)
    expect(out['allowedProvider']).toBe(PROVIDER)
    expect(out['allowedModelHash']).toBe(ethers.keccak256(ethers.toUtf8Bytes('0GM-1.0-35B-A3B')))
  })

  it('moves with the nonce, because the question does', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    const first = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '0.01' }))
      .structuredContent as Record<string, unknown>

    world.nonce = 7n

    const later = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '0.01' }))
      .structuredContent as Record<string, unknown>

    expect(first['nonce']).toBe('0')
    expect(later['nonce']).toBe('7')
    expect(later['requestHash']).not.toBe(first['requestHash'])
  })

  it('breaks the question out into the nine facts the agent is judged on', async () => {
    const world = makeWorld({ treasuryBalance: ethers.parseEther('10') })
    harness = await connect(world.deps)

    const out = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '1' }))
      .structuredContent as Record<string, unknown>
    const facts = out['facts'] as Record<string, unknown>

    expect(facts).toMatchObject({
      recipient: RECIPIENT,
      amount: '1000000000000000000',
      amountOg: '1.0',
      nonce: '0',
      treasuryBalance: '10000000000000000000',
      treasuryBalanceOg: '10.0',
      amountPctOfBalance: 10,
      priorApprovals: '0',
      priorRefusals: '0',
      recipientPriorPayments: '0',
      recipientPriorTotal: '0',
      treasuryCoversAmount: true,
      recipientIsNew: true,
    })
  })

  it('reads the same state back off the gate’s own getters', async () => {
    const world = makeWorld({ treasuryBalance: ethers.parseEther('4') })
    harness = await connect(world.deps)

    const out = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '0.5' }))
      .structuredContent as Record<string, unknown>

    expect(out['treasury']).toEqual({
      balance: '4000000000000000000',
      balanceOg: '4.0',
      nonce: '0',
      approvedCount: '0',
      refusedCount: '0',
      recipientPayments: '0',
      recipientTotal: '0',
      recipientTotalOg: '0.0',
    })
  })

  it('warns that the answer is bound to the treasury as it stands now', async () => {
    harness = await connect(makeWorld().deps)

    const out = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '0.01' }))
      .structuredContent as Record<string, unknown>

    expect((out['notes'] as string[]).join(' ')).toMatch(/live treasury state/i)
  })

  it('says an amount the treasury cannot cover is exactly that', async () => {
    const world = makeWorld({ treasuryBalance: ethers.parseEther('1') })
    harness = await connect(world.deps)

    const out = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '3' }))
      .structuredContent as Record<string, unknown>
    const facts = out['facts'] as Record<string, unknown>

    expect(facts['amountPctOfBalance']).toBe(300)
    expect(facts['treasuryCoversAmount']).toBe(false)
    expect((out['notes'] as string[]).join(' ')).toMatch(/cannot cover this transfer/i)
  })

  it('does not let a floored percentage read as a free transfer', async () => {
    const world = makeWorld({ treasuryBalance: ethers.parseEther('1000') })
    harness = await connect(world.deps)

    const out = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '0.5' }))
      .structuredContent as Record<string, unknown>

    expect((out['facts'] as Record<string, unknown>)['amountPctOfBalance']).toBe(0)
    expect((out['notes'] as string[]).join(' ')).toMatch(/under 1% of the balance, not zero/i)
  })

  it('moves the facts as the treasury moves', async () => {
    const world = makeWorld({ treasuryBalance: ethers.parseEther('10') })
    harness = await connect(world.deps)

    const before = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '1' }))
      .structuredContent as Record<string, unknown>

    world.deposit(ethers.parseEther('10'))

    const after = (await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '1' }))
      .structuredContent as Record<string, unknown>

    expect((before['facts'] as Record<string, unknown>)['amountPctOfBalance']).toBe(10)
    expect((after['facts'] as Record<string, unknown>)['amountPctOfBalance']).toBe(5)
    expect(after['requestHash']).not.toBe(before['requestHash'])
  })

  it('sends nothing: previewing twice does not touch the chain', async () => {
    const world = makeWorld()
    harness = await connect(world.deps)

    await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '0.01' })
    await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: '0.01' })

    expect(world.notarized).toHaveLength(0)
    expect(world.settled).toHaveLength(0)
    expect(world.archived).toHaveLength(0)
  })
})

describe('writ_preview_question schema validation', () => {
  it('rejects a recipient that is not an address', async () => {
    harness = await connect(makeWorld().deps)

    const res = await harness.call('writ_preview_question', { gate: GATE, to: 'bob', amount: '0.01' })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
    expect(textOf(res)).toMatch(/must be a 20-byte hex address/i)
  })

  it('rejects a gate that is not an address', async () => {
    harness = await connect(makeWorld().deps)

    const res = await harness.call('writ_preview_question', { gate: '0x1234', to: RECIPIENT, amount: '0.01' })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/Input validation error/i)
  })

  it('rejects an amount that is not a decimal 0G value', async () => {
    harness = await connect(makeWorld().deps)

    const res = await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: 'lots' })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/decimal amount in 0G/i)
  })

  it('rejects a numeric amount, because a double cannot carry 18 decimals', async () => {
    harness = await connect(makeWorld().deps)

    const res = await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT, amount: 0.01 })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/expected string/i)
  })

  it('rejects a missing argument', async () => {
    harness = await connect(makeWorld().deps)

    const res = await harness.call('writ_preview_question', { gate: GATE, to: RECIPIENT })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
  })
})
