import type { ContractTransactionResponse, DeferredTopicFilter, EventLog, Log } from 'ethers'

/**
 * Typed views onto the contracts this app reads.
 *
 * `ethers.Contract` is an index-signature object, so every method comes back as
 * `ContractMethod | undefined` and every call site has to assert. Naming the surface once, here,
 * buys real argument and return types at every call site instead — and doubles as the list of
 * exactly which contract functions this app depends on, which is a short and checkable list.
 */

export type Queryable = {
  queryFilter(
    filter: DeferredTopicFilter,
    fromBlock?: number,
    toBlock?: number,
  ): Promise<(Log | EventLog)[]>
}

/**
 * `WritRegistry.Writ`, as ethers decodes the tuple.
 *
 * Six fields, and the order is load-bearing — `test/abi.test.ts` pins it against the Solidity
 * struct and against the app's own decoder, because a positional read of the wrong shape does
 * not throw, it captions the wrong value.
 */
export type RawWrit = readonly [string, string, string, string, bigint, string]

/** `WritRegistry.RoutingProof`. */
export type RawRouting = readonly [string, string, string]

/** `WritRegistry.transcriptRootAt` — the candidate, and whose claim it is. */
export type RawTranscriptRootAt = readonly [string, string]

/** `PolicyGate.Policy`. */
export type RawPolicy = readonly [string, string, string, string, bigint]

/** `IInferenceServing.Service`. */
export type RawService = readonly [
  string, // provider
  string, // serviceType
  string, // url
  bigint, // inputPrice
  bigint, // outputPrice
  bigint, // updatedAt
  string, // model
  string, // verifiability
  string, // additionalInfo
  string, // teeSignerAddress
  boolean, // teeSignerAcknowledged
]

export type RegistryContract = Queryable & {
  readonly target: string
  getWrit(id: string): Promise<RawWrit>
  getRoutingProof(id: string): Promise<RawRouting>
  isNotarized(id: string): Promise<boolean>
  isRoutingProof(id: string): Promise<boolean>
  writCount(): Promise<bigint>
  /** Every archive pointer anyone has published for this writ, in submission order. */
  transcriptRoots(id: string): Promise<string[]>
  transcriptRootCount(id: string): Promise<bigint>
  transcriptRootAt(id: string, index: bigint): Promise<RawTranscriptRootAt>
  /** Who published a candidate; the zero address when it is not listed. */
  transcriptSubmitter(id: string, root: string): Promise<string>
  filters: {
    Notarized(id?: string | null, provider?: string | null): DeferredTopicFilter
    RoutingProofNotarized(id?: string | null): DeferredTopicFilter
    TranscriptAdded(id?: string | null, root?: string | null): DeferredTopicFilter
  }
}

export type GateContract = Queryable & {
  readonly target: string
  agent(): Promise<string>
  owner(): Promise<string>
  registry(): Promise<string>
  nonce(): Promise<bigint>
  approvedCount(): Promise<bigint>
  refusedCount(): Promise<bigint>
  lastAttestationAt(): Promise<bigint>
  recoveryAvailableAt(): Promise<bigint>
  RECOVERY_DELAY(): Promise<bigint>
  getPolicy(policyId: bigint): Promise<RawPolicy>
  previewRequestBody(to: string, amount: bigint): Promise<string>
  recover(to: string): Promise<ContractTransactionResponse>
  filters: {
    TransferApproved(to?: string | null, writId?: string | null): DeferredTopicFilter
    TransferRefused(to?: string | null, writId?: string | null): DeferredTopicFilter
  }
}

/** `PolicyGate.Policy`, as a deployed gate reports it. */
export type PolicyStruct = {
  promptHead: string
  promptTail: string
  allowedModelHash: string
  allowedProvider: string
  maxRisk: number
}

/**
 * `PolicyGateFactory.GateSpec` — what a caller supplies to get a gate.
 *
 * There is no `allowedModelHash`: the factory derives it from `modelName`, which is the same
 * string it splices into the question. The two halves of a gate cannot disagree any more.
 */
export type GateSpecStruct = {
  modelName: string
  /** Hex. Continues from the model key the factory writes: `"temperature":0,"messages":[…`. */
  promptHead: string
  promptTail: string
  allowedProvider: string
  maxRisk: number
}

export type FactoryContract = Queryable & {
  readonly target: string
  registry(): Promise<string>
  gateCount(): Promise<bigint>
  allGates(index: bigint): Promise<string>
  gatesOf(owner: string): Promise<string[]>
  /** Pure. The contract's own splice of the model key onto the author's bytes. */
  buildPromptHead(modelName: string, promptHead: string): Promise<string>
  deployGate(spec: GateSpecStruct, agent: string, owner: string): Promise<ContractTransactionResponse>
  filters: {
    GateDeployed(gate?: string | null, owner?: string | null): DeferredTopicFilter
  }
}

export type ServingContract = {
  getService(provider: string): Promise<RawService>
  /** Paginated, and the page size is capped — see `SERVICE_PAGE_SIZE`. */
  getAllServices(offset: bigint, limit: bigint): Promise<[RawService[], bigint]>
  serviceExists(provider: string): Promise<boolean>
}
