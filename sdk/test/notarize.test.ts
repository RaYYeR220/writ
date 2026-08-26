import { describe, it, expect, vi } from 'vitest'
import { notarize } from '../src/notarize.js'
import type { AttestedRun } from '../src/inference.js'

const run: AttestedRun = {
  chatId: 'chat-1',
  rawRequest: new Uint8Array([1]),
  rawResponse: new Uint8Array([2]),
  reqHash: '0x' + 'aa'.repeat(32),
  respHash: '0x' + 'bb'.repeat(32),
}

const WRIT_ID = '0x' + 'ee'.repeat(32)
const ROOT = '0x' + 'cd'.repeat(32)

function registryStub(over: Partial<Record<string, unknown>> = {}) {
  return {
    writId: vi.fn(async () => WRIT_ID),
    isNotarized: vi.fn(async () => false),
    notarize: vi.fn(async () => ({ wait: async () => ({ hash: '0xtx', status: 1 }) })),
    ...over,
  }
}

describe('notarize', () => {
  it('sends the proof and reports the writ id and tx hash', async () => {
    const registry = registryStub()
    const res = await notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)
    expect(res).toEqual({ writId: WRIT_ID, txHash: '0xtx', alreadyNotarized: false })
    expect(registry.notarize).toHaveBeenCalledWith('0xBEEF', run.reqHash, run.respHash, '0xsig', ROOT)
  })

  it('treats an existing record as success without sending a second transaction', async () => {
    const registry = registryStub({ isNotarized: vi.fn(async () => true) })
    const res = await notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)
    expect(res).toEqual({ writId: WRIT_ID, txHash: '', alreadyNotarized: true })
    expect(registry.notarize).not.toHaveBeenCalled()
  })

  it('propagates a rejected notarization rather than reporting a writ that does not exist', async () => {
    const registry = registryStub({
      notarize: vi.fn(async () => {
        throw new Error('execution reverted: BadSignature')
      }),
    })
    await expect(notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)).rejects.toThrow(/BadSignature/)
  })

  it('refuses to report success when the receipt never arrives', async () => {
    const registry = registryStub({
      notarize: vi.fn(async () => ({ wait: async () => null })),
    })
    await expect(notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)).rejects.toThrow(/receipt/i)
  })

  it('refuses to report success when the transaction reverted', async () => {
    const registry = registryStub({
      notarize: vi.fn(async () => ({ wait: async () => ({ hash: '0xtx', status: 0 }) })),
    })
    await expect(notarize(registry as never, run, '0xBEEF', '0xsig', ROOT)).rejects.toThrow(/reverted/i)
  })

  it('rejects a transcript root that is not a bytes32', async () => {
    const registry = registryStub()
    await expect(notarize(registry as never, run, '0xBEEF', '0xsig', '0xnope')).rejects.toThrow(
      /32-byte hex/i,
    )
    expect(registry.notarize).not.toHaveBeenCalled()
  })
})
