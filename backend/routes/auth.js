'use strict';

/*
 * routes/auth.js — OAuth login redirects + callbacks, /me, /logout.
 *
 * On the FIRST login for an identity we provision the embedded wallet and trigger the airdrop;
 * on every login we (idempotently) ensure both exist, then issue a signed JWT session.
 */

const express = require('express');
const passport = require('passport');
const crypto = require('crypto');
const jsonwebtoken = require('jsonwebtoken');
const { enabledProviders } = require('../config');
const { config } = require('../config');
const db = require('../db');
const { upsertIdentity, ensureProvisionedAndAirdropped } = require('../auth/identity');
const { issueToken, setSessionCookie, clearSessionCookie, requireAuth } = require('../auth/session');

const router = express.Router();
const ENABLED = enabledProviders();

/*
 * cypherpunk2048 entry handling.
 *
 * 1) VERIFICATION OVER TRUST — every OAuth round-trip is bound by a `state` nonce
 *    carried in a short-lived signed cookie (stateless, same pattern as the wallet
 *    challenge). A callback whose state doesn't match its cookie is discarded, which
 *    closes the login-CSRF hole of an unbound authorize redirect.
 * 2) CONSENT OVER DEFAULT — the callback does NOT mint a session. A provider with a
 *    live browser session (GitHub especially: no prompt-forcing param exists) redirects
 *    straight back without showing the user anything, so the verified identity is
 *    parked in a 5-minute pending token and the browser lands on /enter.html. Nothing
 *    is provisioned and no session exists until the user explicitly clicks enter.
 */
const STATE_COOKIE = 'shambaluv_oauth_state';
const PENDING_COOKIE = 'shambaluv_oauth_pending';
const OAUTH_TTL_S = 300;

function setShortCookie(res, name, value) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: OAUTH_TTL_S * 1000,
    path: '/auth',
  });
}

function dropShortCookie(res, name) {
  // Attributes MUST mirror setShortCookie or the browser keeps the cookie.
  res.clearCookie(name, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/auth',
  });
}

function consentUrl() {
  return config.frontendConsentUrl || `${config.publicBaseUrl}/consent.html`;
}

function readPending(req) {
  const raw = req.cookies && req.cookies[PENDING_COOKIE];
  if (!raw) return null;
  try {
    const claim = jsonwebtoken.verify(raw, config.jwtSecret, { issuer: 'shambaluv-auth' });
    return claim.sub === 'oauth-pending' ? claim : null;
  } catch (_) {
    return null;
  }
}

// Build a login + callback pair for each enabled provider.
function wireProvider(provider, scope) {
  // Kick off the OAuth dance — with a state nonce bound to this browser.
  router.get(`/${provider}`, (req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    setShortCookie(
      res,
      STATE_COOKIE,
      jsonwebtoken.sign(
        { sub: 'oauth-state', provider, nonce },
        config.jwtSecret,
        { expiresIn: OAUTH_TTL_S, issuer: 'shambaluv-auth' }
      )
    );
    const opts = { session: false, scope, state: nonce };
    // Google honors an account chooser; GitHub has no equivalent — /enter.html is the gate.
    if (provider === 'google') opts.prompt = 'select_account';
    passport.authenticate(provider, opts)(req, res, next);
  });

  // Provider redirects back here. State check FIRST, then the code exchange, then PARK —
  // the session is only minted by POST /auth/enter (the explicit consent click).
  router.get(
    `/${provider}/callback`,
    (req, res, next) => {
      const raw = req.cookies && req.cookies[STATE_COOKIE];
      dropShortCookie(res, STATE_COOKIE); // single-use either way
      let claim = null;
      try {
        claim = raw ? jsonwebtoken.verify(raw, config.jwtSecret, { issuer: 'shambaluv-auth' }) : null;
      } catch (_) {
        claim = null;
      }
      if (
        !claim ||
        claim.sub !== 'oauth-state' ||
        claim.provider !== provider ||
        !req.query.state ||
        claim.nonce !== req.query.state
      ) {
        return res.redirect(config.frontendFailureUrl);
      }
      return next();
    },
    passport.authenticate(provider, {
      session: false,
      failureRedirect: config.frontendFailureUrl,
    }),
    (req, res) => {
      // req.user is the normalized profile from the strategy verify callback.
      const profile = req.user;
      setShortCookie(
        res,
        PENDING_COOKIE,
        jsonwebtoken.sign(
          {
            sub: 'oauth-pending',
            provider: profile.provider,
            providerUserId: profile.providerUserId,
            email: profile.email || null,
          },
          config.jwtSecret,
          { expiresIn: OAUTH_TTL_S, issuer: 'shambaluv-auth' }
        )
      );
      return res.redirect(consentUrl());
    }
  );
}

