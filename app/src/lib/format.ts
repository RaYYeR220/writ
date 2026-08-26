/**
 * Numbers, the way a ledger writes them.
 *
 * Amounts come back split into an integer part and a fraction so the columns can align on the
 * decimal point. That is not decoration — it is the whole reason a double-entry page is
 * readable at a glance, and it is what lets held and released be compared down a page rather
 * than hunted for.
 */

const DECIMALS = 4

export type Amount = { int: string; frac: string; text: string }

export function formatOG(wei: bigint | null | undefined): Amount {
  if (wei === null || wei === undefined) return { int: '—', frac: '', text: '—' }

  const negative = wei < 0n
  const abs = negative ? -wei : wei
  const whole = abs / 10n ** 18n
  const remainder = abs % 10n ** 18n

  // Truncate rather than round: a treasury page that rounds 0.99995 up to 1.0000 has told you
  // the treasury holds more than it does.
  const fracDigits = (remainder / 10n ** BigInt(18 - DECIMALS)).toString().padStart(DECIMALS, '0')
  const int = (negative ? '-' : '') + groupThousands(whole.toString())
  return { int, frac: fracDigits, text: `${int}.${fracDigits}` }
}

export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatCount(n: number | bigint): string {
  return groupThousands(n.toString())
}

/** Relative age, in the shortest form that is still true. */
export function ago(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return '—'
  const seconds = Math.max(0, Math.floor(now / 1000) - timestamp)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 60) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}

export function utc(timestamp: number | null): string {
  if (timestamp === null) return 'time not fetched'
  return new Date(timestamp * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

/** A countdown to a timelock, phrased as the wait it actually is. */
export function untilPhrase(target: number, now = Math.floor(Date.now() / 1000)): string {
  const seconds = target - now
  if (seconds <= 0) return 'available now'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${seconds % 60}s`
}

export function untilParts(target: number, now = Math.floor(Date.now() / 1000)): {
  days: number
  hours: number
  minutes: number
  seconds: number
  elapsed: boolean
} {
  const remaining = Math.max(0, target - now)
  return {
    days: Math.floor(remaining / 86_400),
    hours: Math.floor((remaining % 86_400) / 3600),
    minutes: Math.floor((remaining % 3600) / 60),
    seconds: remaining % 60,
    elapsed: target - now <= 0,
  }
}

/**
 * Where a decision sits relative to the seam.
 *
 * The seam is the gate's own ceiling, so a risk of 87 against a ceiling of 40 is `+47` and sits
 * 47 units to the held side. `fraction` is how far out along its half to draw it, normalised
 * against the widest overshoot a policy can produce so that two rows on the same page are
 * measuring with the same ruler.
 */
export function distanceFromSeam(risk: number | null, ceiling: number | null): {
  delta: number | null
  label: string
  fraction: number
} {
  if (risk === null || ceiling === null) return { delta: null, label: '', fraction: 0 }
  const delta = risk - ceiling
  const span = Math.max(ceiling, 100 - ceiling, 1)
  return {
    delta,
    label: `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta)}`,
    fraction: Math.min(1, Math.abs(delta) / span),
  }
}
