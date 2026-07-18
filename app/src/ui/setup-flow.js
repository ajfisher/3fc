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

  function navigateTo(url, mode = "assign") {
    if (typeof window.__THREEFC_NAVIGATE__ === "function") {
      window.__THREEFC_NAVIGATE__(url, mode);
      return;
    }

    if (mode === "replace") {
      window.location.replace(url);
      return;
    }

    window.location.assign(url);
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

  function initialsForName(value) {
    const initials = value
      .trim()
      .split(/\s+/)
      .filter((segment) => segment.length > 0)
      .slice(0, 2)
      .map((segment) => segment[0]?.toUpperCase() ?? "")
      .join("");

    return initials || "P";
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

  function setFieldMessage(fieldId, state = "default", message = null) {
    const input = document.getElementById(fieldId);
    const notice = document.getElementById(`${fieldId}-notice`);
    if (!(input instanceof HTMLElement) || !(notice instanceof HTMLElement)) {
      return;
    }

    if (state === "invalid") {
      input.setAttribute("data-state", "invalid");
      input.setAttribute("aria-invalid", "true");
      notice.setAttribute("data-ui", "field-notice");
      notice.setAttribute("data-state", "invalid");
      notice.setAttribute("role", "alert");
      notice.removeAttribute("aria-live");
      notice.textContent = message ?? "";
      return;
    }

    if (state === "valid") {
      input.setAttribute("data-state", "valid");
      input.removeAttribute("aria-invalid");
      notice.setAttribute("data-ui", "field-notice");
      notice.setAttribute("data-state", "valid");
      notice.setAttribute("aria-live", "polite");
      notice.removeAttribute("role");
      notice.textContent = message ?? "";
      return;
    }

    input.setAttribute("data-state", "default");
    input.removeAttribute("aria-invalid");

    const defaultKind = notice.getAttribute("data-default-kind") ?? "empty";
    const defaultMessage = notice.getAttribute("data-default-message") ?? "";

    if (defaultKind === "hint") {
      notice.setAttribute("data-ui", "field-hint");
      notice.removeAttribute("data-state");
      notice.removeAttribute("role");
      notice.removeAttribute("aria-live");
      notice.textContent = defaultMessage;
      return;
    }

    if (defaultKind === "valid") {
      notice.setAttribute("data-ui", "field-notice");
      notice.setAttribute("data-state", "valid");
      notice.removeAttribute("role");
      notice.setAttribute("aria-live", "polite");
      notice.textContent = defaultMessage;
      return;
    }

    notice.setAttribute("data-ui", "field-hint");
    notice.removeAttribute("data-state");
    notice.removeAttribute("role");
    notice.removeAttribute("aria-live");
    notice.textContent = defaultMessage;
  }

  function buildApiUrl(path) {
    const normalizedBase = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    return new URL(normalizedPath, normalizedBase).toString();
  }

  function resolveRouteEntityId(attributeName, collectionName) {
    const attributeValue = root.getAttribute(attributeName);
    if (attributeValue && attributeValue.trim().length > 0) {
      return attributeValue.trim();
    }

    const pathSegments = window.location.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    const collectionIndex = pathSegments.indexOf(collectionName);
    if (collectionIndex < 0 || pathSegments.length <= collectionIndex + 1) {
      return null;
    }

    try {
      return decodeURIComponent(pathSegments[collectionIndex + 1]);
    } catch {
      return pathSegments[collectionIndex + 1];
    }
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

  function parseThirdLengthMinutes(value) {
    const parsed = Number.parseInt(String(value), 10);
    return [20, 25, 30].includes(parsed) ? parsed : 20;
  }

  function defaultTimerThirds() {
    return [1, 2, 3].map((third) => ({
      third,
      startedAt: null,
      finishedAt: null,
      status: "not_started",
    }));
  }

  function buildTimerState(game) {
    if (game?.timer && Array.isArray(game.timer.thirds)) {
      return game.timer;
    }

    const thirdLengthMinutes = parseThirdLengthMinutes(game?.thirdLengthMinutes);
    const sourceThirds = Array.isArray(game?.thirds) ? game.thirds : defaultTimerThirds();
    const thirdsByNumber = new Map(sourceThirds.map((third) => [third.third, third]));
    const thirds = [1, 2, 3].map((third) => {
      const segment = thirdsByNumber.get(third) ?? {
        third,
        startedAt: null,
        finishedAt: null,
      };
      const status = segment.finishedAt ? "finished" : segment.startedAt ? "running" : "not_started";
      return {
        third,
        startedAt: segment.startedAt ?? null,
        finishedAt: segment.finishedAt ?? null,
        status,
      };
    });
    const activeThird = thirds.find((third) => third.status === "running")?.third ?? null;
    const anyStarted = thirds.some((third) => third.startedAt !== null);
    const allFinished = thirds.every((third) => third.status === "finished");
    const status = activeThird
      ? "running"
      : allFinished
        ? "complete"
        : anyStarted
          ? "between_thirds"
          : "not_started";

    return {
      thirdLengthMinutes,
      activeThird,
      status,
      thirds,
    };
  }

  function elapsedSeconds(startedAt, finishedAt = null) {
    const started = new Date(startedAt);
    const finished = finishedAt ? new Date(finishedAt) : new Date();
    if (Number.isNaN(started.getTime()) || Number.isNaN(finished.getTime())) {
      return 0;
    }

    return Math.max(0, Math.floor((finished.getTime() - started.getTime()) / 1000));
  }

  function formatTimerDisplay(totalSeconds, thirdLengthMinutes) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const nominalSeconds = thirdLengthMinutes * 60;
    if (safeSeconds <= nominalSeconds) {
      const minutes = Math.floor(safeSeconds / 60);
      const seconds = safeSeconds % 60;
      return {
        displayTime: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
        phase: "regulation",
      };
    }

    const stoppageSeconds = safeSeconds - nominalSeconds;
    const stoppageMinute = Math.floor(stoppageSeconds / 60) + 1;
    return {
      displayTime: `${thirdLengthMinutes}+${String(stoppageMinute).padStart(2, "0")}`,
      phase: "stoppage",
    };
  }

  function humanTimerStatus(value) {
    const labels = {
      not_started: "Not started",
      running: "Running",
      between_thirds: "Between thirds",
      complete: "All thirds finished",
      finished: "Finished",
    };
    return labels[value] ?? value;
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
      navigateTo(`/sign-in?returnTo=${returnTo}`, "replace");
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
    leagueNameInput.addEventListener("input", () => {
      setFieldMessage("league-name");
    });
    leagueFriendlyUrlInput.addEventListener("input", () => {
      setFieldMessage("league-friendly-url");
    });

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
        setFieldMessage("league-name", "invalid", "League name is required.");
        leagueNameInput.focus();
        return;
      }

      setFieldMessage("league-name");

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

        navigateTo(`/leagues/${encodeURIComponent(leagueId)}`);
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
    const leagueId = resolveRouteEntityId("data-league-id", "leagues");
    if (!leagueId) {
      return;
    }

    const title = document.getElementById("league-title");
    const subtitle = document.getElementById("league-subtitle");
    const deleteLeagueButton = document.querySelector('[data-testid="delete-league"]');

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
    seasonNameInput.addEventListener("input", () => {
      setFieldMessage("season-name");
    });
    seasonFriendlyUrlInput.addEventListener("input", () => {
      setFieldMessage("season-friendly-url");
    });

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
        setFieldMessage("season-name", "invalid", "Season name is required.");
        seasonNameInput.focus();
        return;
      }

      setFieldMessage("season-name");

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

        navigateTo(`/seasons/${encodeURIComponent(seasonId)}`);
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
          navigateTo("/setup");
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
    const seasonId = resolveRouteEntityId("data-season-id", "seasons");
    if (!seasonId) {
      return;
    }

    const seasonTitle = document.getElementById("season-title");
    const seasonSubtitle = document.getElementById("season-subtitle");
    const seasonLeagueLink = document.getElementById("season-league-link");

    const gameDateInput = document.getElementById("game-date");
    const gameKickoffInput = document.getElementById("game-kickoff");
    const gameThirdLengthInput = document.getElementById("game-third-length");
    const gameIdDisplay = document.getElementById("game-id-display");
    const createGameButton = root.querySelector('[data-action="create-game"]');

    const deleteSeasonButton = document.querySelector('[data-testid="delete-season"]');

    const gamesBody = document.getElementById("season-games-body");
    const gamesTableWrap = document.querySelector('[data-testid="season-games-table"]');
    const gamesEmpty = document.getElementById("season-games-empty");

    if (
      !(gameDateInput instanceof HTMLInputElement) ||
      !(gameKickoffInput instanceof HTMLInputElement) ||
      !(gameThirdLengthInput instanceof HTMLSelectElement) ||
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
      setFieldMessage("game-date");
      updateDerivedGameId();
    });
    gameKickoffInput.addEventListener("change", () => {
      setFieldMessage("game-kickoff");
      updateDerivedGameId();
    });
    gameDateInput.addEventListener("input", () => {
      setFieldMessage("game-date");
    });
    gameKickoffInput.addEventListener("input", () => {
      setFieldMessage("game-kickoff");
    });

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
        setFieldMessage("game-date", "invalid", "Game date is required.");
        gameDateInput.focus();
        return;
      }
      setFieldMessage("game-date");

      const kickoffIso = toIsoTimestamp(gameKickoff);
      if (!kickoffIso) {
        setFieldMessage("game-kickoff", "invalid", "Kickoff time must be valid.");
        gameKickoffInput.focus();
        return;
      }
      setFieldMessage("game-kickoff");

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
            thirdLengthMinutes: parseThirdLengthMinutes(gameThirdLengthInput.value),
          }),
        });

        navigateTo(`/games/${encodeURIComponent(gameId)}`);
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
          navigateTo(`/leagues/${encodeURIComponent(leagueId)}`);
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
    const gameId = resolveRouteEntityId("data-game-id", "games");
    if (!gameId) {
      return;
    }

    const title = document.getElementById("game-title");
    const subtitle = document.getElementById("game-subtitle");
    const gameLeagueLink = document.getElementById("game-league-link");
    const gameSeasonLink = document.getElementById("game-season-link");

    const gameIdValue = document.getElementById("game-id-value");
    const gameLeagueId = document.getElementById("game-league-id");
    const gameSeasonId = document.getElementById("game-season-id");

    const kickoffInput = document.getElementById("game-edit-kickoff");
    const statusInput = document.getElementById("game-edit-status");
    const thirdLengthInput = document.getElementById("game-edit-third-length");
    const saveButton = root.querySelector('[data-action="save-game"]');
    const deleteButton = root.querySelector('[data-action="delete-game"]');
    const createAnotherLink = document.getElementById("create-another-game-link");
    const timerThirdLabel = document.getElementById("timer-third-label");
    const timerDisplayValue = document.getElementById("timer-display-value");
    const timerPhaseLabel = document.getElementById("timer-phase-label");
    const timerThirdLength = document.getElementById("timer-third-length");
    const timerStatus = document.getElementById("timer-status");
    const timerActiveThird = document.getElementById("timer-active-third");
    const thirdStatusList = document.getElementById("third-status-list");
    const startThirdButton = root.querySelector('[data-action="start-active-third"]');
    const finishThirdButton = root.querySelector('[data-action="finish-active-third"]');
    const playerNicknameInput = document.getElementById("player-nickname");
    const quickCreatePlayerButton = root.querySelector('[data-action="quick-create-player"]');
    const playerSearchInput = document.getElementById("player-search");
    const playerPoolElement = document.getElementById("player-pool");
    const rosterTeamsElement = document.getElementById("roster-teams");
    const liveScoreboardElement = document.getElementById("live-scoreboard");
    const goalScoringTeamInput = document.getElementById("goal-scoring-team");
    const goalConcedingTeamInput = document.getElementById("goal-conceding-team");
    const goalOwnGoalInput = document.getElementById("goal-own-goal");
    const goalScorerInput = document.getElementById("goal-scorer");
    const goalAssistsElement = document.getElementById("goal-assists");
    const goalFormNote = document.getElementById("goal-form-note");
    const saveGoalButton = root.querySelector('[data-action="save-goal"]');
    const cancelGoalEditButton = root.querySelector('[data-action="cancel-goal-edit"]');
    const undoLastGoalButton = root.querySelector('[data-action="undo-last-goal"]');
    const goalTimelineElement = document.getElementById("goal-timeline");

    if (
      !(kickoffInput instanceof HTMLInputElement) ||
      !(statusInput instanceof HTMLSelectElement) ||
      !(thirdLengthInput instanceof HTMLSelectElement) ||
      !(saveButton instanceof HTMLButtonElement) ||
      !(deleteButton instanceof HTMLButtonElement) ||
      !(startThirdButton instanceof HTMLButtonElement) ||
      !(finishThirdButton instanceof HTMLButtonElement)
    ) {
      return;
    }

    let currentLeagueId = "";
    let currentSeasonId = "";
    let currentGame = null;
    let timerTickInterval = 0;
    let rosterTeams = [];
    let rosterPlayers = [];
    let rosterAssignments = [];
    let rosterSearchTimer = 0;
    let scoreboardTeams = [];
    let goalTimeline = [];
    let editingGoalId = null;

    kickoffInput.addEventListener("input", () => {
      setFieldMessage("game-edit-kickoff");
    });

    function nextStartableThird(timer) {
      if (timer.status === "running" || timer.status === "complete") {
        return null;
      }

      const next = timer.thirds.find((third) => third.status === "not_started");
      if (!next) {
        return null;
      }

      return next.third;
    }

    function displaySegmentForTimer(timer) {
      const running = timer.thirds.find((third) => third.status === "running");
      if (running) {
        return running;
      }

      const finished = [...timer.thirds].reverse().find((third) => third.status === "finished");
      return finished ?? timer.thirds[0] ?? null;
    }

    function syncStatusOptions(hasStarted) {
      const scheduledOption = statusInput.querySelector('option[value="scheduled"]');
      if (scheduledOption instanceof HTMLOptionElement) {
        scheduledOption.disabled = hasStarted;
      }

      if (hasStarted && statusInput.value === "scheduled") {
        statusInput.value = currentGame.status === "finished" ? "finished" : "live";
      }
    }

    function renderTimer() {
      if (!currentGame) {
        return;
      }

      const timer = buildTimerState(currentGame);
      const segment = displaySegmentForTimer(timer);
      const hasStarted = timer.thirds.some((third) => third.startedAt !== null);
      const activeSegment = timer.thirds.find((third) => third.status === "running") ?? null;
      const display = segment?.startedAt
        ? formatTimerDisplay(
            elapsedSeconds(segment.startedAt, segment.finishedAt),
            timer.thirdLengthMinutes,
          )
        : { displayTime: "00:00", phase: "regulation" };
      const nextThird = nextStartableThird(timer);

      thirdLengthInput.value = String(timer.thirdLengthMinutes);
      thirdLengthInput.disabled = hasStarted;
      syncStatusOptions(hasStarted);

      if (timerThirdLabel) {
        timerThirdLabel.textContent = segment ? `Third ${segment.third}` : "Third 1";
      }
      if (timerDisplayValue) {
        timerDisplayValue.textContent = display.displayTime;
      }
      if (timerPhaseLabel) {
        timerPhaseLabel.textContent =
          timer.status === "running" && display.phase === "stoppage"
            ? "Stoppage"
            : humanTimerStatus(timer.status);
      }
      if (timerThirdLength) {
        timerThirdLength.textContent = `${timer.thirdLengthMinutes} minutes`;
      }
      if (timerStatus) {
        timerStatus.textContent = humanTimerStatus(timer.status);
      }
      if (timerActiveThird) {
        timerActiveThird.textContent = timer.activeThird ? `Third ${timer.activeThird}` : "-";
      }
      if (thirdStatusList) {
        thirdStatusList.innerHTML = timer.thirds
          .map((third) => {
            const status = humanTimerStatus(third.status);
            const detail = third.finishedAt
              ? `Finished ${third.finishedAt}`
              : third.startedAt
                ? `Started ${third.startedAt}`
                : "Waiting";
            return `<li data-ui="third-status-item" data-state="${escapeHtml(third.status)}">
              <strong>Third ${third.third}</strong>
              <span>${escapeHtml(status)}</span>
              <small>${escapeHtml(detail)}</small>
            </li>`;
          })
          .join("");
      }

      const gameFinished = currentGame.status === "finished";
      startThirdButton.disabled = gameFinished || nextThird === null;
      finishThirdButton.disabled = gameFinished || !activeSegment;
      startThirdButton.textContent = nextThird ? `Start Third ${nextThird}` : "Start Third";
      finishThirdButton.textContent = activeSegment ? `Finish Third ${activeSegment.third}` : "Finish Third";
      if (nextThird) {
        startThirdButton.setAttribute("data-third", String(nextThird));
      } else {
        startThirdButton.removeAttribute("data-third");
      }
      if (activeSegment) {
        finishThirdButton.setAttribute("data-third", String(activeSegment.third));
      } else {
        finishThirdButton.removeAttribute("data-third");
      }

      window.clearInterval(timerTickInterval);
      timerTickInterval = 0;
      if (activeSegment) {
        timerTickInterval = window.setInterval(renderTimer, 1000);
      }
    }

    function rosterControlsAvailable() {
      return (
        playerNicknameInput instanceof HTMLInputElement &&
        quickCreatePlayerButton instanceof HTMLButtonElement &&
        playerSearchInput instanceof HTMLInputElement &&
        playerPoolElement instanceof HTMLElement &&
        rosterTeamsElement instanceof HTMLElement
      );
    }

    function liveControlsAvailable() {
      return (
        liveScoreboardElement instanceof HTMLElement &&
        goalScoringTeamInput instanceof HTMLSelectElement &&
        goalConcedingTeamInput instanceof HTMLSelectElement &&
        goalOwnGoalInput instanceof HTMLInputElement &&
        goalScorerInput instanceof HTMLSelectElement &&
        goalAssistsElement instanceof HTMLElement &&
        goalFormNote instanceof HTMLElement &&
        saveGoalButton instanceof HTMLButtonElement &&
        cancelGoalEditButton instanceof HTMLButtonElement &&
        undoLastGoalButton instanceof HTMLButtonElement &&
        goalTimelineElement instanceof HTMLElement
      );
    }

    function teamById(teamId) {
      return rosterTeams.find((team) => team.teamId === teamId) ?? null;
    }

    function playerById(playerId) {
      const rosterPlayer = rosterAssignments.find((assignment) => assignment.playerId === playerId)?.player;
      if (rosterPlayer) {
        return rosterPlayer;
      }

      return rosterPlayers.find((player) => player.playerId === playerId) ?? null;
    }

    function playerNickname(playerId) {
      return playerById(playerId)?.nickname ?? playerId;
    }

    function teamName(teamId) {
      return teamById(teamId)?.name ?? teamId;
    }

    function assignmentByPlayerId(playerId) {
      return rosterAssignments.find((assignment) => assignment.playerId === playerId) ?? null;
    }

    function rosteredPlayers() {
      const seen = new Set();
      const players = [];

      for (const assignment of rosterAssignments) {
        const player = assignment.player ?? playerById(assignment.playerId);
        if (!player || seen.has(assignment.playerId)) {
          continue;
        }

        seen.add(assignment.playerId);
        players.push({
          ...player,
          teamId: assignment.teamId,
        });
      }

      return players;
    }

    function rosteredPlayersForTeam(teamId) {
      return rosteredPlayers().filter((player) => player.teamId === teamId);
    }

    function activeThirdNumber() {
      if (!currentGame) {
        return null;
      }

      return buildTimerState(currentGame).activeThird;
    }

    function normalizeScoreboardTeams(teams) {
      return teams.map((team) => ({
        gameId: team.gameId ?? gameId,
        teamId: team.teamId,
        name: team.name ?? team.teamId,
        color: typeof team.color === "string" ? team.color : null,
        scored: Number.isInteger(team.scored) && team.scored >= 0 ? team.scored : 0,
        conceded: Number.isInteger(team.conceded) && team.conceded >= 0 ? team.conceded : 0,
        createdAt: team.createdAt ?? "",
        updatedAt: team.updatedAt ?? "",
      }));
    }

    function scoreboardTeamsInRosterOrder() {
      const byTeamId = new Map(scoreboardTeams.map((team) => [team.teamId, team]));
      const ordered = rosterTeams
        .map((team) => byTeamId.get(team.teamId) ?? normalizeScoreboardTeams([team])[0])
        .filter(Boolean);

      if (ordered.length > 0) {
        return ordered;
      }

      return scoreboardTeams;
    }

    function sortGoalTimeline(timeline) {
      return [...timeline].sort((left, right) => {
        const thirdDelta = (left.third ?? 0) - (right.third ?? 0);
        if (thirdDelta !== 0) {
          return thirdDelta;
        }

        const elapsedDelta = (left.elapsedSeconds ?? 0) - (right.elapsedSeconds ?? 0);
        if (elapsedDelta !== 0) {
          return elapsedDelta;
        }

        return String(left.eventId ?? "").localeCompare(String(right.eventId ?? ""));
      });
    }

    function teamSwatchStyle(team) {
      const color = typeof team.color === "string" && team.color.length > 0 ? team.color : "#d9f0e8";
      if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) {
        return "";
      }

      return ` style="--team-color: ${escapeHtml(color)}"`;
    }

    function renderSelectOptions(selectElement, options, selectedValue, emptyLabel = "Select") {
      const safeSelected = options.some((option) => option.value === selectedValue)
        ? selectedValue
        : (options[0]?.value ?? "");

      selectElement.innerHTML =
        options.length > 0
          ? options
              .map(
                (option) =>
                  `<option value="${escapeHtml(option.value)}"${option.value === safeSelected ? " selected" : ""}>${escapeHtml(
                    option.label,
                  )}</option>`,
              )
              .join("")
          : `<option value="">${escapeHtml(emptyLabel)}</option>`;
      selectElement.value = safeSelected;
      selectElement.disabled = options.length === 0;
    }

    function renderLiveScoreboard() {
      if (!(liveScoreboardElement instanceof HTMLElement)) {
        return;
      }

      const teams = scoreboardTeamsInRosterOrder();
      if (teams.length === 0) {
        liveScoreboardElement.innerHTML = `<p data-ui="empty-note">Teams load before scoring.</p>`;
        return;
      }

      liveScoreboardElement.innerHTML = teams
        .map(
          (team) => `<article data-ui="score-team" data-team-id="${escapeHtml(team.teamId)}"${teamSwatchStyle(team)}>
            <header>
              <span data-ui="team-swatch"></span>
              <strong>${escapeHtml(team.name)}</strong>
            </header>
            <dl>
              <div><dt>Scored</dt><dd>${escapeHtml(String(team.scored))}</dd></div>
              <div><dt>Conceded</dt><dd>${escapeHtml(String(team.conceded))}</dd></div>
            </dl>
          </article>`,
        )
        .join("");
    }

    function selectedAssistPlayerIds() {
      if (!(goalAssistsElement instanceof HTMLElement)) {
        return [];
      }

      return [...goalAssistsElement.querySelectorAll('input[type="checkbox"]:checked')]
        .map((input) => (input instanceof HTMLInputElement ? input.value : ""))
        .filter((value) => value.length > 0)
        .slice(0, 3);
    }

    function renderGoalAssistChoices(scorerPlayerId, seedAssistPlayerIds = null) {
      if (!(goalAssistsElement instanceof HTMLElement)) {
        return;
      }

      const rostered = rosteredPlayers().filter((player) => player.playerId !== scorerPlayerId);
      const seeded = seedAssistPlayerIds ?? selectedAssistPlayerIds();
      const selected = new Set(seeded.filter((playerId) => playerId !== scorerPlayerId).slice(0, 3));

      if (rostered.length === 0) {
        goalAssistsElement.innerHTML = `<p data-ui="empty-note">No assist options yet.</p>`;
        return;
      }

      goalAssistsElement.innerHTML = rostered
        .map((player) => {
          const checked = selected.has(player.playerId);
          const disabled = !checked && selected.size >= 3;
          return `<label data-ui="check-row">
            <input type="checkbox" value="${escapeHtml(player.playerId)}"${checked ? " checked" : ""}${
              disabled ? " disabled" : ""
            } />
            <span>${escapeHtml(player.nickname)} <small>${escapeHtml(teamName(player.teamId))}</small></span>
          </label>`;
        })
        .join("");
    }

    function renderGoalControls(seed = {}) {
      if (!liveControlsAvailable()) {
        return;
      }

      const ownGoal = seed.ownGoal ?? goalOwnGoalInput.checked;
      const teamOptions = rosterTeams.map((team) => ({
        value: team.teamId,
        label: team.name,
      }));
      const previousScoringTeamId = seed.scoringTeamId ?? goalScoringTeamInput.value;
      const previousConcedingTeamId = seed.concedingTeamId ?? goalConcedingTeamInput.value;

      goalOwnGoalInput.checked = ownGoal;
      if (ownGoal) {
        goalScoringTeamInput.innerHTML = `<option value="">Own goal</option>`;
        goalScoringTeamInput.value = "";
        goalScoringTeamInput.disabled = true;
      } else {
        renderSelectOptions(goalScoringTeamInput, teamOptions, previousScoringTeamId, "No teams");
      }

      const scoringTeamId = ownGoal ? null : goalScoringTeamInput.value;
      const concedingOptions = ownGoal
        ? teamOptions
        : teamOptions.filter((team) => team.value !== scoringTeamId);
      renderSelectOptions(goalConcedingTeamInput, concedingOptions, previousConcedingTeamId, "No conceding teams");

      const concedingTeamId = goalConcedingTeamInput.value;
      const scorerPool = ownGoal
        ? rosteredPlayersForTeam(concedingTeamId)
        : rosteredPlayersForTeam(scoringTeamId);
      const scorerOptions = scorerPool.map((player) => ({
        value: player.playerId,
        label: player.nickname,
      }));
      const selectedScorerId = seed.scorerPlayerId ?? goalScorerInput.value;
      renderSelectOptions(goalScorerInput, scorerOptions, selectedScorerId, "Assign players first");
      renderGoalAssistChoices(goalScorerInput.value, seed.assistPlayerIds ?? null);

      const activeThird = activeThirdNumber();
      saveGoalButton.textContent = editingGoalId ? "Save goal" : "Add goal";
      cancelGoalEditButton.hidden = editingGoalId === null;
      cancelGoalEditButton.disabled = editingGoalId === null;
      undoLastGoalButton.disabled = goalTimeline.length === 0;
      undoLastGoalButton.textContent = goalTimeline.length > 0 ? "Undo last" : "Undo last";

      if (!activeThird) {
        goalFormNote.textContent = "Start a third before adding goals.";
        return;
      }

      if (rosterTeams.length < 2) {
        goalFormNote.textContent = "Teams load before scoring.";
        return;
      }

      if (rosteredPlayers().length === 0) {
        goalFormNote.textContent = "Assign players before scoring.";
        return;
      }

      goalFormNote.textContent = editingGoalId
        ? "Editing keeps the original timer stamp."
        : `Goal will be added to third ${activeThird}.`;
    }

    function timelineGoalLabel(goal) {
      const scorer = playerNickname(goal.scorerPlayerId);
      if (goal.ownGoal) {
        return `${scorer} own goal against ${teamName(goal.concedingTeamId)}`;
      }

      return `${scorer} for ${teamName(goal.scoringTeamId)}`;
    }

    function renderGoalTimeline() {
      if (!(goalTimelineElement instanceof HTMLElement)) {
        return;
      }

      if (goalTimeline.length === 0) {
        goalTimelineElement.innerHTML = `<li data-ui="empty-note">No goals yet.</li>`;
        return;
      }

      const latestEventId = goalTimeline.at(-1)?.eventId ?? null;
      goalTimelineElement.innerHTML = [...goalTimeline]
        .reverse()
        .map((goal) => {
          const assists =
            Array.isArray(goal.assistPlayerIds) && goal.assistPlayerIds.length > 0
              ? goal.assistPlayerIds.map((playerId) => playerNickname(playerId)).join(", ")
              : "None";
          const latest = goal.eventId === latestEventId;
          return `<li data-ui="goal-event" data-event-id="${escapeHtml(goal.eventId)}"${
            latest ? ' data-state="latest"' : ""
          }>
            <div data-ui="goal-event-main">
              <strong>${escapeHtml(goal.displayTime)} · Third ${escapeHtml(String(goal.third))}</strong>
              <span>${escapeHtml(timelineGoalLabel(goal))}</span>
              <small>Assists: ${escapeHtml(assists)}</small>
              ${goal.ownGoal ? `<small>Own goal: conceding tally only</small>` : ""}
            </div>
            <div data-ui="row-action-buttons">
              ${latest ? `<span data-ui="latest-flag">Latest</span>` : ""}
              <button data-ui="row-action" type="button" data-action="edit-goal" data-event-id="${escapeHtml(
                goal.eventId,
              )}">Edit</button>
              <button data-ui="row-action" data-tone="danger" type="button" data-action="delete-goal" data-event-id="${escapeHtml(
                goal.eventId,
              )}">Delete</button>
            </div>
          </li>`;
        })
        .join("");
    }

    function renderLiveScoring(seed = {}) {
      if (!liveControlsAvailable()) {
        return;
      }

      renderLiveScoreboard();
      renderGoalControls(seed);
      renderGoalTimeline();
    }

    function applyGoalMutationResult(result, fallback = {}) {
      if (Array.isArray(result?.scoreboard?.teams)) {
        scoreboardTeams = normalizeScoreboardTeams(result.scoreboard.teams);
      }

      if (Array.isArray(result?.timeline)) {
        goalTimeline = sortGoalTimeline(result.timeline);
      } else if (result?.goal) {
        const nextGoal = result.goal;
        goalTimeline = sortGoalTimeline([
          ...goalTimeline.filter((goal) => goal.eventId !== nextGoal.eventId),
          nextGoal,
        ]);
      } else if (fallback.deletedEventId) {
        goalTimeline = goalTimeline.filter((goal) => goal.eventId !== fallback.deletedEventId);
      }

      editingGoalId = null;
      renderLiveScoring();
    }

    function resetGoalForm() {
      editingGoalId = null;
      if (goalOwnGoalInput instanceof HTMLInputElement) {
        goalOwnGoalInput.checked = false;
      }
      renderLiveScoring();
    }

    function populateGoalForm(goal) {
      editingGoalId = goal.eventId;
      renderLiveScoring({
        ownGoal: Boolean(goal.ownGoal),
        scoringTeamId: goal.scoringTeamId ?? "",
        concedingTeamId: goal.concedingTeamId,
        scorerPlayerId: goal.scorerPlayerId,
        assistPlayerIds: Array.isArray(goal.assistPlayerIds) ? goal.assistPlayerIds : [],
      });
      goalScorerInput?.focus();
    }

    function buildGoalPayload() {
      const activeThird = activeThirdNumber();
      if (!activeThird && !editingGoalId) {
        return {
          error: "Start a third before adding goals.",
        };
      }

      const ownGoal = goalOwnGoalInput.checked;
      const scoringTeamId = ownGoal ? null : goalScoringTeamInput.value;
      const concedingTeamId = goalConcedingTeamInput.value;
      const scorerPlayerId = goalScorerInput.value;
      const assistPlayerIds = selectedAssistPlayerIds().filter((playerId) => playerId !== scorerPlayerId).slice(0, 3);

      if (!concedingTeamId) {
        return {
          error: "Choose a conceding team.",
        };
      }

      if (!ownGoal && !scoringTeamId) {
        return {
          error: "Choose a scoring team.",
        };
      }

      if (!ownGoal && scoringTeamId === concedingTeamId) {
        return {
          error: "Scoring and conceding teams must differ.",
        };
      }

      if (!scorerPlayerId) {
        return {
          error: "Choose a scorer.",
        };
      }

      return {
        payload: {
          scoringTeamId,
          concedingTeamId,
          scorerPlayerId,
          assistPlayerIds,
          ownGoal,
        },
      };
    }

    function assignmentButtons(playerId, currentTeamId = null) {
      return rosterTeams
        .map((team) => {
          const active = currentTeamId === team.teamId ? ' data-state="active" aria-pressed="true"' : "";
          return `<button data-ui="row-action" type="button" data-action="assign-player" data-player-id="${escapeHtml(
            playerId,
          )}" data-team-id="${escapeHtml(team.teamId)}"${active}>${escapeHtml(team.name)}</button>`;
        })
        .join("");
    }

    function renderPlayerPool() {
      if (!(playerPoolElement instanceof HTMLElement)) {
        return;
      }

      if (rosterPlayers.length === 0) {
        playerPoolElement.innerHTML = `<p data-ui="empty-note">No players found.</p>`;
        return;
      }

      playerPoolElement.innerHTML = rosterPlayers
        .map((player) => {
          const assignment = assignmentByPlayerId(player.playerId);
          const assignedTeam = assignment ? teamById(assignment.teamId) : null;
          const statusText = assignedTeam ? `Assigned to ${assignedTeam.name}` : "Unassigned";
          return `<article data-ui="roster-player" data-player-id="${escapeHtml(player.playerId)}">
            <figure data-ui="avatar"><span>${escapeHtml(initialsForName(player.nickname))}</span></figure>
            <div data-ui="roster-player-main">
              <strong>${escapeHtml(player.nickname)}</strong>
              <span>${escapeHtml(statusText)}</span>
            </div>
            <div data-ui="row-action-buttons">
              ${assignmentButtons(player.playerId, assignment?.teamId ?? null)}
            </div>
          </article>`;
        })
        .join("");
    }

    function renderRosterTeams() {
      if (!(rosterTeamsElement instanceof HTMLElement)) {
        return;
      }

      if (rosterTeams.length === 0) {
        rosterTeamsElement.innerHTML = `<p data-ui="empty-note">No teams found.</p>`;
        return;
      }

      rosterTeamsElement.innerHTML = rosterTeams
        .map((team) => {
          const assignments = rosterAssignments.filter((assignment) => assignment.teamId === team.teamId);
          const players = assignments
            .map((assignment) => {
              const player = assignment.player ?? playerById(assignment.playerId);
              const nickname = player?.nickname ?? assignment.playerId;
              return `<li data-ui="roster-member">
                <span>${escapeHtml(nickname)}</span>
                <div data-ui="row-action-buttons">
                  ${assignmentButtons(assignment.playerId, team.teamId)}
                </div>
              </li>`;
            })
            .join("");

          return `<article data-ui="roster-team" data-team-id="${escapeHtml(team.teamId)}"${teamSwatchStyle(team)}>
            <header>
              <span data-ui="team-swatch"></span>
              <h4>${escapeHtml(team.name)}</h4>
              <span data-ui="roster-count">${assignments.length}</span>
            </header>
            <ul>
              ${players || `<li data-ui="empty-note">No players assigned.</li>`}
            </ul>
          </article>`;
        })
        .join("");
    }

    function renderRosterSetup() {
      renderPlayerPool();
      renderRosterTeams();
    }

    async function loadRosterSetup(options = {}) {
      if (!rosterControlsAvailable()) {
        return;
      }

      const search = playerSearchInput.value.trim();
      const searchQuery = search ? `?search=${encodeURIComponent(search)}` : "";
      const [rosterPayload, playersPayload] = await Promise.all([
        requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/roster`, { method: "GET" }),
        requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/players${searchQuery}`, {
          method: "GET",
        }),
      ]);

      rosterTeams = Array.isArray(rosterPayload?.teams) ? rosterPayload.teams : [];
      rosterAssignments = Array.isArray(rosterPayload?.roster) ? rosterPayload.roster : [];
      rosterPlayers = Array.isArray(playersPayload?.players) ? playersPayload.players : [];
      if (scoreboardTeams.length === 0 || goalTimeline.length === 0) {
        scoreboardTeams = normalizeScoreboardTeams(rosterTeams);
      }
      renderRosterSetup();
      renderLiveScoring();

      if (options.updateStatus !== false) {
        setStatus("Game roster ready.", "success");
      }
    }

    async function loadGameGoals() {
      if (!liveControlsAvailable()) {
        return true;
      }

      let payload;
      try {
        payload = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/goals`, {
          method: "GET",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load goal timeline.";
        showError(message);
        setStatus("Could not load goal timeline.", "error");
        renderLiveScoring();
        return false;
      }

      if (Array.isArray(payload?.scoreboard?.teams)) {
        scoreboardTeams = normalizeScoreboardTeams(payload.scoreboard.teams);
      }

      goalTimeline = Array.isArray(payload?.timeline) ? sortGoalTimeline(payload.timeline) : [];
      renderLiveScoring();
      return true;
    }

    async function loadGame() {
      const game = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}`, {
        method: "GET",
      });

      currentGame = game;
      currentLeagueId = game.leagueId;
      currentSeasonId = game.seasonId;

      if (title) {
        title.textContent = game.gameId;
      }

      if (subtitle) {
        subtitle.innerHTML = `Kickoff (UTC): <code>${escapeHtml(game.gameStartTs)}</code>`;
      }

      if (gameIdValue) {
        gameIdValue.textContent = game.gameId;
      }
      if (gameLeagueId) {
        gameLeagueId.textContent = game.leagueId;
      }
      if (gameSeasonId) {
        gameSeasonId.textContent = game.seasonId;
      }

      kickoffInput.value = toLocalDateTimeInput(game.gameStartTs);
      statusInput.value = game.status;
      thirdLengthInput.value = String(parseThirdLengthMinutes(game.thirdLengthMinutes ?? game.timer?.thirdLengthMinutes));
      renderTimer();

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
        setFieldMessage("game-edit-kickoff", "invalid", "Kickoff time must be valid.");
        kickoffInput.focus();
        return;
      }
      setFieldMessage("game-edit-kickoff");

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
            thirdLengthMinutes: parseThirdLengthMinutes(thirdLengthInput.value),
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
        navigateTo(`/seasons/${encodeURIComponent(currentSeasonId)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not delete game.";
        showError(message);
        setStatus("Game deletion failed.", "error");
      } finally {
        deleteButton.disabled = false;
      }
    });

    startThirdButton.addEventListener("click", async () => {
      const third = startThirdButton.getAttribute("data-third");
      if (!third) {
        return;
      }

      startThirdButton.disabled = true;
      clearError();
      setStatus(`Starting third ${third}…`, "default");

      try {
        currentGame = await requestJsonOrThrow(
          `/v1/games/${encodeURIComponent(gameId)}/thirds/${encodeURIComponent(third)}/start`,
          { method: "POST" },
        );
        renderTimer();
        renderLiveScoring();
        statusInput.value = currentGame.status;
        setStatus(`Third ${third} started.`, "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start third.";
        showError(message);
        setStatus("Third start failed.", "error");
      } finally {
        startThirdButton.disabled = false;
        renderTimer();
        renderLiveScoring();
      }
    });

    finishThirdButton.addEventListener("click", async () => {
      const third = finishThirdButton.getAttribute("data-third");
      if (!third) {
        return;
      }

      finishThirdButton.disabled = true;
      clearError();
      setStatus(`Finishing third ${third}…`, "default");

      try {
        currentGame = await requestJsonOrThrow(
          `/v1/games/${encodeURIComponent(gameId)}/thirds/${encodeURIComponent(third)}/finish`,
          { method: "POST" },
        );
        renderTimer();
        renderLiveScoring();
        statusInput.value = currentGame.status;
        setStatus(`Third ${third} finished.`, "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not finish third.";
        showError(message);
        setStatus("Third finish failed.", "error");
      } finally {
        finishThirdButton.disabled = false;
        renderTimer();
        renderLiveScoring();
      }
    });

    if (rosterControlsAvailable()) {
      playerNicknameInput.addEventListener("input", () => {
        setFieldMessage("player-nickname");
      });

      playerSearchInput.addEventListener("input", () => {
        window.clearTimeout(rosterSearchTimer);
        rosterSearchTimer = window.setTimeout(() => {
          void loadRosterSetup({ updateStatus: false }).catch((error) => {
            const message = error instanceof Error ? error.message : "Could not search players.";
            showError(message);
            setStatus("Player search failed.", "error");
          });
        }, 160);
      });

      quickCreatePlayerButton.addEventListener("click", async () => {
        clearError();

        const nickname = playerNicknameInput.value.trim();
        if (!nickname) {
          setFieldMessage("player-nickname", "invalid", "Player nickname is required.");
          playerNicknameInput.focus();
          return;
        }

        const nicknameSlug = slugify(nickname) || "player";
        const playerId = `player-${nicknameSlug}-${randomSuffix(6)}`;
        quickCreatePlayerButton.disabled = true;
        setStatus("Creating player…", "default");

        try {
          await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/players`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": createIdempotencyKey("create-player", `${gameId}-${playerId}`),
            },
            body: JSON.stringify({
              playerId,
              nickname,
            }),
          });

          playerNicknameInput.value = "";
          playerSearchInput.value = "";
          setFieldMessage("player-nickname", "valid", "Player created.");
          await loadRosterSetup({ updateStatus: false });
          setStatus("Player created.", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not create player.";
          showError(message);
          setStatus("Player creation failed.", "error");
        } finally {
          quickCreatePlayerButton.disabled = false;
        }
      });

      root.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement)) {
          return;
        }

        if (target.getAttribute("data-action") !== "assign-player") {
          return;
        }

        const playerId = target.getAttribute("data-player-id");
        const teamId = target.getAttribute("data-team-id");
        if (!playerId || !teamId) {
          return;
        }

        target.disabled = true;
        clearError();
        setStatus("Assigning player…", "default");

        try {
          await requestJsonOrThrow(
            `/v1/games/${encodeURIComponent(gameId)}/roster/${encodeURIComponent(playerId)}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                teamId,
              }),
            },
          );

          await loadRosterSetup({ updateStatus: false });
          const player = playerById(playerId);
          const team = teamById(teamId);
          setStatus(
            `${player?.nickname ?? "Player"} assigned to ${team?.name ?? teamId}.`,
            "success",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not assign player.";
          showError(message);
          setStatus("Roster assignment failed.", "error");
        } finally {
          target.disabled = false;
        }
      });
    }

    if (liveControlsAvailable()) {
      goalScoringTeamInput.addEventListener("change", () => {
        renderLiveScoring();
      });

      goalConcedingTeamInput.addEventListener("change", () => {
        renderLiveScoring();
      });

      goalOwnGoalInput.addEventListener("change", () => {
        renderLiveScoring();
      });

      goalScorerInput.addEventListener("change", () => {
        renderLiveScoring();
      });

      goalAssistsElement.addEventListener("change", () => {
        renderGoalAssistChoices(goalScorerInput.value);
      });

      saveGoalButton.addEventListener("click", async () => {
        clearError();
        const draft = buildGoalPayload();
        if (draft.error || !draft.payload) {
          showError(draft.error ?? "Goal details are incomplete.");
          setStatus("Goal validation failed.", "error");
          return;
        }

        saveGoalButton.disabled = true;
        const eventId = editingGoalId;
        const actionLabel = eventId ? "Saving goal edit" : "Adding goal";
        setStatus(`${actionLabel}…`, "default");

        try {
          const path = eventId
            ? `/v1/games/${encodeURIComponent(gameId)}/goals/${encodeURIComponent(eventId)}`
            : `/v1/games/${encodeURIComponent(gameId)}/goals`;
          const result = await requestJsonOrThrow(path, {
            method: eventId ? "PATCH" : "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": createIdempotencyKey(eventId ? "update-goal" : "create-goal", `${gameId}-${eventId ?? "new"}`),
            },
            body: JSON.stringify(draft.payload),
          });

          applyGoalMutationResult(result);
          setStatus(eventId ? "Goal updated." : "Goal added.", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not save goal.";
          showError(message);
          setStatus("Goal save failed.", "error");
        } finally {
          saveGoalButton.disabled = false;
          renderLiveScoring();
        }
      });

      cancelGoalEditButton.addEventListener("click", () => {
        resetGoalForm();
        setStatus("Goal edit cancelled.", "default");
      });

      undoLastGoalButton.addEventListener("click", async () => {
        const latest = goalTimeline.at(-1);
        if (!latest) {
          return;
        }

        undoLastGoalButton.disabled = true;
        clearError();
        setStatus("Undoing latest goal…", "default");

        try {
          const result = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/goals/undo-last`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": createIdempotencyKey("undo-goal", `${gameId}-${latest.eventId}`),
            },
            body: JSON.stringify({
              expectedEventId: latest.eventId,
            }),
          });

          applyGoalMutationResult(result, { deletedEventId: latest.eventId });
          setStatus("Latest goal undone.", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not undo latest goal.";
          showError(message);
          setStatus("Goal undo failed.", "error");
        } finally {
          undoLastGoalButton.disabled = false;
          renderLiveScoring();
        }
      });

      root.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement)) {
          return;
        }

        const action = target.getAttribute("data-action");
        if (action !== "edit-goal" && action !== "delete-goal") {
          return;
        }

        const eventId = target.getAttribute("data-event-id");
        if (!eventId) {
          return;
        }

        const goal = goalTimeline.find((item) => item.eventId === eventId);
        if (!goal) {
          return;
        }

        if (action === "edit-goal") {
          populateGoalForm(goal);
          setStatus("Goal ready to edit.", "default");
          return;
        }

        if (!window.confirm(`Delete goal ${eventId}?`)) {
          return;
        }

        target.disabled = true;
        clearError();
        setStatus("Deleting goal…", "default");

        try {
          const result = await requestJsonOrThrow(
            `/v1/games/${encodeURIComponent(gameId)}/goals/${encodeURIComponent(eventId)}`,
            {
              method: "DELETE",
              headers: {
                "Idempotency-Key": createIdempotencyKey("delete-goal", `${gameId}-${eventId}`),
              },
            },
          );

          applyGoalMutationResult(result, { deletedEventId: eventId });
          setStatus("Goal deleted.", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not delete goal.";
          showError(message);
          setStatus("Goal deletion failed.", "error");
        } finally {
          target.disabled = false;
          renderLiveScoring();
        }
      });
    }

    await loadGame();
    await loadRosterSetup({ updateStatus: false });
    const goalsLoaded = await loadGameGoals();

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

    if (goalsLoaded) {
      setStatus("Game page ready.", "success");
    }
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
