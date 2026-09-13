import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { playerInitial, renderPlayerIdentity } from "../ui/player-presentation.js";

test("player initials use one safe Unicode grapheme", () => {
  for (const [name, initial] of [[" Xavier", "X"], ["Ari Fisher", "A"], ["  ", "P"], ["éclair", "É"], ["e\u0301clair", "E\u0301"], ["🧑🏽‍⚽ Alex", "🧑🏽‍⚽"], ["ßam", "S"]]) {
    assert.equal(playerInitial(name), initial);
  }
});

test("server and browser share escaped identity markup and truthful link states", () => {
  const dom = new JSDOM("<body></body>", { runScripts: "outside-only" });
  try {
    dom.window.eval(readFileSync(resolve(process.cwd(), "dist/ui/player-presentation-browser.js"), "utf8"));
    for (const linkState of ["linked", "unlinked", "unknown"] as const) {
      const input = { name: '<img src=x onerror="bad()">', context: "Winter & spring", linkState };
      const html = renderPlayerIdentity(input);
      assert.equal(dom.window.ThreeFcPlayers.renderPlayerIdentity(input), html);
      dom.window.document.body.innerHTML = html;
      assert.equal(dom.window.document.querySelector("img"), null);
      assert.equal(dom.window.document.querySelector("strong")?.textContent, input.name);
      assert.equal(dom.window.document.querySelectorAll('[data-ui="player-linked-tick"]').length, linkState === "linked" ? 1 : 0);
      assert.equal(dom.window.document.querySelectorAll(".sr-only").length, linkState === "unknown" ? 0 : 1);
      assert.equal(dom.window.document.querySelector('[data-ui="player-initial"]')?.getAttribute("aria-hidden"), "true");
    }
    dom.window.eval("Intl.Segmenter = undefined");
    assert.equal(dom.window.ThreeFcPlayers.playerInitial("😀 Alex"), "😀");
    assert.equal(dom.window.ThreeFcPlayers.playerInitial("  "), "P");
  } finally { dom.window.close(); }
});
