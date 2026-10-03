# Winter season production cutover

This is preparation, not approval to merge, pause services, disable workflows,
create backups, write production or reopen traffic. AJ approves the reviewed
tooling and separately authorises the maintenance window and exact import
manifest. Do not create the equivalent league manually first: this importer
preserves the selected league, season and player IDs itself and requires an
otherwise empty destination, apart from existing identity system records.

## Scope and ownership

The agreed scope is Melbourne 3FC / Winter 2026, excluding the incomplete 21 June
game, retaining only the two selected existing admin grants. A fresh plan includes
any subsequently added finished or unstarted scheduled games; a live game blocks.
AJ's canonical player is already owned by the requested Gmail account. Configure
an explicit ownership assertion to detect a later change. Historical profile IDs,
aliases, rosters and events survive; bearer join codes rotate. QA auth sessions,
invitations, proof tokens and replay receipts do not migrate.

The private configuration extends [the rehearsal configuration](season-import-rehearsal.md):

```json
{
  "profile": "3fc-agent",
  "accountId": "123456789012",
  "scope": {
    "leagueId": "reviewed-league-id",
    "seasonId": "reviewed-season-id",
    "excludedGameIds": ["reviewed-excluded-game-id"],
    "adminEmails": ["organiser@example.invalid"],
    "adminPlayerIds": ["reviewed-second-admin-root"],
    "ownershipMappings": [{
      "playerId": "reviewed-organiser-root",
      "expectedOwner": "observed-magic-link-subject",
      "toEmail": "organiser@example.invalid"
    }]
  },
  "reviewedPlan": "https://github.com/ajfisher/3fc/pull/REVIEWED_NUMBER",
  "qaDeployment": "/private/operator/accepted-qa-api-manifest.json",
  "prodDeployment": "/private/operator/accepted-prod-api-manifest.json",
  "exclusiveWriterFreeze": true,
  "backups": {
    "qa": "verified-source-backup-arn",
    "prod": "verified-destination-backup-arn"
  }
}
```

Values above are placeholders. Private input files must be regular files with
mode 0600; output directories must be new and are created with mode 0700. Retain
the source backup, approved manifest, configs and all reports securely outside
the checkout. Never publish profiles, email/account identifiers or join codes.
The manifest includes the complete selected data and pre-import system baseline.

## Approved maintenance window

1. Complete review of this tooling and the disposable rehearsal, then merge only
   with AJ's authority. Run from a clean checkout at the approved tooling commit.
   Obtain the unmodified accepted QA and production API deployment manifests.
   Their runtime sources (`api`, `packages/contracts`, lockfile) must match this
   checkout, and their code hashes, revisions and player feature flags must match
   both live functions. Production must have returning-player discovery enabled
   and both environments must enforce claim proofs.
   If not, stop for a separately reviewed compatible deployment. Do not edit a
   manifest to match an arbitrary live Lambda.
2. Obtain AJ's execution-window approval. Inventory every writer: both core APIs,
   manual AWS/CLI jobs, old local services, migrations, aliases/versioned invokes,
   scheduled services and deployments. Exclude every competing writer for the
   whole window, including recovery. `exclusiveWriterFreeze` is a real operator
   attestation, not proof discovered by the CLI. The CLI checks the known core
   functions, aliases, event mappings and workflows; it cannot prove there are
   no independent writers or detect an unobserved temporary unfreeze.
3. Record the original reserved concurrency and workflow states. Disable both
   `deploy-qa.yml` and `deploy-prod.yml`; drain all queued/running/waiting runs.
   Set both `3fc-qa-api-core` and `3fc-prod-api-core` reserved concurrency to zero.
   This takes both APIs offline, including sign-in and reads. The frontend may
   remain visible but API operations will be unavailable. Keep production
   unpublished as the active league space until acceptance completes.
4. Run the read-only `observe` command below. It checks both disabled workflows,
   no pending deployment runs, concurrency zero, exact accepted Lambda revisions,
   no aliases/event mappings, and physical table IDs. Wait at least **905 seconds
   after this observation** for the longest possible old invocation to drain.
   If any writer or deployment was enabled during that interval, restart the
   observation and drain. No tool here changes concurrency or workflow state.
5. Create on-demand backups of **both** drained tables. Wait for AVAILABLE and
   record their ARNs in the config. The CLI checks table ARN and physical ID,
   USER backup type and creation time after the drain. PITR alone is not the
   capture evidence for this operation. Preserve backup restore access.
6. Run read-only `prepare`. It captures fresh source data twice, builds the
   selected plan, and checks the destination contains only its verified identity
   control and old migration audits. Auth sessions or new business records also
   block this narrow importer. Do not delete them to force it through; revisit
   collision scope. Inspect the manifest's IDs, account bindings, retained game
   list, counts, exclusions and before/after records. Obtain AJ's approval for
   this exact manifest digest before `apply`.
