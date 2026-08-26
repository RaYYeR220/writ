import { getAddress, keccak256, toUtf8Bytes } from 'ethers'
import { sha256Hex, utf8 } from './hashes'

/**
 * The question a gate will pin, rebuilt exactly as `TreasuryGate` builds it.
 *
 * Mirrors `TreasuryGate.buildParams` field for field and in order. It exists so Studio can show
 * the bytes and the digest *before* anything is deployed — and, more usefully, so it can show
 * that the middle of the question is not the author's to write. The head and the tail are
 * policy; everything between them is the contract reporting its own state at execute time.
 *
 * `test/policy.test.ts` pins this format against the Solidity source. If the contract's field
 * order ever changes, the preview would otherwise start lying about a digest, which is a worse
 * failure than no preview at all.
 */

export type TransferFacts = {
  recipient: string
  /** wei */
  amount: bigint
  nonce: bigint
  /** wei */
  treasuryBalance: bigint
  priorApprovals: bigint
  priorRefusals: bigint
  recipientPriorPayments: bigint
  /** wei */
  recipientPriorTotal: bigint
}

/** `TreasuryGate._percentOfBalance`, capped exactly where the contract caps it. */
export function percentOfBalance(amount: bigint, balance: bigint): bigint {
  const CAP = 999n
  if (amount === 0n) return 0n
  if (balance === 0n) return CAP
  const pct = (amount * 100n) / balance
  return pct > CAP ? CAP : pct
}

/** The params block, byte-for-byte as the contract concatenates it. */
export function buildParams(f: TransferFacts): string {
  const recipient = f.recipient.toLowerCase()
  return (
    `recipient=${recipient}` +
    ` amount=${f.amount.toString()}` +
    ` nonce=${f.nonce.toString()}` +
    ` treasuryBalance=${f.treasuryBalance.toString()}` +
    ` amountPctOfBalance=${percentOfBalance(f.amount, f.treasuryBalance).toString()}` +
    ` priorApprovals=${f.priorApprovals.toString()}` +
    ` priorRefusals=${f.priorRefusals.toString()}` +
    ` recipientPriorPayments=${f.recipientPriorPayments.toString()}` +
    ` recipientPriorTotal=${f.recipientPriorTotal.toString()}`
  )
}

/** `PolicyGate.buildRequestBody`: head, then the contract's own facts, then tail. */
export function buildRequestBody(promptHead: string, promptTail: string, facts: TransferFacts): string {
  return promptHead + buildParams(facts) + promptTail
}

/** The digest the gate will demand a signature over. */
export async function requestDigest(body: string): Promise<string> {
  return await sha256Hex(utf8(body))
}

/** `keccak256(bytes(model))`, which is how a policy names the model it will accept. */
export function modelHash(model: string): string {
  return keccak256(toUtf8Bytes(model))
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type PolicyDraft = {
  /**
   * The model name, as its own field.
   *
   * The factory writes `{"model":"<model>",` itself and derives `allowedModelHash` from this
   * same string, so the model a gate's question names and the model its writs are checked
   * against cannot disagree. It used to be possible to pass a prompt head naming one model and
   * an unrelated hash, producing a gate that asked about one and accepted an answer from
   * another with every check passing.
   */
  model: string
  /** Continues from the model key the factory writes: `"temperature":0,"messages":[…`. */
  promptHead: string
  promptTail: string
  provider: string
  /** Empty means any acknowledged TeeML provider, which is what `address(0)` means on chain. */
  restrictToProvider: boolean
  maxRisk: number
  agent: string
  owner: string
}

export type DraftProblem = { field: keyof PolicyDraft; message: string }

/** `PolicyGateFactory.MAX_MODEL_NAME`. */
export const MAX_MODEL_NAME = 64

/**
 * `PolicyGateFactory._requireModelName`, byte for byte.
 *
 * The name is spliced into a JSON string literal, so anything that could end that literal early
 * would let the rest be read as structure — a caller could rewrite the messages array from
 * inside what looks like a model name. The contract rejects `"` and `\` and every control byte;
 * so does this, before a wallet is ever opened.
 */
export function modelNameProblem(model: string): string | null {
  const raw = new TextEncoder().encode(model)
  if (raw.length === 0) {
    return 'Choose a provider above, or type the model name — the factory reverts with ModelNameEmpty().'
  }
  if (raw.length > MAX_MODEL_NAME) {
    return `The model name is ${raw.length} bytes; the factory reverts with ModelNameTooLong(${raw.length}) above ${MAX_MODEL_NAME}.`
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c === 0x22 || c === 0x5c || c < 0x20) {
      return `Byte ${i} of the model name is one the factory rejects with ModelNameHasIllegalByte(${i}) — a quote, a backslash or a control byte would end the JSON string early and let the rest be read as structure.`
    }
  }
  return null
}

/**
 * `PolicyGateFactory._requireNoModelKey`, byte for byte.
 *
 * JSON leaves duplicate keys to the parser, so a second `"model"` could win and the provider
 * would run a model the gate never named. The factory writes the key itself, so the caller's
 * bytes may not carry one.
 */
