# The handoff — how a LUVwallet becomes the participant's alone

1. **Provision** (`provisionWallet(identityKey)`): `ethers.Wallet.createRandom()` → owner EOA. Encrypt the private key with
   AES-256-GCM under `scrypt(WALLET_ENCRYPTION_KEY, sha256("shambaluv:" + identityKey))`. Compute the counterfactual
   LuvAccount from the factory (`getAddress(owner, salt 0)`). Insert one `wallets` row (UNIQUE per identity).
2. **Deliver**: LUV is sent to the smart-account address (0-fee while code-less). Reflections accrue there.
3. **Reveal** (`POST /auth/wallet/export`, session-gated): decrypt, return `{address, privateKey}` with `Cache-Control: no-store`.
   The page fetches only while the button is held (pointerdown) and masks on release, blur, or tab hide.
4. **Shred** (the relinquish route) (`POST /auth/wallet/relinquish`, session-gated, body `{confirm}` = last six characters of the owner address):
   the three key columns are overwritten with random bytes `WALLET_SHRED_PASSES` (default 7) times, then blanked with `custody=participant, relinquished_at=now()`, then `VACUUM FULL wallets` rewrites the table. Irreversible; the response carries `passes` and `rewritten`.
   `getUserSigner` throws `relinquished`; export answers 410; `/auth/me` reports `custody: 'participant'` and `relinquishedAt`.
5. **After**: the platform delivers to the address (distributor, drip redemption) but cannot sign. The participant imports the
   key into MetaMask (the owner EOA) and controls the LuvAccount through it.

Standard: cypherpunk4096 — determinism (one factory, one salt, one address per owner on every chain), zero dependencies on
the page, verification over trust (every contract source-verified), consent over default (nothing is revealed or destroyed
without the participant's press).

## The standard path (no handoff needed)

`site/luvwallet.js` → create on the machine → `POST /auth/wallet/challenge` → `wallet.signMessage(challenge)` →
`POST /auth/wallet/bind {address, signature, challengeToken}` → `wallets` row with `custody='client'`, `enc_* = ''`,
`smart_account = factory.getAddress(address)`. The platform delivers to that address and can never sign. `custody` values:
`platform` (legacy, key held encrypted) · `participant` (legacy key taken and shredded) · `client` (generated on the client's
machine, never held) · `external` (MetaMask sign-in, reported by `/auth/me` only).
