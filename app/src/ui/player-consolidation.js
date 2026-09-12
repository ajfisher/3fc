(() => {
  const api = document.body.dataset.apiBaseUrl || location.origin;
  const validId = value => typeof value === "string" && value.trim().length > 0;
  const subject = session => session?.subject ?? session?.email;
  const urlFor = id => `/combine-players?${new URLSearchParams({ proposalId: id })}`;
  function element(tag, text, attrs = {}) {
    const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  }
  const button = text => element("button", text, { type: "button", "data-ui": "button", "data-variant": "secondary" });
  function focusOwner(control) {
    let owned = control?.contains(document.activeElement) === true;
    const moved = event => { if (event.target !== document.body && !control?.contains(event.target)) owned = false; };
    const navigated = () => { owned = false; };
    document.addEventListener("focusin", moved); document.addEventListener("pointerdown", moved);
    window.addEventListener("hashchange", navigated);
    return target => {
      document.removeEventListener("focusin", moved); document.removeEventListener("pointerdown", moved);
      window.removeEventListener("hashchange", navigated);
      if (owned && target?.isConnected && !target.closest("[hidden]")) { target.tabIndex = -1; target.focus(); }
    };
  }
  async function request(path, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(new URL(path, api), { method: body ? "POST" : "GET", credentials: "include", cache: "no-store",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: controller.signal });
      const data = response.status === 204 ? {} : await response.json();
      if (!response.ok) throw Object.assign(new Error("request_failed"), { status: response.status, code: data?.code });
      return data;
    } finally { clearTimeout(timeout); }
  }
  async function session() {
    const value = await request("/v1/auth/session");
    if (value.authenticated !== true || !validId(subject(value.session)) || !validId(value.session.sessionId)) throw Object.assign(new Error("session_unavailable"), { status: 401 });
    return value.session;
  }
  function validProposal(p) {
    return p && validId(p.proposalId) && validId(p.leagueId) && typeof p.leagueName === "string" &&
      typeof p.nickname === "string" && validId(p.retainedPlayerId) &&
      ["pending_approval", "ready", "declined", "committed", "stale"].includes(p.status) &&
      [p.requiresApproval, p.canApprove, p.canCommit].every(value => typeof value === "boolean") &&
      Array.isArray(p.blockers) && Array.isArray(p.profiles) && p.profiles.length >= 2 && p.profiles.length <= 20 &&
      p.profiles.every(profile => validId(profile.playerId) && typeof profile.nickname === "string" && typeof profile.claimed === "boolean" &&
        Array.isArray(profile.games) && profile.games.every(game => validId(game.gameId) && Number.isFinite(Date.parse(game.kickoffAt))));
  }
  function explanation(code) {
    if (/overlap|shared_game/.test(code || "")) return "These profiles appear in the same game and can’t be combined here.";
    if (/owner|claimed/.test(code || "")) return "These profiles are linked to different accounts, or need their owner’s approval.";
    if (/external|cross_league/.test(code || "")) return "One or more profiles can’t be combined from this league.";
    if (/coverage|migration|unavailable/.test(code || "")) return "Profile records aren’t ready to combine. Try again later.";
    if (/limit|large|size/.test(code || "")) return "This group is too large to combine here.";
    return "These profiles changed or can’t be combined. Review your selection and try again.";
  }
  function controller(panel, options) {
    const status = element("p", "", { role: "status", "aria-live": "polite" }); status.hidden = true;
    const accountBar = element("div", undefined, { "data-ui": "button-row" });
    const content = element("div"); const actions = element("div", undefined, { "data-ui": "button-row" });
    panel.append(accountBar, status, content, actions);
    let owner = null, proposal = null, attempt = null, previousRequest = null, pending = false, invalidated = false, generation = 0, signInNeeded = false, refreshFailed = false;
    const key = () => `threefc.consolidation.v1:${encodeURIComponent(subject(owner))}`;
    const say = (text, error = false) => { status.textContent = text; status.hidden = !text; status.setAttribute("role", error ? "alert" : "status"); };
    function persist(value) { sessionStorage.setItem(key(), JSON.stringify(value)); }
    function invalidate() {
      invalidated = true; generation += 1; content.replaceChildren(); actions.replaceChildren(); accountBar.replaceChildren();
      options.onInvalidated?.();
      say("Your sign-in changed. Reload before continuing.", true);
    }
    window.addEventListener("threefc:player-proof-cleared", invalidate);
    window.addEventListener("threefc:player-proof-invalidated", invalidate);
    window.addEventListener("pagehide", invalidate);
    async function verifiedSession() {
      const current = await session();
      if (invalidated) throw new Error("account_changed");
      if (owner && (subject(owner) !== subject(current) || owner.sessionId !== current.sessionId)) { invalidate(); throw new Error("account_changed"); }
      owner = current;
    }
    function render() {
      try {
      content.replaceChildren(); actions.replaceChildren(); accountBar.replaceChildren();
      options.onLock?.(pending || Boolean(attempt) || Boolean(previousRequest) || Boolean(proposal && !["stale", "declined", "committed"].includes(proposal.status)), pending || Boolean(attempt) || Boolean(previousRequest), Boolean(proposal), proposal?.status);
      if (invalidated) return;
      if (options.proposalId && owner) {
        const signOut = button("Sign out"); signOut.disabled = pending;
        signOut.addEventListener("click", async () => {
          if (pending) return;
          if (window.ThreeFcPlayerProof?.clear() === false) return;
          signOut.disabled = true;
          try {
            await request("/v1/auth/logout", {});
            location.assign(`/sign-in?returnTo=${encodeURIComponent(urlFor(options.proposalId))}`);
          } catch { say("Sign out could not be confirmed. Reload to check before continuing.", true); }
        }); accountBar.append(signOut);
      }
      if (signInNeeded) {
        actions.append(element("a", "Sign in to review profiles", { "data-ui": "button-secondary",
          href: `/sign-in?returnTo=${encodeURIComponent(urlFor(options.proposalId))}` })); return;
      }
      if (previousRequest) {
        say("An earlier request for a different proposal is still unconfirmed. Open that proposal to check it before starting another change.");
        actions.append(element("a", "Open earlier proposal", { "data-ui": "button-secondary", href: urlFor(previousRequest.body.proposalId) }));
        return;
      }
      if (attempt) {
        const retry = button("Retry this request"); retry.disabled = pending;
        retry.addEventListener("click", () => { void mutate(attempt.path, attempt.body, retry); }); actions.append(retry); return;
      }
      if (!proposal) {
        if (options.proposalId && !pending) {
          const retry = button("Check proposal"); retry.addEventListener("click", () => { void load(options.proposalId, retry); }); actions.append(retry);
        }
        return;
      }
      if (proposal.status === "committed") {
        say(`Profiles combined as ${proposal.nickname}.${refreshFailed ? " The player list couldn’t refresh. Return to players and try refreshing it." : ""}`);
        if (options.onBackToPlayers) {
          const back = button("Back to players"), more = button("Combine more");
          back.disabled = pending; more.disabled = pending;
          back.addEventListener("click", options.onBackToPlayers); more.addEventListener("click", options.onCombineMore);
          actions.append(back, more);
        }
        return;
      }
      content.append(element("h3", `Keep ${proposal.nickname}`), element("p", proposal.leagueName));
      const profiles = element("ul", undefined, { "data-ui": "directory-list", "aria-label": "Profiles to combine" });
      for (const profile of proposal.profiles) {
        const row = element("li"); row.append(element("strong", profile.nickname));
        row.append(element("p", `${profile.claimed ? "Linked to an account" : "Not linked to an account"}${profile.playerId === proposal.retainedPlayerId ? " · Profile to keep" : ""}`));
        const games = element("ul", undefined, { "aria-label": `Games for ${profile.nickname}` });
        for (const game of profile.games) games.append(element("li", new Date(game.kickoffAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })));
        if (profile.games.length) row.append(games); else row.append(element("p", "No game registrations."));
        profiles.append(row);
      }
      content.append(profiles);
      content.append(element("p", "These profiles will become one player. Existing game records will be kept."));
      if (proposal.status === "stale" || proposal.status === "declined") {
        say(proposal.status === "declined" ? "The player declined this proposal." : "These profiles changed. Review them again before combining.", true);
        if (options.onRestart) {
          const restart = button("Review profiles again"); restart.addEventListener("click", () => { proposal = null; options.onRestart(); render(); }); actions.append(restart);
        }
        return;
      }
      if (proposal.blockers.length) { say(explanation(proposal.blockers[0]?.code), true); return; }
      if (proposal.canApprove && proposal.status === "pending_approval") {
        content.append(element("p", `Confirming with ${owner.email}`));
        for (const [label, decision] of [["Approve these profiles", "approve"], ["Decline", "decline"]]) {
          const control = button(label); control.disabled = pending;
          control.addEventListener("click", () => { void mutate("/v1/player-consolidations/approve", { proposalId: proposal.proposalId, decision }, control); }); actions.append(control);
        }
      } else if (proposal.status === "pending_approval") {
        if (!status.textContent) say("Waiting for player approval. Share this proposal with the player whose account is linked.");
        const field = element("div", undefined, { "data-ui": "field" });
        const link = element("input", undefined, { id: "consolidation-approval-link", "data-ui": "input", readonly: "", "aria-label": "Player approval link" });
        link.value = new URL(urlFor(proposal.proposalId), location.origin).href;
        field.append(element("label", "Player approval link", { for: link.id }), link); content.append(field);
        const copy = button("Copy approval link"); copy.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(link.value); say("Approval link copied."); }
          catch { link.focus(); link.select(); say("Copy failed. Select and copy the link above.", true); }
        }); actions.append(copy);
      }
      if (proposal.status === "ready" && proposal.canCommit) {
        const commit = button("Combine profiles"); commit.disabled = pending;
        commit.setAttribute("data-variant", "primary");
        commit.addEventListener("click", () => { void mutate("/v1/player-consolidations/commit", { proposalId: proposal.proposalId }, commit); }); actions.append(commit);
      } else if (proposal.status === "ready") say("Approval recorded. The organiser can now combine these profiles.");
      if (proposal.status === "pending_approval") {
        const refresh = button("Check approval"); refresh.disabled = pending;
        refresh.addEventListener("click", () => { void load(proposal.proposalId, refresh); }); actions.append(refresh);
      }
      } finally { options.renderNavigation?.(actions); }
    }
    async function load(id, control) {
      if (pending || invalidated || attempt) return;
      const finish = focusOwner(control); const current = generation;
      pending = true; say("Loading proposal…"); render();
      try {
        await verifiedSession();
        if (current !== generation || invalidated) return;
        const result = await request(`/v1/player-consolidations?${new URLSearchParams({ proposalId: id })}`);
        if (current !== generation) return;
        if (!validProposal(result.proposal) || result.proposal.proposalId !== id) throw new Error("invalid_proposal");
        proposal = result.proposal; say("");
      } catch (error) {
        if (error.status === 401 && options.proposalId) signInNeeded = true;
        if (!invalidated) say(error.status === 401 || error.status === 403 ? "Sign in with the account linked to this player, or ask the organiser for help." : "Couldn’t load the proposal. Try again.", true);
      } finally { pending = false; render(); finish(current === generation && !invalidated ? (status.hidden ? content : status) : null); }
    }
    async function mutate(path, body, control) {
      if (pending || invalidated || previousRequest || (attempt && JSON.stringify(attempt.body) !== JSON.stringify(body))) return;
      const finish = focusOwner(control); const current = generation;
      pending = true;
      let dispatched = false;
      try {
        await verifiedSession();
        if (current !== generation || invalidated) return;
        if (!attempt) attempt = { path, body: { ...body, expectedAccountId: subject(owner) }, leagueId: options.leagueId ?? proposal?.leagueId, uncertain: false };
        persist(attempt); say("Saving proposal…"); render();
        dispatched = true;
        const result = await request(path, attempt.body);
        if (current !== generation) return;
        if (!validProposal(result.proposal) || result.proposal.proposalId !== body.proposalId) throw new Error("invalid_proposal");
        proposal = result.proposal; sessionStorage.removeItem(key()); attempt = null; say("");
        if (proposal.status === "committed") {
          refreshFailed = false;
          render();
          try { await options.onCommitted?.(); } catch { refreshFailed = true; }
          if (current !== generation || invalidated) return;
        }
      } catch (error) {
        if (error.status === 403 && error.code === "account_changed") {
          // This response rejects this dispatch, not an earlier uncertain commit.
          // Keep the owner-scoped recovery record, but retire all visible old-account details.
          invalidate(); return;
        }
        if (!invalidated) {
          if (attempt && !attempt.uncertain && [400, 403, 404, 409, 422].includes(error.status)) {
            try { sessionStorage.removeItem(key()); attempt = null; } catch { /* Keep exact request if cleanup fails. */ }
          } else if (attempt && dispatched) { attempt.uncertain = true; try { persist(attempt); } catch { /* Earlier durable request remains. */ } }
          say(attempt ? "Couldn’t confirm this request. Retry checks the same proposal; your selection has been kept." : explanation(error.code), true);
        }
      } finally { pending = false; render(); finish(current === generation && !invalidated ? (status.hidden ? content : status) : null); }
    }
    async function restore(id) {
      if (pending || invalidated) return;
      const current = generation;
      pending = true; render();
      try {
        await verifiedSession();
        if (current !== generation || invalidated) return;
        const value = JSON.parse(sessionStorage.getItem(key()) || "null");
        if (value && ["/v1/player-consolidations", "/v1/player-consolidations/approve", "/v1/player-consolidations/commit"].includes(value.path) && validId(value.body?.proposalId)) {
          if ((id && value.body.proposalId !== id) || (options.leagueId && (value.leagueId ?? value.body.leagueId) !== options.leagueId)) {
            previousRequest = value; render(); return;
          }
          if (value.body.expectedAccountId !== subject(owner)) { invalidate(); return; }
          attempt = { ...value, uncertain: true }; say("An earlier request is unconfirmed. Retry checking it before making another change."); render(); return;
        }
        pending = false;
        if (id) await load(id);
      } catch (error) {
        if (current !== generation || invalidated) return;
        signInNeeded = error.status === 401 && Boolean(options.proposalId);
        say(signInNeeded ? "Sign in to review this proposal." : "Couldn’t verify your sign-in. Reload to try again.", true); render();
      } finally { pending = false; render(); }
    }
    function reset() {
      if (pending || attempt || previousRequest || invalidated) return false;
      if (proposal?.status === "pending_approval") options.onDeferred?.(proposal);
      proposal = null; refreshFailed = false; signInNeeded = false; generation += 1; say("");
      return true;
    }
    return { preview: (body, control) => mutate("/v1/player-consolidations", body, control), restore, render, reset,
      hasProposal: () => Boolean(proposal || attempt), status };
  }
  function initializeLeague({ leagueId, canManage, getPlayer, getPlayers, onCommitted, onTaskState }) {
    const host = document.getElementById("league-player-combine-host"); if (!host) return null;
    const toggle = button("Combine profiles"); toggle.hidden = !canManage();
    const panel = element("section", undefined, { "data-ui": "disclosure-panel", "aria-label": "Combine player profiles" }); panel.hidden = true;
    const heading = element("h3", "Select profiles to combine", { tabindex: "-1" });
    const editor = element("div", undefined, { "data-ui": "consolidation-editor" });
    const table = element("table", undefined, { "data-ui": "consolidation-selection-table", "aria-label": "Players to combine" });
    const head = element("thead"), titles = element("tr");
    for (const title of ["Select", "Player", "Games"]) titles.append(element("th", title, { scope: "col" }));
    head.append(titles);
    const rows = element("tbody", undefined, { "data-ui": "consolidation-selection-body" }); table.append(head, rows);
    const retained = element("select", undefined, { id: "consolidation-retained", "data-ui": "input", "aria-label": "Profile to keep" });
    const name = element("input", undefined, { id: "consolidation-name", "data-ui": "input", maxlength: "80", "aria-label": "Player name" });
    const retainedLabel = element("div", undefined, { "data-ui": "field" }); retainedLabel.append(element("label", "Profile to keep", { for: retained.id }), retained);
    const nameLabel = element("div", undefined, { "data-ui": "field" }); nameLabel.append(element("label", "Player name", { for: name.id }), name);
    const review = button("Review profiles"), cancel = button("Cancel"), back = button("Back");
    review.setAttribute("data-variant", "primary");
    const selectionActions = element("div", undefined, { "data-ui": "button-row" }); selectionActions.append(review, back, cancel);
    const selectionCount = element("p", "0 profiles selected", { "data-ui": "consolidation-selected-count", "aria-live": "polite" });
    editor.append(heading, table, selectionCount, retainedLabel, nameLabel);
    panel.append(editor); host.append(toggle, panel);
    const deferred = element("div", undefined, { "data-ui": "consolidation-pending-links" }); host.append(deferred);
    const selected = new Map(), deferredIds = new Set(); let active = false, locked = false, busy = false, reviewing = false, success = false;
    const playerLabel = player => [player.nickname, ...(player.seasons || []).map(season => season.name)].join(" · ");
    const gameDate = game => typeof game.kickoffAt === "string" && Number.isFinite(Date.parse(game.kickoffAt))
      ? new Date(game.kickoffAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";
    const keeperLabel = player => `${playerLabel(player)} · ${Array.isArray(player.games) && player.games.length ? player.games.map(gameDate).join(", ") : Array.isArray(player.games) && !player.gamesIncomplete ? "No games" : "Game history unavailable"}`;
    let retired = false;
    const state = controller(panel, { leagueId,
      renderNavigation: actions => actions.append(selectionActions),
      onCommitted() { selected.clear(); retained.replaceChildren(); name.value = ""; return onCommitted?.(); },
      onBackToPlayers() { leave(false); }, onCombineMore() { leave(true); },
      onDeferred(proposal) {
        if (deferredIds.has(proposal.proposalId)) return;
        deferredIds.add(proposal.proposalId);
        deferred.append(element("a", `Awaiting approval: ${proposal.nickname}`, { href: urlFor(proposal.proposalId) }));
      },
      onLock(value, operationPending, hasProposal, status) { locked = value; busy = operationPending; reviewing = hasProposal; success = status === "committed"; renderSelection(); },
      onRestart() { locked = false; reviewing = false; renderSelection(); heading.focus(); },
      onInvalidated() { retired = true; active = false; selected.clear(); deferred.replaceChildren(); deferredIds.clear(); retained.replaceChildren(); name.value = ""; renderSelection(); } });
    function renderSelection() {
      toggle.hidden = retired || active || !canManage();
      editor.hidden = retired || reviewing;
      selectionActions.hidden = retired || success;
      review.hidden = reviewing;
      back.hidden = !reviewing; back.disabled = busy;
      deferred.hidden = active || retired;
      const focusedId = document.activeElement?.matches?.("[data-consolidation-select]") ? document.activeElement.dataset.playerId : null;
      rows.replaceChildren();
      const available = new Map((getPlayers ? getPlayers() : [...document.querySelectorAll("#league-player-list > li[data-player-id]")].map(row => getPlayer(row.dataset.playerId)).filter(Boolean)).map(player => [player.playerId, player]));
      for (const [id, player] of available) if (selected.has(id)) selected.set(id, player);
      // Dates can arrive after selection. Update option descriptions without
      // resetting the chosen identity or the organiser's edited player name.
      for (const option of retained.options) {
        const player = selected.get(option.value);
        if (player) option.textContent = keeperLabel(player);
      }
      // Keep already-selected profiles visible when the search changes, once each.
      for (const [id, player] of selected) if (!available.has(id)) available.set(id, player);
      for (const player of available.values()) {
        const row = element("tr", undefined, { "data-player-id": player.playerId });
        const selectCell = element("td"), label = element("label", undefined, { "data-ui": "check-row" });
        const input = element("input", undefined, { type: "checkbox", "data-consolidation-select": "", "data-player-id": player.playerId, "aria-label": `Select ${playerLabel(player)}` });
        input.checked = selected.has(player.playerId); input.disabled = retired || locked || (!input.checked && selected.size >= 20);
        input.addEventListener("change", () => {
          if (!canManage() || locked || retired) return;
          if (input.checked) selected.set(player.playerId, player); else selected.delete(player.playerId);
          refreshRetained();
        });
        label.append(input); selectCell.append(label);
        const playerCell = element("td"); playerCell.append(element("strong", player.nickname), document.createTextNode(" "), element("span", player.claimed ? "Linked" : "Unlinked"));
        const gamesCell = element("td", undefined, { id: `consolidation-games-${rows.children.length}` });
        input.setAttribute("aria-describedby", gamesCell.id);
        if (!Array.isArray(player.games)) gamesCell.textContent = "Game history unavailable";
        else if (!player.games.length) gamesCell.textContent = player.gamesIncomplete ? "Game history unavailable" : "No games";
        else {
          const games = element("ul", undefined, { "aria-label": `Games for ${player.nickname}` });
          for (const game of player.games) {
            games.append(element("li", gameDate(game)));
          }
          gamesCell.append(games);
          if (player.gamesIncomplete) gamesCell.append(element("p", "Some games are unavailable"));
        }
        row.append(selectCell, playerCell, gamesCell); rows.append(row);
      }
      retained.disabled = locked; name.readOnly = locked; review.disabled = locked || selected.size < 2 || !name.value.trim(); cancel.disabled = busy;
      selectionCount.textContent = `${selected.size} ${selected.size === 1 ? "profile" : "profiles"} selected`;
      for (const option of retained.options) if (selected.has(option.value)) option.textContent = keeperLabel(selected.get(option.value));
      if (focusedId && !editor.hidden) [...rows.querySelectorAll("input")].find(input => input.dataset.playerId === focusedId)?.focus();
      const directory = document.getElementById("league-player-list"); if (directory) directory.hidden = active;
      onTaskState?.({ active: active && !retired, phase: success ? "success" : reviewing || busy ? "review" : "select" });
    }
    function refreshRetained() {
      const previous = retained.value; const claimed = [...selected.values()].filter(player => player.claimed);
      retained.replaceChildren();
      for (const player of claimed.length ? claimed : selected.values()) retained.append(element("option", keeperLabel(player), { value: player.playerId }));
      if ([...retained.options].some(option => option.value === previous)) retained.value = previous;
      name.value = selected.get(retained.value)?.nickname || ""; renderSelection();
    }
    function refreshRows() {
      renderSelection();
    }
    toggle.addEventListener("click", () => {
      if (!canManage()) return;
      active = true; panel.hidden = false; refreshRows();
      if (reviewing) { panel.tabIndex = -1; panel.focus(); } else heading.focus();
      void state.restore();
    });
    function leave(more) {
      if (busy || !state.reset()) return;
      selected.clear(); retained.replaceChildren(); name.value = ""; active = more; panel.hidden = !more;
      state.render(); refreshRows(); if (more) heading.focus(); else toggle.focus();
    }
    cancel.addEventListener("click", () => leave(false));
    back.addEventListener("click", () => { if (busy || !state.reset()) return; state.render(); heading.focus(); });
    panel.addEventListener("keydown", event => { if (event.key === "Escape" && !busy) { event.preventDefault(); leave(false); } });
    retained.addEventListener("change", () => { name.value = selected.get(retained.value)?.nickname || ""; renderSelection(); });
    name.addEventListener("input", renderSelection);
    review.addEventListener("click", () => {
      if (!canManage() || review.disabled) return;
      void state.preview({ leagueId, playerIds: [...selected.keys()], retainedPlayerId: retained.value, nickname: name.value.trim(), proposalId: crypto.randomUUID() }, review);
    });
    const clearSelection = () => { selected.clear(); active = false; panel.hidden = true; refreshRows(); };
    window.addEventListener("threefc:player-proof-cleared", clearSelection);
    window.addEventListener("threefc:player-proof-invalidated", clearSelection);
    return { refreshRows };
  }
  window.ThreeFcConsolidation = Object.freeze({ initializeLeague });
  const approval = document.getElementById("consolidation-approval");
  if (approval) {
    const id = new URLSearchParams(location.search).get("proposalId");
    if (!id) approval.append(element("p", "This proposal link is missing. Ask the organiser for the full link."));
    else void controller(approval, { proposalId: id }).restore(id);
  }
})();
