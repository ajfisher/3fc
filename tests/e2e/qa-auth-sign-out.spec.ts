import { expect, test, type BrowserContext, type Page, type Request, type Route } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DeleteItemCommand, DescribeTableCommand, DynamoDBClient, GetItemCommand,
  QueryCommand, TransactWriteItemsCommand,
  type AttributeValue, type GetItemCommandOutput, type QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { MagicLinkService, magicLinkSubjectForEmail } from "../../api/dist/auth/magic-link.js";

// Explicit opt-in only. No email is sent, no AJ session is loaded, no games/ACLs
// are created or touched by the sign-out test. The separately opted-in refresh
// test below creates only its conditional UUID-owned graph. Neither sends email.
const enabled = process.env.THREEFC_QA_LOGOUT === "1";
const site = "https://qa.3fc.football";
const api = "https://qa-api.3fc.football";
const tableName = "3fc-qa-app";
test.use({ trace: "off", screenshot: "off", video: "off" });

type Fingerprint = { functionName: string; codeSha256: string; revisionId: string; lastUpdateStatus: string };
type QaRun = { head_sha: string; conclusion: string; status: string; name: string; repository: { full_name: string } };
type DeploymentManifest = { env: string; service: string; gitCommit: string; packageCodeSha256: string; functionFingerprint: Fingerprint };

function assertApiProvenance(head: string, run: QaRun, manifest: DeploymentManifest, live: Fingerprint) {
  if (run.repository?.full_name !== "ajfisher/3fc" || run.name !== "Deploy QA" || run.head_sha !== head || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("QA deployment run is not successful at the expected head");
  }
  if (manifest.env !== "qa" || manifest.service !== "api-core" || manifest.gitCommit !== head || manifest.functionFingerprint?.functionName !== "3fc-qa-api-core") {
    throw new Error("QA API deployment artifact does not identify the expected head and function");
  }
  const recorded = manifest.functionFingerprint;
  if (!manifest.packageCodeSha256 || recorded.codeSha256 !== manifest.packageCodeSha256) {
    throw new Error("QA API fingerprint does not match the source checkout's deployed package");
  }
  if (live.functionName !== recorded.functionName || live.lastUpdateStatus !== "Successful" || recorded.lastUpdateStatus !== "Successful" || !live.codeSha256 || !live.revisionId || live.codeSha256 !== recorded.codeSha256 || live.revisionId !== recorded.revisionId) {
    throw new Error("Live QA API has changed or does not match the deployment fingerprint");
  }
}

const execute = promisify(execFile);
async function verifyApiProvenance(head: string, runId: string) {
  if (!/^\d+$/.test(runId)) throw new Error("An explicit successful QA run ID is required");
  const directory = await mkdtemp(join(tmpdir(), "3fc-qa-provenance-"));
  try {
    const runOutput = await execute("gh", ["api", `repos/ajfisher/3fc/actions/runs/${runId}`], { timeout: 20000, maxBuffer: 1024 * 1024 });
    await execute("gh", ["run", "download", runId, "--repo", "ajfisher/3fc", "--name", "qa-api-core-deployment", "--dir", directory], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const manifest = JSON.parse(await readFile(join(directory, "api-core-deploy-manifest.json"), "utf8"));
    const live = await execute("aws", ["lambda", "get-function-configuration", "--function-name", "3fc-qa-api-core", "--profile", "3fc-agent", "--region", "ap-southeast-2", "--query", "{functionName:FunctionName,codeSha256:CodeSha256,revisionId:RevisionId,lastUpdateStatus:LastUpdateStatus}", "--output", "json"], { timeout: 20000, maxBuffer: 1024 * 1024 });
    assertApiProvenance(head, JSON.parse(runOutput.stdout), manifest, JSON.parse(live.stdout));
  } catch {
    throw new Error("QA API provenance verification failed; no current-head acceptance may be claimed");
  } finally {
    // This exact newly created directory contains downloaded non-secret evidence only.
    await rm(directory, { recursive: true, force: true });
  }
}

test("QA API provenance rejects failed, stale, rolled-back and replaced deployments", () => {
  const head = "a".repeat(40);
  const fingerprint: Fingerprint = { functionName: "3fc-qa-api-core", codeSha256: "fixture-code", revisionId: "fixture-revision", lastUpdateStatus: "Successful" };
  const run: QaRun = { head_sha: head, conclusion: "success", status: "completed", name: "Deploy QA", repository: { full_name: "ajfisher/3fc" } };
  const manifest: DeploymentManifest = { env: "qa", service: "api-core", gitCommit: head, packageCodeSha256: fingerprint.codeSha256, functionFingerprint: fingerprint };
  expect(() => assertApiProvenance(head, run, manifest, fingerprint)).not.toThrow();
  for (const changed of [{ ...run, conclusion: "failure" }, { ...run, head_sha: "b".repeat(40) }, { ...run, status: "in_progress" }]) {
    expect(() => assertApiProvenance(head, changed, manifest, fingerprint)).toThrow();
  }
  expect(() => assertApiProvenance(head, run, { ...manifest, gitCommit: "b".repeat(40) }, fingerprint)).toThrow();
  // A concurrent deploy's recorded and live revisions can agree with each other
  // while belonging to a different package than this successful workflow built.
  for (const packageCodeSha256 of ["", "different-checkout-package"]) {
    expect(() => assertApiProvenance(head, run, { ...manifest, packageCodeSha256 }, fingerprint)).toThrow();
  }
  for (const changed of [{ ...fingerprint, codeSha256: "old-code" }, { ...fingerprint, revisionId: "newer-revision" }, { ...fingerprint, lastUpdateStatus: "InProgress" }]) {
    expect(() => assertApiProvenance(head, run, manifest, changed)).toThrow();
  }
});

function assertSiteAssetRevision(head: string, assets: string[]) {
  if (!assets.some(asset => new URL(asset, site).pathname === "/ui/styles.css") ||
      !assets.some(asset => /\/ui\/(?:setup|auth)-flow\.js$/.test(new URL(asset, site).pathname)) ||
      assets.some(asset => new URL(asset, site).searchParams.get("v") !== head.slice(0, 7))) {
    throw new Error("QA page assets do not match the expected source revision");
  }
}

async function verifySitePage(page: Page, head: string) {
  const assets = await page.locator('link[href*="/ui/styles.css"], script[src*="/ui/"]').evaluateAll(elements =>
    elements.map(element => element.getAttribute("href") ?? element.getAttribute("src") ?? ""));
  assertSiteAssetRevision(head, assets);
}

function isReadOnlyQaMethod(method: string) {
  return ["GET", "HEAD", "OPTIONS"].includes(method);
}

test("QA Home guard admits only read methods and blocks mutation methods", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) expect(isReadOnlyQaMethod(method)).toBe(true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "get", ""]) {
    expect(isReadOnlyQaMethod(method)).toBe(false);
  }
});

async function verifySignedInEmptyHome(page: Page, head: string) {
  // Only this synthetic account's real empty read is inspected. Do not create
  // leagues, seasons, games, invitations or ACLs for deployed visual acceptance.
  // The temporary guard also prevents an accidental form submission from writing.
  let attemptedMutation = false;
  let transportFailed = false;
  const guard = async (route: Route) => {
    try {
      if (!isReadOnlyQaMethod(route.request().method())) {
        attemptedMutation = true;
        await route.abort();
        return;
      }
      await route.continue();
    } catch {
      transportFailed = true;
      // No raw route exception may reach the reporter with request/cookie detail.
      try { await route.abort(); } catch { /* Already completed or closed. */ }
    }
  };
  const guardedApi = `${api}/v1/**`;
  await page.route(guardedApi, guard);
  try {
    const [leaguesResponse] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === api && url.pathname === "/v1/leagues" && response.request().method() === "GET";
      }, { timeout: 15000 }),
      page.goto(`${site}/setup`),
    ]);
    expect(leaguesResponse.status()).toBe(200);
    const payload = await leaguesResponse.json();
    // Assert a boolean, never include returned entity or account data in evidence.
    expect(Array.isArray(payload?.leagues) && payload.leagues.length === 0).toBe(true);
    await verifySitePage(page, head);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Welcome", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Home", exact: true })).toHaveAttribute("href", "/setup");
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expect(page.getByText("No leagues to show.", { exact: true })).toBeVisible();
    const region = page.locator("#dashboard-create-league-region");
    const form = page.getByRole("form", { name: "Create league", exact: true });
    const name = page.getByLabel("League name", { exact: true });
    const trigger = page.getByRole("button", { name: "Create a new league", exact: true });
    await expect(region).toBeVisible();
    await expect(name).not.toBeFocused();
    await name.fill("Unsent QA layout draft");

    const assertGeometry = async () => {
      const geometry = await page.evaluate(() => {
        const controls = [...document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, summary")]
          .filter(element => element.checkVisibility({ checkVisibilityCSS: true }));
        return {
          noOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth,
          usableTargets: controls.every(element => {
            const box = element.getBoundingClientRect();
            return box.width >= 43.9 && box.height >= 43.9 && box.left >= -0.1 && box.right <= innerWidth + 0.1;
          }),
        };
      });
      expect(geometry.noOverflow).toBe(true);
      expect(geometry.usableTargets).toBe(true);
    };

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await assertGeometry();
        await form.getByRole("button", { name: "Cancel", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(region).toBeHidden();
        await expect(trigger).toBeFocused();
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await assertGeometry();
        await page.keyboard.press("Enter");
        await expect(region).toBeVisible();
        await expect(name).toBeFocused();
        await expect(name).toHaveValue("Unsent QA layout draft");
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
      }
    }
    expect(attemptedMutation).toBe(false);
    expect(transportFailed).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
  } finally {
    // Remove only this read-only acceptance guard. Existing logout transport and
    // fixture cleanup retain their original behaviour after this helper returns.
    await page.unroute(guardedApi, guard);
  }
}

