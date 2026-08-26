/**
 * Human-readable ABIs, kept local to the app on purpose.
 *
 * `@writ/sdk` carries the same fragments, but it reaches for `node:crypto` and the 0G storage
 * SDK, neither of which belongs in a page that has to run entirely inside a browser tab. The
 * app's whole claim is that a stranger can check a writ without our server, so its dependency
 * list has to stay something a browser can actually execute.
 *
 * `test/abi.test.ts` compares every fragment here against the Solidity sources, so a drift in
 * either direction is a failing test rather than a page that silently decodes nothing.
 */

/**
 * `WritRegistry`.
 *
 * The record carries no transcript root. The TEE never signed one, notarization is
 * permissionless, and a single stored pointer would let whoever notarized first fix the archive
 * pointer forever — so candidates live in `transcriptRoots`, anyone may append one, and a reader
 * re-derives `reqHash`/`respHash` from the bytes a candidate points at instead of trusting any
 * of them. `Notarized` carries none for the same reason; follow `TranscriptAdded` for pointers.
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
] as const

export const TREASURY_GATE_ABI = [
  'function registry() view returns (address)',
  'function agent() view returns (address)',
  'function owner() view returns (address)',
  'function nonce() view returns (uint256)',
  'function POLICY_ID() view returns (uint256)',
  'function RECOVERY_DELAY() view returns (uint64)',
  'function lastAttestationAt() view returns (uint64)',
  'function recoveryAvailableAt() view returns (uint64)',
  'function approvedCount() view returns (uint96)',
  'function refusedCount() view returns (uint96)',
  'function consumed(bytes32) view returns (bool)',
  'function recipientHistory(address) view returns (uint64 payments, uint192 total)',
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
] as const

/**
 * `PolicyGateFactory`.
 *
 * `GateSpec` names the model as a STRING, and the factory writes `{"model":"<modelName>",`
 * itself while deriving `allowedModelHash` from that same string. The old shape took a prompt
 * head and an unrelated model hash, so a caller could deploy a gate that asked about one model
 * and accepted an answer from another with every check passing. Studio therefore takes a model
 * name as its own field and asks `buildPromptHead` — on chain, pure — what the contract will
 * actually build, rather than reproducing the concatenation here and hoping they agree.
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
 * 0G's official inference registry — the only authority on which key a provider's enclave signs
 * with. `getService` is what a single proof row checks one provider against; `getAllServices` is
 * what Studio lists.
 *
 * `getAllServices` is **paginated**, and the page size is capped. Asking for more reverts with
 * `LimitTooLarge(requested, max)`, which decodes to a readable error only because it is declared
 * here. The signature was read off the live beacon implementation
 * (`0x1c0a264f5ae6cfc37e8695442fb139efd884ca48` behind the mainnet proxy), not guessed — an
 * unpaginated `getAllServices()` does not exist and reverts with no data at all.
 */
const SERVICE_TUPLE =
  'tuple(address provider, string serviceType, string url, uint256 inputPrice, uint256 outputPrice, uint256 updatedAt, string model, string verifiability, string additionalInfo, address teeSignerAddress, bool teeSignerAcknowledged)'

export const INFERENCE_SERVING_ABI = [
  `function getService(address provider) view returns (${SERVICE_TUPLE})`,
  `function getAllServices(uint256 offset, uint256 limit) view returns (${SERVICE_TUPLE}[] services, uint256 total)`,
  'function serviceExists(address provider) view returns (bool)',
  'error ServiceNotExist(address provider)',
  'error LimitTooLarge(uint256 requested, uint256 max)',
] as const

/** The largest page `getAllServices` will serve. Above this it reverts with `LimitTooLarge`. */
export const SERVICE_PAGE_SIZE = 50

/** `PolicyGate.Refusal` — who said no. Both values mean the funds stayed put. */
export const REFUSAL = { None: 0, Model: 1, Policy: 2 } as const

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

/** Plain English for a `TransferRefused.refusedBy`, in the app's voice. */
export function refusedByPhrase(refusedBy: number | bigint): string {
  switch (refusalName(refusedBy)) {
    case 'model':
      return 'the model declined'
    case 'policy':
      return 'the model agreed, the ceiling did not'
    case 'none':
      return 'nobody refused'
    default:
      return 'refused, reason not recognised'
  }
}
