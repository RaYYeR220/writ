import { describe, expect, it } from 'vitest'
import { expectedOutcome, parseVerdict } from '../src/verdict.js'

const enc = new TextEncoder()

/** A chat-completions body with the given assistant content, as the provider sends it. */
function body(content: string): Uint8Array {
  return enc.encode(
    `{"id":"chat-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"${content}"},"finish_reason":"stop"}]}`,
  )
}

describe('parseVerdict mirrors VerdictLib', () => {
  it('reads ALLOW with its risk', () => {
    expect(parseVerdict(body('ALLOW:12'))).toEqual({ ok: true, allowed: true, risk: 12, content: 'ALLOW:12' })
  })

  it('reads DENY with its risk', () => {
    expect(parseVerdict(body('DENY:97'))).toEqual({ ok: true, allowed: false, risk: 97, content: 'DENY:97' })
  })

  it('accepts the boundary values', () => {
    expect(parseVerdict(body('ALLOW:0'))).toMatchObject({ ok: true, risk: 0 })
    expect(parseVerdict(body('ALLOW:100'))).toMatchObject({ ok: true, risk: 100 })
    expect(parseVerdict(body('DENY:000'))).toMatchObject({ ok: true, risk: 0 })
  })

  it('rejects a risk above 100', () => {
    expect(parseVerdict(body('ALLOW:101'))).toEqual({ ok: false, reason: 'VerdictMalformed' })
  })

  it('rejects more than three digits', () => {
    expect(parseVerdict(body('ALLOW:0012'))).toEqual({ ok: false, reason: 'VerdictMalformed' })
  })

  it('rejects a missing risk', () => {
    expect(parseVerdict(body('ALLOW:'))).toEqual({ ok: false, reason: 'VerdictMalformed' })
    expect(parseVerdict(body('DENY:'))).toEqual({ ok: false, reason: 'VerdictMalformed' })
  })

  it('rejects a non-numeric risk', () => {
    expect(parseVerdict(body('ALLOW:low'))).toEqual({ ok: false, reason: 'VerdictMalformed' })
  })

  it('rejects prose', () => {
    expect(parseVerdict(body('I think this is fine'))).toEqual({ ok: false, reason: 'VerdictMalformed' })
  })

  it('rejects a lowercase verdict', () => {
    expect(parseVerdict(body('allow:12'))).toEqual({ ok: false, reason: 'VerdictMalformed' })
  })

  it('reports a body with no content marker', () => {
    expect(parseVerdict(enc.encode('{"error":"rate limited"}'))).toEqual({ ok: false, reason: 'MarkerNotFound' })
  })

  it('reports a body shorter than the marker', () => {
    expect(parseVerdict(enc.encode('{}'))).toEqual({ ok: false, reason: 'MarkerNotFound' })
  })

  it('caps the content it will scan at 32 bytes', () => {
    expect(parseVerdict(body('A'.repeat(40)))).toEqual({ ok: false, reason: 'VerdictTooLong' })
  })

  it('accepts content exactly at the cap', () => {
    // "ALLOW:" plus 26 digits is 32 bytes, so the scan reaches the closing quote — and then
    // the digit-count rule rejects it. Being rejected by the right rule matters.
    expect(parseVerdict(body('ALLOW:' + '1'.repeat(26)))).toEqual({ ok: false, reason: 'VerdictMalformed' })
  })

  it('reports an unterminated content string', () => {
    expect(parseVerdict(enc.encode('{"content":"ALLOW:12'))).toEqual({ ok: false, reason: 'VerdictMalformed' })
  })

  it('takes the first content marker, as the contract does', () => {
    const twoMarkers = enc.encode('{"content":"DENY:80","choices":[{"message":{"content":"ALLOW:1"}}]}')
    expect(parseVerdict(twoMarkers)).toMatchObject({ ok: true, allowed: false, risk: 80 })
  })
})

describe('expectedOutcome', () => {
  it('approves an allow within the ceiling', () => {
    expect(expectedOutcome(parseVerdict(body('ALLOW:12')), 40)).toBe('approve')
  })

  it('approves an allow exactly at the ceiling', () => {
    expect(expectedOutcome(parseVerdict(body('ALLOW:40')), 40)).toBe('approve')
  })

  it('refuses by policy one above the ceiling', () => {
    expect(expectedOutcome(parseVerdict(body('ALLOW:41')), 40)).toBe('refuse-policy')
  })

  it('refuses by the model on a DENY, whatever the ceiling', () => {
    expect(expectedOutcome(parseVerdict(body('DENY:1')), 100)).toBe('refuse-model')
  })

  it('predicts a revert on an answer the gate cannot parse', () => {
    expect(expectedOutcome(parseVerdict(body('probably fine')), 40)).toBe('revert-malformed')
  })
})
