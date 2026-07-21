import { generateKeypair } from "@agentcommercekit/keys"
import { ExactEvmScheme } from "@x402/evm/exact/client"
import {
  decodePaymentResponseHeader,
  wrapFetchWithPayment,
  x402Client,
} from "@x402/fetch"
import { privateKeyToAccount } from "viem/accounts"
import { createIdentity, createIdentityProof } from "../identity.js"
import { PROTECTED_PATH } from "../seller/server.js"
import { startDidHost } from "./did-host.js"
import type { SettleResponse } from "@x402/core/types"

export const SCENARIOS = [
  "valid",
  "missing-identity",
  "mismatched-identity",
  "expired-identity",
] as const

export type Scenario = (typeof SCENARIOS)[number]

export function isScenario(value: string): value is Scenario {
  return (SCENARIOS as readonly string[]).includes(value)
}

/** Placeholder key for rejection scenarios: those flows are rejected before
 * any 402 challenge, so this key never signs a payment. */
const UNUSED_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001"

export interface BuyerOptions {
  sellerUrl: string
  sellerDid: string
  /** Port for the buyer's did:web document host. 0 picks a free port. */
  didPort?: number
  /** Funded Base Sepolia key. Required only for the "valid" scenario. */
  evmPrivateKey?: `0x${string}`
}

export interface BuyerRunResult {
  scenario: Scenario
  buyerDid: string
  status: number
  body: unknown
  /** Present when a payment was settled on-chain. */
  settlement?: SettleResponse
}

/**
 * Scripted buyer: mint a did:web identity, host its DID document, sign the
 * identity proof for the requested scenario, then call the paid endpoint
 * through the x402-wrapped fetch (which transparently pays on a 402).
 */
export async function runBuyer(
  scenario: Scenario,
  options: BuyerOptions,
): Promise<BuyerRunResult> {
  const { sellerUrl, sellerDid, didPort = 0, evmPrivateKey } = options
  if (scenario === "valid" && !evmPrivateKey) {
    throw new Error(
      "evmPrivateKey is required for the valid scenario: it signs the USDC payment (the demo reads it from BUYER_EVM_PRIVATE_KEY)",
    )
  }

  const didHost = await startDidHost(didPort)
  try {
    const identity = await createIdentity(didHost.baseUrl)
    didHost.setDocument(identity.didDocument)

    let proof: string | undefined
    switch (scenario) {
      case "valid":
        proof = await createIdentityProof({
          issuerDid: identity.did,
          keypair: identity.keypair,
          audience: sellerDid,
        })
        break
      case "missing-identity":
        proof = undefined
        break
      case "mismatched-identity": {
        // Signed with a key the claimed DID does not publish: an attacker
        // asserting an identity they do not control.
        const rogueKeypair = await generateKeypair("secp256k1")
        proof = await createIdentityProof({
          issuerDid: identity.did,
          keypair: rogueKeypair,
          audience: sellerDid,
        })
        break
      }
      case "expired-identity":
        proof = await createIdentityProof({
          issuerDid: identity.did,
          keypair: identity.keypair,
          audience: sellerDid,
          expiresInSeconds: -600,
        })
        break
    }

    const signer = privateKeyToAccount(evmPrivateKey ?? UNUSED_PRIVATE_KEY)
    const client = new x402Client().register(
      "eip155:*",
      new ExactEvmScheme(signer),
    )
    const fetchWithPayment = wrapFetchWithPayment(fetch, client)

    const response = await fetchWithPayment(`${sellerUrl}${PROTECTED_PATH}`, {
      headers: proof ? { authorization: `Bearer ${proof}` } : {},
    })

    const body: unknown = await response.json().catch(() => undefined)
    const settlementHeader = response.headers.get("PAYMENT-RESPONSE")
    const result: BuyerRunResult = {
      scenario,
      buyerDid: identity.did,
      status: response.status,
      body,
    }
    if (settlementHeader) {
      result.settlement = decodePaymentResponseHeader(settlementHeader)
    }
    return result
  } finally {
    await didHost.close()
  }
}
