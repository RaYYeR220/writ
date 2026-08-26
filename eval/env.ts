/**
 * The two worlds a scenario can run in.
 *
 * `--fork` boots a local anvil forked from 0G mainnet, deploys the real contract suite onto it,
 * and answers inference from a stand-in provider that signs the exact bytes it received. It is a
 * test of our machinery. The signer is not a TEE and the answers are ours, so a fork run says
 * nothing whatsoever about a model's judgement.
 *
 * `--live` runs the identical scenarios against contracts deployed on 0G mainnet and a real 0G
 * Compute provider whose TEE key is registered in 0G's official `InferenceServing`. Only a live
 * run is an evaluation of model behaviour.
 *
 * Both are expressed behind one `EvalEnv` so `run.ts` cannot accidentally take a shortcut in one
 * mode that it does not take in the other.
 */
import { ethers } from 'ethers'
import type { ArchiveOptions, InferenceBrokerLike, Transcript } from '../sdk/src/index.js'
import {
  sha256Hex,
  INFERENCE_SERVING_ABI,
  INFERENCE_SERVING_MAINNET,
  TREASURY_GATE_ABI,
  WRIT_REGISTRY_ABI,
} from '../sdk/src/index.js'
import { ensureBuilt, buildFailure, loadArtifact } from '../sdk/test/helpers/contracts.js'
import { startAnvil, ANVIL_KEY } from '../sdk/test/helpers/anvil.js'
import { startProviderStub } from '../sdk/test/helpers/provider-stub.js'

export const MAINNET_CHAIN_ID = 16661n
export const EXPLORER = 'https://chainscan.0g.ai'

/** The demo policy's risk ceiling, and the model its question names. */
export const MODEL = '0GM-1.0-35B-A3B'
export const MAX_RISK = 50

/** A live 0G mainnet TeeML chatbot, used on the fork purely to read real registry facts. */
export const REFERENCE_TEE_PROVIDER = '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9'

/** One inference channel for one scenario. */
export type Session = {
  endpoint: string
  /** The address 0G's registry says signs for this provider. Never the provider's own claim. */
  teeSigner: string
  /**
   * Sign an arbitrary request/response pair as the TEE.
   *
   * Only a stand-in signer can do this, so probes that need it are skipped under `--live`
   * rather than quietly weakened.
   */
  signPair?: (request: Uint8Array, response: Uint8Array) => Promise<string>
  /** Present only on the fork: a stand-in provider using a key that is not the registered one. */
  forgedEndpoint?: string
  close: () => Promise<void>
}

export type EvalEnv = {
  mode: 'fork' | 'live'
  /** One line naming exactly what produced the numbers. Goes into the report verbatim. */
  label: string
  chainId: bigint
  blockNumber: number
  rpcUrl: string
  wallet: ethers.Wallet
  registry: ethers.Contract
  treasury: ethers.Contract
  registryAddress: string
  treasuryAddress: string
  servingAddress: string
  /** True when `WritRegistry` is reading 0G's real deployed registry rather than a mock. */
  servingIsLiveContract: boolean
  provider: string
  model: string
  maxRisk: number
  broker: InferenceBrokerLike
  archiveTranscript: (t: Transcript, signer: ethers.Signer, opts?: ArchiveOptions) => Promise<string>
  /** Opens a channel that will answer with `answer` on the fork, or with the model's own words live. */
  session: (answer: string) => Promise<Session>
  /**
   * A provider endpoint that signs with a key 0G's registry does not recognise.
   *
   * Absent under `--live`, because a real provider cannot be made to sign with the wrong key —
   * the control that needs it is then reported as skipped rather than quietly weakened.
   */
  forgedSession?: (answer: string) => Promise<Session>
  /** Restores the treasury to a known balance where that is possible. Returns the balance in force. */
  primeTreasury: (target: bigint) => Promise<bigint>
  /**
   * Moves the treasury's balance by paying into it, as an outsider would.
   *
   * A plain transaction rather than a cheat code, so it means the same thing in both modes: the
   * question the gate asks now reports a different balance, which is exactly what the
   * state-drift probe needs to demonstrate. Returns the balance afterwards.
   */
  depositToTreasury: (amount: bigint) => Promise<bigint>
  /** Verified statements about this environment, for the report. */
  facts: string[]
  /** Caveats about this environment, for the report. */
  caveats: string[]
  stop: () => Promise<void>
}

