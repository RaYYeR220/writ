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
  'function writId(address provider, bytes32 reqHash, bytes32 respHash) pure returns (bytes32)',
  'function routingWritId(address provider, bytes32 reqHash, bytes32 respHash, string providerType, string providerIdentity, bytes32 tlsFingerprint) pure returns (bytes32)',
  'function isNotarized(bytes32 id) view returns (bool)',
  'function isRoutingProof(bytes32 id) view returns (bool)',
  'function getWrit(bytes32 id) view returns (tuple(address provider, bytes32 modelHash, bytes32 reqHash, bytes32 respHash, bytes32 transcriptRoot, uint64 notarizedAt, address notarizedBy))',
  'function getRoutingProof(bytes32 id) view returns (tuple(string providerType, string providerIdentity, bytes32 tlsFingerprint))',
  'function notarize(address provider, bytes32 reqHash, bytes32 respHash, bytes signature, bytes32 transcriptRoot) returns (bytes32)',
  'function notarizeRoutingProof(address provider, bytes32 reqHash, bytes32 respHash, string providerType, string providerIdentity, bytes32 tlsFingerprint, bytes signature, bytes32 transcriptRoot) returns (bytes32)',
  'event Notarized(bytes32 indexed id, address indexed provider, bytes32 indexed modelHash, string model, bytes32 reqHash, bytes32 respHash, bytes32 transcriptRoot, address notarizedBy)',
  'event RoutingProofNotarized(bytes32 indexed id, address indexed provider, string providerType, string providerIdentity, bytes32 tlsFingerprint)',
  'error NotTeeVerifiable(address provider, string verifiability)',
  'error SignerNotAcknowledged(address provider)',
  'error BadSignature(address recovered, address expected)',
  'error AlreadyNotarized(bytes32 id)',
  'error NotNotarized(bytes32 id)',
  'error NotARoutingProof(bytes32 id)',
  'error RoutingFieldEmpty()',
  'error RoutingFieldTooLong(uint256 length)',
  'error RoutingFieldHasDelimiter()',
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
 */
export const TREASURY_GATE_ABI = [
  'function registry() view returns (address)',
  'function agent() view returns (address)',
  'function owner() view returns (address)',
  'function nonce() view returns (uint256)',
  'function POLICY_ID() view returns (uint256)',
  'function RECOVERY_DELAY() view returns (uint64)',
  'function lastAttestationAt() view returns (uint64)',
  'function recoveryAvailableAt() view returns (uint64)',
  'function consumed(bytes32) view returns (bool)',
  'function decisionKey(address provider, bytes32 reqHash, bytes32 respHash) view returns (bytes32)',
  'function getPolicy(uint256 policyId) view returns (tuple(bytes promptHead, bytes promptTail, bytes32 allowedModelHash, address allowedProvider, uint8 maxRisk))',
  'function buildParams(address to, uint256 amount, uint256 n) pure returns (bytes)',
  'function buildRequestBody(uint256 policyId, bytes params) view returns (bytes)',
  'function previewRequestBody(address to, uint256 amount) view returns (bytes)',
  'function execute(address to, uint256 amount, bytes rawResponse, address provider, bytes signature, bytes32 transcriptRoot) returns (bool)',
  'function executeRoutingProof(address to, uint256 amount, bytes rawResponse, address provider, tuple(string providerType, string providerIdentity, bytes32 tlsFingerprint) routing, bytes signature, bytes32 transcriptRoot) returns (bool)',
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

/** `AgentTreasury(registry, agent, owner, allowedModelHash, allowedProvider, maxRisk)`. */
export const AGENT_TREASURY_CONSTRUCTOR_ARGS = [
  'address',
  'address',
  'address',
  'bytes32',
  'address',
  'uint8',
] as const

export const POLICY_GATE_FACTORY_ABI = [
  'function registry() view returns (address)',
  'function deployGate(tuple(bytes promptHead, bytes promptTail, bytes32 allowedModelHash, address allowedProvider, uint8 maxRisk) p, address agent, address owner) returns (address)',
  'function gatesOf(address owner) view returns (address[])',
  'function gateCount() view returns (uint256)',
  'function allGates(uint256) view returns (address)',
  'event GateDeployed(address indexed gate, address indexed owner, address indexed deployer, bytes32 modelHash)',
  'error EmptyPrompt()',
  'error ZeroAgent()',
  'error ZeroOwner()',
  'error RiskCeilingTooHigh(uint8 maxRisk)',
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
