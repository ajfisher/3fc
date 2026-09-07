# Action-menu review and acceptance

Issue [UX-07 #147](https://github.com/ajfisher/3fc/issues/147) follows
[match/roster #145](https://github.com/ajfisher/3fc/pull/145). It is the extra
focused slice requested during AJ's QA inspection, before live scoring.

## Behaviour and scope

Replace More/Manage action accordions with one consistent vertical-kebab button
and a compact, floating surface of native actions. Apply to league/season/game
headers, nested season rendering, season/game rows and verified player
management. Keep real information/form disclosures. Opening actions must not
expand rows, squeeze names/dates or change domain data.

Architecture and rollback: [action ownership](../architecture/action-menus.md).
Content: [copy states](copy-states.md). Specification:
[frontend redesign](frontend-redesign.md).

## Independent findings and disposition

| Review | Finding or challenged claim | Disposition |
| --- | --- | --- |
| Architecture / security preparation | Reparenting popup controls could bypass authority ancestry or lose delegated entity targeting. | Keep original DOM ancestry; use native top layer where available, fixed fallback otherwise. Existing handlers retain scope and authority checks. |
| Architecture / engineering | A row redraw can render a fresh enabled delete control while a detached old button is pending. | Track pending deletion by entity, not only old button state; adapt surviving-row and stale-read regressions. |
| Frontend / interaction ownership | Closing before the mutation handler runs can lose deletion or promotion focus ownership. | Transfer ownership to the kebab; retain same-entity redraw and external-movement tests. |
| Independent UX | A popup clamped to the viewport after its owner scrolls off-screen could leave Delete detached from its game. Inferred from source. | Close when the trigger leaves the visual viewport; verify with a long fictional game list. |
| Architecture / compatibility | Fixed fallback beneath containment could use the wrong coordinate system. Inferred, not demonstrated. | Exercise disabled native Popover methods with scrolled rows and enlarged text; do not infer fallback correctness from native-only tests. |
| Independent QA / engineering | A disabled-only surface loses its focus during a list or roster redraw. | Preserve the surface as a focus destination alongside native controls; four interaction regressions pass. |
| Native browser validation | Tab briefly passes through body between blur and focus; premature dismissal hides the next action. Demonstrated. | Use the related focus target and the popover invoker relationship; actual Tab, Escape and outside-focus scenarios pass. |
| Engineering / mutation ownership | A clock redraw can re-enable the game-header Delete action during its request. | Keep a synchronous game-deletion latch and native finished-game disabling; captured-interval and inert-action regressions pass. |
| Independent visual UX | Assess compactness, labels, disabled reasons and non-expanding rows in final captures. | PASS for inspected dark 320px season/player surfaces and light 390px league view. No remaining material findings; not a physical-device approval. |

## Acceptance-to-evidence map

| Criterion | Evidence owner / checks | Result |
| --- | --- | --- |
| All targeted surfaces, no More/Manage action accordions, genuine information details retained | 24 layout/icon assertions and 218 complete controller interactions, including dynamic shells | PASS |
| One-open, native keyboard, icon-child activation, Escape/outside focus | Focused JSDOM and 63 built-asset browser scenarios | PASS |
| Confirmations, permission/finished locks, pending redraw, correct entity and truthful outcome | Existing and added deletion/promotion interaction matrices; disabled-only focus, interval redraw and synthetic activation | PASS |
| Real computed visibility, no row displacement, long names, viewport fit | 320/390/430/768/1280 light/dark organiser/match fixtures; zoom, fallback and trial-click hit-testing | PASS |
| Local Iconify generation, offline assets, unchanged contracts and security | Lint, complete repository tests, contracts, build, 57 review-gate tests and strict browser-fixture typecheck | PASS |
| Backlog consistency | Validation/export; new #147, existing #130/#135/#137 dependencies reconciled; no established IDs or issue states changed | PASS |
| Exact-head external gate | CI, GitHub Codex, QA deployment/provenance and acceptance are recorded against the published SHA in the PR packet | External delivery evidence |

Browser fixture data is fictional and transport-intercepted; production-built
markup, assets and controller are real. These scenarios do not mutate AJ's
games, send email or use his session. Local fixture renders are not represented
as populated live QA or physical-device evidence. Real iOS/Android acceptance
remains tracked by cross-stack #137.

## Validation ownership and failures

Final browser run: 63/63 passed, group31938 exit0, peak1518656KiB including
Chromium descendants in separate process groups; no surviving workers.
Captures: `/tmp/3fc-action-menu-browser.8Vnl1N/final`.
Complete interaction/repository validation passed in group30387 (peak1413168KiB).
That sequence's final strict fixture typecheck exposed a nullable season-date
fixture declaration; the bounded type-only fix passed independently in
group31886, exit0, peak448416KiB.

Earlier ordinary failures exposed promotion focus scope and native Tab
dismissal; both were fixed, isolated and then included in the successful full
reruns. A browser hit-test helper waited on an intentionally aria-disabled
Delete control. Group29561 was stopped with exit130 and its Chromium children
were verified gone before isolating the case. The helper now excludes disabled
actions and uses a five-second bound. This was a demonstrated fixture defect,
not abnormal memory. The monitor was also extended to include Chromium's
separate descendant process groups; only final aggregate figures are claimed
as covering those descendants. No memory-ceiling breach or orphan remained.

Root owns serialized validation with exact process-group exit, aggregate 4 GiB
ceiling and cleanup evidence. Independent reviewers do not launch test, build
or browser workers. No merge, auto-merge, queue or release is authorized.
