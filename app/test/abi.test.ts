import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Interface, getAddress } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  INFERENCE_SERVING_ABI,
  POLICY_GATE_FACTORY_ABI,
  TREASURY_GATE_ABI,
  WRIT_REGISTRY_ABI,
} from '@/lib/abi'

/**
 * The app decodes events positionally — `log.args[3]` is a writ id and `log.args[1]` is an
 * amount — so a reordered parameter would not throw, it would quietly render the wrong number
 * next to the right verdict. That is the worst failure this codebase could have, so the
 * signatures are checked against the Solidity sources rather than against a copy of themselves.
 */

function sol(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../contracts/src/${file}`, import.meta.url)), 'utf8')
}

/** Enums and contract types are `uint8` and `address` on the wire. */
const ALIASES: Record<string, string> = {
  Refusal: 'uint8',
  'PolicyGate.Refusal': 'uint8',
  WritRegistry: 'address',
  IInferenceServing: 'address',
}

function normaliseType(raw: string): string {
  const base = raw.replace(/\[\]$/, '')
  const suffix = raw.endsWith('[]') ? '[]' : ''
  return (ALIASES[base] ?? base) + suffix
}

/** `event Name(type indexed name, …);` → `Name(type,type,…)`, comments and newlines allowed. */
function eventSignatures(source: string): Map<string, string> {
  const stripped = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const out = new Map<string, string>()
  for (const match of stripped.matchAll(/\bevent\s+(\w+)\s*\(([\s\S]*?)\)\s*;/g)) {
    const name = match[1]!
    const params = match[2]!.trim()
    const types =
      params.length === 0
        ? []
        : params.split(',').map((p) => normaliseType(p.trim().split(/\s+/)[0]!))
    out.set(name, `${name}(${types.join(',')})`)
  }
  return out
}

/** `struct Name { type field; … }` → the field types in declaration order. */
function structFields(source: string, name: string): { type: string; name: string }[] {
  const stripped = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const match = new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\}`).exec(stripped)
  if (!match) throw new Error(`no struct ${name} found`)
  return match[1]!
    .split(';')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/)
      return { type: normaliseType(parts[0]!), name: parts[parts.length - 1]! }
    })
}

const REGISTRY = new Interface(WRIT_REGISTRY_ABI as unknown as string[])
const GATE = new Interface(TREASURY_GATE_ABI as unknown as string[])
const FACTORY = new Interface(POLICY_GATE_FACTORY_ABI as unknown as string[])
const SERVING = new Interface(INFERENCE_SERVING_ABI as unknown as string[])

function ours(iface: Interface, name: string): string {
  const fragment = iface.getEvent(name)
  if (!fragment) throw new Error(`this app's ABI has no ${name} event`)
  return fragment.format('sighash')
}

describe('event signatures match the contracts', () => {
  const cases: [string, Interface, string[]][] = [
    ['WritRegistry.sol', REGISTRY, ['Notarized', 'RoutingProofNotarized']],
    ['TreasuryGate.sol', GATE, ['TransferApproved', 'TransferRefused', 'Recovered']],
    ['PolicyGateFactory.sol', FACTORY, ['GateDeployed']],
  ]

  for (const [file, iface, names] of cases) {
    const declared = eventSignatures(sol(file))
    for (const name of names) {
      it(`${file} · ${name}`, () => {
        expect(declared.get(name)).toBe(ours(iface, name))
      })
    }
  }
})

