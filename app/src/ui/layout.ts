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

function renderStylesheetLink(): string {
  return '<link rel="stylesheet" href="/ui/styles.css" />';
}

function renderModalScriptTag(): string {
  return '<script src="/ui/modal.js" defer></script>';
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
    ${renderStylesheetLink()}
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
    `<div class="validation-stack">
      <section class="validation-card validation-card-invalid" data-testid="validation-invalid">
        <h3>Invalid email example</h3>
        ${renderValidatedField({
          id: "organizer-email-invalid",
          label: "Organizer email",
          type: "email",
          value: "player-at-example.com",
          error: "Please provide a valid email address.",
        })}
      </section>
      <section class="validation-card validation-card-valid" data-testid="validation-valid">
        <h3>Valid email example</h3>
        ${renderValidatedField({
          id: "organizer-email-valid",
          label: "Organizer email",
          type: "email",
          value: "organizer@example.com",
          success: "Email format looks valid.",
        })}
      </section>
    </div>`,
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
    "Overlay prompt for destructive actions with confirm and cancel paths.",
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
    ${renderStylesheetLink()}
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
    ${renderModalScriptTag()}
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
    ${renderStylesheetLink()}
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
