# Player identity stack: acceptance and operational handoff

This is the delivery index for #162, not permission to merge or migrate production.
The canonical scope is [player-identity-delivery.md](player-identity-delivery.md).
Physical-device checks remain separate from desktop browser emulation.

## Feature evidence

| Issue / feature | PR and reviewed head | Falsifying evidence |
| --- | --- | --- |
| #158 specification/backlog | #163, `634a570bf7bfd4dfca71e0fe3bca3bdb225f34f8` | Canonical backlog validation/export; independent specification reviews; established issue IDs preserved |
| #138 proof-enforced claims/private linking | #164, `aa1a646c11f19855e66061f8aab9b4c6a9ea0fa3` | Arbitrary-ID denial; expiry/revoke/replace; exact account/revision confirmation; lost-response receipt recovery; local/Lambda proof suites and disposable acceptance |
| #159 directory/reusable registration | #166, `9e78e8348b2a684250d961d0518c09b4d411bd65` | Complete scoped pagination; claimed/unclaimed nickname search; duplicate prevention; historical alias references; migration interruption/coverage validation; isolated deployment |
| #160 consolidation | #167, `4ccb2de18d75c9ffaadac75354113986add2e076` | Same/different owner, explicit approval, overlap/cross-league denial, concurrent commits and unchanged goal/assist/roster/audit targets; actual DynamoDB transaction acceptance |
| #161 returning join | #168, `f6f3882b9f6e0094a2a78efd4f06a2dadde2bca5` | Zero/one/many, complete namespace pagination, frozen retry/account switch, original alias assignment,20×20 fanout, mixed-batch failure suppression; actual isolated browser/API acceptance |
| #162 cross-stack regression/handoff | Final child of #168 | Current proof-aware entry fixture, isolated M2, complete regression and operational checklist; final exact-head links recorded in PR packet |

Do not infer that feature-specific evidence at a parent SHA was rerun at a child
SHA. The final PR packet distinguishes fresh runs from inherited unchanged-code
evidence, and records its own CI, deployed SHA, review and browser acceptance.

## Published parent gates

All following parent gates were verified before beginning their children. No PR
was merged by the agent. An exact-head no-findings Codex completion is accepted
by AJ even where the gate's older parser displays the last formal review as stale.

| PR | CI / QA run | Exact-head Codex evidence | Acceptance |
| --- | --- | --- | --- |
| #164 | 34541923179 /34541923190 | comment5613875127 | Versioned proof review packet |
| #166 | 34558554914 /34558774778 | comment5629039309, summary5628255833 | comment5629153452; gate34559822349 |
| #167 | 34562614246 /34562771328 | comment5629552031, summary5629522681 | comment5629763338; gates34564668838/34564668977 |
| #168 | 34581843972 /34581843884 | no-findings5632113100, completed summary5630045547 | [acceptance5632094636](https://github.com/ajfisher/3fc/pull/168#issuecomment-5632094636), refreshed `review:ready` |

## Maximum identity fanout and resource evidence

The initial20-concurrent-stream discovery still timed out in the real isolated
Lambda. Request-local strong BatchGet prefetch, bounded retries/backoff and shared
failure suppression replaced it; this was not solved by increasing timeout or
memory. Final #168 measured20 canonical roots ×20 underlying profiles with420
original registrations:3748ms first-page AWS CLI round trip, then576/498/506ms
namespace continuations. Node20/arm64/256MiB/10-second timeout remained unchanged.
These are fixture observations, not a percentile SLA or every metadata fanout.

Its original migration evidence was preserved through code-only updates. After a
synthetic deletion correctly invalidated coverage, an audited reconciliation
verified840/840 records, zero issues and equal digest
`def82fbfd9a2d9d0d94f33d5807b0d26dcf90b7de35cd03c3a5fe8b3012141fc`.
All20 groups were created through preview, owner approval and commit. No direct
coverage flag editing or repeated mutation was used to manufacture acceptance.

Final #168 local validation passed493 API/636 app/3 operator/57 gate tests,
contracts, lint/typecheck, backlog and build. Real local HTTP/DynamoDB/browser
passed with512MiB Docker plus982928KiB process-group peak. Deployed acceptance
group26438 exited0,820480KiB peak, remaining[]. Its isolated function, table and
role were verified absent; temporary credentials were removed. Earlier #166 and
#167 isolated resources were likewise deleted and absence verified.

## Repeatable local acceptance

Build first. Run each command separately through the existing resource guard;
observe exit and children cleanup before the next. Do not run review-agent tests
in parallel. Reserve512MiB for Docker and cap the host group at3.5GiB when using
either disposable database runner.

- `node scripts/local/test-player-consolidation.mjs --browser`: actual proof,
  consolidation, canonical history, returning join and disabled-write checks.
- `node scripts/local/test-player-stack-m2.mjs`: a new in-memory Docker database,
  audited stopped-writer local migration, loopback-only API/app/fake-email and
  single-worker M2. No existing volume, AWS profile, QA account or email service.
- `THREEFC_SKIP_WEB_SERVER=1 npx playwright test tests/e2e/results-entry.spec.ts --workers=1`:
  production-built UI with strictly fictional transport. The route fixture serves
  its own HTML/assets; no listening app server is required. This is UI evidence,
  not proof of real backend authorization.

The M2 runner verifies actual loopback listener addresses, suppresses raw browser
errors and service output, and forwards only safe reporter status/source records.
Private fake emails and automatic browser diagnostics are removed with the exact
generated directory after all children close. Docker cleanup inventories the
exact UUID name even if creation returns an ambiguous failure. Missing cleanup,
abnormal memory or repeated unexplained stalls require investigation, not retry.

## Remaining physical checks

Not yet claimed: real iOS Safari and Android devices, mobile keyboards, returning
from a real email app, browser process eviction and account switching on-device.
Record device, OS/browser version, scenario, actual result and sanitized evidence.
Emulated widths/themes and keyboard tests do not satisfy these checks. #162 stays
open for any outstanding criteria; #25/#40 are not closed for unrelated work.

## Release decision checklist

1. AJ reviews the complete stack and separately authorizes merge/release and any
   production migration. Green gates are not authorization.
2. Follow [proof rollout](../runbooks/player-claim-proof.md),
   [membership cutover](../runbooks/player-identity-directory.md),
   [consolidation](../runbooks/player-consolidation.md) and
   [returning joins](../runbooks/returning-player-join.md) in that dependency order.
3. Inventory every writer and capture the exact deployed code hash/revision and
   flags. Keep consolidation and returning joins disabled until their prerequisites
   are verified. Shared QA at final #168 deliberately retained both false.
4. Complete the resumable inventory/backfill and controlled final write pause.
   Resolve missing profiles/inconsistent membership; never infer completeness from
   a partial scan. Record matched inventory/verification digests and audit phase.
5. Observe the real905-second old-writer drain where required, verify unchanged
   revision/provenance and enable only with explicit environment authorization.
   Local synthetic manifests are not production provenance. A later deletion or
   other coverage invalidation requires audited reconciliation before enablement.
6. Verify enabled exact-head behavior with disposable accounts and check cleanup.
   No real AJ profiles are mutation fixtures. No new Terraform resources are
   required; existing table IAM already includes BatchGetItem.
7. Containment disables new consolidation/returning joins while retaining proof
   enforcement, canonical/alias readers and revision-aware writers. Do not revert
   to alias-unaware code or delete a consolidation pointer as an undo operation.
   A mistaken consolidation needs a separately reviewed compensating operation.

Deferred: cross-league account discovery/import, nickname-based matching,
attendance, public results and player-performance aggregation. None are silently
completed by this stack.
