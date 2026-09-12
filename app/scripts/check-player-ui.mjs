import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { renderPlayerIdentity } from "../dist/ui/player-presentation.js";
import { renderGamePage } from "../dist/ui/layout.js";

const output = process.env.PLAYER_UI_EVIDENCE;
if (output) mkdirSync(output, { recursive: true });
const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
const icons = readFileSync(new URL("../dist/ui/icons.css", import.meta.url), "utf8");
const iconButton = (icon, label) => `<button data-ui="icon-button" aria-label="${label}"><span data-ui="icon" data-icon="${icon}" aria-hidden="true"></span></button>`;
const row = (name, context, actions, linkState = "linked") => `<div data-ui="player-row">${renderPlayerIdentity({ name, context, linkState })}${actions}</div>`;
const actions = `<div data-ui="player-actions">${iconButton("ellipsis-vertical", "Player actions")}${iconButton("arrow-left-right", "Transfer player")}</div>`;
const name = "Alexandra van der Westhuizen-Smith";
const pickerForm = renderGamePage("http://localhost:3001", { gameId: "fixture" }).match(/<form id="game-player-picker-form"[\s\S]*?<\/form>/)?.[0];
assert(pickerForm, "Use the production picker markup for spacing checks");
const markup = `<main data-ui="app-shell"><section data-ui="panel"><h1>Player layout fixtures</h1>
  <ul data-ui="directory-list"><li>${row(name, "Winter 2026 · Spring 2026", actions)}</li><li>${row("Xavier", "Winter 2026", actions, "unlinked")}</li></ul>
  <article data-ui="roster-player">${row(name, "", actions)}<div data-ui="row-action-buttons"><button data-ui="button">Red</button><button data-ui="button">Blue</button><button data-ui="button">Yellow</button></div></article>
  <article data-ui="roster-team"><ul><li data-ui="roster-member">${row(name, "", actions)}<div data-ui="transfer-menu"><button data-ui="button">Blue</button><button data-ui="button">Yellow</button></div></li></ul></article>
  <ul data-ui="directory-list"><li>${row(name, "Winter 2026", '<button data-ui="button" disabled>Already in game</button>', "unknown")}</li></ul>
  <div data-ui="consolidation-editor"><table data-ui="consolidation-selection-table"><thead><tr><th>Select</th><th>Player</th><th>Games</th></tr></thead><tbody><tr><td><label><input type="checkbox" aria-label="Select fixture player" /></label></td><td>${renderPlayerIdentity({ name, linkState: "unlinked" })}</td><td>13 September 2026, 9:30 am</td></tr></tbody></table></div>
  <h2>Add player</h2>${pickerForm}
</section></main>`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 390, 430, 768, 1280]) for (const colorScheme of ["light", "dark"]) for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    try {
      await page.route("**/*", route => route.abort());
      await page.setContent(`<style>${css}\n${icons}\nhtml{font-size:${16 * scale}px}</style>${markup}`);
      const metrics = await page.evaluate(() => {
        const box = element => element.getBoundingClientRect();
        const centre = element => { const r = box(element); return r.y + r.height / 2; };
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          offenders: [...document.querySelectorAll("body *")].filter(element => box(element).right > innerWidth + 1).map(element => [element.tagName, element.getAttribute("data-ui"), box(element).width]),
          rows: [...document.querySelectorAll('[data-ui="player-row"]')].map(row => {
            const avatar = row.querySelector('[data-ui="player-initial"]'), name = row.querySelector("strong");
            const action = row.querySelector('[data-ui="player-actions"]') ?? row.querySelector("button");
            return { avatar: centre(avatar), name: centre(name), action: centre(action), nameWidth: box(name).width,
              actionRow: getComputedStyle(action).gridRowStart };
          }),
          targets: [...document.querySelectorAll("button")].map(button => ({ width: box(button).width, height: box(button).height })),
          tableNameWidth: box(document.querySelector("td strong")).width,
          fieldGaps: [...document.querySelectorAll('#game-player-picker-form > [data-ui="field"]')].map(field => {
            const next = field.nextElementSibling; return next ? box(next).top - box(field).bottom : 0;
          }),
        };
      });
      const context = `${width}px ${colorScheme} text-${scale}x`;
      assert.equal(metrics.overflow, false, `${context}: page overflow ${JSON.stringify(metrics)}`);
      for (const row of metrics.rows) {
        assert(Math.abs(row.avatar - row.name) < 1 && (row.actionRow === "3" ? row.action > row.name : Math.abs(row.action - row.name) < 1), `${context}: uncentred row ${JSON.stringify(row)}`);
        assert(row.nameWidth >= 48, `${context}: fragmented name column ${JSON.stringify(metrics)}`);
      }
      for (const target of metrics.targets) assert(target.width >= 44 && target.height >= 44, `${context}: small target`);
      assert(metrics.tableNameWidth >= 48, `${context}: combine identity too narrow`);
      assert(metrics.fieldGaps.every(gap => gap >= 12), `${context}: picker fields/actions touch`);
      if (output && width === 390 && scale === 1) await page.screenshot({ path: resolve(output, `players-${width}-${colorScheme}.png`), fullPage: true });
      console.log(`PASS ${context}`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
