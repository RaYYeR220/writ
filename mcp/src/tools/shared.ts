import { ethers } from 'ethers'
import * as z from 'zod/v4'
import { fail } from '../errors.js'
import type { Policy, ServiceInfo, WritDeps } from '../deps.js'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const BYTES32 = /^0x[0-9a-fA-F]{64}$/

export function addressField(description: string) {
  return z
    .string()
    .refine((v) => ethers.isAddress(v), { message: 'must be a 20-byte hex address' })
    .describe(description)
}

export function bytes32Field(description: string) {
  return z
    .string()
    .refine((v) => BYTES32.test(v), { message: 'must be a 0x-prefixed 32-byte hex value' })
    .describe(description)
}

/**
 * The transfer amount, in whole 0G.
 *
 * A decimal string rather than a number, because the gate pins the exact wei value into the
 * question it asks and an IEEE double cannot carry 18 significant decimal places. `"0.01"` is
 * unambiguous; `0.01` is not.
 */
export const amountField = z
  .string()
  .refine(
    (v) => {
      try {
        return ethers.parseEther(v) >= 0n
      } catch {
        return false
      }
    },
    { message: 'must be a decimal amount in 0G, for example "0.01"' },
  )
  .describe('Transfer amount in whole 0G as a decimal string, e.g. "0.01". Not wei.')

export function parseAmount(amount: string): bigint {
  return ethers.parseEther(amount)
}

/** Both renderings, so nothing downstream has to guess which unit a number is in. */
export function amountOut(wei: bigint): { amount: string; amountWei: string } {
  return { amount: ethers.formatEther(wei), amountWei: wei.toString() }
}

export function explorerTx(deps: WritDeps, hash: string): string {
  return hash ? `${deps.explorer.replace(/\/+$/, '')}/tx/${hash}` : ''
}

/**
 * Works out which provider must answer this gate's question.
 *
 * A gate with `allowedProvider == address(0)` accepts any acknowledged TeeML provider, which
 * leaves the choice to the caller — so it has to come from configuration rather than be
 * invented here.
 */
export function resolveProvider(policy: Policy, deps: WritDeps): string {
  if (policy.allowedProvider !== ZERO_ADDRESS) return policy.allowedProvider

  const fallback = deps.fallbackProvider()
  if (!fallback) {
    fail(
      'this gate accepts any acknowledged TeeML provider, so there is no provider to ask; set WRIT_PROVIDER to name one',
    )
  }
  if (!ethers.isAddress(fallback)) fail(`WRIT_PROVIDER is not an address: ${fallback}`)
  return ethers.getAddress(fallback)
}

/**
 * Refuses a provider that cannot produce a proof at all.
 *
 * These are exactly the checks `WritRegistry` re-runs on chain, done here first so a run that
 * could never be notarized costs nothing and, more importantly, so the reason is legible to the
 * agent rather than arriving as a revert after inference has been paid for.
 */
export function assertAttestable(svc: ServiceInfo): void {
  if (svc.verifiability !== 'TeeML') {
    fail(
      `provider ${svc.provider} serves verifiability "${svc.verifiability}", not TeeML — nothing it says can be attested`,
    )
  }
  if (!svc.teeSignerAcknowledged) {
    fail(`provider ${svc.provider} has not acknowledged its TEE signer in 0G's InferenceServing registry`)
  }
  if (!svc.teeSignerAddress || svc.teeSignerAddress === ZERO_ADDRESS) {
    fail(`provider ${svc.provider} has no registered TEE signer address`)
  }
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
