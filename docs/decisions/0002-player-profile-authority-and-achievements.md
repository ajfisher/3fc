# ADR 0002: Player profile authority and shared achievement definitions

- Status: Accepted
- Date: 2026-10-03
- Decider: AJ Fisher, approved player profile build plan

## Context

A league role authorises management, not changes to another person's account or
portrait. Existing self-service joins, invitations and claims already have their
own session-bound authority. Performance records need safe league-readable
contracts; account data needs a separate owner-only boundary. Missing derived
history must not be mistaken for confirmed zero statistics.

## Decision

Clarify INV-002 to require each operation's explicit authority. Owner name/photo
writes verify canonical ownership, independently of league management permission.
Retain existing documented join, invitation and claim authorities. Separate private
owner DTOs from performance DTOs (INV-001). League participation grants profile
read access only. Public sharing consists of exported performance images; live
public profile links are deferred.

Adopt one versioned source for all 23 badge definitions and milestone scales.
Represent incomplete/unavailable projections explicitly. Card selection retains
combined scope labels while the durable ledger retains every milestone. Derivation
uses canonical scoring facts, durable work delivery and revision-consistent
projections; detailed storage/worker contracts follow in their owning slices.

This first slice defines types, catalogue and pure presentation helpers. It adds
no route, permission implementation, storage, evaluator, or enabled feature.
Runtime schema validation and negative-authorisation tests are required with the
routes, and must not be inferred from TypeScript interfaces alone.

## Alternatives and consequences

An administrator-as-owner exception would violate the approved privacy boundary.
Using the directory's bounded game sample as complete career history would fabricate
totals and break streaks. Independent gallery rules would drift from awarded badges.
These alternatives are rejected. Separate projections introduce eventual consistency,
so freshness and coverage must be visible, and correction work must be durable.

## Reversal

This slice is unused by runtime consumers and can be reverted without data changes.
Later feature flags will isolate profiles, owner editing and achievements. Disabling
workers or exposure must preserve source records and unlock audit history.

## Evidence

- Invariants: INV-001, INV-002; existing scoring INV-005/006/008 remain unchanged.
- Approved brief: `docs/design/player-profile-brief.md`.
- Tests: `api/src/tests/achievement-contracts.test.ts` (catalogue, milestone and
  deterministic card selection boundaries).
- Delivery/issue map: `docs/design/player-profile-delivery.md`.
