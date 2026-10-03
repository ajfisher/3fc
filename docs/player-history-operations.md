# Player history infrastructure and deployment

Player history uses a separate Serverless service, `player-history`. Terraform owns
the existing table's stream, the work queue, two failure queues, IAM roles and
CloudWatch alarms. Serverless owns the two functions and their event-source mappings.
There is no HTTP endpoint for dispatching or running history work.

The worker can read and condition-check only the player, game, league, history,
identity-control and tombstone partition families used by its source adapters.
It can put records only in `PLAYER_HISTORY#*`, `PLAYER_PROFILE_WORK#*` and `LEAGUE#*`; it has no DynamoDB
delete, update or scan permission. Both grants require `dynamodb:LeadingKeys` to
be present. The league grant is deliberately documented as a residual boundary:
jobs, sweeps and acknowledgements share league partitions with authoritative
records, and DynamoDB IAM cannot restrict this grant by sort key. Runtime
transaction construction must still keep writes within history-owned sort keys;
IAM does not make the entire `LEAGUE#*` partition exclusive to history.

## Provision before application deployment

The reviewed QA account is `301691475109`, region `ap-southeast-2`, CLI profile
`3fc-agent`. QA identity coverage was verified in fenced mode before this slice;
operators must check its current state again before backfill or activation.

Review a local Terraform plan for `infra/qa` before applying it. GitHub workflows
do not run Terraform. The expected additions are three SQS queues, dedicated
dispatcher/worker roles and policies, alarms, and a `NEW_IMAGE` stream on the
existing `3fc-qa-app` table. There must be no table replacement, deletion or new
public storage. Changes to shared deployment-role permissions must be reviewed too.

```sh
AWS_PROFILE=3fc-agent aws sts get-caller-identity --query Account --output text
AWS_PROFILE=3fc-agent terraform -chdir=infra/qa plan -out=/tmp/3fc-history-qa.tfplan
# After reviewing the saved plan:
AWS_PROFILE=3fc-agent terraform -chdir=infra/qa apply /tmp/3fc-history-qa.tfplan
AWS_PROFILE=3fc-agent terraform -chdir=infra/qa output player_history_stream_arn
AWS_PROFILE=3fc-agent terraform -chdir=infra/qa output player_history_queue_url
```

Keep Terraform plans local: they may contain unrelated provider configuration or
sensitive inputs. Provisioning the stream and queues does not activate consumers.
Production has its own `infra/prod` prerequisite and requires AJ's release decision;
a QA plan or successful PR gate is not authority to apply or deploy production.

## Deploy with processing disabled

Both deploy workflows place the compatible worker service before the API writer deployment,
inside their existing serialized environment job. The deployment fails if the
stream, queues or dedicated roles have not been provisioned. The deploy script
checks the reviewed AWS account; `EXPECTED_AWS_ACCOUNT_ID` permits an explicitly
reviewed alternative account. Infrastructure discovery is read-only.

`HISTORY_PROCESSING_ENABLED` defaults to `false`. That value controls both runtime
configuration and both event-source mappings. The corresponding GitHub environment
variable must remain false until activation is approved. Example local QA deploy:

```sh
AWS_PROFILE=3fc-agent HISTORY_PROCESSING_ENABLED=false make deploy ENV=qa SERVICE=player-history
```

Both functions run Node.js 22 and use shared unreserved Lambda capacity. The QA
account currently has a concurrency quota of 10 and an unreserved minimum of 10,
so it cannot allocate reserved concurrency to these functions. The SQS mapping
limits worker concurrency to two. Stream parallelisation is one batch per shard;
this does not impose a global dispatcher concurrency limit. Other functions share
the same account capacity and may contend with history processing. Check current
account capacity, API latency and Lambda throttling before activation, and monitor
them alongside queue age after activation. This change neither increases the
account quota nor reserves or changes production capacity.

Deployment captures `out/deploy/qa/player-history-deploy-manifest.json` (or `prod`).
The manifest contains the exact commit, both local ZIP hashes, live function
revision IDs, selected nonsecret configuration, queue settings and mapping IDs and
states. It does not capture the complete Lambda environment or source records.
The final workflow check re-reads AWS and rejects changed packages, roles, source
scope, concurrency, filters, mappings, queue settings or processing state.

```sh
AWS_PROFILE=3fc-agent node scripts/deploy/verify-player-history.mjs qa <reviewed-full-head-sha>
```

## Delivery, recovery and activation

The stream dispatcher admits three event classes: work inserts, job inserts/updates,
and league directory revision inserts/updates. Directory events must have partition
key `LEAGUE#*`, sort key `PLAYER_DIRECTORY` and type `playerDirectoryRevision`.
They schedule reconciliation when the eligible player directory changes, including
players added after an earlier sweep completed. The runtime validates scope and each
job's scheduling state, and sends only versioned league/key references to SQS. Never
forward or log a raw stream image. The dispatcher uses stream sequence numbers for
partial failures; the queue worker uses SQS message IDs.

