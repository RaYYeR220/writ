/**
 * Human-readable ABIs for the Writ contract suite.
 *
 * Kept in sync with the compiled artifacts by `test/abi.test.ts`, which compiles the Foundry
 * project and compares every selector and topic hash. Custom errors are declared alongside the
 * functions so `ethers` can decode a revert into `BadSignature(...)` rather than an opaque blob.
 */

export const WRIT_REGISTRY_ABI = [
  'function serving() view returns (address)',
  'function writCount() view returns (uint256)',
  'function MAX_ROOTS_PER_SUBMITTER() view returns (uint256)',
  'function writId(address provider, bytes32 reqHash, bytes32 respHash) pure returns (bytes32)',
  'function routingWritId(address provider, bytes32 reqHash, bytes32 respHash, string providerType, string providerIdentity, bytes32 tlsFingerprint) pure returns (bytes32)',
  'function isNotarized(bytes32 id) view returns (bool)',
  'function isRoutingProof(bytes32 id) view returns (bool)',
  'function getWrit(bytes32 id) view returns (tuple(address provider, bytes32 modelHash, bytes32 reqHash, bytes32 respHash, uint64 notarizedAt, address notarizedBy))',
  'function getRoutingProof(bytes32 id) view returns (tuple(string providerType, string providerIdentity, bytes32 tlsFingerprint))',
  'function transcriptRoots(bytes32 id) view returns (bytes32[])',
  'function transcriptRootCount(bytes32 id) view returns (uint256)',
  'function transcriptRootAt(bytes32 id, uint256 index) view returns (bytes32 root, address submitter)',
  'function transcriptSubmitter(bytes32 id, bytes32 root) view returns (address)',
  'function transcriptQuotaUsed(bytes32 id, address submitter) view returns (uint256)',
  'function addTranscript(bytes32 id, bytes32 root)',
  'function notarize(address provider, bytes32 reqHash, bytes32 respHash, bytes signature, bytes32 transcriptRoot) returns (bytes32)',
  'function notarizeRoutingProof(address provider, bytes32 reqHash, bytes32 respHash, string providerType, string providerIdentity, bytes32 tlsFingerprint, bytes signature, bytes32 transcriptRoot) returns (bytes32)',
  'event Notarized(bytes32 indexed id, address indexed provider, bytes32 indexed modelHash, string model, bytes32 reqHash, bytes32 respHash, address notarizedBy)',
  'event RoutingProofNotarized(bytes32 indexed id, address indexed provider, string providerType, string providerIdentity, bytes32 tlsFingerprint)',
  'event TranscriptAdded(bytes32 indexed id, bytes32 indexed root, address indexed submitter)',
  'error NotTeeVerifiable(address provider, string verifiability)',
  'error SignerNotAcknowledged(address provider)',
  'error BadSignature(address recovered, address expected)',
  'error AlreadyNotarized(bytes32 id)',
  'error NotNotarized(bytes32 id)',
  'error NotARoutingProof(bytes32 id)',
  'error RoutingFieldEmpty()',
  'error RoutingFieldTooLong(uint256 length)',
  'error RoutingFieldHasDelimiter()',
  'error ZeroServing()',
  'error TranscriptRootEmpty()',
  'error TranscriptAlreadyListed(bytes32 root)',
  'error TranscriptQuotaUsed(address submitter, uint256 quota)',
  'error TranscriptIndexOutOfRange(uint256 index, uint256 length)',
  'error ECDSAInvalidSignature()',
  'error ECDSAInvalidSignatureLength(uint256 length)',
  'error ECDSAInvalidSignatureS(bytes32 s)',
] as const

/**
 * `TreasuryGate` — the deployable gate. `AgentTreasury` is a `TreasuryGate` with its policy
 * baked in, so this ABI covers both.
 *
 * `execute` and `executeRoutingProof` return `bool approved`, but a return value is not
 * readable from a mined transaction: read `TransferApproved` / `TransferRefused` from the
 * receipt instead. A refusal is a successful transaction.
 *
 * Neither takes a signature or a transcript root, because neither notarizes. The writ must
 * already be on record — `WritNotNotarized(id)` otherwise — which is what keeps the permanent
 * record out of the settling transaction's fate: an approval whose payout reverts would
 * otherwise roll back the decision along with it, and only refusals would survive.
 *
 * `buildParams` is `view`, not `pure`: the question it builds carries the treasury's live state
 * (balance, decision counts, what this recipient has been paid before) as well as the proposed
 * transfer. A proof is therefore bound to the treasury as it stood when the question was built —
 * if the balance moves before the proof is settled, ask again. `approvedCount`, `refusedCount`
 * and `recipientHistory` are exposed so a client can read the same facts the question reports.
 */
