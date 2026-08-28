/**
 * Can a contract bind a request to this provider? One command, one cheap request, one answer.
 *
 *   pnpm tsx examples/check-provider.ts 0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D
 *   pnpm tsx examples/check-provider.ts 0x7DCF… --json
 *
 * 0G's broker rewrites certain request fields before forwarding them upstream and signs the
 * translated body — `0gfoundation/0g-serving-broker`, `docs/design/request-translation.md`. Where
 * it does, no contract can reproduce the hash the enclave signed, and a Writ gate pinned to that
 * provider can never settle. Where it does not, the body passes through untouched and the whole
 * prompt-swap defence works. Which one you have is a property of the provider, and this measures
 * it instead of assuming it.
 *
 * It sends one minimal request — `model` and `messages`, nothing the broker is documented to
 * translate — so it costs a few tokens of your 0G compute balance and a gas-only acknowledgement
 * transaction the first time you use a provider.
 *
 * Required environment:
 *   WRIT_PRIVATE_KEY   a key with a funded 0G compute ledger
 * Optional:
 *   WRIT_RPC_URL       default https://evmrpc.0g.ai
 *   WRIT_PROBE         the user message to send, default "ping"
 *
 * Exit codes, so this can gate a deploy script:
 *   0  passthrough    — on-chain request binding works here
 *   1  response-only  — the provider translates; a gate pinned to it can never settle
 *   2  unusable       — the check could not be completed, and says why
 */
import { ethers } from 'ethers'
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk'
import {
  checkProviderPassthrough,
  probeRequestBody,
  INFERENCE_SERVING_ABI,
  INFERENCE_SERVING_MAINNET,
  INFERENCE_SERVING_GALILEO,
  type PassthroughReport,
} from '../src/index.js'

const MAINNET_CHAIN_ID = 16661n
const GALILEO_CHAIN_ID = 16602n

const args = process.argv.slice(2)
const json = args.includes('--json')
const provider = args.find((a) => !a.startsWith('--'))

if (!provider || !/^0x[0-9a-fA-F]{40}$/.test(provider)) {
  console.error('usage: pnpm tsx examples/check-provider.ts <provider address> [--json]')
  process.exit(2)
}

const key = process.env['WRIT_PRIVATE_KEY'] ?? process.env['DEPLOYER_PRIVATE_KEY']
if (!key) {
  console.error('set WRIT_PRIVATE_KEY to a key with a funded 0G compute ledger')
  process.exit(2)
}

const RPC = process.env['WRIT_RPC_URL'] ?? 'https://evmrpc.0g.ai'
const rpc = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 })
const wallet = new ethers.Wallet(key, rpc)

const net = await rpc.getNetwork()
// createZGComputeNetworkBroker silently falls back to testnet addresses on an unrecognised
// chain, so a wrong RPC would otherwise produce a confident verdict about the wrong network.
if (net.chainId !== MAINNET_CHAIN_ID && net.chainId !== GALILEO_CHAIN_ID) {
  console.error(`chain ${net.chainId} is neither 0G mainnet (${MAINNET_CHAIN_ID}) nor Galileo (${GALILEO_CHAIN_ID})`)
  process.exit(2)
}
const servingAddress = net.chainId === MAINNET_CHAIN_ID ? INFERENCE_SERVING_MAINNET : INFERENCE_SERVING_GALILEO

const serving = new ethers.Contract(servingAddress, INFERENCE_SERVING_ABI, rpc)
const svc = await serving['getService']!(provider)

const service = {
  model: String(svc.model),
  verifiability: String(svc.verifiability),
  teeSignerAddress: String(svc.teeSignerAddress),
  teeSignerAcknowledged: Boolean(svc.teeSignerAcknowledged),
}

const broker = await createZGComputeNetworkBroker(wallet)

// A gas-only transaction, once per provider per account. Nothing is spent from the compute
// ledger by it, and it is what lets the broker mint the billing header below.
if (service.verifiability === 'TeeML' && service.teeSignerAcknowledged) {
  await broker.inference.acknowledgeProviderSigner(provider).catch((e: Error) => {
    if (!/already acknowledged/i.test(e.message)) throw e
  })
}

const report = await checkProviderPassthrough({
  broker,
  provider,
  service,
  ...(process.env['WRIT_PROBE'] ? { probe: process.env['WRIT_PROBE'] } : {}),
})

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  print(report)
}

process.exit(report.status === 'passthrough' ? 0 : report.status === 'response-only' ? 1 : 2)

function print(r: PassthroughReport): void {
  const probe = new TextDecoder().decode(probeRequestBody(r.model, process.env['WRIT_PROBE'] ?? 'ping'))

  console.log(`provider       ${r.provider}`)
  console.log(`model          ${r.model}`)
  console.log(`verifiability  ${service.verifiability}, signer ${service.teeSignerAddress}`)
  console.log(`registry       ${servingAddress} on chain ${net.chainId}`)
  console.log(`measured       ${r.measuredAt}`)

  if (r.evidence) {
    console.log(`\nprobe          ${probe.length} bytes — nothing the broker is documented to translate`)
    console.log(probe)

    console.log('\n                 ours                                                             the TEE signed')
    console.log(
      `request          ${bare(r.evidence.sentRequestHash)}  ${bare(r.evidence.signedRequestHash)}  ${mark(r.evidence.requestMatches)}`,
    )
    console.log(
      `response         ${bare(r.evidence.receivedResponseHash)}  ${bare(r.evidence.signedResponseHash)}  ${mark(r.evidence.responseMatches)}`,
    )
    console.log(`\nsigned text    ${r.evidence.signedText}`)
    console.log(`format         ${r.evidence.kind}`)
    console.log(`signature      ${r.evidence.signatureVerified ? 'recovers to the registered TEE signer' : 'DOES NOT recover to the registered TEE signer'}`)
  }

  console.log(`\nVERDICT  ${r.status.toUpperCase()}`)
  console.log(wrap(r.detail, 88))
}

function bare(hash: string): string {
  return hash.startsWith('0x') ? hash.slice(2) : hash
}

function mark(ok: boolean): string {
  return ok ? 'match' : 'DIFFER'
}

function wrap(text: string, width: number): string {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > width) {
      out.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) out.push(line)
  return out.join('\n')
}
