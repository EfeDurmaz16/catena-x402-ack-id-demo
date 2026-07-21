/**
 * Integration tests for the core security invariant: identity verification
 * strictly precedes payment. Every rejected-identity path must leave the
 * settlement adapter (FacilitatorClient) untouched.
 */
import { createDidKeyUri } from "@agentcommercekit/did"
import { createJwt, createJwtSigner } from "@agentcommercekit/jwt"
import { generateKeypair } from "@agentcommercekit/keys"
import { afterEach, describe, expect, it } from "vitest"
import { runBuyer } from "../src/buyer/buyer.js"
import { startDidHost } from "../src/buyer/did-host.js"
import { createIdentity, createIdentityProof } from "../src/identity.js"
import { PROTECTED_PATH } from "../src/seller/server.js"
import { startTestSeller } from "./helpers.js"
import type { Scenario } from "../src/buyer/buyer.js"
import type { DidHost } from "../src/buyer/did-host.js"
import type { TestSeller } from "./helpers.js"

// Unfunded throwaway key: fine here because the fake facilitator approves
// payments without touching a chain.
const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const

let seller: TestSeller | undefined
const hosts: DidHost[] = []

afterEach(async () => {
  await seller?.close()
  seller = undefined
  await Promise.all(hosts.map((h) => h.close()))
  hosts.length = 0
})

/**
 * Mint a hosted did:web identity and sign the scenario's proof. The host stays
 * up (closed in afterEach) so the seller can resolve it during the request.
 * Returns undefined for the missing-identity case.
 */
async function buildProof(
  sellerDid: string,
  scenario: Scenario,
): Promise<string | undefined> {
  if (scenario === "missing-identity") return undefined
  const host = await startDidHost()
  hosts.push(host)
  const identity = await createIdentity(host.baseUrl)
  host.setDocument(identity.didDocument)
  const keypair =
    scenario === "mismatched-identity"
      ? await generateKeypair("secp256k1") // key the DID does not publish
      : identity.keypair
  return createIdentityProof({
    issuerDid: identity.did,
    keypair,
    audience: sellerDid,
    ...(scenario === "expired-identity" ? { expiresInSeconds: -600 } : {}),
  })
}

async function runScenario(scenario: Scenario) {
  seller = await startTestSeller()
  const result = await runBuyer(scenario, {
    sellerUrl: seller.url,
    sellerDid: seller.identity.did,
    evmPrivateKey: TEST_PRIVATE_KEY,
  })
  return { result, seller }
}

