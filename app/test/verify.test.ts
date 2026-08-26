import { describe, expect, it } from 'vitest'
import { chainSummary, runProofChain, tamperCase, writId, routingWritId } from '@/lib/verify'
import type { ProofRow } from '@/lib/verify'
import { buildFixture, sourcesFor, STRANGER_KEY } from './helpers/fixture'

function row(rows: ProofRow[], key: ProofRow['key']): ProofRow {
  const found = rows.find((r) => r.key === key)
  if (!found) throw new Error(`no ${key} row`)
  return found
}

describe('the four checks', () => {
  it('passes all four for a proof that is actually sound', async () => {
    const fixture = await buildFixture()
    const { rows } = await runProofChain(fixture.writ.id, sourcesFor(fixture))

    expect(rows.map((r) => r.state)).toEqual(['pass', 'pass', 'pass', 'pass'])
    expect(chainSummary(rows).state).toBe('pass')
  })

  it('reports the checks in order as they land', async () => {
    const fixture = await buildFixture()
    const seen: string[] = []
    await runProofChain(fixture.writ.id, sourcesFor(fixture), (rows) => {
      seen.push(rows.map((r) => r.state[0]).join(''))
    })
    // Every row starts idle and only ever moves forward — a check never un-passes.
    expect(seen[0]).toBe('riii')
    expect(seen.at(-1)).toBe('pppp')
  })

  it('fails the transcript row when the archived question has been edited', async () => {
    const fixture = await buildFixture()
    const edited = {
      ...fixture.transcript,
      request: fixture.transcript.request.replace(
        'has no prior relationship with this treasury',
        'is a long-standing vendor',
      ),
    }
    expect(edited.request).not.toBe(fixture.transcript.request)

    const { rows } = await runProofChain(fixture.writ.id, sourcesFor(fixture, { transcript: edited }))

    expect(row(rows, 'transcript').state).toBe('fail')
    expect(row(rows, 'transcript').reason).toMatch(/question/)
    // The record and the provider are untouched by a doctored transcript.
    expect(row(rows, 'record').state).toBe('pass')
    expect(row(rows, 'provider').state).toBe('pass')
  })

  it('fails the transcript row when the archived answer has been edited', async () => {
    const fixture = await buildFixture()
    const edited = { ...fixture.transcript, response: fixture.transcript.response.replace('DENY:87', 'ALLOW:07') }

    const { rows } = await runProofChain(fixture.writ.id, sourcesFor(fixture, { transcript: edited }))
    expect(row(rows, 'transcript').state).toBe('fail')
    expect(row(rows, 'transcript').reason).toMatch(/answer/)
  })

  it('fails the signature row when the signer is a key the registry never published', async () => {
    // The bytes are honest and hash correctly; only the key is a stranger's.
    const fixture = await buildFixture({ signWith: STRANGER_KEY })
    const { rows, recovered } = await runProofChain(fixture.writ.id, sourcesFor(fixture))

    expect(row(rows, 'transcript').state).toBe('pass')
    expect(row(rows, 'signature').state).toBe('fail')
    expect(row(rows, 'signature').reason).toMatch(/not the key/)
    expect(recovered?.toLowerCase()).not.toBe(fixture.teeSigner.toLowerCase())
  })

  it('fails the signature row on a signature that is not a signature at all', async () => {
    const fixture = await buildFixture()
    const broken = { ...fixture.transcript, signature: '0xdeadbeef' }

    const { rows } = await runProofChain(fixture.writ.id, sourcesFor(fixture, { transcript: broken }))
    expect(row(rows, 'signature').state).toBe('fail')
    expect(row(rows, 'signature').reason).toMatch(/well-formed/)
  })

  it('fails the record row when the identifier does not describe its own contents', async () => {
    const fixture = await buildFixture()
    const wrongId = '0x' + 'ab'.repeat(32)

    const { rows } = await runProofChain(wrongId, sourcesFor(fixture))
    expect(row(rows, 'record').state).toBe('fail')
    expect(row(rows, 'record').reason).toMatch(/does not describe/)
  })

  it('fails the provider row when 0G no longer calls the service TeeML', async () => {
    const fixture = await buildFixture()
    const { rows } = await runProofChain(
      fixture.writ.id,
      sourcesFor(fixture, { service: { verifiability: 'standard' } }),
    )

    expect(row(rows, 'provider').state).toBe('fail')
    expect(row(rows, 'provider').reason).toMatch(/not "TeeML"/)
  })

  it('fails the provider row when the TEE signer is not acknowledged', async () => {
    const fixture = await buildFixture()
    const { rows } = await runProofChain(
      fixture.writ.id,
      sourcesFor(fixture, { service: { teeSignerAcknowledged: false } }),
    )
    expect(row(rows, 'provider').state).toBe('fail')
  })
})

