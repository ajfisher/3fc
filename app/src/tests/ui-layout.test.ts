import assert from "node:assert/strict";
import test from "node:test";

import { renderComponentShowcasePage, renderSetupHomePage } from "../ui/layout.js";
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

test("setup home page includes all foundation sections and links external stylesheet", () => {
  const html = renderSetupHomePage("https://qa-api.3fc.football");

  assert.match(html, /League setup/);
  assert.match(html, /Season setup/);
  assert.match(html, /Session setup/);
  assert.match(html, /Game setup/);
  assert.match(html, /rel="stylesheet" href="\/ui\/styles\.css"/);
  assert.match(html, /data-ui="step-list"/);
  assert.match(html, /data-testid="setup-shell"/);
  assert.match(html, /data-testid="panel-league"/);
  assert.match(html, /data-testid="panel-season"/);
  assert.match(html, /data-testid="panel-session"/);
  assert.match(html, /data-testid="panel-game"/);
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
