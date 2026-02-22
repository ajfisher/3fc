import { randomUUID } from "node:crypto";

import { buildHealthResponse } from "./index.js";
import { logRequest, logRequestError } from "./logging.js";

export interface ApiGatewayHttpEvent {
  rawPath?: string;
  requestContext?: {
    requestId?: string;
    routeKey?: string;
    http?: {
      method?: string;
      path?: string;
    };
  };
}

export interface ApiGatewayHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface RequestDetails {
  requestId: string;
  route: string;
  method: string;
}

function createJsonResponse(statusCode: number, payload: unknown): ApiGatewayHttpResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  };
}

function getRequestDetails(event: ApiGatewayHttpEvent): RequestDetails {
  return {
    requestId: event.requestContext?.requestId ?? randomUUID(),
    route: event.requestContext?.http?.path ?? event.rawPath ?? "/",
    method: event.requestContext?.http?.method ?? "GET",
  };
}

export function isHealthRoute(method: string, route: string): boolean {
  return method === "GET" && route === "/v1/health";
}

export async function handler(event: ApiGatewayHttpEvent): Promise<ApiGatewayHttpResponse> {
  const details = getRequestDetails(event);
  let status = 500;

  try {
    if (isHealthRoute(details.method, details.route)) {
      status = 200;
      return createJsonResponse(status, buildHealthResponse());
    }

    status = 404;
    return createJsonResponse(status, { error: "Not found" });
  } catch (error) {
    status = 500;

    logRequestError({
      ...details,
      status,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return createJsonResponse(status, {
      error: "Internal server error",
    });
  } finally {
    logRequest({
      ...details,
      status,
    });
  }
}
