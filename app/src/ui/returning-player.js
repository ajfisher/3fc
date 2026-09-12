(() => {
  const prefix = "threefc.returning-join.v1:";
  const identity = session => session?.subject ?? session?.email;
  const text = value => typeof value === "string" && value.trim().length > 0;
  function validPlayerId(value) {
    if (!text(value)) return false;
    try { return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "x").length <= 2041; }
    catch { return false; }
  }
  function validSavedAttempt(value, accountId, joinCode) {
    const body = value?.body, key = value?.idempotencyKey;
    return value?.joinCode === joinCode && text(value.gameId) && text(value.nickname) &&
      body && !Array.isArray(body) && Object.keys(body).sort().join(",") === "expectedAccountId,playerId" &&
      body.expectedAccountId === accountId && text(accountId) && accountId.length <= 2048 && validPlayerId(body.playerId) &&
      text(key) && key.trim().length <= 128 && !/[^\t\x20-\x7e\x80-\xff]/.test(key);
  }
  function node(tag, content, attributes = {}) {
    const element = document.createElement(tag); if (content !== undefined) element.textContent = content;
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }
  function initialize({ joinCode, onSession, onCreate, onLock }) {
    const host = document.getElementById("returning-player"); if (!host) return null;
    const status = node("p", "", { role: "status", "aria-live": "polite", tabindex: "-1" });
    const content = node("div", undefined, { "data-ui": "returning-player-content" }); host.append(status, content);
    const base = document.body.dataset.apiBaseUrl || location.origin;
    const route = `/v1/join/${encodeURIComponent(joinCode)}`;
    let owner = null, generation = 0, invalidated = false, busy = false, complete = false, cursor = null;
    let failed = false, invalidSaved = false, selected = "", attempt = null, receipt = null, anonymous = false, gameId = null, leagueId = null;
    const players = new Map();
    const key = () => prefix + encodeURIComponent(identity(owner)) + ":" + encodeURIComponent(joinCode);
    function say(message, error = false) { status.textContent = message; status.hidden = !message; status.setAttribute("role", error ? "alert" : "status"); }
    function focusAfter(control) {
      let owned = control?.contains(document.activeElement) === true;
      const move = event => { if (event.target !== document.body && !control?.contains(event.target)) owned = false; };
      const leave = () => { owned = false; };
      document.addEventListener("focusin", move); document.addEventListener("pointerdown", move); window.addEventListener("hashchange", leave);
      return () => { document.removeEventListener("focusin", move); document.removeEventListener("pointerdown", move); window.removeEventListener("hashchange", leave);
        if (owned && !invalidated && !host.hidden) { const target = status.hidden ? content : status; target.tabIndex = -1; target.focus(); } };
    }
    async function request(path, options = {}) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(new URL(path, base).href, { credentials: "include", cache: "no-store", ...options, signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw Object.assign(new Error("request_failed"), { status: response.status, code: body.code });
        return body;
      } finally { clearTimeout(timeout); }
    }
    function retire(message = "Your sign-in changed. Reload before joining.") {
      invalidated = true; generation += 1; players.clear(); selected = ""; receipt = null;
      content.replaceChildren(); onLock?.(); say(message, true);
    }
    function purge() {
      retire();
      try { for (const stored of Object.keys(sessionStorage)) if (stored.startsWith(prefix)) sessionStorage.removeItem(stored); }
      catch { say("Your browser couldn’t clear the saved join request. Close this tab before continuing.", true); }
    }
    window.addEventListener("threefc:player-proof-cleared", purge);
    window.addEventListener("threefc:player-proof-invalidated", purge);
    window.addEventListener("pagehide", () => { invalidated = true; generation += 1; });
    window.addEventListener("pageshow", event => {
      if (!event.persisted) return;
      // Re-read the session and durable attempt through a fresh controller;
      // never revive an in-flight request from a browser-history snapshot.
      if (typeof window.__THREEFC_NAVIGATE__ === "function") window.__THREEFC_NAVIGATE__(location.href, "reload");
      else location.reload();
    });
    async function verify() {
      let value;
      try { value = await request("/v1/auth/session"); }
      catch (error) { if (error.status === 401 && !owner) return null; throw error; }
      if (invalidated) return null;
      if (value.authenticated !== true || !text(value.session?.sessionId) || !text(identity(value.session))) throw new Error("session_unconfirmed");
      if (owner && (identity(owner) !== identity(value.session) || owner.sessionId !== value.session.sessionId)) { retire(); return null; }
      owner = value.session; onSession(owner); return owner;
    }
    function button(label, action, variant = "secondary") { const control = node("button", label, { type: "button", "data-ui": "button", "data-variant": variant });
      control.disabled = busy; control.addEventListener("click", action); content.append(control); return control; }
    function create() { if (busy || attempt || invalidated) return; host.hidden = true; onCreate(); }
    function render() {
      content.replaceChildren(); if (invalidated) return;
      if (receipt) {
        button("Join another player", create); return;
      }
      if (attempt) { button("Retry join", event => { void join(event.currentTarget); }); return; }
      if (invalidSaved) {
        button("Clear saved request", async event => {
          if (busy || invalidated) return;
          const current = generation, finish = focusAfter(event.currentTarget); busy = true; render();
          try {
            await verify(); if (current !== generation || invalidated) return;
            sessionStorage.removeItem(key());
            if (sessionStorage.getItem(key()) !== null) throw new Error("cleanup_failed");
            invalidSaved = false; failed = false; busy = false;
            await load(false);
          } catch {
            if (!invalidated) say("Your browser couldn’t clear the saved request. Allow site storage, then try again. No new join has been sent.", true);
          } finally { busy = false; render(); finish(); }
        }); return;
      }
      if (failed) { button("Retry", event => { void load(false, event.currentTarget); }); return; }
      if (anonymous) {
        const link = node("a", "Already played? Sign in", { "data-ui": "button-secondary", href: `/sign-in?returnTo=${encodeURIComponent(`/join/${joinCode}`)}` }); content.append(link); return;
      }
      if (busy && !players.size) return;
      if (!complete) {
        if (!busy) say("Load the rest of your players before choosing.");
        button("Load more players", event => { void load(true, event.currentTarget); }); return;
      }
      if (!players.size) {
        content.append(node("p", "Played before? Ask the organiser for a profile link."));
        button("Create new player", create, "primary"); return;
      }
      if (players.size === 1) {
        const player = [...players.values()][0]; selected = player.playerId;
        content.append(node("p", player.nickname));
        const context = details(player); if (context) content.append(node("p", context));
        button(`Join as ${player.nickname}`, event => { void join(event.currentTarget); }, "primary");
      } else {
        const field = node("div", undefined, { "data-ui": "field" });
        const select = node("select", undefined, { id: "returning-player-choice", "data-ui": "input" });
        select.append(node("option", "Choose player", { value: "" }));
        for (const player of players.values()) select.append(node("option", [player.nickname, details(player)].filter(Boolean).join(" · "), { value: player.playerId }));
        select.value = selected; select.disabled = busy;
        field.append(node("label", "Player", { for: select.id }), select); content.append(field);
        const submit = button("Join game", event => { void join(event.currentTarget); }, "primary"); submit.disabled = busy || !selected;
        select.addEventListener("change", () => { selected = select.value; submit.disabled = busy || !selected; });
        select.addEventListener("keydown", event => { if (event.key === "Enter" && selected) { event.preventDefault(); void join(select); } });
      }
      button("Create new player", create);
    }
    function details(player) { return [player.registeredPlayerId ? player.team ? `Already in ${player.team.name}` : "Already in this game" : "",
      ...player.seasons.map(season => season.name)].filter(Boolean).join(" · "); }
    async function load(append = false, control) {
      if (busy || invalidated || attempt) return;
      const current = generation, finish = focusAfter(control); busy = true; failed = false; say("Loading your players…"); render();
      try {
        const session = await verify(); if (current !== generation || invalidated) return;
        if (!session) { anonymous = true; onSession(null); say(""); onCreate({ anonymous: true }); return; }
        const saved = sessionStorage.getItem(key());
        if (saved) {
          const value = JSON.parse(saved);
          if (!validSavedAttempt(value, identity(owner), joinCode)) throw new Error("invalid_saved_request");
          attempt = { ...value, uncertain: true }; say("An earlier join could not be confirmed. Retry uses the same player."); return;
        }
        if (!append) { players.clear(); cursor = null; complete = false; selected = ""; }
        // The directory has several bounded source streams. Read at most four
        // pages sequentially per user action; never infer zero/one prematurely.
        for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
        const result = await request(`${route}/linked-players?${new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) })}`);
        if (current !== generation || invalidated) return;
        if (result.accountId !== identity(owner)) { retire(); return; }
        if (!text(result.gameId) || !text(result.leagueId) || !Array.isArray(result.players) || typeof result.complete !== "boolean" ||
          !(result.cursor === null || text(result.cursor)) || (result.complete ? result.cursor !== null : !text(result.cursor)) ||
          ((append || pageNumber > 0) && (result.gameId !== gameId || result.leagueId !== leagueId))) throw new Error("invalid_page");
        for (const player of result.players) {
          if (!text(player.playerId) || !text(player.nickname) || !Array.isArray(player.seasons) || player.seasons.some(season => !text(season.name) || !text(season.seasonId)) ||
            !(player.registeredPlayerId === null || text(player.registeredPlayerId)) || !(player.team === null || text(player.team?.name))) throw new Error("invalid_player");
        }
        gameId = result.gameId; leagueId = result.leagueId;
        for (const player of result.players) players.set(player.playerId, player);
        cursor = result.cursor; complete = result.complete;
        if (complete) break;
        }
        say("");
      } catch (error) {
        if (current !== generation || invalidated) return;
        if (owner && [401, 403].includes(error.status)) { retire("Sign in again, then reopen this join link."); return; }
        if (error.message === "invalid_saved_request" || error instanceof SyntaxError) {
          invalidSaved = true;
          say("This saved join request can’t be recovered. Clear it to reload your players and check existing game membership before choosing again. Clearing it does not join another player.", true);
        } else { failed = true; say("Couldn’t load your players. Try again.", true); }
      } finally { busy = false; render(); finish(); }
    }
    async function join(control) {
      if (busy || invalidated || (!attempt && (!complete || !players.has(selected)))) return;
      const current = generation, finish = focusAfter(control); busy = true;
      let dispatched = false;
      try {
        await verify(); if (current !== generation || invalidated) return;
        if (!attempt) { const player = players.get(selected); attempt = { joinCode, nickname: player.nickname, gameId,
          body: { playerId: selected, expectedAccountId: identity(owner) }, idempotencyKey: crypto.randomUUID(), uncertain: false }; }
        sessionStorage.setItem(key(), JSON.stringify(attempt));
        say("Joining game…"); render(); dispatched = true;
        const result = await request(`${route}/linked-player`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.idempotencyKey }, body: JSON.stringify(attempt.body) });
        if (current !== generation || invalidated) return;
        if (result.accountId !== identity(owner)) { retire(); return; }
        if (result.gameId !== attempt.gameId || result.joinCode !== joinCode || !text(result.player?.playerId) || !text(result.player?.nickname) ||
          result.link?.gameId !== result.gameId || result.link?.playerId !== result.player.playerId || typeof result.alreadyRegistered !== "boolean" ||
          !(result.team === null || text(result.team?.name))) throw new Error("invalid_receipt");
        sessionStorage.removeItem(key()); receipt = result; attempt = null;
        say(result.alreadyRegistered ? `${result.player.nickname} is already in this game.` : `${result.player.nickname} joined the game.`);
      } catch (error) {
        if (current !== generation || invalidated) return;
        if ([401, 403].includes(error.status)) { retire("Your sign-in or player access changed. Reload before joining."); return; }
        if (attempt && !attempt.uncertain && [400, 404, 409, 422].includes(error.status)) {
          try { sessionStorage.removeItem(key()); attempt = null; } catch { /* Keep frozen recovery if storage cleanup fails. */ }
        } else if (attempt && dispatched) { attempt.uncertain = true; try { sessionStorage.setItem(key(), JSON.stringify(attempt)); } catch { /* Earlier durable request remains. */ } }
        say(attempt ? "Joining could not be confirmed. Retry uses the same player." : "Could not join this player. Reload the player list and try again.", true);
        if (!attempt) { failed = true; players.clear(); }
      } finally { busy = false; render(); finish(); }
    }
    return { start: () => { host.hidden = false; void load(); }, hide: () => { host.hidden = true; },
      setRegistrationPending: pending => { if (anonymous) host.hidden = pending; },
      pending: () => busy || Boolean(attempt) };
  }
  window.ThreeFcReturningPlayer = Object.freeze({ initialize });
})();
