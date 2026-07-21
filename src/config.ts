import { z } from "zod"

const envSchema = z.object({
  SELLER_PORT: z.coerce.number().int().positive().default(4021),
  BUYER_DID_PORT: z.coerce.number().int().positive().default(4022),
  /** Address that receives the USDC payment (seller's wallet). */
  SELLER_PAY_TO_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /** Buyer's EVM private key. Only needed for the real-payment path. */
  BUYER_EVM_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  /**
   * x402 facilitator endpoint. This is the settlement adapter's public
   * surface: point it at the Catena sandbox facilitator once credentials
   * and an endpoint are available; defaults to the public testnet facilitator.
   */
  X402_FACILITATOR_URL: z.url().default("https://x402.org/facilitator"),
  /** CAIP-2 network id. Base Sepolia. */
  X402_NETWORK: z.string().default("eip155:84532"),
  /** Price of the protected endpoint, as a money string. */
  ENDPOINT_PRICE_USD: z.string().regex(/^\$\d+(\.\d+)?$/).default("$0.001"),
  /** Per-request cap enforced by the authorization stub. */
  AUTHORIZATION_MAX_USD: z.string().regex(/^\$\d+(\.\d+)?$/).default("$0.05")
})

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env)
  return {
    ...parsed,
    sellerBaseUrl: `http://localhost:${parsed.SELLER_PORT}`,
    buyerDidBaseUrl: `http://localhost:${parsed.BUYER_DID_PORT}`
  }
}

/**
 * Parse a "$1.23" money string into integer micro-dollars (bigint).
 * Money never touches floats in this codebase.
 */
export function moneyToMicros(money: string): bigint {
  const match = /^\$(\d+)(?:\.(\d+))?$/.exec(money)
  if (!match?.[1]) {
    throw new Error(`Invalid money string: ${money}`)
  }
  const whole = match[1]
  const fraction = (match[2] ?? "").padEnd(6, "0")
  if (fraction.length > 6) {
    throw new Error(`Too many decimal places for micro-dollars: ${money}`)
  }
  return BigInt(whole) * 1_000_000n + BigInt(fraction)
}
