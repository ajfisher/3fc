import { APP_RETURN_TARGET_PATTERN_SOURCES } from "@3fc/contracts";

import {
  renderActionMenu,
  renderButton,
  renderDataTable,
  renderInputField,
  renderIcon,
  renderIconButton,
  renderIconLink,
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

function renderAuthReturnTargetPatterns(): string {
  return escapeHtml(JSON.stringify(APP_RETURN_TARGET_PATTERN_SOURCES));
}

function renderModalScriptTag(): string {
  return `<script src="${escapeHtml(renderAssetPath("/ui/modal.js"))}" defer></script>`;
}

function renderSetupScriptTag(): string {
  return `<script src="${escapeHtml(renderAssetPath("/ui/setup-flow.js"))}" defer></script>`;
}

function renderActivityStatus(message: string, loading = true): string {
  return `<div data-ui="activity-status" id="setup-status" role="status" aria-live="polite" data-activity="${loading ? "loading" : "message"}">${renderIcon("loader-circle")}<span data-ui="activity-message" class="sr-only">${escapeHtml(message)}</span></div>`;
}

function renderAuthScriptTag(): string {
  return `<script src="${escapeHtml(renderAssetPath("/ui/auth-flow.js"))}" defer></script>`;
}

function renderAccountActions(): string {
  return `<div data-ui="account-actions" id="account-actions" hidden>
    ${renderButton("Sign out", "secondary", {
      type: "button",
      id: "sign-out",
      "data-testid": "sign-out",
      disabled: "",
    })}
    <p data-ui="status-note" id="sign-out-status" role="status" aria-live="polite" hidden></p>
  </div>`;
}

function renderManagementNavigation(home = false): string {
  return `<div data-ui="site-header">
    <nav data-ui="site-nav" aria-label="Primary"><a href="/setup"${home ? ' aria-current="page"' : ""}>Home</a></nav>
    ${renderAccountActions()}
  </div>`;
}

function renderFormCancel(): string {
  return renderButton("Cancel", "ghost", { type: "button", "data-action": "cancel-disclosure" });
}

function renderAdditionalOptions(content: string): string {
  return `<details data-ui="additional-options"><summary>Additional options</summary><div data-ui="form-fields">${content}</div></details>`;
}

function renderSetupFoundationPanels(): string {
  return `<div data-ui="auth-form" data-testid="fixture-fields">
    ${renderInputField({
      id: "fixture-league-name",
      label: "League name",
      value: "North Melbourne Three-Sided Football Club",
    })}
    ${renderValidatedField({
      id: "fixture-email",
      label: "Email address",
      type: "email",
      value: "organiser@example.com",
      inputAttributes: { autocomplete: "email", inputmode: "email", autocapitalize: "none" },
    })}
    ${renderInputField({
      id: "fixture-season-start",
      label: "Season starts",
      type: "date",
      value: "2026-09-13",
    })}
    ${renderInputField({
      id: "fixture-kickoff",
      label: "Kickoff time",
      type: "datetime-local",
      value: "2026-09-13T09:30",
    })}
    <div data-ui="field">
      <label for="fixture-status">Game status</label>
      <select data-ui="input" id="fixture-status" name="fixture-status">
        <option value="scheduled">Scheduled</option>
        <option value="live">Live</option>
        <option value="finished">Finished</option>
      </select>
    </div>
    <label data-ui="check-row" for="fixture-own-goal"><input id="fixture-own-goal" type="checkbox" />Own goal</label>
    ${renderValidatedField({
      id: "fixture-disabled-field",
      label: "Finished game example",
      value: "13 September 2026",
      inputAttributes: { disabled: "" },
    })}
  </div>`;
}

function renderTableShell(input: {
  tableTestId: string;
  bodyId: string;
  emptyId: string;
  emptyText: string;
  headers: string[];
  tableLabel?: string;
  emptyInitiallyHidden?: boolean;
}): string {
  const headers = input.headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("");
  const tableLabel = input.tableLabel ? ` aria-label="${escapeHtml(input.tableLabel)}"` : "";
  const emptyHidden = input.emptyInitiallyHidden ? " hidden" : "";

  return `<p data-ui="status-note" id="${escapeHtml(input.emptyId)}"${emptyHidden}>${escapeHtml(input.emptyText)}</p>
  <div data-ui="table-wrap" data-testid="${escapeHtml(input.tableTestId)}" hidden>
    <table data-ui="data-table"${tableLabel}>
      <thead><tr>${headers}</tr></thead>
      <tbody id="${escapeHtml(input.bodyId)}"></tbody>
    </table>
  </div>`;
}

function renderDashboardHero(): string {
  return `<section data-ui="hero" data-layout="dashboard">
    ${renderManagementNavigation(true)}
    <h1 id="dashboard-welcome">Welcome</h1>
  </section>`;
}

export function renderSetupHomePage(apiBaseUrl: string): string {
  const createLeaguePanel = renderPanel(
    "Create league",
    "",
    `${renderValidatedField({
      id: "league-name",
      label: "League name",
      placeholder: "Three Sided Football Club",
      required: true,
    })}${renderAdditionalOptions(`${renderValidatedField({
      id: "league-friendly-url",
      label: "Friendly URL",
      placeholder: "three-sided-football-club",
    })}<dl data-ui="id-preview"><div><dt>League ID</dt><dd id="league-id-display">Not generated yet</dd></div></dl>`)}`,
    `<div data-ui="button-row">${renderButton("Create league", "primary", {
      type: "submit",
      "data-action": "create-league",
      "data-testid": "create-league",
    })}${renderFormCancel()}</div>`,
    "panel-dashboard-create-league",
  );

  const leaguesPanel = renderPanel(
    "Leagues",
    "",
    renderTableShell({
      tableTestId: "dashboard-leagues-table",
      bodyId: "dashboard-leagues-body",
      emptyId: "dashboard-leagues-empty",
      emptyText: "No leagues to show.",
      headers: ["League"],
      tableLabel: "Leagues",
      emptyInitiallyHidden: true,
    }),
    "",
    "panel-dashboard-leagues",
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Home</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}">
    <main data-ui="app-shell" data-testid="setup-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      ${renderDashboardHero()}
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="dashboard" data-api-base-url="${escapeHtml(apiBaseUrl)}">
        ${renderActivityStatus("Checking sign-in state…")}
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-stack" data-testid="dashboard-grid">
          ${leaguesPanel}
          <div data-ui="page-toolbar" role="group" aria-label="Home actions">
            ${renderIconButton({
              icon: "circle-plus",
              label: "Create a new league",
              text: "Create a new league",
              variant: "secondary",
              attributes: {
                "data-action": "toggle-create-league",
                "data-testid": "toggle-create-league",
                "aria-controls": "dashboard-create-league-region",
                "aria-expanded": "false",
              },
            })}
          </div>
          <section id="dashboard-create-league-region" data-ui="disclosure-panel" hidden>
            <form id="create-league-form" data-ui="management-form" aria-label="Create league" novalidate>${createLeaguePanel}</form>
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
  const createSeasonPanel = renderPanel(
    "Create season",
    "",
    `${renderValidatedField({
      id: "season-name",
      label: "Season name",
      placeholder: "2026 Season",
      required: true,
    })}${renderInputField({
      id: "season-start",
      label: "Start date",
      type: "date",
    })}${renderInputField({
      id: "season-end",
      label: "End date",
      type: "date",
    })}${renderAdditionalOptions(`${renderValidatedField({
      id: "season-friendly-url",
      label: "Friendly URL",
      placeholder: "2026-season",
    })}<dl data-ui="id-preview"><div><dt>Season ID</dt><dd id="season-id-display">Not generated yet</dd></div></dl>`)}`,
    `<div data-ui="button-row">${renderButton("Create season", "primary", {
      type: "submit",
      "data-action": "create-season",
      "data-testid": "create-season",
      "data-management-only": "",
      disabled: "",
    })}${renderFormCancel()}</div>`,
    "panel-league-create-season",
  );

  const seasonsPanel = renderPanel(
    "Seasons",
    "",
    renderTableShell({
      tableTestId: "league-seasons-table",
      bodyId: "league-seasons-body",
      emptyId: "league-seasons-empty",
      emptyText: "No seasons yet.",
      headers: ["Season name", "Dates", "Actions"],
      tableLabel: "Seasons",
      emptyInitiallyHidden: true,
    }),
    "",
    "panel-league-seasons",
  );

  const organiserInvitePanel = renderPanel(
    "Invite organiser",
    "Share the link or code below or send an invite via email.",
    `<section data-ui="section-stack" aria-labelledby="organiser-share-invite-heading">
      <h3 id="organiser-share-invite-heading">Share invite</h3>
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
        hint: "Only this email address can accept.",
        inputAttributes: { autocomplete: "email", inputmode: "email", autocapitalize: "none" },
      })}
    </section>`,
    `<div data-ui="button-row">${renderButton("Send email invite", "primary", {
      type: "submit",
      "data-action": "create-organiser-invite",
      "data-testid": "create-organiser-invite",
      "data-management-only": "",
      disabled: "",
    })}${renderFormCancel()}</div>`,
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
        ${renderManagementNavigation()}
        <nav data-ui="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="/setup">Home</a></li><li><span id="league-breadcrumb-name" aria-current="page">League</span></li></ol></nav>
        <div data-ui="hero-title-row">
          <h1 id="league-title">League</h1>
        </div>
        <details data-ui="reference-details"><summary>Reference ID</summary><small data-ui="reference-id" id="league-reference">League ID: ${safeLeagueId || "Loading…"}</small></details>
        <div data-ui="header-actions" role="group" aria-label="League actions">
          ${renderActionMenu({
            id: "league-actions",
            label: "Actions for this league",
            attributes: { "data-management-only": "", hidden: "" },
            content: renderIconButton({
            icon: "calendar-plus",
            label: "Create season",
            text: "Create season",
            attributes: {
              "data-management-only": "", hidden: "", disabled: "",
              "data-action": "toggle-create-season",
              "data-testid": "toggle-create-season",
              "aria-controls": "league-create-season-region",
              "aria-expanded": "false",
            },
          }) + renderIconButton({
            icon: "user-round-plus",
            label: "Invite organiser",
            text: "Invite organiser",
            attributes: {
              "data-management-only": "", hidden: "", disabled: "",
              "data-action": "toggle-organiser-invite",
              "data-testid": "toggle-organiser-invite",
              "aria-controls": "league-organiser-invite-region",
              "aria-expanded": "false",
            },
          }) + renderIconButton({
              icon: "trash-2",
              label: "Delete league",
              text: "Delete league",
              variant: "danger",
              attributes: {
                "data-action": "delete-league",
                "data-testid": "delete-league",
                "data-management-only": "", disabled: "",
              },
            }),
          })}
        </div>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="league" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-league-id="${safeLeagueId}">
        ${renderActivityStatus("Loading league data…")}
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-stack" data-testid="league-grid">
          ${seasonsPanel}
          <section id="league-create-season-region" data-ui="disclosure-panel" hidden>
            <form id="create-season-form" data-ui="management-form" aria-label="Create season" novalidate>${createSeasonPanel}</form>
          </section>
          <section id="league-organiser-invite-region" data-ui="disclosure-panel" hidden>
            <form id="organiser-invite-form" data-ui="management-form" aria-label="Invite organiser" novalidate>${organiserInvitePanel}</form>
          </section>
          <p data-ui="status-note" id="organiser-invite-email-status" role="status" aria-live="polite" hidden></p>
        </section>
      </section>
    </main>
    ${renderSetupScriptTag()}
  </body>
</html>`;
}

export function renderInvitePage(apiBaseUrl: string, inviteCode: string): string {
  const safeInviteCode = escapeHtml(inviteCode.trim().toUpperCase());
  const hasCode = safeInviteCode.length > 0;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Organiser Invite</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}" data-return-target-patterns="${renderAuthReturnTargetPatterns()}">
    <main data-ui="app-shell" data-testid="invite-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero" data-layout="auth">
        ${renderAccountActions()}
        <h1>Organiser invite</h1>
        <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="invite" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-invite-code="${safeInviteCode}">
        ${renderActivityStatus("Checking sign-in state…")}
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <div data-testid="panel-organiser-invite">
            <form data-ui="auth-form" id="organiser-invite-code-form" ${hasCode ? "hidden" : ""} novalidate>
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
                <div><dt>Invite code</dt><dd id="organiser-invite-accept-code">${safeInviteCode}</dd></div>
              </dl>
              <div data-ui="button-row">
                ${renderButton("Accept invite", "primary", {
                  type: "button",
                  "data-action": "accept-organiser-invite",
                  "data-testid": "accept-organiser-invite",
                })}
                <a data-ui="button-secondary" id="organiser-invite-league-link" data-testid="organiser-invite-league-link" href="/setup" hidden>Open league</a>
              </div>
            </section>
        </div>
        </section>
      </section>
    </main>
    ${renderAuthScriptTag()}
    ${renderSetupScriptTag()}
  </body>
</html>`;
}

export function renderSeasonPage(apiBaseUrl: string, seasonId: string, leagueId = ""): string {
  const safeSeasonId = escapeHtml(seasonId);
  const safeLeagueId = escapeHtml(leagueId);
  const createGamePanel = renderPanel(
    "Create game",
    "",
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
      type: "submit",
      "data-action": "create-game",
      "data-testid": "create-game",
      "data-management-only": "", disabled: "",
    })}${renderFormCancel()}</div>`,
    "panel-season-create-game",
  );

  const upcomingGamesPanel = renderPanel(
    "Upcoming games",
    "",
    renderTableShell({
      tableTestId: "season-upcoming-games-table",
      bodyId: "season-upcoming-games-body",
      emptyId: "season-upcoming-games-empty",
      emptyText: "No upcoming games.",
      headers: ["Date", "Status", "Actions"],
      tableLabel: "Upcoming games",
      emptyInitiallyHidden: true,
    }),
    "",
    "panel-season-upcoming-games",
  );

  const completedGamesPanel = renderPanel(
    "Completed games",
    "",
    renderTableShell({
      tableTestId: "season-completed-games-table",
      bodyId: "season-completed-games-body",
      emptyId: "season-completed-games-empty",
      emptyText: "No completed games.",
      headers: ["Date", "Status", "Actions"],
      tableLabel: "Completed games",
      emptyInitiallyHidden: true,
    }),
    "",
    "panel-season-completed-games",
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
        ${renderManagementNavigation()}
        <nav data-ui="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="/setup">Home</a></li><li><a id="season-league-link"${safeLeagueId ? ` href="/leagues/${encodeURIComponent(leagueId)}"` : ""}>League</a></li><li><span id="season-breadcrumb-name" aria-current="page">Season</span></li></ol></nav>
        <div data-ui="hero-title-row">
          <h1 id="season-title">Season</h1>
        </div>
        <details data-ui="reference-details"><summary>Reference ID</summary><small data-ui="reference-id" id="season-reference">Season ID: ${safeSeasonId || "Loading…"}</small></details>
        <div data-ui="header-actions" role="group" aria-label="Season actions">
          ${renderIconButton({
            icon: "calendar-plus",
            label: "Create game",
            text: "Create game",
            variant: "primary",
            attributes: {
              "data-management-only": "", hidden: "", disabled: "",
              "data-action": "toggle-create-game",
              "data-testid": "toggle-create-game",
              "aria-controls": "season-create-game-region",
              "aria-expanded": "false",
            },
          })}
          ${renderActionMenu({
            id: "season-actions",
            label: "Actions for this season",
            attributes: { "data-management-only": "", hidden: "" },
            content: renderIconButton({
              icon: "trash-2",
              label: "Delete season",
              text: "Delete season",
              variant: "danger",
              attributes: {
                "data-action": "delete-season",
                "data-testid": "delete-season",
                "data-management-only": "", disabled: "",
              },
            }),
          })}
        </div>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="season" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-season-id="${safeSeasonId}" data-league-id="${safeLeagueId}">
        ${renderActivityStatus("Loading season data…")}
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-stack" data-testid="season-grid">
          ${upcomingGamesPanel}
          ${completedGamesPanel}
          <section id="season-create-game-region" data-ui="disclosure-panel" hidden>
            <form id="create-game-form" data-ui="management-form" aria-label="Create game" novalidate>${createGamePanel}</form>
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
    <title>Sign in to 3FC</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}" data-return-target-patterns="${renderAuthReturnTargetPatterns()}">
    <main data-ui="app-shell" data-testid="signin-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero" data-layout="auth" data-testid="panel-signin-flow">
        <h1>Sign in to 3FC</h1>
        <form data-ui="auth-form" id="auth-magic-form" novalidate>
          <input id="auth-return-to" type="hidden" value="${safeReturnTo}" />
          ${renderValidatedField({
            id: "auth-email",
            label: "Email address",
            type: "email",
            placeholder: "you@example.com",
            required: true,
            inputAttributes: {
              autocomplete: "email",
              inputmode: "email",
              autocapitalize: "none",
              spellcheck: "false",
            },
          })}
          <div data-ui="button-row">${renderButton("Send sign-in link", "primary", {
            type: "submit",
            "data-action": "send-magic-link",
            "data-testid": "send-magic-link",
          })}</div>
        </form>
        <p data-ui="status-note" id="auth-status" role="status" aria-live="polite" hidden></p>
        <p data-ui="status-note" data-state="error" id="auth-error" role="alert" hidden></p>
      </section>
    </main>
    ${renderAuthScriptTag()}
  </body>
</html>`;
}

