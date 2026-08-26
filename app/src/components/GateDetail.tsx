'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Amount, CeilingBar, Gap } from '@/components/primitives'
import { refusedByPhrase } from '@/lib/abi'
import { connectWallet, explain, gateContract } from '@/lib/chain'
import { addressUrl, config, txUrl } from '@/lib/config'
import { ago, formatCount, formatOG, untilParts, untilPhrase, utc } from '@/lib/format'
import { loadGate, type GateDetail as GateData, type LedgerLine } from '@/lib/gate'
import { shortAddress, shortHash } from '@/lib/hashes'

type State =
  | { kind: 'loading' }
  | { kind: 'error'; reason: string }
  | { kind: 'ready'; data: GateData }

export function GateDetail({ address }: { address: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const data = await loadGate(address, controller.signal)
        if (!controller.signal.aborted) setState({ kind: 'ready', data })
      } catch (e) {
        if (!controller.signal.aborted) setState({ kind: 'error', reason: explain(e) })
      }
    })()
    return () => controller.abort()
  }, [address])

  if (state.kind === 'loading') {
    return (
      <div className="wrap pad center dim">
        Reading <span className="mono">{address}</span> from your browser…
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="wrap pad" style={{ maxWidth: '66ch' }}>
        <Gap title="This treasury could not be read">
          <p>{state.reason}</p>
          <p>
            <code>{address}</code> may not be a gate, or may live on a chain other than {config.networkName}. Nothing
            below has been assumed in its place.
          </p>
          <p>
            <Link href="/gate">Back to the treasuries</Link>
          </p>
        </Gap>
      </div>
    )
  }

  const g = state.data
  const heldTotal = g.ledger.length ? g.ledger[g.ledger.length - 1]!.heldSoFar : 0n
  const releasedTotal = g.ledger.length ? g.ledger[g.ledger.length - 1]!.releasedSoFar : 0n

  return (
    <div className="wrap">
      <div className="tribunal">
        <div className="trow banner">
          <div className="side l">
            <h2>
              Held
              <span className="sub">
                {formatCount(g.refusedCount)} refusal{g.refusedCount === 1 ? '' : 's'}, all of them settled transactions
              </span>
            </h2>
          </div>
          <div className="pin">
            <span className="seam-label">ceiling {g.policy.maxRisk}</span>
          </div>
          <div className="side r">
            <h2>
              Released
              <span className="sub">
                {formatCount(g.approvedCount)} approval{g.approvedCount === 1 ? '' : 's'}, each against a signed answer
              </span>
            </h2>
          </div>
        </div>

        <div className="trow balance">
          <div className="l">
            <span>
              <b className="tnum">{formatOG(heldTotal).text}</b> 0G never left this treasury
            </span>
          </div>
          <div className="pin">
            <div className="on-seam">
              <div className="n tnum">{formatOG(g.balance).text}</div>
              <div className="k">0G on hand</div>
            </div>
          </div>
          <div className="r">
            <span>
              <b className="tnum">{formatOG(releasedTotal).text}</b> 0G was paid out
            </span>
          </div>
        </div>

        <Facts gate={g} />
        <Ledger gate={g} heldTotal={heldTotal} releasedTotal={releasedTotal} />
        <Policy gate={g} />
        <Recovery gate={g} />

        {g.problems.length > 0 ? (
          <div className="trow">
            <div style={{ gridColumn: '1 / -1', maxWidth: '66ch', margin: '18px auto', padding: '0 18px' }}>
              <Gap title="Some of this page could not be read">
                <ul>
                  {g.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Gap>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Facts({ gate }: { gate: GateData }) {
  return (
    <div className="trow" style={{ borderBottom: '1px solid var(--rule)' }}>
      <div className="side-pad l-pad">
        <h3 className="h5">Who may do what</h3>
        <p className="facts">
          treasury <Addr address={gate.address} />
          <br />
          agent <Addr address={gate.agent} /> — the only address <span className="mono">execute</span> accepts
          <br />
          owner <Addr address={gate.owner} /> — holds the recovery hatch, and nothing else
          <br />
          registry <Addr address={gate.registry} />
          <br />
          nonce {formatCount(gate.nonce)} — spent by every decision, refusals included
        </p>
      </div>
      <div className="pin" />
      <div className="side-pad r-pad">
        <h3 className="h5">What the agent cannot do</h3>
        <p className="note">
          Move a single wei without a TEE-signed answer to this contract&rsquo;s own question about this exact
          recipient, amount and nonce. Not by asking the model something easier — the question is rebuilt on chain and
          the hashes have to match. Not by replaying an old ALLOW — the nonce and the treasury&rsquo;s live state are
          both inside the question. Not by waiting the owner out — the recovery hatch is the owner&rsquo;s, not the
          agent&rsquo;s.
        </p>
      </div>
    </div>
  )
}

/**
 * The double-entry ledger.
 *
 * Two columns of one book, decimals aligned, sums carried forward, and the seam between them as
 * the rule. A refusal does not error and does not vanish — it posts to the withheld column and
 * the folio still foots. That is the same argument the seam makes, said in the language of
 * accounting, and it gives the numbers their frame for free.
 */
function Ledger({ gate, heldTotal, releasedTotal }: { gate: GateData; heldTotal: bigint; releasedTotal: bigint }) {
  if (gate.ledger.length === 0) {
    return (
      <div className="trow" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="pad" style={{ gridColumn: '1 / -1', maxWidth: '62ch', margin: '0 auto' }}>
          <Gap title="No decisions in the scanned range">
            <p>
              This gate has emitted no <code>TransferApproved</code> or <code>TransferRefused</code> between blocks{' '}
              {formatCount(gate.range.fromBlock)} and {formatCount(gate.range.toBlock)}. Its counters report{' '}
              {formatCount(gate.approvedCount)} approvals and {formatCount(gate.refusedCount)} refusals over its whole
              life, so anything missing here is outside the scanned window rather than absent from the chain.
            </p>
          </Gap>
        </div>
      </div>
    )
  }

  // Newest first for reading; the running sums were accumulated oldest-first, so the top row
  // carries the totals for the whole folio.
  const rows = [...gate.ledger].reverse()

  return (
    <div className="trow" style={{ borderBottom: '1px solid var(--rule)' }}>
      {/* The one band where the seam steps aside. A ledger's rule between its two money
          columns is the same boundary the seam draws, but accounting puts it where the
          numbers are, not at the middle of the page. Two vertical rules meaning one thing
          would be worse than moving it, so this band paints over the seam and the double
          rule below carries it instead. */}
      <div className="ledger-band" style={{ gridColumn: '1 / -1', padding: '26px 18px' }}>
        <h3 className="h5">The book · {formatCount(gate.ledger.length)} entries in the scanned range</h3>
        <div className="scroll-x">
          <table className="ledger">
            <thead>
              <tr>
                <th className="left">When</th>
                <th className="left">Writ</th>
                <th className="left">Recipient</th>
                <th>Risk / ceiling</th>
                <th className="col-held">Withheld 0G</th>
                <th className="gutter" aria-hidden="true" />
                <th className="col-released">Disbursed 0G</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((line) => (
                <Line key={line.key} line={line} ceiling={gate.policy.maxRisk} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="left carry" colSpan={4}>
                  Sum of this folio, carried forward
                </td>
                <td className="col-held num">
                  <Amount wei={heldTotal} />
                </td>
                <td className="gutter" aria-hidden="true" />
                <td className="col-released num">
                  <Amount wei={releasedTotal} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="note" style={{ marginTop: 14, maxWidth: '68ch' }}>
          Every decision posts to exactly one column and never to neither. {formatOG(heldTotal).text} 0G stayed where it
          was; {formatOG(releasedTotal).text} 0G moved. Both halves of that sentence are permanent records with
          transaction hashes, and either can be re-checked by a stranger without asking us.
        </p>
      </div>
    </div>
  )
}

function Line({ line, ceiling }: { line: LedgerLine; ceiling: number }) {
  const held = line.side === 'held'
  return (
    <tr className={held ? 'held' : 'released'} style={{ ['--acc' as string]: held ? 'var(--held)' : 'var(--released)' }}>
      <td className="left">
        {line.timestamp !== null ? (
          <>
            <span title={utc(line.timestamp)}>{ago(line.timestamp)} ago</span>
          </>
        ) : (
          <span className="dimmer">#{formatCount(line.blockNumber)}</span>
        )}
        <br />
        <TxLink hash={line.txHash}>
          <span className="dimmer" style={{ fontSize: 11 }}>
            {shortAddress(line.txHash)}
          </span>
        </TxLink>
      </td>
      <td className="left">
        <Link href={`/writ/${line.writId}`} className="mono" style={{ fontSize: 12 }}>
          {shortHash(line.writId, 8, 6)}
        </Link>
        {line.model ? (
          <>
            <br />
            <span className="dimmer" style={{ fontSize: 11.5 }}>
              {line.model}
            </span>
          </>
        ) : null}
      </td>
      <td className="left mono" style={{ fontSize: 12 }}>
        {shortAddress(line.to)}
        {held ? (
          <>
            <br />
            <span className="dimmer" style={{ fontFamily: 'inherit', fontStyle: 'italic', fontSize: 11.5 }}>
              {refusedByPhrase(line.refusedBy)}
            </span>
          </>
        ) : null}
      </td>
      <td>
        <span className="tnum">
          {line.risk} / {ceiling}
        </span>
        <div style={{ minWidth: 110 }}>
          <ForceBar risk={line.risk} ceiling={ceiling} />
        </div>
      </td>
      <td className="col-held num">{held ? <Amount wei={line.amount} /> : ''}</td>
      <td className="gutter" aria-hidden="true" />
      <td className="col-released num">{held ? '' : <Amount wei={line.amount} />}</td>
    </tr>
  )
}

/** Inside a table the seam has no room, so the compact ceiling bar carries the measurement. */
function ForceBar({ risk, ceiling }: { risk: number; ceiling: number }) {
  return (
    <div className="ceilbar-always">
      <CeilingBar risk={risk} ceiling={ceiling} />
    </div>
  )
}

function Policy({ gate }: { gate: GateData }) {
  return (
    <div className="trow" style={{ borderBottom: '1px solid var(--rule)' }}>
      <div className="side-pad l-pad">
        <h3 className="h5">The question this gate pins</h3>
        <pre className="code" style={{ maxHeight: '30vh' }}>
          {gate.policy.promptHead}
          {'\n\n···  the contract writes its own facts here  ···\n\n'}
          {gate.policy.promptTail}
        </pre>
      </div>
      <div className="pin" />
      <div className="side-pad r-pad">
        <h3 className="h5">And what it will accept</h3>
        <p className="facts">
          allowedModelHash <span className="mono">{gate.policy.allowedModelHash}</span>
          <br />
          allowedProvider{' '}
          {/^0x0{40}$/i.test(gate.policy.allowedProvider) ? (
            <em>any acknowledged TeeML provider</em>
          ) : (
            <Addr address={gate.policy.allowedProvider} />
          )}
          <br />
          maxRisk <b>{gate.policy.maxRisk}</b>
        </p>
        <p className="note" style={{ marginTop: 12 }}>
          An <span className="mono">ALLOW</span> above {gate.policy.maxRisk} is refused with{' '}
          <span className="mono">refusedBy = Policy</span>: the model was willing and this ceiling was not. A{' '}
          <span className="mono">DENY</span> is refused with <span className="mono">refusedBy = Model</span>. Both mean
          no funds moved, and the record says which happened.
        </p>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────── the recovery hatch ───── */

function Recovery({ gate }: { gate: GateData }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [action, setAction] = useState<{ kind: 'idle' | 'busy' | 'done' | 'failed'; message?: string }>({ kind: 'idle' })

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  const parts = untilParts(gate.recoveryAvailableAt, now)
  const days = Math.round(gate.recoveryDelay / 86_400)

  async function onRecover() {
    setAction({ kind: 'busy' })
    try {
      const connection = await connectWallet()
      const tx = await gateContract(gate.address, connection.signer).recover(connection.address)
      await tx.wait()
      setAction({ kind: 'done', message: `Swept to ${connection.address} in ${tx.hash}` })
    } catch (e) {
      setAction({ kind: 'failed', message: explain(e) })
    }
  }

  return (
    <div className="trow" style={{ padding: '30px 0 44px' }}>
      <div className="side-pad l-pad">
        <h3 className="h5">The escape hatch</h3>
        <p className="note" style={{ marginLeft: 'auto' }}>
          If the provider stops signing, or the agent stops asking, this treasury would be stuck forever. So the owner
          may sweep it after {days} days without a decision — and any verified proof, approval or refusal alike, pushes
          that deadline back out of reach. A refusal counts, because a refusal is just as much evidence that the
          provider is still signing.
        </p>
        <p className="facts" style={{ marginTop: 14 }}>
          last decision {utc(gate.lastAttestationAt)}
          <br />
          hatch opens {utc(gate.recoveryAvailableAt)}
        </p>
      </div>

      <div className="pin">
        <div className="on-seam" style={{ padding: '12px 0' }}>
          {parts.elapsed ? (
            <div className="cond" style={{ fontSize: 11, letterSpacing: '0.16em', color: 'var(--over)' }}>
              HATCH
              <br />
              OPEN
            </div>
          ) : (
            <div className="countdown">
              <div>
                <b>{parts.days}</b>
                <span>d</span>
              </div>
              <div>
                <b>{String(parts.hours).padStart(2, '0')}</b>
                <span>h</span>
              </div>
              <div>
                <b>{String(parts.minutes).padStart(2, '0')}</b>
                <span>m</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="side-pad r-pad">
        <h3 className="h5">{parts.elapsed ? 'Available now' : `Locked for another ${untilPhrase(gate.recoveryAvailableAt, now)}`}</h3>
        <p className="note">
          Callable only by the owner, <Addr address={gate.owner} />. This is a bounded last resort for a treasury that
          would otherwise be bricked, not an admin override — and it is deliberately not the agent&rsquo;s to take.
        </p>
        <button className="big-btn cond" style={{ marginTop: 14 }} onClick={() => void onRecover()} disabled={!parts.elapsed || action.kind === 'busy'}>
          {action.kind === 'busy' ? 'Waiting…' : 'Sweep to the owner'}
        </button>
        {action.message ? (
          <p className={action.kind === 'failed' ? 'pnote' : 'note'} style={{ marginTop: 12 }}>
            {action.message}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function Addr({ address }: { address: string }) {
  const url = addressUrl(address)
  if (!url) return <span className="mono">{address}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mono">
      {address}
    </a>
  )
}

function TxLink({ hash, children }: { hash: string; children: React.ReactNode }) {
  const url = txUrl(hash)
  if (!url) return <>{children}</>
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}
