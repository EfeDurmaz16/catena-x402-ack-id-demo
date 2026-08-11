/**
 * Integration tests for the core security invariant: identity verification
 * strictly precedes payment. Every rejected-identity path must leave the
 * settlement adapter (FacilitatorClient) untouched.
 */
import { createDidKeyUri } from "@agentcommercekit/did"
import { createJwt, createJwtSigner } from "@agentcommercekit/jwt"
import { generateKeypair } from "@agentcommercekit/keys"
import { ExactEvmScheme } from "@x402/evm/exact/client"
import { wrapFetchWithPayment, x402Client } from "@x402/fetch"
import { privateKeyToAccount } from "viem/accounts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runBuyer, signScenarioProof } from "../src/buyer/buyer.js"
import { startDidHost } from "../src/buyer/did-host.js"
import { createIdentity, createIdentityProof } from "../src/identity.js"
import { PROTECTED_PATH } from "../src/seller/server.js"
import { FakeFacilitatorClient, startTestSeller } from "./helpers.js"
import type { Scenario } from "../src/buyer/buyer.js"
import type { DidHost } from "../src/buyer/did-host.js"
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
} from "@x402/core/types"
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
  return signScenarioProof(scenario, identity, sellerDid)
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

  // A did:key proof verifies against its own embedded key and proves no domain
  // control, so the gate must require did:web; "not.a.jwt" is not a proof at
  // all. Both are identity_invalid, and neither reaches the payment layer.
  it.each([
    [
      "did:key",
      async (sellerDid: string) => {
        const keypair = await generateKeypair("secp256k1")
        return createJwt(
          { aud: sellerDid, nonce: "did-key-nonce" },
          {
            issuer: createDidKeyUri(keypair),
            signer: createJwtSigner(keypair),
            expiresIn: 300,
          },
        )
      },
    ],
    ["garbage", () => Promise.resolve("not.a.jwt")],
  ] as const)(
    "%s identity proof: rejected as identity_invalid before settlement",
    async (_name, buildToken) => {
      seller = await startTestSeller()
      const response = await fetch(`${seller.url}${PROTECTED_PATH}`, {
        headers: {
          authorization: `Bearer ${await buildToken(seller.identity.did)}`,
        },
      })
      expect(response.status).toBe(401)
      const body: unknown = await response.json()
      expect(body).toMatchObject({ error: "identity_invalid" })
      expect(seller.facilitator.verifyCalls).toHaveLength(0)
      expect(seller.facilitator.settleCalls).toHaveLength(0)
    },
  )

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

  it("replayed identity proof: a second settleable payment with the same proof never settles", async () => {
    // The nonce is consumed at settlement, so replay is proven by driving two
    // real payments with the same proof: the first settles, the second reaches
    // the facilitator's verify but is aborted before settle.
    seller = await startTestSeller()
    const host = await startDidHost()
    hosts.push(host)
    const identity = await createIdentity(host.baseUrl)
    host.setDocument(identity.didDocument)
    const signer = privateKeyToAccount(TEST_PRIVATE_KEY)
    const proof = await createIdentityProof({
      issuerDid: identity.did,
      keypair: identity.keypair,
      audience: seller.identity.did,
      paymentAddress: signer.address, // bind the proof to the paying wallet
    })
    const client = new x402Client().register(
      "eip155:*",
      new ExactEvmScheme(signer),
    )
    const pay = wrapFetchWithPayment(fetch, client)
    const url = `${seller.url}${PROTECTED_PATH}`

    // First settleable payment: nonce consumed at settle time; it goes through.
    const first = await pay(url, {
      headers: { authorization: `Bearer ${proof}` },
    })
    expect(first.status).toBe(200)
    expect(seller.facilitator.verifyCalls).toHaveLength(1)
    expect(seller.facilitator.settleCalls).toHaveLength(1)

    // Same proof, second settleable payment: the facilitator verifies it
    // (verify=2), but the nonce is already used, so the seller aborts before
    // settle. No second settlement.
    const second = await pay(url, {
      headers: { authorization: `Bearer ${proof}` },
    })
    expect(second.status).not.toBe(200)
    expect(seller.facilitator.verifyCalls).toHaveLength(2)
    expect(seller.facilitator.settleCalls).toHaveLength(1)
  })

  it("a garbage payment does not burn the proof's nonce", async () => {
    // Regression guard for the fix: the nonce is consumed only at settlement,
    // so a payment that never settles (here, an undecodable one) leaves the
    // proof usable. Under the old header-presence consumption this failed: the
    // junk payment burned the nonce and the real payment was rejected as replay.
    seller = await startTestSeller()
    const host = await startDidHost()
    hosts.push(host)
    const identity = await createIdentity(host.baseUrl)
    host.setDocument(identity.didDocument)
    const signer = privateKeyToAccount(TEST_PRIVATE_KEY)
    const proof = await createIdentityProof({
      issuerDid: identity.did,
      keypair: identity.keypair,
      audience: seller.identity.did,
      paymentAddress: signer.address,
    })
    const url = `${seller.url}${PROTECTED_PATH}`

    // Undecodable payment: the payment layer never verifies or settles it. It
    // logs the decode failure, which is the expected outcome here, not noise
    // worth printing on every run.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const garbage = await fetch(url, {
      headers: {
        authorization: `Bearer ${proof}`,
        "payment-signature": "bm90LWEtcmVhbC1wYXltZW50",
      },
    }).finally(() => {
      warn.mockRestore()
    })
    expect(garbage.status).not.toBe(200)
    expect(seller.facilitator.settleCalls).toHaveLength(0)

    // The same proof still pays for real and settles.
    const client = new x402Client().register(
      "eip155:*",
      new ExactEvmScheme(signer),
    )
    const paid = await wrapFetchWithPayment(fetch, client)(url, {
      headers: { authorization: `Bearer ${proof}` },
    })
    expect(paid.status).toBe(200)
    expect(seller.facilitator.settleCalls).toHaveLength(1)
  })
})

