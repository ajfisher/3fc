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
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${cookieName}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
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

  if (method === "DELETE" && /^\/v1\/leagues\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/seasons\/[^/]+$/.test(route)) {
    return true;
  }

  if (method === "GET" && /^\/v1\/seasons\/[^/]+\/games$/.test(route)) {
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

  if (method === "GET" && route === "/v1/auth/session") {
    return true;
  }

  if (method === "POST" && route === "/v1/leagues") {
    return true;
  }

  if (method === "POST" && /^\/v1\/leagues\/[^/]+\/seasons$/.test(route)) {
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
