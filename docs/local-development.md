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

Emails are persisted as newline-delimited JSON at:

- `local/fake-ses/emails.jsonl`

DynamoDB Local data persists under:

- `local/dynamodb/`
