import {
  renderButton,
  renderDataTable,
  renderInputField,
  renderIconButton,
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

function renderAssetPath(path: string): string {
  const version = process.env.THREEFC_ASSET_VERSION?.trim();
  if (!version) {
    return path;
  }

  return `${path}?v=${encodeURIComponent(version)}`;
}

function renderStylesheetLink(): string {
  return `<link rel="stylesheet" href="${escapeHtml(renderAssetPath("/ui/styles.css"))}" />
  <link rel="stylesheet" href="${escapeHtml(renderAssetPath("/ui/icons.css"))}" />`;
}

function renderModalScriptTag(): string {
  return `<script src="${escapeHtml(renderAssetPath("/ui/modal.js"))}" defer></script>`;
}

function renderSetupScriptTag(): string {
  return `<script src="${escapeHtml(renderAssetPath("/ui/setup-flow.js"))}" defer></script>`;
}

function renderAuthScriptTag(): string {
  return `<script src="${escapeHtml(renderAssetPath("/ui/auth-flow.js"))}" defer></script>`;
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
        label: "League friendly URL",
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

function renderTableShell(input: {
  tableTestId: string;
  bodyId: string;
  emptyId: string;
  emptyText: string;
  headers: string[];
}): string {
  const headers = input.headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("");

  return `<p data-ui="status-note" id="${escapeHtml(input.emptyId)}">${escapeHtml(input.emptyText)}</p>
  <div data-ui="table-wrap" data-testid="${escapeHtml(input.tableTestId)}" hidden>
    <table data-ui="data-table">
      <thead><tr>${headers}</tr></thead>
      <tbody id="${escapeHtml(input.bodyId)}"></tbody>
    </table>
  </div>`;
}

function renderDashboardHero(): string {
  return `<section data-ui="hero" data-layout="dashboard">
    <h1 id="dashboard-welcome">Welcome</h1>
  </section>`;
}

export function renderSetupHomePage(apiBaseUrl: string): string {
  const createLeaguePanel = renderPanel(
    "Create league",
    "Start here if this account has no leagues yet.",
    `${renderValidatedField({
      id: "league-name",
      label: "League name",
      placeholder: "Three Sided Football Club",
      required: true,
    })}${renderValidatedField({
      id: "league-friendly-url",
      label: "League friendly URL",
      placeholder: "three-sided-football-club",
      hint: "Auto-filled from league name. Editable.",
    })}<dl data-ui="id-preview"><div><dt>League ID</dt><dd id="league-id-display">Not generated yet</dd></div></dl>`,
    `<div data-ui="button-row">${renderButton("Create league", "primary", {
      type: "button",
      "data-action": "create-league",
      "data-testid": "create-league",
    })}</div>`,
    "panel-dashboard-create-league",
  );

  const leaguesPanel = renderPanel(
    "Leagues",
    "Select a league to manage seasons and games.",
    renderTableShell({
      tableTestId: "dashboard-leagues-table",
      bodyId: "dashboard-leagues-body",
      emptyId: "dashboard-leagues-empty",
      emptyText: "No leagues yet. Create your first league to begin.",
      headers: ["League", "Actions"],
    }),
    "",
    "panel-dashboard-leagues",
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Dashboard</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="setup-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      ${renderDashboardHero()}
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="dashboard" data-api-base-url="${escapeHtml(apiBaseUrl)}">
        <div data-ui="page-toolbar" role="toolbar" aria-label="Dashboard actions">
          ${renderIconButton({
            icon: "circle-plus",
            label: "Create a new league",
            text: "Create a new league",
            variant: "primary",
            attributes: {
              "data-action": "toggle-create-league",
              "data-testid": "toggle-create-league",
              "aria-controls": "dashboard-create-league-region",
              "aria-expanded": "false",
            },
          })}
        </div>
        <p data-ui="status-note" id="setup-status" role="status" aria-live="polite">Checking sign-in state…</p>
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-stack" data-testid="dashboard-grid">
          ${leaguesPanel}
          <section id="dashboard-create-league-region" data-ui="disclosure-panel" hidden>
            ${createLeaguePanel}
          </section>
        </section>
      </section>
    </main>
    ${renderSetupScriptTag()}
  </body>
</html>`;
}

export function renderLeaguePage(apiBaseUrl: string, leagueId: string): string {
  const safeLeagueId = escapeHtml(leagueId);
  const leagueHeading = safeLeagueId.length > 0 ? safeLeagueId : "League";
  const createSeasonPanel = renderPanel(
    "Create season",
    "Create a season inside this league.",
    `${renderValidatedField({
      id: "season-name",
      label: "Season name",
      placeholder: "2026 Season",
      required: true,
    })}${renderInputField({
      id: "season-start",
      label: "Season start date",
      type: "date",
    })}${renderInputField({
      id: "season-end",
      label: "Season end date",
      type: "date",
    })}${renderValidatedField({
      id: "season-friendly-url",
      label: "Season friendly URL",
      placeholder: "2026-season",
      hint: "Auto-filled from season name. Editable.",
    })}<dl data-ui="id-preview"><div><dt>Season ID</dt><dd id="season-id-display">Not generated yet</dd></div></dl>`,
    `<div data-ui="button-row">${renderButton("Create season", "primary", {
      type: "button",
      "data-action": "create-season",
      "data-testid": "create-season",
    })}</div>`,
    "panel-league-create-season",
  );

  const seasonsPanel = renderPanel(
    "Seasons",
    "Manage seasons for this league.",
    renderTableShell({
      tableTestId: "league-seasons-table",
      bodyId: "league-seasons-body",
      emptyId: "league-seasons-empty",
      emptyText: "No seasons yet. Create one to add games.",
      headers: ["Season", "Dates", "Actions"],
    }),
    "",
    "panel-league-seasons",
  );

  const organiserInvitePanel = renderPanel(
    "Invite organiser",
    "Share the link or code below or send an invite via email.",
    `<section data-ui="section-stack" aria-labelledby="organiser-share-invite-heading">
      <h3 id="organiser-share-invite-heading">Share code/link</h3>
      <p data-ui="status-note" id="organiser-share-invite-status" aria-live="polite"></p>
      <dl data-ui="id-preview" data-testid="organiser-share-invite-result" id="organiser-share-invite-result">
        <div><dt>Invite code</dt><dd id="organiser-share-invite-code">Open this panel to load</dd></div>
        <div><dt>Invite link</dt><dd><a id="organiser-share-invite-link">Open this panel to load</a></dd></div>
      </dl>
    </section>
    <section data-ui="section-stack" aria-labelledby="organiser-email-invite-heading">
      <h3 id="organiser-email-invite-heading">Email invite</h3>
      ${renderValidatedField({
        id: "organiser-invite-email",
        label: "Organiser email",
        type: "email",
        placeholder: "coach@example.com",
        hint: "Sends a one-time invite restricted to this email.",
      })}
      <p data-ui="status-note" id="organiser-invite-email-status" aria-live="polite"></p>
    </section>`,
    `<div data-ui="button-row">${renderButton("Send email invite", "primary", {
      type: "button",
      "data-action": "create-organiser-invite",
      "data-testid": "create-organiser-invite",
    })}</div>`,
    "panel-league-organiser-invite",
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC League</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="league-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero">
        <span data-ui="hero-kicker"><a href="/setup">Dashboard</a> / League</span>
        <div data-ui="hero-title-row">
          <h1 id="league-title">${leagueHeading}</h1>
          <small data-ui="reference-id" id="league-reference">League ID: ${safeLeagueId || "Loading…"}</small>
        </div>
        <div data-ui="header-actions" role="toolbar" aria-label="League actions">
          ${renderIconButton({
            icon: "calendar-plus",
            label: "Create season",
            attributes: {
              "data-action": "toggle-create-season",
              "data-testid": "toggle-create-season",
              "aria-controls": "league-create-season-region",
              "aria-expanded": "false",
            },
          })}
          ${renderIconButton({
            icon: "user-round-plus",
            label: "Invite organiser",
            attributes: {
              "data-action": "toggle-organiser-invite",
              "data-testid": "toggle-organiser-invite",
              "aria-controls": "league-organiser-invite-region",
              "aria-expanded": "false",
            },
          })}
          ${renderIconButton({
            icon: "trash-2",
            label: "Delete league",
            variant: "danger",
            attributes: {
              "data-action": "delete-league",
              "data-testid": "delete-league",
            },
          })}
        </div>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="league" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-league-id="${safeLeagueId}">
        <p data-ui="status-note" id="setup-status" role="status" aria-live="polite">Loading league data…</p>
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-stack" data-testid="league-grid">
          ${seasonsPanel}
          <section id="league-create-season-region" data-ui="disclosure-panel" hidden>
            ${createSeasonPanel}
          </section>
          <section id="league-organiser-invite-region" data-ui="disclosure-panel" hidden>
            ${organiserInvitePanel}
          </section>
        </section>
      </section>
    </main>
    ${renderSetupScriptTag()}
  </body>
</html>`;
}

export function renderInvitePage(apiBaseUrl: string, inviteCode: string): string {
  const safeInviteCode = escapeHtml(inviteCode.trim().toUpperCase());
  const inviteHeading = safeInviteCode.length > 0 ? safeInviteCode : "Organiser invite";
  const hasCode = safeInviteCode.length > 0;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Organiser Invite</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="invite-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero">
        <span data-ui="hero-kicker">3FC Invite</span>
        <h1>Organiser invite</h1>
        <p data-ui="hero-copy">Code <code>${inviteHeading}</code></p>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="invite" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-invite-code="${safeInviteCode}">
        <p data-ui="status-note" id="setup-status" role="status" aria-live="polite">Checking sign-in state…</p>
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-grid" data-testid="invite-grid">
          ${renderPanel(
            "Accept invite",
            "Join the league setup team.",
            `<form data-ui="auth-form" id="organiser-invite-code-form" ${hasCode ? "hidden" : ""} novalidate>
              ${renderValidatedField({
                id: "organiser-invite-code-input",
                label: "Invite code",
                placeholder: "ABCD2345",
                required: true,
              })}
              <div data-ui="button-row">${renderButton("Continue", "primary", {
                type: "submit",
                "data-action": "continue-organiser-invite",
                "data-testid": "continue-organiser-invite",
              })}</div>
            </form>
            <section data-ui="claim-panel" id="organiser-invite-acceptance" data-testid="organiser-invite-acceptance" ${hasCode ? "" : "hidden"}>
              <dl data-ui="id-preview">
                <div><dt>Invite code</dt><dd id="organiser-invite-accept-code">${inviteHeading}</dd></div>
                <div><dt>League</dt><dd id="organiser-invite-league">Pending</dd></div>
              </dl>
              <div data-ui="button-row">
                ${renderButton("Accept invite", "primary", {
                  type: "button",
                  "data-action": "accept-organiser-invite",
                  "data-testid": "accept-organiser-invite",
                })}
                <a data-ui="button-secondary" id="organiser-invite-league-link" data-testid="organiser-invite-league-link" href="/setup" hidden>Open league</a>
              </div>
            </section>`,
            "",
            "panel-organiser-invite",
          )}
        </section>
      </section>
    </main>
    ${renderSetupScriptTag()}
  </body>
</html>`;
}

export function renderSeasonPage(apiBaseUrl: string, seasonId: string, leagueId = ""): string {
  const safeSeasonId = escapeHtml(seasonId);
  const safeLeagueId = escapeHtml(leagueId);
  const seasonHeading = safeSeasonId.length > 0 ? safeSeasonId : "Season";
  const createGamePanel = renderPanel(
    "Create game",
    "Add a game into this season.",
    `${renderValidatedField({
      id: "game-date",
      label: "Game date",
      type: "date",
      required: true,
    })}${renderValidatedField({
      id: "game-kickoff",
      label: "Kickoff time",
      type: "datetime-local",
      required: true,
    })}
    <div data-ui="field">
      <label for="game-third-length">Third length</label>
      <select id="game-third-length" data-ui="input" data-testid="game-third-length">
        <option value="20" selected>20 minutes</option>
        <option value="25">25 minutes</option>
        <option value="30">30 minutes</option>
      </select>
    </div>`,
    `<div data-ui="button-row">${renderButton("Create game", "primary", {
      type: "button",
      "data-action": "create-game",
      "data-testid": "create-game",
    })}</div>`,
    "panel-season-create-game",
  );

  const gamesPanel = renderPanel(
    "Games",
    "Manage scheduled games for this season.",
    renderTableShell({
      tableTestId: "season-games-table",
      bodyId: "season-games-body",
      emptyId: "season-games-empty",
      emptyText: "No games yet. Create your first game.",
      headers: ["Kickoff", "Status", "Actions"],
    }),
    "",
    "panel-season-games",
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Season</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="season-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-season-id="${safeSeasonId}" data-league-id="${safeLeagueId}">
      <section data-ui="hero">
        <span data-ui="hero-kicker"><a href="/setup">Dashboard</a> / <a id="season-league-link" href="/setup">League</a> / Season</span>
        <div data-ui="hero-title-row">
          <h1 id="season-title">${seasonHeading}</h1>
          <small data-ui="reference-id" id="season-reference">Season ID: ${safeSeasonId || "Loading…"}</small>
        </div>
        <div data-ui="header-actions" role="toolbar" aria-label="Season actions">
          ${renderIconButton({
            icon: "calendar-plus",
            label: "Create game",
            attributes: {
              "data-action": "toggle-create-game",
              "data-testid": "toggle-create-game",
              "aria-controls": "season-create-game-region",
              "aria-expanded": "false",
            },
          })}
          ${renderIconButton({
            icon: "trash-2",
            label: "Delete season",
            variant: "danger",
            attributes: {
              "data-action": "delete-season",
              "data-testid": "delete-season",
            },
          })}
        </div>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="season" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-season-id="${safeSeasonId}" data-league-id="${safeLeagueId}">
        <p data-ui="status-note" id="setup-status" role="status" aria-live="polite">Loading season data…</p>
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-stack" data-testid="season-grid">
          ${gamesPanel}
          <section id="season-create-game-region" data-ui="disclosure-panel" hidden>
            ${createGamePanel}
          </section>
        </section>
      </section>
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
          "Use your organizer email and open the link from your inbox. First-time emails are treated as sign-up and account creation.",
          `<form data-ui="auth-form" id="auth-magic-form" novalidate>
            <input id="auth-return-to" type="hidden" value="${safeReturnTo}" />
            ${renderValidatedField({
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
      ${renderDashboardHero()}
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
        <h1>Complete sign-in</h1>
        <p data-ui="hero-copy">Confirm this browser should finish sign-in and continue.</p>
      </section>
      <section data-ui="section-stack">
        <p data-ui="status-note" id="auth-callback-status">Verifying callback parameters…</p>
        <div data-ui="button-row">
          ${renderButton("Complete sign-in", "primary", {
            type: "button",
            "data-action": "complete-magic-link",
            "data-testid": "complete-magic-link",
            hidden: "hidden",
          })}
        </div>
        <p data-ui="status-note" data-state="error" id="auth-callback-error" hidden></p>
      </section>
    </main>
    ${renderAuthScriptTag()}
  </body>
</html>`;
}

export function renderJoinPage(apiBaseUrl: string, joinCode: string): string {
  const safeJoinCode = escapeHtml(joinCode);
  const joinHeading = safeJoinCode.length > 0 ? safeJoinCode : "Join game";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Join</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="join-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero">
        <span data-ui="hero-kicker">3FC Join</span>
        <h1>Join game</h1>
        <p data-ui="hero-copy">Code <code>${joinHeading}</code></p>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="join" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-join-code="${safeJoinCode}">
        <p data-ui="status-note" id="setup-status" role="status" aria-live="polite">Ready.</p>
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-grid" data-testid="join-grid">
          ${renderPanel(
            "Player registration",
            "Enter the name that should appear on the scorekeeper roster.",
            `<dl data-ui="id-preview" data-testid="join-context-details">
              <div><dt>Join code</dt><dd id="join-code-value" data-testid="join-code-value">${joinHeading}</dd></div>
            </dl>
            <form data-ui="auth-form" id="join-game-form" novalidate>
              ${renderValidatedField({
                id: "join-player-nickname",
                label: "Nickname",
                placeholder: "Ari",
                required: true,
                hint: "Use the name the scorekeeper expects.",
              })}
              <div data-ui="button-row">${renderButton("Join game", "primary", {
                type: "submit",
                "data-action": "join-game",
                "data-testid": "join-game",
              })}</div>
            </form>
            <dl data-ui="id-preview" data-testid="join-result" id="join-result" hidden>
              <div><dt>Player</dt><dd id="join-result-player"></dd></div>
              <div><dt>Game</dt><dd id="join-result-game"></dd></div>
            </dl>
            <section data-ui="claim-panel" data-testid="join-claim-actions" id="join-claim-actions" hidden>
              <p data-ui="field-hint" id="join-claim-status">Sign in to claim this player for scoring access.</p>
              <div data-ui="button-row">
                <a data-ui="button-secondary" id="join-signin-link" data-testid="join-signin-link" href="/sign-in">Sign in to claim</a>
                ${renderButton("Claim player", "primary", {
                  type: "button",
                  "data-action": "claim-player",
                  "data-testid": "claim-player",
                })}
              </div>
            </section>`,
            "",
            "panel-join-player",
          )}
        </section>
      </section>
    </main>
    ${renderSetupScriptTag()}
  </body>
</html>`;
}

export interface GameContextPageInput {
  gameId: string;
  leagueId?: string;
  seasonId?: string;
  gameStartTs?: string;
}

function renderGameModeTab(input: {
  mode: "structure" | "players" | "run" | "final";
  label: string;
  meta: string;
  active?: boolean;
}): string {
  const tabId = `game-mode-tab-${input.mode}`;
  const panelId = `game-mode-${input.mode}`;
  const controls = input.mode === "final" ? "" : ` aria-controls="${panelId}"`;
  return `<button data-ui="game-mode-tab" type="button" id="${tabId}"${controls} aria-pressed="${
    input.active ? "true" : "false"
  }" data-action="select-game-mode" data-game-mode="${input.mode}" data-state="${input.active ? "active" : "idle"}" data-testid="game-mode-${input.mode}-tab">
    <span data-mode-label="${input.mode}">${escapeHtml(input.label)}</span>
    <small data-mode-meta="${input.mode}">${escapeHtml(input.meta)}</small>
  </button>`;
}

export function renderGamePage(apiBaseUrl: string, input: GameContextPageInput): string {
  const gameId = escapeHtml(input.gameId);
  const gameHeading = gameId.length > 0 ? gameId : "Game";
  const gameDetailsPanel = renderPanel(
    "Game details",
    "Edit core game metadata.",
    `<dl data-ui="id-preview" data-testid="game-context-details">
      <div><dt>Game ID</dt><dd id="game-id-value">${gameHeading}</dd></div>
      <div><dt>Join code</dt><dd id="game-join-code-value" data-testid="game-join-code-value">Loading…</dd></div>
      <div><dt>Join link</dt><dd><a id="game-join-link" data-testid="game-join-link" href="/join">Loading…</a></dd></div>
      <div data-ui="join-qr-row"><dt>Join QR</dt><dd id="game-join-qr" data-ui="join-qr" data-testid="game-join-qr">Loading…</dd></div>
      <div><dt>League ID</dt><dd id="game-league-id">Loading…</dd></div>
      <div><dt>Season ID</dt><dd id="game-season-id">Loading…</dd></div>
    </dl>
    ${renderValidatedField({
      id: "game-edit-kickoff",
      label: "Kickoff time",
      type: "datetime-local",
      required: true,
    })}
    <div data-ui="field">
      <label for="game-edit-status">Status</label>
      <select id="game-edit-status" data-ui="input" data-testid="game-edit-status">
        <option value="scheduled">Scheduled</option>
        <option value="live">Live</option>
        <option value="finished" disabled>Finished</option>
      </select>
    </div>
    <div data-ui="field">
      <label for="game-edit-third-length">Third length</label>
      <select id="game-edit-third-length" data-ui="input" data-testid="game-edit-third-length">
        <option value="20">20 minutes</option>
        <option value="25">25 minutes</option>
        <option value="30">30 minutes</option>
      </select>
    </div>`,
    `<div data-ui="button-row">
      ${renderButton("Save changes", "primary", {
        type: "button",
        "data-action": "save-game",
        "data-testid": "save-game",
      })}
      ${renderButton("Delete game", "danger", {
        type: "button",
        "data-action": "delete-game",
        "data-testid": "delete-game",
      })}
      <a id="create-another-game-link" href="/setup" data-ui="button-link" data-variant="secondary" data-testid="create-another-game">Create another game</a>
    </div>
    <div data-ui="mode-actions">
      ${renderButton("Players", "secondary", {
        type: "button",
        "data-action": "select-game-mode",
        "data-game-mode": "players",
        "data-testid": "game-mode-next-players",
      })}
    </div>`,
    "panel-game-details",
  );
  const timerPanel = `<section data-ui="run-timer-panel" data-testid="panel-game-timer" aria-labelledby="run-timer-heading">
    <header data-ui="section-heading">
      <h2 id="run-timer-heading">Clock</h2>
      <p>Start or stop the current third.</p>
    </header>
    <div data-ui="timer-board" data-testid="third-timer">
      <div data-ui="run-timer-bar" data-testid="run-timer-bar">
        <div data-ui="timer-display" id="timer-display" data-testid="timer-display" tabindex="-1">
          <span id="timer-third-label">Third 1</span>
          <strong id="timer-display-value">00:00</strong>
          <span id="timer-phase-label">Not started</span>
        </div>
        <div data-ui="button-row" data-density="compact">
          ${renderButton("Start Third 1", "primary", {
            type: "button",
            "data-action": "start-active-third",
            "data-testid": "start-third",
          })}
          ${renderButton("Finish Third", "secondary", {
            type: "button",
            "data-action": "finish-active-third",
            "data-testid": "finish-third",
          })}
        </div>
      </div>
      <details data-ui="run-third-history" data-testid="run-third-history">
        <summary>Third history</summary>
        <dl data-ui="id-preview" data-testid="timer-context-details">
          <div><dt>Length</dt><dd id="timer-third-length">20 minutes</dd></div>
          <div><dt>Status</dt><dd id="timer-status">Not started</dd></div>
          <div><dt>Active third</dt><dd id="timer-active-third">-</dd></div>
        </dl>
        <ol data-ui="third-status-list" id="third-status-list" data-testid="third-status-list"></ol>
      </details>
    </div>
  </section>`;
  const rosterPanel = renderPanel(
    "Roster setup",
    "Create players and assign them to game teams.",
    `${renderValidatedField({
      id: "player-nickname",
      label: "Player nickname",
      placeholder: "Ari",
    })}
    <div data-ui="button-row">
      ${renderButton("Create player", "primary", {
        type: "button",
        "data-action": "quick-create-player",
        "data-testid": "quick-create-player",
      })}
    </div>
    <div data-ui="field">
      <label for="player-search">Search players</label>
      <input data-ui="input" id="player-search" name="player-search" type="search" placeholder="Nickname" autocomplete="off" />
    </div>
    <div data-ui="roster-workspace" data-testid="roster-workspace">
      <section data-ui="player-pool" aria-labelledby="player-pool-title">
        <h3 id="player-pool-title">Players</h3>
        <div id="player-pool" data-ui="player-list" data-testid="player-pool"></div>
      </section>
      <section data-ui="roster-board" aria-labelledby="roster-board-title">
        <h3 id="roster-board-title">Teams</h3>
        <div id="roster-teams" data-ui="roster-grid" data-testid="roster-teams"></div>
      </section>
    </div>`,
    `<div data-ui="mode-actions">
      ${renderButton("Game", "secondary", {
        type: "button",
        "data-action": "select-game-mode",
        "data-game-mode": "structure",
        "data-testid": "game-mode-back-structure",
      })}
      ${renderButton("Run", "primary", {
        type: "button",
        "data-action": "select-game-mode",
        "data-game-mode": "run",
        "data-testid": "game-mode-next-run",
      })}
    </div>`,
    "panel-game-roster",
  );
  const scorePanel = `<div data-ui="run-score-strip" data-testid="run-score-strip">
    <div data-ui="live-scoreboard" id="live-scoreboard" data-testid="live-scoreboard"></div>
  </div>`;
  const livePanel = `<section data-ui="run-scoring-panel" data-testid="panel-game-live" aria-labelledby="run-scoring-heading">
    <header data-ui="section-heading">
      <h2 id="run-scoring-heading">Run game</h2>
      <p>Record goals first; review corrections when needed.</p>
    </header>
    <section data-ui="run-primary-scoring" data-testid="run-primary-scoring" aria-labelledby="run-goal-form-heading">
      <header>
        <h3 id="run-goal-form-heading">Record goal</h3>
      </header>
      <div data-ui="run-goal-form">
        <div data-ui="field">
          <label for="goal-scoring-team">Scoring team</label>
          <select id="goal-scoring-team" data-ui="input" data-testid="goal-scoring-team"></select>
        </div>
        <div data-ui="field">
          <label for="goal-conceding-team">Conceding team</label>
          <select id="goal-conceding-team" data-ui="input" data-testid="goal-conceding-team"></select>
        </div>
        <div data-ui="field">
          <label for="goal-scorer">Scorer</label>
          <select id="goal-scorer" data-ui="input" data-testid="goal-scorer"></select>
        </div>
        <label data-ui="check-row" data-density="secondary" for="goal-own-goal">
          <input id="goal-own-goal" type="checkbox" data-testid="goal-own-goal" />
          <span>Own goal</span>
        </label>
        <details data-ui="run-secondary-scoring" open>
          <summary>Assists</summary>
          <div id="goal-assists" data-ui="assist-list" data-testid="goal-assists"></div>
        </details>
      </div>
      <p data-ui="field-hint" id="goal-form-note">Start a third and assign players before scoring.</p>
      <div data-ui="button-row" data-priority="scoring">
        ${renderButton("Add goal", "primary", {
          type: "button",
          "data-action": "save-goal",
          "data-testid": "add-goal",
        })}
        ${renderButton("Cancel edit", "secondary", {
          type: "button",
          "data-action": "cancel-goal-edit",
          "data-testid": "cancel-goal-edit",
        })}
        ${renderButton("Undo last", "danger", {
          type: "button",
          "data-action": "undo-last-goal",
          "data-testid": "undo-last-goal",
        })}
      </div>
    </section>
  </section>`;
  const latestGoalsPanel = `<details data-ui="run-latest-goals" data-testid="run-latest-goals" open>
      <summary>Latest goals</summary>
      <ol id="goal-timeline" data-ui="goal-timeline" data-testid="goal-timeline"></ol>
    </details>`;
  const finalPanel = renderPanel(
    "Finalisation",
    "Finish the match and review the summary.",
    `<div data-ui="finalisation-board" data-testid="finalisation-board">
      <dl data-ui="id-preview" data-testid="finalisation-context">
        <div><dt>Game</dt><dd id="final-game-id-value">${gameHeading}</dd></div>
        <div><dt>Status</dt><dd id="final-game-status">Loading…</dd></div>
        <div><dt>Timeline</dt><dd id="final-game-readiness">Loading…</dd></div>
      </dl>
      <div data-ui="game-result-summary" id="game-result-summary" data-testid="game-result-summary" hidden></div>
    </div>`,
    `<div data-ui="button-row">
      ${renderButton("Finish game", "primary", {
        type: "button",
        "data-action": "finish-game",
        "data-testid": "finish-game",
      })}
    </div>
    <div data-ui="mode-actions">
      ${renderButton("Run", "secondary", {
        type: "button",
        "data-action": "select-game-mode",
        "data-game-mode": "run",
        "data-testid": "game-mode-back-run",
      })}
    </div>`,
    "panel-game-final",
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Game</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="game-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero">
        <span data-ui="hero-kicker"><a href="/setup">Dashboard</a> / <a id="game-league-link" href="/setup">League</a> / <a id="game-season-link" href="/setup">Season</a> / Game</span>
        <h1 id="game-title">${gameHeading}</h1>
        <p data-ui="hero-copy" id="game-subtitle">Loading game details…</p>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="game" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-game-id="${gameId}">
        <p data-ui="status-note" id="setup-status" role="status" aria-live="polite">Loading game data…</p>
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <nav data-ui="game-mode-nav" data-testid="game-mode-nav" aria-label="Game workflow">
          <div data-ui="game-mode-tabs" aria-label="Game workflow modes">
            ${renderGameModeTab({ mode: "structure", label: "Game", meta: "Setup", active: true })}
            ${renderGameModeTab({ mode: "players", label: "Players", meta: "Roster" })}
            ${renderGameModeTab({ mode: "run", label: "Run", meta: "Timer" })}
            ${renderGameModeTab({ mode: "final", label: "Final", meta: "Summary" })}
          </div>
        </nav>
        <p data-ui="game-mode-status" id="game-mode-status" data-testid="game-mode-status">Game setup</p>
        <section data-ui="game-mode-panels" data-testid="game-grid">
          <section data-ui="game-mode-panel" id="game-mode-structure" aria-labelledby="game-mode-tab-structure" data-game-mode="structure" data-testid="game-mode-structure">
            ${gameDetailsPanel}
          </section>
          <section data-ui="game-mode-panel" id="game-mode-players" aria-labelledby="game-mode-tab-players" data-game-mode="players" data-testid="game-mode-players" hidden>
            ${rosterPanel}
          </section>
          <section data-ui="game-mode-panel" id="game-mode-run" aria-labelledby="game-mode-tab-run" data-game-mode="run" data-testid="game-mode-run" data-mode-layout="run" hidden>
            <div data-ui="run-console" data-testid="run-console">
              ${scorePanel}
              ${livePanel}
              ${timerPanel}
              ${latestGoalsPanel}
            </div>
          </section>
          <section data-ui="game-mode-panel" id="game-mode-final" aria-label="Finalisation" data-game-mode="final" data-testid="game-mode-final" hidden>
            ${finalPanel}
          </section>
        </section>
      </section>
    </main>
    ${renderSetupScriptTag()}
  </body>
</html>`;
}