describe('struct field order matches the contracts', () => {
  it('WritRegistry.Writ — the app reads getWrit positionally', () => {
    expect(structFields(sol('WritRegistry.sol'), 'Writ').map((f) => f.name)).toEqual([
      'provider',
      'modelHash',
      'reqHash',
      'respHash',
      'transcriptRoot',
      'notarizedAt',
      'notarizedBy',
    ])
  })

  it('WritRegistry.RoutingProof', () => {
    expect(structFields(sol('WritRegistry.sol'), 'RoutingProof').map((f) => f.name)).toEqual([
      'providerType',
      'providerIdentity',
      'tlsFingerprint',
    ])
  })

  it('PolicyGate.Policy — Studio builds this tuple to deploy a gate', () => {
    expect(structFields(sol('PolicyGate.sol'), 'Policy').map((f) => f.name)).toEqual([
      'promptHead',
      'promptTail',
      'allowedModelHash',
      'allowedProvider',
      'maxRisk',
    ])
  })

  it('IInferenceServing.Service — the app reads index 6, 7, 9 and 10 by number', () => {
    const fields = structFields(sol('interfaces/IInferenceServing.sol'), 'Service')
    expect(fields[6]!.name).toBe('model')
    expect(fields[7]!.name).toBe('verifiability')
    expect(fields[9]!.name).toBe('teeSignerAddress')
    expect(fields[10]!.name).toBe('teeSignerAcknowledged')

    // …and the app's own ABI declares them in that same order.
    const fragment = SERVING.getFunction('getService')!
    const tuple = fragment.outputs[0]!
    expect(tuple.components?.map((c) => c.name)).toEqual(fields.map((f) => f.name))
  })
})

describe('the members the app calls exist in the contracts', () => {
  /**
   * Every name the contract exposes as a callable getter — declared functions, and the getters
   * Solidity synthesises for public state. The app cannot tell the two apart over an ABI, so
   * neither does this.
   */
  const members = (file: string): Set<string> => {
    const source = sol(file)
    const names = [...source.matchAll(/\bfunction\s+(\w+)\s*\(/g)].map((m) => m[1]!)
    const state = [...source.matchAll(/^\s{4}[\w.[\]()=> ]+\bpublic\b(?:\s+(?:constant|immutable))?\s+(\w+)\s*[;=]/gm)].map(
      (m) => m[1]!,
    )
    return new Set([...names, ...state])
  }

  it('WritRegistry', () => {
    const inSource = members('WritRegistry.sol')
    for (const name of [
      'getWrit',
      'getRoutingProof',
      'isNotarized',
      'isRoutingProof',
      'writId',
      'routingWritId',
      'writCount',
      'serving',
    ]) {
      expect([...inSource], `WritRegistry.${name}`).toContain(name)
    }
  })

  it('TreasuryGate, including what it inherits from PolicyGate', () => {
    const inSource = new Set([...members('TreasuryGate.sol'), ...members('PolicyGate.sol')])
    for (const name of [
      'agent',
      'owner',
      'registry',
      'nonce',
      'approvedCount',
      'refusedCount',
      'lastAttestationAt',
      'recoveryAvailableAt',
      'RECOVERY_DELAY',
      'POLICY_ID',
      'consumed',
      'recipientHistory',
      'decisionKey',
      'getPolicy',
      'buildParams',
      'buildRequestBody',
      'previewRequestBody',
      'execute',
      'recover',
    ]) {
      expect([...inSource], `TreasuryGate.${name}`).toContain(name)
    }
  })

  it('PolicyGateFactory', () => {
    const inSource = members('PolicyGateFactory.sol')
    for (const name of ['deployGate', 'gatesOf', 'gateCount', 'allGates', 'registry']) {
      expect([...inSource], `PolicyGateFactory.${name}`).toContain(name)
    }
  })

  it('TreasuryGate.buildParams takes the recipient and the amount, and nothing else', () => {
    // The gate derives the nonce itself. If a third parameter ever appeared, Studio's byte
    // preview would be building a question the contract does not ask.
    expect(sol('TreasuryGate.sol')).toMatch(
      /function\s+buildParams\(address to, uint256 amount\)\s+public\s+view/,
    )
  })
})

describe('the app declares the custom errors it wants readable', () => {
  it('decodes a BadSignature revert into its name and arguments', () => {
    const encoded = REGISTRY.encodeErrorResult('BadSignature', [
      getAddress('0x2e6b8dc19a05f34eb7c0d5a8f2913e6bc47a0d82'),
      getAddress('0x4870cbc4d07d6ac2ee5aa865588e5985fe77a4e9'),
    ])
    const decoded = REGISTRY.parseError(encoded)
    expect(decoded?.name).toBe('BadSignature')
  })

  it('decodes LimitTooLarge, which is what an over-large service page returns', () => {
    const encoded = SERVING.encodeErrorResult('LimitTooLarge', [200, 50])
    expect(SERVING.parseError(encoded)?.name).toBe('LimitTooLarge')
  })
})
