# 3FC Web App — Product Brief (v0)

A lightweight, phone-first web app for recording three-sided soccer games (3
thirds) via goal events, computing results automatically, and sharing outcomes
+ season stats.

This page is the product brief. Technical architecture/specs will be written
separately once we agree scope + UX.

## Problem

- 3FC is social and teams are created on the day; tracking in spreadsheets is
  fiddly on a phone.
- Scorekeeping requires repeated entry of goals, scorers, and (optionally)
  assists; totals and winner rules should be computed automatically.
- Players want to see results and personal contributions over time without
  extra admin burden.

## Goals (v0)

- Fast goal logging during play (single scorekeeper on one phone).
- Timer-per-third with stoppage time, auto-stamping goal events.
- Accurate results per 3FC rules (winner = fewest conceded; tiebreak = most
  scored; else draw).
- Capture player goals + assists (multi-assist) and show post-game summary +
  timeline.
- Let players claim a profile (Cognito: Google/Facebook/magic link) and get an
  email summary after game.
- QR join link to speed up onboarding/registration to a specific game.
- Season-level stats (v0): team played/win/loss + conceded/scored; player goal
  leaderboards (total goals and goals-per-match).

## Non-goals (v0)

- No tracking of who is on/off pitch at time of goal (subs rotate informally).
- No offline-first requirement (online-only is ok).
- No deep event metadata beyond what we need (e.g. locations, shot types, etc).
  No multi-scorekeeper concurrent editing in v0.

## Users & roles

- Scorekeeper (usually one person): creates/starts games, assigns players to
  teams, logs goals.
- Player: can view public results; if logged in + claimed, sees personal stats
  and receives email notifications.
- Admin (scoped per League/Season/Game): can modify entities and correct data.

## Core concepts

- League → contains Seasons.
- Season → contains Sessions/Days and Games.
- Game → exactly 3 thirds; teams are typically Red/Blue/Yellow (configurable
  per league/season).
- Team - a collection of players. Configurable to be set at season or game
  level.
- Goal event → scored-by player (team they belong to awarded the scoring goal)
  + conceding team, optional assists; may be an own goal.
- Two tallies are explicit: conceded (includes own goals) vs scored (excludes
  own goals).

## Key rules

- Winner: team with fewest conceded.
- Tiebreak: team with most scored of the tied teams.
- If still tied: draw.
- Own goals: increase conceding team conceded; do NOT add to any other team
  scored.

## Primary flows

1. Create/select League + Season.
2. Create Game (date, place, third length 20/25/30).
3. Assign players quickly to Red/Blue/Yellow (show recent players heavily).
4. (optional) edit third length times 
5. (optional) reassign players or add late joining players
6. Start Third → timer runs; at nominal time it rolls into stoppage; ‘Finish
Third’ ends it.
7. Log goal: tap scoring team, tap conceding team, pick scorer (from scoring
team), optionally add assists (quick multi select from available players);
event stamped with current time.
8. (ongoing) show current scoreboard - conceded goals by team, scored goals by
team.
9. Undo last goal (one tap). Edit/remove any goal from the timeline list.
10. Finish game → compute winner + stats → send email summaries to claimed
players.
11. Share results via public game URL (suggested: /league/season/game, each as
ID or human-friendly slug e.g. https://3fc.football/melbourne-3fc/2025-26/20260222/).

## Screens (v0)

- Home: pick league/season; quick links to today’s session/game.
- Game setup: choose third length; add/assign players; show recent players list
  + search.
- Live game: big timer + third controls; big ‘Add Goal’ button; mini
  scoreboard; undo.
- Add goal modal/screen: scoring team → conceding team → scorer → assists →
  save.
- Timeline: list of goals (time, third, scorer, assists, own goal flag),
  edit/remove.
- Results: per-team conceded/scored by third + total; winner banner; player
  leaderboard; timeline.
- Join (QR): identify yourself fast; claim profile or quick-register then claim
  later.

## Notifications (email)

- Triggered on game finish (immediately or shortly after).
- Email contains summary + personal callouts (you scored/assisted) + link to
  full results.
- Privacy: emails only visible to the owner + admins; public pages show
  nickname + optional avatar only.

## Success criteria

- Goal logging is fast enough to keep up with play (single phone).
- Joining via QR + claiming identity takes ~20–30 seconds for most players.
- Post-game output is ‘good enough’ to replace the spreadsheet.

## Nice-to-haves / later

- PWA push notifications.
- Richer visualisations (season trends, head-to-head, assist networks).
- Offline support + sync.

## Answered questions

- [x]  What is the minimal set of season stats to ship in v0 (top 5)?
    - Played/ win / loss / conceded / scored
    - Seasonal player score lists sortable by nominal goals scored vs goals div
      matches played
- [x]  Do we need to support multiple scorekeepers editing the same game
  concurrently later?
    -  No - not at this time
- [x]  What’s the desired public URL structure (human-friendly slug vs ID
  only)?
    - /league/season/game
    - Each of these to be an ID or human friendly identifier eg
      https://3fc.football/melbourne-3fc/2025-26/20260222/
