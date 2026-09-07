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

Authentication completion copy and timers are unchanged. Later feature slices
own navigation, human dates, entry-flow and match-specific language refinement.

## Organiser shell (UX-02)

| Surface/state | Reviewed treatment |
| --- | --- |
| Home | Neutral “Welcome”; “Leagues” first; “Create a new league” below the existing list. No email-local-part name guess or speculative cross-league game summary. |
| Empty league list | “No leagues to show.” Only after the authorised list responds, with the creation form opened once without stealing focus. |
| League/season navigation | Home plus actual league/season names. On phones, omit the duplicate breadcrumb Home from display/tab order and visually hide its non-interactive current item; the H1 supplies the full name. Season retains its real parent link. Full breadcrumbs remain on desktop. Generic League/Season only while loading, never an opaque route ID as the heading. |
| Management actions | Visible Create season, Invite organiser and Create game verbs; Delete under More after confirmed organiser access. No management controls while authority is unknown. |
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
