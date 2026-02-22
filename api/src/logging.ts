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
