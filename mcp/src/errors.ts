import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * A refusal to answer, raised anywhere in a tool.
 *
 * Every one of these becomes `isError: true` on the wire. There is deliberately no severity
 * ladder and no "soft" variant: a tool either has a verified answer or it has none.
 */
export class ToolFailure extends Error {
  override readonly name = 'ToolFailure'
}

export function fail(message: string): never {
  throw new ToolFailure(message)
}

/** ethers hides the useful part of a revert in a few different places depending on the path. */
function revertOf(err: unknown): string | null {
  const e = err as { revert?: { name?: string; args?: unknown[] } | null; shortMessage?: string }
  if (e?.revert?.name) {
    const args = (e.revert.args ?? []).map((a) => String(a)).join(', ')
    return `${e.revert.name}(${args})`
  }
  return null
}

/** Renders any thrown value as one line an agent can act on, including a decoded revert. */
export function describeError(err: unknown): string {
  if (err instanceof ToolFailure) return err.message

  const revert = revertOf(err)
  if (revert) return `reverted with ${revert}`

  if (err instanceof Error) {
    const short = (err as { shortMessage?: string }).shortMessage
    const base = short && short.length > 0 ? short : err.message
    const cause = err.cause
    if (cause && cause !== err) {
      const causeText = cause instanceof Error ? cause.message : String(cause)
      if (causeText && !base.includes(causeText)) return `${base}: ${causeText}`
    }
    return base
  }

  return String(err)
}

/**
 * Runs a tool body and shapes the result.
 *
 * Success carries `structuredContent`; failure carries `isError: true` and no structured
 * content at all. That asymmetry is the whole point — the MCP server validates
 * `structuredContent` against the declared `outputSchema` and exempts error results, so there
 * is no shape in which a failed tool can hand back a populated, schema-valid answer.
 */
export async function runTool<T extends Record<string, unknown>>(
  tool: string,
  body: () => Promise<T>,
): Promise<CallToolResult> {
  try {
    const structuredContent = await body()
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${tool} failed: ${describeError(err)}` }],
      isError: true,
    }
  }
}
