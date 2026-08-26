/**
 * Human-readable ABIs for the Writ contract suite.
 *
 * Kept in sync with the compiled artifacts by `test/abi.test.ts`, which compiles the Foundry
 * project and compares every selector and topic hash. Custom errors are declared alongside the
 * functions so `ethers` can decode a revert into `BadSignature(...)` rather than an opaque blob.
 */

export const WRIT_REGISTRY_ABI = [
  'function serving() view returns (address)',
  'function notarize(address provider, bytes32 reqHash, bytes32 respHash, bytes signature, bytes32 transcriptRoot) returns (bytes32)',
  'function writId(address provider, bytes32 reqHash, bytes32 respHash) pure returns (bytes32)',
  'function isNotarized(bytes32 id) view returns (bool)',
  'function getWrit(bytes32 id) view returns (tuple(address provider, bytes32 modelHash, bytes32 reqHash, bytes32 respHash, bytes32 transcriptRoot, uint64 notarizedAt, address notarizedBy))',
  'function writCount() view returns (uint256)',
  'event Notarized(bytes32 indexed id, address indexed provider, bytes32 indexed modelHash, string model, bytes32 reqHash, bytes32 respHash, bytes32 transcriptRoot, address notarizedBy)',
  'error NotTeeVerifiable(address provider, string verifiability)',
  'error SignerNotAcknowledged(address provider)',
  'error BadSignature(address recovered, address expected)',
  'error AlreadyNotarized(bytes32 id)',
  'error NotNotarized(bytes32 id)',
] as const

/**
 * `TreasuryGate` — the deployable gate. `AgentTreasury` is a `TreasuryGate` with its policy
 * baked in, so this ABI covers both.
 *
 * `execute` returns `bool approved`, but a return value is not readable from a mined
 * transaction: read `TransferApproved` / `TransferRefused` from the receipt instead. A refusal
 * is a successful transaction.
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
  'function getPolicy(uint256 policyId) view returns (tuple(bytes promptHead, bytes promptTail, bytes32 allowedModelHash, address allowedProvider, uint8 maxRisk))',
  'function buildParams(address to, uint256 amount, uint256 n) pure returns (bytes)',
  'function buildRequestBody(uint256 policyId, bytes params) view returns (bytes)',
  'function previewRequestBody(address to, uint256 amount) view returns (bytes)',
  'function execute(address to, uint256 amount, bytes rawResponse, address provider, bytes signature, bytes32 transcriptRoot) returns (bool)',
  'function recover(address to)',
  'event TransferApproved(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId)',
  'event TransferRefused(address indexed to, uint256 amount, uint8 risk, bytes32 indexed writId)',
  'event Recovered(address indexed to, uint256 amount, uint64 lastAttestationAt)',
  'error NotAgent(address caller)',
  'error NotOwner(address caller)',
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
  'function deployGate(tuple(bytes promptHead, bytes promptTail, bytes32 allowedModelHash, address allowedProvider, uint8 maxRisk) p, address agent) returns (address)',
  'function gatesOf(address owner) view returns (address[])',
  'function gateCount() view returns (uint256)',
  'function allGates(uint256) view returns (address)',
  'event GateDeployed(address indexed gate, address indexed owner, bytes32 modelHash)',
  'error EmptyPrompt()',
  'error ZeroAgent()',
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
