# Results and entry review / acceptance map

Scope: UX-05 (#136), with cross-stack acceptance recorded in UX-06 (#137).
Parent: PR149, `b09ee27bb7c629e6a9cbcaa28e931d1729afbdb1`, reached
`review:ready` before this slice began. CI34171885475, QA34172029761 and completed
Codex no-findings evidence naming that head are recorded on the parent PR.

## Behavioural claims and falsification

| Claim | Evidence target |
| --- | --- |
| Reports show actual outcome, comparable totals and one log | Layout and results browser fixtures; valid win, scored tiebreak, two-/three-way draw, zero, own goals and assists. |
| Invalid data is not a zero/draw/empty match | Duplicate/missing teams, invalid counts/winner, missing/invalid/duplicate/cross-game timeline and failed-log tests. Valid independent totals remain. |
| Contributions preserve identity | Historical string IDs, repeated nicknames and own-goal/assist assertions. No nickname merging or fabricated scorer tally. |
| Parent mutation recovery remains safe | Confirmed malformed goal response with failed read still resets committed create/edit; uncertain delete/undo retains its original expected event and retry. |
| Joining and claiming do not duplicate or imply access | Pending double-submit, blocked storage, lost/malformed response, edited nickname, separate claim retry, explicit query claim and explicit next join. |
| Invite acceptance and account switching retain the right context | Same-code latch/retry, actual contract rejections, malformed correction, confirmed league identity, restricted query reconstruction and shared-validator fail-closed tests. |
| Sign-in belongs to all existing actors | One panel with Sign in to 3FC / Email address / Send sign-in link, captured-recipient feedback and no account-creation or scorer-access promise. |
| Late authentication reads do not overwrite an action | Deferred positive/negative/rejected probes while sending/after sent, native double submit, and already-scheduled redirect versus valid/invalid submission. |
| Callback mechanics are unchanged | 2999/3000ms boundary, manual/double/timer activation, URL scrubbing, timeout/recovery, missing/OAuth/error states and one alert; failed copy no longer promises automatic completion. |
| No new runtime service or unsafe script split | One versioned auth script before setup on entry pages; shared route metadata, static/dynamic parity, no entry auth-initialization request and existing CSP/header checks. |
| Mobile presentation is usable | Production-built fictional browser fixtures at320/390/430/768/1280, both themes, enlarged text, landscape, keyboard and computed visibility/target sizes. |

## Independent review disposition

Architecture/security preparation confirmed frontend-only scope is adequate.
The pure existing validator can be reused through ordered deferred scripts;
its absence must fail closed. This dependency is documented in
`docs/architecture/results-entry.md`. No new backend contract is implied.

Root-owned auth/layout/workflow review found one P2: HTTP408/5xx after email
acceptance could falsely report that mail was not sent. The response now uses
the same inbox-first uncertainty copy as transport loss. The one-alert test was
updated accordingly. Other initial auth review checks found no issue with
submission revision/latching, captured recipients, callback timer/recovery or
heading-only deployment assertions. Final integrated review follows validation.

Design preparation requested one partial-log error surface, h3 contribution
headings under Match summary, no duplicate logs and callback text describing
the upcoming attempt rather than promising a successful sign-in. These are
included in the final composition.

Review agents never launch validation. Browser-fixture authorship is disclosed;
another reviewer must independently assess that fixture's assertions. All
material integrated findings and final execution counts belong in the versioned
PR packet; this map does not imply pending tests have passed.

Final source and capture review closed the material findings: unknown/stale
join-session probes cannot discard registration or overwrite newer account
state; callback recovery is checked with computed visibility; receipts keep
ordinary full-width text; enlarged totals and date words remain intact. The
design reviewer inspected all20 normal320/390 light/dark captures and the
390px/200% enlarged view. Architecture/security independently reviewed the
fixture assertions and recovery fixes. No material local findings remain.

The malformed league-ID fixture now uses a non-string value. An encoded opaque
string remains a supported single league-route component, not an auth redirect;
a positive compatibility regression proves this. This evidence-disposition
preserves the existing contract rather than inventing a narrower ID grammar.

Bounded fixture corrections retained their decisive assertions: rejected page
copy is checked on the body rather than a legitimate browser-tab title, and the
callback clock is paused before navigation while keeping the2999/3000ms checks.
Earlier foundation scenarios use the actual native team radios and canonical
match navigation introduced by their parent slices.

## Validation and remaining acceptance

Completed local execution:331/331 interaction cases;23/23 layout cases;
311/311 API and379/379 app cases;57/57 review-gate tests; lint/typecheck,
contracts and build. Final results/entry browser file passed49/49. Each owned
group exited0 with no descendants; peak aggregate RSS remained below4GiB.
The final six-suite browser matrix passed159/159. The isolated local M2 passed
4/4, including the real fake-email/database journey and three cleanup cases.
All services exited and the owned in-memory database was removed, leaving
unrelated local containers untouched. Exact-head external results belong in
the versioned PR packet after publication.

Run focused tests, complete affected files, serialized lint/typecheck/full
app/API/contracts/build/review-gate tests, production-built browser fixtures and
one local M2 fake-email/DynamoDB smoke. Confirm actual process exit, monitored
aggregate RSS and descendant cleanup for each command. Deployed QA is a separate
exact-SHA scenario with synthetic credentials and owned fixture cleanup.

AJ's real games are only viewed; mutation tests use dedicated fictional/local
or owned QA data. No callback tokens, cookies or private email are attached to
public evidence. No production release is requested.

Real iOS Safari/Android keyboards, safe areas, date controls and email returns,
and Android Firefox account switching remain physical-device checks for AJ in
#137. Browser emulation and CSS zoom are explicitly not physical-device proof.
Do not close #137 until its outstanding required evidence is recorded. The
redesign does not close partial roster/correction/join work or deferred M3 issues.
