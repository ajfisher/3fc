export type PlayerLinkState = "linked" | "unlinked" | "unknown";

export interface PlayerPresentation {
  name: string;
  linkState?: PlayerLinkState;
  context?: string;
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function playerInitial(name: string): string {
  const firstGrapheme = (value: string): string | undefined => typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)[Symbol.iterator]().next().value?.segment
    : Array.from(value)[0];
  const first = firstGrapheme(name.trim());
  if (!first) return "P";
  // Uppercasing can expand a character (e.g. ß); keep a single grapheme.
  return firstGrapheme(first.toUpperCase()) ?? "P";
}

/** Presentation only: callers must derive linkState from authorised metadata. */
export function renderPlayerIdentity({ name, linkState = "unknown", context }: PlayerPresentation): string {
  const state = linkState === "linked" || linkState === "unlinked" ? linkState : "unknown";
  const status = state === "linked" ? "Linked to an account" : state === "unlinked" ? "Not linked to an account" : "";
  return `<span data-ui="player-identity">
    <span data-ui="player-initial" data-link-state="${state}" aria-hidden="true">${escape(playerInitial(name))}${state === "linked" ? '<span data-ui="player-linked-tick"><span data-ui="icon" data-icon="circle-check" aria-hidden="true"></span></span>' : ""}</span>
    <span data-ui="player-identity-copy"><strong>${escape(name)}</strong> ${status ? `<span class="sr-only">${status}</span> ` : ""}${context ? `<span data-ui="player-context">${escape(context)}</span>` : ""}</span>
  </span>`;
}
