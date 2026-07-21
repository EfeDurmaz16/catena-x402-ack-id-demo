import { createServer } from "node:http"
import { createAmountCapAuthorization } from "../src/seller/authorization.js"
import { createSeller } from "../src/seller/server.js"
import type { Identity } from "../src/identity.js"
import type { Authorize } from "../src/seller/authorization.js"
import type { FacilitatorClient } from "@x402/core/server"
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse
} from "@x402/core/types"
import type { Server } from "node:http"

export const TEST_NETWORK: Network = "eip155:84532"
export const TEST_PAY_TO = "0x0000000000000000000000000000000000000001"

/**
 * Facilitator test double: records every verify/settle invocation and
 * approves everything, so tests can assert exactly when settlement logic is
 * (and is not) reached without touching any network.
 */
export class FakeFacilitatorClient implements FacilitatorClient {
  verifyCalls: PaymentPayload[] = []
  settleCalls: PaymentPayload[] = []

  async verify(
    payload: PaymentPayload,
    _requirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    this.verifyCalls.push(payload)
    return { isValid: true, payer: TEST_PAY_TO }
  }

  async settle(
    payload: PaymentPayload,
    _requirements: PaymentRequirements
  ): Promise<SettleResponse> {
    this.settleCalls.push(payload)
    return {
      success: true,
      transaction: "0xtest-settlement-transaction",
      network: TEST_NETWORK,
      payer: TEST_PAY_TO
    }
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: TEST_NETWORK }],
      extensions: [],
      signers: {}
    }
  }
}

export interface TestSeller {
  url: string
  identity: Identity
  facilitator: FakeFacilitatorClient
  close: () => Promise<void>
}

/**
 * Boot a seller on an ephemeral port. The port is reserved first so the
 * seller's did:web identity encodes the real base URL.
 */
export async function startTestSeller(
  options: { price?: string; authorize?: Authorize } = {}
): Promise<TestSeller> {
  const price = options.price ?? "$0.001"
  const facilitator = new FakeFacilitatorClient()

  const server: Server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine test seller port"))
        return
      }
      resolve(address.port)
    })
  })
  const url = `http://localhost:${port}`

  const { app, identity } = await createSeller({
    baseUrl: url,
    network: TEST_NETWORK,
    payTo: TEST_PAY_TO,
    price,
    facilitatorClient: facilitator,
    authorize: options.authorize ?? createAmountCapAuthorization("$0.05")
  })
  server.on("request", app)

  return {
    url,
    identity,
    facilitator,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      })
  }
}