describe('unavailable is never mistaken for failed', () => {
  it('marks the transcript unavailable — not failed — when 0G Storage does not answer', async () => {
    const fixture = await buildFixture()
    const { rows } = await runProofChain(fixture.writ.id, sourcesFor(fixture, { transcript: 'unavailable' }))

    expect(row(rows, 'transcript').state).toBe('unavailable')
    expect(row(rows, 'transcript').reason).toMatch(/File not found/)
    // And the signature it depends on is unavailable too, rather than quietly passing or failing.
    expect(row(rows, 'signature').state).toBe('unavailable')
    expect(row(rows, 'signature').reason).toMatch(/transcript could not be checked/)
    expect(chainSummary(rows).state).toBe('unavailable')
    expect(chainSummary(rows).sentence).toMatch(/An unrun check is not a passed one/)
  })

  it('marks the signature unavailable when the registry cannot supply a key to compare against', async () => {
    const fixture = await buildFixture()
    const { rows } = await runProofChain(fixture.writ.id, sourcesFor(fixture, { service: 'unreachable' }))

    expect(row(rows, 'provider').state).toBe('unavailable')
    expect(row(rows, 'signature').state).toBe('unavailable')
    // Specifically: it does NOT fall back to the signer the transcript names for itself.
    expect(row(rows, 'signature').reason).toMatch(/self-declared/)
  })

  it('marks the transcript unavailable when the writ was notarized without archiving anything', async () => {
    const fixture = await buildFixture()
    const { rows } = await runProofChain(
      fixture.writ.id,
      sourcesFor(fixture, { writ: { transcriptRoot: '0x' + '00'.repeat(32) } }),
    )
    expect(row(rows, 'transcript').state).toBe('unavailable')
    expect(row(rows, 'transcript').reason).toMatch(/empty transcript root/)
  })

  it('a failing check outranks a missing one in the summary', async () => {
    const rows: ProofRow[] = [
      { key: 'record', name: '', claim: '', state: 'pass', evidence: [] },
      { key: 'provider', name: '', claim: '', state: 'unavailable', evidence: [] },
      { key: 'transcript', name: '', claim: '', state: 'fail', evidence: [] },
      { key: 'signature', name: '', claim: '', state: 'unavailable', evidence: [] },
    ]
    expect(chainSummary(rows).state).toBe('fail')
    expect(chainSummary(rows).sentence).toMatch(/different thing from a refused transfer/)
  })
})

describe('the transcript never gets to vouch for itself', () => {
  it('rebuilds the signed text from the chain, not from the transcript field', async () => {
    const fixture = await buildFixture()
    // A doctored transcript that claims the TEE signed something other than what the chain says.
    const lying = { ...fixture.transcript, signedText: '00'.repeat(32) + ':' + '11'.repeat(32) }

    const { rows } = await runProofChain(fixture.writ.id, sourcesFor(fixture, { transcript: lying }))
    expect(row(rows, 'signature').state).toBe('fail')
    expect(row(rows, 'signature').reason).toMatch(/the chain's own hashes rebuild to/)
  })

  it('notes, but does not trust, the signer the transcript names for itself', async () => {
    const fixture = await buildFixture()
    const boasting = { ...fixture.transcript, signingAddress: '0x000000000000000000000000000000000000dEaD' }

    const { rows } = await runProofChain(fixture.writ.id, sourcesFor(fixture, { transcript: boasting }))
    expect(row(rows, 'signature').state).toBe('pass')
    expect(row(rows, 'signature').notes?.[0]).toMatch(/That claim is ignored/)
  })
})

describe('the tamper case is computed, not illustrated', () => {
  it('produces a different digest and a signer nobody published', async () => {
    const fixture = await buildFixture()
    const softened = fixture.transcript.request.replace(
      'has no prior relationship with this treasury',
      'is a long-standing vendor',
    )

    const result = await tamperCase(fixture.writ, fixture.transcript, softened)

    expect(result.changed).toBe(true)
    expect(result.tamperedReqHash).not.toBe(result.originalReqHash)
    expect(result.tamperedSignedText).not.toBe(result.originalSignedText)
    expect(result.recovered?.toLowerCase()).not.toBe(fixture.teeSigner.toLowerCase())
  })

  it('reports no change when nothing was actually edited', async () => {
    const fixture = await buildFixture()
    const result = await tamperCase(fixture.writ, fixture.transcript, fixture.transcript.request)

    expect(result.changed).toBe(false)
    expect(result.tamperedReqHash).toBe(result.originalReqHash.toLowerCase())
    expect(result.recovered?.toLowerCase()).toBe(fixture.teeSigner.toLowerCase())
  })
})

describe('writ identifiers', () => {
  it('matches WritRegistry.writId — keccak256(abi.encode(provider, reqHash, respHash))', () => {
    // Recomputed against the contract's own definition; a drift here would file records under
    // keys that do not describe them.
    const id = writId(
      '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9',
      '0x' + '11'.repeat(32),
      '0x' + '22'.repeat(32),
    )
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(
      writId('0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9', '0x' + '11'.repeat(32), '0x' + '23'.repeat(32)),
    ).not.toBe(id)
  })

  it('domain-separates a routing writ from a chat writ over the same triple', () => {
    const provider = '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9'
    const req = '0x' + '11'.repeat(32)
    const resp = '0x' + '22'.repeat(32)
    const routing = {
      providerType: 'centralized',
      providerIdentity: 'upstream-a',
      tlsFingerprint: '0x' + '33'.repeat(32),
    }

    expect(routingWritId(provider, req, resp, routing)).not.toBe(writId(provider, req, resp))
    // And the attribution is part of the identifier, because it is part of what was signed.
    expect(routingWritId(provider, req, resp, { ...routing, providerIdentity: 'upstream-b' })).not.toBe(
      routingWritId(provider, req, resp, routing),
    )
  })
})
