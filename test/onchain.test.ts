import { createPublicClient, custom, encodeEventTopics, toHex } from "viem"
import { baseSepolia } from "viem/chains"
import { describe, expect, it } from "vitest"
import { BASE_SEPOLIA_USDC } from "../src/config.js"
import { verifySettlement } from "../src/onchain.js"

const TX =
  "0x0000000000000000000000000000000000000000000000000000000000000abc" as const
const BUYER = "0x1111111111111111111111111111111111111111"
const CATENA = "0x2222222222222222222222222222222222222222"

function transferLog(to: string, value: bigint, from?: string) {
  const topics = encodeEventTopics({
    abi: [
      {
        type: "event",
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      },
    ],
    eventName: "Transfer",
    args: { from: (from ?? BUYER) as `0x${string}`, to: to as `0x${string}` },
  })
  return {
    address: BASE_SEPOLIA_USDC,
    topics,
    data: toHex(value, { size: 32 }),
    blockNumber: "0x2a5f2b8",
  }
}

/** A client whose only RPC method is eth_getTransactionReceipt, returning `receipt`. */
function clientReturning(receipt: unknown) {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: ({ method }) => {
        if (method === "eth_getTransactionReceipt") {
          return Promise.resolve(receipt)
        }
        return Promise.reject(new Error(`unexpected RPC ${method}`))
      },
    }),
  })
}

const opts = {
  txHash: TX,
  rpcUrl: "http://unused",
  token: BASE_SEPOLIA_USDC,
  expectedTo: CATENA,
  expectedFrom: BUYER,
  expectedAmount: 1000n,
}

describe("verifySettlement", () => {
  it("confirms a matching USDC transfer to the Catena address", async () => {
    const client = clientReturning({
      status: "0x1",
      blockNumber: "0x2a5f2b8",
      logs: [transferLog(CATENA, 1000n)],
    })
    const result = await verifySettlement({ ...opts, client })
    expect(result.status).toBe("confirmed")
    if (result.status === "confirmed") {
      expect(result.settlement.to.toLowerCase()).toBe(CATENA)
      expect(result.settlement.amount).toBe(1000n)
    }
  })

  it("confirms the right transfer when the receipt carries several to the address", async () => {
    const client = clientReturning({
      status: "0x1",
      blockNumber: "0x2a5f2b8",
      logs: [transferLog(CATENA, 999n), transferLog(CATENA, 1000n)],
    })
    const result = await verifySettlement({ ...opts, client })
    expect(result.status).toBe("confirmed")
    if (result.status === "confirmed") {
      expect(result.settlement.amount).toBe(1000n)
    }
  })

  it("throws when the amount does not match", async () => {
    const client = clientReturning({
      status: "0x1",
      blockNumber: "0x2a5f2b8",
      logs: [transferLog(CATENA, 999n)],
    })
    await expect(verifySettlement({ ...opts, client })).rejects.toThrow(
      /amount mismatch/i,
    )
  })

  it("throws when there is no transfer to the expected address", async () => {
    const client = clientReturning({
      status: "0x1",
      blockNumber: "0x2a5f2b8",
      logs: [transferLog("0x000000000000000000000000000000000000dEaD", 1000n)],
    })
    await expect(verifySettlement({ ...opts, client })).rejects.toThrow(
      /no USDC transfer/i,
    )
  })

  it("throws when the settlement transaction reverted", async () => {
    const client = clientReturning({
      status: "0x0",
      blockNumber: "0x2a5f2b8",
      logs: [],
    })
    await expect(verifySettlement({ ...opts, client })).rejects.toThrow(
      /reverted/i,
    )
  })

  it("reports unavailable when the receipt cannot be read", async () => {
    const client = createPublicClient({
      chain: baseSepolia,
      // retryCount 0: without it viem retries each call ~3x with backoff, so
      // the intended fast fail would take seconds.
      transport: custom(
        { request: () => Promise.reject(new Error("rpc down")) },
        { retryCount: 0 },
      ),
    })
    const result = await verifySettlement({
      ...opts,
      client,
      attempts: 2,
      delayMs: 1,
    })
    expect(result.status).toBe("unavailable")
  })
})

describe("settlement attribution", () => {
  it("rejects a receipt whose transfer came from a different sender", async () => {
    // A facilitator returning a stale hash from an earlier run (same price,
    // same payTo) would otherwise confirm as this run's settlement.
    const client = clientReturning({
      status: "0x1",
      blockNumber: "0x2a5f2b8",
      logs: [
        transferLog(
          CATENA,
          1000n,
          "0x000000000000000000000000000000000000dead",
        ),
      ],
    })
    await expect(verifySettlement({ ...opts, client })).rejects.toThrow(
      /No USDC transfer from/,
    )
  })

  it("ignores a transfer of another token to the same address", async () => {
    const client = clientReturning({
      status: "0x1",
      blockNumber: "0x2a5f2b8",
      logs: [
        {
          ...transferLog(CATENA, 1000n),
          address: "0x0000000000000000000000000000000000000bad",
        },
      ],
    })
    await expect(verifySettlement({ ...opts, client })).rejects.toThrow(
      /No USDC transfer from/,
    )
  })
})
