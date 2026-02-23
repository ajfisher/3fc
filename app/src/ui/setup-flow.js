(() => {
  const form = document.getElementById("setup-flow-form");
  if (!form) {
    return;
  }

  const apiBaseUrl = form.getAttribute("data-api-base-url") ?? "";
  const createButton = form.querySelector('[data-action="create-game-context"]');
  const resetButton = form.querySelector('[data-action="reset-setup-flow"]');
  const statusElement = document.getElementById("setup-status");
  const errorElement = document.getElementById("setup-error");
  const previewElement = document.getElementById("setup-id-preview");
  const previewLeagueId = document.getElementById("preview-league-id");
  const previewSeasonId = document.getElementById("preview-season-id");
  const previewSessionId = document.getElementById("preview-session-id");
  const previewGameId = document.getElementById("preview-game-id");

  let submitting = false;
  let isAuthenticated = false;

  function slugify(value) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 48);
  }

  function randomSuffix() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    }

    return Math.random().toString(16).slice(2, 10);
  }

  function toIsoTimestamp(localDateTime) {
    const parsed = new Date(localDateTime);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed.toISOString();
  }

  function buildApiUrl(path) {
    const normalizedBase = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    return new URL(normalizedPath, normalizedBase).toString();
  }

  function createIdempotencyKey(prefix, stablePart) {
    const safeStable = stablePart.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 48);
    return `${prefix}-${safeStable}-${Date.now().toString(36)}`;
  }

  function getInput(fieldId) {
    const input = form.querySelector(`#${fieldId}`);
    if (!(input instanceof HTMLInputElement)) {
      return null;
    }

    return input;
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

  function getFieldMessageContainer(fieldId) {
    const input = getInput(fieldId);
    const field = input?.closest('[data-ui="field"]');
    if (!field) {
      return null;
    }

    return field.querySelector('[data-ui="field-message"]');
  }

  function clearFieldState(fieldId) {
    const input = getInput(fieldId);
    if (!input) {
      return;
    }

    input.dataset.state = "default";
    input.removeAttribute("aria-invalid");
    const message = getFieldMessageContainer(fieldId);
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
    const message = getFieldMessageContainer(fieldId);
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

  function showGlobalError(message) {
    if (!errorElement) {
      return;
    }

    errorElement.textContent = message;
    errorElement.hidden = false;
  }

  function clearGlobalError() {
    if (!errorElement) {
      return;
    }

    errorElement.hidden = true;
    errorElement.textContent = "";
  }

  function updatePreview(ids) {
    if (!previewElement) {
      return;
    }

    if (!ids.leagueId && !ids.seasonId && !ids.sessionId && !ids.gameId) {
      previewElement.hidden = true;
      return;
    }

    previewElement.hidden = false;
    if (previewLeagueId) {
      previewLeagueId.textContent = ids.leagueId || "Not set";
    }
    if (previewSeasonId) {
      previewSeasonId.textContent = ids.seasonId || "Not set";
    }
    if (previewSessionId) {
      previewSessionId.textContent = ids.sessionId || "Not set";
    }
    if (previewGameId) {
      previewGameId.textContent = ids.gameId || "Not set";
    }
  }

  function deriveIdsFromInputs() {
    if (!getValue("league-id")) {
      const name = getValue("league-name");
      if (name) {
        setValue("league-id", slugify(name));
      }
    }

    if (!getValue("season-id")) {
      const name = getValue("season-name");
      if (name) {
        setValue("season-id", slugify(name));
      }
    }

    if (!getValue("session-id")) {
      const sessionDate = getValue("session-date");
      if (sessionDate) {
        setValue("session-id", sessionDate.replaceAll("-", ""));
      }
    }

    if (!getValue("game-id")) {
      const sessionId = getValue("session-id");
      const fallbackSession = sessionId || "session";
      setValue("game-id", `game-${fallbackSession}-${randomSuffix()}`);
    }
  }

  function setSubmittableState(isEnabled) {
    const enabled = isEnabled && isAuthenticated;
    if (createButton instanceof HTMLButtonElement) {
      createButton.disabled = !enabled;
    }
    if (resetButton instanceof HTMLButtonElement) {
      resetButton.disabled = !isEnabled;
    }
  }

  function validate() {
    deriveIdsFromInputs();
    clearGlobalError();

    const requiredFieldErrors = [];
    const requiredFields = [
      { id: "league-id", label: "League ID" },
      { id: "league-name", label: "League name" },
      { id: "season-id", label: "Season ID" },
      { id: "season-name", label: "Season name" },
      { id: "session-id", label: "Session ID" },
      { id: "session-date", label: "Session date" },
      { id: "game-id", label: "Game ID" },
      { id: "game-kickoff", label: "Kickoff time" },
    ];

    requiredFields.forEach((field) => {
      clearFieldState(field.id);
      if (!getValue(field.id)) {
        requiredFieldErrors.push(field.id);
        setFieldError(field.id, `${field.label} is required.`);
      }
    });

    const seasonStart = getValue("season-start");
    const seasonEnd = getValue("season-end");
    if (seasonStart && seasonEnd && seasonEnd < seasonStart) {
      setFieldError("season-end", "Season end date must be on or after season start.");
      requiredFieldErrors.push("season-end");
    }

    const kickoffIso = toIsoTimestamp(getValue("game-kickoff"));
    if (!kickoffIso) {
      setFieldError("game-kickoff", "Kickoff time must be a valid date and time.");
      requiredFieldErrors.push("game-kickoff");
    }

    const ids = {
      leagueId: getValue("league-id"),
      seasonId: getValue("season-id"),
      sessionId: getValue("session-id"),
      gameId: getValue("game-id"),
    };
    updatePreview(ids);

    return {
      isValid: requiredFieldErrors.length === 0,
      ids,
      kickoffIso,
    };
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

    const rawText = await response.text();
    let parsedBody = null;
    if (rawText.length > 0) {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = { error: rawText };
      }
    }

    if (!response.ok) {
      const detail =
        parsedBody?.message ||
        parsedBody?.error ||
        `Request failed with status ${response.status}.`;
      throw new Error(detail);
    }

    return parsedBody ?? {};
  }

  async function runSetupFlow(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    if (!isAuthenticated) {
      showGlobalError("Sign in is required before creating setup entities.");
      setStatus("Sign in is required before setup can run.", "error");
      return;
    }

    const validation = validate();
    if (!validation.isValid || !validation.kickoffIso) {
      setStatus("Fix validation issues and try again.", "error");
      return;
    }

    const leagueId = validation.ids.leagueId;
    const seasonId = validation.ids.seasonId;
    const sessionId = validation.ids.sessionId;
    const gameId = validation.ids.gameId;

    const leaguePayload = {
      leagueId,
      name: getValue("league-name"),
      slug: getValue("league-slug") || null,
    };
    const seasonPayload = {
      seasonId,
      name: getValue("season-name"),
      slug: getValue("season-slug") || null,
      startsOn: getValue("season-start") || null,
      endsOn: getValue("season-end") || null,
    };
    const sessionPayload = {
      sessionId,
      sessionDate: getValue("session-date"),
    };
    const gamePayload = {
      gameId,
      gameStartTs: validation.kickoffIso,
      status: "scheduled",
    };

    submitting = true;
    setSubmittableState(false);
    setStatus("Creating league...", "default");

    try {
      await postJson(
        "/v1/leagues",
        leaguePayload,
        createIdempotencyKey("setup-league", leagueId),
      );
      setStatus("Creating season...", "default");

      await postJson(
        `/v1/leagues/${encodeURIComponent(leagueId)}/seasons`,
        seasonPayload,
        createIdempotencyKey("setup-season", `${leagueId}-${seasonId}`),
      );
      setStatus("Creating session...", "default");

      await postJson(
        `/v1/seasons/${encodeURIComponent(seasonId)}/sessions`,
        sessionPayload,
        createIdempotencyKey("setup-session", `${seasonId}-${sessionId}`),
      );
      setStatus("Creating game...", "default");

      await postJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/games`,
        gamePayload,
        createIdempotencyKey("setup-game", `${sessionId}-${gameId}`),
      );

      setStatus("Setup complete. Redirecting to game context...", "success");
      clearGlobalError();

      const query = new URLSearchParams({
        leagueId,
        seasonId,
        sessionId,
        gameStartTs: validation.kickoffIso,
      });
      window.location.assign(`/games/${encodeURIComponent(gameId)}?${query.toString()}`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unexpected setup error occurred. Please retry.";
      showGlobalError(message);
      setStatus("Setup failed. Review errors and retry.", "error");
    } finally {
      submitting = false;
      setSubmittableState(true);
    }
  }

  function resetSetupFlow() {
    form.reset();
    [
      "league-id",
      "league-name",
      "league-slug",
      "season-id",
      "season-name",
      "season-slug",
      "season-start",
      "season-end",
      "session-id",
      "session-date",
      "game-id",
      "game-kickoff",
    ].forEach((fieldId) => clearFieldState(fieldId));

    clearGlobalError();
    updatePreview({ leagueId: "", seasonId: "", sessionId: "", gameId: "" });
    setStatus("Ready to create setup entities.", "default");
    setSubmittableState(!submitting);
  }

  function attachAutoFillListeners() {
    const leagueName = getInput("league-name");
    const seasonName = getInput("season-name");
    const sessionDate = getInput("session-date");
    const kickoff = getInput("game-kickoff");

    leagueName?.addEventListener("blur", () => {
      if (!getValue("league-id")) {
        deriveIdsFromInputs();
        updatePreview({
          leagueId: getValue("league-id"),
          seasonId: getValue("season-id"),
          sessionId: getValue("session-id"),
          gameId: getValue("game-id"),
        });
      }
    });

    seasonName?.addEventListener("blur", () => {
      if (!getValue("season-id")) {
        deriveIdsFromInputs();
        updatePreview({
          leagueId: getValue("league-id"),
          seasonId: getValue("season-id"),
          sessionId: getValue("session-id"),
          gameId: getValue("game-id"),
        });
      }
    });

    sessionDate?.addEventListener("change", () => {
      if (!getValue("session-id")) {
        deriveIdsFromInputs();
        updatePreview({
          leagueId: getValue("league-id"),
          seasonId: getValue("season-id"),
          sessionId: getValue("session-id"),
          gameId: getValue("game-id"),
        });
      }
    });

    kickoff?.addEventListener("change", () => {
      if (!getValue("game-id")) {
        deriveIdsFromInputs();
        updatePreview({
          leagueId: getValue("league-id"),
          seasonId: getValue("season-id"),
          sessionId: getValue("session-id"),
          gameId: getValue("game-id"),
        });
      }
    });
  }

  form.addEventListener("submit", runSetupFlow);
  if (resetButton instanceof HTMLButtonElement) {
    resetButton.addEventListener("click", resetSetupFlow);
  }

  window.addEventListener("threefc:auth-state", (event) => {
    const detail = event.detail ?? {};
    isAuthenticated = Boolean(detail.authenticated);

    if (!submitting) {
      if (isAuthenticated) {
        setStatus("Ready to create setup entities.", "default");
      } else {
        setStatus("Sign in is required before setup can run.", "error");
      }
    }

    setSubmittableState(!submitting);
  });

  attachAutoFillListeners();
  resetSetupFlow();
})();
