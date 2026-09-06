'use strict';

/*
 * send.js — send LUV FROM a custodial wallet (the social-login wallet).
 *
 * The claimed LUV lives in the user's ERC-4337 LuvAccount (a counterfactual smart account owned by
 * their encrypted EOA key). LuvAccount.execute is onlyEntryPointOrOwner, so we move funds by having
 * the OWNER EOA call execute() directly (no bundler needed). The relayer (gas tank) fronts the gas:
 * it deploys the account on first use and tops the owner EOA up enough to send the execute tx.
 *
 * MetaMask / external wallets are NOT handled here — they self-custody and send from their own wallet.
 */

const ethers = require('../ethers');
const { config } = require('../config');
const db = require('../db');
const { getUserSigner } = require('./provision');

const FACTORY_ABI = ['function createAccount(address owner, uint256 salt) returns (address)'];
const ACCOUNT_ABI = ['function execute(address target, uint256 value, bytes data) external'];
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

function provider() { return new ethers.JsonRpcProvider(config.rpcUrl, config.chainId); }
function relayer(p) { return config.relayerPrivateKey ? new ethers.Wallet(config.relayerPrivateKey, p) : null; }

// Make sure `who` has enough native ETH for a tx of ~gasUnits; the relayer tops it up if not.
async function ensureGas(p, r, who, gasUnits) {
  const fee = await p.getFeeData();
  const gp = fee.maxFeePerGas || fee.gasPrice || 0n;
  const need = gp * gasUnits * 2n; // 2x buffer
  const bal = await p.getBalance(who);
  if (bal >= need) return;
  if (!r) { const e = new Error('no_relayer'); e.code = 'NO_RELAYER'; throw e; }
  await (await r.sendTransaction({ to: who, value: need - bal })).wait();
}

/**
 * Send `amountWei` LUV from the identity's custodial wallet to `to`. Returns the tx hash of the
 * transfer. Throws with .code on: INSUFFICIENT_LUV, NO_RELAYER, or a revert.
 */
async function sendLuv(identityKey, to, amountWei) {
  const p = provider();
  const r = relayer(p);
  const owner = await getUserSigner(identityKey, p); // owner EOA (decrypted), connected to provider

  const w = await db.query('SELECT smart_account, address FROM wallets WHERE identity_key=$1', [identityKey]);
  const row = w.rows[0] || {};
  const smart = row.smart_account || null;
  const source = smart || row.address; // where the LUV actually is
  if (!source) { const e = new Error('no_wallet'); e.code = 'NO_WALLET'; throw e; }

  const luvRead = new ethers.Contract(config.luvTokenAddress, ERC20_ABI, p);
  const bal = await luvRead.balanceOf(source);
  if (bal < amountWei) { const e = new Error('insufficient_luv'); e.code = 'INSUFFICIENT_LUV'; throw e; }

  const transferData = new ethers.Interface(ERC20_ABI).encodeFunctionData('transfer', [to, amountWei]);

  // Case A — LUV sits in the OWNER EOA (no AA rail): a plain transfer, owner pays (relayer funds gas).
  if (!smart || source.toLowerCase() === (row.address || '').toLowerCase()) {
    await ensureGas(p, r, owner.address, 80000n);
    const luv = new ethers.Contract(config.luvTokenAddress, ERC20_ABI, owner);
    return (await luv.transfer(to, amountWei)).hash;
  }

  // Case B — LUV sits in the SMART ACCOUNT: deploy it on first use, then owner.execute(transfer).
  if ((await p.getCode(smart)) === '0x') {
    if (!r) { const e = new Error('no_relayer'); e.code = 'NO_RELAYER'; throw e; }
    if (!config.aaFactoryAddress) { const e = new Error('no_factory'); e.code = 'NO_FACTORY'; throw e; }
    const factory = new ethers.Contract(config.aaFactoryAddress, FACTORY_ABI, r);
    await (await factory.createAccount(owner.address, config.aaSalt)).wait();
  }
  const acct = new ethers.Contract(smart, ACCOUNT_ABI, owner);
  await ensureGas(p, r, owner.address, 120000n);
  return (await acct.execute(config.luvTokenAddress, 0, transferData)).hash;
}

module.exports = { sendLuv };
