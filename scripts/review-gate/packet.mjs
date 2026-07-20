export const PACKET_MARKER = "review-packet-version:1";

export const CHANGE_TYPES = [
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
];

const RISK_LEVELS = ["low", "medium", "high"];
const ARCHITECTURE_DISPOSITIONS = [
  "architecture:none",
  "architecture:documented",
  "architecture:judgement-required",
];
const HUMAN_JUDGEMENT_DISPOSITIONS = [
  "human-judgement:none",
  "human-judgement:required",
];
const REQUIRED_SECTIONS = [
  "Behavioural claim",
  "Specification and acceptance evidence",
  "Scope boundaries",
  "Change classification",
  "Architecture and invariants",
  "Failure and rollback",
  "Automated and agent review disposition",
  "Human judgement",
  "Review focus",
];
const REQUIRED_SUBSECTIONS = [
  "Affected invariants",
  "Architecture or decision record",
  "Failure behaviour",
  "Rollback approach",
  "Rollback evidence",
  "Unresolved blocking findings",
  "Rejected findings and evidence",
  "Decision requiring judgement",
  "Options considered",
  "Reason selected",
  "Reversal cost",
];

function clean(value, { emptyNone = true } = {}) {
  const cleaned = (value ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (emptyNone && /^\s*(none|n\/a)\.?\s*$/i.test(cleaned)) {
    return "";
  }
  return cleaned;
}

function splitHeadings(body, level) {
  const matches = [...body.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)];
  const sections = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index][1].length !== level) {
      continue;
    }
    const start = matches[index].index + matches[index][0].length;
    const next = matches
      .slice(index + 1)
      .find((match) => match[1].length <= level);
    sections.set(
      matches[index][2].trim(),
      body.slice(start, next?.index ?? body.length).trim(),
    );
  }
  return sections;
}

function selectedTokens(section) {
  return [...section.matchAll(/^\s*-\s*\[[xX]\]\s*`([^`]+)`/gm)]
    .map((match) => match[1]);
}

function readField(section, label) {
  const lines = section.split("\n");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}:\\s*(.*)$`, "i");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(pattern);
    if (!match) {
      continue;
    }
    const values = match[1].trim() ? [match[1].trim()] : [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor].trim();
      if (/^[A-Za-z][A-Za-z ]+:\s*/.test(candidate)) {
        break;
      }
      if (candidate) {
        values.push(candidate);
      }
    }
    return clean(values.join("\n"));
  }
  return "";
}

function parseMarkdownTable(section) {
  const lines = section.split("\n");
  const splitTableCells = (line) => {
    const cells = [];
    let cell = "";
    let codeDelimiterLength = 0;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === "\\" && index + 1 < line.length) {
        cell += character + line[index + 1];
        index += 1;
        continue;
      }
      if (character === "`") {
        const start = index;
        while (line[index + 1] === "`") {
          index += 1;
        }
        const delimiterLength = index - start + 1;
        if (codeDelimiterLength === 0) {
          codeDelimiterLength = delimiterLength;
        } else if (delimiterLength === codeDelimiterLength) {
          codeDelimiterLength = 0;
        }
        cell += "`".repeat(delimiterLength);
        continue;
      }
      if (character === "|" && codeDelimiterLength === 0) {
        cells.push(cell);
        cell = "";
        continue;
      }
      cell += character;
    }
    cells.push(cell);
    return cells;
  };
  const readRow = (line) => {
    const trimmed = line.trim();
    if (!trimmed.includes("|")) {
      return null;
    }
    const cells = splitTableCells(trimmed);
    if (trimmed.startsWith("|")) {
      cells.shift();
    }
    if (cells.at(-1)?.trim() === "") {
      cells.pop();
    }
    return cells.map((cell) => clean(cell));
  };
  const isDelimiter = (row, width) =>
    row?.length === width && row.every((cell) => /^:?-+:?$/.test(cell));

  const bodyRows = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = readRow(lines[index]);
    if (!header || header.length < 2 || !header.some(Boolean)) {
      continue;
    }
    if (!isDelimiter(readRow(lines[index + 1]), header.length)) {
      continue;
    }
    let cursor = index + 2;
    for (; cursor < lines.length; cursor += 1) {
      const row = readRow(lines[cursor]);
      if (!row || row.length !== header.length || isDelimiter(row, header.length)) {
        break;
      }
      if (row.some(Boolean)) {
        bodyRows.push(row);
      }
    }
    index = cursor - 1;
  }
  return bodyRows;
}

function parseEvidence(section) {
  const rows = parseMarkdownTable(section);
  return rows
    .map(([criterion = "", evidence = "", result = ""]) => ({
      criterion,
      evidence,
      result: result.toUpperCase(),
    }));
}

