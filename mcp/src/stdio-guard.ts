/**
 * Keeps stdout clean for the MCP transport.
 *
 * On a stdio server, stdout IS the JSON-RPC channel. Both 0G SDKs chat to `console.log` while
 * they work — 15 calls in the storage indexer, 21 in its uploader, and one on every compute
 * broker construction — and a single stray line desynchronises the framing and drops the
 * connection. Rebinding the three stdout-bound console methods onto stderr costs nothing and
 * removes the whole class of failure.
 *
 * `console.warn` and `console.error` already go to stderr in Node, so they are left alone.
 *
 * This module is a side effect on purpose: importing it first in the entrypoint guarantees it
 * runs before any other module in the graph is evaluated, and therefore before any 0G SDK
 * object can exist.
 */

const REDIRECTED = ['log', 'info', 'debug'] as const

let installed = false

function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Points `console.log` / `console.info` / `console.debug` at stderr. Idempotent, so importing
 * this module and calling the function explicitly cannot double-wrap.
 */
export function installStdioGuard(): void {
  if (installed) return
  installed = true

  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`[writ-mcp] ${args.map(render).join(' ')}\n`)
  }

  for (const method of REDIRECTED) {
    console[method] = toStderr
  }
}

installStdioGuard()
