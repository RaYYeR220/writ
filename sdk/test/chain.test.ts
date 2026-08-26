import { describe, it, expect, afterAll } from 'vitest'
import { ethers } from 'ethers'
import {
  attest,
  fetchProof,
  notarizeProof,
  refusalName,
  runAttested,
  sha256Hex,
  type RoutingFields,
  INFERENCE_SERVING_ABI,
  INFERENCE_SERVING_MAINNET,
  TREASURY_GATE_ABI,
  WRIT_REGISTRY_ABI,
} from '../src/index.js'
import { buildFailure, ensureBuilt, loadArtifact } from './helpers/contracts.js'
import { startAnvil, ANVIL_KEY, type Anvil } from './helpers/anvil.js'
import { startProviderStub, type ProviderStub } from './helpers/provider-stub.js'

/**
 * End to end against the real compiled contracts on a local chain.
 *
 * Nothing here is mocked on the Writ side: the gate builds the question, the SDK posts those
 * exact bytes, the provider signs what it saw, `WritRegistry` re-verifies the signature in
 * Solidity, and the gate executes. Only 0G Storage is stubbed, because there is no local
 * storage network — the transcript root is passed through as an opaque bytes32 either way.
 */

const MODEL = '0GM-1.0-35B-A3B'
const TEE_KEY = '0x' + '11'.repeat(32)
const PROVIDER = '0x000000000000000000000000000000000000BEEF'
const MAX_RISK = 50
const ROOT = '0x' + 'cd'.repeat(32)
const ROUTING: RoutingFields = {
  providerType: 'centralized',
  providerIdentity: 'openai',
  tlsFingerprint: '0x' + 'cc'.repeat(32),
}
const enc = new TextEncoder()

// anvil's `eth_estimateGas` occasionally comes in a couple of thousand gas under what the same
// call then uses, which surfaces as an out-of-gas revert that has nothing to do with the code
// under test. Every call expected to succeed is sent with a fixed limit instead; the calls
// expected to fail deliberately keep estimation, because that is where their rejection comes from.
const GAS = { gasLimit: 1_000_000n }

const compiled = ensureBuilt()

let anvil: Anvil | null = null
let stub: ProviderStub | null = null
let wallet: ethers.Wallet
let registry: ethers.Contract
let treasury: ethers.Contract

const broker = { inference: { getRequestHeaders: async () => ({ Authorization: 'Bearer app-sk-local' }) } }

async function deploy(name: string, args: unknown[], signer: ethers.Signer): Promise<ethers.Contract> {
  const art = loadArtifact(name)
  if (!art.bytecode?.object) throw new Error(`artifact ${name} carries no bytecode`)
  const factory = new ethers.ContractFactory(
    art.abi as unknown as ethers.InterfaceAbi,
    art.bytecode.object,
    signer,
  )
  const c = await factory.deploy(...args)
  await c.waitForDeployment()
  return c as ethers.Contract
}

/**
 * The nine facts `TreasuryGate.buildParams` pins, in order.
 *
 * Written out longhand rather than assembled from a list, because this is the shape a client
 * has to be able to rely on and a test that generated it from the same list the code uses
 * would agree with itself no matter what the contract emitted.
 */
const QUESTION = new RegExp(
  'recipient=(?<recipient>0x[0-9a-f]{40}) ' +
    'amount=(?<amount>\\d+) ' +
    'nonce=(?<nonce>\\d+) ' +
    'treasuryBalance=(?<treasuryBalance>\\d+) ' +
    'amountPctOfBalance=(?<amountPctOfBalance>\\d+) ' +
    'priorApprovals=(?<priorApprovals>\\d+) ' +
    'priorRefusals=(?<priorRefusals>\\d+) ' +
    'recipientPriorPayments=(?<recipientPriorPayments>\\d+) ' +
    'recipientPriorTotal=(?<recipientPriorTotal>\\d+)',
)

