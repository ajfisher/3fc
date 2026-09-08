# Frontend stack acceptance

As of 8 September 2026. Readiness is not merge or release authority. The rows
below describe open PRs; no merge, auto-merge, queue or production deployment is
authorised by this document. The versioned packet on each PR contains its exact
head's CI, Codex, QA and browser evidence, including findings and disposition.

## Issue → PR → evidence

| Issue | Deliverable | PR / reviewed head | Evidence and state |
| --- | --- | --- | --- |
| #131 / UX-00 | Approved design and reconciled backlog | [#141](https://github.com/ajfisher/3fc/pull/141), `4cf5b6333512f6f7904cd1eb6b8a710ea2f4c684` | Versioned PR packet; canonical specification/backlog. Review-ready. |
| #132 / UX-01 | Mobile design foundation and honest feedback | [#142](https://github.com/ajfisher/3fc/pull/142), `69b1cc5e1ecc9d5bbb452f1247fc59aa5e01740d` | [Foundation map](foundation-review.md) and packet. Review-ready. |
| #114 / M1-13 | Session sign-out and account switching | [#143](https://github.com/ajfisher/3fc/pull/143), `a048602ee1f0730ccdc8325fd323183c656125c6` | [Sign-out map](sign-out-review.md), API/local/Lambda and isolated QA. Review-ready; physical Android Firefox check remains #137. |
| #133 / UX-02 | Organiser navigation, lists and focused forms | [#144](https://github.com/ajfisher/3fc/pull/144), `85454e575c45827d63a7e99c6443f2f5f86c65db` | [Organiser map](organiser-shell-review.md) and packet. Review-ready. |
| #134 / UX-03 | Match overview, navigation and teams | [#145](https://github.com/ajfisher/3fc/pull/145), `6f0085d1417d17415fe69af864e0f4cec3fabd66` | [Roster map](match-roster-review.md), role/permission and browser matrices. Review-ready. |
| #147 / UX-07 | Kebab action surfaces, including both game lists | [#148](https://github.com/ajfisher/3fc/pull/148), `ce429963d4b667a67a0123e5c1ff3094aa43dc7f` | [Action-menu map](action-menu-review.md),63 browser/12 isolated QA cases and signed-in read-only menus. Review-ready. |
| #135 / UX-04 | Scoring, clock and safe request recovery | [#149](https://github.com/ajfisher/3fc/pull/149), `b09ee27bb7c629e6a9cbcaa28e931d1729afbdb1` | [Scoring map](live-scoring-review.md),254 interactions/89 cross-surface browser/12 isolated QA cases and signed-in phone checks. Review-ready. |
| #136 / UX-05 | Reports and existing entry journeys | [#150](https://github.com/ajfisher/3fc/pull/150), `codex/design-results-entry` | [Results/entry map](results-entry-review.md). Implementation and local acceptance complete; current-head external readiness is recorded in this branch's PR packet. |
| #137 / UX-06 | Cross-stack acceptance | Final frontend PR plus this checklist | 161 cross-stack browser cases and4 local M2 cases passed; physical-device evidence below remains outstanding. Keep issue open. |

Parent acceptance was completed before each child was implemented. Shared QA is
deployed serially, and each packet records its accepted deployment SHA before
the next replaces it. A completed no-findings Codex comment naming the exact head
is accepted per AJ's clarification; it is not mislabeled a formal review.

## Required physical-device handoff

These remain **not executed**, not an emulated pass:

- iOS Safari: sign-in from email and return; player-name/email keyboards;
  kickoff/date inputs; safe-area/landscape and enlarged-text behaviour.
- Android: the same real keyboard, date, email-return and safe-area checks.
- Android Firefox: sign out, sign into a different account and confirm the old
  account does not return via browser history or completion replay.

Use dedicated fixture games/accounts, not AJ's real matches. Record browser/OS,
viewport, exact QA SHA, steps and outcome in #137. Tokens and cookies must never
appear in screenshots, issue comments or attached logs.

## Deferred / partial boundaries

This stack does not complete unrelated remainder in roster #25, goal correction
#28, onboarding #40 or M3 public/player/performance #32–#37. Their original IDs,
criteria, labels and milestones remain. Canonical scope is
`docs/backlog/backlog.json`, with regenerated Markdown alongside it.

The deferred order remains ownership-proof hardening (#138), safe public result
reads/canonical routes and safe entry context (#32/#33/#140), linked-player
history/participation home (#139), season standings/leaderboards (#34/#35), then
private personal performance (#37). Existing profile/claim work in #36 is not
closed by entry-copy refinement. Games played means team membership in finished
games, never registration, claims or organiser/scorer duties alone.

No deferred navigation or unsupported sharing destination is added. All actor
boundaries remain distinct and may overlap for the same account.
