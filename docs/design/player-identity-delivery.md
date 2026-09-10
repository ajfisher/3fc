# Reusable players, profile linking and claim recovery

Approved by AJ on 2026-09-10. This document activates previously deferred
ownership-proof work, but does not authorise a merge, production migration or
release. Canonical issue scope remains in `docs/backlog/backlog.json`.

## Product contract

Create a player once, reuse them across games, and link their account later.
An account, player identity, game registration and league permission are distinct.
No nickname matching, account search, cross-league discovery or permission grant
is implied by playing, claiming or combining profiles.

League Players lists claimed and unclaimed identities. Season/game entry defaults
to that season with an explicit All league players alternative. Search includes
retained former nicknames; equal names remain distinct identities. Show relevant
game/season participation, never private emails or raw account identifiers.
Organisers may create a league player without a game. Existing scorer permission
to add/assign game players remains; directory management, invitations and combining
are organiser-only.

Keep Search this game as a roster filter. Add player opens the reusable picker:
search, choose a player, then Unassigned or a team. Already-present identities
cannot be registered twice. Create new player is explicit and warns of possible
name matches without treating them as identity proof. Preserve existing finished
game rules, including the deliberate join/claim exception without team-edit access.

## Claims and private invitations

An organiser can Invite to link profile from existing unclaimed game-player menus
in PR1; it must not depend on the future league directory. Opening the panel does
not create a secret. Create private link generates a seven-day invitation. Show
Copy link, Replace link, Revoke link and Close, with focus restoration and exact
copy: “Anyone with this link can link this player to their account. Share it privately.”
Replacement invalidates the former invitation. Closing preserves an unfinished
operation; clipboard failure leaves a selectable link, not a false success.

Recipient heading: Link your player profile. Show verified player and league,
and the signed-in account's email privately beside confirmation, with Sign out
available to switch accounts before linking. After authentication require
Link this player to my account. No GET, preview,
sign-in completion or fresh registration auto-claims. Existing ownership is
preserved; same-owner retries are safe. Another owner produces neutral organiser
recovery, not a promise that changing accounts fixes it.

Use a browser-generated cryptographic 256-bit secret and random proof identifier.
Persist the pending secret in tab sessionStorage before dispatch; send only its
SHA-256 verifier when creating registration proof or an organiser invitation.
Both fresh-registration proofs and organiser invitations use a persisted seven-day
expiry; physical DynamoDB TTL deletion is never the expiry check.
Creation idempotency binds the verifier and returns metadata, never the secret:
the current generic idempotency store persists response bodies verbatim. Fresh
registration creates player, registration and proof metadata in one transaction.
Never mint new proof for an existing registration merely from a name or known ID.

The private link carries its secret in a fragment. Capture and immediately scrub
the fragment before loading other page work; use no-store/no-referrer and existing
frame protections. Neither logs, telemetry, callback URLs nor QA evidence contain
secrets. Proof acceptance sends the secret only in a redacted request body.

Same-tab sign-in uses sessionStorage. Same-origin new-tab returns may recover the
exact pending proof through a bounded two-second BroadcastChannel exchange with
a fresh correlation nonce while the original tab is open; no localStorage secret
fallback. Version and validate message schemas, allow one outstanding exchange,
and reject mismatched/late replies. This channel is transport, not authentication;
all same-origin listeners can observe responses. Load verified preview from the
server, never from transmitted nickname/account data. Auth return contains only
a non-secret proof identifier. Logout purges active-tab copies and stops handoff
responses; this is not invitation revocation and frozen tabs may miss broadcasts.
Cancel/fence exchanges and close listeners on logout/pagehide; recheck the session
on pageshow and require explicit current-account confirmation. Unsupported
storage/channel or a closed original tab fails closed: reopen the original private
link after sign-in, or obtain a fresh organiser invitation for a lost registration
proof. Do not claim seamless cross-browser transfer from an email auth link.

