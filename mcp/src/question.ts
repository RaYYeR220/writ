import { formatEther, getAddress } from 'ethers'

/**
 * The nine facts `TreasuryGate.buildParams` pins, in the order the contract renders them.
 *
 * The contract is the sole author of this string — it derives every field from its own state and
 * the action proposed, so a caller cannot understate the balance, hide a refusal history, or
 * claim an unfamiliar recipient is a familiar one. Naming the fields here means a drift between
 * this file and the contract shows up as a parse that returns null, not as a silent
 * misinterpretation.
 */
export const QUESTION_FACTS = [
  'recipient',
  'amount',
  'nonce',
  'treasuryBalance',
  'amountPctOfBalance',
  'priorApprovals',
  'priorRefusals',
  'recipientPriorPayments',
  'recipientPriorTotal',
] as const

export type QuestionFact = (typeof QUESTION_FACTS)[number]

/** Every fact exactly as it appears on the wire: decimal strings, lowercase hex address. */
export type QuestionFacts = Record<QuestionFact, string>

/** `TreasuryGate.PCT_CAP`. */
export const PCT_CAP = 999n

/**
 * Anchored match for the params block inside a full request body.
 *
 * Anchored at both ends on purpose. The block sits inside a JSON string between the policy's
 * prompt head and tail, so an unanchored pattern would happily match a nine-fact prefix of a
 * longer question and report facts that are not the whole truth. The leading lookbehind stops
 * `recipient=` matching the tail of some other key, and the trailing lookahead stops the last
 * number being truncated.
 */
const FACT_PATTERN = new RegExp(
  '(?<![0-9A-Za-z_])' +
    'recipient=(0x[0-9a-fA-F]{40})' +
    ' amount=(\\d+)' +
    ' nonce=(\\d+)' +
    ' treasuryBalance=(\\d+)' +
    ' amountPctOfBalance=(\\d+)' +
    ' priorApprovals=(\\d+)' +
    ' priorRefusals=(\\d+)' +
    ' recipientPriorPayments=(\\d+)' +
    ' recipientPriorTotal=(\\d+)' +
    '(?![0-9])',
)

function text(request: string | Uint8Array): string {
  return typeof request === 'string' ? request : new TextDecoder().decode(request)
}

/**
 * Reads the nine facts out of a request body, or returns null.
 *
 * Null is a real answer: a `PolicyGate` that is not a `TreasuryGate` pins a different question
 * entirely, and inventing fields for it would be worse than admitting they are not there.
 */
export function parseQuestionFacts(request: string | Uint8Array): QuestionFacts | null {
  const m = FACT_PATTERN.exec(text(request))
  if (!m) return null

  const facts = {} as QuestionFacts
  QUESTION_FACTS.forEach((field, i) => {
    facts[field] = m[i + 1]!
  })
  return facts
}

/** Renders facts back to the exact bytes the contract would. */
export function renderQuestionFacts(f: QuestionFacts): string {
  return QUESTION_FACTS.map((k) => `${k}=${f[k]}`).join(' ')
}

/**
 * `TreasuryGate._percentOfBalance`, mirrored.
 *
 * Total by construction, exactly as on chain: an empty treasury reports the cap rather than
 * dividing by zero, and the result is floored, so 25x and 1000x are both 999.
 */
export function percentOfBalance(amount: bigint, balance: bigint): bigint {
  if (amount === 0n) return 0n
  if (balance === 0n) return PCT_CAP
  const pct = (amount * 100n) / balance
  return pct > PCT_CAP ? PCT_CAP : pct
}

/** One fact that is no longer what it was. */
export type FactChange = { field: QuestionFact; was: string; now: string }

export function diffFacts(before: QuestionFacts, after: QuestionFacts): FactChange[] {
  return QUESTION_FACTS.filter((f) => before[f] !== after[f]).map((field) => ({
    field,
    was: before[field],
    now: after[field],
  }))
}

/** Facts that only move when this gate itself settles a decision. */
const SETTLEMENT_FACTS = new Set<QuestionFact>([
  'nonce',
  'priorApprovals',
  'priorRefusals',
  'recipientPriorPayments',
  'recipientPriorTotal',
])