export function renderComponentShowcasePage(apiBaseUrl: string): string {
  const navigationPanel = renderPanel(
    "Component examples",
    "Development fixtures only. These names, dates and scores are examples; no account or game data is loaded or saved.",
    renderNavigation(
      [
        { label: "Controls", href: "#fixture-controls" },
        { label: "Players", href: "#fixture-players" },
        { label: "Match totals", href: "#fixture-totals" },
        { label: "Feedback", href: "#fixture-feedback" },
      ],
      "component-nav",
    ),
    "",
    "panel-navigation",
  );

  const playersPanel = renderPanel(
    "Players and team choices",
    "Try choosing a team. Yellow is unavailable in this example.",
    `<div data-ui="player-grid" data-testid="player-grid">${[
      renderPlayerCard({ name: "Ari Fisher", subtitle: "Red Team" }, "player-ari"),
      renderPlayerCard({ name: "Mina G", subtitle: "Blue Team" }, "player-mina"),
      renderPlayerCard({ name: "Alexandra van der Westhuizen-Smith", subtitle: "Yellow Team" }, "player-chris"),
    ].join("")}</div>
    <fieldset data-ui="field">
      <legend>Example team</legend>
      <div data-ui="button-row" data-testid="fixture-team-choices">
        <label data-ui="team-chip" style="--team-color: #d43d3d"><input type="radio" name="fixture-team" value="red" checked /><span data-ui="team-chip-visual"><span>Red</span></span></label>
        <label data-ui="team-chip" style="--team-color: #377cd6"><input type="radio" name="fixture-team" value="blue" /><span data-ui="team-chip-visual"><span>Blue</span></span></label>
        <label data-ui="team-chip" style="--team-color: #d6ad22"><input type="radio" name="fixture-team" value="yellow" disabled /><span data-ui="team-chip-visual"><span>Yellow</span></span></label>
      </div>
    </fieldset>
    <div data-ui="button-row" data-testid="fixture-claim-badges">
      <span data-ui="claim-badge" data-state="unclaimed" role="img" aria-label="Not claimed" title="Not claimed">${renderIcon("circle-user-round")}</span>
      <span data-ui="claim-badge" data-state="claimed" role="img" aria-label="Claimed" title="Claimed">${renderIcon("user-round-check")}</span>
    </div>`,
    "",
    "panel-player",
  );

  const tablePanel = renderPanel(
    "Match totals",
    "",
    `${renderDataTable({
      tableId: "fixture-match-totals",
      caption: "Example finished game",
      columns: ["Team", "Conceded", "Scored"],
      rows: [
        ["Red", 2, 4],
        ["Blue", 4, 3],
        ["Yellow", 3, 2],
      ],
    })}
    <div data-ui="button-row" data-testid="fixture-status-chips">
      <span data-ui="status-chip" data-status="scheduled">${renderIcon("calendar-clock")}<span>Scheduled</span></span>
      <span data-ui="status-chip" data-status="live">${renderIcon("activity")}<span>Live</span></span>
      <span data-ui="status-chip" data-status="finished">${renderIcon("circle-check")}<span>Finished</span></span>
    </div>
    <div data-ui="button-row" data-testid="fixture-thirds">
      ${[1, 2, 3].map((third) => `<span data-ui="third-indicator" data-third="${third}" role="img" aria-label="Third ${third} of 3"></span>`).join("")}
    </div>`,
    "",
    "panel-table",
  );

  const validationPanel = renderPanel(
    "Validation and feedback",
    "Example states, shown together for review.",
    `<div data-ui="validation-stack">
      <section data-ui="validation-card" data-state="invalid" data-testid="validation-invalid">
        <h3>Invalid email example</h3>
        ${renderValidatedField({
          id: "organizer-email-invalid",
          label: "Organiser email",
          type: "email",
          value: "player-at-example.com",
          error: "Please provide a valid email address.",
        })}
      </section>
      <section data-ui="validation-card" data-state="valid" data-testid="validation-valid">
        <h3>Valid email example</h3>
        ${renderValidatedField({
          id: "organizer-email-valid",
          label: "Organiser email",
          type: "email",
          value: "organiser@example.com",
          success: "Email format looks valid.",
        })}
      </section>
    </div>
    <div data-ui="section-stack" data-testid="fixture-feedback-states">
      <p data-ui="status-note" data-state="loading" role="status">Loading games…</p>
      <p data-ui="status-note" data-state="success" role="status">Player added.</p>
      <p data-ui="status-note" data-state="error">Couldn’t load the teams. Try again.</p>
      <p data-ui="status-note" data-state="uncertain">We couldn’t confirm whether the goal was saved. Your details are still here.</p>
      <p data-ui="status-note" data-state="empty">No upcoming games.</p>
    </div>`,
    "",
    "panel-validation",
  );

  const rowActionsPanel = renderPanel(
    "Actions",
    "Action examples open the confirmation prompt below. They do not change a game.",
    `${renderRowActionList(
      [
        {
          title: "Sunday 13 September 2026",
          subtitle: "9:30 am · North Melbourne Three-Sided Football Club",
          actions: [],
        },
        {
          title: "Sunday 20 September 2026",
          subtitle: "9:30 am · Spring 2026",
          actions: [],
        },
      ],
      "game-row-actions",
    )}
    <div data-ui="button-row" data-testid="fixture-button-variants">
      ${(["primary", "secondary", "ghost", "danger"] as const).map((variant) => renderButton(`${variant[0]?.toUpperCase()}${variant.slice(1)} example`, variant, { type: "button", "data-modal-open": "confirm-delete-game" })).join("")}
    </div>
    <div data-ui="header-actions" role="group" aria-label="Example icon actions">
      ${renderIconLink({ href: "#fixture-totals", icon: "eye", label: "View example match totals" })}
      ${renderIconButton({ icon: "pencil", label: "Open example edit prompt", attributes: { "data-modal-open": "confirm-delete-game" } })}
      ${renderIconButton({ icon: "trash-2", label: "Open example delete prompt", variant: "danger", attributes: { "data-modal-open": "confirm-delete-game" } })}
    </div>
    <div data-ui="button-row" data-testid="fixture-disabled-actions">
      ${renderButton("Save", "primary", { type: "button", disabled: "", "aria-label": "Save example, disabled" })}
      ${renderIconButton({ icon: "loader-circle", label: "Saving example", text: "Saving…", variant: "primary", attributes: { disabled: "", "aria-busy": "true" } })}
    </div>`,
    "",
    "panel-row-actions",
  );

  const modalPanel = renderPanel(
    "Confirmation prompt",
    "Open, confirm, cancel or press Escape. No data is changed.",
    `${renderModalPrompt({
      id: "confirm-delete-game",
      triggerLabel: "Open example prompt",
      title: "Delete example game?",
      message: "This is a component example. Confirming will not delete a game.",
      cancelLabel: "Cancel",
      confirmLabel: "Confirm example",
    })}<p data-ui="status-note" id="modal-note" role="status"></p>`,
    "",
    "panel-modal",
  );

  const setupFoundationPanel = renderPanel(
    "Form controls",
    "Try the native controls. These example values are not submitted.",
    renderSetupFoundationPanels(),
    "",
    "panel-setup-composition",
  );

  const hiddenStatesPanel = renderPanel(
    "Hidden states",
    "The form, claim panel and reference IDs below must remain invisible and out of the keyboard order.",
    `<div data-ui="auth-form" data-testid="fixture-hidden-auth-form" hidden>${renderInputField({ id: "fixture-hidden-email", label: "Hidden email", type: "email" })}</div>
    <section data-ui="claim-panel" data-testid="fixture-hidden-claim-panel" hidden>${renderButton("Hidden claim action", "primary", { type: "button" })}</section>
    <dl data-ui="id-preview" data-testid="fixture-hidden-id-preview" hidden><div><dt>Example game ID</dt><dd>fixture-hidden-game</dd></div></dl>`,
    "",
    "panel-hidden-states",
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
      <section data-ui="hero"><h1>Design fixtures</h1></section>
      <div data-ui="section-stack">
        ${navigationPanel}
        <section data-ui="panel-grid" data-testid="component-grid">
          <section id="fixture-controls" tabindex="-1">${rowActionsPanel}${setupFoundationPanel}</section>
          <section id="fixture-players" tabindex="-1">${playersPanel}</section>
          <section id="fixture-totals" tabindex="-1">${tablePanel}</section>
          <section id="fixture-feedback" tabindex="-1">${validationPanel}</section>
          <section id="fixture-modal" tabindex="-1">${modalPanel}</section>
          <section id="fixture-hidden-states" tabindex="-1">${hiddenStatesPanel}</section>
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
    <meta name="referrer" content="no-referrer" />
    <title>Complete your sign-in | 3FC</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}" data-return-target-patterns="${renderAuthReturnTargetPatterns()}">
    <main data-ui="app-shell" data-testid="auth-callback-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero" data-layout="auth">
        <h1 id="auth-callback-title">Complete your sign-in</h1>
        <p data-ui="hero-copy" id="auth-callback-copy">Sign-in starts in a few seconds. Or continue below.</p>
        <div data-ui="button-row">
          ${renderButton("Complete sign-in", "primary", {
            type: "button",
            "data-action": "complete-magic-link",
            "data-testid": "complete-magic-link",
            hidden: "hidden",
          })}
        </div>
        <p class="sr-only" id="auth-callback-status" role="status" aria-live="polite" hidden></p>
        <p data-ui="status-note" data-state="error" id="auth-callback-error" role="alert" hidden></p>
        <a data-ui="button-secondary" id="auth-callback-recovery" href="/sign-in" hidden>Return to sign in</a>
      </section>
    </main>
    ${renderAuthScriptTag()}
  </body>
</html>`;
}

export function renderJoinPage(apiBaseUrl: string, joinCode: string): string {
  const safeJoinCode = escapeHtml(joinCode);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Join</title>
    ${renderStylesheetLink()}
  </head>
  <body data-api-base-url="${escapeHtml(apiBaseUrl)}" data-return-target-patterns="${renderAuthReturnTargetPatterns()}">
    <main data-ui="app-shell" data-testid="join-shell" data-api-base-url="${escapeHtml(apiBaseUrl)}">
      <section data-ui="hero" data-layout="auth">
        ${renderAccountActions()}
        <h1>Join game</h1>
        <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="join" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-join-code="${safeJoinCode}">
        ${renderActivityStatus("", false)}
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <div data-testid="panel-join-player">
            <dl data-ui="id-preview" data-testid="join-context-details">
              <div><dt>Join code</dt><dd id="join-code-value" data-testid="join-code-value">${safeJoinCode}</dd></div>
            </dl>
            <form data-ui="auth-form" id="join-game-form" novalidate>
              ${renderValidatedField({
                id: "join-player-nickname",
                label: "Player name",
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
            <dl data-ui="join-receipt" data-testid="join-result" id="join-result" hidden>
              <div><dt>Player</dt><dd id="join-result-player"></dd></div>
            </dl>
            <section data-ui="claim-panel" data-testid="join-claim-actions" id="join-claim-actions" hidden>
              <p data-ui="field-hint" id="join-claim-status" hidden></p>
              <div data-ui="button-row">
                <a data-ui="button-secondary" id="join-signin-link" data-testid="join-signin-link" href="/sign-in">Sign in to claim this player</a>
                ${renderButton("Claim player", "primary", {
                  type: "button",
                  "data-action": "claim-player",
                  "data-testid": "claim-player",
                  "aria-describedby": "join-result-player",
                })}
                ${renderButton("Retry lookup", "secondary", {
                  type: "button",
                  "data-action": "retry-join-context",
                  hidden: "",
                })}
              </div>
            </section>
            ${renderButton("Join another player", "secondary", {
              type: "button", "data-action": "join-another-player",
              "data-testid": "join-another-player", hidden: "",
            })}
        </div>
        </section>
      </section>
    </main>
    ${renderAuthScriptTag()}
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
  destination: "overview" | "teams" | "score" | "results";
  active?: boolean;
}): string {
  const tabId = `game-mode-tab-${input.mode}`;
  return `<a data-ui="game-mode-tab" id="${tabId}"${input.mode === "run" ? ' data-mode-href="#score" aria-disabled="true"' : ` href="#${input.destination}"`}${input.active ? ' aria-current="page"' : ""} data-action="select-game-mode" data-game-mode="${input.mode}" data-state="${input.active ? "active" : "idle"}" data-testid="game-mode-${input.mode}-tab"${input.mode === "final" || input.mode === "run" ? " hidden" : ""}${input.mode === "run" ? ' data-game-capability="score"' : ""}>
    <span data-mode-label="${input.mode}">${escapeHtml(input.label)}</span>
  </a>`;
}

export function renderGamePage(apiBaseUrl: string, input: GameContextPageInput): string {
  const gameId = escapeHtml(input.gameId);
  const gameHeading = "Game";
  const gameDetailsPanel = renderPanel(
    "Overview",
    "",
    `<dl data-ui="game-overview">
      <div><dt>Kickoff</dt><dd id="game-overview-kickoff">Loading…</dd></div>
      <div><dt>Status</dt><dd id="game-overview-status">Loading…</dd></div>
      <div><dt>Third length</dt><dd id="game-overview-third-length">Loading…</dd></div>
    </dl>
    <div data-ui="game-overview-actions">
      ${renderIconButton({
        icon: "pencil", label: "Edit game", text: "Edit game",
        attributes: {
          "data-action": "toggle-game-edit", "data-game-capability": "admin", hidden: "", disabled: "",
          "aria-expanded": "false", "aria-controls": "game-edit-region",
        },
      })}
      ${renderIconButton({
        icon: "users", label: "View teams", text: "View teams",
        attributes: {
          "data-action": "select-game-mode", "data-game-mode": "players", "data-testid": "game-mode-next-players",
        },
      })}
    </div>
    <div id="game-edit-region" data-ui="disclosure-panel" hidden>
      <form id="game-edit-form" data-ui="management-form" aria-label="Edit game" novalidate>
        <div data-ui="game-fields">
          ${renderValidatedField({
            id: "game-edit-kickoff", label: "Kickoff time", type: "datetime-local", required: true,
          })}
          <div data-ui="field">
            <label for="game-edit-status">Status</label>
            <select id="game-edit-status" name="game-edit-status" data-ui="input" data-testid="game-edit-status">
              <option value="scheduled">Scheduled</option>
              <option value="live">Live</option>
              <option value="finished" disabled>Finished</option>
            </select>
          </div>
          <div data-ui="field">
            <label for="game-edit-third-length">Third length</label>
            <select id="game-edit-third-length" name="game-edit-third-length" data-ui="input" data-testid="game-edit-third-length">
              <option value="20">20 minutes</option>
              <option value="25">25 minutes</option>
              <option value="30">30 minutes</option>
            </select>
          </div>
        </div>
        <div data-ui="game-details-actions">
          <button type="submit" data-ui="icon-button" data-variant="primary" aria-label="Save game" data-action="save-game" data-testid="save-game">${renderIcon("save")}<span data-ui="button-text">Save</span></button>
          ${renderButton("Cancel", "ghost", { type: "button", "data-action": "cancel-game-edit" })}
        </div>
      </form>
    </div>
    <details data-ui="join-disclosure">
      <summary>Join game</summary>
      <section data-ui="join-details" data-testid="game-join-details" aria-label="Join game details">
      <div data-ui="join-qr-block">
        <h3>Join QR</h3>
        <div id="game-join-qr" data-ui="join-qr" data-testid="game-join-qr">Loading…</div>
      </div>
      <dl data-ui="join-copy">
        <div><dt>Join code</dt><dd id="game-join-code-value" data-testid="game-join-code-value">Loading…</dd></div>
        <div><dt>Join link</dt><dd><a id="game-join-link" data-testid="game-join-link" href="/join">Loading…</a></dd></div>
      </dl>
      </section>
    </details>
    <details data-ui="reference-ids" data-testid="game-reference-ids">
      <summary>Reference IDs</summary>
      <dl data-ui="id-preview" data-testid="game-context-details">
        <div><dt>Game ID</dt><dd id="game-id-value">${gameId || "Loading…"}</dd></div>
        <div><dt>League ID</dt><dd id="game-league-id">Loading…</dd></div>
        <div><dt>Season ID</dt><dd id="game-season-id">Loading…</dd></div>
      </dl>
    </details>`,
    "",
    "panel-game-details",
  );
  const timerPanel = `<section data-ui="run-timer-panel" data-testid="panel-game-timer" aria-labelledby="run-timer-heading">
    <h2 id="run-timer-heading" class="sr-only">Clock</h2>
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
          ${renderButton("Refresh game", "secondary", {
            type: "button", hidden: "", disabled: "",
            "data-action": "refresh-game-state", "data-testid": "refresh-game-state",
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
    "Teams",
    "",
    `<div data-ui="roster-actions">
      ${renderIconButton({
        icon: "circle-plus", label: "Add player", text: "Add player", variant: "primary",
        attributes: {
          "data-action": "toggle-player-create", "data-game-capability": "roster", hidden: "", disabled: "",
          "aria-expanded": "false", "aria-controls": "player-create-region", "data-hide-when-expanded": "",
        },
      })}
      ${renderIconButton({
        icon: "pencil", label: "Edit teams", text: "Edit teams",
        attributes: { "data-action": "edit-finished-teams", "data-game-capability": "correct", hidden: "", disabled: "" },
      })}
    </div>
    <div id="player-create-region" data-ui="disclosure-panel" hidden>
      <form id="player-create-form" data-ui="management-form" aria-label="Add player" novalidate>
        <div data-ui="inline-create" data-testid="player-create-row">
          <div data-ui="field" data-validated="true">
            <label for="player-nickname">Player name</label>
            <input data-ui="input" data-state="default" id="player-nickname" name="player-nickname" type="text" placeholder="Ari" autocomplete="off" aria-describedby="player-nickname-notice" />
            <div data-ui="field-message"><p data-ui="field-hint" id="player-nickname-notice" data-default-message="" data-default-kind="empty"></p></div>
          </div>
        </div>
        <div data-ui="game-details-actions">
          <button type="submit" data-ui="icon-button" data-variant="primary" aria-label="Add player" data-action="quick-create-player" data-testid="quick-create-player">${renderIcon("circle-plus")}<span data-ui="button-text">Add player</span></button>
          ${renderButton("Cancel", "ghost", { type: "button", "data-action": "cancel-player-create" })}
        </div>
      </form>
    </div>
    <div data-ui="field">
      <label for="player-search">Search players</label>
      <input data-ui="input" id="player-search" name="player-search" type="search" autocomplete="off" />
    </div>
    <div data-ui="roster-workspace" data-testid="roster-workspace">
      <section data-ui="player-pool" aria-labelledby="player-pool-title">
        <h3 id="player-pool-title">Unassigned</h3>
        <div id="player-pool" data-ui="player-list" data-testid="player-pool"></div>
      </section>
      <section data-ui="roster-board" aria-labelledby="roster-board-title">
        <h3 id="roster-board-title">Teams</h3>
        <div id="roster-teams" data-ui="roster-grid" data-testid="roster-teams"></div>
      </section>
    </div>`,
    "",
    "panel-game-roster",
  );
  const scorePanel = `<div data-ui="run-score-strip" data-testid="run-score-strip" role="group" aria-label="Team scores">
    <div data-ui="live-scoreboard" id="live-scoreboard" data-testid="live-scoreboard"></div>
  </div>`;
  const livePanel = `<div data-ui="run-scoring-panel" data-testid="panel-game-live">
    <section data-ui="run-primary-scoring" data-testid="run-primary-scoring" aria-labelledby="run-goal-form-heading">
      <header>
        <h2 id="run-goal-form-heading">Record goal</h2>
      </header>
      <form id="goal-form" data-ui="run-goal-form" aria-labelledby="run-goal-form-heading" novalidate>
        <label data-ui="check-row" for="goal-own-goal">
          <input id="goal-own-goal" type="checkbox" data-testid="goal-own-goal" />
          <span>Own goal</span>
        </label>
        <fieldset id="goal-scoring-team" data-ui="goal-team-field" data-testid="goal-scoring-team" disabled>
          <legend>Scoring team</legend>
          <div data-ui="goal-team-options"></div>
        </fieldset>
        <fieldset id="goal-conceding-team" data-ui="goal-team-field" data-testid="goal-conceding-team" disabled>
          <legend>Conceding team</legend>
          <div data-ui="goal-team-options"></div>
        </fieldset>
        <div data-ui="field">
          <label for="goal-scorer">Scorer</label>
          <select id="goal-scorer" data-ui="input" data-testid="goal-scorer"></select>
        </div>
        <details id="goal-assists-dropdown" data-ui="run-secondary-scoring" data-testid="goal-assists-dropdown">
          <summary><span>Assists</span><span id="goal-assists-summary" data-ui="assist-summary">Choose assists</span>${renderIcon("chevron-down")}</summary>
          <p data-ui="field-hint">Up to 3 players</p>
          <div id="goal-assists" data-ui="assist-list" data-testid="goal-assists"></div>
        </details>
      <p data-ui="field-hint" id="goal-form-note">Start a third and assign players before scoring.</p>
      <div data-ui="button-row" data-priority="scoring">
        ${renderButton("Record goal", "primary", {
          type: "submit",
          "data-action": "save-goal",
          "data-testid": "add-goal",
        })}
        ${renderButton("Cancel edit", "secondary", {
          type: "button",
          "data-action": "cancel-goal-edit",
          "data-testid": "cancel-goal-edit",
        })}
      </div>
      </form>
    </section>
  </div>`;
  const latestGoalsPanel = `<section data-ui="run-latest-goals" data-testid="run-latest-goals" aria-labelledby="latest-goals-heading">
      <header data-ui="latest-goals-heading">
        <h2 id="latest-goals-heading">Latest goals</h2>
        ${renderButton("Undo last goal", "secondary", {
          type: "button", "data-action": "undo-last-goal", "data-testid": "undo-last-goal",
        })}
      </header>
      <ol id="goal-timeline" data-ui="goal-timeline" data-testid="goal-timeline"></ol>
    </section>`;
  const finalPanel = renderPanel(
    "Match summary",
    "",
    `<div data-ui="finalisation-board" data-testid="finalisation-board">
      <dl data-ui="final-summary-status" data-testid="finalisation-context" hidden>
        <div><dt>Status</dt><dd id="final-game-status">Loading…</dd></div>
      </dl>
      <div data-ui="game-result-summary" id="game-result-summary" data-testid="game-result-summary" hidden></div>
    </div>`,
    `<div data-ui="mode-actions">
      ${renderIconButton({
        icon: "pencil", label: "Correct result", text: "Correct result",
        attributes: {
        "data-action": "correct-finished-result",
        "data-game-capability": "correct", hidden: "", disabled: "",
        "data-testid": "game-mode-back-run",
        },
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
        ${renderManagementNavigation()}
        <nav data-ui="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="/setup">Home</a></li><li><a id="game-league-link">League</a></li><li><a id="game-season-link">Season</a></li><li><span aria-current="page">Game</span></li></ol></nav>
        <div data-ui="hero-title-row">
        <h1 id="game-title">${gameHeading}</h1>
        ${renderActionMenu({
          id: "game-actions",
          label: "Actions for this game",
          attributes: { "data-game-capability": "admin", hidden: "" },
          content: `${renderIconLink({
            href: "/setup",
            icon: "calendar-plus",
            label: "Create another game",
            text: "Create another game",
            attributes: {
              id: "create-another-game-link",
              "data-testid": "create-another-game",
            },
          })}
          ${renderIconButton({
            icon: "trash-2",
            label: "Delete game",
            text: "Delete game",
            variant: "danger",
            attributes: {
              "data-action": "delete-game",
              "data-testid": "delete-game",
              disabled: "disabled",
            },
          })}
          <p data-ui="field-hint" id="game-delete-lock-reason" hidden>Finished games can’t be deleted.</p>`,
        })}
        </div>
        <p data-ui="hero-copy" id="game-subtitle" hidden></p>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="game" data-api-base-url="${escapeHtml(apiBaseUrl)}" data-game-id="${gameId}">
        ${renderActivityStatus("Loading game data…")}
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <nav data-ui="game-mode-nav" data-testid="game-mode-nav" aria-label="Game">
          <div data-ui="game-mode-tabs">
            ${renderGameModeTab({ mode: "structure", label: "Overview", destination: "overview", active: true })}
            ${renderGameModeTab({ mode: "players", label: "Teams", destination: "teams" })}
            ${renderGameModeTab({ mode: "run", label: "Score game", destination: "score" })}
            ${renderGameModeTab({ mode: "final", label: "Results", destination: "results" })}
          </div>
        </nav>
        <section data-ui="game-mode-panels" data-testid="game-grid">
          <section data-ui="game-mode-panel" id="game-mode-structure" aria-labelledby="game-mode-tab-structure" data-game-mode="structure" data-testid="game-mode-structure">
            ${gameDetailsPanel}
          </section>
          <section data-ui="game-mode-panel" id="game-mode-players" aria-labelledby="game-mode-tab-players" data-game-mode="players" data-testid="game-mode-players" hidden>
            ${rosterPanel}
          </section>
          <section data-ui="game-mode-panel" id="game-mode-run" aria-labelledby="game-mode-tab-run" data-game-mode="run" data-testid="game-mode-run" data-mode-layout="run" hidden>
            <section id="finished-correction-actions" data-ui="correction-actions" aria-labelledby="finished-correction-heading" hidden>
              <h2 id="finished-correction-heading">Correct result</h2>
              ${renderButton("Exit correction", "secondary", {
                type: "button", "data-action": "exit-result-correction",
                "aria-describedby": "correction-exit-reason",
              })}
              <p id="correction-exit-reason" data-ui="field-hint" hidden>Resolve the pending goal change before exiting correction. You can still view Overview, Teams or Results.</p>
            </section>
            <div data-ui="run-console" data-testid="run-console">
              <section data-ui="run-match-summary" data-testid="run-match-summary" aria-label="Score and clock">
                ${scorePanel}
                ${timerPanel}
              </section>
              <section id="goal-operation-recovery" data-ui="run-recovery" aria-label="Goal recovery" hidden>
                <p id="goal-operation-note">Retry uses the original goal change.</p>
                ${renderButton("Retry goal save", "secondary", {
                  type: "button", hidden: "", disabled: "",
                  "data-action": "retry-goal-operation", "data-testid": "retry-goal-operation",
                  "aria-describedby": "goal-operation-note",
                })}
              </section>
              ${livePanel}
              ${latestGoalsPanel}
            </div>
            <div data-ui="mode-actions">
              ${renderButton("Finish game", "primary", {
                type: "button", "data-action": "finish-game", "data-testid": "finish-game",
                "data-game-capability": "score", hidden: "", disabled: "",
              })}
            </div>
          </section>
          <section data-ui="game-mode-panel" id="game-mode-final" aria-label="Match summary" data-game-mode="final" data-testid="game-mode-final" hidden>
            ${finalPanel}
          </section>
        </section>
      </section>
    </main>
    ${renderSetupScriptTag()}
  </body>
</html>`;
}