Acceptance atomically checks persisted expiry, unused/replay state and profile
revision. Organiser invitations additionally check the issuer's still-current ACL;
fresh-registration proofs instead check their exact original player/registration
binding (they have no issuing organiser). Consumption and ownership/user-index
recording are one transaction. Same-account lost-response replay returns committed success
without transferring ownership. Expired/revoked/replaced proofs cannot create a
new claim. Preview supplies an opaque account/session confirmation binding;
acceptance must carry it and the server compares it against the authenticated
account/session, rejecting a cookie switch even after a successful client probe.
A changed account requires renewed confirmation, never attribution to the new
cookie's owner. Issuing/accepting invitations never changes league ACL.

Replace every proofless first-claim path in both local and Lambda adapters. An old
client may register without proof but cannot claim without it; show actionable
recovery. New clients against an older API detect missing proof support and leave
the joined record unclaimed rather than retrying the unsafe endpoint. Rollback
can disable new invitations, never re-enable proofless claiming.

## Canonical identity and membership

Player profiles are global today. Introduce bounded, cycle-free canonical roots
and aliases while retaining original game, roster, event, correction and audit
IDs. Add canonical identity metadata; do not change historical playerId semantics.
New registrations use the root; old-game edits map a canonical selection to that
game's unique original registration. Existing scoring and winner computations
are unchanged, including own-goal and assist attribution.

Maintain league-directory, season membership and reverse game/league references
in the existing DynamoDB table. Normal search uses paginated scoped queries, not
the existing single-page global scan. Every identity/membership writer, including
join/create/link, alias requests, claim, consolidation and relevant game/season/
league deletion, participates in root revision fencing or marks coverage unsafe.
Read all pages; empty filtered pages with a continuation are not completion.

Before consolidation, complete and verify a resumable audited backfill over
registrations and roster references. Report missing profiles/inconsistent records
without repairing or guessing names. Write-capable migration tools require explicit
environment/table provenance and a reviewed plan; production execution is separate
authority. Use a controlled identity/membership write pause for final cutover,
drain old writers, reconcile, then enable fenced writers. Missing/unknown migration
coverage blocks consolidation. New flags default closed.

## Combining profiles

League organisers select profiles and preview Combine profiles. Show all alias
members, claim status, affected games, retained identity/name and blocking reasons.
Retain a claimed identity when present; if several share one owner, explicitly
choose the survivor. The resulting closure is at most 20 underlying profiles.

Check the entire closure, not just selected roots. Block different account owners,
any shared-game registration (including Unassigned), any external-league use,
incomplete coverage, and any revision change since preview. Do not reveal the
external league or offer an override. Consolidations into a claimed root require
that owner's explicit approval of the exact proposal and revisions before commit;
even same-owner additions do not expand history silently. Proposal approval is
bound to the existing owner, not transferable by a general bearer invitation.

Commit root/alias state, ownership-index reconciliation, proposal consumption,
audit before/after and idempotent result atomically. Every concurrent registration,
claim and consolidation checks/updates the root revision, including old alias
requests. Do not partially apply oversized transactions or flatten only part of
a group. Membership changing after approval invalidates that approval.

Keep historical records intact. A mistaken consolidation requires a checked
compensating operation, not raw redirect deletion. Once aliases exist, rollback
must retain compatible readers/writers; disabling new consolidations is safe,
reverting to an alias-unaware binary is not. A player may later reuse their owned
identity elsewhere, making it ineligible for further league-only consolidation.

## Returning-player joining

Use only the signed-in account's linked identities in the destination league.
One identity offers Join as {name}; several require selection. Repeat registration
returns existing membership/team unchanged. No identity offers a directed private
invitation or explicit new player creation, not a public unclaimed-player picker.
When no invitation is present, explain Ask the organiser for a profile link;
do not add an unimplemented invitation-request button.
Anonymous creation remains; its proof survives supported sign-in continuity.
No cross-league import, public performance or participation-home work is included.

## Stack and delivery gates