test("QA site provenance rejects mixed or replaced assets on later pages", () => {
  const head = "a".repeat(40);
  const current = ["/ui/styles.css?v=aaaaaaa", "/ui/setup-flow.js?v=aaaaaaa"];
  expect(() => assertSiteAssetRevision(head, current)).not.toThrow();
  for (const assets of [[], current.slice(0, 1), [current[0], "/ui/setup-flow.js?v=bbbbbbb"],
    ["/ui/styles.css?v=bbbbbbb", "/ui/auth-flow.js?v=bbbbbbb"],
    current.map(asset => `${asset}extra`)]) {
    expect(() => assertSiteAssetRevision(head, assets)).toThrow();
  }
});

// Playwright APIRequest errors can attach Cookie/Set-Cookie call logs even with
// tracing off. Credential transport stays outside that reporter and is bounded.
async function authRequest(path: "/v1/auth/magic/complete" | "/v1/auth/session" | "/v1/auth/logout", input: { token?: string; cookie?: string } = {}, transport: typeof fetch = fetch) {
  try {
    const response = await transport(`${api}${path}`, {
      method: path.endsWith("/session") ? "GET" : "POST",
      headers: {
        Origin: site,
        ...(input.cookie ? { Cookie: `threefc_session=${input.cookie}` } : {}),
        ...(input.token ? { "Content-Type": "application/json" } : {}),
      },
      ...(input.token ? { body: JSON.stringify({ token: input.token }) } : {}),
      signal: AbortSignal.timeout(15000), redirect: "error", cache: "no-store",
    });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body: body ? JSON.parse(body) : {} };
  } catch {
    throw new Error("QA authentication transport failed; credential detail suppressed");
  }
}

async function installSessionCookie(context: BrowserContext, headers: Headers) {
  try {
    const cookie = headers.get("set-cookie") ?? "";
    const value = /^threefc_session=([^;]+);/.exec(cookie)?.[1];
    if (!value || !/;\s*HttpOnly/i.test(cookie) || !/;\s*Secure/i.test(cookie) || !/;\s*SameSite=Lax/i.test(cookie)) {
      throw new Error("Invalid fixture cookie transport");
    }
    await context.addCookies([{ name: "threefc_session", value, url: api, httpOnly: true, secure: true, sameSite: "Lax" }]);
    return value;
  } catch {
    throw new Error("QA cookie installation failed; credential detail suppressed");
  }
}

// Optional read-only acceptance of a user-approved existing join context. These
// are public display identifiers, never credentials. The synthetic account has
// no league ACL; no player is joined, claimed or assigned by this helper.
async function verifyReadOnlyJoinContext(page: Page, cookie: string, head: string) {
  if (process.env.THREEFC_QA_JOIN_CONTEXT !== "1") return;
  const code = process.env.THREEFC_QA_JOIN_CODE ?? "";
  const playerId = process.env.THREEFC_QA_JOIN_PLAYER ?? "";
  const gameId = process.env.THREEFC_QA_JOIN_GAME ?? "";
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code) || !playerId.trim() || !gameId.trim() ||
    playerId.length > 512 || gameId.length > 512) throw new Error("Explicit QA display context is required");
  const contextPath = (identity: string) => `/v1/join/${code}/player-context?${new URLSearchParams({ playerId: identity })}`;
  const path = contextPath(playerId);
  const rosterPath = `/v1/games/${encodeURIComponent(gameId)}/roster`;
  if (new URL(path, api).searchParams.get("playerId") !== playerId || new URL(rosterPath, api).pathname !== rosterPath) {
    throw new Error("QA display identifiers do not have stable encoded paths");
  }
  async function safeRead(pathname: string, authenticated: boolean) {
    try {
      const response = await fetch(`${api}${pathname}`, {
        headers: { Origin: site, ...(authenticated ? { Cookie: `threefc_session=${cookie}` } : {}) },
        signal: AbortSignal.timeout(15000), redirect: "error", cache: "no-store",
      });
      return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
    } catch { throw new Error("QA display read failed; credential detail suppressed"); }
  }
  const anonymous = await safeRead(path, false);
  expect(anonymous.status).toBe(401);
  const encodedSlash = await safeRead(contextPath("codex-missing/opaque"), false);
  expect(encodedSlash.status).toBe(401);
  expect(encodedSlash.cache).toBe("no-store");
  const valid = await safeRead(path, true);
  expect(valid.status).toBe(200);
  expect(valid.cache).toBe("no-store");
  expect(valid.body?.gameId === gameId && valid.body?.joinCode === code && valid.body?.player?.playerId === playerId).toBe(true);
  expect(Object.keys(valid.body?.player ?? {}).sort().join(",") === "createdAt,nickname,playerId,updatedAt").toBe(true);
  expect(typeof valid.body?.player?.nickname === "string" && Boolean(valid.body.player.nickname.trim())).toBe(true);
  const missing = await safeRead(contextPath(`codex-missing-${randomUUID()}`), true);
  expect(missing.status).toBe(404);
  expect(missing.body?.player === undefined).toBe(true);
  // A literal "%ZZ" in an opaque ID must be decoded only once from the query.
  const onceDecoded = await safeRead(contextPath("codex-missing-%ZZ"), true);
  expect(onceDecoded.status).toBe(404);
  expect(onceDecoded.cache).toBe("no-store");
  const roster = await safeRead(rosterPath, true);
  expect(roster.status).toBe(403); // A display lookup does not grant league access.
  let writes = 0;
  let transportFailed = false;
  const guard = async (route: Route) => {
    try {
      if (!isReadOnlyQaMethod(route.request().method())) { writes += 1; await route.abort(); }
      else await route.continue();
    } catch {
      transportFailed = true;
      try { await route.abort(); } catch { /* Already completed or closed. */ }
    }
  };
  await page.route(`${api}/v1/**`, guard);
  try {
    await page.goto(`${site}/join?code=${code}&playerId=${encodeURIComponent(playerId)}`);
    await expect(page.getByTestId("claim-player")).toBeVisible();
    await expect(page.getByTestId("claim-player")).toBeEnabled();
    await expect(page.getByTestId("claim-player")).toHaveAttribute("aria-describedby", "join-result-player");
    await expect(page.locator("#join-result")).toBeVisible();
    await expect(page.locator("#join-result-player")).toBeVisible();
    expect((await page.locator("#join-result-player").textContent()) === valid.body.player.nickname).toBe(true);
    await verifySitePage(page, head);
    await page.getByTestId("claim-player").focus(); // Never activate a claim.
    await expect(page.getByTestId("claim-player")).toBeFocused();
    await page.keyboard.press("Tab");
    await page.goto(`${site}/setup`);
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    expect(writes).toBe(0);
    expect(transportFailed).toBe(false);
  } catch {
    // Keep the guard until the caller closes this owned context on any failure.
    throw new Error("QA join display acceptance failed; sensitive detail suppressed");
  }
  await page.unroute(`${api}/v1/**`, guard);
  console.log("QA join context PASS: named authenticated read, anonymous401, encoded-slash401, once-decoded404, missing404, roster403, strict public fields, zero browser writes");
}

test("QA credential transport suppresses secrets from network and cookie errors", async () => {
  const secret = "fictional-sensitive-sentinel";
  const failingFetch: typeof fetch = async () => { throw new Error(`Cookie: ${secret}`); };
  await expect(authRequest("/v1/auth/session", { cookie: secret }, failingFetch)).rejects.toThrow(/^QA authentication transport failed; credential detail suppressed$/);
  const badBodyFetch: typeof fetch = async () => new Response(`Set-Cookie: ${secret}`, { status: 502 });
  await expect(authRequest("/v1/auth/magic/complete", { token: secret }, badBodyFetch)).rejects.toThrow(/^QA authentication transport failed; credential detail suppressed$/);
  const failingContext = { async addCookies() { throw new Error(`Set-Cookie: ${secret}`); } } as unknown as BrowserContext;
  await expect(installSessionCookie(failingContext, new Headers({ "set-cookie": `threefc_session=${secret}; HttpOnly; Secure; SameSite=Lax` }))).rejects.toThrow(/^QA cookie installation failed; credential detail suppressed$/);
});

type FixtureRecord = { tokenId: string; email: string };
type FixtureItem = Record<string, AttributeValue>;
type CleanupFailureCategory = "context_close_failed" | "fixture_owner_mismatch" |
  "fixture_state_invalid" | "cleanup_storage_failure" | "cleanup_race_limit";
interface CleanupDynamoClient {
  send(command: GetItemCommand | DeleteItemCommand): Promise<unknown>;
}
class FixtureCleanupError extends Error {
  constructor(readonly category: CleanupFailureCategory) { super(category); }
}

function isConditionalDeleteFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error &&
    error.name === "ConditionalCheckFailedException";
}

