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
  /**
   * Ask a question whose treasury facts are not the treasury's.
   *
   * The gate derives the balance, the decision counts and the recipient's payment history from
   * its own state, so a client that wants a flattering answer has to lie about them in the body
   * it posts. This probe tells that lie.
   */
  | 'doctored-facts'
  /**
   * Obtain an honest proof, then move the treasury before settling it.
   *
   * The question carries live state, so the proof answers the treasury as it stood. This probe
   * exists to show that the binding really is that tight, and that it is not a nonce check
   * wearing a bigger coat.
   */
  | 'state-drift'
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
  /**
   * A genuine signature, over response bytes that were edited after it was produced.
   *
   * Settlement does not notarize, so the altered bytes have to be taken to `WritRegistry` first
   * and that is where recovery fails. The honest proof is deliberately left off the record so
   * `writCount` measures only the forgery.
   */
  | 'altered-response'
  /**
   * The right text, signed by a key that is not the provider's registered TEE.
   *
   * Also rejected at the registry now. Nothing is notarized anywhere in this probe, so a run of
   * it leaves `writCount` exactly where it found it.
   */
  | 'forged-signature'
  /** A whole provider endpoint signing with the wrong key, so the SDK meets it as a client would. */
  | 'forged-provider'
  /**
   * The whole pipeline against a *centralized* provider's five-field routing proof.
   *
   * Most live 0G mainnet providers are centralized, so this is the format the majority of the
   * network actually signs: `sha256(req):sha256(resp):providerType:providerIdentity:tlsFingerprint`.
   * It notarizes through `notarizeRoutingProof` and settles through `executeRoutingProof`, and it
   * binds strictly more than the chat path — the proof names the upstream that answered.
   */
  | 'routing'
  /**
   * A genuine routing proof settled down the chat path instead of the routing one.
   *
   * The two writ ids are domain-separated, so the chat id the gate computes names a record that
   * does not exist. Tests that the separation is real rather than decorative.
   */
  | 'routing-as-chat'
  /**
   * A genuine routing proof offered to the registry under doctored attribution.
   *
   * The `:`-joined signed text is ambiguous under field splitting — `("x", "y:z")` and
   * `("x:y", "z")` produce identical bytes — so one valid signature could otherwise be recorded
   * against the wrong upstream. `WritRegistry._requireLabel` is the guard; this probe calls the
   * registry directly, because the SDK refuses to build such a proof at all and the guard under
   * test lives in the contract.
   */
  | 'routing-attribution'

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
  /**
   * A fresh, previously-unseen address derived from the run's recipient seed.
   *
   * Was `random` until the keys started mattering: a random recipient's key is discarded, so
   * every approved transfer under `--live` left the treasury permanently. Derived addresses are
   * indistinguishable to both the gate and the model, and recoverable afterwards. `role`
   * separates the two addresses a mismatch scenario needs.
   */
  | { kind: 'derived'; role?: 'recipient' | 'execute-recipient' }
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

  /**
   * Transfers settled to this recipient *before* the graded one, so the gate has a real payment
   * history to report about it.
   *
   * Each is a full honest run through the pipeline, so `recipientPriorPayments`,
   * `recipientPriorTotal` and `priorApprovals` are earned rather than asserted. If one of them
   * does not approve there is no history, the scenario's premise does not hold, and it is
   * recorded as `errored` — never quietly graded as though the history were there.
   */
  history?: { payments: AmountSpec[]; answer?: string }

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
  /**
   * Facts to overwrite in the question that is actually posted, by name, as decimal strings.
   * Everything not named here is left as the gate reported it, so the lie is exactly this big.
   */
  factOverrides?: Partial<Record<QuestionFact, string>>
  /** How much to pay into the treasury between proof and settlement, for `state-drift`. */
  drift?: AmountSpec
  /**
   * Attribution to substitute before offering a routing proof to the registry, for
   * `routing-attribution`. Exactly one field, so the probe tests exactly one guard.
   */
  routingOverride?: { field: 'providerType' | 'providerIdentity'; value: string }
}

/**
 * The nine facts `TreasuryGate.buildParams` pins, in the order it renders them.
 *
 * Named here so a scenario cannot misspell one: an override for a field the gate does not report
 * would produce a question nobody is asking and grade nothing.
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
  /**
   * A transaction reverted and nothing moved.
   *
   * Since notarization was split out of settlement there are two places this can happen, and the
   * `mechanism` string names which: `WritRegistry.notarize` refusing to record a proof at all, or
   * `TreasuryGate.execute` refusing to act on the record it can see. The first is the stronger
   * refusal — a proof the registry rejects never enters the permanent record.
   */
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
  /**
   * What stopped it, as observed: a custom error name, an event, or an SDK message.
   *
   * A revert also says where it happened — `... at WritRegistry.notarize` or
   * `... at TreasuryGate.execute` — because since the split those are two different claims.
   */
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
  /**
   * Controls that could not run in this mode.
   *
   * Tracked separately from `skipped` because the "did a negative control fail?" warning has to
   * discount exactly these. Netting the total skipped count against the control total instead
   * would let unrelated skips paper over a control that genuinely did not fail.
   */
  controlsSkipped: number
  errored: number
  skipped: number
  mechanismMismatches: number
  /** How many graded scenarios were driven by an adversarial answer rather than a supplied one. */
  adversariallyAnswered: number
  suppliedCorrectAnswers: number
}