function parseInvariantImpacts(section) {
  return parseMarkdownTable(section)
    .map(([
      invariant = "",
      affected = "",
      valid = "",
      evidence = "",
    ]) => {
      const invariantIds = [...invariant.matchAll(/\bINV-\d{3}\b/ig)]
        .map((match) => match[0].toUpperCase());
      return {
        invariant: invariantIds.length === 1
          ? invariantIds[0]
          : invariant.toUpperCase(),
        invariantIds,
        affected,
        valid,
        evidence,
      };
    })
    .filter((row) => row.invariant || row.affected || row.valid || row.evidence);
}

export function parseReviewPacket(body = "") {
  const errors = [];
  if (!body.includes(`<!-- ${PACKET_MARKER} -->`)) {
    errors.push(`Review packet marker ${PACKET_MARKER} is missing or unsupported.`);
  }

  const sections = splitHeadings(body, 2);
  for (const heading of REQUIRED_SECTIONS) {
    if (!sections.has(heading)) {
      errors.push(`Missing review packet section: ${heading}.`);
    }
  }
  const subsections = splitHeadings(body, 3);
  for (const heading of REQUIRED_SUBSECTIONS) {
    if (!subsections.has(heading)) {
      errors.push(`Missing review packet subsection: ${heading}.`);
    }
  }

  const classification = sections.get("Change classification") ?? "";
  const declaredMatches = [
    ...classification.matchAll(/^- Declared risk:\s*`([^`]+)`\s*$/gm),
  ];
  const declaredRisk = declaredMatches.length === 1
    && RISK_LEVELS.includes(declaredMatches[0][1])
    ? declaredMatches[0][1]
    : null;
  if (!declaredRisk) {
    errors.push("Declared risk must be exactly one of: low, medium, high.");
  }

  const selectedChangeTypes = selectedTokens(classification);
  if (selectedChangeTypes.length === 0) {
    errors.push("Select at least one machine-readable change type.");
  }
  const unknownChangeTypes = selectedChangeTypes.filter(
    (type) => !CHANGE_TYPES.includes(type),
  );
  if (unknownChangeTypes.length > 0) {
    errors.push(`Unknown change type(s): ${unknownChangeTypes.join(", ")}.`);
  }

  const architectureSelections = selectedTokens(
    sections.get("Architecture and invariants") ?? "",
  ).filter((token) => token.startsWith("architecture:"));
  if (
    architectureSelections.length !== 1
    || !ARCHITECTURE_DISPOSITIONS.includes(architectureSelections[0])
  ) {
    errors.push("Select exactly one architecture disposition.");
  }

  const humanSelections = selectedTokens(
    sections.get("Human judgement") ?? "",
  ).filter((token) => token.startsWith("human-judgement:"));
  if (
    humanSelections.length !== 1
    || !HUMAN_JUDGEMENT_DISPOSITIONS.includes(humanSelections[0])
  ) {
    errors.push("Select exactly one human-judgement disposition.");
  }

  const scope = sections.get("Scope boundaries") ?? "";
  const acceptanceRows = parseEvidence(
    sections.get("Specification and acceptance evidence") ?? "",
  );
  const affectedInvariantSection = subsections.get("Affected invariants") ?? "";
  const affectedInvariantRows = parseInvariantImpacts(affectedInvariantSection);

  return {
    errors,
    version: body.includes(`<!-- ${PACKET_MARKER} -->`) ? 1 : null,
    claim: clean(sections.get("Behavioural claim") ?? ""),
    scopeIncluded: readField(scope, "Included"),
    scopeExcluded: readField(scope, "Excluded"),
    declaredRisk,
    changeTypes: selectedChangeTypes.filter((type) => CHANGE_TYPES.includes(type)),
    acceptanceRows,
    hasAcceptanceEvidence: acceptanceRows.some(
      (row) => row.criterion && row.evidence && row.result === "PASS",
    ),
    architectureSelections,
    architecture: architectureSelections.length === 1
      ? architectureSelections[0]
      : null,
    affectedInvariants: clean(affectedInvariantSection, { emptyNone: false }),
    affectedInvariantRows,
    architectureRecord: clean(
      subsections.get("Architecture or decision record") ?? "",
    ),
    failureBehaviour: clean(subsections.get("Failure behaviour") ?? ""),
    rollbackApproach: clean(subsections.get("Rollback approach") ?? ""),
    rollbackEvidence: clean(subsections.get("Rollback evidence") ?? ""),
    unresolvedBlockingFindings: clean(
      subsections.get("Unresolved blocking findings") ?? "",
    ),
    rejectedFindings: clean(
      subsections.get("Rejected findings and evidence") ?? "",
    ),
    humanJudgement: humanSelections.length === 1 ? humanSelections[0] : null,
    humanJudgementRequested: humanSelections[0] === "human-judgement:required",
    judgementDecision: clean(
      subsections.get("Decision requiring judgement") ?? "",
    ),
    judgementOptions: clean(subsections.get("Options considered") ?? ""),
    judgementReason: clean(subsections.get("Reason selected") ?? ""),
    reversalCost: clean(subsections.get("Reversal cost") ?? ""),
    reviewFocus: clean(sections.get("Review focus") ?? ""),
  };
}