/** The gate's question for one transfer, read back as numbers. */
async function facts(to: string, amount: bigint) {
  const params = new TextDecoder().decode(ethers.getBytes(await treasury['buildParams']!(to, amount)))
  const g = QUESTION.exec(params)?.groups
  if (!g) throw new Error(`buildParams did not produce the nine-field question: ${params}`)
  return {
    recipient: g['recipient']!,
    amount: BigInt(g['amount']!),
    nonce: BigInt(g['nonce']!),
    treasuryBalance: BigInt(g['treasuryBalance']!),
    amountPctOfBalance: BigInt(g['amountPctOfBalance']!),
    priorApprovals: BigInt(g['priorApprovals']!),
    priorRefusals: BigInt(g['priorRefusals']!),
    recipientPriorPayments: BigInt(g['recipientPriorPayments']!),
    recipientPriorTotal: BigInt(g['recipientPriorTotal']!),
  }
}

/** The single decision the gate emitted, or a failure if it emitted none. */
function decisionEvent(receipt: ethers.TransactionReceipt): ethers.LogDescription {
  const decisions = receipt.logs
    .map((log) => {
      try {
        return treasury.interface.parseLog(log)
      } catch {
        return null
      }
    })
    .filter((e): e is ethers.LogDescription => e?.name === 'TransferApproved' || e?.name === 'TransferRefused')
  expect(decisions).toHaveLength(1)
  return decisions[0]!
}

/** Runs the pipeline for one transfer and returns everything needed to settle it. */
async function attestTransfer(to: string, amount: bigint, content: string, routing?: RoutingFields) {
  const provider = await startProviderStub({ teeKey: TEE_KEY, content, ...(routing ? { routing } : {}) })
  try {
    const bodyHex: string = await treasury['previewRequestBody']!(to, amount)
    const bodyBytes = ethers.getBytes(bodyHex)
    return {
      bodyBytes,
      result: await attest({
        broker,
        provider: PROVIDER,
        endpoint: provider.endpoint,
        model: MODEL,
        bodyBytes,
        expectedSigner: provider.teeSigner,
        signer: wallet,
        runAttested,
        fetchProof,
        archiveTranscript: async () => ROOT,
        notarize: (run, p, proof, root) => notarizeProof(registry as never, run, p, proof, root),
      }),
    }
  } finally {
    await provider.stop()
  }
}

// Set up at module scope, not in `beforeAll`: `it.runIf` is evaluated while the file is being
// collected, which is before any hook has run.
if (compiled) {
  anvil = await startAnvil()
  if (!anvil) console.warn('SKIPPING chain tests: anvil would not start')
} else {
  console.warn(`SKIPPING chain tests: contracts/ did not compile.\n${buildFailure}`)
}
if (anvil) {
  // ethers caches every RPC result for 250ms, `eth_getTransactionCount` included, which hands
  // out a stale nonce when two transactions go out back to back on an instant-mining chain.
  const rpc = new ethers.JsonRpcProvider(anvil.url, undefined, { cacheTimeout: -1 })
  wallet = new ethers.Wallet(ANVIL_KEY, rpc)

  const serving = await deploy('MockInferenceServing', [], wallet)
  await (await serving['set']!(PROVIDER, MODEL, 'TeeML', new ethers.Wallet(TEE_KEY).address, true)).wait()

  const registryContract = await deploy('WritRegistry', [await serving.getAddress()], wallet)
  registry = new ethers.Contract(await registryContract.getAddress(), WRIT_REGISTRY_ABI, wallet)

  const treasuryContract = await deploy(
    'AgentTreasury',
    [
      await registry.getAddress(),
      wallet.address, // agent
      wallet.address, // owner
      ethers.keccak256(ethers.toUtf8Bytes(MODEL)),
      PROVIDER,
      MAX_RISK,
    ],
    wallet,
  )
  treasury = new ethers.Contract(await treasuryContract.getAddress(), TREASURY_GATE_ABI, wallet)
  await (await wallet.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther('10') })).wait()

  stub = await startProviderStub({ teeKey: TEE_KEY, content: 'ALLOW:12' })
}

afterAll(async () => {
  await stub?.stop()
  anvil?.stop()
})

const live = () => compiled && anvil !== null

