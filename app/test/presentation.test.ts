import { describe, expect, it } from 'vitest'
import { refusalName, refusedByPhrase } from '@/lib/abi'
import { ago, distanceFromSeam, formatOG, untilParts, untilPhrase } from '@/lib/format'
import { classify } from '@/lib/services'
import type { ServiceRecord } from '@/lib/verify'

describe('amounts are written the way a ledger writes them', () => {
  it('splits at the decimal point so columns can align', () => {
    expect(formatOG(250n * 10n ** 18n)).toEqual({ int: '250', frac: '0000', text: '250.0000' })
    expect(formatOG(1_234_567n * 10n ** 18n).int).toBe('1,234,567')
  })

  it('truncates rather than rounds, because a treasury page must not overstate a balance', () => {
    // 0.99995 0G. Rounded, this page would claim a whole 0G that the treasury does not hold.
    expect(formatOG(999_950_000_000_000_000n).text).toBe('0.9999')
    expect(formatOG(9_999_999_999_999_999_999n).text).toBe('9.9999')
    // And a dust balance reads as dust rather than as nothing.
    expect(formatOG(1n).text).toBe('0.0000')
  })

  it('says nothing rather than zero when there is no amount', () => {
    expect(formatOG(null).text).toBe('—')
    expect(formatOG(undefined).text).toBe('—')
    expect(formatOG(0n).text).toBe('0.0000')
  })
})

describe('risk is measured as distance from the seam', () => {
  it('reports the overshoot with a sign, because the sign is the whole point', () => {
    expect(distanceFromSeam(87, 40).label).toBe('+47')
    expect(distanceFromSeam(7, 40).label).toBe('−33')
    expect(distanceFromSeam(40, 40).label).toBe('±0')
  })

  it('normalises against the widest overshoot the ceiling allows, so rows share one ruler', () => {
    // Ceiling 40: the furthest under is 40, the furthest over is 60, so the span is 60.
    expect(distanceFromSeam(100, 40).fraction).toBeCloseTo(1)
    expect(distanceFromSeam(70, 40).fraction).toBeCloseTo(0.5)
    // Ceiling 90: the span is 90, so the same +30 is drawn shorter.
    expect(distanceFromSeam(100, 90).fraction).toBeLessThan(distanceFromSeam(70, 40).fraction)
  })

  it('draws nothing at all when there is no ceiling to measure against', () => {
    expect(distanceFromSeam(87, null).delta).toBeNull()
    expect(distanceFromSeam(null, 40).delta).toBeNull()
  })
})

describe('who refused is always named', () => {
  it('separates the model declining from the ceiling declining', () => {
    expect(refusalName(1)).toBe('model')
    expect(refusalName(2)).toBe('policy')
    expect(refusedByPhrase(1)).toBe('the model declined')
    expect(refusedByPhrase(2)).toBe('the model agreed, the ceiling did not')
  })

  it('does not invent a reason for a value it does not recognise', () => {
    expect(refusalName(9)).toBe('unknown')
    expect(refusedByPhrase(9)).toMatch(/not recognised/)
  })
})

describe('a provider is usable, or the reason is on the page', () => {
  const base: ServiceRecord = {
    provider: '0xA46EA4FC5889AD35A1487e1Ed04dCcfa872146B9',
    serviceType: 'chatbot',
    url: 'https://example/v1',
    updatedAt: 0,
    model: 'glm-5.2',
    verifiability: 'TeeML',
    teeSignerAddress: '0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D',
    teeSignerAcknowledged: true,
  }

  it('accepts an acknowledged TeeML service', () => {
    expect(classify(base).usable).toBe(true)
    expect(classify(base).blockedReason).toBe('')
  })

  it('explains a "standard" service in terms of what is missing, not as an error', () => {
    // This is the claude-opus-5 case on live mainnet: hosted by 0G, not executed in an enclave.
    const blocked = classify({ ...base, model: 'claude-opus-5', verifiability: 'standard' })
    expect(blocked.usable).toBe(false)
    expect(blocked.blockedReason).toMatch(/hosted, not executed inside an enclave/)
  })

  it('explains an unacknowledged signer', () => {
    const blocked = classify({ ...base, teeSignerAcknowledged: false })
    expect(blocked.usable).toBe(false)
    expect(blocked.blockedReason).toMatch(/has not acknowledged its TEE signer/)
  })

  it('explains a zero signer address, which no signature can recover to', () => {
    const blocked = classify({ ...base, teeSignerAddress: '0x' + '00'.repeat(20) })
    expect(blocked.usable).toBe(false)
    expect(blocked.blockedReason).toMatch(/zero address/)
  })
})

describe('time is either measured or admitted', () => {
  it('shortens an age without lying about it', () => {
    const now = 1_800_000_000_000
    expect(ago(1_800_000_000 - 12, now)).toBe('12s')
    expect(ago(1_800_000_000 - 100 * 60, now)).toBe('1h')
    expect(ago(1_800_000_000 - 3 * 86_400, now)).toBe('3d')
  })

  it('shows an em dash rather than "just now" when no timestamp was fetched', () => {
    expect(ago(null)).toBe('—')
  })

  it('counts a timelock down and stops at zero', () => {
    const now = 1_800_000_000
    expect(untilPhrase(now + 30 * 86_400 + 3600, now)).toBe('30d 1h')
    expect(untilPhrase(now - 1, now)).toBe('available now')

    const parts = untilParts(now + 2 * 86_400 + 3 * 3600 + 240, now)
    expect(parts).toMatchObject({ days: 2, hours: 3, minutes: 4, elapsed: false })
    expect(untilParts(now - 5, now).elapsed).toBe(true)
  })
})