/**
 * Records calls like the fake it extends, but answers verify with a verdict
 * of an arbitrary runtime shape, the way a broken facilitator client would.
 */
class MalformedVerdictFacilitator extends FakeFacilitatorClient {
  constructor(private readonly verdict: unknown) {
    super()
  }

  override async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    await super.verify(payload, requirements)
    return { isValid: this.verdict } as VerifyResponse
  }
}

describe("hardening against a broken payment layer", () => {
  // The static VerifyResponse type promises a boolean verdict, but nothing
  // enforces it at runtime for a custom facilitator client. A truthy
  // non-boolean ("false", 1) passes both x402's settle check and a naive
  // truthiness check in the seller's hook, so the payment would settle even
  // though the facilitator never said isValid === true.
  it.each([
    ['the string "false"', "false"],
    ["the number 1", 1],
    ["missing entirely", undefined],
  ] as const)(
    "facilitator verdict is %s: request fails and nothing settles",
    async (_name, verdict) => {
      const facilitator = new MalformedVerdictFacilitator(verdict)
      seller = await startTestSeller({ facilitator })
      const result = await runBuyer("valid", {
        sellerUrl: seller.url,
        sellerDid: seller.identity.did,
        evmPrivateKey: TEST_PRIVATE_KEY,
      })
      expect(result.status).not.toBe(200)
      expect(facilitator.verifyCalls).toHaveLength(1)
      expect(facilitator.settleCalls).toHaveLength(0)
    },
  )

  it("HEAD with a valid identity and no payment: 405, payment layer untouched", async () => {
    // Express answers HEAD through app.get handlers, but the x402 route key
    // only covers GET, so without an explicit HEAD route the handler would
    // serve a 200 with no payment involved.
    seller = await startTestSeller()
    const proof = await buildProof(seller.identity.did, "valid")
    const response = await fetch(`${seller.url}${PROTECTED_PATH}`, {
      method: "HEAD",
      headers: proof ? { authorization: `Bearer ${proof}` } : {},
    })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
    expect(seller.facilitator.verifyCalls).toHaveLength(0)
    expect(seller.facilitator.settleCalls).toHaveLength(0)
  })
})
