# 3FC

Phone-first web application for managing and scoring Three Sided Football Club (3FC) matches.

## Purpose

This repository contains the product, technical, infrastructure, and delivery assets for the 3FC v0 build.

## Domain

- Primary domain: `https://3fc.football`
- Production app domain: `https://app.3fc.football`
- QA app domain: `https://qa.3fc.football`
- Production API domain: `https://api.3fc.football`
- QA API domain: `https://qa-api.3fc.football`
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
- `docs/openapi/`: OpenAPI definitions for implemented API surface
- `docs/local-development.md`: local stack usage and smoke checks
- `docs/dynamodb-single-table.md`: key schema and repository access patterns
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
- Core write endpoint contract reference: `docs/openapi/v1-core-write.yaml`.
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

Build and deploy examples:

```bash
make build
AWS_PROFILE=3fc-agent make deploy ENV=qa
AWS_PROFILE=3fc-agent make deploy ENV=prod
AWS_PROFILE=3fc-agent make deploy ENV=qa SERVICE=api-health
```

`make build` compiles workspace artifacts (`dist/` outputs) without deployment.

`make deploy ENV=<qa|prod> [SERVICE=<name>]` builds and deploys the selected Serverless endpoint service.

Serverless definitions live in `serverless.<service>.yml` (for example `serverless.api-health.yml`). This allows endpoint services to be split and deployed independently.

Serverless manages API/Lambda provisioning through CloudFormation stacks per service and stage.

Current API services:

- `api-health`: health route (`GET /v1/health`)
- `api-core`: authenticated core routes (`/v1/auth/session`, leagues/seasons/sessions/games write endpoints)

The deploy script requires `HTTP_API_ID` and `LAMBDA_EXECUTION_ROLE_ARN` and resolves them from env vars first, then from AWS by convention (`3fc-<env>-http-api`, `3fc-<env>-lambda-exec`). Infrastructure must be provisioned first.

Scale note: as endpoint count grows, keep adding discrete `serverless.<service>.yml` services and group deployments by domain area.

Delivery rule: local-only wiring is not sufficient. A backend feature is only considered complete when it has:

- a working local test path
- a wired live deployment path (Serverless service definition + CI deploy workflow coverage)

Run help:

```bash
make help
```

## CI/CD Workflows

- `.github/workflows/pr-checks.yml` runs lint, unit, and contracts checks on PRs.
- `.github/workflows/deploy-qa.yml` deploys to QA when a PR is labeled `QA-ready`.
- `.github/workflows/deploy-prod.yml` deploys to production on `main` pushes (with path filters).

Required GitHub repo configuration:

- Add secret `AWS_ROLE_TO_ASSUME_QA` using `terraform -chdir=infra/qa output -raw github_actions_deploy_role_arn`.
- Add secret `AWS_ROLE_TO_ASSUME_PROD` using `terraform -chdir=infra/prod output -raw github_actions_deploy_role_arn`.
- Configure branch protection on `main` to require `PR checks / merge-gate` before merge.

Notes:

- `github_actions_deploy_role_arn` is the CI deploy role (OIDC-assumable by GitHub Actions).
- `lambda_execution_role_arn` is the runtime role used by Lambda functions and should not be used as the GitHub secret.
- The GitHub OIDC provider is account-scoped and is created from `infra/qa`; run QA Terraform apply once before the first prod apply.
- The GitHub OIDC provider resource is lifecycle-protected (`prevent_destroy`) to avoid accidental auth breakage across environments.

## Domain Validation Checks

After Terraform apply in both environments, validate DNS and API routing:

```bash
curl -i https://qa-api.3fc.football/v1/health
curl -i https://api.3fc.football/v1/health
```

Expected result for both commands:

- HTTP `200` response
- JSON body from the health handler

## Social Auth Credentials (Local)

To enable Google social sign-in in Cognito, add local-only credentials per environment:

1. QA:
   - Copy `infra/qa/auth.auto.tfvars.example` to `infra/qa/auth.auto.tfvars`
   - Set `google_oauth_client_id` and `google_oauth_client_secret`
2. Prod:
   - Copy `infra/prod/auth.auto.tfvars.example` to `infra/prod/auth.auto.tfvars`
   - Set `google_oauth_client_id` and `google_oauth_client_secret`

`auth.auto.tfvars` files are gitignored and are loaded automatically by Terraform.
