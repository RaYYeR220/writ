// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WritLib} from "./WritLib.sol";
import {IInferenceServing} from "./interfaces/IInferenceServing.sol";

/// @title WritRegistry
/// @notice Permanent public record of verified 0G Compute TEE inference proofs.
/// @dev Ownerless and non-upgradeable. Validity is decided entirely by the TEE signature and
///      0G's official InferenceServing registry, which is read live on every call. There is no
///      allowlist: anyone may notarize any valid proof.
///
///      Two proof kinds are accepted, matching the two signed-text formats the 0G broker
///      produces for text inference: `notarize` for a decentralized provider's chat proof and
///      `notarizeRoutingProof` for a centralized provider's five-field routing proof. Their
///      identifiers are domain-separated so the same request/response pair can hold both.
///
///      One thing here is NOT attested, and it is kept out of the record entirely rather than
///      stored beside things that are: the transcript root. The TEE signs the request and
///      response hashes, never a pointer to an archive, so a root is a claim by whoever published
///      it. `Writ` therefore has no root field and `Notarized` carries none — candidates live in
///      `transcriptRoots`, anyone may publish one with `addTranscript`, and a reader re-derives
///      `reqHash`/`respHash` from the bytes a candidate points at rather than trusting any
///      pointer. Nothing downstream depends on which candidate is right; the proof was verified
///      by signature recovery, independently of every one of them.
contract WritRegistry {
    /// @notice What the TEE signature and 0G's registry between them establish, and nothing else.
    /// @dev Deliberately carries no archive pointer. A root is not attested by anything, so a
    ///      field for one sitting beside four verified facts would invite a reader to treat it as
    ///      a fifth. Candidates live in `transcriptRoots`, where they are labelled as claims.
    struct Writ {
        address provider;
        bytes32 modelHash;
        bytes32 reqHash;
        bytes32 respHash;
        uint64 notarizedAt;
        address notarizedBy;
    }

    /// @notice The upstream attribution a centralized provider's routing proof binds.
    /// @dev Only populated for writs notarized through `notarizeRoutingProof`; its presence is
    ///      what distinguishes the two kinds. The TLS fingerprint proves which upstream actually
    ///      served the request, which the chat format does not attest at all.
    struct RoutingProof {
        string providerType;
        string providerIdentity;
        bytes32 tlsFingerprint;
    }

    /// @notice 0G's official inference service registry.
    IInferenceServing public immutable serving;

    bytes32 private constant TEE_ML = keccak256(bytes("TeeML"));

    /// @dev Domain tag that keeps a routing writ from colliding with a plain one over the same
    ///      provider, request and response.
    bytes32 private constant ROUTING_PROOF_DOMAIN = keccak256("writ.routingProof.v1");

    /// @dev Generous for `"centralized"` and for any upstream label the broker uses.
    uint256 private constant MAX_ROUTING_FIELD = 32;

    /// @notice How many archive pointers ONE ADDRESS may publish for one writ.
    /// @dev The quota is per submitter rather than a cap on the list as a whole, and that choice
    ///      is the whole defence. A global cap plus permissionless writes cannot both be safe:
    ///      a griefer spends the entire list on distinct junk roots and the real archivist is
    ///      locked out forever, which is the front-running this mechanism exists to defeat, only
    ///      worse. With a per-address quota a griefer can exhaust nothing but their own, and
    ///      every honest publisher always has room.
    ///
    ///      The cost is that the list is unbounded against a sybil: one attacker with N addresses
    ///      can publish 4N candidates. That is a bounded nuisance rather than a denial — the real
    ///      root still gets in, and a reader that cannot afford the whole list walks it with
    ///      `transcriptRootCount` and `transcriptRootAt`. Trading an unbounded read against a
    ///      permanent lockout is the right way round.
    ///
    ///      Four, because a writ has one true transcript and an honest publisher who needs more
    ///      than a couple of attempts is not publishing, they are guessing.
    uint256 public constant MAX_ROOTS_PER_SUBMITTER = 4;

    mapping(bytes32 => Writ) private _writs;
    mapping(bytes32 => RoutingProof) private _routingProofs;

    /// @dev Candidate archive pointers per writ, in submission order.
    mapping(bytes32 => bytes32[]) private _transcriptRoots;

    /// @dev Who published a given candidate. Non-zero doubles as "already listed", which keeps
    ///      the duplicate check O(1) — a scan over an unbounded list would itself be griefable.
    mapping(bytes32 => mapping(bytes32 => address)) private _transcriptSubmitter;

    /// @dev How much of their quota an address has spent on a given writ.
    mapping(bytes32 => mapping(address => uint256)) private _transcriptQuotaUsed;

    uint256 public writCount;

    error NotTeeVerifiable(address provider, string verifiability);
    error SignerNotAcknowledged(address provider);
    error BadSignature(address recovered, address expected);
    error AlreadyNotarized(bytes32 id);
    error NotNotarized(bytes32 id);
    error NotARoutingProof(bytes32 id);
    error RoutingFieldEmpty();
    error RoutingFieldTooLong(uint256 length);
    error RoutingFieldHasDelimiter();
    error ZeroServing();
    error TranscriptRootEmpty();
    error TranscriptAlreadyListed(bytes32 root);
    error TranscriptQuotaUsed(address submitter, uint256 quota);
    error TranscriptIndexOutOfRange(uint256 index, uint256 length);

    /// @dev Carries no transcript root: a root is a claim, and it gets its own event so that a
    ///      claim is never delivered inside the record of a verified fact. Follow
    ///      `TranscriptAdded` for pointers, including the one supplied at notarization.
    event Notarized(
        bytes32 indexed id,
        address indexed provider,
        bytes32 indexed modelHash,
        string model,
        bytes32 reqHash,
        bytes32 respHash,
        address notarizedBy
    );

    event RoutingProofNotarized(
        bytes32 indexed id,
        address indexed provider,
        string providerType,
        string providerIdentity,
        bytes32 tlsFingerprint
    );

    /// @notice Someone published a candidate archive pointer for a writ.
    /// @dev Emitted for the root supplied at notarization too, so following this one event gives
    ///      an indexer every candidate in submission order. `submitter` is who claimed it, which
    ///      is all the attribution there is: nothing here vouches for the root itself.
    event TranscriptAdded(bytes32 indexed id, bytes32 indexed root, address indexed submitter);

    /// @param serving_ 0G's InferenceServing contract. Mainnet:
    ///        `0x47340d900bdFec2BD393c626E12ea0656F938d84` (chain 16661).
    /// @dev The address is immutable and every check this registry makes is read from it, so a
    ///      wrong one cannot be corrected — it deploys a registry that fails on every proof. The
    ///      zero address is the mistake worth catching here, because it is the one a missing
    ///      environment variable produces and it would fail silently at deployment.
    constructor(address serving_) {
        if (serving_ == address(0)) revert ZeroServing();
        serving = IInferenceServing(serving_);
    }

    /// @notice Content-addressed identifier of a chat proof.
    function writId(address provider, bytes32 reqHash, bytes32 respHash) public pure returns (bytes32) {
        return keccak256(abi.encode(provider, reqHash, respHash));
    }

    /// @notice Content-addressed identifier of a centralized routing proof.
    /// @dev Domain-tagged and over a longer preimage than `writId`, so the two kinds cannot
    ///      collide. The attribution fields are part of the identifier because they are part of
    ///      what the TEE signed: a proof recorded under a different upstream is a different fact.
    function routingWritId(
        address provider,
        bytes32 reqHash,
        bytes32 respHash,
        string memory providerType,
        string memory providerIdentity,
        bytes32 tlsFingerprint
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ROUTING_PROOF_DOMAIN,
                provider,
                reqHash,
                respHash,
                keccak256(bytes(providerType)),
                keccak256(bytes(providerIdentity)),
                tlsFingerprint
            )
        );
    }

    function isNotarized(bytes32 id) public view returns (bool) {
        return _writs[id].notarizedAt != 0;
    }

    /// @notice Whether this writ was recorded from a centralized provider's routing proof.
    function isRoutingProof(bytes32 id) public view returns (bool) {
        return bytes(_routingProofs[id].providerType).length != 0;
    }

    function getWrit(bytes32 id) external view returns (Writ memory w) {
        w = _writs[id];
        if (w.notarizedAt == 0) revert NotNotarized(id);
    }

    function getRoutingProof(bytes32 id) external view returns (RoutingProof memory p) {
        p = _routingProofs[id];
        if (bytes(p.providerType).length == 0) revert NotARoutingProof(id);
    }

    /// @notice Every archive pointer anyone has published for this writ, in submission order.
    /// @dev These are CANDIDATES, not facts. **The TEE signature does not cover the transcript
    ///      root**, and this contract has no way to check one, so a root here means only that
    ///      some address published it. Verification is by re-deriving the hashes: fetch the
    ///      transcript a candidate points at and check that its request and response bytes
    ///      sha256 to the writ's `reqHash` and `respHash`. A candidate that fails is junk and
    ///      says nothing about the writ; the writ itself was verified by signature recovery
    ///      against 0G's registered TEE signer, independently of any pointer.
    ///
    ///      Read them in order and stop at the first that re-derives. An unknown writ has none.
    ///
    ///      The list has no ceiling — see `MAX_ROOTS_PER_SUBMITTER` for why that is the safer
    ///      trade — so a caller that cannot bound its own gas should walk it with
    ///      `transcriptRootCount` and `transcriptRootAt` instead of loading it whole.
    function transcriptRoots(bytes32 id) external view returns (bytes32[] memory) {
        return _transcriptRoots[id];
    }

    /// @notice How many candidate pointers this writ carries.
    function transcriptRootCount(bytes32 id) external view returns (uint256) {
        return _transcriptRoots[id].length;
    }

    /// @notice One candidate and the address that published it, by position.
    /// @dev The pair a reader actually wants: the pointer to try, and whose claim it is if it
    ///      turns out to be junk.
    function transcriptRootAt(bytes32 id, uint256 index) external view returns (bytes32 root, address submitter) {
        bytes32[] storage roots = _transcriptRoots[id];
        if (index >= roots.length) revert TranscriptIndexOutOfRange(index, roots.length);
        root = roots[index];
        submitter = _transcriptSubmitter[id][root];
    }

    /// @notice Who published a given candidate for a given writ; zero if it is not listed.
    /// @dev Attribution, not endorsement. It says who to disbelieve when a root does not
    ///      re-derive, and nothing about whether it will.
    function transcriptSubmitter(bytes32 id, bytes32 root) external view returns (address) {
        return _transcriptSubmitter[id][root];
    }

    /// @notice How many of `MAX_ROOTS_PER_SUBMITTER` this address has spent on this writ.
    function transcriptQuotaUsed(bytes32 id, address submitter) external view returns (uint256) {
        return _transcriptQuotaUsed[id][submitter];
    }

    /// @notice Publish another candidate archive pointer for an existing writ.
    /// @dev Permissionless by design, and it has to be. `notarize` is permissionless and records
    ///      are immutable, so whoever gets there first would otherwise fix the archive pointer
    ///      forever — and because the signature endpoint is public, that can be someone who
    ///      learned the chat id and published a junk root. Verification is unaffected either way;
    ///      only the pointer would be lost. Appending makes a wrong first root noise rather than
    ///      damage: the real archivist publishes the true root beside it and a consumer
    ///      re-derives its way to the right one.
    ///
    ///      Duplicates are rejected so a griefer cannot pad the list with one value, and each
    ///      address is held to `MAX_ROOTS_PER_SUBMITTER` so no one can spend the room another
    ///      publisher needs. A rejected call spends no quota.
    /// @param id The writ this pointer claims to archive. It must already be notarized.
    /// @param root A 0G Storage merkle root. Attributed to `msg.sender` in `TranscriptAdded`.
    function addTranscript(bytes32 id, bytes32 root) external {
        if (_writs[id].notarizedAt == 0) revert NotNotarized(id);
        _addTranscript(id, root);
    }

    /// @dev The zero root is not a pointer, it is the absence of one, so it is never listed.
    ///      Every check is O(1): the list this writes to is unbounded, so nothing here may scan
    ///      it or an attacker could price honest publishers out one append at a time.
    function _addTranscript(bytes32 id, bytes32 root) private {
        if (root == bytes32(0)) revert TranscriptRootEmpty();
        if (_transcriptSubmitter[id][root] != address(0)) revert TranscriptAlreadyListed(root);

        uint256 used = _transcriptQuotaUsed[id][msg.sender];
        if (used >= MAX_ROOTS_PER_SUBMITTER) revert TranscriptQuotaUsed(msg.sender, MAX_ROOTS_PER_SUBMITTER);

        unchecked {
            _transcriptQuotaUsed[id][msg.sender] = used + 1;
        }
        _transcriptSubmitter[id][root] = msg.sender;
        _transcriptRoots[id].push(root);

        emit TranscriptAdded(id, root, msg.sender);
    }

    /// @notice Verify a TEE inference proof and record it forever.
    /// @param provider The 0G Compute provider that served the request.
    /// @param reqHash sha256 of the exact request body bytes sent to the provider.
    /// @param respHash sha256 of the exact response body bytes returned by the provider.
    /// @param signature The provider's TEE signature over `sha256hex(req):sha256hex(resp)`.
    /// @param transcriptRoot 0G Storage merkle root of the archived transcript, or zero for none.
    ///        **Not attested by the TEE** and not validated here — it is the first candidate
    ///        pointer, nothing more. See `addTranscript` and `transcriptRoots`.
    function notarize(
        address provider,
        bytes32 reqHash,
        bytes32 respHash,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) external returns (bytes32 id) {
        id = writId(provider, reqHash, respHash);
        IInferenceServing.Service memory svc = _teeService(id, provider);
        _requireSigner(WritLib.recoverSigner(reqHash, respHash, signature), svc.teeSignerAddress);
        _record(id, provider, svc.model, reqHash, respHash, transcriptRoot);
    }

    /// @notice Verify a centralized provider's routing proof and record it forever.
    /// @dev Same registry checks as `notarize`; only the signed text differs. The extra fields
    ///      are recorded because they are the stronger part of this proof: the TLS fingerprint
    ///      names the upstream that actually answered.
    ///
    ///      `providerType` and `providerIdentity` are not a trust input — the signature covers
    ///      them, so a wrong value simply fails recovery. They are validated anyway because the
    ///      `:`-joined text is ambiguous under field splitting: `("x", "y:z")` and `("x:y", "z")`
    ///      sign the same bytes, which would let one valid proof be recorded under mis-attributed
    ///      metadata. The broker relies on the fingerprint provably being 32 hex bytes for the
    ///      same reason; the two free-text fields get the equivalent guarantee here.
    ///
    ///      We deliberately do NOT cross-check these against the service's `additionalInfo` JSON.
    ///      The signature already binds them, so parsing JSON on chain would add attack surface
    ///      for no security gain.
    function notarizeRoutingProof(
        address provider,
        bytes32 reqHash,
        bytes32 respHash,
        string calldata providerType,
        string calldata providerIdentity,
        bytes32 tlsFingerprint,
        bytes calldata signature,
        bytes32 transcriptRoot
    ) external returns (bytes32 id) {
        _requireLabel(providerType);
        _requireLabel(providerIdentity);

        id = routingWritId(provider, reqHash, respHash, providerType, providerIdentity, tlsFingerprint);
        IInferenceServing.Service memory svc = _teeService(id, provider);
        _requireSigner(
            WritLib.recoverRoutingProofSigner(
                reqHash, respHash, providerType, providerIdentity, tlsFingerprint, signature
            ),
            svc.teeSignerAddress
        );

        _routingProofs[id] = RoutingProof(providerType, providerIdentity, tlsFingerprint);
        _record(id, provider, svc.model, reqHash, respHash, transcriptRoot);

        emit RoutingProofNotarized(id, provider, providerType, providerIdentity, tlsFingerprint);
    }

    /// @dev Reads 0G's live registry and enforces that the provider is a TEE service we accept.
    function _teeService(bytes32 id, address provider) private view returns (IInferenceServing.Service memory svc) {
        if (_writs[id].notarizedAt != 0) revert AlreadyNotarized(id);

        svc = serving.getService(provider);
        if (!svc.teeSignerAcknowledged) revert SignerNotAcknowledged(provider);
        if (keccak256(bytes(svc.verifiability)) != TEE_ML) {
            revert NotTeeVerifiable(provider, svc.verifiability);
        }
    }

    function _requireSigner(address recovered, address expected) private pure {
        if (recovered != expected) revert BadSignature(recovered, expected);
    }

    /// @dev A label may not be empty, may not exceed `MAX_ROUTING_FIELD`, and may not contain the
    ///      `:` that separates the fields it sits between.
    function _requireLabel(string calldata label) private pure {
        bytes calldata raw = bytes(label);
        if (raw.length == 0) revert RoutingFieldEmpty();
        if (raw.length > MAX_ROUTING_FIELD) revert RoutingFieldTooLong(raw.length);
        for (uint256 i = 0; i < raw.length; ++i) {
            if (raw[i] == ":") revert RoutingFieldHasDelimiter();
        }
    }

    /// @dev The model name is stored as a hash and emitted raw, so indexers get the string for
    ///      free while storage stays one slot.
    function _record(
        bytes32 id,
        address provider,
        string memory model,
        bytes32 reqHash,
        bytes32 respHash,
        bytes32 transcriptRoot
    ) private {
        bytes32 modelHash = keccak256(bytes(model));
        _writs[id] = Writ({
            provider: provider,
            modelHash: modelHash,
            reqHash: reqHash,
            respHash: respHash,
            notarizedAt: uint64(block.timestamp),
            notarizedBy: msg.sender
        });
        unchecked {
            ++writCount;
        }

        emit Notarized(id, provider, modelHash, model, reqHash, respHash, msg.sender);

        // The notarizer's root goes in through the same door as every later one, attributed to
        // them and against their quota. Being first to record the proof buys no standing here.
        if (transcriptRoot != bytes32(0)) _addTranscript(id, transcriptRoot);
    }
}
