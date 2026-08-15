import assert from "node:assert/strict";
import test from "node:test";

import {
  renderComponentShowcasePage,
  renderGamePage,
  renderJoinPage,
  renderLeaguePage,
  renderMagicLinkCallbackPage,
  renderSeasonPage,
  renderSignInPage,
  renderSetupHomePage,
} from "../ui/layout.js";
import {
  renderButton,
  renderDataTable,
  renderIcon,
  renderIconButton,
  renderIconLink,
  renderInputField,
  renderModalPrompt,
  renderNavigation,
  renderPanel,
  renderPlayerCard,
  renderRowActionList,
  renderStepChip,
  renderValidatedField,
} from "../ui/primitives.js";

test("primitives render expected semantic and data-ui hooks", () => {
  const button = renderButton("Continue", "danger");
  const chip = renderStepChip({ label: "1. League", state: "active" });
  const field = renderInputField({
    id: "league-name",
    label: "League name",
    placeholder: "Three FC",
    required: true,
  });
  const validatedField = renderValidatedField({
    id: "organizer-email",
    label: "Organizer email",
    type: "email",
    value: "bad-email",
    error: "Please provide a valid email address.",
  });
  const nav = renderNavigation([{ label: "Setup", href: "/setup", active: true }], "test-nav");
  const player = renderPlayerCard({ name: "Ari Fisher", subtitle: "Red Team" }, "player-ari");
  const table = renderDataTable({
    columns: ["Team", "W"],
    rows: [["Red", 3]],
    tableId: "table-standings",
  });
  const actions = renderRowActionList(
    [{ title: "Game 01", actions: [{ label: "Delete", action: "delete", tone: "danger" }] }],
    "row-actions",
  );
  const modal = renderModalPrompt({
    id: "delete-game",
    triggerLabel: "Open prompt",
    title: "Delete?",
    message: "Confirm delete.",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
  });
  const panel = renderPanel("League setup", "Description", field, button);
  const icon = renderIcon("circle-plus");
  const iconButton = renderIconButton({ icon: "trash-2", label: "Delete league" });
  const iconLink = renderIconLink({ href: "/leagues/league-1", icon: "eye", label: "View league" });

  assert.match(button, /data-ui="button"/);
  assert.match(button, /data-variant="danger"/);
  assert.match(chip, /data-ui="step-chip"/);
  assert.match(chip, /data-state="active"/);
  assert.match(field, /data-ui="input"/);
  assert.match(validatedField, /data-state="invalid"/);
  assert.match(validatedField, /data-ui="field-message"/);
  assert.match(validatedField, /role="alert"/);
  assert.match(nav, /data-testid="test-nav"/);
  assert.match(nav, /data-ui="nav"/);
  assert.match(player, /data-testid="player-ari"/);
  assert.match(player, /data-ui="player-card"/);
  assert.match(table, /data-testid="table-standings"/);
  assert.match(table, /data-ui="data-table"/);
  assert.match(actions, /data-testid="row-actions"/);
  assert.match(actions, /data-ui="row-action"/);
  assert.match(modal, /data-modal-open="delete-game"/);
  assert.match(modal, /data-ui="prompt-overlay"/);
  assert.match(panel, /data-ui="panel"/);
  assert.match(icon, /data-icon="circle-plus"/);
  assert.match(icon, /aria-hidden="true"/);
  assert.match(iconButton, /aria-label="Delete league"/);
  assert.match(iconButton, /title="Delete league"/);
  assert.match(iconLink, /aria-label="View league"/);
  assert.throws(() => renderIcon("missing-icon" as never), /Unsupported icon/);
});