/** `InferenceServing`'s write surface, which the fork uses to register a provider for real. */
const SERVING_WRITE_ABI = [
  'function owner() view returns (address)',
  'function serviceExists(address provider) view returns (bool)',
  'function addOrUpdateService(tuple(string serviceType, string url, string model, string verifiability, uint256 inputPrice, uint256 outputPrice, string additionalInfo, address teeSignerAddress) params) payable',
  'function acknowledgeTEESignerByOwner(address provider)',
]

const enc = new TextEncoder()

/**
 * The transcript root the fork uses in place of a 0G Storage upload.
 *
 * There is no local storage network, and the contracts treat the root as an opaque `bytes32`
 * either way. It is the sha256 of the transcript rather than a constant so that it is at least a
 * real commitment to real content — but it is NOT a 0G Storage merkle root and the report says so.
 */
function forkTranscriptRoot(t: Transcript): string {
  return '0x' + sha256Hex(enc.encode(JSON.stringify(t)))
}

async function deploy(name: string, args: unknown[], signer: ethers.Signer): Promise<string> {
  const art = loadArtifact(name)
  if (!art.bytecode?.object) throw new Error(`artifact ${name} carries no bytecode`)
  const factory = new ethers.ContractFactory(art.abi as unknown as ethers.InterfaceAbi, art.bytecode.object, signer)
  const c = await factory.deploy(...args)
  await c.waitForDeployment()
  return await c.getAddress()
}

/**
 * Registers a provider in whichever `InferenceServing` the fork actually has.
 *
 * Preferred path: 0G's real deployed mainnet registry, reached by impersonating a provider
 * address on the fork and calling the registry's own `addOrUpdateService`, then having the
 * registry's own owner acknowledge the TEE signer. That leaves the TEE *key* as the one and only
 * substituted value — everything else, including the acknowledgement rule `WritRegistry` depends
 * on, is the real contract's logic.
 *
 * Falls back to `MockInferenceServing` only when the fork is unavailable, and says so.
 */
