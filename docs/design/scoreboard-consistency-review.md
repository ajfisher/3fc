<!-- review-packet-version:1 -->

## Behavioural claim

Live scoring and finished results use one escaped team-total renderer and shared
responsive styles. Headings, Conceded and Scored are centred consistently. Native
team-choice radios remain keyboard-operable but their dots are visually clipped;
the whole label provides focus, selection and disabled presentation.

Fixes #179 (UX-13). Base: codex/ux-player-picker-search (#181).
Parent reached review:ready at413112fe961aa36ed82e74721ae23d79fefb06a9 before
implementation: CI34683681591, QA34683681580 and exact-head Codex no-findings
comment5644824093. No merge or production deployment is authorised.

## Specification and acceptance evidence

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Identical semantic team totals and unchanged order/calculation | Shared renderer focused and full controller regression plus existing scoring/result suites, group55435 PASS | PASS |
| Scheduled/live/finished centred text, swatches and totals | Shared Range-based browser helper; all71 results and34 live cases plus14 refresh cases PASS, group54757 exit0, peak1467616KiB, remaining[] | PASS |
| Native radio keyboard/disabled semantics and non-colour selection | Space/ArrowRight, disabled-team skip, full-label click, forced-colours border-weight test included in group54757 | PASS |
| Cross-stack organiser/scorer permissions | Actual season action surface, filtered Manage players URL, Escape focus, viewer/unknown hidden controls; full24 organiser cases PASS, group54426 before later zoom failure was isolated and fixed | PASS |
| Full controller, lint/typecheck, API/app, contract, build, backlog and review-gate validation | Group55435 PASS, peak2899536KiB, actual exit0, remaining[]; also52 roster/sign-out browser cases and20 shared player-layout cases PASS | PASS |
| Resource-controlled local M2 end-to-end smoke | Four scenarios PASS in group61903; private reporter only, host peak1312544KiB under3.5GiB plus hard512MiB in-memory database; service exits observed, container removed, exit0, remaining[] | PASS |
| Exact-head Codex review, CI and isolated QA acceptance | Remote evidence to follow publication | PENDING |

### Cross-stack issue-to-evidence checklist

| Issue | PR | Evidence |
| --- | --- | --- |
| #177 UX-11 shared player identity and season navigation | #180 | review:ready atffb6286; CI34679464480, QA34679464495, Codex no-findings5644347918; shared20-case geometry and role/privacy regressions |
| #178 UX-12 search-first addition and roster recovery | #181 | review:ready at413112f; CI34683681591, QA34683681580, Codex no-findings5644824093; full validation and60 browser cases in group45859, peak2575728KiB, exit0, remaining[] |
| #179 UX-13 scoring presentation and final acceptance | This PR | This packet and final remote evidence |

Physical iOS/Android and Android Firefox checks are not represented by browser
emulation. No physical-device pass is claimed. Real QA records are read-only;
mutation acceptance uses disposable isolated fixtures.

## Scope boundaries

Included: frontend presentation, native-radio styling, fixtures, regression tests,
backlog and versioned review evidence. Existing player rows and search behaviour
are retained and covered by the final cross-stack checks.

Excluded: backend/API, Terraform, migration, dependencies, scoring calculations,
ownership/permissions, own-goal checkbox, draft/reset/recovery and write handling.

## Change classification

- Declared risk: `medium`
- [x] `application-behaviour`
- [x] `backlog-maintenance`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How this PR affects it | Why it remains valid | Evidence |
| --- | --- | --- | --- |
| INV-001 | Presents existing authorised data | No new reads or permissions; escaped names/totals and existing safe swatches | Independent engineering/security diff review |
| INV-002 | Changes visual scoring choices | Existing session, role and finished-game locks remain unchanged | Role and correction regressions |
| INV-003 | Changes radio appearance only | Native checked/disabled/change semantics and existing submission/retry logic retained | Keyboard, failed-write and correction regressions |
| INV-005 | Shares Conceded and Scored presentation | Values remain distinct; normal/own-goal calculations are untouched | Existing own-goal/edit/delete/undo regressions |
| INV-006 | Shares result team presentation | Winner comparator and outcome header are untouched | Winner/tiebreak/draw regressions |
| INV-008 | Changes team-choice appearance beside assist controls | Native selections, three-assist constraints and scorer restrictions remain unchanged | Assist and draft/reset/recovery regressions |

### Architecture or decision record

renderTeamTotal owns the repeated semantic header/dl presentation. Its context is
one of two fixed internal hooks, preserving existing test and view selectors.
One CSS rule owns all team columns; result-specific headings/logs and wrapper
borders remain outside it. Narrow containers stack teams and their totals to keep
labels intact at enlarged text sizes. No dependency or responsibility crosses
an API, persistence, authentication or deployment boundary.

## Failure and rollback

### Failure behaviour

Existing unavailable/uncertain score states, frozen goal operations and recovery
remain unchanged. Selection remains perceptible through border weight in forced
colours; compensating padding prevents selection from shifting controls.

### Rollback approach

Revert this child and rebuild the frontend, retaining the independently gated
parents and existing alias-aware backend. No migration or Terraform apply.

### Rollback evidence

The diff changes no endpoint, persisted data, infrastructure or mutation handler.
Native inputs and existing context hooks remain present in both versions.

## Automated and agent review disposition

Independent engineering/architecture/security review found no material defect or
boundary expansion. UX review identified colour-only selection after hiding the
native dot; resolved with a3px selected border and stable compensated padding,
tested in forced-colours mode. QA review identified remaining clipped-input
check() calls in the two-client fixture; these now click the full labels. The
shared geometry helper asserts all three teams and four text entries per team.
Review agents remained read-only and launched no tests.

Focused browser validation exposed an incorrect menuitem assertion for an existing
semantic link; corrected to link without changing runtime semantics. Real200%
zoom exposed a split Conceded label in the shared two-column narrow fallback;
both views now use one totals column at that breakpoint.
The new controller comparison initially seeded a finished status without a stored
result snapshot; corrected to the existing finished-result fixture. Its focused
test, complete file and full workflow then passed in the required order.

### Unresolved blocking findings

No unresolved local findings. Exact-head remote evidence remains outstanding.

### Rejected findings and evidence

None.

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

Challenge visible alignment at narrow widths, text fragmentation at zoom, native
radio keyboard and forced-colour behaviour, unchanged totals/own-goal semantics,
and whether acceptance assertions actually inspect rendered content.
