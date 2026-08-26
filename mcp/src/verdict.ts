/**
 * Off-chain mirror of `VerdictLib.parseVerdict`.
 *
 * Byte-for-byte the same scan the gate runs: find the first `"content":"` marker, read to the
 * closing quote under a hard 32-byte cap, then require exactly `ALLOW:<0-100>` or
 * `DENY:<0-100>`. Deliberately not a JSON parser, for the same reason the contract is not one —
 * the answer this reads must be the answer the chain reads, and a lenient parser here would
 * predict an outcome the gate then refuses to reach.
 *
 * It reports rather than throws, so `writ_attest` can say "the model's answer does not parse"
 * instead of pretending the run failed. The attestation is real either way; what it cannot do
 * is settle.
 */

const MAX_CONTENT_LEN = 32
const MARKER = '"content":"'

export type VerdictParse =
  | { ok: true; allowed: boolean; risk: number; content: string }
  | { ok: false; reason: 'MarkerNotFound' | 'VerdictTooLong' | 'VerdictMalformed' }

const DENY = new TextEncoder().encode('DENY:')
const ALLOW = new TextEncoder().encode('ALLOW:')
const MARKER_BYTES = new TextEncoder().encode(MARKER)
const QUOTE = 0x22

function startsWith(body: Uint8Array, at: number, needle: Uint8Array): boolean {
  if (at + needle.length > body.length) return false
  for (let i = 0; i < needle.length; i++) {
    if (body[at + i] !== needle[i]) return false
  }
  return true
}

/** Index just past the first `"content":"`, or -1. */
function contentStart(body: Uint8Array): number {
  const limit = body.length - MARKER_BYTES.length
  for (let i = 0; i <= limit; i++) {
    if (startsWith(body, i, MARKER_BYTES)) return i + MARKER_BYTES.length
  }
  return -1
}

export function parseVerdict(body: Uint8Array): VerdictParse {
  const start = contentStart(body)
  if (start < 0) return { ok: false, reason: 'MarkerNotFound' }

  let end = start
  while (end < body.length && body[end] !== QUOTE) {
    if (end - start >= MAX_CONTENT_LEN) return { ok: false, reason: 'VerdictTooLong' }
    end++
  }
  if (end >= body.length) return { ok: false, reason: 'VerdictMalformed' }

  const len = end - start
  let allowed: boolean
  let digitsAt: number
  if (len > 6 && startsWith(body, start, ALLOW)) {
    allowed = true
    digitsAt = start + ALLOW.length
  } else if (len > 5 && startsWith(body, start, DENY)) {
    allowed = false
    digitsAt = start + DENY.length
  } else {
    return { ok: false, reason: 'VerdictMalformed' }
  }

  let value = 0
  let digits = 0
  for (let i = digitsAt; i < end; i++) {
    const c = body[i]!
    if (c < 0x30 || c > 0x39) return { ok: false, reason: 'VerdictMalformed' }
    value = value * 10 + (c - 0x30)
    digits++
  }
  if (digits === 0 || digits > 3 || value > 100) return { ok: false, reason: 'VerdictMalformed' }

  return {
    ok: true,
    allowed,
    risk: value,
    content: new TextDecoder().decode(body.subarray(start, end)),
  }
}

/** What the gate would do with this answer, given a policy's risk ceiling. */
export type ExpectedOutcome = 'approve' | 'refuse-model' | 'refuse-policy' | 'revert-malformed'

export function expectedOutcome(parse: VerdictParse, maxRisk: number): ExpectedOutcome {
  if (!parse.ok) return 'revert-malformed'
  if (!parse.allowed) return 'refuse-model'
  return parse.risk > maxRisk ? 'refuse-policy' : 'approve'
}
