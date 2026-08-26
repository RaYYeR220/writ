import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  WRIT_REGISTRY_ABI,
  TREASURY_GATE_ABI,
  POLICY_GATE_FACTORY_ABI,
  INFERENCE_SERVING_ABI,
} from '../src/abi.js'
import { buildFailure, ensureBuilt, loadArtifact } from './helpers/contracts.js'

/**
 * The SDK ships hand-written human-readable ABIs so consumers need no build artifacts. That
 * only stays true if they match the compiled contracts, so this suite compiles and compares.
 */
const compiled = ensureBuilt()
if (!compiled) {
  console.warn(`SKIPPING ABI drift checks: contracts/ did not compile.\n${buildFailure}`)
}

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

/**
 * What each function RETURNS, which a selector does not cover.
 *
 * A selector is computed over the inputs alone, so `getWrit(bytes32)` keeps its selector when a
 * field is added to or removed from the struct it returns. That is the drift that does not
 * throw — it shifts every later field by one and hands back the wrong value under the right
 * name — so the return shapes are compared by name and type, in order, on their own.
 */
function returnShapes(abi: ethers.InterfaceAbi): Map<string, { types: string; names: string[] }> {
  const iface = new ethers.Interface(abi)
  const out = new Map<string, { types: string; names: string[] }>()

  const names: string[] = []
  // Paths are positional, never parented by a name: Solidity leaves an unnamed return unnamed,
  // so `getRoutingProof`'s tuple is `p` on chain and anonymous here while its FIELDS — the part
  // a positional read depends on — are named identically on both sides.
  const walk = (p: ethers.ParamType, path: string): string => {
    if (path.includes('.') || /^\d+\./.test(path)) names.push(`${path}:${p.name}`)
    if (!p.components) return p.type
    return `(${p.components.map((c, i) => walk(c, `${path}.${i}`)).join(',')})${p.type.endsWith('[]') ? '[]' : ''}`
  }

  iface.forEachFunction((f) => {
    names.length = 0
    const types = f.outputs.map((o, i) => walk(o, String(i))).join(',')
    out.set(f.format('sighash'), { types, names: [...names] })
  })
  return out
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

  it.runIf(compiled)('returns what the compiled contracts return, field for field and in order', () => {
    // The check a selector cannot make. `WritRegistry.Writ` lost `transcriptRoot`, and every
    // field after it shifted up one — a change no selector, topic hash or argument list notices.
    for (const [name, contract] of [
      ['WritRegistry', WRIT_REGISTRY_ABI],
      ['TreasuryGate', TREASURY_GATE_ABI],
      ['PolicyGateFactory', POLICY_GATE_FACTORY_ABI],
      ['IInferenceServing', INFERENCE_SERVING_ABI],
    ] as const) {
      const real = returnShapes(loadArtifact(name).abi as unknown as ethers.InterfaceAbi)
      const mine = returnShapes(contract as unknown as ethers.InterfaceAbi)
      for (const [sighash, shape] of mine) {
        const theirs = real.get(sighash)
        expect(theirs, `${name}.${sighash} is not on the compiled contract`).toBeDefined()
        expect(shape.types, `${name}.${sighash} returns different types`).toBe(theirs!.types)
        // Solidity leaves an unnamed return unnamed, so only the labels we actually declare are
        // compared — the struct field names, which are what a positional read hangs on.
        for (const field of shape.names) {
          expect(theirs!.names, `${name}.${sighash} has no field ${field}`).toContain(field)
        }
      }
    }
  })

  it.runIf(compiled)('carries the whole transcript-candidate surface', () => {
    // A reader must be able to walk every candidate root, not trust one pointer, so the ABI has
    // to expose the list, its length, the pair at an index, and who claimed each one.
    const iface = new ethers.Interface(WRIT_REGISTRY_ABI as unknown as ethers.InterfaceAbi)
    for (const fn of [
      'transcriptRoots',
      'transcriptRootCount',
      'transcriptRootAt',
      'transcriptSubmitter',
      'transcriptQuotaUsed',
      'addTranscript',
      'MAX_ROOTS_PER_SUBMITTER',
    ]) {
      expect(iface.getFunction(fn), `WRIT_REGISTRY_ABI has no ${fn}`).toBeTruthy()
    }
    expect(iface.getEvent('TranscriptAdded')).toBeTruthy()

    // And the removed single pointer is gone from both the record and its event, so nothing
    // downstream can go on reading one.
    expect(iface.getFunction('getWrit')!.outputs[0]!.components!.map((c) => c.name)).toEqual([
      'provider',
      'modelHash',
      'reqHash',
      'respHash',
      'notarizedAt',
      'notarizedBy',
    ])
    expect(iface.getEvent('Notarized')!.inputs.map((i) => i.name)).toEqual([
      'id',
      'provider',
      'modelHash',
      'model',
      'reqHash',
      'respHash',
      'notarizedBy',
    ])
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
