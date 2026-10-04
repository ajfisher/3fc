// Shared transaction engine. Production CLI owns provenance/freeze/approval;
// the rehearsal supplies a newly owned disposable table and exercises this engine.
import { GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { decode, digest, envelope, inventoryDigest, key, validatePlan } from "./season-import-plan.mjs";
const need = (ok, reason) => { if (!ok) throw new Error(`Cutover: ${reason}`); };
const controlKey = JSON.stringify(["PLAYER_IDENTITY", "CONTROL"]);
export const isControl = row => key(row) === controlKey;
// A verified identity migration now also leaves an explicitly disabled history
// activation fence. Preserve it through import; imported history needs a separate
// reviewed activation and rebuild before profiles can be exposed.
export const isDisabledHistory = row => row.pk?.S === "PLAYER_HISTORY" && row.sk?.S === "CONTROL" &&
  row.entityType?.S === "playerHistoryReadiness" && decode(row).version === 1 && decode(row).enabled === false;
export function cutoverManifest(plan, baseline, provenance) {
  validatePlan(plan);
  need(baseline.filter(isControl).length === 1 && baseline.every(i => isControl(i) || isDisabledHistory(i) ||
    (i.pk?.S?.startsWith("PLAYER_MIGRATION#") && i.entityType?.S === "playerIdentityMigration")), "destination must contain only identity system records");
  const control = decode(baseline.find(isControl));
  need(control.mode === "fenced" && control.coverage === "verified" && control.writerVersion === 1, "destination identity coverage must already be verified");
  const body = { version: 1, purpose: "selective-season-production-cutover", plan, baseline, provenance };
  return { ...body, digest: digest(body) };
}
export function validateCutover(manifest) {
  const { digest: expected, ...body } = manifest;
  need(digest(body) === expected, "manifest digest mismatch");
  need(manifest.version === 1 && manifest.purpose === "selective-season-production-cutover", "unsupported manifest");
  need(cutoverManifest(manifest.plan, manifest.baseline, manifest.provenance).digest === expected, "invalid manifest");
  const baselineKeys = new Set(manifest.baseline.map(key));
  need(manifest.plan.items.filter(i => !isControl(i)).every(i => !baselineKeys.has(key(i))), "baseline key collision");
}
const addr = row => ({ pk: row.pk, sk: row.sk });
const absent = { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" };
const equals = row => ({ ConditionExpression: "#data = :data AND #updated = :updated AND #type = :type AND #created = :created",
  ExpressionAttributeNames: { "#data": "data", "#updated": "updatedAt", "#type": "entityType", "#created": "createdAt" },
  ExpressionAttributeValues: { ":data": row.data, ":updated": row.updatedAt, ":type": row.entityType, ":created": row.createdAt } });

export class SeasonImportExecutor {
  constructor(client, table, manifest, { scan, guard, acceptance, progress = () => {} }) {
    validateCutover(manifest);
    need(table === "3fc-prod-app" || /^3fc-import-rehearsal-[a-f0-9-]{36}$/.test(table), "unsupported destination");
    need(typeof scan === "function" && typeof guard === "function" && typeof acceptance === "function", "execution guards required");
    Object.assign(this, { client, table, manifest, scan, guard, acceptance, progress });
    this.items = manifest.plan.items.filter(i => !isControl(i));
    this.auditKey = { pk: { S: `SEASON_IMPORT#${manifest.plan.nonce}` }, sk: { S: "AUDIT" } };
    this.paused = manifest.plan.items.find(isControl);
    this.active = envelope("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl",
      { ...decode(this.paused), mode: "fenced", coverage: "verified" }, manifest.plan.at);
  }
  audit(next, phase) {
    return envelope(this.auditKey.pk.S, "AUDIT", "seasonImportAudit",
      { manifestDigest: this.manifest.digest, next, phase, total: this.items.length }, this.manifest.plan.at);
  }
  async status() {
    const { Item } = await this.client.send(new GetItemCommand({ TableName: this.table, Key: this.auditKey, ConsistentRead: true }));
    if (Item) {
      const d = decode(Item);
      need(d.manifestDigest === this.manifest.digest && Number.isInteger(d.next) && d.next >= 0 && d.next <= this.items.length &&
        ["loading", "verified", "accepted"].includes(d.phase) && (d.phase === "loading" || d.next === this.items.length), "checkpoint ownership or shape mismatch");
      need(digest(Item) === digest(this.audit(d.next, d.phase)), "checkpoint changed");
    }
    return Item;
  }
  async transaction(parts, token) {
    await this.guard();
    await this.client.send(new TransactWriteItemsCommand({ ClientRequestToken: digest([this.manifest.digest, token]).slice(0, 36), TransactItems: parts }));
  }
  put(Item, previous) { return { Put: { TableName: this.table, Item, ...(previous ? equals(previous) : absent) } }; }
  check(Item) { return { ConditionCheck: { TableName: this.table, Key: addr(Item), ...equals(Item) } }; }
  expected(audit) {
    const { next, phase } = decode(audit);
    return [...this.manifest.baseline.filter(i => !isControl(i)), ...this.items.slice(0, next), phase === "loading" ? this.paused : this.active, audit];
  }
  async verify(audit) {
    await this.guard();
    need(inventoryDigest(await this.scan()) === inventoryDigest(this.expected(audit)), "destination differs from exact checkpoint inventory; retain freeze and investigate");
  }
  async run() {
    await this.guard();
    let audit = await this.status();
    if (!audit) {
      need(inventoryDigest(await this.scan()) === inventoryDigest(this.manifest.baseline), "destination changed before begin");
      audit = this.audit(0, "loading");
      await this.transaction([this.put(this.paused, this.manifest.baseline.find(isControl)), this.put(audit)], "begin");
    }
    await this.verify(audit); // A retry verifies all previously committed rows.
    while (decode(audit).next < this.items.length) {
      const start = decode(audit).next, chunk = []; let bytes = 0;
      for (const row of this.items.slice(start, start + 23)) {
        const size = Buffer.byteLength(JSON.stringify(row));
        need(size < 350000, "oversize source item");
        if (bytes + size > 3 * 1024 * 1024) break;
        chunk.push(row); bytes += size;
      }
      const next = this.audit(start + chunk.length, "loading");
      await this.transaction([this.check(this.paused), this.put(next, audit), ...chunk.map(row => this.put(row))], `rows-${start}`);
      audit = next;
      this.progress({ phase: "loading", records: decode(audit).next });
    }
    await this.verify(audit);
    if (decode(audit).phase === "loading") {
      const next = this.audit(this.items.length, "verified");
      await this.transaction([this.put(this.active, this.paused), this.put(next, audit)], "verify");
      audit = next;
    }
    // API concurrency stays zero through acceptance, including failures here.
    await this.guard();
    const result = await this.acceptance();
    await this.verify(audit);
    if (decode(audit).phase === "verified") {
      const next = this.audit(this.items.length, "accepted");
      await this.transaction([this.check(this.active), this.put(next, audit)], "accept");
      audit = next;
    }
    await this.verify(audit);
    return { phase: decode(audit).phase, records: this.items.length, acceptance: result };
  }
}
