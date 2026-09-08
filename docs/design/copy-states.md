# Reviewed interface copy and states

This sheet accompanies the frontend stack. Each slice adds its final screen copy
and recovery behaviour here; future screens are not promised by current copy.

## Shared foundation (UX-01)

| State | Treatment |
| --- | --- |
| Empty global feedback | Hidden with no layout gap or idle sign-in statement. |
| Loading a page | Quiet spinner with a short accessible loading message. No fabricated empty result is introduced by this slice. |
| Pending mutation | Existing specific progress, disabled action and request ownership are preserved. |
| Confirmed save | A visible polite message, such as “Game updated.” or “Player created.” |
| Failure | One visible global live region combines the outcome and detailed recovery. |
| Uncertain mutation | Preserve “could not confirm”, safe retry instructions and draft/idempotency state. Never replace uncertainty with success. |
| Committed mutation, refresh failed | Say the change was saved and which view failed to refresh. |
| Email organiser invitation | One feedback region immediately after the invite disclosure owns pending/sent/unconfirmed/failed messages, remaining visible if the form closes mid-request. No duplicate global announcement. Existing delivery/recovery contracts are unchanged. |
| Routine roster load | No “Game roster ready” message. |

The component examples use labelled fictional fixtures, genuine in-page links,
native form controls and the existing confirmation prompt. They do not advertise
performance, standings, public results or unsupported navigation.

The foundation retained authentication completion mechanics. The final entry
slice below refines its copy while keeping the same timer and recovery contract.

## Organiser shell (UX-02)

| Surface/state | Reviewed treatment |
| --- | --- |
| Home | Neutral “Welcome”; “Leagues” first; “Create a new league” below the existing list. No email-local-part name guess or speculative cross-league game summary. |
| Empty league list | “No leagues to show.” Only after the authorised list responds, with the creation form opened once without stealing focus. |
| League/season navigation | Home plus actual league/season names. On phones, omit the duplicate breadcrumb Home from display/tab order and visually hide its non-interactive current item; the H1 supplies the full name. Season retains its real parent link. Full breadcrumbs remain on desktop. Generic League/Season only while loading, never an opaque route ID as the heading. |
| Management actions | Visible Create season, Invite organiser and Create game verbs. Rare actions sit behind a vertical-three-dot button named “Actions for {entity}”; the floating surface uses visible action verbs. No More/Manage action accordions, or management controls while authority is unknown. |
| Reference data | “Reference ID” collapsed in the heading area; “Additional options” contains friendly URL and creation IDs. |
| Native forms | Visible label, Create/Send action and Cancel. Cancel preserves the draft and returns focus to the opener. |
| Invite by email | “Only this email address can accept.” This material restriction stays at the choice, unlike routine permission narration. |
| Empty season/game lists | “No seasons yet.” / “No upcoming games.” / “No completed games.” No pre-load empty-state flash or repeated ordering subtitle. |
| Dates | Human calendar ranges with no timezone shift for date-only values; local kickoff date and time. Missing bounds say Starts, Ends or Dates not set. |
| Uncertain creation | Preserve the original attempt and explain that Retry uses those details. Do not present edited fields as a new confirmed request. |
| Confirmed deletion, failed reload | Say the item was deleted and the list could not be refreshed; remove the confirmed deleted row. Never report deletion failure after HTTP 204. |

Role presentation uses existing league access, not player claims or creator
identity. Read-only league rows do not acquire admin actions through a home-page
request fan-out. Existing sign-out and invitation outcome feedback remain.

## Match overview and teams (UX-03)

