# Joined-player identity and Unassigned visibility

UX-09 / #152 builds on PR154 at
`a1cccc18a13e92843e1c8740cec374993afd1953`. Parent review:ready, CI34193345615,
QA34193484313 and current-head Codex completion5580204505 were verified before
starting this child. No parent was merged.

## Behaviour and copy

The existing Player/name receipt identifies the exact player before Claim player
is enabled after a sign-in return. The name comes from an authenticated,
join-code-and-registration-bound read, not a nickname query parameter or guessed
identity. Claim player is described by that visible name. Loading says
“Loading player…”. Unavailable context has no enabled Claim action. Retry lookup
performs reads only. Join another player abandons the lookup, retains no stale
name, and makes late responses harmless. Retry completion restores focus only
while that interaction still owns it.

Exact recovery copy:

- “The player details couldn’t be loaded. Retry lookup or sign in again.”
- “This player couldn’t be found for this join link. Ask the organiser for help.”

Existing fresh authenticated Join game behaviour is preserved: a confirmed
registration may continue its existing automatic claim. Merely opening a query
return, loading an identity or retrying that read never claims a player. Displaying
a verified nickname is not evidence that the account owns that player.

Unassigned uses all registered, unassigned identities from the authorized roster
read, independently of the existing top-20 player search/private enrichment.
Names are filtered locally with the existing search and deduplicated by ID;
same-name players are not merged. Confirmed pending additions remain available,
and confirmed assignments move the player to one team row. Unassigned players
are not scorer/assist candidates until assigned. Existing viewer presentation and
finished assignment locks remain unchanged.

On a mixed-version response lacking a valid new collection, existing search is a
limited fallback, not proof that Unassigned is empty. Show “The full Unassigned
list is unavailable. Search by name to find players.” and, if that search has no
rows, “No players found in the available search.”

## Trust boundaries and pre-implementation review

Independent architecture/security and QA reviews approved these bounded support
changes before backend implementation:

- Authenticated GET `/v1/join/{joinCode}/player-context?playerId=…` verifies the current
  join-code mapping, exact game-player registration and profile. It returns only
  gameId, joinCode and explicit public player fields. It grants neither ownership
  nor league access. Invalid/mismatched context reveals no global player identity.
- Existing ACL-protected roster GET adds `unassignedPlayers`, an array of public
  identities. Existing viewers share that public read visibility; no new write
  authority follows from it. Private administrator enrichment remains separate.
- Complete registration/assignment reads need scoped pagination and bounded
  profile lookup concurrency. A greater-than-20 fixture alone cannot prove Dynamo
  pagination. Exact fresh registration/profile reads must be consistent.
- Local and Lambda handlers, session classification, strict public OpenAPI shape
  and deployed GET/OPTIONS routes must agree. No new IAM privilege is intended.

INV-001 protects private identity; INV-002 preserves authorization; INV-003 keeps
existing join/claim retry semantics; INV-004 preserves registration keys and
ownership; INV-009 preserves cookies, CORS and security headers. This is a new
authenticated display read, not deferred ownership-proof claim hardening.

## Independent findings and dispositions

The design reviewer inspected production state transitions, markup and the
optional deployed QA helper without running tests or browser workers. That
reviewer authored the local browser fixtures, so their review is independent of
the production UI and QA helper, not independent validation of their own tests.

| Finding | Disposition and evidence boundary |
| --- | --- |
| Retry lookup hid the focused control without restoring a useful continuation. | Fixed: the retry tracks focus ownership and restores visible, enabled Retry lookup after failure or Claim player after success. Navigation or Join another player wins over old completion. Source-reviewed; covered by the completed interaction-file run below. |
| An old identity lookup could settle a newer flow's pending state. | Fixed: claim, flow and lookup revisions invalidate old responses and their cleanup independently. Join another player allows a new flow while the old GET remains pending. Source-reviewed; delayed-response interaction cases are in the completed run. |
| Private search could retire a pending created player after the complete roster refresh failed, making the confirmed player disappear from Unassigned. | Fixed: private search does not retire that overlay while a complete public roster snapshot exists. Public roster/assignment acknowledgement retires it; legacy fallback keeps its existing behaviour. Source-reviewed; the failed-refresh/search-acknowledgement regression passed in the interaction-file run. |
| HTML parsing could normalize distinct opaque player IDs, directing assignment or transfer to a different registration. | Fixed: JSON-encoded identity attributes are restored through DOM setters before roster controls become interactive. The CR/LF and NUL/replacement-character collision regressions passed, followed by the full 398-test interaction file. |
| The optional QA helper removed its write guard before leaving Join. | Fixed: the guard stays installed through navigation to Home and the zero-write assertion. On failure it remains until the owned context closes. Source-reviewed; no deployed execution is claimed. |
| QA name comparison could pass while the receipt remained hidden. | Fixed: the helper now asserts visible receipt and name, the exact API-derived nickname, the Claim description relationship and keyboard focus, without activating Claim. Source-reviewed; browser execution remains pending. |
| An asynchronous QA route error could escape sanitized diagnostics. | Fixed: the guard catches and flags transport errors, safely attempts abort, and checks the flag inside the sanitized helper boundary. This was an inferred diagnostic risk, not an observed credential leak. Source-reviewed; deployed execution remains pending. |

