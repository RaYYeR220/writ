/**
 * End-to-end demo: an agent asks its treasury gate for permission to move funds, and the
 * treasury only moves them against a TEE-attested answer to its own question.
 *
 *   pnpm tsx examples/treasury-demo.ts
 *
 * Required environment:
 *   WRIT_PRIVATE_KEY   the agent's key (also pays for storage and gas)
 *   WRIT_REGISTRY      deployed WritRegistry
 *   WRIT_TREASURY      deployed AgentTreasury / TreasuryGate
 *   WRIT_PROVIDER      a 0G Compute provider serving TeeML
 *   WRIT_RECIPIENT     who the transfer would go to
 * Optional:
 *   WRIT_AMOUNT        ether, default 0.01
 *   WRIT_RPC_URL       default https://evmrpc.0g.ai
 *   WRIT_INDEXER       default https://indexer-storage-turbo.0g.ai
 *   WRIT_CREATE_LEDGER set to 1 to open a 3 0G compute ledger if none exists (spends funds)
 */
import { ethers } from 'ethers'
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk'
import {
  attest,
  archiveTranscript,
  fetchProof,
  notarize,
  runAttested,
  INFERENCE_SERVING_ABI,
  INFERENCE_SERVING_MAINNET,
  INDEXER_RPC_MAINNET,
  TREASURY_GATE_ABI,
  WRIT_REGISTRY_ABI,
} from '../src/index.js'

const MAINNET_CHAIN_ID = 16661n
const EXPLORER = 'https://chainscan.0g.ai'

function required(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n]
    if (v) return v
  }
  throw new Error(`set ${names[0]} (checked ${names.join(', ')})`)
}

const RPC = process.env['WRIT_RPC_URL'] ?? 'https://evmrpc.0g.ai'
const INDEXER = process.env['WRIT_INDEXER'] ?? INDEXER_RPC_MAINNET

// ethers caches every RPC result for 250ms; that includes the account nonce, which is enough
// to collide when the notarization and the execution go out back to back.
const rpc = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 })
const wallet = new ethers.Wallet(required('WRIT_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY'), rpc)

const teeProvider = required('WRIT_PROVIDER', 'TEE_PROVIDER')
const to = required('WRIT_RECIPIENT', 'DEMO_RECIPIENT')
const amount = ethers.parseEther(process.env['WRIT_AMOUNT'] ?? '0.01')

// ---------------------------------------------------------------- 1. the chain

const net = await rpc.getNetwork()
if (net.chainId !== MAINNET_CHAIN_ID) {
  // createZGComputeNetworkBroker silently falls back to TESTNET contract addresses on an
  // unrecognised chain, warning only through console.warn. Refuse rather than sign for the
  // wrong network.
  throw new Error(`expected 0G mainnet ${MAINNET_CHAIN_ID}, got ${net.chainId}`)
}
console.log(`chain ${net.chainId} via ${RPC}`)
console.log(`agent  ${wallet.address}  balance ${ethers.formatEther(await rpc.getBalance(wallet.address))} 0G`)

// ------------------------------------------------- 2. who is allowed to answer

const serving = new ethers.Contract(INFERENCE_SERVING_MAINNET, INFERENCE_SERVING_ABI, rpc)
const svc = await serving['getService']!(teeProvider)

console.log(`\nprovider ${teeProvider}`)
console.log(`  model        ${svc.model}`)
console.log(`  verifiability ${svc.verifiability}`)
console.log(`  TEE signer   ${svc.teeSignerAddress} (acknowledged: ${svc.teeSignerAcknowledged})`)

if (svc.verifiability !== 'TeeML') {
  throw new Error(`provider ${teeProvider} serves "${svc.verifiability}", not TeeML — nothing it says is attestable`)
}
if (!svc.teeSignerAcknowledged) {
  throw new Error(`provider ${teeProvider} has not acknowledged its TEE signer on chain`)
}
if (svc.teeSignerAddress === ethers.ZeroAddress) {
  throw new Error(`provider ${teeProvider} has no registered TEE signer`)
}

// --------------------------------------------------------------- 3. the broker

