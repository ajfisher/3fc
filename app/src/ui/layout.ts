import {
  renderButton,
  renderDataTable,
  renderInputField,
  renderModalPrompt,
  renderNavigation,
  renderPanel,
  renderPlayerCard,
  renderRowActionList,
  renderStepChip,
  renderValidatedField,
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
  --danger: #a33a2f;
  --danger-soft: #ffe9e5;
  --radius-lg: 18px;
  --radius-sm: 12px;
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
  width: min(72rem, 100%);
  margin: 0 auto;
  padding: 1.1rem 0.9rem 2.4rem;
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
  max-width: 56ch;
}

.section-stack {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
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
  display: grid;
  gap: 0.85rem;
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

.panel h3 {
  margin: 0;
  font-size: 0.95rem;
  font-family: var(--font-display);
}

.panel p {
  margin: 0.35rem 0 0;
  color: var(--ink-soft);
  font-size: 0.92rem;
}

.panel-body {
  display: grid;
  gap: 0.7rem;
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

.field-notice {
  margin: 0;
  font-size: 0.8rem;
}

.field-notice-error {
  color: #9c2f27;
}

.field-notice-success {
  color: #1f6d45;
}

.field-input-invalid {
  border-color: #ca5a50;
  background: #fff7f6;
}

.field-input-success {
  border-color: #4da173;
  background: #f5fff8;
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

.btn-secondary {
  background: #f1f7f4;
  border-color: #b7d2c7;
}

.btn-ghost {
  background: transparent;
  border-color: #b9cbc5;
}

.btn-danger {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff6f5;
}

.top-nav {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #f8fcfa;
  padding: 0.25rem;
}

.top-nav-list {
  display: flex;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-x: auto;
}

.nav-link {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  text-decoration: none;
  color: var(--ink-soft);
  font-weight: 700;
  font-size: 0.86rem;
  padding: 0.45rem 0.8rem;
}

.nav-link-active {
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.player-grid {
  display: grid;
  gap: 0.55rem;
}

.player-card {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  border: 1px solid #cce0d8;
  border-radius: 12px;
  background: #f9fffc;
  padding: 0.5rem 0.6rem;
}

.player-avatar {
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 999px;
  border: 1px solid #8db8a9;
  background: #d9f0e8;
  color: #0b534a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
}

.player-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 999px;
  object-fit: cover;
}

.player-meta h3 {
  margin: 0;
}

.player-meta p {
  margin: 0.2rem 0 0;
  font-size: 0.81rem;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid #cadcd6;
  border-radius: 10px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 28rem;
}

.data-table caption {
  caption-side: top;
  text-align: left;
  padding: 0.6rem;
  font-weight: 700;
}

.data-table th,
.data-table td {
  border-bottom: 1px solid #dbe8e3;
  text-align: left;
  padding: 0.52rem 0.6rem;
  font-size: 0.87rem;
}

.data-table th {
  background: #f1f8f5;
  color: #2a4f49;
}

.row-action-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.5rem;
}

.row-action-item {
  border: 1px solid #cadfd8;
  border-radius: 10px;
  padding: 0.6rem;
  display: grid;
  gap: 0.45rem;
}

.row-action-copy p {
  margin: 0.2rem 0 0;
  font-size: 0.81rem;
}

.row-action-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.list-action {
  border-radius: 999px;
  border: 1px solid #a8c8bc;
  background: #f4faf7;
  font: inherit;
  font-size: 0.81rem;
  font-weight: 700;
  color: #1c4f46;
  padding: 0.3rem 0.65rem;
}

.list-action-danger {
  border-color: #d38d84;
  background: var(--danger-soft);
  color: #8a2d24;
}

.prompt-dialog {
  border: 1px solid #bed5cd;
  border-radius: 12px;
  padding: 1rem;
  width: min(24rem, 92vw);
}

.prompt-dialog::backdrop {
  background: rgba(20, 40, 36, 0.45);
}

.prompt-dialog h3 {
  margin: 0;
}

.prompt-dialog p {
  margin-top: 0.5rem;
}

.prompt-actions {
  margin-top: 0.85rem;
  display: flex;
  justify-content: flex-end;
  gap: 0.45rem;
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

  .player-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>`;
}

function renderModalBehaviorScript(): string {
  return `<script>
(() => {
  const dialogs = Array.from(document.querySelectorAll('dialog[data-modal]'));
  const note = document.getElementById('modal-note');

  function setNote(message) {
    if (note) {
      note.textContent = message;
    }
  }

  document.querySelectorAll('[data-modal-open]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-modal-open');
      const dialog = dialogs.find((entry) => entry.getAttribute('data-modal') === id);
      if (dialog && typeof dialog.showModal === 'function') {
        dialog.showModal();
      }
    });
  });

  document.querySelectorAll('[data-modal-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-modal-close');
      const dialog = dialogs.find((entry) => entry.getAttribute('data-modal') === id);
      if (dialog) {
        dialog.close();
      }
    });
  });

  document.querySelectorAll('[data-modal-confirm]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-modal-confirm');
      const dialog = dialogs.find((entry) => entry.getAttribute('data-modal') === id);
      if (dialog) {
        dialog.close();
      }
      setNote('Confirmed modal action: ' + id);
    });
  });

  dialogs.forEach((dialog) => {
    dialog.addEventListener('cancel', () => {
      const id = dialog.getAttribute('data-modal') || 'unknown';
      setNote('Cancelled modal action: ' + id);
    });
  });
})();
</script>`;
}

function renderSetupFoundationPanels(): string {
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
    `<div class="button-row">${renderButton("Save League", "primary", { "data-testid": "save-league" })}${renderButton("Reset", "ghost", { "data-testid": "reset-league" })}${renderButton("Cancel", "danger", { "data-testid": "cancel-league" })}</div>`,
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

  return `<section class="panel-grid">${leaguePanel}${seasonPanel}${sessionPanel}${gamePanel}</section>`;
}

function renderSetupHero(apiBaseUrl: string): string {
  const steps = [
    renderStepChip({ label: "1. League", state: "active" }),
    renderStepChip({ label: "2. Season", state: "upcoming" }),
    renderStepChip({ label: "3. Session", state: "upcoming" }),
    renderStepChip({ label: "4. Game", state: "upcoming" }),
  ].join("");

  return `<section class="hero">
    <span class="hero-kicker">3FC Setup Foundation</span>
    <h1>Create League to Game in one mobile-first flow.</h1>
    <p class="hero-copy">This shell provides reusable form primitives and layout scaffolding for the M1-07 setup journey. API target: <code>${escapeHtml(apiBaseUrl)}</code></p>
    <ul class="step-list" data-testid="setup-steps">${steps}</ul>
  </section>`;
}

export function renderSetupHomePage(apiBaseUrl: string): string {
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
      ${renderSetupHero(apiBaseUrl)}
      <div class="section-stack">
        ${renderSetupFoundationPanels()}
        <p class="status-note">Foundation only: persistence wiring and validation messaging will be implemented in M1-07.</p>
      </div>
    </main>
  </body>
</html>`;
}

