(() => {
  const root = document.getElementById("setup-flow-root");
  if (!root) {
    return;
  }

  const apiBaseUrl = root.getAttribute("data-api-base-url") ?? "";
  const page = root.getAttribute("data-page") ?? "dashboard";

  const statusElement = document.getElementById("setup-status");
  const errorElement = document.getElementById("setup-error");

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function randomSuffix(length = 8) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "").slice(0, length);
    }

    return Math.random().toString(16).slice(2, 2 + length);
  }

  function slugify(value) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 48);
  }

  function setStatus(text, state = "default") {
    if (!statusElement) {
      return;
    }

    statusElement.textContent = text;
    if (state === "default") {
      statusElement.removeAttribute("data-state");
      return;
    }

    statusElement.setAttribute("data-state", state);
  }

  function showError(message) {
    if (!errorElement) {
      return;
    }

    errorElement.textContent = message;
    errorElement.hidden = false;
  }

  function clearError() {
    if (!errorElement) {
      return;
    }

    errorElement.hidden = true;
    errorElement.textContent = "";
  }

  function buildApiUrl(path) {
    const normalizedBase = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    return new URL(normalizedPath, normalizedBase).toString();
  }

  function createIdempotencyKey(prefix, stablePart) {
    const safeStable = stablePart.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 56);
    return `${prefix}-${safeStable}-${Date.now().toString(36)}`;
  }

  async function requestJson(path, init = {}) {
    const response = await fetch(buildApiUrl(path), {
      credentials: "include",
      ...init,
    });

    const text = await response.text();
    let body = {};

    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  }

  async function requestJsonOrThrow(path, init = {}) {
    const result = await requestJson(path, init);
    if (!result.ok) {
      const message = result.body?.message || result.body?.error || `Request failed with status ${result.status}.`;
      const error = new Error(message);
      error.statusCode = result.status;
      throw error;
    }

    return result.body;
  }

  function toIsoTimestamp(localDateTime) {
    const parsed = new Date(localDateTime);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed.toISOString();
  }

  function toLocalDateTimeInput(isoTimestamp) {
    const parsed = new Date(isoTimestamp);
    if (Number.isNaN(parsed.getTime())) {
      return "";
    }

    const offsetAdjusted = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
    return offsetAdjusted.toISOString().slice(0, 16);
  }

  function todayDate() {
    const now = new Date();
    const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return localNow.toISOString().slice(0, 10);
  }

  function syncKickoffFromDate(dateInput, kickoffInput) {
    const gameDate = dateInput.value.trim();
    if (!gameDate) {
      return;
    }

    const current = kickoffInput.value.trim();
    const timePart = current.includes("T") ? current.split("T")[1] : "10:00";
    kickoffInput.value = `${gameDate}T${timePart}`;
  }

  async function ensureAuthenticatedSession() {
    setStatus("Checking sign-in state…", "default");
    const result = await requestJson("/v1/auth/session", { method: "GET" });

    if (!result.ok) {
      const returnTo = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
      window.location.replace(`/sign-in?returnTo=${returnTo}`);
      throw new Error("redirecting_to_sign_in");
    }

    const email = result.body?.session?.email;
    if (typeof email === "string" && email.length > 0) {
      setStatus(`Signed in as ${email}.`, "success");
    } else {
      setStatus("Session active.", "success");
    }

    return result.body?.session ?? null;
  }

  function attachSlugAutoFill(nameInput, friendlyUrlInput, idDisplay, idPrefix) {
    let friendlyEdited = false;

    const updateDerivedId = () => {
      if (!idDisplay) {
        return;
      }

      const fromFriendly = slugify(friendlyUrlInput.value);
      const fromName = slugify(nameInput.value);
      idDisplay.textContent = fromFriendly || fromName || `${idPrefix}-${randomSuffix(6)}`;
    };

    nameInput.addEventListener("input", () => {
      if (!friendlyEdited) {
        friendlyUrlInput.value = slugify(nameInput.value);
      }
      updateDerivedId();
    });

    friendlyUrlInput.addEventListener("input", () => {
      friendlyEdited = friendlyUrlInput.value.trim().length > 0;
      updateDerivedId();
    });

    updateDerivedId();
  }

  async function initDashboardPage() {
    const leagueNameInput = document.getElementById("league-name");
    const leagueFriendlyUrlInput = document.getElementById("league-friendly-url");
    const leagueIdDisplay = document.getElementById("league-id-display");
    const createLeagueButton = root.querySelector('[data-action="create-league"]');

    const leaguesBody = document.getElementById("dashboard-leagues-body");
    const leaguesTableWrap = document.querySelector('[data-testid="dashboard-leagues-table"]');
    const leaguesEmpty = document.getElementById("dashboard-leagues-empty");

    if (
      !(leagueNameInput instanceof HTMLInputElement) ||
      !(leagueFriendlyUrlInput instanceof HTMLInputElement) ||
      !(createLeagueButton instanceof HTMLButtonElement) ||
      !(leaguesBody instanceof HTMLElement)
    ) {
      return;
    }

    attachSlugAutoFill(leagueNameInput, leagueFriendlyUrlInput, leagueIdDisplay, "league");

    async function renderLeagues() {
      const payload = await requestJsonOrThrow("/v1/leagues", { method: "GET" });
      const leagues = Array.isArray(payload?.leagues) ? payload.leagues : [];

      if (leagues.length === 0) {
        leaguesBody.innerHTML = "";
        if (leaguesTableWrap instanceof HTMLElement) {
          leaguesTableWrap.hidden = true;
        }
        if (leaguesEmpty instanceof HTMLElement) {
          leaguesEmpty.hidden = false;
        }
        setStatus("No leagues found. Create your first league.", "default");
        return;
      }

      const rows = leagues
        .map((league) => {
          const friendlyUrl = league.slug ?? "-";
          return `<tr>
            <td><a href="/leagues/${encodeURIComponent(league.leagueId)}">${escapeHtml(league.name)}</a></td>
            <td><code>${escapeHtml(friendlyUrl)}</code></td>
            <td>
              <div data-ui="row-action-buttons">
                <a href="/leagues/${encodeURIComponent(league.leagueId)}" data-ui="button-link" data-variant="secondary">View</a>
                <button data-ui="row-action" data-tone="danger" type="button" data-action="delete-league" data-league-id="${escapeHtml(league.leagueId)}">Delete</button>
              </div>
            </td>
          </tr>`;
        })
        .join("");

      leaguesBody.innerHTML = rows;
      if (leaguesTableWrap instanceof HTMLElement) {
        leaguesTableWrap.hidden = false;
      }
      if (leaguesEmpty instanceof HTMLElement) {
        leaguesEmpty.hidden = true;
      }
      setStatus(`Loaded ${leagues.length} league${leagues.length === 1 ? "" : "s"}.`, "success");
    }

    createLeagueButton.addEventListener("click", async () => {
      clearError();

      const leagueName = leagueNameInput.value.trim();
      if (!leagueName) {
        showError("League name is required.");
        leagueNameInput.focus();
        return;
      }

      const leagueFriendlyUrl = slugify(leagueFriendlyUrlInput.value) || slugify(leagueName);
      const leagueId = leagueFriendlyUrl || `league-${randomSuffix(6)}`;

      createLeagueButton.disabled = true;
      setStatus("Creating league…", "default");

      try {
        await requestJsonOrThrow("/v1/leagues", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": createIdempotencyKey("create-league", leagueId),
          },
          body: JSON.stringify({
            leagueId,
            name: leagueName,
            slug: leagueFriendlyUrl || null,
          }),
        });

        window.location.assign(`/leagues/${encodeURIComponent(leagueId)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create league.";
        showError(message);
        setStatus("League creation failed.", "error");
      } finally {
        createLeagueButton.disabled = false;
      }
    });

    leaguesBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.getAttribute("data-action") !== "delete-league") {
        return;
      }

      const leagueId = target.getAttribute("data-league-id");
      if (!leagueId) {
        return;
      }

      if (!window.confirm(`Delete league ${leagueId}? This only works when the league has no seasons.`)) {
        return;
      }

      target.setAttribute("disabled", "true");
      clearError();
      setStatus(`Deleting league ${leagueId}…`, "default");

      try {
        await requestJsonOrThrow(`/v1/leagues/${encodeURIComponent(leagueId)}`, {
          method: "DELETE",
        });
        await renderLeagues();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not delete league.";
        showError(message);
        setStatus("League deletion failed.", "error");
      } finally {
        target.removeAttribute("disabled");
      }
    });

    await renderLeagues();
  }

  async function initLeaguePage() {
    const leagueId = root.getAttribute("data-league-id");
    if (!leagueId) {
      return;
    }

    const title = document.getElementById("league-title");
    const subtitle = document.getElementById("league-subtitle");
    const deleteLeagueButton = root.querySelector('[data-action="delete-league"]');

    const seasonNameInput = document.getElementById("season-name");
    const seasonFriendlyUrlInput = document.getElementById("season-friendly-url");
    const seasonIdDisplay = document.getElementById("season-id-display");
    const createSeasonButton = root.querySelector('[data-action="create-season"]');

    const seasonsBody = document.getElementById("league-seasons-body");
    const seasonsTableWrap = document.querySelector('[data-testid="league-seasons-table"]');
    const seasonsEmpty = document.getElementById("league-seasons-empty");

    if (
      !(seasonNameInput instanceof HTMLInputElement) ||
      !(seasonFriendlyUrlInput instanceof HTMLInputElement) ||
      !(createSeasonButton instanceof HTMLButtonElement) ||
      !(seasonsBody instanceof HTMLElement)
    ) {
      return;
    }

    attachSlugAutoFill(seasonNameInput, seasonFriendlyUrlInput, seasonIdDisplay, "season");

    async function loadLeague() {
      const league = await requestJsonOrThrow(`/v1/leagues/${encodeURIComponent(leagueId)}`, {
        method: "GET",
      });

      if (title) {
        title.textContent = league.name;
      }

      if (subtitle) {
        subtitle.innerHTML = `League ID: <code>${escapeHtml(league.leagueId)}</code> | Friendly URL: <code>${escapeHtml(
          league.slug ?? "-",
        )}</code>`;
      }
    }

    async function renderSeasons() {
      const payload = await requestJsonOrThrow(
        `/v1/leagues/${encodeURIComponent(leagueId)}/seasons`,
        { method: "GET" },
      );

      const seasons = Array.isArray(payload?.seasons) ? payload.seasons : [];
      if (seasons.length === 0) {
        seasonsBody.innerHTML = "";
        if (seasonsTableWrap instanceof HTMLElement) {
          seasonsTableWrap.hidden = true;
        }
        if (seasonsEmpty instanceof HTMLElement) {
          seasonsEmpty.hidden = false;
        }
        return;
      }

      seasonsBody.innerHTML = seasons
        .map((season) => {
          const dateRange = `${season.startsOn ?? "-"} to ${season.endsOn ?? "-"}`;
          return `<tr>
            <td><a href="/seasons/${encodeURIComponent(season.seasonId)}">${escapeHtml(season.name)}</a></td>
            <td>${escapeHtml(dateRange)}</td>
            <td><code>${escapeHtml(season.slug ?? "-")}</code></td>
            <td>
              <div data-ui="row-action-buttons">
                <a href="/seasons/${encodeURIComponent(season.seasonId)}" data-ui="button-link" data-variant="secondary">View</a>
                <button data-ui="row-action" data-tone="danger" type="button" data-action="delete-season" data-season-id="${escapeHtml(season.seasonId)}">Delete</button>
              </div>
            </td>
          </tr>`;
        })
        .join("");

      if (seasonsTableWrap instanceof HTMLElement) {
        seasonsTableWrap.hidden = false;
      }
      if (seasonsEmpty instanceof HTMLElement) {
        seasonsEmpty.hidden = true;
      }
    }

    createSeasonButton.addEventListener("click", async () => {
      clearError();

      const seasonName = seasonNameInput.value.trim();
      if (!seasonName) {
        showError("Season name is required.");
        seasonNameInput.focus();
        return;
      }

      const seasonFriendlyUrl = slugify(seasonFriendlyUrlInput.value) || slugify(seasonName);
      const seasonId = seasonFriendlyUrl || `season-${randomSuffix(6)}`;

      createSeasonButton.disabled = true;
      setStatus("Creating season…", "default");

      try {
        await requestJsonOrThrow(`/v1/leagues/${encodeURIComponent(leagueId)}/seasons`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": createIdempotencyKey("create-season", `${leagueId}-${seasonId}`),
          },
          body: JSON.stringify({
            seasonId,
            name: seasonName,
            slug: seasonFriendlyUrl || null,
            startsOn: (document.getElementById("season-start")?.value ?? "") || null,
            endsOn: (document.getElementById("season-end")?.value ?? "") || null,
          }),
        });

        window.location.assign(`/seasons/${encodeURIComponent(seasonId)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create season.";
        showError(message);
        setStatus("Season creation failed.", "error");
      } finally {
        createSeasonButton.disabled = false;
      }
    });

    seasonsBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.getAttribute("data-action") !== "delete-season") {
        return;
      }

      const seasonId = target.getAttribute("data-season-id");
      if (!seasonId) {
        return;
      }

      if (!window.confirm(`Delete season ${seasonId}? This only works when it has no games.`)) {
        return;
      }

      target.setAttribute("disabled", "true");
      clearError();
      setStatus(`Deleting season ${seasonId}…`, "default");

      try {
        await requestJsonOrThrow(`/v1/seasons/${encodeURIComponent(seasonId)}`, {
          method: "DELETE",
        });
        await renderSeasons();
        setStatus(`Season ${seasonId} deleted.`, "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not delete season.";
        showError(message);
        setStatus("Season deletion failed.", "error");
      } finally {
        target.removeAttribute("disabled");
      }
    });

    if (deleteLeagueButton instanceof HTMLButtonElement) {
      deleteLeagueButton.addEventListener("click", async () => {
        if (!window.confirm(`Delete league ${leagueId}? This only works when the league has no seasons.`)) {
          return;
        }

        deleteLeagueButton.disabled = true;
        clearError();
        setStatus(`Deleting league ${leagueId}…`, "default");

        try {
          await requestJsonOrThrow(`/v1/leagues/${encodeURIComponent(leagueId)}`, {
            method: "DELETE",
          });
          window.location.assign("/setup");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not delete league.";
          showError(message);
          setStatus("League deletion failed.", "error");
        } finally {
          deleteLeagueButton.disabled = false;
        }
      });
    }

    await loadLeague();
    await renderSeasons();
    setStatus("League page ready.", "success");
  }

  async function initSeasonPage() {
    const seasonId = root.getAttribute("data-season-id");
    if (!seasonId) {
      return;
    }

    const seasonTitle = document.getElementById("season-title");
    const seasonSubtitle = document.getElementById("season-subtitle");
    const seasonLeagueLink = document.getElementById("season-league-link");

    const gameDateInput = document.getElementById("game-date");
    const gameKickoffInput = document.getElementById("game-kickoff");
    const gameIdDisplay = document.getElementById("game-id-display");
    const createGameButton = root.querySelector('[data-action="create-game"]');

    const deleteSeasonButton = root.querySelector('[data-action="delete-season"]');

    const gamesBody = document.getElementById("season-games-body");
    const gamesTableWrap = document.querySelector('[data-testid="season-games-table"]');
    const gamesEmpty = document.getElementById("season-games-empty");

    if (
      !(gameDateInput instanceof HTMLInputElement) ||
      !(gameKickoffInput instanceof HTMLInputElement) ||
      !(createGameButton instanceof HTMLButtonElement) ||
      !(gamesBody instanceof HTMLElement)
    ) {
      return;
    }

    let leagueId = "";
    let gameIdNonce = randomSuffix(4);

    function updateDerivedGameId() {
      const sessionId = gameDateInput.value.trim() ? gameDateInput.value.trim().replaceAll("-", "") : `session-${randomSuffix(6)}`;
      const kickoff = gameKickoffInput.value.trim();
      const kickoffPart = kickoff.includes("T") ? kickoff.split("T")[1].replace(":", "") : "0000";
      if (gameIdDisplay) {
        gameIdDisplay.textContent = `game-${sessionId}-${kickoffPart}-${gameIdNonce}`;
      }
    }

    gameDateInput.addEventListener("change", () => {
      syncKickoffFromDate(gameDateInput, gameKickoffInput);
      updateDerivedGameId();
    });
    gameKickoffInput.addEventListener("change", updateDerivedGameId);

    if (!gameDateInput.value) {
      gameDateInput.value = todayDate();
    }
    syncKickoffFromDate(gameDateInput, gameKickoffInput);
    if (!gameKickoffInput.value) {
      gameKickoffInput.value = `${gameDateInput.value}T10:00`;
    }
    updateDerivedGameId();

    async function loadSeason() {
      const season = await requestJsonOrThrow(`/v1/seasons/${encodeURIComponent(seasonId)}`, {
        method: "GET",
      });

      leagueId = season.leagueId;
      if (seasonTitle) {
        seasonTitle.textContent = season.name;
      }

      if (seasonSubtitle) {
        seasonSubtitle.innerHTML = `Season ID: <code>${escapeHtml(season.seasonId)}</code> | Friendly URL: <code>${escapeHtml(
          season.slug ?? "-",
        )}</code>`;
      }

      if (seasonLeagueLink instanceof HTMLAnchorElement) {
        seasonLeagueLink.href = `/leagues/${encodeURIComponent(season.leagueId)}`;
      }
    }

    async function renderGames() {
      const payload = await requestJsonOrThrow(`/v1/seasons/${encodeURIComponent(seasonId)}/games`, {
        method: "GET",
      });

      const games = Array.isArray(payload?.games) ? payload.games : [];
      if (games.length === 0) {
        gamesBody.innerHTML = "";
        if (gamesTableWrap instanceof HTMLElement) {
          gamesTableWrap.hidden = true;
        }
        if (gamesEmpty instanceof HTMLElement) {
          gamesEmpty.hidden = false;
        }
        return;
      }

      gamesBody.innerHTML = games
        .map((game) => `<tr>
          <td><a href="/games/${encodeURIComponent(game.gameId)}">${escapeHtml(game.gameId)}</a></td>
          <td>${escapeHtml(game.gameStartTs)}</td>
          <td>${escapeHtml(game.status)}</td>
          <td>
            <div data-ui="row-action-buttons">
              <a href="/games/${encodeURIComponent(game.gameId)}" data-ui="button-link" data-variant="secondary">View</a>
              <button data-ui="row-action" data-tone="danger" type="button" data-action="delete-game" data-game-id="${escapeHtml(game.gameId)}">Delete</button>
            </div>
          </td>
        </tr>`)
        .join("");

      if (gamesTableWrap instanceof HTMLElement) {
        gamesTableWrap.hidden = false;
      }
      if (gamesEmpty instanceof HTMLElement) {
        gamesEmpty.hidden = true;
      }
    }

    createGameButton.addEventListener("click", async () => {
      clearError();

      const gameDate = gameDateInput.value.trim();
      const gameKickoff = gameKickoffInput.value.trim();
      if (!gameDate) {
        showError("Game date is required.");
        return;
      }

      const kickoffIso = toIsoTimestamp(gameKickoff);
      if (!kickoffIso) {
        showError("Kickoff time must be valid.");
        return;
      }

      const sessionId = gameDate.replaceAll("-", "");
      const gameId = (gameIdDisplay?.textContent ?? "").trim() || `game-${sessionId}-${randomSuffix(6)}`;

      createGameButton.disabled = true;
      setStatus("Creating game…", "default");

      try {
        await requestJsonOrThrow(`/v1/seasons/${encodeURIComponent(seasonId)}/sessions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": createIdempotencyKey("create-session", `${seasonId}-${sessionId}`),
          },
          body: JSON.stringify({
            sessionId,
            sessionDate: gameDate,
          }),
        });

        await requestJsonOrThrow(`/v1/sessions/${encodeURIComponent(sessionId)}/games`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": createIdempotencyKey("create-game", `${sessionId}-${gameId}`),
          },
          body: JSON.stringify({
            gameId,
            gameStartTs: kickoffIso,
            status: "scheduled",
          }),
        });

        window.location.assign(`/games/${encodeURIComponent(gameId)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create game.";
        showError(message);
        setStatus("Game creation failed.", "error");
      } finally {
        createGameButton.disabled = false;
      }
    });

    gamesBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.getAttribute("data-action") !== "delete-game") {
        return;
      }

      const gameId = target.getAttribute("data-game-id");
      if (!gameId) {
        return;
      }

      if (!window.confirm(`Delete game ${gameId}?`)) {
        return;
      }

      target.setAttribute("disabled", "true");
      clearError();
      setStatus(`Deleting game ${gameId}…`, "default");

      try {
        await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}`, {
          method: "DELETE",
        });
        await renderGames();
        setStatus(`Game ${gameId} deleted.`, "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not delete game.";
        showError(message);
        setStatus("Game deletion failed.", "error");
      } finally {
        target.removeAttribute("disabled");
      }
    });

    if (deleteSeasonButton instanceof HTMLButtonElement) {
      deleteSeasonButton.addEventListener("click", async () => {
        if (!window.confirm(`Delete season ${seasonId}? This only works when no games remain.`)) {
          return;
        }

        deleteSeasonButton.disabled = true;
        clearError();
        setStatus(`Deleting season ${seasonId}…`, "default");

        try {
          await requestJsonOrThrow(`/v1/seasons/${encodeURIComponent(seasonId)}`, {
            method: "DELETE",
          });
          window.location.assign(`/leagues/${encodeURIComponent(leagueId)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not delete season.";
          showError(message);
          setStatus("Season deletion failed.", "error");
        } finally {
          deleteSeasonButton.disabled = false;
        }
      });
    }

    await loadSeason();
    await renderGames();
    setStatus("Season page ready.", "success");
  }

  async function initGamePage() {
    const gameId = root.getAttribute("data-game-id");
    if (!gameId) {
      return;
    }

    const title = document.getElementById("game-title");
    const subtitle = document.getElementById("game-subtitle");
    const gameLeagueLink = document.getElementById("game-league-link");
    const gameSeasonLink = document.getElementById("game-season-link");

    const gameLeagueId = document.getElementById("game-league-id");
    const gameSeasonId = document.getElementById("game-season-id");

    const kickoffInput = document.getElementById("game-edit-kickoff");
    const statusInput = document.getElementById("game-edit-status");
    const saveButton = root.querySelector('[data-action="save-game"]');
    const deleteButton = root.querySelector('[data-action="delete-game"]');
    const createAnotherLink = document.getElementById("create-another-game-link");

    if (
      !(kickoffInput instanceof HTMLInputElement) ||
      !(statusInput instanceof HTMLSelectElement) ||
      !(saveButton instanceof HTMLButtonElement) ||
      !(deleteButton instanceof HTMLButtonElement)
    ) {
      return;
    }

    let currentLeagueId = "";
    let currentSeasonId = "";

    async function loadGame() {
      const game = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}`, {
        method: "GET",
      });

      currentLeagueId = game.leagueId;
      currentSeasonId = game.seasonId;

      if (title) {
        title.textContent = game.gameId;
      }

      if (subtitle) {
        subtitle.innerHTML = `Kickoff (UTC): <code>${escapeHtml(game.gameStartTs)}</code>`;
      }

      if (gameLeagueId) {
        gameLeagueId.textContent = game.leagueId;
      }
      if (gameSeasonId) {
        gameSeasonId.textContent = game.seasonId;
      }

      kickoffInput.value = toLocalDateTimeInput(game.gameStartTs);
      statusInput.value = game.status;

      if (gameLeagueLink instanceof HTMLAnchorElement) {
        gameLeagueLink.href = `/leagues/${encodeURIComponent(game.leagueId)}`;
      }
      if (gameSeasonLink instanceof HTMLAnchorElement) {
        gameSeasonLink.href = `/seasons/${encodeURIComponent(game.seasonId)}`;
      }
      if (createAnotherLink instanceof HTMLAnchorElement) {
        createAnotherLink.href = `/seasons/${encodeURIComponent(game.seasonId)}`;
      }
    }

    saveButton.addEventListener("click", async () => {
      clearError();

      const kickoffIso = toIsoTimestamp(kickoffInput.value.trim());
      if (!kickoffIso) {
        showError("Kickoff time must be valid.");
        return;
      }

      saveButton.disabled = true;
      setStatus("Saving game updates…", "default");

      try {
        await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            gameStartTs: kickoffIso,
            status: statusInput.value,
          }),
        });

        await loadGame();
        setStatus("Game updated.", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not update game.";
        showError(message);
        setStatus("Game update failed.", "error");
      } finally {
        saveButton.disabled = false;
      }
    });

    deleteButton.addEventListener("click", async () => {
      if (!window.confirm(`Delete game ${gameId}?`)) {
        return;
      }

      deleteButton.disabled = true;
      clearError();
      setStatus(`Deleting game ${gameId}…`, "default");

      try {
        await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}`, {
          method: "DELETE",
        });
        window.location.assign(`/seasons/${encodeURIComponent(currentSeasonId)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not delete game.";
        showError(message);
        setStatus("Game deletion failed.", "error");
      } finally {
        deleteButton.disabled = false;
      }
    });

    await loadGame();

    try {
      const season = await requestJsonOrThrow(`/v1/seasons/${encodeURIComponent(currentSeasonId)}`, {
        method: "GET",
      });
      currentLeagueId = season.leagueId;
      if (gameLeagueLink instanceof HTMLAnchorElement) {
        gameLeagueLink.href = `/leagues/${encodeURIComponent(currentLeagueId)}`;
      }
    } catch {
      // Keep existing game context if season lookup fails.
    }

    setStatus("Game page ready.", "success");
  }

  async function initialize() {
    clearError();

    try {
      await ensureAuthenticatedSession();
    } catch (error) {
      if (error instanceof Error && error.message === "redirecting_to_sign_in") {
        return;
      }

      showError("Could not verify sign-in state.");
      setStatus("Session check failed.", "error");
      return;
    }

    try {
      if (page === "dashboard") {
        await initDashboardPage();
        return;
      }

      if (page === "league") {
        await initLeaguePage();
        return;
      }

      if (page === "season") {
        await initSeasonPage();
        return;
      }

      if (page === "game") {
        await initGamePage();
        return;
      }

      setStatus("No page handler registered.", "error");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected setup page error.";
      showError(message);
      setStatus("Page load failed.", "error");
    }
  }

  void initialize();
})();
