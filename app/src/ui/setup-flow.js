(() => {
  let root = document.getElementById("setup-flow-root");
  let apiBaseUrl = "";
  let page = "dashboard";
  let statusElement = null;
  let errorElement = null;

  function refreshShellReferences() {
    root = document.getElementById("setup-flow-root");
    if (!root) {
      return false;
    }

    apiBaseUrl =
      root.getAttribute("data-api-base-url") ??
      document.body.getAttribute("data-api-base-url") ??
      "";
    page = root.getAttribute("data-page") ?? "dashboard";
    statusElement = document.getElementById("setup-status");
    errorElement = document.getElementById("setup-error");
    return true;
  }

  if (!refreshShellReferences()) {
    return;
  }

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
    statusElement.hidden = text.length === 0;
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

  function buildLeagueSeasonPath(leagueId, seasonId) {
    return `/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}`;
  }

  function resolveNestedLeagueSeasonRoute() {
    const pathSegments = window.location.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    const leaguesIndex = pathSegments.indexOf("leagues");
    if (
      leaguesIndex < 0 ||
      pathSegments[leaguesIndex + 2] !== "seasons" ||
      pathSegments.length <= leaguesIndex + 3
    ) {
      return null;
    }

    try {
      return {
        leagueId: decodeURIComponent(pathSegments[leaguesIndex + 1]),
        seasonId: decodeURIComponent(pathSegments[leaguesIndex + 3]),
      };
    } catch {
      return {
        leagueId: pathSegments[leaguesIndex + 1],
        seasonId: pathSegments[leaguesIndex + 3],
      };
    }
  }

  function renderClientValidatedField({ id, label, type, required = false }) {
    return `<div data-ui="field">
      <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
      <input id="${escapeHtml(id)}" data-ui="input" data-testid="${escapeHtml(id)}" type="${escapeHtml(type)}"${required ? " required" : ""} />
      <p data-ui="field-hint" id="${escapeHtml(id)}-notice" data-default-kind="empty" data-default-message=""></p>
    </div>`;
  }

  function renderClientPanel(title, description, body, footer, testId) {
    return `<article data-ui="panel" data-testid="${escapeHtml(testId)}">
      <div data-ui="panel-heading">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
      <div data-ui="panel-body">${body}</div>
      ${footer ? `<div data-ui="panel-footer">${footer}</div>` : ""}
    </article>`;
  }

  function renderClientButton(label, variant, attributes) {
    const renderedAttributes = Object.entries(attributes)
      .map(([name, value]) => `${name}="${escapeHtml(String(value))}"`)
      .join(" ");
    return `<button data-ui="button" data-variant="${escapeHtml(variant)}" ${renderedAttributes}>${escapeHtml(label)}</button>`;
  }

  function renderClientIcon(name) {
    return `<span data-ui="icon" data-icon="${escapeHtml(name)}" aria-hidden="true"></span>`;
  }

  function renderClientIconButton({ icon, label, variant = "secondary", attributes = {} }) {
    const renderedAttributes = Object.entries({
      ...attributes,
      type: "button",
      "aria-label": label,
      title: label,
    })
      .map(([name, value]) => `${name}="${escapeHtml(String(value))}"`)
      .join(" ");
    return `<button data-ui="icon-button" data-variant="${escapeHtml(variant)}" ${renderedAttributes}>${renderClientIcon(icon)}</button>`;
  }

  function renderClientIconLink({ href, icon, label, attributes = {} }) {
    const renderedAttributes = Object.entries({
      ...attributes,
      href,
      "aria-label": label,
      title: label,
    })
      .map(([name, value]) => `${name}="${escapeHtml(String(value))}"`)
      .join(" ");
    return `<a data-ui="icon-link" data-variant="secondary" ${renderedAttributes}>${renderClientIcon(icon)}</a>`;
  }

  function setDisclosureState(trigger, panel, open, options = {}) {
    if (!(trigger instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) {
      return;
    }

    const focusWasInside = panel.contains(document.activeElement);
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    panel.hidden = !open;
    if (open && options.focus !== false) {
      const focusTarget = panel.querySelector("input, select, button, [tabindex]");
      if (focusTarget instanceof HTMLElement) {
        focusTarget.focus();
      }
      return;
    }
    if (!open && options.restoreFocus !== false && focusWasInside) {
      trigger.focus();
    }
  }

  function closeOtherDisclosures(activeTrigger) {
    for (const trigger of document.querySelectorAll('button[aria-controls][aria-expanded="true"]')) {
      if (!(trigger instanceof HTMLButtonElement) || trigger === activeTrigger) {
        continue;
      }
      const panelId = trigger.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      setDisclosureState(trigger, panel, false, { restoreFocus: false });
    }
  }

  function attachDisclosure(trigger, panel, options = {}) {
    if (!(trigger instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) {
      return;
    }

    trigger.addEventListener("click", () => {
      const open = trigger.getAttribute("aria-expanded") !== "true";
      if (open) {
        closeOtherDisclosures(trigger);
      }
      setDisclosureState(trigger, panel, open);
      if (open && typeof options.onOpen === "function") {
        options.onOpen();
      }
    });
  }

  function renderClientTableShell({ tableTestId, bodyId, emptyId, emptyText, headers }) {
    return `<div data-ui="table-wrap" data-testid="${escapeHtml(tableTestId)}" hidden>
      <table>
        <thead>
          <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
        </thead>
        <tbody id="${escapeHtml(bodyId)}"></tbody>
      </table>
    </div>
    <p data-ui="empty-state" id="${escapeHtml(emptyId)}">${escapeHtml(emptyText)}</p>`;
  }

  function mountSeasonShellForNestedLeagueRoute() {
    if (page !== "league") {
      return;
    }

    const route = resolveNestedLeagueSeasonRoute();
    if (!route) {
      return;
    }

    const safeApiBaseUrl = escapeHtml(apiBaseUrl);
    const safeLeagueId = escapeHtml(route.leagueId);
    const safeSeasonId = escapeHtml(route.seasonId);
    const createGamePanel = renderClientPanel(
      "Create game",
      "Add a game into this season.",
      `${renderClientValidatedField({
        id: "game-date",
        label: "Game date",
        type: "date",
        required: true,
      })}${renderClientValidatedField({
        id: "game-kickoff",
        label: "Kickoff time",
        type: "datetime-local",
        required: true,
      })}
      <div data-ui="field">
        <label for="game-third-length">Third length</label>
        <select id="game-third-length" data-ui="input" data-testid="game-third-length">
          <option value="20" selected>20 minutes</option>
          <option value="25">25 minutes</option>
          <option value="30">30 minutes</option>
        </select>
      </div>
      `,
      `<div data-ui="button-row">${renderClientButton("Create game", "primary", {
        type: "button",
        "data-action": "create-game",
        "data-testid": "create-game",
      })}</div>`,
      "panel-season-create-game",
    );
    const gamesPanel = renderClientPanel(
      "Games",
      "Manage scheduled games for this season.",
      renderClientTableShell({
        tableTestId: "season-games-table",
        bodyId: "season-games-body",
        emptyId: "season-games-empty",
        emptyText: "No games yet. Create your first game.",
        headers: ["Kickoff", "Status", "Actions"],
      }),
      "",
      "panel-season-games",
    );

    document.title = "3FC Season";
    document.body.setAttribute("data-api-base-url", apiBaseUrl);
    document.body.innerHTML = `<main data-ui="app-shell" data-testid="season-shell" data-api-base-url="${safeApiBaseUrl}" data-season-id="${safeSeasonId}" data-league-id="${safeLeagueId}">
      <section data-ui="hero">
        <span data-ui="hero-kicker"><a href="/setup">Dashboard</a> / <a id="season-league-link" href="/setup">League</a> / Season</span>
        <div data-ui="hero-title-row">
          <h1 id="season-title">${safeSeasonId || "Season"}</h1>
          <small data-ui="reference-id" id="season-reference">Season ID: ${safeSeasonId || "Loading..."}</small>
        </div>
        <div data-ui="header-actions" role="toolbar" aria-label="Season actions">
          ${renderClientIconButton({
            icon: "calendar-plus",
            label: "Create game",
            attributes: {
              "data-action": "toggle-create-game",
              "data-testid": "toggle-create-game",
              "aria-controls": "season-create-game-region",
              "aria-expanded": "false",
            },
          })}
          ${renderClientIconButton({
            icon: "trash-2",
            label: "Delete season",
            variant: "danger",
            attributes: {
              "data-action": "delete-season",
              "data-testid": "delete-season",
            },
          })}
        </div>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="season" data-api-base-url="${safeApiBaseUrl}" data-season-id="${safeSeasonId}" data-league-id="${safeLeagueId}">
        <p data-ui="status-note" id="setup-status" role="status" aria-live="polite">Loading season data...</p>
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-stack" data-testid="season-grid">
          ${gamesPanel}
          <section id="season-create-game-region" data-ui="disclosure-panel" hidden>
            ${createGamePanel}
          </section>
        </section>
      </section>
    </main>`;

    refreshShellReferences();
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

  function organiserInviteIdempotencyStablePart(leagueId, email) {
    const normalizedEmail = email.trim().toLowerCase();
    return `${leagueId.trim()}-${normalizedEmail || "link"}`;
  }

  function idempotencyKeyForOrganiserInvite(leagueId, email) {
    return cachedIdempotencyKey(
      "organiser-invite",
      organiserInviteIdempotencyStablePart(leagueId, email),
    );
  }

  function stableOrganiserShareInviteIdempotencyKey(leagueId) {
    const safeLeagueId = leagueId.trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-");
    return `organiser-share-invite-${(safeLeagueId || "league").slice(0, 80)}`;
  }

  function clearIdempotencyKeyForOrganiserInvite(leagueId, email) {
    clearCachedIdempotencyKey(
      "organiser-invite",
      organiserInviteIdempotencyStablePart(leagueId, email),
    );
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

  function isRouteUnavailable(error) {
    return error instanceof Error && (error.statusCode === 404 || error.statusCode === 405);
  }

  function isDefinitiveRequestRejection(error) {
    return (
      error instanceof Error &&
      Number.isInteger(error.statusCode) &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    );
  }

  async function requestJsonOrThrowWithFallback(primaryPath, fallbackPath, init = {}, validateFallback = null) {
    try {
      return await requestJsonOrThrow(primaryPath, init);
    } catch (error) {
      if (!fallbackPath || !isRouteUnavailable(error)) {
        throw error;
      }

      const fallbackBody = await requestJsonOrThrow(fallbackPath, init);
      if (typeof validateFallback === "function" && !validateFallback(fallbackBody)) {
        throw error;
      }

      return fallbackBody;
    }
  }

  async function currentAuthenticatedSession() {
    const result = await requestJson("/v1/auth/session", { method: "GET" });
    if (!result.ok) {
      return null;
    }

    return result.body?.session ?? null;
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

  function formatLocalDateHeading(isoTimestamp) {
    const parsed = new Date(isoTimestamp);
    if (Number.isNaN(parsed.getTime())) {
      return "Game";
    }

    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(parsed);
  }

  function formatLocalKickoffTime(isoTimestamp) {
    const parsed = new Date(isoTimestamp);
    if (Number.isNaN(parsed.getTime())) {
      return "Kickoff time unavailable";
    }

    return `Kickoff at ${new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(parsed)}`;
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

  function normalizePositiveInteger(value) {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  function normalizePositiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  }

  function regulationMinuteForElapsedSeconds(totalSeconds, thirdLengthMinutes) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const nominalSeconds = thirdLengthMinutes * 60;
    return Math.max(1, Math.min(thirdLengthMinutes, Math.floor(Math.min(safeSeconds, nominalSeconds) / 60) + 1));
  }

  function fullMatchMinuteForThird(third, thirdMinute, thirdLengthMinutes) {
    const safeThird = normalizePositiveInteger(third);
    const safeThirdMinute = normalizePositiveInteger(thirdMinute);
    if (!safeThird || !safeThirdMinute) {
      return null;
    }

    return (safeThird - 1) * thirdLengthMinutes + Math.min(safeThirdMinute, thirdLengthMinutes);
  }

  function fullMatchMinuteForThirdElapsed(third, elapsedSecondsValue, thirdLengthMinutes) {
    const safeThird = normalizePositiveInteger(third);
    const safeElapsedSeconds = normalizePositiveNumber(elapsedSecondsValue);
    if (!safeThird || safeElapsedSeconds === null) {
      return null;
    }

    return (
      (safeThird - 1) * thirdLengthMinutes +
      regulationMinuteForElapsedSeconds(safeElapsedSeconds, thirdLengthMinutes)
    );
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

  function dashboardNameFromSession(session) {
    const email = typeof session?.email === "string" ? session.email.trim() : "";
    const localPart = email.split("@")[0] ?? "";
    const token = localPart.split(/[._-]+/).find((part) => part.length > 0) ?? "";
    if (!token) {
      return email || "there";
    }

    return `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`;
  }

  async function initDashboardPage(session) {
    const leagueNameInput = document.getElementById("league-name");
    const leagueFriendlyUrlInput = document.getElementById("league-friendly-url");
    const leagueIdDisplay = document.getElementById("league-id-display");
    const createLeagueButton = root.querySelector('[data-action="create-league"]');
    const toggleCreateLeagueButton = root.querySelector('[data-action="toggle-create-league"]');
    const createLeagueRegion = document.getElementById("dashboard-create-league-region");
    const welcomeHeading = document.getElementById("dashboard-welcome");

    const leaguesBody = document.getElementById("dashboard-leagues-body");
    const leaguesTableWrap = document.querySelector('[data-testid="dashboard-leagues-table"]');
    const leaguesEmpty = document.getElementById("dashboard-leagues-empty");

    if (
      !(leagueNameInput instanceof HTMLInputElement) ||
      !(leagueFriendlyUrlInput instanceof HTMLInputElement) ||
      !(createLeagueButton instanceof HTMLButtonElement) ||
      !(toggleCreateLeagueButton instanceof HTMLButtonElement) ||
      !(createLeagueRegion instanceof HTMLElement) ||
      !(leaguesBody instanceof HTMLElement)
    ) {
      return;
    }

    let createLeagueDisclosureTouched = false;
    attachSlugAutoFill(leagueNameInput, leagueFriendlyUrlInput, leagueIdDisplay, "league");
    toggleCreateLeagueButton.addEventListener("click", () => {
      createLeagueDisclosureTouched = true;
    });
    attachDisclosure(toggleCreateLeagueButton, createLeagueRegion);
    if (welcomeHeading instanceof HTMLElement) {
      welcomeHeading.textContent = `Welcome ${dashboardNameFromSession(session)}`;
    }
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
        if (!createLeagueDisclosureTouched) {
          setDisclosureState(toggleCreateLeagueButton, createLeagueRegion, true, { focus: false });
        }
        setStatus("");
        return;
      }

      const rows = leagues
        .map((league) => {
          return `<tr>
            <td data-label="League"><a href="/leagues/${encodeURIComponent(league.leagueId)}">${escapeHtml(league.name)}</a></td>
            <td data-label="Actions">
              <div data-ui="row-action-buttons">
                ${renderClientIconLink({
                  href: `/leagues/${encodeURIComponent(league.leagueId)}`,
                  icon: "eye",
                  label: `View ${league.name}`,
                })}
                ${renderClientIconButton({
                  icon: "trash-2",
                  label: `Delete ${league.name}`,
                  variant: "danger",
                  attributes: {
                    "data-action": "delete-league",
                    "data-league-id": league.leagueId,
                  },
                })}
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
      setStatus("");
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
      const eventTarget = event.target;
      const target = eventTarget instanceof Element ? eventTarget.closest('[data-action="delete-league"]') : null;
      if (!(target instanceof HTMLElement)) {
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
    const leagueReference = document.getElementById("league-reference");
    const deleteLeagueButton = document.querySelector('[data-testid="delete-league"]');
    const toggleCreateSeasonButton = document.querySelector('[data-action="toggle-create-season"]');
    const toggleOrganiserInviteButton = document.querySelector('[data-action="toggle-organiser-invite"]');
    const createSeasonRegion = document.getElementById("league-create-season-region");
    const organiserInviteRegion = document.getElementById("league-organiser-invite-region");

    const seasonNameInput = document.getElementById("season-name");
    const seasonFriendlyUrlInput = document.getElementById("season-friendly-url");
    const seasonIdDisplay = document.getElementById("season-id-display");
    const createSeasonButton = root.querySelector('[data-action="create-season"]');
    const organiserInviteEmailInput = document.getElementById("organiser-invite-email");
    const createOrganiserInviteButton = root.querySelector('[data-action="create-organiser-invite"]');
    const organiserShareInviteStatus = document.getElementById("organiser-share-invite-status");
    const organiserShareInviteResult = document.getElementById("organiser-share-invite-result");
    const organiserShareInviteCode = document.getElementById("organiser-share-invite-code");
    const organiserShareInviteLink = document.getElementById("organiser-share-invite-link");
    const organiserInviteEmailStatus = document.getElementById("organiser-invite-email-status");

    const seasonsBody = document.getElementById("league-seasons-body");
    const seasonsTableWrap = document.querySelector('[data-testid="league-seasons-table"]');
    const seasonsEmpty = document.getElementById("league-seasons-empty");

    if (
      !(seasonNameInput instanceof HTMLInputElement) ||
      !(seasonFriendlyUrlInput instanceof HTMLInputElement) ||
      !(createSeasonButton instanceof HTMLButtonElement) ||
      !(toggleCreateSeasonButton instanceof HTMLButtonElement) ||
      !(toggleOrganiserInviteButton instanceof HTMLButtonElement) ||
      !(createSeasonRegion instanceof HTMLElement) ||
      !(organiserInviteRegion instanceof HTMLElement) ||
      !(organiserInviteEmailInput instanceof HTMLInputElement) ||
      !(createOrganiserInviteButton instanceof HTMLButtonElement) ||
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
    organiserInviteEmailInput.addEventListener("input", () => {
      setFieldMessage("organiser-invite-email");
    });

    let shareInviteLoaded = false;
    let shareInvitePromise = null;
    attachDisclosure(toggleCreateSeasonButton, createSeasonRegion);
    attachDisclosure(toggleOrganiserInviteButton, organiserInviteRegion, {
      onOpen: () => {
        if (!shareInviteLoaded && !shareInvitePromise) {
          shareInvitePromise = ensureShareInvite()
            .then((loaded) => {
              shareInviteLoaded = loaded;
            })
            .finally(() => {
              shareInvitePromise = null;
            });
        }
      },
    });

    function setLocalStatus(element, text, state = "default") {
      if (!(element instanceof HTMLElement)) {
        return;
      }

      element.textContent = text;
      element.hidden = text.length === 0;
      if (state === "default") {
        element.removeAttribute("data-state");
        return;
      }

      element.setAttribute("data-state", state);
    }

    function renderInviteCodeLink(resultElement, codeElement, linkElement, payload) {
      const inviteCode = typeof payload?.inviteCode === "string"
        ? payload.inviteCode
        : typeof payload?.invite?.inviteCode === "string" ? payload.invite.inviteCode : "";
      const inviteLink = typeof payload?.inviteLink === "string" ? payload.inviteLink : "";

      if (resultElement instanceof HTMLElement) {
        resultElement.hidden = false;
      }
      if (codeElement instanceof HTMLElement) {
        codeElement.textContent = inviteCode || "Unavailable";
      }
      if (linkElement instanceof HTMLAnchorElement) {
        if (inviteLink) {
          linkElement.href = inviteLink;
          linkElement.textContent = inviteLink;
        } else {
          linkElement.removeAttribute("href");
          linkElement.textContent = "Unavailable";
        }
      }
    }

    async function ensureShareInvite() {
      setLocalStatus(organiserShareInviteStatus, "Loading share invite…", "default");
      if (organiserShareInviteCode instanceof HTMLElement) {
        organiserShareInviteCode.textContent = "Loading…";
      }
      if (organiserShareInviteLink instanceof HTMLAnchorElement) {
        organiserShareInviteLink.removeAttribute("href");
        organiserShareInviteLink.textContent = "Loading…";
      }

      const idempotencyKey = stableOrganiserShareInviteIdempotencyKey(leagueId);

      try {
        const payload = await requestJsonOrThrow(
          `/v1/leagues/${encodeURIComponent(leagueId)}/organiser-invites`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              email: null,
            }),
          },
        );

        renderInviteCodeLink(
          organiserShareInviteResult,
          organiserShareInviteCode,
          organiserShareInviteLink,
          payload,
        );
        setLocalStatus(organiserShareInviteStatus, "", "default");
        return true;
      } catch {
        if (organiserShareInviteCode instanceof HTMLElement) {
          organiserShareInviteCode.textContent = "Unavailable";
        }
        if (organiserShareInviteLink instanceof HTMLAnchorElement) {
          organiserShareInviteLink.removeAttribute("href");
          organiserShareInviteLink.textContent = "Unavailable";
        }
        setLocalStatus(organiserShareInviteStatus, "Share invite unavailable. Close and reopen to try again.", "error");
        return false;
      }
    }

    async function loadLeague() {
      const league = await requestJsonOrThrow(`/v1/leagues/${encodeURIComponent(leagueId)}`, {
        method: "GET",
      });

      if (title) {
        title.textContent = league.name;
      }

      if (leagueReference) {
        leagueReference.textContent = `League ID: ${league.leagueId}`;
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
          const seasonPath = buildLeagueSeasonPath(leagueId, season.seasonId);
          return `<tr>
            <td data-label="Season"><a href="${seasonPath}">${escapeHtml(season.name)}</a></td>
            <td data-label="Dates">${escapeHtml(dateRange)}</td>
            <td data-label="Actions">
              <div data-ui="row-action-buttons">
                ${renderClientIconLink({ href: seasonPath, icon: "eye", label: `View ${season.name}` })}
                ${renderClientIconButton({
                  icon: "trash-2",
                  label: `Delete ${season.name}`,
                  variant: "danger",
                  attributes: { "data-action": "delete-season", "data-season-id": season.seasonId },
                })}
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

        navigateTo(buildLeagueSeasonPath(leagueId, seasonId));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create season.";
        showError(message);
        setStatus("Season creation failed.", "error");
      } finally {
        createSeasonButton.disabled = false;
      }
    });

    createOrganiserInviteButton.addEventListener("click", async () => {
      clearError();

      const rawEmail = organiserInviteEmailInput.value.trim();
      if (!rawEmail) {
        setFieldMessage("organiser-invite-email", "invalid", "Email is required.");
        organiserInviteEmailInput.focus();
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
        setFieldMessage("organiser-invite-email", "invalid", "Enter a valid email address.");
        organiserInviteEmailInput.focus();
        return;
      }

      setFieldMessage("organiser-invite-email");
      createOrganiserInviteButton.disabled = true;
      setLocalStatus(organiserInviteEmailStatus, "Sending invite…", "default");
      setStatus("Sending organiser invite…", "default");
      const idempotencyKey = idempotencyKeyForOrganiserInvite(leagueId, rawEmail);

      try {
        const payload = await requestJsonOrThrow(
          `/v1/leagues/${encodeURIComponent(leagueId)}/organiser-invites`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              email: rawEmail,
            }),
          },
        );

        if (payload.emailDelivery?.status === "sent") {
          setLocalStatus(organiserInviteEmailStatus, `Sent to ${payload.emailDelivery.email}.`, "success");
        } else if (payload.emailDelivery?.status === "unknown") {
          const recoveryLink = typeof payload.inviteLink === "string" ? payload.inviteLink : "";
          setLocalStatus(organiserInviteEmailStatus, "Delivery unconfirmed.", "error");
          if (recoveryLink) {
            const recoveryAnchor = document.createElement("a");
            recoveryAnchor.href = recoveryLink;
            recoveryAnchor.textContent = "Open the email-restricted recovery link";
            recoveryAnchor.className = "inline-recovery-link";
            organiserInviteEmailStatus.append(" ", recoveryAnchor, ".");
          }
        } else {
          setLocalStatus(organiserInviteEmailStatus, "Invite created.", "success");
        }

        organiserInviteEmailInput.value = "";
        clearIdempotencyKeyForOrganiserInvite(leagueId, rawEmail);
        setStatus(
          payload.emailDelivery?.status === "unknown"
            ? "Organiser invite created; email delivery unconfirmed."
            : "Organiser invite sent.",
          "success",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create organiser invite.";
        setLocalStatus(organiserInviteEmailStatus, `Invite failed: ${message}`, "error");
        showError(message);
        setStatus("Organiser invite failed.", "error");
      } finally {
        createOrganiserInviteButton.disabled = false;
      }
    });

    seasonsBody.addEventListener("click", async (event) => {
      const eventTarget = event.target;
      const target = eventTarget instanceof Element ? eventTarget.closest('[data-action="delete-season"]') : null;
      if (!(target instanceof HTMLElement)) {
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
    setStatus("");
  }

  async function initSeasonPage() {
    const seasonId = resolveRouteEntityId("data-season-id", "seasons");
    if (!seasonId) {
      return;
    }
    const routeLeagueId = resolveRouteEntityId("data-league-id", "leagues");

    const seasonTitle = document.getElementById("season-title");
    const seasonReference = document.getElementById("season-reference");
    const seasonLeagueLink = document.getElementById("season-league-link");

    const gameDateInput = document.getElementById("game-date");
    const gameKickoffInput = document.getElementById("game-kickoff");
    const gameThirdLengthInput = document.getElementById("game-third-length");
    const createGameButton = root.querySelector('[data-action="create-game"]');
    const toggleCreateGameButton = document.querySelector('[data-action="toggle-create-game"]');
    const createGameRegion = document.getElementById("season-create-game-region");

    const deleteSeasonButton = document.querySelector('[data-testid="delete-season"]');

    const gamesBody = document.getElementById("season-games-body");
    const gamesTableWrap = document.querySelector('[data-testid="season-games-table"]');
    const gamesEmpty = document.getElementById("season-games-empty");

    if (
      !(gameDateInput instanceof HTMLInputElement) ||
      !(gameKickoffInput instanceof HTMLInputElement) ||
      !(gameThirdLengthInput instanceof HTMLSelectElement) ||
      !(createGameButton instanceof HTMLButtonElement) ||
      !(toggleCreateGameButton instanceof HTMLButtonElement) ||
      !(createGameRegion instanceof HTMLElement) ||
      !(gamesBody instanceof HTMLElement)
    ) {
      return;
    }

    let leagueId = routeLeagueId ?? "";
    let gameIdNonce = randomSuffix(4);
    let derivedGameId = "";

    attachDisclosure(toggleCreateGameButton, createGameRegion);

    function updateDerivedGameId() {
      const sessionId = gameDateInput.value.trim() ? gameDateInput.value.trim().replaceAll("-", "") : `session-${randomSuffix(6)}`;
      const kickoff = gameKickoffInput.value.trim();
      const kickoffPart = kickoff.includes("T") ? kickoff.split("T")[1].replace(":", "") : "0000";
      derivedGameId = `game-${sessionId}-${kickoffPart}-${gameIdNonce}`;
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
      const seasonPath = routeLeagueId
        ? `/v1/leagues/${encodeURIComponent(routeLeagueId)}/seasons/${encodeURIComponent(seasonId)}`
        : `/v1/seasons/${encodeURIComponent(seasonId)}`;
      const legacySeasonPath = `/v1/seasons/${encodeURIComponent(seasonId)}`;
      const season = await requestJsonOrThrowWithFallback(
        seasonPath,
        routeLeagueId ? legacySeasonPath : null,
        { method: "GET" },
        (fallbackSeason) => fallbackSeason?.leagueId === routeLeagueId,
      );

      leagueId = season.leagueId;
      if (seasonTitle) {
        seasonTitle.textContent = season.name;
      }

      if (seasonReference) {
        seasonReference.textContent = `Season ID: ${season.seasonId}`;
      }

      if (seasonLeagueLink instanceof HTMLAnchorElement) {
        seasonLeagueLink.href = `/leagues/${encodeURIComponent(season.leagueId)}`;
      }
    }

    async function renderGames() {
      const gamesPath = leagueId
        ? `/v1/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/games`
        : `/v1/seasons/${encodeURIComponent(seasonId)}/games`;
      const legacyGamesPath = `/v1/seasons/${encodeURIComponent(seasonId)}/games`;
      const payload = await requestJsonOrThrowWithFallback(
        gamesPath,
        leagueId ? legacyGamesPath : null,
        { method: "GET" },
      );

      const games = (Array.isArray(payload?.games) ? payload.games : []).filter(
        (game) => !leagueId || (game.leagueId === leagueId && game.seasonId === seasonId),
      );
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
        .map((game) => {
          const status = ["scheduled", "live", "finished"].includes(game.status) ? game.status : "scheduled";
          const statusIcon = status === "live" ? "activity" : status === "finished" ? "circle-check" : "calendar-clock";
          const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
          const gamePath = `/games/${encodeURIComponent(game.gameId)}`;
          return `<tr>
          <td data-label="Kickoff"><a href="${gamePath}">${escapeHtml(formatLocalTimestamp(game.gameStartTs))}</a></td>
          <td data-label="Status"><span data-ui="status-chip" data-status="${escapeHtml(status)}">${renderClientIcon(statusIcon)}<span>${escapeHtml(statusLabel)}</span></span></td>
          <td data-label="Actions">
            <div data-ui="row-action-buttons">
              ${renderClientIconLink({ href: gamePath, icon: "eye", label: `View game at ${formatLocalTimestamp(game.gameStartTs)}` })}
              ${renderClientIconButton({
                icon: "trash-2",
                label: `Delete game at ${formatLocalTimestamp(game.gameStartTs)}`,
                variant: "danger",
                attributes: { "data-action": "delete-game", "data-game-id": game.gameId },
              })}
            </div>
          </td>
        </tr>`;
        })
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
      const gameId = derivedGameId || `game-${sessionId}-${randomSuffix(6)}`;

      createGameButton.disabled = true;
      setStatus("Creating game…", "default");

      try {
        const createSessionPath = leagueId
          ? `/v1/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/sessions`
          : `/v1/seasons/${encodeURIComponent(seasonId)}/sessions`;
        await requestJsonOrThrow(createSessionPath, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": createIdempotencyKey("create-session", `${leagueId}-${seasonId}-${sessionId}`),
          },
          body: JSON.stringify({
            sessionId,
            sessionDate: gameDate,
          }),
        });

        const createGamePath = leagueId
          ? `/v1/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/sessions/${encodeURIComponent(sessionId)}/games`
          : `/v1/sessions/${encodeURIComponent(sessionId)}/games`;
        await requestJsonOrThrow(createGamePath, {
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
      const eventTarget = event.target;
      const target = eventTarget instanceof Element ? eventTarget.closest('[data-action="delete-game"]') : null;
      if (!(target instanceof HTMLElement)) {
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
          const deleteSeasonPath = leagueId
            ? `/v1/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}`
            : `/v1/seasons/${encodeURIComponent(seasonId)}`;
          await requestJsonOrThrow(deleteSeasonPath, {
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
    if (window.location.hash === "#create-game") {
      setDisclosureState(toggleCreateGameButton, createGameRegion, true);
    }
    setStatus("");
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
    const deleteButton = document.querySelector('[data-action="delete-game"]');
    const deleteLockReason = document.getElementById("game-delete-lock-reason");
    const createAnotherLink = document.getElementById("create-another-game-link");
    const timerThirdLabel = document.getElementById("timer-third-label");
    const timerDisplayValue = document.getElementById("timer-display-value");
    const timerPhaseLabel = document.getElementById("timer-phase-label");
    const timerThirdLength = document.getElementById("timer-third-length");
    const timerStatus = document.getElementById("timer-status");
    const timerActiveThird = document.getElementById("timer-active-third");
    const timerDisplayElement = document.getElementById("timer-display");
    const thirdStatusList = document.getElementById("third-status-list");
    const startThirdButton = root.querySelector('[data-action="start-active-third"]');
    const finishThirdButton = root.querySelector('[data-action="finish-active-third"]');
    const finishGameButton = root.querySelector('[data-action="finish-game"]');
    const gameResultSummaryElement = document.getElementById("game-result-summary");
    const finalGameStatus = document.getElementById("final-game-status");
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
    let openTransferPlayerId = null;
    let scoreboardTeams = [];
    let scoreboardState = "loading";
    let goalTimeline = [];
    let goalTimelineLoaded = false;
    let finishedResultState = "authoritative";
    let editingGoalId = null;
    let goalMutationInFlight = false;
    let currentLeagueRole = null;
    let manualGameModeSelected = false;
    let pendingCreateGoalIdempotency = null;
    const pendingGoalMutationIdempotency = new Map();
    const gameModes = ["structure", "players", "run", "final"];
    const gameModeTabs = [...root.querySelectorAll('[data-ui="game-mode-tab"][data-game-mode]')];
    const gameModeTriggers = [...root.querySelectorAll('[data-action="select-game-mode"][data-game-mode]')];
    const gameModePanels = [...root.querySelectorAll('[data-ui="game-mode-panel"][data-game-mode]')];

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
        tab.setAttribute("aria-pressed", active ? "true" : "false");
        tab.setAttribute("data-state", active ? "active" : "idle");
      }

      for (const trigger of gameModeTriggers) {
        if (trigger instanceof HTMLElement) {
          trigger.setAttribute("data-current", trigger.getAttribute("data-game-mode") === mode ? "true" : "false");
        }
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

      if (finalGameStatus instanceof HTMLElement) {
        finalGameStatus.textContent = humanGameStatus(currentGame?.status);
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
        return false;
      }

      if (isGameFinished() || timer.status === "complete") {
        setGameMode("final");
        focusElementAction(finishGameButton);
        return true;
      }

      setGameMode("run");
      const activeSegment = timer.thirds.find((third) => third.status === "running") ?? null;
      focusElementAction(activeSegment ? timerDisplayElement : startThirdButton);
      return true;
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
      deleteButton.disabled = false;
      if (gameFinished) {
        deleteButton.setAttribute("aria-disabled", "true");
        deleteButton.setAttribute("aria-describedby", "game-delete-lock-reason");
        deleteButton.setAttribute("aria-label", "Delete game unavailable: game is finished");
        deleteButton.title = "Finished games cannot be deleted";
        if (deleteLockReason instanceof HTMLElement) {
          deleteLockReason.hidden = false;
        }
      } else {
        deleteButton.removeAttribute("aria-disabled");
        deleteButton.removeAttribute("aria-describedby");
        deleteButton.setAttribute("aria-label", "Delete game");
        deleteButton.title = "Delete game";
        if (deleteLockReason instanceof HTMLElement) {
          deleteLockReason.hidden = true;
        }
      }
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
      const enrichedPlayer = rosterPlayers.find((player) => player.playerId === playerId);
      if (enrichedPlayer) {
        return enrichedPlayer;
      }

      const assignedPlayer = rosterAssignments.find((assignment) => assignment.playerId === playerId)?.player;
      if (assignedPlayer) {
        return assignedPlayer;
      }

      return null;
    }

    function playerNickname(playerId) {
      if (typeof playerId !== "string" || playerId.length === 0) {
        return typeof playerId === "number" && Number.isFinite(playerId)
          ? `Unknown player (invalid ID: ${playerId})`
          : "Unknown player (invalid ID)";
      }

      const nickname = playerById(playerId)?.nickname;
      if (typeof nickname === "string" && nickname.length > 0) {
        return nickname;
      }

      return String(playerId ?? "Unknown player");
    }

    function teamName(teamId) {
      const name = teamById(teamId)?.name;
      if (typeof name === "string" && name.length > 0) {
        return name;
      }

      return String(teamId ?? "Unknown team");
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
        name:
          typeof team.name === "string" && team.name.length > 0
            ? team.name
            : String(team.teamId ?? "Unknown team"),
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
      if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
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

      if (isGameFinished() && finishedResultState !== "authoritative") {
        const resultPending = finishedResultState === "refreshing";
        const resultUncertain = finishedResultState === "uncertain";
        const heading = resultPending
          ? "Refreshing result"
          : resultUncertain
            ? "Result may have changed"
            : "Result refresh required";
        const message = resultPending
          ? "Checking the latest match result…"
          : resultUncertain
            ? "The correction outcome could not be confirmed. Retry the same action."
            : "The goal change was saved, but the updated match result could not be loaded.";
        gameResultSummaryElement.hidden = false;
        gameResultSummaryElement.innerHTML = `<section data-ui="result-board" data-state="unavailable">
          <header>
            <span>Final result</span>
            <strong>${heading}</strong>
          </header>
          <p data-ui="empty-note">${message}</p>
        </section>`;
        syncGameModeState();
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
      const goalLogsLoaded = goalTimelineLoaded;
      gameResultSummaryElement.hidden = false;
      gameResultSummaryElement.innerHTML = `<section data-ui="result-board" data-outcome="${escapeHtml(resultOutcome)}">
        <header>
          <span>Final result</span>
          <strong data-testid="game-result-outcome">${escapeHtml(outcomeText)}</strong>
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
                ${goalLogsLoaded
                  ? `<details data-ui="final-team-log" data-testid="final-team-log-${escapeHtml(team.teamId)}">
                    <summary>Scoring log</summary>
                    <ol data-ui="final-goal-list">
                      ${renderFinalGoalItems(teamGoals, "No goals recorded for this team.")}
                    </ol>
                  </details>`
                  : `<p data-ui="empty-note" data-testid="final-team-log-unavailable-${escapeHtml(team.teamId)}">Goal log unavailable.</p>`}
              </article>`;
            })
            .join("")}
        </div>
        ${goalLogsLoaded ? `${renderFinalAggregateStats()}${renderFinalFullGoalLog()}` : renderFinalGoalSummariesUnavailable()}
      </section>`;
      syncGameModeState();
    }

    function renderSelectOptions(
      selectElement,
      options,
      selectedValue,
      emptyLabel = "Select",
      missingSelectedLabel = null,
      includePlaceholder = false,
    ) {
      const selectedExists = options.some((option) => option.value === selectedValue);
      const preservesMissingSelection =
        !selectedExists && Boolean(selectedValue) && typeof missingSelectedLabel === "string";
      const safeSelected = selectedExists || preservesMissingSelection
        ? selectedValue
        : includePlaceholder
          ? ""
          : (options[0]?.value ?? "");
      const placeholderOption = includePlaceholder
        ? `<option value=""${safeSelected === "" ? " selected" : ""}>${escapeHtml(emptyLabel)}</option>`
        : "";
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
          ? `${placeholderOption}${preservedOption}${renderedOptions}`
          : `<option value="">${escapeHtml(emptyLabel)}</option>`;
      selectElement.value = safeSelected;
      selectElement.disabled = options.length === 0 && !preservesMissingSelection;
    }

    function renderLiveScoreboard() {
      if (!(liveScoreboardElement instanceof HTMLElement)) {
        return;
      }

      if (scoreboardState !== "authoritative") {
        const message = scoreboardState === "unavailable"
          ? "Scores unavailable. Reload to try again."
          : scoreboardState === "uncertain"
            ? "Scores may have changed. Retry the same action."
          : scoreboardState === "refreshing"
            ? "Refreshing scores…"
            : "Loading scores…";
        liveScoreboardElement.innerHTML = `<p data-ui="empty-note" data-testid="live-scoreboard-${escapeHtml(scoreboardState)}">${message}</p>`;
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
              <div><dt>Conceded</dt><dd>${escapeHtml(String(team.conceded))}</dd></div>
              <div><dt>Scored</dt><dd>${escapeHtml(String(team.scored))}</dd></div>
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
        renderSelectOptions(goalScoringTeamInput, teamOptions, previousScoringTeamId, "Choose scoring team", null, true);
      }

      const scoringTeamId = ownGoal ? null : goalScoringTeamInput.value;
      const concedingOptions = ownGoal
        ? teamOptions
        : teamOptions.filter((team) => team.value !== scoringTeamId);
      renderSelectOptions(
        goalConcedingTeamInput,
        concedingOptions,
        previousConcedingTeamId,
        "Choose conceding team",
        null,
        true,
      );
      if (!ownGoal && !scoringTeamId) {
        goalConcedingTeamInput.disabled = true;
      }

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
        true,
      );
      if (!concedingTeamId || (!ownGoal && !scoringTeamId)) {
        goalScorerInput.disabled = true;
      }
      renderGoalAssistChoices(goalScorerInput.value, seed.assistPlayerIds ?? null);

      const activeThird = activeThirdNumber();
      const gameFinished = isGameFinished();
      const finishedCorrectionsAllowed = canCorrectFinishedGoals();
      const creatingFinishedCorrection = gameFinished && finishedCorrectionsAllowed && !isEditingGoal();
      saveGoalButton.textContent = editingGoalId ? "Save goal" : "Add goal";
      cancelGoalEditButton.hidden = editingGoalId === null;
      cancelGoalEditButton.disabled = editingGoalId === null;
      undoLastGoalButton.disabled =
        goalMutationInFlight ||
        !goalTimelineLoaded ||
        goalTimeline.length === 0 ||
        (gameFinished && !finishedCorrectionsAllowed);
      undoLastGoalButton.textContent = "Undo last";

      if (goalMutationInFlight) {
        goalScoringTeamInput.disabled = true;
        goalConcedingTeamInput.disabled = true;
        goalOwnGoalInput.disabled = true;
        goalScorerInput.disabled = true;
        saveGoalButton.disabled = true;
        cancelGoalEditButton.disabled = true;
        for (const input of goalAssistsElement.querySelectorAll("input")) {
          if (input instanceof HTMLInputElement) {
            input.disabled = true;
          }
        }
        goalFormNote.textContent = "Saving goal change…";
        return;
      }

      if (!goalTimelineLoaded) {
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
        goalFormNote.textContent = "Goal timeline unavailable. Reload before scoring or correcting goals.";
        return;
      }

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

      goalOwnGoalInput.disabled = false;
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

      if (!goalOwnGoalInput.checked && !goalScoringTeamInput.value) {
        saveGoalButton.disabled = true;
        goalFormNote.textContent = "Choose a scoring team before adding a goal.";
        return;
      }

      if (!goalConcedingTeamInput.value) {
        saveGoalButton.disabled = true;
        goalFormNote.textContent = "Choose a conceding team before adding a goal.";
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
          ? "Choose the goal details to correct the finished result."
          : "Start a third before adding goals.";
        return;
      }

      saveGoalButton.disabled = false;
      goalFormNote.textContent = `Goal will be added to third ${activeThird}.`;
    }

    function renderThirdIndicator(third) {
      const safeThird = Number.isInteger(third) && third >= 1 && third <= 3 ? third : null;
      if (!safeThird) {
        return "";
      }

      return `<span data-ui="third-indicator" data-third="${safeThird}" role="img" aria-label="Third ${safeThird} of 3"></span>`;
    }

    function renderGoalTeamChip(teamId, relationship = "") {
      const team = teamById(teamId);
      const name = typeof team?.name === "string" && team.name.length > 0
        ? team.name
        : String(teamId ?? "Unknown team");
      return `<span data-ui="goal-team-chip" role="img" data-team-id="${escapeHtml(String(teamId ?? ""))}"${
        team ? teamSwatchStyle(team) : ""
      }${relationship ? ` aria-label="${escapeHtml(`${relationship}: ${name}`)}"` : ""}><span data-ui="team-swatch" aria-hidden="true"></span><span>${escapeHtml(name)}</span></span>`;
    }

    function goalDisplayTime(goal) {
      const thirdLength = parseThirdLengthMinutes(currentGame?.thirdLengthMinutes ?? currentGame?.timer?.thirdLengthMinutes);
      const stoppageMinute = normalizePositiveInteger(goal.stoppageMinute);
      const safeThird = normalizePositiveInteger(goal.third);
      if (stoppageMinute) {
        const stoppageBaseMinute = safeThird
          ? safeThird * thirdLength
          : normalizePositiveInteger(goal.gameMinute);
        if (stoppageBaseMinute) {
          return `${stoppageBaseMinute}+${stoppageMinute}"`;
        }
      }

      const regulationMinute = fullMatchMinuteForThird(goal.third, goal.thirdMinute, thirdLength);
      if (regulationMinute) {
        return `${regulationMinute}"`;
      }

      const elapsedMinute = fullMatchMinuteForThirdElapsed(goal.third, goal.elapsedSeconds, thirdLength);
      if (elapsedMinute) {
        return `${elapsedMinute}"`;
      }

      if (Number.isInteger(goal.gameMinute) && goal.gameMinute > 0) {
        return `${goal.gameMinute}"`;
      }

      if (typeof goal.displayTime === "string" && goal.displayTime.length > 0) {
        const stoppageMatch = goal.displayTime.match(/^(\d+)\+0?(\d+)$/);
        if (stoppageMatch) {
          const stoppageBaseMinute = safeThird
            ? safeThird * thirdLength
            : Number.parseInt(stoppageMatch[1], 10);
          return `${stoppageBaseMinute}+${Number.parseInt(stoppageMatch[2], 10)}"`;
        }

        const clockMatch = goal.displayTime.match(/^(\d+):\d{2}$/);
        if (clockMatch) {
          const periodMinute = Math.max(1, Number.parseInt(clockMatch[1], 10));
          if (safeThird) {
            return `${(safeThird - 1) * thirdLength + Math.min(periodMinute, thirdLength)}"`;
          }
          return `${periodMinute}"`;
        }

        const decimalMinuteMatch = goal.displayTime.match(/^(\d+(?:\.\d+)?)$/);
        if (decimalMinuteMatch) {
          return `${Math.max(1, Math.ceil(Number.parseFloat(decimalMinuteMatch[1])))}"`;
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

    function renderFinalGoalItems(goals, emptyText, options = {}) {
      if (goals.length === 0) {
        return `<li data-ui="empty-note">${escapeHtml(emptyText)}</li>`;
      }

      return goals
        .map((goal) => {
          const detail = finalTeamGoalDetail(goal);
          const includesThird = options.includeThird === true && Number.isInteger(goal.third);
          const goalTeamSemantics = options.includeThird === true
            ? goal.ownGoal
              ? `Own goal. No scoring team. Conceding team: ${teamName(goal.concedingTeamId)}.`
              : `Scoring team: ${teamName(goal.scoringTeamId)}. Conceding team: ${teamName(goal.concedingTeamId)}.`
            : "";
          return `<li data-ui="final-goal-item" data-event-id="${escapeHtml(String(goal.eventId ?? ""))}"${
            includesThird ? ' data-has-third="true"' : ""
          }>
            <span data-ui="goal-time">${escapeHtml(goalDisplayTime(goal))}</span>
            <div>
              <strong>${escapeHtml(finalTeamGoalLabel(goal))}</strong>
              <small>${escapeHtml(detail)}</small>
              ${goalTeamSemantics ? `<span class="sr-only" data-ui="goal-team-semantics">${escapeHtml(goalTeamSemantics)}</span>` : ""}
            </div>
            ${includesThird ? renderThirdIndicator(goal.third) : ""}
          </li>`;
        })
        .join("");
    }

    function incrementPlayerStat(stats, playerId) {
      if (playerId === null || playerId === undefined || playerId === "") {
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

    function renderFinalGoalSummariesUnavailable() {
      return `<section data-ui="final-goal-unavailable" data-testid="final-goal-summary-unavailable" aria-label="Goal summaries unavailable">
        <h4>Goal summaries unavailable</h4>
        <p data-ui="empty-note">Team result totals are shown, but scorer, assist, and full goal logs could not be loaded.</p>
      </section>`;
    }

    function renderFinalFullGoalLog() {
      return `<details data-ui="final-full-log" data-testid="final-full-goal-log">
        <summary>Full match log</summary>
        <ol data-ui="final-goal-list">
          ${renderFinalGoalItems(goalTimeline, "No goals recorded.", { includeThird: true })}
        </ol>
      </details>`;
    }

    function renderGoalTimeline() {
      if (!(goalTimelineElement instanceof HTMLElement)) {
        return;
      }

      if (!goalTimelineLoaded) {
        goalTimelineElement.innerHTML = `<li data-ui="empty-note">Goal timeline unavailable.</li>`;
        return;
      }

      if (goalTimeline.length === 0) {
        goalTimelineElement.innerHTML = `<li data-ui="empty-note">No goals yet.</li>`;
        return;
      }

      const latestEventId = goalTimeline.at(-1)?.eventId ?? null;
      const finishedActionsDisabled =
        goalMutationInFlight || (isGameFinished() && !canCorrectFinishedGoals());
      const disabledAttribute = finishedActionsDisabled ? " disabled" : "";
      goalTimelineElement.innerHTML = [...goalTimeline]
        .reverse()
        .map((goal) => {
          const assists =
            Array.isArray(goal.assistPlayerIds) && goal.assistPlayerIds.length > 0
              ? goal.assistPlayerIds.map((playerId) => playerNickname(playerId)).join(", ")
              : "None";
          const latest = goal.eventId === latestEventId;
          const displayTime = goalDisplayTime(goal);
          const scorer = String(playerNickname(goal.scorerPlayerId));
          const eventId = String(goal.eventId ?? "");
          const scoringContext = goal.ownGoal
            ? `<span data-ui="own-goal-marker" aria-label="Own goal">OG</span>`
            : renderGoalTeamChip(goal.scoringTeamId, "Scoring team");
          return `<li data-ui="goal-event" data-event-id="${escapeHtml(eventId)}"${
            latest ? ' data-state="latest"' : ""
          }>
            <div data-ui="goal-event-main">
              <div data-ui="goal-primary-row">
                <strong data-ui="goal-time">${escapeHtml(displayTime)}</strong>
                <span data-ui="goal-scorer">${escapeHtml(scorer)}</span>
                ${scoringContext}
                <span data-ui="goal-team-arrow" aria-hidden="true">→</span>
                ${renderGoalTeamChip(goal.concedingTeamId, "Conceding team")}
                ${renderThirdIndicator(goal.third)}
              </div>
              <small>Assists: ${escapeHtml(assists)}</small>
              ${goal.ownGoal ? `<small>Own goal: conceding tally only</small>` : ""}
            </div>
            <div data-ui="row-action-buttons">
              <button data-ui="icon-button" type="button" data-action="edit-goal" data-event-id="${escapeHtml(
                eventId,
              )}" aria-label="Edit ${escapeHtml(scorer)} goal at ${escapeHtml(displayTime)}" title="Edit goal"${
                disabledAttribute
              }>${renderClientIcon("pencil")}</button>
              <button data-ui="icon-button" data-variant="danger" type="button" data-action="delete-goal" data-event-id="${escapeHtml(
                eventId,
              )}" aria-label="Delete ${escapeHtml(scorer)} goal at ${escapeHtml(displayTime)}" title="Delete goal"${
                disabledAttribute
              }>${renderClientIcon("trash-2")}</button>
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
      scoreboardState = "refreshing";
      if (Array.isArray(result?.scoreboard?.teams)) {
        scoreboardTeams = normalizeScoreboardTeams(result.scoreboard.teams);
      }

      if (Array.isArray(result?.timeline)) {
        goalTimelineLoaded = true;
        goalTimeline = sortGoalTimeline(result.timeline);
      } else if (goalTimelineLoaded && result?.goal) {
        const nextGoal = result.goal;
        goalTimeline = sortGoalTimeline([
          ...goalTimeline.filter((goal) => goal.eventId !== nextGoal.eventId),
          nextGoal,
        ]);
      } else if (goalTimelineLoaded && fallback.deletedEventId) {
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
      if (goalScoringTeamInput instanceof HTMLSelectElement) {
        goalScoringTeamInput.value = "";
      }
      if (goalConcedingTeamInput instanceof HTMLSelectElement) {
        goalConcedingTeamInput.value = "";
      }
      if (goalScorerInput instanceof HTMLSelectElement) {
        goalScorerInput.value = "";
      }
      for (const input of goalAssistsElement?.querySelectorAll('input[type="checkbox"]') ?? []) {
        if (input instanceof HTMLInputElement) {
          input.checked = false;
        }
      }
      renderLiveScoring({
        ownGoal: false,
        scoringTeamId: "",
        concedingTeamId: "",
        scorerPlayerId: "",
        assistPlayerIds: [],
      });
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

    function assignmentButton(playerId, team, currentTeamId = null, context = "assign") {
      const disabled = finishedRosterControlsLocked() ? " disabled" : "";
      const active = currentTeamId === team.teamId;
      const nickname = playerNickname(playerId);
      const label =
        context === "transfer"
          ? `Transfer ${nickname} to ${team.name}`
          : active
            ? `${nickname} assigned to ${team.name}`
            : `Assign ${nickname} to ${team.name}`;
      return `<button data-ui="team-chip" type="button" data-action="assign-player" data-player-id="${escapeHtml(
        playerId,
      )}" data-team-id="${escapeHtml(team.teamId)}" aria-label="${escapeHtml(label)}" aria-pressed="${
        active ? "true" : "false"
      }" data-state="${
        active ? "active" : "idle"
      }"${teamSwatchStyle(team)}${disabled}><span>${escapeHtml(team.name)}</span>${
        active ? renderClientIcon("circle-check") : ""
      }</button>`;
    }

    function assignmentButtons(playerId, currentTeamId = null) {
      return rosterTeams.map((team) => assignmentButton(playerId, team, currentTeamId)).join("");
    }

    function transferMenuId(playerId) {
      let safeSegment;
      try {
        safeSegment = encodeURIComponent(String(playerId));
      } catch {
        safeSegment = Array.from(String(playerId))
          .map((character) => character.codePointAt(0).toString(16))
          .join("-");
      }
      return `transfer-options-${safeSegment}`;
    }

    function focusTransferTrigger(playerId) {
      const trigger = [...root.querySelectorAll('button[data-action="toggle-transfer"]')].find(
        (candidate) => candidate.getAttribute("data-player-id") === playerId,
      );
      if (trigger instanceof HTMLButtonElement) {
        trigger.focus();
      }
    }

    function transferControl(playerId, currentTeamId) {
      const safePlayerId = escapeHtml(playerId);
      const menuId = transferMenuId(playerId);
      const open = openTransferPlayerId === playerId;
      const disabled = finishedRosterControlsLocked() ? " disabled" : "";
      const nickname = playerNickname(playerId);
      const alternatives = rosterTeams
        .filter((team) => team.teamId !== currentTeamId)
        .map((team) => assignmentButton(playerId, team, null, "transfer"))
        .join("");

      return `<div data-ui="transfer-control">
        <button data-ui="transfer-toggle" type="button" data-action="toggle-transfer" data-player-id="${safePlayerId}" aria-label="${escapeHtml(
          `Transfer ${nickname}`,
        )}" aria-expanded="${
          open ? "true" : "false"
        }" aria-controls="${menuId}"${disabled}>${renderClientIcon("arrow-left-right")}<span>Transfer</span></button>
        <div id="${menuId}" data-ui="transfer-menu"${open ? "" : " hidden"}>
          ${alternatives}
        </div>
      </div>`;
    }

    function playerAccessPanel(player) {
      if (currentLeagueRole !== "admin") {
        return "";
      }

      const access = player?.access;
      if (!access || typeof access.userId !== "string" || access.userId.length === 0) {
        return `<div data-ui="player-access" data-testid="player-access" data-state="unclaimed">
          <span data-ui="claim-badge" data-state="unclaimed" role="img" aria-label="Not claimed" title="Not claimed">${renderClientIcon(
            "circle-user-round",
          )}</span>
        </div>`;
      }

      const role = normalizeLeagueRole(access.role);
      const roleLabel =
        role === "admin" ? "Co-organiser" : role === "scorekeeper" ? "Scorer" : "Claimed";
      const scorerDisabled = role === "scorekeeper" || role === "admin" ? " disabled" : "";
      const adminDisabled = role === "admin" ? " disabled" : "";

      return `<div data-ui="player-access" data-testid="player-access" data-state="claimed">
        <span data-ui="claim-badge" data-state="claimed" role="img" aria-label="${escapeHtml(
          roleLabel,
        )}" title="${escapeHtml(roleLabel)}">${renderClientIcon("user-round-check")}</span>
        <div data-ui="access-actions">
          <button data-ui="row-action" type="button" data-action="grant-player-access" data-player-id="${escapeHtml(
            player.playerId,
          )}" data-role="scorekeeper"${scorerDisabled}>Make scorer</button>
          <button data-ui="row-action" type="button" data-action="grant-player-access" data-player-id="${escapeHtml(
            player.playerId,
          )}" data-role="admin"${adminDisabled}>Make co-organiser</button>
        </div>
      </div>`;
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
          return `<article data-ui="roster-player" data-player-id="${escapeHtml(player.playerId)}">
            <figure data-ui="avatar"><span>${escapeHtml(initialsForName(player.nickname))}</span></figure>
            <div data-ui="roster-player-main">
              <strong>${escapeHtml(player.nickname)}</strong>
              ${playerAccessPanel(player)}
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
                ${transferControl(assignment.playerId, team.teamId)}
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
      if (rosterLocked) {
        openTransferPlayerId = null;
      }
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

      rosterTeams = Array.isArray(rosterPayload?.teams)
        ? rosterPayload.teams.map((team) => ({
            ...team,
            name:
              typeof team.name === "string" && team.name.length > 0
                ? team.name
                : String(team.teamId ?? "Unknown team"),
          }))
        : [];
      rosterAssignments = Array.isArray(rosterPayload?.roster) ? rosterPayload.roster : [];
      rosterPlayers = Array.isArray(playersPayload?.players) ? playersPayload.players : [];
      if (scoreboardTeams.length === 0 || (goalTimeline.length === 0 && !isGameFinished())) {
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
        goalTimelineLoaded = false;
        const message = error instanceof Error ? error.message : "Could not load goal timeline.";
        showError(message);
        setStatus("Could not load goal timeline.", "error");
        renderLiveScoring();
        return false;
      }

      goalTimelineLoaded = true;
      if (Array.isArray(payload?.scoreboard?.teams)) {
        scoreboardTeams = normalizeScoreboardTeams(payload.scoreboard.teams);
        scoreboardState = "authoritative";
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
      finishedResultState = "authoritative";
      if (game.status === "finished" && Array.isArray(game.result?.teams)) {
        scoreboardTeams = normalizeScoreboardTeams(game.result.teams);
        scoreboardState = "authoritative";
      }
      currentLeagueId = game.leagueId;
      currentSeasonId = game.seasonId;

      if (title) {
        title.textContent = formatLocalDateHeading(game.gameStartTs);
      }

      if (subtitle) {
        subtitle.textContent = formatLocalKickoffTime(game.gameStartTs);
      }

      if (gameIdValue) {
        gameIdValue.textContent = game.gameId;
      }
      if (gameJoinCodeValue) {
        gameJoinCodeValue.textContent = typeof game.joinCode === "string" && game.joinCode.length > 0
          ? game.joinCode
          : "Unavailable";
      }
      if (gameJoinLink instanceof HTMLAnchorElement) {
        if (typeof game.joinCode === "string" && game.joinCode.length > 0) {
          const joinPath = `/join?code=${encodeURIComponent(game.joinCode)}`;
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
        gameSeasonLink.href = buildLeagueSeasonPath(game.leagueId, game.seasonId);
      }
      if (createAnotherLink instanceof HTMLAnchorElement) {
        createAnotherLink.href = `${buildLeagueSeasonPath(game.leagueId, game.seasonId)}#create-game`;
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

      if (rosterControlsAvailable()) {
        renderRosterSetup();
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
        navigateTo(buildLeagueSeasonPath(currentLeagueId, currentSeasonId));
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
          scoreboardState = "authoritative";
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
      if (mode === "final") {
        manualGameModeSelected = selectGameStateAction();
        return;
      }
      manualGameModeSelected = true;
      setGameMode(mode, { focusPanel: trigger.getAttribute("data-ui") !== "game-mode-tab" });
    });

    if (rosterControlsAvailable()) {
      root.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !openTransferPlayerId) {
          return;
        }

        const playerId = openTransferPlayerId;
        openTransferPlayerId = null;
        renderRosterTeams();
        focusTransferTrigger(playerId);
      });

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
        const eventTarget = event.target;
        const target = eventTarget instanceof Element ? eventTarget.closest("button[data-action]") : null;
        if (!(target instanceof HTMLButtonElement)) {
          return;
        }

        const action = target.getAttribute("data-action");
        if (action === "toggle-transfer") {
          if (finishedRosterControlsLocked()) {
            return;
          }

          const playerId = target.getAttribute("data-player-id");
          if (!playerId) {
            return;
          }

          const opening = openTransferPlayerId !== playerId;
          openTransferPlayerId = opening ? playerId : null;
          renderRosterTeams();
          if (opening) {
            const menu = document.getElementById(transferMenuId(playerId));
            const firstOption = menu?.querySelector('button[data-action="assign-player"]');
            if (firstOption instanceof HTMLButtonElement) {
              firstOption.focus();
            }
          } else {
            focusTransferTrigger(playerId);
          }
          return;
        }

        if (action === "grant-player-access") {
          if (currentLeagueRole !== "admin") {
            return;
          }

          const playerId = target.getAttribute("data-player-id");
          const userId = playerId ? playerById(playerId)?.access?.userId : null;
          const role = target.getAttribute("data-role");
          if (!currentLeagueId || !userId || (role !== "scorekeeper" && role !== "admin")) {
            return;
          }

          target.disabled = true;
          clearError();
          setStatus("Updating scorer access…", "default");

          try {
            await requestJsonOrThrow(`/v1/leagues/${encodeURIComponent(currentLeagueId)}/access`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                userId,
                role,
              }),
            });

            await loadRosterSetup({ updateStatus: false });
            setStatus(
              role === "admin"
                ? "Player can now co-organise and score."
                : "Player can now score this league's games.",
              "success",
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : "Could not update scorer access.";
            showError(message);
            setStatus("Scorer access update failed.", "error");
          } finally {
            target.disabled = false;
          }
          return;
        }

        if (action !== "assign-player") {
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
        const isTransferAssignment = target.closest('[data-ui="transfer-menu"]') !== null;
        clearError();
        setStatus("Assigning player…", "default");

        let committedAssignment;
        try {
          committedAssignment = await requestJsonOrThrow(
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
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not assign player.";
          showError(message);
          setStatus("Roster assignment failed.", "error");
          target.disabled = false;
          if (target.isConnected) {
            target.focus();
          }
          return;
        }

        if (isTransferAssignment) {
          openTransferPlayerId = null;
        }
        const existingAssignment = assignmentByPlayerId(playerId);
        rosterAssignments = [
          ...rosterAssignments.filter((assignment) => assignment.playerId !== playerId),
          {
            ...(existingAssignment ?? {}),
            ...(committedAssignment && typeof committedAssignment === "object" ? committedAssignment : {}),
            gameId,
            playerId,
            teamId,
          },
        ];
        renderRosterSetup();
        focusTransferTrigger(playerId);

        let refreshFailed = false;
        try {
          await loadRosterSetup({ updateStatus: false });
        } catch (error) {
          refreshFailed = true;
          const message = error instanceof Error ? error.message : "Could not refresh the roster.";
          showError(`Assignment was saved, but the latest roster could not be loaded. ${message}`);
          setStatus("Roster assignment saved; roster refresh failed.", "error");
        }

        focusTransferTrigger(playerId);

        if (!refreshFailed) {
          const player = playerById(playerId);
          const team = teamById(teamId);
          setStatus(
            `${player?.nickname ?? "Player"} assigned to ${team?.name ?? teamId}.`,
            "success",
          );
        }
        target.disabled = false;
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
        if (goalMutationInFlight || (isGameFinished() && !canCorrectFinishedGoals())) {
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

        const eventId = editingGoalId;
        const actionLabel = eventId ? "Saving goal edit" : "Adding goal";
        const previousScoreboardState = scoreboardState;
        const previousFinishedResultState = finishedResultState;
        setStatus(`${actionLabel}…`, "default");
        goalMutationInFlight = true;
        scoreboardState = "refreshing";
        if (isGameFinished()) {
          finishedResultState = "refreshing";
        }
        renderLiveScoring();

        try {
          const path = eventId
            ? `/v1/games/${encodeURIComponent(gameId)}/goals/${encodeURIComponent(eventId)}`
            : `/v1/games/${encodeURIComponent(gameId)}/goals`;
          let result;
          try {
            result = await requestJsonOrThrow(path, {
              method: eventId ? "PATCH" : "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": idempotencyKeyForGoalSave(eventId, draft.payload),
              },
              body: JSON.stringify(draft.payload),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Could not save goal.";
            showError(message);
            if (isDefinitiveRequestRejection(error)) {
              scoreboardState = previousScoreboardState;
              finishedResultState = previousFinishedResultState;
              if (eventId) {
                clearGoalMutationIdempotency("update-goal", `${gameId}-${eventId}`);
              } else {
                pendingCreateGoalIdempotency = null;
              }
              setStatus("Goal was not saved. Review the error and try again.", "error");
              return;
            }
            scoreboardState = "uncertain";
            if (isGameFinished()) {
              finishedResultState = "uncertain";
            }
            setStatus(
              "Could not confirm whether the goal was saved. Retry with the same details.",
              "error",
            );
            return;
          }

          const finishedCorrection = isGameFinished();
          if (finishedCorrection) {
            finishedResultState = "saved-unavailable";
          }
          applyGoalMutationResult(result);
          resetGoalForm();

          const goalsLoaded = await loadGameGoals();
          if (eventId) {
            clearGoalMutationIdempotency("update-goal", `${gameId}-${eventId}`);
          } else {
            pendingCreateGoalIdempotency = null;
          }

          const gameRefreshed = await refreshGameAfterFinishedCorrection();
          if (!goalsLoaded) {
            if (scoreboardState !== "authoritative") {
              scoreboardState = "unavailable";
            }
            const savedLabel = eventId ? "Goal update" : "Goal addition";
            const savedStatus = eventId ? "Goal updated" : "Goal added";
            if (!gameRefreshed) {
              showError(
                `${savedLabel} was saved, but neither the latest goal state nor the finished result could be refreshed. Reload to try again.`,
              );
              setStatus(`${savedStatus}; timeline and result refresh failed.`, "error");
            } else if (finishedCorrection) {
              showError("Goal details could not be loaded. Reload to try again.");
              setStatus(
                `${savedStatus}. Scores refreshed; goal timeline unavailable.`,
                "default",
              );
            } else {
              showError(`${savedLabel} was saved, but the latest scores and goal timeline could not be loaded.`);
              setStatus(`${savedStatus}; scores and timeline unavailable.`, "default");
            }
            return;
          }

          if (!gameRefreshed) {
            showError(
              eventId
                ? "Goal was updated, but the finished result could not be refreshed."
                : "Goal was added, but the finished result could not be refreshed.",
            );
            setStatus(
              eventId
                ? "Goal updated. Run scores refreshed; Match Summary unavailable."
                : "Goal added. Run scores refreshed; Match Summary unavailable.",
              "default",
            );
            return;
          }

          setStatus(eventId ? "Goal updated." : "Goal added.", "success");
        } finally {
          goalMutationInFlight = false;
          renderLiveScoring();
        }
      });

      cancelGoalEditButton.addEventListener("click", () => {
        if (goalMutationInFlight) {
          return;
        }
        resetGoalForm();
        setStatus("Goal edit cancelled.", "default");
      });

      undoLastGoalButton.addEventListener("click", async () => {
        if (goalMutationInFlight || (isGameFinished() && !canCorrectFinishedGoals())) {
          renderLiveScoring();
          return;
        }

        const latest = goalTimeline.at(-1);
        if (!latest) {
          return;
        }

        const previousScoreboardState = scoreboardState;
        const previousFinishedResultState = finishedResultState;
        goalMutationInFlight = true;
        scoreboardState = "refreshing";
        if (isGameFinished()) {
          finishedResultState = "refreshing";
        }
        clearError();
        setStatus("Undoing latest goal…", "default");
        renderLiveScoring();

        const stablePart = `${gameId}-${latest.eventId}`;
        try {
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

          if (isGameFinished()) {
            finishedResultState = "saved-unavailable";
          }
          applyGoalMutationResult(result, { deletedEventId: latest.eventId });
          resetGoalForm();
          const goalsLoaded = await loadGameGoals();
          clearGoalMutationIdempotency("undo-goal", stablePart);
          const gameRefreshed = await refreshGameAfterFinishedCorrection();
          if (!goalsLoaded) {
            if (scoreboardState !== "authoritative") {
              scoreboardState = "unavailable";
            }
            if (!gameRefreshed) {
              showError(
                "The latest goal was undone, but neither the latest goal state nor the finished result could be refreshed. Reload to try again.",
              );
              setStatus("Latest goal undone; timeline and result refresh failed.", "error");
            } else if (isGameFinished()) {
              showError("Goal details could not be loaded. Reload to try again.");
              setStatus(
                "Latest goal undone. Scores refreshed; goal timeline unavailable.",
                "default",
              );
            } else {
              showError("The latest goal was undone, but the latest scores and goal timeline could not be loaded.");
              setStatus("Latest goal undone; scores and timeline unavailable.", "default");
            }
            return;
          }
          if (!gameRefreshed) {
            showError("Latest goal was undone, but the finished result could not be refreshed.");
            setStatus(
              "Latest goal undone. Run scores refreshed; Match Summary unavailable.",
              "default",
            );
            return;
          }
          setStatus("Latest goal undone.", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not undo latest goal.";
          showError(message);
          if (isDefinitiveRequestRejection(error)) {
            scoreboardState = previousScoreboardState;
            finishedResultState = previousFinishedResultState;
            clearGoalMutationIdempotency("undo-goal", stablePart);
            setStatus("The latest goal was not undone. Review the error and try again.", "error");
            return;
          }
          scoreboardState = "uncertain";
          if (isGameFinished()) {
            finishedResultState = "uncertain";
          }
          setStatus("Could not confirm the undo. Retry the same action.", "error");
        } finally {
          goalMutationInFlight = false;
          renderLiveScoring();
        }
      });

      root.addEventListener("click", async (event) => {
        const eventTarget = event.target;
        const target = eventTarget instanceof Element ? eventTarget.closest("button[data-action]") : null;
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

        if (goalMutationInFlight || (isGameFinished() && !canCorrectFinishedGoals())) {
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

        const previousScoreboardState = scoreboardState;
        const previousFinishedResultState = finishedResultState;
        goalMutationInFlight = true;
        scoreboardState = "refreshing";
        if (isGameFinished()) {
          finishedResultState = "refreshing";
        }
        clearError();
        setStatus("Deleting goal…", "default");
        renderLiveScoring();

        const stablePart = `${gameId}-${eventId}`;
        try {
          const result = await requestJsonOrThrow(
            `/v1/games/${encodeURIComponent(gameId)}/goals/${encodeURIComponent(eventId)}`,
            {
              method: "DELETE",
              headers: {
                "Idempotency-Key": idempotencyKeyForGoalMutation("delete-goal", stablePart, eventId),
              },
            },
          );

          if (isGameFinished()) {
            finishedResultState = "saved-unavailable";
          }
          applyGoalMutationResult(result, { deletedEventId: eventId });
          resetGoalForm();
          const goalsLoaded = await loadGameGoals();
          clearGoalMutationIdempotency("delete-goal", stablePart);
          const gameRefreshed = await refreshGameAfterFinishedCorrection();
          if (!goalsLoaded) {
            if (scoreboardState !== "authoritative") {
              scoreboardState = "unavailable";
            }
            if (!gameRefreshed) {
              showError(
                "The goal was deleted, but neither the latest goal state nor the finished result could be refreshed. Reload to try again.",
              );
              setStatus("Goal deleted; timeline and result refresh failed.", "error");
            } else if (isGameFinished()) {
              showError("Goal details could not be loaded. Reload to try again.");
              setStatus("Goal deleted. Scores refreshed; goal timeline unavailable.", "default");
            } else {
              showError("The goal was deleted, but the latest scores and goal timeline could not be loaded.");
              setStatus("Goal deleted; scores and timeline unavailable.", "default");
            }
            return;
          }
          if (!gameRefreshed) {
            showError("Goal was deleted, but the finished result could not be refreshed.");
            setStatus("Goal deleted. Run scores refreshed; Match Summary unavailable.", "default");
            return;
          }
          setStatus("Goal deleted.", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not delete goal.";
          showError(message);
          if (isDefinitiveRequestRejection(error)) {
            scoreboardState = previousScoreboardState;
            finishedResultState = previousFinishedResultState;
            clearGoalMutationIdempotency("delete-goal", stablePart);
            setStatus("The goal was not deleted. Review the error and try again.", "error");
            return;
          }
          scoreboardState = "uncertain";
          if (isGameFinished()) {
            finishedResultState = "uncertain";
          }
          setStatus("Could not confirm the deletion. Retry the same action.", "error");
        } finally {
          goalMutationInFlight = false;
          renderLiveScoring();
        }
      });
    }

    syncGameModeState();
    await loadGame();
    await loadLeagueAccess();
    await loadRosterSetup({ updateStatus: false });
    const goalsLoaded = await loadGameGoals();
    if (!goalsLoaded && scoreboardState !== "authoritative") {
      scoreboardState = "unavailable";
      renderLiveScoring();
    }
    if (!manualGameModeSelected) {
      setGameMode(preferredInitialGameMode());
    }
    syncGameModeState();

    try {
      const seasonPath = currentLeagueId
        ? `/v1/leagues/${encodeURIComponent(currentLeagueId)}/seasons/${encodeURIComponent(currentSeasonId)}`
        : `/v1/seasons/${encodeURIComponent(currentSeasonId)}`;
      const season = await requestJsonOrThrow(seasonPath, { method: "GET" });
      const previousLeagueId = currentLeagueId;
      currentLeagueId = season.leagueId;
      if (gameLeagueLink instanceof HTMLAnchorElement) {
        gameLeagueLink.href = `/leagues/${encodeURIComponent(currentLeagueId)}`;
      }
      if (currentLeagueId !== previousLeagueId) {
        await loadLeagueAccess();
      }
    } catch {
      // Keep existing game context if season lookup fails.
    }

    if (goalsLoaded) {
      setStatus("");
    }
  }

  async function initJoinPage() {
    const searchParams = new URLSearchParams(window.location.search);
    const queryJoinCode = searchParams.get("code") ?? "";
    const routeJoinCode = queryJoinCode || resolveRouteEntityId("data-join-code", "join") || "";
    const joinCode = routeJoinCode.trim().toUpperCase();
    const joinCodeValue = document.getElementById("join-code-value");
    const form = document.getElementById("join-game-form");
    const nicknameInput = document.getElementById("join-player-nickname");
    const joinButton = root.querySelector('[data-action="join-game"]');
    const resultElement = document.getElementById("join-result");
    const resultPlayer = document.getElementById("join-result-player");
    const resultGame = document.getElementById("join-result-game");
    const claimActions = document.getElementById("join-claim-actions");
    const claimStatus = document.getElementById("join-claim-status");
    const signInLink = document.getElementById("join-signin-link");
    const claimButton = root.querySelector('[data-action="claim-player"]');
    const initialPlayerId = searchParams.get("playerId") ?? "";
    let claimPlayerId = initialPlayerId.trim();

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

    function signInHrefForClaim(playerId) {
      const returnParams = new URLSearchParams(window.location.search);
      returnParams.set("playerId", playerId);
      if (!returnParams.has("code") && window.location.pathname === "/join" && joinCode) {
        returnParams.set("code", joinCode);
      }
      const returnTo = `${window.location.pathname}?${returnParams.toString()}`;
      return `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
    }

    function showClaimActions() {
      if (claimActions instanceof HTMLElement) {
        claimActions.hidden = false;
      }
    }

    async function claimJoinedPlayer(playerId) {
      if (!playerId) {
        return;
      }

      showClaimActions();
      if (claimStatus instanceof HTMLElement) {
        claimStatus.textContent = "Claiming player for this account…";
      }
      if (claimButton instanceof HTMLButtonElement) {
        claimButton.disabled = true;
        claimButton.hidden = false;
      }
      if (signInLink instanceof HTMLAnchorElement) {
        signInLink.hidden = true;
      }

      const result = await requestJsonOrThrow(`/v1/players/${encodeURIComponent(playerId)}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (resultPlayer) {
        resultPlayer.textContent = result?.player?.nickname ?? resultPlayer.textContent;
      }
      if (resultElement) {
        resultElement.hidden = false;
      }
      if (claimStatus instanceof HTMLElement) {
        claimStatus.textContent = "Player claimed. The organiser can now make this account a scorer.";
      }
      setStatus("Player claimed.", "success");
    }

    async function refreshClaimActions(playerId, options = {}) {
      if (!playerId) {
        return;
      }

      showClaimActions();
      const session = await currentAuthenticatedSession();
      if (session) {
        if (signInLink instanceof HTMLAnchorElement) {
          signInLink.hidden = true;
        }
        if (claimButton instanceof HTMLButtonElement) {
          claimButton.hidden = false;
          claimButton.disabled = false;
        }
        if (claimStatus instanceof HTMLElement) {
          claimStatus.textContent = `Signed in as ${session.email}. Claim this player for scorer access.`;
        }
        if (options.autoClaim === true) {
          await claimJoinedPlayer(playerId);
        }
        return;
      }

      if (claimStatus instanceof HTMLElement) {
        claimStatus.textContent = "Sign in to claim this player so the organiser can make you a scorer.";
      }
      if (signInLink instanceof HTMLAnchorElement) {
        signInLink.hidden = false;
        signInLink.href = signInHrefForClaim(playerId);
      }
      if (claimButton instanceof HTMLButtonElement) {
        claimButton.hidden = true;
        claimButton.disabled = true;
      }
    }

    if (claimPlayerId) {
      void refreshClaimActions(claimPlayerId).catch((error) => {
        const message = error instanceof Error ? error.message : "Could not claim player.";
        showError(message);
        setStatus("Player claim failed.", "error");
        if (claimButton instanceof HTMLButtonElement) {
          claimButton.disabled = false;
          claimButton.hidden = false;
        }
      });
    }

    if (claimButton instanceof HTMLButtonElement) {
      claimButton.addEventListener("click", async () => {
        clearError();
        try {
          await claimJoinedPlayer(claimPlayerId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not claim player.";
          showError(message);
          setStatus("Player claim failed.", "error");
          claimButton.disabled = false;
        }
      });
    }

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
        claimPlayerId = result?.player?.playerId ?? "";
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
        return;
      }

      try {
        await refreshClaimActions(claimPlayerId, { autoClaim: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not claim player.";
        showError(message);
        setStatus("Joined game. Player claim failed.", "error");
        if (claimButton instanceof HTMLButtonElement) {
          claimButton.disabled = false;
          claimButton.hidden = false;
        }
      }
    });

    setStatus("Join page ready.", "success");
  }

  async function initInvitePage() {
    const queryInviteCode = new URLSearchParams(window.location.search).get("code") ?? "";
    const initialInviteCode =
      resolveRouteEntityId("data-invite-code", "invites") || queryInviteCode;
    const codeForm = document.getElementById("organiser-invite-code-form");
    const codeInput = document.getElementById("organiser-invite-code-input");
    const acceptance = document.getElementById("organiser-invite-acceptance");
    const acceptCode = document.getElementById("organiser-invite-accept-code");
    const acceptLeague = document.getElementById("organiser-invite-league");
    const acceptButton = document.querySelector('[data-action="accept-organiser-invite"]');
    const leagueLink = document.getElementById("organiser-invite-league-link");

    function normalizeInviteCode(value) {
      return value.trim().toUpperCase().replace(/\s+/g, "");
    }

    function isInviteCodeValid(value) {
      return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(value);
    }

    function showInviteAcceptance(inviteCode) {
      if (codeForm instanceof HTMLFormElement) {
        codeForm.hidden = true;
      }
      if (acceptance instanceof HTMLElement) {
        acceptance.hidden = false;
      }
      if (acceptCode instanceof HTMLElement) {
        acceptCode.textContent = inviteCode;
      }
    }

    async function acceptInvite(inviteCode) {
      if (!isInviteCodeValid(inviteCode)) {
        setFieldMessage("organiser-invite-code-input", "invalid", "Invite code must be 8 characters.");
        if (codeInput instanceof HTMLInputElement) {
          codeInput.focus();
        }
        return;
      }

      showInviteAcceptance(inviteCode);
      if (acceptButton instanceof HTMLButtonElement) {
        acceptButton.disabled = true;
      }
      clearError();
      setStatus("Accepting organiser invite…", "default");

      try {
        const payload = await requestJsonOrThrow(
          `/v1/invites/${encodeURIComponent(inviteCode)}/accept`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          },
        );
        const leagueId = payload.invite?.leagueId ?? payload.access?.leagueId ?? "";
        if (acceptLeague instanceof HTMLElement) {
          acceptLeague.textContent = leagueId || "Accepted";
        }
        if (leagueLink instanceof HTMLAnchorElement && leagueId) {
          leagueLink.href = `/leagues/${encodeURIComponent(leagueId)}`;
          leagueLink.hidden = false;
        }
        setStatus("Organiser invite accepted.", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not accept organiser invite.";
        showError(message);
        setStatus("Organiser invite failed.", "error");
        if (acceptButton instanceof HTMLButtonElement) {
          acceptButton.disabled = false;
        }
      }
    }

    if (codeForm instanceof HTMLFormElement) {
      codeForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!(codeInput instanceof HTMLInputElement)) {
          return;
        }

        const inviteCode = normalizeInviteCode(codeInput.value);
        if (!isInviteCodeValid(inviteCode)) {
          setFieldMessage("organiser-invite-code-input", "invalid", "Invite code must be 8 characters.");
          codeInput.focus();
          return;
        }

        navigateTo(`/invites?code=${encodeURIComponent(inviteCode)}`);
      });
    }

    if (codeInput instanceof HTMLInputElement) {
      codeInput.addEventListener("input", () => {
        setFieldMessage("organiser-invite-code-input");
      });
    }

    if (acceptButton instanceof HTMLButtonElement) {
      acceptButton.addEventListener("click", () => {
        const inviteCode = normalizeInviteCode(
          acceptCode instanceof HTMLElement ? acceptCode.textContent ?? "" : initialInviteCode ?? "",
        );
        void acceptInvite(inviteCode);
      });
    }

    if (initialInviteCode) {
      const normalizedInitialInviteCode = normalizeInviteCode(initialInviteCode);
      if (isInviteCodeValid(normalizedInitialInviteCode)) {
        showInviteAcceptance(normalizedInitialInviteCode);
      } else {
        setFieldMessage("organiser-invite-code-input", "invalid", "Invite code must be 8 characters.");
        if (codeInput instanceof HTMLInputElement) {
          codeInput.value = normalizedInitialInviteCode;
          codeInput.focus();
        }
      }
      setStatus("Invite page ready.", "success");
      return;
    }

    setStatus("Invite page ready.", "success");
  }

  async function initialize() {
    mountSeasonShellForNestedLeagueRoute();
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

    let authenticatedSession = null;
    try {
      authenticatedSession = await ensureAuthenticatedSession();
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
        await initDashboardPage(authenticatedSession);
        return;
      }

      if (page === "league") {
        await initLeaguePage();
        return;
      }

      if (page === "invite") {
        await initInvitePage();
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
