import { afterEach, describe, expect, it, vi } from 'vitest'
import { installStdioGuard } from '../src/stdio-guard.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * stdout is the JSON-RPC channel on a stdio MCP server, and both 0G SDKs write progress lines
 * to `console.log`. One stray line desynchronises the framing and the client drops the
 * connection, so this is load-bearing rather than cosmetic.
 */
describe('stdio guard', () => {
  it('is already installed by importing the module', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    console.log('Starting upload for file of size: 35 bytes')

    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Starting upload for file of size: 35 bytes'))
  })

  it('redirects log, info and debug', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    console.log('log line')
    console.info('info line')
    console.debug('debug line')

    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledTimes(3)
  })

  it('serialises the objects the 0G SDKs log', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    console.log('Selected nodes:', [{ url: 'https://node.test' }])

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[{"url":"https://node.test"}]'))
  })

  it('survives a value that cannot be serialised', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic

    expect(() => console.log('cyclic', cyclic)).not.toThrow()
    expect(stderr).toHaveBeenCalled()
  })

  it('is idempotent, so calling it again does not double-wrap', () => {
    const before = console.log
    installStdioGuard()
    installStdioGuard()

    expect(console.log).toBe(before)
  })

  it('leaves warn and error alone, because Node already sends them to stderr', () => {
    // Not rebound, so the compute broker's "Unknown chain ID" warning still reaches a human.
    expect(console.warn).not.toBe(console.log)
    expect(console.error).not.toBe(console.log)
    expect(console.info).toBe(console.log)
    expect(console.debug).toBe(console.log)
  })
})
