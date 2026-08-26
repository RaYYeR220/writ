import type {
  AttestedRun,
  InferenceBrokerLike,
  RoutingFields,
  TeeProof,
  Transcript,
  WritRegistryContract,
} from '@writ/sdk'
import type { WritStore } from './store.js'

/** `PolicyGate.Policy`, as read back from a deployed gate. */
export type Policy = {
  /** Hex, `0x`-prefixed. */
  promptHead: string
  promptTail: string
  allowedModelHash: string
  /** `address(0)` means the gate accepts any acknowledged TeeML provider. */
  allowedProvider: string
  maxRisk: number
}

/** The fields of 0G's `InferenceServing.getService` that decide whether a proof can exist. */
export type ServiceInfo = {
  provider: string
  url: string
  model: string
  verifiability: string
  teeSignerAddress: string
  teeSignerAcknowledged: boolean
}

/** `WritRegistry.Writ`. */
export type WritRecord = {
  provider: string
  modelHash: string
  reqHash: string
  respHash: string
  transcriptRoot: string
  notarizedAt: bigint
  notarizedBy: string
}

export type DecodedEvent = { name: string; args: Record<string, unknown> }

export type TxReceiptLike = {
  hash: string
  status: number | null
  logs: readonly unknown[]
}

export type TxHandle = {
  hash: string
  wait(): Promise<TxReceiptLike | null>
}

export type SettleArgs = {
  to: string
  amountWei: bigint
  rawResponse: Uint8Array
  provider: string
  signature: string
  transcriptRoot: string
}

/**
 * The slice of a deployed `TreasuryGate` these tools touch, declared structurally so the whole
 * server can be driven without a chain.
 */
export type GateHandle = {
  address: string
  registryAddress(): Promise<string>
  agent(): Promise<string>
  nonce(): Promise<bigint>
  policy(): Promise<Policy>
  /** The exact bytes the contract will pin. Never rebuilt client-side. */
  previewRequestBody(to: string, amountWei: bigint): Promise<Uint8Array>
  decisionKey(provider: string, reqHash: string, respHash: string): Promise<string>
  consumed(key: string): Promise<boolean>
  execute(args: SettleArgs): Promise<TxHandle>
  executeRoutingProof(args: SettleArgs & { routing: RoutingFields }): Promise<TxHandle>
  /** Decodes one receipt log into a named event, or null when it is not this gate's. */
  parseLog(log: unknown): DecodedEvent | null
}

export type RegistryHandle = WritRegistryContract & {
  address: string
  /** Rejects with `NotNotarized` when the id has never been recorded. */
  getWrit(id: string): Promise<WritRecord>
  isRoutingProof(id: string): Promise<boolean>
  getRoutingProof(id: string): Promise<RoutingFields>
}

/** What 0G Compute hands back once a provider is acknowledged and the ledger can pay. */
export type ComputeSession = {
  broker: InferenceBrokerLike
  /** `<serviceUrl>/v1/proxy`. */
  endpoint: string
  model: string
}

/**
 * Everything the four tools need from the outside world.
 *
 * The live implementation lives in `runtime.ts`; the tests supply a fake with the same shape,
 * so the verification and ordering rules are exercised for real without a chain, a funded
 * compute ledger, or a provider.
 */
export type WritDeps = {
  chainId(): Promise<bigint>
  /** Block explorer base URL, for links in tool output. */
  explorer: string
  /** The address that signs notarizations and gate calls. */
  agentAddress(): Promise<string>
  gate(address: string): GateHandle
  registry(address: string): RegistryHandle
  /** `WRIT_REGISTRY`, for the tools that have no gate to read it from. */
  configuredRegistry(): string
  getService(provider: string): Promise<ServiceInfo>
  /** Builds the compute broker and resolves the provider's endpoint and model. */
  computeSession(provider: string): Promise<ComputeSession>
  /** `WRIT_PROVIDER`, used only when a gate's policy allows any provider. */
  fallbackProvider(): string | undefined
  /** Downloads an archived transcript from 0G Storage and checks its merkle root. */
  downloadTranscript(root: string): Promise<Uint8Array>
  pipeline: {
    runAttested(o: {
      broker: InferenceBrokerLike
      provider: string
      endpoint: string
      bodyBytes: Uint8Array
    }): Promise<AttestedRun>
    fetchProof(endpoint: string, chatId: string, model: string): Promise<TeeProof>
    archiveTranscript(t: Transcript, signer: unknown, opts?: unknown): Promise<string>
    /** The signer that pays for the 0G Storage upload. */
    storageSigner(): Promise<unknown>
  }
  store: WritStore
}
