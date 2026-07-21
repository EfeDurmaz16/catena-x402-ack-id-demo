/** Generate a throwaway Base Sepolia wallet for the buyer. Testnet only. */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

const privateKey = generatePrivateKey()
const account = privateKeyToAccount(privateKey)

console.log(`Address:     ${account.address}`)
console.log(`Private key: ${privateKey}`)
console.log(
  "\nFund the address with Base Sepolia USDC at https://faucet.circle.com,",
)
console.log("then set BUYER_EVM_PRIVATE_KEY in .env. Testnet use only.")
