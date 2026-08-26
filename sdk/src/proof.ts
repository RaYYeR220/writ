import type { RoutingFields } from './hashes.js'

/** What the provider's signature endpoint hands back. */
export type TeeProof = {
  /**
   * The text the TEE signed. Two fields for a decentralized provider's chat proof, five for a
   * centralized provider's routing proof — `parseSignedText` tells them apart.
   */
  text: string
  /** The secp256k1 signature over the EIP-191 hash of `text`. */
  signature: string
  /**
   * The address the provider claims signed. Advisory only — it is absent from the signature
   * endpoint's payload in practice, and a provider naming its own signer proves nothing. The
   * authority is `InferenceServing.getService(provider).teeSignerAddress`.
   */
  signingAddress?: string
  /**
   * Upstream attribution, present for a centralized provider.
   *
   * Taken from the endpoint's `provider_type` / `provider_identity` / `tls_cert_fingerprint`
   * when it sends them, and otherwise recovered from `text` — which is the authority either
   * way, since `text` is what was signed.
   */
  routing?: RoutingFields
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
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

  const fields = (data ?? {}) as Record<string, unknown>
  const text = str(fields['text'])
  const signature = str(fields['signature'])
  if (!text) throw new Error(`proof response carried no signed text: ${body.slice(0, 200)}`)
  if (!signature) throw new Error(`proof response carried no signature: ${body.slice(0, 200)}`)

  // The endpoint reports these separately for a centralized provider, but `text` already
  // contains them and `text` is what the TEE signed — so let the caller reconcile the two
  // via `parseSignedText` rather than trusting the loose fields here.
  const providerType = str(fields['provider_type'])
  const providerIdentity = str(fields['provider_identity'])
  const tlsFingerprint = str(fields['tls_cert_fingerprint'])
  const routing =
    providerType && providerIdentity && tlsFingerprint
      ? {
          providerType,
          providerIdentity,
          tlsFingerprint: tlsFingerprint.startsWith('0x') ? tlsFingerprint : `0x${tlsFingerprint}`,
        }
      : undefined

  return { text, signature, signingAddress: str(fields['signing_address']), routing }
}
