# 3FC

Phone-first web application for managing and scoring Three Sided Football Club (3FC) matches.

## Purpose

This repository contains the product, technical, infrastructure, and delivery assets for the 3FC v0 build.

## Domain

- Primary domain: `https://3fc.football`
- Production app domain: `https://app.3fc.football`
- QA app domain: `https://qa.3fc.football`
- Public game URLs should resolve under the production app domain using `/{league}/{season}/{game}` paths.

Primary source docs:

- `docs/product.md`: product brief, UX flows, and game rules
- `docs/spec.md`: high-level technical architecture and platform constraints
- `docs/backlog/backlog.json`: canonical implementation backlog (M0-M4)

## Current Status

The project is in the delivery setup phase:

- Milestone backlog is defined and ready to seed into GitHub issues.
- Infrastructure skeleton exists under `infra/`.
- Monorepo runtime bootstrap is in place for `app`, `api`, and shared contracts.

## Architecture Direction (v0)

- Frontend: Astro + Web Components (mobile-first)
- API: AWS API Gateway HTTP API + Lambda (Node.js/TypeScript)
- Data: DynamoDB single-table
- Auth: Cognito (Google/Facebook) + magic-link flow
- Notifications: SES
- Infra: Terraform (AWS-first)

## Repository Layout

- `app/`: frontend package scaffold (TypeScript)
- `api/`: backend package scaffold (TypeScript)
- `packages/contracts/`: shared TypeScript contracts and core domain types
- `infra/`: Terraform modules and environment wrappers (`qa`, `prod`)
- `docs/`: product, spec, and backlog artifacts
- `docs/local-development.md`: local stack usage and smoke checks
- `scripts/github/`: backlog validation/export/sync helpers

## Tooling Requirements

- Node.js `>=22.0.0`
- npm `>=10.0.0`

## Local Setup

```bash
make install
make build
make test
```

These run against npm workspaces at the repository root.

## Local Stack (Docker Compose)

Start the full local stack (app + api + DynamoDB Local + fake SES):

```bash
make dev
```

Stop it:

```bash
make dev-down
```

Detailed local stack smoke tests are documented in:

- `docs/local-development.md`

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

`Makefile` provides working install/build/test targets for the npm workspace, backlog automation targets, and deploy env guardrails.

Deploy examples:

```bash
make deploy ENV=qa
make deploy ENV=qa DEPLOY=1 AWS_PROFILE=3fc-agent
make deploy ENV=prod DEPLOY=1 AWS_PROFILE=3fc-agent
```

`make deploy` prepares a versioned application bundle, Lambda zip, and manifest under `out/deploy/<env>/`.

Set `DEPLOY=1` to upload the Lambda artifact and update function code via AWS CLI (infrastructure remains Terraform-managed).

Run help:

```bash
make help
```