// What is waiting for consent (drives /enter.html).
router.get('/pending', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pending = readPending(req);
  if (!pending) return res.status(401).json({ error: 'no_pending_entry' });
  res.json({ provider: pending.provider, email: pending.email || null });
});

// The consent click — the ONLY place a social login becomes a session.
router.post('/enter', async (req, res) => {
  const pending = readPending(req);
  dropShortCookie(res, PENDING_COOKIE);
  if (!pending) return res.status(401).json({ error: 'no_pending_entry' });
  try {
    const { identityKey, provider } = await upsertIdentity({
      provider: pending.provider,
      providerUserId: pending.providerUserId,
      email: pending.email || null,
    });

    // First-login (idempotent) provisioning + airdrop — consent-gated.
    await ensureProvisionedAndAirdropped(identityKey);

    // The LUVdrip needs no claim here: upsertIdentity above already armed this login's
    // million (actions/drip.js), and it drips for the whole 24 hours on its own.

    const token = issueToken({ identityKey, provider });
    setSessionCookie(res, token);
    return res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth] enter error:', err.message);
    return res.status(500).json({ error: 'enter_failed' });
  }
});

// Walk away — drop the pending identity without entering.
router.post('/cancel', (req, res) => {
  dropShortCookie(res, PENDING_COOKIE);
  res.json({ ok: true });
});

if (ENABLED.includes('google')) wireProvider('google', ['profile', 'email']);
if (ENABLED.includes('discord')) wireProvider('discord', ['identify', 'email']);
if (ENABLED.includes('github')) wireProvider('github', ['read:user', 'user:email']);

// List which providers are live (handy for the frontend to render buttons).
router.get('/providers', (req, res) => {
  res.json({ providers: ENABLED, wallet: true });
});

// ── MetaMask / wallet sign-in (challenge → personal_sign → verify) ──────────────
// Identity: `metamask:<address>` — a session like any other, BUT the 1T gesture stays
// gated to SOCIAL identities (a wallet is free to mint endlessly; social accounts are the
// Sybil unit — the lesson from the luvdrop audit). Wallet users get the dashboard, balance
// and the tasks rail on their OWN address; no custodial wallet is provisioned.
const jwt = require('jsonwebtoken');
const ethers = require('../ethers');

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

router.post('/wallet/challenge', (req, res) => {
  const { address } = req.body || {};
  if (typeof address !== 'string' || !ADDR_RE.test(address)) {
    return res.status(400).json({ error: 'bad_address' });
  }
  const checksummed = ethers.getAddress(address);
  const nonce = require('crypto').randomBytes(16).toString('hex');
  const message =
    `SHAMBA LUV ❤ sign-in\n\n` +
    `wallet: ${checksummed}\n` +
    `nonce: ${nonce}\n\n` +
    `Signing proves you control this wallet. This request costs nothing.`;
  // Stateless challenge: the message is bound to the address+nonce in a short-lived JWT.
  const challengeToken = jwt.sign(
    { sub: 'wallet-challenge', address: checksummed, nonce },
    config.jwtSecret,
    { expiresIn: 300, issuer: 'shambaluv-auth' }
  );
  res.json({ message, challengeToken });
});

router.post('/wallet/verify', async (req, res) => {
  const { address, signature, challengeToken } = req.body || {};
  if (typeof address !== 'string' || !ADDR_RE.test(address)
    || typeof signature !== 'string' || typeof challengeToken !== 'string') {
    return res.status(400).json({ error: 'invalid_request' });
  }
  let claim;
  try {
    claim = jwt.verify(challengeToken, config.jwtSecret, { issuer: 'shambaluv-auth' });
  } catch (e) {
    return res.status(400).json({ error: 'challenge_expired' });
  }
  const checksummed = ethers.getAddress(address);
  if (claim.sub !== 'wallet-challenge' || claim.address !== checksummed) {
    return res.status(400).json({ error: 'challenge_mismatch' });
  }
  const message =
    `SHAMBA LUV ❤ sign-in\n\n` +
    `wallet: ${claim.address}\n` +
    `nonce: ${claim.nonce}\n\n` +
    `Signing proves you control this wallet. This request costs nothing.`;
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (e) {
    return res.status(400).json({ error: 'bad_signature' });
  }
  if (recovered.toLowerCase() !== checksummed.toLowerCase()) {
    return res.status(401).json({ error: 'signature_mismatch' });
  }
  // Session identity — no custodial wallet, no automatic gesture. The free airdrop is
  // SOCIAL SIGN-IN ONLY (the Sybil gate): a wallet is free to mint in unlimited numbers, so it
  // can't be the "one person, one gesture" unit. MetaMask signs in for the dashboard + earning
  // actions, but does not board the airdrop bus.
  const { identityKey } = await upsertIdentity({
    provider: 'metamask',
    providerUserId: checksummed.toLowerCase(),
  });
  const token = issueToken({ identityKey, provider: 'metamask' });
  setSessionCookie(res, token);
  res.json({ ok: true, walletAddress: checksummed });
});

