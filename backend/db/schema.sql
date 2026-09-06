-- ShambaLuv self-hosted auth + airdrop backend — Postgres schema.
-- One social identity = one wallet = one claim, enforced by UNIQUE constraints.

CREATE TABLE IF NOT EXISTS identities (
    id              BIGSERIAL PRIMARY KEY,
    provider        TEXT        NOT NULL,            -- 'google' | 'discord' | 'github' | ...
    provider_user_id TEXT       NOT NULL,            -- the provider's stable user id
    -- Stable identity key = '<provider>:<providerUserId>'. The Sybil unit.
    identity_key    TEXT        NOT NULL UNIQUE,
    email           TEXT,                            -- may be null (not all providers share it)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Stamped on every REAL sign-in (consent click / wallet signature) — the daily-login
    -- timer gate reads it; a lingering session cookie never refreshes it.
    last_login_at   TIMESTAMPTZ,
    UNIQUE (provider, provider_user_id)
);

-- One embedded wallet per identity. Private key encrypted at rest (AES-256-GCM).
CREATE TABLE IF NOT EXISTS wallets (
    id              BIGSERIAL PRIMARY KEY,
    identity_key    TEXT        NOT NULL UNIQUE
                        REFERENCES identities (identity_key) ON DELETE CASCADE,
    address         TEXT        NOT NULL UNIQUE,      -- the 0x EVM address
    enc_ciphertext  TEXT        NOT NULL,             -- base64 AES-256-GCM ciphertext of the priv key
    enc_iv          TEXT        NOT NULL,             -- base64 12-byte GCM nonce
    enc_tag         TEXT        NOT NULL,             -- base64 16-byte GCM auth tag
    enc_alg         TEXT        NOT NULL DEFAULT 'AES-256-GCM',
    -- ERC-4337: the counterfactual LuvAccount for this identity (factory.getAddress(owner,
    -- salt)). The gesture is delivered HERE while the account has no code (0-fee window);
    -- `address` above stays the owner EOA (the signing key). NULL on pre-AA rows.
    smart_account   TEXT        UNIQUE,
    -- cypherpunk4096 handoff: 'platform' while we hold the encrypted owner key; 'participant' once the
    -- participant has taken the key and told us to destroy our copy (enc_* are blanked, irreversibly).
    custody         TEXT        NOT NULL DEFAULT 'platform',
    relinquished_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS custody TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS relinquished_at TIMESTAMPTZ;

-- Idempotent upgrade for databases created before the ERC-4337 wallet rail.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS smart_account TEXT UNIQUE;

-- One airdrop claim per identity. nonce is globally unique (matches on-chain usedNonce[]).
CREATE TABLE IF NOT EXISTS airdrop_claims (
    id              BIGSERIAL PRIMARY KEY,
    identity_key    TEXT        NOT NULL UNIQUE
                        REFERENCES identities (identity_key) ON DELETE CASCADE,
    wallet_address  TEXT        NOT NULL,
    nonce           NUMERIC(78, 0) UNIQUE,            -- uint256 nonce; NULL for the wallet-to-wallet
                                                      -- gesture (multiple NULLs ok), set only on the
                                                      -- optional on-chain voucher path
    amount          NUMERIC(78, 0) NOT NULL,          -- base units (wei)
    deadline        BIGINT,                           -- unix seconds the voucher expires
    tx_hash         TEXT,                             -- relayed claim() tx, or the SHARED batch tx
    -- status:
    --   direct mode: 'pending' -> 'submitted' -> 'confirmed' | 'failed' | 'already_claimed' | 'cap_reached'
    --   batch  mode: 'queued' -> 'batching' -> 'submitted' -> 'confirmed'
    --               | back to 'queued' on send failure (attempts++) | 'failed' | 'cap_reached'
    status          TEXT        NOT NULL DEFAULT 'pending',
    attempts        INT         NOT NULL DEFAULT 0,   -- batch send retries (failed at BATCH_MAX_ATTEMPTS)
    error           TEXT,                             -- short non-PII error note on failure
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Proof-of-action submissions for the IncentiveDistributor tasks rail (earn LUV for
-- tweet/post/interaction). action_id is the on-chain dedup key (claimWithSignature);
-- amounts/limits always come from the on-chain registry — `amount` here is a display copy.
CREATE TABLE IF NOT EXISTS action_submissions (
    id              BIGSERIAL PRIMARY KEY,
    identity_key    TEXT        NOT NULL
                        REFERENCES identities (identity_key) ON DELETE CASCADE,
    action          TEXT        NOT NULL,             -- 'tweet' | 'post' | 'interaction' | ...
    action_id       TEXT        NOT NULL UNIQUE,      -- derived: luv:<action>:<sha256(identity+proof)>
    proof_url       TEXT        NOT NULL,
    platform        TEXT,                             -- detected from the proof URL host
    amount          NUMERIC(78, 0),                   -- registry reward at submission time (display)
    -- 'queued' -> 'approved' (operator or ACTIONS_AUTO_APPROVE) -> 'paid' | 'failed' | 'rejected'
    status          TEXT        NOT NULL DEFAULT 'queued',
    tx_hash         TEXT,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_action_submissions_status ON action_submissions (status);
CREATE INDEX IF NOT EXISTS idx_action_submissions_identity ON action_submissions (identity_key);

-- Idempotent upgrade for databases created before batch mode existed.
ALTER TABLE airdrop_claims ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_airdrop_claims_status ON airdrop_claims (status);
CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets (address);

-- internal.calculation — LUV earned per identity over a trailing window, computed when the
-- identity is processed at login and kept as an append-only record. Bookkeeping only: it
-- moves nothing and is never authoritative over the chain or the on-chain action registry.
-- luv_base_units is NUMERIC(78,0) — base units, 1 LUV = 10^18 — never a float.
CREATE TABLE IF NOT EXISTS internal_calculations (
    id              BIGSERIAL PRIMARY KEY,
    identity_key    TEXT        NOT NULL
                        REFERENCES identities (identity_key) ON DELETE CASCADE,
    kind            TEXT        NOT NULL,             -- 'internal.calculation'
    trigger         TEXT        NOT NULL,             -- what caused it: 'login' | ...
    window_label    TEXT        NOT NULL,             -- '24 hours'
    luv_base_units  NUMERIC(78, 0) NOT NULL,          -- earned in the window, base units
    entries         INT         NOT NULL DEFAULT 0,   -- rows counted
    detail          JSONB,                            -- by_action / by_status breakdown
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_internal_calc_identity ON internal_calculations (identity_key, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_calc_kind ON internal_calculations (kind, computed_at DESC);

-- ── the LUVdrip ledger ───────────────────────────────────────────────────────────────────
-- A LOGIN ARMS A MILLION. Signing in opens a 24-hour window in which 1,000,000 LUV drips
-- continuously against the wall clock — presence-free: the flow keeps running whether or not
-- the tab is open — until that window's million is complete. The NEXT million starts on the
-- NEXT login. Settled LUV accumulates in `banked_wei` and stays there, growing, until it is
-- redeemed on-chain (see drip_redemptions).
--
-- `window_wei` is a PURE FUNCTION OF TIME: cap × elapsed(window) ÷ 24h, floored. Settling is
-- therefore idempotent and drift-free — ticking often, rarely, or never gives the same answer.
CREATE TABLE IF NOT EXISTS drip_state (
    identity_key      TEXT PRIMARY KEY
                          REFERENCES identities (identity_key) ON DELETE CASCADE,
    window_started_at TIMESTAMPTZ    NOT NULL DEFAULT now(),  -- the login that armed this million
    window_ends_at    TIMESTAMPTZ    NOT NULL,                -- window_started_at + 24h
    window_wei        NUMERIC(78, 0) NOT NULL DEFAULT 0,      -- settled inside this window (≤ cap)
    cap_wei           NUMERIC(78, 0) NOT NULL,                -- the window's million, in wei (1e24)
    settled_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),  -- last settlement tick
    banked_wei        NUMERIC(78, 0) NOT NULL DEFAULT 0,      -- accumulated, not yet redeemed
    held_wei          NUMERIC(78, 0) NOT NULL DEFAULT 0,      -- inside a live redemption voucher
    redeemed_wei      NUMERIC(78, 0) NOT NULL DEFAULT 0,      -- lifetime delivered on-chain
    windows           INT            NOT NULL DEFAULT 0,      -- how many millions have been armed
    created_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- One row per redemption voucher (IncentiveDistributor.redeemWithSignature / redeemBatch).
-- The amount leaves `banked_wei` for `held_wei` when the voucher is issued and returns if the
-- voucher expires unspent, so a participant can never redeem the same LUV twice.
--   payer  'self'    — the participant sends the transaction and spends their own ETH
--          'sponsor' — the project sends it and pays the gas for them
--   status 'pending' -> 'paid' (seen on-chain) | 'expired' (deadline passed, returned to banked)
CREATE TABLE IF NOT EXISTS drip_redemptions (
    id            BIGSERIAL PRIMARY KEY,
    identity_key  TEXT           NOT NULL
                      REFERENCES identities (identity_key) ON DELETE CASCADE,
    redemption_id TEXT           NOT NULL UNIQUE,   -- bytes32 hex — the on-chain replay key
    wallet        TEXT           NOT NULL,          -- recipient (the LUV lands here either way)
    token         TEXT           NOT NULL,
    amount_wei    NUMERIC(78, 0) NOT NULL,
    deadline      BIGINT         NOT NULL,          -- epoch seconds; the voucher dies here
    payer         TEXT           NOT NULL DEFAULT 'self',
    status        TEXT           NOT NULL DEFAULT 'pending',
    tx_hash       TEXT,
    error         TEXT,
    created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drip_redemptions_status ON drip_redemptions (status);
CREATE INDEX IF NOT EXISTS idx_drip_redemptions_identity ON drip_redemptions (identity_key, id DESC);

-- Idempotent upgrade for databases created before the drip ledger existed.
ALTER TABLE drip_state ADD COLUMN IF NOT EXISTS held_wei NUMERIC(78, 0) NOT NULL DEFAULT 0;

-- ── the drip's Sybil bindings — one login, one participant ────────────────────────────────
-- The ledger enforces uniqueness on every axis it can actually see:
--   • ONE DRIP PER IDENTITY   — drip_state's primary key, structurally
--   • ONE DRIP PER WALLET     — bound on first sight and unique thereafter, so a second
--                               identity can never point its drip at a wallet that is
--                               already earning. Partial index: NULL means "not yet bound".
--   • ONE DRIP PER EMAIL      — where the provider gives one, checked at arming time
-- What it cannot see is one human holding two unrelated social accounts; that is what makes
-- the social account, not the wallet, the Sybil unit in the first place.
ALTER TABLE drip_state ADD COLUMN IF NOT EXISTS wallet TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_drip_state_wallet ON drip_state (wallet) WHERE wallet IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_identities_email_lower ON identities (lower(email)) WHERE email IS NOT NULL;
