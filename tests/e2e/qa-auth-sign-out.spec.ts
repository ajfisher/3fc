import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DeleteItemCommand, DescribeTableCommand, DynamoDBClient, GetItemCommand,
  type AttributeValue, type GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { MagicLinkService } from "../../api/dist/auth/magic-link.js";

// Explicit opt-in only. No email is sent, no AJ session is loaded, no games/ACLs
// are created or touched. Synthetic auth records are removed in finally.
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
    phase = "keyboard sign-out and cookie expiry";
    await page.goto(`${site}/setup`);
    const signOut = page.getByRole("button", { name: "Sign out", exact: true });
    await expect(signOut).toBeVisible();
    await verifySitePage(page, expectedHead);
    await signOut.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${site}/sign-in`);
    await expect(page.getByRole("heading", { name: "League organiser sign in" })).toBeVisible();
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
    console.log(`QA sign-out PASS head=${expectedHead} run=${runId}; live API fingerprint, isolated account switch, cookie expiry, revoked replay, protected re-entry verified`);
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