// Current session identity + wallet. Requires auth.
router.get('/me', requireAuth, async (req, res) => {
  const { identityKey, provider } = req.identity;
  const r = await db.query(
    `SELECT i.email, w.address, w.smart_account, w.custody, w.relinquished_at
       FROM identities i
       LEFT JOIN wallets w ON w.identity_key = i.identity_key
      WHERE i.identity_key = $1`,
    [identityKey]
  );
  const row = r.rows[0] || {};
  // MetaMask identities bring their OWN wallet (identity_key = metamask:<address>) —
  // no custodial row exists; the user-facing wallet is theirs.
  const selfWallet = provider === 'metamask' && !row.address
    ? require('../ethers').getAddress(identityKey.split(':')[1]) : null;
  res.json({
    provider,
    // The user-facing wallet: the ERC-4337 smart account when the AA rail is on, else the EOA.
    walletAddress: row.smart_account || row.address || selfWallet,
    ownerAddress: row.address || selfWallet,
    smartAccount: row.smart_account || null,
    // custody: 'platform' (we hold an encrypted copy of the owner key) · 'participant' (handed off, our copy destroyed) · 'external' (MetaMask)
    custody: provider === 'metamask' ? 'external' : (row.custody || 'platform'),
    relinquishedAt: row.relinquished_at || null,
    // Do not echo the raw identity key publicly beyond what the session already holds.
    email: row.email || null,
  });
});

// Logout — clear the cookie. (Stateless JWT; client should also drop any Bearer token.)
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Export the sovereign wallet's private key (self-custody) ──────────────────────────────────
// Session-gated: only the signed-in identity can export ITS OWN custodial key. MetaMask identities
// bring their own key (nothing to export). The frontend reveals this only on press-and-hold and
// never persists it. This is the "take custody" escape hatch for the wallet we created for you.
router.post('/wallet/export', requireAuth, async (req, res) => {
  const { identityKey, provider } = req.identity;
  if (provider === 'metamask') return res.status(400).json({ error: 'external_wallet' });
  try {
    const { getUserSigner } = require('../wallet/provision');
    const w = await getUserSigner(identityKey);
    res.set('Cache-Control', 'no-store');
    res.json({ address: w.address, privateKey: w.privateKey });
  } catch (e) {
    // eslint-disable-next-line no-console
    if (e && e.code === 'relinquished') return res.status(410).json({ error: 'relinquished' });
    console.error('[auth] wallet export failed:', e.message);
    res.status(500).json({ error: 'export_failed' });
  }
});

