<!-- review-packet-version:1 -->

## Behavioural claim

Players can explicitly link an account using private proof from their own fresh
registration or an organiser-issued invitation. Knowing a player ID is no longer
enough to acquire ownership. Invitations are private, replaceable/revocable and
seven-day; ownership and its same-account recovery receipt commit atomically.

Implements #138 (M3-07); delivery epic #157. Stacked on #163,
`codex/player-identity-backlog`. Directory/reuse #159, consolidation #160 and
returning-player joining #161 remain separate children, not claimed complete here.

## Specification and acceptance evidence

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| No first claim from a player ID alone; explicit current-account confirmation | API proof helper/repository tests, shared local/Lambda route boundary checks, recipient confirmation tests; preview returns display and binding from the same resolved session | PASS locally |
| Hash-only seven-day proofs and durable atomic same-owner outcome | 9 focused repository proof cases; real disposable DynamoDB concurrent acquisition returns exactly one owner; consumed receipt loses TTL | PASS locally |
| Organiser-only invitation, predecessor checks, revocation and authority/revision races | Repository transaction-boundary tests; actual local HTTP invitation lifecycle; organiser panel tests | PASS locally |
| Secret-safe sign-in continuation and logout/account-switch purge | Early fragment scrub, session storage + bounded same-origin handoff, no secret in return URL; native WebCrypto recipient tests; pending-response purge tests | PASS locally |
| Truthful retries, keyboard continuation and preserved existing gameplay | Complete setup interactions, full app/API suites, native-WebCrypto recipient tests and repository race tests; invitation replacement clears obsolete copyable links before dispatch | PASS locally |
| Local/Lambda/deployment compatibility and containment | OpenAPI, Serverless routes, shared repository/handler, static object aliases; actual local HTTP disabled-mode restart; docs/runbooks/player-claim-proof.md | PASS locally |
| Exact-head CI, independent GitHub review and deployed acceptance | Previous head a59cc50 passed CI34455135000, QA34455134462 and isolated browser/API acceptance (group19316/session87130); refreshed evidence required after the contract completeness update. Current external evidence is recorded in the PR packet and comments. | PENDING new head |

## Scope boundaries

Included: proof-enforced claims, public self-registration proof, private invitation
controls in existing game rosters, dedicated recipient screen, safe sign-in
continuity, additive proof/pointer records, deployment/contract/tests/runbook.

Excluded: canonical aliases, player directory, consolidation, bulk migration,
returning-player selection, scoring-rule changes, new dependencies, Terraform
resources, production writes, merge/queue/release. No changes to organiser email
invites; profile links are shared privately, not emailed by this feature.

## Change classification

- Declared risk: `high`
- [x] `application-behaviour`
- [x] `public-contract`
- [x] `permission-trust-boundary`
- [x] `durable-state-ownership`
- [x] `authentication-authorisation`
- [x] `privacy-regulated-data`
- [x] `infrastructure-production-configuration`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How this PR affects it | Why it remains valid | Evidence |
| --- | --- | --- | --- |
| INV-001 | New proof preview and account-linked ownership | Preview is authenticated and proof-gated; public join/claim DTOs omit private owner email; credentials never logged/persisted raw | API public DTO tests, paired-account tests, real HTTP log-secret assertion, trace capture disabled |
| INV-002 | New invitation and claim authority | Organiser scope rechecked transactionally; first claim requires exact proof/session binding; no ACL grants from ownership | Negative route/repository tests and real HTTP authentication/origin checks |
| INV-003 | New atomic proof/invitation receipts | Exact creation replay and predecessor conflicts; current binding checked before immutable same-owner receipt; one concurrent owner | Fake race cases plus real DynamoDB contention and committed-request replay |
| INV-004 | New proof and invitation pointer records | Existing profile/registration/event IDs preserved; additive PK/SK patterns documented | docs/dynamodb-single-table.md, repository tests, no migration execution |
| INV-009 | New recipient transport and session-bound confirmation | Existing httpOnly cookies retained; no-store/no-referrer dynamic/API paths, early static meta policy, local script assets, purge on sign-out | Header/static/deployment tests and actual local HTTP; deployed verification pending |

### Architecture or decision record

docs/design/player-identity-delivery.md is the approved delivery contract.
docs/dynamodb-single-table.md records additive key ownership.
docs/runbooks/player-claim-proof.md records rollout, static routing, transport
limits, containment and forward-only recovery. No canonical identity migration is
enabled by this PR. Scoring/events are unchanged and covered by regression tests.