const broker = await createZGComputeNetworkBroker(wallet)

if (process.env['WRIT_CREATE_LEDGER'] === '1') {
  // 3 is whole 0G as a plain number here — the ledger API takes 0G, the per-provider
  // sub-account minimum is expressed in neuron. They are not interchangeable.
  await broker.ledger.addLedger(3).catch((e: Error) => {
    if (!/exists|already/i.test(e.message)) throw e
  })
}

await broker.inference.acknowledgeProviderSigner(teeProvider).catch((e: Error) => {
  if (!/already acknowledged/i.test(e.message)) throw e
})

const { endpoint, model } = await broker.inference.getServiceMetadata(teeProvider)
console.log(`  endpoint     ${endpoint}`)

// ---------------------------------------------- 4. the question the gate pins

const registry = new ethers.Contract(required('WRIT_REGISTRY'), WRIT_REGISTRY_ABI, wallet)
const treasury = new ethers.Contract(required('WRIT_TREASURY', 'AGENT_TREASURY'), TREASURY_GATE_ABI, wallet)

const bodyHex: string = await treasury['previewRequestBody']!(to, amount)
const bodyBytes = ethers.getBytes(bodyHex)

console.log(`\nthe contract's own question (${bodyBytes.length} bytes, posted verbatim):`)
console.log(new TextDecoder().decode(bodyBytes))

// ------------------------------------- 5. inference, proof, archive, notarize

const result = await attest({
  broker,
  provider: teeProvider,
  endpoint,
  model,
  bodyBytes,
  expectedSigner: svc.teeSignerAddress,
  signer: wallet,
  archiveOptions: { indexerRpc: INDEXER, chainRpc: RPC },
  runAttested,
  fetchProof,
  archiveTranscript,
  notarize: (run, p, sig, root) => notarize(registry as never, run, p, sig, root),
})

console.log(`\nanswer: ${new TextDecoder().decode(result.run.rawResponse)}`)
console.log(`writ            ${result.writId}`)
console.log(`transcript root ${result.transcriptRoot}`)
console.log(
  result.txHash
    ? `notarized       ${EXPLORER}/tx/${result.txHash}`
    : 'notarized       already on chain (someone got there first)',
)

// ------------------------------------------------------- 6. settle, separately

// A second transaction on purpose. If the gate refuses, the notarization above still stands:
// the refusal is a permanent public record rather than something a revert erases.
let receipt: ethers.TransactionReceipt | null = null
try {
  const tx = await treasury['execute']!(
    to,
    amount,
    result.run.rawResponse,
    teeProvider,
    result.signature,
    result.transcriptRoot,
  )
  receipt = await tx.wait()
} catch (err) {
  const e = err as { revert?: { name: string; args: unknown[] }; data?: string }
  // A revert raised inside WritRegistry bubbles up as raw data the gate's own interface
  // cannot name, so fall back to the registry's.
  const named =
    e.revert ??
    (typeof e.data === 'string' ? registry.interface.parseError(e.data) : null)
  if (named) {
    console.error(`\nthe gate rejected the proof: ${named.name}(${named.args.join(', ')})`)
    console.error('that is a verification failure, not a decision — nothing was executed')
  }
  throw err
}

if (!receipt) throw new Error('execution produced no receipt')

const events = receipt.logs
  .map((log) => {
    try {
      return treasury.interface.parseLog(log)
    } catch {
      return null
    }
  })
  .filter((e): e is ethers.LogDescription => e !== null)

const approved = events.find((e) => e.name === 'TransferApproved')
const refused = events.find((e) => e.name === 'TransferRefused')

console.log(`\nexecuted        ${EXPLORER}/tx/${receipt.hash}`)
if (approved) {
  console.log(`APPROVED  risk ${approved.args['risk']}  moved ${ethers.formatEther(amount)} 0G to ${to}`)
} else if (refused) {
  console.log(`REFUSED   risk ${refused.args['risk']}  no funds moved — this is the gate working`)
} else {
  throw new Error(`execution ${receipt.hash} emitted no decision event; refusing to claim an outcome`)
}
