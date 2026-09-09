# UX-01 foundation review evidence

This slice establishes shared visual tokens, controls, responsive constraints and
truthful feedback. It does not claim completion of the later screen-composition,
navigation, roster, scoring, results or entry-flow slices.

## Independent review and dispositions

| Review | Finding | Disposition and evidence |
| --- | --- | --- |
| Architecture / security / engineering | No blocking runtime boundary changes. | No API, ACL, session, persistence, dependencies, scoring calculation, payload or idempotency changes. Reviewed shared feedback and hidden-state responsibility. |
| Design / content | Committed outcomes could repeat when global status and detailed error were combined. | Explicit outcome ownership suppresses duplicate prefixes; saved-but-refresh-failed interaction assertions cover the visible error. |
| Design / content | Rejected-copy test covered too few examples. | All canonical rejected concepts tested across nine customer renderer families, including hidden text and accessible naming attributes. |
| QA / accessibility | Uncertainty assertions checked the hidden global message, not visible recovery. | Replay/create/delete/undo tests now assert the visible error owns the uncertainty and retry instructions. |
| QA / accessibility | Existing example modal had no focus handling. | Opening focuses Cancel; Tab cycles; Escape closes and restores the actual trigger. Chromium exercises a nested-icon click. |
| QA / accessibility | Collapsing a pending email invitation hid its outcome. | One status region immediately outside the disclosure remains visible. Nine deferred-response tests cover sent/unknown/failure across closing, reopening and switching to Create season; failed drafts/keys and recovery links survive. |
| Browser / root | DOM simulator accepted hidden elements despite a stylesheet parsing failure. | Downlevel unsupported CSS syntax with existing esbuild for JSDOM, assert no parse errors; real Chromium mutation removes the hidden rule and proves the author-display defect becomes visible. |
| Browser / design engineering | Fixed columns and implicit min-content tracks overflowed or overlapped at enlarged text. | Width-aware grids reflow navigation, scores, roster and shared panels. Legacy independently sticky regions are unpinned until the coordinated scoring slice, preventing obscured focus. No font shrinking or overflow clipping workaround. |
| Design rendered review | Assists summary fit the page but fragmented into a vertical column of letters at 200%. | Reflow the label/icon and selection summary onto separate readable rows; Chromium measures the longest word against available width, in addition to page overflow checks. |

## Acceptance mapping

- `ui-layout.test.ts`: local-icon semantics, real fixture destinations, full copy
  exclusions, fields, status/team/third examples and customer shell hooks.
- `ui-styles.test.ts`: parsed computed hidden visibility, local fonts, system
  themes and no decorative gradients; functional conic thirds retained.
- `setup-flow-e2e.test.ts`: visible success, one global failure owner, uncertain
  mutation recovery, invitation lifecycle, retained drafts/keys and unchanged
  roster/scoring behaviour.
- `tests/e2e/design-foundation.spec.ts`: untouched built CSS and local icons in
  real Chromium; 320/390/430/768/1280px light/dark fixtures, 44px effective
  controls, 16px inputs, focus, hidden mutation, modal keyboard, enlarged text,
  and actual controller rendering with 18 fictional players and a live timer.
  Fixture requests are fulfilled locally; unexpected requests fail acceptance.
- Existing server, contract, security-header and icon-generation tests remain
  part of the complete serialized validation.

Secondary-text contrast was independently calculated at 6.63:1 on light surface
and 7.95:1 on dark surface; soft selections are 5.58:1 and 6.01:1 respectively.
Physical iOS/Android checks remain the explicitly tracked cross-stack device
acceptance, not claims inferred from Chromium emulation.

## Failure and rollback

Nothing in this slice changes durable data. Failed/uncertain writes keep their
existing ownership, input and retry identity. Successful commits are not retried
because a later view refresh fails. The invitation recovery link remains
email-restricted and is not replaced by a reusable league grant.

Rollback consists of redeploying the previously validated parent site head
`4cf5b6333512f6f7904cd1eb6b8a710ea2f4c684`; no database, API or infrastructure
rollback/migration is required. The parent is deployed and validated in PR #141.
Current-head CI, QA run, browser evidence and Codex disposition are recorded in
the versioned PR packet because they are obtained after the commit is published.

Independent design re-review accepted the fresh light/dark 200% renders after
the assists fix. QA/accessibility re-review closed the invitation feedback
finding. Local real-Chromium acceptance passed all 15 cases; the complete app
suite passed 129 tests. The root retained process ownership, observed actual
exit and verified no surviving process-group workers for each validation run.