The work queue retains messages for four days, with six-minute visibility for a
60-second worker and redrive after five receives. Both failure queues retain
messages for fourteen days. The dispatcher retries a failing stream record three
times, with a one-hour maximum record age, then sends failure metadata to its own
failure queue. Neither transport retention nor successful delivery proves work is
complete. Durable work/job records are the recovery authority.

Disabled mappings do not consume records. Streams have a finite retention window;
after a delayed activation or outage, use the bounded recovery runner to enumerate
durable pending work for the intended league. Do not rely only on replaying the
stream or DLQ, and do not remove an obligation merely because it was sent to SQS.
Backfill must retain checkpoints and verify source coverage; sending messages must
never mark a league complete. Local processing uses the same bounded service as
Lambda against local DynamoDB; it does not need an HTTP management route.

Before enabling processing, verify the current API writer fingerprint and drain old
writers, confirm identity coverage, establish resumable backfill/recovery evidence,
and check both function/mapping fingerprints. Enable QA processing only under the
reviewed activation procedure. Profiles and achievements remain behind their own
exposure flags until derived coverage and totals have been checked. Keep scoring
available while processing is disabled or failed.

The Terraform alarms expose worker/dispatcher DLQ depth, function errors, stream
iterator age and queue age. They have no
invented notification recipient; attach the team's approved alarm destination
before activation. Inspect generation/job coverage and lag alongside queue metrics:
an empty queue alone does not demonstrate complete history.

Rollback disables processing mappings and feature exposure, preserving source,
pending obligations and generation/unlock audit history. Reverting to old writers
requires disabling profile/achievement exposure first because those writers do not
maintain the source-revision guarantee. Never purge queues, history rows or awards
as a rollback shortcut.

## Bounded operator and local commands

The shared runner is [scripts/player-history.mjs](../scripts/player-history.mjs).
Run it from the repository root. Every invocation builds API and contract project
references before loading the same coordinator used by Lambda. Autonomous runs must
have one owned process group and the agreed 4 GiB memory guard around the entire
command; do not overlap the build/runner with other tests or builds.

Every command requires a JSON activation manifest with this shape. Substitute the
actual accepted writer commit, reviewed issue/PR and recorded drain time:

```json
{
  "version": 1,
  "writerVersion": 1,
  "writerSha": "<full-40-character-accepted-writer-sha>",
  "tableName": "3fc-qa-app",
  "accountId": "301691475109",
  "region": "ap-southeast-2",
  "reviewedPlan": "https://github.com/ajfisher/3fc/issues/200",
  "drainedAt": "<recorded-UTC-drain-time>",
  "ruleVersion": 1
}
```

For cloud operations, use an unchanged tracked checkout at that SHA, including no
untracked runtime/operator source. Supply the accepted **API core** deployment
manifest with `--deployment-manifest` and the accepted history worker deployment
manifest with `--worker-manifest`. The CLI verifies account, table, live writer code
and revision, and requires the drain time to be at least 905 seconds after the live
writer's last deployment. It verifies live worker packages, configuration and
transport against the worker manifest as well; both manifests must describe the
same accepted commit and environment. It repeats full deployment checks at the start and end of every invocation,
and rechecks the API at least every 30 seconds between bounded steps. A final
drift check failure prevents the invocation being treated as accepted.

Cloud mutation commands also require the environment's deployment workflow to have
been manually disabled and all pending runs drained. This temporary deployment
freeze requires the operator's approval; the runner never changes workflow state.
Restore the prior workflow state only after the approved maintenance operation.
Normal scoring is not disabled by these commands.

The following helper only supplies file/profile arguments; it performs no work
until called. Replace the example file paths with reviewed local evidence:

```sh
history_qa() {
  node scripts/player-history.mjs "$@" \
    --manifest /path/to/history-activation.json \
    --deployment-manifest /path/to/api-core-deploy-manifest.json \
    --worker-manifest /path/to/player-history-deploy-manifest.json \
    --profile 3fc-agent
}

# Read one status/pending-marker page; this does not mutate DynamoDB.
history_qa status --league '<league-id>'

# Activate deployment readiness only; this does not publish totals or enable mappings.
history_qa activate --apply reviewed-history

# Start a league rebuild, returning a durable work reference.
history_qa backfill --league '<league-id>' --apply reviewed-history

# Advance that returned reference by at most ten checkpoints, then inspect done.
history_qa step --league '<league-id>' --kind work \
  --key 'HISTORY_WORK#<returned-revision>' --pages 10 --apply reviewed-history

# Enumerate one page of pending player jobs; retain the returned cursor.
history_qa recover --league '<league-id>' --kind player --apply reviewed-history
history_qa recover --league '<league-id>' --kind player \
  --cursor '<returned-cursor>' --apply reviewed-history

# After repairing a failed player's source, explicitly create/reuse its retry job.
history_qa recover --league '<league-id>' --player '<player-id>' --apply reviewed-history
history_qa step --league '<league-id>' --kind player \
  --key 'HISTORY_JOB#<returned-hash>' --pages 10 --apply reviewed-history

# Derive a comparison without replacing the published generation.
history_qa dry-run --league '<league-id>' --player '<player-id>' \
  --pages 10 --apply reviewed-history
history_qa dry-run --league '<league-id>' --comparison '<returned-comparison-id>' \
  --pages 10 --apply reviewed-history
```