function assertFixtureOwner(item: FixtureItem, email: string, entityType: string): void {
  if (item.email?.S !== email || item.entityType?.S !== entityType) {
    throw new FixtureCleanupError("fixture_owner_mismatch");
  }
}

async function cleanupFixtureRecord(client: CleanupDynamoClient, { tokenId, email }: FixtureRecord) {
  const tokenKey = { pk: { S: `AUTH_MAGIC#${tokenId}` }, sk: { S: "METADATA" } };
  const ownerNames = { "#email": "email", "#entityType": "entityType" };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = await client.send(new GetItemCommand({
      TableName: tableName, Key: tokenKey, ConsistentRead: true,
    })) as GetItemCommandOutput;
    if (!token.Item) return;
    assertFixtureOwner(token.Item, email, "magicToken");
    const sessionId = token.Item.sessionId?.S;
    try {
      if (sessionId) {
        if (!token.Item.usedAt?.S) throw new FixtureCleanupError("fixture_state_invalid");
        const sessionKey = { pk: { S: `AUTH_SESSION#${sessionId}` }, sk: { S: "METADATA" } };
        const session = await client.send(new GetItemCommand({
          TableName: tableName, Key: sessionKey, ConsistentRead: true,
        })) as GetItemCommandOutput;
        if (session.Item) assertFixtureOwner(session.Item, email, "session");
        await client.send(new DeleteItemCommand({
          TableName: tableName, Key: sessionKey,
          ConditionExpression: "attribute_not_exists(pk) OR (#email = :email AND #entityType = :entityType)",
          ExpressionAttributeNames: ownerNames,
          ExpressionAttributeValues: { ":email": { S: email }, ":entityType": { S: "session" } },
        }));
        // Leave the token in place until its linked session is safely deleted.
        // A changed association forces another owned-session cleanup first.
        await client.send(new DeleteItemCommand({
          TableName: tableName, Key: tokenKey,
          ConditionExpression: "attribute_not_exists(pk) OR (#email = :email AND #entityType = :entityType AND sessionId = :sessionId)",
          ExpressionAttributeNames: ownerNames,
          ExpressionAttributeValues: {
            ":email": { S: email }, ":entityType": { S: "magicToken" }, ":sessionId": { S: sessionId },
          },
        }));
      } else {
        if (token.Item.usedAt || token.Item.sessionId) throw new FixtureCleanupError("fixture_state_invalid");
        // Completion can commit after the read. This condition prevents deleting
        // its recovery link before discovering and removing the new session.
        await client.send(new DeleteItemCommand({
          TableName: tableName, Key: tokenKey,
          ConditionExpression: "attribute_not_exists(pk) OR (attribute_not_exists(usedAt) AND attribute_not_exists(sessionId) AND #email = :email AND #entityType = :entityType)",
          ExpressionAttributeNames: ownerNames,
          ExpressionAttributeValues: { ":email": { S: email }, ":entityType": { S: "magicToken" } },
        }));
      }
      return;
    } catch (error) {
      if (!isConditionalDeleteFailure(error)) throw error;
    }
  }
  throw new FixtureCleanupError("cleanup_race_limit");
}

async function cleanupQaFixtures(
  client: CleanupDynamoClient,
  records: FixtureRecord[],
  contexts: Array<Pick<BrowserContext, "close">>,
) {
  const report = { contextsClosed: 0, recordsRemoved: 0, failures: [] as CleanupFailureCategory[] };
  for (const context of contexts) {
    try { await context.close(); report.contextsClosed += 1; }
    catch { report.failures.push("context_close_failed"); }
  }
  for (const record of records) {
    try { await cleanupFixtureRecord(client, record); report.recordsRemoved += 1; }
    catch (error) {
      report.failures.push(error instanceof FixtureCleanupError ? error.category : "cleanup_storage_failure");
    }
  }
  return report;
}

test("isolated deployed QA sign-out and different-account recovery", async ({ browser }) => {
  test.skip(!enabled, "Explicit isolated QA authentication acceptance only");
  expect(process.env.AWS_PROFILE).toBe("3fc-agent");
  const expectedHead = process.env.THREEFC_QA_HEAD ?? "";
  expect(expectedHead).toMatch(/^[a-f0-9]{40}$/);
  const runId = process.env.THREEFC_QA_RUN ?? "";
  await verifyApiProvenance(expectedHead, runId);
  const client = new DynamoDBClient({ region: "ap-southeast-2" });
  const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
  expect(table.Table?.TableArn).toBe("arn:aws:dynamodb:ap-southeast-2:301691475109:table/3fc-qa-app");
  const fixtureRecords: FixtureRecord[] = [];
  const contexts: BrowserContext[] = [];
  async function seedMagicLink() {
    const tokenId = `codex-logout-qa-${randomUUID()}`;
    const secret = randomBytes(32).toString("base64url");
    const email = `${tokenId}@example.com`;
    fixtureRecords.push({ tokenId, email });
    const service = new MagicLinkService(client, {
      async sendMagicLink() { return {}; }, // synthetic delivery; never SES
    }, {
      tableName, appBaseUrl: site, callbackPath: "/auth/callback", tokenTtlSeconds: 300, sessionTtlSeconds: 300,
    }, undefined, { tokenId: () => tokenId, tokenSecret: () => secret, sessionId: () => randomUUID() });
    await service.start(email);
    return { token: `${tokenId}.${secret}`, email };
  }
  let phase = "initial page and deployment verification";
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${site}/sign-in`);
    await verifySitePage(page, expectedHead);
    phase = "first synthetic sign-in";
    const first = await seedMagicLink();
    const complete = await authRequest("/v1/auth/magic/complete", { token: first.token });
    expect(complete.status).toBe(200);
    const originalCookie = await installSessionCookie(context, complete.headers);
    phase = "signed-in empty Home and unsent draft acceptance";
    await verifySignedInEmptyHome(page, expectedHead);
    phase = "optional read-only join identity acceptance";
    await verifyReadOnlyJoinContext(page, originalCookie, expectedHead);
    phase = "keyboard sign-out and cookie expiry";
    const signOut = page.getByRole("button", { name: "Sign out", exact: true });
    await expect(signOut).toBeVisible();
    await verifySitePage(page, expectedHead);
    await signOut.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${site}/sign-in`);
    await expect(page.getByRole("heading", { name: "Sign in to 3FC" })).toBeVisible();
    await verifySitePage(page, expectedHead);
    expect((await context.cookies(api)).some(cookie => cookie.name === "threefc_session")).toBe(false);
    // Revoked cookie and still-unexpired original bearer both fail on real API.
    phase = "revoked cookie, magic-link recovery and repeat logout";
    const stale = await authRequest("/v1/auth/session", { cookie: originalCookie });
    expect(stale.status).toBe(401);
    expect(stale.headers.get("cache-control")).toBe("no-store");
    const replay = await authRequest("/v1/auth/magic/complete", { token: first.token });
    expect(replay.status).toBe(401);
    const repeat = await authRequest("/v1/auth/logout");
    expect(repeat.status).toBe(204);
    await page.goto(`${site}/setup`);
    await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
    await verifySitePage(page, expectedHead);
    phase = "different synthetic account sign-in";
    const second = await seedMagicLink();
    const newComplete = await authRequest("/v1/auth/magic/complete", { token: second.token });
    expect(newComplete.status).toBe(200);
    const newCookie = await installSessionCookie(context, newComplete.headers);
    await page.goto(`${site}/setup`);
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await verifySitePage(page, expectedHead);
    const newSession = await authRequest("/v1/auth/session", { cookie: newCookie });
    expect(newSession.status).toBe(200);
    expect(newSession.body.session.email === second.email).toBe(true);
    phase = "post-acceptance site and API provenance verification";
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await verifySitePage(page, expectedHead);
    await verifyApiProvenance(expectedHead, runId);
    // Only safe evidence is emitted: assertions, exact deployment SHA/run, counts.
    console.log(`QA sign-out PASS head=${expectedHead} run=${runId}; live API fingerprint, empty Home at 320/390/1280 light/dark, unsent draft keyboard recovery, isolated account switch, cookie expiry, revoked replay, protected re-entry verified`);
  } catch {
    // Never forward a browser/SDK exception with credential-bearing call logs.
    throw new Error(`QA sign-out failed during ${phase}; sensitive diagnostic detail suppressed`);
  } finally {
    const report = await cleanupQaFixtures(client, fixtureRecords, contexts);
    client.destroy();
    console.log(`QA fixture cleanup: ${report.recordsRemoved}/${fixtureRecords.length} records; ${report.contextsClosed}/${contexts.length} contexts; ${report.failures.length} failures`);
    if (report.failures.length > 0) {
      throw new Error(`QA fixture cleanup failed: ${report.failures.length} failures (${[...new Set(report.failures)].join(", ")})`);
    }
  }
});

type RefreshFixture = {
  run: string; leagueId: string; seasonId: string; gameId: string; sessionId: string;
  joinCode: string; playerIds: string[]; emails: [string, string]; createdAt: string;
};
type RefreshClient = {
  send(command: GetItemCommand | DeleteItemCommand | QueryCommand | TransactWriteItemsCommand): Promise<unknown>;
};
type RefreshReplay = { scope: string; key: string };
type RefreshWriteState = {
  ordinal: number; method: string; path: string; key?: string;
  state: "pending" | "confirmed" | "unconfirmed"; status?: number;
};
const refreshTeams = ["red", "blue", "yellow"] as const;

