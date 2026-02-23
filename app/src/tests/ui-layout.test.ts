import assert from "node:assert/strict";
import test from "node:test";

import { renderSetupHomePage } from "../ui/layout.js";
import { renderButton, renderInputField, renderPanel, renderStepChip } from "../ui/primitives.js";

test("primitives render expected class hooks", () => {
  const button = renderButton("Continue", "primary");
  const chip = renderStepChip({ label: "1. League", state: "active" });
  const field = renderInputField({
    id: "league-name",
    label: "League name",
    placeholder: "Three FC",
    required: true,
  });
  const panel = renderPanel("League setup", "Description", field, button);

  assert.match(button, /class="btn btn-primary"/);
  assert.match(chip, /class="step-chip step-chip-active"/);
  assert.match(field, /class="field-input"/);
  assert.match(panel, /class="panel"/);
});

test("setup home page includes all foundation sections and responsive CSS", () => {
  const html = renderSetupHomePage("https://qa-api.3fc.football");

  assert.match(html, /League setup/);
  assert.match(html, /Season setup/);
  assert.match(html, /Session setup/);
  assert.match(html, /Game setup/);
  assert.match(html, /@media \(min-width: 768px\)/);
  assert.match(html, /class="step-list"/);
  assert.match(html, /data-testid="setup-shell"/);
  assert.match(html, /data-testid="panel-league"/);
  assert.match(html, /data-testid="panel-season"/);
  assert.match(html, /data-testid="panel-session"/);
  assert.match(html, /data-testid="panel-game"/);
  assert.match(html, /https:\/\/qa-api\.3fc\.football/);
});
