import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { keccak256, toUtf8Bytes } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  buildParams,
  buildRequestBody,
  DEFAULT_HEAD,
  DEFAULT_TAIL,
  hasModelKey,
  modelHash,
  modelNameProblem,
  percentOfBalance,
  requestDigest,
  validate,
  type PolicyDraft,
  type TransferFacts,
} from '@/lib/policy'
import { sha256Hex, utf8 } from '@/lib/hashes'

const GATE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../contracts/src/TreasuryGate.sol', import.meta.url)),
  'utf8',
)

const FACTS: TransferFacts = {
  recipient: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  amount: 250_000_000_000_000_000_000n,
  nonce: 7n,
  treasuryBalance: 412_608_400_000_000_000_000n,
  priorApprovals: 3n,
  priorRefusals: 2n,
  recipientPriorPayments: 0n,
  recipientPriorTotal: 0n,
}

describe('the question Studio previews is the question the gate builds', () => {
  it('uses the contract’s field names, in the contract’s order', () => {
    // Pulled from the two abi.encodePacked calls in TreasuryGate.buildParams, so this fails
    // if a field is renamed, reordered, added or dropped on chain.
    const declared = [...GATE_SOURCE.matchAll(/"(\s?[a-zA-Z]+)="/g)].map((m) => m[1]!.trim())
    expect(declared).toEqual([
      'recipient',
      'amount',
      'nonce',
      'treasuryBalance',
      'amountPctOfBalance',
      'priorApprovals',
      'priorRefusals',
      'recipientPriorPayments',
      'recipientPriorTotal',
    ])

    const built = buildParams(FACTS)
    const keys = [...built.matchAll(/(\w+)=/g)].map((m) => m[1]!)
    expect(keys).toEqual(declared)
  })

  it('writes the recipient the way Strings.toHexString does — lowercase, 0x, 40 characters', () => {
    expect(GATE_SOURCE).toContain('Strings.toHexString(to)')
    expect(buildParams(FACTS)).toContain('recipient=0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae')
  })

  it('writes amounts in wei as decimal integers, not as ether', () => {
    expect(buildParams(FACTS)).toContain('amount=250000000000000000000')
    expect(buildParams(FACTS)).toContain('treasuryBalance=412608400000000000000')
  })

  it('reproduces _percentOfBalance including its cap and its zero cases', () => {
    expect(percentOfBalance(250n * 10n ** 18n, 412n * 10n ** 18n)).toBe(60n)
    expect(percentOfBalance(0n, 0n)).toBe(0n)
    // An empty treasury reports the cap rather than dividing by zero.
    expect(percentOfBalance(1n, 0n)).toBe(999n)
    // And an absurd amount cannot stretch the prompt with a huge number.
    expect(percentOfBalance(10n ** 30n, 1n)).toBe(999n)
    expect(GATE_SOURCE).toContain('PCT_CAP = 999')
  })

  it('assembles head + facts + tail, which is exactly buildRequestBody', () => {
    const body = buildRequestBody('HEAD>', '<TAIL', FACTS)
    expect(body.startsWith('HEAD>')).toBe(true)
    expect(body.endsWith('<TAIL')).toBe(true)
    expect(body).toContain(buildParams(FACTS))
    expect(GATE_SOURCE).toContain('buildRequestBody(POLICY_ID, buildParams(to, amount))')
  })

  it('digests the exact bytes, and turns over completely on one character', async () => {
    const body = buildRequestBody('HEAD>', '<TAIL', FACTS)
    const digest = await requestDigest(body)
    expect(digest).toBe(await sha256Hex(utf8(body)))

    const nudged = await requestDigest(buildRequestBody('HEAD>', '<TAIL', { ...FACTS, nonce: 8n }))
    expect(nudged).not.toBe(digest)
    // Nothing in common: a sha256 is not a checksum with a locality property.
    const shared = [...digest].filter((c, i) => nudged[i] === c).length
    expect(shared).toBeLessThan(20)
  })

  it('names the model by keccak256 of its registered name', () => {
    expect(modelHash('0GM-1.0-35B-A3B')).toBe(keccak256(toUtf8Bytes('0GM-1.0-35B-A3B')))
    expect(modelHash('glm-5.2')).not.toBe(modelHash('glm-5.1'))
  })
})

