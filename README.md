# catena-x402-ack-id-demo

An [x402](https://github.com/x402-foundation/x402) seller that verifies an [ACK-ID](https://www.agentcommercekit.com) identity proof before any payment logic runs, then settles USDC on Base Sepolia. No verified identity, no payment. Tests assert the settlement adapter is never invoked for rejected identities.

```
Buyer                              Seller
  |  GET /api/premium                 |
  |  Authorization: Bearer <ACK-ID>   |
  |---------------------------------->|  1. resolve did:web, verify JWT
  |                                   |  2. authorization stub (amount cap)
  |          402 + PAYMENT-REQUIRED   |  3. x402 challenge
  |<----------------------------------|
  |  retry + PAYMENT-SIGNATURE        |
  |---------------------------------->|  1-2 again, then verify + settle
  |          200 + PAYMENT-RESPONSE   |
  |<----------------------------------|
```

Rejected identities (missing, malformed, expired, mismatched, replayed) stop at step 1 with 401/403. [docs/architecture.md](docs/architecture.md) explains why the ordering holds.

## Quickstart

Node >= 22.13, pnpm >= 9.

```sh
pnpm install
cp .env.example .env
```

The rejected-identity demos need no keys or funds:

```sh
pnpm demo:missing-identity
pnpm demo:mismatched-identity
pnpm demo:expired-identity
```

For the real payment:

1. `pnpm exec tsx scripts/new-wallet.ts` and fund the printed address with Base Sepolia USDC at [faucet.circle.com](https://faucet.circle.com). No ETH needed; transfers are gasless EIP-3009, the facilitator pays gas.
2. Set `BUYER_EVM_PRIVATE_KEY` and `SELLER_PAY_TO_ADDRESS` in `.env`. For the Catena sandbox story, use your sandbox account's base-sepolia USDC deposit address as `SELLER_PAY_TO_ADDRESS`: the settlement then lands in your Catena account, visible in the console.
3. `pnpm demo:valid` completes a ~$0.001 USDC payment and prints the transaction with a BaseScan link.

## Commands

| Command                                      | Result                                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| `pnpm demo:valid`                            | Verified identity, real USDC settlement, protected result |
| `pnpm demo:missing-identity`                 | 401 before any payment logic                              |
| `pnpm demo:mismatched-identity`              | 403 before any payment logic                              |
| `pnpm demo:expired-identity`                 | 401 before any payment logic                              |
| `pnpm seller`                                | Seller service standalone                                 |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` | Checks                                                    |

## Layout

- [src/identity.ts](src/identity.ts): ACK-ID proof creation and verification, nonce replay cache
- [src/seller/server.ts](src/seller/server.ts): identity gate → authorization stub → x402 middleware → handler
- [src/seller/authorization.ts](src/seller/authorization.ts): the injectable authorization stub (amount cap)
- [src/buyer/buyer.ts](src/buyer/buyer.ts): scripted buyer, one entrypoint per scenario
- [test/ordering.test.ts](test/ordering.test.ts): proof that rejected identities never reach settlement

## License

MIT
