/**
 * The third thing a provider has to be, and the only one you cannot read off the chain.
 *
 * A provider can advertise `TeeML`, acknowledge a TEE signer, and still be unable to support
 * on-chain request binding. 0G's broker accepts a portable OpenAI-schema request and rewrites
 * certain fields into the schema the target model actually understands before forwarding —
 * `max_tokens` ↔ `max_completion_tokens`, `reasoning_effort` into one of five upstream dialects,
 * and the `model` field to the upstream id (`0gfoundation/0g-serving-broker`,
 * `docs/design/request-translation.md`). It then signs the translated body. Where that happens
 * the enclave signed a hash of bytes no contract can rebuild, so a gate pinned to that provider
 * can never settle, and Writ's prompt-swap defence has nothing to stand on.
 *
 * Where it does not happen — the same document: "if it advertises nothing translatable, the body
 * passes through untouched" — everything works. Which case a provider is in is a property to
 * measure, and this module is the app's half of the measuring.
 *
 * Response binding is unaffected in both cases, which is why the verdicts name the halves rather
 * than passing or failing the provider.
 */

export type PassthroughStatus = 'passthrough' | 'response-only' | 'unusable'

export type PassthroughRecord = {
  provider: string
  model: string
  /** ISO 8601. A measurement without a date is a rumour. */
  measuredAt: string
  status: PassthroughStatus
  detail: string
  /**
   * Where this came from. `mainnet-record` shipped with the app and was taken by hand on 0G
   * mainnet; `imported` was pasted in by whoever is reading the page. The page always says which,
   * because "measured" and "measured by us, once, in August" are different claims.
   */
  origin: 'mainnet-record' | 'imported'
}

/**
 * The live 0G mainnet run of 2026-08-27, verbatim.
 *
 * Four acknowledged TeeML providers, one minimal body each — no `max_tokens`, no
 * `reasoning_effort`, nothing the broker is documented to translate. Two forwarded it untouched
 * and two did not. The response half matched on all four.
 *
 * This is a dated record of what was true that day, not a standing guarantee. A provider can
 * change the model it fronts, and the record does not follow it.
 */
export const MAINNET_MEASUREMENTS: readonly PassthroughRecord[] = [
  {
    provider: '0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D',
    model: 'glm-5.2',
    measuredAt: '2026-08-27T00:00:00.000Z',
    status: 'passthrough',
    detail:
      'The enclave signed the exact bytes that were sent and the exact bytes that came back. A contract that rebuilds this body computes the same hash the enclave signed.',
    origin: 'mainnet-record',
  },
  {
    provider: '0x25F8f01cA76060ea40895472b1b79f76613Ca497',
    model: 'openai/gpt-5.4-mini',
    measuredAt: '2026-08-27T00:00:00.000Z',
    status: 'passthrough',
    detail:
      'The enclave signed the exact bytes that were sent and the exact bytes that came back. A contract that rebuilds this body computes the same hash the enclave signed.',
    origin: 'mainnet-record',
  },
  {
    provider: '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9',
    model: '0GM-1.0-35B-A3B',
    measuredAt: '2026-08-27T00:00:00.000Z',
    status: 'response-only',
    detail:
      'The response half matched byte for byte; the request half did not. The broker rewrote the body before forwarding it — the answer even reports the model as 0GM-1.0-35B-A3B-0427 — and signed what it forwarded.',
    origin: 'mainnet-record',
  },
  {
    provider: '0xf56fAaf9989aDafDDf26fa5Ffdd03a9A27b38fAE',
    model: '0GM-1.0-35B-A3B-SIA',
    measuredAt: '2026-08-27T00:00:00.000Z',
    status: 'response-only',
    detail:
      'The response half matched byte for byte; the request half did not. The broker rewrote the body before forwarding it and signed what it forwarded.',
    origin: 'mainnet-record',
  },
]

const STATUSES: readonly PassthroughStatus[] = ['passthrough', 'response-only', 'unusable']
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const STORAGE_KEY = 'writ.passthrough.v1'

