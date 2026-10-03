// Offline planning only. This module cannot access AWS or write a table.
import { createHash, randomBytes, randomUUID } from "node:crypto";

const teams = ["red", "blue", "yellow"];
const gameTypes = new Set(["game", "gameTeam", "gamePlayer", "roster", "goal", "goalEventId", "goalState", "goalAudit", "goalCorrectionOperation"]);
export const excludedTypes = ["playerProof", "playerProofPointer", "leagueInvite", "leagueInvitePointer", "idempotency", "gameJoinReceipt", "ownedPlayerJoinReceipt"];
const fail = code => { throw new Error(`Import validation: ${code}`); };
const need = (condition, code) => { if (!condition) fail(code); };
const hash = value => createHash("sha256").update(value).digest("hex");
export const projection = (prefix, ...ids) => `${prefix}#${hash(JSON.stringify(ids))}`;
export const subject = email => `magic-link:${createHash("sha256").update(email.trim().toLowerCase()).digest("base64url")}`;
export const key = item => JSON.stringify([item.pk?.S, item.sk?.S]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const digest = value => hash(JSON.stringify(canonical(value)));
export const inventoryDigest = items => digest([...items].sort((a, b) => key(a).localeCompare(key(b), "en")));
export function decode(item) {
  let data;
  try { data = JSON.parse(item.data.S); } catch { fail("invalid_payload"); }
  need(data && typeof data === "object" && !Array.isArray(data), "invalid_payload");
  return data;
}
export function envelope(pk, sk, type, data, at) {
  return { pk: { S: pk }, sk: { S: sk }, entityType: { S: type }, data: { S: JSON.stringify(data) }, createdAt: { S: at }, updatedAt: { S: at } };
}
const freshCode = () => [...randomBytes(8)].map(n => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[n % 32]).join("");
const claimKey = id => Buffer.byteLength(`PLAYER#${id}`) <= 1024 ? `PLAYER#${id}` : `PLAYER_HASH#${hash(id)}`;

/** Explicit scope; preserve source IDs and history, regenerate only projections/capabilities. */
export function buildPlan(source, scope, options = {}) {
  const at = options.at ?? new Date().toISOString(), nonce = options.nonce ?? randomUUID();
  const code = options.code ?? freshCode;
  const { leagueId, seasonId, excludedGameIds, adminEmails = [], adminPlayerIds = [], ownershipMappings = [] } = scope;
  need(Array.isArray(ownershipMappings) && ownershipMappings.every(t => t && typeof t.playerId === "string" &&
    /^magic-link:[A-Za-z0-9_-]{43}$/.test(t.expectedOwner ?? "") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.toEmail ?? "")), "invalid_ownership_transfer");
  need(new Set(ownershipMappings.map(t => t.playerId)).size === ownershipMappings.length, "duplicate_ownership_transfer");
  need([leagueId, seasonId].every(x => typeof x === "string" && x.length > 0), "invalid_scope");
  need(Array.isArray(excludedGameIds) && new Set(excludedGameIds).size === excludedGameIds.length, "invalid_exclusions");
  need(Array.isArray(adminEmails) && Array.isArray(adminPlayerIds) && adminEmails.length + adminPlayerIds.length === 2 &&
    adminPlayerIds.every(id => typeof id === "string" && id.length > 0) && adminEmails.every(e => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)), "two_admin_accounts_required");
  const emails = adminEmails.map(e => e.trim().toLowerCase());
  need(new Set(emails).size === emails.length && new Set(adminPlayerIds).size === adminPlayerIds.length, "duplicate_admin_accounts");
  const byKey = new Map();
  for (const item of source) {
    need(typeof item.pk?.S === "string" && typeof item.sk?.S === "string" && item.entityType?.S, "invalid_envelope");
    need(!byKey.has(key(item)), "duplicate_source_key"); byKey.set(key(item), item);
  }
  const get = (pk, sk, type) => {
    const row = byKey.get(JSON.stringify([pk, sk]));
    need(row && row.entityType.S === type, `missing_${type}`); return row;
  };
  const rows = source.map(item => ({ item, type: item.entityType.S, d: decode(item) }));
  const gameRows = rows.filter(r => r.type === "game" && r.d.leagueId === leagueId && r.d.seasonId === seasonId);
  const allGameIds = new Set(gameRows.map(r => r.d.gameId));
  need(excludedGameIds.every(id => allGameIds.has(id)), "unknown_excluded_game");
  const games = gameRows.filter(r => !excludedGameIds.includes(r.d.gameId));
  need(games.length > 0 && games.every(r => ["finished", "scheduled"].includes(r.d.status)), "live_or_unknown_game_state");
  const gameIds = new Set(games.map(r => r.d.gameId)), sessionIds = new Set(games.map(r => r.d.sessionId));
  need(gameIds.size === games.length, "duplicate_game_id");
  const output = new Map(), copiedKeys = new Set(), transformedKeys = new Set();
  const add = (item, copied = false) => {
    const k = key(item);
    need(!output.has(k), "duplicate_target_key");
    need(item.createdAt?.S && item.updatedAt?.S && !item.expiresAtEpoch, "invalid_durable_envelope");
    output.set(k, structuredClone(item)); (copied ? copiedKeys : transformedKeys).add(k);
  };
  const create = (pk, sk, type, data) => add(envelope(pk, sk, type, data, at));
  const copy = (pk, sk, type) => add(get(pk, sk, type), true);
  copy(`LEAGUE#${leagueId}`, "METADATA", "league");
  need(decode(get(`LEAGUE#${leagueId}`, "METADATA", "league")).leagueId === leagueId, "league_payload_scope");
  for (const [pk, sk] of [[`LEAGUE#${leagueId}`, `SEASON#${seasonId}`], [`SEASON#${seasonId}`, "METADATA"]]) {
    const row = get(pk, sk, "season"), d = decode(row);
    need(d.leagueId === leagueId && d.seasonId === seasonId, "season_mirror_scope"); add(row, true);
  }
  for (const r of rows) {
    const { item, type, d } = r;
    if (type === "team" && d.seasonId === seasonId && d.leagueId === leagueId) {
      need((item.pk.S === `LEAGUE#${leagueId}` && item.sk.S === `SEASON#${seasonId}#TEAM#${d.teamId}`) ||
        (item.pk.S === `SEASON#${seasonId}` && item.sk.S === `TEAM#${d.teamId}`), "team_key");
      need(teams.includes(d.teamId), "team_id"); add(item, true);
    }
    if (type === "session" && d.seasonId === seasonId && sessionIds.has(d.sessionId)) {
      need(d.leagueId === leagueId || d.leagueId === undefined, "session_scope");
      need((item.pk.S === `LEAGUE#${leagueId}` && item.sk.S === `SEASON#${seasonId}#SESSION#${d.sessionId}`) ||
        (item.pk.S === `SEASON#${seasonId}` && item.sk.S === `SESSION#${d.sessionId}`) ||
        (item.pk.S === `SESSION#${d.sessionId}` && item.sk.S === "METADATA"), "session_key"); add(item, true);
    }
  }
  for (const sessionId of sessionIds) {
    const owned = [...output.values()].filter(x => x.entityType.S === "session" && decode(x).sessionId === sessionId);
    // Old games predate scoped rows (and some mirrors). The already-validated
    // global season mirror supplies provenance exactly as compatibility reads do.
    need(owned.length > 0 && new Set(owned.map(x => decode(x).sessionDate)).size === 1, "missing_or_conflicting_session");
    for (const [pk, sk] of [[`LEAGUE#${leagueId}`, `SEASON#${seasonId}#SESSION#${sessionId}`], [`SESSION#${sessionId}`, "METADATA"]]) {
      if (!output.has(JSON.stringify([pk, sk]))) {
        const collision = byKey.get(JSON.stringify([pk, sk]));
        // Date-based global mirrors can have been overwritten by an unrelated
        // QA season. Never copy that foreign row. For an empty destination,
        // reconstruct our mirror from proven season-owned data instead.
        need(!collision || (pk === `SESSION#${sessionId}` && collision.entityType.S === "session" &&
          decode(collision).sessionId === sessionId && decode(collision).seasonId !== seasonId), "conflicting_session_address");
        add({ ...owned[0], pk: { S: pk }, sk: { S: sk }, data: { S: JSON.stringify({ ...decode(owned[0]), leagueId }) } });
      }
    }
  }
  const selected = rows.filter(r => gameIds.has(r.item.pk.S.slice("GAME#".length)) && r.item.pk.S.startsWith("GAME#"));
  const ids = new Set();
  const reference = id => { need(typeof id === "string" && id.length > 0, "invalid_player_reference"); ids.add(id); };
  // Includes deleted/corrected-event snapshots, not just today's timeline.
  const references = value => {
    if (!value || typeof value !== "object") return;
    for (const [field, child] of Object.entries(value)) {
      if (["playerId", "scorerPlayerId"].includes(field)) reference(child);
      else if (field === "assistPlayerIds") { need(Array.isArray(child), "invalid_assists"); child.forEach(reference); }
      else references(child);
    }
  };
  const oldCodes = new Set(rows.filter(r => r.type === "game").map(r => r.d.joinCode).filter(Boolean)), newCodes = new Set();
  for (const r of selected) {
    if (excludedTypes.includes(r.type)) continue;
    need(gameTypes.has(r.type), "unknown_game_record");
    need(r.d.gameId && r.item.pk.S === `GAME#${r.d.gameId}` && gameIds.has(r.d.gameId), "game_record_scope");
    references(r.d);
    if (r.type === "game") {
      need(r.item.sk.S === "METADATA", "game_key");
      let joinCode;
      for (let tries = 0; tries < 100; tries++) { const candidate = code(r.d.gameId); if (!oldCodes.has(candidate) && !newCodes.has(candidate)) { joinCode = candidate; break; } }
      need(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(joinCode ?? ""), "join_code_generation"); newCodes.add(joinCode);
      const d = { ...r.d, joinCode }; delete d.createRequestHash;
      add({ ...r.item, data: { S: JSON.stringify(d) } });
      create(`JOIN_CODE#${joinCode}`, "METADATA", "gameJoinCode", { gameId: d.gameId, joinCode });
    } else {
      const sk = r.item.sk.S;
      const validKey = { gameTeam: () => sk === `TEAM#${r.d.teamId}`, gamePlayer: () => sk === `PLAYER#${r.d.playerId}`,
        roster: () => sk === `ROSTER#${r.d.teamId}#${r.d.playerId}`, goal: () => sk === `GOAL#${r.d.third}#${String(r.d.gameMinute).padStart(4, "0")}#${String(r.d.elapsedSeconds).padStart(6, "0")}#${r.d.eventId}`,
        goalEventId: () => sk === `GOAL_EVENT#${r.d.eventId}`, goalState: () => sk === "GOAL_STATE",
        goalAudit: () => sk.startsWith("AUDIT#GOAL#") && sk.endsWith(`#${r.d.auditId}`),
        goalCorrectionOperation: () => sk === `GOAL_CORRECTION#${r.d.operationId}` };
      need(validKey[r.type]?.(), "game_record_key"); add(r.item, true);
    }
  }
  const directlyReferenced = ids.size;
  for (const id of ids) {
    const identity = decode(get(`PLAYER#${id}`, "IDENTITY", "playerIdentity"));
    need(identity.playerId === id && typeof identity.rootId === "string" && Array.isArray(identity.members), "identity_shape");
    ids.add(identity.rootId); identity.members.forEach(reference);
    need(ids.size <= 5000, "identity_closure_budget");
  }
  const identities = new Map(), roots = new Set();
  for (const id of ids) {
    const profile = decode(get(`PLAYER#${id}`, "PROFILE", "player")), identity = decode(get(`PLAYER#${id}`, "IDENTITY", "playerIdentity"));
    need(profile.playerId === id && typeof profile.nickname === "string" && (profile.claimedByUserId === null || typeof profile.claimedByUserId === "string"), "profile_shape");
    const root = decode(get(`PLAYER#${identity.rootId}`, "IDENTITY", "playerIdentity"));
    need(root.rootId === root.playerId && root.members.includes(id) && root.members.length <= 20 && new Set(root.members).size === root.members.length, "identity_closure");
    need(id === identity.rootId || identity.members.length === 0, "alias_members");
    need(root.members.every(member => decode(get(`PLAYER#${member}`, "IDENTITY", "playerIdentity")).rootId === root.playerId), "identity_backreference");
    identities.set(id, identity); roots.add(identity.rootId);
    copy(`PLAYER#${id}`, "IDENTITY", "playerIdentity");
  }
  // Account repair is explicit and conditional on the observed canonical owner.
  // Preserve unclaimed aliases; transfer every claimed member in this group so
  // no historical alias can retain authority for the former account.
  const transfers = new Map();
  for (const transfer of ownershipMappings) {
    need(roots.has(transfer.playerId), "transfer_requires_selected_root");
    const owner = decode(get(`PLAYER#${transfer.playerId}`, "PROFILE", "player")).claimedByUserId;
    const next = subject(transfer.toEmail);
    need(owner === transfer.expectedOwner, "transfer_owner_precondition");
    need(owner === next || !rows.some(r => r.type === "player" && r.d.claimedByUserId === next &&
      !identities.get(transfer.playerId).members.includes(r.d.playerId)), "transfer_destination_already_claimed");
    need(![...transfers.values()].some(t => t.to === next), "duplicate_transfer_destination");
    need(identities.get(transfer.playerId).members.every(id => {
      const current = decode(get(`PLAYER#${id}`, "PROFILE", "player")).claimedByUserId;
      return current === null || current === owner;
    }), "conflicting_claim_owners");
    transfers.set(transfer.playerId, { from: owner, to: next });
  }
  const targetProfile = id => decode(output.get(JSON.stringify([`PLAYER#${id}`, "PROFILE"])));
  for (const id of ids) {
    const row = get(`PLAYER#${id}`, "PROFILE", "player"), d = decode(row), transfer = transfers.get(identities.get(id).rootId);
    if (transfer && transfer.from !== transfer.to && d.claimedByUserId !== null) add({ ...row, updatedAt: { S: at }, data: { S: JSON.stringify({ ...d, claimedByUserId: transfer.to }) } });
    else add(row, true);
  }
  // A player shared with unselected scope needs a separate reviewed plan.
  for (const r of rows.filter(r => ids.has(r.d.playerId))) {
    if (r.type === "playerGameMembership") need(r.d.leagueId === leagueId && r.d.seasonId === seasonId &&
      (gameIds.has(r.d.gameId) || excludedGameIds.includes(r.d.gameId)), "external_player_membership");
    if (r.type === "playerSeasonMembership") need(r.d.leagueId === leagueId && r.d.seasonId === seasonId, "external_player_membership");
    if (r.type === "playerLeagueMembership" || r.type === "leaguePlayerCreation") need(r.d.leagueId === leagueId, "external_player_membership");
  }
  const registrationPairs = new Map();
  for (const r of selected.filter(r => ["gamePlayer", "roster"].includes(r.type))) registrationPairs.set(JSON.stringify([r.d.playerId, r.d.gameId]), r.d);
  const seasonPlayers = new Set();
  for (const d of registrationPairs.values()) {
    const g = games.find(g => g.d.gameId === d.gameId).d;
    create(`PLAYER#${d.playerId}`, projection("GAME", d.gameId), "playerGameMembership", { playerId: d.playerId, gameId: d.gameId, leagueId, seasonId, gameStartTs: g.gameStartTs, registeredPlayerId: d.playerId });
    seasonPlayers.add(d.playerId);
  }
  for (const id of seasonPlayers) create(`PLAYER#${id}`, projection("SEASON", leagueId, seasonId), "playerSeasonMembership", { playerId: id, leagueId, seasonId });
  const owners = new Set();
  for (const id of ids) {
    const identity = identities.get(id), active = roots.has(id);
    const hasSeason = (active ? identity.members : [id]).some(member => seasonPlayers.has(member));
    need(!active || hasSeason, "root_without_selected_membership");
    create(`LEAGUE#${leagueId}`, projection("PLAYER", id), "leaguePlayer", { playerId: id, nickname: identity.displayName,
      formerNames: identity.formerNames, active, seasonIds: hasSeason ? [seasonId] : [], hasMoreSeasons: false });
    if (active) {
      create(`PLAYER#${id}`, projection("LEAGUE", leagueId), "playerLeagueMembership", { playerId: id, leagueId });
      const owner = targetProfile(id).claimedByUserId;
      need(identity.members.every(member => { const other = targetProfile(member).claimedByUserId; return other === null || other === owner; }), "conflicting_claim_owners");
      if (owner !== null) {
        // This rehearsal is for the current magic-link identity scheme only.
        need(/^magic-link:[A-Za-z0-9_-]{43}$/.test(owner), "unsupported_claim_owner");
        create(`USER#${owner}`, claimKey(id), "playerClaim", { userId: owner, playerId: id }); owners.add(owner);
      }
    }
  }
  for (const owner of owners) create(`USER#${owner}`, "PLAYER_CLAIMS_REVISION", "playerClaimsRevision", { revision: nonce });
  create(`LEAGUE#${leagueId}`, "PLAYER_DIRECTORY", "playerDirectoryRevision", { revision: nonce });
  const admins = [];
  const accounts = emails.map(email => [subject(email), email]);
  for (const playerId of adminPlayerIds) {
    need(roots.has(playerId), "admin_player_not_selected_root");
    need(!transfers.has(playerId) || transfers.get(playerId).from === transfers.get(playerId).to, "transferred_admin_requires_explicit_email");
    const owner = decode(get(`PLAYER#${playerId}`, "PROFILE", "player")).claimedByUserId;
    need(typeof owner === "string" && owner.length > 0, "admin_player_unclaimed"); accounts.push([owner]);
  }
  for (const accountIds of accounts) {
    const candidates = accountIds.map(id => byKey.get(JSON.stringify([`LEAGUE#${leagueId}`, `ACL#USER#${id}`]))).filter(Boolean);
    need(candidates.length > 0, "admin_account_not_found");
    const selectedAcl = candidates.find(row => { const d = decode(row); return row.entityType.S === "acl" && d.leagueId === leagueId && d.role === "admin" && row.sk.S === `ACL#USER#${d.userId}`; });
    need(selectedAcl, "admin_grant_invalid"); add(selectedAcl, true); admins.push(decode(selectedAcl).userId);
  }
  for (const g of games) {
    const d = g.d, sk = `GAME#${d.gameStartTs}#${d.gameId}`, row = get(`SESSION#${d.sessionId}`, sk, "sessionGame"), index = decode(row);
    need(index.gameId === d.gameId && index.sessionId === d.sessionId && index.leagueId === leagueId && index.seasonId === seasonId && index.gameStartTs === d.gameStartTs, "session_game_index"); add(row, true);
  }
  // Fresh destination control: never copy the QA coverage certification or epoch.
  create("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", { mode: "paused", coverage: "unknown", epoch: nonce, writerVersion: 1 });
  const items = [...output.values()].sort((a, b) => key(a).localeCompare(key(b), "en"));
  const plan = { version: 1, purpose: "disposable-rehearsal-only", at, nonce, scope: { leagueId, seasonId, excludedGameIds },
    sourceDigest: inventoryDigest(source), items, copiedKeys: [...copiedKeys].sort(), transformedKeys: [...transformedKeys].sort(),
    ownershipBindings: [...transfers].map(([playerId, t]) => ({ playerId, ...t })),
    admins, summary: { ownershipTransfers: [...transfers.values()].filter(t => t.from !== t.to).length, verifiedOwnershipBindings: transfers.size, games: games.length, sessions: sessionIds.size, goals: selected.filter(r => r.type === "goal").length,
      historicalPlayerIds: ids.size, directlyReferencedPlayerIds: directlyReferenced, canonicalPlayers: roots.size, claimedAccounts: owners.size, adminGrants: admins.length,
      copiedRows: copiedKeys.size, generatedOrTransformedRows: transformedKeys.size, totalRows: items.length } };
  validatePlan(plan);
  return { ...plan, planDigest: digest(plan) };
}

