import Link from 'next/link'
import { config } from '@/lib/config'

export const metadata = {
  title: 'Writ — how it works',
  description: 'What the signature covers, what the contract checks, and what none of it proves.',
}

export default function AboutPage() {
  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="split">
            <div>
              <p className="eyebrow">How it works</p>
              <h1>Which model said what, to which question</h1>
            </div>
            <div className="stack">
              <p className="lede">
                0G Compute runs models inside Intel TDX enclaves and signs{' '}
                <span className="mono">sha256(request bytes):sha256(response bytes)</span> with a hardware key whose
                address 0G publishes on chain. Writ checks that signature <em>inside a smart contract</em>, records it
                permanently, and lets contracts act on the verified decision.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="wrap">
        <div className="tribunal">
          <div className="trow banner">
            <div className="side l">
              <h2>
                What is proved
                <span className="sub">by arithmetic, not by anyone&rsquo;s word</span>
              </h2>
            </div>
            <div className="pin">
              <span className="seam-label">the line</span>
            </div>
            <div className="side r">
              <h2>
                What is not
                <span className="sub">said plainly, because overclaiming is the failure mode</span>
              </h2>
            </div>
          </div>

          <div className="trow" style={{ borderBottom: '1px solid var(--rule)' }}>
            <div className="side-pad l-pad">
              <ol className="reasons">
                <li>
                  <b>The question was this question.</b> The signature covers the request bytes, and the contract built
                  those bytes itself from its stored policy and its own live state. A prompt cannot be swapped for a
                  friendlier one, because the friendlier one hashes differently.
                </li>
                <li>
                  <b>The answer was this answer.</b> Same signature, other side of the colon.
                </li>
                <li>
                  <b>The signer was an enclave 0G vouches for.</b> Recovery has to land on the{' '}
                  <span className="mono">teeSignerAddress</span> that 0G&rsquo;s own{' '}
                  <span className="mono">InferenceServing</span> registry publishes — read live, on the same chain, as a
                  plain staticcall. No oracle, no bridge, no admin key, no relayer.
                </li>
                <li>
                  <b>One verdict authorises one action.</b> The writ id is content-addressed and the gate marks it
                  spent, and the action&rsquo;s nonce is inside the signed question.
                </li>
                <li>
                  <b>Nothing here can be edited afterwards.</b> The registry is ownerless, non-upgradeable, and has no
                  allowlist. Anyone may notarize any valid proof; nobody may remove one.
                </li>
              </ol>
            </div>
            <div className="pin" />
            <div className="side-pad r-pad">
              <ol className="reasons">
                <li>
                  <b>That the model was right.</b> Writ proves attribution, not correctness. A confidently wrong model
                  produces a confidently wrong, permanently recorded decision.
                </li>
                <li>
                  <b>That the same prompt would answer the same way twice.</b> It might not. Writ is not a
                  reproducibility claim.
                </li>
                <li>
                  <b>That Intel is trustworthy.</b> The trust base is Intel TDX plus 0G&rsquo;s registry. Break either
                  and the guarantee goes with it. That is a smaller trust base than an oracle committee, not no trust
                  base.
                </li>
                <li>
                  <b>That a treasury is safe from its own owner.</b> The 30-day recovery hatch is real and the owner
                  holds it. It exists so a dead provider cannot brick a treasury forever, and every page here says so.
                </li>
              </ol>
            </div>
          </div>

          <div className="trow" style={{ borderBottom: '1px solid var(--rule)' }}>
            <div className="side-pad l-pad">
              <h3 className="h5">A refusal is a receipt</h3>
              <p className="note" style={{ marginLeft: 'auto' }}>
                When a gate refuses, the transaction succeeds. It notarizes the proof, emits{' '}
                <span className="mono">TransferRefused</span>, spends the nonce, and returns false. The funds stay where
                they were and that fact is now a permanent record rather than an absence of one.
              </p>
              <p className="note" style={{ marginLeft: 'auto', marginTop: 12 }}>
                Only a failure to <em>verify</em> reverts — because then the caller has not shown a decision at all.
              </p>
            </div>
            <div className="pin">
              <span className="seam-label">both are settled</span>
            </div>
            <div className="side-pad r-pad">
              <h3 className="h5">And a broken proof is not a refusal</h3>
              <p className="note">
                Those are opposite things, so this site never draws them alike. A verdict lives on the seam in colour
                and is always a settled outcome. Proof state lives on the four rows of a{' '}
                <Link href="/">writ page</Link> in plain ink and knocked-out type, and is the only thing anywhere here
                allowed to read as broken.
              </p>
            </div>
          </div>

          <div className="trow" style={{ padding: '30px 0 50px' }}>
            <div className="side-pad l-pad">
              <h3 className="h5">Check it yourself</h3>
              <p className="note" style={{ marginLeft: 'auto' }}>
                Open any writ and press <b>Verify in your browser</b>. All four checks are re-derived in your tab from
                public sources: the chain over <span className="mono">{config.rpcUrl}</span>, 0G&rsquo;s registry over
                that same RPC, and 0G Storage over its public indexer — all three of which answer a browser directly.
                This app&rsquo;s backend serves the page and nothing else.
              </p>
            </div>
            <div className="pin" />
            <div className="side-pad r-pad">
              <h3 className="h5">Then try to break it</h3>
              <p className="note">
                On the same page, edit one byte of the pinned question. The sha256 turns over completely, the text the
                enclave would have had to sign becomes a different string, and recovery lands on an address nobody has
                published. The gate would revert with <span className="mono">BadSignature</span> and no decision would
                exist. Nothing about that demonstration is stored — it is computed from the characters you typed.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
