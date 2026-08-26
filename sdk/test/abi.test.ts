import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  WRIT_REGISTRY_ABI,
  TREASURY_GATE_ABI,
  POLICY_GATE_FACTORY_ABI,
  INFERENCE_SERVING_ABI,
} from '../src/abi.js'
import { ensureBuilt, loadArtifact } from './helpers/contracts.js'

/**
 * The SDK ships hand-written human-readable ABIs so consumers need no build artifacts. That
 * only stays true if they match the compiled contracts, so this suite compiles and compares.
 */
const compiled = ensureBuilt()

function selectors(abi: ethers.InterfaceAbi): { fns: Set<string>; events: Set<string>; errors: Set<string> } {
  const iface = new ethers.Interface(abi)
  const fns = new Set<string>()
  const events = new Set<string>()
  const errors = new Set<string>()
  iface.forEachFunction((f) => fns.add(`${f.selector} ${f.format('sighash')}`))
  iface.forEachEvent((e) => events.add(`${e.topicHash} ${e.format('sighash')}`))
  iface.forEachError((e) => errors.add(`${e.selector} ${e.format('sighash')}`))
  return { fns, events, errors }
}

describe('exported ABIs', () => {
  it('parse as valid ethers interfaces', () => {
    for (const abi of [WRIT_REGISTRY_ABI, TREASURY_GATE_ABI, POLICY_GATE_FACTORY_ABI, INFERENCE_SERVING_ABI]) {
      expect(() => new ethers.Interface(abi as unknown as ethers.InterfaceAbi)).not.toThrow()
    }
  })

  it('encode the registry calls the pipeline depends on', () => {
    const iface = new ethers.Interface(WRIT_REGISTRY_ABI as unknown as ethers.InterfaceAbi)
    expect(iface.getFunction('notarize')?.selector).toBeTruthy()
    expect(iface.getFunction('writId')?.stateMutability).toBe('pure')
    expect(iface.getFunction('isNotarized')?.stateMutability).toBe('view')
  })

  it.runIf(compiled)('matches the compiled WritRegistry', () => {
    const real = selectors(loadArtifact('WritRegistry').abi as unknown as ethers.InterfaceAbi)
    const mine = selectors(WRIT_REGISTRY_ABI as unknown as ethers.InterfaceAbi)
    for (const f of mine.fns) expect([...real.fns]).toContain(f)
    for (const e of mine.events) expect([...real.events]).toContain(e)
    for (const e of mine.errors) expect([...real.errors]).toContain(e)
  })

  it.runIf(compiled)('matches the compiled TreasuryGate', () => {
    const real = selectors(loadArtifact('TreasuryGate').abi as unknown as ethers.InterfaceAbi)
    const mine = selectors(TREASURY_GATE_ABI as unknown as ethers.InterfaceAbi)
    for (const f of mine.fns) expect([...real.fns]).toContain(f)
    for (const e of mine.events) expect([...real.events]).toContain(e)
    for (const e of mine.errors) expect([...real.errors]).toContain(e)
  })

  it.runIf(compiled)('matches the compiled PolicyGateFactory', () => {
    const real = selectors(loadArtifact('PolicyGateFactory').abi as unknown as ethers.InterfaceAbi)
    const mine = selectors(POLICY_GATE_FACTORY_ABI as unknown as ethers.InterfaceAbi)
    for (const f of mine.fns) expect([...real.fns]).toContain(f)
    for (const e of mine.events) expect([...real.events]).toContain(e)
  })

  it.runIf(compiled)('matches the IInferenceServing interface the registry reads', () => {
    const real = selectors(loadArtifact('IInferenceServing').abi as unknown as ethers.InterfaceAbi)
    const mine = selectors(INFERENCE_SERVING_ABI as unknown as ethers.InterfaceAbi)
    for (const f of mine.fns) expect([...real.fns]).toContain(f)
  })

  it.runIf(compiled)('can decode every revert the gate can produce', () => {
    // A refusal is not a revert, but a verification failure is, and an operator needs to be
    // told which one they hit rather than "execution reverted (unknown custom error)".
    const iface = new ethers.Interface(TREASURY_GATE_ABI as unknown as ethers.InterfaceAbi)
    const real = loadArtifact('TreasuryGate').abi as unknown as ethers.InterfaceAbi
    const realErrors = new ethers.Interface(real)
    const missing: string[] = []
    realErrors.forEachError((e) => {
      if (!iface.getError(e.selector)) missing.push(e.format('sighash'))
    })
    expect(missing).toEqual([])
  })
})
