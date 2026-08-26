/**
 * Brings back what a `--live` run paid out.
 *
 *   pnpm eval:sweep              # report only: what is sitting where, and what is recoverable
 *   pnpm eval:sweep -- --send    # actually return it, with WRIT_SWEEP_CONFIRM=1
 *   pnpm eval:sweep -- --selftest  # prove the sweep works, on a throwaway local chain
 *
 * Recipients are derived rather than random (see `recipients.ts`), so every address a run paid is
 * reproducible from the seed and the answer key. This walks them, and sends whatever it finds to
 * one destination.
 *
 * Two rules, for the same reason the harness has them:
 *   - it reports by default and moves nothing without `--send` AND `WRIT_SWEEP_CONFIRM=1`.
 *   - it never claims a recovery it did not observe. Every line is a balance read before and
 *     after, not an assumption about what a transaction did.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ethers } from 'ethers'
import { allRecipients, FORK_RECIPIENT_SEED, requireLiveSeed } from './recipients.js'
import type { ScenarioFile } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** A plain send costs exactly this; anything above it is what a recipient can actually return. */
const TRANSFER_GAS = 21_000n

/** Headroom over the reported gas price, so a fee bump between quote and mining does not strand a sweep. */
const FEE_HEADROOM_NUM = 3n
const FEE_HEADROOM_DEN = 2n

function out(line = ''): void {
  process.stdout.write(line + '\n')
}

type Found = { scenarioId: string; role: string; address: string; balance: bigint }

/** Reads every derived address, in one pass, and keeps the ones holding anything. */
async function findFunds(
  rpc: ethers.JsonRpcProvider,
  seed: string,
  scenarioIds: readonly string[],
): Promise<{ found: Found[]; scanned: number; total: bigint }> {
  const all = allRecipients(seed, scenarioIds)
  const found: Found[] = []
  let total = 0n
  for (const r of all) {
    const balance = await rpc.getBalance(r.wallet.address)
    if (balance > 0n) {
      found.push({ scenarioId: r.scenarioId, role: r.role, address: r.wallet.address, balance })
      total += balance
    }
  }
  return { found, scanned: all.length, total }
}

/**
 * Empties one derived address into `to`.
 *
 * The recipient pays its own gas out of the balance being swept, so the amount returned is the
 * balance minus the fee — and a balance that cannot cover the fee is reported as stranded rather
 * than attempted. Sending it anyway would just burn the account's contents in a failed
 * transaction.
 */
async function sweepOne(
  rpc: ethers.JsonRpcProvider,
  wallet: ethers.Wallet,
  to: string,
  balance: bigint,
): Promise<{ sent: bigint; txHash: string } | { stranded: bigint; reason: string }> {
  const fee = await rpc.getFeeData()
  const quoted = fee.maxFeePerGas ?? fee.gasPrice
  if (quoted === null || quoted === undefined) {
    return { stranded: balance, reason: 'the RPC reported no gas price' }
  }

  // The headroom is applied to the price we PAY, not merely withheld from the amount returned.
  // Withholding more than is spent was the first version of this function and it left dust at
  // every address — the self-test caught it. A legacy `gasPrice` transaction costs exactly
  // `gasLimit * gasPrice` with no refund, so paying the bumped price and subtracting the bumped
  // cost empties the account exactly while still clearing a base fee that rises after the quote.
  const gasPrice = (quoted * FEE_HEADROOM_NUM) / FEE_HEADROOM_DEN
  const cost = TRANSFER_GAS * gasPrice
  if (balance <= cost) {
    return { stranded: balance, reason: `costs ${ethers.formatEther(cost)} 0G in gas to move` }
  }

  const signer = wallet.connect(rpc)
  const value = balance - cost
  const tx = await signer.sendTransaction({ to, value, gasLimit: TRANSFER_GAS, gasPrice })
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) {
    return { stranded: balance, reason: `sweep transaction ${tx.hash} did not succeed` }
  }
  return { sent: value, txHash: receipt.hash }
}

async function sweep(rpc: ethers.JsonRpcProvider, seed: string, scenarioIds: readonly string[], to: string, send: boolean): Promise<bigint> {
  const { found, scanned, total } = await findFunds(rpc, seed, scenarioIds)

  out(`scanned    ${scanned} derived addresses across ${scenarioIds.length} scenarios`)
  out(`holding    ${found.length} of them, ${ethers.formatEther(total)} 0G in total`)
  out(`destination ${to}`)
  out('')

  if (found.length === 0) {
    out('nothing to sweep.')
    return 0n
  }

  if (!send) {
    for (const f of found) {
      out(`  ${f.address}  ${ethers.formatEther(f.balance).padStart(22)} 0G   ${f.scenarioId} (${f.role})`)
    }
    out('')
    out('REPORT ONLY. Nothing was moved. Re-run with --send and WRIT_SWEEP_CONFIRM=1 to return it.')
    return 0n
  }

  let recovered = 0n
  for (const f of found) {
    const wallet = allRecipients(seed, [f.scenarioId]).find((r) => r.role === f.role)!.wallet
    const result = await sweepOne(rpc, wallet, to, f.balance)
    if ('sent' in result) {
      recovered += result.sent
      out(`  swept    ${ethers.formatEther(result.sent).padStart(22)} 0G from ${f.address}  ${result.txHash}`)
    } else {
      out(`  STRANDED ${ethers.formatEther(result.stranded).padStart(22)} 0G at   ${f.address}  ${result.reason}`)
    }
  }

  // Read it back rather than trusting the sum: the point of this file is that a number is
  // observed, and a sweep that reports success while leaving funds behind is the failure that
  // matters.
  const after = await findFunds(rpc, seed, scenarioIds)
  out('')
  out(`recovered  ${ethers.formatEther(recovered)} 0G`)
  out(`remaining  ${ethers.formatEther(after.total)} 0G across ${after.found.length} address(es)`)
  return recovered
}

