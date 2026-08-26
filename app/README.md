# Writ — the docket

The public face of Writ: a live record of AI decisions that a smart contract verified, and a page
where anyone can re-derive the proof of any one of them in their own browser.

Four views, one Next.js app.

| Route             | What it is                                                                          |
| ----------------- | ----------------------------------------------------------------------------------- |
| `/`               | **The docket.** Every decision across every gate — held on the left, released on the right. |
| `/writ/[id]`      | **The proof chain.** Four independently checkable rows, plus a live tamper demo.      |
| `/studio`         | **Compose a policy.** Live providers, the exact bytes a gate will pin, and their sha256. |
| `/gate/[address]` | **One treasury.** Balance, policy, a double-entry ledger, and the recovery countdown. |

Read-only views need no wallet, no account, no funds and no install. Only deploying a gate from
Studio and sweeping a treasury need a signer.

## Running it

```bash
pnpm install
cp .env.example .env.local     # then fill in the two contract addresses
pnpm dev
```

`pnpm test` runs the client-side verification suite. `pnpm build` produces the production build.

Nothing is deployed yet, so the addresses in `.env.example` are blank. The app works the moment
real ones are supplied; until then every view states plainly that there is nothing to read rather
than rendering an empty page that could be mistaken for an empty chain.

To try it without spending anything, run a local fork and point the app at it:

```bash
anvil --fork-url https://evmrpc.0g.ai
# deploy WritRegistry and PolicyGateFactory to the fork, then:
# NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545 in .env.local
```

## What the design is arguing

**A refusal is a successful transaction, not an error.** That is the emotional core of the product,
so it is carried structurally rather than stated in a caption.

A single vertical **seam** splits the viewport for its full height. Held sits on the left in cold
blue, released on the right in warm gold. Neither verdict is red. Refusal permanently occupies half
the screen, which makes it impossible to read as an exception or an error path — it is one of the
two things this product does, given equal architecture. The running counters sit **on** the seam as
one balance rather than as a success metric beside a failure metric.

**Risk is plotted as distance from the seam.** The ceiling is not a tick mark on a bar; it *is* the
centre line. So a decision that went over it is drawn further from the middle of your screen, and
`+47` means forty-seven over. You read a page of enforcement before you read a word.

Exactly one warm accent is reserved for the over-ceiling overshoot and used for nothing else
anywhere in the app, so the only saturated object on any screen is always the thing being enforced.

On a writ page the same seam does the product's actual thesis: **the pinned question on the left,
the answer on the right, and one signature binding them across the line.** That is the claim, drawn
rather than described — the TEE signs `sha256(request):sha256(response)`, so a contract that holds
the bytes can prove *which question was asked*.

### Verdict state and proof state never share a visual language

This is the most important correctness point in the interface.

A refused transfer is the system working correctly. A failed proof is the system telling you
something is wrong. If the two rhymed, a proof failure would start reading like a refusal, and they
are opposite things.

So they run on separate channels:

- **Verdict** lives on the seam, in colour, and is always a settled outcome. Held is blue, released
  is gold, money that did not move is struck through in its own verdict colour.
- **Proof state** lives on the four rows of a writ page, in achromatic geometry — a square node on
  the centre line, knocked-out type, and a hatch. It is the only thing in the entire app permitted
  to read as broken, and it never borrows a verdict colour or the reserved accent.

The proof channel also keeps its own vocabulary: a check is *checked*, *broken*, or *not run*. It
never says held, released, allowed or refused.

### Below 820px

The seam has nowhere to live in one column, so it becomes edge-on: the verdict colour is the row's
left-hand rule, and the distance-from-the-seam measurement falls back to an explicit bar against
the ceiling — black to the ceiling, the reserved accent for the overrun, a tick at the line. Same
semantics, less width. On a writ page the four proof nodes leave the centre line and become a spine
down the left. The empty half disappears, because emptiness was the seam's job and there is no seam.

## What the app will not do

**It will never fabricate state.** Every value on every page was read from somewhere, and anything
that could not be read is shown as a stated gap with the reason — hatched, dashed, and impossible
to mistake for content. There is no branch anywhere that substitutes a plausible default for a
value it does not have, and `unavailable` is kept rigorously distinct from `fail`:

- `fail` — the check ran and the claim did not hold. This is evidence.
- `unavailable` — the check could not be run. This is a missing measurement, and it is never a pass.

If 0G Storage does not answer, the transcript row says so, and the signature row that depends on it
says it is unavailable *because* of that — it does not fall back to the signer the transcript names
for itself, because a provider that vouches for its own key proves nothing.

## The trust path

"Verify in your browser" is literal. All three sources answer a browser directly, with
`Access-Control-Allow-Origin: *`:

1. the chain, over its public RPC — `WritRegistry.getWrit`
2. 0G's own `InferenceServing`, over the same RPC — the registered TEE signer
3. 0G Storage, over its public indexer — `GET /file?root=…`

The bytes that come back are content-addressed: `zg-merkle.ts` rebuilds 0G Storage's merkle root in
the browser and compares it with the root the chain recorded, so the byte source is interchangeable
and untrusted. A file dropped in from disk gets the identical check.

**This app's backend serves the page and nothing else.** It is not in the trust path, and every
writ page says so where a reader will see it.

## Tests

```bash
pnpm test
```

92 tests, in seven files:

- `verify.test.ts` — the four checks over real sha256 and real EIP-191 signatures. A sound proof
  passes; an edited question fails on hashes; an edited answer fails on hashes; a signature from a
  key the registry never published fails on the signer; a doctored transcript cannot vouch for its
  own signed text; unavailable never becomes pass.
- `zg-merkle.test.ts` — the 0G Storage merkle port, against vectors from the storage SDK itself,
  across every branch of the padding rule.
- `abi.test.ts` — every event signature and struct field order checked against the Solidity
  sources. The app decodes logs positionally, so a reordered parameter would render the wrong
  number beside the right verdict rather than throwing.
- `policy.test.ts` — Studio's byte preview against `TreasuryGate.buildParams`, field for field.
- `storage.test.ts` — the content-addressed fetch, including every way it can refuse.
- `transcript.test.ts` — parsing, and the verdict grammar read exactly as `VerdictLib` reads it.
- `presentation.test.ts` — amounts truncate rather than round, distance-from-seam, refusal naming.
