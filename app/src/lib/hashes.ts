import { hashMessage, recoverAddress } from 'ethers'

/**
 * The browser mirror of `@writ/sdk`'s hashing rules.
 *
 * The SDK reaches for `node:crypto`; this reaches for `crypto.subtle`, which every browser has
 * had for a decade and Node has had since 18. Same bytes in, same hex out — which is the whole
 * point, because these are the values the contract compares against.
 */

const HASH_64 = /^[0-9a-f]{64}$/
export const MAX_ROUTING_FIELD_BYTES = 32

/** sha256 of exact bytes, lowercase hex, no `0x`. Byte-identical to Go's `hex.EncodeToString`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', view.buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** Normalises a bytes32 to bare lowercase hex, rejecting anything that is not one. */
export function bare32(hash: string, label: string): string {
  const stripped = (hash.startsWith('0x') || hash.startsWith('0X') ? hash.slice(2) : hash).toLowerCase()
  if (!HASH_64.test(stripped)) {
    throw new Error(`${label} must be a 32-byte hex hash, got ${JSON.stringify(hash)}`)
  }
  return stripped
}

export type RoutingFields = {
  providerType: string
  providerIdentity: string
  /** `0x`-prefixed 32 bytes. */
  tlsFingerprint: string
}

/** Mirrors `WritLib._requireLabel` and the broker's fingerprint shape. */
export function assertRoutingFields(routing: RoutingFields): void {
  for (const [name, value] of [
    ['providerType', routing.providerType],
    ['providerIdentity', routing.providerIdentity],
  ] as const) {
    if (value.length === 0) throw new Error(`${name} must not be empty`)
    const bytes = utf8(value).length
    if (bytes > MAX_ROUTING_FIELD_BYTES) {
      throw new Error(`${name} must be at most ${MAX_ROUTING_FIELD_BYTES} bytes, got ${bytes}`)
    }
    if (value.includes(':')) throw new Error(`${name} must not contain the field delimiter ":"`)
  }
  bare32(routing.tlsFingerprint, 'tlsFingerprint')
}

/**
 * The exact 129-byte text a decentralized provider's TEE signs.
 *
 * This is the whole product in one line: the request hash is on the left of the colon, so the
 * signature covers the question, not only the answer.
 */
export function signedText(reqHash: string, respHash: string): string {
  return `${bare32(reqHash, 'reqHash')}:${bare32(respHash, 'respHash')}`
}

/** The five-field text a centralized provider's TEE signs, upstream attribution included. */
export function signedTextRouting(reqHash: string, respHash: string, routing: RoutingFields): string {
  assertRoutingFields(routing)
  return [
    bare32(reqHash, 'reqHash'),
    bare32(respHash, 'respHash'),
    routing.providerType,
    routing.providerIdentity,
    bare32(routing.tlsFingerprint, 'tlsFingerprint'),
  ].join(':')
}

/**
 * Recovers the address that signed `text` under EIP-191.
 *
 * Returns `null` rather than throwing on a malformed signature, so a caller has exactly two
 * outcomes to render — an address, or nothing. There is no third state where a broken signature
 * is quietly treated as absent.
 */
export function recoverSigner(text: string, signature: string): string | null {
  try {
    return recoverAddress(hashMessage(text), signature)
  } catch {
    return null
  }
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

export function shortHash(h: string, head = 10, tail = 8): string {
  if (h.length <= head + tail + 1) return h
  return `${h.slice(0, head)}…${h.slice(-tail)}`
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}
