import { HTTPFacilitatorClient } from "@x402/core/server"
import { loadConfig } from "../config.js"
import { createAmountCapAuthorization } from "./authorization.js"
import { createSeller, PROTECTED_PATH } from "./server.js"

try {
  process.loadEnvFile()
} catch {
  // no .env file; environment variables may be set directly
}

const config = loadConfig()

if (!config.SELLER_PAY_TO_ADDRESS) {
  console.error("SELLER_PAY_TO_ADDRESS is required (see .env.example)")
  process.exit(1)
}

const { app, identity } = await createSeller({
  baseUrl: config.sellerBaseUrl,
  network: config.X402_NETWORK,
  payTo: config.SELLER_PAY_TO_ADDRESS,
  price: config.ENDPOINT_PRICE_USD,
  facilitatorClient: new HTTPFacilitatorClient({
    url: config.X402_FACILITATOR_URL,
  }),
  authorize: createAmountCapAuthorization(config.AUTHORIZATION_MAX_USD),
})

app.listen(config.SELLER_PORT, () => {
  console.log(`Seller listening on ${config.sellerBaseUrl}`)
  console.log(`Seller DID: ${identity.did}`)
  console.log(
    `Protected endpoint: GET ${config.sellerBaseUrl}${PROTECTED_PATH}`,
  )
})
