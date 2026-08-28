import { refusalName } from './abi'

/**
 * What the ceiling ruler is allowed to say.
 *
 * The ruler plots one number against one line, and for a long time it read the outcome straight
 * off that picture: past the line meant "over the ceiling → held", short of it meant "under the
 * ceiling → released". Both of those are claims about *cause*, and the geometry does not carry
 * cause. `TransferRefused` does, in `refusedBy`, and the contracts separate the two on purpose:
 *
 *   `Refusal.Model`  — the model answered DENY. The gate never got as far as comparing the score
 *                      to its ceiling, so the ceiling is not why the funds stayed, whatever the
 *                      score happens to be. A ceiling can only overrule an ALLOW.
 *   `Refusal.Policy` — the model answered ALLOW above the ceiling and the ceiling overruled it.
 *                      This one, and only this one, is the sentence the ruler was written for.
 *
 * So the score keeps its place on the ruler — it is still the measurement the page exists to
 * show — and the words underneath come from the record instead of from the drawing.
 */

/** Who ended the decision, as far as the record actually establishes it. */
export type Cause = 'released' | 'model' | 'policy' | 'unknown'

/**
 * The two facts a page holds — which side the writ landed on, and the `refusedBy` a gate wrote —
 * reduced to one cause, with `unknown` kept as a real answer rather than a fallback to the
 * likelier of the two refusers.
 */
export function refusalCause(held: boolean | null, refusedBy: number | null): Cause {
  if (held === false) return 'released'
  if (refusedBy === null) return 'unknown'

  switch (refusalName(refusedBy)) {
    case 'model':
      return 'model'
    case 'policy':
      return 'policy'
    case 'none':
      // Nobody refused. That is a release, unless the page also believes the funds were held —
      // in which case one of the two facts is wrong and this page cannot tell which.
      return held === true ? 'unknown' : 'released'
    default:
      // An enum value from a later contract. Naming one of the two refusers we do know would be
      // a guess, and a guess is the thing this whole page is built to avoid.
      return 'unknown'
  }
}

export type RulerReading = {
  cause: Cause
  /** `risk − ceiling`. Geometry, true whoever refused. */
  delta: number
  /**
   * The score is past the ceiling. The one reserved warm accent keys off this and nothing else,
   * so a model that declined at a score under the ceiling produces no overshoot and no accent.
   */
  past: boolean
  /** The mark's own label: the score, and its distance from the line. */
  label: string
  /** The short line at the far end of the measured half: what happened, and who did it. */
  end: string
  /** The sentence beneath, where the geometry alone would mislead. Empty when it would not. */
  note: string
}

export function rulerReading({
  risk,
  ceiling,
  held,
  refusedBy,
}: {
  risk: number
  ceiling: number
  held: boolean | null
  refusedBy: number | null
}): RulerReading {
  const cause = refusalCause(held, refusedBy)
  const delta = risk - ceiling
  const past = delta > 0
  const label = `RISK ${risk} · ${past ? `+${delta} OVER` : `${Math.abs(delta)} UNDER`}`

  return { cause, delta, past, label, end: endLine(cause), note: noteLine(cause, risk, ceiling, past) }
}

function endLine(cause: Cause): string {
  switch (cause) {
    case 'released':
      return 'under the ceiling → released'
    case 'policy':
      return 'over the ceiling → held'
    case 'model':
      return 'the model declined → held'
    default:
      return 'held · who said no is not known'
  }
}

function noteLine(cause: Cause, risk: number, ceiling: number, past: boolean): string {
  if (cause === 'model') {
    return past
      ? `The model itself answered DENY, and the gate recorded refusedBy = Model. Risk ${risk} is drawn against this gate’s ceiling of ${ceiling} for scale, not for cause: a ceiling only overrules an ALLOW, and here there was no ALLOW to overrule.`
      : `The model itself answered DENY, and the gate recorded refusedBy = Model. Risk ${risk} never reached this gate’s ceiling of ${ceiling}, so the ceiling had nothing to overrule.`
  }

  if (cause === 'unknown') {
    return `Risk ${risk} against a ceiling of ${ceiling}. The record does not say which of the two refused, so this page names neither.`
  }

  // A release and a ceiling's own refusal are both fully told by the ruler and the seam already.
  return ''
}
