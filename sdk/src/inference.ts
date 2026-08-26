import { sha256Hex } from './hashes.js'

/** A single non-streaming inference, captured at the byte level. */
export type AttestedRun = {
  /** The provider's chat id, needed to claim the TEE signature before it expires. */
  chatId: string
  /** The exact bytes posted to the provider. */
  rawRequest: Uint8Array
  /** The exact bytes the provider returned. */
  rawResponse: Uint8Array
  /** `0x`-prefixed sha256 of `rawRequest`. */
  reqHash: string
  /** `0x`-prefixed sha256 of `rawResponse`. */
  respHash: string
}

/**
 * The slice of the 0G Compute broker `runAttested` needs.
 *
 * Declared structurally so the pipeline can be exercised without a funded ledger. The real
 * `broker.inference` satisfies it.
 */
export type InferenceBrokerLike = {
  inference: {
    getRequestHeaders(providerAddress: string): Promise<unknown>
  }
}

export type RunAttestedOptions = {
  broker: InferenceBrokerLike
  provider: string
  /** `broker.inference.getServiceMetadata(provider).endpoint`, i.e. `<serviceUrl>/v1/proxy`. */
  endpoint: string
  /** The exact request body, normally straight out of `gate.previewRequestBody(...)`. */
  bodyBytes: Uint8Array
  /** Abort the request after this many milliseconds. Default 120s. */
  timeoutMs?: number
}

/** `getRequestHeaders` is typed as an interface in the SDK; narrow it to a header bag we can send. */
function toHeaderBag(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('broker.inference.getRequestHeaders did not return headers')
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  if (!out['Authorization']) {
    throw new Error(
      'broker.inference.getRequestHeaders returned no Authorization header — the provider signer is probably not acknowledged, or the ledger is unfunded',
    )
  }
  return out
}

/**
 * Rejects a streaming request up front.
 *
 * A stream has no single response body, so there is nothing for the TEE to have signed and
 * nothing for `sha256` to bind on chain. Better to refuse than to produce an unprovable run.
 */
function assertNotStreaming(bodyBytes: Uint8Array): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyBytes))
  } catch {
    return // not JSON; nothing to check, and the provider will judge it
  }
  if (parsed !== null && typeof parsed === 'object' && (parsed as { stream?: unknown }).stream === true) {
    throw new Error('refusing to run a streaming request: a streamed response has no signable body')
  }
}

/**
 * Posts the exact bytes the contract produced and captures the exact bytes that come back.
 *
 * Never parse-then-rehash: the TEE signs the wire bytes, so any re-serialization — even a
 * round-trip through `JSON.parse`/`JSON.stringify` that changes nothing semantically — breaks
 * the proof. That is why the response is read with `text()` and hashed as-is.
 */
export async function runAttested(opts: RunAttestedOptions): Promise<AttestedRun> {
  const { broker, provider, endpoint, bodyBytes, timeoutMs = 120_000 } = opts

  if (bodyBytes.length === 0) throw new Error('refusing to run an empty request body')
  assertNotStreaming(bodyBytes)

  // Auth headers carry billing identity only; they do not bind the body.
  const headers = toHeaderBag(await broker.inference.getRequestHeaders(provider))

  const base = endpoint.replace(/\/+$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: bodyBytes,
    signal: AbortSignal.timeout(timeoutMs),
  })

  const rawText = await res.text()
  if (!res.ok) throw new Error(`inference failed (${res.status} ${res.statusText}): ${rawText}`)

  const rawResponse = new TextEncoder().encode(rawText)
  const chatId = res.headers.get('ZG-Res-Key') ?? bodyChatId(rawText)
  if (!chatId) {
    throw new Error('no chat id in the ZG-Res-Key header or the response body; the proof cannot be claimed')
  }

  return {
    chatId,
    rawRequest: bodyBytes,
    rawResponse,
    reqHash: '0x' + sha256Hex(bodyBytes),
    respHash: '0x' + sha256Hex(rawResponse),
  }
}

function bodyChatId(rawText: string): string | null {
  try {
    const id = (JSON.parse(rawText) as { id?: unknown }).id
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}
