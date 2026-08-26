import { describe, it, expect, afterAll } from 'vitest'
import { ethers } from 'ethers'
import {
  attest,
  fetchProof,
  notarize,
  runAttested,
  sha256Hex,
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
const enc = new TextEncoder()

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

/** Runs the pipeline for one transfer and returns everything needed to settle it. */
async function attestTransfer(to: string, amount: bigint, content: string) {
  const provider = await startProviderStub({ teeKey: TEE_KEY, content })
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
        notarize: (run, p, sig, root) => notarize(registry as never, run, p, sig, root),
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
    expect(text).toContain('nonce=')
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
      await treasury['execute']!(to, amount, result.run.rawResponse, PROVIDER, result.signature, ROOT)
    ).wait()

    const events = receipt.logs
      .map((l: ethers.Log) => {
        try {
          return treasury.interface.parseLog(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    expect(events.map((e: ethers.LogDescription) => e.name)).toContain('TransferApproved')
    expect(await wallet.provider!.getBalance(to)).toBe(before + amount)
  })

  it.runIf(live())('records a DENY permanently and moves nothing', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('2')
    const { result } = await attestTransfer(to, amount, 'DENY:91')

    // The refusal is on the public record before anyone tries to act on it.
    expect(await registry['isNotarized']!(result.writId)).toBe(true)

    const receipt = await (
      await treasury['execute']!(to, amount, result.run.rawResponse, PROVIDER, result.signature, ROOT)
    ).wait()
    expect(receipt.status).toBe(1)

    const names = receipt.logs
      .map((l: ethers.Log) => {
        try {
          return treasury.interface.parseLog(l)?.name
        } catch {
          return null
        }
      })
      .filter(Boolean)
    expect(names).toContain('TransferRefused')
    expect(names).not.toContain('TransferApproved')
    expect(await wallet.provider!.getBalance(to)).toBe(0n)
  })

  it.runIf(live())('refuses an ALLOW whose risk is over the policy ceiling, without reverting', async () => {
    const to = ethers.Wallet.createRandom().address
    const amount = ethers.parseEther('1')
    const { result } = await attestTransfer(to, amount, `ALLOW:${MAX_RISK + 30}`)

    const receipt = await (
      await treasury['execute']!(to, amount, result.run.rawResponse, PROVIDER, result.signature, ROOT)
    ).wait()
    expect(receipt.status).toBe(1)
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
          notarize: (run, p, sig, root) => notarize(registry as never, run, p, sig, root),
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
          notarize: (run, p, sig, root) => notarize(registry as never, run, p, sig, root),
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