export const TREASURY_GATE_ABI = [
  'function registry() view returns (address)',
  'function agent() view returns (address)',
  'function owner() view returns (address)',
  'function nonce() view returns (uint256)',
  'function approvedCount() view returns (uint96)',
  'function refusedCount() view returns (uint96)',
  'function recipientHistory(address recipient) view returns (uint64 payments, uint192 total)',
  'function POLICY_ID() view returns (uint256)',
  'function RECOVERY_DELAY() view returns (uint64)',
  'function lastAttestationAt() view returns (uint64)',
  'function recoveryAvailableAt() view returns (uint64)',
  'function consumed(bytes32) view returns (bool)',
  'function decisionKey(address provider, bytes32 reqHash, bytes32 respHash) view returns (bytes32)',
  'function getPolicy(uint256 policyId) view returns (tuple(bytes promptHead, bytes promptTail, bytes32 allowedModelHash, address allowedProvider, uint8 maxRisk))',
  'function buildParams(address to, uint256 amount) view returns (bytes)',
  'function buildRequestBody(uint256 policyId, bytes params) view returns (bytes)',
  'function previewRequestBody(address to, uint256 amount) view returns (bytes)',
  'function execute(address to, uint256 amount, bytes rawResponse, address provider) returns (bool)',
  'function executeRoutingProof(address to, uint256 amount, bytes rawResponse, address provider, tuple(string providerType, string providerIdentity, bytes32 tlsFingerprint) routing) returns (bool)',
  'function recover(address to)',
  'event TransferApproved(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId)',
  'event TransferRefused(address indexed to, uint256 amount, uint8 risk, uint8 refusedBy, bytes32 indexed writId)',
  'event Recovered(address indexed to, uint256 amount, uint64 lastAttestationAt)',
  'error NotAgent(address caller)',
  'error NotOwner(address caller)',
  'error ZeroRecipient()',
  'error RecoveryNotYetAvailable(uint64 availableAt)',
  'error TransferFailed(address to, uint256 amount)',
  'error ModelNotAllowed(bytes32 got, bytes32 want)',
  'error ProviderNotAllowed(address got, address want)',
  'error WritAlreadyConsumed(bytes32 id)',
  'error WritNotNotarized(bytes32 id)',
  'error UnknownPolicy(uint256 policyId)',
  'error MarkerNotFound()',
  'error VerdictTooLong()',
  'error VerdictMalformed()',
  'error ReentrancyGuardReentrantCall()',
  'error StringsInsufficientHexLength(uint256 value, uint256 length)',
] as const

/**
 * `PolicyGate.Refusal` — who said no. Carried by `TransferRefused` as `refusedBy`.
 *
 * `Model` is the model exercising judgement; `Policy` is the model saying yes and the gate's
 * risk ceiling saying no anyway. Both are successful transactions.
 */
export const REFUSAL = { None: 0, Model: 1, Policy: 2 } as const
export type Refusal = (typeof REFUSAL)[keyof typeof REFUSAL]

export function refusalName(refusedBy: number | bigint): 'none' | 'model' | 'policy' | 'unknown' {
  switch (Number(refusedBy)) {
    case REFUSAL.None:
      return 'none'
    case REFUSAL.Model:
      return 'model'
    case REFUSAL.Policy:
      return 'policy'
    default:
      return 'unknown'
  }
}

/** `AgentTreasury(registry, agent, owner, modelName, allowedProvider, maxRisk)`. */
export const AGENT_TREASURY_CONSTRUCTOR_ARGS = [
  'address',
  'address',
  'address',
  'string',
  'address',
  'uint8',
] as const

/**
 * `PolicyGateFactory` — deploys a configured `TreasuryGate`.
 *
 * `GateSpec` carries a model NAME rather than a model hash. The factory writes
 * `{"model":"<modelName>",` itself and derives `allowedModelHash` from that same string, so the
 * model a gate's question names and the model its writs are checked against cannot disagree.
 * The caller's `promptHead` continues from there (`"temperature":0,"messages":[…`) and is
 * rejected with `ModelKeyInPrompt` if it carries a `"model"` key of its own.
 *
 * `buildPromptHead` is pure and public so the exact question can be read off the chain before
 * paying to deploy a gate that asks it.
 */
export const POLICY_GATE_FACTORY_ABI = [
  'function registry() view returns (address)',
  'function buildPromptHead(string modelName, bytes promptHead) pure returns (bytes)',
  'function deployGate(tuple(string modelName, bytes promptHead, bytes promptTail, address allowedProvider, uint8 maxRisk) spec, address agent, address owner) returns (address)',
  'function gatesOf(address owner) view returns (address[])',
  'function gateCount() view returns (uint256)',
  'function allGates(uint256) view returns (address)',
  'event GateDeployed(address indexed gate, address indexed owner, address indexed deployer, bytes32 modelHash)',
  'error EmptyPrompt()',
  'error ZeroAgent()',
  'error ZeroOwner()',
  'error RiskCeilingTooHigh(uint8 maxRisk)',
  'error ModelNameEmpty()',
  'error ModelNameTooLong(uint256 length)',
  'error ModelNameHasIllegalByte(uint256 index)',
  'error ModelKeyInPrompt()',
] as const

/**
 * 0G's official inference service registry — the only authority on which address a provider's
 * TEE signs with.
 *
 * Mainnet (chain 16661): `0x47340d900bdFec2BD393c626E12ea0656F938d84`.
 * Galileo testnet (chain 16602): `0xa79F4c8311FF93C06b8CfB403690cc987c93F91E`.
 */
export const INFERENCE_SERVING_ABI = [
  'function getService(address provider) view returns (tuple(address provider, string serviceType, string url, uint256 inputPrice, uint256 outputPrice, uint256 updatedAt, string model, string verifiability, string additionalInfo, address teeSignerAddress, bool teeSignerAcknowledged))',
] as const

export const INFERENCE_SERVING_MAINNET = '0x47340d900bdFec2BD393c626E12ea0656F938d84'
export const INFERENCE_SERVING_GALILEO = '0xa79F4c8311FF93C06b8CfB403690cc987c93F91E'
