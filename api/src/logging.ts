type LogLevel = "info" | "error";

interface RequestLogFields {
  requestId: string;
  route: string;
  method: string;
  status: number;
}

interface RequestErrorLogFields extends RequestLogFields {
  error: string;
}

interface AuthRateLimitLogFields extends RequestLogFields {
  dimension: string;
  retryAfterSeconds: number;
}

interface MagicLinkEventLogFields extends RequestLogFields {
  action: "start" | "complete" | "organiser_invite_start";
  outcome: "success" | "failure" | "blocked" | "unknown";
  reason: string;
  emailHash?: string;
  tokenIdHash?: string;
  correlationId?: string;
}

function writeLog(level: LogLevel, payload: Record<string, unknown>): void {
  const entry = JSON.stringify({
    level,
    service: "api",
    timestamp: new Date().toISOString(),
    ...payload,
  });

  if (level === "error") {
    console.error(entry);
    return;
  }

  console.log(entry);
}

export function logRequest(fields: RequestLogFields): void {
  writeLog("info", {
    message: "request_complete",
    ...fields,
  });
}

export function logRequestError(fields: RequestErrorLogFields): void {
  writeLog("error", {
    message: "request_failed",
    ...fields,
  });
}

export function logAuthRateLimit(fields: AuthRateLimitLogFields): void {
  writeLog("info", {
    message: "auth_rate_limited",
    ...fields,
  });
}

export function logMagicLinkEvent(fields: MagicLinkEventLogFields): void {
  writeLog(fields.outcome === "failure" ? "error" : "info", {
    message: "magic_link_event",
    ...fields,
  });
}
