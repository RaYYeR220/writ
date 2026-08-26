import { getAddress } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  QUESTION_FACTS,
  diffFacts,
  explainDrift,
  factNotes,
  parseQuestionFacts,
  percentOfBalance,
  renderQuestionFacts,
  reportFacts,
  type QuestionFacts,
} from '../src/question.js'

/** The worked example from the contract: a fresh treasury holding 10 ether, proposing 1 ether. */
const WORKED =
  'recipient=0x00000000000000000000000000000000000000d1 amount=1000000000000000000 nonce=0 ' +
  'treasuryBalance=10000000000000000000 amountPctOfBalance=10 priorApprovals=0 priorRefusals=0 ' +
  'recipientPriorPayments=0 recipientPriorTotal=0'

const FRESH: QuestionFacts = {
  recipient: '0x00000000000000000000000000000000000000d1',
  amount: '1000000000000000000',
  nonce: '0',
  treasuryBalance: '10000000000000000000',
  amountPctOfBalance: '10',
  priorApprovals: '0',
  priorRefusals: '0',
  recipientPriorPayments: '0',
  recipientPriorTotal: '0',
}

/** As the gate embeds it: between the policy's prompt head and tail, inside a JSON string. */
function inBody(params: string): string {
  return `{"model":"m","messages":[{"role":"user","content":"Approve this transfer? ${params}"}]}`
}

describe('the nine facts', () => {
  it('names them in the order the contract renders them', () => {
    expect([...QUESTION_FACTS]).toEqual([
      'recipient',
      'amount',
      'nonce',
      'treasuryBalance',
      'amountPctOfBalance',
      'priorApprovals',
      'priorRefusals',
      'recipientPriorPayments',
      'recipientPriorTotal',
    ])
  })

  it('renders the worked example byte for byte', () => {
    expect(renderQuestionFacts(FRESH)).toBe(WORKED)
  })

  it('round-trips through a full request body', () => {
    expect(parseQuestionFacts(inBody(WORKED))).toEqual(FRESH)
  })

  it('reads bytes as happily as a string', () => {
    expect(parseQuestionFacts(new TextEncoder().encode(inBody(WORKED)))).toEqual(FRESH)
  })
})

describe('the parse is anchored at both ends', () => {
  it('does not match a question that is missing a fact', () => {
    const short = WORKED.replace(' priorRefusals=0', '')
    expect(parseQuestionFacts(inBody(short))).toBeNull()
  })

  it('does not match the old three-fact question', () => {
    expect(
      parseQuestionFacts(inBody('recipient=0x00000000000000000000000000000000000000d1 amount=1 nonce=0')),
    ).toBeNull()
  })

  it('does not match facts in a different order', () => {
    const swapped = WORKED.replace(
      'nonce=0 treasuryBalance=10000000000000000000',
      'treasuryBalance=10000000000000000000 nonce=0',
    )
    expect(parseQuestionFacts(inBody(swapped))).toBeNull()
  })

  it('does not truncate the final number', () => {
    const facts = parseQuestionFacts(inBody(WORKED.replace('recipientPriorTotal=0', 'recipientPriorTotal=12345')))
    expect(facts?.recipientPriorTotal).toBe('12345')
  })

  it('does not read `recipient=` out of the middle of another key', () => {
    const disguised = WORKED.replace('recipient=', 'notTheRecipient=')
    expect(parseQuestionFacts(inBody(disguised))).toBeNull()
  })

  it('does not accept extra digits glued to a value', () => {
    // A tenth field appended without a space would extend the last number, which the trailing
    // anchor catches rather than silently reading a different total.
    const glued = `${WORKED}9`
    expect(parseQuestionFacts(inBody(glued))?.recipientPriorTotal).toBe('09')
    expect(parseQuestionFacts(inBody(`${WORKED} extra=1`))).toEqual(FRESH)
  })

  it('rejects a negative or non-numeric value', () => {
    expect(parseQuestionFacts(inBody(WORKED.replace('nonce=0', 'nonce=-1')))).toBeNull()
    expect(parseQuestionFacts(inBody(WORKED.replace('priorApprovals=0', 'priorApprovals=many')))).toBeNull()
  })

  it('rejects a recipient that is not 20 bytes', () => {
    expect(parseQuestionFacts(inBody(WORKED.replace(FRESH.recipient, '0xd1')))).toBeNull()
  })
})