## Failure and rollback

### Failure behaviour

Missing/stolen IDs and proofless legacy links fail closed with organiser recovery.
Expiry, revocation, changed revision/authority and account-switch confirmation
reject acquisition. Transient/lost-result uncertainty retains exact retry bodies;
opening a link or signing in does not claim it. Storage loss requires reopening
the original private link or obtaining a replacement, never bypassing proof.
The accepted bearer tradeoff is visible beside sharing: anyone possessing the
private link can link that unclaimed player; the link is deliberately not email-bound.

### Rollback approach

Deploy the hardened API before the site. Set `PLAYER_CLAIM_MODE=disabled` and
redeploy to stop new proofs/first claims while preserving unclaimed joins,
existing ownership and consumed same-owner recovery. Keep a hardened API artifact
as the baseline; API recovery is forward-only. Never restore proofless acquisition
or delete receipts. Older UI against the hardened API cannot perform new claims.
No Terraform apply or production migration is needed for this PR.

### Rollback evidence

scripts/local/test-player-proof.mjs passed with a real isolated DynamoDB 2.5.2
container: actual local API was stopped and restarted in disabled mode; a join
with claimProof returned201 linkingUnavailable without issuing proof, and that
registration retry plus prior consumed-claim replay passed. The harness checks
replay of a committed request, not injected transport loss; separate UI tests
inject rejected/lost responses and preserve identical retries. API exit and
container removal were observed. Production rollback was not executed.

## Automated and agent review disposition

Independent read-only architecture/security, design/frontend and QA reviewers
found and drove fixes for account-display/binding races, deadline rechecks,
idempotency requirements, stale invitation disclosure after account change,
bounded logout, replacement/revocation consequences, persisted expiry and focus
continuation. Added transaction-boundary and actual HTTP/DynamoDB evidence rather
than treating injected-session helpers as end-to-end coverage.

DOM workflow tests use deterministic SHA-256 completion to isolate interaction
scheduling; dedicated recipient tests use native WebCrypto. No reviewer launched
tests. Root owns all validation groups, capped at 4 GiB; the real DB acceptance
uses 3.5 GiB host + 512 MiB container limits and no existing volume.

Local validation: lint/typecheck and complete API suite passed in group48229;
after bounded app fixture fixes, group50509/session93107 passed complete affected
files, all532 app tests, contract checks, complete monorepo build and57 review-gate
tests. Exit0, peak2811680KiB, remaining[], tripNone. Actual local HTTP/DynamoDB
acceptance group47551/session85109 exited0, peak205824KiB host plus independently
capped512MiB container; API and container cleanup confirmed. No resource anomaly
or orphaned worker occurred. No production or AJ-profile mutation was performed.

Rollout follow-up: QA and production now deploy and smoke the hardened API before
publishing the site, including credential-free probes for the new proof routes.
Recipient aliases and local proof assets are checked after site publication.
Architecture/security reviewed and cleared this ordering; deployment regressions
passed (6 tests). Refreshed full lint, API/app tests, contracts, review-gate tests
and build passed in group52711/session17744: exit0, peak2535920KiB, remaining[],
tripNone. Site marker probes prove route availability, not exact-head provenance;
deployment fingerprint and browser asset version remain the SHA evidence.

### Unresolved blocking findings

None

### Resolved findings and validation history

Codex3977394972/3977394981 accepted. Recipient proof retention now binds to the
server-resolved stable account ID (private preview only, never rendered), retaining
it through reload, recapture, attachment and handoff. It cannot be downgraded or
rebound to another account; mismatches and bound401 purge locally and broadcast.
Same-account session renewal and changed display email do not change ownership.
Binding metadata reaches existing holders and pending handoffs, including an
out-of-order older unbound response. Storage must succeed before confirmation.
Local401 exposes tokenless sign-in and preserves owned/outside focus. Architecture,
security and design reviewed these races/recovery paths and cleared the fixes.
HTTP400 proof errors now use bad_request consistently in shared and join adapters;
noncanonical secrets and wrong-player claim paths retain their machine codes.
Focused34 recipient tests passed group25779/session21382 exit0 peak393616KiB,
remaining[], tripNone; API adapter focused checks also passed group25483.
Full API/app/review-gate tests, lint, contracts, build and actual local HTTP/DynamoDB
acceptance passed group25952/session48992 exit0, peak1728608KiB host plus512MiB
container, remaining[], tripNone. Actual HTTP also asserted stable private account
identity and consistent400 categories; disposable API/container cleanup verified.

