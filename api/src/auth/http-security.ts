const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://qa.3fc.football",
  "https://app.3fc.football",
] as const;

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [...DEFAULT_ALLOWED_ORIGINS];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .reduce<Record<string, string>>((acc, segment) => {
      const separator = segment.indexOf("=");
      if (separator <= 0) {
        return acc;
      }

      const name = segment.slice(0, separator).trim();
      const value = segment.slice(separator + 1).trim();
      acc[name] = decodeURIComponent(value);
      return acc;
    }, {});
}

export function getCookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  const cookies = parseCookies(cookieHeader);
  const value = cookies[cookieName];
  return value && value.length > 0 ? value : null;
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin || origin.length === 0) {
    return false;
  }

  return allowedOrigins.includes(origin);
}

export function buildCorsHeaders(
  origin: string | undefined,
  allowedOrigins: string[],
): Record<string, string> {
  if (!isOriginAllowed(origin, allowedOrigins)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "content-type,x-csrf-token,idempotency-key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    Vary: "Origin",
  };
}

export function isStateChangingRequest(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function isStateChangeOriginPermitted(
  method: string,
  origin: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (!isStateChangingRequest(method)) {
    return true;
  }

  if (!origin || origin.length === 0) {
    return true;
  }

  return isOriginAllowed(origin, allowedOrigins);
}