describe('percentOfBalance mirrors the contract', () => {
  it('floors the ratio', () => {
    expect(percentOfBalance(10n, 100n)).toBe(10n)
    expect(percentOfBalance(19n, 1000n)).toBe(1n)
    expect(percentOfBalance(9n, 1000n)).toBe(0n)
  })

  it('reports zero for a zero amount, even against an empty treasury', () => {
    expect(percentOfBalance(0n, 0n)).toBe(0n)
    expect(percentOfBalance(0n, 100n)).toBe(0n)
  })

  it('reports the cap for an empty treasury rather than dividing by zero', () => {
    expect(percentOfBalance(1n, 0n)).toBe(999n)
  })

  it('caps at 999, so 25x and 1000x are indistinguishable', () => {
    expect(percentOfBalance(25n, 1n)).toBe(999n)
    expect(percentOfBalance(1000n, 1n)).toBe(999n)
  })

  it('goes over 100 when the treasury cannot cover the amount', () => {
    expect(percentOfBalance(150n, 100n)).toBe(150n)
  })
})

describe('the readings a caller is owed', () => {
  it('converts wei to 0G and answers the obvious questions', () => {
    const r = reportFacts(FRESH)

    expect(r.amountOg).toBe('1.0')
    expect(r.treasuryBalanceOg).toBe('10.0')
    expect(r.amountPctOfBalance).toBe(10)
    expect(r.treasuryCoversAmount).toBe(true)
    expect(r.recipientIsNew).toBe(true)
  })

  it('checksums the address for the caller while the question keeps it lowercase', () => {
    // `Strings.toHexString` renders lowercase, and that lowercase form is what is signed.
    expect(FRESH.recipient).toBe(FRESH.recipient.toLowerCase())
    expect(reportFacts(FRESH).recipient).toBe(getAddress(FRESH.recipient))
  })

  it('says the treasury cannot cover an amount above the balance', () => {
    const r = reportFacts({ ...FRESH, amount: '20000000000000000000', amountPctOfBalance: '200' })
    expect(r.treasuryCoversAmount).toBe(false)
  })

  it('explains a capped percentage', () => {
    expect(factNotes({ ...FRESH, amountPctOfBalance: '999' }).join(' ')).toMatch(/capped at 999/)
  })

  it('explains an empty treasury rather than blaming the cap', () => {
    const notes = factNotes({ ...FRESH, treasuryBalance: '0', amountPctOfBalance: '999' })
    expect(notes.join(' ')).toMatch(/treasury is empty/)
  })

  it('explains a floored zero, so it is not read as a free transfer', () => {
    const notes = factNotes({ ...FRESH, amount: '1', amountPctOfBalance: '0' })
    expect(notes.join(' ')).toMatch(/under 1% of the balance, not zero/)
  })

  it('explains that a refusal never shows up in the recipient history', () => {
    expect(factNotes(FRESH).join(' ')).toMatch(/count approvals only/)
  })

  it('says nothing surprising about an ordinary transfer to a familiar recipient', () => {
    expect(factNotes({ ...FRESH, recipientPriorPayments: '3', recipientPriorTotal: '5' })).toEqual([])
  })
})

describe('naming what moved', () => {
  it('finds nothing when nothing changed', () => {
    expect(diffFacts(FRESH, FRESH)).toEqual([])
  })

  it('blames a stranger when only the balance moved', () => {
    const after = { ...FRESH, treasuryBalance: '11000000000000000000', amountPctOfBalance: '9' }
    const text = explainDrift(diffFacts(FRESH, after))

    expect(text).toMatch(/without this gate settling anything/i)
    expect(text).toMatch(/treasuryBalance 10000000000000000000 -> 11000000000000000000/)
    expect(text).toMatch(/Nothing about the transfer changed/i)
  })

  it('blames the gate when a settlement fact moved', () => {
    const after = { ...FRESH, nonce: '1', priorRefusals: '1' }
    expect(explainDrift(diffFacts(FRESH, after))).toMatch(/settled another decision/i)
  })

  it('reports a settlement even when the balance moved with it', () => {
    const after = { ...FRESH, nonce: '1', priorApprovals: '1', treasuryBalance: '9000000000000000000' }
    expect(explainDrift(diffFacts(FRESH, after))).toMatch(/settled another decision/i)
  })
})