/**
 * What is known about a provider's request binding, newest measurement first.
 *
 * Returns `null` rather than a default when nobody has measured it. An unmeasured provider is not
 * a passing one and is not a failing one, and the whole point of this feature is that the
 * difference is visible.
 */
export function compatibilityOf(
  provider: string,
  imported: readonly PassthroughRecord[],
): PassthroughRecord | null {
  const key = provider.toLowerCase()
  const mine = imported
    .filter((r) => r.provider.toLowerCase() === key)
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  if (mine[0]) return mine[0]
  return MAINNET_MEASUREMENTS.find((r) => r.provider.toLowerCase() === key) ?? null
}

export type ParseResult =
  | { ok: true; record: PassthroughRecord }
  | { ok: false; reason: string }

/**
 * The CLI's `--json` output, checked rather than trusted.
 *
 * Every field the page will show has to be present and the right shape, because a half-parsed
 * measurement rendered next to a provider is exactly the kind of confident wrong answer this
 * whole product exists to make impossible.
 */
export function parseMeasurement(text: string): ParseResult {
  if (text.trim().length === 0) {
    return { ok: false, reason: 'Nothing was pasted.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      reason: 'That is not JSON. Run the check with --json and paste the whole object it prints.',
    }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'That JSON is not an object, so it is not a measurement.' }
  }

  const r = parsed as Record<string, unknown>
  const provider = typeof r['provider'] === 'string' ? r['provider'] : ''
  if (!ADDRESS.test(provider)) {
    return { ok: false, reason: `The measurement names ${JSON.stringify(r['provider'])} as its provider, which is not an address.` }
  }

  const status = r['status']
  if (typeof status !== 'string' || !STATUSES.includes(status as PassthroughStatus)) {
    return { ok: false, reason: `${JSON.stringify(status)} is not a verdict this page knows.` }
  }

  const measuredAt = typeof r['measuredAt'] === 'string' ? r['measuredAt'] : ''
  if (!measuredAt || Number.isNaN(Date.parse(measuredAt))) {
    return { ok: false, reason: 'The measurement carries no readable date, and an undated one is not worth keeping.' }
  }

  return {
    ok: true,
    record: {
      provider,
      model: typeof r['model'] === 'string' ? r['model'] : '',
      measuredAt,
      status: status as PassthroughStatus,
      detail: typeof r['detail'] === 'string' ? r['detail'] : '',
      origin: 'imported',
    },
  }
}

/**
 * How each state is named on the page.
 *
 * Nothing here says broken, failed, invalid or unsupported. A provider that translates is not
 * malfunctioning — it is doing what 0G's broker documents, and the only thing that follows is
 * which half a contract can bind. That vocabulary belongs to the proof channel on a writ page,
 * and this is not that.
 */
export function measurementSummary(status: PassthroughStatus | null): { label: string; note: string } {
  switch (status) {
    case 'passthrough':
      return {
        label: 'binds request + response',
        note: 'The broker forwarded the body unmodified, so a gate can pin the question as well as the answer.',
      }
    case 'response-only':
      return {
        label: 'binds response only',
        note: 'The broker rewrites this body before forwarding it and signs what it forwarded, so a gate pinned to this provider would never settle.',
      }
    case 'unusable':
      return {
        label: 'could not be measured',
        note: 'The check did not complete, so neither half is known. Nothing has been assumed in its place.',
      }
    default:
      return {
        label: 'request binding not measured',
        note: 'Nobody has checked whether this provider forwards a request body unmodified. Running the check costs one billed request, which is why this page does not run it for you.',
      }
  }
}

/** Measurements pasted into this browser. Local to it, and never sent anywhere. */
export function loadImported(): PassthroughRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => parseMeasurement(JSON.stringify(entry)))
      .flatMap((r) => (r.ok ? [r.record] : []))
  } catch {
    return []
  }
}

export function saveImported(records: readonly PassthroughRecord[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch {
    // A browser with storage disabled still gets the measurement for this session; it simply
    // will not have it next time. Nothing is worth throwing over here.
  }
}

/** `2026-08-27`, in the reader's locale-independent form. */
export function measuredOn(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10)
}
