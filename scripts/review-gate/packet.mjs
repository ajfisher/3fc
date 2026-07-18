const CHANGE_TYPES = new Map([
  ["public contract", "public-contract"],
  ["data migration", "data-migration"],
  ["permission or trust boundary", "permission-trust-boundary"],
  ["durable state ownership", "durable-state-ownership"],
  ["destructive behaviour", "destructive-behaviour"],
  ["new production dependency", "new-production-dependency"],
  ["authentication or authorisation", "authentication-authorisation"],
  ["privacy or regulated data", "privacy-regulated-data"],
  ["infrastructure or production configuration", "infrastructure-production-configuration"],
  ["none of the above", "none"],
]);

const ARCHITECTURE_OPTIONS = new Map([
  ["no architecture boundary or invariant changed", "none"],
  ["architecture documentation updated", "documented"],
  ["human architecture judgement required", "judgement-required"],
]);

function withoutComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function splitSections(body) {
  const sections = new Map();
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const start = current.index + current[0].length;
    const end = next ? next.index : body.length;
    sections.set(current[1].trim().toLowerCase(), body.slice(start, end).trim());
  }
  return sections;
}

function parseCheckedOptions(section, options) {
  const selected = [];
  for (const match of section.matchAll(/^\s*-\s*\[([xX ])\]\s*(.+?)\s*$/gm)) {
    if (match[1].toLowerCase() !== "x") {
      continue;
    }
    const value = options.get(match[2].trim().toLowerCase());
    if (value) {
      selected.push(value);
    }
  }
  return selected;
}

function parseTable(section) {
  const rows = [];
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) {
      continue;
    }
    const cells = line.slice(1, -1).split("|").map((cell) => withoutComments(cell));
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      continue;
    }
    rows.push(cells);
  }
  return rows.slice(1);
}

function readField(section, label) {
  const lines = section.split("\n");
  const labelPattern = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.*)$`, "i");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(labelPattern);
    if (!match) {
      continue;
    }
    const values = [];
    if (match[1].trim()) {
      values.push(match[1].trim());
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor].trim();
      if (/^[A-Za-z][A-Za-z ]+:/.test(candidate)) {
        break;
      }
      if (candidate) {
        values.push(candidate);
      }
    }
    return withoutComments(values.join("\n"));
  }
  return "";
}

export function parseReviewPacket(body = "") {
  const sections = splitSections(body);
  const classification = sections.get("change classification") ?? "";
  const architectureSection = sections.get("architecture and invariants") ?? "";
  const failureSection = sections.get("failure and rollback") ?? "";
  const findingsSection = sections.get("automated and agent review disposition") ?? "";
  const judgementSection = sections.get("human judgement") ?? "";

  const declaredRiskMatch = classification.match(/^-\s*Declared risk:\s*(low|medium|high)\s*$/im);
  const changeTypes = parseCheckedOptions(classification, CHANGE_TYPES);
  const architectureSelections = parseCheckedOptions(architectureSection, ARCHITECTURE_OPTIONS);
  const acceptanceRows = parseTable(sections.get("specification and acceptance evidence") ?? "")
    .filter((row) => row.some(Boolean));
  const findingRows = parseTable(findingsSection).filter((row) => row.some(Boolean));
  const rejectedFindingsMissingEvidence = findingRows.filter((row) => {
    const disposition = (row[1] ?? "").toLowerCase();
    return disposition === "rejected" && (!(row[2] ?? "").trim() || !(row[3] ?? "").trim());
  });
  const noJudgementChecked = /^-\s*\[[xX]\]\s*No human judgement requested\s*$/im.test(judgementSection);

  return {
    version: body.includes("<!-- review-packet-version:1 -->") ? 1 : null,
    claim: withoutComments(sections.get("behavioural claim") ?? ""),
    declaredRisk: declaredRiskMatch?.[1]?.toLowerCase() ?? null,
    changeTypes: changeTypes.filter((type) => type !== "none"),
    invalidChangeTypeSelection: changeTypes.includes("none") && changeTypes.length > 1,
    acceptanceRows,
    hasAcceptanceEvidence: acceptanceRows.some((row) => (row[0] ?? "").trim() && (row[1] ?? "").trim()),
    architectureSelections,
    architecture: architectureSelections.length === 1 ? architectureSelections[0] : null,
    affectedInvariants: readField(architectureSection, "Affected invariants"),
    architectureRecord: readField(architectureSection, "Architecture or decision record"),
    failureBehaviour: readField(failureSection, "Failure behaviour"),
    rollbackApproach: readField(failureSection, "Rollback approach"),
    rollbackEvidence: readField(failureSection, "Rollback evidence"),
    findingRows,
    rejectedFindingsMissingEvidence,
    unresolvedBlockingFindings: readField(findingsSection, "Unresolved blocking findings"),
    noJudgementRequested: noJudgementChecked,
    humanJudgementRequested: !noJudgementChecked,
    judgementDecision: readField(judgementSection, "Decision requiring judgement"),
    judgementOptions: readField(judgementSection, "Options considered"),
    judgementReason: readField(judgementSection, "Reason selected"),
    reversalCost: readField(judgementSection, "Reversal cost"),
  };
}
