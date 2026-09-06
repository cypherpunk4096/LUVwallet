# LUVwallet

The wallet SHAMBA LUV creates for a participant at sign-in, and the handoff that makes it theirs.
Built to the [cypherpunk4096 standard](https://github.com/cypherpunk4096/standard): sovereignty over custody,
consent over default, verification over trust. Made with [LUV ❤](https://luv.pythai.net/).

## What it is

| piece | where | state |
|---|---|---|
| **LuvAccount** — the participant's ERC-4337 smart account (EntryPoint v0.7), owned by one EOA key | [`contracts/aa/LuvAccount.sol`](contracts/aa/LuvAccount.sol) | counterfactual per participant; `factory.getAddress(owner, salt)`; receives LUV while code-less (0-fee window) |
| **LuvAccountFactory** | [`contracts/aa/LuvAccountFactory.sol`](contracts/aa/LuvAccountFactory.sol) | **live** on Ethereum `0xB8cb4780d79ce0c6DA7700ad46d976376AC21D09` ([verified](https://etherscan.io/address/0xB8cb4780d79ce0c6DA7700ad46d976376AC21D09#code)) |
| **LuvPaymaster** — gas sponsorship for user operations | [`contracts/aa/LuvPaymaster.sol`](contracts/aa/LuvPaymaster.sol) | **live** `0xa5Bee1887F145893Fd3698Eb0b4c761d088Ea68A` ([verified](https://etherscan.io/address/0xa5Bee1887F145893Fd3698Eb0b4c761d088Ea68A#code)) |
| **Provisioning** — one wallet per identity, owner key generated in-house, AES-256-GCM at rest (scrypt per identity from the master secret) | [`backend/wallet/provision.js`](backend/wallet/provision.js) | live in the luv.pythai.net backend (`auth/`) |
| **Send** — LUV from the custodial owner key while custody is `platform` | [`backend/wallet/send.js`](backend/wallet/send.js) | live |
| **The handoff** — reveal on press-and-hold, then `POST /auth/wallet/relinquish` destroys the platform's copy | [`backend/routes/auth.js`](backend/routes/auth.js), [`docs/HANDOFF.md`](docs/HANDOFF.md) | live 2026-09-06 |
| **The dashboard** — the wallet card first, then custody, then the gesture, the LUVdrip, trade, share | [`site/app.html`](site/app.html) · [`site/app.js`](site/app.js) · [`site/app.css`](site/app.css) | live at https://luv.pythai.net/app.html |
| **The LUV card** — any wallet's LUV read live from the chain, QR, share, the cypherpunk4096 mark, made with LUV | [`site/card.html`](site/card.html) · [`site/card.js`](site/card.js) | live at https://luv.pythai.net/card.html?a=0x… |
| **Schema** — `wallets` incl. `custody` ∈ {platform, participant} and `relinquished_at` | [`backend/db/schema.sql`](backend/db/schema.sql) | live |
| **Every live address** | [`deploy/addresses.json`](deploy/addresses.json) | the luv.live.json contract |

The token these wallets hold: SHAMBA LUV `0x2711111111683B8708cb9a48cBf36a51315F8254`, Ethereum mainnet, source verified.

## The standard (operator, 2026-09-06)

**Client-side compute. The client controller lives in the client's wallet, on the client's machine. The platform verifies
signatures.** [`site/luvwallet.js`](site/luvwallet.js) is that controller: the key is generated in the browser (vendored
ethers v6, no network), encrypted under the client's passphrase into the wallet's own keystore format and kept in that
browser's storage (and downloadable, so MetaMask can import it). To attach it to a sign-in the client signs the same
challenge MetaMask sign-in uses and `POST /auth/wallet/bind` verifies the signature and records the address with
`custody = 'client'` — no key material is ever stored server-side, and export answers 410. Shred on the machine is seven random
overwrites of the stored keystore before removal. The platform-generated wallet is the legacy path, and it must be taken and
shredded (below) before a client-controlled address can be bound, so no key is ever left unheld.

## The handoff, in one paragraph

Sign in (Google, GitHub, or MetaMask). For social identities a key pair is generated on our own box, the private key is
encrypted with a per-identity key derived from a master secret that lives only in the service environment, and the
counterfactual LuvAccount is computed from the owner address. The participant sees the account address, a QR, the balance.
Under it: press and hold to reveal the private key (fetched only on hold, masked on release, never persisted by the page),
save it, then type the last six characters of the address and press *destroy the platform's copy*. The ciphertext columns are
blanked in the same transaction that flips `custody` to `participant`; the export route answers 410 from then on; the
platform can still deliver LUV to the address but can never sign for it. MetaMask identities bring their own key and skip
all of this (`custody: external`).

## Not done yet

- The LuvAccount contract is deployed counterfactually only: an account gets code on its first user operation. The
  paymaster needs an EntryPoint deposit before it sponsors anything.
- The handoff moves custody to the participant's *own* saved key. A passkey / 2-of-2 key-share so that no single copy of the
  owner key is ever whole on any machine is the next commitment (see the comment block at the top of `provision.js`).
- No independent audit of the AA contracts yet.

## Run the site part locally

```
cd site && python3 -m http.server 8792
```
`card.html?a=0x…` needs only a browser: it reads Ethereum through a public node. `app.html` needs the luv.pythai.net backend.

MIT for the site and backend; the contracts carry their own headers.
