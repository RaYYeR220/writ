'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Amount, CeilingBar, Gap, Measure } from '@/components/primitives'
import { refusedByPhrase } from '@/lib/abi'
import { chainReachable, loadDocket, type Docket as DocketData, type DocketEntry } from '@/lib/docket'
import { addressUrl, config, missingRegistryReason, txUrl } from '@/lib/config'
import { ago, formatCount, formatOG, utc } from '@/lib/format'
import { shortAddress, shortHash } from '@/lib/hashes'

type State =
  | { phase: 'loading' }
  | { phase: 'unconfigured'; reason: string }
  | { phase: 'unreachable'; reason: string }
  | { phase: 'ready'; data: DocketData }
  | { phase: 'error'; reason: string }

export function Docket() {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()

    const reason = missingRegistryReason()
    if (reason) {
      setState({ phase: 'unconfigured', reason })
      return
    }

    void (async () => {
      const reach = await chainReachable()
      if (!reach.ok) {
        setState({ phase: 'unreachable', reason: reach.reason })
        return
      }
      try {
        const data = await loadDocket(controller.signal)
        if (!controller.signal.aborted) setState({ phase: 'ready', data })
      } catch (e) {
        if (!controller.signal.aborted) {
          setState({ phase: 'error', reason: e instanceof Error ? e.message : String(e) })
        }
      }
    })()

    return () => controller.abort()
  }, [])

  return (
    <div className="wrap">
      <div className="tribunal">
        <Banner />
        <Balance state={state} />

        {state.phase === 'loading' ? (
          <div className="trow">
            <div className="pad dim" style={{ gridColumn: '1 / -1', textAlign: 'center' }}>
              Reading the chain from your browser…
            </div>
          </div>
        ) : null}

        {state.phase === 'unconfigured' ? (
          <div className="pad" style={{ maxWidth: '62ch', margin: '0 auto' }}>
            <Gap title="Nothing to read yet">
              <p>{state.reason}</p>
              <p>
                Copy <code>.env.example</code> to <code>.env.local</code> and set{' '}
                <code>NEXT_PUBLIC_WRIT_REGISTRY</code> and <code>NEXT_PUBLIC_POLICY_GATE_FACTORY</code> to the deployed
                addresses — or point <code>NEXT_PUBLIC_RPC_URL</code> at a local anvil fork of 0G and use the addresses
                it prints. Every view below is a read of the chain, so until there is a chain to read, this page shows
                you nothing rather than something.
              </p>
            </Gap>
          </div>
        ) : null}

        {state.phase === 'unreachable' ? (
          <div className="pad" style={{ maxWidth: '62ch', margin: '0 auto' }}>
            <Gap title="The chain did not answer">
              <p>{state.reason}</p>
              <p>
                Nothing below this line is a claim about what happened on 0G, because nothing below this line was read
                from it.
              </p>
            </Gap>
          </div>
        ) : null}

        {state.phase === 'error' ? (
          <div className="pad" style={{ maxWidth: '62ch', margin: '0 auto' }}>
            <Gap title="The docket could not be built">
              <p>{state.reason}</p>
            </Gap>
          </div>
        ) : null}

        {state.phase === 'ready' ? <Feed data={state.data} /> : null}
      </div>
    </div>
  )
}

function Banner() {
  return (
    <div className="trow banner">
      <div className="side l">
        <h2>
          Held
          <span className="sub">stopped at the gate · sealed on chain</span>
        </h2>
      </div>
      <div className="pin">
        <span className="seam-label">seam · ceiling</span>
      </div>
      <div className="side r">
        <h2>
          Released
          <span className="sub">attested · funds moved</span>
        </h2>
      </div>
    </div>
  )
}

/**
 * The counters sit on the seam as one balance, not as a success metric beside a failure metric.
 * Held and released are the two columns of the same book, so they are footed together.
 */
function Balance({ state }: { state: State }) {
  const totals = state.phase === 'ready' ? state.data.totals : null
  const held = formatOG(totals?.heldAmount ?? null)
  const released = formatOG(totals?.releasedAmount ?? null)

  return (
    <div className="trow balance">
      <div className="l">
        <span>
          {totals ? (
            <>
              <b className="tnum">{held.text}</b> 0G stayed where it was
            </>
          ) : (
            <span className="dimmer">—</span>
          )}
        </span>
      </div>
      <div className="pin">
        <div className="on-seam">
          <div className="n tnum">{totals ? formatCount(totals.held) : '—'}</div>
          <div className="k">held</div>
          <div className="dot">·</div>
          <div className="n tnum">{totals ? formatCount(totals.released) : '—'}</div>
          <div className="k">released</div>
        </div>
      </div>
      <div className="r">
        <span>
          {totals ? (
            <>
              <b className="tnum">{released.text}</b> 0G moved, each against a signed answer
            </>
          ) : (
            <span className="dimmer">—</span>
          )}
        </span>
      </div>
    </div>
  )
}

