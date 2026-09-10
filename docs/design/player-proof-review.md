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
| Exact-head CI, independent GitHub review and deployed acceptance | Previous head 3640595 passed CI34448514974, QA34448514988 and isolated browser/API acceptance; refreshed evidence required for the account-switch/replay fixes | PENDING new head |

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
container: actual local API was stopped and restarted in disabled mode; fresh
proof rejected, ordinary join and prior receipt replay passed. The harness checks
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

New-head external review, CI and deployed acceptance must be refreshed. No child
implementation begins before this parent reaches its required review gate.

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

None; AJ approved the private bearer invitation tradeoff and explicit confirmation.

### Options considered

None outstanding.

### Reason selected

Approved plan; no automatic name/account matching or email-bound expansion.

### Reversal cost

Proof acquisition can be disabled; existing ownership and immutable receipts must
remain readable. Do not roll back to a proofless API.

## Review focus

Try to falsify account/session binding, proof issuance scope, transaction/race
conditions, immutable receipt precedence, secret persistence/logging, cross-tab
purge, static route delivery and retry ownership. Verify claims against exact
current-head evidence. AJ retains all merge and production authority.
