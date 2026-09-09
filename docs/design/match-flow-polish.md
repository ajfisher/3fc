# Match-flow QA follow-ups

UX-08 / #151 builds on PR150, based at
`bfd4af7ab05e1e5a55eede4e716e851c0ab188e8`.

## Accepted interaction and copy

The native match navigation contains Overview, Teams and, for an authorised
operator, Score game. Results appears when finished. Score game has the same
active destination treatment as the other links; it is not a floating primary
button repeated between every tab and its content. The old Back to game and
Teams-footer duplicates are removed. Existing readable and legacy hashes work.

Finished scoring still requires explicit Correct result from Results. While
armed its destination is named Correction, and the correction surface contains
Correct result and Exit correction. Exit makes no request, discards the unsaved
goal draft, revokes only result-correction mode and returns focus to Results.
It does not undo already committed changes or revoke independently armed team
editing. Pending/uncertain writes disable exit with a visible reason, preserving
the original retry; the read-only destinations remain available.

League Create season, Invite organiser and Delete league are text-labelled
actions in the header kebab. Opening a form dismisses the menu and focuses its
first field. Cancel/Escape returns to the visible kebab, not the now-hidden
menu item. Existing drafts and reusable-invite loading remain intact.

The Add player trigger is hidden while its form is open, including after roster
redraws. The real submit and Cancel remain visible. Closing restores the trigger
before focus; it does not cancel or replace an unresolved create request.

Settled success belongs to its originating navigation revision and activity.
Leaving that view removes it; delayed completion cannot resurrect it or replace
newer activity feedback. Errors, pending operations and uncertain-write recovery
remain available. Metadata saves also respect later navigation and focus.

All latest-goal rows have equal padding. Newest emphasis changes the surface,
not alignment. Team labels and numeric totals are centered in stable team
columns. Scored/conceded values, own goals and outcome calculation are unchanged.

## Architecture and review

This slice changes local view state, focus and feedback ownership only. No API,
session, data ownership, dependency, deployment or scoring-write contract changes.
INV-002 authority and INV-003 retry identity remain authoritative in handlers
and the backend. INV-005/006/008 calculations are unchanged. Existing INV-009
headers and local icons are retained.

Independent design/front-end, engineering/QA and architecture/security reviews
identified two concrete risks: focus returning into a dismissed action menu,
and disabling the only uncertain-correction retry on exit. Both are guarded and
receive interaction/browser regression coverage. Architecture review also caught
the pre-existing metadata-save navigation takeover; the same ownership rule now
covers it. Reviewers do not launch validation workers.

## Acceptance evidence

Root runs focused interaction tests, their full file, full application/API and
contract suites, then built-asset browser fixtures serially under the 4 GiB
process-group ceiling. Browser fixtures cover five widths, light/dark themes,
computed visibility, actual text geometry, focus, held and lost responses.
The PR packet records commands, actual exits, CI, exact-head Codex and QA evidence.
No validation is claimed until it has executed.

Executed local evidence: all369 interaction cases (including17 new follow-up
regressions),23 layouts and strict changed-browser-fixture typechecking passed.
The final six-suite built-asset matrix passed167/167 at 320/390/430/768/1280px,
light/dark and enlarged text. Group47454 exited0, peak1888944KiB and no remaining
children. Independent rendered review also passed the corrected full-width
uncertain-score message and native metadata-save focus at320px.

Bounded failures were investigated before retrying: an early native link needed
no href until authority loaded; a blank post-exit draft correctly leaves Save
disabled; two old browser assertions expected now-removed late success text.
The last fixture failure was a full-page screenshot resizing the viewport and
dismissing an open fixed menu before Escape (trace after screenshot9951 already
showed hidden, before Escape9953). A viewport-only capture preserves the
interaction, with additional post-capture visibility/focus assertions. Focused
fixes, their complete affected files and then the combined matrix passed. No
resource ceiling or stall occurred, and every owned process exited before the
next intensive command. Final publication checks and deployed evidence are in
the versioned PR packet; physical-device checks remain separately tracked in#137.

Rollback is the unchanged validated PR150 frontend head. No migration or durable
change needs reversal; reverting UI does not undo a previously committed goal,
assignment or league action. No rollback deployment is implied.

## Remaining stacked scope

- UX-09 / #152: verified player identity on claim return; complete Unassigned
  roster reads. Architecture/security review precedes backend implementation.
- UX-10 / #153: bounded cross-client read freshness without overwriting drafts
  or settling uncertain writes. No coordinated concurrent-editing promise.

These are separate children, not claimed complete by this first follow-up.