test("setup home page includes stepwise setup panels and setup-flow script", () => {
  const html = renderSetupHomePage("https://qa-api.3fc.football");

  assert.match(html, /data-testid="setup-flow-root"/);
  assert.match(html, /data-page="dashboard"/);
  assert.match(html, /data-testid="panel-dashboard-create-league"/);
  assert.match(html, /data-testid="panel-dashboard-leagues"/);
  assert.match(html, /id="dashboard-welcome">Welcome</);
  assert.match(html, /id="setup-status" role="status" aria-live="polite"/);
  assert.match(html, /id="setup-error" role="status" aria-live="polite" hidden/);
  assert.doesNotMatch(html, /API target/);
  assert.doesNotMatch(html, /3FC ORGANIZER/i);
  assert.match(html, /data-testid="toggle-create-league"/);
  assert.match(html, /aria-controls="dashboard-create-league-region"/);
  assert.match(html, /id="dashboard-create-league-region" data-ui="disclosure-panel" hidden/);
  assert.ok(html.indexOf('data-testid="panel-dashboard-leagues"') < html.indexOf('data-testid="panel-dashboard-create-league"'));
  assert.match(html, /dashboard-leagues-body/);
  assert.match(html, /data-testid="create-league"/);
  assert.match(html, /id="league-id-display"/);
  assert.match(html, /rel="stylesheet" href="\/ui\/styles\.css"/);
  assert.match(html, /rel="stylesheet" href="\/ui\/icons\.css"/);
  assert.match(html, /data-testid="setup-shell"/);
  assert.match(html, /<script src="\/ui\/setup-flow\.js" defer><\/script>/);
  assert.match(html, /https:\/\/qa-api\.3fc\.football/);
});

test("setup pages can version UI asset URLs for deployments", () => {
  const previousVersion = process.env.THREEFC_ASSET_VERSION;
  process.env.THREEFC_ASSET_VERSION = "abc1234";

  try {
    const setupHtml = renderSetupHomePage("https://qa-api.3fc.football");
    const signInHtml = renderSignInPage("https://qa-api.3fc.football", "/setup");
    const componentHtml = renderComponentShowcasePage("https://qa-api.3fc.football");

    assert.match(setupHtml, /href="\/ui\/styles\.css\?v=abc1234"/);
    assert.match(setupHtml, /href="\/ui\/icons\.css\?v=abc1234"/);
    assert.match(setupHtml, /<script src="\/ui\/setup-flow\.js\?v=abc1234" defer><\/script>/);
    assert.match(signInHtml, /<script src="\/ui\/auth-flow\.js\?v=abc1234" defer><\/script>/);
    assert.match(componentHtml, /<script src="\/ui\/modal\.js\?v=abc1234" defer><\/script>/);
  } finally {
    if (previousVersion === undefined) {
      delete process.env.THREEFC_ASSET_VERSION;
    } else {
      process.env.THREEFC_ASSET_VERSION = previousVersion;
    }
  }
});

test("league page includes season create form and seasons table", () => {
  const html = renderLeaguePage("https://qa-api.3fc.football", "league-1");

  assert.match(html, /data-testid="league-shell"/);
  assert.match(html, /data-page="league"/);
  assert.match(html, /data-league-id="league-1"/);
  assert.match(html, /id="league-reference">League ID: league-1/);
  assert.match(html, /data-testid="toggle-create-season"/);
  assert.match(html, /data-ui="header-actions" role="toolbar" aria-label="League actions"/);
  assert.match(html, /data-testid="toggle-organiser-invite"/);
  assert.match(html, /aria-controls="league-create-season-region"/);
  assert.match(html, /id="league-create-season-region" data-ui="disclosure-panel" hidden/);
  assert.match(html, /Share the link or code below or send an invite via email/);
  assert.doesNotMatch(html, /Share invite ready/);
  assert.match(html, /league-seasons-body/);
  assert.match(html, /data-testid="create-season"/);
  assert.match(html, /data-testid="delete-league"/);
});

test("season page includes game create form and games table", () => {
  const html = renderSeasonPage("https://qa-api.3fc.football", "season-1");

  assert.match(html, /data-testid="season-shell"/);
  assert.match(html, /data-page="season"/);
  assert.match(html, /data-season-id="season-1"/);
  assert.match(html, /id="season-reference">Season ID: season-1/);
  assert.match(html, /data-testid="toggle-create-game"/);
  assert.match(html, /data-ui="header-actions" role="toolbar" aria-label="Season actions"/);
  assert.match(html, /aria-controls="season-create-game-region"/);
  assert.match(html, /id="season-create-game-region" data-ui="disclosure-panel" hidden/);
  assert.doesNotMatch(html, /game-id-display/);
  assert.match(html, /Game date/);
  assert.match(html, /data-testid="game-third-length"/);
  assert.match(html, /season-games-body/);
  assert.match(html, /data-testid="create-game"/);
  assert.match(html, /data-testid="delete-season"/);
});

