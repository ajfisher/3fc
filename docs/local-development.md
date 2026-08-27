# Local Development Stack

This project provides a Docker Compose stack for local runtime and service stubs.

## Services

- `app`: Local frontend scaffold server on `http://localhost:3000`
- `api`: Local API server on `http://localhost:3001`
- `dynamodb`: DynamoDB Local on `http://localhost:8000`
- `fake-ses`: local email sink on `http://localhost:4025`

## Start and Stop

```bash
make dev
```

In a second terminal, to stop services:

```bash
make dev-down
```

## Smoke Checks

### Health checks

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3001/v1/health
curl -s http://localhost:4025/health
```

### UI component showcase

The app includes a foundation showcase route that renders the reusable setup
shell and all placeholder components on one page:

```bash
open http://localhost:3000/ui/components
```

Useful for manual visual review and automation smoke checks (Playwright/DevTools MCP).

### DynamoDB write/read via API

```bash
curl -s -X POST http://localhost:3001/v1/dev/items \
  -H 'content-type: application/json' \
  -d '{"id":"demo-1","value":{"hello":"world"}}'

curl -s http://localhost:3001/v1/dev/items/demo-1
```

### Fake SES email capture

```bash
curl -s -X POST http://localhost:3001/v1/dev/send-email \
  -H 'content-type: application/json' \
  -d '{"to":"player@example.com","subject":"Test","body":"hello"}'

curl -s http://localhost:4025/messages
```

### M2 browser smoke

The M2 Playwright smoke runs the real browser flow against the local stack:
magic-link sign-in, league/season/game setup, player creation and assignment,
goal scoring, third completion, and game finish.

First-time setup may need Docker images and the Playwright Chromium runtime:

```bash
docker compose pull
npx playwright install chromium
```

```bash
npm run smoke:m2:playwright
```

By default the Playwright config starts `make dev` and waits for the app health
endpoint. To run against an already-started local stack:

```bash
THREEFC_SKIP_WEB_SERVER=1 npm run smoke:m2:playwright
```

Useful overrides:

- `PLAYWRIGHT_BASE_URL`: app URL, default `http://localhost:3000`
- `THREEFC_API_BASE_URL`: API URL, default `http://localhost:3001`
- `THREEFC_FAKE_SES_BASE_URL`: fake SES URL, default `http://localhost:4025`
- `THREEFC_WEB_SERVER_COMMAND`: command Playwright uses to start the stack, default `make dev`

If `PLAYWRIGHT_BASE_URL` points anywhere other than the default app origin, make
sure the API is started with matching `APP_BASE_URL` and `CORS_ALLOWED_ORIGINS`
values, and that the app is started with the matching `API_BASE_URL`.

### Magic-link auth flow (local)

Start flow (sends link to fake SES):

```bash
curl -s -X POST http://localhost:3001/v1/auth/magic/start \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:3000' \
  -d '{"email":"player@example.com","timeZone":"Australia/Melbourne"}'

curl -s http://localhost:4025/messages
```

Take the `token=...` query value from the latest fake SES message body, then complete:

```bash
curl -s -X POST http://localhost:3001/v1/auth/magic/complete \
  -H 'content-type: application/json' \
  -d '{"token":"<copied-token>"}'
```

Emails are persisted as newline-delimited JSON at:

- `local/fake-ses/emails.jsonl`

DynamoDB Local data persists under:

- `local/dynamodb/`
