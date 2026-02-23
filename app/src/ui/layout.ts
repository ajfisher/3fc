import {
  renderButton,
  renderInputField,
  renderPanel,
  renderStepChip,
} from "./primitives.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderStyleBlock(): string {
  return `<style>
:root {
  color-scheme: light;
  --font-display: "Avenir Next", "Trebuchet MS", "Gill Sans", "Segoe UI", sans-serif;
  --font-body: "Trebuchet MS", "Verdana", "Segoe UI", sans-serif;
  --bg-top: #f2efe7;
  --bg-bottom: #dce7ef;
  --ink-strong: #1d2a2f;
  --ink-soft: #445a61;
  --surface: #fbfaf7;
  --surface-elevated: #ffffff;
  --line: #cfddd7;
  --accent: #106c61;
  --accent-strong: #0c4e46;
  --accent-soft: #dbf3ef;
  --radius-lg: 18px;
  --radius-sm: 10px;
  --shadow: 0 18px 40px rgba(9, 44, 39, 0.12);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  font-family: var(--font-body);
  color: var(--ink-strong);
  background:
    radial-gradient(140% 120% at 0% 0%, rgba(16, 108, 97, 0.12), transparent 60%),
    linear-gradient(160deg, var(--bg-top), var(--bg-bottom));
}

.app-shell {
  width: min(64rem, 100%);
  margin: 0 auto;
  padding: 1.1rem 0.9rem 2.2rem;
}

.hero {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: linear-gradient(145deg, var(--surface), var(--surface-elevated));
  box-shadow: var(--shadow);
  padding: 1.1rem;
}

.hero-kicker {
  display: inline-block;
  border-radius: 999px;
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 700;
  font-size: 0.74rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 0.24rem 0.6rem;
}

h1 {
  font-family: var(--font-display);
  line-height: 1.1;
  margin: 0.65rem 0 0.5rem;
  font-size: clamp(1.6rem, 6vw, 2.5rem);
}

.hero-copy {
  margin: 0;
  color: var(--ink-soft);
  max-width: 48ch;
}

.step-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  margin: 1rem 0 0;
  padding: 0;
  list-style: none;
}

.step-chip {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0.45rem 0.7rem;
  font-weight: 650;
  font-size: 0.86rem;
}

.step-chip-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.step-chip-done {
  border-color: #8db8a9;
  background: #ebf8f4;
}

.step-chip-upcoming {
  color: var(--ink-soft);
  background: #f4f8f6;
}

.panel-grid {
  margin-top: 1rem;
  display: grid;
  gap: 0.8rem;
}

.panel {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-elevated);
  padding: 0.85rem;
}

.panel h2 {
  margin: 0;
  font-size: 1.04rem;
  font-family: var(--font-display);
}

.panel p {
  margin: 0.4rem 0 0;
  color: var(--ink-soft);
  font-size: 0.93rem;
}

.panel-body {
  display: grid;
  gap: 0.68rem;
  margin-top: 0.9rem;
}

.panel-footer {
  margin-top: 0.9rem;
}

.field {
  display: grid;
  gap: 0.35rem;
}

.field-label {
  font-weight: 680;
  font-size: 0.89rem;
}

.field-input {
  width: 100%;
  border: 1px solid #b5ccc2;
  border-radius: 12px;
  padding: 0.65rem 0.72rem;
  font: inherit;
  background: #fdfefe;
  color: var(--ink-strong);
}

.field-input:focus {
  border-color: var(--accent);
  outline: 2px solid #5eb6aa45;
  outline-offset: 1px;
}

.field-hint {
  margin: 0;
  font-size: 0.8rem;
  color: #5d7571;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
}

.btn {
  border-radius: 999px;
  font: inherit;
  font-weight: 700;
  padding: 0.58rem 0.95rem;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ink-strong);
}

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #f6fdfb;
}

.btn-primary:hover {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}

.btn-secondary {
  background: #f1f7f4;
  border-color: #b7d2c7;
}

.btn-ghost {
  background: transparent;
  border-color: #b9cbc5;
}

.status-note {
  margin-top: 0.9rem;
  font-size: 0.84rem;
  color: #5a6f6b;
}

code {
  font-family: "SF Mono", "Menlo", "Monaco", monospace;
  background: #e8f0ec;
  border-radius: 6px;
  padding: 0.08rem 0.3rem;
}

@media (min-width: 768px) {
  .app-shell {
    padding: 1.8rem 1.4rem 2.6rem;
  }

  .hero {
    padding: 1.35rem;
  }

  .step-list {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .panel-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.95rem;
  }
}
</style>`;
}

