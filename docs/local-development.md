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

### Magic-link auth flow (local)

Start flow (sends link to fake SES):

```bash
curl -s -X POST http://localhost:3001/v1/auth/magic/start \
  -H 'content-type: application/json' \
  -d '{"email":"player@example.com"}'

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
