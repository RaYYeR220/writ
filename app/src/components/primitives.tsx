import { formatOG } from '@/lib/format'

/**
 * An amount, split at the decimal point so a column of them lines up.
 *
 * The fraction is dimmed rather than hidden: 250.0000 and 250.0001 are different numbers and a
 * treasury page that rounds them together is lying about a balance.
 */
export function Amount({ wei, struck = false }: { wei: bigint | null | undefined; struck?: boolean }) {
  const a = formatOG(wei)
  if (a.text === '—') return <span className="num dimmer">—</span>

  const inner = (
    <span className="num">
      {a.int}
      <span className="frac">.{a.frac}</span>
    </span>
  )
  return (
    <>
      {struck ? <s>{inner}</s> : inner} <span className="dimmer">0G</span>
    </>
  )
}

/**
 * The gap that is not filled.
 *
 * Used everywhere a check could not be run, a value could not be read, or a source did not
 * answer. It is deliberately ugly — hatched, dashed, unstyled by any verdict colour — because a
 * visible hole is worth more than a plausible default, and because a reader must never have to
 * wonder whether a number on this site was measured or assumed.
 */
export function Gap({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gap" role="status">
      <strong>{title}</strong>
      {children}
    </div>
  )
}

/**
 * The compact rendering of the same measurement the seam makes.
 *
 * Risk plotted against the gate's own ceiling: the ceiling is a rule, everything under it is the
 * verdict colour, everything past it is the one reserved accent. Shown only where the seam has
 * no room — narrow viewports, dense tables — so the enforcement visual survives the collapse
 * instead of being dropped.
 */
export function CeilingBar({ risk, ceiling }: { risk: number | null; ceiling: number | null }) {
  if (risk === null || ceiling === null) return null
  const under = Math.min(risk, ceiling)
  const over = Math.max(0, risk - ceiling)

  return (
    <div
      className="ceilbar"
      role="img"
      aria-label={`Risk ${risk} against a ceiling of ${ceiling}${over > 0 ? `, ${over} over` : `, ${ceiling - risk} under`}.`}
    >
      <div className="track" />
      <div className="fill" style={{ width: `${under}%` }} />
      {over > 0 ? <div className="over" style={{ left: `${ceiling}%`, width: `${over}%` }} /> : null}
      <div className="ceil" style={{ left: `${ceiling}%` }} />
      <div className="ceilcap" style={{ left: `${ceiling}%` }}>
        CEILING {ceiling}
      </div>
    </div>
  )
}

/**
 * Risk as distance from the seam.
 *
 * The ceiling is not a tick on a bar here — it is the centre line itself, so a decision that
 * went over it is drawn further from the middle of the screen. That removes the last bit of
 * interpretation: over the line is over the line, and it reads across a whole page of rows
 * before a single word has been.
 */
export function Measure({ risk, ceiling }: { risk: number | null; ceiling: number | null }) {
  if (risk === null || ceiling === null) return null

  const delta = risk - ceiling
  const span = Math.max(ceiling, 100 - ceiling, 1)
  const reach = Math.max(6, Math.min(92, Math.round((Math.abs(delta) / span) * 100)))
  const past = delta > 0

  // The overshoot is drawn only where there is one. A held decision is not automatically an
  // over-ceiling decision: a model that answers DENY at a risk of 20 against a ceiling of 50 is
  // held with nothing to overshoot, so the reserved accent stays off and the sign on the label
  // does the talking. Who refused is a separate fact, and the row prints it in words.
  return (
    <div className="measure" style={{ ['--reach' as string]: reach }} aria-hidden="true">
      <div className="track" />
      {past ? <div className="over" /> : null}
      <div className="cap" />
      <div className={past ? 'delta past' : 'delta'}>
        {delta > 0 ? '+' : delta < 0 ? '−' : '±'}
        {Math.abs(delta)}
      </div>
    </div>
  )
}
