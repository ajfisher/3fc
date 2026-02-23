(() => {
  const root = document.getElementById("setup-flow-root");
  if (!root) {
    return;
  }

  const apiBaseUrl = root.getAttribute("data-api-base-url") ?? "";
  const statusElement = document.getElementById("setup-status");
  const errorElement = document.getElementById("setup-error");

  const leagueStep = root.querySelector('[data-step="league"]');
  const seasonStep = root.querySelector('[data-step="season"]');
  const gamesStep = root.querySelector('[data-step="games"]');

  const createLeagueButton = root.querySelector('[data-action="create-league"]');
  const createSeasonButton = root.querySelector('[data-action="create-season"]');
  const createGameButton = root.querySelector('[data-action="create-game"]');

  const gameCreatedNote = document.getElementById("game-created-note");
  const gameContextLink = document.getElementById("game-context-link");

  const leagueIdDisplay = document.getElementById("league-id-display");
  const seasonIdDisplay = document.getElementById("season-id-display");
  const sessionIdDisplay = document.getElementById("session-id-display");
  const gameIdDisplay = document.getElementById("game-id-display");

  const stepChipLeague = document.getElementById("step-chip-league");
  const stepChipSeason = document.getElementById("step-chip-season");
  const stepChipGames = document.getElementById("step-chip-games");

  let submitting = false;
  let leagueCreated = null;
  let seasonCreated = null;
  let leagueSlugEdited = false;
  let seasonSlugEdited = false;
  let gameIdNonce = randomSuffix(4);

  function slugify(value) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 48);
  }

  function randomSuffix(length = 8) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "").slice(0, length);
    }

    return Math.random().toString(16).slice(2, 2 + length);
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

  function getInput(fieldId) {
    const input = root.querySelector(`#${fieldId}`);
    return input instanceof HTMLInputElement ? input : null;
  }

  function getValue(fieldId) {
    return getInput(fieldId)?.value.trim() ?? "";
  }

  function setValue(fieldId, value) {
    const input = getInput(fieldId);
    if (input) {
      input.value = value;
    }
  }

  function getFieldContainer(fieldId) {
    const input = getInput(fieldId);
    return input?.closest('[data-ui="field"]') ?? null;
  }

  function ensureFieldMessageContainer(fieldId) {
    const field = getFieldContainer(fieldId);
    if (!field) {
      return null;
    }

    let message = field.querySelector('[data-ui="field-message"]');
    if (!message) {
      message = document.createElement("div");
      message.setAttribute("data-ui", "field-message");
      field.appendChild(message);
    }

    return message;
  }

  function clearFieldState(fieldId) {
    const input = getInput(fieldId);
    if (!input) {
      return;
    }

    input.dataset.state = "default";
    input.removeAttribute("aria-invalid");

    const message = ensureFieldMessageContainer(fieldId);
    if (message) {
      message.textContent = "";
    }
  }

  function setFieldError(fieldId, text) {
    const input = getInput(fieldId);
    if (!input) {
      return;
    }

    input.dataset.state = "invalid";
    input.setAttribute("aria-invalid", "true");

    const message = ensureFieldMessageContainer(fieldId);
    if (message) {
      message.textContent = text;
    }
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

    errorElement.textContent = "";
    errorElement.hidden = true;
  }

  function toIsoTimestamp(localDateTime) {
    const parsed = new Date(localDateTime);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed.toISOString();
  }

  function deriveLeagueId() {
    const leagueSlug = slugify(getValue("league-slug"));
    const leagueName = slugify(getValue("league-name"));
    return leagueSlug || leagueName || `league-${randomSuffix(6)}`;
  }

  function deriveSeasonId() {
    const seasonSlug = slugify(getValue("season-slug"));
    const seasonName = slugify(getValue("season-name"));
    return seasonSlug || seasonName || `season-${randomSuffix(6)}`;
  }

  function deriveSessionId() {
    const sessionDate = getValue("session-date");
    if (sessionDate) {
      return sessionDate.replaceAll("-", "");
    }

    return `session-${randomSuffix(6)}`;
  }

  function deriveGameId() {
    const sessionId = deriveSessionId();
    const kickoff = getValue("game-kickoff");
    const kickoffPart = kickoff.includes("T") ? kickoff.split("T")[1].replace(":", "") : "0000";
    return `game-${sessionId}-${kickoffPart}-${gameIdNonce}`;
  }

  function updateDerivedIds() {
    if (leagueIdDisplay) {
      leagueIdDisplay.textContent = deriveLeagueId();
    }
    if (seasonIdDisplay) {
      seasonIdDisplay.textContent = deriveSeasonId();
    }
    if (sessionIdDisplay) {
      sessionIdDisplay.textContent = deriveSessionId();
    }
    if (gameIdDisplay) {
      gameIdDisplay.textContent = deriveGameId();
    }
  }

  function setStepState(stepName) {
    const isLeague = stepName === "league";
    const isSeason = stepName === "season";
    const isGames = stepName === "games";

    if (leagueStep) {
      leagueStep.hidden = false;
    }
    if (seasonStep) {
      seasonStep.hidden = !(isSeason || isGames);
    }
    if (gamesStep) {
      gamesStep.hidden = !isGames;
    }

    if (stepChipLeague) {
      stepChipLeague.setAttribute("data-state", isLeague ? "active" : "done");
    }
    if (stepChipSeason) {
      stepChipSeason.setAttribute("data-state", isSeason ? "active" : isGames ? "done" : "upcoming");
    }
    if (stepChipGames) {
      stepChipGames.setAttribute("data-state", isGames ? "active" : "upcoming");
    }
  }

  function setSubmittingState(isActive) {
    submitting = isActive;
    const disabled = isActive;

    if (createLeagueButton instanceof HTMLButtonElement) {
      createLeagueButton.disabled = disabled;
    }
    if (createSeasonButton instanceof HTMLButtonElement) {
      createSeasonButton.disabled = disabled;
    }
    if (createGameButton instanceof HTMLButtonElement) {
      createGameButton.disabled = disabled;
    }
  }

  async function postJson(path, payload, idempotencyKey) {
    const response = await fetch(buildApiUrl(path), {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
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

    if (!response.ok) {
      const message = body?.message || body?.error || `Request failed with status ${response.status}.`;
      throw new Error(message);
    }

    return body;
  }

  function clearValidationState() {
    [
      "league-name",
      "league-slug",
      "season-name",
      "season-slug",
      "season-start",
      "season-end",
      "session-date",
      "game-kickoff",
    ].forEach((fieldId) => clearFieldState(fieldId));
  }

  function validateLeague() {
    clearFieldState("league-name");
    clearFieldState("league-slug");

    let valid = true;

    if (!getValue("league-name")) {
      setFieldError("league-name", "League name is required.");
      valid = false;
    }

    return valid;
  }

  function validateSeason() {
    clearFieldState("season-name");
    clearFieldState("season-slug");
    clearFieldState("season-start");
    clearFieldState("season-end");

    let valid = true;

    if (!getValue("season-name")) {
      setFieldError("season-name", "Season name is required.");
      valid = false;
    }

    const startsOn = getValue("season-start");
    const endsOn = getValue("season-end");

    if (startsOn && endsOn && endsOn < startsOn) {
      setFieldError("season-end", "Season end date must be on or after season start.");
      valid = false;
    }

    return valid;
  }

  function validateGame() {
    clearFieldState("session-date");
    clearFieldState("game-kickoff");

    let valid = true;

    if (!getValue("session-date")) {
      setFieldError("session-date", "Session date is required.");
      valid = false;
    }

    if (!getValue("game-kickoff")) {
      setFieldError("game-kickoff", "Kickoff time is required.");
      valid = false;
    } else if (!toIsoTimestamp(getValue("game-kickoff"))) {
      setFieldError("game-kickoff", "Kickoff time must be a valid date and time.");
      valid = false;
    }

    return valid;
  }

  function syncKickoffDateFromSessionDate() {
    const sessionDate = getValue("session-date");
    if (!sessionDate) {
      return;
    }

    const kickoffInput = getInput("game-kickoff");
    if (!kickoffInput) {
      return;
    }

    const current = kickoffInput.value.trim();
    const timePart = current.includes("T") ? current.split("T")[1] : "10:00";
    kickoffInput.value = `${sessionDate}T${timePart}`;
  }

  function wireAutoPopulation() {
    const leagueName = getInput("league-name");
    const leagueSlug = getInput("league-slug");
    const seasonName = getInput("season-name");
    const seasonSlug = getInput("season-slug");
    const sessionDate = getInput("session-date");
    const gameKickoff = getInput("game-kickoff");

    leagueName?.addEventListener("input", () => {
      if (!leagueSlugEdited && leagueSlug) {
        leagueSlug.value = slugify(leagueName.value);
      }
      updateDerivedIds();
    });

    leagueSlug?.addEventListener("input", () => {
      leagueSlugEdited = leagueSlug.value.trim().length > 0;
      updateDerivedIds();
    });

    seasonName?.addEventListener("input", () => {
      if (!seasonSlugEdited && seasonSlug) {
        seasonSlug.value = slugify(seasonName.value);
      }
      updateDerivedIds();
    });

    seasonSlug?.addEventListener("input", () => {
      seasonSlugEdited = seasonSlug.value.trim().length > 0;
      updateDerivedIds();
    });

    sessionDate?.addEventListener("change", () => {
      syncKickoffDateFromSessionDate();
      updateDerivedIds();
    });

    gameKickoff?.addEventListener("change", () => {
      updateDerivedIds();
    });
  }

  async function ensureAuthenticatedSession() {
    setStatus("Checking sign-in state…", "default");

    const response = await fetch(buildApiUrl("/v1/auth/session"), {
      method: "GET",
      credentials: "include",
    });

    if (response.ok) {
      const payload = await response.json();
      const email = payload?.session?.email;
      if (typeof email === "string" && email.length > 0) {
        setStatus(`Signed in as ${email}. Create your league to begin.`, "success");
      } else {
        setStatus("Session active. Create your league to begin.", "success");
      }
      return;
    }

    const returnTo = encodeURIComponent("/setup");
    window.location.replace(`/sign-in?returnTo=${returnTo}`);
    throw new Error("redirecting_to_sign_in");
  }

  async function createLeague() {
    clearError();
    clearValidationState();

    if (!validateLeague()) {
      setStatus("Fix league validation issues and retry.", "error");
      return;
    }

    const leagueId = deriveLeagueId();
    const payload = {
      leagueId,
      name: getValue("league-name"),
      slug: slugify(getValue("league-slug")) || null,
    };

    setSubmittingState(true);
    setStatus("Creating league…", "default");

    try {
      await postJson("/v1/leagues", payload, createIdempotencyKey("setup-league", leagueId));
      leagueCreated = { leagueId };
      setStatus(`League created (${leagueId}). Continue to season.`, "success");
      setStepState("season");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create league.";
      showError(message);
      setStatus("League creation failed.", "error");
    } finally {
      setSubmittingState(false);
    }
  }

  async function createSeason() {
    clearError();
    clearValidationState();

    if (!leagueCreated?.leagueId) {
      showError("Create a league first.");
      setStatus("League step must be completed first.", "error");
      setStepState("league");
      return;
    }

    if (!validateSeason()) {
      setStatus("Fix season validation issues and retry.", "error");
      return;
    }

    const seasonId = deriveSeasonId();
    const payload = {
      seasonId,
      name: getValue("season-name"),
      slug: slugify(getValue("season-slug")) || null,
      startsOn: getValue("season-start") || null,
      endsOn: getValue("season-end") || null,
    };

    setSubmittingState(true);
    setStatus("Creating season…", "default");

    try {
      await postJson(
        `/v1/leagues/${encodeURIComponent(leagueCreated.leagueId)}/seasons`,
        payload,
        createIdempotencyKey("setup-season", `${leagueCreated.leagueId}-${seasonId}`),
      );

      seasonCreated = {
        leagueId: leagueCreated.leagueId,
        seasonId,
      };
      setStatus(`Season created (${seasonId}). Continue to game creation.`, "success");
      setStepState("games");
      syncKickoffDateFromSessionDate();
      updateDerivedIds();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create season.";
      showError(message);
      setStatus("Season creation failed.", "error");
    } finally {
      setSubmittingState(false);
    }
  }

  async function createGame() {
    clearError();
    clearValidationState();

    if (!seasonCreated?.seasonId || !seasonCreated.leagueId) {
      showError("Create season before creating games.");
      setStatus("Season step must be completed first.", "error");
      setStepState("season");
      return;
    }

    if (!validateGame()) {
      setStatus("Fix game validation issues and retry.", "error");
      return;
    }

    const sessionId = deriveSessionId();
    const gameId = deriveGameId();
    const sessionDate = getValue("session-date");
    const kickoffIso = toIsoTimestamp(getValue("game-kickoff"));
    if (!kickoffIso) {
      setFieldError("game-kickoff", "Kickoff time must be valid.");
      setStatus("Fix game validation issues and retry.", "error");
      return;
    }

    const sessionPayload = {
      sessionId,
      sessionDate,
    };
    const gamePayload = {
      gameId,
      gameStartTs: kickoffIso,
      status: "scheduled",
    };

    setSubmittingState(true);
    setStatus("Creating session and game…", "default");

    try {
      await postJson(
        `/v1/seasons/${encodeURIComponent(seasonCreated.seasonId)}/sessions`,
        sessionPayload,
        createIdempotencyKey("setup-session", `${seasonCreated.seasonId}-${sessionId}`),
      );

      await postJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/games`,
        gamePayload,
        createIdempotencyKey("setup-game", `${sessionId}-${gameId}`),
      );

      setStatus(`Game created (${gameId}). You can create another game.`, "success");

      if (gameCreatedNote) {
        gameCreatedNote.hidden = false;
      }
      if (gameContextLink) {
        const query = new URLSearchParams({
          leagueId: seasonCreated.leagueId,
          seasonId: seasonCreated.seasonId,
          sessionId,
          gameStartTs: kickoffIso,
        });
        gameContextLink.setAttribute("href", `/games/${encodeURIComponent(gameId)}?${query.toString()}`);
      }

      gameIdNonce = randomSuffix(4);
      updateDerivedIds();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create game.";
      showError(message);
      setStatus("Game creation failed.", "error");
    } finally {
      setSubmittingState(false);
    }
  }

  async function initialize() {
    setStepState("league");
    wireAutoPopulation();
    updateDerivedIds();
    setSubmittingState(true);

    if (createLeagueButton instanceof HTMLButtonElement) {
      createLeagueButton.addEventListener("click", () => {
        void createLeague();
      });
    }

    if (createSeasonButton instanceof HTMLButtonElement) {
      createSeasonButton.addEventListener("click", () => {
        void createSeason();
      });
    }

    if (createGameButton instanceof HTMLButtonElement) {
      createGameButton.addEventListener("click", () => {
        void createGame();
      });
    }

    try {
      await ensureAuthenticatedSession();
      setSubmittingState(false);
    } catch (error) {
      if (error instanceof Error && error.message === "redirecting_to_sign_in") {
        return;
      }

      showError("Could not verify sign-in state.");
      setStatus("Session check failed.", "error");
    }
  }

  void initialize();
})();
