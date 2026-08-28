import { describe, expect, it } from 'vitest'
import { refusalCause, rulerReading } from '@/lib/ruling'

/**
 * The ceiling ruler used to read the outcome off the geometry: score past the ceiling meant
 * "over the ceiling → held", score under it meant "under the ceiling → released". Both are
 * claims about *cause*, and the chain does not support either one on its own.
 *
 * `TransferRefused` carries `refusedBy`, and the two refusals mean different things:
 *
 *   Refusal.Model  — the model answered DENY. The ceiling never had an ALLOW to overrule, so it
 *                    is not why the funds stayed, whatever the score happens to be.
 *   Refusal.Policy — the model answered ALLOW above the ceiling, and the ceiling overruled it.
 *                    This, and only this, is the sentence the old copy was written for.
 *
 * The live case that made the old copy wrong is writ 0xf200…d31a on 0G mainnet: gate
 * 0x2688059e106195941F320110bE2d5fe9a1c75fEE, risk 95, ceiling 50, refusedBy = 1 = Model. The
 * score really is 45 over the ceiling, and the ceiling really is not why 1.9 0G stayed put.
 */

const MODEL = 1
const POLICY = 2
const NONE = 0

describe('who refused, read off the record rather than off the chart', () => {
  it('names the model when the gate recorded refusedBy = Model', () => {
    expect(refusalCause(true, MODEL)).toBe('model')
  })

  it('names the ceiling when the gate recorded refusedBy = Policy', () => {
    expect(refusalCause(true, POLICY)).toBe('policy')
  })

  it('reads an approval as released, whoever asks', () => {
    expect(refusalCause(false, NONE)).toBe('released')
    expect(refusalCause(false, null)).toBe('released')
  })

  it('refuses to guess when no gate event carries a reason', () => {
    expect(refusalCause(true, null)).toBe('unknown')
    expect(refusalCause(null, null)).toBe('unknown')
  })

  it('refuses to guess at an enum value this app does not know', () => {
    // A later contract could add a third refuser. Inventing one of the two we know would be
    // exactly the error this fix exists to remove.
    expect(refusalCause(true, 7)).toBe('unknown')
  })

  it('trusts neither half of a contradiction', () => {
    // Held, but the gate says nobody refused. One of the two facts is wrong and this page
    // cannot tell which, so it names no cause.
    expect(refusalCause(true, NONE)).toBe('unknown')
  })
})

describe('the ruler measures the score and reports the cause separately', () => {
  it('plots the live mainnet refusal without crediting the ceiling for it', () => {
    const r = rulerReading({ risk: 95, ceiling: 50, held: true, refusedBy: MODEL })

    // The geometry is unchanged: the score really is 45 past the line.
    expect(r.cause).toBe('model')
    expect(r.delta).toBe(45)
    expect(r.past).toBe(true)
    expect(r.label).toBe('RISK 95 · +45 OVER')

    // The cause is not.
    expect(r.end).toBe('the model declined → held')
    expect(r.end).not.toMatch(/over the ceiling/)
    expect(r.note).toMatch(/refusedBy = Model/)
    expect(r.note).toMatch(/no ALLOW to overrule/)
  })

  it('says the ceiling was never reached when the model declined under it', () => {
    const r = rulerReading({ risk: 20, ceiling: 50, held: true, refusedBy: MODEL })

    // No overshoot, so the one reserved warm accent — which keys off `past` and nothing else —
    // must stay off the page. A held row is not, by itself, an over-ceiling row.
    expect(r.past).toBe(false)
    expect(r.delta).toBe(-30)
    expect(r.label).toBe('RISK 20 · 30 UNDER')

    // And the ruler must not read this as a release just because the score is low.
    expect(r.end).toBe('the model declined → held')
    expect(r.end).not.toMatch(/released/)
    expect(r.note).toMatch(/never reached/)
    expect(r.note).toMatch(/nothing to overrule/)
  })

  it('keeps the ceiling sentence for the refusal the ceiling actually made', () => {
    const r = rulerReading({ risk: 95, ceiling: 50, held: true, refusedBy: POLICY })
    expect(r.cause).toBe('policy')
    expect(r.past).toBe(true)
    expect(r.end).toBe('over the ceiling → held')
    // The seam already says this in full; the ruler does not need a second sentence for it.
    expect(r.note).toBe('')
  })

  it('leaves an approval exactly as it read before', () => {
    const r = rulerReading({ risk: 15, ceiling: 50, held: false, refusedBy: NONE })
    expect(r.cause).toBe('released')
    expect(r.past).toBe(false)
    expect(r.label).toBe('RISK 15 · 35 UNDER')
    expect(r.end).toBe('under the ceiling → released')
    expect(r.note).toBe('')
  })

  it('says the score and admits the cause when the cause is not on the record', () => {
    const r = rulerReading({ risk: 95, ceiling: 50, held: true, refusedBy: null })
    expect(r.cause).toBe('unknown')
    expect(r.label).toBe('RISK 95 · +45 OVER')
    expect(r.end).not.toMatch(/over the ceiling/)
    expect(r.end).not.toMatch(/the model/)
    expect(r.note).toMatch(/95/)
    expect(r.note).toMatch(/50/)
    expect(r.note).toMatch(/does not say which/)
  })

  it('never lets any wording but the ceiling’s own refusal blame the ceiling', () => {
    const cases = [
      { risk: 95, ceiling: 50, held: true, refusedBy: MODEL },
      { risk: 20, ceiling: 50, held: true, refusedBy: MODEL },
      { risk: 95, ceiling: 50, held: true, refusedBy: null },
      { risk: 95, ceiling: 50, held: true, refusedBy: 7 },
    ]
    for (const c of cases) {
      const r = rulerReading(c)
      expect(`${r.end} ${r.note}`).not.toMatch(/the ceiling (held|stopped|refused|overruled)/i)
    }
  })

  it('draws a score sitting exactly on the ceiling as not past it', () => {
    // Refusal.Policy needs `risk > maxRisk`, strictly, so the line itself is still allowed.
    const r = rulerReading({ risk: 50, ceiling: 50, held: false, refusedBy: NONE })
    expect(r.past).toBe(false)
    expect(r.delta).toBe(0)
  })
})