async function registerOnFork(
  rpc: ethers.JsonRpcProvider,
  wallet: ethers.Wallet,
  provider: string,
  teeSigner: string,
  endpointUrl: string,
  forked: boolean,
  facts: string[],
  caveats: string[],
): Promise<{ serving: string; live: boolean }> {
  if (forked) {
    try {
      const serving = new ethers.Contract(INFERENCE_SERVING_MAINNET, SERVING_WRITE_ABI, rpc)
      const owner: string = await serving['owner']!()

      const params = {
        serviceType: 'chatbot',
        url: endpointUrl,
        model: MODEL,
        verifiability: 'TeeML',
        inputPrice: 504_000_000_000n,
        outputPrice: 3_020_000_000_000n,
        additionalInfo: '{"TEEVerifier":"dstack"}',
        teeSignerAddress: teeSigner,
      }
      const iface = new ethers.Interface(SERVING_WRITE_ABI)
      const data = iface.encodeFunctionData('addOrUpdateService', [params])

      // The registry charges a provider stake. Read the amount out of its own revert rather
      // than hardcoding it, so a change on 0G's side surfaces as a different number, not a bug.
      let stake = ethers.parseEther('100')
      try {
        await rpc.call({ to: INFERENCE_SERVING_MAINNET, from: provider, data, value: 0n })
        stake = 0n
      } catch (e) {
        const raw = (e as { data?: unknown }).data
        if (typeof raw === 'string' && raw.length >= 138) stake = BigInt('0x' + raw.slice(74, 138))
      }

      await rpc.send('anvil_impersonateAccount', [provider])
      await rpc.send('anvil_setBalance', [provider, ethers.toBeHex(stake + ethers.parseEther('10'))])
      const preg = new ethers.Contract(INFERENCE_SERVING_MAINNET, SERVING_WRITE_ABI, await rpc.getSigner(provider))
      await (await preg['addOrUpdateService']!(params, { value: stake, gasLimit: 3_000_000n })).wait()

      await rpc.send('anvil_impersonateAccount', [owner])
      await rpc.send('anvil_setBalance', [owner, ethers.toBeHex(ethers.parseEther('10'))])
      const oreg = new ethers.Contract(INFERENCE_SERVING_MAINNET, SERVING_WRITE_ABI, await rpc.getSigner(owner))
      await (await oreg['acknowledgeTEESignerByOwner']!(provider, { gasLimit: 2_000_000n })).wait()

      const check = new ethers.Contract(INFERENCE_SERVING_MAINNET, INFERENCE_SERVING_ABI, rpc)
      const svc = await check['getService']!(provider)
      if (svc.verifiability !== 'TeeML' || !svc.teeSignerAcknowledged || svc.teeSignerAddress !== teeSigner) {
        throw new Error(`registration did not take: ${svc.verifiability} ack=${svc.teeSignerAcknowledged}`)
      }

      facts.push(
        `WritRegistry reads 0G's real deployed InferenceServing at ${INFERENCE_SERVING_MAINNET}; the eval provider was registered through that contract's own addOrUpdateService (${ethers.formatEther(stake)} 0G stake) and acknowledged by its own owner ${owner}.`,
      )
      caveats.push(
        'The TEE signing key is ours, not an enclave\'s. A real TEE key cannot be extracted, so on a fork it must be substituted — which is exactly why a fork run proves nothing about model behaviour.',
      )
      return { serving: INFERENCE_SERVING_MAINNET, live: true }
    } catch (e) {
      caveats.push(
        `Could not register in the live mainnet InferenceServing on the fork (${e instanceof Error ? e.message.slice(0, 160) : String(e)}); fell back to MockInferenceServing.`,
      )
    }
  }

  const mock = await deploy('MockInferenceServing', [], wallet)
  const m = new ethers.Contract(mock, ['function set(address,string,string,address,bool)'], wallet)
  await (await m['set']!(provider, MODEL, 'TeeML', teeSigner, true)).wait()
  caveats.push('WritRegistry was pointed at a MockInferenceServing, not at 0G\'s deployed registry.')
  return { serving: mock, live: false }
}

