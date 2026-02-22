import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3001";

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Local App</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        padding: 2rem;
        background: #f5f7fb;
        color: #1c2430;
      }

      main {
        max-width: 50rem;
        margin: 0 auto;
      }

      h1 {
        margin-top: 0;
      }

      code {
        background: #e5eaf3;
        border-radius: 4px;
        padding: 0.15rem 0.35rem;
      }

      .card {
        background: white;
        border: 1px solid #d8deea;
        border-radius: 10px;
        padding: 1rem;
        margin-top: 1rem;
      }

      ul {
        margin: 0.5rem 0 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>3FC Local Development</h1>
      <p>
        Local app scaffold is running. API base URL: <code>${API_BASE_URL}</code>
      </p>

      <section class="card">
        <strong>Useful endpoints</strong>
        <ul>
          <li><code>${API_BASE_URL}/v1/health</code></li>
          <li><code>${API_BASE_URL}/v1/dev/items</code> (POST)</li>
          <li><code>${API_BASE_URL}/v1/dev/items/&lt;id&gt;</code> (GET)</li>
          <li><code>${API_BASE_URL}/v1/dev/send-email</code> (POST)</li>
        </ul>
      </section>
    </main>
  </body>
</html>`;

const server = createServer((request, response) => {
  if ((request.method ?? "GET") === "GET" && (request.url ?? "/") === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ok", service: "app" }));
    return;
  }

  if ((request.method ?? "GET") === "GET" && (request.url ?? "/") === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      service: "app",
      message: "App local server started",
      port: PORT,
      apiBaseUrl: API_BASE_URL,
    }),
  );
});
