# Mobile-first frontend redesign

Status: approved implementation scope, 7 September 2026. This document supersedes
the exploratory design review and its illustrative mobile prototype. The current
delivery is the existing-frontend redesign, not the later player portal.

## Boundaries

Preserve game rules, IDs, scoped routes, authentication, existing join/claim
behaviour, league ACLs, idempotency and authorised finished-game corrections.
Players, organisers, scorers and viewers are distinct, overlapping relationships;
claiming a player does not grant an ACL role. Scorer access remains league-wide
and promotion-only. Do not add a global role switch.

Retain the current add-player and team-assignment workflow, including late
additions during a game. There is no new attendance or no-show workflow. Future
games-played counts use distinct finished games with team membership, not merely
joining, claiming, organising or scoring duties.

The only planned backend addition in this stack is active-session sign-out
(`M1-13`, GitHub #114). Any further necessary backend refinement must be separately
scoped and reviewed by architecture, security and QA before implementation.

Deferred: ownership-proof hardening of the existing claim flow, safe public
results, join/invite preview APIs, participant home/history, season standings,
leaderboards and private performance. Do not add dead navigation or promise these
capabilities. No framework migration, new component library, editable profiles,
identity merging, match-only scorer grants, offline-first mode or production
release is included.

## Design system

Follow system appearance using light/dark tokens; do not add a theme switch.
Keep local, allow-listed Lucide/Iconify assets and the CSS thirds indicator.
No runtime icon/font CDN or additional production dependency is needed.

| Token | Light | Dark |
| --- | --- | --- |
| Canvas | `#f5f6f2` | `#131b18` |
| Surface | `#ffffff` | `#1e2924` |
| Text | `#14291f` | `#edf5ee` |
| Secondary text | `#526057` | `#b2c0b6` |
| Divider | `#d9dfd8` | `#3c4b42` |
| Primary action | `#125f45` | `#a3e4b5` |
| Text on primary | `#ffffff` | `#153323` |
| Soft selection | `#e5eee5` | `#293f31` |

Use system sans-serif. Body and inputs: 16/24px; labels/metadata: approximately
14/20px; mobile page titles: 26–30px; section titles: 18–20px; score/clock:
36–48px. Use tabular numerals for tallies and time. Verify contrast on actual
combinations, including team colours and disabled states.

Spacing scale: 4, 8, 12, 16, 24, 32, 48px. Phone gutters: 16px. Desktop gutters:
24–32px. Control radius: 8px; content surfaces: 12px, with uniform corners.
Use surface colour and space to establish hierarchy. No decorative top/side
stripes, curved accent caps, gradients, glows or gratuitous nested panels.
Keep meaningful focus, selection, validation and active-navigation indicators.

Effective targets are at least 44px; repeated roster/scoring actions target 48px.
Primary tasks use visible verbs; familiar utilities may be icon-only with an
entity-specific accessible name. SVG contents are decorative and child clicks
must activate the enclosing control exactly once.

## Content contract

Every visible string helps someone orient, choose, act, understand an outcome or
recover. Delete copy without a purpose rather than replace it with a slogan.
There is no mandatory subtitle below a heading. Use Australian English, familiar
football terms and direct task labels: View game, Add player, Transfer, Record
goal, Save, Copy join link, Invite organiser and Sign out.

Do not render these rejected concepts, including as accessible descriptions:

- One account for playing and organising.
- Your context.
- Permissions follow the league and game you open.
- Your player history stays with your account.
- Your games, people and progress; Your week with 3FC.
- Only games linked to your player profile count towards your performance.
- Account access is managed separately from team assignment.
- Scoring tools for this game. Your access applies across this league.
- Organiser invitations and league-wide scorer access belong here, separate from player participation.

Explain consequences at the decision point. A scorer grant must say it applies
to all games in the named league before confirmation; do not repeat that on the
normal match screen. Preserve labels, useful constraints, recipient information,
sample sizes, accessible names and genuine feedback.

Each implementation PR includes a copy/state sheet for its screens:

| State | Required treatment |
| --- | --- |
| Populated | Actual entity names, dates, values and useful actions; no invented role chips or personal data. |
| Loading | Stable layout; do not flash an empty result before fetching. One quiet pending indication. |
| Empty | Describe the actual absence, with an action only when authorised and implemented. |
| Pending write | Disable/latch the initiating action and show concise progress. |
| Confirmed success | One visible, accessible confirmation, for example Player added or Goal recorded. |
| Confirmed failure | State the problem and usable recovery. Preserve input and safe retry identity. |
| Uncertain write | Do not claim success/failure that is not known. Keep the draft and existing reconciliation/idempotent retry behaviour. |
| Restricted | No unauthorised action or private-data leakage; explain the unavailable task only when needed. |

Retain meaningful operation feedback; the ban on idle chatter does not remove
Saving, failures, sign-in recovery or uncertainty. One error message must not be
announced twice by separate status and alert surfaces.

## Existing screens and data

| Surface | Data/authority source | Required experience |
| --- | --- | --- |
| Home/account | Current session and existing authorised league list | Leagues first. Create league below them. Known reliable name or neutral greeting. Working account/sign-out entry, not permanent session chatter. No cross-league summary fan-out. |
| League | Existing scoped league/seasons and ACL | Real breadcrumb/name; human dates; aligned desktop rows and generous phone rows. Create/invite intentionally disclosed; delete low-emphasis with existing confirmation. |
| Season | Existing scoped game list | Upcoming before completed, concise empty state, linked local kickoff and readable status. No invented winner if the list lacks results. |
| Create/edit | Current creation endpoints and controller drafts | Bounded focused form; IDs optional reference; friendly URL under more options; first-field focus, preserved draft and cancellation focus restoration. |
| Game overview | Existing game/team/roster reads and actual ACL | Date/time/state, readable details, explicit manage/score actions. Do not require admin-only player-search for a viewer. |
| Teams | Existing roster and authorised player search/create/assignment | Unassigned then team groups, one search, each assigned person once. Real keyboard-submittable Add player. |
| Scoring | Existing timer/goals/result contracts and permitted mutations | One coordinated score/clock region and efficient goal sequence; preserve authoritative timing and mutation semantics. |
| Results | Authenticated stored result and goal data | Outcome and comparable totals first, then contributions and log. Explicit authorised corrections. No public-result sharing. |
| Join/invite/auth | Existing supported responses and authentication flow | Show only safely known context and the meaningful current step. Joining does not imply viewing access or personal history. No unsupported redirect or destination. |

### Navigation and layout

Use a restrained shared header with home/account entry and actual breadcrumb
names. Do not copy the prototype's future Home/Games/Performance navigation.
Desktop lists use aligned columns; phone rows prioritise the main name/date link
over rare actions. Put destructive actions in a labelled More/management surface
while preserving existing confirmations and disabled reasons.

Use stable Overview and Teams destinations, and Results once finished. Scoring
is an explicit task with Back to game, not a state-changing fourth tab. Default
scheduled/live viewing to Overview and finished viewing to Results. Add readable
`#overview`, `#teams`, `#score`, `#results` destinations while retaining existing
`#structure`, `#players`, `#run`, `#final` and `#mode-*` compatibility. Honour
authorised explicit destinations; invalid/unavailable modes fall back safely.
Update browser history and back/forward handling. Destination changes land at
their meaningful start with visible focus; do not preserve unrelated scrolling.
Retain `#create-game` and existing scoped/legacy route compatibility.

Team groups stack at narrow/tablet widths. Only use columns when each group has
room for full names and actions; do not repeat the nested-column 768px failure.
Transfers show only valid other teams, one menu at a time, with Escape support,
success collapse and failure retention. Preserve existing finished-game and
permission locks. Authorised historical editing is explicit, not removed.

### Scoring and reports

Keep Red/Blue/Yellow in stable positions. Label Conceded as primary and Scored as
secondary. Coordinate sticky clock/score content so it never covers focus or a
field, including text wrapping, landscape, safe areas and software keyboards.
Start third and Finish third stay distinct from Record goal.

Use labelled direct scoring/conceding team choices, a roster-based scorer
dropdown, and a compact assist multiselect. Labels are Scoring team, Conceding
team and Scorer. Retain blank selection/prerequisite behaviour. Own goals must
not invent a scoring team or change existing attribution rules. Enforce at most
three unique rostered assisters, no self-assist, and any-team eligibility.

Clear the complete create/edit draft after confirmed commit even if a subsequent
result refresh fails. Preserve failed/uncertain drafts and idempotency keys.
Undo uses the current expected-event guard; do not remove an unrelated newer
event. Keep names readable in compact goal rows, team dots/relationship and
accessible thirds indicators, with edit/delete controls and optional assists.

Finished reports lead with winner/draw and the three-team totals. Show conceded
and scored distinctly, then player contributions and the full log. Preserve all
winner/tiebreak/own-goal/assist computations. Public result sharing and personal
performance are deferred, not hidden unfinished features.

### Sign-out interface

`POST /v1/auth/logout` invalidates the current server-side session and expires
the httpOnly session cookie with its existing environment/domain/path security
attributes. It is safe with a missing, invalid, expired or previously revoked
session. Success returns to sign-in without the existing-session redirect loop.
Failures must not falsely report sign-out. Test that magic-link recovery cannot
resurrect a revoked session. Implement the local handler, Lambda, contract,
Serverless route and deployment checks together. Revoke only the session
represented by the current cookie; independently issued sessions remain valid.
The same replayable magic link can establish the same session in two browsers,
so signing out that shared session correctly invalidates both. Do not introduce
a device identity model or promise isolation between copies of one session.

## Stack and acceptance ownership

| PR | Branch | Canonical issue | Scope |
| --- | --- | --- | --- |
| 0 | codex/design-delivery-backlog | UX-00 | This specification, backlog/GitHub reconciliation and evidence map. |
| 1 | codex/design-foundation | UX-01 | Shared tokens, controls, visibility, copy/state contract and fixtures. |
| 2 | codex/auth-sign-out | M1-13 (#114) | Complete current-session logout before shell integration. |
| 3 | codex/design-organiser-shell | UX-02 | Home/account, league/season lists and focused forms. |
| 4 | codex/design-match-roster | UX-03 | Match/navigation, existing viewer reads, roster and transfers. |
| 5 | codex/design-live-scoring | UX-04 | Clock/scoreboard, goal entry, log and mutation feedback. |
| 6 | codex/design-results-entry | UX-05, UX-06 | Authenticated report, existing entry journeys, final acceptance. |

The first branch targets main; each child targets its predecessor. Each head must
work independently and complete review before child implementation begins. Link
partially addressed existing issues without closing their remaining scope.

For every PR, independent design/content and frontend/accessibility reviewers
inspect rendered states. Engineering and QA challenge implementation and test
claims. Architecture/security review is mandatory for backend, auth, permissions,
contracts, private data, ownership, dependencies or deployment changes. Reviewers
are read-only and do not launch competing tests.

| Evidence area | Minimum checks |
| --- | --- |
| Responsive | 320/390/430px, 768px and desktop; landscape, enlarged text and 200% zoom; both themes; no page overflow, name fragmentation or obscured focus. |
| Roles | Player-only, organiser-only, scorer-only, combined, ACL viewer without a claim, cross-league permissions; truthful unavailable views. |
| Interactions | SVG-child clicks, keyboard form submission, disclosures/focus/history, successful and failed transfers, late additions, corrections and draft recovery. |
| Rules | Normal/own goals, assists, thirds/stoppage time, edit/delete/undo, confirmed/uncertain commits, winner/tiebreak/draw correctness. |
| Security | Local/Lambda parity, logout/replay/account switch, CSP/headers, no new public/private data leakage or remote icon dependency. |
| Device | Real iOS Safari and Android keyboard/safe-area/date/email-return checks, plus Android Firefox account switching. Emulation is not physical-device evidence. |

Use dedicated QA data/accounts; never mutate AJ's real matches for acceptance.
Missing physical-device access is an explicit evidence gap requiring AJ's check,
not a passing result or a reason to fabricate evidence.

Run focused tests, then files/suites, then required lint/typecheck/full tests,
contracts, build and review-gate tests serially. The local M2 Playwright smoke
depends on local fake email/DynamoDB; do not point it at QA. Deployed acceptance
uses dedicated scenarios. Before each intensive command, check for old workers,
preserve its session/process group, monitor aggregate RSS under 4 GiB, observe
exit and verify cleanup. Stop abnormal groups; never blindly retry.

Every PR preserves the versioned packet and maps criteria to evidence. Record
risk, architecture/invariants, findings and rollback. Request GitHub Codex review
on the exact head and verify its formal reviewed SHA; an advisory comment alone
is not current-head review. Mark ready before adding/re-adding QA-ready. CI and
QA deploy must pass at that head. QA is shared, so serialize deployments and
record evidence before another branch replaces it. Refresh the review gate and
require review:ready plus current-head Codex evidence. Revisions/rebases require
refreshed checks, affected reviews, QA and downstream evidence. Do not weaken the
policy. The PR that changes any asserted heading/content must update the QA and
production smoke assertions in that same PR, retaining route/assets/security
checks; this particularly applies to UX-02 home/setup changes and must not wait
for UX-05. Workflow/copy-smoke changes and logout receive high-risk review.

Finish with the full frontend stack ready for AJ's final review and an
issue-to-PR-to-evidence checklist. No merge, auto-merge, merge queue or production
release without explicit authorisation.

## Deferred player work

Existing M3 issues retain their identities and their own complete acceptance.
M3-07 hardens ownership proof before new public discovery/private history. M3-01
and M3-02 add canonical safe public results; M3-09 adds safe entry context.
M3-08 adds bounded claim/participation lookup and home. M3-03/M3-04 own shared
finished-game standings/leaderboards; M3-06 uses those aggregates for private
performance. No private identity or join/invite bearer data is public. No claim,
registration or ACL grant independently counts as playing. This is planned work,
not part of the current frontend implementation or a claim of completion.
