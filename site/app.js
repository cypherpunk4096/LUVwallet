// app.js — the LUVwallet card extras on top of luv.app.js: the QR, the card link, the custody handoff.
"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var lastAddr = null;
  function isAddr(s) { return /^0x[0-9a-fA-F]{40}$/.test(s || ""); }
  function drawQr(addr) {
    var box = $("walletqr"); if (!box || !window.qrcode) return;
    try { var q = window.qrcode(0, "M"); q.addData("ethereum:" + addr); q.make(); box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); var svg = box.querySelector("svg"); if (svg) { svg.setAttribute("width", "144"); svg.setAttribute("height", "144"); } } catch (e) {}
  }
  function onAddress(addr) {
    if (!isAddr(addr) || addr === lastAddr) return; lastAddr = addr;
    drawQr(addr);
    var c = $("cardlink"); if (c) c.href = "card.html?a=" + addr;
  }
  var yw = $("youwallet");
  if (yw) { new MutationObserver(function () { onAddress(yw.textContent.trim()); }).observe(yw, { childList: true, characterData: true, subtree: true }); onAddress(yw.textContent.trim()); }

  // custody state from /auth/me (custody: platform | participant | external)
  function paintCustody(me) {
    var st = $("custodystate"), box = $("relinquishbox"), pk = $("pkrow"); if (!st) return;
    var c = me.custody || (me.provider === "metamask" ? "external" : "platform");
    st.className = "state " + c;
    if (c === "participant") { st.textContent = "custody: yours — the platform's copy was shredded" + (me.relinquishedAt ? " on " + new Date(me.relinquishedAt).toISOString().slice(0, 10) : ""); if (box) box.hidden = true; var f = $("pkfield"), b = $("revealpk"); if (f) f.textContent = "the platform no longer holds this key"; if (b) b.hidden = true; }
    else if (c === "external") { if (pk) pk.hidden = true; }
    else { st.textContent = "custody: the platform holds an encrypted copy — reveal, save, then shred it"; if (box) box.hidden = false; }
  }
  fetch("/auth/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) { if (me) paintCustody(me); }).catch(function () {});

  // take the key: shown for 60 s on request, copyable, downloadable; the page keeps it only in a local variable
  // that is cleared on timeout, blur, or tab hide — never in storage, never in the DOM after masking.
  var PASSES = 7;
  (function takeTheKey() {
    var show = $("pkshow"), copy = $("pkcopy"), dl = $("pkdownload"), clock = $("pkclock"), field = $("pkfield"), hold = $("revealpk");
    if (!show || !field) return;
    var key = null, addr = null, timer = null, left = 0, blobUrl = null;
    function rnd(n) { var a = new Uint8Array(n); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; }); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
    function shredCache() { for (var i = 0; i < PASSES; i++) field.textContent = "0x" + rnd(32); if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; } }
    function mask() { key = null; clearInterval(timer); timer = null; shredCache(); field.textContent = "•••• hidden — press & hold to peek ••••"; field.classList.remove("shown"); copy.hidden = true; dl.hidden = true; clock.hidden = true; show.disabled = false; }
    function tick() { left--; clock.textContent = left + "s"; if (left <= 0) mask(); }
    show.addEventListener("click", function () {
      show.disabled = true; field.textContent = "unlocking…";
      fetch("/auth/wallet/export", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then(function (r) { if (!r.ok) throw new Error(r.status === 410 ? "the platform no longer holds this key" : "could not unlock"); return r.json(); })
        .then(function (j) { key = j.privateKey; addr = j.address; field.textContent = key; field.classList.add("shown"); copy.hidden = false; dl.hidden = false; clock.hidden = false; left = 60; clock.textContent = "60s"; timer = setInterval(tick, 1000); })
        .catch(function (e) { field.textContent = e.message; show.disabled = false; });
    });
    copy.addEventListener("click", function () { if (!key) return; var done = function () { copy.textContent = "copied"; setTimeout(function () { copy.textContent = "copy key"; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(key).then(done).catch(function () { field.focus(); }); });
    dl.addEventListener("click", function () { if (!key) return;
      var text = "SHAMBA LUV — your LUVwallet owner key. Anyone with this key controls the wallet. Keep it private.\n\nowner address: " + addr + "\nprivate key:   " + key + "\nnetwork:       Ethereum mainnet\nimport:        MetaMask → Import account → private key\n";
      var blob = new Blob([text], { type: "text/plain" }), u = URL.createObjectURL(blob), l = document.createElement("a"); blobUrl = u; l.href = u; l.download = "LUVwallet-" + addr.slice(0, 10) + ".txt"; document.body.appendChild(l); l.click(); document.body.removeChild(l); });
    window.addEventListener("blur", function () { if (key) mask(); });
    document.addEventListener("visibilitychange", function () { if (document.hidden && key) mask(); });
    if (hold) hold.addEventListener("pointerdown", function () { if (key) mask(); });
  })();

  var btn = $("relinquish"), inp = $("relinquishconfirm"), msg = $("relinquishmsg");
  if (btn) btn.addEventListener("click", function () {
    var v = (inp && inp.value || "").trim();
    if (v.length !== 6) { msg.textContent = "type the last six characters of your address"; return; }
    btn.disabled = true; msg.textContent = "shredding the platform's copy…";
    fetch("/auth/wallet/relinquish", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: v }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (x.ok) { msg.textContent = "shredded: " + (x.j.passes || 7) + " random overwrites, blanked, table " + (x.j.rewritten ? "rewritten" : "queued for rewrite") + (x.j.checkpoint ? ", checkpoint written" : "") + " · cache.shred on this page: " + PASSES + " overwrites. The key exists only where you saved it."; paintCustody({ custody: "participant", relinquishedAt: Date.now() }); } else { msg.textContent = x.j && x.j.error === "confirm_mismatch" ? "those six characters do not match your address" : "could not complete: " + (x.j && x.j.error || "error"); btn.disabled = false; } })
      .catch(function () { msg.textContent = "network error"; btn.disabled = false; });
  });
})();
