/**
 * Scripted demo runner. Usage: tsx scripts/demo.ts <scenario>
 * Scenarios: valid | missing-identity | mismatched-identity | expired-identity
 *
 * Starts the seller in-process, runs the scripted buyer against it, prints
 * the outcome and the settlement-adapter call counts, and exits non-zero if
 * the scenario did not behave as required.
 */
import { HTTPFacilitatorClient } from "@x402/core/server"
import { isScenario, runBuyer, SCENARIOS } from "../src/buyer/buyer.js"
import { BASE_SEPOLIA_USDC, loadConfig, moneyToMicros } from "../src/config.js"
import { CountingFacilitatorClient } from "../src/counting-facilitator.js"
import { verifySettlement } from "../src/onchain.js"
import { createAmountCapAuthorization } from "../src/seller/authorization.js"
import { createSeller } from "../src/seller/server.js"
import type { Server } from "node:http"

try {
  process.loadEnvFile()
} catch {
  // no .env file; environment variables may be set directly
}

const scenarioArg = process.argv[2] ?? ""
if (!isScenario(scenarioArg)) {
  console.error(`Usage: demo.ts <${SCENARIOS.join(" | ")}>`)
  process.exit(2)
}
const scenario = scenarioArg

const config = loadConfig()
// The valid scenario settles real testnet USDC; refuse to burn it to a
// placeholder address. Rejected-identity scenarios never reach payment, so
// they run without a funded wallet or a real pay-to address.
if (scenario === "valid" && !config.SELLER_PAY_TO_ADDRESS) {
  console.error("SELLER_PAY_TO_ADDRESS is required for the valid scenario")
  process.exit(2)
}
const payTo =
  config.SELLER_PAY_TO_ADDRESS ?? "0x0000000000000000000000000000000000000001"

const facilitator = new CountingFacilitatorClient(
  new HTTPFacilitatorClient({ url: config.X402_FACILITATOR_URL }),
)

const { app, identity } = await createSeller({
  baseUrl: config.sellerBaseUrl,
  network: config.X402_NETWORK,
  payTo,
  price: config.ENDPOINT_PRICE_USD,
  facilitatorClient: facilitator,
  authorize: createAmountCapAuthorization(config.AUTHORIZATION_MAX_USD),
})

const server: Server = await new Promise((resolve, reject) => {
  const s = app.listen(config.SELLER_PORT, () => {
    resolve(s)
  })
  // Fail loudly if the port is taken: a stale seller with old config would
  // otherwise serve the demo silently.
  s.once("error", reject)
})

console.log(`Seller:   ${config.sellerBaseUrl} (${identity.did})`)
console.log(
  `Network:  ${config.X402_NETWORK}, price ${config.ENDPOINT_PRICE_USD}`,
)
console.log(`Scenario: ${scenario}\n`)

try {
  const result = await runBuyer(scenario, {
    sellerUrl: config.sellerBaseUrl,
    sellerDid: identity.did,
    didPort: config.BUYER_DID_PORT,
    ...(config.BUYER_EVM_PRIVATE_KEY
      ? { evmPrivateKey: config.BUYER_EVM_PRIVATE_KEY }
      : {}),
  })

  console.log(`Buyer DID:    ${result.buyerDid}`)
  console.log(`HTTP status:  ${result.status}`)
  console.log(`Response:     ${JSON.stringify(result.body)}`)
  if (result.settlement) {
    console.log(`Settlement:   success=${result.settlement.success}`)
    console.log(`Transaction:  ${result.settlement.transaction}`)
    console.log(
      `Explorer:     https://sepolia.basescan.org/tx/${result.settlement.transaction}`,
    )
  }
  console.log(
    `\nSettlement adapter calls: verify=${facilitator.verifyCalls} settle=${facilitator.settleCalls}`,
  )

  // Close the loop: confirm the money actually reached the Catena account
  // on-chain, rather than trusting the facilitator's response. Only the valid
  // scenario settles, and only when the seller pays a real address.
  let onChainConfirmed = false
  if (result.settlement?.transaction && config.SELLER_PAY_TO_ADDRESS) {
    const onchain = await verifySettlement({
      txHash: result.settlement.transaction as `0x${string}`,
      rpcUrl: config.BASE_SEPOLIA_RPC_URL,
      token: BASE_SEPOLIA_USDC,
      expectedTo: config.SELLER_PAY_TO_ADDRESS,
      expectedAmount: moneyToMicros(config.ENDPOINT_PRICE_USD),
    }).catch((error: unknown) => {
      // A thrown error means the chain contradicts the claimed settlement.
      console.error(
        `\nON-CHAIN MISMATCH: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    })
    if (onchain?.status === "confirmed") {
      console.log(
        `On-chain:     ${onchain.settlement.amount} atomic USDC confirmed to ${onchain.settlement.to} (block ${onchain.settlement.block})`,
      )
      console.log(
        `Loop closed:  confirmed on-chain to your Catena deposit address; the Catena console shows whether it credited as an incoming deposit.`,
      )
      onChainConfirmed = true
    } else if (onchain?.status === "unavailable") {
      console.log(
        `On-chain:     not confirmed (${onchain.reason}); rerun to confirm`,
      )
    }
  }

  const ok =
    scenario === "valid"
      ? result.status === 200 &&
        result.settlement?.success === true &&
        onChainConfirmed
      : (result.status === 401 || result.status === 403) &&
        facilitator.verifyCalls === 0 &&
        facilitator.settleCalls === 0

  if (ok) {
    console.log(
      scenario === "valid"
        ? "\nPASS: identity verified, payment settled, resource delivered."
        : "\nPASS: identity rejected before any payment; settlement adapter never invoked.",
    )
  } else {
    console.error("\nFAIL: scenario did not behave as required.")
    process.exitCode = 1
  }
} finally {
  server.close()
}
