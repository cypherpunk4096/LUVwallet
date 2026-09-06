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
    if (c === "participant") { st.textContent = "custody: yours — the platform's copy was destroyed" + (me.relinquishedAt ? " on " + new Date(me.relinquishedAt).toISOString().slice(0, 10) : ""); if (box) box.hidden = true; var f = $("pkfield"), b = $("revealpk"); if (f) f.textContent = "the platform no longer holds this key"; if (b) b.hidden = true; }
    else if (c === "external") { if (pk) pk.hidden = true; }
    else { st.textContent = "custody: the platform holds an encrypted copy — reveal, save, then destroy it"; if (box) box.hidden = false; }
  }
  fetch("/auth/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) { if (me) paintCustody(me); }).catch(function () {});

  var btn = $("relinquish"), inp = $("relinquishconfirm"), msg = $("relinquishmsg");
  if (btn) btn.addEventListener("click", function () {
    var v = (inp && inp.value || "").trim();
    if (v.length !== 6) { msg.textContent = "type the last six characters of your address"; return; }
    btn.disabled = true; msg.textContent = "destroying the platform's copy…";
    fetch("/auth/wallet/relinquish", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: v }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (x.ok) { msg.textContent = "done. The key exists only where you saved it."; paintCustody({ custody: "participant", relinquishedAt: Date.now() }); } else { msg.textContent = x.j && x.j.error === "confirm_mismatch" ? "those six characters do not match your address" : "could not complete: " + (x.j && x.j.error || "error"); btn.disabled = false; } })
      .catch(function () { msg.textContent = "network error"; btn.disabled = false; });
  });
})();
