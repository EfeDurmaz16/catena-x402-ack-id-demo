import type { FacilitatorClient } from "@x402/core/server"
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types"

/**
 * Decorator around any FacilitatorClient that counts verify/settle calls.
 * Used by the demo scripts and tests to prove that rejected identities never
 * reach the settlement adapter.
 */
export class CountingFacilitatorClient implements FacilitatorClient {
  verifyCalls = 0
  settleCalls = 0

  constructor(private readonly inner: FacilitatorClient) {}

  async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    this.verifyCalls += 1
    return this.inner.verify(payload, requirements)
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
    this.settleCalls += 1
    return this.inner.settle(payload, requirements)
  }

  async getSupported() {
    return this.inner.getSupported()
  }
}
