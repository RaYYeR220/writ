import { fromUtf8, type RoutingFields } from './hashes'

/**
 * What a Writ transcript is: everything a stranger needs to re-derive the on-chain proof from
 * public data alone. Written by `@writ/sdk`'s `serializeTranscript`, read here.
 */
export type Transcript = {
  chatId: string
  provider: string
  model: string
  /** The exact request wire body. sha256 of these bytes must equal the writ's `reqHash`. */
  request: string
  /** The exact response wire body. sha256 of these bytes must equal the writ's `respHash`. */
  response: string
  reqHash: string
  respHash: string
  /** The exact text the TEE signed — the artifact everything else is checked against. */
  signedText: string
  signature: string
  signingAddress: string
  capturedAt: string
  routing?: RoutingFields
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (typeof v !== 'string') throw new Error(`transcript field "${key}" is missing or not a string`)
  return v
}

/**
 * Parses archived bytes into a transcript, refusing anything shaped wrong.
 *
 * Deliberately strict and deliberately dumb: it validates the shape and nothing else. Whether
 * the contents are *true* is decided by the four checks against the chain, not here, so this
 * function must never be tempted into filling a blank with something plausible.
 */
export function parseTranscript(bytes: Uint8Array): Transcript {
  let raw: unknown
  try {
    raw = JSON.parse(fromUtf8(bytes))
  } catch (e) {
    throw new Error(`archived bytes are not JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('archived bytes are JSON, but not a transcript object')
  }
  const o = raw as Record<string, unknown>

  const t: Transcript = {
    chatId: str(o, 'chatId'),
    provider: str(o, 'provider'),
    model: str(o, 'model'),
    request: str(o, 'request'),
    response: str(o, 'response'),
    reqHash: str(o, 'reqHash'),
    respHash: str(o, 'respHash'),
    signedText: str(o, 'signedText'),
    signature: str(o, 'signature'),
    signingAddress: str(o, 'signingAddress'),
    capturedAt: str(o, 'capturedAt'),
  }

  const routing = o['routing']
  if (routing !== undefined) {
    if (typeof routing !== 'object' || routing === null) {
      throw new Error('transcript field "routing" is present but is not an object')
    }
    const r = routing as Record<string, unknown>
    t.routing = {
      providerType: str(r, 'providerType'),
      providerIdentity: str(r, 'providerIdentity'),
      tlsFingerprint: str(r, 'tlsFingerprint'),
    }
  }

  return t
}

/**
 * The model's answer, lifted out of the chat-completions body the same way `VerdictLib` does it
 * on chain: find the first `"content":"`, read to the closing quote, cap at 32 bytes.
 *
 * Kept identical to the contract on purpose — if the page showed a verdict the contract would
 * have rejected, the page would be lying about what the gate did.
 */
export function parseVerdict(responseBody: string): { allowed: boolean; risk: number } | null {
  const marker = '"content":"'
  const at = responseBody.indexOf(marker)
  if (at < 0) return null
  const start = at + marker.length
  const end = responseBody.indexOf('"', start)
  if (end < 0 || end - start > 32) return null

  const token = responseBody.slice(start, end)
  const m = /^(ALLOW|DENY):(\d{1,3})$/.exec(token)
  if (!m) return null
  const risk = Number(m[2])
  if (risk > 100) return null
  return { allowed: m[1] === 'ALLOW', risk }
}

/** The prompt without the JSON envelope, for the reader who wants the question and not the wire. */
export function extractPrompt(requestBody: string): string {
  try {
    const parsed = JSON.parse(requestBody) as { messages?: { role?: string; content?: string }[] }
    const messages = parsed.messages
    if (!Array.isArray(messages) || messages.length === 0) return requestBody
    return messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n\n')
  } catch {
    return requestBody
  }
}

/** The model's answer as text, for display next to the raw body. */
export function extractAnswer(responseBody: string): string {
  const marker = '"content":"'
  const at = responseBody.indexOf(marker)
  if (at < 0) return responseBody
  const start = at + marker.length
  const end = responseBody.indexOf('"', start)
  return end < 0 ? responseBody : responseBody.slice(start, end)
}
