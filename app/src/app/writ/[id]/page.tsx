import Link from 'next/link'
import { WritDetail } from '@/components/WritDetail'

export const metadata = {
  title: 'Writ — the proof chain',
  description: 'Four independently checkable rows, re-derived in your browser from public sources.',
}

export default async function WritPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const normalised = id.startsWith('0x') ? id.toLowerCase() : `0x${id.toLowerCase()}`

  if (!/^0x[0-9a-f]{64}$/.test(normalised)) {
    return (
      <div className="wrap pad" style={{ maxWidth: '62ch' }}>
        <div className="gap">
          <strong>Not a writ identifier</strong>
          <p>
            <code>{id}</code> is not a 32-byte hex value. A writ id is{' '}
            <code>keccak256(abi.encode(provider, reqHash, respHash))</code>, so it is always 64 hex characters.
          </p>
          <p>
            <Link href="/">Back to the docket</Link>
          </p>
        </div>
      </div>
    )
  }

  return <WritDetail id={normalised} />
}
