# Live-scoring review and acceptance

UX-04 [#135](https://github.com/ajfisher/3fc/issues/135) follows the gated
action-menu [PR #148](https://github.com/ajfisher/3fc/pull/148).
Specification: [frontend redesign](frontend-redesign.md).
Architecture: [live scoring and recovery](../architecture/live-scoring.md).

## Behavioural claim

Scorers can read the clock and team totals together, enter goals through labelled
direct team choices and a native form, and recover from uncertain requests
without accidentally replacing the original operation or undo target.
The compact log keeps readable names and accessible team/third relationships.
Existing rules, permissions and authenticated result behaviour remain intact.

## Review challenges and disposition

| Review | Requirement or finding | Disposition |
| --- | --- | --- |
| Design/content | Coordinate scores/clock; no narrow truncated names, decorative accents or routine instructions. | Plain document-flow summary, full names and labelled native choices. Independent light/dark 320px capture review found no material issue; 25 controlled browser cases passed. |
| Architecture/security | A changed draft or newer last goal cannot replace an unresolved request's body/key/target. | Captured operation and explicit retry; independent final source/assertion review accepted exact serialized request comparisons for all four operation kinds. |
| Architecture/security | Unknown 409 and a rejection after response loss do not prove non-commit. | Conservative goal-specific settlement. Review's first-create `no_active_third` gap is fixed and independently re-reviewed; it releases only a first create, never a previously uncertain attempt. Both regression paths pass. |
| Architecture/security | Third transitions have no idempotent wrapper; finish-game does. | GET-only third reconciliation and captured finish-game key. Fresh result read after confirmed finish/replay prevents stale replay totals being presented as current. |
| QA | Fresh finished corrections must allow eligible assists; navigation/focus must survive delayed responses. | Capability-based controls and logical ownership regressions; final source/assertion review accepted the failure matrix. |
| Independent UX/accessibility | Shared delete/undo recovery must not sit inside the Record goal form; team relationships must not split across lines. | Recovery moved outside the form, with correctly scoped focus ownership; dot-arrow-dot relationship kept together. |
| Root integration review | Delete/undo must not clear an unrelated draft. | Only confirmed create/edit, or removal of the currently edited event, resets the draft. |
| Final integration review | Unavailable result copy must not claim a goal was saved after finishing a game. | Neutral result-refresh copy; the separate operation feedback retains the confirmed goal/game outcome. Regression asserts no invented goal-save claim after finish. |
| Signed-in QA | Overview-to-scoring left the Score game entry visible; direct-link fixtures missed it. | Visibility now updates in the actual action-trigger loop, not the navigation-link loop. New browser test failed on the deployed source and passed after the fix; it covers return and Back/Forward with no mutations. Independently re-reviewed with no findings. |

## Acceptance map

| Criterion | Required evidence | Result |
| --- | --- | --- |
| One coordinated score/clock, native form and direct labelled team choices | Complete layout 22/22 and fictional browser 25/25; computed bounds and 48px labels | PASS |
| Normal/own goal, three unique any-team assists, scorer exclusion, thirds/stoppage | All254 interactions, complete API/contract suite and25 scoring browser scenarios | PASS |
| Confirmed create/edit reset despite later refresh failure | Focused interaction 36/36 and browser 25/25; unrelated delete/undo drafts retained | PASS |
| Frozen uncertain create/edit/delete/undo and original expected event | Focused interaction 36/36: commit-before-response-loss, altered input, later rejection, newer event and first/replayed no-active-third cases | PASS |
| Clock reconciliation and stable finish-game retry | Focused interaction 36/36: captured third, negative/failed reads, exact finish key, fresh/unavailable results and delayed navigation | PASS |
| Readable log, keyboard/focus, actor and finished restrictions | Fictional built-asset browser 25/25: 320/390/430/768/1280px, both themes, enlarged text, short landscape, keyboard and fail-closed access; independent captures review | PASS |
| No dependencies/API/security or rule changes | Lint/typecheck, complete API and301 app tests, contracts, build and57 review-gate tests | PASS |
| Exact-head external delivery | CI, accepted Codex review, QA provenance/browser acceptance and review gate in PR packet | External delivery evidence |

Root owns serialized validation and complete process-group monitoring under the
4 GiB ceiling. Authors/reviewers do not launch competing workers. Built-asset
fixtures use fictional intercepted transport, not AJ's real games. Local M2 UI
adapters retain its fake-email/database workflow; do not point it at deployed QA.
Physical iOS/Android and final cross-stack acceptance remain #137. No merge,
auto-merge, queue or production release is authorised.

The design lead reviewed root-authored UI captures and authored the fictional
browser fixture; that review is not represented as independent review of its own
fixture. A separate read-only reviewer examined production code, test claims,
architecture/security, accessibility and the same captures. No material findings
remain after the documented correction. Neither reviewer launched validation.

Execution: focused36/36 (group36693, peak649248KiB), complete interactions254/254
(group37487, peak1438896KiB), complete lint/tests/contracts/build (group37679,
peak1572528KiB), strict browser/M2 fixture typecheck (group37099, peak457440KiB).
Every listed command exited0, with no owned descendants remaining. Ordinary
fixture corrections retained durable-state, totals, request identity and focus
assertions; no resource anomaly or blind retry occurred. Exact-head external
evidence and final cross-surface browser regression are recorded in the PR packet.
Final rebuilt-asset browser regression passed 88/88 (group38922,
peak1815648KiB, exit0, no descendants remaining), including organiser lists,
upcoming/completed game menus, game/player action menus, rosters and scoring.

Final neutral-copy follow-up was independently re-reviewed with no findings.
Refreshed evidence: isolated finish recovery1/1 (group39807, peak434464KiB),
complete interactions254/254 (group39878, peak1195712KiB), full
lint/tests/contracts/build (group40073, peak1744320KiB), and all88 browser
regressions (group41381, peak1851984KiB). Each exited0 with no descendants.

Signed-in navigation follow-up: the new browser test demonstrably failed on the
old source, then passed after correction (group42098, peak664448KiB). Complete
scoring browser26/26 passed (group42201, peak1795408KiB). Current final evidence:
interaction254/254 (group42442, peak1146544KiB), full lint/tests/contracts/build
(group42651, peak1745840KiB), strict browser/M2 typecheck and focused navigation
(group42354, peak479920KiB), all89 browser regressions (group43896,
peak1617760KiB). Every validation group exited0 with no descendants remaining.
