# Player profile consolidation

## Enablement and scope

Consolidation is disabled by default. Set `PLAYER_CONSOLIDATION_ENABLED=true`
only for an explicitly selected environment after the directory migration has
verified complete membership and all writers/readers are identity-aware.
The local Compose service and QA/production deployment workflows pass this flag;
the GitHub environment variable defaults to false. No new Terraform resource is
required. The existing table and transaction permissions are used.

For local acceptance, enable the flag for the disposable local API. For deployed
acceptance, use a disposable tagged table/function with synthetic profiles and a
reviewed, fingerprint-pinned directory migration. Do not combine AJ's profiles
as test data. Production enablement and migration require AJ's separate approval.

## Normal operation

1. An organiser selects distinct profiles in League Players and prepares a
   proposal. Inspect every underlying profile and game, not just search matches.
2. Choose the retained name and identity. If a selected identity is claimed,
   retain a claimed identity belonging to the same account.
3. Where ownership would expand, send the nonsecret proposal URL privately to
   that player. Only their authenticated account can approve the exact proposal;
   opening the URL or signing in is not approval.
   Proposals expire after 24 hours; an expired proposal requires a new preview
   and fresh approval of its exact current contents.
4. The initiating organiser checks the approved proposal and explicitly combines
   it. Membership, authority, coverage and identity revisions are checked again.
5. Preserve the resulting proposal/audit identifiers for support. A lost-response
   retry uses the same proposal, never a newly guessed replacement.

Preview, approval and commit do not edit game events. Old games continue to use
their original registered IDs, while views resolve the retained name/ownership.
Future registrations use the canonical identity. Do not manually rewrite goals,
assists, corrections, roster assignments or registration records.

## Conflicts and incomplete evidence

Different account owners, shared games (including Unassigned registrations),
foreign-league history, incomplete membership coverage and more than 20 underlying
profiles are blocking conditions. There is no override. A changed or expired
proposal requires a fresh review and, where applicable, fresh owner approval.
Do not infer that similar nicknames identify the same person.

## Containment and rollback

Set `PLAYER_CONSOLIDATION_ENABLED=false` and deploy the same alias-aware version
to stop new previews, approvals and commits. Existing committed proposals remain
readable and their committed outcome recoverable. Existing aliases remain active.
Disabling the feature is not an undo operation.

After the first consolidation, **never deploy alias-unaware readers or writers**.
Restoring an old app/API version or deleting a redirect can split identity,
misattribute account ownership and create duplicate game registrations.

## Mistaken consolidation: checked compensating operation

No general undo endpoint or user-interface action is supplied. Before any
compensation, stop new identity writes in an authorised maintenance window and
inventory the exact proposal/audit, all underlying aliases, account ownership,
all league/game membership and subsequent identity operations completely.
Compare original snapshots with current revisions. Identify later registrations,
claims, invitations and later combinations that depend on the retained group.

Prepare a specific reviewed transaction/migration preserving every historical
event target and authoritative account owner. Architecture, security and QA must
review the intended before/after mapping and proof that no concurrent writer can
bypass it. Obtain AJ's explicit approval before executing against production.
If evidence is incomplete or later activity makes the correction ambiguous, leave
the group intact and investigate; do not delete a pointer as an attempted fix.

Record actor, reason, original proposal/digest, inspected revisions, exact affected
records, tested failure/retry behaviour and resulting audit. Re-verify coverage
before reopening writes. Preserve alias-aware rollback throughout.
