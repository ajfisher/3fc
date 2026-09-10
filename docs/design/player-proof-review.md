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
| Truthful retries, keyboard continuation and preserved existing gameplay | 462 complete setup interactions, 532 full app tests, 21 native-WebCrypto recipient tests, complete API suite and repository tests passed | PASS locally |
| Local/Lambda/deployment compatibility and containment | OpenAPI, Serverless routes, shared repository/handler, static object aliases; actual local HTTP disabled-mode restart; docs/runbooks/player-claim-proof.md | PASS locally |
| Exact-head CI, independent GitHub review and deployed acceptance | Pending publication; dedicated AWS profile refresh required for disposable QA account fixtures | PENDING |

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

### Unresolved blocking findings

External review, exact-head CI and deployed acceptance are pending. No child
implementation begins before this parent reaches its required review gate.

### Rejected findings and evidence

None.

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