The public roster collection is copied into a display-only shape and does not
populate `verifiedAdminPlayers`. Missing private enrichment therefore does not
invent a claim badge or promotion authority. Verified join display context does
not establish ownership, and query-return lookup does not trigger a claim. No
remaining material production design finding was identified in this source
review. The subsequent bounded rendered review is recorded below.

The optional QA helper requires explicit opt-in and approved existing display
IDs, uses the owned synthetic account, and performs only reads of that context.
Its guard blocks browser mutations; it never joins, claims or assigns a player.
The random nonexistent-ID check is recorded as `missing404`, not evidence of a
separately exercised cross-game identity. Credential transport errors and
assertion output remain sanitized; captures, traces and video are disabled.

## Validation and rollback

Required: exact linked versus foreign/global-only/duplicate-name identities;
missing/revoked sessions; encoded IDs; no read side effects; strict public fields;
multi-page and over-20 roster reads; failed private enrichment; delayed context
and assignment responses; missing-field fallback; local/Lambda/deployment parity;
mobile keyboard/focus and claims requiring deliberate activation on return.

Completed evidence at this review checkpoint is reported by the root, which
owns serialized validation under the repository resource ceiling:

- App interaction file: 396/396 passed, including the baseline and new UX-09
  cases for retry focus and pending creation. After both opaque-ID collision
  regressions passed, the full interaction file passed 398/398, process group
  93121, peak RSS 1,612,912 KiB. The 398 result supersedes the earlier 396 result.
- API affected suites: 324 passed, process group 92804, peak RSS 553,248 KiB,
  observed exit 0. The Lambda suite reported 105 passing cases. Two new
  role/assignment cases initially encountered 404 because their fixture omitted
  the existing required season; the fixture was corrected, not the production
  authorization rules.
- The shared local join-context adapter is tested for session-required access,
  public DTO output, unavailable reads and no-store responses. The local
  server's top-level session-store-error path is source-reviewed only: its
  route-specific catch returns generic 503/no-store. Calling the adapter with an
  already resolved session does not exercise that outer auth-resolution path.
  Lambda session-store 503/no-store handling has a direct handler test.
- Focused browser acceptance: 14/14 passed, process group 93429, peak RSS
  1,090,656 KiB, observed exit 0 and no remaining children. These are local
  production-built fixtures with fictional intercepted transport, not deployed
  QA or real player data.

- Both complete affected browser suites passed107/107, process group93573,
  peak RSS1,605,296KiB, exit0 and no remaining children.
- Final six-suite built-asset browser matrix passed180/180, process group95550,
  peak RSS1,769,920KiB, exit0 with no remaining children. No physical-device
  testing is claimed by these Chromium fixtures.
- Final serialized lint, complete tests, contract checks, build, strict browser
  fixture typecheck and backlog validation/export passed in group93981,
  peak RSS1,684,432KiB, exit0 with no remaining children. This includes324 API
  tests, the complete app suite and57 review-gate tests.

No child deployment, deployed QA,
current-head Codex completion or final review gate is claimed. The PR packet will
map those exact-head checks and failure/rollback evidence when available. Review
agents have not launched validation workers.

## Rendered review checkpoint

The independent design reviewer viewed these existing local screenshots under
`/tmp/3fc-ux-validation.8CLLfa/join-focused/`, without launching a browser:

- `results-entry-claim-return-430ea-ore-explicit-activation-320-chromium-mobile/claim-verified-name-320.png`
- `results-entry-claim-return-80b9b-ore-explicit-activation-390-chromium-mobile/claim-verified-name-390.png`
- `results-entry-a-failed-ide-50b8a-fore-enabling-a-named-claim-chromium-mobile/claim-lookup-retry-dark-320.png`
- `match-roster-complete-Unas-148f5-ivate-enrichment-capped-320-chromium-mobile/complete-unassigned-filtered-320.png`

Scoped rendered disposition: pass, with no material UI or copy findings in these
four states. The full Player name is readable at light 320px and dark 390px,
directly preceding the deliberate Claim player action; its focus ring is clear.
The dark 320px lookup-failure state explains the missing context and presents
Retry lookup and sign-in without an unnamed Claim action. The light 320px
filtered roster keeps the long name readable, presents three separately labelled
team choices, and distinguishes no matching assigned players from the unchanged
team totals. Its claim badge follows successful private search enrichment; it is
not evidence that public identity data supplies claim status.

These images support the reviewed mobile composition, plain surfaces and visible
states only. They do not establish physical-device behaviour, every viewport or
zoom state, a complete accessibility audit, or deployed acceptance. Interaction
and transport claims rely on their separate executed tests, not screenshots.

## GitHub review: encoded gateway identity