export function renderComponentShowcasePage(apiBaseUrl: string): string {
  const navigationPanel = renderPanel(
    "Navigation items",
    "Top-level route selection with active state styling.",
    renderNavigation(
      [
        { label: "Setup", href: "/setup", active: true },
        { label: "Live Game", href: "/games/live" },
        { label: "Standings", href: "/standings" },
        { label: "Profile", href: "/profile" },
      ],
      "component-nav",
    ),
    "",
    "panel-navigation",
  );

  const playersPanel = renderPanel(
    "Player representation",
    "Avatar + name rows suitable for roster and score events.",
    `<div class="player-grid" data-testid="player-grid">${[
      renderPlayerCard({ name: "Ari Fisher", subtitle: "Red Team" }, "player-ari"),
      renderPlayerCard({ name: "Mina G", subtitle: "Blue Team" }, "player-mina"),
      renderPlayerCard({ name: "Chris Long", subtitle: "Yellow Team" }, "player-chris"),
    ].join("")}</div>`,
    "",
    "panel-player",
  );

  const tablePanel = renderPanel(
    "Information table",
    "Reusable table for standings, results, and summaries.",
    renderDataTable({
      tableId: "standings-table",
      caption: "Season standings",
      columns: ["Team", "P", "W", "D", "L", "GF", "GA"],
      rows: [
        ["Red", 8, 5, 2, 1, 19, 10],
        ["Blue", 8, 4, 3, 1, 17, 11],
        ["Yellow", 8, 2, 1, 5, 11, 18],
      ],
    }),
    "",
    "panel-table",
  );

  const validationPanel = renderPanel(
    "Field validation",
    "Inline notice state for valid/invalid input feedback.",
    [
      renderValidatedField({
        id: "organizer-email-invalid",
        label: "Organizer email",
        type: "email",
        value: "player-at-example.com",
        error: "Please provide a valid email address.",
      }),
      renderValidatedField({
        id: "organizer-email-valid",
        label: "Organizer email",
        type: "email",
        value: "organizer@example.com",
        success: "Email format looks valid.",
      }),
    ].join(""),
    "",
    "panel-validation",
  );

  const rowActionsPanel = renderPanel(
    "Row action list",
    "List rows with add/edit/delete style actions.",
    renderRowActionList(
      [
        {
          title: "Game 01 - Saturday AM",
          subtitle: "Kickoff 10:00, Red vs Blue vs Yellow",
          actions: [
            { label: "Edit", action: "edit-game" },
            { label: "Clone", action: "clone-game" },
            { label: "Delete", action: "delete-game", tone: "danger" },
          ],
        },
        {
          title: "Game 02 - Saturday PM",
          subtitle: "Kickoff 14:30, Red vs Blue vs Yellow",
          actions: [
            { label: "Edit", action: "edit-game-2" },
            { label: "Delete", action: "delete-game-2", tone: "danger" },
          ],
        },
      ],
      "game-row-actions",
    ),
    "",
    "panel-row-actions",
  );

  const modalPanel = renderPanel(
    "Popover modal prompt",
    "Dialog-based confirmation for destructive actions.",
    `${renderModalPrompt({
      id: "confirm-delete-game",
      triggerLabel: "Open delete prompt",
      title: "Delete game?",
      message: "This action removes game timeline and scores for this game.",
      cancelLabel: "Keep game",
      confirmLabel: "Delete game",
    })}<p class="status-note" id="modal-note">No modal action has been confirmed yet.</p>`,
    "",
    "panel-modal",
  );

  const setupFoundationPanel = renderPanel(
    "Setup shell composition",
    "How primitives come together in the M1-07 setup journey.",
    renderSetupFoundationPanels(),
    "",
    "panel-setup-composition",
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Component Showcase</title>
    ${renderStyleBlock()}
  </head>
  <body>
    <main class="app-shell" data-testid="component-showcase">
      ${renderSetupHero(apiBaseUrl)}
      <div class="section-stack">
        ${navigationPanel}
        <section class="panel-grid" data-testid="component-grid">
          ${playersPanel}
          ${tablePanel}
          ${validationPanel}
          ${rowActionsPanel}
          ${modalPanel}
          ${setupFoundationPanel}
        </section>
      </div>
    </main>
    ${renderModalBehaviorScript()}
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
