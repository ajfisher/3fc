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
