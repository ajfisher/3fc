# Action surfaces and mutation ownership

UX-07 replaces the original More/Manage action accordions after AJ's QA feedback.
It is a frontend presentation and interaction change, not new deletion or
promotion authority. The base is PR #145 at
`6f0085d1417d17415fe69af864e0f4cec3fabd66`.

## Component boundary

The shared server primitive and client renderer produce an entity-labelled
native kebab button and a labelled group of native actions. They do not claim
ARIA menu semantics or require a separate arrow-key navigation model. The local
Iconify/Lucide allowlist supplies `ellipsis-vertical`; no dependency or remote
asset is introduced.

The controller owns one open action surface, keyboard focus and viewport
positioning. The surface stays in its original DOM ancestry so delegated
handlers, row identity and hidden authority ancestors still apply. Native
popover support provides the top layer; fixed positioning is the fallback.
Opening does not participate in row layout. Informational and form disclosures
are not action surfaces and retain their existing behaviour.

## State and trust boundaries

Opening and closing do not mutate domain data. Existing scoped entity handlers
still own confirmation, server authorization, pending writes, uncertainty and
confirmed refresh. Closing the action surface transfers local focus ownership
to its trigger; it must not erase the operation's ability to recover focus after
a committed deletion or steal focus after a later independent user interaction.

List redraws preserve a surviving focused entity/control, not an obsolete DOM
node. Pending deletion is entity-owned across redraw. Confirmed-deleted IDs
continue filtering stale list responses. Player promotion remains
verified-administrator-only and league-wide; public roster data does not prove
claim status or grant permissions. Unknown authority closes action surfaces.

INV-001 (identity privacy), INV-002 (permissions), INV-003 (request ownership),
INV-004 (scoped identities) and INV-009 (browser security) are affected only at
the existing presentation boundary. API contracts, durable records, auth,
scoring and own-goal semantics remain unchanged.

## Failure and rollback

Cancelled confirmation makes no request. Failed or unconfirmed actions preserve
their existing recovery feedback; closing a popup must not be presented as a
successful mutation. Finished-game deletion remains disabled with its reason
inside the surface. Restricted actors cannot gain access through a hidden
trigger or synthetic nested click.

Rollback is redeployment of the validated parent frontend. No backend, schema,
dependency, configuration or data migration needs reversing. A UI rollback
does not undo a committed deletion or promotion. No rollback deployment is
claimed; compatibility is checked through existing contracts and tests.
