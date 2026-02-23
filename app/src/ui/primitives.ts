export type ButtonVariant = "primary" | "secondary" | "ghost";

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
  type?: "text" | "date" | "datetime-local";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
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
