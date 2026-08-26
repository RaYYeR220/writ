import { afterEach, describe, expect, it } from 'vitest'
import { connect, type Harness } from './helpers/client.js'
import { makeWorld } from './helpers/world.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('server surface', () => {
  it('registers exactly the four Writ tools', async () => {
    harness = await connect(makeWorld().deps)
    const { tools } = await harness.client.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual([
      'writ_attest',
      'writ_execute',
      'writ_lookup',
      'writ_preview_question',
    ])
  })

  it('publishes an input and an output schema for every tool', async () => {
    harness = await connect(makeWorld().deps)
    const { tools } = await harness.client.listTools()

    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} inputSchema`).toMatchObject({ type: 'object' })
      expect(tool.outputSchema, `${tool.name} outputSchema`).toMatchObject({ type: 'object' })
      expect(tool.description, `${tool.name} description`).toBeTruthy()
      expect(tool.title, `${tool.name} title`).toBeTruthy()
    }
  })

  it('requires gate, to and amount on writ_attest', async () => {
    harness = await connect(makeWorld().deps)
    const { tools } = await harness.client.listTools()
    const attest = tools.find((t) => t.name === 'writ_attest')

    expect(attest?.inputSchema['required']).toEqual(expect.arrayContaining(['gate', 'to', 'amount']))
  })

  it('marks the read-only tools read-only and the settling tool destructive', async () => {
    harness = await connect(makeWorld().deps)
    const { tools } = await harness.client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

    expect(byName['writ_preview_question']?.annotations?.readOnlyHint).toBe(true)
    expect(byName['writ_lookup']?.annotations?.readOnlyHint).toBe(true)
    expect(byName['writ_attest']?.annotations?.readOnlyHint).toBe(false)
    expect(byName['writ_execute']?.annotations?.destructiveHint).toBe(true)
  })

  it('advertises what the tools will and will not do', async () => {
    harness = await connect(makeWorld().deps)
    const instructions = harness.client.getInstructions()

    expect(instructions).toMatch(/refusal is a successful outcome/i)
    expect(instructions).toMatch(/never synthesise/i)
  })
})