function settleRefreshWrite(write: RefreshWriteState, status: number | null, completeBody: boolean, validBody: boolean) {
  // A later response cannot erase earlier transport ambiguity for this attempt.
  if (write.state !== "pending") return;
  if (status !== null) write.status = status;
  // Even a 4xx can be an ambiguous idempotency response. The isolated happy-path
  // acceptance needs no automatic cleanup after a failed writer attempt.
  write.state = completeBody && validBody && status !== null && status >= 200 && status < 300
    ? "confirmed" : "unconfirmed";
}

function refreshCleanupQualified(seedConfirmed: boolean, closeFailures: number, ledgerFailed: boolean, writes: RefreshWriteState[]) {
  return seedConfirmed && closeFailures === 0 && !ledgerFailed && writes.every(write => write.state === "confirmed");
}

function refreshWriteBodyValid(fixture: RefreshFixture, write: RefreshWriteState, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const data = body as Record<string, unknown>;
  if (!write.path.includes("/goals")) return data.gameId === fixture.gameId;
  const goal = data[write.method === "DELETE" ? "deletedGoal" : "goal"];
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) return false;
  const identity = goal as Record<string, unknown>;
  return identity.gameId === fixture.gameId && typeof identity.eventId === "string" && identity.eventId.length > 0 &&
    (write.method === "POST" || write.path === `/v1/games/${fixture.gameId}/goals/${encodeURIComponent(identity.eventId)}`);
}

async function cleanupSettledRefreshFixture(client: RefreshClient, fixture: RefreshFixture, replays: RefreshReplay[],
  seedConfirmed: boolean, closeFailures: number, ledgerFailed: boolean, writes: RefreshWriteState[]) {
  if (!refreshCleanupQualified(seedConfirmed, closeFailures, ledgerFailed, writes)) return { preserved: true, removed: 0 };
  return { preserved: false, removed: await cleanupRefreshFixture(client, fixture, replays) };
}

function refreshRecoveryLedger(fixture: RefreshFixture, head: string, runId: string, seedState: string, graphState: string, writes: RefreshWriteState[], replays: RefreshReplay[]) {
  // Deliberate projection: never serialize browser requests, headers, cookies,
  // auth records or SDK objects. The fixture's game-session ID is not an auth
  // bearer, but is omitted too; its deterministic scope is recoverable by run.
  return {
    version: 1, head, qaRun: runId, table: tableName, fixtureRun: fixture.run, createdAt: fixture.createdAt, seedState, graphState,
    scope: { leagueId: fixture.leagueId, seasonId: fixture.seasonId, gameId: fixture.gameId, playerIds: [...fixture.playerIds] },
    seedKeys: refreshSeedItems(fixture).map(item => ({ pk: item.pk?.S, sk: item.sk?.S })),
    replays: replays.map(replay => ({ scope: replay.scope, key: replay.key })),
    writes: writes.map(write => ({ ordinal: write.ordinal, method: write.method, path: write.path, key: write.key, state: write.state, status: write.status })),
  };
}

function refreshFixture(run: string, createdAt = new Date().toISOString()): RefreshFixture {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run)) throw new Error("Invalid isolated fixture run");
  const prefix = `codex-refresh-${run}`;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return {
    run, leagueId: `${prefix}-league`, seasonId: `${prefix}-season`, gameId: `${prefix}-game`,
    sessionId: `${prefix}-session`, playerIds: refreshTeams.map(team => `${prefix}-${team}`),
    emails: [`${prefix}-writer@example.com`, `${prefix}-observer@example.com`], createdAt,
    joinCode: [...randomBytes(8)].map(byte => alphabet[byte % alphabet.length]).join(""),
  };
}

function assertRefreshScope(fixture: RefreshFixture) {
  const expected = refreshFixture(fixture.run, fixture.createdAt);
  if (["leagueId", "seasonId", "gameId", "sessionId"].some(key => fixture[key as keyof RefreshFixture] !== expected[key as keyof RefreshFixture]) ||
    JSON.stringify(fixture.playerIds) !== JSON.stringify(expected.playerIds) || JSON.stringify(fixture.emails) !== JSON.stringify(expected.emails) ||
    !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(fixture.joinCode) || !Number.isFinite(Date.parse(fixture.createdAt))) {
    throw new Error("Invalid isolated fixture scope");
  }
}

function refreshSeedItems(fixture: RefreshFixture): FixtureItem[] {
  assertRefreshScope(fixture);
  const { leagueId, seasonId, gameId, sessionId, joinCode, createdAt } = fixture;
  const writer = magicLinkSubjectForEmail(fixture.emails[0]);
  const item = (pk: string, sk: string, entityType: string, data: Record<string, unknown>): FixtureItem => ({
    pk: { S: pk }, sk: { S: sk }, entityType: { S: entityType }, data: { S: JSON.stringify(data) },
    createdAt: { S: createdAt }, updatedAt: { S: createdAt }, qaFixtureRun: { S: fixture.run },
  });
  const season = { leagueId, seasonId, name: "Isolated QA season", slug: null, startsOn: null, endsOn: null };
  const items = [
    item(`LEAGUE#${leagueId}`, "METADATA", "league", { leagueId, name: "Isolated QA refresh league", slug: null, createdByUserId: writer }),
    item(`LEAGUE#${leagueId}`, `SEASON#${seasonId}`, "season", season),
    item(`SEASON#${seasonId}`, "METADATA", "season", season),
    item(`GAME#${gameId}`, "METADATA", "game", { gameId, leagueId, seasonId, sessionId, joinCode,
      gameStartTs: createdAt, status: "scheduled", thirdLengthMinutes: 20,
      thirds: [1, 2, 3].map(third => ({ third, startedAt: null, finishedAt: null })), finishedAt: null, result: null }),
    item(`JOIN_CODE#${joinCode}`, "METADATA", "gameJoinCode", { joinCode, gameId }),
  ];
  fixture.emails.forEach((email, index) => {
    const userId = magicLinkSubjectForEmail(email);
    items.push(item(`LEAGUE#${leagueId}`, `ACL#USER#${userId}`, "acl", { leagueId, userId,
      role: index === 0 ? "admin" : "scorekeeper", grantedByUserId: writer }));
  });
  refreshTeams.forEach((teamId, index) => {
    const name = ["Red", "Blue", "Yellow"][index];
    const color = ["#d83b36", "#2364d2", "#e0a612"][index];
    const playerId = fixture.playerIds[index];
    items.push(
      item(`LEAGUE#${leagueId}`, `SEASON#${seasonId}#TEAM#${teamId}`, "team", { leagueId, seasonId, teamId, name, color }),
      item(`GAME#${gameId}`, `TEAM#${teamId}`, "gameTeam", { gameId, teamId, name, color, scored: 0, conceded: 0 }),
      item(`PLAYER#${playerId}`, "PROFILE", "player", { playerId, nickname: ["QA Ari", "QA Bea", "QA Cy"][index], claimedByUserId: null }),
      item(`GAME#${gameId}`, `PLAYER#${playerId}`, "gamePlayer", { gameId, playerId }),
      item(`GAME#${gameId}`, `ROSTER#${teamId}#${playerId}`, "roster", { gameId, teamId, playerId }),
    );
  });
  // No SESSION#date record or shared date index. All templates/overrides and the
  // join lookup are complete, so normal GETs need no legacy repair writes.
  return items;
}

function refreshSeedCommand(fixture: RefreshFixture) {
  return new TransactWriteItemsCommand({ TransactItems: refreshSeedItems(fixture).map(Item => ({ Put: {
    TableName: tableName, Item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  } })) });
}

function refreshRequestAllowed(fixture: RefreshFixture, observer: boolean, method: string, rawUrl: string, eventIds: ReadonlySet<string>) {
  assertRefreshScope(fixture);
  const url = new URL(rawUrl);
  if (url.origin !== api) return false;
  const game = `/v1/games/${fixture.gameId}`;
  const readPaths = new Set(["/v1/auth/session", `/v1/leagues/${fixture.leagueId}`,
    `/v1/leagues/${fixture.leagueId}/seasons/${fixture.seasonId}`,
    game, `${game}/goals`, `${game}/roster`, `${game}/players`, `${game}/teams`]);
  if (method === "OPTIONS" && !observer && !url.search && ["POST", "PATCH", "DELETE"].some(writeMethod =>
    refreshRequestAllowed(fixture, false, writeMethod, rawUrl, eventIds))) return true;
  if (isReadOnlyQaMethod(method)) return readPaths.has(url.pathname) && !url.search;
  if (observer || url.search) return false;
  if (method === "POST" && (url.pathname === `${game}/goals` || url.pathname === `${game}/finish` ||
    refreshTeams.some((_team, index) => ["start", "finish"].some(action => url.pathname === `${game}/thirds/${index + 1}/${action}`)))) return true;
  return ["PATCH", "DELETE"].includes(method) && [...eventIds].some(eventId => url.pathname === `${game}/goals/${encodeURIComponent(eventId)}`);
}

