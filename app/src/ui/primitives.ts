export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface StepChipInput {
  label: string;
  state?: "active" | "upcoming" | "done";
}

export interface InputFieldInput {
  id: string;
  label: string;
  placeholder?: string;
  value?: string;
  hint?: string;
  required?: boolean;
  type?: "text" | "date" | "datetime-local" | "email";
}

export interface ValidatedFieldInput extends InputFieldInput {
  error?: string;
  success?: string;
}

export interface NavItemInput {
  label: string;
  href: string;
  active?: boolean;
}

export interface PlayerCardInput {
  name: string;
  subtitle?: string;
  avatarUrl?: string | null;
}

export interface DataTableInput {
  columns: string[];
  rows: Array<Array<string | number>>;
  caption?: string;
  tableId?: string;
}

export interface RowActionInput {
  label: string;
  action: string;
  tone?: "neutral" | "danger";
}

export interface RowActionItemInput {
  title: string;
  subtitle?: string;
  actions: RowActionInput[];
}

export interface ModalPromptInput {
  id: string;
  triggerLabel: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function getNameInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((segment) => segment.length > 0)
    .slice(0, 2)
    .map((segment) => segment[0]?.toUpperCase() ?? "");

  return parts.join("") || "P";
}

export function renderButton(
  label: string,
  variant: ButtonVariant = "secondary",
  attributes: Record<string, string> = {},
): string {
  const htmlAttributes = Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(" ");

  const attributeSuffix = htmlAttributes.length > 0 ? ` ${htmlAttributes}` : "";
  return `<button class="btn btn-${variant}"${attributeSuffix}>${escapeHtml(label)}</button>`;
}

export function renderStepChip(input: StepChipInput): string {
  const state = input.state ?? "upcoming";
  return `<li class="step-chip step-chip-${state}">${escapeHtml(input.label)}</li>`;
}

export function renderInputField(input: InputFieldInput): string {
  const type = input.type ?? "text";
  const required = input.required ? " required" : "";
  const value = input.value ? ` value="${escapeHtml(input.value)}"` : "";
  const placeholder = input.placeholder
    ? ` placeholder="${escapeHtml(input.placeholder)}"`
    : "";
  const hint = input.hint
    ? `<p class="field-hint" id="${escapeHtml(input.id)}-hint">${escapeHtml(input.hint)}</p>`
    : "";
  const describedBy = input.hint ? ` aria-describedby="${escapeHtml(input.id)}-hint"` : "";

  return `<div class="field">
  <label class="field-label" for="${escapeHtml(input.id)}">${escapeHtml(input.label)}</label>
  <input class="field-input" id="${escapeHtml(input.id)}" name="${escapeHtml(input.id)}" type="${type}"${value}${placeholder}${required}${describedBy} />
  ${hint}
</div>`;
}

export function renderValidatedField(input: ValidatedFieldInput): string {
  const type = input.type ?? "text";
  const required = input.required ? " required" : "";
  const value = input.value ? ` value="${escapeHtml(input.value)}"` : "";
  const placeholder = input.placeholder
    ? ` placeholder="${escapeHtml(input.placeholder)}"`
    : "";
  const error = input.error ? escapeHtml(input.error) : null;
  const success = !error && input.success ? escapeHtml(input.success) : null;
  const hint = input.hint ? escapeHtml(input.hint) : null;
  const noticeId = `${escapeHtml(input.id)}-notice`;

  const notice = error
    ? `<p class="field-notice field-notice-error" id="${noticeId}">${error}</p>`
    : success
      ? `<p class="field-notice field-notice-success" id="${noticeId}">${success}</p>`
      : hint
        ? `<p class="field-hint" id="${noticeId}">${hint}</p>`
        : "";

  const noticeAttr = notice ? ` aria-describedby="${noticeId}"` : "";
  const invalidAttr = error ? " aria-invalid=\"true\"" : "";
  const stateClass = error
    ? " field-input-invalid"
    : success
      ? " field-input-success"
      : "";

  return `<div class="field field-validated">
  <label class="field-label" for="${escapeHtml(input.id)}">${escapeHtml(input.label)}</label>
  <input class="field-input${stateClass}" id="${escapeHtml(input.id)}" name="${escapeHtml(input.id)}" type="${type}"${value}${placeholder}${required}${noticeAttr}${invalidAttr} />
  ${notice}
</div>`;
}

