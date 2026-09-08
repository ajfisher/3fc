# Authenticated reports and existing entry recovery

## Scope and dependency direction

UX-05 changes frontend presentation and ownership of existing requests. It adds
no API, schema, IAM, runtime dependency, session lifetime, permissions or public
read capability. Deployment workflow changes update the sign-in heading smoke
assertion only; route, versioned-asset and security checks remain.

Join and invite shells now load the existing versioned `auth-flow.js` before
`setup-flow.js` using ordered deferred scripts. The authentication script exposes
only its pure return-target normalizer, using the same renderer-supplied route
patterns as sign-in/callback. Its page initializers do nothing on entry routes.
The setup controller reconstructs permitted entry fields before applying this
normalizer and fails closed if it is unavailable. It never copies a complete
query string into account-switch navigation. This is an explicit frontend
dependency change, not a new authentication model or a second validator.

## Read authority and incomplete data

Match reports remain authenticated. Independently loaded team totals, outcome
and goal timeline are checked without throwing before presentation. A malformed
or absent response cannot become a draw, zero tally or valid empty log. Totals
must contain each existing team once and non-negative integer counts. A claimed
outcome must agree with the existing conceded/scored comparator; the frontend
does not invent a replacement winner. Valid totals can remain visible when the
log is unavailable, without fabricating contributions.

The timeline retains opaque historical identities. Contributions aggregate by
player ID, never nickname. Own goals add neither a team-scored nor player-goal
tally. Assists retain existing eligibility and bounds. The existing API owns all
durable arithmetic; separate reads are not described as an atomic snapshot.
Nonthrowing decoding also prevents malformed successful mutation payloads from
interrupting confirmed-create/edit draft settlement. Uncertain-operation retry
retains the parent PR's original body, key and expected-event target.

## Entry writes and account changes

A public join owns its normalized code, nickname, serialized body and
idempotency key synchronously. That ownership is retained in memory if browser
storage is blocked, and survives an uncertain response. An incomplete successful
payload is not proof that the request failed to commit. A confirmed registration
and its account claim are separate outcomes: claim retry never registers the
player again. A player ID in a query is not proof of registration or ownership;
the existing claim action remains explicit. No nickname deduplication or new
ownership-proof policy is introduced.

Invite acceptance is synchronously latched for the captured code. Existing
same-account replay and email restrictions are unchanged. Open league uses a
validated identity from the confirmed response. The contract has no invite
expiry field; the frontend invents none.

Sign-out still requires the existing confirmed HTTP204 before clearing auth
recovery state or navigating. Only validated entry context is retained for a
different account. Neither failed logout nor malformed success is called done.
Page-lifetime in-memory recovery is not an offline or reload guarantee.

Sign-in requests use a synchronous send latch and submission revision. Every
late session-probe path and its scheduled redirect yields to a newer submission,
including invalid input. Feedback names the captured recipient, not later
edited input. Errors use stable safe copy. Callback token capture/scrubbing,
three-second timer, manual-completion latch, bounded timeout and replay remain
unchanged; only explanatory copy changes by state.

## Review and rollback

High-risk review covers INV-001/002/003/005/006/008/009, the new script dependency,
request settlement, privacy, current actor boundaries and workflow assertions.
The evidence map is `docs/design/results-entry-review.md` and the versioned PR
packet. Reviewers inspect source and failure assertions independently and do
not run competing tests.

Rollback is a site redeployment of parent PR149 head
`b09ee27bb7c629e6a9cbcaa28e931d1729afbdb1`. No schema or backend migration is
required. Existing goals, registrations, accepted invites and sessions committed
before rollback remain durable; a visual rollback cannot reverse those writes.
