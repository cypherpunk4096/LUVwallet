'use strict';

/*
 * signer-vault.js — unlock the LUVdrop voucher signer from its bankon-vault at runtime.
 *
 * The dedicated signer's private key lives ONLY inside secrets/luvdrop-signer.vault.json,
 * AES-256-GCM sealed (engine/bankon-vault.js). At boot we open it with the passphrase and hold
 * the resulting Wallet in memory — the key is never on disk in plaintext and never logged.
 *
 * Precedence:
 *   1. LUV_SIGNER_VAULT_FILE (+ LUV_SIGNER_VAULT_PASSPHRASE or …_FILE)  → the vault (production)
 *   2. VOUCHER_SIGNER_PRIVATE_KEY                                        → raw key (dev/fallback)
 *
 * Security note (honest): a signer that must sign on every request is necessarily in memory while
 * the service runs — the vault protects the key AT REST, not against a live-process compromise. The
 * real containment is that this key holds no funds and sends no transactions, and the offline owner
 * (bankon.eth) can setSigner()/setPaused() to revoke it instantly. See scripts/create-luvdrop-signer.mjs.
 */

const fs = require('fs');
const path = require('path');
const ethers = require('./ethers');
const { config } = require('./config');

let _wallet = null;

function readPassphrase() {
  if (config.signerVaultPassphrase) return config.signerVaultPassphrase;
  if (config.signerVaultPassphraseFile) {
    return fs.readFileSync(config.signerVaultPassphraseFile, 'utf8').trim();
  }
  return '';
}

async function loadFromVault() {
  const DVBankonVault = require(path.resolve(__dirname, '..', '..', '..', 'engine', 'bankon-vault.js'));
  const doc = JSON.parse(fs.readFileSync(config.signerVaultFile, 'utf8'));
  const pass = readPassphrase();
  if (!pass) {
    throw new Error('LUV_SIGNER_VAULT_PASSPHRASE (or LUV_SIGNER_VAULT_PASSPHRASE_FILE) is required to unlock the signer vault');
  }
  // fromPassphrase re-derives the master key and verifies the vault's integrity check; a wrong
  // passphrase throws "wrong key — vault did not unlock" (never a silent bad signer).
  const vault = await DVBankonVault.fromPassphrase(pass, { doc });
  const pk = await vault.get(config.signerVaultEntry || 'luvdrop-signer');
  return new ethers.Wallet(pk);
}

/**
 * The EIP-712 voucher signer Wallet. Loaded once and cached. MUST equal ShambaLuvAirdrop.signer.
 * @returns {Promise<import('ethers').Wallet>}
 */
async function getVoucherSigner() {
  if (_wallet) return _wallet;
  if (config.signerVaultFile) {
    _wallet = await loadFromVault();
  } else if (config.voucherSignerPrivateKey) {
    _wallet = new ethers.Wallet(config.voucherSignerPrivateKey);
  } else {
    throw new Error('no voucher signer configured — set LUV_SIGNER_VAULT_FILE (preferred) or VOUCHER_SIGNER_PRIVATE_KEY');
  }
  return _wallet;
}

/** Public address of the configured signer (for a boot-time sanity log vs the on-chain signer). */
async function getSignerAddress() {
  return (await getVoucherSigner()).address;
}

module.exports = { getVoucherSigner, getSignerAddress };
