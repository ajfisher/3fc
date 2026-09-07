# Sign-out implementation review

PR slice: `codex/auth-sign-out` on validated foundation
`69b1cc5e1ecc9d5bbb452f1247fc59aa5e01740d`. Scope #114/M1-13; live
current-head CI, Codex and QA results are attached to the PR packet after push.

## Independent review and disposition

Architecture/security, design/content/accessibility and QA/engineering reviews
were independent of the two bounded implementation agents. Reviewers remained
read-only; the primary agent owned every validation process.

| Finding | Disposition and evidence |
| --- | --- |
| Initial join lacked an account-switch action until joining could claim | Fixed with a non-blocking session read; signed-in/anonymous tests prove no new join/claim mutation. |
| Fresh BFCache validation could reuse a cached session response | Fixed no-store on session reads, success/unauthorized API responses and existing-sign-in probe; BFCache hides stale shell before one reload. |
| A late join session probe could hide uncertain logout and its retry | Fixed separate pending/unconfirmed ownership; six deferred request-order tests check latch, every ancestor and successful retry. |
| New account test's mock returned every league | Test-local scoped API response now mirrors production; strict old-league absence and cross-account 403 assertions retained. No production ACL change. |
| QA cleanup could delete a token while completion created a linked session | Fixed ownership/state-conditional deletion with bounded rereads; session-first cleanup preserves linkage on failure. Seven local mock tests cover races, ownership and continued cleanup. |
| Playwright API error logs could disclose fixture cookies despite tracing off | Removed APIRequest credential transport. Bounded native fetch, safe cookie installation and fixed phase errors suppress details; local fault-injection test verifies redaction. |
| GitHub Codex review: site asset SHA does not prove the API revision | The successful exact-head QA run now preserves an API manifest. The fixture verifies its full SHA and the live Lambda code/revision before any fixture writes and again before reporting acceptance. |
| Independent security re-review: a concurrent QA deployment could be misattributed to this run | Bind the live code hash to this invocation's packaged core ZIP before emitting the manifest; reject a recorded/live pair that differs from the package digest. No runtime provenance endpoint or secret environment read is added. |

No rejected findings. Production architecture, engineering/QA and visual reviews
passed after fixes. The QA harness receives its own security re-review before any
remote execution. Later organiser-shell composition and physical-device tests
are not claimed as this slice's visual evidence.

## Local evidence

- Focused API revocation/cookie checks: 39 passed. Complete affected API files:
  170 passed, including local/Lambda parity, deployment routes and strong reads.
- Focused join/sign-out race regressions: six passed. Complete interaction file:
  112 passed. Full repository lint, tests, contracts and build then passed.
- Full repository run: process group 89786, exit 0, peak 808240 KiB, no survivors.
  Review-gate suite included: 57 passed. Ceiling was 4194304 KiB.
- Real Chromium keyboard/failure/retry/cookie-navigation fixtures: six passed at
  320/390/1280px, both system themes; process group 89548, exit 0, peak 633728 KiB.
- QA harness TypeScript check and nonremote tests: eight passed, deployed case
  deliberately skipped without opt-in; group 91456, exit 0, peak 602336 KiB.
- Provenance fix: five deployment-config tests passed; QA harness TypeScript,
  nine nonremote tests and 57 review-gate tests passed. Groups 93058/93133 exited
  0 with peaks 564976/634544 KiB and no survivors. Architecture/security re-review
  approved source-package binding before publication.
- Full repository lint, tests, contracts and build repeated after that fix:
  group 93303, exit 0, peak 915024 KiB, no survivors.
- All commands serialized; every returned session was observed to actual exit
  and group cleanup verified. Ordinary fixture failures were isolated and
  corrected through single-test → file → broader validation, with no resource
  anomaly or circuit-breaker trip.

## Deployed acceptance boundaries

Workflow no-cookie smoke proves POST/OPTIONS routing, CORS, expiry-cookie and
no-store transport, not authenticated deletion or execution-role authorization.
The separate opt-in QA test uses two synthetic authentication fixtures with no
SES delivery and no league, roster, game or ACL changes. It verifies site asset
SHA, actual Lambda completion, browser Sign out, cookie expiry, revoked-cookie
401, consumed-link replay rejection and a different-account sign-in. Deployment
run metadata and its preserved API artifact must prove the full source SHA,
successful deployment, source-package digest and matching live Lambda revision.
The fixture verifies provenance before creating records and again before claiming
acceptance; stale, failed, replaced and rolled-back deployments fail closed.
Only counts/SHA and safe phase outcomes are reported; no trace, screenshots,
video, bearer-bearing URL or credentialed APIRequest log is captured. Cleanup
verifies ownership and removes only synthetic tokens and their linked sessions.

Real Android Firefox/iOS checks remain cross-stack #137; desktop Chromium is not
physical-device evidence. #114 is referenced, not prematurely auto-closed while
that criterion is outstanding. Rollback and invariant reasoning are recorded in
[session sign-out architecture](../architecture/session-sign-out.md).
