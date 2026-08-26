/**
 * The shape of `scenarios.json` and of a graded result.
 *
 * `scenarios.json` is the answer key. It is committed before the harness runs against it, so
 * nothing in this file may derive an expectation from an observation — every `expected` value
 * comes off disk.
 */

export type Band = 'safe' | 'dangerous' | 'trap' | 'control'

/**
 * What the answer key demands.
 *
 * - `approve` — the funds must move.
 * - `refuse`  — the funds must not move, by any mechanism. A recorded refusal, a reverted
 *               settlement and a client-side rejection all satisfy it.
 * - `fail`    — the proof must be rejected outright. A control that ends in a *recorded* verdict
 *               has not been rejected, so it does not satisfy this even though no funds moved.
 */
export type Expected = 'approve' | 'refuse' | 'fail'

/** How the harness drives one scenario. Each value is a distinct attack or a distinct honest run. */
export type Probe =
  /** The sanctioned path: post the gate's own bytes, settle the same transfer. */
  | 'normal'
  /** Ask about a nonce the contract will not pin. */
  | 'stale-nonce'
  /** Ask about one amount, settle another. */
  | 'amount-mismatch'
  /** Ask about one recipient, settle to another. */
  | 'recipient-mismatch'
  /** Smuggle an override instruction into the request body the provider actually sees. */
  | 'injected'
  /** Doctor the request to stream, so no single body exists for the TEE to sign. */
  | 'streaming'
  /** Settle a genuine approval, then settle it again. */
  | 'replay'
  /** Settle naming a provider other than the one the proof and the policy name. */
  | 'wrong-provider'
  /** Have the stand-in TEE sign a response body we composed, to probe the verdict parser. */
  | 'crafted-response'
  /** A genuine proof of a question the agent wrote rather than the one the gate asked. */
  | 'unrelated-question'
  /** A genuine signature, over response bytes that were edited after it was produced. */
  | 'altered-response'
  /** The right text, signed by a key that is not the provider's registered TEE. */
  | 'forged-signature'
  /** A whole provider endpoint signing with the wrong key, so the SDK meets it as a client would. */
  | 'forged-provider'

/** Where the model's answer came from when running against the stand-in signer. */
export type AnswerSource =
  /** We handed the stub the answer a correct model would give. Grades plumbing only. */
  | 'supplied-correct'
  /** We handed the stub the answer a naive gate would be fooled by. Grades the machinery. */
  | 'adversarial'

export type AmountSpec =
  | { og: string }
  | { wei: string }
  /** A fraction of the treasury's balance at the moment the scenario starts. */
  | { balanceFraction: number }
  /** A multiple of that balance, for amounts the treasury cannot cover. */
  | { balanceMultiple: number }

export type RecipientSpec =
  | { kind: 'random' }
  | { kind: 'fixed'; address: string }
  /** The agent's own address — the caller paying itself. */
  | { kind: 'agent' }

export type Scenario = {
  id: string
  band: Band
  title: string
  /** Why the answer key says what it says. Written before the run. */
  rationale: string
  expected: Expected
  probe: Probe
  recipient: RecipientSpec
  amount: AmountSpec
  forkAnswer: { content: string; source: AnswerSource }
  /** Reported, never graded: under `--live` a different correct mechanism may catch a scenario. */
  expectMechanism: string
  /** Custom errors that would be an unsurprising way for this to be stopped. */
  expectRevert?: string[]
  /** Cannot be expressed against a real provider; recorded as skipped under `--live`. */
  forkOnly?: boolean
  skipReason?: string
  notes?: string

  // probe-specific
  nonceOffset?: number
  executeAmount?: AmountSpec
  executeRecipient?: RecipientSpec
  executeProvider?: string
  injection?: string
  injectionStyle?: 'append' | 'system'
  craftedResponse?: string
  unrelatedQuestion?: string
  responseEdit?: { from: string; to: string }
}

export type ScenarioFile = {
  version: number
  registeredOn: string
  gate: string
  policy: { model: string; maxRisk: number; treasuryBalanceOg: string; questionShape: string }
  readMeFirst: string[]
  scenarios: Scenario[]
}

/**
 * What actually happened.
 *
 * `errored` and `skipped` are outcomes in their own right and never grade as a pass — an
 * unexplained exception must never be able to look like a correct refusal.
 */
export type Outcome =
  /** `TransferApproved`: the funds moved. */
  | 'approved'
  /** `TransferRefused` with `refusedBy == Model`. A successful transaction. */
  | 'refused-model'
  /** `TransferRefused` with `refusedBy == Policy`. Also a successful transaction. */
  | 'refused-policy'
  /** The settlement reverted. No decision was recorded and nothing moved. */
  | 'blocked'
  /** The SDK refused before any transaction was sent. */
  | 'attest-failed'
  /** Something went wrong that the scenario did not predict. Never a pass. */
  | 'errored'
  /** Not runnable in this mode. Never a pass, and always shown in the output. */
  | 'skipped'

export type Result = {
  id: string
  band: Band
  expected: Expected
  outcome: Outcome
  pass: boolean
  /** What stopped it, as observed: a custom error name, an event, or an SDK message. */
  mechanism: string
  /** True when the mechanism was not one the answer key predicted. Reported, not graded. */
  mechanismMismatch: boolean
  answerSource: AnswerSource | 'model' | 'n/a'
  /** The verdict text the model actually produced, when there was one. */
  verdict?: string
  fundsMoved: boolean
  recipient?: string
  amountWei?: string
  writId?: string
  notarizeTx?: string
  settleTx?: string
  detail?: string
  ms: number
}

export type Scorecard = {
  total: number
  ran: number
  correctApprovals: number
  correctRefusals: number
  falseApprovals: number
  falseRefusals: number
  trapsRefused: number
  trapsTotal: number
  controlsFailedAsDesigned: number
  controlsTotal: number
  errored: number
  skipped: number
  mechanismMismatches: number
  /** How many graded scenarios were driven by an adversarial answer rather than a supplied one. */
  adversariallyAnswered: number
  suppliedCorrectAnswers: number
}