| Surface/state | Reviewed treatment |
| --- | --- |
| Match navigation | Stable Overview and Teams; Results after confirmed finish. Score game is an explicit task with Back to game, not a changing clock/navigation label. |
| Overview | Actual date, kickoff, status and third length. Edit game opens only when requested and authorised. Join game and Reference IDs are optional details. |
| Teams | Unassigned candidates when available, then Red, Blue and Yellow. Assigned identities appear once. Search players filters current-game names. |
| Add player | Player name, Add player and Cancel. Native Enter submission; retained failed/uncertain input and safe consecutive additions. |
| Capped search | “Search by name to find more players.” A capped candidate response is not described as the complete game population. |
| Filtered empty state | “No matching players.” Do not turn a filtered list or unavailable enrichment into an assertion that nobody joined. |
| Viewer roster | Existing public assigned names and teams, without fabricated Unassigned 0, claim status or management controls. |
| Transfer | Familiar transfer action with an entity-specific accessible name, only other teams, preserved context on failure. An uncertain request says “Assignment could not be confirmed. Retry this team choice or reload to check.” |
| Scorer promotion | Confirm “Allow {name} to score all games in {league}?” at the action. Co-organiser promotion also explains management access. No routine league-permission paragraph on the match page. |
| Finished records | Readable Results and Teams. Correct result and Edit teams are explicit authorised editing entry points, not ordinary live actions. |

Loading, committed, failed and uncertain outcomes retain the shared feedback
contract. This slice does not promise attendance, public viewing, personal
history, a player portal or match-only scorer permissions.

## Live scoring (UX-04)

| Surface/state | Reviewed treatment |
| --- | --- |
| Score and clock | Stable Red, Blue and Yellow; Conceded primary and Scored secondary. Actual third/time/status, without a second clock panel or a repeated instruction. |
| Goal entry | Record goal; Own goal; Scoring team; Conceding team; Scorer. Native labelled team choices start unselected and preserve prerequisites. |
| Assist chooser | Assists; Choose assists when empty, selected names/count when populated. “Up to 3 players” inside the chooser. No “Assists: None” in the log. |
| Editing | Save changes and Cancel edit. Completed edits return to a blank Record goal form. |
| Uncertain goal operation | Keep its exact draft/target and offer Retry goal save, Retry goal deletion or Retry undo. Do not claim that a lost response means failure. |
| Clock uncertainty | Refresh game checks the current state; it does not silently repeat a start/finish-third request. Retry finish game preserves the existing request identity. |
| Latest goals | Full player names, compact time, dot-only team relationship, optional assists and accessible thirds. Own goal remains explicit; no repeated arithmetic explanation. |
| Undo | Undo last goal, tied to the originally captured expected goal during a retry. |

Confirmed commits and failed refreshes are separate outcomes. Keep useful
constraints and recovery, without promising offline recovery or concurrent
scorekeeper editing.

## Results and existing entry journeys (UX-05)

| Surface/state | Reviewed treatment |
| --- | --- |
| Finished report | Match summary; confirmed winner or Draw, comparable Red/Blue/Yellow totals, Goals and Assists, Own goals only when present, then one Full match log. No duplicate per-team logs or routine Status/Finished paragraph. |
| Invalid/missing result | Result unavailable. Never turn malformed counts into zero or a missing winner into Draw. Valid totals may remain when the outcome cannot be verified. |
| Unavailable log | Player contributions and the match log could not be loaded. Reload to try again. A missing or partial log is not an empty match. |
| Goal log | Time, full player name, dot-only team relationship and accessible thirds. Optional assists, explicit OG; no repeated conceding-only explanation. |
| Join | Join game; Player name; Use the name the scorekeeper expects. One join code and no raw game-ID receipt. |
| Claim | Sign in to claim this player / Claim player / Player claimed. Claiming is not scorer access and makes no personal-history promise. |
| Unconfirmed joining/acceptance | Explain uncertainty and retry the captured action. Do not convert edited input into a second operation while the original is unresolved. |
| Organiser invite | One invite code, Accept invite, then Open league only after a valid confirmed response. If the confirmed league has no usable direct link, offer Go to Home; do not call the accepted invite unconfirmed. No Pending league, repeated code, or invented expiry deadline. |
| Sign in | Sign in to 3FC; Email address; Send sign-in link. No organiser-only or unfinished-account paragraph. |
| Email request | Sending sign-in link… then Sign-in link sent to the submitted address. Network uncertainty tells the person to check their inbox before trying again. Older session checks cannot replace this feedback or redirect them. |
| Complete sign-in | Complete your sign-in; Sign-in starts in a few seconds. Or continue below. Same three-second completion and immediate manual action. Hide the initial promise while pending or after failure; one error and the appropriate retry/return action remain. |

The destination for account switching preserves only validated join/invite
fields, never the whole query string. No token, OAuth parameter, identity
inference, public result link or future portal destination is introduced.
