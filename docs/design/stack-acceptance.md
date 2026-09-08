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
| #136 / UX-05 | Reports and existing entry journeys | [#150](https://github.com/ajfisher/3fc/pull/150), `bfd4af7ab05e1e5a55eede4e716e851c0ab188e8` | [Results/entry map](results-entry-review.md) and versioned packet. Exact-head review:ready reconfirmed by root. |
| #151 / UX-08 | Match navigation, correction exit and presentation follow-ups | [#154](https://github.com/ajfisher/3fc/pull/154), `a1cccc18a13e92843e1c8740cec374993afd1953` | [Match-flow map](match-flow-polish.md) and versioned packet. Review-ready before UX-09. |
| #152 / UX-09 | Named claim return and complete Unassigned identities | [#155](https://github.com/ajfisher/3fc/pull/155), `dd8982e134fd055bb4f7e13ad5cb4053853a9de8` | [Join/Unassigned map](join-unassigned-review.md); final query transport. CI34201089422, QA34201253601 and Codex completion5581369750 verified by root; review:ready before UX-10. |
| #153 / UX-10 | Bounded cross-client read freshness | [#156](https://github.com/ajfisher/3fc/pull/156), `codex/design-match-refresh` | [Refresh policy and acceptance map](match-refresh-review.md). Initial190cbf4 passed488 app, M2 4/4,197 browser plus15 offline and17 deployed acceptance/safety cases. Codex identified two P1s; corrected legacy uncertainty and apply-boundary identity safeguards require renewed current-head evidence in the versioned PR packet. |
| #137 / UX-06 | Cross-stack acceptance | Final frontend PR plus this checklist | Initial 161 cross-stack browser cases and4 local M2 cases passed; subsequent parent evidence is in the maps/packets above. Refresh-child and physical-device evidence remain outstanding. Keep issue open. |

Parent acceptance was completed before each child was implemented. Shared QA is
deployed serially, and each packet records its accepted deployment SHA before
the next replaces it. A completed no-findings Codex comment naming the exact head
is accepted per AJ's clarification; it is not mislabeled a formal review.
Root has reconfirmed exact-head `review:ready` for all ten parent PRs:
#141, #142, #143, #144, #145, #148, #149, #150, #154 and #155.

## AJ's ten post-stack QA items

These follow-ups supplement the original frontend plan; they do not imply that
deferred player/public-performance features are implemented. The parent state is
recorded separately from the refresh child so the whole list is not prematurely
called complete. The first nine items are complete in reviewed parents #154 and
#155; the tenth is implemented and awaiting final QA and external readiness.

| Item | Requested outcome | Delivery / evidence |
| --- | --- | --- |
| 1 | Finished Correct result has an intentional correction surface and an exit, without an unrelated Score button. | #154: explicit Correction destination and zero-write Exit; pending/uncertain operations cannot be discarded. |
| 2 | League Create season and Invite organiser belong in the kebab. | #154: labelled menu actions, preserved drafts, Cancel/Escape restores visible focus. |
| 3 | Scheduled Score game belongs in the match navigation flow. | #154: native active destination; authority-aware link and existing readable/legacy hashes. |
| 4 | Claim return names the player, and newly joined players appear directly in Unassigned. | #155: authenticated exact-identity query read, deliberate return claim, complete public Unassigned independent of top-20 search. |
| 5 | Hide the upper Add player trigger while its form is open; restore it on Cancel. | #154: computed visibility and focus through cancel/redraw; unresolved creation identity is retained. |
| 6 | Assignment success must not follow the user into Score. | #154: navigation and feedback ownership; late settled success cannot replace newer activity or recovery. |
| 7 | Latest-goal padding matches other goal rows. | #154: equal geometry; latest emphasis changes the surface only. |
| 8 | Remove Back to game because Overview already supplies that navigation. | #154: duplicate back/footer actions removed; one native destination set remains. |
| 9 | Center scoreboard team labels and numbers. | #154: centered stable team columns, unchanged scored/conceded semantics. |
| 10 | Other clients refresh scores after someone records or changes the game. | #153 / refresh child implemented and locally validated: bounded reads, draft preservation, lifecycle/authority guards and no poll-driven write settlement. 440 interactions (40 UX-10), 14 new two-client cases within final 197-browser pass, and local M2 4/4 pass; external QA/readiness pending. |

