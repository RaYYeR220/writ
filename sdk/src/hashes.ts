import { createHash } from 'node:crypto'
import { ethers } from 'ethers'

/**
 * sha256 of exact bytes, lowercase hex, no `0x` prefix.
 *
 * Byte-identical to Go's `hex.EncodeToString(sha256.Sum256(b))`, which is what the 0G provider
 * broker uses when it builds the text its TEE signs.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

/**
 * The upstream attribution a centralized provider's TEE binds into its signature.
 *
 * `tlsFingerprint` is the certificate fingerprint of the upstream that actually served the
 * request — the part of this proof the chat format does not attest at all.
 */
export type RoutingFields = {
  providerType: string
  providerIdentity: string
  /** `0x`-prefixed 32 bytes. */
  tlsFingerprint: string
}

/** What a provider's signed text turned out to be. */
export type ParsedSignedText =
  | { kind: 'chat'; reqHash: string; respHash: string }
  | { kind: 'routing'; reqHash: string; respHash: string; routing: RoutingFields }

const HASH_64 = /^[0-9a-f]{64}$/
/** `WritRegistry.MAX_ROUTING_FIELD`. */
export const MAX_ROUTING_FIELD_BYTES = 32

/** Normalises a bytes32 to bare lowercase hex, rejecting anything that is not one. */
function bare32(hash: string, label: string): string {
  const stripped = (hash.startsWith('0x') || hash.startsWith('0X') ? hash.slice(2) : hash).toLowerCase()
  if (!HASH_64.test(stripped)) {
    throw new Error(`${label} must be a 32-byte hex hash, got ${JSON.stringify(hash)}`)
  }
  return stripped
}

/**
 * The exact 129-byte text a decentralized provider's TEE signs:
 * `sha256hex(request):sha256hex(response)`.
 *
 * Mirrors `0g-serving-broker/api/inference/internal/ctrl/signing.go`. `WritLib.signedText`
 * rebuilds the same bytes on chain, so the two must never drift.
 */
export function signedText(reqHash: string, respHash: string): string {
  return `${bare32(reqHash, 'reqHash')}:${bare32(respHash, 'respHash')}`
}

/**
 * Mirrors the contract's `_requireLabel` and the broker's fingerprint shape.
 *
 * The five fields are `:`-joined, so a label containing `:` makes the split ambiguous —
 * `("x", "y:z")` and `("x:y", "z")` sign identical bytes. Checking here means a bad value
 * fails immediately with a readable message instead of reverting after gas has been spent.
 */
export function assertRoutingFields(routing: RoutingFields): void {
  for (const [name, value] of [
    ['providerType', routing.providerType],
    ['providerIdentity', routing.providerIdentity],
  ] as const) {
    if (value.length === 0) throw new Error(`${name} must not be empty`)
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_ROUTING_FIELD_BYTES) {
      throw new Error(`${name} must be at most ${MAX_ROUTING_FIELD_BYTES} bytes, got ${bytes}`)
    }
    if (value.includes(':')) throw new Error(`${name} must not contain the field delimiter ":"`)
  }
  bare32(routing.tlsFingerprint, 'tlsFingerprint')
}

/**
 * The text a centralized provider's TEE signs:
 * `sha256hex(req):sha256hex(resp):providerType:providerIdentity:tlsCertFingerprint`.
 *
 * Mirrors `FormatRoutingProofText` in the broker's `api/common/tee/tls.go` and
 * `WritLib.routingProofText` on chain.
 */
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
 * Works out which format a provider signed.
 *
 * The broker produces three texts. Two are supported; the image format
 * (`sha256hex(req):sha256hex(img0),sha256hex(img1),…`) is not, and is rejected rather than
 * mistaken for a chat proof — it also splits into two fields, but its second field is a
 * comma-joined list rather than one hash.
 */
export function parseSignedText(text: string): ParsedSignedText {
  const parts = text.split(':')
  if (parts.length === 2) {
    return {
      kind: 'chat',
      reqHash: '0x' + bare32(parts[0]!, 'signed text request hash'),
      respHash: '0x' + bare32(parts[1]!, 'signed text response hash'),
    }
  }
  if (parts.length === 5) {
    const routing: RoutingFields = {
      providerType: parts[2]!,
      providerIdentity: parts[3]!,
      tlsFingerprint: '0x' + bare32(parts[4]!, 'signed text tls fingerprint'),
    }
    assertRoutingFields(routing)
    return {
      kind: 'routing',
      reqHash: '0x' + bare32(parts[0]!, 'signed text request hash'),
      respHash: '0x' + bare32(parts[1]!, 'signed text response hash'),
      routing,
    }
  }
  throw new Error(
    `unsupported signed text format (${parts.length} ':'-separated fields): ${JSON.stringify(text.slice(0, 200))}`,
  )
}

function recovers(text: string, signature: string, expectedSigner: string): boolean {
  try {
    const recovered = ethers.recoverAddress(ethers.hashMessage(text), signature)
    return recovered.toLowerCase() === expectedSigner.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Off-chain mirror of the on-chain check in `WritLib.recoverSigner`.
 *
 * `expectedSigner` must come from 0G's on-chain `InferenceServing` registry, never from the
 * provider's own response — a provider that names its own signer proves nothing.
 *
 * Returns a boolean rather than throwing so a caller can branch on it, but there is no third
 * state: anything unusable is `false`, never an assumed pass.
 */
export function verifyProofLocally(
  reqHash: string,
  respHash: string,
  signature: string,
  expectedSigner: string,
): boolean {
  try {
    return recovers(signedText(reqHash, respHash), signature, expectedSigner)
  } catch {
    return false
  }
}

/** `verifyProofLocally` for a centralized provider's five-field routing proof. */
export function verifyRoutingProofLocally(
  reqHash: string,
  respHash: string,
  routing: RoutingFields,
  signature: string,
  expectedSigner: string,
): boolean {
  try {
    return recovers(signedTextRouting(reqHash, respHash, routing), signature, expectedSigner)
  } catch {
    return false
  }
}
