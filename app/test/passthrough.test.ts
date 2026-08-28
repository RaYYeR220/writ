import { describe, expect, it } from 'vitest'
import {
  MAINNET_MEASUREMENTS,
  compatibilityOf,
  measurementSummary,
  parseMeasurement,
  type PassthroughRecord,
} from '@/lib/passthrough'

const PASSING = '0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D'
const TRANSLATING = '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9'
const UNKNOWN = '0x0000000000000000000000000000000000000123'

function cliJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    provider: PASSING,
    model: 'glm-5.2',
    measuredAt: '2026-08-28T09:00:00.000Z',
    status: 'passthrough',
    detail: 'The enclave signed the exact bytes that were sent.',
    evidence: { requestMatches: true, responseMatches: true },
    ...over,
  })
}

describe('the shipped mainnet record', () => {
  it('carries the four providers that were actually measured, with the date', () => {
    expect(MAINNET_MEASUREMENTS).toHaveLength(4)
    for (const m of MAINNET_MEASUREMENTS) {
      expect(m.origin).toBe('mainnet-record')
      expect(Number.isNaN(Date.parse(m.measuredAt))).toBe(false)
    }
    expect(MAINNET_MEASUREMENTS.filter((m) => m.status === 'passthrough')).toHaveLength(2)
    expect(MAINNET_MEASUREMENTS.filter((m) => m.status === 'response-only')).toHaveLength(2)
  })
})

describe('compatibilityOf', () => {
  it('finds a shipped measurement whatever case the address is written in', () => {
    expect(compatibilityOf(PASSING.toLowerCase(), [])?.status).toBe('passthrough')
    expect(compatibilityOf(TRANSLATING, [])?.status).toBe('response-only')
  })

  it('reports nothing at all for a provider nobody has measured', () => {
    // Not "assumed fine". A provider that has never been checked is a provider that has never
    // been checked, and the page has to say so.
    expect(compatibilityOf(UNKNOWN, [])).toBeNull()
  })

  it('prefers a measurement taken in this browser over the shipped one', () => {
    const mine: PassthroughRecord = {
      provider: PASSING,
      model: 'glm-5.2',
      measuredAt: '2026-09-01T00:00:00.000Z',
      status: 'response-only',
      detail: 'measured later, and it changed',
      origin: 'imported',
    }
    const found = compatibilityOf(PASSING, [mine])
    expect(found?.status).toBe('response-only')
    expect(found?.origin).toBe('imported')
  })

  it('keeps the newer of two imported measurements', () => {
    const older: PassthroughRecord = {
      provider: PASSING,
      model: 'glm-5.2',
      measuredAt: '2026-08-01T00:00:00.000Z',
      status: 'response-only',
      detail: 'older',
      origin: 'imported',
    }
    const newer: PassthroughRecord = { ...older, measuredAt: '2026-09-01T00:00:00.000Z', detail: 'newer' }
    expect(compatibilityOf(PASSING, [older, newer])?.detail).toBe('newer')
    expect(compatibilityOf(PASSING, [newer, older])?.detail).toBe('newer')
  })
})

describe('parseMeasurement', () => {
  it('accepts the CLI’s --json output', () => {
    const result = parseMeasurement(cliJson())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record).toMatchObject({
      provider: PASSING,
      model: 'glm-5.2',
      status: 'passthrough',
      origin: 'imported',
    })
  })

  it('accepts an unusable verdict — a failed check is a result worth keeping', () => {
    const result = parseMeasurement(cliJson({ status: 'unusable', evidence: undefined }))
    expect(result.ok).toBe(true)
  })

  it('refuses anything that is not JSON', () => {
    const result = parseMeasurement('passthrough, trust me')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('JSON')
  })

  it('refuses a verdict this app does not know', () => {
    const result = parseMeasurement(cliJson({ status: 'fine' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('fine')
  })

  it('refuses a measurement with no provider address', () => {
    const result = parseMeasurement(cliJson({ provider: 'the good one' }))
    expect(result.ok).toBe(false)
  })

  it('refuses a measurement with no usable date', () => {
    const result = parseMeasurement(cliJson({ measuredAt: 'recently' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('date')
  })

  it('refuses an empty paste without pretending it was a parse failure', () => {
    const result = parseMeasurement('   ')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Nothing')
  })
})

describe('measurementSummary', () => {
  it('says which half binds, in the provider’s own terms', () => {
    expect(measurementSummary('passthrough').label).toBe('binds request + response')
    expect(measurementSummary('response-only').label).toBe('binds response only')
    expect(measurementSummary('unusable').label).toBe('could not be measured')
    expect(measurementSummary(null).label).toBe('request binding not measured')
  })

  it('never describes any of them as broken', () => {
    for (const s of ['passthrough', 'response-only', 'unusable', null] as const) {
      const { label, note } = measurementSummary(s)
      expect(`${label} ${note}`.toLowerCase()).not.toContain('broken')
      expect(`${label} ${note}`.toLowerCase()).not.toContain('fail')
    }
  })
})
