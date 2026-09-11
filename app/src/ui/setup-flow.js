(() => {
  let root = document.getElementById("setup-flow-root");
  let apiBaseUrl = "";
  let page = "dashboard";
  let statusElement = null;
  let errorElement = null;
  let errorDetail = "";
  let errorIncludesOutcome = false;
  let statusRevision = 0;
  let beforeGameWrite = null;

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
    errorDetail = errorElement?.textContent ?? "";
    errorIncludesOutcome = false;
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

  function usableEntityId(value) {
    // Record identity is an opaque nonempty string. URL constructability and
    // the stricter authentication return-target policy are separate concerns.
    return typeof value === "string" && value.trim().length > 0;
  }

  function encodedRecordPath(prefix, id, suffix = "") {
    try {
      const encodedId = encodeURIComponent(id);
      const path = prefix + encodedId + suffix;
      const target = new URL(path, window.location.origin);
      return target.origin === window.location.origin && target.pathname === path &&
        !target.search && !target.hash && decodeURIComponent(encodedId) === id ? path : null;
    } catch {
      // Dot segments normalize away; malformed Unicode cannot be represented
      // losslessly. Neither means an already-confirmed write was rejected.
      return null;
    }
  }

  function navigateTo(url, mode = "assign") {
    if (window.ThreeFcPlayerProof?.isBlocked?.()) return;
    closeActionMenu();
    if (typeof window.__THREEFC_NAVIGATE__ === "function") {
      window.__THREEFC_NAVIGATE__(url, mode);
      return;
    }

    if (mode === "replace") {
      window.location.replace(url);
      return;
    }

    if (mode === "reload") {
      window.location.reload();
      return;
    }

    window.location.assign(url);
  }

  let signOutPending = false;
  let signOutUnconfirmed = false;
  let hasAuthenticatedAccount = false;
  let accountRevalidating = false;
  let entryClaimPlayerId = null;
  let leagueDeletionRecovery = null;

  function normalizedEntryCode(value) {
    return typeof value === "string" ? value.trim().toUpperCase().replace(/\s+/g, "") : "";
  }

  function validEntryCode(value) {
    return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(value);
  }

  function entryReturnTarget(playerId = entryClaimPlayerId) {
    if (page !== "join" && page !== "invite") return null;
    const query = new URLSearchParams(window.location.search);
    const code = normalizedEntryCode(page === "join"
      ? query.get("code") || resolveRouteEntityId("data-join-code", "join")
      : resolveRouteEntityId("data-invite-code", "invites") || query.get("code"));
    const params = new URLSearchParams();
    if (validEntryCode(code)) params.set("code", code);
    if (page === "join" && usableEntityId(playerId)) {
      params.set("playerId", playerId);
      if (params.get("playerId") !== playerId) return null;
    }
    const target = `${page === "join" ? "/join" : "/invites"}${params.size ? `?${params}` : ""}`;
    try {
      return typeof window.__THREEFC_NORMALIZE_RETURN_TO__ === "function" ? window.__THREEFC_NORMALIZE_RETURN_TO__(target) : null;
    } catch {
      return null;
    }
  }

  function entrySignInHref(playerId = entryClaimPlayerId) {
    const target = entryReturnTarget(playerId);
    return target ? `/sign-in?returnTo=${encodeURIComponent(target)}` : "/sign-in";
  }

  function setAccountSession(session) {
    const actions = document.getElementById("account-actions");
    const button = document.getElementById("sign-out");
    const authenticated = typeof session?.email === "string" && session.email.trim().length > 0;
    if (!authenticated) closeActionMenu();
    hasAuthenticatedAccount = authenticated;
    if (actions instanceof HTMLElement) {
      // Once requested, sign-out owns its pending/recovery surface. A later
      // join-session probe can legitimately return 401 after revocation and
      // must not hide the only confirmation/retry control.
      actions.hidden = !authenticated && !signOutPending && !signOutUnconfirmed;
    }
    if (button instanceof HTMLButtonElement) {
      button.disabled = signOutPending || (!authenticated && !signOutUnconfirmed);
    }
  }

  function initializeSignOut() {
    const button = document.getElementById("sign-out");
    const feedback = document.getElementById("sign-out-status");
    if (!(button instanceof HTMLButtonElement) || !(feedback instanceof HTMLElement)) {
      return;
    }

    window.addEventListener("pageshow", (event) => {
      if (!event.persisted || accountRevalidating || (page === "join" && !hasAuthenticatedAccount)) {
        return;
      }
      accountRevalidating = true;
      // A restored page can belong to a session revoked in another tab, or to
      // the previous account. Hide its stale data before a fresh load performs
      // the normal server session check. Ordinary page loads are untouched.
      const shell = document.querySelector('[data-ui="app-shell"]');
      if (shell instanceof HTMLElement) {
        shell.hidden = true;
      }
      const progress = document.createElement("div");
      progress.setAttribute("data-ui", "activity-status");
      progress.setAttribute("data-activity", "loading");
      progress.setAttribute("role", "status");
      progress.setAttribute("aria-live", "polite");
      progress.id = "account-revalidation-status";
      progress.innerHTML = `${renderClientIcon("loader-circle")}<span class="sr-only">Checking sign-in state…</span>`;
      document.body.append(progress);
      navigateTo(`${window.location.pathname}${window.location.search}${window.location.hash}`, "reload");
    });

    button.addEventListener("click", async () => {
      if (signOutPending || button.disabled) {
        return;
      }
      // Latch before awaiting: repeated activation must not start parallel
      // revocations. Keep this feedback separate from page-data refreshes.
      const restoreFocusOnFailure = document.activeElement === button;
      closeActionMenu();
      signOutPending = true;
      if (window.ThreeFcPlayerProof?.clear() === false) { signOutPending = false; return; }
      signOutUnconfirmed = false;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      feedback.hidden = false;
      feedback.removeAttribute("data-state");
      feedback.textContent = "Signing out…";

      try {
        const result = await requestJson("/v1/auth/logout", { method: "POST" });
        if (result.status !== 204) {
          throw new Error("sign_out_unconfirmed");
        }
        // Only remove auth navigation/recovery state after confirmed server
        // revocation. Never discard another workflow's drafts or retry keys.
        try {
          window.localStorage.removeItem("threefc.auth.return_to");
        } catch {
          // Storage access is optional; the server session is already revoked.
        }
        try {
          window.sessionStorage.removeItem("threefc.auth.callback");
        } catch {
          // A blocked storage API must not prevent leaving the signed-out page.
        }
        navigateTo(entrySignInHref(), "replace");
      } catch {
        // A lost response may mean revocation committed. Do not promise that
        // the session is still active, and never display raw transport errors.
        signOutUnconfirmed = true;
        signOutPending = false;
        button.disabled = false;
        button.removeAttribute("aria-busy");
        feedback.setAttribute("data-state", "error");
        feedback.textContent = "Sign out could not be confirmed. Please try again.";
        if (restoreFocusOnFailure && (document.activeElement === document.body || document.activeElement === button)) {
          button.focus();
        }
      }
    });
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
    ++statusRevision;
    if (!statusElement) {
      return;
    }

    let messageElement = statusElement.querySelector('[data-ui="activity-message"]');
    if (!(messageElement instanceof HTMLElement)) {
      const initialMessage = statusElement.textContent?.trim() ?? "";
      statusElement.textContent = "";
      statusElement.insertAdjacentHTML("afterbegin", renderClientIcon("loader-circle"));
      messageElement = document.createElement("span");
      messageElement.setAttribute("data-ui", "activity-message");
      messageElement.classList.add("sr-only");
      messageElement.textContent = initialMessage;
      statusElement.append(messageElement);
      statusElement.setAttribute("data-ui", "activity-status");
    }

    const isLoading = state === "default" && /(?:…|\.{3})$/.test(text.trim());
    messageElement.textContent = text;
    messageElement.classList.toggle("sr-only", isLoading);
    statusElement.setAttribute("data-activity", isLoading ? "loading" : "message");
    if (state === "default") {
      statusElement.removeAttribute("data-state");
    } else {
      statusElement.setAttribute("data-state", state);
    }
    syncFeedback();
    return statusRevision;
  }

  // Keep operation outcomes and recovery together in one visible live region.
  // In particular, do not hide an uncertain-write instruction behind a generic
  // network error, or announce the same failure from both global surfaces.
  function syncFeedback() {
    const message = statusElement?.querySelector('[data-ui="activity-message"]')?.textContent?.trim() ?? "";
    const loading = statusElement?.getAttribute("data-activity") === "loading";
    if (errorElement && !errorElement.hidden && errorDetail) {
      errorElement.textContent = message && !loading && !errorIncludesOutcome && !errorDetail.includes(message)
        ? `${message} ${errorDetail}`
        : errorDetail;
      if (statusElement) {
        statusElement.hidden = true;
      }
      return;
    }
    if (statusElement) {
      statusElement.hidden = !message;
    }
  }

  function showError(message, { includesOutcome = false } = {}) {
    if (!errorElement) {
      return;
    }

    errorDetail = message;
    errorIncludesOutcome = includesOutcome;
    errorElement.hidden = false;
    syncFeedback();
  }

  function clearError() {
    if (!errorElement) {
      return;
    }

    errorElement.hidden = true;
    errorElement.textContent = "";
    errorDetail = "";
    errorIncludesOutcome = false;
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
    return `<div data-ui="field" data-validated="true">
      <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
      <input id="${escapeHtml(id)}" name="${escapeHtml(id)}" data-ui="input" data-state="default" data-testid="${escapeHtml(id)}" aria-describedby="${escapeHtml(id)}-notice" type="${escapeHtml(type)}"${required ? " required" : ""} />
      <div data-ui="field-message"><p data-ui="field-hint" id="${escapeHtml(id)}-notice" data-default-kind="empty" data-default-message=""></p></div>
    </div>`;
  }

  function renderClientPanel(title, description, body, footer, testId) {
    const descriptionHtml = description ? `<p>${escapeHtml(description)}</p>` : "";
    return `<article data-ui="panel" data-testid="${escapeHtml(testId)}">
      <div data-ui="panel-heading">
        <h2>${escapeHtml(title)}</h2>
        ${descriptionHtml}
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

  function renderClientIconButton({ icon, label, text = "", variant = "secondary", attributes = {} }) {
    const renderedAttributes = Object.entries({
      ...attributes,
      type: "button",
      "aria-label": label,
      title: label,
    })
      .map(([name, value]) => `${name}="${escapeHtml(String(value))}"`)
      .join(" ");
    return `<button data-ui="${text ? "button" : "icon-button"}" data-variant="${escapeHtml(variant)}" ${renderedAttributes}>${renderClientIcon(icon)}${text ? `<span>${escapeHtml(text)}</span>` : ""}</button>`;
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
    if (trigger.hasAttribute("data-hide-when-expanded")) trigger.hidden = open || trigger.disabled;
    if (open && options.focus !== false) {
      const focusTarget = panel.querySelector("input, select, button, [tabindex]");
      if (focusTarget instanceof HTMLElement) {
        focusTarget.focus();
      }
      return;
    }
    if (!open && options.restoreFocus !== false && focusWasInside) {
      // A disclosure action may live inside an already-dismissed kebab menu.
      const returnTarget = trigger.closest('[data-ui="action-menu"]')?.querySelector('[data-action="toggle-action-menu"]') ?? trigger;
      if (returnTarget instanceof HTMLElement && actionElementVisible(returnTarget) && !returnTarget.disabled) returnTarget.focus();
    }
  }

  function closeOtherDisclosures(activeTrigger) {
    closeActionMenu();
    const activePanel = document.getElementById(activeTrigger.getAttribute("aria-controls"));
    for (const trigger of document.querySelectorAll('button[aria-controls][aria-expanded="true"]')) {
      // Reopening a parent must preserve the selected nested journey and draft.
      if (!(trigger instanceof HTMLButtonElement) || trigger === activeTrigger || activePanel?.contains(trigger)) {
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
      if (trigger.disabled) {
        return;
      }
      const open = trigger.getAttribute("aria-expanded") !== "true";
      if (open) {
        closeOtherDisclosures(trigger);
      }
      setDisclosureState(trigger, panel, open);
      if (open && typeof options.onOpen === "function") {
        options.onOpen();
      }
    });
    panel.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-action="cancel-disclosure"]') : null;
      if (target && panel.contains(target)) {
        setDisclosureState(trigger, panel, false);
      }
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        event.preventDefault();
        setDisclosureState(trigger, panel, false);
      }
    });
  }

  function setManagementAccess(canManage) {
    if (!canManage) closeActionMenu();
    for (const element of document.querySelectorAll("[data-management-only]")) {
      if (!(element instanceof HTMLElement)) continue;
      element.hidden = !canManage;
      if (element instanceof HTMLButtonElement) element.disabled = !canManage;
    }
  }

  function attachFormSubmit(formId, button, submit) {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!button.disabled) void submit();
    });
  }

  function freezeCreationRequest(path, payload, prefix, stablePart) {
    return Object.freeze({
      path,
      init: Object.freeze({
        method: "POST",
        headers: Object.freeze({
          "Content-Type": "application/json",
          "Idempotency-Key": createIdempotencyKey(prefix, stablePart),
        }),
        body: JSON.stringify(payload),
      }),
    });
  }

  async function deleteManagementEntity(path) {
    const result = await requestJson(path, { method: "DELETE" });
    if (result.status === 204) return;
    const error = new Error(result.body?.message || "Deletion could not be confirmed.");
    if (!result.ok) error.statusCode = result.status;
    throw error;
  }

  function initializeLeagueDeletionRecovery(session) {
    if (!["dashboard", "league"].includes(page) || !usableEntityId(session?.email)) return null;
    const owner = session.subject ?? session.email;
    if (!usableEntityId(owner)) return null;
    const key = `threefc.league-deletion.v1:${encodeURIComponent(owner)}`;
    let attempt = null, pending = false, invalidated = false;
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) || "null");
      if (stored?.owner === owner && usableEntityId(stored.leagueId) && typeof stored.uncertain === "boolean") attempt = stored;
    } catch { /* A new request must persist successfully before dispatch. */ }
    const panel = document.createElement("section"); panel.dataset.ui = "panel"; panel.id = "league-deletion-recovery";
    const heading = document.createElement("h2"); heading.textContent = "League deletion";
    const status = document.createElement("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const retry = document.createElement("button"); retry.type = "button"; retry.dataset.ui = "button"; retry.textContent = "Retry league deletion";
    panel.append(heading, status, retry); root.prepend(panel);
    function render(message = "League deletion is not yet confirmed. Retry to finish checking it.") {
      panel.hidden = !attempt || invalidated; retry.disabled = pending || invalidated;
      retry.hidden = false;
      status.textContent = message;
    }
    function persist(value) { sessionStorage.setItem(key, JSON.stringify(value)); }
    function invalidate() { invalidated = true; render(); }
    window.addEventListener("threefc:player-proof-cleared", invalidate);
    window.addEventListener("threefc:player-proof-invalidated", invalidate);
    window.addEventListener("pagehide", invalidate);
    async function run() {
      if (!attempt || pending || invalidated || signOutPending || signOutUnconfirmed) return false;
      const ownsFocus = document.activeElement === retry;
      let focusOwned = ownsFocus;
      const moved = event => { if (event.target !== retry && event.target !== document.body) focusOwned = false; };
      document.addEventListener("focusin", moved); document.addEventListener("pointerdown", moved);
      pending = true; render("Checking league deletion…");
      const wasUncertain = attempt.uncertain;
      let dispatched = false;
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const account = await requestJson("/v1/auth/session", { method: "GET", cache: "no-store", signal: controller.signal });
        if (!account.ok || account.body?.authenticated !== true || (account.body?.session?.subject ?? account.body?.session?.email) !== owner ||
            account.body?.session?.sessionId !== session.sessionId) {
          invalidate(); showError("Your sign-in changed. Reload before retrying league deletion.", { includesOutcome: true }); return false;
        }
        if (invalidated || signOutPending) return false;
        const path = encodedRecordPath("/v1/leagues/", attempt.leagueId, "");
        if (!path) throw new Error("unaddressable_league");
        // A reload after dispatch must treat the result as uncertain, even when
        // the first response was lost after the server removed the league ACL.
        attempt.uncertain = true; persist(attempt); dispatched = true;
        const response = await requestJson(path, { method: "DELETE", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedAccountId: owner }) });
        if (invalidated) return false;
        if (response.status === 204) {
          sessionStorage.removeItem(key); attempt = null;
          panel.hidden = false; status.textContent = "League deleted."; retry.hidden = true;
          if (focusOwned) { status.tabIndex = -1; status.focus(); }
          return true;
        }
        if (!wasUncertain && [400, 401, 403, 404, 409, 422].includes(response.status)) {
          sessionStorage.removeItem(key); attempt = null; panel.hidden = true;
          showError("League could not be deleted. Check that it has no seasons and try again.", { includesOutcome: true });
        } else render("League deletion is not yet confirmed. Retry to finish checking it.");
        return false;
      } catch {
        if (!invalidated) render(dispatched ? "League deletion is not yet confirmed. Retry to finish checking it."
          : "Could not check or save deletion recovery. Allow site storage and try again.");
        return false;
      } finally {
        clearTimeout(timeout); pending = false; retry.disabled = invalidated;
        document.removeEventListener("focusin", moved); document.removeEventListener("pointerdown", moved);
      }
    }
    retry.addEventListener("click", () => { void run(); });
    render();
    return { async start(leagueId) {
      if (pending || invalidated) return false;
      if (attempt && attempt.leagueId !== leagueId) { render("Finish the earlier league deletion before starting another one."); retry.focus(); return false; }
      if (!attempt) {
        const next = { owner, leagueId, uncertain: false };
        try { persist(next); attempt = next; } catch { showError("Your browser could not save deletion recovery. Allow site storage before deleting this league.", { includesOutcome: true }); return false; }
      }
      return run();
    } };
  }

  function trackDeletedRowFocus(button) {
    const body = button.closest("tbody");
    const row = button.closest("tr");
    const menuTrigger = button.closest('[data-ui="action-menu"]')?.querySelector('[data-action="toggle-action-menu"]');
    const rowHref = row?.querySelector("a[href]")?.getAttribute("href");
    // Selecting an action closes its surface before the entity handler runs.
    // Its trigger owns that same interaction through confirmation and refresh.
    const ownsTarget = (target) => button.contains(target) || target === menuTrigger || (
      target instanceof HTMLElement && target.getAttribute("data-action") === "toggle-action-menu" && rowHref &&
      target.closest("tr")?.querySelector("a[href]")?.getAttribute("href") === rowHref
    );
    const ownedFocus = ownsTarget(document.activeElement);
    if (!ownedFocus || !(body instanceof HTMLElement) || !(row instanceof HTMLElement)) return () => {};
    const rows = Array.from(body.querySelectorAll("tr"));
    const index = rows.indexOf(row);
    const adjacentHrefs = [...rows.slice(index + 1), ...rows.slice(0, index).reverse()]
      .map((candidate) => candidate.querySelector("a[href]")?.getAttribute("href"))
      .filter(Boolean);
    const heading = body.closest('[data-ui="panel"]')?.querySelector("h2");
    let userMoved = false;
    const onFocus = (event) => {
      if (event.target !== document.body && event.target instanceof Element && !ownsTarget(event.target)) userMoved = true;
    };
    const onPointer = (event) => {
      if (event.target instanceof Element && !ownsTarget(event.target)) userMoved = true;
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("pointerdown", onPointer, true);
    return (committed) => {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("pointerdown", onPointer, true);
      if (!committed || userMoved) return;
      const links = Array.from(body.querySelectorAll("a[href]"));
      const nextLink = adjacentHrefs.map((href) => links.find((link) => link.getAttribute("href") === href)).find(Boolean)
        ?? links[Math.min(index, links.length - 1)];
      if (nextLink instanceof HTMLElement) {
        nextLink.focus();
      } else if (heading instanceof HTMLElement) {
        heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    };
  }

  function replaceManagementRows(body, html) {
    // Capture immediately before the synchronous redraw, not when the request
    // starts: someone may have moved into a surviving row while it was pending.
    const focused = document.activeElement;
    const oldRow = focused instanceof HTMLElement && body.contains(focused) ? focused.closest("tr") : null;
    const rowHref = oldRow?.querySelector("a[href]")?.getAttribute("href");
    const controlKind = focused instanceof HTMLAnchorElement ? "link"
      : focused instanceof HTMLButtonElement ? "button"
        : focused instanceof HTMLElement && focused.getAttribute("data-ui") === "action-menu-surface" ? "surface" : null;
    const action = focused instanceof HTMLElement ? focused.getAttribute("data-action") : null;
    const focusedHref = focused instanceof HTMLAnchorElement ? focused.getAttribute("href") : null;
    const menuWasOpen = oldRow?.querySelector('[data-action="toggle-action-menu"]')?.getAttribute("aria-expanded") === "true";
    if (openActionMenu && body.contains(openActionMenu.menu)) closeActionMenu();
    body.innerHTML = html;
    if (!rowHref || !controlKind) return;
    const row = Array.from(body.querySelectorAll("tr"))
      .find((candidate) => candidate.querySelector("a[href]")?.getAttribute("href") === rowHref);
    if (!(row instanceof HTMLElement)) return;
    const menu = row.querySelector('[data-ui="action-menu"]');
    if (menuWasOpen) openActions(menu, { focus: false });
    const replacement = controlKind === "link"
      ? Array.from(row.querySelectorAll("a[href]")).find((link) => link.getAttribute("href") === focusedHref)
      : controlKind === "surface" ? menu?.querySelector('[data-ui="action-menu-surface"]')
        : Array.from(row.querySelectorAll("button[data-action]")).find((button) => button.getAttribute("data-action") === action);
    if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
  }

  function renderClientActionMenu(id, label, content, attributes = {}) {
    const wrapperAttributes = Object.entries(attributes)
      .map(([name, value]) => `${name}="${escapeHtml(String(value))}"`).join(" ");
    return `<div data-ui="action-menu" ${wrapperAttributes}>${renderClientIconButton({
      icon: "ellipsis-vertical", label: `Actions for ${label}`, variant: "ghost",
      attributes: { "data-action": "toggle-action-menu", "aria-expanded": "false", "aria-controls": id },
    })}<div data-ui="action-menu-surface" id="${escapeHtml(id)}" role="group" aria-label="${escapeHtml(`Actions for ${label}`)}" tabindex="-1" popover="manual" hidden>${content}</div></div>`;
  }

  function renderManagementDelete(label, attributes, disabled = false, pending = false) {
    const reasonId = `delete-lock-${encodeURIComponent(attributes["data-game-id"] ?? label)}`;
    const id = `row-actions-${encodeURIComponent(attributes["data-game-id"] ?? attributes["data-season-id"] ?? label)}`;
    return renderClientActionMenu(id, label, `${renderClientIconButton({
      icon: "trash-2", label: disabled ? `Delete unavailable: ${label} is finished` : `Delete ${label}`, text: "Delete",
      variant: "danger", attributes: { ...attributes, ...(disabled || pending ? { disabled: "" } : {}), ...(disabled ? { "aria-describedby": reasonId } : {}) },
    })}${disabled ? `<p data-ui="action-reason" id="${escapeHtml(reasonId)}">Finished games can’t be deleted.</p>` : ""}`);
  }

  let openActionMenu = null;

  function actionMenuParts(menu) {
    if (!(menu instanceof HTMLElement)) return null;
    const trigger = menu.querySelector('[data-action="toggle-action-menu"]');
    const surface = trigger ? document.getElementById(trigger.getAttribute("aria-controls")) : null;
    return trigger instanceof HTMLButtonElement && surface instanceof HTMLElement && surface.closest('[data-ui="action-menu"]') === menu
      ? { menu, trigger, surface } : null;
  }

  function actionElementVisible(element) {
    for (let current = element; current instanceof HTMLElement; current = current.parentElement) {
      if (current.hidden || current.hasAttribute("inert")) return false;
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return element.isConnected;
  }

  function closeActionMenu({ restoreFocus = false } = {}) {
    if (!openActionMenu) return;
    const { trigger, surface } = openActionMenu;
    openActionMenu = null;
    trigger.setAttribute("aria-expanded", "false");
    if (typeof surface.hidePopover === "function") {
      try { surface.hidePopover(); } catch { /* A fallback or detached surface is already closed. */ }
    }
    surface.hidden = true;
    if (restoreFocus && !trigger.disabled && actionElementVisible(trigger)) trigger.focus({ preventScroll: true });
  }

  function positionActionMenu(event) {
    if (!openActionMenu) return;
    const { trigger, surface } = openActionMenu;
    if (event?.type === "scroll" && event.target instanceof Element && surface.contains(event.target)) return;
    if (!actionElementVisible(trigger) || trigger.disabled) { closeActionMenu(); return; }
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft ?? 0;
    const topEdge = viewport?.offsetTop ?? 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const gutter = 8;
    const rect = trigger.getBoundingClientRect();
    if (rect.bottom < topEdge || rect.top > topEdge + height || rect.right < leftEdge || rect.left > leftEdge + width) {
      closeActionMenu();
      return;
    }
    // Client rects include CSS zoom; fixed offsets/sizes are pre-zoom CSS units.
    // Page zoom already changes viewport units and needs no extra conversion.
    let cssZoom = 1;
    for (let element = surface; element instanceof HTMLElement; element = element.parentElement) {
      const value = window.getComputedStyle(element).zoom;
      const factor = Number.parseFloat(value);
      if (Number.isFinite(factor) && factor > 0) cssZoom *= value.endsWith("%") ? factor / 100 : factor;
    }
    surface.style.maxWidth = `${Math.max(0, width - gutter * 2) / cssZoom}px`;
    surface.style.maxHeight = `${Math.max(0, height - gutter * 2) / cssZoom}px`;
    const box = surface.getBoundingClientRect();
    const surfaceWidth = Math.min(box.width, Math.max(0, width - gutter * 2));
    const surfaceHeight = Math.min(box.height, Math.max(0, height - gutter * 2));
    const bottomEdge = topEdge + height;
    const below = rect.bottom + gutter;
    const above = rect.top - gutter - surfaceHeight;
    const preferredTop = below + surfaceHeight <= bottomEdge - gutter || bottomEdge - rect.bottom >= rect.top - topEdge ? below : above;
    const desiredLeft = Math.max(leftEdge + gutter, Math.min(rect.right - surfaceWidth, leftEdge + width - gutter - surfaceWidth));
    const desiredTop = Math.max(topEdge + gutter, Math.min(preferredTop, bottomEdge - gutter - surfaceHeight));
    surface.style.left = `${desiredLeft / cssZoom}px`;
    surface.style.top = `${desiredTop / cssZoom}px`;
    if (!openActionMenu.topLayer) {
      // Size containment may establish a fixed containing block. Correct its
      // offset without moving the menu DOM or disabling responsive containers.
      let hasContainingBlock = false;
      for (let element = surface.parentElement; element instanceof HTMLElement; element = element.parentElement) {
        const style = window.getComputedStyle(element);
        if ((style.containerType && style.containerType !== "normal") || /layout|paint|strict|content/.test(style.contain) ||
          (style.transform && style.transform !== "none") || (style.filter && style.filter !== "none") ||
          (style.perspective && style.perspective !== "none")) {
          hasContainingBlock = true;
          break;
        }
      }
      if (hasContainingBlock) {
        const actual = surface.getBoundingClientRect();
        surface.style.left = `${Number.parseFloat(surface.style.left) + (desiredLeft - actual.left) / cssZoom}px`;
        surface.style.top = `${Number.parseFloat(surface.style.top) + (desiredTop - actual.top) / cssZoom}px`;
      }
    }
  }

  function openActions(menu, { focus = true } = {}) {
    const parts = actionMenuParts(menu);
    if (!parts || parts.trigger.disabled || !actionElementVisible(parts.trigger)) return;
    closeActionMenu();
    openActionMenu = parts;
    parts.topLayer = false;
    parts.trigger.setAttribute("aria-expanded", "true");
    parts.surface.hidden = false;
    if (typeof parts.surface.showPopover === "function") {
      try { parts.surface.showPopover({ source: parts.trigger }); parts.topLayer = true; } catch { parts.surface.removeAttribute("popover"); }
    } else parts.surface.removeAttribute("popover");
    positionActionMenu();
    if (openActionMenu !== parts) return;
    if (focus) {
      const first = [...parts.surface.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')]
        .find((element) => element instanceof HTMLElement && element.getAttribute("aria-disabled") !== "true" && actionElementVisible(element));
      (first ?? parts.surface).focus({ preventScroll: true });
    }
  }

  function initializeActionMenus() {
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const trigger = target?.closest('[data-action="toggle-action-menu"]');
      if (trigger instanceof HTMLButtonElement) {
        event.preventDefault();
        if (trigger.disabled) return;
        if (openActionMenu?.trigger === trigger) closeActionMenu({ restoreFocus: true });
        else openActions(trigger.closest('[data-ui="action-menu"]'));
        return;
      }
      if (!openActionMenu) return;
      const action = target?.closest('button, a[href]');
      if (action && openActionMenu.surface.contains(action)) {
        if ((action instanceof HTMLButtonElement && action.disabled) || action.getAttribute("aria-disabled") === "true") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        closeActionMenu({ restoreFocus: openActionMenu.menu.contains(document.activeElement) });
      } else if (!target || !openActionMenu.menu.contains(target)) closeActionMenu();
    }, true);
    document.addEventListener("pointerdown", (event) => {
      if (openActionMenu && event.target instanceof Element && !openActionMenu.menu.contains(event.target)) closeActionMenu();
    }, true);
    document.addEventListener("focusin", (event) => {
      if (openActionMenu && event.target instanceof Element && !openActionMenu.menu.contains(event.target)) closeActionMenu();
    }, true);
    document.addEventListener("focusout", (event) => {
      // activeElement may temporarily be body between native blur/focus events.
      // Use the actual next destination, not a microtask that can hide the next
      // action before the browser has focused it during ordinary Tab traversal.
      if (openActionMenu && event.relatedTarget instanceof Node && !openActionMenu.menu.contains(event.relatedTarget)) closeActionMenu();
    }, true);
    window.addEventListener("blur", () => closeActionMenu());
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !openActionMenu) return;
      event.preventDefault();
      event.stopPropagation();
      closeActionMenu({ restoreFocus: true });
    }, true);
    window.addEventListener("resize", positionActionMenu);
    document.addEventListener("scroll", positionActionMenu, true);
    window.visualViewport?.addEventListener("resize", positionActionMenu);
    window.visualViewport?.addEventListener("scroll", positionActionMenu);
    window.addEventListener("pagehide", () => closeActionMenu());
    window.addEventListener("hashchange", () => closeActionMenu());
    window.addEventListener("popstate", () => closeActionMenu());
    const observer = new MutationObserver(() => {
      if (openActionMenu && (!openActionMenu.menu.isConnected || openActionMenu.trigger.disabled || !actionElementVisible(openActionMenu.trigger))) closeActionMenu();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "disabled"] });
    window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  }

  function formatSeasonDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return "";
    return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(parsed);
  }

  function formatSeasonDates(startsOn, endsOn) {
    const start = formatSeasonDate(startsOn);
    const end = formatSeasonDate(endsOn);
    return start && end ? `${start} – ${end}` : start ? `Starts ${start}` : end ? `Ends ${end}` : "Dates not set";
  }

  function formatSeasonKickoff(isoTimestamp) {
    const parsed = new Date(isoTimestamp);
    if (Number.isNaN(parsed.getTime())) return "Kickoff time unavailable";
    return new Intl.DateTimeFormat("en-AU", {
      day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
    }).format(parsed);
  }

  function renderClientTableShell({
    tableTestId,
    bodyId,
    emptyId,
    emptyText,
    headers,
    tableLabel = "",
    emptyInitiallyHidden = false,
  }) {
    const tableLabelAttribute = tableLabel ? ` aria-label="${escapeHtml(tableLabel)}"` : "";
    return `<div data-ui="table-wrap" data-testid="${escapeHtml(tableTestId)}" hidden>
      <table data-ui="data-table"${tableLabelAttribute}>
        <thead>
          <tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr>
        </thead>
        <tbody id="${escapeHtml(bodyId)}"></tbody>
      </table>
    </div>
    <p data-ui="empty-state" id="${escapeHtml(emptyId)}"${emptyInitiallyHidden ? " hidden" : ""}>${escapeHtml(emptyText)}</p>`;
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
      "",
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
        type: "submit",
        "data-action": "create-game",
        "data-testid": "create-game",
        "data-management-only": "", disabled: "",
      })}${renderClientButton("Cancel", "ghost", { type: "button", "data-action": "cancel-disclosure" })}</div>`,
      "panel-season-create-game",
    );
    const upcomingGamesPanel = renderClientPanel(
      "Upcoming games",
      "",
      renderClientTableShell({
        tableTestId: "season-upcoming-games-table",
        bodyId: "season-upcoming-games-body",
        emptyId: "season-upcoming-games-empty",
        emptyText: "No upcoming games.",
        headers: ["Date", "Status", "Actions"],
        tableLabel: "Upcoming games",
        emptyInitiallyHidden: true,
      }),
      "",
      "panel-season-upcoming-games",
    );
    const completedGamesPanel = renderClientPanel(
      "Completed games",
      "",
      renderClientTableShell({
        tableTestId: "season-completed-games-table",
        bodyId: "season-completed-games-body",
        emptyId: "season-completed-games-empty",
        emptyText: "No completed games.",
        headers: ["Date", "Status", "Actions"],
        tableLabel: "Completed games",
        emptyInitiallyHidden: true,
      }),
      "",
      "panel-season-completed-games",
    );

    document.title = "3FC Season";
    document.body.setAttribute("data-api-base-url", apiBaseUrl);
    document.body.innerHTML = `<main data-ui="app-shell" data-testid="season-shell" data-api-base-url="${safeApiBaseUrl}" data-season-id="${safeSeasonId}" data-league-id="${safeLeagueId}">
      <section data-ui="hero">
        <div data-ui="site-header"><nav data-ui="site-nav" aria-label="Primary"><a href="/setup">Home</a></nav>
        <div data-ui="account-actions" id="account-actions" hidden>
          ${renderClientButton("Sign out", "secondary", { type: "button", id: "sign-out", "data-testid": "sign-out", disabled: "" })}
          <p data-ui="status-note" id="sign-out-status" role="status" aria-live="polite" hidden></p>
        </div>
        </div>
        <nav data-ui="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="/setup">Home</a></li><li><a id="season-league-link" href="/leagues/${encodeURIComponent(route.leagueId)}">League</a></li><li><span id="season-breadcrumb-name" aria-current="page">Season</span></li></ol></nav>
        <div data-ui="hero-title-row">
          <h1 id="season-title">Season</h1>
        </div>
        <details data-ui="reference-details"><summary>Reference ID</summary><small data-ui="reference-id" id="season-reference">Season ID: ${safeSeasonId || "Loading…"}</small></details>
        <div data-ui="header-actions" role="group" aria-label="Season actions">
          ${renderClientIconButton({
            icon: "calendar-plus",
            label: "Create game",
            text: "Create game", variant: "primary",
            attributes: {
              "data-management-only": "", hidden: "", disabled: "",
              "data-action": "toggle-create-game",
              "data-testid": "toggle-create-game",
              "aria-controls": "season-create-game-region",
              "aria-expanded": "false",
            },
          })}
          ${renderClientActionMenu("season-actions", "this season", renderClientIconButton({
            icon: "trash-2",
            label: "Delete season",
            text: "Delete season",
            variant: "danger",
            attributes: {
              "data-action": "delete-season",
              "data-testid": "delete-season",
              "data-management-only": "", disabled: "",
            },
          }), { "data-management-only": "", hidden: "" })}
        </div>
      </section>
      <section data-ui="setup-flow" id="setup-flow-root" data-testid="setup-flow-root" data-page="season" data-api-base-url="${safeApiBaseUrl}" data-season-id="${safeSeasonId}" data-league-id="${safeLeagueId}">
        <div data-ui="activity-status" id="setup-status" role="status" aria-live="polite" data-activity="loading">${renderClientIcon("loader-circle")}<span data-ui="activity-message" class="sr-only">Loading season data…</span></div>
        <p data-ui="status-note" data-state="error" id="setup-error" role="status" aria-live="polite" hidden></p>
        <section data-ui="panel-stack" data-testid="season-grid">
          ${upcomingGamesPanel}
          ${completedGamesPanel}
          <section id="season-create-game-region" data-ui="disclosure-panel" hidden>
            <form id="create-game-form" data-ui="management-form" aria-label="Create game" novalidate>${createGamePanel}</form>
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

  async function requestJson(path, init = {}, onDispatch = null) {
    const finishWrite = !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase()) ? beforeGameWrite?.(path, init.method) : null;
    try {
      onDispatch?.();
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

      const result = {
        ok: response.ok,
        status: response.status,
        body,
      };
      finishWrite?.(result);
      return result;
    } catch (error) {
      finishWrite?.(null);
      throw error;
    }
  }

  async function requestJsonOrThrow(path, init = {}, onDispatch = null) {
    const result = await requestJson(path, init, onDispatch);
    if (!result.ok) {
      const message = result.body?.message || result.body?.error || `Request failed with status ${result.status}.`;
      const error = new Error(message);
      error.statusCode = result.status;
      // Keep the machine category separate from user-facing copy. Callers can
      // distinguish a known state rejection from an in-progress idempotent write.
      error.responseCode = typeof result.body?.code === "string" ? result.body.code
        : typeof result.body?.error === "string" ? result.body.error : null;
      error.responseError = typeof result.body?.error === "string" ? result.body.error : null;
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
    const result = await requestJson("/v1/auth/session", { method: "GET", cache: "no-store" });

    if (!result.ok) {
      const target = page === "invite" ? entrySignInHref() : `/sign-in?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;
      navigateTo(target, "replace");
      throw new Error("redirecting_to_sign_in");
    }

    setStatus("Loading page…", "default");

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
      welcomeHeading.textContent = "Welcome";
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

    let creationPending = false;
    let creationAttempt = null;
    attachFormSubmit("create-league-form", createLeagueButton, async () => {
      if (creationPending) return;
      clearError();

      const leagueName = leagueNameInput.value.trim();
      if (!creationAttempt && !leagueName) {
        setFieldMessage("league-name", "invalid", "League name is required.");
        leagueNameInput.focus();
        return;
      }

      setFieldMessage("league-name");

      const leagueFriendlyUrl = slugify(leagueFriendlyUrlInput.value) || slugify(leagueName);
      const leagueId = leagueFriendlyUrl || `league-${randomSuffix(6)}`;
      if (!creationAttempt) {
        creationAttempt = { leagueId, request: freezeCreationRequest("/v1/leagues", {
          leagueId, name: leagueName, slug: leagueFriendlyUrl || null,
        }, "create-league", leagueId) };
      }
      creationPending = true;
      createLeagueButton.disabled = true;
      setStatus("Creating league…", "default");

      try {
        await requestJsonOrThrow(creationAttempt.request.path, creationAttempt.request.init);
        navigateTo(`/leagues/${encodeURIComponent(creationAttempt.leagueId)}`);
      } catch (error) {
        if (isDefinitiveRequestRejection(error) && !creationAttempt.uncertain) {
          creationAttempt = null;
          showError(error.message);
          setStatus("League could not be created.", "error");
        } else {
          creationAttempt.uncertain = true;
          showError("League creation could not be confirmed. Try again to resend the original details; changes to this draft will not be sent yet.", { includesOutcome: true });
        }
        creationPending = false;
        createLeagueButton.disabled = false;
      }
    });

    await renderLeagues();
  }

  function trackInteractionFocus(scope) {
    if (!(scope instanceof HTMLElement)) return () => false;
    let ownsFocus = scope.contains(document.activeElement);
    const playerId = scope.getAttribute("data-player-id");
    const isInside = target => scope.contains(target) || (playerId && target.closest("[data-player-id]")?.getAttribute("data-player-id") === playerId);
    const focusChanged = event => {
      if (event.target !== document.body && event.target instanceof Element && !isInside(event.target)) ownsFocus = false;
    };
    const pointerChanged = event => {
      if (event.target instanceof Element && !isInside(event.target)) ownsFocus = false;
    };
    document.addEventListener("focusin", focusChanged, true);
    document.addEventListener("pointerdown", pointerChanged, true);
    return () => {
      document.removeEventListener("focusin", focusChanged, true);
      document.removeEventListener("pointerdown", pointerChanged, true);
      return ownsFocus;
    };
  }

  function initPlayerInvitation({ path, canManage, canOpen, isLocked, playerName, proofPlayerId = playerId => playerId }) {
    const invitationPanel = document.getElementById("player-invitation-panel");
    const invitationStatus = document.getElementById("player-invitation-status");
    const invitationCreate = document.getElementById("player-invitation-create");
    const invitationCopy = document.getElementById("player-invitation-copy");
    const invitationRevoke = document.getElementById("player-invitation-revoke");
    const invitationClose = document.getElementById("player-invitation-close");
    const invitationLink = document.getElementById("player-invitation-link");
    let invitationPlayerId = null;
    let invitationTarget = null;
    let invitationMetadata = null;
    let invitationAttempt = null;
    let invitationPending = false;
    let invitationLoaded = false;
    let invitationRevokeUnconfirmed = false;
    let invitationCleanup = null;
    let invitationGeneration = 0;
    function discardPlayerInvitation() {
      invitationGeneration += 1;
      invitationLink.value = "";
      invitationAttempt = null; invitationMetadata = null; invitationPlayerId = null;
      invitationTarget = null;
      invitationLoaded = false; invitationPending = false; invitationRevokeUnconfirmed = false;
      invitationCleanup = null;
      invitationPanel.hidden = true;
      invitationMessage("");
    }
    window.addEventListener("threefc:player-proof-cleared", discardPlayerInvitation);
    window.addEventListener("threefc:player-proof-invalidated", discardPlayerInvitation);
    function invitationMessage(text, error = false) {
      invitationStatus.textContent = text;
      invitationStatus.hidden = !text;
      invitationStatus.setAttribute("role", error ? "alert" : "status");
    }
    function retireInvitationDraft() {
      try {
        window.ThreeFcPlayerProof.discardDraft(invitationAttempt.proof);
        invitationAttempt = null;
        return true;
      } catch {
        invitationMessage("Your browser couldn’t clear the saved private link. Allow site storage, then retry.", true);
        return false;
      }
    }
    function finishInvitationCleanup() {
      if (!invitationCleanup) return;
      window.ThreeFcPlayerProof.retireInvitation(invitationCleanup.proofId, invitationCleanup.playerId);
      invitationCleanup = null;
    }
    function renderInvitation() {
      const canIssue = invitationLoaded && canManage() && !isLocked();
      invitationCreate.disabled = invitationPending || !canIssue || invitationRevokeUnconfirmed;
      invitationClose.disabled = invitationPending;
      invitationCopy.disabled = invitationPending || Boolean(invitationAttempt) || !invitationLoaded;
      invitationRevoke.disabled = invitationPending || !canIssue || Boolean(invitationAttempt);
      invitationCreate.textContent = invitationAttempt ? "Retry link creation" : invitationMetadata ? "Replace private link" : "Create private link";
      invitationRevoke.hidden = !invitationMetadata || invitationMetadata.state !== "pending";
      invitationCopy.hidden = !invitationLink.value;
      document.getElementById("player-invitation-link-field").hidden = !invitationLink.value;
    }
    function invitationPath(suffix = "") { return invitationTarget?.paths[suffix] ?? null; }
    async function invitationRequest(path, options, onDispatch = null) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      try { return await requestJsonOrThrow(path, { ...options, signal: controller.signal }, onDispatch); }
      finally { window.clearTimeout(timeout); }
    }
    async function openPlayerInvitation(playerId) {
      if (invitationPending || !canManage() || !canOpen(playerId)) return;
      closeActionMenu();
      if (invitationPlayerId !== playerId && (invitationAttempt || invitationRevokeUnconfirmed)) {
        invitationPanel.hidden = false;
        invitationMessage("Finish checking the previous profile-link request before starting another one.", true);
        return;
      }
      if (invitationPlayerId === playerId && invitationLoaded) {
        invitationPanel.hidden = false;
        document.getElementById("player-invitation-title").focus();
        return;
      }
      invitationPlayerId = playerId; invitationMetadata = null; invitationAttempt = null;
      // The card keeps its historical game ID. Proof storage and all retries
      // must instead retain the exact canonical target selected on opening.
      invitationTarget = { playerId: proofPlayerId(playerId), paths: { "": path("", playerId), "/revoke": path("/revoke", playerId) } };
      const generation = ++invitationGeneration;
      invitationRevokeUnconfirmed = false;
      invitationLoaded = false; invitationPending = true; invitationLink.value = "";
      invitationPanel.hidden = false;
      document.getElementById("player-invitation-title").textContent = `Invite ${playerName(playerId)} to link their profile`;
      document.getElementById("player-invitation-title").focus();
      invitationMessage("Checking profile link…"); renderInvitation();
      try {
        const result = await invitationRequest(invitationPath(), { method: "GET", cache: "no-store" });
        if (generation !== invitationGeneration) return;
        if (result.invitation !== null && (typeof result.invitation?.proofId !== "string" || typeof result.invitation?.expiresAt !== "string")) throw new Error("invite_unconfirmed");
        invitationMetadata = result.invitation;
        invitationLoaded = true;
        invitationMessage(invitationMetadata ? "A private link already exists. Replace it if you need a new copy." : "");
      } catch {
        if (generation !== invitationGeneration) return;
        invitationMessage("Could not check this player’s link. Close this panel and try again.", true);
      } finally { if (generation === invitationGeneration) { invitationPending = false; renderInvitation(); } }
    }
    invitationCreate?.addEventListener("click", async () => {
      if (invitationPending || !invitationLoaded || invitationRevokeUnconfirmed || !canManage() || isLocked()) return;
      if (!invitationAttempt && invitationMetadata && !window.confirm("Replace this private link? The previous link will stop working. Share the new link privately.")) return;
      const generation = invitationGeneration;
      let dispatched = false;
      invitationPending = true; renderInvitation(); invitationMessage("Creating private link…");
      try {
        finishInvitationCleanup();
        if (!invitationAttempt) {
          const proof = await window.ThreeFcPlayerProof.create(`invite:${randomSuffix(24)}`);
          if (generation !== invitationGeneration) return;
          invitationAttempt = { proof, previousProofId: invitationMetadata?.proofId ?? null, previousLink: invitationLink.value, body: JSON.stringify({ proofId: proof.proofId, verifier: proof.verifier,
            replacesProofId: invitationMetadata?.proofId ?? null }) };
        }
        const result = await invitationRequest(invitationPath(), { method: "POST", headers: { "Content-Type": "application/json" }, body: invitationAttempt.body }, () => {
          dispatched = true;
          invitationLink.value = "";
          renderInvitation();
        });
        if (generation !== invitationGeneration) return;
        const record = window.ThreeFcPlayerProof.attach(invitationAttempt.proof, result.invitation, invitationTarget.playerId, invitationAttempt.previousProofId);
        invitationMetadata = { ...result.invitation, state: "pending" };
        invitationLink.value = window.ThreeFcPlayerProof.shareLink(record);
        invitationAttempt = null;
        invitationMessage(`Private link created. It expires on ${new Date(result.invitation.expiresAt).toLocaleString()}.`);
      } catch (error) {
        if (generation !== invitationGeneration) return;
        if (error.statusCode === 503 && error.responseCode === "claims_unavailable" && invitationAttempt && !invitationAttempt.uncertain) {
          invitationLink.value = invitationAttempt.previousLink;
          if (!retireInvitationDraft()) return;
          invitationMessage(invitationLink.value
            ? "Profile linking is temporarily unavailable. Your existing link was not replaced. Try again later."
            : "Profile linking is temporarily unavailable. No link was created. Try again later.", true);
          return;
        }
        if (!dispatched && invitationAttempt && !invitationAttempt.uncertain) {
          if (!retireInvitationDraft()) return;
          invitationMessage("The link was not replaced. Reload to check the earlier game change before trying again.", true);
          return;
        }
        if (invitationAttempt && ((!invitationAttempt.uncertain && [400, 401, 403, 404, 409].includes(error.statusCode)) ||
            (error.statusCode === 409 && error.responseCode === "claim_invite_changed"))) {
          if (!retireInvitationDraft()) return;
          invitationLoaded = false; invitationLink.value = "";
          invitationMessage("This player or its private link changed. Close this panel and check it again.", true);
        } else {
          if (invitationAttempt) invitationAttempt.uncertain = true;
          invitationMessage(error.message === "proof_storage_full"
            ? "This tab is holding too many private links. Save any links you need before signing out and back in."
            : invitationAttempt ? "Link creation could not be confirmed. Retry sends the same request."
            : "Your browser could not keep the private link. Allow site storage and try again.", true);
        }
      } finally { if (generation === invitationGeneration) { invitationPending = false; renderInvitation(); } }
    });
    invitationRevoke?.addEventListener("click", async () => {
      if (invitationPending || invitationAttempt || !invitationMetadata || !canManage() || isLocked()) return;
      if (!invitationRevokeUnconfirmed && !window.confirm("Revoke this private link? Anyone who received it will no longer be able to use it.")) return;
      const generation = invitationGeneration;
      const finishFocus = trackInteractionFocus(invitationRevoke);
      let dispatched = false;
      invitationPending = true; renderInvitation();
      try {
        finishInvitationCleanup();
        const result = await invitationRequest(invitationPath("/revoke"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proofId: invitationMetadata.proofId }) }, () => { dispatched = true; });
        if (generation !== invitationGeneration) return;
        if (result.revoked !== true) throw new Error("revoke_unconfirmed");
        invitationMetadata.state = "revoked"; invitationLink.value = "";
        invitationRevokeUnconfirmed = false;
        invitationCleanup = { proofId: invitationMetadata.proofId, playerId: invitationTarget.playerId };
        try { finishInvitationCleanup(); invitationMessage("Private link revoked."); }
        catch { invitationMessage("Private link revoked. Your browser couldn’t clear its saved copy. Allow site storage before creating another link.", true); }
      } catch (error) {
        if (generation === invitationGeneration) {
          if (!dispatched) {
            invitationMessage(invitationRevokeUnconfirmed
              ? "This retry was not sent. The earlier revocation is still unconfirmed. Reload before continuing."
              : "Revocation was not sent. Reload to check the earlier game change before trying again.", true);
          } else if (error.statusCode === 409) {
            invitationRevokeUnconfirmed = false; invitationLoaded = false;
            invitationMetadata = null; invitationLink.value = "";
            invitationMessage("The private link changed. Close this panel and check the current link before revoking it.", true);
          } else {
            invitationRevokeUnconfirmed = true;
            invitationMessage("Revocation could not be confirmed. Try again to revoke the same link.", true);
          }
        }
      }
      finally {
        const owned = finishFocus();
        if (generation === invitationGeneration) {
          invitationPending = false; renderInvitation();
          if (owned && invitationRevoke.hidden && !invitationPanel.hidden) { invitationStatus.tabIndex = -1; invitationStatus.focus(); }
        }
      }
    });
    invitationCopy?.addEventListener("click", async () => {
      if (!invitationLink.value || invitationPending || isLocked() || !canManage()) return;
      const generation = invitationGeneration;
      try { await navigator.clipboard.writeText(invitationLink.value); if (generation === invitationGeneration) invitationMessage("Private link copied."); }
      catch { if (generation === invitationGeneration) { invitationLink.focus(); invitationLink.select(); invitationMessage("Copy failed. Select and copy the link above.", true); } }
    });
    function closePlayerInvitation() {
      if (invitationPending) return;
      invitationPanel.hidden = true;
      const card = [...root.querySelectorAll('[data-player-id]')].find((node) => node.getAttribute("data-player-id") === invitationPlayerId);
      (card?.querySelector('[data-action="toggle-action-menu"]') ?? card?.querySelector('[data-action="invite-player-profile"]'))?.focus();
    }
    invitationClose?.addEventListener("click", closePlayerInvitation);
    invitationPanel?.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); closePlayerInvitation(); } });
    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-action="invite-player-profile"]') : null;
      if (target) void openPlayerInvitation(target.getAttribute("data-player-id"));
    });
    return {
      discard: discardPlayerInvitation,
      hasPending: () => Boolean(invitationPending || invitationAttempt || invitationRevokeUnconfirmed),
      ownsRequest: requestPath => invitationPending && [invitationPath(), invitationPath("/revoke")].includes(requestPath),
    };

  }

  function attachPlayerNameSuggestions({ input, panel, leagueId, canRead, useExisting }) {
    let version = 0, timer = null;
    function clear() { ++version; window.clearTimeout(timer); panel.replaceChildren(); panel.hidden = true; }
    async function check() {
      clear();
      const nickname = input.value.trim(), current = version;
      if (!nickname || !canRead()) return;
      const message = document.createElement("p");
      message.setAttribute("role", "status"); message.textContent = "Checking for existing players…";
      panel.append(message); panel.hidden = false;
      try {
        // Suggestions are bounded and advisory, never identity matching or an
        // assertion that no duplicates exist beyond this page of results.
        const result = await requestJsonOrThrow(`/v1/league-players?${new URLSearchParams({ leagueId: leagueId(), query: nickname, limit: "10" })}`);
        if (current !== version || input.value.trim() !== nickname || !canRead()) return;
        if (!Array.isArray(result.players) || result.players.some(player => !usableEntityId(player.playerId) ||
            typeof player.nickname !== "string" || !Array.isArray(player.seasons) || player.seasons.some(season => typeof season.name !== "string"))) throw new Error("Invalid player suggestions");
        panel.replaceChildren();
        if (!result.players.length && !result.cursor) { panel.hidden = true; return; }
        message.textContent = "Possible existing players. If this is someone else, create a new player below.";
        panel.append(message);
        const list = document.createElement("ul");
        for (const player of result.players) {
          const row = document.createElement("li");
          row.textContent = [player.nickname, ...player.seasons.map(season => season.name)].join(" · "); list.append(row);
        }
        panel.append(list);
        const button = document.createElement("button"); button.type = "button";
        button.setAttribute("data-ui", "button"); button.setAttribute("data-variant", "secondary");
        button.textContent = "Find existing players";
        button.addEventListener("click", () => { if (canRead()) useExisting(nickname); }); panel.append(button);
      } catch {
        if (current === version && canRead()) message.textContent = "Couldn’t check for existing players. Search the player list before creating another profile.";
      }
    }
    input.addEventListener("input", () => { clear(); timer = window.setTimeout(() => { void check(); }, 180); });
    window.addEventListener("threefc:player-proof-cleared", clear);
    window.addEventListener("threefc:player-proof-invalidated", clear);
    window.addEventListener("pagehide", clear);
    return { check, clear };
  }

  function initLeagueDirectory(leagueId, seasons, canManage) {
    const panel = document.getElementById("league-players-region");
    if (!panel) return;
    const list = document.getElementById("league-player-list");
    const status = document.getElementById("league-player-status");
    const scope = document.getElementById("league-player-scope");
    const search = document.getElementById("league-player-search");
    const more = document.getElementById("league-player-more");
    const createToggle = document.getElementById("league-player-create-toggle");
    const createPanel = document.getElementById("league-player-create-region");
    const name = document.getElementById("league-player-name");
    const createButton = document.getElementById("league-player-create");
    const cancel = document.getElementById("league-player-create-cancel");
    const seasonPanel = document.querySelector('[data-testid="panel-league-seasons"]');
    let generation = 0, cursor = null, loaded = false, pending = false, creating = false, attempt = null;
    let submittedQuery = "", submittedScope = "", filterRevision = 0;
    const seen = new Set();
    const directoryPlayers = new Map();
    const consolidation = window.ThreeFcConsolidation?.initializeLeague({ leagueId, canManage,
      getPlayer: playerId => directoryPlayers.get(playerId), onCommitted: () => { void load(); } });
    const say = (message, error = false) => {
      status.textContent = message; status.hidden = !message;
      status.setAttribute("data-state", error ? "error" : "default");
    };
    for (const season of seasons) {
      const option = document.createElement("option");
      option.value = season.seasonId; option.textContent = season.name;
      scope.append(option);
    }
    const requestedSeason = new URLSearchParams(window.location.search).get("seasonId");
    if (requestedSeason && seasons.some(season => season.seasonId === requestedSeason)) scope.value = requestedSeason;
    attachDisclosure(createToggle, createPanel);
    const canWrite = () => canManage() && hasAuthenticatedAccount && !signOutPending && !signOutUnconfirmed && !accountRevalidating;
    const nameSuggestions = attachPlayerNameSuggestions({ input: name, panel: document.getElementById("league-player-name-matches"),
      leagueId: () => leagueId, canRead: () => canWrite() && !creating && !attempt,
      useExisting: nickname => {
        setDisclosureState(createToggle, createPanel, false, { restoreFocus: false });
        scope.value = ""; search.value = nickname; filterRevision += 1; search.focus(); void load();
      } });
    const invitations = initPlayerInvitation({
      path: (suffix, playerId) => {
        try {
          return usableEntityId(playerId) ? `/v1/player-proofs/league-invitation${suffix}?${new URLSearchParams({ leagueId, playerId })}` : null;
        } catch { return null; }
      },
      canManage: canWrite,
      canOpen: playerId => directoryPlayers.has(playerId) && !directoryPlayers.get(playerId).claimed,
      isLocked: () => !canWrite(),
      playerName: playerId => directoryPlayers.get(playerId)?.nickname ?? "Player",
    });
    function renderRows(players, append) {
      if (!append) { list.replaceChildren(); seen.clear(); directoryPlayers.clear(); }
      for (const player of players) {
        if (!usableEntityId(player.playerId) || typeof player.nickname !== "string" || seen.has(player.playerId)) continue;
        seen.add(player.playerId);
        directoryPlayers.set(player.playerId, player);
        const row = document.createElement("li");
        row.setAttribute("data-player-id", player.playerId);
        const label = document.createElement("strong"); label.textContent = player.nickname;
        const badge = document.createElement("span");
        badge.setAttribute("data-ui", "claim-badge");
        badge.setAttribute("data-state", player.claimed ? "claimed" : "unclaimed");
        badge.title = player.claimed ? "Linked to an account" : "Not linked to an account";
        badge.innerHTML = renderClientIcon(player.claimed ? "user-round-check" : "circle-user-round");
        const accessible = document.createElement("span"); accessible.className = "sr-only"; accessible.textContent = badge.title;
        badge.append(accessible);
        const heading = document.createElement("div"); heading.setAttribute("data-ui", "directory-player-heading"); heading.append(label, badge);
        if (canManage() && !player.claimed) {
          const actions = document.createElement("div");
          actions.innerHTML = renderClientActionMenu(`directory-player-${encodeURIComponent(player.playerId)}`, player.nickname,
            renderClientIconButton({ icon: "user-round-plus", label: `Invite ${player.nickname} to link their profile`, text: "Invite to link profile",
              attributes: { "data-action": "invite-player-profile", "data-player-id": player.playerId } }));
          heading.append(actions);
        }
        row.append(heading);
        const names = (Array.isArray(player.seasons) ? player.seasons : []).filter(season => typeof season.name === "string").map(season => season.name);
        if (names.length) {
          const context = document.createElement("p"); context.textContent = names.join(" · ") + (player.hasMoreSeasons ? " · More seasons" : "");
          row.append(context);
        }
        list.append(row);
      }
      consolidation?.refreshRows();
    }
    async function load(append = false) {
      if (append && (pending || !cursor)) return;
      const finishFocus = append ? trackInteractionFocus(more) : null;
      const version = ++generation;
      pending = true; more.disabled = true;
      if (!append) { cursor = null; more.hidden = true; }
      say("Loading players…");
      if (!append) { submittedQuery = search.value.trim(); submittedScope = scope.value; }
      const query = new URLSearchParams({ leagueId, query: submittedQuery, limit: "25" });
      if (submittedScope) query.set("seasonId", submittedScope);
      if (append) query.set("cursor", cursor);
      try {
        const result = await requestJsonOrThrow(`/v1/league-players?${query}`, { method: "GET", cache: "no-store" });
        if (version !== generation) return;
        if (!Array.isArray(result.players) || (result.cursor !== null && typeof result.cursor !== "string")) throw new Error("Invalid player list");
        renderRows(result.players, append); cursor = result.cursor; loaded = true;
        more.hidden = !cursor;
        say(seen.size ? "" : cursor ? "No matches on this page. Load more players to continue searching." : "No players found.");
        return true;
      } catch (error) {
        if (version !== generation) return;
        // Never label an unavailable/migrating directory an empty player list.
        if (!append || error.statusCode === 403 || error.statusCode === 401) { list.replaceChildren(); seen.clear(); directoryPlayers.clear(); }
        if (error.statusCode === 403 || error.statusCode === 401) invitations.discard();
        if (error.statusCode === 409) { cursor = null; more.hidden = true; }
        say(error.statusCode === 503 ? "The player list is temporarily unavailable. Try again later."
          : error.statusCode === 409 ? "The player list changed. Search again to refresh it."
          : "Could not load players. Search again to retry.", true);
        return false;
      } finally {
        const owned = finishFocus?.();
        if (version === generation) {
          pending = false; more.disabled = false;
          if (owned && more.hidden && !panel.hidden) {
            if (status.hidden) say("All matching players loaded.");
            status.tabIndex = -1; status.focus();
          }
        }
      }
    }
    document.getElementById("league-player-search-form").addEventListener("submit", event => { event.preventDefault(); void load(); });
    search.addEventListener("input", () => { filterRevision += 1; });
    scope.addEventListener("change", () => { filterRevision += 1; void load(); });
    more.addEventListener("click", () => { void load(true); });
    cancel.addEventListener("click", () => { if (!creating) setDisclosureState(createToggle, createPanel, false); });
    document.getElementById("league-player-create-form").addEventListener("submit", async event => {
      event.preventDefault();
      if (creating || !canWrite()) return;
      const nickname = name.value.trim();
      if (!nickname) { name.reportValidity(); name.focus(); return; }
      if (!attempt) attempt = { playerId: `player-${randomSuffix(24)}`, nickname, uncertain: false };
      const filtersAtDispatch = filterRevision;
      const finishFocus = trackInteractionFocus(document.getElementById("league-player-create-form"));
      creating = true; createButton.disabled = true; cancel.disabled = true; name.readOnly = true;
      say("Creating player…");
      try {
        const result = await requestJsonOrThrow(`/v1/league-players?${new URLSearchParams({ leagueId })}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId: attempt.playerId, nickname: attempt.nickname }),
        });
        if (result.player?.playerId !== attempt.playerId) throw new Error("Unconfirmed creation");
        const savedName = attempt.nickname;
        attempt = null; name.value = ""; name.readOnly = false; nameSuggestions.clear();
        // A standalone player has no season membership until added to a game.
        if (filtersAtDispatch === filterRevision) {
          scope.value = ""; search.value = "";
          const refreshed = await load();
          if (filtersAtDispatch === filterRevision) say(refreshed ? `${savedName} created.` : `${savedName} created. The player list could not be refreshed. Search again to retry.`, !refreshed);
        } else say(`${savedName} created. Find them in All league players.`);
      } catch (error) {
        if (attempt && !attempt.uncertain && isDefinitiveRequestRejection(error) && ![408, 429].includes(error.statusCode)) {
          attempt = null; name.readOnly = false;
        } else if (attempt) attempt.uncertain = true;
        say(attempt ? "Player creation could not be confirmed. Retry sends the same player entry."
          : "Could not create this player. Check the name and try again.", true);
      } finally {
        creating = false; createButton.disabled = !canWrite(); cancel.disabled = false;
        if (finishFocus() && !panel.hidden && !createPanel.hidden) name.focus();
      }
    });
    function showDestination(focus = false) {
      const players = window.location.hash === "#players";
      panel.hidden = !players; if (seasonPanel) seasonPanel.hidden = players;
      for (const anchor of root.querySelectorAll("[data-league-destination]")) {
        const active = (anchor.dataset.leagueDestination === "players") === players;
        anchor.setAttribute("data-state", active ? "active" : "inactive");
        if (active) anchor.setAttribute("aria-current", "page"); else anchor.removeAttribute("aria-current");
      }
      if (players && !loaded && !pending) void load();
      if (players && focus) document.getElementById("league-players-title").focus();
    }
    window.addEventListener("hashchange", () => showDestination(true));
    showDestination();
    return { updateSeasons(nextSeasons) {
      const selected = scope.value;
      const all = document.createElement("option"); all.value = ""; all.textContent = "All league players";
      scope.replaceChildren(all);
      for (const season of nextSeasons) {
        const option = document.createElement("option"); option.value = season.seasonId; option.textContent = season.name; scope.append(option);
      }
      scope.value = nextSeasons.some(season => season.seasonId === selected) ? selected : "";
      generation += 1; filterRevision += 1; loaded = false; pending = false; cursor = null; more.hidden = true;
      list.replaceChildren(); seen.clear(); directoryPlayers.clear();
      if (!panel.hidden) void load();
    } };
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
    let canManage = false;
    let leagueName = "League";
    let directorySeasons = [];
    let directoryController = null;
    const confirmedDeletedSeasonIds = new Set();
    const pendingDeletedSeasonIds = new Set();
    let seasonsRenderVersion = 0;
    setManagementAccess(false);

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
        if (canManage && !shareInviteLoaded && !shareInvitePromise) {
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

      canManage = league.access?.role === "admin";
      leagueName = league.name;
      setManagementAccess(canManage);

      if (title) {
        title.textContent = league.name;
      }

      if (leagueReference) {
        leagueReference.textContent = `League ID: ${league.leagueId}`;
      }
      const breadcrumb = document.getElementById("league-breadcrumb-name");
      if (breadcrumb) breadcrumb.textContent = league.name;
    }

    async function renderSeasons() {
      const renderVersion = ++seasonsRenderVersion;
      const payload = await requestJsonOrThrow(
        `/v1/leagues/${encodeURIComponent(leagueId)}/seasons`,
        { method: "GET" },
      ).catch((error) => {
        if (renderVersion !== seasonsRenderVersion) return null;
        throw error;
      });
      if (renderVersion !== seasonsRenderVersion) return;

      const seasons = (Array.isArray(payload?.seasons) ? payload.seasons : [])
        .filter((season) => !confirmedDeletedSeasonIds.has(season.seasonId));
      directorySeasons = seasons;
      directoryController?.updateSeasons(seasons);
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

      replaceManagementRows(seasonsBody, seasons
        .map((season) => {
          const dateRange = formatSeasonDates(season.startsOn, season.endsOn);
          const seasonPath = buildLeagueSeasonPath(leagueId, season.seasonId);
          return `<tr>
            <td data-label="Season name"><a href="${seasonPath}">${escapeHtml(season.name)}</a></td>
            <td data-label="Dates">${escapeHtml(dateRange)}</td>
            <td data-label="Actions">
              ${canManage ? renderManagementDelete(season.name, {
                "data-action": "delete-season", "data-season-id": season.seasonId, "data-season-name": season.name,
              }, false, pendingDeletedSeasonIds.has(season.seasonId)) : ""}
            </td>
          </tr>`;
        })
        .join(""));

      if (seasonsTableWrap instanceof HTMLElement) {
        seasonsTableWrap.hidden = false;
      }
      if (seasonsEmpty instanceof HTMLElement) {
        seasonsEmpty.hidden = true;
      }
    }

    let creationPending = false;
    let creationAttempt = null;
    attachFormSubmit("create-season-form", createSeasonButton, async () => {
      if (!canManage || creationPending) return;
      clearError();

      const seasonName = seasonNameInput.value.trim();
      if (!creationAttempt && !seasonName) {
        setFieldMessage("season-name", "invalid", "Season name is required.");
        seasonNameInput.focus();
        return;
      }

      setFieldMessage("season-name");

      const seasonFriendlyUrl = slugify(seasonFriendlyUrlInput.value) || slugify(seasonName);
      const seasonId = seasonFriendlyUrl || `season-${randomSuffix(6)}`;
      if (!creationAttempt) {
        creationAttempt = { seasonId, request: freezeCreationRequest(
          `/v1/leagues/${encodeURIComponent(leagueId)}/seasons`, {
            seasonId, name: seasonName, slug: seasonFriendlyUrl || null,
            startsOn: (document.getElementById("season-start")?.value ?? "") || null,
            endsOn: (document.getElementById("season-end")?.value ?? "") || null,
          }, "create-season", `${leagueId}-${seasonId}`,
        ) };
      }
      creationPending = true;
      createSeasonButton.disabled = true;
      setStatus("Creating season…", "default");

      try {
        await requestJsonOrThrow(creationAttempt.request.path, creationAttempt.request.init);
        navigateTo(buildLeagueSeasonPath(leagueId, creationAttempt.seasonId));
      } catch (error) {
        if (isDefinitiveRequestRejection(error) && !creationAttempt.uncertain) {
          creationAttempt = null;
          showError(error.message);
          setStatus("Season could not be created.", "error");
        } else {
          creationAttempt.uncertain = true;
          showError("Season creation could not be confirmed. Try again to resend the original details; changes to this draft will not be sent yet.", { includesOutcome: true });
        }
        creationPending = false;
        createSeasonButton.disabled = false;
      }
    });

    let invitePending = false;
    attachFormSubmit("organiser-invite-form", createOrganiserInviteButton, async () => {
      if (!canManage || invitePending) return;
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
      invitePending = true;
      createOrganiserInviteButton.disabled = true;
      clearError();
      setStatus("");
      setLocalStatus(organiserInviteEmailStatus, "Sending invite…", "default");
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
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create organiser invite.";
        setLocalStatus(organiserInviteEmailStatus, `Invite failed: ${message}`, "error");
      } finally {
        invitePending = false;
        createOrganiserInviteButton.disabled = false;
      }
    });

    seasonsBody.addEventListener("click", async (event) => {
      const eventTarget = event.target;
      const target = eventTarget instanceof Element ? eventTarget.closest('[data-action="delete-season"]') : null;
      if (!(target instanceof HTMLButtonElement) || !canManage || target.disabled) {
        return;
      }

      const seasonId = target.getAttribute("data-season-id");
      if (!seasonId || pendingDeletedSeasonIds.has(seasonId) || confirmedDeletedSeasonIds.has(seasonId)) {
        return;
      }

      const name = target.getAttribute("data-season-name") || "this season";
      if (!window.confirm(`Delete ${name}? This only works when it has no games.`)) {
        return;
      }

      const finishFocus = trackDeletedRowFocus(target);
      let committed = false;
      pendingDeletedSeasonIds.add(seasonId);
      target.setAttribute("disabled", "true");
      clearError();
      setStatus(`Deleting season ${seasonId}…`, "default");

      try {
        await deleteManagementEntity(`/v1/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}`);
        committed = true;
        confirmedDeletedSeasonIds.add(seasonId);
        directorySeasons = directorySeasons.filter(season => season.seasonId !== seasonId);
        directoryController?.updateSeasons(directorySeasons);
        for (const action of seasonsBody.querySelectorAll('[data-season-id]')) {
          if (action.getAttribute("data-season-id") === seasonId) action.closest("tr")?.remove();
        }
        try {
          await renderSeasons();
          setStatus("Season deleted.", "success");
        } catch {
          showError("Season deleted. The list could not be refreshed. Reload this page to see the latest seasons.", { includesOutcome: true });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not delete season.";
        showError(message);
        setStatus(isDefinitiveRequestRejection(error) ? "Season could not be deleted." : "Season deletion could not be confirmed. Reload the page before trying again.", "error");
      } finally {
        pendingDeletedSeasonIds.delete(seasonId);
        target.removeAttribute("disabled");
        for (const action of seasonsBody.querySelectorAll('[data-action="delete-season"]')) {
          if (action.getAttribute("data-season-id") === seasonId) action.removeAttribute("disabled");
        }
        finishFocus(committed);
      }
    });

    if (deleteLeagueButton instanceof HTMLButtonElement) {
      deleteLeagueButton.addEventListener("click", async () => {
        if (!canManage || deleteLeagueButton.disabled) return;
        if (!window.confirm(`Delete ${leagueName}? This only works when the league has no seasons.`)) {
          return;
        }

        deleteLeagueButton.disabled = true;
        clearError();
        // The recoverable action owns its pending/error feedback; do not leave
        // an unrelated global progress message behind after a failed attempt.
        setStatus("");

        try {
          if (await leagueDeletionRecovery?.start(leagueId)) navigateTo("/setup");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not delete league.";
          showError(message);
          setStatus(isDefinitiveRequestRejection(error) ? "League could not be deleted." : "League deletion could not be confirmed. Reload the page before trying again.", "error");
        } finally {
          deleteLeagueButton.disabled = false;
        }
      });
    }

    await loadLeague();
    await renderSeasons();
    directoryController = initLeagueDirectory(leagueId, directorySeasons, () => canManage);
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

    const upcomingGamesBody = document.getElementById("season-upcoming-games-body");
    const upcomingGamesTableWrap = document.querySelector('[data-testid="season-upcoming-games-table"]');
    const upcomingGamesEmpty = document.getElementById("season-upcoming-games-empty");
    const completedGamesBody = document.getElementById("season-completed-games-body");
    const completedGamesTableWrap = document.querySelector('[data-testid="season-completed-games-table"]');
    const completedGamesEmpty = document.getElementById("season-completed-games-empty");

    if (
      !(gameDateInput instanceof HTMLInputElement) ||
      !(gameKickoffInput instanceof HTMLInputElement) ||
      !(gameThirdLengthInput instanceof HTMLSelectElement) ||
      !(createGameButton instanceof HTMLButtonElement) ||
      !(toggleCreateGameButton instanceof HTMLButtonElement) ||
      !(createGameRegion instanceof HTMLElement) ||
      !(upcomingGamesBody instanceof HTMLElement) ||
      !(completedGamesBody instanceof HTMLElement)
    ) {
      return;
    }

    let leagueId = routeLeagueId ?? "";
    let canManage = false;
    let seasonName = "this season";
    const confirmedDeletedGameIds = new Set();
    const pendingDeletedGameIds = new Set();
    let gamesRenderVersion = 0;
    setManagementAccess(false);
    const gameIdNonce = randomSuffix(4);
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
      seasonName = season.name;
      if (seasonTitle) {
        seasonTitle.textContent = season.name;
      }

      if (seasonReference) {
        seasonReference.textContent = `Season ID: ${season.seasonId}`;
      }
      const breadcrumb = document.getElementById("season-breadcrumb-name");
      if (breadcrumb) breadcrumb.textContent = season.name;

      if (seasonLeagueLink instanceof HTMLAnchorElement) {
        seasonLeagueLink.href = `/leagues/${encodeURIComponent(season.leagueId)}`;
      }
      // A season does not carry an ACL. One bounded parent read supplies both
      // its real breadcrumb and authority, without an admin-only search.
      try {
        const league = await requestJsonOrThrow(`/v1/leagues/${encodeURIComponent(leagueId)}`, { method: "GET" });
        if (league.leagueId === leagueId) {
          if (seasonLeagueLink instanceof HTMLAnchorElement) seasonLeagueLink.textContent = league.name;
          canManage = league.access?.role === "admin";
          if (["admin", "scorekeeper"].includes(league.access?.role)) {
            let playersLink = document.getElementById("season-players-link");
            if (!playersLink) {
              playersLink = document.createElement("a"); playersLink.id = "season-players-link";
              playersLink.setAttribute("data-ui", "button"); playersLink.setAttribute("data-variant", "secondary");
              playersLink.innerHTML = `${renderClientIcon("users")}<span>Players</span>`;
              document.querySelector('[data-ui="header-actions"]')?.prepend(playersLink);
            }
            playersLink.href = `/leagues/${encodeURIComponent(leagueId)}?${new URLSearchParams({ seasonId })}#players`;
          }
        }
      } catch {
        // Existing season/game reads can still be useful. Unknown authority
        // never enables management, even if #create-game was requested.
        canManage = false;
        showError("League details couldn’t be loaded. Reload this page to try again.", { includesOutcome: true });
      }
      setManagementAccess(canManage);
    }

    async function renderGames() {
      const renderVersion = ++gamesRenderVersion;
      const gamesPath = leagueId
        ? `/v1/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/games`
        : `/v1/seasons/${encodeURIComponent(seasonId)}/games`;
      const legacyGamesPath = `/v1/seasons/${encodeURIComponent(seasonId)}/games`;
      const payload = await requestJsonOrThrowWithFallback(
        gamesPath,
        leagueId ? legacyGamesPath : null,
        { method: "GET" },
      ).catch((error) => {
        if (renderVersion !== gamesRenderVersion) return null;
        throw error;
      });
      if (renderVersion !== gamesRenderVersion) return;

      const games = (Array.isArray(payload?.games) ? payload.games : []).filter(
        (game) => (!leagueId || (game.leagueId === leagueId && game.seasonId === seasonId)) && !confirmedDeletedGameIds.has(game.gameId),
      );
      const kickoffTime = (game) => {
        const parsed = Date.parse(game.gameStartTs);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const compareByKickoff = (direction) => (left, right) => {
        const timestampDifference = (kickoffTime(left) - kickoffTime(right)) * direction;
        return timestampDifference || String(left.gameId).localeCompare(String(right.gameId));
      };
      const upcomingGames = games
        .filter((game) => game.status !== "finished")
        .sort(compareByKickoff(1));
      const completedGames = games
        .filter((game) => game.status === "finished")
        .sort(compareByKickoff(-1));

      const renderRows = (gamesForPanel) => gamesForPanel
        .map((game) => {
          const status = ["scheduled", "live", "finished"].includes(game.status) ? game.status : "scheduled";
          const statusIcon = status === "live" ? "activity" : status === "finished" ? "circle-check" : "calendar-clock";
          const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
          const gamePath = `/games/${encodeURIComponent(game.gameId)}`;
          const kickoffLabel = formatSeasonKickoff(game.gameStartTs);
          const deleteAction = canManage ? renderManagementDelete(`game at ${kickoffLabel}`,
            status === "finished" ? { "data-game-id": game.gameId } : { "data-action": "delete-game", "data-game-id": game.gameId, "data-kickoff-label": kickoffLabel },
            status === "finished",
            pendingDeletedGameIds.has(game.gameId),
          ) : "";
          return `<tr>
          <td data-label="Date"><a href="${gamePath}">${escapeHtml(kickoffLabel)}</a></td>
          <td data-label="Status"><span data-ui="status-chip" data-status="${escapeHtml(status)}">${renderClientIcon(statusIcon)}<span>${escapeHtml(statusLabel)}</span></span></td>
          <td data-label="Actions">
            ${deleteAction}
          </td>
        </tr>`;
        })
        .join("");

      const renderPanelGames = (panelGames, body, tableWrap, emptyState) => {
        replaceManagementRows(body, renderRows(panelGames));
        if (tableWrap instanceof HTMLElement) {
          tableWrap.hidden = panelGames.length === 0;
        }
        if (emptyState instanceof HTMLElement) {
          emptyState.hidden = panelGames.length > 0;
        }
      };

      renderPanelGames(upcomingGames, upcomingGamesBody, upcomingGamesTableWrap, upcomingGamesEmpty);
      renderPanelGames(completedGames, completedGamesBody, completedGamesTableWrap, completedGamesEmpty);
    }

    let creationPending = false;
    let creationAttempt = null;
    const confirmedSessions = new Set();
    attachFormSubmit("create-game-form", createGameButton, async () => {
      if (!canManage || !leagueId || creationPending) return;
      clearError();

      const gameDate = gameDateInput.value.trim();
      const gameKickoff = gameKickoffInput.value.trim();
      if (!creationAttempt && !gameDate) {
        setFieldMessage("game-date", "invalid", "Game date is required.");
        gameDateInput.focus();
        return;
      }
      setFieldMessage("game-date");

      const kickoffIso = toIsoTimestamp(gameKickoff);
      if (!creationAttempt && !kickoffIso) {
        setFieldMessage("game-kickoff", "invalid", "Kickoff time must be valid.");
        gameKickoffInput.focus();
        return;
      }
      setFieldMessage("game-kickoff");

      const sessionId = gameDate.replaceAll("-", "");
      const gameId = derivedGameId || `game-${sessionId}-${randomSuffix(6)}`;
      if (!creationAttempt) {
        const seasonPath = `/v1/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}`;
        creationAttempt = {
          gameId, sessionConfirmed: confirmedSessions.has(sessionId), sessionId, uncertain: false,
          session: freezeCreationRequest(`${seasonPath}/sessions`, {
            sessionId, sessionDate: gameDate,
          }, "create-session", `${leagueId}-${seasonId}-${sessionId}`),
          game: freezeCreationRequest(`${seasonPath}/sessions/${encodeURIComponent(sessionId)}/games`, {
            gameId, gameStartTs: kickoffIso, status: "scheduled",
            thirdLengthMinutes: parseThirdLengthMinutes(gameThirdLengthInput.value),
          }, "create-game", `${leagueId}-${seasonId}-${sessionId}-${gameId}`),
        };
      }
      creationPending = true;
      createGameButton.disabled = true;
      setStatus("Creating game…", "default");

      try {
        if (!creationAttempt.sessionConfirmed) {
          await requestJsonOrThrow(creationAttempt.session.path, creationAttempt.session.init);
          creationAttempt.sessionConfirmed = true;
          confirmedSessions.add(creationAttempt.sessionId);
          creationAttempt.uncertain = false;
        }
        await requestJsonOrThrow(creationAttempt.game.path, creationAttempt.game.init);
        navigateTo(`/games/${encodeURIComponent(creationAttempt.gameId)}`);
      } catch (error) {
        // Existing game creation may commit before a later team-initialisation
        // conflict returns 409. That response cannot release the game attempt.
        if (isDefinitiveRequestRejection(error) && !creationAttempt.uncertain &&
            !(creationAttempt.sessionConfirmed && error.statusCode === 409)) {
          creationAttempt = null;
          showError(error.message);
          setStatus("Game could not be created.", "error");
        } else {
          creationAttempt.uncertain = true;
          showError("Game creation could not be confirmed. Try again to resend the original details; changes to this draft will not be sent yet.", { includesOutcome: true });
        }
        creationPending = false;
        createGameButton.disabled = false;
      }
    });

    const handleGameListClick = async (event) => {
      const eventTarget = event.target;
      const target = eventTarget instanceof Element ? eventTarget.closest('[data-action="delete-game"]') : null;
      if (!(target instanceof HTMLButtonElement) || !canManage || target.disabled) {
        return;
      }

      const gameId = target.getAttribute("data-game-id");
      if (!gameId || pendingDeletedGameIds.has(gameId) || confirmedDeletedGameIds.has(gameId)) {
        return;
      }

      if (!window.confirm(`Delete game at ${target.getAttribute("data-kickoff-label") || "this kickoff time"}?`)) {
        return;
      }

      const finishFocus = trackDeletedRowFocus(target);
      let committed = false;
      pendingDeletedGameIds.add(gameId);
      target.setAttribute("disabled", "true");
      clearError();
      setStatus(`Deleting game ${gameId}…`, "default");

      try {
        await deleteManagementEntity(`/v1/games/${encodeURIComponent(gameId)}`);
        committed = true;
        confirmedDeletedGameIds.add(gameId);
        for (const action of document.querySelectorAll('tbody [data-game-id]')) {
          if (action.getAttribute("data-game-id") === gameId) action.closest("tr")?.remove();
        }
        try {
          await renderGames();
          setStatus("Game deleted.", "success");
        } catch {
          showError("Game deleted. The list could not be refreshed. Reload this page to see the latest games.", { includesOutcome: true });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not delete game.";
        showError(message);
        setStatus(isDefinitiveRequestRejection(error) ? "Game could not be deleted." : "Game deletion could not be confirmed. Reload the page before trying again.", "error");
      } finally {
        pendingDeletedGameIds.delete(gameId);
        target.removeAttribute("disabled");
        for (const action of document.querySelectorAll('tbody [data-action="delete-game"]')) {
          if (action.getAttribute("data-game-id") === gameId) action.removeAttribute("disabled");
        }
        finishFocus(committed);
      }
    };
    upcomingGamesBody.addEventListener("click", handleGameListClick);
    completedGamesBody.addEventListener("click", handleGameListClick);

    if (deleteSeasonButton instanceof HTMLButtonElement) {
      deleteSeasonButton.addEventListener("click", async () => {
        if (!canManage || !leagueId || deleteSeasonButton.disabled) return;
        if (!window.confirm(`Delete ${seasonName}? This only works when no games remain.`)) {
          return;
        }

        deleteSeasonButton.disabled = true;
        clearError();
        setStatus(`Deleting season ${seasonId}…`, "default");

        try {
          const deleteSeasonPath = `/v1/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}`;
          await deleteManagementEntity(deleteSeasonPath);
          navigateTo(`/leagues/${encodeURIComponent(leagueId)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not delete season.";
          showError(message);
          setStatus(isDefinitiveRequestRejection(error) ? "Season could not be deleted." : "Season deletion could not be confirmed. Reload the page before trying again.", "error");
        } finally {
          deleteSeasonButton.disabled = false;
        }
      });
    }

    await loadSeason();
    await renderGames();
    if (canManage && window.location.hash === "#create-game") {
      setDisclosureState(toggleCreateGameButton, createGameRegion, true);
    }
    setStatus("");
  }

  async function initGamePage(authenticatedSession) {
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
    const goalAssistsDropdown = document.getElementById("goal-assists-dropdown");
    const goalAssistsSummaryElement = document.getElementById("goal-assists-summary");
    const goalAssistsElement = document.getElementById("goal-assists");
    const goalFormNote = document.getElementById("goal-form-note");
    const saveGoalButton = root.querySelector('[data-action="save-goal"]');
    const cancelGoalEditButton = root.querySelector('[data-action="cancel-goal-edit"]');
    const undoLastGoalButton = root.querySelector('[data-action="undo-last-goal"]');
    const goalTimelineElement = document.getElementById("goal-timeline");
    const goalForm = document.getElementById("goal-form");
    const retryGoalButton = root.querySelector('[data-action="retry-goal-operation"]');
    const refreshGameStateButton = root.querySelector('[data-action="refresh-game-state"]');

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
    // Public registration identities are separate from administrator-only
    // search enrichment. null means the additive read is unavailable, not empty.
    let rosterUnassignedPlayers = null;
    let rosterAssignments = [];
    let rosterSearchTimer = 0;
    let existingPlayerAttempt = null;
    let openTransferPlayerId = null;
    let scoreboardTeams = [];
    let scoreboardState = "loading";
    let goalTimeline = [];
    let goalTimelineLoaded = false;
    let finishedResultState = "authoritative";
    let editingGoalId = null;
    let goalMutationInFlight = false;
    let currentLeagueRole = null;
    let currentLeagueName = "League";
    let finishedRosterEditing = false;
    let finishedResultEditing = false;
    let gameMetadataPending = false;
    let gameDeletionPending = false;
    let timerMutationPending = false;
    let rosterMutationPending = false;
    let playerCreatePending = false;
    let playerCreateAttempt = null;
    let rosterReadVersion = 0;
    let playersReadVersion = 0;
    let rosterDataLoaded = false;
    let playerSearchState = "loading";
    let playerNicknameGeneration = 0;
    let playerSearchGeneration = 0;
    const knownRosterPlayers = new Map();
    const verifiedAdminPlayers = new Map();
    const pendingCreatedPlayers = new Map();
    const pendingAssignments = new Map();
    let manualGameModeSelected = false;
    let goalOperation = null;
    let clockOperation = null;
    let gameNavigationRevision = 0;
    const gameModes = ["structure", "players", "run", "final"];
    const gameModeTabs = [...root.querySelectorAll('[data-ui="game-mode-tab"][data-game-mode]')];
    const gameModeTriggers = [...root.querySelectorAll('[data-action="select-game-mode"][data-game-mode]')];
    const gameModePanels = [...root.querySelectorAll('[data-ui="game-mode-panel"][data-game-mode]')];
    let lastHandledGameHash = window.location.hash;
    let metadataDirty = false;
    let refreshAccountLocked = false;
    let refreshWriteLocked = false;
    let authorityRevision = 0;
    let draftRosterChanged = false;
    let editingGoalSnapshot = null;
    let editingGoalChanged = false;
    let refreshingPresentation = false;
    const resultMarkup = new WeakMap();
    for (const field of [kickoffInput, statusInput, thirdLengthInput]) {
      field.addEventListener("input", () => { metadataDirty = true; renderTimer(); });
      field.addEventListener("change", () => { metadataDirty = true; renderTimer(); });
    }

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
      return !refreshAccountLocked && !refreshWriteLocked && currentLeagueRole === "admin" && finishedResultEditing;
    }

    function finishedRosterControlsLocked() {
      return refreshWriteLocked || Boolean(existingPlayerAttempt?.uncertain) || !canManageRoster();
    }

    function isLeagueOperator() {
      return !refreshAccountLocked && (currentLeagueRole === "admin" || currentLeagueRole === "scorekeeper");
    }

    function canManageRoster() {
      return Boolean(currentGame) && isLeagueOperator() && (!isGameFinished() || (currentLeagueRole === "admin" && finishedRosterEditing));
    }

    function canScoreGame() {
      return !refreshWriteLocked && !existingPlayerAttempt?.uncertain && Boolean(currentGame) && isLeagueOperator() && (!isGameFinished() || canCorrectFinishedGoals());
    }

    function canEditGame() {
      return !refreshAccountLocked && !refreshWriteLocked && !existingPlayerAttempt?.uncertain && Boolean(currentGame) && currentLeagueRole === "admin" && !isGameFinished();
    }

    function syncGameCapabilities() {
      if (currentLeagueRole !== "admin") closeActionMenu();
      const capabilities = {
        admin: !refreshAccountLocked && Boolean(currentGame) && currentLeagueRole === "admin",
        roster: !refreshWriteLocked && canManageRoster(),
        score: canScoreGame(),
        correct: !refreshAccountLocked && isGameFinished() && currentLeagueRole === "admin",
      };
      for (const element of document.querySelectorAll("[data-game-capability]")) {
        if (!(element instanceof HTMLElement)) continue;
        const allowed = capabilities[element.getAttribute("data-game-capability")] === true;
        element.hidden = !allowed || (element.hasAttribute("data-hide-when-expanded") && element.getAttribute("aria-expanded") === "true");
        if (element instanceof HTMLAnchorElement) {
          if (allowed) element.removeAttribute("aria-disabled");
          else element.setAttribute("aria-disabled", "true");
          if (element.hasAttribute("data-mode-href")) {
            if (allowed) element.setAttribute("href", element.getAttribute("data-mode-href"));
            else element.removeAttribute("href");
          }
        }
        if (element instanceof HTMLButtonElement) {
          if (!allowed) {
            element.disabled = true;
            element.setAttribute("data-capability-disabled", "true");
          } else if (element.hasAttribute("data-capability-disabled")) {
            element.disabled = false;
            element.removeAttribute("data-capability-disabled");
          }
        }
      }
      const editToggle = document.querySelector('[data-action="toggle-game-edit"]');
      if (editToggle instanceof HTMLButtonElement) {
        editToggle.hidden = !canEditGame();
        editToggle.disabled = !canEditGame() || gameMetadataPending;
      }
      const correctionTeams = root.querySelector('[data-action="edit-finished-teams"]');
      if (correctionTeams instanceof HTMLElement) correctionTeams.hidden = !capabilities.correct || finishedRosterEditing;
      if (correctionTeams instanceof HTMLButtonElement) correctionTeams.disabled = refreshWriteLocked;
      const correctionResult = root.querySelector('[data-action="correct-finished-result"]');
      if (correctionResult instanceof HTMLElement) correctionResult.hidden = !capabilities.correct || finishedResultEditing;
      if (correctionResult instanceof HTMLButtonElement) correctionResult.disabled = refreshWriteLocked;
      setModeLabel("run", isGameFinished() && finishedResultEditing ? "Correction" : "Score game");
      // A remotely finished game must not remove the current destination or
      // silently enter correction mode. The draft remains here until navigation.
      const scoreTab = document.getElementById("game-mode-tab-run");
      if (scoreTab && !refreshAccountLocked && gameModePanels.some((panel) => panel.getAttribute("data-game-mode") === "run" && !panel.hidden)) scoreTab.hidden = false;
      const correctionActions = document.getElementById("finished-correction-actions");
      if (correctionActions) correctionActions.hidden = !capabilities.correct || !finishedResultEditing;
      const exit = root.querySelector('[data-action="exit-result-correction"]');
      const exitLocked = Boolean(goalOperation || clockOperation || goalMutationInFlight || timerMutationPending);
      if (exit instanceof HTMLButtonElement) exit.disabled = exitLocked;
      const exitReason = document.getElementById("correction-exit-reason");
      if (exitReason) exitReason.hidden = !exitLocked;
    }

    function humanGameStatus(value) {
      const labels = {
        scheduled: "Scheduled",
        live: "Live",
        finished: "Finished",
      };
      return labels[value] ?? "Loading";
    }

    function renderGameOverview() {
      if (!currentGame) return;
      const kickoff = document.getElementById("game-overview-kickoff");
      const status = document.getElementById("game-overview-status");
      const thirdLength = document.getElementById("game-overview-third-length");
      if (kickoff) kickoff.textContent = formatSeasonKickoff(currentGame.gameStartTs);
      if (status) status.textContent = humanGameStatus(currentGame.status);
      if (thirdLength) thirdLength.textContent = `${parseThirdLengthMinutes(currentGame.thirdLengthMinutes ?? currentGame.timer?.thirdLengthMinutes)} minutes`;
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
      const previousMode = gameModePanels.find((panel) => !panel.hidden)?.getAttribute("data-game-mode");
      gameNavigationRevision += 1;
      closeActionMenu();
      if (!isGameMode(mode)) {
        mode = isGameFinished() ? "final" : "structure";
      }
      if (mode === "run" && !canScoreGame()) mode = isGameFinished() ? "final" : "structure";
      if (mode === "final" && !isGameFinished()) mode = canScoreGame() && buildTimerState(currentGame)?.status === "complete" ? "run" : "structure";
      if (previousMode !== mode && statusElement?.getAttribute("data-state") === "success" && (!errorElement || errorElement.hidden)) setStatus("");
      const hashes = { structure: "overview", players: "teams", run: "score", final: "results" };
      if (options.history !== false) {
        const hash = `#${hashes[mode]}`;
        if (window.location.hash !== hash) {
          const url = `${window.location.pathname}${window.location.search}${hash}`;
          window.history[options.history === "replace" ? "replaceState" : "pushState"](null, "", url);
        }
      }
      lastHandledGameHash = window.location.hash;

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
        if (tab instanceof HTMLAnchorElement) {
          if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
          tab.removeAttribute("aria-pressed");
        } else tab.setAttribute("aria-pressed", active ? "true" : "false");
        tab.setAttribute("data-state", active ? "active" : "idle");
      }

      for (const trigger of gameModeTriggers) {
        if (trigger instanceof HTMLElement) {
          if (trigger.id === "game-mode-tab-run") trigger.hidden = !canScoreGame();
          trigger.setAttribute("data-current", trigger.getAttribute("data-game-mode") === mode ? "true" : "false");
        }
      }

      if (options.focusPanel === true) {
        const panel = gameModePanels.find((candidate) => candidate.getAttribute("data-game-mode") === mode);
        if (panel instanceof HTMLElement) {
          panel.focus({ preventScroll: true });
          panel.scrollIntoView?.({ block: "start" });
        }
      }
    }

    function beginGameFeedback(message) {
      return { navigation: gameNavigationRevision, revision: setStatus(message, "default") };
    }

    function finishGameFeedback(message, owner) {
      // A late settled success must not replace a newer operation's feedback,
      // or follow the organiser to a different view. Errors/recovery stay put.
      if (owner.revision !== statusRevision || (errorElement && !errorElement.hidden)) return;
      setStatus(owner.navigation === gameNavigationRevision ? message : "", "success");
    }

    function gameModeFromHash() {
      const hashMode = window.location.hash.replace(/^#/, "").replace(/^mode-/, "");
      const aliases = { overview: "structure", teams: "players", score: "run", results: "final" };
      if (aliases[hashMode]) return aliases[hashMode];
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

      return "structure";
    }

    const handleGameHistory = () => {
      if (lastHandledGameHash === window.location.hash || !currentGame) return;
      manualGameModeSelected = true;
      setGameMode(gameModeFromHash() ?? (isGameFinished() ? "final" : "structure"), { history: "replace", focusPanel: true });
    };
    window.addEventListener("popstate", handleGameHistory);
    window.addEventListener("hashchange", handleGameHistory);


    function syncGameModeState() {
      const timer = currentGame ? buildTimerState(currentGame) : null;
      const rosteredCount = rosteredPlayers().length;
      const finished = isGameFinished();
      setModeMeta("structure", humanGameStatus(currentGame?.status));
      setModeMeta("players", `${rosteredCount} assigned`);
      setModeMeta("run", timer ? humanTimerStatus(timer.status) : "Timer");
      setModeLabel("final", "Results");
      setModeMeta("final", "");
      const gameStateTab = root.querySelector('[data-testid="game-mode-final-tab"]');
      if (gameStateTab instanceof HTMLElement) {
        gameStateTab.hidden = !finished;
      }
      syncGameCapabilities();

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


    function syncStatusOptions(hasStarted) {
      const scheduledOption = statusInput.querySelector('option[value="scheduled"]');
      if (scheduledOption instanceof HTMLOptionElement) {
        scheduledOption.disabled = hasStarted;
      }

      if (!metadataDirty && hasStarted && statusInput.value === "scheduled") {
        statusInput.value = currentGame.status === "finished" ? "finished" : "live";
      }
    }

    function metadataRefreshConflict() {
      if (!metadataDirty || !currentGame) return false;
      const timer = buildTimerState(currentGame);
      return timer.thirds.some((third) => third.startedAt !== null) &&
        (statusInput.value === "scheduled" || thirdLengthInput.value !== String(timer.thirdLengthMinutes));
    }

    function renderTimer() {
      if (!currentGame) {
        return;
      }
      syncGameCapabilities();
      renderGameOverview();

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

      if (!metadataDirty && document.getElementById("game-edit-region")?.hidden !== false) thirdLengthInput.value = String(timer.thirdLengthMinutes);
      thirdLengthInput.disabled = !canEditGame() || hasStarted || gameMetadataPending;
      kickoffInput.disabled = !canEditGame() || gameMetadataPending;
      statusInput.disabled = !canEditGame() || gameMetadataPending;
      saveButton.disabled = !canEditGame() || gameMetadataPending || metadataRefreshConflict();
      const metadataNote = document.getElementById("game-edit-refresh-note");
      if (metadataNote) metadataNote.hidden = !metadataRefreshConflict();
      for (const field of [statusInput, thirdLengthInput]) {
        if (metadataRefreshConflict()) field.setAttribute("aria-describedby", "game-edit-refresh-note");
        else field.removeAttribute("aria-describedby");
      }
      deleteButton.hidden = currentLeagueRole !== "admin";
      deleteButton.disabled = refreshAccountLocked || refreshWriteLocked || currentLeagueRole !== "admin" || gameFinished || gameDeletionPending;
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

      const clockBlocked = timerMutationPending || goalMutationInFlight || goalOperation !== null;
      startThirdButton.disabled = clockBlocked || clockOperation !== null || !canScoreGame() || gameFinished || nextThird === null;
      finishThirdButton.disabled = clockBlocked || clockOperation !== null || !canScoreGame() || gameFinished || !activeSegment;
      finishGameButton.disabled = clockBlocked || (clockOperation !== null && clockOperation.kind !== "finish-game") || !canScoreGame() || gameFinished || !allThirdsFinished;
      startThirdButton.textContent = nextThird ? `Start Third ${nextThird}` : "Start Third";
      finishThirdButton.textContent = activeSegment ? `Finish Third ${activeSegment.third}` : "Finish Third";
      finishGameButton.textContent = gameFinished ? "Game finished" : clockOperation?.kind === "finish-game" ? "Retry finish game" : "Finish game";
      if (refreshGameStateButton instanceof HTMLButtonElement) {
        refreshGameStateButton.hidden = !clockOperation?.uncertain;
        refreshGameStateButton.disabled = refreshAccountLocked || refreshWriteLocked || timerMutationPending || !clockOperation?.uncertain;
      }
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
      if (activeSegment && !gameFinished && refreshVisible()) {
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
        goalScoringTeamInput instanceof HTMLFieldSetElement &&
        goalConcedingTeamInput instanceof HTMLFieldSetElement &&
        goalOwnGoalInput instanceof HTMLInputElement &&
        goalScorerInput instanceof HTMLSelectElement &&
        goalAssistsDropdown instanceof HTMLDetailsElement &&
        goalAssistsSummaryElement instanceof HTMLElement &&
        goalAssistsElement instanceof HTMLElement &&
        goalFormNote instanceof HTMLElement &&
        saveGoalButton instanceof HTMLButtonElement &&
        cancelGoalEditButton instanceof HTMLButtonElement &&
        undoLastGoalButton instanceof HTMLButtonElement &&
        goalTimelineElement instanceof HTMLElement &&
        goalForm instanceof HTMLFormElement &&
        retryGoalButton instanceof HTMLButtonElement
      );
    }

    function teamById(teamId) {
      return rosterTeams.find((team) => team.teamId === teamId) ?? null;
    }

    function playerById(playerId) {
      const enrichedPlayer = knownRosterPlayers.get(playerId) ?? rosterPlayers.find((player) => player.playerId === playerId)
        ?? rosterUnassignedPlayers?.find((player) => player.playerId === playerId);
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
      if (!Array.isArray(teams) || teams.length !== 3 ||
        teams.some((team) => !team || typeof team !== "object" || !["red", "blue", "yellow"].includes(team.teamId) ||
          !Number.isSafeInteger(team.scored) || team.scored < 0 || !Number.isSafeInteger(team.conceded) || team.conceded < 0) ||
        new Set(teams.map((team) => team.teamId)).size !== 3) return [];
      return teams.map((team) => ({
        gameId: team.gameId ?? gameId,
        teamId: team.teamId,
        name:
          typeof team.name === "string" && team.name.length > 0
            ? team.name
            : ({ red: "Red", blue: "Blue", yellow: "Yellow" }[team.teamId]),
        color: typeof team.color === "string" ? team.color : null,
        scored: team.scored,
        conceded: team.conceded,
        createdAt: team.createdAt ?? "",
        updatedAt: team.updatedAt ?? "",
      }));
    }

    function scoreboardTeamsInRosterOrder() {
      return teamsInMatchOrder(scoreboardTeams);
    }

    function decodeGoalTimeline(value) {
      if (!Array.isArray(value)) return null;
      const ids = new Set();
      for (const goal of value) {
        if (!goal || typeof goal !== "object" || Array.isArray(goal) || goal.gameId !== gameId ||
          !usableEntityId(goal.eventId) || ids.has(goal.eventId) || !usableEntityId(goal.scorerPlayerId) ||
          typeof goal.ownGoal !== "boolean" || !["red", "blue", "yellow"].includes(goal.concedingTeamId) ||
          (goal.ownGoal ? goal.scoringTeamId !== null : !["red", "blue", "yellow"].includes(goal.scoringTeamId) || goal.scoringTeamId === goal.concedingTeamId) ||
          !Number.isInteger(goal.third) || goal.third < 1 || goal.third > 3 ||
          !Number.isSafeInteger(goal.thirdMinute) || goal.thirdMinute < 1 ||
          !Number.isSafeInteger(goal.gameMinute) || goal.gameMinute < 0 ||
          !Number.isSafeInteger(goal.elapsedSeconds) || goal.elapsedSeconds < 0 ||
          (goal.stoppageMinute !== null && (!Number.isSafeInteger(goal.stoppageMinute) || goal.stoppageMinute < 1)) ||
          typeof goal.createdAt !== "string" || !Number.isFinite(Date.parse(goal.createdAt)) ||
          !Array.isArray(goal.assistPlayerIds) || goal.assistPlayerIds.length > 3 ||
          goal.assistPlayerIds.some((id) => !usableEntityId(id) || id === goal.scorerPlayerId) ||
          new Set(goal.assistPlayerIds).size !== goal.assistPlayerIds.length) return null;
        ids.add(goal.eventId);
      }
      return sortGoalTimeline(value);
    }

    function teamsInMatchOrder(teams) {
      const order = new Map([["red", 0], ["blue", 1], ["yellow", 2]]);
      return [...teams].sort((left, right) => (order.get(left.teamId) ?? 3) - (order.get(right.teamId) ?? 3));
    }

    function selectedGoalTeam(group) {
      return group?.querySelector('input[type="radio"]:checked')?.value ?? "";
    }

    function renderGoalTeamChoices(group, selectedValue, disabledTeamId = null) {
      const options = group.querySelector('[data-ui="goal-team-options"]');
      if (!(options instanceof HTMLElement)) return;
      options.innerHTML = teamsInMatchOrder(rosterTeams).map((team) => {
        const disabled = team.teamId === disabledTeamId;
        const checked = !disabled && team.teamId === selectedValue;
        return `<label data-ui="goal-team-choice"${teamSwatchStyle(team)}>
          <input type="radio" name="${escapeHtml(group.id)}" value="${escapeHtml(team.teamId)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""} />
          <span data-ui="team-swatch" aria-hidden="true"></span><span>${escapeHtml(team.name)}</span>
        </label>`;
      }).join("");
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

    function fallbackTeamColor(teamId) {
      const knownColors = new Map([
        ["red", "#d64545"],
        ["blue", "#2f6fcb"],
        ["yellow", "#d4a800"],
      ]);
      const knownColor = knownColors.get(teamId);
      if (knownColor) {
        return knownColor;
      }

      const palette = ["#477a70", "#8a5b9b", "#b5663d", "#387c94", "#7a7139"];
      const hash = [...String(teamId || "unknown")]
        .reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
      return palette[hash % palette.length];
    }

    function resolvedTeamColors(extraTeam = null, fallbackTeamId = "") {
      const availableTeams = rosterTeams.length > 0 ? rosterTeams : scoreboardTeams;
      const teamsById = new Map();
      for (const team of availableTeams) {
        if (team && typeof team.teamId === "string" && team.teamId.length > 0) {
          teamsById.set(team.teamId, team);
        }
      }
      for (const goal of goalTimeline) {
        for (const id of [goal?.scoringTeamId, goal?.concedingTeamId]) {
          const normalizedId = id === null || id === undefined ? "" : String(id);
          if (normalizedId.length > 0 && !teamsById.has(normalizedId)) {
            teamsById.set(normalizedId, { teamId: normalizedId, color: null });
          }
        }
      }
      const extraTeamId = typeof extraTeam?.teamId === "string" && extraTeam.teamId.length > 0
        ? extraTeam.teamId
        : String(fallbackTeamId || "");
      if (extraTeamId.length > 0 && !teamsById.has(extraTeamId)) {
        teamsById.set(extraTeamId, extraTeam ?? teamById(extraTeamId) ?? { teamId: extraTeamId, color: null });
      }

      const opaqueColor = (value) => {
        if (typeof value !== "string") {
          return null;
        }
        const match = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
        if (!match) {
          return null;
        }
        const hex = match[1].toLowerCase();
        if (hex.length === 4) {
          return hex[3] === "f"
            ? `#${[...hex.slice(0, 3)].map((character) => `${character}${character}`).join("")}`
            : null;
        }
        if (hex.length === 8) {
          return hex.endsWith("ff") ? `#${hex.slice(0, 6)}` : null;
        }
        return hex.length === 3
          ? `#${[...hex].map((character) => `${character}${character}`).join("")}`
          : `#${hex}`;
      };
      const colorCounts = new Map();
      for (const team of teamsById.values()) {
        const color = opaqueColor(team.color);
        if (color) {
          colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
        }
      }

      const colors = new Map();
      const usedColors = new Set();
      for (const [id, team] of teamsById) {
        const color = opaqueColor(team.color);
        if (color && colorCounts.get(color) === 1) {
          colors.set(id, color);
          usedColors.add(color);
        }
      }

      const fallbackPalette = [
        "#d64545",
        "#2f6fcb",
        "#d4a800",
        "#477a70",
        "#8a5b9b",
        "#b5663d",
        "#387c94",
        "#7a7139",
      ];
      for (const id of teamsById.keys()) {
        if (colors.has(id)) {
          continue;
        }
        const preferredColor = fallbackTeamColor(id);
        let color = [preferredColor, ...fallbackPalette].find((candidate) => !usedColors.has(candidate));
        if (!color) {
          const base = [...String(id || "unknown")]
            .reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
          let attempt = 0;
          do {
            color = `#${((base + (attempt * 2654435761)) & 0xffffff).toString(16).padStart(6, "0")}`;
            attempt += 1;
          } while (usedColors.has(color));
        }
        colors.set(id, color);
        usedColors.add(color);
      }

      return colors;
    }

    function teamSwatchStyle(team, fallbackTeamId = "") {
      const teamId = typeof team?.teamId === "string" && team.teamId.length > 0
        ? team.teamId
        : String(fallbackTeamId || "unknown");
      const color = resolvedTeamColors(team, teamId).get(teamId) ?? fallbackTeamColor(teamId);
      return ` style="--team-color: ${escapeHtml(color)}"`;
    }

    function goalTeamDotStyle(teamId) {
      const normalizedTeamId = String(teamId ?? "Unknown team");
      const team = teamById(normalizedTeamId) ?? { teamId: normalizedTeamId, color: null };
      const color = resolvedTeamColors(team, normalizedTeamId).get(normalizedTeamId)
        ?? fallbackTeamColor(normalizedTeamId);
      return ` style="--team-color: ${escapeHtml(color)}"`;
    }

    function resultTeams() {
      return teamsInMatchOrder(normalizeScoreboardTeams(currentGame?.result?.teams));
    }

    function resultOutcome(teams, result = currentGame?.result) {
      if (teams.length !== 3 || !result || !["win", "draw"].includes(result.outcome)) return null;
      // Check the supplied outcome against the same conceded/scored comparator,
      // never replace it with a newly computed winner when the response differs.
      const ranked = [...teams].sort((left, right) => left.conceded - right.conceded || right.scored - left.scored);
      const leaders = ranked.filter((team) => team.conceded === ranked[0].conceded && team.scored === ranked[0].scored);
      if (result.outcome === "draw") return result.winnerTeamId === null && leaders.length > 1 ? { kind: "draw", text: "Draw" } : null;
      return leaders.length === 1 && leaders[0].teamId === result.winnerTeamId ? { kind: "win", text: `${leaders[0].name} win` } : null;
    }

    function patchReadOnlyMarkup(surface, markup) {
      // Retain actual controls/disclosures while read-only siblings change.
      // Restore opaque IDs before comparing keys: HTML normalizes CR/NUL.
      const template = document.createElement("template");
      template.innerHTML = markup;
      restorePlayerIdentities(template.content);
      const active = document.activeElement;
      const ownedFocus = surface.contains(active);
      const key = (node) => node.nodeType === Node.ELEMENT_NODE
        ? JSON.stringify([node.tagName, node.id, ...["data-ui", "data-testid", "data-event-id", "data-player-id", "data-team-id", "data-action", "data-role", "data-context"].map((name) => node.getAttribute(name))])
        : String(node.nodeType);
      const identities = new Map();
      for (const node of surface.querySelectorAll("[data-player-id], [data-event-id]")) {
        const identity = key(node);
        identities.set(identity, identities.has(identity) ? null : node);
      }
      const retained = new Set();
      const obsolete = [];
      const runtimeAttribute = (node, name) =>
        (node instanceof HTMLDetailsElement && name === "open") ||
        (node === openActionMenu?.trigger && name === "aria-expanded") ||
        (node === openActionMenu?.surface && ["hidden", "style", "popover"].includes(name));
      function patch(parent, nextParent) {
        const previous = [...parent.childNodes];
        [...nextParent.childNodes].forEach((next, index) => {
          let node = previous.find((candidate) => !retained.has(candidate) && key(candidate) === key(next));
          const identified = identities.get(key(next));
          if (!node && identified && !retained.has(identified)) node = identified;
          if (!node) node = next.cloneNode(true);
          else if (node.nodeType === Node.ELEMENT_NODE) {
            for (const attribute of [...node.attributes]) {
              if (!runtimeAttribute(node, attribute.name) && !next.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
            }
            for (const attribute of [...next.attributes]) {
              if (!runtimeAttribute(node, attribute.name) && node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
            }
            patch(node, next);
          } else if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
          retained.add(node);
          if (parent.childNodes[index] !== node) {
            const before = parent.childNodes[index] ?? null;
            // moveBefore preserves focus/popovers when a player changes teams;
            // the fallback restores owned focus below without scrolling.
            if (node.isConnected && typeof parent.moveBefore === "function") parent.moveBefore(node, before);
            else parent.insertBefore(node, before);
          }
        });
        obsolete.push(...previous);
      }
      patch(surface, template.content);
      // Defer removals so keyed rows can move out of an earlier team list.
      for (const node of obsolete) if (!retained.has(node)) node.remove();
      if (ownedFocus && (!active.isConnected || active.matches(":disabled") || !actionElementVisible(active))) {
        // Local mutation callbacks own their eventual focus destination. An
        // interim surface focus would look like the user leaving that operation
        // to trackInteractionFocus, preventing its exact-player restoration.
        const mutationPending = gameMetadataPending || gameDeletionPending || goalMutationInFlight ||
          timerMutationPending || rosterMutationPending || playerCreatePending;
        if (!mutationPending && actionElementVisible(surface)) {
          surface.setAttribute("tabindex", "-1");
          surface.focus({ preventScroll: true });
        }
      } else if (ownedFocus && document.activeElement !== active) {
        active.focus({ preventScroll: true });
      }
    }

    function updateResultMarkup(markup) {
      if (resultMarkup.get(gameResultSummaryElement) === markup) return;
      patchReadOnlyMarkup(gameResultSummaryElement, markup);
      resultMarkup.set(gameResultSummaryElement, markup);
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
            ? refreshWriteLocked ? "The correction outcome could not be confirmed. Reload this game before making more changes." : "The correction outcome could not be confirmed. Retry the same action."
            : "The latest match result could not be loaded. Reload to try again.";
        gameResultSummaryElement.hidden = false;
        updateResultMarkup(`<section data-ui="result-board" data-state="unavailable">
          <header>
            <span>Final result</span>
            <strong>${heading}</strong>
          </header>
          <p data-ui="empty-note">${message}</p>
        </section>`);
        syncGameModeState();
        return;
      }

      const teams = resultTeams();
      if (!isGameFinished()) {
        gameResultSummaryElement.hidden = true;
        updateResultMarkup("");
        syncGameModeState();
        return;
      }

      const outcome = resultOutcome(teams);
      const goalLogsLoaded = goalTimelineLoaded;
      gameResultSummaryElement.hidden = false;
      updateResultMarkup(`<section data-ui="result-board"${outcome ? ` data-outcome="${outcome.kind}"` : ' data-state="unavailable"'}>
        <header>
          ${outcome ? `<strong data-testid="game-result-outcome">${escapeHtml(outcome.text)}</strong>` : '<strong data-testid="result-unavailable">Result unavailable</strong><p data-ui="empty-note">The match result could not be loaded. Reload to try again.</p>'}
        </header>
        ${teams.length > 0 ? `<div data-ui="result-team-list" data-testid="game-result-teams">
          ${teams
            .map((team) => {
              return `<article data-ui="result-team" data-team-id="${escapeHtml(team.teamId)}"${teamSwatchStyle(team)}>
                <header>
                  <span data-ui="team-swatch" aria-hidden="true"></span>
                  <strong>${escapeHtml(team.name)}</strong>
                </header>
                <dl>
                  <div><dt>Conceded</dt><dd>${escapeHtml(String(team.conceded))}</dd></div>
                  <div><dt>Scored</dt><dd>${escapeHtml(String(team.scored))}</dd></div>
                </dl>
              </article>`;
            })
            .join("")}
        </div>` : ""}
        ${goalLogsLoaded ? `${renderFinalAggregateStats()}${renderFinalFullGoalLog()}` : renderFinalGoalSummariesUnavailable()}
      </section>`);
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
      // HTML attribute parsing normalizes CR and NUL. Restore opaque record
      // values through DOM properties before selecting an existing identity.
      const renderedValues = options.length > 0 || preservesMissingSelection
        ? [...(includePlaceholder ? [""] : []), ...(preservesMissingSelection ? [selectedValue] : []), ...options.map((option) => option.value)]
        : [""];
      renderedValues.forEach((value, index) => { selectElement.options[index].value = value; });
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
      if (!(goalAssistsElement instanceof HTMLElement) || !(goalAssistsSummaryElement instanceof HTMLElement)) {
        return;
      }

      const rostered = rosteredPlayers().filter((player) => player.playerId !== scorerPlayerId);
      if (goalOperation) seedAssistPlayerIds = goalOperation.draft.assistPlayerIds;
      const seeded = seedAssistPlayerIds ?? selectedAssistPlayerIds();
      const selected = new Set(seeded.filter((playerId) => playerId !== scorerPlayerId).slice(0, 3));
      // An unresolved request retains its original display as well as payload,
      // even when a later roster read no longer contains an original assister.
      for (const player of goalOperation?.assistPlayers ?? []) {
        if (selected.has(player.playerId) && !rostered.some((candidate) => candidate.playerId === player.playerId)) rostered.push(player);
      }
      if (draftRosterChanged) {
        for (const playerId of selected) {
          if (!rostered.some((player) => player.playerId === playerId)) rostered.push({ playerId, nickname: playerNickname(playerId), teamId: "" });
        }
      }

      if (rostered.length === 0) {
        goalAssistsElement.innerHTML = `<p data-ui="empty-note">No assist options yet.</p>`;
        goalAssistsSummaryElement.textContent = "No options";
        goalAssistsSummaryElement.removeAttribute("title");
        return;
      }

      const selectedNames = rostered
        .filter((player) => selected.has(player.playerId))
        .map((player) => player.nickname);
      goalAssistsSummaryElement.textContent = selectedNames.length === 0
        ? "Choose assists"
        : `${selectedNames.length} selected: ${selectedNames.join(", ")}`;
      if (selectedNames.length > 0) {
        goalAssistsSummaryElement.title = selectedNames.join(", ");
      } else {
        goalAssistsSummaryElement.removeAttribute("title");
      }

      goalAssistsElement.innerHTML = rostered
        .map((player) => {
          const checked = selected.has(player.playerId);
          const disabled = !canScoreGame() || goalMutationInFlight || goalOperation !== null || timerMutationPending || clockOperation !== null || !scorerPlayerId || (!checked && selected.size >= 3);
          return `<label data-ui="check-row">
            <input type="checkbox" value="${escapeHtml(player.playerId)}"${checked ? " checked" : ""}${
              disabled ? " disabled" : ""
            } />
            <span>${escapeHtml(player.nickname)} <small>${escapeHtml(teamName(player.teamId))}</small></span>
          </label>`;
        })
        .join("");
      goalAssistsElement.querySelectorAll('input[type="checkbox"]').forEach((input, index) => {
        // Keep the submitted player identity exact, independent of HTML parsing.
        input.value = rostered[index].playerId;
      });
    }

    function renderGoalControls(seed = {}, preserveNodes = false) {
      if (!liveControlsAvailable()) {
        return;
      }

      if (!preserveNodes) {
      if (goalOperation) seed = goalOperation.draft;
      const ownGoal = seed.ownGoal ?? goalOwnGoalInput.checked;
      const previousScoringTeamId = seed.scoringTeamId ?? selectedGoalTeam(goalScoringTeamInput);
      const previousConcedingTeamId = seed.concedingTeamId ?? selectedGoalTeam(goalConcedingTeamInput);

      goalOwnGoalInput.checked = ownGoal;
      renderGoalTeamChoices(goalScoringTeamInput, ownGoal ? "" : previousScoringTeamId);
      goalScoringTeamInput.disabled = ownGoal;
      const scoringTeamId = ownGoal ? null : selectedGoalTeam(goalScoringTeamInput);
      renderGoalTeamChoices(goalConcedingTeamInput, previousConcedingTeamId, scoringTeamId);
      goalConcedingTeamInput.disabled = !ownGoal && !scoringTeamId;
      const concedingTeamId = selectedGoalTeam(goalConcedingTeamInput);
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
      const selectedScorerLabel = selectedScorerId && (canPreserveHistoricalScorer || goalOperation !== null || draftRosterChanged)
        ? `${playerNickname(selectedScorerId)} (not currently rostered)`
        : null;
      renderSelectOptions(
        goalScorerInput,
        scorerOptions,
        selectedScorerId,
        "Choose scorer",
        selectedScorerLabel,
        true,
      );
      if (!concedingTeamId || (!ownGoal && !scoringTeamId)) {
        goalScorerInput.disabled = true;
      }
      renderGoalAssistChoices(goalScorerInput.value, seed.assistPlayerIds ?? null);
      }

      const activeThird = activeThirdNumber();
      const gameFinished = isGameFinished();
      const finishedCorrectionsAllowed = canCorrectFinishedGoals();
      const creatingFinishedCorrection = gameFinished && finishedCorrectionsAllowed && !isEditingGoal();
      saveGoalButton.textContent = editingGoalId ? "Save changes" : "Record goal";
      cancelGoalEditButton.hidden = editingGoalId === null;
      cancelGoalEditButton.disabled = editingGoalId === null;
      undoLastGoalButton.disabled =
        goalMutationInFlight ||
        goalOperation !== null || timerMutationPending || clockOperation !== null ||
        !goalTimelineLoaded ||
        goalTimeline.length === 0 ||
        !canScoreGame();
      undoLastGoalButton.textContent = "Undo last goal";
      retryGoalButton.hidden = goalOperation?.uncertain !== true;
      retryGoalButton.disabled = goalMutationInFlight || timerMutationPending || clockOperation !== null || !canScoreGame() || goalOperation?.uncertain !== true;
      retryGoalButton.textContent = goalOperation?.kind === "delete" ? "Retry goal deletion" : goalOperation?.kind === "undo" ? "Retry undo" : "Retry goal save";
      const recovery = document.getElementById("goal-operation-recovery");
      if (recovery instanceof HTMLElement) recovery.hidden = retryGoalButton.hidden;
      const recoveryNote = document.getElementById("goal-operation-note");
      if (recoveryNote instanceof HTMLElement) recoveryNote.textContent = refreshWriteLocked ? "Reload this game before making more changes." : goalOperation?.kind === "delete" ? "Retry targets the same goal."
        : goalOperation?.kind === "undo" ? "Retry targets the original goal, even if another has been recorded." : "Retry uses the original goal details.";

      if (refreshWriteLocked || goalMutationInFlight || goalOperation !== null || timerMutationPending || clockOperation !== null) {
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
        goalFormNote.textContent = refreshWriteLocked ? "Reload this game before making more changes." : goalOperation?.uncertain ? "The goal change is unconfirmed. Retry the same action."
          : clockOperation?.uncertain ? "Check the clock before recording another goal."
            : goalMutationInFlight ? "Saving goal change…" : "Updating clock…";
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

      if (!canScoreGame()) {
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
        goalFormNote.textContent = gameFinished
          ? currentLeagueRole === "admin"
            ? "Choose Correct result to edit this finished game."
            : "Ask a league organiser to correct this result."
          : "Scoring is unavailable for this account.";
        return;
      }

      if (preserveNodes) {
        const own = goalOwnGoalInput.checked;
        const scoring = selectedGoalTeam(goalScoringTeamInput);
        const conceding = selectedGoalTeam(goalConcedingTeamInput);
        goalScoringTeamInput.disabled = own;
        goalConcedingTeamInput.disabled = !own && !scoring;
        goalScorerInput.disabled = !conceding || (!own && !scoring);
        const selected = selectedAssistPlayerIds();
        for (const input of goalAssistsElement.querySelectorAll("input")) input.disabled = !goalScorerInput.value || (!input.checked && selected.length >= 3);
      }
      goalOwnGoalInput.disabled = false;
      saveGoalButton.disabled = false;

      const conflict = goalDraftConflict();
      if (conflict) {
        saveGoalButton.disabled = true;
        goalFormNote.textContent = conflict;
        return;
      }

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

      if (!goalOwnGoalInput.checked && !selectedGoalTeam(goalScoringTeamInput)) {
        saveGoalButton.disabled = true;
        goalFormNote.textContent = "";
        return;
      }

      if (!selectedGoalTeam(goalConcedingTeamInput)) {
        saveGoalButton.disabled = true;
        goalFormNote.textContent = "";
        return;
      }

      if (!goalScorerInput.value) {
        saveGoalButton.disabled = true;
        goalFormNote.textContent = "";
        return;
      }

      if (editingGoalId) {
        saveGoalButton.disabled = false;
        goalFormNote.textContent = "Editing keeps the original time.";
        return;
      }

      if (!activeThird) {
        saveGoalButton.disabled = !creatingFinishedCorrection;
        goalFormNote.textContent = creatingFinishedCorrection
          ? ""
          : "Start a third before recording goals.";
        return;
      }

      saveGoalButton.disabled = false;
      goalFormNote.textContent = "";
    }

    function refreshGoalOptions() {
      // Keep the native select, checkboxes and open disclosure alive. Reconcile
      // choices by opaque identity; never drop a selected stale draft value.
      const scorer = goalScorerInput.value;
      const own = goalOwnGoalInput.checked;
      const team = selectedGoalTeam(own ? goalConcedingTeamInput : goalScoringTeamInput);
      const options = new Map(rosteredPlayersForTeam(team).map((player) => [player.playerId, player]));
      for (const option of [...goalScorerInput.options]) {
        if (!option.value) continue;
        if (!options.has(option.value) && option.value !== scorer) option.remove();
        else if (options.has(option.value)) option.textContent = options.get(option.value).nickname;
      }
      for (const player of options.values()) {
        if (![...goalScorerInput.options].some((option) => option.value === player.playerId)) {
          const option = document.createElement("option");
          option.value = player.playerId;
          option.textContent = player.nickname;
          goalScorerInput.append(option);
        }
      }
      goalScorerInput.value = scorer;
      const players = new Map(rosteredPlayers().filter((player) => player.playerId !== scorer).map((player) => [player.playerId, player]));
      for (const input of [...goalAssistsElement.querySelectorAll("input")]) {
        if (!players.has(input.value) && !input.checked && input !== document.activeElement) input.closest("label")?.remove();
      }
      if (players.size) goalAssistsElement.querySelector('[data-ui="empty-note"]')?.remove();
      for (const player of players.values()) {
        let input = [...goalAssistsElement.querySelectorAll("input")].find((candidate) => candidate.value === player.playerId);
        if (!input) {
          const label = document.createElement("label");
          label.setAttribute("data-ui", "check-row");
          input = document.createElement("input");
          input.type = "checkbox";
          input.value = player.playerId;
          label.append(input, document.createElement("span"));
          goalAssistsElement.append(label);
        }
        const label = input.closest("label")?.querySelector("span");
        if (label) label.textContent = `${player.nickname} ${teamName(player.teamId)}`;
      }
      const selectedNames = selectedAssistPlayerIds().map((id) => playerNickname(id));
      goalAssistsSummaryElement.textContent = selectedNames.length ? `${selectedNames.length} selected: ${selectedNames.join(", ")}` : "Choose assists";
      if (selectedNames.length) goalAssistsSummaryElement.title = selectedNames.join(", ");
      else goalAssistsSummaryElement.removeAttribute("title");
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
      const accessibleName = relationship ? `${relationship}: ${name}` : name;
      return `<span data-ui="goal-team-chip" data-display="dot" role="img" data-team-id="${escapeHtml(String(teamId ?? ""))}"${
        goalTeamDotStyle(String(teamId ?? "Unknown team"))
      } aria-label="${escapeHtml(accessibleName)}" title="${escapeHtml(accessibleName)}"><span data-ui="team-swatch" aria-hidden="true"></span></span>`;
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

    function renderFinalGoalItems(goals, emptyText) {
      if (goals.length === 0) {
        return `<li data-ui="empty-note">${escapeHtml(emptyText)}</li>`;
      }

      return goals
        .map((goal) => {
          return `<li data-ui="final-goal-item" data-event-id="${escapeHtml(goal.eventId)}" data-has-third="true">
            <span data-ui="goal-time">${escapeHtml(goalDisplayTime(goal))}</span>
            <div data-ui="final-goal-details">
              <strong>${escapeHtml(playerNickname(goal.scorerPlayerId))}</strong>
              <span data-ui="goal-team-relationship">${goal.ownGoal ? '<span data-ui="own-goal-marker" aria-label="Own goal">OG</span>' : renderGoalTeamChip(goal.scoringTeamId, "Scoring team")}
                <span data-ui="goal-team-arrow" aria-hidden="true">→</span>${renderGoalTeamChip(goal.concedingTeamId, "Conceding team")}
              </span>
              ${goal.assistPlayerIds.length ? `<small>Assists: ${escapeHtml(goal.assistPlayerIds.map((id) => playerNickname(id)).join(", "))}</small>` : ""}
            </div>
            ${renderThirdIndicator(goal.third)}
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
          <h3>Own goals</h3>
          ${renderPlayerStatList(stats.ownGoals, "No own goals.")}
        </section>`
        : "";

      return `<section data-ui="final-aggregate-stats" data-testid="final-aggregate-stats" aria-label="Player statistics">
        <section data-ui="final-stat-card" data-testid="final-scorer-stats">
          <h3>Goals</h3>
          ${renderPlayerStatList(stats.scorers, "No scorers recorded.")}
        </section>
        <section data-ui="final-stat-card" data-testid="final-assist-stats">
          <h3>Assists</h3>
          ${renderPlayerStatList(stats.assists, "No assists recorded.")}
        </section>
        ${ownGoalStats}
      </section>`;
    }

    function renderFinalGoalSummariesUnavailable() {
      return `<section data-ui="final-goal-unavailable" data-testid="final-goal-summary-unavailable" aria-label="Goal summaries unavailable">
        <h3>Goal summaries unavailable</h3>
        <p data-ui="empty-note">Player contributions and the match log could not be loaded. Reload to try again.</p>
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
      const patchTimeline = (markup) => patchReadOnlyMarkup(goalTimelineElement, markup);

      if (!goalTimelineLoaded) {
        patchTimeline(`<li data-ui="empty-note">Goal timeline unavailable.</li>`);
        return;
      }

      if (goalTimeline.length === 0) {
        patchTimeline(`<li data-ui="empty-note">No goals yet.</li>`);
        return;
      }

      const latestEventId = goalTimeline.at(-1)?.eventId ?? null;
      const finishedActionsDisabled =
        goalMutationInFlight || goalOperation !== null || timerMutationPending || clockOperation !== null || !canScoreGame();
      patchTimeline([...goalTimeline]
        .reverse()
        .map((goal, index) => {
          const assists =
            Array.isArray(goal.assistPlayerIds) && goal.assistPlayerIds.length > 0
              ? goal.assistPlayerIds.map((playerId) => playerNickname(playerId)).join(", ")
              : "";
          const latest = goal.eventId === latestEventId;
          const displayTime = goalDisplayTime(goal);
          const scorer = String(playerNickname(goal.scorerPlayerId));
          const eventId = String(goal.eventId ?? "");
          const addressable = goalEventControlAvailable(eventId);
          const disabledAttribute = finishedActionsDisabled || !addressable ? " disabled" : "";
          const unavailableId = `goal-action-unavailable-${index}`;
          const reasonAttribute = addressable ? "" : ` aria-describedby="${unavailableId}"`;
          const scoringContext = goal.ownGoal
            ? `<span data-ui="own-goal-marker" aria-label="Own goal">OG</span>`
            : renderGoalTeamChip(goal.scoringTeamId, "Scoring team");
          return `<li data-ui="goal-event" data-event-id="${escapeHtml(eventId)}"${
            latest ? ' data-state="latest"' : ""
          }>
            <div data-ui="goal-event-main">
              <div data-ui="goal-primary-row">
                <strong data-ui="goal-time">${escapeHtml(displayTime)}</strong>
                <span data-ui="goal-scorer" title="${escapeHtml(scorer)}">${escapeHtml(scorer)}</span>
                <span data-ui="goal-team-relationship">${scoringContext}
                  <span data-ui="goal-team-arrow" aria-hidden="true">→</span>
                  ${renderGoalTeamChip(goal.concedingTeamId, "Conceding team")}
                </span>
                ${renderThirdIndicator(goal.third)}
              </div>
              ${assists ? `<small>Assists: ${escapeHtml(assists)}</small>` : ""}
              ${addressable ? "" : `<small id="${unavailableId}">Editing isn’t available for this goal.</small>`}
            </div>
            <div data-ui="row-action-buttons">
              <button data-ui="icon-button" type="button" data-action="edit-goal" data-event-id="${escapeHtml(
                addressable ? eventId : "",
              )}" aria-label="Edit ${escapeHtml(scorer)} goal at ${escapeHtml(displayTime)}" title="Edit goal"${reasonAttribute}${
                disabledAttribute
              }>${renderClientIcon("pencil")}</button>
              <button data-ui="icon-button" data-variant="danger" type="button" data-action="delete-goal" data-event-id="${escapeHtml(
                addressable ? eventId : "",
              )}" aria-label="Delete ${escapeHtml(scorer)} goal at ${escapeHtml(displayTime)}" title="Delete goal"${reasonAttribute}${
                disabledAttribute
              }>${renderClientIcon("trash-2")}</button>
            </div>
          </li>`;
        })
        .join(""));
    }

    function renderLiveScoring(seed = {}) {
      const focus = captureScoringFocus();
      renderLiveScoreboard();
      if (liveControlsAvailable()) renderGoalControls(seed);
      renderGoalTimeline();
      renderGameResult();
      syncGameModeState();
      restoreScoringFocus(focus);
    }

    function captureScoringFocus() {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || (!goalForm?.contains(active) && !goalTimelineElement?.contains(active))) return null;
      return {
        id: active.id, action: active.getAttribute("data-action"), eventId: active.getAttribute("data-event-id"),
        group: active.closest('[data-ui="goal-team-options"]')?.parentElement?.id,
        value: active instanceof HTMLInputElement ? active.value : null,
      };
    }

    function restoreScoringFocus(focus) {
      if (!focus) return;
      let target = focus.id ? document.getElementById(focus.id) : null;
      if (focus.group) target = [...(document.getElementById(focus.group)?.querySelectorAll('input[type="radio"]') ?? [])].find((input) => input.value === focus.value);
      else if (!target && focus.value) target = [...(goalAssistsElement?.querySelectorAll('input[type="checkbox"]') ?? [])].find((input) => input.value === focus.value);
      else if (!target && focus.action) target = [...root.querySelectorAll('button[data-action]')].find((button) => button.getAttribute("data-action") === focus.action && button.getAttribute("data-event-id") === focus.eventId);
      if (target instanceof HTMLElement && !target.matches(":disabled") && actionElementVisible(target)) target.focus({ preventScroll: true });
    }

    function applyGoalMutationResult(result) {
      scoreboardState = "refreshing";
      const teams = normalizeScoreboardTeams(result?.scoreboard?.teams);
      if (teams.length) scoreboardTeams = teams;
      const timeline = decodeGoalTimeline(result?.timeline);
      goalTimelineLoaded = timeline !== null;
      goalTimeline = timeline ?? [];

      renderLiveScoring();
    }

    function resetGoalForm() {
      editingGoalId = null;
      editingGoalSnapshot = null;
      editingGoalChanged = false;
      draftRosterChanged = false;
      if (goalOwnGoalInput instanceof HTMLInputElement) {
        goalOwnGoalInput.checked = false;
      }
      for (const input of root.querySelectorAll('#goal-scoring-team input, #goal-conceding-team input')) input.checked = false;
      if (goalScorerInput instanceof HTMLSelectElement) {
        goalScorerInput.value = "";
      }
      for (const input of goalAssistsElement?.querySelectorAll('input[type="checkbox"]') ?? []) {
        if (input instanceof HTMLInputElement) {
          input.checked = false;
        }
      }
      if (goalAssistsDropdown instanceof HTMLDetailsElement) {
        goalAssistsDropdown.open = false;
      }
      renderLiveScoring({
        ownGoal: false,
        scoringTeamId: "",
        concedingTeamId: "",
        scorerPlayerId: "",
        assistPlayerIds: [],
      });
    }

    function goalDraftConflict() {
      if (editingGoalChanged) return "This goal changed in another session. Cancel this edit and open the latest goal.";
      if (!draftRosterChanged) return null;
      const scorer = goalScorerInput.value;
      const own = goalOwnGoalInput.checked;
      const scoring = own ? null : selectedGoalTeam(goalScoringTeamInput);
      const conceding = selectedGoalTeam(goalConcedingTeamInput);
      const original = editingGoalId ? goalTimeline.find((goal) => goal.eventId === editingGoalId) : null;
      const historicalScorer = original && original.scorerPlayerId === scorer && original.ownGoal === own &&
        original.scoringTeamId === scoring && original.concedingTeamId === conceding;
      const ids = new Set(rosteredPlayers().map((player) => player.playerId));
      if ((scorer && !historicalScorer && !rosteredPlayersForTeam(own ? conceding : scoring).some((player) => player.playerId === scorer)) ||
        selectedAssistPlayerIds().some((id) => !ids.has(id) && !original?.assistPlayerIds.includes(id))) {
        return "Teams changed. Review the scorer and assists before saving.";
      }
      return null;
    }

    function populateGoalForm(goal) {
      editingGoalId = goal.eventId;
      editingGoalSnapshot = JSON.stringify(goal);
      editingGoalChanged = false;
      draftRosterChanged = false;
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
      const conflict = goalDraftConflict();
      if (conflict) return { error: conflict };
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
      const scoringTeamId = ownGoal ? null : selectedGoalTeam(goalScoringTeamInput);
      const concedingTeamId = selectedGoalTeam(goalConcedingTeamInput);
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

    function currentGoalDraft() {
      return {
        ownGoal: goalOwnGoalInput.checked,
        scoringTeamId: selectedGoalTeam(goalScoringTeamInput),
        concedingTeamId: selectedGoalTeam(goalConcedingTeamInput),
        scorerPlayerId: goalScorerInput.value,
        assistPlayerIds: selectedAssistPlayerIds(),
      };
    }

    function isDefinitiveScoringRejection(error, kind) {
      if (!isDefinitiveRequestRejection(error) || error.statusCode === 408) return false;
      if (error.statusCode !== 409) return true;
      // Ambiguous/idempotency conflicts can follow a committed request. Only
      // documented pre-commit goal conflicts retire a first attempt; clock
      // conflicts are reconciled against the original third instead.
      if (!["create", "edit", "delete", "undo"].includes(kind)) return false;
      if (kind === "create" && error.responseError === "conflict" && error.responseCode === "no_active_third") return true;
      return error.responseError === "conflict" && [
        "game_finished", "game_state_changed", "goal_state_changed", "latest_goal_changed", "not_latest_goal",
      ].includes(error.responseCode);
    }

    function goalMutationPath(kind, eventId = null) {
      const goalsPath = encodedRecordPath("/v1/games/", gameId, "/goals");
      if (!goalsPath) return null;
      if (kind === "undo") return goalsPath + "/undo-last";
      return eventId ? encodedRecordPath(goalsPath + "/", eventId) : goalsPath;
    }

    function goalEventControlAvailable(eventId) {
      if (!goalMutationPath("edit", eventId)) return false;
      const probe = document.createElement("span");
      probe.innerHTML = `<i data-event-id="${escapeHtml(eventId)}"></i>`;
      return probe.firstElementChild?.getAttribute("data-event-id") === eventId;
    }

    function newGoalOperation(kind, eventId = null, payload = null) {
      const path = goalMutationPath(kind, eventId);
      if (!path) return null;
      const method = kind === "delete" ? "DELETE" : kind === "edit" ? "PATCH" : "POST";
      const prefix = kind === "edit" ? "update-goal" : `${kind}-goal`;
      const requestPayload = kind === "undo" ? { expectedEventId: eventId } : payload;
      const draft = currentGoalDraft();
      return {
        kind, eventId, path, editingGoalId,
        request: Object.freeze({ method, headers: Object.freeze({
          ...(method === "DELETE" ? {} : { "Content-Type": "application/json" }),
          "Idempotency-Key": createIdempotencyKey(prefix, `${gameId}-${eventId ?? "new"}`),
        }), ...(requestPayload ? { body: JSON.stringify(requestPayload) } : {}) }),
        draft: Object.freeze({ ...draft, assistPlayerIds: Object.freeze([...draft.assistPlayerIds]) }),
        assistPlayers: rosteredPlayers().filter((player) => draft.assistPlayerIds.includes(player.playerId)).map((player) => Object.freeze({ ...player })),
        previousScoreboardState: scoreboardState,
        previousFinishedResultState: finishedResultState,
        uncertain: false,
      };
    }

    function trackScoringOperationFocus(initiator) {
      const revision = gameNavigationRevision;
      const scope = initiator === saveGoalButton ? goalForm
        : initiator === retryGoalButton ? document.getElementById("goal-operation-recovery") ?? initiator : initiator;
      const action = initiator?.getAttribute("data-action");
      const eventId = initiator?.getAttribute("data-event-id");
      const inside = (element) => scope?.contains(element) || (element instanceof Element &&
        element.closest("button[data-action]")?.getAttribute("data-action") === action &&
        element.closest("button[data-action]")?.getAttribute("data-event-id") === eventId);
      let ownsFocus = inside(document.activeElement);
      const onFocus = (event) => { if (event.target !== document.body && !inside(event.target)) ownsFocus = false; };
      const onPointer = (event) => { if (!inside(event.target)) ownsFocus = false; };
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("pointerdown", onPointer, true);
      return () => {
        document.removeEventListener("focusin", onFocus, true);
        document.removeEventListener("pointerdown", onPointer, true);
        return ownsFocus && revision === gameNavigationRevision;
      };
    }

    function focusNextGoal() {
      const target = goalScoringTeamInput.querySelector('input[type="radio"]:not(:disabled)') ?? goalOwnGoalInput;
      if (target instanceof HTMLElement && !target.matches(":disabled") && actionElementVisible(target)) target.focus();
    }

    function focusGoalLogAction(operation) {
      const action = operation.kind === "delete" ? "delete-goal" : "undo-last-goal";
      const candidates = [...root.querySelectorAll('button[data-action]')].filter((button) =>
        button.getAttribute("data-action") === action && !button.disabled && actionElementVisible(button));
      const target = candidates.find((button) => button.getAttribute("data-event-id") === operation.eventId) ?? candidates[0];
      if (target instanceof HTMLElement) target.focus();
      else if (!undoLastGoalButton.disabled && actionElementVisible(undoLastGoalButton)) undoLastGoalButton.focus();
      else focusNextGoal();
    }

    async function performGoalOperation(operation, initiator) {
      if (!operation || goalMutationInFlight || operation !== goalOperation || timerMutationPending || clockOperation || !canScoreGame()) return;
      const finishFocus = trackScoringOperationFocus(initiator);
      const saved = operation.kind === "create" ? "Goal recorded" : operation.kind === "edit" ? "Goal updated" : operation.kind === "delete" ? "Goal deleted" : "Latest goal undone";
      const progress = operation.kind === "delete" ? "Deleting goal" : operation.kind === "undo" ? "Undoing latest goal" : "Saving goal";
      goalMutationInFlight = true;
      scoreboardState = "refreshing";
      if (isGameFinished()) finishedResultState = "refreshing";
      clearError();
      const feedback = beginGameFeedback(`${progress}…`);
      renderLiveScoring();
      renderTimer();
      let committed = false;
      try {
        let result;
        try {
          // Replay this exact operation: no re-reading fields, current latest
          // event, or roster membership, and never mint a replacement key.
          result = await requestJsonOrThrow(operation.path, operation.request);
        } catch (error) {
          if (!operation.uncertain && isDefinitiveScoringRejection(error, operation.kind)) {
            goalOperation = null;
            scoreboardState = operation.previousScoreboardState;
            finishedResultState = operation.previousFinishedResultState;
            showError(error instanceof Error ? error.message : "The goal change was rejected.");
            setStatus(operation.kind === "delete" ? "The goal was not deleted. Review the error and try again."
              : operation.kind === "undo" ? "The latest goal was not undone. Review the error and try again."
                : "Goal was not saved. Review the error and try again.", "error");
          } else {
            operation.uncertain = true;
            scoreboardState = "uncertain";
            if (isGameFinished()) finishedResultState = "uncertain";
            const message = operation.kind === "delete" ? "Could not confirm the deletion. Retry the same action."
              : operation.kind === "undo" ? "Could not confirm the undo. Retry the same action."
                : "Could not confirm whether the goal was saved. Retry with the same details.";
            showError(message, { includesOutcome: true });
          }
          return;
        }

        committed = true;
        goalOperation = null;
        const finishedCorrection = isGameFinished();
        if (finishedCorrection) finishedResultState = "saved-unavailable";
        applyGoalMutationResult(result);
        if (operation.kind === "create" || operation.kind === "edit" || (operation.editingGoalId && operation.editingGoalId === operation.eventId)) resetGoalForm();
        else {
          editingGoalId = operation.editingGoalId;
          renderLiveScoring(operation.draft);
        }
        // A successful mutation or replay proves the commit, not that its old
        // response snapshot is the latest scoreboard. Always refresh reads.
        const goalsLoaded = await loadGameGoals();
        const gameRefreshed = await refreshGameAfterFinishedCorrection();
        if (!goalsLoaded && scoreboardState !== "authoritative") scoreboardState = "unavailable";
        if (!goalsLoaded && !gameRefreshed) {
          showError(`${saved}, but neither the latest goal state nor the finished result could be refreshed. Reload to try again.`, { includesOutcome: true });
        } else if (!goalsLoaded) {
          showError(finishedCorrection
            ? `${saved}. Scores refreshed; goal timeline unavailable. Reload to try again.`
            : `${saved}, but the latest scores and goal timeline could not be loaded. Reload to try again.`, { includesOutcome: true });
        } else if (!gameRefreshed) {
          showError(`${saved}, but the finished result could not be refreshed.`, { includesOutcome: true });
        } else finishGameFeedback(`${saved}.`, feedback);
      } catch {
        // Refresh/render failure after a confirmed commit is not a failed write.
        if (committed) {
          scoreboardState = "unavailable";
          if (isGameFinished()) finishedResultState = "saved-unavailable";
          showError(`${saved}, but the latest game details could not be loaded. Reload to try again.`, { includesOutcome: true });
        }
      } finally {
        goalMutationInFlight = false;
        const ownsFocus = finishFocus();
        renderLiveScoring(committed ? {} : operation.draft);
        renderTimer();
        if (ownsFocus) {
          if (operation.uncertain && !retryGoalButton.disabled) retryGoalButton.focus();
          else if (committed && (operation.kind === "create" || operation.kind === "edit")) focusNextGoal();
          else if ((operation.kind === "create" || operation.kind === "edit") && !saveGoalButton.disabled) saveGoalButton.focus();
          else focusGoalLogAction(operation);
        }
      }
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

    function playerIdentityAttribute(playerId) {
      // JSON protects opaque IDs from HTML's CR/NUL normalization. Restore the
      // exact value through the DOM before any rendered control is interactive.
      return `data-player-identity="${escapeHtml(JSON.stringify(playerId))}"`;
    }

    function restorePlayerIdentities(surface) {
      for (const element of surface.querySelectorAll("[data-player-identity]")) {
        element.setAttribute("data-player-id", JSON.parse(element.getAttribute("data-player-identity")));
        element.removeAttribute("data-player-identity");
      }
    }

    function assignmentButton(playerId, team, currentTeamId = null, context = "assign") {
      const disabled = finishedRosterControlsLocked() || rosterMutationPending || playerCreatePending ? " disabled" : "";
      const active = currentTeamId === team.teamId;
      const nickname = playerNickname(playerId);
      const label =
        context === "transfer"
          ? `Transfer ${nickname} to ${team.name}`
          : active
            ? `${nickname} assigned to ${team.name}`
            : `Assign ${nickname} to ${team.name}`;
      return `<button data-ui="team-chip" data-context="${escapeHtml(context)}" type="button" data-action="assign-player" ${playerIdentityAttribute(playerId)} data-team-id="${escapeHtml(team.teamId)}" aria-label="${escapeHtml(label)}" aria-pressed="${
        active ? "true" : "false"
      }" data-state="${
        active ? "active" : "idle"
      }"${teamSwatchStyle(team)}${disabled}><span data-ui="team-chip-visual"><span>${escapeHtml(
        team.name,
      )}</span>${active ? renderClientIcon("circle-check") : ""}</span></button>`;
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
      const menuId = transferMenuId(playerId);
      const open = openTransferPlayerId === playerId;
      const disabled = finishedRosterControlsLocked() || rosterMutationPending || playerCreatePending ? " disabled" : "";
      const nickname = playerNickname(playerId);
      const alternatives = rosterTeams
        .filter((team) => team.teamId !== currentTeamId)
        .map((team) => assignmentButton(playerId, team, null, "transfer"))
        .join("");

      return `<div data-ui="transfer-control">
        <button data-ui="transfer-toggle" type="button" data-action="toggle-transfer" ${playerIdentityAttribute(playerId)} aria-label="${escapeHtml(
          `Transfer ${nickname}`,
        )}" aria-expanded="${
          open ? "true" : "false"
        }" aria-controls="${menuId}" title="${escapeHtml(`Transfer ${nickname}`)}"${disabled}>${renderClientIcon("arrow-left-right")}</button>
        <div id="${menuId}" data-ui="transfer-menu"${open ? "" : " hidden"}>
          ${alternatives}
        </div>
      </div>`;
    }

    function playerAccessPanel(player) {
      if (currentLeagueRole !== "admin" || !verifiedAdminPlayers.has(player?.playerId)) {
        return "";
      }

      const access = verifiedAdminPlayers.get(player.playerId)?.access;
      if (!access || typeof access.userId !== "string" || access.userId.length === 0) {
        const invitePath = invitationPath("", player.playerId);
        return `<div data-ui="player-access" data-testid="player-access" data-state="unclaimed">
          <span data-ui="claim-badge" data-state="unclaimed" role="img" aria-label="Not claimed" title="Not claimed">${renderClientIcon(
            "circle-user-round",
          )}</span>
          ${invitePath ? renderClientActionMenu(`player-actions-${encodeURIComponent(player.playerId)}`, player.nickname,
            `<button data-ui="row-action" type="button" data-action="invite-player-profile" ${playerIdentityAttribute(player.playerId)}>Invite to link profile</button>`,
            { "data-player-management": "" }) : '<small>Profile linking is unavailable for this player. Ask for help.</small>'}
        </div>`;
      }

      const role = normalizeLeagueRole(access.role);
      const roleLabel =
        role === "admin" ? "Co-organiser" : role === "scorekeeper" ? "Scorer" : "Claimed";
      const pendingDisabled = refreshAccountLocked || refreshWriteLocked || rosterMutationPending || playerCreatePending ? " disabled" : "";
      const actions = role === "admin" ? "" : renderClientActionMenu(`player-actions-${encodeURIComponent(player.playerId)}`, player.nickname, `<div data-ui="access-actions">
          ${role !== "scorekeeper" ? `<button data-ui="row-action" type="button" data-action="grant-player-access" ${playerIdentityAttribute(player.playerId)} data-role="scorekeeper"${pendingDisabled}>Make scorer</button>` : ""}
          <button data-ui="row-action" type="button" data-action="grant-player-access" ${playerIdentityAttribute(player.playerId)} data-role="admin"${pendingDisabled}>Make co-organiser</button>
        </div>`, { "data-player-management": "" });

      return `<div data-ui="player-access" data-testid="player-access" data-state="claimed">
        <span data-ui="claim-badge" data-state="claimed" role="img" aria-label="${escapeHtml(
          roleLabel,
        )}" title="${escapeHtml(roleLabel)}">${renderClientIcon("user-round-check")}</span>
        ${actions}
      </div>`;
    }

    function renderPlayerPool() {
      if (!(playerPoolElement instanceof HTMLElement)) {
        return;
      }

      const section = playerPoolElement.closest('[data-ui="player-pool"]');
      if (section instanceof HTMLElement) section.hidden = !isLeagueOperator();
      if (!isLeagueOperator()) {
        patchReadOnlyMarkup(playerPoolElement, "");
        return;
      }
      const search = playerSearchInput.value.trim().toLocaleLowerCase();
      const candidates = new Map((rosterUnassignedPlayers ?? rosterPlayers).map((player) => [player.playerId, player]));
      for (const player of pendingCreatedPlayers.values()) candidates.set(player.playerId, player);
      const players = [...candidates.values()].filter((player) => !assignmentByPlayerId(player.playerId) &&
        (!search || player.nickname.toLocaleLowerCase().includes(search)))
        .sort((left, right) => left.nickname.localeCompare(right.nickname) || left.playerId.localeCompare(right.playerId));
      const limitedNote = rosterUnassignedPlayers === null && rosterDataLoaded
        ? '<p data-ui="empty-note">The full Unassigned list is unavailable. Search by name to find players.</p>' : "";
      if (players.length === 0) {
        const message = rosterUnassignedPlayers === null && playerSearchState === "unavailable" ? "Unassigned players couldn’t be loaded. Try searching again."
          : rosterUnassignedPlayers === null && playerSearchState === "loading" ? "Loading players…"
            : rosterUnassignedPlayers === null ? "No players found in the available search."
              : search ? "No matching unassigned players." : "No unassigned players to show.";
        patchReadOnlyMarkup(playerPoolElement, `<p data-ui="empty-note">${message}</p>${limitedNote}`);
        return;
      }

      patchReadOnlyMarkup(playerPoolElement, players
        .map((player) => {
          const assignment = assignmentByPlayerId(player.playerId);
          return `<article data-ui="roster-player" ${playerIdentityAttribute(player.playerId)}>
            <figure data-ui="avatar"><span>${escapeHtml(initialsForName(player.nickname))}</span></figure>
            <div data-ui="roster-player-main">
              <strong>${escapeHtml(player.nickname)}</strong>
              ${playerAccessPanel(player)}
            </div>
            <div data-ui="row-action-buttons">
              ${canManageRoster() ? assignmentButtons(player.playerId, assignment?.teamId ?? null) : ""}
            </div>
          </article>`;
        })
        .join("") + limitedNote);
    }

    function renderRosterTeams() {
      if (!(rosterTeamsElement instanceof HTMLElement)) {
        return;
      }

      if (rosterTeams.length === 0) {
        patchReadOnlyMarkup(rosterTeamsElement, `<p data-ui="empty-note">${rosterDataLoaded ? "No teams found." : "Loading teams…"}</p>`);
        return;
      }

      patchReadOnlyMarkup(rosterTeamsElement, rosterTeams
        .map((team) => {
          const search = playerSearchInput.value.trim().toLocaleLowerCase();
          const allAssignments = rosterAssignments.filter((assignment) => assignment.teamId === team.teamId);
          const assignments = allAssignments.filter((assignment) => !search || playerNickname(assignment.playerId).toLocaleLowerCase().includes(search));
          const players = assignments
            .map((assignment) => {
              const player = assignment.player ?? playerById(assignment.playerId);
              const nickname = player?.nickname ?? assignment.playerId;
              return `<li data-ui="roster-member" ${playerIdentityAttribute(assignment.playerId)}>
                <div data-ui="roster-member-main"><strong>${escapeHtml(nickname)}</strong>${playerAccessPanel(playerById(assignment.playerId) ?? player)}</div>
                ${canManageRoster() ? transferControl(assignment.playerId, team.teamId) : ""}
              </li>`;
            })
            .join("");

          return `<article data-ui="roster-team" data-team-id="${escapeHtml(team.teamId)}"${teamSwatchStyle(team)}>
            <header>
              <span data-ui="team-swatch"></span>
              <h4>${escapeHtml(team.name)}</h4>
              <span data-ui="roster-count">${allAssignments.length}</span>
            </header>
            <ul>
              ${players || `<li data-ui="empty-note">${search && allAssignments.length ? "No matching players." : "No players assigned."}</li>`}
            </ul>
          </article>`;
        })
        .join(""));
    }

    function renderRosterSetup() {
      syncGameCapabilities();
      const focus = captureRosterFocus();
      const active = document.activeElement;
      const rosterLocked = finishedRosterControlsLocked();
      if (!canManageRoster()) {
        openTransferPlayerId = null;
      }
      if (quickCreatePlayerButton instanceof HTMLButtonElement) {
        quickCreatePlayerButton.disabled = rosterLocked || playerCreatePending || rosterMutationPending;
      }
      if (playerNicknameInput instanceof HTMLInputElement) {
        playerNicknameInput.disabled = rosterLocked;
      }
      renderPlayerPool();
      renderRosterTeams();
      syncGameModeState();
      if (openActionMenu && (playerPoolElement?.contains(openActionMenu.menu) || rosterTeamsElement?.contains(openActionMenu.menu))) {
        // Older browsers may close a native popover when its row moves. Keep
        // the same surface/trigger and restore only its presentation state.
        if (openActionMenu.topLayer) {
          try {
            if (!openActionMenu.surface.matches(":popover-open")) openActionMenu.surface.showPopover({ source: openActionMenu.trigger });
          } catch {
            openActionMenu.topLayer = false;
            openActionMenu.surface.removeAttribute("popover");
          }
        }
        positionActionMenu();
      } else if (openActionMenu && !openActionMenu.menu.isConnected) closeActionMenu();
      if (focus && !active.isConnected) restoreRosterFocus(focus);
    }

    function captureRosterFocus() {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || (!playerPoolElement?.contains(active) && !rosterTeamsElement?.contains(active))) return null;
      const playerId = active.closest("[data-player-id]")?.getAttribute("data-player-id");
      if (!playerId) return null;
      return {
        playerId, action: active.getAttribute("data-action"), teamId: active.getAttribute("data-team-id"), role: active.getAttribute("data-role"),
        surface: active.getAttribute("data-ui") === "action-menu-surface",
        managementOpen: active.closest('[data-ui="roster-player"], [data-ui="roster-member"]')?.querySelector('[data-action="toggle-action-menu"]')?.getAttribute("aria-expanded") === "true",
      };
    }

    function restoreRosterFocus(focus) {
      if (!focus) return;
      const player = [...root.querySelectorAll('[data-ui="roster-player"][data-player-id], [data-ui="roster-member"][data-player-id]')]
        .find((element) => element.getAttribute("data-player-id") === focus.playerId);
      if (!(player instanceof HTMLElement)) return;
      const management = player.querySelector('[data-ui="action-menu"]');
      if (focus.managementOpen) openActions(management, { focus: false });
      const target = focus.surface ? management?.querySelector('[data-ui="action-menu-surface"]') : [...player.querySelectorAll("button[data-action]")]
        .find((button) => button.getAttribute("data-action") === focus.action && button.getAttribute("data-team-id") === focus.teamId && button.getAttribute("data-role") === focus.role);
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    }

    function applyRosterPayload(rosterPayload, confirmedBeforeRead) {
      rosterTeams = Array.isArray(rosterPayload?.teams)
        ? rosterPayload.teams.map((team) => ({
            ...team,
            name:
              typeof team.name === "string" && team.name.length > 0
                ? team.name
                : String(team.teamId ?? "Unknown team"),
          }))
        : [];
      const assignmentsById = new Map((Array.isArray(rosterPayload?.roster) ? rosterPayload.roster : []).map((assignment) => [assignment.playerId, assignment]));
      for (const [playerId, assignment] of pendingAssignments) {
        // A confirmed local projection survives failed/pre-confirmation reads,
        // not a later authoritative read that may include another transfer.
        if (confirmedBeforeRead.get(playerId) === assignment) pendingAssignments.delete(playerId);
        else assignmentsById.set(playerId, assignment);
      }
      rosterAssignments = [...assignmentsById.values()];
      const publicPlayers = rosterPayload?.unassignedPlayers;
      rosterUnassignedPlayers = Array.isArray(publicPlayers) && publicPlayers.every((player) =>
        usableEntityId(player?.playerId) && typeof player.nickname === "string" && player.nickname.trim())
        ? [...new Map(publicPlayers.map((player) => [player.playerId, {
            playerId: player.playerId, nickname: player.nickname,
          }])).values()] : null;
      for (const player of rosterUnassignedPlayers ?? []) {
        // Public reads never establish claimed identity or administrator access.
        if (!knownRosterPlayers.has(player.playerId)) knownRosterPlayers.set(player.playerId, player);
        pendingCreatedPlayers.delete(player.playerId);
      }
      for (const assignment of rosterAssignments) pendingCreatedPlayers.delete(assignment.playerId);
      rosterDataLoaded = true;
    }

    async function loadRosterSetup(options = {}) {
      if (!rosterControlsAvailable()) return;
      const version = ++rosterReadVersion;
      const confirmedBeforeRead = new Map(pendingAssignments);
      const rosterPayload = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/roster`, { method: "GET", cache: "no-store" });
      if (version !== rosterReadVersion) return;
      // Preserve independently valid assignments and the existing search
      // fallback when only the optional complete-Unassigned DTO is unavailable.
      if (!refreshRosterValid(rosterPayload, { allowUnavailableUnassigned: true })) throw new Error("The latest roster could not be loaded.");
      applyRosterPayload(rosterPayload, confirmedBeforeRead);
      if (scoreboardTeams.length === 0 || (goalTimeline.length === 0 && !isGameFinished())) {
        scoreboardTeams = normalizeScoreboardTeams(rosterTeams);
      }
      renderRosterSetup();
      renderLiveScoring();

      if (options.updateStatus !== false) {
        setStatus("");
      }
    }

    async function loadPlayerSearch() {
      if (!rosterControlsAvailable() || !isLeagueOperator()) return;
      const version = ++playersReadVersion;
      const role = currentLeagueRole;
      const search = playerSearchInput.value.trim();
      playerSearchState = "loading";
      try {
        const payload = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/players${search ? `?search=${encodeURIComponent(search)}` : ""}`, { method: "GET" });
        if (version !== playersReadVersion || role !== currentLeagueRole || search !== playerSearchInput.value.trim()) return;
        rosterPlayers = Array.isArray(payload?.players) ? payload.players : [];
        verifiedAdminPlayers.clear();
        if (role === "admin") {
          for (const player of rosterPlayers) verifiedAdminPlayers.set(player.playerId, player);
        }
        for (const [playerId, player] of pendingCreatedPlayers) {
          if (rosterPlayers.some((entry) => entry.playerId === playerId)) {
            // Private search cannot acknowledge a complete public roster snapshot:
            // its previous refresh may have failed after this creation committed.
            if (rosterUnassignedPlayers === null) pendingCreatedPlayers.delete(playerId);
          }
          else if (!search || player.nickname.toLocaleLowerCase().includes(search.toLocaleLowerCase())) rosterPlayers.unshift(player);
        }
        for (const player of rosterPlayers) knownRosterPlayers.set(player.playerId, player);
        playerSearchState = "loaded";
      } catch {
        if (version !== playersReadVersion || role !== currentLeagueRole) return;
        playerSearchState = "unavailable";
        verifiedAdminPlayers.clear();
        rosterPlayers = [...pendingCreatedPlayers.values()].filter((player) => !search || player.nickname.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
      }
      renderRosterSetup();
    }

    async function loadGameGoals() {
      let payload;
      try {
        payload = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}/goals`, {
          method: "GET",
        });
      } catch (error) {
        goalTimelineLoaded = false;
        // Results owns its partial-log message. Scoring still has the local
        // unavailable timeline; a mutation caller adds its own commit outcome.
        if (!isGameFinished()) {
          showError("The match log could not be loaded. Reload to try again.", { includesOutcome: true });
        }
        renderLiveScoring();
        return false;
      }

      const teams = normalizeScoreboardTeams(payload?.scoreboard?.teams);
      const timeline = decodeGoalTimeline(payload?.timeline);
      goalTimelineLoaded = timeline !== null;
      goalTimeline = timeline ?? [];
      if (teams.length) {
        scoreboardTeams = teams;
        scoreboardState = "authoritative";
      } else if (!(isGameFinished() && finishedResultState === "authoritative" && resultTeams().length)) {
        scoreboardTeams = [];
        scoreboardState = "unavailable";
      }
      if (!goalTimelineLoaded && !isGameFinished()) showError("The match log could not be loaded. Reload to try again.", { includesOutcome: true });
      renderLiveScoring();
      return goalTimelineLoaded;
    }

    async function loadGame() {
      const game = await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}`, {
        method: "GET",
      });
      applyGameView(game, true);
    }

    function applyGameView(game, updateForm = false) {
      currentGame = game;
      finishedResultState = "authoritative";
      if (game.status === "finished") {
        scoreboardTeams = normalizeScoreboardTeams(game.result?.teams);
        scoreboardState = scoreboardTeams.length ? "authoritative" : "unavailable";
      }
      currentLeagueId = game.leagueId;
      currentSeasonId = game.seasonId;

      if (title) {
        title.textContent = formatLocalDateHeading(game.gameStartTs);
      }

      if (subtitle) {
        subtitle.textContent = formatLocalKickoffTime(game.gameStartTs);
        subtitle.hidden = false;
      }
      renderGameOverview();

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

      if (updateForm || !metadataDirty) {
        kickoffInput.value = toLocalDateTimeInput(game.gameStartTs);
        statusInput.value = game.status;
        thirdLengthInput.value = String(parseThirdLengthMinutes(game.thirdLengthMinutes ?? game.timer?.thirdLengthMinutes));
      }
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
      if (refreshAccountLocked) return;
      const revision = ++authorityRevision;
      currentLeagueRole = null;
      ++playersReadVersion;
      knownRosterPlayers.clear();
      verifiedAdminPlayers.clear();
      rosterPlayers = [];
      playerSearchState = "loading";
      finishedRosterEditing = false;
      finishedResultEditing = false;
      syncGameCapabilities();
      renderRosterSetup();
      renderLiveScoring();
      renderTimer();
      if (!currentLeagueId) {
        renderLiveScoring();
        return;
      }

      try {
        const league = await requestJsonOrThrow(`/v1/leagues/${encodeURIComponent(currentLeagueId)}`, {
          method: "GET",
        });
        if (refreshAccountLocked || revision !== authorityRevision) return;
        if (league?.leagueId === currentLeagueId) {
          currentLeagueRole = normalizeLeagueRole(league?.access?.role);
          currentLeagueName = league.name;
          if (gameLeagueLink instanceof HTMLAnchorElement) gameLeagueLink.textContent = league.name;
        }
      } catch {
        if (refreshAccountLocked || revision !== authorityRevision) return;
        currentLeagueRole = null;
      }

      if (rosterControlsAvailable()) {
        renderRosterSetup();
      }
      renderLiveScoring();
      renderTimer();
    }

    const gameEditToggle = document.querySelector('[data-action="toggle-game-edit"]');
    const gameEditRegion = document.getElementById("game-edit-region");
    const playerCreateToggle = root.querySelector('[data-action="toggle-player-create"]');
    const playerCreateRegion = document.getElementById("player-create-region");
    const pickerSearch = document.getElementById("game-player-picker-search");
    const pickerScope = document.getElementById("game-player-picker-scope");
    const pickerTeam = document.getElementById("game-player-picker-team");
    const pickerList = document.getElementById("game-player-picker-list");
    const pickerStatus = document.getElementById("game-player-picker-status");
    const pickerMore = document.getElementById("game-player-picker-more");
    const newPlayerToggle = document.getElementById("game-player-new-toggle");
    const nameSuggestions = attachPlayerNameSuggestions({ input: playerNicknameInput, panel: document.getElementById("game-player-name-matches"),
      leagueId: () => currentLeagueId, canRead: () => canManageRoster() && !refreshAccountLocked && !playerCreatePending && !playerCreateAttempt && !existingPlayerAttempt && !signOutPending && !signOutUnconfirmed,
      useExisting: nickname => {
        document.getElementById("player-create-form").hidden = true; newPlayerToggle.setAttribute("aria-expanded", "false");
        pickerScope.value = "league"; pickerSearch.value = nickname; pickerSearch.focus(); void loadPicker();
      } });
    let pickerCursor = null, pickerVersion = 0, pickerQuery = "", pickerSeason = "", pickerLoading = false;
    const pickerPlayers = new Map();
    function pickerMessage(message, error = false) {
      pickerStatus.textContent = message; pickerStatus.hidden = !message;
      pickerStatus.setAttribute("data-state", error ? "error" : "default");
    }
    function renderPicker() {
      const focusedPlayerId = pickerList.contains(document.activeElement) ? document.activeElement.getAttribute("data-player-id") : null;
      const locked = !canManageRoster() || refreshWriteLocked || rosterMutationPending || playerCreatePending || Boolean(playerCreateAttempt);
      pickerList.replaceChildren();
      for (const player of pickerPlayers.values()) {
        const row = document.createElement("li"); row.setAttribute("data-player-id", player.playerId);
        const heading = document.createElement("div"); heading.setAttribute("data-ui", "directory-player-heading");
        const name = document.createElement("strong"); name.textContent = player.nickname; heading.append(name);
        const button = document.createElement("button"); button.type = "button"; button.setAttribute("data-ui", "button");
        button.setAttribute("data-variant", "secondary"); button.setAttribute("data-action", "add-existing-player");
        button.setAttribute("data-player-id", player.playerId);
        button.disabled = locked || pickerLoading || player.inGame || Boolean(existingPlayerAttempt && existingPlayerAttempt.playerId !== player.playerId);
        button.textContent = player.inGame ? "Already in game" : existingPlayerAttempt?.playerId === player.playerId ? "Retry adding" : "Add";
        button.setAttribute("aria-label", `${button.textContent} ${player.nickname}`); heading.append(button); row.append(heading);
        const context = document.createElement("p");
        context.id = `game-player-picker-context-${pickerList.children.length}`;
        button.setAttribute("aria-describedby", context.id);
        context.textContent = [...(player.seasons ?? []).map(season => season.name), player.claimed ? "Linked to an account" : "Not linked to an account"].join(" · ");
        row.append(context); pickerList.append(row);
      }
      pickerTeam.disabled = locked || Boolean(existingPlayerAttempt);
      pickerSearch.disabled = locked || Boolean(existingPlayerAttempt);
      pickerScope.disabled = locked || Boolean(existingPlayerAttempt);
      pickerMore.disabled = locked || pickerLoading || Boolean(existingPlayerAttempt);
      newPlayerToggle.disabled = locked || Boolean(existingPlayerAttempt);
      if (focusedPlayerId) [...pickerList.querySelectorAll("button")].find(button => button.getAttribute("data-player-id") === focusedPlayerId && !button.disabled)?.focus({ preventScroll: true });
    }
    async function loadPicker(append = false) {
      if (!currentLeagueId || !canManageRoster() || existingPlayerAttempt || playerCreateAttempt || (append && (!pickerCursor || pickerLoading))) return;
      const version = ++pickerVersion, role = currentLeagueRole;
      const finishFocus = append ? trackInteractionFocus(pickerMore) : null;
      pickerLoading = true;
      if (!append) { pickerCursor = null; pickerMore.hidden = true; pickerQuery = pickerSearch.value.trim(); pickerSeason = pickerScope.value === "season" ? currentSeasonId : ""; }
      renderPicker(); pickerMessage("Loading players…");
      const params = new URLSearchParams({ leagueId: currentLeagueId, gameId, query: pickerQuery, limit: "25" });
      if (pickerSeason) params.set("seasonId", pickerSeason);
      if (append) params.set("cursor", pickerCursor);
      try {
        const result = await requestJsonOrThrow(`/v1/league-players?${params}`, { method: "GET", cache: "no-store" });
        if (version !== pickerVersion || role !== currentLeagueRole || refreshAccountLocked) return;
        if (!Array.isArray(result.players) || (result.cursor !== null && typeof result.cursor !== "string") || result.players.some(player => typeof player.inGame !== "boolean")) throw new Error("Invalid player page");
        if (!append) pickerPlayers.clear();
        for (const player of result.players) pickerPlayers.set(player.playerId, player);
        pickerCursor = result.cursor; pickerMore.hidden = !pickerCursor;
        pickerMessage(pickerPlayers.size ? "" : pickerCursor ? "No matches on this page. Load more players to continue searching." : "No players found. Try All league players or create a new player.");
      } catch (error) {
        if (version !== pickerVersion) return;
        if (!append || [401, 403].includes(error.statusCode)) pickerPlayers.clear();
        if (error.statusCode === 409 || error.statusCode === 400) { pickerCursor = null; pickerMore.hidden = true; }
        pickerMessage(error.statusCode === 503 ? "The player list is temporarily unavailable. Try again later."
          : "Could not load players. Search again to refresh the list.", true);
      } finally {
        const owned = finishFocus?.();
        if (version === pickerVersion) {
          pickerLoading = false; renderPicker();
          if (owned && pickerMore.hidden && !playerCreateRegion.hidden) {
            if (pickerStatus.hidden) pickerMessage("All matching players loaded.");
            pickerStatus.tabIndex = -1; pickerStatus.focus();
          }
        }
      }
    }
    document.getElementById("game-player-picker-form")?.addEventListener("submit", event => { event.preventDefault(); void loadPicker(); });
    pickerScope?.addEventListener("change", () => { void loadPicker(); });
    pickerMore?.addEventListener("click", () => { void loadPicker(true); });
    newPlayerToggle?.addEventListener("click", () => {
      if (newPlayerToggle.disabled || existingPlayerAttempt) return;
      const form = document.getElementById("player-create-form");
      const open = form.hidden; form.hidden = !open; newPlayerToggle.setAttribute("aria-expanded", String(open));
      if (open) {
        if (!playerNicknameInput.value) playerNicknameInput.value = pickerSearch.value.trim();
        playerNicknameInput.focus();
        void nameSuggestions.check();
      }
    });
    pickerList?.addEventListener("click", async event => {
      const button = event.target instanceof Element ? event.target.closest('[data-action="add-existing-player"]') : null;
      if (!(button instanceof HTMLButtonElement) || button.disabled || rosterMutationPending || playerCreatePending || playerCreateAttempt || !canManageRoster() || refreshWriteLocked) return;
      const selected = pickerPlayers.get(button.getAttribute("data-player-id"));
      if (!selected || selected.inGame) return;
      if (!existingPlayerAttempt) existingPlayerAttempt = { playerId: selected.playerId, nickname: selected.nickname, uncertain: false,
        path: `/v1/game-player-registrations?${new URLSearchParams({ gameId })}`,
        body: JSON.stringify({ playerId: selected.playerId, teamId: pickerTeam.value || null, allowFinished: isGameFinished() }) };
      if (existingPlayerAttempt.playerId !== selected.playerId) return;
      // A read started before dispatch cannot replace the frozen retry's row.
      pickerVersion += 1; pickerLoading = false; pickerCursor = null; pickerMore.hidden = true;
      const authorityAtDispatch = authorityRevision;
      const finishFocus = trackInteractionFocus(button.closest("li"));
      rosterMutationPending = true; renderRosterSetup(); renderPicker(); pickerMessage("Adding player…");
      let committed = false;
      try {
        const response = await requestJsonOrThrow(existingPlayerAttempt.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: existingPlayerAttempt.body });
        if (!usableEntityId(response.registration?.playerId) || typeof response.registration.alreadyInGame !== "boolean") throw new Error("Unconfirmed registration");
        committed = true;
        const player = { playerId: response.registration.playerId, nickname: existingPlayerAttempt.nickname };
        existingPlayerAttempt = null; selected.inGame = true;
        if (refreshAccountLocked || authorityAtDispatch !== authorityRevision) return;
        pendingCreatedPlayers.set(player.playerId, player); knownRosterPlayers.set(player.playerId, player);
        ++playersReadVersion;
        await loadRosterSetup({ updateStatus: false }); await loadPlayerSearch();
        pickerMessage(response.registration.alreadyInGame ? `${player.nickname} is already in this game.` : `${player.nickname} added.`);
      } catch (error) {
        if (committed) pickerMessage("Player added. The latest teams couldn’t be loaded. Reload to check them.", true);
        else {
          if (existingPlayerAttempt && !existingPlayerAttempt.uncertain && isDefinitiveRequestRejection(error) && ![408, 429].includes(error.statusCode)) existingPlayerAttempt = null;
          else if (existingPlayerAttempt) existingPlayerAttempt.uncertain = true;
          pickerMessage(existingPlayerAttempt ? "Player addition could not be confirmed. Retry adding sends the same request."
            : "This player could not be added. Search again to refresh the list.", true);
        }
      } finally {
        rosterMutationPending = false; renderRosterSetup(); renderPicker();
        if (finishFocus() && !playerCreateRegion.hidden) { pickerStatus.tabIndex = -1; pickerStatus.focus(); }
      }
    });
    const playerInvitation = initPlayerInvitation({
      path: (suffix, playerId) => invitationPath(suffix, playerId),
      proofPlayerId: playerId => {
        const canonicalPlayerId = verifiedAdminPlayers.get(playerId)?.canonicalPlayerId;
        return usableEntityId(canonicalPlayerId) && usableEntityId(currentLeagueId) ? canonicalPlayerId : playerId;
      },
      canManage: () => currentLeagueRole === "admin",
      canOpen: playerId => verifiedAdminPlayers.has(playerId),
      isLocked: () => refreshAccountLocked,
      playerName: playerNickname,
    });
    function invitationPath(suffix = "", playerId) {
      try {
        const canonicalPlayerId = verifiedAdminPlayers.get(playerId)?.canonicalPlayerId;
        if (usableEntityId(canonicalPlayerId) && canonicalPlayerId !== playerId && usableEntityId(currentLeagueId)) {
          return `/v1/player-proofs/league-invitation${suffix}?${new URLSearchParams({ leagueId: currentLeagueId, playerId: canonicalPlayerId })}`;
        }
        if (!usableEntityId(playerId) || new TextEncoder().encode(`PLAYER#${playerId}`).length > 2048 ||
            !usableEntityId(gameId) || new TextEncoder().encode(`GAME#${gameId}`).length > 2048) return null;
        return `/v1/player-proofs/invitation${suffix}?gameId=${encodeURIComponent(gameId)}&playerId=${encodeURIComponent(playerId)}`;
      } catch { return null; }
    }
    attachDisclosure(gameEditToggle, gameEditRegion);
    attachDisclosure(playerCreateToggle, playerCreateRegion, { onOpen: () => {
      void loadPicker();
      if (!document.getElementById("player-create-form").hidden) playerNicknameInput.focus();
    } });
    for (const panel of [gameEditRegion, playerCreateRegion]) panel?.addEventListener("keydown", (event) => {
      // The disclosure's Escape handler already closed it. Its original trigger
      // may now be disabled; keep deliberate keyboard recovery visible.
      if (event.key === "Escape" && refreshWriteLocked && panel.hidden) refreshRetry?.focus();
    });
    root.addEventListener("click", (event) => {
      const action = event.target instanceof Element ? event.target.closest("[data-action]")?.getAttribute("data-action") : null;
      if (action === "cancel-game-edit" || action === "cancel-player-create") {
        const panel = action === "cancel-game-edit" ? gameEditRegion : playerCreateRegion;
        const trigger = action === "cancel-game-edit" ? gameEditToggle : playerCreateToggle;
        const ownsFocus = panel?.contains(document.activeElement);
        setDisclosureState(trigger, panel, false);
        if (ownsFocus && refreshWriteLocked) refreshRetry?.focus();
      }
    });

    attachFormSubmit("game-edit-form", saveButton, async () => {
      if (!canEditGame() || gameMetadataPending || metadataRefreshConflict()) {
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

      gameMetadataPending = true;
      const saveNavigation = gameNavigationRevision;
      const finishSaveFocus = trackInteractionFocus(gameEditRegion);
      saveButton.disabled = true;
      kickoffInput.disabled = true;
      statusInput.disabled = true;
      thirdLengthInput.disabled = true;
      const feedback = beginGameFeedback("Saving game updates…");

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
        if (refreshAccountLocked) return;
        metadataDirty = false;

        try {
          await loadGame();
          gameMetadataPending = false;
          renderTimer();
          const ownsFocus = finishSaveFocus();
          if (saveNavigation === gameNavigationRevision) {
            setDisclosureState(gameEditToggle, gameEditRegion, false, { restoreFocus: false });
            // Disabling a focused native input can blur it to body. The captured
            // interaction still owns restoration unless the user moved away.
            if (ownsFocus && gameEditToggle instanceof HTMLButtonElement && !gameEditToggle.disabled && actionElementVisible(gameEditToggle)) gameEditToggle.focus();
          }
          finishGameFeedback("Game saved.", feedback);
        } catch {
          showError("Game saved. The latest details couldn’t be loaded. Reload the page to check them.", { includesOutcome: true });
        }
      } catch (error) {
        if (uncertainReadBarriers.has(`PATCH:/v1/games/${encodeURIComponent(gameId)}`)) {
          showError("Game changes could not be confirmed. Reload to check before making more changes.", { includesOutcome: true });
        } else {
          const message = error instanceof Error ? error.message : "Could not update game.";
          showError(message);
          setStatus("Game update failed.", "error");
        }
      } finally {
        const ownsFocus = finishSaveFocus();
        gameMetadataPending = false;
        renderTimer();
        saveButton.disabled = !canEditGame() || metadataRefreshConflict();
        kickoffInput.disabled = !canEditGame();
        statusInput.disabled = !canEditGame();
        thirdLengthInput.disabled = !canEditGame() || buildTimerState(currentGame).thirds.some((third) => third.startedAt !== null);
        if (ownsFocus && refreshWriteLocked) refreshRetry?.focus();
      }
    });

    deleteButton.addEventListener("click", async () => {
      if (refreshAccountLocked || refreshWriteLocked || currentLeagueRole !== "admin" || deleteButton.disabled || gameDeletionPending || isGameFinished()) return;

      if (!window.confirm(`Delete game ${gameId}?`)) {
        return;
      }

      gameDeletionPending = true;
      deleteButton.disabled = true;
      clearError();
      setStatus(`Deleting game ${gameId}…`, "default");

      try {
        await requestJsonOrThrow(`/v1/games/${encodeURIComponent(gameId)}`, {
          method: "DELETE",
        });
        navigateTo(buildLeagueSeasonPath(currentLeagueId, currentSeasonId));
      } catch (error) {
        if (refreshWriteLocked) {
          showError("Game deletion could not be confirmed. Reload to check before making more changes.", { includesOutcome: true });
        } else {
          const message = error instanceof Error ? error.message : "Could not delete game.";
          showError(message);
          setStatus("Game deletion failed.", "error");
        }
      } finally {
        gameDeletionPending = false;
        deleteButton.disabled = refreshAccountLocked || refreshWriteLocked || currentLeagueRole !== "admin" || isGameFinished();
      }
    });

    function newClockOperation(kind, third = null) {
      return {
        kind, third, uncertain: false,
        path: "/v1/games/" + encodeURIComponent(gameId) + (kind === "finish-game" ? "/finish" : "/thirds/" + encodeURIComponent(third) + "/" + kind),
        request: Object.freeze({ method: "POST", ...(kind === "finish-game" ? {
          headers: Object.freeze({ "Idempotency-Key": createIdempotencyKey("finish-game", gameId) }),
        } : {}) }),
      };
    }

    function clockOutcomeObserved(operation) {
      if (isGameFinished()) return true;
      if (operation.kind === "finish-game") return false;
      const third = buildTimerState(currentGame).thirds.find((segment) => segment.third === Number(operation.third));
      return operation.kind === "start" ? Boolean(third?.startedAt) : Boolean(third?.finishedAt);
    }

    async function reconcileClockOperation(operation) {
      if (refreshAccountLocked || refreshWriteLocked) return false;
      try {
        const game = await requestJsonOrThrow("/v1/games/" + encodeURIComponent(gameId), { method: "GET", cache: "no-store" });
        if (refreshAccountLocked || refreshWriteLocked) return false;
        currentGame = game;
        if (clockOutcomeObserved(operation)) {
          clockOperation = null;
          return true;
        }
      } catch {
        // A failed or negative read does not prove a lost POST never committed.
      }
      return false;
    }

    async function acceptClockOutcome(operation, feedback) {
      let accessAvailable = true;
      let resultAvailable = true;
      if (operation.kind === "finish-game") {
        try {
          // A finish replay can predate later authorised corrections. It proves
          // the finish committed, but only a fresh read supplies current results.
          const latest = await requestJsonOrThrow("/v1/games/" + encodeURIComponent(gameId), { method: "GET", cache: "no-store" });
          if (latest?.status !== "finished") throw new Error("Finished result is not available yet.");
          currentGame = latest;
        } catch {
          resultAvailable = false;
        }
      }
      if (isGameFinished()) {
        finishedResultState = resultAvailable ? "authoritative" : "saved-unavailable";
        if (!resultAvailable) scoreboardState = "unavailable";
        else {
          scoreboardTeams = normalizeScoreboardTeams(currentGame?.result?.teams);
          scoreboardState = scoreboardTeams.length ? "authoritative" : "unavailable";
        }
        finishedResultEditing = false;
        finishedRosterEditing = false;
        try {
          await loadLeagueAccess();
          await loadPlayerSearch();
          accessAvailable = currentLeagueRole !== null && playerSearchState !== "unavailable";
        } catch {
          accessAvailable = false;
        }
      }
      if (!metadataDirty) statusInput.value = currentGame.status;
      const success = operation.kind === "finish-game" ? "Game finished." : "Third " + operation.third + (operation.kind === "start" ? " started." : " finished.");
      if (!resultAvailable) showError("Game finished. The latest result could not be loaded. Reload to try again.", { includesOutcome: true });
      else if (!accessAvailable) showError("Game finished. Player details could not be refreshed. Reload to try again.", { includesOutcome: true });
      else { finishGameFeedback(success, feedback); }
    }

    async function performClockOperation(operation, initiator, readOnly = false) {
      if (refreshAccountLocked || refreshWriteLocked || timerMutationPending || goalMutationInFlight || goalOperation || (!readOnly && !canScoreGame())) return;
      const finishFocus = trackScoringOperationFocus(initiator);
      const navigationRevision = gameNavigationRevision;
      timerMutationPending = true;
      clearError();
      const feedback = beginGameFeedback(readOnly ? "Checking clock…" : operation.kind === "finish-game" ? "Finishing game…" : (operation.kind === "start" ? "Starting third " : "Finishing third ") + operation.third + "…");
      renderTimer();
      renderLiveScoring();
      let confirmed = false;
      try {
        if (readOnly) {
          confirmed = await reconcileClockOperation(operation);
        } else {
          try {
            currentGame = await requestJsonOrThrow(operation.path, operation.request);
            clockOperation = null;
            confirmed = true;
          } catch (error) {
            if (!operation.uncertain && isDefinitiveScoringRejection(error, operation.kind)) {
              clockOperation = null;
              showError(error instanceof Error ? error.message : "The clock change was rejected.");
              setStatus(operation.kind === "finish-game" ? "Game finish failed." : operation.kind === "start" ? "Third start failed." : "Third finish failed.", "error");
              return;
            }
            operation.uncertain = true;
            confirmed = await reconcileClockOperation(operation);
          }
        }
        if (confirmed) await acceptClockOutcome(operation, feedback);
        else {
          operation.uncertain = true;
          showError(refreshWriteLocked ? "The clock change could not be confirmed. Reload this game before making more changes." : operation.kind === "finish-game"
            ? "Game finish could not be confirmed. Check the clock or retry finishing this game."
            : "The clock change could not be confirmed. Check the clock before continuing.", { includesOutcome: true });
        }
      } finally {
        timerMutationPending = false;
        const ownsFocus = finishFocus();
        renderTimer();
        renderRosterSetup();
        renderLiveScoring();
        if (refreshWriteLocked) {
          // The lock wins even if the user moved focus: a late confirmation
          // must not switch modes and hide their new recovery/navigation target.
          if (ownsFocus && refreshRetry instanceof HTMLButtonElement && !refreshRetry.disabled && refreshRetry.isConnected && actionElementVisible(refreshRetry)) refreshRetry.focus();
        } else if (confirmed && navigationRevision === gameNavigationRevision) {
          if (isGameFinished()) setGameMode("final", { focusPanel: ownsFocus });
          else if (operation.kind === "start") {
            setGameMode("run");
            if (ownsFocus) focusNextGoal();
          } else if (ownsFocus) {
            const next = !startThirdButton.disabled ? startThirdButton : !finishGameButton.disabled ? finishGameButton : null;
            next?.focus();
          }
        } else if (ownsFocus) {
          if (operation.uncertain && refreshGameStateButton instanceof HTMLButtonElement && !refreshGameStateButton.disabled) refreshGameStateButton.focus();
          else if (!initiator.disabled && actionElementVisible(initiator)) initiator.focus();
        }
      }
    }

    startThirdButton.addEventListener("click", () => {
      if (startThirdButton.disabled || clockOperation || goalOperation || goalMutationInFlight || timerMutationPending || !canScoreGame() || isGameFinished()) return;
      const third = startThirdButton.getAttribute("data-third");
      if (!third) return;
      clockOperation = newClockOperation("start", third);
      void performClockOperation(clockOperation, startThirdButton);
    });

    finishThirdButton.addEventListener("click", () => {
      if (finishThirdButton.disabled || clockOperation || goalOperation || goalMutationInFlight || timerMutationPending || !canScoreGame() || isGameFinished()) return;
      const third = finishThirdButton.getAttribute("data-third");
      if (!third) return;
      clockOperation = newClockOperation("finish", third);
      void performClockOperation(clockOperation, finishThirdButton);
    });

    finishGameButton.addEventListener("click", () => {
      if (finishGameButton.disabled || goalOperation || goalMutationInFlight || timerMutationPending || !canScoreGame() || isGameFinished()) return;
      if (clockOperation && clockOperation.kind !== "finish-game") return;
      if (!clockOperation) {
        if (buildTimerState(currentGame).status !== "complete") return;
        clockOperation = newClockOperation("finish-game");
      }
      void performClockOperation(clockOperation, finishGameButton);
    });

    if (refreshGameStateButton instanceof HTMLButtonElement) refreshGameStateButton.addEventListener("click", () => {
      if (clockOperation?.uncertain) void performClockOperation(clockOperation, refreshGameStateButton, true);
    });

    root.addEventListener("click", (event) => {
      const target = event.target;
      const action = target instanceof Element ? target.closest("[data-action]")?.getAttribute("data-action") : null;
      if (action === "exit-result-correction") {
        if (!isGameFinished() || refreshAccountLocked || currentLeagueRole !== "admin" || !finishedResultEditing || goalOperation || clockOperation || goalMutationInFlight || timerMutationPending) return;
        finishedResultEditing = false;
        if (!refreshWriteLocked) resetGoalForm();
        renderLiveScoring();
        manualGameModeSelected = true;
        setGameMode("final", { focusPanel: true });
        return;
      }
      if (action === "edit-finished-teams" || action === "correct-finished-result") {
        if (!isGameFinished() || refreshAccountLocked || refreshWriteLocked || currentLeagueRole !== "admin") return;
        if (action === "edit-finished-teams") finishedRosterEditing = true;
        else finishedResultEditing = true;
        manualGameModeSelected = true;
        renderRosterSetup();
        renderLiveScoring();
        setGameMode(action === "edit-finished-teams" ? "players" : "run", { focusPanel: true });
        return;
      }
      const trigger =
        target instanceof Element
          ? target.closest('[data-action="select-game-mode"][data-game-mode]')
          : null;
      if (!(trigger instanceof HTMLElement)) {
        return;
      }
      event.preventDefault();
      if (trigger instanceof HTMLButtonElement && trigger.disabled) return;
      if (trigger.getAttribute("aria-disabled") === "true") return;

      const mode = trigger.getAttribute("data-game-mode");
      manualGameModeSelected = true;
      setGameMode(mode, { focusPanel: true });
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
        ++playerNicknameGeneration;
        setFieldMessage("player-nickname");
      });

      playerSearchInput.addEventListener("input", () => {
        ++playerSearchGeneration;
        window.clearTimeout(rosterSearchTimer);
        ++playersReadVersion;
        rosterPlayers = [];
        playerSearchState = "loading";
        renderRosterSetup();
        rosterSearchTimer = window.setTimeout(() => {
          void loadPlayerSearch();
        }, 160);
      });

      attachFormSubmit("player-create-form", quickCreatePlayerButton, async () => {
        if (finishedRosterControlsLocked() || playerCreatePending || rosterMutationPending) {
          return;
        }

        clearError();

        const nickname = playerNicknameInput.value.trim();
        if (!playerCreateAttempt && !nickname) {
          setFieldMessage("player-nickname", "invalid", "Player nickname is required.");
          playerNicknameInput.focus();
          return;
        }

        const nicknameSlug = slugify(nickname) || "player";
        const playerId = `player-${nicknameSlug}-${randomSuffix(6)}`;
        if (!playerCreateAttempt) playerCreateAttempt = {
          playerId, nickname, search: playerSearchInput.value,
          nicknameGeneration: playerNicknameGeneration, searchGeneration: playerSearchGeneration,
          request: freezeCreationRequest(`/v1/games/${encodeURIComponent(gameId)}/players`, { playerId, nickname }, "create-player", `${gameId}-${playerId}`),
          uncertain: false,
        };
        const finishFocus = trackInteractionFocus(document.getElementById("player-create-form"));
        playerCreatePending = true;
        let committed = false;
        quickCreatePlayerButton.disabled = true;
        renderRosterSetup();
        const feedback = beginGameFeedback("Adding player…");

        try {
          const response = await requestJsonOrThrow(playerCreateAttempt.request.path, playerCreateAttempt.request.init);
          committed = true;
          const player = { ...response, playerId: playerCreateAttempt.playerId, nickname: playerCreateAttempt.nickname };
          pendingCreatedPlayers.set(player.playerId, player);
          knownRosterPlayers.set(player.playerId, player);
          if (playerNicknameGeneration === playerCreateAttempt.nicknameGeneration && playerNicknameInput.value.trim() === playerCreateAttempt.nickname) playerNicknameInput.value = "";
          if (playerSearchGeneration === playerCreateAttempt.searchGeneration && playerSearchInput.value === playerCreateAttempt.search) playerSearchInput.value = "";
          playerCreateAttempt = null;
          nameSuggestions.clear();
          ++playersReadVersion;
          rosterPlayers = [player, ...rosterPlayers.filter((entry) => entry.playerId !== player.playerId)];
          renderRosterSetup();
          setFieldMessage("player-nickname");
          try {
            await loadRosterSetup({ updateStatus: false });
            await loadPlayerSearch();
            finishGameFeedback("Player added.", feedback);
          } catch {
            showError("Player added. The latest teams couldn’t be loaded. Reload to check them.", { includesOutcome: true });
          }
        } catch (error) {
          if (committed) {
            showError("Player added. The latest players couldn’t be loaded. Reload to check them.", { includesOutcome: true });
          } else if (isDefinitiveRequestRejection(error) &&
            (error.statusCode !== 409 || (error.responseError === "conflict" &&
              ["game_finished", "game_state_changed"].includes(error.responseCode))) &&
            !playerCreateAttempt.uncertain) {
            // These state conflicts are persisted rejections, not pending writes.
            // An earlier lost response still needs its original request retained;
            // a later rejection cannot establish that the first attempt failed.
            playerCreateAttempt = null;
            showError(error.message);
            setStatus("Player could not be added.", "error");
          } else {
            playerCreateAttempt.uncertain = true;
            showError("Player addition could not be confirmed. Try again to resend the original nickname; changes to this draft will not be sent yet.", { includesOutcome: true });
          }
        } finally {
          playerCreatePending = false;
          quickCreatePlayerButton.disabled = finishedRosterControlsLocked() || rosterMutationPending;
          renderRosterSetup();
          if (finishFocus() && !playerNicknameInput.disabled) playerNicknameInput.focus();
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
          if (finishedRosterControlsLocked() || rosterMutationPending || playerCreatePending || target.disabled) {
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
          if (refreshAccountLocked || refreshWriteLocked || currentLeagueRole !== "admin" || rosterMutationPending || playerCreatePending || target.disabled) {
            return;
          }

          const playerId = target.getAttribute("data-player-id");
          const userId = playerId ? verifiedAdminPlayers.get(playerId)?.access?.userId : null;
          const role = target.getAttribute("data-role");
          const previousRole = normalizeLeagueRole(playerId ? verifiedAdminPlayers.get(playerId)?.access?.role : null);
          if (!currentLeagueId || !userId || (role !== "scorekeeper" && role !== "admin")) {
            return;
          }
          if (previousRole === "admin" || (previousRole === "scorekeeper" && role === "scorekeeper")) return;
          if (!window.confirm(role === "admin"
            ? `Allow ${playerNickname(playerId)} to manage ${currentLeagueName} and score its games?`
            : `Allow ${playerNickname(playerId)} to score all games in ${currentLeagueName}?`)) return;

          const finishAccessFocus = trackInteractionFocus(target.closest('[data-ui="roster-player"], [data-ui="roster-member"]'));
          rosterMutationPending = true;
          ++playersReadVersion;
          target.disabled = true;
          renderRosterSetup();
          clearError();
          const feedback = beginGameFeedback("Updating scorer access…");

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

            const player = verifiedAdminPlayers.get(playerId);
            if (player) verifiedAdminPlayers.set(playerId, { ...player, access: { ...player.access, role } });
            await loadPlayerSearch();
            finishGameFeedback(
              role === "admin"
                ? "Player can now co-organise and score."
                : "Player can now score this league's games.",
              feedback,
            );
          } catch (error) {
            if (isDefinitiveRequestRejection(error) && !uncertainReadBarriers.has(`POST:/v1/leagues/${encodeURIComponent(currentLeagueId)}/access`)) {
              const message = error instanceof Error ? error.message : "Could not update scorer access.";
              showError(message);
              setStatus("Scorer access update failed.", "error");
            } else {
              showError("Access change could not be confirmed. Reload to check before trying again.", { includesOutcome: true });
            }
          } finally {
            rosterMutationPending = false;
            const ownsFocus = finishAccessFocus();
            renderRosterSetup();
            if (ownsFocus && refreshWriteLocked) refreshRetry?.focus();
            else if (ownsFocus) {
              const player = [...root.querySelectorAll('[data-ui="roster-player"][data-player-id], [data-ui="roster-member"][data-player-id]')]
                .find((element) => element.getAttribute("data-player-id") === playerId);
              const focusTarget = player?.querySelector('[data-action="toggle-action-menu"]') ?? player;
              if (focusTarget instanceof HTMLElement) {
                if (focusTarget === player) focusTarget.setAttribute("tabindex", "-1");
                focusTarget.focus({ preventScroll: true });
              }
            }
          }
          return;
        }

        if (action !== "assign-player") {
          return;
        }

        if (finishedRosterControlsLocked() || rosterMutationPending || playerCreatePending || target.disabled) {
          return;
        }

        const playerId = target.getAttribute("data-player-id");
        const teamId = target.getAttribute("data-team-id");
        if (!playerId || !teamId || !teamById(teamId) || !playerById(playerId)) {
          return;
        }

        const originalFocus = captureRosterFocus();
        const finishFocus = trackInteractionFocus(target.closest('[data-player-id]'));
        rosterMutationPending = true;
        ++rosterReadVersion;
        target.disabled = true;
        const isTransferAssignment = target.closest('[data-ui="transfer-menu"]') !== null;
        renderRosterSetup();
        clearError();
        const feedback = beginGameFeedback("Assigning player…");

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
          if (isDefinitiveRequestRejection(error) && !uncertainReadBarriers.has(`PUT:/v1/games/${encodeURIComponent(gameId)}/roster/${encodeURIComponent(playerId)}`)) {
            const message = error instanceof Error ? error.message : "Could not assign player.";
            showError(message);
            setStatus("Roster assignment failed.", "error");
          } else {
            showError("Assignment could not be confirmed. Reload to check before making more changes.", { includesOutcome: true });
          }
          rosterMutationPending = false;
          const ownsFocus = finishFocus();
          renderRosterSetup();
          if (ownsFocus && refreshWriteLocked) refreshRetry?.focus();
          else if (ownsFocus) restoreRosterFocus(originalFocus);
          return;
        }

        if (isTransferAssignment) {
          openTransferPlayerId = null;
        }
        const existingAssignment = assignmentByPlayerId(playerId);
        const assignment = {
          ...(existingAssignment ?? {}),
          ...(committedAssignment && typeof committedAssignment === "object" ? committedAssignment : {}),
          gameId, playerId, teamId, player: existingAssignment?.player ?? playerById(playerId),
        };
        pendingAssignments.set(playerId, assignment);
        rosterAssignments = [
          ...rosterAssignments.filter((assignment) => assignment.playerId !== playerId),
          assignment,
        ];
        renderRosterSetup();

        let refreshFailed = false;
        try {
          await loadRosterSetup({ updateStatus: false });
        } catch (error) {
          refreshFailed = true;
          const message = error instanceof Error ? error.message : "Could not refresh the roster.";
          showError(`Assignment was saved, but the latest roster could not be loaded. ${message}`, { includesOutcome: true });
          setStatus("Roster assignment saved; roster refresh failed.", "error");
        }

        if (!refreshFailed) {
          const player = playerById(playerId);
          const team = teamById(teamId);
          finishGameFeedback(
            `${player?.nickname ?? "Player"} assigned to ${team?.name ?? teamId}.`,
            feedback,
          );
        }
        rosterMutationPending = false;
        const ownsFocus = finishFocus();
        renderRosterSetup();
        if (ownsFocus) focusTransferTrigger(playerId);
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

      goalAssistsElement.addEventListener("change", (event) => {
        const changedInput = event.target instanceof HTMLInputElement ? event.target : null;
        if (changedInput?.checked && goalAssistsElement.querySelectorAll("input:checked").length > 3) changedInput.checked = false;
        refreshGoalOptions();
        renderGoalControls({}, true);
      });

      goalAssistsDropdown.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !goalAssistsDropdown.open) {
          return;
        }
        event.preventDefault();
        goalAssistsDropdown.open = false;
        goalAssistsDropdown.querySelector("summary")?.focus();
      });

      goalForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (goalMutationInFlight || goalOperation || timerMutationPending || clockOperation || !canScoreGame() || !goalTimelineLoaded) return;
        clearError();
        const draft = buildGoalPayload();
        if (draft.error || !draft.payload) {
          showError(draft.error ?? "Goal details are incomplete.");
          setStatus("Goal validation failed.", "error");
          return;
        }
        goalOperation = newGoalOperation(editingGoalId ? "edit" : "create", editingGoalId, draft.payload);
        void performGoalOperation(goalOperation, saveGoalButton);
      });

      retryGoalButton.addEventListener("click", () => {
        if (goalOperation?.uncertain) void performGoalOperation(goalOperation, retryGoalButton);
      });

      cancelGoalEditButton.addEventListener("click", () => {
        if (goalMutationInFlight || goalOperation || timerMutationPending || clockOperation) return;
        resetGoalForm();
        setStatus("");
        focusNextGoal();
      });

      undoLastGoalButton.addEventListener("click", () => {
        if (goalMutationInFlight || goalOperation || timerMutationPending || clockOperation || !canScoreGame() || !goalTimelineLoaded) return;
        const latest = goalTimeline.at(-1);
        if (!latest) return;
        goalOperation = newGoalOperation("undo", latest.eventId);
        void performGoalOperation(goalOperation, undoLastGoalButton);
      });

      root.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
        if (!(target instanceof HTMLButtonElement)) return;
        const action = target.getAttribute("data-action");
        if (action !== "edit-goal" && action !== "delete-goal") return;
        if (target.disabled || goalMutationInFlight || goalOperation || timerMutationPending || clockOperation || !canScoreGame() || !goalTimelineLoaded) return;
        const eventId = target.getAttribute("data-event-id");
        const goal = goalTimeline.find((item) => item.eventId === eventId);
        if (!goal || !goalEventControlAvailable(eventId)) return;
        if (action === "edit-goal") {
          populateGoalForm(goal);
          return;
        }
        if (!window.confirm("Delete " + playerNickname(goal.scorerPlayerId) + " goal at " + goalDisplayTime(goal) + "?")) return;
        goalOperation = newGoalOperation("delete", eventId);
        void performGoalOperation(goalOperation, target);
      });
    }

    // Read freshness is deliberately separate from the write/recovery owners.
    // These endpoints are independent snapshots, not a concurrent-edit protocol.
    const refreshRoot = root;
    const refreshNotice = document.getElementById("game-refresh-notice");
    const refreshMessage = document.getElementById("game-refresh-message");
    const refreshRetry = root.querySelector('[data-action="retry-game-updates"]');
    let refreshTimer = 0;
    let refreshFlight = null;
    let refreshGeneration = 0;
    let refreshEpoch = 0;
    let refreshFailures = 0;
    let refreshLastFullAt = Date.now();
    let refreshForceFull = false;
    let refreshStarted = false;
    let refreshSuspended = false;
    let refreshRemoved = false;
    const uncertainReadBarriers = new Set();

    function refreshVisible() {
      return !refreshRemoved && refreshRoot.isConnected && !refreshSuspended &&
        document.visibilityState !== "hidden" && !accountRevalidating && !signOutPending && !signOutUnconfirmed;
    }

    function setRefreshNotice(message = "") {
      if (refreshWriteLocked && !refreshAccountLocked) message = "An earlier change is unconfirmed. Reload to check before making more changes.";
      const ownedFocus = !message && refreshNotice?.contains(document.activeElement);
      if (refreshNotice) refreshNotice.hidden = !message;
      if (refreshMessage && refreshMessage.textContent !== message) refreshMessage.textContent = message;
      const label = refreshAccountLocked || uncertainReadBarriers.size ? "Reload game" : "Retry updates";
      if (refreshRetry && refreshRetry.textContent !== label) refreshRetry.textContent = label;
      if (ownedFocus) gameModePanels.find((panel) => !panel.hidden)?.focus({ preventScroll: true });
    }

    function refreshDelay() {
      const cadence = currentGame?.status === "live" ? 5000 : 15000;
      return Math.min(60000, cadence * (2 ** Math.min(refreshFailures, 4)));
    }

    function scheduleRefresh(delay = refreshDelay()) {
      window.clearTimeout(refreshTimer);
      refreshTimer = 0;
      if (!refreshStarted || !refreshVisible() || refreshAccountLocked || refreshFlight) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = 0;
        void refreshMatch();
      }, delay);
    }

    function invalidateRefresh() {
      refreshGeneration += 1;
      window.clearTimeout(refreshTimer);
      refreshTimer = 0;
      if (refreshFlight) {
        refreshFlight.cancelled = true;
        window.clearTimeout(refreshFlight.deadline);
        refreshFlight.controller.abort();
      }
    }

    beforeGameWrite = (path, method) => {
      if (existingPlayerAttempt?.uncertain && path !== existingPlayerAttempt.path && path !== "/v1/auth/logout") throw new Error("Retry the unconfirmed player addition before making another change.");
      if (refreshAccountLocked && path !== "/v1/auth/logout") throw new Error("Your account changed. Reload before making changes.");
      if (refreshWriteLocked && path !== "/v1/auth/logout") throw new Error("An earlier change is unconfirmed. Reload before making changes.");
      // Synchronous and before fetch, including writes made outside this root.
      refreshEpoch += 1;
      invalidateRefresh();
      scheduleRefresh();
      const owner = `${method}:${path}`;
      const dedicatedOwner = (goalOperation?.path === path && goalOperation.request.method === method) ||
        (clockOperation?.path === path && clockOperation.request.method === method) ||
        (playerCreateAttempt?.request.path === path && playerCreateAttempt.request.init.method === method) ||
        (existingPlayerAttempt?.path === path && method === "POST") ||
        playerInvitation.ownsRequest(path);
      return (result) => {
        // These writes already have an explicit recovery owner. A clock GET
        // can confirm its operation without replaying the POST; don't strand
        // freshness behind an additional generic barrier.
        if (dedicatedOwner) return;
        if (!result || result.status >= 500 || [408, 429].includes(result.status)) {
          uncertainReadBarriers.add(owner);
          // Legacy writes have no frozen replay owner. A different payload to
          // the same path cannot prove an earlier request settled. Keep this
          // page read-only until explicit reload, even after other successes.
          refreshWriteLocked = true;
          renderBackgroundState();
          setRefreshNotice();
        }
      };
    };

    function localWriteOwnsState() {
      return Boolean(gameMetadataPending || gameDeletionPending || goalMutationInFlight || timerMutationPending ||
        rosterMutationPending || playerCreatePending || goalOperation || clockOperation || playerCreateAttempt ||
        playerInvitation.hasPending() || existingPlayerAttempt || uncertainReadBarriers.size);
    }

    function discardPrivateEnrichment() {
      playerInvitation.discard();
      pickerVersion += 1; pickerPlayers.clear(); pickerList.replaceChildren(); pickerCursor = null; pickerMore.hidden = true;
      pickerSearch.value = ""; pickerMessage("");
      ++playersReadVersion;
      knownRosterPlayers.clear();
      verifiedAdminPlayers.clear();
      rosterPlayers = [];
      playerSearchState = "unavailable";
      finishedRosterEditing = false;
      finishedResultEditing = false;
      openTransferPlayerId = null;
      closeActionMenu();
    }

    function lockRefreshAccount(message) {
      window.ThreeFcPlayerProof?.clear();
      refreshAccountLocked = true;
      authorityRevision += 1;
      currentLeagueRole = null;
      discardPrivateEnrichment();
      // Keep operation identity and drafts, but do not allow this page's old
      // account to submit them under a newly switched cookie.
      renderRosterSetup();
      renderTimer();
      renderGoalControls({}, true);
      for (const button of goalTimelineElement?.querySelectorAll("button") ?? []) button.disabled = true;
      setRefreshNotice(message);
    }

    function refreshRosterValid(payload, { allowUnavailableUnassigned = false } = {}) {
      const teams = payload?.teams;
      return Array.isArray(teams) && teams.length === 3 && new Set(teams.map((team) => team.teamId)).size === 3 &&
        teams.every((team) => ["red", "blue", "yellow"].includes(team?.teamId) && (!team.gameId || team.gameId === gameId)) &&
        Array.isArray(payload.roster) && new Set(payload.roster.map((item) => item.playerId)).size === payload.roster.length &&
        payload.roster.every((item) => usableEntityId(item?.playerId) && ["red", "blue", "yellow"].includes(item.teamId) &&
          (!item.gameId || item.gameId === gameId) && (!item.player || (item.player.playerId === item.playerId && typeof item.player.nickname === "string"))) &&
        (allowUnavailableUnassigned || payload.unassignedPlayers === undefined || (Array.isArray(payload.unassignedPlayers) && payload.unassignedPlayers.every((player) => usableEntityId(player?.playerId) && typeof player.nickname === "string" && player.nickname.trim())));
    }

    function refreshGameValid(game) {
      if (game?.gameId !== gameId || game.leagueId !== currentLeagueId || game.seasonId !== currentSeasonId ||
        !["scheduled", "live", "finished"].includes(game.status) || !Number.isFinite(Date.parse(game.gameStartTs))) return false;
      const segments = game.timer?.thirds ?? game.thirds;
      if (!Array.isArray(segments) || segments.length !== 3 || new Set(segments.map((segment) => segment?.third)).size !== 3 ||
        ![20, 25, 30].includes(game.thirdLengthMinutes)) return false;
      for (const segment of segments) {
        if (!segment || ![1, 2, 3].includes(segment.third) ||
          ![segment.startedAt, segment.finishedAt].every((value) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)))) ||
          (segment.finishedAt && (!segment.startedAt || Date.parse(segment.finishedAt) < Date.parse(segment.startedAt)))) return false;
        if (game.timer && segment.status !== (segment.finishedAt ? "finished" : segment.startedAt ? "running" : "not_started")) return false;
      }
      const sorted = [...segments].sort((left, right) => left.third - right.third);
      if (sorted.some((segment, index) => index > 0 && segment.startedAt && !sorted[index - 1].finishedAt)) return false;
      const running = sorted.filter((segment) => segment.startedAt && !segment.finishedAt);
      const status = running.length ? "running" : sorted.every((segment) => segment.finishedAt) ? "complete" : sorted.some((segment) => segment.startedAt) ? "between_thirds" : "not_started";
      if (running.length > 1 || (game.timer && (game.timer.thirdLengthMinutes !== game.thirdLengthMinutes || game.timer.status !== status || game.timer.activeThird !== (running[0]?.third ?? null)))) return false;
      if (game.status === "finished") {
        const result = game.result;
        if (!normalizeScoreboardTeams(result?.teams).length || !["win", "draw"].includes(result?.outcome) ||
          (result.outcome === "draw" ? result.winnerTeamId !== null : !["red", "blue", "yellow"].includes(result.winnerTeamId)) ||
          result.comparator !== "fewest_conceded_then_most_scored" || !Number.isFinite(Date.parse(result.computedAt)) || !resultOutcome(result.teams, result)) return false;
      }
      return true;
    }

    function renderBackgroundState() {
      refreshingPresentation = true;
      try {
        renderTimer();
        renderLiveScoreboard();
        refreshGoalOptions();
        renderGoalControls({}, true);
        renderGoalTimeline();
        renderRosterSetup();
        renderPicker();
        for (const button of goalTimelineElement?.querySelectorAll("button[data-event-id]") ?? []) {
          button.disabled = !canScoreGame() || !goalTimeline.some((goal) => goal.eventId === button.getAttribute("data-event-id"));
        }
      } finally {
        refreshingPresentation = false;
      }
    }

    async function refreshMatch() {
      if (!refreshStarted || refreshFlight || !refreshVisible() || refreshAccountLocked) return;
      const flight = { controller: new AbortController(), generation: refreshGeneration, epoch: refreshEpoch, cancelled: false };
      refreshFlight = flight;
      const current = () => !flight.cancelled && flight.generation === refreshGeneration && flight.epoch === refreshEpoch && refreshVisible();
      const full = refreshForceFull || Date.now() - refreshLastFullAt >= 15000;
      flight.full = full;
      refreshForceFull = false;
      const deadline = window.setTimeout(() => {
        if (!current()) return;
        flight.cancelled = true;
        flight.controller.abort();
        refreshFailures += 1;
        setRefreshNotice("Updates unavailable. Showing the last loaded game.");
        // Do not release the flight until fetch/body consumption really settles.
        // Even an abort-ignoring transport cannot cause overlapping requests.
      }, 12000);
      flight.deadline = deadline;
      const read = async (path) => {
        if (!current()) throw new Error("Superseded read");
        const value = await requestJsonOrThrow(path, { method: "GET", cache: "no-store", signal: flight.controller.signal });
        if (!current()) throw new Error("Superseded read");
        return value;
      };
      const sameSession = async () => {
        const session = (await read("/v1/auth/session"))?.session;
        if (!usableEntityId(session?.sessionId) || !usableEntityId(session?.email) ||
          session.sessionId !== authenticatedSession?.sessionId || session.email !== authenticatedSession?.email) {
          lockRefreshAccount("Your sign-in changed. Reload this game before continuing.");
          return false;
        }
        return true;
      };
      const applyAuthority = (league) => {
        if (!league) return;
        const role = normalizeLeagueRole(league.access.role);
        authorityRevision += 1;
        if (role !== currentLeagueRole) {
          discardPrivateEnrichment();
          currentLeagueRole = role;
          renderRosterSetup();
          renderTimer();
          renderGoalControls({}, true);
        }
      };
      try {
        let league = null;
        if (full) {
          if (!await sameSession()) return;
          league = await read(`/v1/leagues/${encodeURIComponent(currentLeagueId)}`);
          if (league?.leagueId !== currentLeagueId || !normalizeLeagueRole(league?.access?.role)) throw new Error("Invalid league read");
        }
        // Full authority revalidation is allowed during uncertainty. It cannot
        // acknowledge, retry or supersede any in-flight or unconfirmed write.
        if (localWriteOwnsState()) {
          // Authority is also staged while a write owns match data. Never
          // apply a role fetched with a cookie switched after the first probe.
          if (!await sameSession()) return;
          applyAuthority(league);
          if (full) refreshLastFullAt = Date.now();
          if (refreshWriteLocked) setRefreshNotice();
          return;
        }
        const gamePath = `/v1/games/${encodeURIComponent(gameId)}`;
        const game = await read(gamePath);
        const goals = await read(`${gamePath}/goals`);
        const confirmedBeforeRosterRead = new Map(pendingAssignments);
        const roster = full ? await read(`${gamePath}/roster`) : null;
        const teams = normalizeScoreboardTeams(goals?.scoreboard?.teams);
        const timeline = decodeGoalTimeline(goals?.timeline);
        if (!refreshGameValid(game) ||
          !teams.length || goals.scoreboard.teams.some((team) => team.gameId && team.gameId !== gameId) || timeline === null ||
          (roster && !refreshRosterValid(roster))) throw new Error("Invalid game read");
        // Every batch, including the five-second lightweight reads, verifies
        // identity immediately before synchronous apply. Independent cookie
        // requests are not an atomic session snapshot; do not claim otherwise.
        if (!await sameSession() || !current() || localWriteOwnsState()) return;
        applyAuthority(league);
        if (roster) {
          const before = JSON.stringify([rosterTeams, rosterAssignments, rosterUnassignedPlayers]);
          applyRosterPayload(roster, confirmedBeforeRosterRead);
          if (JSON.stringify([rosterTeams, rosterAssignments, rosterUnassignedPlayers]) !== before) draftRosterChanged = true;
        }
        if (editingGoalId && editingGoalSnapshot !== JSON.stringify(timeline.find((goal) => goal.eventId === editingGoalId))) editingGoalChanged = true;
        goalTimeline = timeline;
        goalTimelineLoaded = true;
        scoreboardTeams = teams;
        scoreboardState = "authoritative";
        applyGameView(game);
        if (league && typeof league.name === "string") {
          currentLeagueName = league.name;
          if (gameLeagueLink) gameLeagueLink.textContent = league.name;
        }
        renderBackgroundState();
        if (full) refreshLastFullAt = Date.now();
        refreshFailures = 0;
        setRefreshNotice();
      } catch (error) {
        if (current()) {
          if (error?.statusCode === 401 || error?.statusCode === 403) lockRefreshAccount("Your access changed. Reload this game before continuing.");
          else {
            refreshFailures += 1;
            setRefreshNotice("Updates unavailable. Showing the last loaded game.");
          }
        }
      } finally {
        window.clearTimeout(deadline);
        refreshFlight = null;
        if (refreshForceFull && refreshVisible() && !refreshAccountLocked) void refreshMatch();
        else scheduleRefresh();
      }
    }

    function requestFullRefresh() {
      // Coalesce duplicate focus/visibility/manual signals into one flight.
      if (refreshFlight?.full && !refreshFlight.cancelled) return;
      refreshForceFull = true;
      window.clearTimeout(refreshTimer);
      refreshTimer = 0;
      if (!refreshFlight) void refreshMatch();
    }

    refreshRetry?.addEventListener("click", () => {
      if (refreshAccountLocked || uncertainReadBarriers.size) {
        navigateTo(`${window.location.pathname}${window.location.search}${window.location.hash}`, "reload");
        return;
      }
      requestFullRefresh();
    });
    root.querySelector('[data-action="reload-game-details"]')?.addEventListener("click", () => {
      navigateTo(`${window.location.pathname}${window.location.search}${window.location.hash}`, "reload");
    });
    function suspendRefresh() {
      invalidateRefresh();
      window.clearInterval(timerTickInterval);
      timerTickInterval = 0;
    }
    document.addEventListener("visibilitychange", () => {
      if (!refreshVisible()) suspendRefresh();
      else {
        renderTimer();
        requestFullRefresh();
      }
    });
    window.addEventListener("focus", () => {
      if (!refreshVisible()) return;
      requestFullRefresh();
    });
    window.addEventListener("pagehide", () => { refreshSuspended = true; suspendRefresh(); });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) { suspendRefresh(); return; }
      refreshSuspended = false;
      if (refreshStarted) requestFullRefresh();
    });
    const rootObserver = new MutationObserver(() => {
      if (refreshRoot.isConnected) return;
      refreshRemoved = true;
      suspendRefresh();
      rootObserver.disconnect();
    });
    rootObserver.observe(document.body, { childList: true, subtree: true });

    syncGameModeState();
    await loadGame();
    await loadLeagueAccess();
    try {
      await loadRosterSetup({ updateStatus: false });
    } catch {
      showError("Teams couldn’t be loaded. Reload this page to try again.", { includesOutcome: true });
    }
    await loadPlayerSearch();
    const goalsLoaded = await loadGameGoals();
    if (!goalsLoaded && scoreboardState !== "authoritative") {
      scoreboardState = "unavailable";
      renderLiveScoring();
    }
    if (!manualGameModeSelected) {
      setGameMode(preferredInitialGameMode(), { history: "replace" });
    }
    syncGameModeState();

    try {
      const seasonPath = currentLeagueId
        ? `/v1/leagues/${encodeURIComponent(currentLeagueId)}/seasons/${encodeURIComponent(currentSeasonId)}`
        : `/v1/seasons/${encodeURIComponent(currentSeasonId)}`;
      const season = await requestJsonOrThrow(seasonPath, { method: "GET" });
      if (season?.leagueId === currentLeagueId && season?.seasonId === currentSeasonId && gameSeasonLink instanceof HTMLAnchorElement) {
        gameSeasonLink.textContent = season.name;
      }
    } catch {
      // Keep existing game context if season lookup fails.
    }

    if (goalsLoaded || isGameFinished()) {
      setStatus("");
    }
    refreshStarted = true;
    refreshLastFullAt = Date.now();
    if (refreshForceFull) void refreshMatch();
    else scheduleRefresh();
  }

  async function initJoinPage() {
    const query = new URLSearchParams(window.location.search);
    const joinCode = normalizedEntryCode(query.get("code") || resolveRouteEntityId("data-join-code", "join") || "");
    const form = document.getElementById("join-game-form");
    const nicknameInput = document.getElementById("join-player-nickname");
    const joinButton = root.querySelector('[data-action="join-game"]');
    const anotherButton = root.querySelector('[data-action="join-another-player"]');
    const resultElement = document.getElementById("join-result");
    const resultPlayer = document.getElementById("join-result-player");
    const claimActions = document.getElementById("join-claim-actions");
    const claimStatus = document.getElementById("join-claim-status");
    const signInLink = document.getElementById("join-signin-link");
    const claimButton = root.querySelector('[data-action="claim-player"]');
    const lookupButton = root.querySelector('[data-action="retry-join-context"]');
    const queryPlayerId = query.get("playerId");
    let claimPlayerId = usableEntityId(queryPlayerId) ? queryPlayerId : "";
    entryClaimPlayerId = claimPlayerId || null;
    let joinAttempt = null;
    let unissuedJoinProof = null;
    let linkingUnavailable = false;
    let creationAllowed = false;
    let entryLocked = false;
    let returningPlayer = null;
    const createCancel = document.getElementById("join-create-cancel");
    let joinPending = false;
    let joined = false;
    let claimPending = false;
    let claimComplete = false;
    let verifiedClaimPlayerId = "";
    let contextLookupPending = false;
    let contextLookupRevision = 0;
    let claimRevision = 0;
    let entryNavigationRevision = 0;
    let entryFlowRevision = 0;
    window.addEventListener("popstate", () => { entryNavigationRevision += 1; });
    window.addEventListener("hashchange", () => { entryNavigationRevision += 1; });
    const codeValue = document.getElementById("join-code-value");
    if (codeValue) codeValue.textContent = joinCode || "Missing";

    if (!(form instanceof HTMLFormElement) || !(nicknameInput instanceof HTMLInputElement) ||
      !(joinButton instanceof HTMLButtonElement) || !(claimButton instanceof HTMLButtonElement)) return;
    if (!validEntryCode(joinCode)) {
      form.hidden = true;
      showError("This join link is missing or invalid. Ask the organiser for a new link.", { includesOutcome: true });
      return;
    }

    function claimMessage(text) {
      if (claimStatus instanceof HTMLElement) {
        claimStatus.textContent = text;
        claimStatus.hidden = !text;
      }
    }

    function trackEntryFocus(scope) {
      const revision = entryNavigationRevision;
      const flowRevision = entryFlowRevision;
      let ownsFocus = scope?.contains(document.activeElement) === true;
      const onFocus = (event) => { if (event.target !== document.body && !scope?.contains(event.target)) ownsFocus = false; };
      const onPointer = (event) => { if (!scope?.contains(event.target)) ownsFocus = false; };
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("pointerdown", onPointer, true);
      return () => {
        document.removeEventListener("focusin", onFocus, true);
        document.removeEventListener("pointerdown", onPointer, true);
        return ownsFocus && revision === entryNavigationRevision && flowRevision === entryFlowRevision;
      };
    }

    function focusClaimContinuation() {
      const target = claimComplete ? anotherButton
        : !claimButton.hidden && !claimButton.disabled ? claimButton
          : lookupButton instanceof HTMLButtonElement && !lookupButton.hidden && !lookupButton.disabled ? lookupButton
            : signInLink instanceof HTMLAnchorElement && !signInLink.hidden ? signInLink : anotherButton;
      if (target instanceof HTMLElement && actionElementVisible(target) && !target.matches(":disabled")) target.focus();
    }

    function renderJoinState() {
      returningPlayer?.setRegistrationPending(joinPending || Boolean(joinAttempt) || joined || entryLocked);
      nicknameInput.disabled = entryLocked || joinPending || joinAttempt !== null || joined || Boolean(claimPlayerId);
      if (joinAttempt) nicknameInput.value = joinAttempt.nickname;
      joinButton.disabled = entryLocked || joinPending || joined || Boolean(claimPlayerId);
      joinButton.textContent = joinAttempt?.uncertain ? "Retry join" : "Join game";
      form.hidden = entryLocked || !creationAllowed || joined || Boolean(claimPlayerId);
      if (createCancel) createCancel.disabled = joinPending || Boolean(joinAttempt);
      if (anotherButton instanceof HTMLButtonElement) {
        anotherButton.hidden = !joined && !claimPlayerId;
        anotherButton.disabled = claimPending || joinPending;
      }
    }

    async function currentJoinSession() {
      const result = await requestJson("/v1/auth/session", { method: "GET", cache: "no-store" });
      if (result.status === 401) return null;
      const session = result.body?.session;
      if (!result.ok || result.body?.authenticated !== true || !usableEntityId(session?.sessionId) ||
        typeof session?.email !== "string" || !session.email.trim()) throw new Error("session_unconfirmed");
      return session;
    }

    async function claimJoinedPlayer(playerId) {
      if (claimPending || claimComplete || !usableEntityId(playerId) || playerId !== claimPlayerId || claimButton.disabled) return;
      const proof = window.ThreeFcPlayerProof?.forPlayer(playerId);
      if (!proof) {
        claimButton.hidden = true;
        claimMessage("Ask the organiser for a private link to link this player to your account.");
        return;
      }
      // Navigation only: the recipient page shows the exact player and account
      // together, then requires an explicit server-bound confirmation.
      navigateTo(window.ThreeFcPlayerProof.destination(proof.proofId));
    }

    async function refreshClaimActions(playerId) {
      if (linkingUnavailable) {
        claimButton.hidden = true;
        if (signInLink instanceof HTMLElement) signInLink.hidden = true;
        if (claimActions instanceof HTMLElement) claimActions.hidden = false;
        claimMessage("You’ve joined the game. Linking your player profile is temporarily unavailable.");
        return;
      }
      if (contextLookupPending) return;
      contextLookupPending = true;
      const lookupRevision = ++contextLookupRevision;
      const revision = ++claimRevision;
      if (claimActions instanceof HTMLElement) claimActions.hidden = false;
      claimButton.disabled = true;
      claimButton.hidden = true;
      if (signInLink instanceof HTMLAnchorElement) signInLink.hidden = true;
      if (lookupButton instanceof HTMLButtonElement) { lookupButton.hidden = true; lookupButton.disabled = true; }
      try {
        const session = await currentJoinSession();
        if (revision !== claimRevision || playerId !== claimPlayerId || claimPending || claimComplete) return;
        setAccountSession(session);
        claimMessage("");
        if (session) {
          if (verifiedClaimPlayerId !== playerId) {
            // Opaque IDs belong in a query value: API Gateway decodes path
            // components before routing, including encoded slashes/percent signs.
            const params = new URLSearchParams({ playerId });
            if (params.get("playerId") !== playerId) throw new Error("context_unavailable");
            const path = `/v1/join/${encodeURIComponent(joinCode)}/player-context?${params}`;
            claimMessage("Loading player…");
            let context;
            try { context = await requestJsonOrThrow(path, { method: "GET", cache: "no-store" }); }
            catch (error) {
              if (revision !== claimRevision || playerId !== claimPlayerId) return;
              if (error.statusCode === 404) {
                claimMessage("");
                showError("This player couldn’t be found for this join link. Ask the organiser for help.", { includesOutcome: true });
                return;
              }
              throw error;
            }
            if (revision !== claimRevision || playerId !== claimPlayerId) return;
            if (context?.joinCode !== joinCode || !usableEntityId(context?.gameId) || context?.player?.playerId !== playerId ||
              typeof context.player.nickname !== "string" || !context.player.nickname.trim()) throw new Error("context_unconfirmed");
            verifiedClaimPlayerId = playerId;
            if (resultPlayer) resultPlayer.textContent = context.player.nickname;
            if (resultElement) resultElement.hidden = false;
          }
          const proof = window.ThreeFcPlayerProof?.forPlayer(playerId);
          claimButton.hidden = !proof;
          claimButton.disabled = !proof;
          claimButton.textContent = "Link player profile";
          claimMessage(proof ? "" : "Ask the organiser for a private link to link this player to your account.");
        } else if (signInLink instanceof HTMLAnchorElement) {
          const proof = window.ThreeFcPlayerProof?.forPlayer(playerId);
          signInLink.hidden = !proof;
          signInLink.textContent = "Sign in to link your player profile";
          if (proof) signInLink.href = `/sign-in?returnTo=${encodeURIComponent(window.ThreeFcPlayerProof.destination(proof.proofId))}`;
          else claimMessage("Ask the organiser for a private link to link this player to your account.");
        }
      } catch (error) {
        if (revision === claimRevision && playerId === claimPlayerId) throw error;
      } finally {
        if (lookupRevision === contextLookupRevision) {
          contextLookupPending = false;
          if (lookupButton instanceof HTMLButtonElement) lookupButton.disabled = false;
        }
      }
    }

    function claimProbeFailed() {
      if (!claimPlayerId || claimComplete) return;
      claimMessage("");
      const identityKnown = verifiedClaimPlayerId === claimPlayerId;
      const proof = window.ThreeFcPlayerProof?.forPlayer(claimPlayerId);
      showError((joined ? "Joined game. " : "") + (identityKnown
        ? proof ? "Sign-in could not be checked. Open your private player link or sign in again."
          : "Ask the organiser for a private link to link this player to your account."
        : "The player details couldn’t be loaded. Retry lookup or sign in again."), { includesOutcome: true });
      claimButton.hidden = !identityKnown || !proof;
      claimButton.disabled = !identityKnown || !proof;
      claimButton.textContent = "Link player profile";
      if (lookupButton instanceof HTMLButtonElement) lookupButton.hidden = identityKnown;
      if (signInLink instanceof HTMLAnchorElement) {
        signInLink.hidden = false;
        signInLink.href = proof ? `/sign-in?returnTo=${encodeURIComponent(window.ThreeFcPlayerProof.destination(proof.proofId))}` : entrySignInHref(claimPlayerId);
      }
    }

    if (claimPlayerId) void refreshClaimActions(claimPlayerId).catch(claimProbeFailed);
    else {
      returningPlayer = window.ThreeFcReturningPlayer?.initialize({ joinCode,
        onSession: setAccountSession,
        onCreate: (options = {}) => {
          if (entryLocked || joinAttempt || claimPlayerId || joined) return;
          creationAllowed = true;
          if (createCancel) createCancel.hidden = options.anonymous === true;
          renderJoinState();
          if (!options.anonymous) nicknameInput.focus();
        },
        onLock: () => { entryLocked = true; creationAllowed = false; ++entryFlowRevision; ++claimRevision; renderJoinState(); },
      });
      if (returningPlayer) returningPlayer.start();
      else showError("The join form couldn’t load. Reload this page to try again.", { includesOutcome: true });
    }
    createCancel?.addEventListener("click", () => {
      if (joinPending || joinAttempt || entryLocked) return;
      creationAllowed = false; renderJoinState(); returningPlayer?.start();
    });
    renderJoinState();
    nicknameInput.addEventListener("input", () => {
      if (joinAttempt) { nicknameInput.value = joinAttempt.nickname; return; }
      clearError();
      setFieldMessage("join-player-nickname");
    });
    claimButton.addEventListener("click", () => { void claimJoinedPlayer(claimPlayerId); });
    if (lookupButton instanceof HTMLButtonElement) lookupButton.addEventListener("click", () => {
      if (lookupButton.disabled || contextLookupPending || !claimPlayerId) return;
      const finishFocus = trackEntryFocus(lookupButton);
      clearError();
      void refreshClaimActions(claimPlayerId).catch(claimProbeFailed).finally(() => {
        if (finishFocus()) focusClaimContinuation();
      });
    });
    if (anotherButton instanceof HTMLButtonElement) anotherButton.addEventListener("click", () => {
      if (anotherButton.disabled || joinPending || claimPending || joinAttempt) return;
      ++claimRevision;
      ++entryFlowRevision;
      ++contextLookupRevision;
      contextLookupPending = false;
      claimPlayerId = "";
      verifiedClaimPlayerId = "";
      entryClaimPlayerId = null;
      joined = false;
      claimComplete = false;
      linkingUnavailable = false;
      creationAllowed = true;
      returningPlayer?.hide();
      claimMessage("");
      if (resultElement) resultElement.hidden = true;
      if (claimActions instanceof HTMLElement) claimActions.hidden = true;
      nicknameInput.value = "";
      clearError();
      setStatus("");
      setFieldMessage("join-player-nickname");
      renderJoinState();
      nicknameInput.focus();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (entryLocked || !creationAllowed || joinPending || joined || claimPlayerId) return;
      const flowAtDispatch = entryFlowRevision;
      if (unissuedJoinProof) {
        try { window.ThreeFcPlayerProof.discardDraft(unissuedJoinProof); unissuedJoinProof = null; }
        catch {
          showError("Your browser couldn’t clear the saved private link. Allow site storage, then retry.", { includesOutcome: true });
          return;
        }
      }
      if (!joinAttempt) {
        const nickname = nicknameInput.value.trim();
        if (!nickname) {
          setFieldMessage("join-player-nickname", "invalid", "Player name is required.");
          nicknameInput.focus();
          return;
        }
        joinPending = true;
        renderJoinState();
        try {
          const key = idempotencyKeyForPublicJoin(joinCode, nickname);
          const proof = await window.ThreeFcPlayerProof.create(`${joinCode}:${key}`);
          if (flowAtDispatch !== entryFlowRevision || entryLocked) return;
          joinAttempt = {
            nickname, proof, uncertain: false,
            path: "/v1/join/" + encodeURIComponent(joinCode),
            request: Object.freeze({ method: "POST", headers: Object.freeze({
              "Content-Type": "application/json", "Idempotency-Key": key,
            }), body: JSON.stringify({ nickname, claimProof: { proofId: proof.proofId, verifier: proof.verifier } }) }),
          };
        } catch (error) {
          joinPending = false;
          renderJoinState();
          showError(error.message === "proof_storage_full"
            ? "This tab is holding too many private links. Save any links you need. Copy this join link, open a fresh tab, and paste it into the address bar."
            : "Your browser could not keep the private profile link. Allow site storage or try another browser before joining.", { includesOutcome: true });
          return;
        }
      }
      const attempt = joinAttempt;
      const finishFocus = trackEntryFocus(form);
      joinPending = true;
      renderJoinState();
      clearError();
      setStatus("Joining game…", "default");
      try {
        const result = await requestJsonOrThrow(attempt.path, attempt.request);
        if (flowAtDispatch !== entryFlowRevision || entryLocked) return;
        if (!usableEntityId(result?.gameId) || !usableEntityId(result?.player?.playerId) ||
          typeof result.player.nickname !== "string" || result.player.nickname.trim() !== attempt.nickname ||
          (result.joinCode !== undefined && result.joinCode !== joinCode) ||
          (result.link !== undefined && (result.link?.gameId !== result.gameId || result.link?.playerId !== result.player.playerId))) throw new Error("join_unconfirmed");
        joined = true;
        linkingUnavailable = result.linkingUnavailable === true;
        returningPlayer?.hide();
        joinAttempt = null;
        clearIdempotencyKeyForPublicJoin(joinCode, attempt.nickname);
        claimPlayerId = result.player.playerId;
        verifiedClaimPlayerId = claimPlayerId;
        entryClaimPlayerId = claimPlayerId;
        try {
          if (linkingUnavailable) {
            unissuedJoinProof = attempt.proof;
            window.ThreeFcPlayerProof.discardDraft(unissuedJoinProof);
            unissuedJoinProof = null;
          } else window.ThreeFcPlayerProof.attach(attempt.proof, result.claimProof, claimPlayerId);
        }
        catch { /* Registration committed; missing proof metadata must not repeat it or trigger a proofless claim. */ }
        if (resultPlayer) resultPlayer.textContent = result.player.nickname;
        if (resultElement) resultElement.hidden = false;
        setFieldMessage("join-player-nickname");
        setStatus("Joined game.", "success");
      } catch (error) {
        const definitive = !attempt.uncertain && isDefinitiveRequestRejection(error) && error.statusCode !== 408 &&
          (error.statusCode !== 409 || (error.responseError === "conflict" && ["game_finished", "join_state_changed"].includes(error.responseCode)));
        if (definitive) {
          try { window.ThreeFcPlayerProof.discardDraft(attempt.proof); }
          catch {
            showError("Your browser couldn’t clear the saved private link. Allow site storage, then retry. The same player name will be used.", { includesOutcome: true });
            return;
          }
          joinAttempt = null;
          clearIdempotencyKeyForPublicJoin(joinCode, attempt.nickname);
          showError(error.statusCode === 404 ? "This join link is unavailable. Ask the organiser for a new link."
            : error.responseCode === "game_finished" ? "This game has finished. Ask the organiser for help."
              : "Could not join the game. Check the player name and try again.", { includesOutcome: true });
        } else {
          attempt.uncertain = true;
          showError("Joining could not be confirmed. Retry uses the same player name.", { includesOutcome: true });
        }
      } finally {
        joinPending = false;
        renderJoinState();
      }
      if (joined) {
        try { await refreshClaimActions(claimPlayerId); } catch { claimProbeFailed(); }
      }
      if (finishFocus()) {
        if (joined) focusClaimContinuation();
        else (joinAttempt?.uncertain ? joinButton : nicknameInput).focus();
      }
    });
    setStatus("");
  }

  async function initInvitePage() {
    const initialCode = normalizedEntryCode(resolveRouteEntityId("data-invite-code", "invites") || new URLSearchParams(window.location.search).get("code"));
    const codeForm = document.getElementById("organiser-invite-code-form");
    const codeInput = document.getElementById("organiser-invite-code-input");
    const acceptance = document.getElementById("organiser-invite-acceptance");
    const acceptCode = document.getElementById("organiser-invite-accept-code");
    const acceptButton = document.querySelector('[data-action="accept-organiser-invite"]');
    const leagueLink = document.getElementById("organiser-invite-league-link");
    let attempt = null;
    let pending = false;
    let accepted = false;

    function showCodeForm(code = "") {
      if (codeForm instanceof HTMLFormElement) codeForm.hidden = false;
      if (acceptance instanceof HTMLElement) acceptance.hidden = true;
      if (codeInput instanceof HTMLInputElement) {
        codeInput.value = code;
        codeInput.disabled = false;
      }
    }

    function showInviteAcceptance(code) {
      if (codeForm instanceof HTMLFormElement) codeForm.hidden = true;
      if (acceptance instanceof HTMLElement) acceptance.hidden = false;
      if (acceptCode instanceof HTMLElement) acceptCode.textContent = code;
    }

    function renderAcceptance() {
      if (attempt) showInviteAcceptance(attempt.code);
      if (acceptButton instanceof HTMLButtonElement) {
        acceptButton.disabled = pending || accepted;
        acceptButton.hidden = accepted;
        acceptButton.textContent = attempt?.uncertain ? "Retry invite" : "Accept invite";
      }
      if (codeInput instanceof HTMLInputElement) codeInput.disabled = pending || attempt !== null;
    }

    async function acceptInvite(code) {
      if (pending || accepted || !(acceptButton instanceof HTMLButtonElement) || acceptButton.disabled) return;
      if (!attempt) {
        if (!validEntryCode(code)) {
          showCodeForm(code);
          setFieldMessage("organiser-invite-code-input", "invalid", "Invite code must be 8 characters.");
          codeInput?.focus();
          return;
        }
        attempt = { code, uncertain: false, path: "/v1/invites/" + encodeURIComponent(code) + "/accept",
          request: Object.freeze({ method: "POST", headers: Object.freeze({ "Content-Type": "application/json" }), body: JSON.stringify({}) }) };
      }
      const operation = attempt;
      pending = true;
      const ownsFocusInitially = document.activeElement === acceptButton;
      let ownsFocus = ownsFocusInitially;
      const focusChanged = (event) => { if (event.target !== document.body && event.target !== acceptButton) ownsFocus = false; };
      const pointerChanged = (event) => { if (!acceptButton.contains(event.target)) ownsFocus = false; };
      document.addEventListener("focusin", focusChanged, true);
      document.addEventListener("pointerdown", pointerChanged, true);
      renderAcceptance();
      clearError();
      setStatus("Accepting invite…", "default");
      try {
        const payload = await requestJsonOrThrow(operation.path, operation.request);
        const leagueId = payload?.access?.leagueId ?? payload?.invite?.leagueId;
        if (!usableEntityId(leagueId) ||
          (payload?.invite?.leagueId !== undefined && payload.invite.leagueId !== leagueId) ||
          (payload?.access?.leagueId !== undefined && payload.access.leagueId !== leagueId) ||
          (payload?.invite?.inviteCode !== undefined && payload.invite.inviteCode !== operation.code)) throw new Error("invite_unconfirmed");
        accepted = true;
        attempt = null;
        const path = encodedRecordPath("/leagues/", leagueId);
        if (leagueLink instanceof HTMLAnchorElement) {
          leagueLink.href = path ?? "/setup";
          leagueLink.textContent = path ? "Open league" : "Go to Home";
          leagueLink.hidden = false;
        }
        setStatus(path ? "Organiser invite accepted." : "Organiser invite accepted. Go to Home to continue.", "success");
      } catch (error) {
        const definitive = !operation.uncertain && isDefinitiveRequestRejection(error) && error.statusCode !== 408 &&
          (error.statusCode !== 409 || (error.responseError === "conflict" && error.responseCode === "invite_already_accepted"));
        if (definitive) {
          attempt = null;
          if (error.statusCode === 404 || error.responseCode === "invite_already_accepted") showCodeForm(operation.code);
          const message = error.responseCode === "invite_email_mismatch"
            ? "This invite is for a different email address. Sign out and use the email it was sent to."
            : error.responseCode === "invite_already_accepted"
              ? "This invite has already been used. Ask the organiser for another invite."
              : error.statusCode === 404 ? "This invite could not be found. Check the code or ask the organiser for another invite."
                : "This invite could not be accepted. Check your sign-in and try again.";
          showError(message, { includesOutcome: true });
        } else {
          operation.uncertain = true;
          showError("Invite acceptance could not be confirmed. Retry uses the same invite.", { includesOutcome: true });
        }
      } finally {
        pending = false;
        document.removeEventListener("focusin", focusChanged, true);
        document.removeEventListener("pointerdown", pointerChanged, true);
        renderAcceptance();
        if (ownsFocus) {
          if (accepted && leagueLink instanceof HTMLAnchorElement) leagueLink.focus();
          else if (codeForm instanceof HTMLFormElement && !codeForm.hidden) codeInput?.focus();
          else acceptButton.focus();
        }
      }
    }

    if (codeForm instanceof HTMLFormElement) codeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (pending || attempt || accepted || !(codeInput instanceof HTMLInputElement)) return;
      const code = normalizedEntryCode(codeInput.value);
      if (!validEntryCode(code)) {
        showCodeForm(code);
        setFieldMessage("organiser-invite-code-input", "invalid", "Invite code must be 8 characters.");
        codeInput.focus();
        return;
      }
      navigateTo("/invites?code=" + encodeURIComponent(code));
    });
    if (codeInput instanceof HTMLInputElement) codeInput.addEventListener("input", () => {
      if (attempt) { codeInput.value = attempt.code; return; }
      clearError();
      setFieldMessage("organiser-invite-code-input");
    });
    if (acceptButton instanceof HTMLButtonElement) acceptButton.addEventListener("click", () => {
      void acceptInvite(attempt?.code ?? normalizedEntryCode(acceptCode?.textContent ?? initialCode));
    });
    if (validEntryCode(initialCode)) showInviteAcceptance(initialCode);
    else {
      showCodeForm(initialCode);
      if (initialCode) {
        setFieldMessage("organiser-invite-code-input", "invalid", "Invite code must be 8 characters.");
        codeInput?.focus();
      }
    }
    renderAcceptance();
    setStatus("");
  }

  async function initialize() {
    mountSeasonShellForNestedLeagueRoute();
    initializeSignOut();
    initializeActionMenus();
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
      setAccountSession(authenticatedSession);
      leagueDeletionRecovery = initializeLeagueDeletionRecovery(authenticatedSession);
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
        await initGamePage(authenticatedSession);
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