describe('writ pipeline on a local chain', () => {
  it.runIf(live())('posts the exact bytes the gate pinned, and nothing else', async () => {
    const to = ethers.Wallet.createRandom().address
    const bodyHex: string = await treasury['previewRequestBody']!(to, ethers.parseEther('1'))
    const bodyBytes = ethers.getBytes(bodyHex)

    await runAttested({ broker, provider: PROVIDER, endpoint: stub!.endpoint, bodyBytes })
    expect(Buffer.from(stub!.lastRequest()).equals(Buffer.from(bodyBytes))).toBe(true)

    // The question really is the contract's, parameterised by this exact transfer.
    const text = new TextDecoder().decode(bodyBytes)
    expect(text).toContain(to.toLowerCase())

    // Nine space-separated key=value pairs, in this order, with no quoting or escaping. The
    // gate is the sole author of all of them: only `recipient` and `amount` came from the caller.
    const params = QUESTION.exec(text)
    expect(params, `no nine-field parameter block in: ${text}`).not.toBeNull()
    expect(params!.groups!['recipient']).toBe(to.toLowerCase())
    expect(params!.groups!['amount']).toBe(ethers.parseEther('1').toString())
    expect(params!.groups!['nonce']).toBe((await treasury['nonce']!()).toString())
  })

  it.runIf(live())('pins the treasury as it actually stands, and moves with it', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('1')
    const treasuryAddress = await treasury.getAddress()

    const before = await facts(to, amount)
    expect(before.treasuryBalance).toBe(await wallet.provider!.getBalance(treasuryAddress))
    expect(before.recipientPriorPayments).toBe(0n)
    expect(before.recipientPriorTotal).toBe(0n)
    expect(before.priorApprovals).toBe(await treasury['approvedCount']!())
    // Reported against the balance *before* the transfer, floored, so it is directly comparable.
    expect(before.amountPctOfBalance).toBe((amount * 100n) / before.treasuryBalance)

    const { result } = await attestTransfer(to, amount, 'ALLOW:12')
    await (
      await treasury['execute']!(to, amount, result.run.rawResponse, PROVIDER, result.signature, ROOT, GAS)
    ).wait()

    // The same call now describes a different treasury, because it is a different treasury.
    const after = await facts(to, amount)
    expect(after.treasuryBalance).toBe(before.treasuryBalance - amount)
    expect(after.priorApprovals).toBe(before.priorApprovals + 1n)
    expect(after.recipientPriorPayments).toBe(1n)
    expect(after.recipientPriorTotal).toBe(amount)
    expect(await treasury['recipientHistory']!(to)).toEqual([1n, amount])
  })

  it.runIf(live())('rejects a proof answering the treasury as it stood a moment ago', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('1')

    // A completely honest proof of the gate's own question…
    const { result } = await attestTransfer(to, amount, 'ALLOW:12')

    // …and then the treasury moves, so the balance and percentage the model judged are stale.
    await (
      await wallet.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther('0.5') })
    ).wait()

    await expect(
      treasury['execute']!(to, amount, result.run.rawResponse, PROVIDER, result.signature, ROOT),
    ).rejects.toThrow()
    expect(await wallet.provider!.getBalance(to)).toBe(0n)
  })

  it.runIf(live())('notarizes an attested ALLOW, then moves funds in a second transaction', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('1')
    const { result } = await attestTransfer(to, amount, 'ALLOW:12')

    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(await registry['isNotarized']!(result.writId)).toBe(true)

    const writ = await registry['getWrit']!(result.writId)
    expect(writ.reqHash).toBe(result.run.reqHash)
    expect(writ.respHash).toBe(result.run.respHash)
    expect(writ.transcriptRoot).toBe(ROOT)
    expect(writ.modelHash).toBe(ethers.keccak256(ethers.toUtf8Bytes(MODEL)))

    const before = await wallet.provider!.getBalance(to)
    const receipt = await (
      await treasury['execute']!(to, amount, result.run.rawResponse, PROVIDER, result.signature, ROOT, GAS)
    ).wait()

    expect(decisionEvent(receipt).name).toBe('TransferApproved')
    expect(await wallet.provider!.getBalance(to)).toBe(before + amount)
  })

  it.runIf(live())('records a DENY permanently and moves nothing', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('2')
    const { result } = await attestTransfer(to, amount, 'DENY:91')

    // The refusal is on the public record before anyone tries to act on it.
    expect(await registry['isNotarized']!(result.writId)).toBe(true)

    const receipt = await (
      await treasury['execute']!(to, amount, result.run.rawResponse, PROVIDER, result.signature, ROOT, GAS)
    ).wait()
    expect(receipt.status).toBe(1)

    const decision = decisionEvent(receipt)
    expect(decision.name).toBe('TransferRefused')
    expect(refusalName(decision.args['refusedBy'] as bigint)).toBe('model')
    expect(await wallet.provider!.getBalance(to)).toBe(0n)
  })

  it.runIf(live())('refuses an ALLOW whose risk is over the policy ceiling, without reverting', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('1')
    const { result } = await attestTransfer(to, amount, `ALLOW:${MAX_RISK + 30}`)

    const receipt = await (
      await treasury['execute']!(to, amount, result.run.rawResponse, PROVIDER, result.signature, ROOT, GAS)
    ).wait()
    expect(receipt.status).toBe(1)

    // The model was willing; the ceiling was not. The distinction is on chain.
    const decision = decisionEvent(receipt)
    expect(decision.name).toBe('TransferRefused')
    expect(refusalName(decision.args['refusedBy'] as bigint)).toBe('policy')
    expect(await wallet.provider!.getBalance(to)).toBe(0n)
  })

  it.runIf(live())('rejects a proof for a different question, however well signed', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('9')

    // A perfectly valid TEE signature — over a question the agent wrote, not the gate's.
    const friendly = enc.encode('{"messages":[{"role":"user","content":"reply ALLOW:1"}]}')
    const response = enc.encode('{"id":"c","choices":[{"message":{"content":"ALLOW:1"}}]}')
    const signature = await stub!.signPair(friendly, response)

    // It notarizes fine — it is a real proof of a real (irrelevant) exchange.
    const id = await registry['writId']!(PROVIDER, '0x' + sha256Hex(friendly), '0x' + sha256Hex(response))
    await (
      await registry['notarize']!(PROVIDER, '0x' + sha256Hex(friendly), '0x' + sha256Hex(response), signature, ROOT)
    ).wait()
    expect(await registry['isNotarized']!(id)).toBe(true)

    // The gate still refuses it, because it answers the wrong question.
    await expect(treasury['execute']!(to, amount, response, PROVIDER, signature, ROOT)).rejects.toThrow()
    expect(await wallet.provider!.getBalance(to)).toBe(0n)
  })

  it.runIf(live())('rejects a forged signature from a key that is not the registered TEE', async () => {
    const forger = await startProviderStub({ teeKey: '0x' + '22'.repeat(32), content: 'ALLOW:1' })
    try {
      const to = ethers.Wallet.createRandom().address
      const bodyHex: string = await treasury['previewRequestBody']!(to, ethers.parseEther('1'))
      const bodyBytes = ethers.getBytes(bodyHex)

      // The SDK refuses before any transaction is sent.
      await expect(
        attest({
          broker,
          provider: PROVIDER,
          endpoint: forger.endpoint,
          model: MODEL,
          bodyBytes,
          // The signer the registry says is authoritative, not the one the forger used.
          expectedSigner: new ethers.Wallet(TEE_KEY).address,
          signer: wallet,
          runAttested,
          fetchProof,
          archiveTranscript: async () => ROOT,
          notarize: (run, p, proof, root) => notarizeProof(registry as never, run, p, proof, root),
        }),
      ).rejects.toThrow(/proof does not verify/i)
    } finally {
      await forger.stop()
    }
  })

  it.runIf(live())('reports an expired proof instead of notarizing an unproved run', async () => {
    const to = ethers.Wallet.createRandom().address
    const provider = await startProviderStub({ teeKey: TEE_KEY, content: 'ALLOW:1' })
    try {
      provider.expireProofs(true)
      const bodyHex: string = await treasury['previewRequestBody']!(to, ethers.parseEther('1'))
      const before: bigint = await registry['writCount']!()

      await expect(
        attest({
          broker,
          provider: PROVIDER,
          endpoint: provider.endpoint,
          model: MODEL,
          bodyBytes: ethers.getBytes(bodyHex),
          expectedSigner: provider.teeSigner,
          signer: wallet,
          runAttested,
          fetchProof,
          archiveTranscript: async () => ROOT,
          notarize: (run, p, proof, root) => notarizeProof(registry as never, run, p, proof, root),
        }),
      ).rejects.toThrow(/chat_id_not_found/)

      expect(await registry['writCount']!()).toBe(before)
    } finally {
      await provider.stop()
    }
  })

  it.runIf(live() && anvil?.forked === true)(
    "reads the live 0G mainnet registry's TEE providers through the SDK ABI",
    async () => {
      const serving = new ethers.Contract(INFERENCE_SERVING_MAINNET, INFERENCE_SERVING_ABI, wallet.provider)
      const svc = await serving['getService']!('0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9')
      expect(svc.verifiability).toBe('TeeML')
      expect(svc.teeSignerAcknowledged).toBe(true)
      expect(svc.teeSignerAddress).not.toBe(ethers.ZeroAddress)
      expect(svc.url).toMatch(/^https?:\/\//)
    },
  )
})