export function renderPanel(
  title: string,
  description: string,
  bodyHtml: string,
  footerHtml = "",
  panelId?: string,
): string {
  const idAttribute = panelId ? ` data-testid="${escapeHtml(panelId)}"` : "";
  return `<article class="panel"${idAttribute}>
  <header class="panel-header">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(description)}</p>
  </header>
  <div class="panel-body">
    ${bodyHtml}
  </div>
  ${footerHtml ? `<footer class="panel-footer">${footerHtml}</footer>` : ""}
</article>`;
}

export function renderNavigation(items: NavItemInput[], navId = "main-nav"): string {
  const links = items
    .map((item) => {
      const stateClass = item.active ? " nav-link-active" : "";
      const current = item.active ? ' aria-current="page"' : "";
      return `<li><a class="nav-link${stateClass}" href="${escapeHtml(item.href)}"${current}>${escapeHtml(item.label)}</a></li>`;
    })
    .join("");

  return `<nav class="top-nav" data-testid="${escapeHtml(navId)}" aria-label="Primary">
  <ul class="top-nav-list">${links}</ul>
</nav>`;
}

export function renderPlayerCard(input: PlayerCardInput, cardId?: string): string {
  const avatar = input.avatarUrl
    ? `<img src="${escapeHtml(input.avatarUrl)}" alt="${escapeHtml(input.name)}" />`
    : `<span>${escapeHtml(getNameInitials(input.name))}</span>`;
  const subtitle = input.subtitle ? `<p>${escapeHtml(input.subtitle)}</p>` : "";
  const idAttribute = cardId ? ` data-testid="${escapeHtml(cardId)}"` : "";

  return `<article class="player-card"${idAttribute}>
  <div class="player-avatar">${avatar}</div>
  <div class="player-meta">
    <h3>${escapeHtml(input.name)}</h3>
    ${subtitle}
  </div>
</article>`;
}

export function renderDataTable(input: DataTableInput): string {
  const header = input.columns
    .map((column) => `<th scope="col">${escapeHtml(column)}</th>`)
    .join("");

  const rows = input.rows
    .map(
      (row) =>
        `<tr>${row.map((value) => `<td>${escapeHtml(String(value))}</td>`).join("")}</tr>`,
    )
    .join("");

  const idAttribute = input.tableId
    ? ` data-testid="${escapeHtml(input.tableId)}"`
    : "";
  const caption = input.caption
    ? `<caption>${escapeHtml(input.caption)}</caption>`
    : "";

  return `<div class="table-wrap"${idAttribute}>
  <table class="data-table">
    ${caption}
    <thead><tr>${header}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

export function renderRowActionList(rows: RowActionItemInput[], listId = "row-action-list"): string {
  const items = rows
    .map((row) => {
      const subtitle = row.subtitle ? `<p>${escapeHtml(row.subtitle)}</p>` : "";
      const actions = row.actions
        .map((action) => {
          const toneClass = action.tone === "danger" ? " list-action-danger" : "";
          return `<button class="list-action${toneClass}" type="button" data-action="${escapeHtml(action.action)}">${escapeHtml(action.label)}</button>`;
        })
        .join("");

      return `<li class="row-action-item">
      <div class="row-action-copy">
        <h3>${escapeHtml(row.title)}</h3>
        ${subtitle}
      </div>
      <div class="row-action-buttons">${actions}</div>
    </li>`;
    })
    .join("");

  return `<ul class="row-action-list" data-testid="${escapeHtml(listId)}">${items}</ul>`;
}

export function renderModalPrompt(input: ModalPromptInput): string {
  const safeId = escapeHtml(input.id);

  return `<div class="modal-prompt" data-testid="${safeId}-container">
  ${renderButton(input.triggerLabel, "ghost", {
    "data-modal-open": safeId,
    type: "button",
  })}
  <dialog class="prompt-dialog" data-modal="${safeId}" aria-label="${escapeHtml(input.title)}">
    <h3>${escapeHtml(input.title)}</h3>
    <p>${escapeHtml(input.message)}</p>
    <div class="prompt-actions">
      ${renderButton(input.cancelLabel, "secondary", {
        "data-modal-close": safeId,
        type: "button",
      })}
      ${renderButton(input.confirmLabel, "danger", {
        "data-modal-confirm": safeId,
        type: "button",
      })}
    </div>
  </dialog>
</div>`;
}
