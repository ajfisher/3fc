# Selective season import rehearsal

This operator tool plans a QA season import and rehearses it in a new disposable
DynamoDB table. It has **no production apply mode**. AJ's approval of a rehearsal
does not authorise a production import, deployment, merge, or authentication
ownership change.

The initial scope is Melbourne 3FC's Winter 2026 season, preserving IDs and
excluding `game-20260621-1000-16b1` (21 June). Only AJ's requested Gmail admin
grant and Xavier's existing admin grant are retained. The private configuration
identifies accounts; no real emails, player IDs, source records, or bearer codes
belong in committed evidence. A selected claimed player can identify an existing
admin grant without reverse-mapping a magic-link subject to an email. This does
not create access for somebody who lacks a source admin grant.

Finished games and unstarted scheduled games can be retained; a live game blocks
planning. A scheduled game must have no goal events, saved result or started
thirds. Re-enumerate the season for every plan: upcoming games can be added after
the initial inventory.

## Architecture and data selection

`scripts/season-import-plan.mjs` is an offline planner. It owns no clients or
writes. `scripts/season-import-rehearsal.mjs` is an operator-only CLI; it is not
exposed by an API, deploy workflow or app. It uses the operator's explicit AWS
profile in the expected account and `ap-southeast-2` region. Its shared source
and destination table names are fixed to `3fc-qa-app` and `3fc-prod-app`. All
business writes target a freshly created random `3fc-import-rehearsal-<UUID>`
table; the CLI accepts no write target argument and refuses existing-table reuse.

Selection includes the league, both season addressing records, owned team
templates, retained game sessions and mirrors, session-to-game indexes, complete
historical game records, goal events and correction/audit history. Profiles and
identity sidecars are closed over every referenced original ID and canonical
member. Excluding a game does not erase an original player ID still needed by a
retained consolidated identity. Profiles used only by excluded games are omitted
unless this identity dependency requires them.

Some old sessions have only legacy season-owned rows. After validating the
league-scoped season and its global season mirror, the planner reconstructs
missing scoped session rows and session mirrors from those owned records. A
global date-based session mirror may instead belong to an unrelated QA season;
that foreign row is excluded and Winter's own mirror is reconstructed only in
the empty destination. Conflicting owned dates, malformed addresses or ambiguous
ownership fail closed. The source mirror is never changed.

Historical player IDs, roster keys, timestamps, event IDs, identity roots and
former names remain intact. Player names never serve as deduplication keys.
Player memberships and league directories are rebuilt from the retained
registrations/rosters, removing links to excluded games. Active directory rows
refer to canonical roots; aliases remain inactive. Claim indexes are rebuilt
from the canonical profile owner, with fresh claim and directory revisions.
An identity with memberships outside the selected and explicitly excluded games
blocks planning. Claimed profiles currently require magic-link account subjects.

Each configured admin must resolve to an existing source admin grant. Email
selection prefers an exact magic-link subject grant, falling back to its exact
legacy email grant. Claimed-player selection uses the selected canonical
profile's current owner. Exactly two distinct grants survive. Grant history and
historical actors on games remain historical attribution, not additional access.

The planner rotates game join codes and creates their matching lookup records.
It excludes authentication records (including raw `AUTH_SESSION#` records whose
entity type is also `session`), claim proofs, invitation pointers/codes and
registration/request replay receipts. It does not copy QA identity control,
migration certification, pending consolidation proposals or their operational
receipts. The effects of completed consolidations survive in preserved identity
sidecars; goal correction history is retained. This is not a complete forensic
archive of QA's administrative operations.

The new table starts with fresh paused/unknown identity control. Only after the
complete imported inventory matches the plan and validates does the rehearsal
activate a fresh fenced/verified control **in that disposable table**. Production
retains its own control and migration history. A real production import would
need its own reviewed pause, source freeze, certification and rollback protocol;
this temporary control activation is not that protocol.

These operations cross a durable-state ownership boundary and are high risk as
tooling despite their restricted target. Relevant invariants are INV-001 (private
data), INV-002 (exact admin scope), INV-004 (complete IDs and index relationships),
INV-005/006/008 (goals, results, assists) and INV-009 (authentication state stays
environment-local). No production runtime, public API, IAM policy, infrastructure
definition or dependency is changed.

## Private configuration and planning

Use an owner-only configuration file outside the checkout:

```json
{
  "profile": "3fc-agent",
  "accountId": "123456789012",
  "scope": {
    "leagueId": "reviewed-league-id",
    "seasonId": "reviewed-season-id",
    "excludedGameIds": ["reviewed-excluded-game-id"],
    "adminEmails": ["organiser@example.invalid"],
    "adminPlayerIds": ["reviewed-claimed-canonical-player-id"]
  }
}
```

The two admin references can instead both be explicit emails. A repeated account,
unclaimed profile, alias instead of a canonical root, or missing admin grant is
a blocking error. Player ownership is preserved independently of administrator
access: granting an account admin access does not transfer a claimed player.

From the repository root, under the normal process-group resource guard:

```sh
node scripts/season-import-rehearsal.mjs plan \
  --config /private/operator/config.json \
  --out /private/operator/new-plan-directory
```

The output directory must not exist. It is created with mode 0700 and files with
mode 0600; existing or symlinked inputs are rejected. `plan.json` is private and
contains selected source data plus regenerated join codes. Only `report.json`
is suitable for redacted review evidence. The report contains counts and hashes,
not player names, emails, login material or join codes.

Planning reads two consistent, fully paginated inventories of business records
and requires matching hashes. This detects intervening changes but **does not
provide snapshot isolation**. Rehearsal is not evidence that a live cutover can
omit a source editing freeze or a point-in-time export. Production must still
contain only its identity control/migration records; other data blocks this
empty-destination plan rather than assuming it is safe to overwrite.

## Execute only the disposable rehearsal

Build the API/contracts at the recorded source revision before acceptance. Run
the focused tests serially; do not overlap build/test/rehearsal processes. Apply
the default 4 GiB full process-group memory ceiling and the repository's resource
safety rules, preserving each process/session ID through confirmed termination.

```sh
node node_modules/typescript/bin/tsc --build api/tsconfig.json --force
node --test --test-concurrency=1 scripts/tests/season-import.test.mjs
node scripts/season-import-rehearsal.mjs rehearse \
  --config /private/operator/config.json \
  --plan /private/operator/new-plan-directory/plan.json \
  --out /private/operator/new-rehearsal-directory \
  --apply disposable-table-only
```

Before CreateTable, the CLI re-reads QA, checks the plan digest, and independently
reconstructs every planned row from the current source and configured scope.
Imports use bounded conditional transactions and stop at the first failed batch.
After import, an exact full-inventory hash comparison detects missing, extra or
altered records. Independent relational checks cover roster registrations,
canonical registration uniqueness, goal players, assists, goal markers, own-goal
arithmetic, saved team totals and saved winners.

The built repository then exercises season game discovery, registrations,
rosters, goals, join lookup, every original-profile alias resolution, directory
pagination, both admin grants, and returning-player discovery for claimed roots.
Its client accepts reads and conditions-only transactions against the temporary
table, rejecting all mutations and other tables. A final inventory comparison
proves those reads did not modify the imported data. This is repository/database
acceptance, not browser acceptance, a sign-in/email test, or proof of the exact
deployed Lambda package. Record the checkout SHA and deployed package hashes
separately; final production acceptance still requires actual sign-in checks.

## Cleanup, failure and later production work

Ownership intent is saved before CreateTable. The physical table ID, exact ARN,
name and unique owner tag must match before cleanup. The same owned table is
deleted after success or failure, and disappearance is polled to confirmation.
An uncertain CreateTable response is investigated using that unique name/tag,
not assumed to mean that no resource exists. A cleanup failure is reported and
requires operator investigation; never delete another table to make a rerun work.
SIGINT/SIGTERM request cleanup. SIGKILL or host failure cannot run a finally block:
recover the exact resource from the private ownership files and verify its tag,
physical ID and ARN before authorising cleanup. Do not blindly rerun a failed
process while it or its children might still exist.

Production is read and hashed before and after; changes or failed verification
make the run fail. The runner never overwrites or rolls back production. Private
plan/report files remain for the operator; retain securely for the approved
retention period and remove when no longer needed. Real QA data briefly exists
in the temporary table; it has no app endpoint or shared Lambda attached.

After a successful rehearsal, prepare a separate reviewed production execution
plan covering the final game selection and account ownership, a fresh stable
export, backup evidence, maintenance window, competing writers, conditional
checkpoints, interrupted-import recovery, production control recertification,
deployment compatibility and actual sign-in acceptance. A rehearsal or green PR
does not authorise that execution or any merge/release.
