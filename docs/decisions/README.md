# Architecture decision records

Use an architecture decision record (ADR) when a change:

- introduces a durable system component
- changes data ownership or a public contract
- creates a cross-service dependency
- changes a system invariant
- moves responsibility for failure, retries, or reconciliation
- changes a permission or trust boundary
- introduces an operational choice that is expensive to reverse

Routine implementation details do not require an ADR. Copy `template.md`, assign
the next available three-digit number, and name the file
`NNN-short-decision-name.md`. Link the ADR from the pull request review packet.

Statuses are `proposed`, `accepted`, `superseded`, or `rejected`. A superseded ADR
must link to its replacement rather than being rewritten.