/** A local anvil fork of 0G mainnet, the real contracts on it, and a stand-in signer. */
export async function forkEnv(): Promise<EvalEnv> {
  if (!ensureBuilt()) throw new Error(`writ/contracts did not compile, so nothing can be evaluated.\n${buildFailure}`)

  const anvil = await startAnvil()
  if (!anvil) throw new Error('anvil would not start; the fork run cannot proceed')

  const facts: string[] = []
  const caveats: string[] = []

  // ethers caches every RPC result for 250ms, the account nonce included, which hands out a
  // stale nonce when two transactions go out back to back on an instant-mining chain.
  const rpc = new ethers.JsonRpcProvider(anvil.url, undefined, { cacheTimeout: -1 })
  const wallet = new ethers.Wallet(ANVIL_KEY, rpc)
  const net = await rpc.getNetwork()
  const blockNumber = await rpc.getBlockNumber()

  if (!anvil.forked) {
    caveats.push(
      'The fork RPC was unreachable, so this ran on a bare local chain with no 0G mainnet state at all. That is weaker than a fork run.',
    )
  } else {
    facts.push(`anvil forked 0G mainnet (chain ${net.chainId}) at block ${blockNumber}.`)
    try {
      const live = new ethers.Contract(INFERENCE_SERVING_MAINNET, INFERENCE_SERVING_ABI, rpc)
      const svc = await live['getService']!(REFERENCE_TEE_PROVIDER)
      facts.push(
        `Read live from that fork: provider ${REFERENCE_TEE_PROVIDER} serves "${svc.model}" with verifiability "${svc.verifiability}", TEE signer ${svc.teeSignerAddress}, acknowledged ${svc.teeSignerAcknowledged}.`,
      )
    } catch {
      caveats.push('Could not read the reference provider from the forked registry.')
    }
  }

  // A distinctive address so the report cannot be misread as naming a real 0G provider.
  const PROVIDER = '0x0000000000000000000000000000000000E7A11D'
  const TEE_KEY = '0x' + '11'.repeat(32)
  const teeSigner = new ethers.Wallet(TEE_KEY).address

  const { serving, live } = await registerOnFork(
    rpc,
    wallet,
    PROVIDER,
    teeSigner,
    'http://127.0.0.1/v1/proxy',
    anvil.forked,
    facts,
    caveats,
  )

  const registryAddress = await deploy('WritRegistry', [serving], wallet)
  const treasuryAddress = await deploy(
    'AgentTreasury',
    [registryAddress, wallet.address, wallet.address, MODEL, PROVIDER, MAX_RISK],
    wallet,
  )

  return {
    mode: 'fork',
    label: `local anvil ${anvil.forked ? 'fork of 0G mainnet' : 'chain (NOT forked)'} at block ${blockNumber}, stand-in signer`,
    chainId: net.chainId,
    blockNumber,
    rpcUrl: anvil.url,
    wallet,
    registry: new ethers.Contract(registryAddress, WRIT_REGISTRY_ABI, wallet),
    treasury: new ethers.Contract(treasuryAddress, TREASURY_GATE_ABI, wallet),
    registryAddress,
    treasuryAddress,
    servingAddress: serving,
    servingIsLiveContract: live,
    provider: PROVIDER,
    model: MODEL,
    maxRisk: MAX_RISK,
    broker: { inference: { getRequestHeaders: async () => ({ Authorization: 'Bearer app-sk-local' }) } },
    archiveTranscript: async (t) => forkTranscriptRoot(t),
    session: async (answer: string) => {
      const stub = await startProviderStub({ teeKey: TEE_KEY, content: answer })
      return {
        endpoint: stub.endpoint,
        teeSigner,
        signPair: stub.signPair,
        close: () => stub.stop(),
      }
    },
    forgedSession: async (answer: string) => {
      const stub = await startProviderStub({ teeKey: '0x' + '22'.repeat(32), content: answer })
      return { endpoint: stub.endpoint, teeSigner: stub.teeSigner, close: () => stub.stop() }
    },
    primeTreasury: async (target: bigint) => {
      await rpc.send('anvil_setBalance', [treasuryAddress, ethers.toBeHex(target)])
      return await rpc.getBalance(treasuryAddress)
    },
    depositToTreasury: async (amount: bigint) => {
      await (await wallet.sendTransaction({ to: treasuryAddress, value: amount })).wait()
      return await rpc.getBalance(treasuryAddress)
    },
    facts,
    caveats,
    stop: async () => {
      anvil.stop()
    },
  }
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`--live needs ${name}`)
  return v
}