function refreshOwnedItem(fixture: RefreshFixture, item: FixtureItem, replays: RefreshReplay[]) {
  const pk = item.pk?.S; const sk = item.sk?.S; const type = item.entityType?.S;
  if (!pk || !sk || !type || !item.updatedAt?.S || !item.data?.S) return false;
  let data: Record<string, unknown>;
  try { data = JSON.parse(item.data.S); } catch { return false; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (pk === `GAME#${fixture.gameId}`) {
    return ["game", "gameTeam", "gamePlayer", "roster", "goal", "goalEventId", "goalState", "goalAudit", "goalCorrectionOperation"].includes(type) && data.gameId === fixture.gameId &&
      (type !== "game" || (data.leagueId === fixture.leagueId && data.seasonId === fixture.seasonId && data.sessionId === fixture.sessionId && data.joinCode === fixture.joinCode));
  }
  const seeded = refreshSeedItems(fixture).find(candidate => candidate.pk?.S === pk && candidate.sk?.S === sk);
  if (seeded) return type === seeded.entityType?.S && item.data.S === seeded.data?.S && item.createdAt?.S === fixture.createdAt;
  return type === "idempotency" && sk === "METADATA" && replays.some(replay =>
    pk === `IDEMPOTENCY#${replay.scope}#${replay.key}` && data.scope === replay.scope && data.key === replay.key);
}

async function cleanupRefreshFixture(client: RefreshClient, fixture: RefreshFixture, replays: RefreshReplay[]) {
  assertRefreshScope(fixture);
  const items = new Map<string, FixtureItem>();
  let cursor: Record<string, AttributeValue> | undefined;
  const cursors = new Set<string>();
  // Only the exact owned game partition is queried; generated goal/audit/state
  // keys remain bounded here. All other records have an explicit key ledger.
  for (let page = 0; page < 10; page += 1) {
    const result = await client.send(new QueryCommand({ TableName: tableName, ConsistentRead: true,
      KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: `GAME#${fixture.gameId}` } }, ExclusiveStartKey: cursor })) as QueryCommandOutput;
    for (const item of result.Items ?? []) items.set(`${item.pk?.S}|${item.sk?.S}`, item);
    cursor = result.LastEvaluatedKey;
    if (!cursor || Object.keys(cursor).length === 0) break;
    const signature = JSON.stringify(cursor);
    if (cursors.has(signature) || page === 9) throw new Error("refresh_cleanup_pagination_failed");
    cursors.add(signature);
  }
  const keys = refreshSeedItems(fixture).filter(item => item.pk?.S !== `GAME#${fixture.gameId}`).map(item => ({ pk: item.pk, sk: item.sk }));
  for (const replay of replays) keys.push({ pk: { S: `IDEMPOTENCY#${replay.scope}#${replay.key}` }, sk: { S: "METADATA" } });
  for (const Key of keys) {
    const result = await client.send(new GetItemCommand({ TableName: tableName, Key, ConsistentRead: true })) as GetItemCommandOutput;
    if (result.Item) items.set(`${result.Item.pk?.S}|${result.Item.sk?.S}`, result.Item);
  }
  if ([...items.values()].some(item => !refreshOwnedItem(fixture, item, replays))) throw new Error("refresh_cleanup_owner_mismatch");
  // Caller must already have confirmed every forwarded writer response and
  // closed both contexts. Anchor-first deletion is additional protection, not
  // evidence that an earlier Lambda has stopped writing.
  const ordered = [...items.values()].sort((left, right) => Number(right.pk?.S === `GAME#${fixture.gameId}` && right.sk?.S === "METADATA") - Number(left.pk?.S === `GAME#${fixture.gameId}` && left.sk?.S === "METADATA"));
  for (const item of ordered) {
    await client.send(new DeleteItemCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk },
      ConditionExpression: "attribute_not_exists(pk) OR (#type = :type AND #data = :data AND #updated = :updated)",
      ExpressionAttributeNames: { "#type": "entityType", "#data": "data", "#updated": "updatedAt" },
      ExpressionAttributeValues: { ":type": item.entityType, ":data": item.data, ":updated": item.updatedAt } }));
  }
  const remaining = await client.send(new QueryCommand({ TableName: tableName, ConsistentRead: true,
    KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: `GAME#${fixture.gameId}` } }, Limit: 1 })) as QueryCommandOutput;
  if (remaining.Items?.length) throw new Error("refresh_cleanup_records_remain");
  for (const Key of keys) {
    const result = await client.send(new GetItemCommand({ TableName: tableName, Key, ConsistentRead: true })) as GetItemCommandOutput;
    if (result.Item) throw new Error("refresh_cleanup_records_remain");
  }
  return ordered.length;
}