7. Run `apply` under the process-group guard with the approved digest. It checks
   provenance, backup evidence and source reproduction before writing, then
   checks the freeze before every transaction and inventory verification. It
   refreshes the built repository from matching source for acceptance. No other
   runner may overlap it. Keep ownership of its session through actual exit.
8. Require an `accepted` durable audit and successful private report. Verify
   counts, ownership and both grants. The tool leaves **both APIs at zero** and
   both workflows disabled even on success. It does not send login emails.
9. With AJ's cutover/reopening approval, restore production concurrency to its
   recorded setting and perform actual Gmail/Xavier sign-in, player discovery,
   league access, historical results and season-statistics checks. New join codes
   replace QA links. Avoid real-player test writes. If a check fails, close
   production again and investigate; do not retry an accepted import after new
   production writes. Keep QA as the preserved source and avoid split editing.
10. Only after sign-in/acceptance succeeds, make production the primary space.
    Restore QA/deployment availability according to the approved plan and their
    recorded prior state, not a blanket enable command. Keep manifests, reports
    and backups for the agreed recovery period.

## Commands

Run these separately from the repository root, under the repository's owned
process-group guard (4 GiB ceiling). No command is an instruction to execute now.
Use a different new output directory for every invocation, including retries.

```sh
node scripts/season-import-production.mjs observe \
  --config /private/operator/config.json \
  --out /private/operator/new-observation

node scripts/season-import-production.mjs prepare \
  --config /private/operator/config.json \
  --observation /private/operator/new-observation/observation.json \
  --out /private/operator/new-preparation

node scripts/season-import-production.mjs apply \
  --config /private/operator/config.json \
  --manifest /private/operator/new-preparation/manifest.json \
  --approved-digest EXACT_APPROVED_SHA256_DIGEST \
  --apply production-season-import \
  --out /private/operator/new-execution
```

`observe` and `prepare` only read AWS/GitHub and write private local artifacts.
`apply` can write only `3fc-prod-app` through this CLI. The shared transaction
engine also accepts a strictly named disposable table for rehearsal; the
production CLI has no configurable target, skip-check or force option. It does
not alter IAM, deploy code, create/delete tables, restore backups or remove rows.

## Atomic progress and recovery

The manifest pins tooling commit, scope hash, source plan, backups, observation,
physical tables and deployed fingerprints. Begin conditionally replaces the
existing identity control with paused/unknown coverage and creates a unique
`SEASON_IMPORT#<nonce>/AUDIT`. Old production migration audits remain byte-for-byte
intact. Every chunk contains at most 23 new rows plus the paused-control check
and audit compare-and-swap. Imported keys must be absent; chunks are size-bounded
and commit their checkpoint atomically. Different runs cannot steal control.

Before resuming, the actual full inventory must equal the original baseline,
the committed prefix, current control and audit. A missing, changed or extra row
blocks. A lost transaction response is safely retried by rerunning **the same
manifest**: DynamoDB's checkpoint, not a local log, determines the next row.
Never regenerate join codes, edit the manifest, unfreeze writers or deploy
between an interruption and a resume. Recheck that the original process and
children are gone before restarting. The 905-second observation stays applicable
only while the operator maintains uninterrupted writer exclusion.

Once every row matches, control and the audit become fenced/verified atomically.
This certification is safe only because the destination was otherwise empty,
the planner validates the entire graph and all imported rows exactly match.
Read-only repository acceptance then tests games, history, aliases, directory,
both grants, claim discovery and explicit account bindings. Only after those
checks and a final inventory comparison does the audit become `accepted`.
This still does not reopen either API. If acceptance fails, retain the external
freeze and resume the same verified manifest after diagnosing the bounded cause.

No automatic rollback deletes player data. Before reopening, an abandoned or
unexpectedly changed import remains offline for investigation. Backups restore
to a **new table**, not in place: verify a restored table, then separately review
and authorise the application table switch/deployment. Recovery may take longer
than the planned window. Do not clear control, delete a checkpoint, change its
digest or re-enable the API to escape a failure. After production receives new
writes, rollback may lose those writes and requires a new recovery decision.

## Architecture and validation limits

This adds an operator data-ownership path, not a runtime endpoint. It uses existing
AWS/GitHub operator privileges; no new runtime dependency, IAM or deploy workflow
is introduced. INV-001 is protected by private artifacts/redacted output; INV-002
by preserving exactly the selected existing grants; INV-004 by complete graph
validation, conditional writes and exact inventory; INV-005/006/008 by unchanged
event history and existing arithmetic checks. API auth remains unchanged.

The disposable rehearsal exercises this exact transaction engine, including a
lost committed response and resume, plus real repository reads. Unit tests cover
interruption at every transaction, collision atomicity, changed control/data,
freeze loss, failed acceptance and bad approvals/backups. It does **not** exercise
production maintenance, restore a backup, send magic links or prove final browser
sign-in. These remain explicit operational acceptance steps during the approved
window. Passing CI/review is not permission to execute them.