export function hasModelKey(prompt: string): boolean {
  return prompt.includes('"model"')
}

/**
 * Everything the factory would revert on, checked before a wallet is ever opened.
 *
 * Each message names the custom error it is standing in for, so a reader can match what the page
 * says to what the chain would have said. The page never claims a deploy will succeed — only
 * that these particular refusals will not be the reason it does not.
 */
export function validate(draft: PolicyDraft): DraftProblem[] {
  const problems: DraftProblem[] = []

  if (draft.promptHead.trim().length === 0) {
    problems.push({ field: 'promptHead', message: 'The head cannot be empty — the factory reverts with EmptyPrompt().' })
  }
  if (draft.maxRisk < 0 || draft.maxRisk > 100) {
    problems.push({
      field: 'maxRisk',
      message: 'The ceiling must be 0–100. Above 100 the factory reverts with RiskCeilingTooHigh, because it would wave through every verdict the grammar can express.',
    })
  }
  if (!isAddress(draft.agent)) {
    problems.push({ field: 'agent', message: 'The agent must be an address. The zero address reverts with ZeroAgent().' })
  }
  if (!isAddress(draft.owner)) {
    problems.push({ field: 'owner', message: 'The owner must be an address. The zero address reverts with ZeroOwner().' })
  }
  if (isAddress(draft.agent) && isAddress(draft.owner) && draft.agent.toLowerCase() === draft.owner.toLowerCase()) {
    problems.push({
      field: 'owner',
      message:
        'The chain permits this, but it defeats the point: the owner holds the 30-day recovery hatch, and an agent that also owns it can stop asking for verdicts and sweep the treasury itself.',
    })
  }
  const modelProblem = modelNameProblem(draft.model)
  if (modelProblem) problems.push({ field: 'model', message: modelProblem })

  if (hasModelKey(draft.promptHead)) {
    problems.push({
      field: 'promptHead',
      message:
        'The head carries a "model" key of its own — the factory writes that key itself and reverts with ModelKeyInPrompt(). Start the head from "temperature":0,"messages":[… instead.',
    })
  }
  if (hasModelKey(draft.promptTail)) {
    problems.push({
      field: 'promptTail',
      message: 'The tail carries a "model" key — the factory reverts with ModelKeyInPrompt().',
    })
  }
  return problems
}

/**
 * The factory's custom errors, in the app's voice.
 *
 * `explain` already decodes a revert into `ModelKeyInPrompt()` because the ABI declares it.
 * This turns that into a sentence saying what to do about it — the name and its arguments are
 * kept in the text so a reader can still match what the page says to what the chain said.
 */
export function explainGateError(decoded: string): string {
  const name = /^(\w+)\(/.exec(decoded)?.[1]
  const arg = /^\w+\(([^,)]*)/.exec(decoded)?.[1] ?? ''

  switch (name) {
    case 'ModelNameEmpty':
      return `${decoded} — the gate needs a model name. It is the one string the factory both writes into the question and hashes into allowedModelHash, so it cannot be blank.`
    case 'ModelNameTooLong':
      return `${decoded} — the model name is ${arg} bytes and the factory allows ${MAX_MODEL_NAME}.`
    case 'ModelNameHasIllegalByte':
      return `${decoded} — byte ${arg} of the model name is a quote, a backslash or a control byte. The name is spliced into a JSON string literal, so a byte that could end that literal early would let the rest be read as structure.`
    case 'ModelKeyInPrompt':
      return `${decoded} — your prompt writes its own "model" key. The factory writes that key itself from the model name, and a duplicate could win in the provider's parser, so the gate would name one model and the provider would run another.`
    case 'EmptyPrompt':
      return `${decoded} — the prompt head cannot be empty.`
    case 'RiskCeilingTooHigh':
      return `${decoded} — a ceiling above 100 would wave through every verdict the grammar can express.`
    case 'ZeroAgent':
      return `${decoded} — the agent cannot be the zero address; nobody could ever call the gate.`
    case 'ZeroOwner':
      return `${decoded} — the owner cannot be the zero address; the recovery hatch would be unreachable.`
    default:
      return decoded
  }
}

export function isAddress(value: string): boolean {
  try {
    getAddress(value)
    return true
  } catch {
    return false
  }
}

/**
 * The default policy, written in the voice the contract needs: one line out, strict grammar.
 *
 * It starts *after* the model key. The factory prepends `{"model":"<modelName>",` and this
 * continues from there, which is why there is an opening brace nowhere in sight.
 */
export const DEFAULT_HEAD = `"temperature":0,"max_tokens":16,"messages":[{"role":"system","content":"You are the risk officer for an autonomous treasury on 0G. Judge the transfer described below on its own facts. Answer on ONE line, exactly: ALLOW:<risk 00-99> or DENY:<risk 00-99>. No other text."},{"role":"user","content":"Transfer request. `

export const DEFAULT_TAIL = `"}]}`