`--pages` is limited to 1–100 for `step` and `dry-run`; stopping at the limit is not
completion. Resume the same returned reference/comparison ID. Recovery enumeration
does not enqueue or execute its references: step each reference or deliver it through
the reviewed queue workflow. A failed job remains failed until its source changes or
explicit player recovery is requested. Restart a comparison if its source changes.

Dry-run is a **non-publishing derivation**, not a read-only operation: it writes
immutable staging/checkpoint and comparison records, so it also requires the apply
acknowledgement. Its result compares totals, achievement counts, timing uncertainty,
streaks and highest milestones for the career summary. It does not claim comparison
of every season or every earlier milestone. It retains the existing active publication.

For local development, supply a manifest whose `tableName` matches the local table
and replace the cloud flags with `--local-table`. This mode uses only
`http://127.0.0.1:8000` and explicit local credentials; cloud profile/deployment flags
cannot be combined with it. Local identity coverage must already be fenced/verified
before activation. For example, after reviewing the local manifest:

```sh
node scripts/player-history.mjs activate --manifest /path/to/local-history.json \
  --local-table threefc_local --apply reviewed-history
node scripts/player-history.mjs backfill --manifest /path/to/local-history.json \
  --local-table threefc_local --league '<league-id>' --apply reviewed-history
node scripts/player-history.mjs step --manifest /path/to/local-history.json \
  --local-table threefc_local --league '<league-id>' --kind work \
  --key 'HISTORY_WORK#<returned-revision>' --pages 10 --apply reviewed-history
```

## Owner name propagation

Name saves require owner editing and processing enabled in the API, plus activated
history readiness. The existing worker performs bounded directory updates. Its
queue messages contain only a player hash and immutable work key. Current canonical
ownership is checked by the save service; operator recovery is not an owner API.
Exact committed requests can replay their receipt while processing is paused,
after rechecking current canonical ownership. Deploy compatible worker code and
stream filters before enabling the API producer; the shared workflows enforce this
order so an old filter cannot skip a new work record.

Use the same guarded `history_qa` wrapper and reviewed manifests above:

```sh
history_qa profile-status --player '<player-id>'
history_qa profile-status --player '<player-id>' --cursor '<returned-cursor>'
history_qa profile-step --player '<player-id>' --key 'NAME#<returned-uuid>' \
  --pages 10 --apply reviewed-history
```

Status remains readable with processing paused. Follow every continuation, even
when a page has no pending jobs. Resume the same work key after a failed delivery;
checkpoint and directory writes are atomic. Completed or superseded work is a
no-op. `profile-step` is limited to1–100 steps and retains the cloud deployment
freeze/provenance checks. Local development uses the same commands with
`--manifest /path/to/local-history.json --local-table threefc_local` instead of
the cloud wrapper, after local activation. It never requires a production queue.

Monitor the worker/DLQ alarms for failed propagation. Disable owner editing or
processing to stop new saves, preserve pending jobs, repair the source/permissions,
then resume. Disabling achievements alone does not stop name work.

### Portrait maintenance

The same guarded runner supports `profile-status --player <id> --kind media` and
`--kind retirement` with an optional continuation cursor. Filtered pages may be
empty while still having a cursor. `profile-step --player <id> --key MEDIA#<uuid>`
(or `RETIRE#<uuid>`) uses the same `--apply reviewed-history`, manifest, exact-code,
account/table and deployment-freeze requirements as name work. Each invocation
processes only its bounded `--pages` allowance; a lease delay is printed and ends
that invocation without sleeping or renewing the original upload lease. Cloud
storage uses the bucket validated in the worker deployment manifest. Local work
requires `PORTRAIT_LOCAL_DIRECTORY` pointing outside the application's static root.

Do not manually delete an active object. Replacement/removal immediately updates
visibility and atomically schedules cleanup. Failed or abandoned uploads retain
work; expiry claims deletion before touching storage so a late finaliser cannot
publish a missing object. Queue/DLQ failures and media503 responses require
investigation, not deleting rows or replaying old successful requests as new saves.
Keep cleanup records and receipts across rollback; disable owner exposure or pause
processing to isolate failures. Consolidation cleanup keeps the retained identity's
portrait and retires former root objects through its durable retirement job.