describe('the model key belongs to the factory, not to the author', () => {
  // `PromptLib` is the single implementation of the splice: the factory and `AgentTreasury`
  // both build through it, so this is the source the app's mirror has to agree with.
  const PROMPT_LIB_SOURCE = readFileSync(
    fileURLToPath(new URL('../../contracts/src/PromptLib.sol', import.meta.url)),
    'utf8',
  )

  it('leaves the model key out of the default prompt entirely', () => {
    // The contract writes `{"model":"<modelName>",` itself and derives allowedModelHash from
    // that same string, so a head carrying its own model key is rejected outright.
    expect(hasModelKey(DEFAULT_HEAD)).toBe(false)
    expect(hasModelKey(DEFAULT_TAIL)).toBe(false)
    expect(DEFAULT_HEAD.startsWith('{')).toBe(false)
    expect(PROMPT_LIB_SOURCE).toContain('abi.encodePacked(\'{"model":"\', modelName, \'",\', promptHead)')
  })

  it('rejects the bytes the factory rejects, and names the error it stands in for', () => {
    expect(modelNameProblem('0GM-1.0-35B-A3B')).toBeNull()
    expect(modelNameProblem('')).toMatch(/ModelNameEmpty/)
    expect(modelNameProblem('x'.repeat(65))).toMatch(/ModelNameTooLong\(65\)/)
    expect(modelNameProblem('x'.repeat(64))).toBeNull()
    // A quote would end the JSON string literal early and let the rest be read as structure.
    expect(modelNameProblem('glm","messages":[')).toMatch(/ModelNameHasIllegalByte\(3\)/)
    expect(modelNameProblem('glm\\5')).toMatch(/ModelNameHasIllegalByte\(3\)/)
    expect(modelNameProblem('glm\n5')).toMatch(/ModelNameHasIllegalByte\(3\)/)
    // Counted in bytes, as the contract counts them, not in JavaScript characters.
    expect(modelNameProblem('é'.repeat(33))).toMatch(/ModelNameTooLong\(66\)/)
    expect(PROMPT_LIB_SOURCE).toContain('MAX_MODEL_NAME = 64')
  })

  it('catches a smuggled second model key before a wallet is opened', () => {
    expect(hasModelKey('{"model":"other"')).toBe(true)
    expect(hasModelKey('"temperature":0,"messages":[]')).toBe(false)
  })
})

describe('a draft is checked against what the factory would revert on', () => {
  const base: PolicyDraft = {
    promptHead: '"temperature":0,"messages":[{"role":"user","content":"ask something',
    promptTail: '"}]}',
    model: 'glm-5.2',
    provider: '0xA46EA4FC5889AD35A1487e1Ed04dCcfa872146B9',
    restrictToProvider: true,
    maxRisk: 40,
    agent: '0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D',
    owner: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  }

  it('accepts a well-formed draft', () => {
    expect(validate(base)).toEqual([])
  })

  it('rejects an empty prompt head, as EmptyPrompt() would', () => {
    expect(validate({ ...base, promptHead: '   ' }).map((p) => p.field)).toContain('promptHead')
  })

  it('rejects a ceiling above 100, as RiskCeilingTooHigh would', () => {
    expect(validate({ ...base, maxRisk: 101 }).map((p) => p.field)).toContain('maxRisk')
    expect(validate({ ...base, maxRisk: 100 })).toEqual([])
  })

  it('rejects a non-address agent or owner', () => {
    expect(validate({ ...base, agent: 'me' }).map((p) => p.field)).toContain('agent')
    expect(validate({ ...base, owner: '' }).map((p) => p.field)).toContain('owner')
  })

  it('warns when the agent is also the owner, which the chain permits and the design does not', () => {
    const problems = validate({ ...base, owner: base.agent })
    expect(problems.map((p) => p.message).join(' ')).toMatch(/recovery hatch/)
  })

  it('rejects a blank or malformed model name, as the four new errors would', () => {
    expect(validate({ ...base, model: '' }).map((p) => p.field)).toContain('model')
    expect(validate({ ...base, model: 'x'.repeat(65) }).map((p) => p.field)).toContain('model')
    expect(validate({ ...base, model: 'a"b' }).map((p) => p.field)).toContain('model')
  })

  it('rejects a prompt that writes its own model key, as ModelKeyInPrompt would', () => {
    const withKey = validate({ ...base, promptHead: '{"model":"something-else","messages":[' })
    expect(withKey.map((p) => p.field)).toContain('promptHead')
    expect(withKey.map((p) => p.message).join(' ')).toMatch(/ModelKeyInPrompt/)
    expect(validate({ ...base, promptTail: '","model":"x"}' }).map((p) => p.field)).toContain('promptTail')
  })
})