/**
 * Proves the sweep works, on a chain that costs nothing.
 *
 * A money-moving script nobody has ever run is a liability, and the only honest alternative to
 * running it on mainnet — which this task may not do — is running it against a local anvil. Funds
 * three derived addresses, sweeps them, and checks the destination actually gained.
 */
async function selftest(): Promise<void> {
  const { startAnvil, ANVIL_KEY } = await import('../sdk/test/helpers/anvil.js')
  const anvil = await startAnvil()
  if (!anvil) throw new Error('anvil would not start; the self-test cannot run')

  try {
    const rpc = new ethers.JsonRpcProvider(anvil.url, undefined, { cacheTimeout: -1 })
    const funder = new ethers.Wallet(ANVIL_KEY, rpc)
    const seed = 'writ-eval-sweep-selftest-seed'
    const ids = ['selftest-a', 'selftest-b']
    const per = ethers.parseEther('0.25')

    const targets = allRecipients(seed, ids)
    out(`funding ${targets.length} derived addresses with ${ethers.formatEther(per)} 0G each`)
    for (const t of targets) {
      await (await funder.sendTransaction({ to: t.wallet.address, value: per })).wait()
    }

    const destination = ethers.Wallet.createRandom().address
    const before = await rpc.getBalance(destination)
    out('')
    const recovered = await sweep(rpc, seed, ids, destination, true)
    const gained = (await rpc.getBalance(destination)) - before

    out('')
    if (gained !== recovered) throw new Error(`destination gained ${gained} wei but the sweep claimed ${recovered}`)
    const leftover = await findFunds(rpc, seed, ids)
    if (leftover.found.length !== 0) throw new Error(`${leftover.found.length} address(es) still hold funds after the sweep`)

    const funded = per * BigInt(targets.length)
    out(`SELF-TEST PASSED: funded ${ethers.formatEther(funded)} 0G, recovered ${ethers.formatEther(gained)} 0G to ${destination},`)
    out(`                  ${ethers.formatEther(funded - gained)} 0G spent on gas, 0 addresses left holding anything.`)
  } finally {
    anvil.stop()
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--selftest')) {
    await selftest()
    return
  }

  const keyArg = argv[argv.indexOf('--scenarios') + 1]
  const keyPath = argv.includes('--scenarios') && keyArg ? resolve(keyArg) : join(HERE, 'scenarios.json')
  const file = JSON.parse(readFileSync(keyPath, 'utf8')) as ScenarioFile
  const scenarioIds = file.scenarios.map((s) => s.id)

  const rpcUrl = process.env['WRIT_RPC_URL'] ?? 'https://evmrpc.0g.ai'
  const rpc = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 })

  // The fork seed is public and its chain is gone; sweeping with it against a real network would
  // be sweeping addresses anyone can already empty, which is not a thing to do quietly.
  const seed = process.env['WRIT_RECIPIENT_SEED'] ? requireLiveSeed() : FORK_RECIPIENT_SEED
  if (seed === FORK_RECIPIENT_SEED) {
    out('! WRIT_RECIPIENT_SEED is not set, so this is using the PUBLIC fork seed. Its keys are in the')
    out('! repository and anyone can spend them. That is fine on a throwaway chain and nowhere else.')
    out('')
  }

  const toArg = argv[argv.indexOf('--to') + 1]
  const to =
    argv.includes('--to') && toArg
      ? ethers.getAddress(toArg)
      : new ethers.Wallet(process.env['WRIT_PRIVATE_KEY'] ?? ethers.ZeroHash.replace(/0$/, '1')).address

  if (!argv.includes('--to') && !process.env['WRIT_PRIVATE_KEY']) {
    throw new Error('give a destination: --to 0x… , or set WRIT_PRIVATE_KEY to sweep back to the deployer')
  }

  const send = argv.includes('--send')
  if (send && process.env['WRIT_SWEEP_CONFIRM'] !== '1') {
    throw new Error('--send moves real funds. Set WRIT_SWEEP_CONFIRM=1 to say that is intended.')
  }

  const net = await rpc.getNetwork()
  out('')
  out('Writ — recipient sweep')
  out('='.repeat(96))
  out(`chain      ${net.chainId} via ${rpcUrl}`)
  out(`answer key ${keyPath} (v${file.version}, ${scenarioIds.length} scenarios)`)
  out(`mode       ${send ? 'SEND' : 'report only'}`)
  out('')

  await sweep(rpc, seed, scenarioIds, to, send)
}

await main()
