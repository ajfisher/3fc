export type PlayerLinkState = "linked" | "unlinked" | "unknown";

export interface PlayerPresentation {
  name: string;
  linkState?: PlayerLinkState;
  context?: string;
  profile?: PlayerProfileLink;
}

export interface PlayerProfileLink { leagueId: string; playerId: string; seasonId?: string }

/** Opaque identities stay in query values, never interpolated path segments. */
export function profileHref(input: PlayerProfileLink): string | null {
  const entries = Object.entries(input);
  if (!input.leagueId || !input.playerId || entries.some(([key, value]) =>
    !["leagueId", "playerId", "seasonId"].includes(key) || typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value))) return null;
  try { for (const [, value] of entries) encodeURIComponent(value); } catch { return null; }
  return `/player?${new URLSearchParams(entries)}`;
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
export function renderPlayerIdentity({ name, linkState = "unknown", context, profile }: PlayerPresentation): string {
  const state = linkState === "linked" || linkState === "unlinked" ? linkState : "unknown";
  const status = state === "linked" ? "Linked to an account" : state === "unlinked" ? "Not linked to an account" : "";
  const href = profile ? profileHref(profile) : null;
  const label = href ? `<a href="${escape(href)}" data-ui="player-profile-link">${escape(name)}</a>` : escape(name);
  return `<span data-ui="player-identity">
    <span data-ui="player-initial" data-link-state="${state}" aria-hidden="true">${escape(playerInitial(name))}${state === "linked" ? '<span data-ui="player-linked-tick"><span data-ui="icon" data-icon="circle-check" aria-hidden="true"></span></span>' : ""}</span>
    <span data-ui="player-identity-copy"><strong>${label}</strong> ${status ? `<span class="sr-only">${status}</span> ` : ""}${context ? `<span data-ui="player-context">${escape(context)}</span>` : ""}</span>
  </span>`;
}