// ── Relinquish: the cypherpunk4096 handoff ─────────────────────────────────────────────────────
// The participant has revealed and saved the owner key and now tells us to destroy our encrypted
// copy. Irreversible: enc_* are blanked, custody flips to 'participant'. From here the platform can
// deliver LUV to the address but can never sign for it. Confirmation = the last six characters of
// the owner address, typed by the participant. MetaMask identities have nothing to relinquish.
router.post('/wallet/relinquish', requireAuth, async (req, res) => {
  const { identityKey, provider } = req.identity;
  if (provider === 'metamask') return res.status(400).json({ error: 'external_wallet' });
  const confirm = String((req.body && req.body.confirm) || '').trim().toLowerCase();
  const r = await db.query('SELECT address, custody FROM wallets WHERE identity_key = $1', [identityKey]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'no_wallet' });
  const address = r.rows[0].address;
  if (r.rows[0].custody === 'participant') return res.json({ ok: true, custody: 'participant', address });
  if (confirm !== address.slice(-6).toLowerCase()) return res.status(400).json({ error: 'confirm_mismatch' });
  // SHRED, not delete: the three key columns are overwritten with fresh random bytes PASSES times (the shred(1)
  // discipline, default 7), then blanked, then the table is rewritten with VACUUM FULL so no earlier row version
  // survives in the heap. Honest note on Postgres: each overwrite is a new row version, not an in-place write —
  // it is VACUUM FULL that removes the old versions from the file; the passes make sure that what the rewrite
  // discards is noise, and that the WAL for this row ends in noise, not in the ciphertext.
  const crypto = require('crypto');
  const PASSES = Math.max(1, Math.min(35, Number(process.env.WALLET_SHRED_PASSES) || 7));
  for (let i = 0; i < PASSES; i++) {
    await db.query(
      `UPDATE wallets SET enc_ciphertext = $2, enc_iv = $3, enc_tag = $4 WHERE identity_key = $1 AND custody <> 'participant'`,
      [identityKey, crypto.randomBytes(48).toString('base64'), crypto.randomBytes(12).toString('base64'), crypto.randomBytes(16).toString('base64')]
    );
  }
  await db.query(
    `UPDATE wallets SET enc_ciphertext = '', enc_iv = '', enc_tag = '', custody = 'participant', relinquished_at = now()
      WHERE identity_key = $1 AND custody <> 'participant'`,
    [identityKey]
  );
  let rewritten = false, checkpoint = false;
  try { await db.query('VACUUM FULL wallets'); rewritten = true; } catch (e) { /* not the owner — autovacuum will reclaim */ }
  // cache.shred: force a checkpoint so dirty buffers reach the new heap file and the WAL that carried the old row
  // versions becomes recyclable now rather than at the next timed checkpoint (needs the pg_checkpoint role).
  try { await db.query('CHECKPOINT'); checkpoint = true; } catch (e) { /* no pg_checkpoint grant — the timed checkpoint does it */ }
  // eslint-disable-next-line no-console
  console.log(`[auth] custody shredded to the participant: ${address} (${PASSES} passes, rewritten=${rewritten}, checkpoint=${checkpoint})`);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, custody: 'participant', address, shredded: true, passes: PASSES, rewritten, checkpoint });
});

// ── Send LUV from the custodial wallet (the LUV wallet's Send button) ─────────────────────────
// Custodial (social) wallets only — MetaMask self-custodies and sends from its own wallet client-side.
router.post('/wallet/send', requireAuth, async (req, res) => {
  const { identityKey, provider } = req.identity;
  if (provider === 'metamask') return res.status(400).json({ error: 'external_wallet' });
  const { to, amount } = req.body || {};
  let dest; try { dest = ethers.getAddress(String(to || '').trim()); } catch (e) { return res.status(400).json({ error: 'invalid_to' }); }
  let amtWei; try { amtWei = ethers.parseUnits(String(amount || '').replace(/[_,\s]/g, ''), 18); } catch (e) { return res.status(400).json({ error: 'invalid_amount' }); }
  if (amtWei <= 0n) return res.status(400).json({ error: 'invalid_amount' });
  try {
    const { sendLuv } = require('../wallet/send');
    const hash = await sendLuv(identityKey, dest, amtWei);
    res.json({ ok: true, txHash: hash, to: dest });
  } catch (e) {
    const m = String((e && (e.code || e.shortMessage || e.message)) || e);
    const err = /INSUFFICIENT_LUV/i.test(m) ? 'insufficient_luv'
      : /NO_RELAYER|NO_FACTORY/i.test(m) ? 'sponsor_unavailable' : 'send_failed';
    // eslint-disable-next-line no-console
    if (err === 'send_failed') console.error('[auth] wallet send failed:', m);
    res.status(400).json({ error: err });
  }
});


/*
 * The rainbow is delivered to wallets. GET /auth/rainbow returns the in-house Bitcoin
 * rainbow chart (static SVG) only to a live session — OAuth or MetaMask wallet signature.
 * The gate is a handshake, not a secret: the chart source is open in the repository;
 * gated delivery is the consent rail, same doctrine as the gesture.
 */
const path = require('path');
const RAINBOW_SVG = path.join(__dirname, '..', 'rainbow.svg');
router.get('/rainbow', requireAuth, (_req, res) => {
  res.type('image/svg+xml');
  res.sendFile(RAINBOW_SVG);
});

module.exports = router;