/** 0G mainnet, deployed contracts, a real 0G Compute provider answering from inside a TEE. */
export async function liveEnv(): Promise<EvalEnv> {
  if (process.env['WRIT_LIVE_CONFIRM'] !== '1') {
    throw new Error(
      '--live moves real funds on 0G mainnet and spends real 0G on inference and storage. Set WRIT_LIVE_CONFIRM=1 to say that is intended.',
    )
  }

  const facts: string[] = []
  const caveats: string[] = []
  const rpcUrl = process.env['WRIT_RPC_URL'] ?? 'https://evmrpc.0g.ai'
  const rpc = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 })
  const wallet = new ethers.Wallet(required('WRIT_PRIVATE_KEY'), rpc)

  const net = await rpc.getNetwork()
  if (net.chainId !== MAINNET_CHAIN_ID) {
    // createZGComputeNetworkBroker silently falls back to TESTNET contract addresses on an
    // unrecognised chain, warning only through console.warn. Refuse rather than sign for the
    // wrong network.
    throw new Error(`expected 0G mainnet ${MAINNET_CHAIN_ID}, got ${net.chainId}`)
  }

  const teeProvider = required('WRIT_PROVIDER')
  const registryAddress = required('WRIT_REGISTRY')
  const treasuryAddress = required('WRIT_TREASURY')

  const serving = new ethers.Contract(INFERENCE_SERVING_MAINNET, INFERENCE_SERVING_ABI, rpc)
  const svc = await serving['getService']!(teeProvider)
  if (svc.verifiability !== 'TeeML') {
    throw new Error(`provider ${teeProvider} serves "${svc.verifiability}", not TeeML — nothing it says is attestable`)
  }
  if (!svc.teeSignerAcknowledged) throw new Error(`provider ${teeProvider} has not acknowledged its TEE signer`)
  if (svc.teeSignerAddress === ethers.ZeroAddress) throw new Error(`provider ${teeProvider} has no registered TEE signer`)

  const { createZGComputeNetworkBroker } = await import('@0gfoundation/0g-compute-ts-sdk')
  const { archiveTranscript, INDEXER_RPC_MAINNET } = await import('../sdk/src/index.js')
  const broker = await createZGComputeNetworkBroker(wallet)
  await broker.inference.acknowledgeProviderSigner(teeProvider).catch((e: Error) => {
    if (!/already acknowledged/i.test(e.message)) throw e
  })
  const { endpoint, model } = await broker.inference.getServiceMetadata(teeProvider)

  const treasury = new ethers.Contract(treasuryAddress, TREASURY_GATE_ABI, wallet)
  const policy = await treasury['getPolicy']!(await treasury['POLICY_ID']!())
  const blockNumber = await rpc.getBlockNumber()
  const indexer = process.env['WRIT_INDEXER'] ?? INDEXER_RPC_MAINNET

  facts.push(
    `0G mainnet chain ${net.chainId} at block ${blockNumber}; WritRegistry ${registryAddress}, AgentTreasury ${treasuryAddress}.`,
    `Provider ${teeProvider} serves "${svc.model}" with verifiability "${svc.verifiability}"; its TEE signer ${svc.teeSignerAddress} is acknowledged in 0G's official InferenceServing at ${INFERENCE_SERVING_MAINNET}.`,
    `Every answer below was produced by that provider's model inside its enclave and signed by that key. Transcripts were archived to 0G Storage via ${indexer}.`,
  )

  return {
    mode: 'live',
    label: `0G mainnet (chain ${net.chainId}) at block ${blockNumber}, real TEE provider ${teeProvider}`,
    chainId: net.chainId,
    blockNumber,
    rpcUrl,
    wallet,
    registry: new ethers.Contract(registryAddress, WRIT_REGISTRY_ABI, wallet),
    treasury,
    registryAddress,
    treasuryAddress,
    servingAddress: INFERENCE_SERVING_MAINNET,
    servingIsLiveContract: true,
    provider: teeProvider,
    model,
    maxRisk: Number(policy.maxRisk),
    broker,
    archiveTranscript: (t, signer, opts) =>
      archiveTranscript(t, signer, { indexerRpc: indexer, chainRpc: rpcUrl, ...(opts ?? {}) }),
    session: async () => ({
      endpoint,
      teeSigner: svc.teeSignerAddress,
      close: async () => {},
    }),
    primeTreasury: async () => await rpc.getBalance(treasuryAddress),
    depositToTreasury: async (amount: bigint) => {
      await (await wallet.sendTransaction({ to: treasuryAddress, value: amount })).wait()
      return await rpc.getBalance(treasuryAddress)
    },
    facts,
    caveats,
    stop: async () => {},
  }
}