/** Validate relational and scoring invariants independently of AWS. */
export function validatePlan(plan) {
  if (plan.planDigest) { const { planDigest, ...body } = plan; need(digest(body) === planDigest, "plan_digest"); }
  need(plan.version === 1 && plan.purpose === "disposable-rehearsal-only", "plan_purpose");
  const rows = plan.items.map(item => ({ item, d: decode(item), type: item.entityType.S }));
  need(new Set(plan.items.map(key)).size === plan.items.length, "duplicate_plan_key");
  need(!rows.some(r => excludedTypes.includes(r.type)), "capability_or_retry_record");
  const profiles = new Set(rows.filter(r => r.type === "player").map(r => r.d.playerId));
  const games = rows.filter(r => r.type === "game");
  const { leagueId, seasonId, excludedGameIds } = plan.scope;
  need(games.length === plan.summary.games && games.every(r => r.d.leagueId === leagueId && r.d.seasonId === seasonId && !excludedGameIds.includes(r.d.gameId)), "plan_scope");
  need(rows.filter(r => r.type === "acl").length === 2 && new Set(plan.admins).size === 2, "plan_admin_count");
  for (const r of rows.filter(r => r.type === "acl")) need(plan.admins.includes(r.d.userId) && r.d.role === "admin", "plan_admin_scope");
  for (const g of games) {
    const scoped = rows.filter(r => r.item.pk.S === `GAME#${g.d.gameId}`);
    const roster = scoped.filter(r => r.type === "roster"), registrations = scoped.filter(r => r.type === "gamePlayer");
    need(roster.every(r => profiles.has(r.d.playerId) && registrations.some(p => p.d.playerId === r.d.playerId)), "roster_registration");
    need(new Set(roster.map(r => r.d.playerId)).size === roster.length, "multiple_roster_teams");
    const tally = Object.fromEntries(teams.map(t => [t, { scored: 0, conceded: 0 }]));
    const goals = scoped.filter(r => r.type === "goal");
    if (g.d.status === "scheduled") need(goals.length === 0 && g.d.result === null &&
      (g.d.thirds ?? []).every(t => t.startedAt === null && t.finishedAt === null), "scheduled_game_has_played_state");
    for (const { d } of goals) {
      need(teams.includes(d.concedingTeamId) && typeof d.ownGoal === "boolean" && (d.ownGoal ? d.scoringTeamId === null : teams.includes(d.scoringTeamId) && d.scoringTeamId !== d.concedingTeamId), "goal_teams");
      need(Array.isArray(d.assistPlayerIds) && d.assistPlayerIds.length <= 3 && new Set(d.assistPlayerIds).size === d.assistPlayerIds.length && !d.assistPlayerIds.includes(d.scorerPlayerId), "goal_assists");
      need([d.scorerPlayerId, ...d.assistPlayerIds].every(id => profiles.has(id) && roster.some(r => r.d.playerId === id)), "goal_player_roster");
      tally[d.concedingTeamId].conceded++; if (!d.ownGoal) tally[d.scoringTeamId].scored++;
      need(scoped.some(r => r.type === "goalEventId" && r.d.eventId === d.eventId), "goal_marker");
    }
    const savedTeams = scoped.filter(r => r.type === "gameTeam");
    need(savedTeams.length === 3 && new Set(savedTeams.map(r => r.d.teamId)).size === 3, "three_game_teams");
    for (const { d } of savedTeams) need(tally[d.teamId] && ["scored", "conceded"].every(k => (d[k] ?? 0) === tally[d.teamId][k]), "score_timeline_mismatch");
    if (g.d.result !== null) {
      const ranked = [...teams].sort((a, b) => tally[a].conceded - tally[b].conceded || tally[b].scored - tally[a].scored);
      const tied = ranked.filter(t => tally[t].scored === tally[ranked[0]].scored && tally[t].conceded === tally[ranked[0]].conceded);
      need(g.d.result?.winnerTeamId === (tied.length === 1 ? tied[0] : null), "result_winner_mismatch");
    }
    const identityByPlayer = new Map(rows.filter(r => r.type === "playerIdentity").map(r => [r.d.playerId, r.d.rootId]));
    const roots = registrations.map(r => identityByPlayer.get(r.d.playerId));
    need(roots.every(Boolean) && new Set(roots).size === roots.length, "canonical_registration_conflict");
  }
  return true;
}