describe("identity-before-payment ordering", () => {
  it("valid identity: pays via the facilitator and receives the resource", async () => {
    const { result, seller } = await runScenario("valid")
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      report: "premium-market-signal",
      buyer: result.buyerDid,
    })
    expect(result.settlement?.success).toBe(true)
    expect(seller.facilitator.verifyCalls).toHaveLength(1)
    expect(seller.facilitator.settleCalls).toHaveLength(1)
  })

  it.each([
    ["missing-identity", 401, "identity_missing"],
    ["mismatched-identity", 403, "identity_mismatched"],
    ["expired-identity", 401, "identity_expired"],
  ] as const satisfies readonly (readonly [Scenario, number, string])[])(
    "%s: rejected with %d before the settlement adapter is ever invoked",
    async (scenario, status, code) => {
      const { result, seller } = await runScenario(scenario)
      expect(result.status).toBe(status)
      expect(result.body).toMatchObject({ error: code })
      expect(result.settlement).toBeUndefined()
      expect(seller.facilitator.verifyCalls).toHaveLength(0)
      expect(seller.facilitator.settleCalls).toHaveLength(0)
    },
  )

  it.each([
    ["missing-identity", 401, "identity_missing"],
    ["mismatched-identity", 403, "identity_mismatched"],
    ["expired-identity", 401, "identity_expired"],
  ] as const satisfies readonly (readonly [Scenario, number, string])[])(
    "%s WITH a payment header: still rejected before settlement",
    async (scenario, status, code) => {
      // The rejected-identity cases above run without a payment header. Repeat
      // them with one present, so a regression that skips the identity gate
      // when PAYMENT-SIGNATURE is set cannot pass unnoticed.
      seller = await startTestSeller()
      const proof = await buildProof(seller.identity.did, scenario)
      const response = await fetch(`${seller.url}${PROTECTED_PATH}`, {
        headers: {
          ...(proof ? { authorization: `Bearer ${proof}` } : {}),
          "payment-signature": "bm90LWEtcmVhbC1wYXltZW50",
        },
      })
      expect(response.status).toBe(status)
      const body: unknown = await response.json()
      expect(body).toMatchObject({ error: code })
      expect(seller.facilitator.verifyCalls).toHaveLength(0)
      expect(seller.facilitator.settleCalls).toHaveLength(0)
    },
  )

  it("did:key identity: rejected as identity_invalid before settlement", async () => {
    // The default resolver handles did:key too, but a self-issued did:key
    // proves no domain control. The gate must require did:web.
    seller = await startTestSeller()
    const keypair = await generateKeypair("secp256k1")
    const did = createDidKeyUri(keypair)
    const proof = await createJwt(
      { aud: seller.identity.did, nonce: "did-key-nonce" },
      { issuer: did, signer: createJwtSigner(keypair), expiresIn: 300 },
    )
    const response = await fetch(`${seller.url}${PROTECTED_PATH}`, {
      headers: { authorization: `Bearer ${proof}` },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: "identity_invalid" })
    expect(seller.facilitator.verifyCalls).toHaveLength(0)
    expect(seller.facilitator.settleCalls).toHaveLength(0)
  })

  it("garbage identity proof: rejected without reaching the settlement adapter", async () => {
    seller = await startTestSeller()
    const response = await fetch(`${seller.url}${PROTECTED_PATH}`, {
      headers: { authorization: "Bearer not.a.jwt" },
    })
    expect(response.status).toBe(401)
    const body: unknown = await response.json()
    expect(body).toMatchObject({ error: "identity_invalid" })
    expect(seller.facilitator.verifyCalls).toHaveLength(0)
    expect(seller.facilitator.settleCalls).toHaveLength(0)
  })

  it("identity-payer binding: proof bound to another wallet is rejected after verify, before settle", async () => {
    // Models the attack: a valid identity proof paired with a payment from a
    // wallet the proof did not commit to. The facilitator verifies the payment
    // (verify=1), but the seller aborts before settle (settle=0): no money moves.
    seller = await startTestSeller()
    const result = await runBuyer("valid", {
      sellerUrl: seller.url,
      sellerDid: seller.identity.did,
      evmPrivateKey: TEST_PRIVATE_KEY,
      bindPaymentAddress: "0x000000000000000000000000000000000000dEaD",
    })
    expect(result.status).not.toBe(200)
    expect(result.settlement?.success).not.toBe(true)
    expect(seller.facilitator.verifyCalls).toHaveLength(1)
    expect(seller.facilitator.settleCalls).toHaveLength(0)
  })

  it("authorization stub: valid identity but price over cap is denied before payment", async () => {
    seller = await startTestSeller({
      price: "$0.10", // over the $0.05 default cap
    })
    const result = await runBuyer("valid", {
      sellerUrl: seller.url,
      sellerDid: seller.identity.did,
      evmPrivateKey: TEST_PRIVATE_KEY,
    })
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ error: "authorization_denied" })
    expect(seller.facilitator.verifyCalls).toHaveLength(0)
    expect(seller.facilitator.settleCalls).toHaveLength(0)
  })

  it("replayed identity proof: second use is rejected before payment", async () => {
    seller = await startTestSeller()
    const host = await startDidHost()
    try {
      const identity = await createIdentity(host.baseUrl)
      host.setDocument(identity.didDocument)
      const proof = await createIdentityProof({
        issuerDid: identity.did,
        keypair: identity.keypair,
        audience: seller.identity.did,
      })
      // Unpaid requests (no payment header) verify the proof but do not
      // consume its nonce: they can only ever earn a 402 challenge.
      const unpaid = await fetch(`${seller.url}${PROTECTED_PATH}`, {
        headers: { authorization: `Bearer ${proof}` },
      })
      expect(unpaid.status).toBe(402)

      // A payment-bearing request consumes the nonce. Its garbage payment
      // fails to decode, so the payment layer answers with a fresh 402.
      const paid = await fetch(`${seller.url}${PROTECTED_PATH}`, {
        headers: {
          authorization: `Bearer ${proof}`,
          "payment-signature": "bm90LWEtcmVhbC1wYXltZW50",
        },
      })
      expect(paid.status).toBe(402)

      // ...so replaying the same proof on a second payment-bearing request
      // is rejected before the payment layer.
      const replayed = await fetch(`${seller.url}${PROTECTED_PATH}`, {
        headers: {
          authorization: `Bearer ${proof}`,
          "payment-signature": "bm90LWEtcmVhbC1wYXltZW50",
        },
      })
      expect(replayed.status).toBe(403)
      const body: unknown = await replayed.json()
      expect(body).toMatchObject({ error: "identity_replayed" })
      // The garbage payment header never verified or settled anything.
      expect(seller.facilitator.verifyCalls).toHaveLength(0)
      expect(seller.facilitator.settleCalls).toHaveLength(0)
    } finally {
      await host.close()
    }
  })
})
