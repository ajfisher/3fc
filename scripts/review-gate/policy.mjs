import { readFile } from "node:fs/promises";

const RISK_TIERS = ["low", "medium", "high"];
const REQUIREMENT_LEVELS = new Set(["required", "optional", "advisory"]);
const CHANGE_TYPES = new Set([
  "documentation-only",
  "tests-only",
  "application-behaviour",
  "backlog-maintenance",
  "dependency-tooling",
  "public-contract",
  "data-migration",
  "permission-trust-boundary",
  "durable-state-ownership",
  "destructive-behaviour",
  "new-production-dependency",
  "authentication-authorisation",
  "privacy-regulated-data",
  "infrastructure-production-configuration",
  "review-policy",
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Invalid review policy: ${message}`);
  }
}

function assertStringArray(value, field, { allowEmpty = true } = {}) {
  assert(Array.isArray(value), `${field} must be an array`);
  assert(allowEmpty || value.length > 0, `${field} must not be empty`);
  assert(value.every((item) => typeof item === "string" && item.trim()), `${field} must contain non-empty strings`);
}

function validateRequirements(requirements, tier) {
  assert(requirements && typeof requirements === "object" && !Array.isArray(requirements), `risk.${tier}.requirements must be an object`);
  for (const key of [
    "ci",
    "qa",
    "codex_review",
    "architecture_declaration",
    "failure_evidence",
    "rollback_evidence",
    "acceptance_evidence",
    "invariant_declaration",
  ]) {
    assert(REQUIREMENT_LEVELS.has(requirements[key]), `risk.${tier}.requirements.${key} has an unsupported value`);
  }
  for (const key of ["unresolved_review_threads", "human_approvals"]) {
    assert(Number.isInteger(requirements[key]) && requirements[key] >= 0, `risk.${tier}.requirements.${key} must be a non-negative integer`);
  }
}

export function parsePolicy(text) {
  let policy;
  try {
    policy = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid review policy: file must use JSON-compatible YAML (${error.message})`);
  }
  return validatePolicy(policy);
}

export function validatePolicy(policy) {
  assert(policy && typeof policy === "object" && !Array.isArray(policy), "root must be an object");
  assert(policy.version === 1, "version must be 1");
  assert(["observe", "enforce"].includes(policy.mode), "mode must be observe or enforce");

  assert(policy.checks && typeof policy.checks === "object", "checks must be an object");
  for (const group of ["ci", "qa"]) {
    assert(policy.checks[group] && typeof policy.checks[group] === "object", `checks.${group} must be an object`);
    assertStringArray(policy.checks[group].required_check_names, `checks.${group}.required_check_names`, { allowEmpty: false });
  }
  assert(
    !Object.values(policy.checks).some((group) => group.required_check_names.includes("review-gate")),
    "review-gate cannot be one of its own input checks",
  );
  if (policy.checks.qa.trigger_label !== undefined) {
    assert(typeof policy.checks.qa.trigger_label === "string" && policy.checks.qa.trigger_label.trim(), "checks.qa.trigger_label must be a non-empty string");
  }

  assert(policy.codex && typeof policy.codex === "object", "codex must be an object");
  assertStringArray(policy.codex.reviewer_logins, "codex.reviewer_logins", { allowEmpty: false });

  assert(policy.risk && typeof policy.risk === "object", "risk must be an object");
  assert(
    JSON.stringify(policy.risk.order) === JSON.stringify(RISK_TIERS),
    "risk.order must be [\"low\", \"medium\", \"high\"]",
  );
  for (const tier of RISK_TIERS) {
    const config = policy.risk[tier];
    assert(config && typeof config === "object", `risk.${tier} must be an object`);
    assertStringArray(config.paths, `risk.${tier}.paths`);
    assertStringArray(config.change_types, `risk.${tier}.change_types`);
    assert(
      config.change_types.every((type) => CHANGE_TYPES.has(type)),
      `risk.${tier}.change_types contains an unsupported change type`,
    );
    validateRequirements(config.requirements, tier);
  }

  assert(
    policy.architecture_triggers
      && typeof policy.architecture_triggers === "object"
      && !Array.isArray(policy.architecture_triggers),
    "architecture_triggers must be an object",
  );
  assertStringArray(
    policy.architecture_triggers.paths,
    "architecture_triggers.paths",
  );
  assertStringArray(
    policy.architecture_triggers.change_types,
    "architecture_triggers.change_types",
  );
  assert(
    policy.architecture_triggers.change_types.every((type) => CHANGE_TYPES.has(type)),
    "architecture_triggers.change_types contains an unsupported change type",
  );
  assert(policy.labels && typeof policy.labels === "object", "labels must be an object");
  assertStringArray(policy.labels.managed_prefixes, "labels.managed_prefixes", { allowEmpty: false });
  assert(Array.isArray(policy.labels.definitions), "labels.definitions must be an array");
  const labelNames = new Set();
  for (const definition of policy.labels.definitions) {
    assert(definition && typeof definition === "object", "each label definition must be an object");
    assert(typeof definition.name === "string" && definition.name.trim(), "label definition name is required");
    assert(/^[0-9A-Fa-f]{6}$/.test(definition.color), `label ${definition.name} must have a six-character hex color`);
    assert(typeof definition.description === "string" && definition.description.trim(), `label ${definition.name} description is required`);
    assert(!labelNames.has(definition.name), `duplicate label definition ${definition.name}`);
    assert(
      policy.labels.managed_prefixes.some((prefix) => definition.name.startsWith(prefix)),
      `label ${definition.name} does not use a managed prefix`,
    );
    labelNames.add(definition.name);
  }
  for (const requiredLabel of [
    ...RISK_TIERS.map((tier) => `risk:${tier}`),
    "review:automated",
    "review:awaiting-evidence",
    "review:awaiting-judgement",
    "review:awaiting-human",
    "review:blocked",
    "review:ready",
    "architecture:none",
    "architecture:documented",
    "architecture:judgement-required",
  ]) {
    assert(labelNames.has(requiredLabel), `labels.definitions is missing ${requiredLabel}`);
  }

  return policy;
}

export async function loadPolicy(path) {
  return parsePolicy(await readFile(path, "utf8"));
}

export const riskTiers = RISK_TIERS;