/** Facts that anyone with an address can move, without this gate doing anything. */
const BALANCE_FACTS = new Set<QuestionFact>(['treasuryBalance', 'amountPctOfBalance'])

/**
 * Says, in one sentence, why a proof stopped answering the gate's question.
 *
 * The distinction matters to the caller: a balance that moved on its own is something a stranger
 * did, and no amount of retrying will fix it, while a settlement fact that moved means this gate
 * did something in between. Both need the same remedy — ask again — and neither is a retry.
 */
export function explainDrift(changes: FactChange[]): string {
  const detail = changes.map((c) => `${c.field} ${c.was} -> ${c.now}`).join(', ')
  const fields = changes.map((c) => c.field)

  if (fields.every((f) => BALANCE_FACTS.has(f))) {
    return (
      `the treasury's balance moved without this gate settling anything, so someone else deposited into it or it paid out elsewhere (${detail}). ` +
      'Nothing about the transfer changed, but the question did, and the proof answers the old one.'
    )
  }
  if (fields.some((f) => SETTLEMENT_FACTS.has(f))) {
    return `this gate settled another decision in the meantime (${detail}).`
  }
  return `the facts the gate pins have changed (${detail}).`
}

/** How the facts are reported to a caller: the wire values, plus the readings they imply. */
export type FactsReport = {
  recipient: string
  amount: string
  amountOg: string
  nonce: string
  treasuryBalance: string
  treasuryBalanceOg: string
  amountPctOfBalance: number
  priorApprovals: string
  priorRefusals: string
  recipientPriorPayments: string
  recipientPriorTotal: string
  recipientPriorTotalOg: string
  treasuryCoversAmount: boolean
  recipientIsNew: boolean
}

export function reportFacts(f: QuestionFacts): FactsReport {
  const amount = BigInt(f.amount)
  const balance = BigInt(f.treasuryBalance)
  const priorTotal = BigInt(f.recipientPriorTotal)

  return {
    recipient: getAddress(f.recipient),
    amount: f.amount,
    amountOg: formatEther(amount),
    nonce: f.nonce,
    treasuryBalance: f.treasuryBalance,
    treasuryBalanceOg: formatEther(balance),
    amountPctOfBalance: Number(f.amountPctOfBalance),
    priorApprovals: f.priorApprovals,
    priorRefusals: f.priorRefusals,
    recipientPriorPayments: f.recipientPriorPayments,
    recipientPriorTotal: f.recipientPriorTotal,
    recipientPriorTotalOg: formatEther(priorTotal),
    treasuryCoversAmount: balance >= amount,
    recipientIsNew: f.recipientPriorPayments === '0',
  }
}

/**
 * The readings of these numbers that are not obvious from the numbers.
 *
 * `amountPctOfBalance` is a floored integer with a cap, which makes three different situations
 * look alike unless someone says so out loud, and the recipient history counts approvals only.
 * A model is told this in the system prompt; a calling agent deserves the same.
 */
export function factNotes(f: QuestionFacts): string[] {
  const notes: string[] = []
  const amount = BigInt(f.amount)
  const balance = BigInt(f.treasuryBalance)
  const pct = Number(f.amountPctOfBalance)

  if (balance === 0n && amount > 0n) {
    notes.push('the treasury is empty, which is reported as amountPctOfBalance=999 rather than as a division by zero')
  } else if (pct >= Number(PCT_CAP)) {
    notes.push(
      `amountPctOfBalance is capped at ${PCT_CAP}, so the real ratio is at least that and could be far higher`,
    )
  } else if (pct > 100) {
    notes.push(`amountPctOfBalance is ${pct}: the treasury cannot cover this transfer`)
  } else if (pct === 0 && amount > 0n) {
    notes.push('amountPctOfBalance floors to 0: the transfer is under 1% of the balance, not zero')
  }

  if (f.recipientPriorPayments === '0') {
    notes.push(
      'this treasury has never paid this recipient; recipientPriorPayments and recipientPriorTotal count approvals only, so an earlier refusal does not appear in them',
    )
  }

  return notes
}
