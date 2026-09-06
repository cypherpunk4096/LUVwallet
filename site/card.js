// card.js — one wallet's LUV as a card, read live from Ethereum by the browser. Zero dependencies beyond the vendored QR encoder.
"use strict";
(function () {
  var RPC = "https://ethereum-rpc.publicnode.com", LUV = "0x2711111111683B8708cb9a48cBf36a51315F8254", PAIR = "0x57D2085Aa859a145cB107845AD03c0eAAFBD8a31", V3 = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
  var $ = function (id) { return document.getElementById(id); };
  function words(hex) { var h = hex.replace(/^0x/, ""), o = []; for (var i = 0; i + 64 <= h.length; i += 64) o.push(BigInt("0x" + h.slice(i, i + 64))); return o; }
  function grp(n, d) { var s = Number(n).toFixed(d), p = s.split("."); return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (p[1] ? "." + p[1] : ""); }
  function isAddr(s) { return /^0x[0-9a-fA-F]{40}$/.test(s || ""); }
  function render(addr) {
    var bal = "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0");
    var calls = [["eth_call", [{ to: LUV, data: bal }, "latest"]], ["eth_call", [{ to: PAIR, data: "0x0902f1ac" }, "latest"]], ["eth_call", [{ to: V3, data: "0x3850c7bd" }, "latest"]], ["eth_blockNumber", []], ["eth_getCode", [addr, "latest"]]];
    fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls.map(function (c, i) { return { jsonrpc: "2.0", id: i + 1, method: c[0], params: c[1] }; })) })
      .then(function (r) { return r.json(); }).then(function (rs) {
        rs.sort(function (a, b) { return a.id - b.id; });
        var luv = Number(words(rs[0].result)[0]) / 1e18, rv = words(rs[1].result), nat = Number(rv[1]) / Number(rv[0]);
        var sq = Number(BigInt("0x" + rs[2].result.slice(2, 66))) / Math.pow(2, 96), eth = 1e12 / (sq * sq), usd = luv * nat * eth, code = rs[4].result;
        $("cbal").textContent = grp(luv, 0); $("cusd").textContent = "≈ $" + grp(usd, 2) + " at the pair's mid price"; $("caddr").textContent = addr;
        $("ckind").textContent = (code && code !== "0x" ? (code.slice(0, 8).toLowerCase() === "0xef0100" ? "wallet (EIP-7702 delegated)" : "smart account") : "wallet") + " on Ethereum, read live from the chain";
        $("cblock").textContent = "block " + parseInt(rs[3].result, 16).toLocaleString();
        $("cscan").href = "https://etherscan.io/address/" + addr;
        try { var q = window.qrcode(0, "M"); q.addData("ethereum:" + addr); q.make(); $("cqr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (e) {}
        var url = "https://luv.pythai.net/card.html?a=" + addr, text = "my LUV card ❤ " + grp(luv, 0) + " LUV on Ethereum — 1 LUV == 1 LUV, sharing is caring @shambaluv #SHAMBALUV ";
        $("sharex").href = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text + url);
        $("sharetg").href = "https://t.me/share/url?url=" + encodeURIComponent(url) + "&text=" + encodeURIComponent(text);
        $("sharecopy").dataset.copy = url;
        $("luvcard").hidden = false; $("share").hidden = false; $("empty").hidden = true;
        document.title = grp(luv, 0) + " LUV — a LUV card — SHAMBA LUV";
      }).catch(function () { $("ckind").textContent = "could not read the chain right now"; $("luvcard").hidden = false; });
  }
  var a = new URLSearchParams(location.search).get("a");
  if (isAddr(a)) render(a);
  var inp = $("addrin"); if (inp) inp.addEventListener("change", function () { var v = inp.value.trim(); if (isAddr(v)) { history.replaceState(null, "", "card.html?a=" + v); render(v); } });
})();
