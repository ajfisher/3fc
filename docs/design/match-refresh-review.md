# Cross-client match freshness

UX-10 / #153 is the frontend-only child on `codex/design-match-refresh`.
The child is [PR156](https://github.com/ajfisher/3fc/pull/156). Its versioned
packet records current-head validation and external readiness. The first
published head passed CI and isolated deployed QA; Codex then identified two
P1 recovery/identity gaps, addressed below. Historical passes are not substitutes
for validation and external acceptance of the corrected head.

The parent [PR155](https://github.com/ajfisher/3fc/pull/155) was `review:ready` at
`dd8982e134fd055bb4f7e13ad5cb4053853a9de8` before this child began. Root verified
[CI34201089422](https://github.com/ajfisher/3fc/actions/runs/34201089422),
[QA34201253601](https://github.com/ajfisher/3fc/actions/runs/34201253601) and
[Codex completion5581369750](https://github.com/ajfisher/3fc/pull/155#issuecomment-5581369750).
The latter is an exact-head no-findings completion, not a formal review.
PR154 remains the earlier reviewed parent at
`a1cccc18a13e92843e1c8740cec374993afd1953`. No parent was merged.

## Behaviour and scope

Another client's confirmed goal, correction, deletion, clock transition or
finished result becomes visible without a manual reload. Roster refresh includes
the complete public Unassigned read introduced by UX-09. Existing authorized
reads supply this information; no endpoint, write contract, permission, database,
deployment configuration or production dependency is added by this child.

Read freshness is not coordinated concurrent editing. The current writer keeps
its existing confirmation, idempotency and expected-event checks. Polling does
not retry a write, decide that a lost write committed, settle an unresolved clock
operation, or select a replacement event to undo.

The original frontend design specification still applies. These follow-ups add
no public results, participation dashboard, performance destination, new claim
proof or match-specific scorer role. Player, organiser and scorer remain distinct
responsibilities that may belong to the same account.

## Approved refresh coordinator

One chained timer owns refresh scheduling; do not use an interval that launches
fetches independently of completion.

| Condition | Policy |
| --- | --- |
| Visible live game | Refresh score/log and clock reads every 5 seconds after the preceding pass settles. |
| Visible scheduled or finished game | Refresh every 15 seconds; finished games still receive authorized corrections. |
| Full authority and roster reads | Due every 15 seconds and on foreground return, within the same coordinator. Private capped player search is enrichment, not roster authority. |
| Session identity | Every batch checks the original session immediately before apply; full batches additionally check before reading authority. Stage role changes until the final check, including authority-only passes during local uncertainty. |
| Foreground return | Coalesce visibility/focus notifications into one immediate full pass. |
| Deadline | One 12-second deadline bounds the batch, including response-body reading. Abort the owned batch on expiry. |
| Repeated unavailable reads | Back off up to 60 seconds; successful refresh resets the delay. Do not pile up queued refreshes. |
| Hidden, pagehide or removed game surface | Clear scheduling, invalidate the lifecycle generation and abort owned refresh reads. Do not leave the existing clock-render interval running in the background. |

Cadences are foreground scheduling targets, not a guaranteed network completion
time; an owned batch, write guard, timeout or backoff can defer a pass.
Only one refresh batch is in flight. Reads within it are serialized and owned
until their promises settle. Cancellation does not imply that the server stopped
executing a read, and is never evidence about a write. The existing persisted
`pageshow` account revalidation takes precedence over restarting a stale page's
coordinator.

Stage and validate responses before applying them. A read generation, lifecycle
generation and synchronous pre-write mutation epoch protect the apply boundary.
Starting any local goal, clock, metadata, player creation, assignment, promotion
or game deletion invalidates older refresh work before awaiting its request.
An old response cannot become current merely because its HTTP status is 200.

Do not apply polled match state while a write is pending or unconfirmed. Preserve
the exact operation kind, path, method, body, idempotency key and expected event,
as well as pending creation/assignment overlays. Authority loss can still disable
controls immediately; it must not delete these recovery records. Resuming
presentation refresh follows the explicit mutation owner's outcome, not a
poll-driven inference.

Legacy metadata, assignment, access and deletion writes do not have the goal,
clock and player-creation recovery slots. An ambiguous network/5xx/408/429
outcome therefore retains an absorbing, reload-required write/read-apply lock.
No later in-page mutation is sent, including a changed body/role/team at the
same endpoint or a dedicated retry. The original draft and any existing frozen
operation remain; successful already-forwarded requests cannot clear the lock.
Reload is an explicit recovery boundary, not proof an uncertain server write
stopped. No idempotency or ordering is invented for these endpoints. Dedicated
goal/clock/player owners do not create this additional legacy lock: absent a
legacy ambiguity, their existing exact recovery flows remain unchanged.
The persistent Reload game action remains available, as do Sign out and
read-only navigation. Deliberate Cancel/Escape and owned-failure recovery focus
have visible fallback targets when their original trigger is disabled.

## Draft, authority and rendering ownership

Separate read-only state updates from form initialization. The existing general
loaders overwrite metadata fields, reset correction authority or rebuild goal
controls, so they cannot simply be called repeatedly unchanged.

- Retain dirty kickoff, status and third-length values, including drafts in a
  closed disclosure. Remote clock progress can make a draft invalid; explain and
  prevent an invalid save instead of silently replacing the chosen value.
- Retain goal team choices, scorer, own-goal state, assists, editing event ID and
  selected player labels. A roster transfer/removal must not drop or substitute a
  selected identity. Keep invalid selections visible for deliberate review, and
  preserve existing historical-correction semantics.
- Keep open assists, menus, focus, selection, scrolling and navigation stable.
  Repaint changed read-only surfaces without needlessly recreating focused form
  controls. Remote finish makes Results available but does not navigate there or
  arm correction mode. Initial finished-game routing is unchanged.
- Keep poll feedback separate from mutation-owned status and error messages.
  No routine success chatter or repeated announcements. A quiet stale/unavailable
  notice may describe refresh failure; it must not report zero scores, an empty
  roster, a saved write or a draw without evidence.
- A 401/403 or changed account invalidates stale authority and private
  administrator enrichment. Close unavailable action surfaces and disable writes;
  do not reuse another account's unresolved operation scope. Retain draft/recovery
  state without pretending the former permissions still apply. The account lock
  is absorbing until reload, including manual clock recovery. A separate
  authority revision rejects late legacy access reads after a newer same-account
  role downgrade.
- Public roster DTOs never populate administrator-verified player metadata.
  Viewers must not acquire private-search or mutation capabilities through polling.

Separate game, goal, roster and authority GETs are not an atomic database
snapshot. Even the existing goal read obtains teams and events separately.
Applying a validated batch together prevents local interleaving, not concurrent
server changes. The claim is bounded, eventually convergent read freshness;
there is no cross-client lock, transaction revision or coordinated editor.
Session probes close a switch between an early probe and later reads/apply, but
separate cookie-authenticated requests are not an atomic session/ACL snapshot.
A switch during the final probe or after it can only be detected subsequently;
there is no server-bound transaction identity or coordinated-edit guarantee.
Scored/conceded, own goals, assists, winner and draw calculations remain unchanged.

## Architecture and invariant review

Pre-implementation architecture/security review approved the coordinator and
the need to separate read application from mutation/form ownership. The root
implements the coordinator; the design/fixture author also implemented bounded
keyed DOM reconciliation. The final design review independently covers the
root-authored controller and existing rendered captures, not that reviewer's own
reconciler, layout hooks or fixtures. Separate independent engineering source
review has cleared the keyed reconciliation and both subsequently added M2
regressions. The authorship distinction remains explicit; the earlier outstanding
local review caveat is resolved. External acceptance remains pending.

| Invariant | Required protection |
| --- | --- |
| INV-001 | No private identity enters public roster presentation or refresh diagnostics. |
| INV-002 | Current session and league authority continue to gate every write; stale UI authority fails closed. |
| INV-003 | Background GETs cannot retire, replace or replay an unresolved write identity. |
| INV-004 | Existing entity identity and data ownership remain unchanged. |
| INV-005 / INV-006 / INV-008 | Presentation updates retain scoring, outcome and assist semantics. |
| INV-009 | Existing cookie, CSP, CORS and local icon behavior remain unchanged; no remote dependency. |

## Acceptance-to-evidence map

Local interaction and two-client browser evidence now exists for this child;
the detailed acceptance cases below remain the coverage contract. Parent passes
are not substitutes for child validation or exact-head external readiness.

| Acceptance | Falsifying cases / planned evidence |
| --- | --- |
| Another client becomes current | Two fictional clients: create/edit/delete a goal, start/finish thirds and finish/correct a game; receiving client updates without reload. |
| Delayed reads cannot undo local work | Hold a pre-write response through a confirmed local commit; release it afterwards and assert it does not apply. Include assignment and metadata. |
| Reads never settle uncertain writes | Lost create/edit/delete/undo/clock outcomes appear in later GETs; exact key/body/path/event and the manual recovery action remain unchanged. |
| Legacy uncertainty is not silently cleared | Lost metadata/assignment/access response, changed body/team/role and synthetic enabled controls cannot send another write or clear the absorbing lock. Preserve draft, original operation and Reload guidance. Dedicated clock recovery remains available when no legacy ambiguity exists. |
| Drafts survive external changes | Dirty visible/closed metadata; scorer and three assists retained through roster transfer/removal; edited event deleted elsewhere; no silent conversion to create. |
| Interaction remains stable | Open assists, native selection, focused controls/menus and hash/history across refresh; remote finish does not move focus or navigate. |
| Authority remains scoped | Session expiry, account switch during full/short batches, unavailable final session check, role downgrade, viewer and cross-league cases; staged and held legacy administrator reads cannot restore revoked private controls. Authority-only uncertain passes also require the final identity check. |
| Failures stay honest | Malformed/partial/unavailable reads retain usable prior data with appropriate freshness state; no invented zeros, empty collection or winner. |
| Coordinator stays bounded | Held reads, 12-second deadline, repeated failures/backoff, hidden/foreground event coalescing, removal and persisted-page restoration; no overlapping batches or surviving timers. Foreground during initialization queues one pass; a late write completion cannot resurrect a hidden-page clock interval. |
| Original QA list is complete | The ten-item map in [stack acceptance](stack-acceptance.md) records the first nine items complete in reviewed parents and the tenth implemented, awaiting final QA. |

## Confirmed local evidence and remaining work

The corrected worktree adds ten interaction cases (450 interactions / 498 total
app tests, including 50 UX-10 cases). The complete interaction file passed in
group3522, exit0, peak1877280KiB, remaining[]. Group4028 passed repository
lint/typecheck, full API/app tests,57 review-gate tests, contracts, build and
strict browser-fixture compilation. Its later browser phase found one stale
uncertain-transfer expectation; this was isolated before broad revalidation.
The final seven-suite browser matrix plus offline QA safety cases passed
212/212 with two explicit deployed opt-ins skipped, group8085, exit0,
peak1679632KiB, remaining[], tripNone. The native transfer case proves actual
main-frame reload, fresh session/game/roster GETs and changed remote membership
before the second deliberate PUT; it cannot pass on a merely local unlock.
Independent QA, architecture/security and design reviews cleared these fixes.
Corrected local M2 then passed4/4 in group8830, exit0, host peak1265040KiB
under a3.5GiB guard plus a hard512MiB database limit. All three service exits
were observed, the ephemeral database was removed, remaining[], tripNone.

The table below preserves the first published head's historical evidence.
Current-head integration, deployment, Codex review and gate evidence is recorded
in PR156's versioned packet; a prior-head pass is not substituted.

The root owned execution and reported the following historical results on 8
September 2026. Review agents did not launch tests or browser workers.

| Validation | Observed result |
| --- | --- |
| Complete application interaction file | Latest full file: 440 passed, including 40 UX-10 cases. The scheduled external-join regression and full file passed in group `93549`, exit 0, peak `1822800 KiB`, cleanup `[]`. The earlier held post-create focused case and 439-test full file also passed in group `92384`. |
| New production-built two-client browser fixture | 14 passed, using fictional intercepted transport and isolated clients. This is local Chromium evidence, not deployed or physical-device acceptance. |
| Earlier repository validation | Before the two isolated M2 fixes below: lint, typecheck, full API/app validation (486 app tests), 57 review-gate tests, contracts, build and diff check completed with exit 0. Owned process group `89559`, peak `1865248 KiB`, cleanup `[]`. Superseded by the final combined pass below. |
| Broader cross-surface browser matrix | Six complete existing suites: 183/183 passed, group `91067`, exit 0, peak `1774288 KiB`, remaining `[]`, trip `None`. Outputs: `/tmp/3fc-ux10-cross-surface/`. |
| Local M2 acceptance | 4/4 passed in group `94003`, exit 0, host peak `1323040 KiB` plus a hard 512 MiB Docker limit. Remaining `[]`; all three services' SIGTERM exits were observed and the ephemeral container was removed. |
| QA helper local validation | Strict typecheck of all fixtures and offline tests passed: 15 passed, 2 explicit deployed opt-ins skipped; group `93335`, exit 0, peak `846944 KiB`, cleanup `[]`. Independent source review is clear. This is not a deployed pass. |
| Backlog tooling | Root-observed validation and export passed before this evidence refresh; the latest JSON edit still needs regeneration by root. |
| Final combined revalidation | Passed: lint, typecheck, full API/app validation (488 app tests: 440 interactions and 48 layouts), 57 review-gate tests, contracts, build and strict typecheck of all e2e fixtures. The final browser/offline run passed 212 cases (197 browser plus 15 offline QA), with 2 explicit deployed opt-ins skipped. Group `94369`, exit 0, peak `1815312 KiB`, cleanup `[]`, trip `None`. |
| First published head (historical) | `190cbf4`: CI34208810305 and QA34209247864 passed. Deployed17/17 cases included two synthetic accounts and real clock/goal/own-goal/edit/delete/finish, preserved observer draft/focus and zero observer writes. Group98395 exit0 peak1194144KiB, cleanup[];32 graph records and both auth fixtures removed with absence verification. Signed-in read-only report checked at320/390/430/768/1280 with current assets and no overflow. |
| Corrected child gates | PR156's versioned packet is authoritative for the corrected head's tests, exact-head CI/Codex/deployed QA and final readiness. Earlier190cbf4 passes do not satisfy the new head. |

No physical iOS/Android result is implied by these counts; #137 remains open.

## Independent design findings and dispositions

- **GitHub Codex P1: path-only uncertainty settlement — fixed.** Review
  [3956352766](https://github.com/ajfisher/3fc/pull/156#discussion_r3956352766)
  demonstrated that a changed save could clear a barrier without settling the
  original request. The legacy lock is now absorbing until explicit reload,
  with no subsequent mutation dispatched even through synthetic controls.
- **GitHub Codex P1: mid-batch cookie transition — fixed.** Review
  [3956352772](https://github.com/ajfisher/3fc/pull/156#discussion_r3956352772)
  demonstrated that early identity checks alone did not fence later apply.
  Every batch now validates the session at its apply boundary, and authority
  changes remain staged until that check succeeds. The non-atomic residual
  limitation above remains explicit. Independent architecture/security review
  cleared both source fixes; focused QA and renewed external evidence follow.

- **Read-only result/log deferral — fixed.** Focus on a summary or goal action
  previously deferred the whole surface. Keyed updates now retain the actual
  disclosure/control while updating siblings; removal has a stable no-scroll
  focus destination.
- **Engaged roster deferred both collections — fixed.** An open transfer or
  action menu no longer freezes Teams and Unassigned. Exact opaque IDs are
  restored before matching; existing engaged rows, triggers and menu surfaces
  survive while other rows and counts update.
- **Pending local mutation focus regression — fixed.** The keyed helper's
  fallback initially focused the pool/list when a local assignment or promotion
  disabled or removed its trigger. That invalidated the operation's existing
  focus-ownership tracker. The fallback now yields to explicit pending local
  mutations; their completion callback restores the exact player's control.
  Remote removals still receive stable fallback. The subsequent 438-test
  interaction pass includes promotion and CR/LF/NUL identity cases.
- **Dirty metadata after remote clock start — fixed.** Draft values remain, an
  incompatible save is blocked, and the conditional note supplies Reload game.
  Its accessible descriptions are removed in healthy states, so hidden conflict
  text is not announced as routine guidance. Confirmed Save clears dirty state;
  closing the disclosure intentionally retains a draft.
- **Repeated feedback and recovery focus — fixed.** Unchanged refresh text is
  not rewritten repeatedly. Successful Retry updates hides its notice and moves
  focus only if that recovery surface still owns it. Mutation feedback remains
  separate, with no routine polling-success message.
- **Assist summary and retained drafts — fixed/reviewed.** Actual scorer/assist
  controls and selected identities survive background updates; invalid choices
  and externally changed edits remain visible but cannot save. The assist
  summary title is updated or removed with the selection.
- **Fast assignment after player creation — fixed.** The first ordinary M2
  failure exposed a visible new-player assignment button whose click was ignored
  while post-create reads were pending. Assignment/transfer controls now include
  the creation busy state, and creation start/finally redraw their actual disabled
  state. A held post-create roster read proves the committed player is visible
  but assignment-disabled; the same button becomes enabled after reads settle
  and sends exactly one identity-bound PUT to Blue. The focused regression and
  439-test file passed before proceeding.
- **Scheduled external-join wait — stale fixture corrected.** The next ordinary
  M2 failure was the old 10-second wait for a player joined by another client,
  shorter than the scheduled 15-second full-roster cadence. Only that condition
  wait changed to 25 seconds; private capped search was not promoted to roster
  authority. The exact 14999/15000ms regression proves the external join appears
  on the public roster refresh, retaining search/draft/focus and sending no
  observer writes. The focused regression and 440-test file passed before the
  final 4/4 M2 pass. Both failures had ordinary exits and observed service cleanup,
  with no resource anomaly; the second failed group was `92988`, exit 1, cleanup
  `[]`. Independent engineering source review cleared both added tests.

Final scoped design/source review found no material residual issue in the
root-authored refresh, conflict and focus paths or these three fictional local
captures: `refresh-unavailable-light-320.png`,
`remote-finished-score-dark-390.png` and
`remote-roster-preserved-actions-dark-390.png`, under
`/tmp/3fc-ux10-browser-complete/`. The 320px recovery copy/control is readable;
remote finish keeps the current Score destination without arming correction;
the retained action menu is readable while other roster rows update. This is
not an independent approval of the reviewer's own implementation or tests.

## Deployed QA helper safety disposition

The opt-in helper has now passed separate independent source review and the
offline checks above; it remains outside the screenshot/design disposition.
Execution requires exact site/API provenance and an explicitly verified QA
account/table. It creates a run-owned synthetic graph and two isolated accounts;
its allowlist limits the writer to that graph and forbids observer writes.

The cleanup review found that closing a browser is not evidence that an already
forwarded Lambda or its idempotency write has completed. This is fixed by tracking
each dispatched writer operation through actual response-body settlement and
returned game/event identity validation. Headers, a quiet interval, context close
or one absence read cannot confirm a write; a failed or ambiguous attempt remains
unconfirmed and cannot later be silently upgraded.

An atomic, mode-0600 non-secret recovery ledger records exact fixture keys and
operation/replay identities before dispatch. It deliberately excludes cookies,
tokens, authorization headers and raw request/SDK objects. Unconfirmed seed/write
outcomes, context-close failures or ledger failures retain the owned graph and
ledger for recovery instead of reporting successful cleanup. Only confirmed,
settled work qualifies for ownership-checked conditional deletes and absence
verification. Offline cases cover pending/failed bodies, identity mismatches,
ownership collisions and retained recovery state.

All local auth/log-helper source reviews are complete with no unresolved findings.
No deployed acceptance or actual live cleanup result for this child is claimed
by helper source review or its two skipped opt-ins. Exact-head external gates
remain required before readiness.

Root owns serialized focused tests, full affected files, repository validation,
built-asset browser fixtures and any deployed acceptance under the 4 GiB process
group ceiling. Review agents do not launch competing workers. The final packet
must identify exact commands, actual exits, cleanup, finding dispositions and
current-head CI/Codex/QA/review-gate evidence. No physical iOS/Android check is
claimed by desktop Chromium fixtures; those remain explicitly tracked in #137.

## Rollout and rollback

This frontend-only child keeps the existing site-first QA workflow unchanged.
Require its exact-head deployment and acceptance before readiness; the parent's
evidence is only the starting point. QA is shared and deployments remain serial.

Rollback is the validated PR155 frontend at
`dd8982e134fd055bb4f7e13ad5cb4053853a9de8`. Its API remains compatible and does
not need rollback for removal of this coordinator. Stopping refresh does not
reverse a durable goal, claim, assignment or clock action. The rollback policy is
not evidence that a rollback deployment was performed. No merge, auto-merge,
queue entry or production release is authorized by this document.
