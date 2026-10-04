# Player profiles, Club Cards and achievements

Approved implementation brief · 3 October 2026; UI refinements · 4 October 2026. Supersedes the design study's
19-badge launch proposal and unresolved decisions. Delivery is tracked in
[player-profile-delivery.md](player-profile-delivery.md) and the canonical backlog.

## Release outcome

Give players useful statistics and a green-and-gold Club Card they are proud to
share. Ship all 23 approved achievements and an in-app unlock gallery. XP, levels,
email changes, notification preferences, public live profile links, manual badge
selection and social features are deferred. Preserve all milestone history for
later retrospective XP; Own Goal must never carry positive XP.

Live profiles require authorised league access, including verified participation
or an existing league ACL. Participation grants read access, not management rights.
Downloaded card images can be shared anywhere and contain performance information
and the selected portrait only.

## Profile and statistics

Use the existing application components, typography, semantic colours and light/
dark themes. The statistics grid is the main view; the card opens on demand.
Open on Season, preserving a supplied season or selecting the latest played
season. With no appearances, select the league's most recent season.

| Period | Statistics |
| --- | --- |
| Last game | Goals, assists, win/draw/loss, own goals |
| Season | Played, goals, assists, wins, draws, own goals, goals/game |
| Career | Same as Season, across the player's recorded history in this league |

Place the name before the league underneath it, with the identity block centred
against the portrait. Centre each statistic and its label. Open the card through
a link-style action inside the statistics panel.

Season and Career show a newest-first match log, 20 entries per page, explicit
Load more and match links. Last game instead shows a compact Last match summary:
linked date, result and plain team scored/conceded totals, without repeating the
player contributions or match history.
Make profiles reachable from relevant league, season, roster and result names.
The grid, log and card use the same authoritative contribution facts. Include
loading, empty, updating and unavailable states. Incomplete totals must not appear
complete; unknown data must not become zero. Zero appearances use zero goals/game.

Resolve canonical identities and aliases before counting each completed game
once. Played requires final team membership, including eligible late assignments;
claims, joins or management duties alone do not count. Own goals never count as
player goals or team scored. Preserve existing assist semantics and the canonical
winner comparator: fewest conceded, then most scored, with tied first teams drawing.

## Club Card

Retain the approved dark green, cream and gold shield, circular portrait, strong
name and gold linework badges. Use the approved three-sided hexagonal pitch for
Played. Open a dialog for the selected period, flip between performance and
honours, and restore focus on close. Export either side as a 1200 × 1560 PNG;
offer native file sharing where supported and download otherwise. Export failure
allows retry without losing period or side. Use Achievements / Statistics for
the flip action and accessible icons for share/download. Refresh expiring share
authorisation silently; retain explicit retry for actual failures. The reverse
is titled Top achievements, with an additional-achievement count and one All
achievements action into the scoped gallery instead of repeating the badge list.

The reverse holds up to five badge classes in the five-dot die arrangement.
Select by rarity (Epic, Legendary, Rare, Common), milestone ordinal descending,
latest milestone date descending, then stable badge ID. Season/career show the
highest active milestone per class. Last game shows milestones earned in that
match, merging identical season/career unlocks with both scope labels. Preserve
all underlying unlocks in the gallery. Fewer badges remain readable; an empty
reverse invites the player to start earning, and additional honours are indicated.
The first milestone earns the badge and first star; show individual stars through
five, then a compact star count.

## Owner details and portrait

Only the verified canonical player owner can change display name or portrait.
Never derive ownership from query parameters, admin or scorer roles. Name changes
update canonical presentation and directory projections without changing history IDs.
Keep owner-only account details, including read-only email, in a separate response
and screen. No private account fields enter performance responses, HTML, exports,
caches or telemetry.

Accept JPEG, PNG and WebP up to 8 MB and 16 megapixels. Add, crop, replace or remove
a portrait, cropping to a 512px square with circular display. Server-side decoding,
validation and re-encoding strip metadata; store only processed images in private
object storage. Reads enforce the same league visibility rules as profiles. Delete
or replace cleans old objects; removal immediately restores initials. Explain before
saving that authorised league viewers and shared card images show the portrait.
Photo selection waits for any in-flight account check after the native picker
closes, then opens the crop. Preview locally; upload only on Save portrait.

## Achievement gallery

Reuse the approved vectors and gallery layout in the app. The shared versioned
[definition source](../../packages/contracts/src/achievements.ts) contains the
23 identifiers, artwork, rarity and descriptions. The evaluator and gallery must
use the same rules and milestone scales. No independently hardcoded unlock copy.

Show all enabled classes, including unearned ones. Support search, rarity and
All / Earned / To unlock in a player context, defaulting to Earned. Order filters
Collection, Rarity, Find an achievement. Show player and season/career scope,
confirmed progress, highest milestone and dates; unknown history is not locked or
zero. Details explain qualifying actions, first unlock, milestone progression,
team eligibility and timing/counting conditions. Profile/card links open the
corresponding detail. Preserve filters and scroll, keyboard dismissal and focus
return. Display concise Progress: X / Y on cards; retain unknown/partial history
qualifiers. Detail lists use stars without repeated ordered counters and load
unlock history automatically as Achieved dates. Place progress to the next
milestone after that history. Remove redundant first/highest-unlock summaries,
study controls, arbitrary star sliders and artwork downloads.

## Personal navigation

