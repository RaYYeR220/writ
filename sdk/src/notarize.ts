import type { ethers } from 'ethers'
import type { AttestedRun } from './inference.js'

/**
 * The part of `WritRegistry` this module calls, declared structurally.
 *
 * `new ethers.Contract(addr, WRIT_REGISTRY_ABI, signer)` satisfies it, and so does a stub, so
 * the ordering rules can be tested without a chain.
 */
export type WritRegistryContract = {
  writId(provider: string, reqHash: string, respHash: string): Promise<string>
  isNotarized(id: string): Promise<boolean>
  notarize(
    provider: string,
    reqHash: string,
    respHash: string,
    signature: string,
    transcriptRoot: string,
  ): Promise<ethers.ContractTransactionResponse>
}

export type NotarizeResult = {
  /** `keccak256(abi.encode(provider, reqHash, respHash))` — the permanent id of this proof. */
  writId: string
  /** The notarizing transaction, or `''` when the writ was already on chain. */
  txHash: string
  /** True when someone had already put this exact proof on the record. */
  alreadyNotarized: boolean
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/**
 * Records a verified proof in `WritRegistry`.
 *
 * Call this BEFORE the gate's `execute`, as a separate transaction. `execute` and `notarize`
 * in one transaction would let a revert on the action roll back the record of the decision;
 * split, a refusal still leaves a permanent public trail. `PolicyGate._consume` skips
 * notarizing when the writ already exists, so the ordering costs nothing.
 *
 * The registry re-verifies the signature against 0G's own on-chain `InferenceServing` entry,
 * so a bad proof reverts here rather than being recorded.
 */
export async function notarize(
  registry: WritRegistryContract,
  run: AttestedRun,
  provider: string,
  signature: string,
  transcriptRoot: string,
): Promise<NotarizeResult> {
  if (!BYTES32.test(transcriptRoot)) {
    throw new Error(`transcriptRoot must be a 32-byte hex value, got ${JSON.stringify(transcriptRoot)}`)
  }

  const writId: string = await registry.writId(provider, run.reqHash, run.respHash)
  if (await registry.isNotarized(writId)) {
    // Already a matter of public record; nothing to pay for and nothing to fabricate.
    return { writId, txHash: '', alreadyNotarized: true }
  }

  const tx = await registry.notarize(provider, run.reqHash, run.respHash, signature, transcriptRoot)
  const receipt = await tx.wait()
  if (!receipt) throw new Error(`notarization ${tx.hash} produced no receipt; the writ is not confirmed`)
  if (receipt.status !== 1) throw new Error(`notarization ${receipt.hash} reverted; the writ was not recorded`)

  return { writId, txHash: receipt.hash, alreadyNotarized: false }
}