test("component showcase page includes navigation, players, tables, validation, row actions, and modal", () => {
  const html = renderComponentShowcasePage("https://qa-api.3fc.football");

  assert.match(html, /data-testid="component-showcase"/);
  assert.match(html, /data-testid="panel-navigation"/);
  assert.match(html, /data-testid="panel-player"/);
  assert.match(html, /data-testid="panel-table"/);
  assert.match(html, /data-testid="panel-validation"/);
  assert.match(html, /data-testid="panel-row-actions"/);
  assert.match(html, /data-testid="panel-modal"/);
  assert.match(html, /data-testid="panel-setup-composition"/);
  assert.match(html, /data-testid="validation-invalid"/);
  assert.match(html, /data-testid="validation-valid"/);
  assert.match(html, /Delete game\\?/);
  assert.match(html, /data-modal-open="confirm-delete-game"/);
  assert.match(html, /data-modal-confirm="confirm-delete-game"/);
  assert.match(html, /<script src="\/ui\/modal\.js" defer><\/script>/);
});

test("magic-link callback page includes auth flow script and callback messaging", () => {
  const html = renderMagicLinkCallbackPage("https://qa-api.3fc.football");

  assert.match(html, /data-testid="auth-callback-shell"/);
  assert.match(html, /Complete sign-in/);
  assert.match(html, /data-testid="complete-magic-link"/);
  assert.match(html, /id="auth-callback-status"/);
  assert.match(html, /<script src="\/ui\/auth-flow\.js" defer><\/script>/);
});

test("sign-in page renders magic-link form and carries return path", () => {
  const html = renderSignInPage("https://qa-api.3fc.football", "/setup");

  assert.match(html, /data-testid="signin-shell"/);
  assert.match(html, /data-testid="panel-signin-flow"/);
  assert.match(html, /id="auth-magic-form"/);
  assert.match(html, /id="auth-return-to"/);
  assert.match(html, /value="\/setup"/);
  assert.match(html, /data-testid="send-magic-link"/);
  assert.match(html, /<script src="\/ui\/auth-flow\.js" defer><\/script>/);
});