New-head external review, CI and deployed acceptance must be refreshed. No child
implementation begins before this parent reaches its required review gate.

Codex3977279870 accepted: malformed invitation game/player identifiers now produce
a denied400 before ACL lookup, rather than an uncaught URIError500. Only route
decoding URIError is mapped; storage/lookup failures still propagate. Missing
sessions retain401. Independent architecture/security cleared. Focused ACL and
local-helper/Lambda matrices passed group22642/session76771 exit0, peak422320KiB,
remaining[]. Actual HTTP coverage is separately recorded after execution.
Complete affected suites, lint, full API/app/review-gate tests, contracts, build
and actual local HTTP/DynamoDB acceptance passed serially: group22727/session23741
exit0, peak2198368KiB host plus bounded512MiB container, remaining[], tripNone.
Actual HTTP covered malformed game/player IDs in GET/create/revoke, malformed
claim IDs, unauthenticated401, valid invitation lifecycle and containment recovery.
The API exited and disposable database container was removed.

Codex3977034764/3977034779 accepted: machine-coded claims_unavailable503 restores
the predecessor link only for an attempt with no earlier uncertain dispatch.
Previously lost responses remain frozen; containment does not prove their prior
outcome. OpenAPI now declares preview404, matching missing-proof/wrong-secret
local-helper and Lambda-adapter assertions (not actual HTTP evidence).
Independent QA cleared. Thirteen invitation tests plus two focused API/contract
checks passed group16794/session33575, exit0 peak431296KiB remaining[] tripNone.
Full affected-file, lint/API/app/review-gate tests, contracts and build passed
group16939/session40814, exit0 peak2086416KiB remaining[] tripNone.

Codex3976866900 accepted: private invitation cleanup now uses an explicit dispatch
callback after the synchronous game-write barrier. A fresh attempt blocked before
fetch preserves the active displayed link and retires only the never-sent request;
a previously uncertain attempt remains frozen. Revocation likewise distinguishes
a never-sent action from a blocked retry of an earlier uncertain action. Tests
drive actual metadata503 write locking and verify no replacement/revoke fetch,
retained link/Copy and truthful prior-uncertainty messages. QA reviewed and cleared.
Eleven focused invitation tests passed group13937/session96737: exit0,
peak425184KiB remaining[] tripNone.
Full affected-file, lint/API/app/review-gate tests, contracts and build passed
group14067/session87781: exit0 peak1764176KiB remaining[] tripNone.

Codex3976768885 accepted: QA/production now explicitly export the GitHub
Environment variable PLAYER_CLAIM_MODE into core deployment. The script validates
the enum before build/deploy and verifies the live nonsecret mode with the
code/revision fingerprint; mismatch prevents site publication. Runbook specifies
the variable and authorised terminal alternative. Architecture/security cleared.
Eight deployment regressions passed group10984/session82204, exit0
peak420832KiB remaining[] tripNone. The first path-only invocation looked for
tests under dist instead of dist-tests and exited1 cleanly; no test/resource
anomaly occurred. Existing actual-HTTP disabled-mode behavior evidence is retained;
configuration checks alone are not described as behavioral containment testing.
Shell syntax, full lint/API/app/review-gate tests, contracts and build passed
group11212/session55897, exit0 peak2364032KiB remaining[] tripNone.

Codex comments3976509993/3976510001 accepted: detected cookie-account changes
now purge retained bearer proofs and stop handoffs. Invitation-creation replay
checks eligibility and transactionally fences the current proof, pointer, profile
and authority; revoked/replaced/consumed/raced requests return claim_invite_changed.
An authoritative changed response retires even a previously uncertain request.
QA additionally found an obsolete displayed link surviving a lost replacement
response: replacement now clears it before dispatch and disables Copy throughout
uncertainty. Tests start with an actually displayed link and verify exact-request
retry without resurfacing it. Architecture/security and QA cleared these fixes.

Focused invitation regressions passed group5439/session30546: eight tests,
exit0, peak399312KiB, remaining[], tripNone. A subsequent affected-file command
used the repository root instead of the required app working directory, failed
with ENOENT, and exited with no remaining workers; the corrected run is tracked
separately. This was a command-path error, not a resource anomaly.

