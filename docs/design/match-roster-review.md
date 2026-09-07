# UX-03 match and roster review

Scope: #134, based on the reviewed organiser shell. This slice makes existing
authenticated matches readable and team management intentional. Scoring and
result composition follow in their separately gated slices; no public results,
participation-based home or performance destination is introduced.

## Review findings and dispositions

| Review | Finding | Disposition |
| --- | --- | --- |
| Architecture / data | “Complete roster” overstated the existing unpaginated repository read. | Describe the assigned-roster endpoint as independent of the player-search 20-item cap, not an unlimited guarantee. No backend pagination change or additional client fan-out. |
| Design / mobile | A visible Add player label beside the input could squeeze the name field at narrow/enlarged widths. | Full-width name field followed by a wrapping Add player/Cancel row. Browser checks measure field width as well as touch targets and page overflow. |
| Design / navigation | Unresolved ancestor links misleadingly led to Home. | League/season anchors have no destination until game context supplies their scoped paths. |
| Architecture / draft ownership | Equality of text alone cannot distinguish the submitted name from a later identically named player's draft. | Independent name/search revisions preserve later A→B→A input while the captured original request completes. Deferred-response regression passed. |
| Architecture / privacy presentation | Public creation DTOs and admin search enrichment must not share claim provenance. | Separate verified admin-read metadata; public/pending DTOs cannot prove an unclaimed account. Clear and redraw immediately while authority is unknown. Role-transition, capped and failed enrichment regressions passed. |
| Architecture / refresh | Finishing refreshes authority and must not leave existing unassigned players missing. | Reload the authorised bounded candidate search after authority refresh; the regression retains an existing unassigned identity without typing a search. |
| Design / enlarged text | Initials split outside fixed-size avatar circles. | Let the avatar grow around a single line of initials; an enlarged-text range assertion checks actual containment. Focused rendered validation passed. |
| Design / mutation copy | A network/503 transfer cannot be labelled a confirmed failure. | One uncertainty message offers retry of the same team choice or reload; definitive rejections retain failure feedback. 403/503 regressions passed. Scorer grants also distinguish response loss after commit from definite rejection, with no automatic retry. |
| QA / keyboard | Promotion can destroy its focused button during redraw. | Preserve operation focus ownership and restore a surviving Manage summary or player card without stealing later focus. Five regressions cover promotion, co-organiser, rejection, committed-but-unconfirmed and outside focus. |
| QA / data presentation | Starting or finishing a game must update Overview, not only the scoring/result panels. | Refresh read-only overview fields after confirmed state changes without writing edit inputs. Scheduled→Live→Finished assertions passed. |
| Root / restricted copy | A finished scorekeeper must not be told to choose an unavailable correction action. | Only an organiser receives that instruction; other actors are directed to ask a league organiser. The finished smoke retains role restrictions and checks this copy. |

Independent architecture/security and QA/engineering re-reviews closed the
material source findings. Root owns validation; review agents launch no tests.
Final design re-review of refreshed fictional renders closed both enlarged
initials and uncertainty-copy findings. The production-asset browser suite
passed 36 cases, including strict typechecking of both changed browser files.
Repository lint/typecheck, all workspace tests, contracts, build and the 57
review-gate tests subsequently passed serially with no resource anomaly.
Exact-head CI, QA, Codex and gate evidence are recorded in the versioned PR
packet, not inferred from a local pass.

## Acceptance mapping

- `ui-layout.test.ts` and `ui-styles.test.ts`: stable semantic destinations,
  one explicit scoring task, native disclosed forms, initially unavailable
  capabilities, approved copy and computed hidden visibility.
- `setup-flow-e2e.test.ts`: role boundaries, scoped names, navigation/history,
  roster identity/provenance, mutation ownership, stale reads, draft recovery
  and explicit finished corrections. The complete interaction file passed
  193 tests after each diagnosed failure was checked in isolation.
- `tests/e2e/match-roster.spec.ts`: built production assets with intercepted
  fictional data; five widths, two themes, role variants, long/duplicate names,
  capped candidate search, native entry, transfer recovery and enlarged text.
- `tests/e2e/m2-smoke.spec.ts`: real local-service workflow follows disclosed
  creation/join forms, explicitly finishes the game after the final third and
  intentionally enters historical corrections. The full controlled local
  smoke is reserved for the completed stack, not blindly repointed at QA.

Existing fixture adaptations retain behavioural assertions: synthetic link
clicks are cancelable like real mouse events, manually seeded scoring games have
explicit league ACLs, and historical controls require intentional editing.
Tests no longer assume an inline name/button grid or scorer access to deletion.
Native icon clicks use the actual local CSS-mask element; an additional SVG
child proves delegated targeting is not limited to HTML elements. These are
test corrections, not relaxations of production permissions or scoring rules.

The enlarged-text fixture is a deterministic reflow check, not physical-device
or browser-zoom evidence. iOS, Android and account-switching device checks remain
tracked in #137. Intercepted fictional browser fixtures are not presented as
live QA business-data acceptance.

## Failure and rollback

See [match and roster boundaries](../architecture/match-roster.md). Parent-site
redeployment rolls back this frontend without an API/data migration; it does
not undo committed player additions, assignments or match corrections. Failed
and uncertain requests must retain their owner, payload and retry key. No
automated destructive retry or live rollback deployment is claimed.
