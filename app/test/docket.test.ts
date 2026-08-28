import { describe, expect, it } from 'vitest'
import { discoverGates, type GateDiscovery } from '@/lib/docket'

/**
 * A gate is not always something the factory deployed.
 *
 * The first live `AgentTreasury` on 0G mainnet went out through a Foundry script, so the
 * factory's `GateDeployed` log has never heard of it. The docket read that as "no gate acted"
 * and rendered two settled decisions — one approval that moved funds, one refusal that did not —
 * as unspent records with zero counters. Watching an address you were told about is the normal
 * case, not the exception, and these tests pin the honesty rules around it.
 */

const FACTORY_GATE = '0x1111111111111111111111111111111111111111'
const SCRIPT_GATE = '0x2688059e106195941F320110bE2d5fe9a1c75fEE'
const OWNER = '0x9999999999999999999999999999999999999999'

function sources(over: Partial<GateDiscovery> = {}): GateDiscovery {
  return {
    factoryGates: async () => [{ address: FACTORY_GATE, owner: OWNER }],
    probeGate: async () => ({ owner: OWNER }),
    ...over,
  }
}

describe('discoverGates', () => {
  it('includes a configured gate the factory never deployed', async () => {
    const problems: string[] = []
    const gates = await discoverGates([SCRIPT_GATE], sources(), problems)

    expect(gates.map((g) => g.address)).toEqual([FACTORY_GATE, SCRIPT_GATE])
    expect(gates.find((g) => g.address === SCRIPT_GATE)).toMatchObject({
      owner: OWNER,
      source: 'configured',
    })
    expect(problems).toEqual([])
  })

  it('does not list a gate twice when the factory already deployed it', async () => {
    const problems: string[] = []
    // Same gate, different case — an operator pasting from an explorer gets whatever case it shows.
    const gates = await discoverGates([FACTORY_GATE.toUpperCase().replace('0X', '0x')], sources(), problems)

    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({ address: FACTORY_GATE, source: 'factory' })
    expect(problems).toEqual([])
  })

  it('reports a configured address that is not a gate instead of listing a phantom', async () => {
    const problems: string[] = []
    const gates = await discoverGates(
      [SCRIPT_GATE],
      sources({
        probeGate: async () => {
          throw new Error('could not decode result data (value="0x")')
        },
      }),
      problems,
    )

    // Left out entirely: a row here would read as a gate that has simply made no decisions.
    expect(gates.map((g) => g.address)).toEqual([FACTORY_GATE])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(SCRIPT_GATE)
    expect(problems[0]).toContain('could not decode result data')
  })

  it('reports a configured entry that is not an address at all', async () => {
    const problems: string[] = []
    const gates = await discoverGates(['0x123', 'the-treasury'], sources(), problems)

    expect(gates.map((g) => g.address)).toEqual([FACTORY_GATE])
    expect(problems).toHaveLength(2)
    expect(problems.join(' ')).toContain('0x123')
    expect(problems.join(' ')).toContain('the-treasury')
  })

  it('still watches configured gates when the factory log cannot be read', async () => {
    const problems: string[] = []
    const gates = await discoverGates(
      [SCRIPT_GATE],
      sources({
        factoryGates: async () => {
          throw new Error('rate limited')
        },
      }),
      problems,
    )

    expect(gates.map((g) => g.address)).toEqual([SCRIPT_GATE])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('rate limited')
  })

  it('still watches configured gates when no factory is configured', async () => {
    const problems: string[] = []
    const gates = await discoverGates([SCRIPT_GATE], { probeGate: async () => ({ owner: OWNER }) }, problems)

    expect(gates.map((g) => g.address)).toEqual([SCRIPT_GATE])
    // Says what is missing rather than implying the list is complete.
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('NEXT_PUBLIC_POLICY_GATE_FACTORY')
  })

  it('says there is nothing to watch when neither source is configured', async () => {
    const problems: string[] = []
    const gates = await discoverGates([], { probeGate: async () => ({ owner: OWNER }) }, problems)

    expect(gates).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('NEXT_PUBLIC_GATES')
  })
})
