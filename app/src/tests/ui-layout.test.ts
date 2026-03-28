import assert from "node:assert/strict";
import test from "node:test";

import {
  renderComponentShowcasePage,
  renderGamePage,
  renderLeaguePage,
  renderMagicLinkCallbackPage,
  renderSeasonPage,
  renderSignInPage,
  renderSetupHomePage,
} from "../ui/layout.js";
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
});

test("setup home page includes stepwise setup panels and setup-flow script", () => {
  const html = renderSetupHomePage("https://qa-api.3fc.football");

  assert.match(html, /data-testid="setup-flow-root"/);
  assert.match(html, /data-page="dashboard"/);
  assert.match(html, /data-testid="panel-dashboard-create-league"/);
  assert.match(html, /data-testid="panel-dashboard-leagues"/);
  assert.match(html, /League friendly URL/);
  assert.match(html, /dashboard-leagues-body/);
  assert.match(html, /data-testid="create-league"/);
  assert.match(html, /id="league-id-display"/);
  assert.match(html, /rel="stylesheet" href="\/ui\/styles\.css"/);
  assert.match(html, /data-testid="setup-shell"/);
  assert.match(html, /<script src="\/ui\/setup-flow\.js" defer><\/script>/);
  assert.match(html, /https:\/\/qa-api\.3fc\.football/);
});

test("league page includes season create form and seasons table", () => {
  const html = renderLeaguePage("https://qa-api.3fc.football", "league-1");

  assert.match(html, /data-testid="league-shell"/);
  assert.match(html, /data-page="league"/);
  assert.match(html, /data-league-id="league-1"/);
  assert.match(html, /Season friendly URL/);
  assert.match(html, /league-seasons-body/);
  assert.match(html, /data-testid="create-season"/);
  assert.match(html, /data-testid="delete-league"/);
});

test("season page includes game create form and games table", () => {
  const html = renderSeasonPage("https://qa-api.3fc.football", "season-1");

  assert.match(html, /data-testid="season-shell"/);
  assert.match(html, /data-page="season"/);
  assert.match(html, /data-season-id="season-1"/);
  assert.match(html, /Game date/);
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
  assert.match(html, /Completing sign-in/);
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
  assert.match(html, /data-testid="save-game"/);
  assert.match(html, /data-testid="delete-game"/);
  assert.match(html, /data-testid="create-another-game"/);
});
