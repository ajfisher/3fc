# 3FC

Phone-first web application for managing and scoring Three Sided Football Club (3FC) matches.

## Purpose

This repository contains the product, technical, infrastructure, and delivery assets for the 3FC v0 build.

## Domain

- Production web domain: `https://3fc.football`
- Public game URLs should resolve under this domain using `/{league}/{season}/{game}` paths.

Primary source docs:

- `docs/product.md`: product brief, UX flows, and game rules
- `docs/spec.md`: high-level technical architecture and platform constraints
- `docs/backlog/backlog.json`: canonical implementation backlog (M0-M4)

## Current Status

The project is in the delivery setup phase:

- Milestone backlog is defined and ready to seed into GitHub issues.
- Infrastructure skeleton exists under `infra/`.
- `app/` and `api/` runtime implementation is still to be built.

## Architecture Direction (v0)

- Frontend: Astro + Web Components (mobile-first)
- API: AWS API Gateway HTTP API + Lambda (Node.js/TypeScript)
- Data: DynamoDB single-table
- Auth: Cognito (Google/Facebook) + magic-link flow
- Notifications: SES
- Infra: Terraform (AWS-first)

## Repository Layout

- `app/`: frontend application (to be implemented)
- `api/`: backend application (to be implemented)
- `infra/`: Terraform modules and environment wrappers (`qa`, `prod`)
- `docs/`: product, spec, and backlog artifacts
- `scripts/github/`: backlog validation/export/sync helpers

## Workflow Conventions

- Branching:
  - Never commit directly to `main`.
  - Use short-lived branches.
  - Use `codex/<topic>` for agent-driven branches.
- Commits:
  - Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, etc).
  - Keep commits scoped and logically grouped.
- PRs:
  - Open PRs against `main`.
  - Include summary, risk notes, and validation steps in PR description.

## Delivery Conventions

- API contracts must be explicit and validated.
- Write endpoints should support idempotency keys where specified.
- Security defaults must prioritize httpOnly cookies, CSP, and least privilege.
- Public pages must not expose player email addresses.
- Mobile-first UX and low-friction scorekeeper workflows are the default.

## Backlog Commands

```bash
make backlog-validate
make backlog-export
make backlog-sync-dry REPO=<owner/repo>
make backlog-sync REPO=<owner/repo>
```

Notes:

- `backlog.json` is the source of truth.
- `backlog.md` is generated; do not hand-edit it.
- `backlog-sync` creates labels, milestones, epics, and child issues in GitHub.

## Make Targets

`Makefile` includes placeholders for future build/test/deploy automation and currently provides working backlog targets plus deploy env guardrails.

Run help:

```bash
make help
```
