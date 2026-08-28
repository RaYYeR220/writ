# PROOF

Writ is deployed on **0G mainnet, chain 16661**. This file is the receipt. Every claim below is a
link you can click and a command you can run, and the commands read the chain directly so you do
not have to trust the explorer either.

RPC `https://evmrpc.0g.ai` · explorer [chainscan.0g.ai](https://chainscan.0g.ai) · everything here
is read-only and spends nothing.

```bash
cast chain-id --rpc-url https://evmrpc.0g.ai      # 16661
```

> **This file is the authority on deployment status.** `README.md`, `CLAIMS.md`, `MOCKS.md`,
> `JUDGES.md` and `docs/architecture.md` were all written while nothing was deployed, and where any
> of them still says so, this file supersedes it.
> [The five things `CLAIMS.md` §6 listed as never run](#what-those-documents-said-and-what-actually-changed)
> have now been run, and what follows is the evidence. Nothing else in those documents changed — in
> particular **`EVAL.md` is still correct as written**: the graded evaluation has still only ever run
> on a local fork against a stand-in signer, and this deployment does not change that. See
> [what is still not proven](#what-is-still-not-proven).

---

## The refusal

Lead with this one, because it is the artifact the whole design exists to produce.

An autonomous agent asked a treasury it operates to send **1.9 0G — 95% of the balance — to the
burn address**. A model running in a 0G TEE answered `DENY:95`. The settlement transaction was
**mined successfully**, moved **nothing**, and left the refusal on chain permanently.

**A refusal is a transaction, not a revert.** The record outlives the decision.

| | |
|---|---|
| Writ | `0xf20090422eefd17f52b10ea8c38fe2957a886112dbabaa1c222f1cfb4345d31a` |
| Notarize | [`0xebce4ce0…b69a779`](https://chainscan.0g.ai/tx/0xebce4ce02dc1504ca6cc6e8314548aea3a37695c7421315102c58615eb69a779) · block [42839403](https://chainscan.0g.ai/block/42839403) · **status `true`** |
| Settle | [`0x8e29c1e6…f5bcf59cdb`](https://chainscan.0g.ai/tx/0x8e29c1e6f2f3c10162c363a033be91b3fb738560bfa24441d5b3f895cbf59cdb) · block [42839414](https://chainscan.0g.ai/block/42839414) · **status `true`** |
| Recipient | [`0x000000000000000000000000000000000000dEaD`](https://chainscan.0g.ai/address/0x000000000000000000000000000000000000dEaD) |
| Amount asked | `1900000000000000000` wei — 1.9 0G |
| Amount moved | **`0`** |
| Verdict | `DENY:95`, refused by the **model** (`Refusal.Model`), not by the gate's ceiling |
| Transcript root | `0x312a8684c1dee72e665296943a4792c4790f89fd9ab156bfec3cb4162f7061ee` |

The settlement succeeded and the treasury has never paid that address:

```bash
cast receipt 0x8e29c1e6f2f3c10162c363a033be91b3fb738560bfa24441d5b3f895cbf59cdb \
  status --rpc-url https://evmrpc.0g.ai
# true

cast call 0x2688059e106195941F320110bE2d5fe9a1c75fEE \
  "recipientHistory(address)(uint64,uint192)" \
  0x000000000000000000000000000000000000dEaD --rpc-url https://evmrpc.0g.ai
# 0
# 0
```

The `TransferRefused` log in that receipt, decoded:

```
topic0  0x1a161d90df55e00e62086d2d2754689b60b9f7fe9ea20002d390da5f0a11c2e0
        = keccak("TransferRefused(address,uint256,uint8,uint8,bytes32)")
topic1  to      = 0x…dEaD
topic2  writId  = 0xf20090422eefd17f52b10ea8c38fe2957a886112dbabaa1c222f1cfb4345d31a
data    amount  = 0x1a5e27eef13e0000 = 1900000000000000000
        risk    = 0x5f = 95
        refusedBy = 1 = Refusal.Model
```

`refusedBy = 1` is the distinction worth having: the model itself declined. `2` would have meant
the model said `ALLOW` and this gate's risk ceiling of 50 overruled it. Both mean no funds moved;
they are not the same event and the chain says which one happened.

**What the model actually wrote**, recovered from the settle transaction's calldata and archived in
0G Storage — reproduced in full at [the transcript section](#the-transcript-in-0g-storage):

> The transfer is 1.9 ETH … against a balance of 1.99 ETH. This is 95% of the treasury balance —
> extremely high, nearly draining the treasury. … `0x000000000000000000000000000000000000dead` —
> This is a burn address. Sending funds here means permanently destroying them. … This is a clear
> DENY with a high risk score.

It read the burn address and it read the percentage. It was not told either in words; both are
facts [`TreasuryGate.buildParams`](contracts/src/TreasuryGate.sol) derived from the treasury's own
state and wrote into the question.

---

## Check it yourself in under a minute

No credentials, no install beyond Foundry and `curl`, no funds, nothing to trust.

**1 — the counters.** One approval, one refusal, two writs, and a balance that closes exactly.

```bash
export RPC=https://evmrpc.0g.ai
cast call 0x857D288652e4f4523347EFf1918B9E1263A574f4 "writCount()(uint256)"     --rpc-url $RPC  # 2
cast call 0x2688059e106195941F320110bE2d5fe9a1c75fEE "approvedCount()(uint96)"  --rpc-url $RPC  # 1
cast call 0x2688059e106195941F320110bE2d5fe9a1c75fEE "refusedCount()(uint96)"   --rpc-url $RPC  # 1
cast balance 0x2688059e106195941F320110bE2d5fe9a1c75fEE --rpc-url $RPC   # 1990000000000000000
```

Funded with 2.0 0G, one approval moved 0.01, one refusal moved nothing: `2.00 − 0.01 = 1.99`. The
balance is the arithmetic, and it leaves no room for a fifth transfer nobody mentioned.

**2 — the TEE signature, with no network at all.** This is the whole cryptographic claim, and it
runs offline:

```bash
cast wallet verify --address 0xA46EA4FC5889AD35A1487e1Ed04dCcfa872146B9 \
  "8add72eeb1b800edb7d47600ab4292a8ad29df8099f9c2882bbe1fd526e657ef:8ee2460fda2f758d7b9e636b9a827ce1bb0feae2766f2d29b7ef540cac870077" \
  0x0706447b8c4e20aa916e87eb9dcfe82b7c31d6578ad3aef0564487f0c4627aa955ab1c8873fa75942c8f4d8703ac29369c3439820c2c339679c7f8efe979bcd31c
# Validation succeeded. Address 0xA46EA4FC5889AD35A1487e1Ed04dCcfa872146B9 signed this message.
```

Then confirm that address is the one **0G's own registry** names for the provider — not one we
chose:

```bash
cast call 0x47340d900bdFec2BD393c626E12ea0656F938d84 \
  "getService(address)((address,string,string,uint256,uint256,uint256,string,string,string,address,bool))" \
  0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D --rpc-url $RPC
# … "glm-5.2", "TeeML", …, 0xA46EA4FC5889AD35A1487e1Ed04dCcfa872146B9, true
```

**3 — the transcript, from 0G Storage, over plain HTTP:**

```bash
curl -s "https://indexer-storage-turbo.0g.ai/file?root=0x312a8684c1dee72e665296943a4792c4790f89fd9ab156bfec3cb4162f7061ee"
```

**4 — the addresses, derived rather than taken on trust.** Both deployments come from the same
deployer, and `CREATE` is deterministic:

```bash
cast compute-address 0xe1b27008710E5453fe021B521428B3DF074804DF --nonce 0  # 0x44641b84…  registry  (first deployment)
cast compute-address 0xe1b27008710E5453fe021B521428B3DF074804DF --nonce 1  # 0xf063dd27…  factory   (first deployment)
cast compute-address 0xe1b27008710E5453fe021B521428B3DF074804DF --nonce 2  # 0xaF9C87f5…  treasury  (first deployment)
cast compute-address 0xe1b27008710E5453fe021B521428B3DF074804DF --nonce 7  # 0x857D2886…  WritRegistry
cast compute-address 0xe1b27008710E5453fe021B521428B3DF074804DF --nonce 8  # 0x4320Ae51…  PolicyGateFactory
cast compute-address 0xe1b27008710E5453fe021B521428B3DF074804DF --nonce 9  # 0x2688059e…  AgentTreasury
```

---

## The deployment

Three contracts, one deployer, two consecutive blocks.

| Contract | Address | Deploy tx | Block |
|---|---|---|---|
| `WritRegistry` | [`0x857D288652e4f4523347EFf1918B9E1263A574f4`](https://chainscan.0g.ai/address/0x857D288652e4f4523347EFf1918B9E1263A574f4) | [`0x791a3768…686f44f5`](https://chainscan.0g.ai/tx/0x791a37687b323a853a415988f8607a32f64c80baec128944a8a610da686f44f5) | [42839181](https://chainscan.0g.ai/block/42839181) |
| `PolicyGateFactory` | [`0x4320Ae51D672f2636a0faFfb2B28C5520013b6D7`](https://chainscan.0g.ai/address/0x4320Ae51D672f2636a0faFfb2B28C5520013b6D7) | [`0x751c185f…0322bee2`](https://chainscan.0g.ai/tx/0x751c185f7eaa532c6f4b25309d5c4c8b405acfa3d0ca635816d459ed0322bee2) | [42839182](https://chainscan.0g.ai/block/42839182) |
| `AgentTreasury` | [`0x2688059e106195941F320110bE2d5fe9a1c75fEE`](https://chainscan.0g.ai/address/0x2688059e106195941F320110bE2d5fe9a1c75fEE) | [`0xcc02a137…668b506f`](https://chainscan.0g.ai/tx/0xcc02a137f8b27998d5cdf76c46e855f24cb9e74f11b25126a2326050668b506f) | [42839182](https://chainscan.0g.ai/block/42839182) |

Deployer / treasury owner [`0xe1b27008710E5453fe021B521428B3DF074804DF`](https://chainscan.0g.ai/address/0xe1b27008710E5453fe021B521428B3DF074804DF).
Agent [`0x5e64c5066b09c1Dc7852A6B069EE26B9AE122eA6`](https://chainscan.0g.ai/address/0x5e64c5066b09c1Dc7852A6B069EE26B9AE122eA6) —
deliberately a different key, so the party that can trigger the recovery timelock by going quiet is
not the party that can take it.

All three receipts have status `true`:

```bash
for tx in 0x791a37687b323a853a415988f8607a32f64c80baec128944a8a610da686f44f5 \
          0x751c185f7eaa532c6f4b25309d5c4c8b405acfa3d0ca635816d459ed0322bee2 \
          0xcc02a137f8b27998d5cdf76c46e855f24cb9e74f11b25126a2326050668b506f; do
  cast receipt $tx contractAddress --rpc-url $RPC
  cast receipt $tx status --rpc-url $RPC
done
```

**The registry points at 0G's own contract, and the gate points at the registry.** Nothing here is
self-attested:

```bash
cast call 0x857D288652e4f4523347EFf1918B9E1263A574f4 "serving()(address)"  --rpc-url $RPC
# 0x47340d900bdFec2BD393c626E12ea0656F938d84   ← 0G's InferenceServing, mainnet
cast call 0x4320Ae51D672f2636a0faFfb2B28C5520013b6D7 "registry()(address)" --rpc-url $RPC
cast call 0x2688059e106195941F320110bE2d5fe9a1c75fEE "registry()(address)" --rpc-url $RPC
# 0x857D288652e4f4523347EFf1918B9E1263A574f4   ← both
cast call 0x2688059e106195941F320110bE2d5fe9a1c75fEE "agent()(address)"    --rpc-url $RPC
cast call 0x2688059e106195941F320110bE2d5fe9a1c75fEE "owner()(address)"    --rpc-url $RPC
```

**The pinned policy**, read off the deployed gate. This is the question, the model, the provider and
the ceiling, all immutable since construction:

```bash
cast call 0x2688059e106195941F320110bE2d5fe9a1c75fEE \
  "getPolicy(uint256)((bytes,bytes,bytes32,address,uint8))" 1 --rpc-url $RPC
```

| Field | Value |
|---|---|
| `allowedProvider` | `0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D` |
| `allowedModelHash` | `0x19527b47f6aa914ad2ed1b557e750cc27a6f41f8679126e5875475faad42f7f4` = `keccak256("glm-5.2")` |
| `maxRisk` | `50` |
| `promptHead` | begins `{"model":"glm-5.2","temperature":0,"messages":[{"role":"system",…` |
| `promptTail` | `"}]}` |

`cast keccak "glm-5.2"` reproduces the model hash. The model name appears **once** — spliced into
the JSON and hashed into the policy from the same string — so the question and the acceptance
criterion cannot disagree.

**Funding.** One transfer in, from the owner, and it is the only one:
[`0x78d599c8…3c04247e4c`](https://chainscan.0g.ai/tx/0x78d599c8099c0fa18692e6c8041074e01f8b03b08d1728363331d03c04247e4c),
block [42839227](https://chainscan.0g.ai/block/42839227), **2.000000000000000000 0G**.

---

## The approval

The same machinery, answering yes.

| | |
|---|---|
| Writ | `0x3d5c0087c25a13c5469252dbb60c4e24b4d27d8300fb3ce55b4cd9d9686137a0` |
| Notarize | [`0xb974d422…3cd1cc4b`](https://chainscan.0g.ai/tx/0xb974d4226ee3a31019b8e1796660fe04a6e8e26eb428b50511420dc93cd1cc4b) · block [42839308](https://chainscan.0g.ai/block/42839308) · status `true` |
| Settle | [`0x7e08d9e4…8a3d4be7b`](https://chainscan.0g.ai/tx/0x7e08d9e4a84ac480e4eaaafd8864c625ddf5a2d76a6b22c567a98618a3d4be7b) · block [42839319](https://chainscan.0g.ai/block/42839319) · status `true` |
| Recipient | [`0x3aa4C7B26eCE5a6Fe26087B5fdD8eB36bC186dC5`](https://chainscan.0g.ai/address/0x3aa4C7B26eCE5a6Fe26087B5fdD8eB36bC186dC5) |
| Amount moved | `10000000000000000` wei — **0.01 0G**, and the recipient holds exactly that |
| Verdict | `ALLOW:15`, under the gate's ceiling of 50 |
| Transcript root | `0x74cb411827911ba0e483a5d8b88d18a22e209442d8fbb8c6a456d09aeace0b11` |

```bash
cast balance 0x3aa4C7B26eCE5a6Fe26087B5fdD8eB36bC186dC5 --rpc-url $RPC   # 10000000000000000
cast call 0x2688059e106195941F320110bE2d5fe9a1c75fEE \
  "recipientHistory(address)(uint64,uint192)" \
  0x3aa4C7B26eCE5a6Fe26087B5fdD8eB36bC186dC5 --rpc-url $RPC
# 1
# 10000000000000000
```

Both writs, read out of the registry:

```bash
cast call 0x857D288652e4f4523347EFf1918B9E1263A574f4 \
  "getWrit(bytes32)((address,bytes32,bytes32,bytes32,uint64,address))" \
  0x3d5c0087c25a13c5469252dbb60c4e24b4d27d8300fb3ce55b4cd9d9686137a0 --rpc-url $RPC
```

| | approval | refusal |
|---|---|---|
| `provider` | `0x7DCFe6AE…62DCe87D` | `0x7DCFe6AE…62DCe87D` |
| `modelHash` | `0x19527b47…ad42f7f4` (`glm-5.2`) | same |
| `reqHash` | `0xe9e0048d…36a88e9b` | `0x8add72ee…26e657ef` |
| `respHash` | `0x5629a9de…aa49fc1d` | `0x8ee2460f…ac870077` |
| `notarizedAt` | `1787891050` | `1787891140` |
| `notarizedBy` | the agent | the agent |

Both writ ids are content-addressed and recompute from their own parts, so the id is not a label
anyone chose:

```bash
cast call 0x857D288652e4f4523347EFf1918B9E1263A574f4 "writId(address,bytes32,bytes32)(bytes32)" \
  0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D \
  0x8add72eeb1b800edb7d47600ab4292a8ad29df8099f9c2882bbe1fd526e657ef \
  0x8ee2460fda2f758d7b9e636b9a827ce1bb0feae2766f2d29b7ef540cac870077 --rpc-url $RPC
# 0xf20090422eefd17f52b10ea8c38fe2957a886112dbabaa1c222f1cfb4345d31a
```

Both decisions are spent, so neither verdict can authorise a second transfer:

```bash
cast call 0x2688059e106195941F320110bE2d5fe9a1c75fEE "consumed(bytes32)(bool)" \
  0xf20090422eefd17f52b10ea8c38fe2957a886112dbabaa1c222f1cfb4345d31a --rpc-url $RPC   # true
```

---

## The link that matters: the question the contract wrote is the question the enclave signed

This is the claim the whole project rests on, and it is checkable end to end from public data.

`reqHash` is not something the caller supplied. `PolicyGate` computes it from
`sha256(promptHead ‖ buildParams(to, amount) ‖ promptTail)` using the treasury's **own state** — the
caller never gets to say what the question was. So if `sha256` of the reconstructed bytes equals the
`reqHash` in the writ, and the TEE signed that `reqHash`, then the enclave answered *this contract's*
question and no other.

Rebuild it yourself. The body is exactly `promptHead ‖ params ‖ promptTail`, all three read or
derived from the chain — `promptHead` and `promptTail` from `getPolicy(1)` above, and `params` from
the treasury's state at the moment the question was asked. For the refusal, `params` was:

```
recipient=0x000000000000000000000000000000000000dead amount=1900000000000000000 nonce=1 treasuryBalance=1990000000000000000 amountPctOfBalance=95 priorApprovals=1 priorRefusals=0 recipientPriorPayments=0 recipientPriorTotal=0
```

(one line; nothing is wrapped). The concatenation is **923 bytes** and its `sha256` is
`8add72eeb1b800edb7d47600ab4292a8ad29df8099f9c2882bbe1fd526e657ef` — the `reqHash` in the writ,
exactly. The approval's 920 bytes hash to `e9e0048d…36a88e9b`, likewise.

Every value in that string is the contract's, not the caller's: the balance and the two counters are
storage it read, `amountPctOfBalance` is arithmetic it did, and `nonce` is a number only it
increments. The caller supplies the recipient and the amount — which *are* the action — and nothing
else. That asymmetry is the prompt-swap defence, and here it is holding on mainnet.

The response half closes the same way. Pull the raw response bytes out of the settle transaction's
calldata — `execute(address,uint256,bytes,address)`, selector `0xecaef8ae` — and `sha256` them:
`8ee2460f…ac870077` for the refusal, `5629a9de…aa49fc1d` for the approval. Both are the `respHash`
in the writ.

And the TEE signed exactly `sha256hex(req):sha256hex(resp)` — the 129-byte text
[`WritLib.signedText`](contracts/src/WritLib.sol) rebuilds on chain — recovering to the address 0G's
registry names. That is the chain, unbroken:

```
contract-authored question  →  sha256  →  reqHash  ┐
provider's response bytes   →  sha256  →  respHash ┴→ "req:resp" → TEE signature
                                                                        ↓
                                            0G's registry: teeSignerAddress, acknowledged, TeeML
```

Note the arithmetic the contract did unaided: `amountPctOfBalance=95`, from
`mulDiv(1.9e18, 100, 1.99e18)`. The model was handed the ratio, not asked to divide two 18-decimal
integers. It then scored the risk at 95.

---

## The provider and its registered TEE key

Nothing about the provider is asserted by us. All of it is read live from
[0G's `InferenceServing`](https://chainscan.0g.ai/address/0x47340d900bdFec2BD393c626E12ea0656F938d84)
at `0x47340d900bdFec2BD393c626E12ea0656F938d84`, on **every** `notarize` call, by staticcall — never
a cached copy.

```bash
cast call 0x47340d900bdFec2BD393c626E12ea0656F938d84 \
  "getService(address)((address,string,string,uint256,uint256,uint256,string,string,string,address,bool))" \
  0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D --rpc-url $RPC
```

| Field | Value |
|---|---|
| `provider` | [`0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D`](https://chainscan.0g.ai/address/0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D) |
| `serviceType` | `chatbot` |
| `url` | `https://compute-network-19.integratenetwork.work` |
| `model` | `glm-5.2` |
| `verifiability` | `TeeML` |
| `teeSignerAddress` | **`0xA46EA4FC5889AD35A1487e1Ed04dCcfa872146B9`** |
| `teeSignerAcknowledged` | **`true`** |
| `additionalInfo` | `TEEVerifier: dstack`, `VerifierURL: …/dstack/releases/tag/verifier-v0.5.4` |

Both live signatures recover to that address and nothing else — including a negative control:

```bash
# the approval
cast wallet verify --address 0xA46EA4FC5889AD35A1487e1Ed04dCcfa872146B9 \
  "e9e0048de6d489b2bf799dadaee136d8e696138c31d817533ac9204736a88e9b:5629a9deaa88c642826ac76ef914db54f12b48dcb2fd1d015462db94aa49fc1d" \
  0x5f4d19e3a59a504ceeb7cab79cf4d2540d740cdd551b5166b8e2a4fcf15d9d0e64b6ecc6532a153a9601d10f2bdb3daeb930ad767e91dd825bbfcd65d18c28b61b
# Validation succeeded.

# a different provider's TEE key must fail
cast wallet verify --address 0x8561E0a9dA3C8d6591A2E756a91334f1a3E537e0 \
  "8add72eeb1b800edb7d47600ab4292a8ad29df8099f9c2882bbe1fd526e657ef:8ee2460fda2f758d7b9e636b9a827ce1bb0feae2766f2d29b7ef540cac870077" \
  0x0706447b8c4e20aa916e87eb9dcfe82b7c31d6578ad3aef0564487f0c4627aa955ab1c8873fa75942c8f4d8703ac29369c3439820c2c339679c7f8efe979bcd31c
# Error: Validation failed.
```

**What this does and does not establish.** It establishes that the key 0G's registry names as this
provider's TEE signer signed those two hashes. It does **not** establish that the key lives in a
genuine Intel TDX enclave — Writ verifies no attestation quote, no measurement registers, no
`ImageDigest`, no Intel PCS. That link in the chain is 0G's registry owner
[`0xddCDcbD9C7aeFB165dE00CE8684907fAAe8C8224`](https://chainscan.0g.ai/address/0xddCDcbD9C7aeFB165dE00CE8684907fAAe8C8224)
acknowledging the key, and Writ inherits it rather than closing it.
[`CLAIMS.md` NOT-CLAIMED #15](CLAIMS.md) says so at length and calls it the biggest one. It still is.

---

## The transcript in 0G Storage

Each transcript was uploaded to 0G Storage **before** its writ was notarized, and its merkle root
went on chain as the writ's first archive candidate.

| | approval | refusal |
|---|---|---|
| Storage `submit` tx | [`0xcf69c7e5…c29991a84d`](https://chainscan.0g.ai/tx/0xcf69c7e524e653b3673820ac5db922bafc0c53ccd944fc5ab1d2d8c29991a84d) | [`0xf3b71673…e20bde6635`](https://chainscan.0g.ai/tx/0xf3b71673fff39dedb25ab183af23ca2b30998d5c5b262eb86263c4e20bde6635) |
| Block | [42839295](https://chainscan.0g.ai/block/42839295) | [42839392](https://chainscan.0g.ai/block/42839392) |
| Size | 4190 bytes | 3569 bytes |
| Root | `0x74cb4118…eace0b11` | `0x312a8684…62f7061ee` |

```bash
cast call 0x857D288652e4f4523347EFf1918B9E1263A574f4 "transcriptRoots(bytes32)(bytes32[])" \
  0xf20090422eefd17f52b10ea8c38fe2957a886112dbabaa1c222f1cfb4345d31a --rpc-url $RPC
# [0x312a8684c1dee72e665296943a4792c4790f89fd9ab156bfec3cb4162f7061ee]
```

**Three independent checks, and the indexer is in none of them.**

1. **The bytes content-address.** Fetch the file from the indexer and recompute 0G Storage's merkle
   root locally with [`app/src/lib/zg-merkle.ts`](app/src/lib/zg-merkle.ts) — 256-byte chunks,
   keccak leaves, odd node carried to the end of the next level, padded to the flow's padded size.
   Both recompute to the roots recorded on chain. Whoever hands you the bytes is irrelevant.

2. **The root is anchored on chain independently of the indexer.** The `Submit` event on 0G's Flow
   contract [`0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526`](https://chainscan.0g.ai/address/0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526)
   carries the submission's subtree nodes and the file length. For the refusal: nodes of height
   3, 2 and 1 (8 + 4 + 2 = 14 chunks) and length `0xdf1` = 3569 bytes. Folding those three node
   roots right-to-left — `keccak(n₈ ‖ keccak(n₄ ‖ n₂))` — gives
   `0x312a8684…62f7061ee`, the root in the writ. The approval's two nodes (16 + 2 = 18 chunks,
   length `0x105e` = 4190) fold to `0x74cb4118…eace0b11` the same way.

3. **The transcript re-derives the writ.** `sha256` of its `request` field is the writ's `reqHash`;
   `sha256` of its `response` field is the writ's `respHash`. Both match for both writs.

```bash
curl -s "https://indexer-storage-turbo.0g.ai/file?root=0x312a8684c1dee72e665296943a4792c4790f89fd9ab156bfec3cb4162f7061ee" \
  | python -c "import json,sys,hashlib; d=json.load(sys.stdin); \
      print(hashlib.sha256(d['request'].encode()).hexdigest()); \
      print(hashlib.sha256(d['response'].encode()).hexdigest())"
# 8add72eeb1b800edb7d47600ab4292a8ad29df8099f9c2882bbe1fd526e657ef
# 8ee2460fda2f758d7b9e636b9a827ce1bb0feae2766f2d29b7ef540cac870077
```

The refusal transcript also carries `capturedAt: 2026-08-28T04:25:20.138Z` — 20 seconds before its
notarization at 04:25:40Z, in the order you would expect.

**Be exact about the standing of a root.** The TEE signs two hashes and nothing else. It does not
sign a pointer to an archive, so a transcript root is a *claim by whoever published it* and the
registry cannot check one. That is why `struct Writ` has no root field and `Notarized` carries none:
roots live in a separate append-only list with a per-address quota of 4, under their own
`TranscriptAdded` event, labelled as candidates. Verification is by re-deriving, above — not by
trusting the pointer. A candidate that does not re-derive is somebody's failed claim and says
nothing about the writ. [`CLAIMS.md` NOT-CLAIMED #11 and #29](CLAIMS.md).

---

## The second deployment, kept on purpose

There is an earlier `AgentTreasury` on 0G mainnet holding **2.0 0G** that **can never settle a
single transfer**. It is left there deliberately.

| Contract | Address |
|---|---|
| `WritRegistry` | [`0x44641b842D571aD06ab67357c710ABb640fc5e94`](https://chainscan.0g.ai/address/0x44641b842D571aD06ab67357c710ABb640fc5e94) |
| `PolicyGateFactory` | [`0xf063dd27Fc3ddFeC19FfbF96b1edaFD002e387C5`](https://chainscan.0g.ai/address/0xf063dd27Fc3ddFeC19FfbF96b1edaFD002e387C5) |
| `AgentTreasury` | [`0xaF9C87f5Eb7c3c5ebb16AcBa23C6cD25faCcAd63`](https://chainscan.0g.ai/address/0xaF9C87f5Eb7c3c5ebb16AcBa23C6cD25faCcAd63) |

Deployed [42808873–42808875](https://chainscan.0g.ai/block/42808875), 2026-08-27 20:05 UTC, from
deployer nonces 0–2. Funded with 2.0 0G at block
[42808948](https://chainscan.0g.ai/tx/0x2ee5a716d008153e9a64d504c56c967f5f1b5dfe60d89fe7cb8853a0a6eb81e5).

Its policy is pinned to provider
[`0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9`](https://chainscan.0g.ai/address/0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9)
and model `0GM-1.0-35B-A3B`, and it is dead:

```bash
cast call 0xaF9C87f5Eb7c3c5ebb16AcBa23C6cD25faCcAd63 "approvedCount()(uint96)" --rpc-url $RPC  # 0
cast call 0xaF9C87f5Eb7c3c5ebb16AcBa23C6cD25faCcAd63 "refusedCount()(uint96)"  --rpc-url $RPC  # 0
cast call 0xaF9C87f5Eb7c3c5ebb16AcBa23C6cD25faCcAd63 "nonce()(uint256)"        --rpc-url $RPC  # 0
cast call 0x44641b842D571aD06ab67357c710ABb640fc5e94 "writCount()(uint256)"    --rpc-url $RPC  # 0
cast balance 0xaF9C87f5Eb7c3c5ebb16AcBa23C6cD25faCcAd63 --rpc-url $RPC   # 2000000000000000000
```

Zero writs, zero decisions, two 0G sitting in it. **That provider's broker rewrites the request
before signing it**, so `sha256(the bytes we sent)` can never equal the request half of what the
enclave signed, and this gate can never accept a proof. Not a bug in the contract — a property of
the provider, discovered by pointing the contract at it.

We are not deleting it. A deployment that cannot work, left on chain with its two 0G stranded in it,
is better evidence than a clean run: it is the artifact that surfaced the finding, and it is the
only reason the finding exists.

---

## What the live run proved that a fork run could not

The very first live end-to-end run **failed**, and it failed in the one place a fork run cannot
reach.

The SDK's own guard refused to notarize:

```
provider signed "2dbfc853…:af714102…", which is not this request and response
```

Probing the halves separately:

| half | ours | TEE signed | |
|---|---|---|---|
| `sha256(response)` | `af714102…` | `af714102…` | matches byte for byte |
| `sha256(request)` | `1a197963…` | `2dbfc853…` | **differs** |

**Why.** `0gfoundation/0g-serving-broker`, `docs/design/request-translation.md`: the broker accepts a
portable OpenAI-schema request and rewrites certain fields into the third-party schema the target
model understands before forwarding it — driven by the model's advertised `supportedParameters`,
`max_tokens` ↔ `max_completion_tokens`, `reasoning_effort` into one of five upstream dialects, and
the model id possibly already rewritten to the upstream id. **The broker then signs the translated
body.** Corroborating it from the wire: that provider's response reported
`"model":"0GM-1.0-35B-A3B-0427"` while 0G's registry publishes it as serving `0GM-1.0-35B-A3B`.

Naive reconstructions do not recover the signed hash — the versioned model id, a `JSON.parse` round
trip, an added `stream:false`, and combinations were all tested and rejected. The transformation is
not something a contract can reproduce.

**Why 0G's own client-side check cannot see this.** Verified directly against the installed
`@0gfoundation/0g-compute-ts-sdk@0.9.0`:

```js
// inference/broker/verifier.js
static verifySignature(message, signature, expectedAddress) {
    const messageHash = ethers.hashMessage(message);
    const recoveredAddress = ethers.recoverAddress(messageHash, signature);
    return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
}

// inference/broker/response.js — the only caller
const ResponseSignature = await Verifier.fetchSignatureByChatID(svc.url, chatID, svc.model);
return Verifier.verifySignature(ResponseSignature.text, ResponseSignature.signature, signingAddress);
```

The text being verified is `ResponseSignature.text` — **whatever the provider returned**. The
request and response bodies are not among the arguments; the helper could not rebuild the text even
if it wanted to. A translated request therefore reads as verified. Writ rebuilds the text from the
bytes it actually sent, which is precisely why the divergence surfaced on the first run and not
later. This is a scope limitation of a client-side convenience helper, stated as such — not a
vulnerability in 0G.

**Measured across four acknowledged TeeML providers**, live, with a minimal body:

| provider | model | request | response |
|---|---|---|---|
| `0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9` | `0GM-1.0-35B-A3B` | differs | matches |
| `0xf56fAaf9989aDafDDf26fa5Ffdd03a9A27b38fAE` | `0GM-1.0-35B-A3B-SIA` | differs | matches |
| `0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D` | `glm-5.2` | **matches** | matches |
| `0x25F8f01cA76060ea40895472b1b79f76613Ca497` | `openai/gpt-5.4-mini` | **matches** | matches |

All four are registered `TeeML` with an acknowledged signer, verifiable with the `getService` call
above. Two translate, two pass through. **So the design works — but only against a provider that
passes the request through, and that is a property to measure, not to assume.** Response binding is
unaffected everywhere.

The consequence for Writ, stated plainly: on-chain **request** binding — the prompt-swap defence —
requires the broker to forward the body unmodified. Where it translates, the contract cannot compute
the hash the enclave signed, and the proof cannot be tied to the question the contract wrote. The
fix is not a contract change; it is a preflight compatibility check, because this is a property of
the provider and it has to be measured before a policy is pinned to one.

The live deployment is pinned to `glm-5.2`, a measured pass-through provider. The stranded one is
pinned to a translating provider. Both are on chain.

---

## What is still not proven

Stated plainly, because a proof file that only lists wins is not a proof file.

**The graded evaluation has never been run against a real model.** `EVAL.md`'s scorecard — 43
scenarios, 0 false approvals, 21/21 traps refused — comes from a `--fork` run against a **local
anvil fork with a stand-in signer we control and whose replies we wrote**. The artifact says so
about itself (`"modelBehaviourMeasured": false`), `eval/results/` contains `fork.json` and no
`live.json`, and **`--live` has still never been executed**. Nothing on this page changes that. The
two decisions above are live TEE inference; they are not a graded evaluation, and two data points
are not a measurement of judgement. Do not read the fork scorecard as evidence about `glm-5.2`.

**Writ verifies no Intel TDX attestation quote.** See [the provider section](#the-provider-and-its-registered-tee-key).
The trust chain bottoms out on 0G's registry owner acknowledging a key.

**The TEE signs no model name.** `modelHash` is what 0G's registry says the provider serves, not
what the enclave attested. A provider whose endpoint honours a `model` field differing from its
registration can be asked for one model and answer with another, and the writ still records the
registered name. [`CLAIMS.md` NOT-CLAIMED #12 and #26](CLAIMS.md).

**A transcript root is unsigned.** [Above](#the-transcript-in-0g-storage). Re-derive; do not trust
the pointer.

**Two decisions is not a sample.** No repetition, no variance measurement, no adversarial live
prompt-swap attempted against the deployed gate. The prompt-swap defence is proven by
[`AgentTreasury.t.sol::test_refusesPromptSwap`](contracts/test/AgentTreasury.t.sol) in the test
suite, not by anything on chain.

**The 29 numbered limitations in [`CLAIMS.md`](CLAIMS.md) all still stand.** Deployment did not
retire any of them.

### What those documents said, and what actually changed

`CLAIMS.md` §6 "What has never been run" listed five things. Four of them have now been run, and the
fifth is no longer true:

| | then | now |
|---|---|---|
| 6.1 | No contract deployed to 0G mainnet | three contracts, blocks 42839181–42839182 (and three more on 42808873–42808875) |
| 6.2 | No inference against a live 0G Compute provider | two, against `glm-5.2` at `0x7DCFe6AE…` |
| 6.3 | No transcript uploaded to or downloaded from 0G Storage | two uploaded, both roots on chain, both retrievable |
| 6.4 | No proof from a real enclave notarized | two, both recovering to `0xA46EA4FC…` |
| 6.5 | The deployer wallet is unfunded | it is funded; that is what unblocked the rest |

`5.5` and `1.11` remain accurate about the eval, and `EVAL.md` is correct as written. Wherever
`README.md`, `JUDGES.md`, `MOCKS.md` or `docs/architecture.md` still carries a "nothing is deployed"
banner, it predates this file and this file wins.

---

## Timing: inside the Wave 3 window

Wave 3 opened **2026-08-13** and closes **2026-08-30 17:00**. Every timestamp below is a block
timestamp read from the chain, not a claim.

| Event | Block | Unix | UTC |
|---|---|---|---|
| First deployment | 42808873–42808875 | 1787861104 | 2026-08-27 20:05:04 |
| First treasury funded | 42808948 | 1787861173 | 2026-08-27 20:06:13 |
| `WritRegistry` deployed | 42839181 | 1787890928 | 2026-08-28 04:22:08 |
| `PolicyGateFactory`, `AgentTreasury` | 42839182 | 1787890929 | 2026-08-28 04:22:09 |
| Treasury funded, 2.0 0G | 42839227 | 1787890972 | 2026-08-28 04:22:52 |
| Approval transcript → 0G Storage | 42839295 | 1787891037 | 2026-08-28 04:23:57 |
| Approval notarized | 42839308 | 1787891050 | 2026-08-28 04:24:10 |
| Approval settled, 0.01 0G moved | 42839319 | 1787891060 | 2026-08-28 04:24:20 |
| Refusal transcript → 0G Storage | 42839392 | 1787891129 | 2026-08-28 04:25:29 |
| Refusal notarized | 42839403 | 1787891140 | 2026-08-28 04:25:40 |
| **Refusal settled, nothing moved** | 42839414 | 1787891151 | 2026-08-28 04:25:51 |

Window bounds are `1786579200` and `1788109200`; every value above falls between them.

```bash
cast block 42839414 --rpc-url $RPC | grep timestamp
```

---

## What it cost

At the effective gas price of the run, `3521243522` wei (~3.52 gwei):

| Transaction | gas used | fee |
|---|---:|---:|
| `notarize` (approval) | 366,711 | 0.001291 0G |
| `execute` (approval) | 329,043 | 0.001159 0G |
| `notarize` (refusal) | 349,575 | 0.001231 0G |
| `execute` (refusal) | 245,306 | 0.000864 0G |
| **four decision transactions** | **1,290,635** | **0.004545 0G** |

Under 0.005 0G for the whole run: two permanent, independently verifiable records of a TEE-attested
treasury decision, and the transfers they authorised. Refusing is *cheaper* than approving — there
is no payout and no recipient-history write. These are the real numbers a caller paid on mainnet,
which the fork measurements in `JUDGES.md` were estimating; they are higher than those figures
because these are whole transactions including calldata and intrinsic gas, not bracketed
`gasleft()` windows.

Gas figures from the receipts themselves:

```bash
cast receipt 0x8e29c1e6f2f3c10162c363a033be91b3fb738560bfa24441d5b3f895cbf59cdb \
  gasUsed --rpc-url $RPC   # 245306
```

---

## Every check on this page, in one block

```bash
export RPC=https://evmrpc.0g.ai
REG=0x857D288652e4f4523347EFf1918B9E1263A574f4
TRE=0x2688059e106195941F320110bE2d5fe9a1c75fEE
SERV=0x47340d900bdFec2BD393c626E12ea0656F938d84
WRIT_ALLOW=0x3d5c0087c25a13c5469252dbb60c4e24b4d27d8300fb3ce55b4cd9d9686137a0
WRIT_DENY=0xf20090422eefd17f52b10ea8c38fe2957a886112dbabaa1c222f1cfb4345d31a

cast chain-id --rpc-url $RPC                                              # 16661
cast call $REG "writCount()(uint256)"    --rpc-url $RPC                   # 2
cast call $REG "serving()(address)"      --rpc-url $RPC                   # $SERV
cast call $TRE "approvedCount()(uint96)" --rpc-url $RPC                   # 1
cast call $TRE "refusedCount()(uint96)"  --rpc-url $RPC                   # 1
cast call $TRE "nonce()(uint256)"        --rpc-url $RPC                   # 2
cast balance $TRE --rpc-url $RPC                                          # 1990000000000000000

cast call $REG "getWrit(bytes32)((address,bytes32,bytes32,bytes32,uint64,address))" $WRIT_DENY  --rpc-url $RPC
cast call $REG "getWrit(bytes32)((address,bytes32,bytes32,bytes32,uint64,address))" $WRIT_ALLOW --rpc-url $RPC
cast call $REG "transcriptRoots(bytes32)(bytes32[])" $WRIT_DENY --rpc-url $RPC
cast call $TRE "consumed(bytes32)(bool)" $WRIT_DENY  --rpc-url $RPC       # true
cast call $TRE "consumed(bytes32)(bool)" $WRIT_ALLOW --rpc-url $RPC       # true

cast call $TRE "recipientHistory(address)(uint64,uint192)" 0x000000000000000000000000000000000000dEaD --rpc-url $RPC  # 0, 0
cast call $TRE "recipientHistory(address)(uint64,uint192)" 0x3aa4C7B26eCE5a6Fe26087B5fdD8eB36bC186dC5 --rpc-url $RPC  # 1, 1e16

cast receipt 0x7e08d9e4a84ac480e4eaaafd8864c625ddf5a2d76a6b22c567a98618a3d4be7b status --rpc-url $RPC  # true
cast receipt 0x8e29c1e6f2f3c10162c363a033be91b3fb738560bfa24441d5b3f895cbf59cdb status --rpc-url $RPC  # true

cast call $SERV "getService(address)((address,string,string,uint256,uint256,uint256,string,string,string,address,bool))" \
  0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D --rpc-url $RPC

# the stranded deployment
cast call 0xaF9C87f5Eb7c3c5ebb16AcBa23C6cD25faCcAd63 "approvedCount()(uint96)" --rpc-url $RPC  # 0
cast call 0x44641b842D571aD06ab67357c710ABb640fc5e94 "writCount()(uint256)"    --rpc-url $RPC  # 0
cast balance 0xaF9C87f5Eb7c3c5ebb16AcBa23C6cD25faCcAd63 --rpc-url $RPC  # 2000000000000000000
```

If any figure on this page does not reproduce, that is a finding, and we would rather have it than
not.
