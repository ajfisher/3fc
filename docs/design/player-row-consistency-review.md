<!-- review-packet-version:1 -->

## Behavioural claim

Player identities use one initial/name/action layout across directories, rosters,
picker results, suggestions and combination tables. Account-link state is truthful
to the caller's authorised metadata. Season player management is a contextual
menu action, with the season filter and existing role permissions preserved.

Fixes #177 (UX-11). Stack: #177 -> #178 -> #179. Base: main.

## Specification and acceptance evidence

AJ's approved Consistent Player Lists, Search and Scoring UI plan is the scope.
This PR implements its first section only; search-first addition and score styling
follow in independently gated child PRs.

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| One escaped renderer, Unicode initial, linked/unlinked/unknown and old-engine fallback | player-presentation.test.ts; browser/server identical markup | PASS |
| Roles, menu navigation, icon-child clicks, transfer/focus and roster metadata | setup-flow-e2e.test.ts, 505 complete interaction tests before final malformed-metadata regression | PASS |
| Malformed administrator metadata does not imply unlinked | Focused real controller test, group9067 exit0/remaining[] | PASS |
| Shared assets in local and static rendering, no remote icons | server, static-export, ui-layout and icons tests, group9271 | PASS |
| Actual computed alignment, readable names, 44px targets and no overflow | app/scripts/check-player-ui.mjs: 320/390/430/768/1280px, light/dark, 16px/32px text; group8840 exit0, peak373184KiB, remaining[] | PASS, 20 cases |
| Full suites, lint/typecheck, contracts, build, backlog and review policy | Group9271 exit0, peak2408752KiB, remaining[]; app suite then lint, complete workspace/API/app/ops/gate tests, contracts, build, backlog validation/export | PASS |
| Exact-head Codex review, CI and isolated deployed QA | Attach after publication | PENDING |

Browser fixture screenshots are stored locally at
/tmp/3fc-player-ui-evidence-20260912/players-390-light.png and players-390-dark.png.
These are synthetic fixtures, not real profiles. Doubled root text is enlarged-text
coverage, not a claim of physical-device or browser-menu zoom acceptance.

## Scope boundaries

No backend domain, API, DynamoDB, Terraform, migration, authentication or scoring
rule changes. The local app server/static exporter only deliver the new frontend
bundle. No additional production dependency. Search controls and registration
behaviour are deliberately unchanged until the next PR. No real QA data mutations.

## Change classification

- Declared risk: `high`
- [x] `application-behaviour`
- [x] `backlog-maintenance`
- [x] `dependency-tooling`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How this PR affects it | Why it remains valid | Evidence |
| --- | --- | --- | --- |
| INV-001 | Displays account-link status | Renderer receives only a nickname, presentation status and context; no account ID/email; no added privileged fetch | Role matrix and malformed metadata tests |
| INV-002 | Moves season navigation and roster action markup | Existing role-derived controls and API authority unchanged; scorer sees Manage players but not delete | Season and roster role/focus tests |
| INV-009 | Adds a same-origin static frontend asset | Existing CSP/security headers and deferred ordering retained, no external resource or inline runtime dependency | Local/static asset and header regressions |

### Architecture or decision record

player-presentation.ts owns escaped identity presentation only. Callers retain
permission, data and mutation ownership. Existing esbuild emits the same renderer
as a separate browser IIFE, while server rendering imports the TypeScript module.
All shells load the bundle before their deferred controllers. Build failure is
explicit rather than silently rendering a second implementation.

Only an authorised administrator's verified game-player DTO can interpret absent
access as unlinked: the existing producer deliberately omits it for unclaimed
profiles. Missing enrichment, non-administrator data and malformed present access
remain unknown. Directory booleans are used only where already supplied.

Shared grid tracks align initials, names and actions without separate page rules.
When enlarged text leaves insufficient inline room, actions move below the name;
the combination table stacks Games under the identity while retaining its checkbox
and header semantics. Assignment/transfer options remain below the identity row.

## Failure and rollback

### Failure behaviour

Missing claim metadata never invents account linkage. Existing pending actions,
refresh failure, uncertainty and focus restoration remain controller-owned.
Intl.Segmenter absence falls back to one Unicode code point, preventing an older
browser from losing all player rendering. Unknown status adds no spoken assertion.

### Rollback approach

Revert this frontend commit and rebuild/redeploy matching app assets. No data or
API rollback is necessary; retain the already-deployed alias-aware identity code.

### Rollback evidence

Diff has no API/storage/configuration changes or new dependency; local/static tests
exercise the asset delivery paths together. No production release is authorised.

## Automated and agent review disposition

Independent design/frontend review inspected both390px screenshots and the final
grid/renderer; no remaining material finding. Engineering/privacy reviewed DTO
ownership, asset ordering and role controls; QA reviewed meaningful assertions.
All reviewers remained read-only and launched no validation workers.

Findings fixed: unsupported Intl.Segmenter, expanded transfer controls squeezing
names, long-name primary-row alignment and malformed access falsely asserting
unlinked. Browser checks exposed a narrow enlarged-text name column; the explicit
responsive fallback fixes it and all20geometry cases pass.

### Unresolved blocking findings

Exact-head remote review, CI and deployed QA remain outstanding.

### Rejected findings and evidence

Treating absent access as always unknown was rejected only for verified admin DTOs:
api/src/server.ts toGamePlayerForLeagueRole defines absence as its unclaimed shape.
All other missing-data cases stay unknown. Independent reviewers accepted this
source-backed distinction.

## Human judgement

- [x] `human-judgement:none`

### Decision requiring judgement

None beyond AJ's final review and merge authority.

### Options considered

Separate per-page layouts were rejected in favour of the requested shared pattern.

### Reason selected

One renderer and component-owned CSS prevent repeated alignment/status drift.

### Reversal cost

Frontend rebuild and deployment only; no durable-state changes.

## Review focus

Challenge unknown versus unlinked presentation, narrow table layout, deferred
bundle availability, season role visibility and transfer focus after row redraw.
