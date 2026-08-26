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

const HASH_64 = /^[0-9a-f]{64}$/

/** Normalises a bytes32 to bare lowercase hex, rejecting anything that is not one. */
function bare32(hash: string, label: string): string {
  const stripped = (hash.startsWith('0x') || hash.startsWith('0X') ? hash.slice(2) : hash).toLowerCase()
  if (!HASH_64.test(stripped)) {
    throw new Error(`${label} must be a 32-byte hex hash, got ${JSON.stringify(hash)}`)
  }
  return stripped
}

/**
 * The exact 129-byte text a 0G provider TEE signs: `sha256hex(request):sha256hex(response)`.
 *
 * Mirrors `0g-serving-broker/api/inference/internal/ctrl/signing.go`. `WritLib.signedText`
 * rebuilds the same bytes on chain, so the two must never drift.
 */
export function signedText(reqHash: string, respHash: string): string {
  return `${bare32(reqHash, 'reqHash')}:${bare32(respHash, 'respHash')}`
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
    const recovered = ethers.recoverAddress(ethers.hashMessage(signedText(reqHash, respHash)), signature)
    return recovered.toLowerCase() === expectedSigner.toLowerCase()
  } catch {
    return false
  }
}