Codex review5138544044 on0a8eb209caf735e4747d1ba84cbcb4fdd1c6d39d
identified decoded HTTP API context paths as a missing deployment boundary.
An anonymous QA probe additionally demonstrated that the single-segment gateway
route rejected encoded slash before Lambda (gateway404), while encoded backslash
reached Lambda's401. [AWS route documentation](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-routes.html)
describes decoded parameters and greedy path variables.

The first attempted fix (superseded after deployed verification below) was scoped to the new GET/OPTIONS transport route: `{playerId+}` lets the
gateway pass encoded slashes, but the application accepts one raw encoded ID
component only. The GET chooses rawPath before context-path decoding; other
routes retain their original precedence. Session classification, safe failures
and logging use that same selected path. Exact membership decodes each capture
once; literal extra separators remain404 and do not read player data. No ANY
route or write permission is introduced. Architecture approved this adjustment
before the deployment edit. Realistic Lambda events now distinguish encoded
rawPath from decoded context path, including percent/double-decode cases.

Post-fix deployed acceptance must prove encoded-slash anonymous401/no-store and
authenticated once-decoded missing-ID404, alongside the ordinary named receipt.
Initial12/12 deployed acceptance at0a8eb20/run34198052736 passed, but does not
prove the corrected head; fresh CI, Codex and QA evidence are mandatory.

The transport fix passed four focused cases, then113 Lambda/deployment cases.
Independent architecture and engineering/QA re-review found no material blocker.
Final serialized lint/full tests/contracts/build/strict QA-fixture typecheck and
11 QA safety tests passed in group98742, exit0, peak2,116,992KiB, no children;
the deployed test was deliberately skipped in that local run. API coverage now
contains327 passing tests. The unchanged frontend's180-case browser matrix
remains applicable; exact-head deployed acceptance is rerun after publication.
The local M2 smoke also passed4/4 in group97469, exit0, host peak1,331,632KiB
plus a hard512MiB ephemeral database. All owned services exited and the database
container was removed; no real data or credentials were captured.

### Deployed falsification and final query transport

Although bfde481 passed CI34199120362, QA deployment34199623186 and Codex's
explicit no-new-issues completion5581070407, the additional deployed identity
check failed. Group18666 exited1 cleanly (peak874,960KiB, no children), removing
its one owned authentication fixture and browser context without cleanup errors.
Anonymous probes demonstrated encoded slash now reached Lambda but returned404,
and a literal percent identity returned gateway400. These observations falsify
the first fix's transport assumption; passing emulated events were insufficient.
No authentication tokens or user data were captured in diagnostic evidence.

Architecture/security approved replacing only this unreleased display endpoint
with a fixed ASCII path and an opaque query value before implementation:
`GET /v1/join/{joinCode}/player-context?playerId=…`. The browser uses
URLSearchParams and checks lossless round-trip identity. Both adapters strictly
decode the raw query exactly once, require one nonempty playerId, and reject
malformed/duplicate values. Slashes, literal percent signs and plus characters
remain part of the ID, never route syntax. Exact membership/profile checks and
the public DTO remain unchanged. The unreleased greedy routes and rawPath
precedence override are removed; all existing routes keep their original
semantics. QA mixed-version failure remains the documented fail-closed404.

Independent engineering/QA found no material issue in the final parser,
adapters, auth ordering, contract or deployment diff. Independent frontend/design
review found no material issue in the query construction or guarded deployed
acceptance helper. Validation is owned by the root, not those reviewers:

- Query interaction focused8 passed, then400/400 full interaction cases,
  groups21845/22653 exit0, peaks439,664/1,708,704KiB, no children.
- Query backend focused16 passed, then134/134 full affected Lambda/shared
  reads/session/deployment cases, groups24312/24376 exit0,
  peaks558,736/163,344KiB, no children.
- Three exact-query browser regressions passed, then64/64 complete results and
  entry browser cases, groups24418/24526 exit0, peaks863,504/1,558,992KiB,
  no children. These are production-built fictional fixtures, not gateway proof.
- Final lint, complete API/app tests (448 app cases),57 review-gate tests,
  contracts, build, strict browser fixture typecheck,11 QA safety tests and
  backlog validation/export passed in group24775, exit0,
  peak2,147,376KiB, no children. The deployed scenario was skipped locally.

Final query-head Codex/CI/deployed QA verification remains required before
readiness; the earlier path-based external passes remain historical.

## Rollback order

The existing QA workflow deploys the site, API health and API core in that order;
this slice does not change it. The additive response remains compatible with the
parent frontend. During the site-first interval, a new frontend encountering the
old API shows the limited roster-search fallback and hides Claim on context404.
That terminal lookup state requires reloading after the API deployment, not an
automatic retry. A site-only deployment is not completed acceptance: require a
successful API deployment and exact-head provenance before QA/review readiness.
Architecture review accepted this bounded temporary degradation; a separately
authorized manual rollout could deploy API first to avoid it.

Roll back the frontend first, then the API, to the validated parent; no migration
or reversal of durable join/claim/assignment writes is needed.
No rollback deployment, merge or production release is implied.