UX-10's earlier full repository validation completed with exit 0: lint,
typecheck, full API/app validation (486 app tests), 57 review-gate tests,
contracts, build and diff check; process group `89559`, peak `1865248 KiB`,
cleanup `[]`. The six-suite cross-surface browser matrix passed 183/183:
group `91067`, exit 0, peak `1774288 KiB`, remaining `[]`, trip `None`, outputs
under `/tmp/3fc-ux10-cross-surface/`.

Two ordinary M2 failures were isolated before another full smoke run: the visible
but busy new-player assignment control was fixed and proved with a held-read
regression (focused case plus full 439 passed, group `92384`); an external join's
old 10-second wait was corrected to a 25-second condition wait for scheduled
15-second polling, backed by exact 14999/15000ms coverage. That focused case and
the complete 440-test interaction file passed in group `93549`, exit 0, peak
`1822800 KiB`, cleanup `[]`. This includes 40 UX-10 cases.

Final local M2 then passed 4/4: group `94003`, exit 0, host peak `1323040 KiB`
plus a hard 512 MiB Docker limit, remaining `[]`, all three service SIGTERM exits
observed and ephemeral container removed. Strict all-fixture typechecking and
QA-helper offline checks passed 15 cases with 2 explicit deployed opt-ins skipped
(group `93335`, exit 0, peak `846944 KiB`, cleanup `[]`). Backlog validation/export
also passed before this evidence refresh. Final combined revalidation then
**passed** in group `94369`, exit 0, peak `1815312 KiB`, cleanup `[]`, trip `None`:
lint/typecheck, full API/app validation (488 app tests: 440 interactions plus
48 layouts), 57 review-gate tests, contracts, build, strict all-e2e typecheck and
212 browser/offline cases (197 browser plus 15 offline QA), with 2 explicit
deployed opt-ins skipped.

Scoped independent design/source and three existing screenshot reviews found no
material residual issue. Authorship remains disclosed; separate independent
engineering review has cleared keyed DOM reconciliation and both new M2 tests.
All local auth/log-helper source reviews are complete. Independent QA-helper
review also cleared response-body settlement,
exact ownership and retained-ledger safeguards; this is not deployed acceptance.
Dispositions are in the [refresh map](match-refresh-review.md). The child is
PR156. Its first190cbf4 head passed CI34208810305 and QA34209247864, including17
deployed cases, before Codex review5139831979 identified two P1s. The absorbing
legacy write lock and final session probes are covered in the refresh map.
PR156's packet supplies renewed validation and external evidence for the
corrected head; prior-head passes are historical. Physical #137 checks remain
pending; no merge is authorized.

The corrected child passed450 interactions /498 total app tests, full API
validation,57 review-gate tests, lint/typecheck/contracts/build,212 browser and
offline safety cases (two deployed opt-ins skipped locally), and4 local M2
cases. QA, architecture/security and design independently cleared the fixes.
The versioned PR156 packet must supply renewed exact-head CI, deployed QA,
Codex disposition and review-gate evidence before handoff.

For #155's final head, see
[CI34201089422](https://github.com/ajfisher/3fc/actions/runs/34201089422),
[QA34201253601](https://github.com/ajfisher/3fc/actions/runs/34201253601) and
[Codex completion5581369750](https://github.com/ajfisher/3fc/pull/155#issuecomment-5581369750).
Earlier path-based transport passes are historical, not substitutes for this
final query-head evidence. Physical-device checks below are still not executed.

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
