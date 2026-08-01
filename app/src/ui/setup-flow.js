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
    const nonce =
      window.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 8) ??
      Math.random().toString(36).slice(2, 10);
    return `${prefix}-${safeStable}-${Date.now().toString(36)}-${nonce}`;
  }

  const JOIN_QR_VERSION = 5;
  const JOIN_QR_SIZE = 21 + 4 * (JOIN_QR_VERSION - 1);
  const JOIN_QR_DATA_CODEWORDS = 108;
  const JOIN_QR_EC_CODEWORDS = 26;
  const JOIN_QR_ALIGNMENT_CENTER = 30;
  const JOIN_QR_MAX_BYTES = 106;

  function utf8Bytes(value) {
    try {
      if (typeof TextEncoder === "function") {
        return Array.from(new TextEncoder().encode(value));
      }
    } catch {
      // Fall through to the percent-encoding path.
    }

    const encoded = encodeURIComponent(value);
    const bytes = [];
    for (let index = 0; index < encoded.length; index += 1) {
      if (encoded[index] === "%") {
        bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        bytes.push(encoded.charCodeAt(index));
      }
    }
    return bytes;
  }

  function appendQrBits(bits, value, length) {
    for (let index = length - 1; index >= 0; index -= 1) {
      bits.push(((value >>> index) & 1) === 1);
    }
  }

  function qrMultiply(left, right) {
    let result = 0;
    let a = left;
    let b = right;

    while (b > 0) {
      if ((b & 1) !== 0) {
        result ^= a;
      }
      a <<= 1;
      if ((a & 0x100) !== 0) {
        a ^= 0x11d;
      }
      b >>>= 1;
    }

    return result;
  }

  function qrReedSolomonDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;

    for (let index = 0; index < degree; index += 1) {
      for (let resultIndex = 0; resultIndex < result.length; resultIndex += 1) {
        result[resultIndex] = qrMultiply(result[resultIndex], root);
        if (resultIndex + 1 < result.length) {
          result[resultIndex] ^= result[resultIndex + 1];
        }
      }
      root = qrMultiply(root, 0x02);
    }

    return result;
  }

  function qrReedSolomonRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);

    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let index = 0; index < divisor.length; index += 1) {
        result[index] ^= qrMultiply(divisor[index], factor);
      }
    }

    return result;
  }

  function qrFormatBits(mask) {
    const data = (1 << 3) | mask;
    let remainder = data << 10;

    for (let index = 14; index >= 10; index -= 1) {
      if (((remainder >>> index) & 1) !== 0) {
        remainder ^= 0x537 << (index - 10);
      }
    }

    return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
  }

  function qrDataCodewords(value) {
    const bytes = utf8Bytes(value);
    if (bytes.length > JOIN_QR_MAX_BYTES) {
      return null;
    }

    const bits = [];
    appendQrBits(bits, 0x4, 4);
    appendQrBits(bits, bytes.length, 8);
    for (const byte of bytes) {
      appendQrBits(bits, byte, 8);
    }

    const capacity = JOIN_QR_DATA_CODEWORDS * 8;
    const terminatorLength = Math.min(4, capacity - bits.length);
    for (let index = 0; index < terminatorLength; index += 1) {
      bits.push(false);
    }
    while (bits.length % 8 !== 0) {
      bits.push(false);
    }

    const codewords = [];
    for (let index = 0; index < bits.length; index += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        byte = (byte << 1) | (bits[index + bit] ? 1 : 0);
      }
      codewords.push(byte);
    }

    const pads = [0xec, 0x11];
    let padIndex = 0;
    while (codewords.length < JOIN_QR_DATA_CODEWORDS) {
      codewords.push(pads[padIndex % pads.length]);
      padIndex += 1;
    }

    return codewords;
  }

  function createJoinQrSvg(value) {
    const data = qrDataCodewords(value);
    if (!data) {
      return "";
    }

    const modules = Array.from({ length: JOIN_QR_SIZE }, () => new Array(JOIN_QR_SIZE).fill(false));
    const reserved = Array.from({ length: JOIN_QR_SIZE }, () => new Array(JOIN_QR_SIZE).fill(false));

    function setFunctionModule(x, y, isDark) {
      if (x < 0 || y < 0 || x >= JOIN_QR_SIZE || y >= JOIN_QR_SIZE) {
        return;
      }
      modules[y][x] = isDark;
      reserved[y][x] = true;
    }

    function drawFinder(centerX, centerY) {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          setFunctionModule(centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
        }
      }
    }

    function drawAlignment(centerX, centerY) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunctionModule(centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    function drawFormat(mask) {
      const bits = qrFormatBits(mask);
      const bit = (index) => ((bits >>> index) & 1) !== 0;

      for (let index = 0; index <= 5; index += 1) {
        setFunctionModule(8, index, bit(index));
      }
      setFunctionModule(8, 7, bit(6));
      setFunctionModule(8, 8, bit(7));
      setFunctionModule(7, 8, bit(8));
      for (let index = 9; index < 15; index += 1) {
        setFunctionModule(14 - index, 8, bit(index));
      }

      for (let index = 0; index < 8; index += 1) {
        setFunctionModule(JOIN_QR_SIZE - 1 - index, 8, bit(index));
      }
      for (let index = 8; index < 15; index += 1) {
        setFunctionModule(8, JOIN_QR_SIZE - 15 + index, bit(index));
      }
    }

    drawFinder(3, 3);
    drawFinder(JOIN_QR_SIZE - 4, 3);
    drawFinder(3, JOIN_QR_SIZE - 4);
    drawAlignment(JOIN_QR_ALIGNMENT_CENTER, JOIN_QR_ALIGNMENT_CENTER);
    for (let index = 0; index < JOIN_QR_SIZE; index += 1) {
      if (!reserved[6][index]) {
        setFunctionModule(index, 6, index % 2 === 0);
      }
      if (!reserved[index][6]) {
        setFunctionModule(6, index, index % 2 === 0);
      }
    }
    setFunctionModule(8, JOIN_QR_SIZE - 8, true);
    drawFormat(0);

    const divisor = qrReedSolomonDivisor(JOIN_QR_EC_CODEWORDS);
    const codewords = [...data, ...qrReedSolomonRemainder(data, divisor)];
    const dataBits = [];
    for (const codeword of codewords) {
      appendQrBits(dataBits, codeword, 8);
    }

    let bitIndex = 0;
    let upward = true;
    for (let right = JOIN_QR_SIZE - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right -= 1;
      }

      for (let vertical = 0; vertical < JOIN_QR_SIZE; vertical += 1) {
        const y = upward ? JOIN_QR_SIZE - 1 - vertical : vertical;
        for (let dx = 0; dx < 2; dx += 1) {
          const x = right - dx;
          if (reserved[y][x]) {
            continue;
          }
          let isDark = bitIndex < dataBits.length ? dataBits[bitIndex] : false;
          bitIndex += 1;
          if ((x + y) % 2 === 0) {
            isDark = !isDark;
          }
          modules[y][x] = isDark;
        }
      }
      upward = !upward;
    }

    const quiet = 4;
    const viewBoxSize = JOIN_QR_SIZE + quiet * 2;
    let path = "";
    for (let y = 0; y < JOIN_QR_SIZE; y += 1) {
      for (let x = 0; x < JOIN_QR_SIZE; x += 1) {
        if (modules[y][x]) {
          path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
        }
      }
    }

    const label = escapeHtml(`Join QR code for ${value}`);
    return `<svg data-ui="join-qr-svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#111"/></svg>`;
  }

  function renderJoinQrCode(container, joinUrl) {
    if (!(container instanceof HTMLElement)) {
      return;
    }

    const svg = createJoinQrSvg(joinUrl);
    container.innerHTML = svg || "QR unavailable";
  }

  function encodeStablePartForStorage(stablePart) {
    try {
      return encodeURIComponent(stablePart);
    } catch {
      let encoded = "";
      for (let index = 0; index < stablePart.length; index += 1) {
        encoded += stablePart.charCodeAt(index).toString(16).padStart(4, "0");
      }
      return `utf16-${encoded}`;
    }
  }

  function idempotencyStorageKey(prefix, stablePart) {
    return `threefc-idempotency:${prefix}:${encodeStablePartForStorage(stablePart)}`;
  }

  function cachedIdempotencyKey(prefix, stablePart) {
    const storageKey = idempotencyStorageKey(prefix, stablePart);

    try {
      const existing = window.localStorage?.getItem(storageKey);
      if (existing) {
        return existing;
      }

      const next = createIdempotencyKey(prefix, stablePart);
      window.localStorage?.setItem(storageKey, next);
      return next;
    } catch {
      return createIdempotencyKey(prefix, stablePart);
    }
  }

  function clearCachedIdempotencyKey(prefix, stablePart) {
    try {
      window.localStorage?.removeItem(idempotencyStorageKey(prefix, stablePart));
    } catch {
      // Ignore storage failures; the next uncached request still gets a fresh key.
    }
  }

  function publicJoinIdempotencyStablePart(joinCode, nickname) {
    return `${joinCode.trim().toUpperCase()}-${nickname.trim()}`;
  }

  function idempotencyKeyForPublicJoin(joinCode, nickname) {
    return cachedIdempotencyKey("join-player", publicJoinIdempotencyStablePart(joinCode, nickname));
  }

  function clearIdempotencyKeyForPublicJoin(joinCode, nickname) {
    clearCachedIdempotencyKey("join-player", publicJoinIdempotencyStablePart(joinCode, nickname));
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

  function formatLocalTimestamp(isoTimestamp) {
    const localValue = toLocalDateTimeInput(isoTimestamp);
    return localValue ? localValue.replace("T", " ") : String(isoTimestamp ?? "");
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
          <td>${escapeHtml(formatLocalTimestamp(game.gameStartTs))}</td>
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
    const gameJoinCodeValue = document.getElementById("game-join-code-value");
    const gameJoinLink = document.getElementById("game-join-link");
    const gameJoinQr = document.getElementById("game-join-qr");
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
    const finishGameButton = root.querySelector('[data-action="finish-game"]');
    const gameResultSummaryElement = document.getElementById("game-result-summary");
    const finalGameIdValue = document.getElementById("final-game-id-value");
    const finalGameStatus = document.getElementById("final-game-status");
    const finalGameReadiness = document.getElementById("final-game-readiness");
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
      !(finishThirdButton instanceof HTMLButtonElement) ||
      !(finishGameButton instanceof HTMLButtonElement) ||
      !(gameResultSummaryElement instanceof HTMLElement)
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
    let currentLeagueRole = null;
    let manualGameModeSelected = false;
    let pendingCreateGoalIdempotency = null;
    const pendingGoalMutationIdempotency = new Map();
    const gameModes = ["structure", "players", "run", "final"];
    const gameModeLabels = {
      structure: "Game setup",
      players: "Players",
      run: "Run game",
      final: "Finalisation",
    };
    const gameModeTabs = [...root.querySelectorAll('[role="tab"][data-game-mode]')];
    const gameModeTriggers = [...root.querySelectorAll('[data-action="select-game-mode"][data-game-mode]')];
    const gameModePanels = [...root.querySelectorAll('[data-ui="game-mode-panel"][data-game-mode]')];
    const gameModeStatus = document.getElementById("game-mode-status");

    kickoffInput.addEventListener("input", () => {
      setFieldMessage("game-edit-kickoff");
    });

    function isGameFinished() {
      return currentGame?.status === "finished";
    }

    function isEditingGoal() {
      return editingGoalId !== null;
    }

    function normalizeLeagueRole(role) {
      return role === "admin" || role === "scorekeeper" || role === "viewer" ? role : null;
    }

    function canCorrectFinishedGoals() {
      return currentLeagueRole === "admin";
    }

    function finishedRosterControlsLocked() {
      return isGameFinished() && !canCorrectFinishedGoals();
    }

    function isFinishedGoalCorrection() {
      return isGameFinished() && isEditingGoal() && canCorrectFinishedGoals();
    }

    function humanGameStatus(value) {
      const labels = {
        scheduled: "Scheduled",
        live: "Live",
        finished: "Finished",
      };
      return labels[value] ?? "Loading";
    }

    function isGameMode(value) {
      return gameModes.includes(value);
    }

    function setModeMeta(mode, text) {
      const meta = root.querySelector(`[data-mode-meta="${mode}"]`);
      if (meta instanceof HTMLElement) {
        meta.textContent = text;
      }
    }

    function setModeLabel(mode, text) {
      const label = root.querySelector(`[data-mode-label="${mode}"]`);
      if (label instanceof HTMLElement) {
        label.textContent = text;
      }
    }

    function setGameMode(mode, options = {}) {
      if (!isGameMode(mode)) {
        return;
      }

      for (const panel of gameModePanels) {
        if (!(panel instanceof HTMLElement)) {
          continue;
        }
        const active = panel.getAttribute("data-game-mode") === mode;
        panel.hidden = !active;
        panel.setAttribute("tabindex", "-1");
      }

      for (const tab of gameModeTabs) {
        if (!(tab instanceof HTMLElement)) {
          continue;
        }
        const active = tab.getAttribute("data-game-mode") === mode;
        tab.setAttribute("aria-selected", active ? "true" : "false");
        tab.setAttribute("data-state", active ? "active" : "idle");
      }

      for (const trigger of gameModeTriggers) {
        if (trigger instanceof HTMLElement) {
          trigger.setAttribute("data-current", trigger.getAttribute("data-game-mode") === mode ? "true" : "false");
        }
      }

      if (gameModeStatus instanceof HTMLElement) {
        gameModeStatus.textContent = gameModeLabels[mode] ?? "Game setup";
      }

      if (options.focusPanel === true) {
        const panel = gameModePanels.find((candidate) => candidate.getAttribute("data-game-mode") === mode);
        if (panel instanceof HTMLElement) {
          panel.focus({ preventScroll: false });
        }
      }
    }

    function gameModeFromHash() {
      const hashMode = window.location.hash.replace(/^#/, "").replace(/^mode-/, "");
      return isGameMode(hashMode) ? hashMode : null;
    }

    function preferredInitialGameMode() {
      const requested = gameModeFromHash();
      if (requested) {
        return requested;
      }

      if (!currentGame) {
        return "structure";
      }

      if (isGameFinished()) {
        return "final";
      }

      const timer = buildTimerState(currentGame);
      const hasStarted = timer.thirds.some((third) => third.startedAt !== null);
      if (timer.status === "complete") {
        return "final";
      }
      if (hasStarted || rosteredPlayers().length > 0) {
        return hasStarted ? "run" : "players";
      }

      return "structure";
    }

    function gameModeAfterGameSave() {
      if (!currentGame) {
        return "structure";
      }

      if (isGameFinished()) {
        return "final";
      }

      const timer = buildTimerState(currentGame);
      if (timer.status === "complete") {
        return "final";
      }

      const hasStarted = timer.thirds.some((third) => third.startedAt !== null);
      return hasStarted ? "run" : "players";
    }

    function gameStateTabState(timer) {
      if (!currentGame || !timer) {
        return {
          label: "Pregame",
          meta: "Loading",
          state: "loading",
        };
      }

      if (isGameFinished()) {
        return {
          label: "Final",
          meta: "Summary",
          state: "finished",
        };
      }

      if (timer.status === "complete") {
        return {
          label: "Final",
          meta: "Finish game",
          state: "ready",
        };
      }

      const activeSegment = timer.thirds.find((third) => third.status === "running") ?? null;
      if (activeSegment?.startedAt) {
        const timerDisplay = formatTimerDisplay(
          elapsedSeconds(activeSegment.startedAt, activeSegment.finishedAt),
          timer.thirdLengthMinutes,
        ).displayTime;
        return {
          label: timerDisplay,
          meta: `Third ${activeSegment.third}`,
          state: "running",
        };
      }

      if (timer.status === "between_thirds") {
        const nextThird = nextStartableThird(timer);
        return {
          label: "Break",
          meta: nextThird ? `Start T${nextThird}` : "Ready",
          state: "break",
        };
      }

      return {
        label: "Pregame",
        meta: "Start clock",
        state: "pregame",
      };
    }

    function syncGameModeState() {
      const timer = currentGame ? buildTimerState(currentGame) : null;
      const rosteredCount = rosteredPlayers().length;
      const hasStarted = timer ? timer.thirds.some((third) => third.startedAt !== null) : false;
      const complete = timer?.status === "complete";
      const finished = isGameFinished();
      const finalReadiness = finished
        ? "Summary posted"
        : complete
          ? "Ready to finish"
          : hasStarted
            ? humanTimerStatus(timer.status)
            : "Not started";

      setModeMeta("structure", humanGameStatus(currentGame?.status));
      setModeMeta("players", `${rosteredCount} assigned`);
      setModeMeta("run", timer ? humanTimerStatus(timer.status) : "Timer");
      const gameState = gameStateTabState(timer);
      setModeLabel("final", gameState.label);
      setModeMeta("final", gameState.meta);
      const gameStateTab = root.querySelector('[data-testid="game-mode-final-tab"]');
      if (gameStateTab instanceof HTMLElement) {
        gameStateTab.setAttribute("data-game-state", gameState.state);
      }

      if (finalGameIdValue instanceof HTMLElement && currentGame?.gameId) {
        finalGameIdValue.textContent = currentGame.gameId;
      }
      if (finalGameStatus instanceof HTMLElement) {
        finalGameStatus.textContent = humanGameStatus(currentGame?.status);
      }
      if (finalGameReadiness instanceof HTMLElement) {
        finalGameReadiness.textContent = finalReadiness;
      }
    }

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

    function focusElementAction(element) {
      if (!(element instanceof HTMLElement)) {
        return;
      }

      if (typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "center" });
      }
      element.focus({ preventScroll: true });
    }

    function selectGameStateAction() {
      const timer = currentGame ? buildTimerState(currentGame) : null;
      if (!timer) {
        setGameMode("structure", { focusPanel: true });
        return;
      }

      if (isGameFinished() || timer.status === "complete") {
        setGameMode("final");
        focusElementAction(finishGameButton);
        return;
      }

      setGameMode("run");
      const activeSegment = timer.thirds.find((third) => third.status === "running") ?? null;
      focusElementAction(activeSegment ? finishThirdButton : startThirdButton);
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
      const gameFinished = isGameFinished();
      const allThirdsFinished = timer.status === "complete";
      const display = segment?.startedAt
        ? formatTimerDisplay(
            elapsedSeconds(segment.startedAt, segment.finishedAt),
            timer.thirdLengthMinutes,
          )
        : { displayTime: "00:00", phase: "regulation" };
      const nextThird = nextStartableThird(timer);

      thirdLengthInput.value = String(timer.thirdLengthMinutes);
      thirdLengthInput.disabled = gameFinished || hasStarted;
      kickoffInput.disabled = gameFinished;
      statusInput.disabled = gameFinished;
      saveButton.disabled = gameFinished;
      deleteButton.disabled = gameFinished;
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
              ? `Finished ${formatLocalTimestamp(third.finishedAt)}`
              : third.startedAt
                ? `Started ${formatLocalTimestamp(third.startedAt)}`
                : "Waiting";
            return `<li data-ui="third-status-item" data-state="${escapeHtml(third.status)}">
              <strong>Third ${third.third}</strong>
              <span>${escapeHtml(status)}</span>
              <small>${escapeHtml(detail)}</small>
            </li>`;
          })
          .join("");
      }

      startThirdButton.disabled = gameFinished || nextThird === null;
      finishThirdButton.disabled = gameFinished || !activeSegment;
      finishGameButton.disabled = gameFinished || !allThirdsFinished;
      startThirdButton.textContent = nextThird ? `Start Third ${nextThird}` : "Start Third";
      finishThirdButton.textContent = activeSegment ? `Finish Third ${activeSegment.third}` : "Finish Third";
      finishGameButton.textContent = gameFinished ? "Game finished" : "Finish game";
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
      if (allThirdsFinished && !gameFinished) {
        finishGameButton.setAttribute("data-state", "ready");
      } else {
        finishGameButton.removeAttribute("data-state");
      }

      window.clearInterval(timerTickInterval);
      timerTickInterval = 0;
      if (activeSegment && !gameFinished) {
        timerTickInterval = window.setInterval(renderTimer, 1000);
      }
      renderGameResult();
      syncGameModeState();
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

        const gameMinuteDelta = (left.gameMinute ?? 0) - (right.gameMinute ?? 0);
        if (gameMinuteDelta !== 0) {
          return gameMinuteDelta;
        }

        const elapsedDelta = (left.elapsedSeconds ?? 0) - (right.elapsedSeconds ?? 0);
        if (elapsedDelta !== 0) {
          return elapsedDelta;
        }

        const createdAtDelta = String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
        if (createdAtDelta !== 0) {
          return createdAtDelta;
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

    function resultTeams() {
      const teams = currentGame?.result?.teams;
      if (!Array.isArray(teams)) {
        return [];
      }

      return teams
        .filter((team) => team && typeof team === "object" && typeof team.teamId === "string")
        .map((team) => ({
          teamId: team.teamId,
          name: typeof team.name === "string" && team.name.length > 0 ? team.name : team.teamId,
          color: typeof team.color === "string" ? team.color : null,
          scored: Number.isInteger(team.scored) && team.scored >= 0 ? team.scored : 0,
          conceded: Number.isInteger(team.conceded) && team.conceded >= 0 ? team.conceded : 0,
          rank: Number.isInteger(team.rank) && team.rank > 0 ? team.rank : 0,
          outcome: ["win", "draw", "loss"].includes(team.outcome) ? team.outcome : "loss",
        }));
    }

    function renderGameResult() {
      if (!(gameResultSummaryElement instanceof HTMLElement)) {
        return;
      }

      const result = currentGame?.result;
      const teams = resultTeams();
      if (!isGameFinished() || !result || teams.length === 0) {
        gameResultSummaryElement.hidden = true;
        gameResultSummaryElement.innerHTML = "";
        syncGameModeState();
        return;
      }

      const winner = teams.find((team) => team.teamId === result.winnerTeamId) ?? null;
      const outcomeText = winner ? `${winner.name} win` : "Draw";
      const resultOutcome = result.outcome === "win" ? "win" : "draw";
      const computedAt = typeof result.computedAt === "string" ? formatLocalTimestamp(result.computedAt) : "";

      gameResultSummaryElement.hidden = false;
      gameResultSummaryElement.innerHTML = `<section data-ui="result-board" data-outcome="${escapeHtml(resultOutcome)}">
        <header>
          <span>Final result</span>
          <strong data-testid="game-result-outcome">${escapeHtml(outcomeText)}</strong>
          ${computedAt ? `<small>Computed ${escapeHtml(computedAt)}</small>` : ""}
        </header>
        <div data-ui="result-team-list" data-testid="game-result-teams">
          ${teams
            .map((team) => {
              const teamGoals = goalsForFinalTeam(team.teamId);
              return `<article data-ui="result-team" data-team-id="${escapeHtml(team.teamId)}" data-outcome="${escapeHtml(
                team.outcome,
              )}"${teamSwatchStyle(team)}>
                <header>
                  <span data-ui="team-swatch"></span>
                  <strong>${escapeHtml(team.name)}</strong>
                  ${team.rank > 0 ? `<span data-ui="rank-chip">#${escapeHtml(String(team.rank))}</span>` : ""}
                </header>
                <dl>
                  <div><dt>Conceded</dt><dd>${escapeHtml(String(team.conceded))}</dd></div>
                  <div><dt>Scored</dt><dd>${escapeHtml(String(team.scored))}</dd></div>
                </dl>
                <details data-ui="final-team-log" data-testid="final-team-log-${escapeHtml(team.teamId)}">
                  <summary>Scoring log</summary>
                  <ol data-ui="final-goal-list">
                    ${renderFinalGoalItems(teamGoals, "No goals recorded for this team.")}
                  </ol>
                </details>
              </article>`;
            })
            .join("")}
        </div>
        ${renderFinalAggregateStats()}
        ${renderFinalFullGoalLog()}
      </section>`;
      syncGameModeState();
    }

    function renderSelectOptions(selectElement, options, selectedValue, emptyLabel = "Select", missingSelectedLabel = null) {
      const selectedExists = options.some((option) => option.value === selectedValue);
      const preservesMissingSelection =
        !selectedExists && Boolean(selectedValue) && typeof missingSelectedLabel === "string";
      const safeSelected = selectedExists || preservesMissingSelection
        ? selectedValue
        : (options[0]?.value ?? "");
      const preservedOption = preservesMissingSelection
        ? `<option value="${escapeHtml(selectedValue)}" selected>${escapeHtml(missingSelectedLabel)}</option>`
        : "";
      const renderedOptions = options
        .map(
          (option) =>
            `<option value="${escapeHtml(option.value)}"${option.value === safeSelected ? " selected" : ""}>${escapeHtml(
              option.label,
            )}</option>`,
        )
        .join("");

      selectElement.innerHTML =
        options.length > 0 || preservesMissingSelection
          ? `${preservedOption}${renderedOptions}`
          : `<option value="">${escapeHtml(emptyLabel)}</option>`;
      selectElement.value = safeSelected;
      selectElement.disabled = options.length === 0 && !preservesMissingSelection;
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
          const disabled = (isGameFinished() && !isFinishedGoalCorrection()) || (!checked && selected.size >= 3);
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
      const editingGoal = editingGoalId
        ? goalTimeline.find((goal) => goal.eventId === editingGoalId)
        : null;
      const canPreserveHistoricalScorer =
        Boolean(editingGoal) &&
        selectedScorerId === editingGoal.scorerPlayerId &&
        ownGoal === Boolean(editingGoal.ownGoal) &&
        scoringTeamId === (editingGoal.scoringTeamId ?? null) &&
        concedingTeamId === editingGoal.concedingTeamId;
      const selectedScorerLabel = selectedScorerId && canPreserveHistoricalScorer
        ? `${playerNickname(selectedScorerId)} (not currently rostered)`
        : null;
      renderSelectOptions(
        goalScorerInput,
        scorerOptions,
        selectedScorerId,
        "Assign players first",
        selectedScorerLabel,
      );
      renderGoalAssistChoices(goalScorerInput.value, seed.assistPlayerIds ?? null);

      const activeThird = activeThirdNumber();
      const gameFinished = isGameFinished();
      const finishedCorrectionsAllowed = canCorrectFinishedGoals();
      const creatingFinishedCorrection = gameFinished && finishedCorrectionsAllowed && !isEditingGoal();
      saveGoalButton.textContent = editingGoalId ? "Save goal" : "Add goal";
      cancelGoalEditButton.hidden = editingGoalId === null;
      cancelGoalEditButton.disabled = editingGoalId === null;
      undoLastGoalButton.disabled = goalTimeline.length === 0 || (gameFinished && !finishedCorrectionsAllowed);
      undoLastGoalButton.textContent = "Undo last";

      if (gameFinished && !finishedCorrectionsAllowed) {
        goalScoringTeamInput.disabled = true;
        goalConcedingTeamInput.disabled = true;
        goalOwnGoalInput.disabled = true;
        goalScorerInput.disabled = true;
        saveGoalButton.disabled = true;
        for (const input of goalAssistsElement.querySelectorAll("input")) {
          if (input instanceof HTMLInputElement) {
            input.disabled = true;
          }
        }
        goalFormNote.textContent = "Game finished. Admin role is required to correct the result.";
        return;
      }

      saveGoalButton.disabled = false;

      if (rosterTeams.length < 2) {
        saveGoalButton.disabled = true;
        goalFormNote.textContent = "Teams load before scoring.";
        return;
      }

      if (rosteredPlayers().length === 0) {
        saveGoalButton.disabled = true;
        goalFormNote.textContent = "Assign players before scoring.";
        return;
      }

      if (!goalScorerInput.value) {
        saveGoalButton.disabled = true;
        goalFormNote.textContent = "Choose a scorer before adding a goal.";
        return;
      }

      if (editingGoalId) {
        saveGoalButton.disabled = false;
        goalFormNote.textContent = gameFinished
          ? "Finished-game correction keeps the original timer stamp."
          : "Editing keeps the original timer stamp.";
        return;
      }

      if (!activeThird) {
        saveGoalButton.disabled = !creatingFinishedCorrection;
        goalFormNote.textContent = creatingFinishedCorrection
          ? "Finished-game correction will be recorded at final whistle."
          : "Start a third before adding goals.";
        return;
      }

      saveGoalButton.disabled = false;
      goalFormNote.textContent = `Goal will be added to third ${activeThird}.`;
    }

    function timelineGoalLabel(goal) {
      const scorer = playerNickname(goal.scorerPlayerId);
      if (goal.ownGoal) {
        return `${scorer} own goal against ${teamName(goal.concedingTeamId)}`;
      }

      return `${scorer} for ${teamName(goal.scoringTeamId)}`;
    }

    function goalDisplayTime(goal) {
      if (Number.isInteger(goal.gameMinute) && goal.gameMinute > 0) {
        if (Number.isInteger(goal.stoppageMinute) && goal.stoppageMinute > 0) {
          return `${goal.gameMinute}+${goal.stoppageMinute}"`;
        }

        return `${goal.gameMinute}"`;
      }

      const thirdLength = parseThirdLengthMinutes(currentGame?.thirdLengthMinutes ?? currentGame?.timer?.thirdLengthMinutes);
      if (Number.isInteger(goal.third) && Number.isInteger(goal.thirdMinute) && goal.third > 0 && goal.thirdMinute > 0) {
        const regulationMinute = (goal.third - 1) * thirdLength + Math.min(goal.thirdMinute, thirdLength);
        if (Number.isInteger(goal.stoppageMinute) && goal.stoppageMinute > 0) {
          return `${goal.third * thirdLength}+${goal.stoppageMinute}"`;
        }

        return `${regulationMinute}"`;
      }

      if (typeof goal.displayTime === "string" && goal.displayTime.length > 0) {
        const stoppageMatch = goal.displayTime.match(/^(\d+)\+0?(\d+)$/);
        if (stoppageMatch) {
          return `${stoppageMatch[1]}+${Number.parseInt(stoppageMatch[2], 10)}"`;
        }

        const clockMatch = goal.displayTime.match(/^(\d+):\d{2}$/);
        if (clockMatch) {
          return `${Math.max(1, Number.parseInt(clockMatch[1], 10))}"`;
        }

        const minuteMatch = goal.displayTime.match(/^(\d+)'?$/);
        if (minuteMatch) {
          return `${Number.parseInt(minuteMatch[1], 10)}"`;
        }
      }

      return "-";
    }

    function goalAssistLabel(goal) {
      const assistPlayerIds = Array.isArray(goal.assistPlayerIds) ? goal.assistPlayerIds : [];
      if (assistPlayerIds.length === 0) {
        return "No assists";
      }

      return `Assisted by ${assistPlayerIds.map((playerId) => playerNickname(playerId)).join(", ")}`;
    }

    function finalTeamGoalLabel(goal) {
      const scorer = playerNickname(goal.scorerPlayerId);
      if (goal.ownGoal) {
        return `${scorer} own goal`;
      }

      return scorer;
    }

    function finalTeamGoalDetail(goal) {
      if (goal.ownGoal) {
        return "Conceded-only own goal";
      }

      return goalAssistLabel(goal);
    }

    function goalsForFinalTeam(teamId) {
      return goalTimeline.filter(
        (goal) =>
          (!goal.ownGoal && goal.scoringTeamId === teamId) ||
          (goal.ownGoal && goal.concedingTeamId === teamId),
      );
    }

    function renderFinalGoalItems(goals, emptyText) {
      if (goals.length === 0) {
        return `<li data-ui="empty-note">${escapeHtml(emptyText)}</li>`;
      }

      return goals
        .map(
          (goal) => `<li data-ui="final-goal-item" data-event-id="${escapeHtml(String(goal.eventId ?? ""))}">
            <span data-ui="goal-time">${escapeHtml(goalDisplayTime(goal))}</span>
            <div>
              <strong>${escapeHtml(finalTeamGoalLabel(goal))}</strong>
              <small>${escapeHtml(finalTeamGoalDetail(goal))}</small>
            </div>
          </li>`,
        )
        .join("");
    }

    function incrementPlayerStat(stats, playerId) {
      if (typeof playerId !== "string" || playerId.length === 0) {
        return;
      }

      const existing = stats.get(playerId) ?? 0;
      stats.set(playerId, existing + 1);
    }

    function sortedPlayerStats(stats) {
      return [...stats.entries()]
        .map(([playerId, count]) => ({
          playerId,
          count,
          name: playerNickname(playerId),
        }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    }

    function renderPlayerStatList(entries, emptyText) {
      if (entries.length === 0) {
        return `<p data-ui="empty-note">${escapeHtml(emptyText)}</p>`;
      }

      return `<ol data-ui="final-stat-list">
        ${entries
          .map(
            (entry) => `<li>
              <span>${escapeHtml(entry.name)}</span>
              <strong>${escapeHtml(String(entry.count))}</strong>
            </li>`,
          )
          .join("")}
      </ol>`;
    }

    function finalAggregateStats() {
      const scorers = new Map();
      const assists = new Map();
      const ownGoals = new Map();

      for (const goal of goalTimeline) {
        if (goal.ownGoal) {
          incrementPlayerStat(ownGoals, goal.scorerPlayerId);
        } else {
          incrementPlayerStat(scorers, goal.scorerPlayerId);
        }

        for (const assistPlayerId of Array.isArray(goal.assistPlayerIds) ? goal.assistPlayerIds : []) {
          incrementPlayerStat(assists, assistPlayerId);
        }
      }

      return {
        scorers: sortedPlayerStats(scorers),
        assists: sortedPlayerStats(assists),
        ownGoals: sortedPlayerStats(ownGoals),
      };
    }

    function renderFinalAggregateStats() {
      const stats = finalAggregateStats();
      const ownGoalStats = stats.ownGoals.length > 0
        ? `<section data-ui="final-stat-card" data-testid="final-own-goal-stats">
          <h4>Own goals</h4>
          ${renderPlayerStatList(stats.ownGoals, "No own goals.")}
        </section>`
        : "";

      return `<section data-ui="final-aggregate-stats" data-testid="final-aggregate-stats" aria-label="Player statistics">
        <section data-ui="final-stat-card" data-testid="final-scorer-stats">
          <h4>Top scorers</h4>
          ${renderPlayerStatList(stats.scorers, "No scorers recorded.")}
        </section>
        <section data-ui="final-stat-card" data-testid="final-assist-stats">
          <h4>Assists</h4>
          ${renderPlayerStatList(stats.assists, "No assists recorded.")}
        </section>
        ${ownGoalStats}
      </section>`;
    }

    function renderFinalFullGoalLog() {
      return `<details data-ui="final-full-log" data-testid="final-full-goal-log">
        <summary>Full match log</summary>
        <ol data-ui="final-goal-list">
          ${renderFinalGoalItems(goalTimeline, "No goals recorded.")}
        </ol>
      </details>`;
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
      const finishedActionsDisabled = isGameFinished() && !canCorrectFinishedGoals();
      const disabledAttribute = finishedActionsDisabled ? " disabled" : "";
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
              <strong>${escapeHtml(goalDisplayTime(goal))} · Third ${escapeHtml(String(goal.third))}</strong>
              <span>${escapeHtml(timelineGoalLabel(goal))}</span>
              <small>Assists: ${escapeHtml(assists)}</small>
              ${goal.ownGoal ? `<small>Own goal: conceding tally only</small>` : ""}
            </div>
            <div data-ui="row-action-buttons">
              ${latest ? `<span data-ui="latest-flag">Latest</span>` : ""}
              <button data-ui="row-action" type="button" data-action="edit-goal" data-event-id="${escapeHtml(
                goal.eventId,
              )}"${disabledAttribute}>Edit</button>
              <button data-ui="row-action" data-tone="danger" type="button" data-action="delete-goal" data-event-id="${escapeHtml(
                goal.eventId,
              )}"${disabledAttribute}>Delete</button>
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
      renderGameResult();
      syncGameModeState();
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
      if (isGameFinished() && !canCorrectFinishedGoals()) {
        return {
          error: "Game finished. Admin role is required to correct the result.",
        };
      }

      const creatingFinishedCorrection = isGameFinished() && canCorrectFinishedGoals() && !isEditingGoal();

      const activeThird = activeThirdNumber();
      if (!activeThird && !editingGoalId && !creatingFinishedCorrection) {
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

    function goalCreatePayloadFingerprint(payload) {
      return JSON.stringify({
        scoringTeamId: payload.scoringTeamId,
        concedingTeamId: payload.concedingTeamId,
        scorerPlayerId: payload.scorerPlayerId,
        assistPlayerIds: Array.isArray(payload.assistPlayerIds) ? payload.assistPlayerIds : [],
        ownGoal: payload.ownGoal === true,
      });
    }

    function idempotencyKeyForGoalMutation(prefix, stablePart, fingerprint) {
      const cacheKey = `${prefix}:${stablePart}`;
      const existing = pendingGoalMutationIdempotency.get(cacheKey);
      if (!existing || existing.fingerprint !== fingerprint) {
        const next = {
          fingerprint,
          key: createIdempotencyKey(prefix, stablePart),
        };
        pendingGoalMutationIdempotency.set(cacheKey, next);
        return next.key;
      }

      return existing.key;
    }

    function clearGoalMutationIdempotency(prefix, stablePart) {
      pendingGoalMutationIdempotency.delete(`${prefix}:${stablePart}`);
    }

    async function refreshGameAfterFinishedCorrection() {
      if (!isGameFinished()) {
        return true;
      }

      try {
        await loadGame();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not refresh finished game result.";
        showError(message);
        setStatus("Finished result refresh failed.", "error");
        return false;
      }
    }

    function idempotencyKeyForGoalSave(eventId, payload) {
      if (eventId) {
        return idempotencyKeyForGoalMutation(
          "update-goal",
          `${gameId}-${eventId}`,
          goalCreatePayloadFingerprint(payload),
        );
      }

      const fingerprint = goalCreatePayloadFingerprint(payload);
      if (!pendingCreateGoalIdempotency || pendingCreateGoalIdempotency.fingerprint !== fingerprint) {
        pendingCreateGoalIdempotency = {
          fingerprint,
          key: createIdempotencyKey("create-goal", `${gameId}-new`),
        };
      }

      return pendingCreateGoalIdempotency.key;
    }

    function assignmentButtons(playerId, currentTeamId = null) {
      const disabled = finishedRosterControlsLocked() ? " disabled" : "";
      return rosterTeams
        .map((team) => {
          const active = currentTeamId === team.teamId ? ' data-state="active" aria-pressed="true"' : "";
          return `<button data-ui="row-action" type="button" data-action="assign-player" data-player-id="${escapeHtml(
            playerId,
          )}" data-team-id="${escapeHtml(team.teamId)}"${active}${disabled}>${escapeHtml(team.name)}</button>`;
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
      const rosterLocked = finishedRosterControlsLocked();
      if (quickCreatePlayerButton instanceof HTMLButtonElement) {
        quickCreatePlayerButton.disabled = rosterLocked;
      }
      if (playerNicknameInput instanceof HTMLInputElement) {
        playerNicknameInput.disabled = rosterLocked;
      }
      renderPlayerPool();
      renderRosterTeams();
      syncGameModeState();
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
        subtitle.innerHTML = `Kickoff: <code>${escapeHtml(formatLocalTimestamp(game.gameStartTs))}</code>`;
      }

      if (gameIdValue) {
        gameIdValue.textContent = game.gameId;
      }
      if (finalGameIdValue) {
        finalGameIdValue.textContent = game.gameId;
      }
      if (gameJoinCodeValue) {
        gameJoinCodeValue.textContent = typeof game.joinCode === "string" && game.joinCode.length > 0
          ? game.joinCode
          : "Unavailable";
      }
      if (gameJoinLink instanceof HTMLAnchorElement) {
        if (typeof game.joinCode === "string" && game.joinCode.length > 0) {
          const joinPath = `/join/${encodeURIComponent(game.joinCode)}`;
          const joinUrl = new URL(joinPath, window.location.origin).toString();
          gameJoinLink.href = joinUrl;
          gameJoinLink.textContent = joinUrl;
          renderJoinQrCode(gameJoinQr, joinUrl);
        } else {
          gameJoinLink.href = "/join";
          gameJoinLink.textContent = "Unavailable";
          if (gameJoinQr instanceof HTMLElement) {
            gameJoinQr.textContent = "Unavailable";
          }
        }
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
      syncGameModeState();

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

    async function loadLeagueAccess() {
      currentLeagueRole = null;
      if (!currentLeagueId) {
        renderLiveScoring();
        return;
      }

      try {
        const league = await requestJsonOrThrow(`/v1/leagues/${encodeURIComponent(currentLeagueId)}`, {
          method: "GET",
        });
        currentLeagueRole = normalizeLeagueRole(league?.access?.role);
      } catch {
        currentLeagueRole = null;
      }

      renderLiveScoring();
    }

    saveButton.addEventListener("click", async () => {
      if (isGameFinished()) {
        return;
      }

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
        setGameMode(gameModeAfterGameSave(), { focusPanel: true });
        setStatus("Game updated.", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not update game.";
        showError(message);
        setStatus("Game update failed.", "error");
      } finally {
        saveButton.disabled = isGameFinished();
      }
    });

    deleteButton.addEventListener("click", async () => {
      if (isGameFinished()) {
        setStatus("Finished games are locked.", "error");
        return;
      }

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
        deleteButton.disabled = isGameFinished();
      }
    });

    startThirdButton.addEventListener("click", async () => {
      if (isGameFinished()) {
        return;
      }

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
        setGameMode("run");
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
      if (isGameFinished()) {
        return;
      }

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
        if (buildTimerState(currentGame).status === "complete") {
          setGameMode("final");
        }
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

    finishGameButton.addEventListener("click", async () => {
      if (!currentGame || isGameFinished()) {
        return;
      }

      const timer = buildTimerState(currentGame);
      if (timer.status !== "complete") {
        return;
      }

      finishGameButton.disabled = true;
      clearError();
      setStatus("Finishing game…", "default");

      try {
        currentGame = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/finish`, {
          method: "POST",
          headers: {
            "Idempotency-Key": createIdempotencyKey("finish-game", gameId),
          },
        });
        if (Array.isArray(currentGame?.result?.teams)) {
          scoreboardTeams = normalizeScoreboardTeams(currentGame.result.teams);
        }
        if (isGameFinished()) {
          await loadLeagueAccess();
        }
        setGameMode("final");
        statusInput.value = currentGame.status;
        renderTimer();
        renderRosterSetup();
        renderLiveScoring();
        setStatus("Game finished.", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not finish game.";
        showError(message);
        setStatus("Game finish failed.", "error");
      } finally {
        renderTimer();
        renderRosterSetup();
        renderLiveScoring();
      }
    });

    root.addEventListener("click", (event) => {
      const target = event.target;
      const trigger =
        target instanceof Element
          ? target.closest('[data-action="select-game-mode"][data-game-mode]')
          : null;
      if (!(trigger instanceof HTMLElement)) {
        return;
      }

      const mode = trigger.getAttribute("data-game-mode");
      manualGameModeSelected = true;
      if (mode === "final") {
        selectGameStateAction();
        return;
      }
      setGameMode(mode, { focusPanel: trigger.getAttribute("role") !== "tab" });
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
        if (finishedRosterControlsLocked()) {
          return;
        }

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
          quickCreatePlayerButton.disabled = finishedRosterControlsLocked();
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

        if (finishedRosterControlsLocked()) {
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
        if (isGameFinished() && !canCorrectFinishedGoals()) {
          renderLiveScoring();
          return;
        }

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
              "Idempotency-Key": idempotencyKeyForGoalSave(eventId, draft.payload),
            },
            body: JSON.stringify(draft.payload),
          });

          if (!eventId) {
            applyGoalMutationResult(result);
            pendingCreateGoalIdempotency = null;
            const gameRefreshed = await refreshGameAfterFinishedCorrection();
            if (!gameRefreshed) {
              showError("Goal was added, but the finished result could not be refreshed.");
              setStatus("Goal added; result refresh failed.", "success");
              return;
            }
          } else {
            const goalsLoaded = await loadGameGoals();
            if (!goalsLoaded) {
              throw new Error("Goal update was saved, but the latest goal state could not be loaded.");
            }
            const gameRefreshed = await refreshGameAfterFinishedCorrection();
            if (!gameRefreshed) {
              throw new Error("Goal update was saved, but the finished result could not be refreshed.");
            }
            editingGoalId = null;
            clearGoalMutationIdempotency("update-goal", `${gameId}-${eventId}`);
          }
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
        if (isGameFinished() && !canCorrectFinishedGoals()) {
          renderLiveScoring();
          return;
        }

        const latest = goalTimeline.at(-1);
        if (!latest) {
          return;
        }

        undoLastGoalButton.disabled = true;
        clearError();
        setStatus("Undoing latest goal…", "default");

        try {
          const stablePart = `${gameId}-${latest.eventId}`;
          const result = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/goals/undo-last`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKeyForGoalMutation("undo-goal", stablePart, latest.eventId),
            },
            body: JSON.stringify({
              expectedEventId: latest.eventId,
            }),
          });

          applyGoalMutationResult(result, { deletedEventId: latest.eventId });
          clearGoalMutationIdempotency("undo-goal", stablePart);
          const gameRefreshed = await refreshGameAfterFinishedCorrection();
          if (!gameRefreshed) {
            showError("Latest goal was undone, but the finished result could not be refreshed.");
            setStatus("Latest goal undone; result refresh failed.", "success");
            return;
          }
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

        if (isGameFinished() && !canCorrectFinishedGoals()) {
          renderLiveScoring();
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
          const stablePart = `${gameId}-${eventId}`;
          const result = await requestJsonOrThrow(
            `/v1/games/${encodeURIComponent(gameId)}/goals/${encodeURIComponent(eventId)}`,
            {
              method: "DELETE",
              headers: {
                "Idempotency-Key": idempotencyKeyForGoalMutation("delete-goal", stablePart, eventId),
              },
            },
          );

          applyGoalMutationResult(result, { deletedEventId: eventId });
          clearGoalMutationIdempotency("delete-goal", stablePart);
          const gameRefreshed = await refreshGameAfterFinishedCorrection();
          if (!gameRefreshed) {
            showError("Goal was deleted, but the finished result could not be refreshed.");
            setStatus("Goal deleted; result refresh failed.", "success");
            return;
          }
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
    if (isGameFinished()) {
      await loadLeagueAccess();
    }
    await loadRosterSetup({ updateStatus: false });
    const goalsLoaded = await loadGameGoals();
    if (!manualGameModeSelected) {
      setGameMode(preferredInitialGameMode());
    }
    syncGameModeState();

    try {
      const season = await requestJsonOrThrow(`/v1/seasons/${encodeURIComponent(currentSeasonId)}`, {
        method: "GET",
      });
      const previousLeagueId = currentLeagueId;
      currentLeagueId = season.leagueId;
      if (gameLeagueLink instanceof HTMLAnchorElement) {
        gameLeagueLink.href = `/leagues/${encodeURIComponent(currentLeagueId)}`;
      }
      if (isGameFinished() && currentLeagueId !== previousLeagueId) {
        await loadLeagueAccess();
      }
    } catch {
      // Keep existing game context if season lookup fails.
    }

    if (goalsLoaded) {
      setStatus("Game page ready.", "success");
    }
  }

  async function initJoinPage() {
    const routeJoinCode = resolveRouteEntityId("data-join-code", "join") ?? "";
    const joinCode = routeJoinCode.trim().toUpperCase();
    const joinCodeValue = document.getElementById("join-code-value");
    const form = document.getElementById("join-game-form");
    const nicknameInput = document.getElementById("join-player-nickname");
    const joinButton = root.querySelector('[data-action="join-game"]');
    const resultElement = document.getElementById("join-result");
    const resultPlayer = document.getElementById("join-result-player");
    const resultGame = document.getElementById("join-result-game");

    if (joinCodeValue) {
      joinCodeValue.textContent = joinCode || "Missing";
    }

    if (!joinCode) {
      setStatus("Join code missing.", "error");
      showError("Open a join link from a game page.");
      return;
    }

    if (!(form instanceof HTMLFormElement) || !(nicknameInput instanceof HTMLInputElement)) {
      setStatus("Join form unavailable.", "error");
      return;
    }

    nicknameInput.addEventListener("input", () => {
      clearError();
      setFieldMessage("join-player-nickname");
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError();

      const nickname = nicknameInput.value.trim();
      if (!nickname) {
        setFieldMessage("join-player-nickname", "invalid", "Nickname is required.");
        setStatus("Nickname required.", "error");
        return;
      }

      if (joinButton instanceof HTMLButtonElement) {
        joinButton.disabled = true;
      }
      nicknameInput.disabled = true;
      setStatus("Joining game...", "default");

      try {
        const result = await requestJsonOrThrow(`/v1/join/${encodeURIComponent(joinCode)}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKeyForPublicJoin(joinCode, nickname),
          },
          body: JSON.stringify({
            nickname,
          }),
        });

        clearIdempotencyKeyForPublicJoin(joinCode, nickname);
        setFieldMessage("join-player-nickname", "valid", "Joined.");
        setStatus("Joined game.", "success");
        if (resultPlayer) {
          resultPlayer.textContent = result?.player?.nickname ?? nickname;
        }
        if (resultGame) {
          resultGame.textContent = result?.gameId ?? "";
        }
        if (resultElement) {
          resultElement.hidden = false;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not join game.";
        showError(message);
        setStatus("Join failed.", "error");
        nicknameInput.disabled = false;
        if (joinButton instanceof HTMLButtonElement) {
          joinButton.disabled = false;
        }
      }
    });

    setStatus("Join page ready.", "success");
  }

  async function initialize() {
    clearError();

    if (page === "join") {
      try {
        await initJoinPage();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected join page error.";
        showError(message);
        setStatus("Page load failed.", "error");
      }
      return;
    }

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
