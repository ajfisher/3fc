import {
  renderButton,
  renderDataTable,
  renderInputField,
  renderModalPrompt,
  renderNavigation,
  renderPanel,
  renderPlayerCard,
  renderRowActionList,
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

function renderSetupScriptTag(): string {
  return '<script src="/ui/setup-flow.js" defer></script>';
}

function renderAuthScriptTag(): string {
  return '<script src="/ui/auth-flow.js" defer></script>';
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
    `<div data-ui="button-row">${renderButton("Save League", "primary", { "data-testid": "save-league" })}${renderButton("Reset", "ghost", { "data-testid": "reset-league" })}${renderButton("Cancel", "danger", { "data-testid": "cancel-league" })}</div>`,
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
    `<div data-ui="button-row">${renderButton("Save Season", "secondary", { "data-testid": "save-season" })}</div>`,
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
    `<div data-ui="button-row">${renderButton("Create Game", "primary", { "data-testid": "create-game" })}${renderButton("Preview", "secondary", { "data-testid": "preview-game" })}</div>`,
    "panel-game",
  );

  return `<section data-ui="panel-grid">${leaguePanel}${seasonPanel}${sessionPanel}${gamePanel}</section>`;
}

function renderSetupFlowForm(apiBaseUrl: string): string {
  const leaguePanel = renderPanel(
    "Step 1: Create League",
    "League ID is generated automatically from the league name/slug.",
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
        placeholder: "three-sided-football-club",
        hint: "Auto-filled from league name. Editable.",
      }),
      `<dl data-ui="id-preview" data-testid="league-id-preview">
        <div><dt>League ID</dt><dd id="league-id-display">Not generated yet</dd></div>
      </dl>`,
    ].join(""),
    `<div data-ui="button-row">${renderButton("Create League", "primary", {
      type: "button",
      "data-action": "create-league",
      "data-testid": "create-league",
    })}</div>`,
    "panel-league-flow",
  );

  const seasonPanel = renderPanel(
    "Step 2: Create Season",
    "Season can only be created after league is confirmed.",
    [
      renderInputField({
        id: "season-name",
        label: "Season name",
        placeholder: "2026 Season",
        required: true,
      }),
      renderInputField({
        id: "season-slug",
        label: "Season slug",
        placeholder: "2026-season",
        hint: "Auto-filled from season name. Editable.",
      }),
      renderInputField({
        id: "season-start",
        label: "Season start date",
        type: "date",
      }),
      renderInputField({
        id: "season-end",
        label: "Season end date",
        type: "date",
      }),
      `<dl data-ui="id-preview" data-testid="season-id-preview">
        <div><dt>Season ID</dt><dd id="season-id-display">Not generated yet</dd></div>
      </dl>`,
    ].join(""),
    `<div data-ui="button-row">${renderButton("Create Season", "primary", {
      type: "button",
      "data-action": "create-season",
      "data-testid": "create-season",
    })}</div>`,
    "panel-season-flow",
  );

  const gamePanel = renderPanel(
    "Step 3: Create Games",
    "Games are created under the selected season and session date.",
    [
      renderInputField({
        id: "session-date",
        label: "Session date",
        type: "date",
        required: true,
      }),
      renderInputField({
        id: "game-kickoff",
        label: "Kickoff time",
        type: "datetime-local",
        required: true,
      }),
      `<dl data-ui="id-preview" data-testid="game-id-preview">
        <div><dt>Session ID</dt><dd id="session-id-display">Not generated yet</dd></div>
        <div><dt>Game ID</dt><dd id="game-id-display">Not generated yet</dd></div>
      </dl>`,
      `<p data-ui="status-note" id="game-created-note" data-state="success" hidden>
        Game created. <a id="game-context-link" href="#">Open game context</a>
      </p>`,
    ].join(""),
    `<div data-ui="button-row">${renderButton("Create Game", "primary", {
      type: "button",
      "data-action": "create-game",
      "data-testid": "create-game",
    })}</div>`,
    "panel-game-flow",
  );

  return `<section data-ui="setup-flow" id="setup-flow-root" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-testid="setup-flow-root">
    <p data-ui="status-note" id="setup-status">Checking sign-in state…</p>
    <p data-ui="status-note" data-state="error" id="setup-error" hidden></p>
    <section data-ui="panel-grid" data-testid="setup-flow-grid">
      <div data-ui="setup-step" data-step="league">${leaguePanel}</div>
      <div data-ui="setup-step" data-step="season" hidden>${seasonPanel}</div>
      <div data-ui="setup-step" data-step="games" hidden>${gamePanel}</div>
    </section>
  </section>`;
}

function renderSetupHero(apiBaseUrl: string): string {
  const steps = [
    '<li id="step-chip-league" data-ui="step-chip" data-state="active">1. League</li>',
    '<li id="step-chip-season" data-ui="step-chip" data-state="upcoming">2. Season</li>',
    '<li id="step-chip-games" data-ui="step-chip" data-state="upcoming">3. Games</li>',
  ].join("");

  return `<section data-ui="hero">
    <span data-ui="hero-kicker">3FC Setup</span>
    <h1>Step through league, season, then game creation.</h1>
    <p data-ui="hero-copy">Authenticated setup flow for M1-07. API target: <code>${escapeHtml(apiBaseUrl)}</code></p>
    <ul data-ui="step-list" data-testid="setup-steps">${steps}</ul>
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
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="setup-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      ${renderSetupHero(apiBaseUrl)}
      <div data-ui="section-stack">
        ${renderSetupFlowForm(apiBaseUrl)}
        <p data-ui="status-note">If you are not signed in, you will be redirected to <code>/sign-in</code>.</p>
      </div>
    </main>
    ${renderSetupScriptTag()}
  </body>
</html>`;
}

