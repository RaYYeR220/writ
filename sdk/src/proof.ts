/** What the provider's signature endpoint hands back. */
export type TeeProof = {
  /** The text the TEE signed: `sha256hex(request):sha256hex(response)`. */
  text: string
  /** The secp256k1 signature over the EIP-191 hash of `text`. */
  signature: string
  /**
   * The address the provider claims signed. Advisory only — it is absent from the signature
   * endpoint's payload in practice, and a provider naming its own signer proves nothing. The
   * authority is `InferenceServing.getService(provider).teeSignerAddress`.
   */
  signingAddress?: string
}

/**
 * Builds the provider's signature URL.
 *
 * `broker.inference.getServiceMetadata()` already returns `<serviceUrl>/v1/proxy`, while the
 * registry's `service.url` is the bare host. Both are accepted so a caller cannot silently end
 * up requesting `/v1/proxy/v1/proxy/...`.
 */
export function signatureUrl(endpoint: string, chatId: string, model: string): string {
  const base = endpoint.replace(/\/+$/, '')
  const proxy = base.endsWith('/v1/proxy') ? base : `${base}/v1/proxy`
  return `${proxy}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}`
}

/**
 * Fetches the TEE signature for a chat. Public and unauthenticated.
 *
 * Call this IMMEDIATELY after inference: providers cache signatures with a TTL and answer
 * expired ids with `chat_id_not_found`. A missed proof cannot be recovered — there is no
 * fallback, and this function will never invent one.
 */
export async function fetchProof(
  endpoint: string,
  chatId: string,
  model: string,
  timeoutMs = 30_000,
): Promise<TeeProof> {
  const url = signatureUrl(endpoint, chatId, model)
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`proof unavailable (${res.status} ${res.statusText}): ${body}`)

  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error(`proof response was not JSON: ${body.slice(0, 200)}`)
  }

  const { text, signature, signing_address: signingAddress } = (data ?? {}) as Record<string, unknown>
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`proof response carried no signed text: ${body.slice(0, 200)}`)
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    throw new Error(`proof response carried no signature: ${body.slice(0, 200)}`)
  }

  return {
    text,
    signature,
    signingAddress: typeof signingAddress === 'string' ? signingAddress : undefined,
  }
}
