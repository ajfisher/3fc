(() => {
  const KEY = "threefc.player-proof.v1";
  const CHANNEL = "threefc.player-proof.handoff.v1";
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const ID = /^[A-Za-z0-9_-]{20,64}$/;
  const SECRET = /^[A-Za-z0-9_-]{43}$/;
  const validAccount = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
  let generation = 0;
  let channel = null;
  let stopped = false;
  const waiting = new Map();
  let records = [];

  function valid(value) {
    return value && ID.test(value.proofId) && SECRET.test(value.secret) &&
      Number.isFinite(value.createdAt) && Number.isFinite(value.expiresAt) &&
      value.expiresAt > Date.now() && value.createdAt <= Date.now() && value.expiresAt <= value.createdAt + WEEK &&
      (!Object.hasOwn(value, "accountId") || validAccount(value.accountId));
  }
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed = raw && raw.length < 50_000 ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) records = parsed.filter(valid).slice(-20);
  } catch { /* A missing storage API produces an explicit recovery below. */ }

  function save(record) {
    if (!valid(record)) throw new Error("proof_unavailable");
    const prior = lookup(record.proofId);
    if (prior && (prior.secret !== record.secret ||
        (prior.accountId && record.accountId && prior.accountId !== record.accountId))) {
      clear();
      throw new Error("proof_account_changed");
    }
    const clean = { proofId: record.proofId, secret: record.secret, createdAt: record.createdAt, expiresAt: record.expiresAt,
      ...(prior?.accountId || record.accountId ? { accountId: prior?.accountId || record.accountId } : {}),
      ...(typeof record.operation === "string" && record.operation.length <= 400 ? { operation: record.operation } : {}),
      ...(typeof record.playerId === "string" && record.playerId.length <= 1024 ? { playerId: record.playerId } : {}),
    };
    const next = [...records.filter((item) => valid(item) && item.proofId !== clean.proofId), clean];
    if (next.length > 20) throw new Error("proof_storage_full");
    // Persist before dispatching a registration/invitation. Never issue a proof
    // whose only copy could disappear on the subsequent sign-in navigation.
    sessionStorage.setItem(KEY, JSON.stringify(next));
    records = next;
    return clean;
  }
  function lookup(id) { return records.find((record) => record.proofId === id && valid(record)) || null; }
  function discardDraft(record) {
    const current = lookup(record?.proofId);
    if (!current) return;
    if (current.secret !== record.secret || current.playerId) throw new Error("proof_not_draft");
    const next = records.filter((item) => item.proofId !== record.proofId);
    // If storage rejects cleanup, retain the attempt so retry cannot accumulate
    // fresh drafts or evict an unrelated live link.
    sessionStorage.setItem(KEY, JSON.stringify(next));
    records = next;
  }
  function cancelHandoffs() {
    generation += 1;
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.resolve(null); }
    waiting.clear();
    channel?.close(); channel = null;
  }
  function clear(broadcast = true) {
    records = [];
    try { sessionStorage.removeItem(KEY); } catch { /* No retained copy is available. */ }
    if (broadcast) try { channel?.postMessage({ version: 1, type: "purge" }); } catch { /* Local purge must still finish. */ }
    cancelHandoffs();
    window.dispatchEvent(new Event("threefc:player-proof-cleared"));
  }
  function connect() {
    stopped = false;
    if (channel || typeof BroadcastChannel !== "function") return;
    try { channel = new BroadcastChannel(CHANNEL); } catch { return; }
    channel.onmessage = (event) => {
      const message = event.data;
      if (!message || message.version !== 1) return;
      if (message.type === "purge") { clear(false); return; }
      if (message.type === "bound" && ID.test(message.proofId) && validAccount(message.accountId)) {
        const record = lookup(message.proofId);
        // Metadata only; never create a secret from an unsolicited message.
        // Existing holders must not later hand off an unbound copy.
        if (record) try { save({ ...record, accountId: message.accountId }); } catch { clear(); }
        for (const pending of waiting.values()) {
          if (pending.proofId !== message.proofId) continue;
          if (pending.accountId && pending.accountId !== message.accountId) { clear(); return; }
          pending.accountId = message.accountId;
        }
        return;
      }
      if (!ID.test(message.proofId) || !ID.test(message.nonce)) return;
      if (message.type === "request") {
        const record = lookup(message.proofId);
        if (record) channel?.postMessage({ version: 1, type: "response", proofId: message.proofId, nonce: message.nonce, record });
      } else if (message.type === "response") {
        const pending = waiting.get(message.nonce);
        if (!pending || pending.proofId !== message.proofId || !valid(message.record) || message.record.proofId !== message.proofId) return;
        if (pending.accountId && message.record.accountId && pending.accountId !== message.record.accountId) { clear(); return; }
        waiting.delete(message.nonce); clearTimeout(pending.timer);
        try { pending.resolve(save({ ...message.record, ...(pending.accountId ? { accountId: pending.accountId } : {}) })); }
        catch { pending.resolve(null); }
      }
    };
  }
  function random(bytes) {
    const values = crypto.getRandomValues(new Uint8Array(bytes));
    return btoa(String.fromCharCode(...values)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }
  async function verifier(record) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(record.secret));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function create(operation) {
    if (stopped || typeof operation !== "string" || !operation || operation.length > 400) throw new Error("proof_unavailable");
    const current = generation;
    const prior = records.find((record) => record.operation === operation && valid(record));
    const stamp = Date.now();
    const record = prior || save({ proofId: random(18), secret: random(32), createdAt: stamp, expiresAt: stamp + WEEK, operation });
    const digest = await verifier(record);
    if (current !== generation || stopped) throw new Error("proof_unavailable");
    return { ...record, verifier: digest };
  }
  async function read(id) {
    if (!ID.test(id) || stopped) return null;
    const own = lookup(id);
    if (own) return own;
    if (!channel) return null;
    const nonce = random(18);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(nonce); resolve(null); }, 2000);
      waiting.set(nonce, { proofId: id, resolve, timer });
      // Correlation only, not authentication: every same-origin receiver can
      // observe this exchange. The server validates the proof independently.
      channel.postMessage({ version: 1, type: "request", proofId: id, nonce });
    });
  }
  function attach(record, metadata, playerId) {
    if (lookup(record.proofId)?.secret !== record.secret) throw new Error("proof_cleared");
    if (metadata?.proofId !== record.proofId || !Number.isFinite(Date.parse(metadata.expiresAt))) throw new Error("proof_unconfirmed");
    // Local retention is bounded even when a slow request was committed later.
    return save({ ...record, playerId, expiresAt: Math.min(Date.parse(metadata.expiresAt), record.createdAt + WEEK) });
  }
  function destination(id) { return `/link-player?proofId=${encodeURIComponent(id)}`; }
  function shareLink(record) {
    const url = new URL("/link-player", location.origin);
    url.hash = new URLSearchParams({ proofId: record.proofId, secret: record.secret }).toString();
    return url.toString();
  }

  // Run before the auth/controller scripts. Fragments never reach the server,
  // and no secret enters a return target, log or history entry after capture.
  let captureFailed = false;
  if (/^\/link-player\/?$/.test(location.pathname)) {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const query = new URLSearchParams(location.search);
    const id = fragment.get("proofId") || query.get("proofId") || "";
    const secret = fragment.get("secret");
    try { history.replaceState(null, "", ID.test(id) ? destination(id) : "/link-player"); }
    catch { captureFailed = true; }
    if (secret) {
      const stamp = Date.now();
      try { save({ proofId: id, secret, createdAt: stamp, expiresAt: stamp + WEEK }); } catch { captureFailed = true; }
    }
  }
  connect();
  window.addEventListener("pagehide", () => { stopped = true; cancelHandoffs(); });
  window.addEventListener("pageshow", (event) => {
    connect();
    if (event.persisted && /^\/link-player\/?$/.test(location.pathname)) location.reload();
  });
  window.ThreeFcPlayerProof = Object.freeze({ create, read, attach, shareLink, destination, clear, discardDraft,
    forPlayer: (id) => records.findLast((record) => record.playerId === id && valid(record)) || null,
  });

  const panel = document.getElementById("player-link-panel");
  if (!panel) return;
  const status = document.getElementById("player-link-status");
  const details = document.getElementById("player-link-details");
  const confirm = document.getElementById("player-link-confirm");
  const retry = document.getElementById("player-link-retry");
  const signIn = document.getElementById("player-link-signin");
  const signOut = document.getElementById("sign-out");
  const accountActions = document.getElementById("account-actions");
  const proofId = new URLSearchParams(location.search).get("proofId") || "";
  let record = null;
  let preview = null;
  let pending = false;
  let accountEmail = "";
  window.addEventListener("threefc:player-proof-cleared", () => {
    record = null; preview = null;
    details.hidden = true; confirm.hidden = true; retry.hidden = true;
    message("Reopen the private link after signing in.", true);
  });

  function message(text, error = false) {
    status.textContent = text;
    status.hidden = !text;
    status.setAttribute("role", error ? "alert" : "status");
    status.dataset.state = error ? "error" : "success";
  }
  function navigate(url) {
    if (typeof window.__THREEFC_NAVIGATE__ === "function") window.__THREEFC_NAVIGATE__(url, "replace");
    else location.replace(url);
  }
  function ownFocus(control) {
    let owned = document.activeElement === control;
    const moved = (event) => { if (event.target !== control) owned = false; };
    const navigated = () => { owned = false; };
    document.addEventListener("focusin", moved);
    window.addEventListener("popstate", navigated);
    window.addEventListener("hashchange", navigated);
    return (target) => {
      document.removeEventListener("focusin", moved);
      window.removeEventListener("popstate", navigated);
      window.removeEventListener("hashchange", navigated);
      if (owned && target && !target.hidden) { if (target === status) target.tabIndex = -1; target.focus(); }
    };
  }
  function nextFocus() { return !confirm.hidden ? confirm : !retry.hidden ? retry : !signIn.hidden ? signIn : status; }
  function signedOutRecovery(finishFocus) {
    clear();
    accountActions.hidden = true;
    signIn.href = `/sign-in?returnTo=${encodeURIComponent(destination(proofId))}`;
    signIn.hidden = false;
    message("Sign in again, then reopen the private link.", true);
    finishFocus(signIn);
  }
  async function request(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const base = document.body.dataset.apiBaseUrl || location.origin;
      const response = await fetch(new URL(path, base), { method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (path === "/v1/auth/logout") {
        if (response.status !== 204) throw new Error("logout_unconfirmed");
        return null;
      }
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error("link_request_failed"), { status: response.status, code: data?.code });
      return data;
    } finally { clearTimeout(timer); }
  }
  async function load() {
    if (pending || stopped) return;
    const finishFocus = ownFocus(retry);
    pending = true;
    const current = generation;
    confirm.hidden = true; retry.hidden = true; signIn.hidden = true;
    details.hidden = true; preview = null;
    message("Loading player…");
    try {
      record = captureFailed ? null : await read(proofId);
      if (current !== generation || stopped) return;
      if (!record) {
        message("Reopen the private link after signing in. If it’s no longer available, ask the organiser for a new link.", true);
        signIn.href = `/sign-in?returnTo=${encodeURIComponent(destination(proofId))}`;
        signIn.hidden = false;
        return;
      }
      const result = await request("/v1/player-proofs/preview", { proofId, secret: record.secret });
      if (current !== generation || stopped) return;
      if (result.preview?.proofId !== proofId || typeof result.preview?.player?.nickname !== "string" ||
          typeof result.preview?.player?.playerId !== "string" || typeof result.preview?.confirmation !== "string" ||
          typeof result.preview?.alreadyLinked !== "boolean" || !Number.isFinite(Date.parse(result.preview?.expiresAt)) ||
          typeof result.preview?.league?.name !== "string" || typeof result.account?.email !== "string" ||
          !validAccount(result.account?.id)) throw new Error("preview_unconfirmed");
      // Persist before enabling confirmation. save compares the latest retained
      // binding too, including one received while this preview was in flight.
      try { record = save({ ...record, accountId: result.account.id }); }
      catch (error) {
        if (error.message === "proof_account_changed") {
          message("Your signed-in account changed. Reopen the private link to continue.", true);
          finishFocus(status); return;
        }
        throw error;
      }
      channel?.postMessage({ version: 1, type: "bound", proofId, accountId: record.accountId });
      preview = result.preview;
      accountEmail = result.account.email;
      document.getElementById("player-link-name").textContent = preview.player.nickname;
      document.getElementById("player-link-league").textContent = preview.league.name;
      document.getElementById("player-link-account").textContent = accountEmail;
      details.hidden = false;
      accountActions.hidden = false;
      signOut.disabled = false;
      confirm.hidden = preview.alreadyLinked === true;
      confirm.disabled = false;
      message(preview.alreadyLinked ? "This player is linked to your account." : "");
    } catch (error) {
      if (current !== generation || stopped) return;
      if (error.status === 401) {
        if (record?.accountId || lookup(proofId)?.accountId) { signedOutRecovery(finishFocus); return; }
        message(""); signIn.href = `/sign-in?returnTo=${encodeURIComponent(destination(proofId))}`; signIn.hidden = false;
      } else {
        message([403, 404, 409].includes(error.status)
          ? "This player link is no longer available. Ask the organiser for help."
          : "Could not load this player. Please try again.", true);
        retry.hidden = false;
      }
    } finally { pending = false; finishFocus(current === generation ? nextFocus() : null); }
  }
  confirm.addEventListener("click", async () => {
    if (pending || !preview || !record || stopped) return;
    const finishFocus = ownFocus(confirm);
    pending = true; confirm.disabled = true; signOut.disabled = true;
    const current = generation;
    message("Linking player…");
    try {
      const playerId = preview.player.playerId;
      if (typeof playerId !== "string" || !playerId.trim() || playerId.length > 1024) throw Object.assign(new Error("unaddressable_player"), { status: 409 });
      let component;
      try { component = encodeURIComponent(playerId); } catch { throw Object.assign(new Error("unaddressable_player"), { status: 409 }); }
      const result = await request(`/v1/player-proofs/claim?playerId=${component}`,
        { proof: { proofId, secret: record.secret, confirmation: preview.confirmation } });
      if (current !== generation || stopped) return;
      if (result.player?.playerId !== preview.player.playerId || result.claim?.claimedByCurrentUser !== true) throw new Error("claim_unconfirmed");
      confirm.hidden = true;
      message(`Player linked to ${accountEmail}.`);
    } catch (error) {
      if (current !== generation || stopped) return;
      if (error.status === 401 && (record?.accountId || lookup(proofId)?.accountId)) { signedOutRecovery(finishFocus); return; }
      if ([401, 403, 404, 409].includes(error.status)) {
        confirm.hidden = true; retry.hidden = false;
        message("Please check the player link and your signed-in account again before continuing.", true);
      } else {
        message("Linking could not be confirmed. Try again to check the same request.", true);
        confirm.disabled = false;
      }
    } finally { pending = false; signOut.disabled = false; finishFocus(current === generation ? nextFocus() : null); }
  });
  retry.addEventListener("click", () => { void load(); });
  signOut.addEventListener("click", async () => {
    if (pending || signOut.disabled) return;
    pending = true; signOut.disabled = true; confirm.disabled = true;
    clear();
    record = null; preview = null;
    details.hidden = true; confirm.hidden = true; retry.hidden = true;
    try {
      await request("/v1/auth/logout", {});
      navigate(`/sign-in?returnTo=${encodeURIComponent(destination(proofId))}`);
    } catch {
      message("Sign out could not be confirmed. Try again. Reopen the private link after signing in.", true);
      signOut.disabled = false;
    } finally { pending = false; }
  });
  void load();
})();