export function renderSignInPage(apiBaseUrl: string, returnTo: string): string {
  const safeReturnTo = escapeHtml(returnTo);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Sign-in</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="signin-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero">
        <span data-ui="hero-kicker">3FC Auth</span>
        <h1>Sign in before setup</h1>
        <p data-ui="hero-copy">Send yourself a magic link and continue to setup flow.</p>
      </section>
      <section data-ui="section-stack">
        ${renderPanel(
          "Magic-link sign-in",
          "Use your organizer email and open the link from your inbox.",
          `<form data-ui="auth-form" id="auth-magic-form" novalidate>
            <input id="auth-return-to" type="hidden" value="${safeReturnTo}" />
            ${renderInputField({
              id: "auth-email",
              label: "Email address",
              type: "email",
              placeholder: "organizer@3fc.football",
              required: true,
              hint: "A magic link will be sent to this address.",
            })}
            <div data-ui="button-row">${renderButton("Send magic link", "primary", {
              type: "submit",
              "data-action": "send-magic-link",
              "data-testid": "send-magic-link",
            })}</div>
          </form>
          <p data-ui="status-note" id="auth-status">Checking session…</p>
          <p data-ui="status-note" data-state="error" id="auth-error" hidden></p>
          <p data-ui="status-note" data-state="success" id="auth-session" hidden>Signed in as <strong id="auth-session-email"></strong>. Redirecting…</p>`,
          "",
          "panel-signin-flow",
        )}
      </section>
    </main>
    ${renderAuthScriptTag()}
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
    `<div data-ui="player-grid" data-testid="player-grid">${[
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
    `<div data-ui="validation-stack">
      <section data-ui="validation-card" data-state="invalid" data-testid="validation-invalid">
        <h3>Invalid email example</h3>
        ${renderValidatedField({
          id: "organizer-email-invalid",
          label: "Organizer email",
          type: "email",
          value: "player-at-example.com",
          error: "Please provide a valid email address.",
        })}
      </section>
      <section data-ui="validation-card" data-state="valid" data-testid="validation-valid">
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
    })}<p data-ui="status-note" id="modal-note">No modal action has been confirmed yet.</p>`,
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
    <main data-ui="app-shell" data-testid="component-showcase">
      ${renderSetupHero(apiBaseUrl)}
      <div data-ui="section-stack">
        ${navigationPanel}
        <section data-ui="panel-grid" data-testid="component-grid">
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
    <main data-ui="app-shell">
      <section data-ui="hero">
        <span data-ui="hero-kicker">3FC Auth</span>
        <h1>${safeTitle}</h1>
        <p data-ui="hero-copy">${safeMessage}</p>
      </section>
    </main>
  </body>
</html>`;
}

export function renderMagicLinkCallbackPage(apiBaseUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Sign-in callback</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="auth-callback-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero">
        <span data-ui="hero-kicker">3FC Auth</span>
        <h1>Completing sign-in</h1>
        <p data-ui="hero-copy">Please wait while we complete your sign-in and return you to setup.</p>
      </section>
      <section data-ui="section-stack">
        <p data-ui="status-note" id="auth-callback-status">Verifying callback parameters…</p>
        <p data-ui="status-note" data-state="error" id="auth-callback-error" hidden></p>
      </section>
    </main>
    ${renderAuthScriptTag()}
  </body>
</html>`;
}

export interface GameContextPageInput {
  gameId: string;
  leagueId?: string;
  seasonId?: string;
  sessionId?: string;
  gameStartTs?: string;
}

export function renderGameContextPage(input: GameContextPageInput): string {
  const gameId = escapeHtml(input.gameId);
  const leagueId = input.leagueId ? escapeHtml(input.leagueId) : "Not provided";
  const seasonId = input.seasonId ? escapeHtml(input.seasonId) : "Not provided";
  const sessionId = input.sessionId ? escapeHtml(input.sessionId) : "Not provided";
  const gameStartTs = input.gameStartTs ? escapeHtml(input.gameStartTs) : "Not provided";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Game Context</title>
    ${renderStylesheetLink()}
  </head>
  <body>
    <main data-ui="app-shell" data-testid="game-context-shell">
      <section data-ui="hero">
        <span data-ui="hero-kicker">3FC Setup</span>
        <h1>Game context created: ${gameId}</h1>
        <p data-ui="hero-copy">Setup flow completed successfully. Live scoring controls are scheduled for Milestone M2.</p>
      </section>
      <section data-ui="panel-grid">
        ${renderPanel(
          "Context details",
          "Resolved identifiers for this game run.",
          `<dl data-ui="id-preview" data-testid="game-context-details">
            <div><dt>League ID</dt><dd>${leagueId}</dd></div>
            <div><dt>Season ID</dt><dd>${seasonId}</dd></div>
            <div><dt>Session ID</dt><dd>${sessionId}</dd></div>
            <div><dt>Game ID</dt><dd>${gameId}</dd></div>
            <div><dt>Kickoff (UTC)</dt><dd>${gameStartTs}</dd></div>
          </dl>`,
          `<div data-ui="button-row"><a href="/setup" data-ui="button-link" data-variant="secondary" data-testid="create-another-game">Create another game</a></div>`,
          "panel-game-context",
        )}
      </section>
    </main>
  </body>
</html>`;
}
