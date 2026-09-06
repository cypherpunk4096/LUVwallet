/*!
 * luvwallet.js — the client controller. The standard: the key is generated and held on the client's machine, in the
 * client's wallet; the platform only ever verifies a signature. Vendored ethers v6 (substrate/ethers.umd.min.js), no
 * network for key work. Keystore = the wallet's own encrypted JSON (scrypt + AES-128-CTR), stored in THIS browser's
 * localStorage under a passphrase only the client knows; also downloadable, so the wallet travels (MetaMask imports it).
 * shred: the stored keystore is overwritten with random bytes seven times before removal.
 */
"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var E = window.ethers; if (!E) return;
  var KS = "luvwallet.keystore.v1", KA = "luvwallet.address.v1", PASSES = 7;
  var wallet = null, timer = null;
  var st = $("cwstate"), addrEl = $("cwaddr"), msg = $("cwmsg"), box = $("clientwallet");
  if (!box) return;
  function say(t, ok) { if (msg) { msg.textContent = t; msg.className = "taskmsg" + (ok ? " ok" : ""); } }
  function stored() { try { return localStorage.getItem(KS); } catch (e) { return null; } }
  function storedAddr() { try { return localStorage.getItem(KA); } catch (e) { return null; } }
  function rnd(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function paint() {
    var has = !!stored(), a = storedAddr();
    $("cw-create").hidden = has; $("cw-import").hidden = has; $("cw-pass").hidden = has;
    $("cw-unlock").hidden = !has || !!wallet; $("cw-lock").hidden = !wallet; $("cw-bind").hidden = !wallet; $("cw-sign").hidden = !wallet;
    $("cw-export").hidden = !has; $("cw-reveal").hidden = !wallet; $("cw-shred").hidden = !has;
    addrEl.textContent = a || "no wallet on this machine yet";
    st.textContent = has ? (wallet ? "unlocked on this machine · the key never leaves it" : "locked on this machine") : "none on this machine";
    st.className = "state " + (has ? "client" : "");
    document.dispatchEvent(new CustomEvent("luvwallet:state", { detail: { address: a, unlocked: !!wallet } }));
  }
  function passphrase() { var v = ($("cw-pass") && $("cw-pass").value) || ""; if (v.length < 8) { say("choose a passphrase of at least 8 characters — it protects the keystore on this machine"); return null; } return v; }
  async function save(w, pw) {
    say("encrypting the keystore on this machine…");
    var json = await w.encrypt(pw, { scrypt: { N: 1 << 17 } });
    try { localStorage.setItem(KS, json); localStorage.setItem(KA, w.address); } catch (e) { say("this browser refused to store the keystore (private mode?) — download it instead"); }
    wallet = w; paint(); say("wallet created on this machine: " + w.address + ". Download the keystore and keep the passphrase.", true);
  }
  $("cw-create").addEventListener("click", async function () { var pw = passphrase(); if (!pw) return; await save(E.Wallet.createRandom(), pw); });
  $("cw-import").addEventListener("click", async function () {
    var pw = passphrase(); if (!pw) return;
    var raw = prompt("paste a private key (0x…) or a keystore JSON to import into this machine"); if (!raw) return;
    try { var w = raw.trim().startsWith("{") ? await E.Wallet.fromEncryptedJson(raw.trim(), prompt("the keystore's passphrase") || "") : new E.Wallet(raw.trim()); await save(w, pw); }
    catch (e) { say("could not import: " + (e.message || e)); }
  });
  $("cw-unlock").addEventListener("click", async function () {
    var pw = prompt("passphrase for the keystore on this machine"); if (!pw) return;
    try { say("unlocking…"); wallet = await E.Wallet.fromEncryptedJson(stored(), pw); paint(); say("unlocked", true); clearTimeout(timer); timer = setTimeout(function () { wallet = null; paint(); say("locked again after 10 minutes"); }, 600000); }
    catch (e) { say("wrong passphrase"); }
  });
  $("cw-lock").addEventListener("click", function () { wallet = null; clearTimeout(timer); paint(); say("locked"); });
  $("cw-export").addEventListener("click", function () {
    var json = stored(); if (!json) return; var a = storedAddr() || "wallet";
    var blob = new Blob([json], { type: "application/json" }), u = URL.createObjectURL(blob), l = document.createElement("a"); l.href = u; l.download = "LUVwallet-keystore-" + a.slice(0, 10) + ".json"; document.body.appendChild(l); l.click(); document.body.removeChild(l); setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
    say("keystore downloaded — MetaMask imports it with the same passphrase", true);
  });
  $("cw-reveal").addEventListener("click", function () {
    if (!wallet) return; var f = $("cw-key"); f.hidden = false; f.textContent = wallet.privateKey; var left = 30;
    var t = setInterval(function () { left--; if (left <= 0) { clearInterval(t); for (var i = 0; i < PASSES; i++) f.textContent = "0x" + rnd(32); f.textContent = ""; f.hidden = true; } }, 1000);
  });
  $("cw-shred").addEventListener("click", function () {
    if (!confirm("Shred the keystore on this machine? Make sure you downloaded it or hold the key elsewhere. This cannot be undone.")) return;
    try { var len = (stored() || "").length || 512; for (var i = 0; i < PASSES; i++) localStorage.setItem(KS, rnd(Math.ceil(len / 2))); localStorage.removeItem(KS); localStorage.removeItem(KA); } catch (e) {}
    wallet = null; paint(); say("shredded on this machine: " + PASSES + " random overwrites, then removed", true);
  });
  // bind: the platform verifies a signature, never sees the key
  $("cw-bind").addEventListener("click", async function () {
    if (!wallet) return; say("asking the platform for a challenge…");
    try {
      var ch = await fetch("/auth/wallet/challenge", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address }) }).then(function (r) { return r.json(); });
      if (!ch.message) throw new Error(ch.error || "no challenge");
      var sig = await wallet.signMessage(ch.message);
      var r = await fetch("/auth/wallet/bind", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address, signature: sig, challengeToken: ch.challengeToken }) });
      var j = await r.json();
      if (r.ok) { say("bound by signature: the platform now delivers to " + (j.walletAddress || wallet.address) + " and holds no key", true); document.dispatchEvent(new CustomEvent("luvwallet:bound", { detail: j })); setTimeout(function () { location.reload(); }, 1800); }
      else if (j.error === "take_the_key_first") say("take and shred the platform-held key above first, then bind this one");
      else if (j.error === "address_in_use") say("that address is already bound to another sign-in");
      else say("could not bind: " + (j.error || r.status));
    } catch (e) { say("could not bind: " + (e.message || e)); }
  });
  // sign an arbitrary message — proof of control, computed on this machine
  $("cw-sign").addEventListener("click", async function () {
    if (!wallet) return; var m = prompt("message to sign with this wallet"); if (!m) return;
    try { var sig = await wallet.signMessage(m); $("cw-key").hidden = false; $("cw-key").textContent = "signature: " + sig; } catch (e) { say("could not sign"); }
  });
  paint();
})();
