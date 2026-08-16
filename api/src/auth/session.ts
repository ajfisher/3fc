export const DEFAULT_SESSION_TTL_SECONDS = 8 * 24 * 60 * 60;

export function resolveSessionCookieSecureFlag(
  explicitValue: string | undefined,
  appBaseUrl: string,
): boolean {
  if (explicitValue !== undefined) {
    return explicitValue.toLowerCase() === "true";
  }

  return appBaseUrl.startsWith("https://");
}

export function buildSessionCookie(
  cookieName: string,
  sessionId: string,
  expiresAt: string,
  secure: boolean,
): string {
  const expiresAtDate = new Date(expiresAt);

  if (Number.isNaN(expiresAtDate.getTime())) {
    throw new Error("Session cookie expiry must be a valid date.");
  }

  const parts = [
    `${cookieName}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAtDate.toUTCString()}`,
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function isAuthenticatedApiRoute(method: string, route: string): boolean {
  if (method === "GET" && route === "/v1/leagues") {
    return true;
  }

  if (method === "GET" && /^\/v1\/leagues\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/leagues\/[^/]+\/seasons$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/leagues\/[^/]+\/seasons\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "DELETE" && /^\/v1\/leagues\/[^/]+\/seasons\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/leagues\/[^/]+\/seasons\/[^/]+\/games$/.test(route)) {
    return true;
  }

  if (method === "DELETE" && /^\/v1\/leagues\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/seasons\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/seasons\/[^/]+\/games$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/seasons\/[^/]+\/teams$/.test(route)) {
    return true;
  }

  if (method === "PUT" && /^\/v1\/seasons\/[^/]+\/teams\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "DELETE" && /^\/v1\/seasons\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/games\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "PATCH" && /^\/v1\/games\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "DELETE" && /^\/v1\/games\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/games\/[^/]+\/teams$/.test(route)) {
    return true;
  }

  if (method === "PUT" && /^\/v1\/games\/[^/]+\/teams\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/games\/[^/]+\/players$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/games\/[^/]+\/goals$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/games\/[^/]+\/players$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/games\/[^/]+\/roster$/.test(route)) {
    return true;
  }

  if (method === "PUT" && /^\/v1\/games\/[^/]+\/roster\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/games\/[^/]+\/thirds\/[^/]*\/start$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/games\/[^/]+\/thirds\/[^/]*\/finish$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/games\/[^/]+\/finish$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/games\/[^/]+\/goals$/.test(route)) {
    return true;
  }

  if (method === "PATCH" && /^\/v1\/games\/[^/]+\/goals\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "DELETE" && /^\/v1\/games\/[^/]+\/goals\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/games\/[^/]+\/goals\/undo-last$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/players\/[^/]+\/claim$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/leagues\/[^/]+\/access$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/leagues\/[^/]+\/organiser-invites$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/invites\/[^/]+\/accept$/.test(route)) {
    return true;
  }

  if (method === "GET" && route === "/v1/auth/session") {
    return true;
  }

  if (method === "POST" && route === "/v1/leagues") {
    return true;
  }

  if (method === "POST" && /^\/v1\/leagues\/[^/]+\/seasons$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/leagues\/[^/]+\/seasons\/[^/]+\/sessions$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/leagues\/[^/]+\/seasons\/[^/]+\/sessions\/[^/]+\/games$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/seasons\/[^/]+\/sessions$/.test(route)) {
    return true;
  }

  if (method === "POST" && /^\/v1\/sessions\/[^/]+\/games$/.test(route)) {
    return true;
  }

  if (method === "POST" && route === "/v1/dev/items") {
    return true;
  }

  if (method === "GET" && route.startsWith("/v1/dev/items/")) {
    return true;
  }

  if (method === "POST" && route === "/v1/dev/send-email") {
    return true;
  }

  return false;
}