Corrected affected-file and full serial lint/API/app/contracts/review-gate/build
validation passed group5542/session69375: exit0, peak2187616KiB, remaining[],
tripNone. Real local HTTP/DynamoDB acceptance for the account/replay changes also
passed group3219/session47161, peak2026608KiB, with API/container cleanup verified.

Codex3976654185 accepted: preserve a displayed active link when local replacement
proof storage fails before any POST. Clearing now occurs after proof/request
freezing, immediately before dispatch, preserving both local-failure recovery and
lost-response safety. Actual Storage.setItem rejection regression verifies no
replacement POST and retained link/Copy through close/reopen. Independent QA
cleared; nine focused invitation tests passed group8021/session7546, exit0,
peak404304KiB, remaining[], tripNone.
Full serial affected-file, lint, API353/app537/review-gate57 tests, contracts and
build passed group8145/session78582: exit0, peak2243456KiB, remaining[], tripNone.

Previous head f570f3e passed CI34450351527 and QA34450351484; deployed disposable
acceptance group7734/session99872 exited0 peak724144KiB remaining[] tripNone.
It verified actual account-switch purge as well as linking, replay and revocation;
all fixture keys were removed. This evidence is refreshed after the local-only
replacement recovery fix, not represented as current-head acceptance.

Codex follow-up3976413105 accepted: even revoked/consumed/TTL-missing invitation
retries now transact pointer/context checks and an unchanged-proof or absence
condition; no successful revoke path returns before its transaction. New
revoked/missing race and safe retry tests passed; architecture review cleared.
Full serial lint/API/app/contracts/review-gate/build plus local HTTP/DynamoDB
acceptance passed group99841/session21169 exit0 peak2941952KiB remaining[] tripNone.

Previous-head c0fdf0d deployed acceptance passed under group99470/session98407:
explicit signed-in browser linking, fragment scrub, proofless-ID rejection,
stale-revoke409/current-link validity, same-owner claim replay and wrong account,
320/390/430/768/1280 overflow checks and light/dark. Full API code/revision
fingerprint matched the deployment manifest before and after. Exact fixture keys
and sessions were deleted and strong-read absence verified; browser exited.
This is browser emulation, not physical-device evidence, and must be rerun at
the replacement head.

### Rejected findings and evidence

None. Codex comments3976053681/3976053687 accepted: revocation now checks and
transactionally fences the active invitation pointer, and disabled-mode web joins
preserve one registration without issuing proof. A separate immutable hashed
join receipt preserves that outcome across retries, assignment and mode changes.
The recipient conflict UI reloads the current link rather than claiming success.

QA run34443498659 exposed a trailing-slash S3 alias403: s3 cp appended the source
filename. Exact s3api put-object keys replace it, with executable stub-argv and
failure-propagation coverage. Both URL variants require deployed revalidation.

Refreshed full lint, API/app tests, contracts, review-gate tests and build passed,
followed by actual local HTTP/DynamoDB acceptance (including disabled-mode web
payload replay): group97268/session65005 exit0 peak2234000KiB remaining[] tripNone.
The separately bounded512MiB database was removed and API exit observed.
Architecture/security cleared the separate immutable receipt design; independent
design/QA follow-up and new exact-head external evidence are tracked separately.

## Human judgement

- [x] `human-judgement:none`

### Decision requiring judgement

None.

### Options considered

None.

### Reason selected

None.

### Reversal cost

None.

## Review focus

### Contract completeness review

Codex findings3977134314 and3977134321 accepted. The contract now documents
claim containment503 and missing invitation context404. Architecture/security
also audited every response on the six touched join/proof operations: origin403,
malformed-path400, internal500 and schema-backed503 coverage is explicit. Join
and claim success use the strict public-player DTO; containment registration201
and invitation creation replay restrictions are documented. No runtime behaviour
changed in this update. The injected-session local helper and Lambda adapter
tests prove disabled claim503 leaves ownership unchanged and missing invitation
context returns404; these are not described as actual HTTP tests. Independent
QA review found no blocker. Focused validation group19896/session30776 exited0,
peak443936KiB, remaining[], with both contract/adapter cases passing.
Complete affected files, lint, full API/app/review-gate tests, contract checks and
build then passed serially: group19933/session77423 exit0, peak2233808KiB,
remaining[], tripNone. No runtime or deployment implementation changed.

Try to falsify account/session binding, proof issuance scope, transaction/race
conditions, immutable receipt precedence, secret persistence/logging, cross-tab
purge, static route delivery and retry ownership. Verify claims against exact
current-head evidence. AJ retains all merge and production authority.
