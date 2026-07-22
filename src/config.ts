import { z } from "zod"

/**
 * `.env.example` ships every key with an empty value, so a copied `.env`
 * sets them to "". Treat empty as absent, or the optional fields below would
 * fail their regex and break the keyless demos at startup.
 */
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v)

const envSchema = z.object({
  SELLER_PORT: z.coerce.number().int().positive().max(65535).default(4021),
  BUYER_DID_PORT: z.coerce.number().int().positive().max(65535).default(4022),
  /** Address that receives the USDC payment (seller's wallet). */
  SELLER_PAY_TO_ADDRESS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
  ),
  /** Buyer's EVM private key. Only needed for the real-payment path. */
  BUYER_EVM_PRIVATE_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      // Safe: the regex above guarantees the 0x-prefixed shape.
      .transform((v) => v as `0x${string}`)
      .optional(),
  ),
  /**
   * x402 facilitator endpoint. This is the settlement adapter's public
   * surface: point it at the Catena sandbox facilitator once credentials
   * and an endpoint are available; defaults to the public testnet facilitator.
   */
  X402_FACILITATOR_URL: z.url().default("https://x402.org/facilitator"),
  /**
   * CAIP-2 network id. Fixed to Base Sepolia: the USDC address, RPC and
   * explorer are all Base Sepolia, so this is not a real knob.
   */
  X402_NETWORK: z.literal("eip155:84532").default("eip155:84532"),
  /**
   * Price of the protected endpoint, as a money string. At most 6 decimals,
   * so any accepted value parses to micro-dollars and bad config fails at
   * startup instead of on the money path. Must be greater than zero: a paid
   * endpoint that charges nothing would settle a 0-value payment.
   */
  ENDPOINT_PRICE_USD: z
    .string()
    .regex(/^\$\d+(\.\d{1,6})?$/)
    .refine((v) => moneyToMicros(v) > 0n, "price must be greater than 0")
    .default("$0.001"),
  /** Per-request cap enforced by the authorization stub. Same shape rule. */
  AUTHORIZATION_MAX_USD: z
    .string()
    .regex(/^\$\d+(\.\d{1,6})?$/)
    .default("$0.05"),
  /**
   * Public Base Sepolia RPC used to confirm the settlement on-chain (that the
   * USDC actually reached the Catena account). Read-only, no key required.
   */
  BASE_SEPOLIA_RPC_URL: z.url().default("https://sepolia.base.org"),
})

/** USDC on Base Sepolia (Circle's canonical testnet deployment, 6 decimals). */
export const BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const

/** Parse and validate env config; derives the local seller and buyer URLs. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env)
  return {
    ...parsed,
    sellerBaseUrl: `http://localhost:${parsed.SELLER_PORT}`,
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
  const rawFraction = match[2] ?? ""
  if (rawFraction.length > 6) {
    throw new Error(`Too many decimal places for micro-dollars: ${money}`)
  }
  const fraction = rawFraction.padEnd(6, "0")
  return BigInt(whole) * 1_000_000n + BigInt(fraction)
}
