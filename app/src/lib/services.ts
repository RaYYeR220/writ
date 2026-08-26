import { SERVICE_PAGE_SIZE } from './abi'
import { servingContract } from './chain'
import type { ServiceRecord } from './verify'

/**
 * Every service 0G's inference registry publishes, with the ones a gate can use marked.
 *
 * The unusable ones are kept and shown disabled, on purpose. "Only TEE providers work here" is
 * an assertion; a list where `claude-opus-5` sits there greyed out with *verifiability
 * "standard" — not executed in an enclave* written next to it is a demonstration. The
 * distinction between an attested model and a merely hosted one is the product, so hiding half
 * the evidence would be hiding the argument.
 */

export type ServiceOption = ServiceRecord & {
  /** Whether `WritRegistry.notarize` would accept a proof from this provider today. */
  usable: boolean
  /** Why not, in the registry's own terms. Empty when usable. */
  blockedReason: string
}

export function classify(s: ServiceRecord): ServiceOption {
  if (s.verifiability !== 'TeeML') {
    return {
      ...s,
      usable: false,
      blockedReason: `verifiability is "${s.verifiability || 'unset'}", not "TeeML" — this model is hosted, not executed inside an enclave, so there is no hardware key to sign with`,
    }
  }
  if (!s.teeSignerAcknowledged) {
    return {
      ...s,
      usable: false,
      blockedReason:
        'the provider has not acknowledged its TEE signer on chain, so the registry publishes no key a contract could check a signature against',
    }
  }
  if (/^0x0{40}$/i.test(s.teeSignerAddress)) {
    return {
      ...s,
      usable: false,
      blockedReason: 'the registry publishes the zero address as this provider’s TEE signer, which nothing can recover to',
    }
  }
  return { ...s, usable: true, blockedReason: '' }
}

/**
 * Every registered service, walked a page at a time.
 *
 * `getAllServices` caps its page size, so this pages until it has the `total` the contract
 * reports rather than assuming one call is the whole registry. A truncated list here would
 * quietly hide providers from a policy author, which is a worse failure than a slow page.
 */
export async function loadServices(): Promise<ServiceOption[]> {
  const serving = servingContract()
  const services: ServiceOption[] = []

  let offset = 0n
  let total = 0n
  do {
    const [page, reported] = await serving.getAllServices(offset, BigInt(SERVICE_PAGE_SIZE))
    total = reported
    if (page.length === 0) break

    for (const row of page) {
      services.push(
        classify({
          provider: String(row[0]),
          serviceType: String(row[1]),
          url: String(row[2]),
          updatedAt: Number(row[5]),
          model: String(row[6]),
          verifiability: String(row[7]),
          teeSignerAddress: String(row[9]),
          teeSignerAcknowledged: Boolean(row[10]),
        }),
      )
    }
    offset += BigInt(page.length)
  } while (offset < total)

  // Usable first, then by model name — a chooser should put what you can pick at the top without
  // pretending the rest is not there.
  services.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1
    return a.model.localeCompare(b.model)
  })
  return services
}
