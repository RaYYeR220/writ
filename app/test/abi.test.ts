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
import type { RawWrit } from '@/lib/contracts'
import { decodeWrit } from '@/lib/sources'

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

/** The component names of a tuple this app's own ABI declares, in declaration order. */
function ourTupleFields(iface: Interface, fn: string, where: 'inputs' | 'outputs', at = 0): string[] {
  const fragment = iface.getFunction(fn)
  if (!fragment) throw new Error(`this app's ABI has no ${fn}`)
  const param = fragment[where][at]
  if (!param?.components) throw new Error(`${fn} ${where}[${at}] is not a tuple`)
  return param.components.map((c) => c.name)
}

describe('struct field order matches the contracts', () => {
  /**
   * The check that matters most in this file.
   *
   * `Writ` lost `transcriptRoot`, and a positional reader that still expects it does not throw —
   * every field after the hole shifts up one and the page renders `notarizedBy` where it labels
   * `notarizedAt`. So the field list is asserted against the Solidity source AND against this
   * app's own ABI, which means a rename, a reorder, an insertion or a removal on either side is
   * a failing test rather than a page quietly captioning the wrong value.
   */
  it('WritRegistry.Writ — the app reads getWrit positionally', () => {
    const declared = structFields(sol('WritRegistry.sol'), 'Writ').map((f) => f.name)
    expect(declared).toEqual(['provider', 'modelHash', 'reqHash', 'respHash', 'notarizedAt', 'notarizedBy'])
    expect(ourTupleFields(REGISTRY, 'getWrit', 'outputs')).toEqual(declared)
  })

  it('WritRegistry.RoutingProof', () => {
    const declared = structFields(sol('WritRegistry.sol'), 'RoutingProof').map((f) => f.name)
    expect(declared).toEqual(['providerType', 'providerIdentity', 'tlsFingerprint'])
    expect(ourTupleFields(REGISTRY, 'getRoutingProof', 'outputs')).toEqual(declared)
  })

  it('PolicyGate.Policy — a gate page reads this back off a deployed gate', () => {
    const declared = structFields(sol('PolicyGate.sol'), 'Policy').map((f) => f.name)
    expect(declared).toEqual([
      'promptHead',
      'promptTail',
      'allowedModelHash',
      'allowedProvider',
      'maxRisk',
    ])
    expect(ourTupleFields(GATE, 'getPolicy', 'outputs')).toEqual(declared)
  })

  it('PolicyGateFactory.GateSpec — Studio builds this tuple to deploy a gate', () => {
    // `allowedModelHash` is gone: the factory derives it from `modelName`, so a gate can no
    // longer ask about one model and accept an answer from another.
    const declared = structFields(sol('PolicyGateFactory.sol'), 'GateSpec').map((f) => f.name)
    expect(declared).toEqual(['modelName', 'promptHead', 'promptTail', 'allowedProvider', 'maxRisk'])
    expect(ourTupleFields(FACTORY, 'deployGate', 'inputs')).toEqual(declared)
    expect(declared).not.toContain('allowedModelHash')
  })

  /**
   * The positional read itself, exercised end to end.
   *
   * The test above pins the ABI tuple to the Solidity struct; this one pins the app's decoder to
   * that same tuple, by encoding a writ whose every field is a distinguishable value and
   * checking each one comes back under the right name. Give `notarizedAt` a value an address
   * could never be and the off-by-one that a removed field causes cannot pass silently.
   */
  it('decodeWrit lands every field on its own label', () => {
    const encoded = REGISTRY.encodeFunctionResult('getWrit', [
      [
        getAddress('0x4870cbc4d07d6ac2ee5aa865588e5985fe77a4e9'),
        '0x' + '11'.repeat(32),
        '0x' + '22'.repeat(32),
        '0x' + '33'.repeat(32),
        1_787_000_000,
        getAddress('0x2e6b8dc19a05f34eb7c0d5a8f2913e6bc47a0d82'),
      ],
    ])
    const raw = REGISTRY.decodeFunctionResult('getWrit', encoded)[0] as unknown as RawWrit

    const writ = decodeWrit('0x' + 'ab'.repeat(32), raw, false)
    expect(writ.provider).toBe('0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9')
    expect(writ.modelHash).toBe('0x' + '11'.repeat(32))
    expect(writ.reqHash).toBe('0x' + '22'.repeat(32))
    expect(writ.respHash).toBe('0x' + '33'.repeat(32))
    expect(writ.notarizedAt).toBe(1_787_000_000)
    expect(writ.notarizedBy).toBe('0x2e6b8Dc19A05F34Eb7c0d5a8F2913e6bC47a0D82')

    // The record itself carries no archive pointer any more, so nothing here can offer one.
    expect(writ).not.toHaveProperty('transcriptRoot')
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
    const needed = [
      'getWrit',
      'getRoutingProof',
      'isNotarized',
      'isRoutingProof',
      'writId',
      'routingWritId',
      'writCount',
      'serving',
      // The candidate list. A reader no longer trusts one pointer: it walks these in order and
      // takes the first whose bytes re-derive the writ's own hashes.
      'transcriptRoots',
      'transcriptRootCount',
      'transcriptRootAt',
      'transcriptSubmitter',
      'transcriptQuotaUsed',
      'MAX_ROOTS_PER_SUBMITTER',
    ]
    for (const name of needed) {
      expect([...inSource], `WritRegistry.${name}`).toContain(name)
      expect(REGISTRY.getFunction(name), `this app's ABI has no ${name}`).toBeTruthy()
    }

    // The single stored pointer is gone from the contract, so nothing here may still declare one.
    expect(sol('WritRegistry.sol')).not.toContain('MAX_TRANSCRIPT_ROOTS')
    expect(sol('WritRegistry.sol')).not.toContain('TooManyTranscriptRoots')
    expect(WRIT_REGISTRY_ABI.join('\n')).not.toContain('MAX_TRANSCRIPT_ROOTS')
    expect(WRIT_REGISTRY_ABI.join('\n')).not.toContain('TooManyTranscriptRoots')
  })

  it('TreasuryGate.execute no longer notarizes, so it takes no signature and no root', () => {
    // Inline notarization is gone: a failed approval must not roll back the record with it.
    // Both settle functions therefore end at `provider`, and the writ must already be recorded.
    expect(sol('TreasuryGate.sol')).toMatch(
      /function\s+execute\(address to, uint256 amount, bytes calldata rawResponse, address provider\)/,
    )
    for (const fn of ['execute', 'executeRoutingProof']) {
      const inputs = GATE.getFunction(fn)!.inputs.map((i) => i.name)
      expect(inputs, `${fn} still takes a signature`).not.toContain('signature')
      expect(inputs, `${fn} still takes a transcript root`).not.toContain('transcriptRoot')
    }
    // And the revert a caller now hits by settling an unrecorded writ has to be readable.
    expect(GATE.getError('WritNotNotarized')).toBeTruthy()
    expect(sol('PolicyGate.sol')).toContain('error WritNotNotarized(bytes32 id)')
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
      'executeRoutingProof',
      'recover',
    ]) {
      expect([...inSource], `TreasuryGate.${name}`).toContain(name)
    }
  })

  it('PolicyGateFactory', () => {
    const inSource = members('PolicyGateFactory.sol')
    // `buildPromptHead` is the one Studio's preview depends on: it is the contract's own splice
    // of the model key onto the author's bytes, so the preview shows what will be deployed
    // rather than the app's guess at it.
    for (const name of ['deployGate', 'buildPromptHead', 'gatesOf', 'gateCount', 'allGates', 'registry']) {
      expect([...inSource], `PolicyGateFactory.${name}`).toContain(name)
      expect(FACTORY.getFunction(name), `this app's ABI has no ${name}`).toBeTruthy()
    }
    // The model-key splice and its four errors live in `PromptLib`, which the factory reverts
    // through. Their selectors still reach a caller of `deployGate`, so the app's factory ABI
    // has to carry them even though the declarations are read from the library.
    for (const err of ['ModelNameEmpty', 'ModelNameTooLong', 'ModelNameHasIllegalByte', 'ModelKeyInPrompt']) {
      expect(sol('PromptLib.sol')).toContain(`error ${err}(`)
      expect(FACTORY.getError(err), `this app's ABI cannot decode ${err}`).toBeTruthy()
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
