/** Shared error identity without a runtime dependency on transaction planners. */
export class PlayerIdentityError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); }
  get category(): string {
    return { 400: "bad_request", 403: "forbidden", 404: "not_found", 409: "conflict", 503: "unavailable" }[this.status];
  }
}
