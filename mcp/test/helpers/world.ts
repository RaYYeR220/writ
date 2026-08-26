import { ethers } from 'ethers'
import {
  serializeTranscript,
  sha256Hex,
  signedText,
  signedTextRouting,
  type AttestedRun,
  type RoutingFields,
  type TeeProof,
  type Transcript,
} from '@writ/sdk'
import type {
  ComputeSession,
  DecodedEvent,
  GateHandle,
  Policy,
  RegistryHandle,
  ServiceInfo,
  SettleArgs,
  TreasuryState,
  TxHandle,
  WritDeps,
  WritRecord,
} from '../../src/deps.js'
import { percentOfBalance, renderQuestionFacts, type QuestionFacts } from '../../src/question.js'
import { WritStore } from '../../src/store.js'
import { parseVerdict } from '../../src/verdict.js'

const ZERO = '0x0000000000000000000000000000000000000000'
const coder = ethers.AbiCoder.defaultAbiCoder()
const ROUTING_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('writ.routingProof.v1'))

/** Fixed keys, so a failing test names the same addresses every run. */
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const TEE_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
const IMPOSTOR_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'

const pad = (tail: string): string => ethers.getAddress(`0x${tail.padStart(40, '0')}`)

export const GATE = pad('6a7e')
export const REGISTRY = pad('e615')
export const PROVIDER = pad('c0de')
export const RECIPIENT = pad('face77')
export const OTHER_GATE = pad('6a7e2')

/** `AgentTreasury`'s policy, verbatim, so the tests exercise the prompt that actually ships. */
const PROMPT_HEAD =
  '{"model":"0GM-1.0-35B-A3B","temperature":0,"messages":[{"role":"system","content":"You are a treasury risk gate. You are given a proposed transfer and facts about the treasury as key=value pairs, all amounts in wei. amountPctOfBalance is the transfer as a percentage of the current balance, so over 100 means the treasury cannot cover it. recipientPriorPayments and recipientPriorTotal are what this treasury has already sent that address. Weigh the size of the transfer against the balance, how familiar the recipient is, and the recipient itself. Reply with exactly ALLOW:<0-100> or DENY:<0-100>, the number being your risk score, and nothing else."},{"role":"user","content":"Approve this transfer? '
const PROMPT_TAIL = '"}]}'

export type ProofMode = 'valid' | 'unavailable' | 'wrong-key' | 'wrong-question' | 'garbled-text'
export type TranscriptMode = 'available' | 'missing' | 'tampered'

export type WorldOptions = {
  /** The assistant content the provider answers with. */
  answer?: string
  maxRisk?: number
  model?: string
  verifiability?: string
  teeSignerAcknowledged?: boolean
  /** Set to make the TEE sign the five-field routing text a centralized provider signs. */
  routing?: RoutingFields
  proofMode?: ProofMode
  transcriptMode?: TranscriptMode
  /** Leave false to make the gate mine a transaction that says nothing about the outcome. */
  emitDecisionEvent?: boolean
  allowedProvider?: string
  allowedModelHash?: string
  registryAddress?: string
  /** What the treasury holds before anything settles. */
  treasuryBalance?: bigint
  /** Force the gate call itself to revert. */
  settleRevert?: { name: string; args: unknown[] }
}

function revert(name: string, args: unknown[]): Error {
  const e = new Error(`execution reverted: ${name}`) as Error & { revert: { name: string; args: unknown[] } }
  e.revert = { name, args }
  return e
}

function randomHash(): string {
  return ethers.hexlify(ethers.randomBytes(32))
}

export type World = {
  deps: WritDeps
  agent: ethers.Wallet
  tee: ethers.Wallet
  options: Required<Pick<WorldOptions, 'answer' | 'maxRisk' | 'model'>> & WorldOptions
  nonce: bigint
  /** Every transcript that reached the archive step. */
  archived: Transcript[]
  /** Every proof the registry accepted. */
  notarized: string[]
  /** Every gate settlement that was actually sent. */
  settled: Array<SettleArgs & { kind: 'chat' | 'routing' }>
  /** Bytes 0G Storage is pretending to hold, keyed by root. */
  storage: Map<string, Uint8Array>
  writIdOf(provider: string, reqHash: string, respHash: string): string
  /** Marks a decision key spent, as a settlement through the other proof format would. */
  spend(decisionKey: string): void
  /** The nine facts the gate would pin right now. */
  factsFor(to: string, amountWei: bigint): QuestionFacts
  buildRequestBody(to: string, amountWei: bigint): Uint8Array
  /** A stranger pays into the treasury, moving the question without this gate doing anything. */
  deposit(amountWei: bigint): void
  balance: bigint
  /** Puts a valid writ on chain without going through writ_attest. */
  seedWrit(o: { to: string; amountWei: bigint; answer?: string }): Promise<{ writId: string; transcriptRoot: string }>
}