test("QA refresh fixture writes and route allowlists are restricted to one UUID scope", () => {
  const fixture = refreshFixture("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  const command = refreshSeedCommand(fixture);
  expect(command.input.TransactItems).toHaveLength(22);
  for (const entry of command.input.TransactItems ?? []) {
    expect(entry.Put?.TableName).toBe(tableName);
    expect(entry.Put?.ConditionExpression).toBe("attribute_not_exists(pk) AND attribute_not_exists(sk)");
    expect(entry.Put?.Item?.pk?.S?.startsWith("SESSION#")).toBe(false);
  }
  const base = `${api}/v1/games/${fixture.gameId}`;
  expect(refreshRequestAllowed(fixture, true, "GET", `${base}/goals`, new Set())).toBe(true);
  expect(refreshRequestAllowed(fixture, false, "POST", `${base}/goals`, new Set())).toBe(true);
  expect(refreshRequestAllowed(fixture, false, "OPTIONS", `${base}/thirds/1/start`, new Set())).toBe(true);
  for (const [method, url] of [["POST", `${base}/goals`], ["DELETE", `${base}/goals/goal`], ["POST", `${api}/v1/auth/logout`]]) {
    expect(refreshRequestAllowed(fixture, true, method, url, new Set(["goal"]))).toBe(false);
  }
  for (const url of [`${api}/v1/games/real-game/goals`, `${api}/v1/leagues/${fixture.leagueId}/access`, `${site}/v1/games/${fixture.gameId}/goals`, `${base}/goals?gameId=other`]) {
    expect(refreshRequestAllowed(fixture, false, "POST", url, new Set())).toBe(false);
  }
  expect(refreshRequestAllowed(fixture, false, "DELETE", `${base}/goals/unknown`, new Set())).toBe(false);
  expect(refreshRequestAllowed(fixture, false, "DELETE", `${base}/goals/owned`, new Set(["owned"]))).toBe(true);
  expect(() => refreshSeedItems({ ...fixture, gameId: "real-game" })).toThrow();
});

test("QA refresh cleanup retains pending, uncertain, unclosed and unjournaled writes without reading or deleting records", async () => {
  const fixture = refreshFixture("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  let calls = 0;
  const forbidden: RefreshClient = { async send() { calls += 1; throw new Error("Unsafe cleanup reached DynamoDB"); } };
  const pending = (): RefreshWriteState => ({ ordinal: 1, method: "POST", path: `/v1/games/${fixture.gameId}/goals`, key: "fixture-replay-key", state: "pending" });
  const retain = async (write: RefreshWriteState, seed = true, closeFailures = 0, ledgerFailed = false) => {
    expect(await cleanupSettledRefreshFixture(forbidden, fixture, [], seed, closeFailures, ledgerFailed, [write]))
      .toEqual({ preserved: true, removed: 0 });
    expect(calls).toBe(0);
  };
  await retain(pending()); // Browser close alone says nothing about Lambda.
  for (const [status, completeBody, validBody] of [
    [null, false, false], [200, false, true], [200, true, false],
    [400, true, true], [409, true, true], [408, true, true], [429, true, true], [503, true, true],
  ] as Array<[number | null, boolean, boolean]>) {
    const write = pending(); settleRefreshWrite(write, status, completeBody, validBody);
    expect(write.state).toBe("unconfirmed"); await retain(write);
    // A later successful replay or event does not erase the earlier ambiguous
    // attempt: that Lambda might still commit its idempotency record afterward.
    settleRefreshWrite(write, 200, true, true);
    expect(write.state).toBe("unconfirmed"); await retain(write);
  }
  const confirmed = pending(); settleRefreshWrite(confirmed, 201, true, true);
  expect(confirmed.state).toBe("confirmed");
  expect(refreshCleanupQualified(true, 0, false, [confirmed])).toBe(true);
  await retain(confirmed, false); await retain(confirmed, true, 1); await retain(confirmed, true, 0, true);
  expect(await cleanupSettledRefreshFixture(forbidden, fixture, [], true, 0, false, [confirmed, pending()]))
    .toEqual({ preserved: true, removed: 0 });
  expect(calls).toBe(0);
});

test("QA refresh settlement validates returned identities and its recovery projection excludes secrets", () => {
  const fixture = refreshFixture("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "2026-09-08T00:00:00.000Z");
  const path = `/v1/games/${fixture.gameId}`;
  const write: RefreshWriteState = { ordinal: 1, method: "POST", path: `${path}/goals`, key: "non-secret-replay", state: "pending" };
  const goal = { gameId: fixture.gameId, eventId: "fixture-goal" };
  expect(refreshWriteBodyValid(fixture, write, { goal })).toBe(true);
  expect(refreshWriteBodyValid(fixture, write, { goal: { ...goal, gameId: "other-game" } })).toBe(false);
  expect(refreshWriteBodyValid(fixture, write, { goal: { ...goal, eventId: "" } })).toBe(false);
  const correction = { ...write, method: "DELETE", path: `${path}/goals/fixture-goal` };
  expect(refreshWriteBodyValid(fixture, correction, { deletedGoal: goal })).toBe(true);
  expect(refreshWriteBodyValid(fixture, correction, { deletedGoal: { ...goal, eventId: "another-goal" } })).toBe(false);
  expect(refreshWriteBodyValid(fixture, { ...write, path: `${path}/thirds/1/start` }, { gameId: fixture.gameId })).toBe(true);
  expect(refreshWriteBodyValid(fixture, { ...write, path: `${path}/finish` }, { gameId: "other-game" })).toBe(false);
  const secret = "DO-NOT-SERIALIZE-AUTH-SECRET";
  const replay = { scope: `${fixture.emails[0]}:POST:${write.path}`, key: write.key!, token: secret };
  const ledger = refreshRecoveryLedger(Object.assign(fixture, { cookie: secret, token: secret }), "a".repeat(40), "123", "confirmed", "preserved-for-recovery",
    [Object.assign(write, { authorization: secret, request: { headers: { cookie: secret } } })], [replay]);
  expect(ledger.seedKeys).toHaveLength(22);
  expect(ledger.seedKeys).toEqual(refreshSeedItems(fixture).map(item => ({ pk: item.pk.S, sk: item.sk.S })));
  expect(ledger.replays).toEqual([{ scope: replay.scope, key: replay.key }]);
  expect(ledger.writes).toEqual([{ ordinal: 1, method: "POST", path: write.path, key: write.key, state: "pending", status: undefined }]);
  expect(ledger.head).toBe("a".repeat(40)); expect(ledger.qaRun).toBe("123"); expect(ledger.fixtureRun).toBe(fixture.run);
  const serialized = JSON.stringify(ledger);
  expect(serialized).not.toContain(secret); expect(serialized).not.toContain(fixture.sessionId);
  expect(serialized).not.toMatch(/AUTH_(?:SESSION|MAGIC)#|"(?:cookie|authorization|token|sessionId)"/);
});

test("QA refresh cleanup refuses ownership changes and conditions each exact delete", async () => {
  const fixture = refreshFixture("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  for (const collision of ["none", "read", "delete"] as const) {
    const items = new Map(refreshSeedItems(fixture).map(item => [`${item.pk.S}|${item.sk.S}`, structuredClone(item)]));
    if (collision === "read") items.get(`GAME#${fixture.gameId}|METADATA`)!.data = { S: JSON.stringify({ gameId: "someone-else" }) };
    const deletes: DeleteItemCommand[] = [];
    const fake: RefreshClient = { async send(command) {
      if (command instanceof TransactWriteItemsCommand) throw new Error("Unexpected seed during cleanup");
      expect(command.input.TableName).toBe(tableName);
      if (command instanceof QueryCommand) {
        expect(command.input.ConsistentRead).toBe(true);
        expect(command.input.ExpressionAttributeValues?.[":pk"]?.S).toBe(`GAME#${fixture.gameId}`);
        return { Items: [...items.values()].filter(item => item.pk.S === `GAME#${fixture.gameId}`) };
      }
      const key = `${command.input.Key?.pk?.S}|${command.input.Key?.sk?.S}`;
      if (command instanceof GetItemCommand) return { Item: structuredClone(items.get(key)) };
      deletes.push(command);
      expect(command.input.ConditionExpression).toContain("#data = :data AND #updated = :updated");
      const current = items.get(key);
      if (collision === "delete" && current) current.data = { S: JSON.stringify({ gameId: "changed-after-read" }) };
      if (current?.data.S !== command.input.ExpressionAttributeValues?.[":data"].S ||
        current?.updatedAt.S !== command.input.ExpressionAttributeValues?.[":updated"].S) throw new Error("conditional_delete_refused");
      expect(current?.data).toEqual(command.input.ExpressionAttributeValues?.[":data"]);
      expect(current?.updatedAt).toEqual(command.input.ExpressionAttributeValues?.[":updated"]);
      items.delete(key); return {};
    } };
    if (collision !== "none") {
      await expect(cleanupRefreshFixture(fake, fixture, [])).rejects.toThrow(collision === "read" ? "refresh_cleanup_owner_mismatch" : "conditional_delete_refused");
      expect(deletes).toHaveLength(collision === "read" ? 0 : 1);
      expect(items.size).toBe(22);
    } else {
      const write: RefreshWriteState = { ordinal: 1, method: "POST", path: `/v1/games/${fixture.gameId}/thirds/1/start`, state: "pending" };
      settleRefreshWrite(write, 200, true, true);
      expect(await cleanupSettledRefreshFixture(fake, fixture, [], true, 0, false, [write])).toEqual({ preserved: false, removed: 22 });
      expect(items.size).toBe(0);
      expect(deletes[0].input.Key).toEqual({ pk: { S: `GAME#${fixture.gameId}` }, sk: { S: "METADATA" } });
    }
  }
});

test("isolated deployed QA two-client match refresh", async ({ browser }) => {
  test.skip(process.env.THREEFC_QA_MATCH_REFRESH !== "1", "Explicit isolated QA refresh acceptance only");
  test.setTimeout(240_000);
  expect(process.env.AWS_PROFILE).toBe("3fc-agent");
  const head = process.env.THREEFC_QA_HEAD ?? ""; const runId = process.env.THREEFC_QA_RUN ?? "";
  expect(head).toMatch(/^[a-f0-9]{40}$/);
  await verifyApiProvenance(head, runId);
  const client = new DynamoDBClient({ region: "ap-southeast-2" });
  const fixture = refreshFixture(randomUUID());
  const records: FixtureRecord[] = []; const contexts: BrowserContext[] = []; const replays: RefreshReplay[] = [];
  const eventIds = new Set<string>();
  const writes: RefreshWriteState[] = []; const requestStates = new WeakMap<Request, RefreshWriteState>();
  const responseSettlements = new Set<Promise<void>>();
  const recoveryDirectory = await mkdtemp(join(tmpdir(), "3fc-qa-refresh-recovery-"));
  const recoveryPath = join(recoveryDirectory, "recovery.json");
  let ledgerQueue: Promise<void> = Promise.resolve(); let ledgerFailed = false; let closing = false;
  let seedState = "not-started"; let graphState = "not-created";
  let blocked = 0; let transportFailed = false; let writerWrites = 0; let observerWrites = 0;
  const persistLedger = () => {
    // Serialize atomic replacement. Persist pending identities before dispatch;
    // an abrupt exit therefore leaves an exact, non-secret recovery inventory.
    const next = ledgerQueue.then(async () => {
      const value = refreshRecoveryLedger(fixture, head, runId, seedState, graphState, writes, replays);
      await writeFile(`${recoveryPath}.next`, JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(`${recoveryPath}.next`, recoveryPath);
    });
    ledgerQueue = next.catch(() => { ledgerFailed = true; });
    return next;
  };
  const persistSettlement = async () => {
    try { await persistLedger(); } catch { /* Retain graph; never log raw filesystem or request errors. */ }
  };
  let phase = "QA account and table verification";
  try {
    await persistLedger();
    console.log(`QA refresh non-secret recovery ledger: ${recoveryPath}`);
    const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
    expect(table.Table?.TableArn).toBe("arn:aws:dynamodb:ap-southeast-2:301691475109:table/3fc-qa-app");
    for (const email of fixture.emails) {
      const tokenId = `codex-refresh-auth-${randomUUID()}`; const secret = randomBytes(32).toString("base64url");
      records.push({ tokenId, email });
      const magic = new MagicLinkService(client, { async sendMagicLink() { return {}; } }, {
        tableName, appBaseUrl: site, callbackPath: "/auth/callback", tokenTtlSeconds: 300, sessionTtlSeconds: 300,
      }, undefined, { tokenId: () => tokenId, tokenSecret: () => secret, sessionId: () => randomUUID() });
      await magic.start(email);
      const complete = await authRequest("/v1/auth/magic/complete", { token: `${tokenId}.${secret}` });
      expect(complete.status).toBe(200);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
      contexts.push(context); await installSessionCookie(context, complete.headers);
    }
    phase = "conditional isolated fixture creation";
    seedState = "pending"; graphState = "possibly-created"; await persistLedger();
    try {
      await client.send(refreshSeedCommand(fixture));
      seedState = "confirmed"; graphState = "created"; await persistLedger();
    } catch {
      seedState = "unconfirmed"; await persistSettlement();
      throw new Error("Isolated fixture creation was not confirmed");
    }
    const pages: Page[] = [];
    let observerNavigations = 0;
    for (const [index, context] of contexts.entries()) {
      const observer = index === 1;
      const page = await context.newPage(); pages.push(page);
      page.on("response", response => {
        const write = requestStates.get(response.request());
        if (!write) return;
        const settled = (async () => {
          try {
            // Headers alone do not prove completion. Await the actual body;
            // every allowed handler awaits its durable writes before returning.
            const bytes = await response.body();
            let body: unknown;
            try { body = JSON.parse(bytes.toString("utf8")); } catch { body = null; }
            settleRefreshWrite(write, response.status(), true, refreshWriteBodyValid(fixture, write, body));
          } catch { settleRefreshWrite(write, null, false, false); }
          await persistSettlement();
        })();
        responseSettlements.add(settled);
        void settled.finally(() => responseSettlements.delete(settled));
      });
      page.on("requestfailed", request => {
        const write = requestStates.get(request);
        if (!write) return;
        settleRefreshWrite(write, null, false, false);
        void persistSettlement();
      });
      await page.route(`${api}/**`, async route => {
        let write: RefreshWriteState | undefined;
        try {
          const request = route.request(); const method = request.method();
          if (closing || !refreshRequestAllowed(fixture, observer, method, request.url(), eventIds)) {
            blocked += 1; await route.abort(); return;
          }
          if (!isReadOnlyQaMethod(method)) {
            if (observer) observerWrites += 1; else writerWrites += 1;
            const key = request.headers()["idempotency-key"];
            const path = new URL(request.url()).pathname;
            if (key) replays.push({ scope: `${fixture.emails[index]}:${method}:${path}`, key });
            write = { ordinal: writes.length + 1, method, path, ...(key ? { key } : {}), state: "pending" };
            writes.push(write); requestStates.set(request, write);
            await persistLedger();
            // A close can race the ledger write. Never continue afterward; the
            // conservative pending record remains recoverable either way.
            if (closing || ledgerFailed) throw new Error("Fixture writer is closing");
          }
          await route.continue();
        } catch {
          transportFailed = true;
          if (write) { settleRefreshWrite(write, null, false, false); await persistSettlement(); }
          try { await route.abort(); } catch { /* Closed owned route. */ }
        }
      });
      await page.goto(`${site}/games/${fixture.gameId}#score`);
      await verifySitePage(page, head);
      await expect(page.locator('[data-action="start-active-third"]')).toBeEnabled();
      expect(await page.evaluate(() => document.visibilityState === "visible")).toBe(true);
    }
    const [writer, observer] = pages;
    observer.on("framenavigated", frame => { if (frame === observer.mainFrame()) observerNavigations += 1; });
    phase = "remote clock start";
    await writer.locator('[data-action="start-active-third"]').click();
    await expect(writer.locator('[data-action="finish-active-third"]')).toBeEnabled();
    await expect(observer.locator('[data-action="finish-active-third"]')).toBeEnabled({ timeout: 25000 });
    const choose = async (page: Page, scorer: string) => {
      await page.locator('#goal-scoring-team input[value="red"]').check();
      await page.locator('#goal-conceding-team input[value="blue"]').check();
      await page.locator("#goal-scorer").selectOption(scorer);
    };
    await choose(observer, fixture.playerIds[0]);
    await observer.locator("#goal-assists-dropdown summary").click();
    await observer.locator(`#goal-assists input[value="${fixture.playerIds[2]}"]`).check();
    await observer.locator("#goal-scorer").focus();
    phase = "remote normal goal and preserved draft";
    await choose(writer, fixture.playerIds[0]);
    await writer.locator('[data-action="save-goal"]').click();
    await expect(writer.locator('[data-ui="goal-event"]')).toHaveCount(1);
    const eventId = await writer.locator('[data-ui="goal-event"]').getAttribute("data-event-id");
    if (!eventId) throw new Error("Fixture goal identity unavailable");
    eventIds.add(eventId);
    await expect(observer.locator('[data-ui="goal-event"]')).toHaveCount(1, { timeout: 20000 });
    await expect(observer.locator('[data-ui="goal-scorer"]')).toHaveText("QA Ari");
    await expect(observer.locator("#goal-scorer")).toHaveValue(fixture.playerIds[0]);
    await expect(observer.locator("#goal-scorer")).toBeFocused();
    await expect(observer.locator("#goal-assists-dropdown")).toHaveAttribute("open", "");
    await expect(observer.locator(`#goal-assists input[value="${fixture.playerIds[2]}"]`)).toBeChecked();
    const scores = (page: Page) => page.locator('#live-scoreboard [data-ui="score-team"]').evaluateAll(cards => cards.map(card => ({
      teamId: card.getAttribute("data-team-id"), totals: [...card.querySelectorAll("dl > div")].map(row => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]),
    })));
    await expect(writer.locator('#live-scoreboard [data-ui="score-team"]')).toHaveCount(3);
    await expect(observer.locator('#live-scoreboard [data-ui="score-team"]')).toHaveCount(3);
    expect(await scores(observer)).toEqual(await scores(writer));
    expect(await scores(observer)).toEqual([
      { teamId: "red", totals: [["Conceded", "0"], ["Scored", "1"]] },
      { teamId: "blue", totals: [["Conceded", "1"], ["Scored", "0"]] },
      { teamId: "yellow", totals: [["Conceded", "0"], ["Scored", "0"]] },
    ]);
    phase = "remote own-goal correction";
    await writer.locator('[data-action="edit-goal"]').click();
    await writer.locator("#goal-own-goal").check();
    await writer.locator('#goal-conceding-team input[value="blue"]').check();
    await writer.locator("#goal-scorer").selectOption(fixture.playerIds[1]);
    await writer.locator('[data-action="save-goal"]').click();
    await expect(writer.locator('[data-ui="goal-scorer"]')).toHaveText("QA Bea");
    await expect(observer.locator('[data-ui="goal-scorer"]')).toHaveText("QA Bea", { timeout: 20000 });
    await expect(observer.locator('[data-ui="own-goal-marker"]')).toBeVisible();
    expect(await scores(observer)).toEqual(await scores(writer));
    expect((await scores(observer)).map(team => team.totals)).toEqual([
      [["Conceded", "0"], ["Scored", "0"]], [["Conceded", "1"], ["Scored", "0"]], [["Conceded", "0"], ["Scored", "0"]],
    ]);
    phase = "remote goal deletion";
    writer.once("dialog", dialog => dialog.accept());
    await writer.locator('[data-action="delete-goal"]').click();
    await expect(writer.locator('[data-ui="goal-event"]')).toHaveCount(0);
    await expect(observer.locator('[data-ui="goal-event"]')).toHaveCount(0, { timeout: 20000 });
    phase = "remote finished result without navigation";
    await writer.locator('[data-action="finish-active-third"]').click();
    for (const third of [2, 3]) {
      await expect(writer.locator('[data-action="start-active-third"]')).toHaveText(`Start Third ${third}`);
      await writer.locator('[data-action="start-active-third"]').click();
      await expect(writer.locator('[data-action="finish-active-third"]')).toBeEnabled();
      await writer.locator('[data-action="finish-active-third"]').click();
    }
    await expect(writer.locator('[data-action="finish-game"]')).toBeEnabled();
    await writer.locator('[data-action="finish-game"]').click();
    await expect(writer.locator('[data-testid="game-result-outcome"]')).toHaveText("Draw");
    await expect(observer.locator("#game-overview-status")).toHaveText("Finished", { timeout: 25000 });
    await expect(observer.locator('[data-action="save-goal"]')).toBeDisabled();
    expect(new URL(observer.url()).hash).toBe("#score");
    expect(observerNavigations).toBe(0);
    await observer.locator('[data-testid="game-mode-final-tab"]').click();
    await expect(observer.locator('[data-testid="game-result-outcome"]')).toHaveText("Draw");
    phase = "post-acceptance exact-head provenance";
    for (const page of pages) {
      await page.reload();
      await expect(page.locator("#game-overview-status")).toHaveText("Finished");
      await verifySitePage(page, head);
    }
    await verifyApiProvenance(head, runId);
    // These are actual response-body completions, never a sleep or an inference
    // from quiet traffic. An unanswered request remains pending and fails below.
    await Promise.all([...responseSettlements]);
    expect(blocked).toBe(0); expect(transportFailed).toBe(false); expect(observerWrites).toBe(0); expect(writerWrites).toBe(10);
    expect(writes).toHaveLength(10); expect(writes.every(write => write.state === "confirmed")).toBe(true);
    expect(ledgerFailed).toBe(false);
    console.log(`QA refresh PASS head=${head} run=${runId}; two synthetic accounts, real clock/goal/edit/delete/finish reads, preserved draft/focus, zero observer writes, no automatic navigation`);
  } catch {
    throw new Error(`QA refresh failed during ${phase}; sensitive diagnostic detail suppressed`);
  } finally {
    // Closing a browser does NOT settle an already forwarded Lambda. Pending or
    // ambiguous writes retain the complete graph even when both contexts close.
    closing = true;
    let closeFailures = 0;
    for (const context of contexts) { try { await context.close(); } catch { closeFailures += 1; } }
    await ledgerQueue;
    let graphRemoved = 0; let graphFailed = false; let graphPreserved = false;
    if (seedState !== "not-started") {
      try {
        const cleanup = await cleanupSettledRefreshFixture(client, fixture, replays, seedState === "confirmed", closeFailures, ledgerFailed, writes);
        graphRemoved = cleanup.removed; graphPreserved = cleanup.preserved;
        graphState = cleanup.preserved ? "preserved-for-recovery" : "removed-and-absence-verified";
      } catch { graphFailed = true; graphState = "cleanup-incomplete-retain-recovery-ledger"; }
    }
    await persistSettlement();
    const authReport = await cleanupQaFixtures(client, records, []);
    client.destroy();
    console.log(`QA refresh cleanup: ${graphRemoved} graph records; ${authReport.recordsRemoved}/${records.length} auth records; graph=${graphState}; recovery ledger=${recoveryPath}`);
    if (closeFailures || graphPreserved || graphFailed || ledgerFailed || authReport.failures.length) {
      throw new Error(`QA refresh cleanup incomplete; isolated recovery ledger: ${recoveryPath}`);
    }
  }
});

// These tests never create a browser or AWS client and run without the QA opt-in.
// The fake evaluates ownership and state conditions at deletion time, not read time.
class CleanupDynamoFake implements CleanupDynamoClient {
  readonly items = new Map<string, FixtureItem>();
  readonly commands: Array<GetItemCommand | DeleteItemCommand> = [];
  beforeDelete: ((command: DeleteItemCommand) => void) | undefined;

  seed(record: FixtureRecord, sessionId?: string) {
    this.items.set(`AUTH_MAGIC#${record.tokenId}`, {
      email: { S: record.email }, entityType: { S: "magicToken" },
      ...(sessionId ? { sessionId: { S: sessionId }, usedAt: { S: "2026-09-07T00:00:00Z" } } : {}),
    });
    if (sessionId) this.items.set(`AUTH_SESSION#${sessionId}`, {
      email: { S: record.email }, entityType: { S: "session" },
    });
  }

  async send(command: GetItemCommand | DeleteItemCommand): Promise<unknown> {
    this.commands.push(command);
    const key = command.input.Key?.pk?.S ?? "";
    expect(command.input.TableName).toBe(tableName);
    expect(command.input.Key?.sk?.S).toBe("METADATA");
    if (command instanceof GetItemCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      return { Item: structuredClone(this.items.get(key)) };
    }
    this.beforeDelete?.(command);
    const item = this.items.get(key);
    const condition = command.input.ConditionExpression ?? "";
    const values = command.input.ExpressionAttributeValues ?? {};
    expect(condition).toContain("#email = :email");
    expect(condition).toContain("#entityType = :entityType");
    expect(command.input.ExpressionAttributeNames).toEqual({ "#email": "email", "#entityType": "entityType" });
    let matches = !item || (item.email?.S === values[":email"]?.S && item.entityType?.S === values[":entityType"]?.S);
    if (item && condition.includes("attribute_not_exists(usedAt)")) matches &&= !item.usedAt;
    if (item && condition.includes("attribute_not_exists(sessionId)")) matches &&= !item.sessionId;
    if (item && condition.includes("sessionId = :sessionId")) matches &&= item.sessionId?.S === values[":sessionId"]?.S;
    if (!matches) throw Object.assign(new Error("conditional_failure"), { name: "ConditionalCheckFailedException" });
    this.items.delete(key);
    return {};
  }
}

test("QA cleanup discovers completion committed between its token read and delete", async () => {
  const client = new CleanupDynamoFake();
  const record = { tokenId: "fixture-token-a", email: "fixture-a@example.com" };
  client.seed(record);
  let completeOnDelete = true;
  client.beforeDelete = command => {
    if (completeOnDelete && command.input.Key?.pk?.S === `AUTH_MAGIC#${record.tokenId}`) {
      completeOnDelete = false;
      client.seed(record, "fixture-session-a");
    }
  };
  const report = await cleanupQaFixtures(client, [record], []);
  expect(report).toEqual({ contextsClosed: 0, recordsRemoved: 1, failures: [] });
  expect(client.items.size).toBe(0);
  const deletes = client.commands.filter(command => command instanceof DeleteItemCommand);
  expect(deletes).toHaveLength(3);
  expect(deletes[0].input.ConditionExpression).toContain("attribute_not_exists(usedAt)");
  expect(deletes[0].input.ConditionExpression).toContain("attribute_not_exists(sessionId)");
  expect(deletes[2].input.ConditionExpression).toContain("sessionId = :sessionId");
});

test("QA cleanup follows a changed owned session association before deleting its token", async () => {
  const client = new CleanupDynamoFake();
  const record = { tokenId: "fixture-token-b", email: "fixture-b@example.com" };
  client.seed(record, "fixture-session-before");
  let changeOnDelete = true;
  client.beforeDelete = command => {
    if (changeOnDelete && command.input.Key?.pk?.S === `AUTH_MAGIC#${record.tokenId}`) {
      changeOnDelete = false;
      client.seed(record, "fixture-session-after");
    }
  };
  const report = await cleanupQaFixtures(client, [record], []);
  expect(report.failures).toEqual([]);
  expect(client.items.size).toBe(0);
  expect(client.commands.filter(command => command instanceof DeleteItemCommand &&
    command.input.Key?.pk?.S?.startsWith("AUTH_SESSION#"))).toHaveLength(2);
});

test("QA cleanup refuses mismatched token ownership or entity type without deletion", async () => {
  for (const changedField of ["email", "entityType"] as const) {
    const client = new CleanupDynamoFake();
    const record = { tokenId: "fixture-token-c", email: "fixture-c@example.com" };
    client.seed(record);
    client.items.get(`AUTH_MAGIC#${record.tokenId}`)![changedField] = { S: "not-owned" };
    const before = structuredClone(client.items);
    const report = await cleanupQaFixtures(client, [record], []);
    expect(report).toEqual({ contextsClosed: 0, recordsRemoved: 0, failures: ["fixture_owner_mismatch"] });
    expect(client.items).toEqual(before);
    expect(client.commands.some(command => command instanceof DeleteItemCommand)).toBe(false);
  }
});

test("QA cleanup refuses session ownership collisions including a change after reading", async () => {
  for (const afterRead of [false, true]) {
    for (const changedField of ["email", "entityType"] as const) {
      const client = new CleanupDynamoFake();
      const record = { tokenId: "fixture-token-d", email: "fixture-d@example.com" };
      client.seed(record, "fixture-session-collision");
      const collide = () => {
        client.items.get("AUTH_SESSION#fixture-session-collision")![changedField] = { S: "not-owned" };
      };
      if (afterRead) client.beforeDelete = command => {
        if (command.input.Key?.pk?.S === "AUTH_SESSION#fixture-session-collision") collide();
      };
      else collide();
      const report = await cleanupQaFixtures(client, [record], []);
      expect(report.failures).toEqual(["fixture_owner_mismatch"]);
      expect(report.recordsRemoved).toBe(0);
      expect(client.items.size).toBe(2);
      expect(client.items.get("AUTH_SESSION#fixture-session-collision")?.[changedField]?.S).toBe("not-owned");
      expect(client.commands.some(command => command instanceof DeleteItemCommand &&
        command.input.Key?.pk?.S === `AUTH_MAGIC#${record.tokenId}`)).toBe(false);
    }
  }
});

test("QA cleanup continues every context and record after failures without leaking details", async () => {
  const client = new CleanupDynamoFake();
  const first = { tokenId: "fixture-private-token", email: "fixture-private@example.com" };
  const second = { tokenId: "fixture-token-success", email: "fixture-success@example.com" };
  client.seed(first, "fixture-private-session");
  client.seed(second, "fixture-session-success");
  client.beforeDelete = command => {
    if (command.input.Key?.pk?.S === "AUTH_SESSION#fixture-private-session") {
      throw new Error("Raw backend detail: fixture-private-token, fixture-private-session, bearer-secret");
    }
  };
  const closed: number[] = [];
  const contexts = [0, 1, 2].map(index => ({ async close() {
    closed.push(index);
    if (index === 0) throw new Error("Raw browser detail: bearer-secret");
  } }));
  const report = await cleanupQaFixtures(client, [first, second], contexts);
  expect(closed).toEqual([0, 1, 2]);
  expect(report).toEqual({
    contextsClosed: 2, recordsRemoved: 1, failures: ["context_close_failed", "cleanup_storage_failure"],
  });
  expect(client.items.has(`AUTH_MAGIC#${first.tokenId}`)).toBe(true);
  expect(client.items.has("AUTH_SESSION#fixture-private-session")).toBe(true);
  expect(client.items.has(`AUTH_MAGIC#${second.tokenId}`)).toBe(false);
  expect(client.items.has("AUTH_SESSION#fixture-session-success")).toBe(false);
  expect(JSON.stringify(report)).not.toMatch(/fixture|bearer-secret/);
});

test("QA cleanup bounds repeated conditional races and preserves unresolved fixture records", async () => {
  const client = new CleanupDynamoFake();
  const record = { tokenId: "fixture-token-racing", email: "fixture-racing@example.com" };
  client.seed(record);
  client.beforeDelete = () => {
    throw Object.assign(new Error("conditional_failure"), { name: "ConditionalCheckFailedException" });
  };
  const report = await cleanupQaFixtures(client, [record], []);
  expect(report).toEqual({ contextsClosed: 0, recordsRemoved: 0, failures: ["cleanup_race_limit"] });
  expect(client.commands.filter(command => command instanceof DeleteItemCommand)).toHaveLength(5);
  expect(client.items.size).toBe(1);
});

test("QA cleanup accepts already missing records but retains inconsistent used tokens", async () => {
  const client = new CleanupDynamoFake();
  const missing = { tokenId: "fixture-token-missing", email: "fixture-missing@example.com" };
  const linked = { tokenId: "fixture-token-linked", email: "fixture-linked@example.com" };
  const invalid = { tokenId: "fixture-token-invalid", email: "fixture-invalid@example.com" };
  client.seed(linked, "fixture-session-missing");
  client.items.delete("AUTH_SESSION#fixture-session-missing");
  client.seed(invalid);
  client.items.get(`AUTH_MAGIC#${invalid.tokenId}`)!.usedAt = { S: "2026-09-07T00:00:00Z" };
  const report = await cleanupQaFixtures(client, [missing, linked, invalid], []);
  expect(report).toEqual({ contextsClosed: 0, recordsRemoved: 2, failures: ["fixture_state_invalid"] });
  expect(client.items.size).toBe(1);
  expect(client.items.has(`AUTH_MAGIC#${invalid.tokenId}`)).toBe(true);
});
