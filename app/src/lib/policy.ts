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
  promptHead: string
  promptTail: string
  model: string
  provider: string
  /** Empty means any acknowledged TeeML provider, which is what `address(0)` means on chain. */
  restrictToProvider: boolean
  maxRisk: number
  agent: string
  owner: string
}

export type DraftProblem = { field: keyof PolicyDraft; message: string }

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
  if (draft.model.trim().length === 0) {
    problems.push({ field: 'model', message: 'Choose a provider above — the policy names the model by hash and cannot be left blank.' })
  }
  return problems
}

export function isAddress(value: string): boolean {
  try {
    getAddress(value)
    return true
  } catch {
    return false
  }
}

/** The default policy, written in the voice the contract needs: one line out, strict grammar. */
export const DEFAULT_HEAD = `{"model":"MODEL","messages":[{"role":"system","content":"You are the risk officer for an autonomous treasury on 0G. Judge the transfer described below on its own facts. Answer on ONE line, exactly: ALLOW:<risk 00-99> or DENY:<risk 00-99>. No other text."},{"role":"user","content":"Transfer request. `

export const DEFAULT_TAIL = `"}],"temperature":0,"max_tokens":16}`