export function renderSetupHomePage(apiBaseUrl: string): string {
  const steps = [
    renderStepChip({ label: "1. League", state: "active" }),
    renderStepChip({ label: "2. Season", state: "upcoming" }),
    renderStepChip({ label: "3. Session", state: "upcoming" }),
    renderStepChip({ label: "4. Game", state: "upcoming" }),
  ].join("");

  const leaguePanel = renderPanel(
    "League setup",
    "Start with league identity and visibility defaults.",
    [
      renderInputField({
        id: "league-name",
        label: "League name",
        placeholder: "Three Sided Football Club",
        required: true,
      }),
      renderInputField({
        id: "league-slug",
        label: "League slug",
        placeholder: "three-sided-fc",
        hint: "Used for readable public URLs.",
      }),
    ].join(""),
    `<div class="button-row">${renderButton("Save League", "primary", { "data-testid": "save-league" })}${renderButton("Reset", "ghost", { "data-testid": "reset-league" })}</div>`,
    "panel-league",
  );

  const seasonPanel = renderPanel(
    "Season setup",
    "Define season window and progression context.",
    [
      renderInputField({
        id: "season-name",
        label: "Season name",
        placeholder: "2026 Season",
        required: true,
      }),
      renderInputField({
        id: "season-start",
        label: "Starts on",
        type: "date",
      }),
      renderInputField({
        id: "season-end",
        label: "Ends on",
        type: "date",
      }),
    ].join(""),
    `<div class="button-row">${renderButton("Save Season", "secondary", { "data-testid": "save-season" })}</div>`,
    "panel-season",
  );

  const sessionPanel = renderPanel(
    "Session setup",
    "Configure the day block where games are played.",
    [
      renderInputField({
        id: "session-name",
        label: "Session label",
        placeholder: "Saturday Morning",
        required: true,
      }),
      renderInputField({
        id: "session-date",
        label: "Session date",
        type: "date",
        required: true,
      }),
    ].join(""),
    "",
    "panel-session",
  );

  const gamePanel = renderPanel(
    "Game setup",
    "Pick kickoff and prepare scorekeeper-ready context.",
    [
      renderInputField({
        id: "game-id",
        label: "Game ID",
        placeholder: "gm_2026_02_24_01",
        required: true,
      }),
      renderInputField({
        id: "game-kickoff",
        label: "Kickoff time",
        type: "datetime-local",
        required: true,
      }),
    ].join(""),
    `<div class="button-row">${renderButton("Create Game", "primary", { "data-testid": "create-game" })}${renderButton("Preview", "secondary", { "data-testid": "preview-game" })}</div>`,
    "panel-game",
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Setup Shell</title>
    ${renderStyleBlock()}
  </head>
  <body>
    <main class="app-shell" data-testid="setup-shell">
      <section class="hero">
        <span class="hero-kicker">3FC Setup Foundation</span>
        <h1>Create League to Game in one mobile-first flow.</h1>
        <p class="hero-copy">This shell provides reusable form primitives and layout scaffolding for the M1-07 setup journey. API target: <code>${escapeHtml(apiBaseUrl)}</code></p>
        <ul class="step-list" data-testid="setup-steps">${steps}</ul>
      </section>
      <section class="panel-grid">
        ${leaguePanel}
        ${seasonPanel}
        ${sessionPanel}
        ${gamePanel}
      </section>
      <p class="status-note">Foundation only: persistence wiring and validation messaging will be implemented in M1-07.</p>
    </main>
  </body>
</html>`;
}

export function renderStatusPage(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    ${renderStyleBlock()}
  </head>
  <body>
    <main class="app-shell">
      <section class="hero">
        <span class="hero-kicker">3FC Auth</span>
        <h1>${safeTitle}</h1>
        <p class="hero-copy">${safeMessage}</p>
      </section>
    </main>
  </body>
</html>`;
}
