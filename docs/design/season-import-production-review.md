# Selective production import preparation evidence

Follow-up to the rehearsal foundation in PR #195. This adds conditional account
bindings, a production cutover CLI and a resumable shared transaction engine.
It does not execute a production cutover or change runtime/deployment source.

## October 3 rehearsal

The live QA canonical AJ profile already belongs to the requested Gmail account.
The old conversational attribution to another address was incorrect. The private
scope now asserts the exact observed owner and requested destination email;
the planner records one verified binding and zero ownership transfers. No source
profile was edited. A separate mapping regression proves actual transfers move
all claimed group members and claim indexes without changing historical IDs.

The real Winter rehearsal used the production transaction engine in a new owned
disposable DynamoDB table. It dropped the successful response of the third write
transaction, restarted the engine with the same manifest, verified committed
state and completed without duplicates. Repository acceptance then passed:

- 11 games and sessions, including the scheduled 4 October game; 21 June excluded.
- 141 goal events; 128 historical profiles resolving to 49 canonical players.
- Both selected existing administrator grants, no extra grants.
- Both claimed accounts discover their canonical player, including the explicitly
  asserted organiser account. Existing Gmail ownership required no transfer.
- All 1,611 planned rows validated; existing synthetic destination migration
  audit preserved and a separate cutover checkpoint added.
- Final durable phase `accepted`; production full hashes unchanged.
- Disposable table deleted and disappearance verified.

Private plan digest:
`29282c575053af742d9f4d1c4e9af22f0ac4b2c1429ed7bfc947ee99f40ef9fb`.
Source digest:
`275076b663bf85924a03c226320b1838084a677a37794870ab570f0c65a01673`.
Temporary table `3fc-import-rehearsal-9878a0c4-a7b8-4000-a4a9-225d9123c552`
is deleted. Guarded rehearsal exited 0, peak process-group RSS 164,240 KiB,
no remaining children. Fresh forced API build exited 0, peak 449,824 KiB.

## Failure and acceptance evidence

The focused test file has 25 passing tests; the complete serial operator suite
has 39 passing tests (exit 0, with no surviving worker processes). New cases exercise:

- Expected-owner mismatch, alias-vs-root rejection, already claimed transfer
  destination, conflicting group owners, unchanged assertions and source immutability.
- Lost successful responses at every transaction boundary: begin, every batch,
  coverage activation and acceptance; repeat success performs no new writes.
- Mid-batch collision with no partial transaction or checkpoint advancement.
- Changed control, altered imported row and unexpected extra destination row
  blocking resume without overwrites.
- Freeze loss before writes; failed repository acceptance retaining a resumable
  verified checkpoint while the operational freeze remains mandatory.
- Tampered manifest, competing manifest, explicit approval options, physical
  backup-table identity, backup availability, completed 905-second drain and accepted Lambda
  revisions/account/endpoint/feature settings.

The live plan initially rejected a no-op ownership assertion because the same
account also owned unrelated QA test profiles. The transfer collision guard was
too broad for unchanged ownership; it now permits an assertion while retaining
the collision rejection for an actual transfer. The specific regression, full
focused file, fresh plan and disposable rehearsal passed after the fix. No table
was created by that failed planning attempt.

## Architecture, risks and operational boundary

See [the cutover runbook](../runbooks/season-import-production.md) for the complete
approval, writer exclusion, backup, drain, certification and recovery protocol.
The operator path now owns production writes during an explicitly approved freeze.
The application still owns ordinary league/player/game writes afterwards. Runtime
auth, dependencies, IAM and deployment workflows are unchanged.

Production input guards use accepted Lambda artifacts, physical table identity,
both disabled deployment workflows, zero core-API concurrency, drained runs,
source reproduction and post-drain backups. Other/manual/versioned writers and
continuous freeze ownership require operator inventory and attestation; the CLI
cannot discover every possible writer or prove an unobserved temporary unfreeze.

The control/audit are atomically updated with imported chunks. Existing audits
survive. Exact inventory verification precedes certification and follows
repository acceptance. Final success does not reopen traffic. No automated
destructive rollback exists: same-manifest resume is tested; an abandoned import
requires separately authorised backup restoration into a new table and deployment
switch. Recovery after new production writes needs a new data-loss decision.

INV-001/002/004/005/006/008 are affected as described in the runbook. INV-009 remains
unchanged. No invariant definition or public API contract is altered.

This rehearsal is not a production maintenance exercise, backup restoration,
live sign-in/email test or browser acceptance. No production execution manifest
with invented freeze times or backup evidence has been created. Actual Gmail
and Xavier sign-in checks remain required during the approved cutover.