test("game page renders editable game metadata view", () => {
  const html = renderGamePage("https://qa-api.3fc.football", {
    gameId: "game-20260223-a1b2c3d4",
  });

  assert.match(html, /data-testid="game-shell"/);
  assert.match(html, /data-page="game"/);
  assert.match(html, /game-20260223-a1b2c3d4/);
  assert.match(html, /data-testid="game-join-code-value"/);
  assert.match(html, /data-testid="game-join-link"/);
  assert.match(html, /data-testid="game-join-qr"/);
  assert.match(html, /data-testid="save-game"/);
  assert.match(html, /data-testid="delete-game"/);
  assert.match(html, /data-testid="create-another-game"/);
  assert.match(html, /data-testid="game-mode-nav"/);
  assert.match(html, /data-testid="game-mode-structure-tab"/);
  assert.match(html, /data-testid="game-mode-players-tab"/);
  assert.match(html, /data-testid="game-mode-run-tab"/);
  assert.match(html, /data-testid="game-mode-final-tab"/);
  assert.match(html, /data-mode-label="final"/);
  assert.doesNotMatch(html, /role="tablist"/);
  assert.doesNotMatch(html, /data-testid="game-mode-final-tab"[^>]*role="tab"/);
  assert.doesNotMatch(html, /data-testid="game-mode-final-tab"[^>]*aria-controls=/);
  assert.doesNotMatch(html, /id="game-mode-tab-final"[^>]*role="tab"/);
  assert.doesNotMatch(html, /id="game-mode-tab-final"[^>]*aria-controls=/);
  assert.match(html, /data-testid="game-mode-status"/);
  assert.match(html, /data-testid="game-mode-structure"/);
  assert.match(html, /data-testid="game-mode-players" hidden/);
  assert.match(html, /data-testid="game-mode-run" data-mode-layout="run" hidden/);
  assert.match(html, /data-testid="game-mode-final" hidden/);
  assert.match(html, /data-testid="run-console"/);
  assert.match(html, /data-testid="run-score-strip"/);
  assert.match(html, /data-testid="run-primary-scoring"/);
  assert.match(html, /data-testid="run-timer-bar"/);
  assert.match(html, /data-testid="run-third-history"/);
  assert.match(html, /data-testid="run-latest-goals"/);
  assert.match(html, /data-testid="panel-game-timer"/);
  assert.match(html, /data-testid="third-timer"/);
  assert.match(html, /data-testid="timer-display"/);
  assert.match(html, /data-testid="start-third"/);
  assert.match(html, /data-testid="finish-third"/);
  assert.match(html, /data-testid="finish-game"/);
  assert.match(html, /data-testid="game-result-summary"/);
  assert.match(html, /data-testid="panel-game-final"/);
  assert.match(html, /data-testid="finalisation-board"/);
  assert.match(html, /data-testid="game-edit-third-length"/);
  assert.ok(
    html.indexOf('data-testid="game-mode-structure"') < html.indexOf('data-testid="game-mode-players"'),
    "Structure mode should appear before player setup.",
  );
  assert.ok(
    html.indexOf('data-testid="game-mode-players"') < html.indexOf('data-testid="game-mode-run"'),
    "Player setup should appear before run mode.",
  );
  assert.ok(
    html.indexOf('data-testid="game-mode-run"') < html.indexOf('data-testid="game-mode-final"'),
    "Run mode should appear before finalisation.",
  );
  assert.ok(
    html.indexOf('data-testid="panel-game-roster"') < html.indexOf('data-testid="panel-game-live"'),
    "Roster setup should appear before live scoring in the game workflow.",
  );
  assert.ok(
    html.indexOf('data-testid="panel-game-live"') < html.indexOf('data-testid="panel-game-timer"'),
    "Run mode should prioritize live scoring before timer controls.",
  );
  assert.ok(
    html.indexOf('data-testid="panel-game-timer"') < html.indexOf('data-testid="run-latest-goals"'),
    "Timer controls should appear before the growing latest-goals history.",
  );
  assert.match(html, /data-testid="panel-game-live"/);
  assert.match(html, /data-testid="live-scoreboard"/);
  assert.match(html, /data-testid="goal-scoring-team"/);
  assert.match(html, /data-testid="goal-conceding-team"/);
  assert.match(html, /data-testid="goal-own-goal"/);
  assert.match(html, /data-testid="goal-scorer"/);
  assert.match(html, /data-testid="goal-assists"/);
  assert.match(html, /data-testid="add-goal"/);
  assert.match(html, /data-testid="undo-last-goal"/);
  assert.match(html, /data-testid="goal-timeline"/);
  assert.match(html, /data-testid="panel-game-roster"/);
  assert.match(html, /data-testid="quick-create-player"/);
  assert.match(html, /data-testid="roster-teams"/);
});

test("join page renders player registration shell", () => {
  const html = renderJoinPage("https://qa-api.3fc.football", "join0001");

  assert.match(html, /data-testid="join-shell"/);
  assert.match(html, /data-page="join"/);
  assert.match(html, /data-join-code="join0001"/);
  assert.match(html, /data-testid="join-code-value"/);
  assert.match(html, /JOIN GAME|Join game/);
  assert.match(html, /id="join-player-nickname"/);
  assert.match(html, /data-testid="join-game"/);
  assert.match(html, /data-testid="join-result"/);
  assert.match(html, /data-testid="join-claim-actions"/);
  assert.match(html, /data-testid="join-signin-link"/);
  assert.match(html, /data-testid="claim-player"/);
});