The shared header links to My profile at `/player`. Resolve that entry from the
signed-in account's verified claims; show a choice when multiple league profiles
exist and an explicit unlinked state when none do. The dashboard sends linked
players without management roles to their profile. Organisers/scorers retain the
dashboard. Unknown roles, failed discovery or user interaction keep the dashboard
usable; explicit league/game/profile links retain their requested destination.

`GET /v1/my-player-profiles` uses existing account claim, canonical identity and
reverse league-membership records. One request visits one claim and at most five
league links, rechecking current ownership and league visibility. Cursors bind
to verified session identities and claim/identity revisions; clients follow empty
continuation pages and do not assume a sole profile until discovery is complete.
No new index, table scan, migration or write authority is introduced. The existing
`GET /v1/leagues` response supplies `hasManagementAccess`, combining admin/scorer
ACL roles across verified subject/email identities solely as a navigation hint.
Every protected action still checks its own authority. Both local HTTP and Lambda
use the shared profile handler; disabled profiles or unavailable discovery fall
back safely. See the documented routes in `docs/openapi/v1-core-write.yaml`.

## Achievement rules

| Rarity | Milestones | Classes |
| --- | --- | --- |
| Common | 1, 5, 10, 25, 50, 100, 150, 200, then every 100 | Goal, Played, Assist |
| Rare | 1, 3, 5, 10, 15, 20, 30, then every 10 | Wins, Draw, Defence, Momentum Play, Clutch, Speedy, Message Sent, Hat-trick, Master Provider, Double Threat, On Fire, Helping Hand |
| Legendary | Every occurrence | Own Goal, Desperate Defence, Hail Mary, Triple Threat, Comeback Crew, Team Engine, Unbeaten Run |
| Epic | Every occurrence | Lockdown |

- Goal, Assist and Own Goal count credited events. Played, Wins and Draw count
  eligible completed matches. Overlapping achievements are allowed.
- Defence counts thirds with zero conceded, starting with
  `teamConceded - min(opponentsConceded) < 2`.
- Desperate Defence requires an outright lead entering the final third, zero
  conceded in that third and an outright final win.
- Momentum Play: each goal in the closing window of the first or second third.
  Clutch: each closing-window goal in the final third. Hail Mary additionally
  changes losing/drawing into an outright lead and requires an outright final win.
- Speedy: each opening-window goal in the second or third third. Message Sent:
  each opening-window goal in the first third. Opening means `0 <= seconds < 120`.
  Closing starts one minute before regulation ends through stoppage to third end.
- Hat-trick: three goals in one match. Master Provider: three assists in one match.
  Double Threat: at least one goal and assist in one match. Triple Threat: a goal
  in each third. Team Engine: a goal and assist in each third.
- Lockdown: team concedes zero for the whole match. Comeback Crew: team starts the
  final third outside first place (including outside shared first), then wins outright.
  These two and Hat-trick, Master Provider, Double Threat, Triple Threat and Team
  Engine count at most once per match. Team awards apply to the eligible final
  roster, with no inference about minutes played.
- On Fire: five consecutive scoring appearances. Helping Hand: three consecutive
  assisting appearances. Unbeaten Run: five consecutive wins/draws. Reset after
  earning or breaking the run; missed fixtures do not break an appearance streak.
  Career streaks cross season boundaries; season streaks begin afresh.

## Historical derivation and corrections

Backfill assessable history in kickoff/game-ID order. Separate original earned
date from calculation date. Preserve explicit timing provenance for new goals and
use reliable historical evidence. Goals inserted after completion never qualify
for timed badges. Unknown goal timing also affects third clean sheets and lead
transitions: keep aggregate statistics but mark affected achievements unassessable.

Corrected/deleted goals, final roster corrections and consolidation trigger bounded,
retryable reconciliation. Recompute later streaks/milestones when earlier history
changes. Keep stable unlock IDs, source evidence, rule version and audit history;
remove invalid awards from display and reinstate when justified. Preserve every
milestone, including tiers hidden by higher awards. Retries and alias merges must
never duplicate unlocks. Publish only revision-consistent projections.

## Delivery and acceptance

Build complete chronological projections; the bounded directory sample is not
career history. No request-time table scans or browser league-history fan-out.
Use transactional work markers, a DynamoDB Streams dispatcher and SQS Lambda
worker with bounded batches/checkpoints. Include resumable backfill, dry-run
comparison and failed-job recovery. Local HTTP and Lambda share handlers and
validated contracts; fixed routes/query parameters preserve opaque identifiers.

Deploy new readers/writers before backfill, verify QA coverage/totals, then enable
separate profiles, owner-editing and achievements flags. Monitor lag, failed jobs,
stale projections, backfill and media failures. Rollback disables exposure/workers
while preserving source and unlock history. Terraform, Serverless, IAM and workflow
changes travel with their owning feature PRs. AJ retains merge/release authority.

Release gates cover all rule/threshold/timing boundaries, aliases, empty histories,
corrections, concurrent work, privacy/ownership matrices, malformed/oversized media,
mobile widths 320/390/430 and desktop, both themes, enlarged text, keyboard, screen
reader and real-device sharing. Local validation is serialised under a 4 GiB
process-tree ceiling; every stack slice needs independent review and its own
current-head passing gate before the next slice begins.

## Local design reference

The local profile at http://127.0.0.1:4381/ and design gallery at
http://127.0.0.1:4382/ retain the approved visual exploration. They are fixed QA
fixtures, not production routes or evidence of implemented permissions/awards.
The owner query switch is presentation-only. Xavier's supplied portrait, demo
account editor and example unlocks must not become production defaults. The
mock's earlier 19-class app catalogue does not limit the approved 23-class release.