function Feed({ data }: { data: DocketData }) {
  if (data.entries.length === 0) {
    return (
      <>
        <div className="pad" style={{ maxWidth: '62ch', margin: '0 auto' }}>
          <Gap title="No decisions in the scanned range">
            <p>
              Blocks {formatCount(data.range.fromBlock)} to {formatCount(data.range.toBlock)} on {config.networkName}{' '}
              contain no <code>Notarized</code>, <code>TransferApproved</code> or <code>TransferRefused</code> events for
              the configured contracts. That is an empty range, not an empty chain — set{' '}
              <code>NEXT_PUBLIC_FROM_BLOCK</code> to the registry&rsquo;s deployment block to look further back.
            </p>
          </Gap>
        </div>
        <Problems problems={data.problems} />
      </>
    )
  }

  return (
    <>
      {data.entries.map((entry) => (
        <Row key={entry.key} entry={entry} />
      ))}
      <ScanNote data={data} />
      <Problems problems={data.problems} />
    </>
  )
}

function Row({ entry }: { entry: DocketEntry }) {
  if (entry.side === 'unspent') return <UnspentRow entry={entry} />

  const held = entry.side === 'held'
  const filled = (
    <Link href={`/writ/${entry.writId}`} className={`side ${held ? 'l' : 'r'} filled`}>
      <span className="verdict">
        {held ? 'DENY' : 'ALLOW'}
        {entry.risk !== null ? `:${String(entry.risk).padStart(2, '0')}` : ''}
      </span>
      <span className="amount">
        <Amount wei={entry.amount} struck={held} />
      </span>
      <span className="meta">
        <span className="k">to</span> {entry.to ? shortAddress(entry.to) : '—'} &nbsp;
        <span className="k">ceiling</span> {entry.ceiling ?? '—'} &nbsp;
        <span className="k">model</span> {entry.model ?? 'not in the scanned range'}
        <br />
        {held && entry.refusedBy !== null ? <em>{refusedByPhrase(entry.refusedBy)}</em> : null}
        {held && entry.refusedBy !== null ? ' · ' : null}
        <span className="k">gate</span> {entry.gate ? shortAddress(entry.gate) : '—'}
      </span>
      <CeilingBar risk={entry.risk} ceiling={entry.ceiling} />
      <Measure risk={entry.risk} ceiling={entry.ceiling} />
    </Link>
  )

  const empty = (
    <div className={`side ${held ? 'r' : 'l'} empty`}>
      <div className="void">
        <span>{held ? 'nothing was released' : 'nothing was held'}</span>
      </div>
    </div>
  )

  return (
    <div className={`trow wrow ${held ? 'held' : 'released'}`}>
      {held ? filled : empty}
      <div className="pin">
        <div>
          <Link href={`/writ/${entry.writId}`} className="id cond">
            {shortHash(entry.writId, 6, 4)}
          </Link>
        </div>
        <div className="age">{entry.timestamp !== null ? ago(entry.timestamp) : `#${entry.blockNumber}`}</div>
      </div>
      {held ? empty : filled}
    </div>
  )
}

/**
 * A proof that was verified and recorded but that no gate has spent.
 *
 * It belongs to neither column, so it is drawn on the line rather than pushed to a side. That is
 * a real state — anyone may notarize a valid proof, and notarizing is not the same as acting on
 * one — and inventing a verdict for it would be the exact thing this page exists to prevent.
 */
function UnspentRow({ entry }: { entry: DocketEntry }) {
  return (
    <div className="trow wrow unspent unspent-row">
      <div className="unspent-inner">
        <Link href={`/writ/${entry.writId}`} className="cond unspent-tag">
          Recorded, not spent
        </Link>{' '}
        <span className="meta">
          <span className="k">writ</span> {shortHash(entry.writId, 8, 6)} &nbsp;
          <span className="k">model</span> {entry.model ?? '—'} &nbsp;
          <span className="k">provider</span> {entry.provider ? shortAddress(entry.provider) : '—'} &nbsp;
          <span className="k">{entry.timestamp !== null ? 'when' : 'block'}</span>{' '}
          {entry.timestamp !== null ? `${ago(entry.timestamp)} ago` : formatCount(entry.blockNumber)}
        </span>
      </div>
    </div>
  )
}

function ScanNote({ data }: { data: DocketData }) {
  return (
    <div className="trow">
      <div className="pad note" style={{ gridColumn: '1 / -1', textAlign: 'center', maxWidth: '72ch', margin: '0 auto' }}>
        Read straight from {config.rpcUrl} in this browser, over blocks {formatCount(data.range.fromBlock)}–
        {formatCount(data.range.toBlock)}. The totals above are for that range, not for all time.{' '}
        {data.entries[0]?.timestamp ? `Most recent entry ${utc(data.entries[0].timestamp)}.` : null}
      </div>
    </div>
  )
}

function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null
  return (
    <div className="trow">
      <div style={{ gridColumn: '1 / -1', maxWidth: '66ch', margin: '18px auto 0', padding: '0 18px' }}>
        <Gap title={`${problems.length} source${problems.length === 1 ? '' : 's'} could not be read`}>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p>
            The docket above is therefore incomplete rather than short. Nothing has been substituted for the missing
            entries.
          </p>
        </Gap>
      </div>
    </div>
  )
}

export function ExplorerLink({ hash, children }: { hash: string; children: React.ReactNode }) {
  const url = txUrl(hash)
  if (!url) return <span className="mono">{children}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mono">
      {children}
    </a>
  )
}

export function AddressLink({ address }: { address: string }) {
  const url = addressUrl(address)
  if (!url) return <span className="mono">{address}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mono">
      {address}
    </a>
  )
}
