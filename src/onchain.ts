import {
  createPublicClient,
  getAddress,
  http,
  parseAbiItem,
  parseEventLogs,
} from "viem"
import { baseSepolia } from "viem/chains"
import type { PublicClient } from "viem"

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
)

export interface ConfirmedSettlement {
  from: string
  to: string
  amount: bigint
  block: bigint
}

export type OnChainResult =
  | { status: "confirmed"; settlement: ConfirmedSettlement }
  | { status: "unavailable"; reason: string }

export interface VerifySettlementOptions {
  txHash: `0x${string}`
  rpcUrl: string
  /** The USDC token contract to look for the Transfer on. */
  token: string
  /** The address that must have received the USDC (the Catena account). */
  expectedTo: string
  /** The exact amount that must have been transferred (atomic USDC units). */
  expectedAmount: bigint
  /** Injected for tests; defaults to an RPC client for `rpcUrl`. */
  client?: Pick<PublicClient, "getTransactionReceipt">
  /** Receipt poll attempts and delay, to ride out propagation lag. */
  attempts?: number
  delayMs?: number
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Confirm the settlement on-chain: the money is only really in the Catena
 * account once a USDC Transfer to its address for the exact amount is mined.
 * This moves the source of truth for "did it settle" from the facilitator's
 * response to the chain itself.
 *
 * Returns `confirmed` on a match, `unavailable` if the receipt cannot be read
 * (RPC lag or outage) since the facilitator already reported success. THROWS
 * only when the chain contradicts a claimed settlement: a reverted tx, a
 * transfer to the wrong address, or the wrong amount.
 */
export async function verifySettlement(
  options: VerifySettlementOptions,
): Promise<OnChainResult> {
  const {
    txHash,
    rpcUrl,
    token,
    expectedTo,
    expectedAmount,
    client = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    }),
    attempts = 8,
    delayMs = 1500,
  } = options

  let receipt
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash })
      break
    } catch {
      if (attempt < attempts - 1) await sleep(delayMs)
    }
  }
  if (!receipt) {
    return {
      status: "unavailable",
      reason: "settlement receipt not found (RPC lag or outage)",
    }
  }

  if (receipt.status !== "success") {
    throw new Error(`Settlement transaction ${txHash} reverted on-chain`)
  }

  const transfers = parseEventLogs({
    abi: [TRANSFER_EVENT],
    logs: receipt.logs,
    eventName: "Transfer",
  })
  const toExpected = transfers.filter(
    (log) =>
      getAddress(log.address) === getAddress(token) &&
      getAddress(log.args.to) === getAddress(expectedTo),
  )
  if (toExpected.length === 0) {
    throw new Error(
      `No USDC transfer to ${expectedTo} found in settlement ${txHash}`,
    )
  }
  // Match on amount too: a receipt can carry several transfers to the same
  // address, and only the one for the expected amount confirms the settlement.
  const match = toExpected.find((log) => log.args.value === expectedAmount)
  if (!match) {
    const amounts = toExpected.map((log) => log.args.value).join(", ")
    throw new Error(
      `Settlement amount mismatch: no transfer of ${expectedAmount} to ${expectedTo} (saw ${amounts})`,
    )
  }

  return {
    status: "confirmed",
    settlement: {
      from: match.args.from,
      to: match.args.to,
      amount: match.args.value,
      block: receipt.blockNumber,
    },
  }
}
