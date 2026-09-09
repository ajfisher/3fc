import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { transformSync } from "esbuild";

import { renderInvitePage, renderJoinPage, renderGamePage, renderSetupHomePage } from "../ui/layout.js";

const styles = readFileSync(resolve("src/ui/styles.css"), "utf8");
// JSDOM cannot parse native CSS nesting. Downlevel CSS syntax for its CSSOM;
// Chromium acceptance separately tests the untouched production stylesheet.
const computedStyles = transformSync(styles, { loader: "css", target: "chrome90" }).code;

test("shared hidden rule wins over component display rules in actual computed styles", () => {
  const layouts = [
    renderJoinPage("http://localhost:3001", "ABCDEFGH"),
    renderInvitePage("http://localhost:3001", ""),
    renderInvitePage("http://localhost:3001", "ABCDEFGH"),
    renderGamePage("http://localhost:3001", { gameId: "fixture-game" }),
    renderSetupHomePage("http://localhost:3001"),
  ];
  for (const html of layouts) {
    const errors: Error[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => errors.push(error));
    const dom = new JSDOM(html, { virtualConsole });
    try {
      const { document } = dom.window;
      const sheet = document.createElement("style");
      sheet.textContent = computedStyles;
      document.head.append(sheet);
      const hidden = [...document.querySelectorAll<HTMLElement>("[hidden]")];
      assert(hidden.length > 0);
      for (const element of hidden) {
        assert.equal(dom.window.getComputedStyle(element).display, "none", element.id || element.outerHTML.slice(0,120));
      }
      for (const component of ["auth-form", "claim-panel", "id-preview"]) {
        const element = document.createElement("div");
        element.dataset.ui = component;
        element.hidden = true;
        document.body.append(element);
        assert.equal(dom.window.getComputedStyle(element).display, "none", `${component} hidden`);
        element.hidden = false;
        assert.notEqual(dom.window.getComputedStyle(element).display, "none", `${component} revealed`);
      }
      assert.deepEqual(errors, [], "CSS parse failures must not turn visibility assertions into false passes");
    } finally {
      dom.window.close();
    }
  }
});

// The mutation control lives in real Chromium: JSDOM's user-agent hidden rule
// differs from browsers, so it cannot prove the original display override.

test("foundation uses local fonts, system themes and no decorative gradients", () => {
  assert.match(styles, /prefers-color-scheme:\s*dark/);
  assert.match(styles, /system-ui|-apple-system/);
  assert.doesNotMatch(styles, /@import|radial-gradient|linear-gradient/);
  assert.match(styles, /conic-gradient/, "the functional thirds indicator remains");
});
