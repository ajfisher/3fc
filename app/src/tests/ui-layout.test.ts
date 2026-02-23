import assert from "node:assert/strict";
import test from "node:test";

import {
  renderComponentShowcasePage,
  renderGameContextPage,
  renderMagicLinkCallbackPage,
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
  assert.match(html, /data-testid="panel-league-flow"/);
  assert.match(html, /data-testid="panel-season-flow"/);
  assert.match(html, /data-testid="panel-game-flow"/);
  assert.match(html, /data-testid="create-league"/);
  assert.match(html, /data-testid="create-season"/);
  assert.match(html, /data-testid="create-game"/);
  assert.match(html, /id="league-id-display"/);
  assert.match(html, /id="season-id-display"/);
  assert.match(html, /id="session-id-display"/);
  assert.match(html, /id="game-id-display"/);
  assert.match(html, /rel="stylesheet" href="\/ui\/styles\.css"/);
  assert.match(html, /data-ui="step-list"/);
  assert.match(html, /data-testid="setup-shell"/);
  assert.match(html, /<script src="\/ui\/setup-flow\.js" defer><\/script>/);
  assert.match(html, /https:\/\/qa-api\.3fc\.football/);
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

test("game context page renders created identifiers and kickoff metadata", () => {
  const html = renderGameContextPage({
    gameId: "game-20260223-a1b2c3d4",
    leagueId: "league-main",
    seasonId: "season-2026",
    sessionId: "20260223",
    gameStartTs: "2026-02-23T10:00:00.000Z",
  });

  assert.match(html, /data-testid="game-context-shell"/);
  assert.match(html, /game-20260223-a1b2c3d4/);
  assert.match(html, /league-main/);
  assert.match(html, /season-2026/);
  assert.match(html, /2026-02-23T10:00:00.000Z/);
  assert.match(html, /data-testid="create-another-game"/);
});
