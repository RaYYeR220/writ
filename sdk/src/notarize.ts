import type { ethers } from 'ethers'
import { assertRoutingFields, parseSignedText, type RoutingFields } from './hashes.js'
import type { AttestedRun } from './inference.js'
import type { TeeProof } from './proof.js'

/**
 * The part of `WritRegistry` this module calls, declared structurally.
 *
 * `new ethers.Contract(addr, WRIT_REGISTRY_ABI, signer)` satisfies it, and so does a stub, so
 * the ordering rules can be tested without a chain.
 */
export type WritRegistryContract = {
  writId(provider: string, reqHash: string, respHash: string): Promise<string>
  routingWritId(
    provider: string,
    reqHash: string,
    respHash: string,
    providerType: string,
    providerIdentity: string,
    tlsFingerprint: string,
  ): Promise<string>
  isNotarized(id: string): Promise<boolean>
  notarize(
    provider: string,
    reqHash: string,
    respHash: string,
    signature: string,
    transcriptRoot: string,
  ): Promise<ethers.ContractTransactionResponse>
  notarizeRoutingProof(
    provider: string,
    reqHash: string,
    respHash: string,
    providerType: string,
    providerIdentity: string,
    tlsFingerprint: string,
    signature: string,
    transcriptRoot: string,
  ): Promise<ethers.ContractTransactionResponse>
}

export type NotarizeResult = {
  /** The permanent id of this proof in `WritRegistry`. */
  writId: string
  /** The notarizing transaction, or `''` when the writ was already on chain. */
  txHash: string
  /** True when someone had already put this exact proof on the record. */
  alreadyNotarized: boolean
  /** Which signed-text format was recorded. */
  kind: 'chat' | 'routing'
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

function assertRoot(transcriptRoot: string): void {
  if (!BYTES32.test(transcriptRoot)) {
    throw new Error(`transcriptRoot must be a 32-byte hex value, got ${JSON.stringify(transcriptRoot)}`)
  }
}

async function send(
  writId: string,
  kind: 'chat' | 'routing',
  registry: WritRegistryContract,
  sendTx: () => Promise<ethers.ContractTransactionResponse>,
): Promise<NotarizeResult> {
  if (await registry.isNotarized(writId)) {
    // Already a matter of public record; nothing to pay for and nothing to fabricate.
    return { writId, txHash: '', alreadyNotarized: true, kind }
  }

  const tx = await sendTx()
  const receipt = await tx.wait()
  if (!receipt) throw new Error(`notarization ${tx.hash} produced no receipt; the writ is not confirmed`)
  if (receipt.status !== 1) throw new Error(`notarization ${receipt.hash} reverted; the writ was not recorded`)

  return { writId, txHash: receipt.hash, alreadyNotarized: false, kind }
}

/**
 * Records a decentralized provider's chat proof in `WritRegistry`.
 *
 * Call this BEFORE the gate's `execute`, as a separate transaction. `execute` and `notarize`
 * in one transaction would let a revert on the action roll back the record of the decision;
 * split, a refusal still leaves a permanent public trail. `PolicyGate` skips notarizing when
 * the writ already exists, so the ordering costs nothing.
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
  assertRoot(transcriptRoot)
  const writId = await registry.writId(provider, run.reqHash, run.respHash)
  return send(writId, 'chat', registry, () =>
    registry.notarize(provider, run.reqHash, run.respHash, signature, transcriptRoot),
  )
}

/**
 * Records a centralized provider's routing proof, which binds the upstream that answered as
 * well as the question and the answer.
 *
 * Most live 0G mainnet providers are centralized, so this is the path that reaches them.
 */
export async function notarizeRoutingProof(
  registry: WritRegistryContract,
  run: AttestedRun,
  provider: string,
  routing: RoutingFields,
  signature: string,
  transcriptRoot: string,
): Promise<NotarizeResult> {
  assertRoot(transcriptRoot)
  assertRoutingFields(routing)

  const writId = await registry.routingWritId(
    provider,
    run.reqHash,
    run.respHash,
    routing.providerType,
    routing.providerIdentity,
    routing.tlsFingerprint,
  )
  return send(writId, 'routing', registry, () =>
    registry.notarizeRoutingProof(
      provider,
      run.reqHash,
      run.respHash,
      routing.providerType,
      routing.providerIdentity,
      routing.tlsFingerprint,
      signature,
      transcriptRoot,
    ),
  )
}

/**
 * Notarizes whichever proof the provider actually produced.
 *
 * The format is read off the signed text rather than off any loose field, because the signed
 * text is the thing the TEE committed to.
 */
export async function notarizeProof(
  registry: WritRegistryContract,
  run: AttestedRun,
  provider: string,
  proof: TeeProof,
  transcriptRoot: string,
): Promise<NotarizeResult> {
  const parsed = parseSignedText(proof.text)
  return parsed.kind === 'routing'
    ? notarizeRoutingProof(registry, run, provider, parsed.routing, proof.signature, transcriptRoot)
    : notarize(registry, run, provider, proof.signature, transcriptRoot)
}
