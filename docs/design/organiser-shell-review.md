# UX-02 organiser shell review

Scope: #133. This slice implements Home, league and season organisation using
the reviewed foundation and sign-out parent. Match, roster, scoring and entry
composition remain the next separately gated slices. No future player portal,
performance destination or public-result route is advertised.

## Independent review and dispositions

| Review | Finding | Disposition |
| --- | --- | --- |
| Architecture / engineering | Authority cannot be inferred from creator identity or a player claim. | Home remains one authorised list read; league access controls management presentation; season has one bounded parent read. Missing/failed access never grants controls. Existing server checks remain authoritative. |
| Architecture / retry | A game conflict can follow a committed game write during team initialisation. | Keep the original captured game request/key after that conflict; a transaction-aware interaction fixture commits before returning 409 and proves retry does not create another game/session. |
| QA / engineering | A stale refresh can reinsert a deleted row or replace a newer result. | Confirmed-deleted IDs filter later reads; monotonic list render versions reject older responses. Deferred refresh tests exercise both management lists. |
| QA / accessibility | Deletion and full-row redraw could lose keyboard focus. | Logical next/previous/heading focus only while the action owns it; moving outside relinquishes ownership. Synchronous redraw preserves the currently focused surviving row link, More summary or action, including More's open state. Eight node-replacement regressions cover both lists; independent re-review closed the finding. |
| Design / content | Removing email restrictions conceals a material consequence. | Keep “Only this email address can accept.” beside direct email invitation, without restoring routine permission narration. |
| Design / mobile | Repeated long breadcrumb names overwhelm the small-screen header. | Home remains once in shared navigation; hide its duplicate from display and tab order on phones. Retain the real parent link on season, the full H1 and noninteractive current breadcrumb semantics. Full breadcrumbs remain on desktop. |
| Browser / root | The expanded finished-game action reason squeezed the primary date column at 320px. | Give expanded actions and their reason a full-width row on phones; do not shrink or clip names/dates to accommodate them. The browser asserts primary reading width as well as page overflow and target size. |
| Design / enlarged text | Short status words fragmented and icons shrank despite passing page-overflow checks. | Protect whole status labels/icons; list composition uses available container width, including enlarged-text reflow. Browser range assertions catch multi-line status words and icon distortion. |

## Acceptance mapping

- `ui-layout.test.ts`: semantic native forms, real navigation, optional reference
  details, reviewed copy, initially unavailable management and no fabricated
  empty result before loading.
- `setup-flow-e2e.test.ts`: authorisation presentation, scoped/legacy reads,
  scoped-only writes, static/dynamic parity, native submission and SVG-child
  latching, retained drafts and captured request keys/payloads, lazy invitations,
  human dates and asynchronous deletion/focus behavior.
- `server.test.ts`: rendered Home title, routes, assets and security headers.
- `tests/e2e/organiser-shell.spec.ts`: production-built assets with fictional
  local request fixtures, five widths and two themes, keyboard forms, touch
  geometry, real hidden-state checks, access variants, empty/delayed/failure
  states, native submission and exact read bounds. No AJ data or live mutation.
- Deployment smoke assertions use the matching `3FC Home` title; route, asset
  version, auth and security probes remain unchanged.

The CSS zoom case is only a deterministic reflow proxy, not proof of physical
browser zoom or iOS/Android behavior. Device acceptance remains in #137.
Exact-head local/CI/QA/Codex results are recorded in the versioned PR packet.

Independent final design re-review closed the enlarged-text finding on the
fresh render: complete status labels/icons, readable cards/dates/actions and
visible form focus. Architecture and QA re-reviews report no remaining material
findings in this slice. Physical-device results are still separate acceptance.

## Failure and rollback

See [organiser shell architecture](../architecture/organiser-shell.md). Failed or
uncertain creation keeps its original attempt; a 204 deletion remains committed
even when list refresh fails. No automated destructive retry is introduced.
Reverting the site and its matching smoke assertions to the validated parent
needs no API migration or data rollback. A UI rollback cannot undo completed
creations or deletions. No actual rollback deployment is claimed.