Delivery epic: [#157](https://github.com/ajfisher/3fc/issues/157).

| PR | Branch | Issue | Outcome |
| --- | --- | --- | --- |
| 0 | codex/player-identity-backlog | #158 | Canonical scope, issues, acceptance and migration boundaries |
| 1 | codex/player-claim-proof | #138 | Proof-enforced claims and usable private invitations |
| 2 | codex/league-player-directory | #159 / related #25 | Canonical compatibility, backfill, directory and game reuse |
| 3 | codex/player-consolidation | #160 | Preview, conflicts, owner approval and atomic consolidation |
| 4 | codex/returning-player-join | #161 / related #40 | Existing linked-player registration |
| 5 | codex/player-identity-acceptance | #162 | Full regression, deployed acceptance and runbook |

First base is main; each child targets its predecessor. Complete local independent
review, serial validation, versioned packet, exact-head Codex review, CI, isolated
QA acceptance and review:ready before implementing a child. AJ accepts a verified
exact-head no-findings completion comment; do not call it a formal approval.
Fixes/rebases require renewed affected evidence. Documentation PR0 deploys the
unchanged application and records that limitation, not future-feature acceptance.

Architecture/security reviews are mandatory for backend, proof, contracts,
migration and ownership. Dedicated design/frontend and engineering/QA reviewers
remain read-only and launch no test workers. Root collates every finding and
evidence-dispositions disagreements. Production resources/IAM are not planned;
any necessity receives explicit review before code. No merges or releases.

## Acceptance matrix

| Area | Falsifying evidence required |
| --- | --- |
| Proof | Arbitrary ID fails in local/Lambda; committed join response loss; same-key changed verifier; no stored/logged secret; explicit confirmation only |
| Invitations | Expiry/revoke/replace/issuer demotion races; same-owner replay; account switch; same/new-tab and missing-storage recovery; no token URLs in evidence |
| Directory | Later pages/empty filtered page; equal names; claimed/unclaimed; season/all league scopes; inaccessible league; stale picker and duplicate registration |
| Migration | Paginated fake and DynamoDB Local; interrupted resume; missing references; deletion; drained old writer; coverage failure blocks enablement |
| Consolidation | Alias-closure cross-league/overlap; same/different owners; stale approval; merge-vs-join/claim/delete; transaction rollback; max group and cycle rejection |
| History | Raw event/roster/audit IDs unchanged; goal/assist/own-goal, corrections and expected-event undo unchanged after combining |
| Returning join | Zero/one/many identities; lost response; existing team preserved; finished join exception; alias/account changes |
| UI | 320/390/430, tablet/desktop, themes, zoom, long names; keyboard/focus/SVG actions; truthful pending/error/recovery and secret-free captures |
| Delivery | Local/Lambda/contracts/Serverless parity; exact-head CI/QA/Codex/gate; disposable records and cleanup; no production mutation |

Run focused tests, affected suites, then full API/app/contracts/security/build and
browser coverage serially under the 4 GiB full-process-group guard. Observe actual
exit and cleanup before advancing. Physical iOS/Android checks are tracked apart
from emulated browsers and never claimed without execution.

## PR0 independent review disposition

Architecture/security, design/frontend and engineering/QA independently reviewed
this specification and canonical issue scope without editing code or running tests.
Accepted findings: hash-only replay rather than secret-bearing idempotency results;
explicit confirmation for every claim; realistic same-browser handoff with closed-
tab recovery; distinct fresh-registration and organiser proof eligibility; server
account/session binding; deletion-inclusive membership fencing; paginated database
evidence; existing finished-game joining. These are requirements for later feature
tests, not claims that the implementation exists. Both blocking review ambiguities
(proof expiry/type and cookie-switch binding) were corrected and re-reviewed.

No design or production dependency was added. PR0 changes only this specification
and canonical/generated backlog files. Reverting its documents cannot revert GHI
edits: reconcile linked issues explicitly and preserve established IDs. Later
feature rollback rules above do not describe a migration performed by PR0.
