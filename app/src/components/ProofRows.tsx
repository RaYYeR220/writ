'use client'

import type { ProofRow } from '@/lib/verify'

/**
 * The proof channel.
 *
 * Everything here is achromatic and geometric on purpose. The verdict — held or released — owns
 * colour and owns which side of the seam you are on. Proof state owns squares, knocked-out type
 * and a hatch, and it is the only thing on this entire site permitted to look broken.
 *
 * That separation is not decoration. A DENY is the system working correctly; a failed proof is
 * the system telling you something is wrong. If they shared a visual language, a reader skimming
 * would read one as the other, and the two are opposites.
 */

const NODE_LABEL: Record<ProofRow['state'], string> = {
  idle: 'NOT\nRUN',
  running: '···',
  pass: 'CHECKED',
  fail: 'BROKEN',
  unavailable: 'NOT\nRUN',
}

export function ProofRows({ rows }: { rows: ProofRow[] }) {
  return (
    <section className="proofs" aria-label="The four checks">
      {rows.map((row, i) => (
        <Row key={row.key} row={row} index={i} />
      ))}
    </section>
  )
}

function Row({ row, index }: { row: ProofRow; index: number }) {
  return (
    <div className={`trow prow ${row.state}`}>
      <div className="l">
        <h3 className="pname">
          {String(index + 1).padStart(2, '0')} — {row.name}
        </h3>
        <p className="pclaim">{row.claim}</p>
        <p className="pms">{stateWord(row)}</p>
        {row.reason ? <p className="pnote">{row.reason}</p> : null}
      </div>

      <div className="pin">
        <div className="node cond" role="img" aria-label={ariaFor(row)}>
          {NODE_LABEL[row.state].split('\n').map((line) => (
            <span key={line} style={{ display: 'block' }}>
              {line}
            </span>
          ))}
        </div>
      </div>

      <div className="r">
        {row.evidence.length > 0 ? (
          <div className="pevidence">
            {row.evidence.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        ) : (
          <p className="dimmer" style={{ fontSize: 13, fontStyle: 'italic', margin: 0 }}>
            {row.state === 'running' ? 'checking…' : 'no evidence gathered'}
          </p>
        )}
        {row.notes?.map((n) => (
          <p className="pnote" key={n}>
            {n}
          </p>
        ))}
      </div>
    </div>
  )
}

/**
 * The proof channel's own vocabulary, kept clear of every word the verdict channel uses.
 *
 * No "held", no "released", no "allowed", no "refused" — those belong to the seam and to
 * settled outcomes. A check is checked, broken, or not run.
 */
function stateWord(row: ProofRow): string {
  switch (row.state) {
    case 'pass':
      return row.ms ? `checked here · ${row.ms} ms` : 'checked here'
    case 'fail':
      return 'broken · see below'
    case 'unavailable':
      return 'not run · see below'
    case 'running':
      return 'checking…'
    default:
      return 'not run yet'
  }
}

function ariaFor(row: ProofRow): string {
  switch (row.state) {
    case 'pass':
      return `${row.name}: check passed.`
    case 'fail':
      return `${row.name}: check FAILED. This is a broken proof, not a refused transfer.`
    case 'unavailable':
      return `${row.name}: check could not be run.`
    case 'running':
      return `${row.name}: checking.`
    default:
      return `${row.name}: not run yet.`
  }
}

/** The one sentence that keeps a failed proof from ever being read as a refused transfer. */
export function ProofKey() {
  return (
    <p className="proof-key">
      These four rows are the only thing on this site allowed to look broken. A refused transfer is
      drawn in colour on the seam, because it is a settled outcome. A failed check is drawn here in
      plain ink and knocked-out type, because it means something is wrong.
    </p>
  )
}