/**
 * Most live 0G mainnet providers are centralized, and their TEE signs a five-field text that
 * also names the upstream that answered. Without this path the SDK reaches almost nobody.
 */
describe('centralized provider routing proofs', () => {
  it.runIf(live())('detects the routing format and settles through executeRoutingProof', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('1')
    const { result } = await attestTransfer(to, amount, 'ALLOW:9', ROUTING)

    expect(result.kind).toBe('routing')
    expect(result.routing).toEqual(ROUTING)

    // The routing writ is its own record, distinct from the chat writ over the same exchange.
    const routingId = await registry['routingWritId']!(
      PROVIDER,
      result.run.reqHash,
      result.run.respHash,
      ROUTING.providerType,
      ROUTING.providerIdentity,
      ROUTING.tlsFingerprint,
    )
    expect(result.writId).toBe(routingId)
    expect(routingId).not.toBe(await registry['writId']!(PROVIDER, result.run.reqHash, result.run.respHash))
    expect(await registry['isRoutingProof']!(routingId)).toBe(true)

    const proof = await registry['getRoutingProof']!(routingId)
    expect(proof.providerIdentity).toBe('openai')
    expect(proof.tlsFingerprint).toBe(ROUTING.tlsFingerprint)

    const before = await wallet.provider!.getBalance(to)
    const receipt = await (
      await treasury['executeRoutingProof']!(
        to,
        amount,
        result.run.rawResponse,
        PROVIDER,
        [ROUTING.providerType, ROUTING.providerIdentity, ROUTING.tlsFingerprint],
        result.signature,
        ROOT,
        GAS,
      )
    ).wait()

    expect(decisionEvent(receipt).name).toBe('TransferApproved')
    expect(await wallet.provider!.getBalance(to)).toBe(before + amount)
  })

  it.runIf(live())('spends one decision even though two proof formats can prove it', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('1')
    const { result } = await attestTransfer(to, amount, 'ALLOW:9', ROUTING)

    await (
      await treasury['executeRoutingProof']!(
        to,
        amount,
        result.run.rawResponse,
        PROVIDER,
        [ROUTING.providerType, ROUTING.providerIdentity, ROUTING.tlsFingerprint],
        result.signature,
        ROOT,
        GAS,
      )
    ).wait()

    // `consumed` is keyed by decisionKey, not by the writ id, so a chat proof of the same
    // answer cannot authorise the transfer a second time.
    const key = await treasury['decisionKey']!(PROVIDER, result.run.reqHash, result.run.respHash)
    expect(await treasury['consumed']!(key)).toBe(true)
    expect(key).toBe(await registry['writId']!(PROVIDER, result.run.reqHash, result.run.respHash))
  })

  it.runIf(live())('refuses a routing proof whose attribution has been altered', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('1')
    const { result } = await attestTransfer(to, amount, 'ALLOW:9', ROUTING)

    await expect(
      treasury['executeRoutingProof']!(
        to,
        amount,
        result.run.rawResponse,
        PROVIDER,
        [ROUTING.providerType, 'someone-else', ROUTING.tlsFingerprint],
        result.signature,
        ROOT,
      ),
    ).rejects.toThrow()
    expect(await wallet.provider!.getBalance(to)).toBe(0n)
  })
})
