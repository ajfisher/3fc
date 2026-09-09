# Current-session sign-out

Scope: M1-13 / #114, the auth-sign-out slice of the frontend redesign. This is a
session lifecycle and authentication trust-boundary change, not a new device or
identity model. Public contracts add only `POST /v1/auth/logout`.

## Ownership and state

The cookie carries the existing opaque session ID. Revocation deletes precisely
`AUTH_SESSION#<sessionId> / METADATA` with DynamoDB `DeleteItem`. No user, player,
ACL, game or token records are deleted. Missing/expired/unknown/already-deleted
sessions all complete safely. Malformed or oversized cookie values cannot make
an invalid DynamoDB key, and an unrelated malformed cookie cannot block logout.

Protected requests strongly read the session, making deletion authoritative for
requests authenticated after it completes. An already-authorized operation may
finish; logout is not cancellation of in-flight game writes. A completion already
holding a linked session may return its now-dead ID, but cannot recreate it.

Consumed magic tokens retain their used flag and session reference. Recovery
strongly reads that referenced session and rejects absence. It must never treat
revocation as a fresh unused token. One magic link can authorize copies of the
same session across browsers, so deleting that shared session invalidates all of
them. Independently issued sessions remain valid.

## HTTP, UI and failure ownership

Both local and Lambda routes retain existing origin enforcement. A supplied
foreign Origin is rejected before deletion; the existing absent-Origin policy
for non-browser clients is unchanged. Logout deliberately bypasses the normal
valid-session requirement so repeated/invalid sessions can clear their cookie.

Only confirmed deletion (or an absent/invalid identifier) returns HTTP 204 and
expires the same host-only cookie: original name, Path=/, HttpOnly, SameSite=Lax,
environment-appropriate Secure, past Expires, Max-Age=0, no Domain. Responses are
no-store. Storage errors return a stable 503 without SDK detail or cookie expiry.
A response lost after deletion is uncertain: preserving the retry credential
allows another safe deletion instead of falsely claiming success.

The frontend reveals Sign out only after a successful existing session read. A
synchronous request latch prevents duplicate activation; only 204 clears local
auth-return/callback state and replaces history with sign-in. Failure preserves
drafts and retry. Restored BFCache authenticated pages hide stale content and
reload for session revalidation, rather than reusing a previous account's DOM.

## Deployment and rollback

Local uses DynamoDB Local through the same service. AWS uses the existing API
core Lambda and explicit POST/OPTIONS Serverless routes. The table-scoped runtime
role already grants DeleteItem; no new IAM, Terraform, package or migration.
QA/prod workflow smoke calls supply no session and do not revoke a user's login.

QA acceptance uses out-of-band deployment evidence, not a new public endpoint.
The deployment manifest records the full checkout SHA and a base64 SHA-256 of
the actual individually packaged `.serverless/core.zip`. The live Lambda code
hash must match that digest before the manifest is emitted. The successful QA
run retains the manifest as an artifact. Before and after isolated acceptance,
the fixture requires that exact-head run and matching live code/revision. This
rejects a concurrent deployment being attributed to another checkout. Only four
non-secret function metadata fields are queried; no environment values, new
IAM permissions or API/authentication contract changes are introduced.

Rollback redeploys the reviewed parent API/site head
`69b1cc5e1ecc9d5bbb452f1247fc59aa5e01740d`. The parent already rejects consumed
links whose referenced session is absent; a deleted session therefore stays
revoked after rollback. Nothing restores credentials. Users whose sessions were
deleted can request a new link. Roll back site and API together to remove the
Sign out action and route coherently; unrelated data is unchanged. Automated
revoked-token and persisted-format tests demonstrate this compatible state;
no rollback against shared QA is claimed without an executed deployment.

## Invariants and acceptance

- INV-001: no email, cookie or token enters public response, telemetry or evidence.
  Logout returns no identity; fixed error categories omit storage diagnostics.
- INV-002: strong post-revocation auth lookup rejects protected reads/writes;
  no league ACL or role changes. Deletion cannot target another ID without that
  session credential.
- INV-009: matching cookie expiry attributes, unchanged CSP/CORS defaults,
  no-store and server-enforced revocation.

Evidence lives in auth service/cookie tests, local/Lambda route parity tests,
frontend sign-out/recovery/BFCache tests and deployed current-head review packet.
Physical iOS/Android and Android Firefox checks remain explicit cross-stack
acceptance work (#137); desktop Chromium emulation is not physical-device proof.
