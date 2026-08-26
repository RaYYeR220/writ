import type { RoutingFields } from '@writ/sdk'

/**
 * What `writ_attest` produced, kept so `writ_execute` can settle it by id alone.
 *
 * The response bytes and the signature are the parts of a writ that are NOT on chain — the
 * chain holds only their hashes — so without this the agent would have to carry them itself.
 * Nothing here is trusted: `writ_execute` re-derives the gate's own question from `to` and
 * `amount` and compares it byte for byte with the request hash before it will spend gas.
 */
export type StoredWrit = {
  writId: string
  gate: string
  to: string
  amountWei: bigint
  provider: string
  reqHash: string
  respHash: string
  /** The exact question the TEE signed, kept so a stale-state failure can name what moved. */
  rawRequest: Uint8Array
  rawResponse: Uint8Array
  signature: string
  transcriptRoot: string
  kind: 'chat' | 'routing'
  routing?: RoutingFields
  attestedAt: string
}

/**
 * In-process memory of this session's attestations.
 *
 * Deliberately not durable. An MCP server restart loses it, and `writ_execute` then falls back
 * to rebuilding the same material from 0G Storage and 0G's on-chain registry — which is the
 * path a stranger would have to take anyway, so it is worth having exercised.
 */
export class WritStore {
  private readonly byId = new Map<string, StoredWrit>()

  put(w: StoredWrit): void {
    this.byId.set(w.writId.toLowerCase(), w)
  }

  get(writId: string): StoredWrit | undefined {
    return this.byId.get(writId.toLowerCase())
  }

  get size(): number {
    return this.byId.size
  }
}