/**
 * A complete stand-in for the chain, 0G Compute and 0G Storage.
 *
 * The parts that matter are real: the TEE signs with a real secp256k1 key, the registry
 * recovers that signature and refuses a proof that does not match, and the gate builds its
 * nine-fact question out of its own live state — balance, decision counts, recipient history —
 * and rebuilds it at settlement time, exactly as `TreasuryGate` does. What is faked is only the
 * transport: no RPC, no funds, no provider.
 */
export function makeWorld(opts: WorldOptions = {}): World {
  const options = {
    answer: 'ALLOW:12',
    maxRisk: 40,
    model: '0GM-1.0-35B-A3B',
    verifiability: 'TeeML',
    teeSignerAcknowledged: true,
    proofMode: 'valid' as ProofMode,
    transcriptMode: 'available' as TranscriptMode,
    emitDecisionEvent: true,
    ...opts,
  }

  const agent = new ethers.Wallet(AGENT_KEY)
  const tee = new ethers.Wallet(TEE_KEY)
  const impostor = new ethers.Wallet(IMPOSTOR_KEY)

  const modelHash = ethers.keccak256(ethers.toUtf8Bytes(options.model))
  const policy: Policy = {
    promptHead: ethers.hexlify(ethers.toUtf8Bytes(PROMPT_HEAD)),
    promptTail: ethers.hexlify(ethers.toUtf8Bytes(PROMPT_TAIL)),
    allowedModelHash: options.allowedModelHash ?? modelHash,
    allowedProvider: options.allowedProvider ?? PROVIDER,
    maxRisk: options.maxRisk,
  }

  const service: ServiceInfo = {
    provider: PROVIDER,
    url: 'https://provider.test',
    model: options.model,
    verifiability: options.verifiability,
    teeSignerAddress: tee.address,
    teeSignerAcknowledged: options.teeSignerAcknowledged,
  }

  const writs = new Map<string, WritRecord>()
  const routingProofs = new Map<string, RoutingFields>()
  const consumed = new Set<string>()
  const storage = new Map<string, Uint8Array>()
  const proofs = new Map<string, TeeProof>()
  const archived: Transcript[] = []
  const notarized: string[] = []
  const settled: Array<SettleArgs & { kind: 'chat' | 'routing' }> = []

  /** Everything `TreasuryGate` reports about itself. */
  const state = {
    nonce: 0n,
    balance: options.treasuryBalance ?? ethers.parseEther('10'),
    approvedCount: 0n,
    refusedCount: 0n,
    history: new Map<string, { payments: bigint; total: bigint }>(),
  }
  let chatCounter = 0

  const historyOf = (to: string): { payments: bigint; total: bigint } =>
    state.history.get(to.toLowerCase()) ?? { payments: 0n, total: 0n }

  const writIdOf = (p: string, r: string, s: string): string =>
    ethers.keccak256(coder.encode(['address', 'bytes32', 'bytes32'], [p, r, s]))

  const routingWritIdOf = (p: string, r: string, s: string, f: RoutingFields): string =>
    ethers.keccak256(
      coder.encode(
        ['bytes32', 'address', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        [
          ROUTING_DOMAIN,
          p,
          r,
          s,
          ethers.keccak256(ethers.toUtf8Bytes(f.providerType)),
          ethers.keccak256(ethers.toUtf8Bytes(f.providerIdentity)),
          f.tlsFingerprint,
        ],
      ),
    )

  // ------------------------------------------------------------------ the gate's own question

  /** `TreasuryGate.buildParams`, from this gate's live state. */
  function factsFor(to: string, amountWei: bigint): QuestionFacts {
    const h = historyOf(to)
    return {
      recipient: to.toLowerCase(),
      amount: amountWei.toString(),
      nonce: state.nonce.toString(),
      treasuryBalance: state.balance.toString(),
      amountPctOfBalance: percentOfBalance(amountWei, state.balance).toString(),
      priorApprovals: state.approvedCount.toString(),
      priorRefusals: state.refusedCount.toString(),
      recipientPriorPayments: h.payments.toString(),
      recipientPriorTotal: h.total.toString(),
    }
  }

  function buildRequestBody(to: string, amountWei: bigint): Uint8Array {
    return ethers.toUtf8Bytes(PROMPT_HEAD + renderQuestionFacts(factsFor(to, amountWei)) + PROMPT_TAIL)
  }

  function responseFor(chatId: string, answer: string): Uint8Array {
    return ethers.toUtf8Bytes(
      `{"id":"${chatId}","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"${answer}"},"finish_reason":"stop"}]}`,
    )
  }

  // --------------------------------------------------------------------------- the registry

  function record(
    id: string,
    provider: string,
    reqHash: string,
    respHash: string,
    transcriptRoot: string,
    signature: string,
    text: string,
  ): void {
    if (writs.has(id)) throw revert('AlreadyNotarized', [id])
    if (!service.teeSignerAcknowledged) throw revert('SignerNotAcknowledged', [provider])
    if (service.verifiability !== 'TeeML') throw revert('NotTeeVerifiable', [provider, service.verifiability])

    let recovered: string
    try {
      recovered = ethers.recoverAddress(ethers.hashMessage(text), signature)
    } catch {
      throw revert('ECDSAInvalidSignature', [])
    }
    if (recovered.toLowerCase() !== service.teeSignerAddress.toLowerCase()) {
      throw revert('BadSignature', [recovered, service.teeSignerAddress])
    }

    writs.set(id, {
      provider,
      modelHash,
      reqHash,
      respHash,
      transcriptRoot,
      notarizedAt: 1_780_000_000n,
      notarizedBy: agent.address,
    })
    notarized.push(id)
  }

  function fakeTx(events: DecodedEvent[]): TxHandle {
    const hash = randomHash()
    return {
      hash,
      wait: async () => ({ hash, status: 1, logs: events.map((e) => ({ __event: e })) }),
    }
  }

  const registry: RegistryHandle = {
    address: options.registryAddress ?? REGISTRY,
    writId: async (p, r, s) => writIdOf(p, r, s),
    routingWritId: async (p, r, s, providerType, providerIdentity, tlsFingerprint) =>
      routingWritIdOf(p, r, s, { providerType, providerIdentity, tlsFingerprint }),
    isNotarized: async (id) => writs.has(id),
    isRoutingProof: async (id) => routingProofs.has(id),
    getWrit: async (id) => {
      const w = writs.get(id)
      if (!w) throw revert('NotNotarized', [id])
      return w
    },
    getRoutingProof: async (id) => {
      const p = routingProofs.get(id)
      if (!p) throw revert('NotARoutingProof', [id])
      return p
    },
    notarize: async (provider, reqHash, respHash, signature, transcriptRoot) => {
      const id = writIdOf(provider, reqHash, respHash)
      record(id, provider, reqHash, respHash, transcriptRoot, signature, signedText(reqHash, respHash))
      return fakeTx([]) as never
    },
    notarizeRoutingProof: async (
      provider,
      reqHash,
      respHash,
      providerType,
      providerIdentity,
      tlsFingerprint,
      signature,
      transcriptRoot,
    ) => {
      const f: RoutingFields = { providerType, providerIdentity, tlsFingerprint }
      const id = routingWritIdOf(provider, reqHash, respHash, f)
      record(id, provider, reqHash, respHash, transcriptRoot, signature, signedTextRouting(reqHash, respHash, f))
      routingProofs.set(id, f)
      return fakeTx([]) as never
    },
  }

  // ------------------------------------------------------------------------------- the gate

  /** Mirrors `PolicyGate._consume` + `TreasuryGate._settle`, including who refuses and why. */
  function settle(a: SettleArgs, routing?: RoutingFields): TxHandle {
    if (options.settleRevert) throw revert(options.settleRevert.name, options.settleRevert.args)
    if (a.to === ZERO) throw revert('ZeroRecipient', [])

    if (policy.allowedProvider !== ZERO && policy.allowedProvider.toLowerCase() !== a.provider.toLowerCase()) {
      throw revert('ProviderNotAllowed', [a.provider, policy.allowedProvider])
    }

    // The question is rebuilt here, from state as it stands now — which is exactly why a proof
    // goes stale when anything about the treasury moves.
    const body = buildRequestBody(a.to, a.amountWei)
    const reqHash = '0x' + sha256Hex(body)
    const respHash = '0x' + sha256Hex(a.rawResponse)

    const decision = writIdOf(a.provider, reqHash, respHash)
    if (consumed.has(decision)) throw revert('WritAlreadyConsumed', [decision])

    const id = routing ? routingWritIdOf(a.provider, reqHash, respHash, routing) : decision
    if (!writs.has(id)) {
      record(
        id,
        a.provider,
        reqHash,
        respHash,
        a.transcriptRoot,
        a.signature,
        routing ? signedTextRouting(reqHash, respHash, routing) : signedText(reqHash, respHash),
      )
      if (routing) routingProofs.set(id, routing)
    }

    const w = writs.get(id)!
    if (w.modelHash !== policy.allowedModelHash) {
      throw revert('ModelNotAllowed', [w.modelHash, policy.allowedModelHash])
    }

    const parsed = parseVerdict(a.rawResponse)
    if (!parsed.ok) throw revert(parsed.reason, [])

    consumed.add(decision)
    state.nonce += 1n
    settled.push({ ...a, kind: routing ? 'routing' : 'chat' })

    const refused = !parsed.allowed || parsed.risk > policy.maxRisk
    if (refused) {
      state.refusedCount += 1n
    } else {
      if (state.balance < a.amountWei) throw revert('TransferFailed', [a.to, a.amountWei])
      state.approvedCount += 1n
      const h = historyOf(a.to)
      state.history.set(a.to.toLowerCase(), { payments: h.payments + 1n, total: h.total + a.amountWei })
      state.balance -= a.amountWei
    }

    if (!options.emitDecisionEvent) return fakeTx([])

    const risk = BigInt(parsed.risk)
    if (!parsed.allowed) {
      return fakeTx([
        { name: 'TransferRefused', args: { to: a.to, amount: a.amountWei, risk, refusedBy: 1n, writId: id } },
      ])
    }
    if (parsed.risk > policy.maxRisk) {
      return fakeTx([
        { name: 'TransferRefused', args: { to: a.to, amount: a.amountWei, risk, refusedBy: 2n, writId: id } },
      ])
    }
    return fakeTx([{ name: 'TransferApproved', args: { to: a.to, amount: a.amountWei, risk, writId: id } }])
  }

  const gate: GateHandle = {
    address: GATE,
    registryAddress: async () => registry.address,
    agent: async () => agent.address,
    nonce: async () => state.nonce,
    policy: async () => policy,
    treasuryState: async (recipient): Promise<TreasuryState> => ({
      balance: state.balance,
      nonce: state.nonce,
      approvedCount: state.approvedCount,
      refusedCount: state.refusedCount,
      recipient: historyOf(recipient),
    }),
    previewRequestBody: async (to, amountWei) => buildRequestBody(to, amountWei),
    decisionKey: async (p, r, s) => writIdOf(p, r, s),
    consumed: async (key) => consumed.has(key),
    execute: async (a) => settle(a),
    executeRoutingProof: async (a) => settle(a, a.routing),
    parseLog: (log) => (log as { __event?: DecodedEvent }).__event ?? null,
  }

  // -------------------------------------------------------------- compute, proofs, storage

  async function proofFor(chatId: string, reqHash: string, respHash: string): Promise<TeeProof> {
    const routing = options.routing
    const text = routing ? signedTextRouting(reqHash, respHash, routing) : signedText(reqHash, respHash)

    if (options.proofMode === 'wrong-key') {
      return { text, signature: await impostor.signMessage(text), ...(routing ? { routing } : {}) }
    }
    if (options.proofMode === 'wrong-question') {
      // A perfectly valid signature by the real TEE key — over a different question.
      const other = signedText(randomHash(), respHash)
      return { text: other, signature: await tee.signMessage(other) }
    }
    if (options.proofMode === 'garbled-text') {
      const broken = `${text}:extra:fields:here:and:more`
      return { text: broken, signature: await tee.signMessage(broken) }
    }
    return { text, signature: await tee.signMessage(text), ...(routing ? { routing } : {}) }
  }

  const runAttested = async (o: {
    provider: string
    endpoint: string
    bodyBytes: Uint8Array
  }): Promise<AttestedRun> => {
    const chatId = `chat-${++chatCounter}`
    const rawResponse = responseFor(chatId, options.answer)
    const reqHash = '0x' + sha256Hex(o.bodyBytes)
    const respHash = '0x' + sha256Hex(rawResponse)
    proofs.set(chatId, await proofFor(chatId, reqHash, respHash))
    return { chatId, rawRequest: o.bodyBytes, rawResponse, reqHash, respHash }
  }

  const fetchProof = async (_endpoint: string, chatId: string): Promise<TeeProof> => {
    if (options.proofMode === 'unavailable') {
      throw new Error(
        'proof unavailable (404 Not Found): {"error":"prepare HTTP request: Chat id not found or expired, chat_id_not_found"}',
      )
    }
    const p = proofs.get(chatId)
    if (!p) throw new Error(`no proof for chat ${chatId}`)
    return p
  }

  const archive = async (t: Transcript): Promise<string> => {
    const bytes = serializeTranscript(t)
    const root = ethers.keccak256(bytes)
    storage.set(root.toLowerCase(), bytes)
    archived.push(t)
    return root
  }

  const downloadTranscript = async (root: string): Promise<Uint8Array> => {
    if (options.transcriptMode === 'missing') {
      throw new Error(`0G Storage could not return transcript ${root}: file not found`)
    }
    const bytes = storage.get(root.toLowerCase())
    if (!bytes) throw new Error(`0G Storage could not return transcript ${root}: file not found`)
    if (options.transcriptMode === 'tampered') {
      const t = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
      t['response'] = String(t['response']).replace('DENY', 'ALLOW').replace('ALLOW:12', 'ALLOW:1')
      return ethers.toUtf8Bytes(JSON.stringify(t, null, 2))
    }
    return bytes
  }

  const computeSession = async (): Promise<ComputeSession> => ({
    broker: { inference: { getRequestHeaders: async () => ({ Authorization: 'Bearer app-sk-test' }) } },
    endpoint: 'https://provider.test/v1/proxy',
    model: options.model,
  })

  const deps: WritDeps = {
    chainId: async () => 16661n,
    explorer: 'https://chainscan.0g.ai',
    agentAddress: async () => agent.address,
    gate: (address) => {
      if (address.toLowerCase() !== GATE.toLowerCase()) {
        return { ...gate, address: ethers.getAddress(address) }
      }
      return gate
    },
    registry: () => registry,
    configuredRegistry: () => registry.address,
    getService: async (p) => {
      if (p.toLowerCase() !== PROVIDER.toLowerCase()) throw new Error(`no service registered for ${p}`)
      return service
    },
    computeSession,
    fallbackProvider: () => undefined,
    downloadTranscript,
    pipeline: {
      runAttested,
      fetchProof,
      archiveTranscript: (t) => archive(t),
      storageSigner: async () => agent,
    },
    store: new WritStore(),
  }

  /** Puts a valid writ on chain and in 0G Storage without going through the tools. */
  async function seedWrit(o: {
    to: string
    amountWei: bigint
    answer?: string
  }): Promise<{ writId: string; transcriptRoot: string }> {
    const chatId = `seed-${++chatCounter}`
    const body = buildRequestBody(o.to, o.amountWei)
    const rawResponse = responseFor(chatId, o.answer ?? options.answer)
    const reqHash = '0x' + sha256Hex(body)
    const respHash = '0x' + sha256Hex(rawResponse)
    const proof = await proofFor(chatId, reqHash, respHash)

    const transcript: Transcript = {
      chatId,
      provider: PROVIDER,
      model: options.model,
      request: new TextDecoder().decode(body),
      response: new TextDecoder().decode(rawResponse),
      reqHash,
      respHash,
      signedText: proof.text,
      signature: proof.signature,
      signingAddress: tee.address,
      ...(options.routing ? { routing: options.routing } : {}),
      capturedAt: '2026-08-26T12:00:00.000Z',
    }
    const transcriptRoot = await archive(transcript)

    const writId = options.routing
      ? routingWritIdOf(PROVIDER, reqHash, respHash, options.routing)
      : writIdOf(PROVIDER, reqHash, respHash)

    record(writId, PROVIDER, reqHash, respHash, transcriptRoot, proof.signature, proof.text)
    if (options.routing) routingProofs.set(writId, options.routing)

    return { writId, transcriptRoot }
  }

  return {
    deps,
    agent,
    tee,
    options,
    get nonce() {
      return state.nonce
    },
    set nonce(v: bigint) {
      state.nonce = v
    },
    get balance() {
      return state.balance
    },
    archived,
    notarized,
    settled,
    storage,
    writIdOf,
    spend: (decisionKey: string) => {
      consumed.add(decisionKey)
    },
    factsFor,
    buildRequestBody,
    deposit: (amountWei: bigint) => {
      state.balance += amountWei
    },
    seedWrit,
  }
}
