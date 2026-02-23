function normalizeApiOrigin(apiBaseUrl: string): string | null {
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(apiBaseUrl: string): string {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ];

  const apiOrigin = normalizeApiOrigin(apiBaseUrl);
  const connectSrc = apiOrigin ? `connect-src 'self' ${apiOrigin}` : "connect-src 'self'";
  directives.push(connectSrc);

  return directives.join("; ");
}

export function buildSecurityHeaders(apiBaseUrl: string): Record<string, string> {
  return {
    "Content-Security-Policy": buildContentSecurityPolicy(apiBaseUrl),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-site",
  };
}
