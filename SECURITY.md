# Security

This is a demo. It runs on Base Sepolia testnet only.

Never put a private key that holds real funds in `.env`. Generate a throwaway
wallet with `pnpm wallet:new` and fund it from a testnet faucet.

The seller binds a local port and serves an unauthenticated `/healthz` and
did:web document; do not expose it on a public interface.

Report a vulnerability by opening an issue at
https://github.com/catena-oss/x402-ack-id-demo/issues, or privately via
GitHub Security Advisories on the same repository.
