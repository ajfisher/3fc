(() => {
  function resolveApiBaseUrl() {
    const root = document.querySelector("[data-api-base-url]");
    const rootValue = root?.getAttribute("data-api-base-url");
    if (rootValue && rootValue.length > 0) {
      return rootValue;
    }

    const bodyValue = document.body.getAttribute("data-api-base-url");
    if (bodyValue && bodyValue.length > 0) {
      return bodyValue;
    }

    return window.location.origin;
  }

  const apiBaseUrl = resolveApiBaseUrl();
  const RETURN_TO_STORAGE_KEY = "threefc.auth.return_to";
  const CALLBACK_STORAGE_KEY = "threefc.auth.callback";
  const CALLBACK_RECOVERY_MAX_AGE_MS = 15 * 60 * 1000;
  const COMPLETION_REQUEST_TIMEOUT_MS = 15 * 1000;

  function resolveBrowserTimeZone() {
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return typeof timeZone === "string" && timeZone.length > 0 ? timeZone : null;
    } catch {
      return null;
    }
  }

  function resolveReturnTargetPatterns() {
    try {
      const raw = document.body.getAttribute("data-return-target-patterns");
      const sources = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(sources) || !sources.every((source) => typeof source === "string")) {
        return [];
      }
      return sources.map((source) => new RegExp(source, "u"));
    } catch {
      return [];
    }
  }

  const RETURN_TARGET_PATHS = resolveReturnTargetPatterns();

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

  function buildApiUrl(path) {
    const normalizedBase = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    return new URL(normalizedPath, normalizedBase).toString();
  }

  function normalizeReturnTo(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
      return null;
    }

    if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/u.test(value)) {
      return null;
    }

    let decoded = value;
    for (let index = 0; index < 2; index += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          break;
        }
        decoded = next;
      } catch {
        if (index === 0) {
          return null;
        }
        break;
      }
    }

    if (/[\\\u0000-\u001f\u007f]/u.test(decoded)) {
      return null;
    }

    try {
      const target = new URL(value, window.location.origin);
      if (
        target.origin !== window.location.origin ||
        !RETURN_TARGET_PATHS.some((pattern) => pattern.test(target.pathname))
      ) {
        return null;
      }
      const pathname = target.pathname.length > 1 && target.pathname.endsWith("/")
        ? target.pathname.slice(0, -1)
        : target.pathname;
      return `${pathname}${target.search}${target.hash}`;
    } catch {
      return null;
    }
  }

  function resolveReturnTo(fallback = "/setup") {
    const hiddenInput = document.getElementById("auth-return-to");
    const hiddenValue =
      hiddenInput instanceof HTMLInputElement && hiddenInput.value.trim().length > 0
        ? hiddenInput.value.trim()
        : fallback;

    try {
      const requested = new URL(window.location.href).searchParams.get("returnTo");
      if (requested && requested.trim().length > 0) {
        return normalizeReturnTo(requested.trim()) ?? fallback;
      }
    } catch {
      // Fall back to hidden input value when URL parsing fails.
    }

    return normalizeReturnTo(hiddenValue) ?? fallback;
  }

  async function requestJson(path, init) {
    const response = await fetch(buildApiUrl(path), init);
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

  function setStatus(element, message, state = "default") {
    if (!element) {
      return;
    }

    element.textContent = message;
    element.hidden = message.length === 0;
    if (state === "default") {
      element.removeAttribute("data-state");
      return;
    }

    element.setAttribute("data-state", state);
  }

  function isEmailLike(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

  function persistReturnTo(returnTo) {
    try {
      const safeReturnTo = normalizeReturnTo(returnTo);
      if (safeReturnTo) {
        localStorage.setItem(RETURN_TO_STORAGE_KEY, safeReturnTo);
      } else {
        localStorage.removeItem(RETURN_TO_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures.
    }
  }

  function readStoredReturnTo(fallback = "/setup") {
    try {
      const value = localStorage.getItem(RETURN_TO_STORAGE_KEY);
      if (value && value.length > 0) {
        const safeReturnTo = normalizeReturnTo(value);
        if (safeReturnTo) {
          return safeReturnTo;
        }
        localStorage.removeItem(RETURN_TO_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures.
    }

    return fallback;
  }

  function clearStoredReturnTo() {
    try {
      localStorage.removeItem(RETURN_TO_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }

  async function initSignInPage() {
    const form = document.getElementById("auth-magic-form");
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const emailInput = form.querySelector("#auth-email");
    const statusElement = document.getElementById("auth-status");
    const errorElement = document.getElementById("auth-error");
    const submitButton = form.querySelector('[data-action="send-magic-link"]');

    const returnTo = resolveReturnTo("/setup");

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

    async function checkSession() {
      const result = await requestJson("/v1/auth/session", {
        method: "GET",
        credentials: "include",
      });

      if (result.ok && result.body?.session?.email) {
        clearError();
        setStatus(statusElement, "Sign-in complete. Redirecting…", "success");
        setTimeout(() => {
          clearStoredReturnTo();
          navigateTo(returnTo, "replace");
        }, 500);
        return;
      }

      setStatus(statusElement, "", "default");
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError();

      if (!(emailInput instanceof HTMLInputElement)) {
        showError("Email input is unavailable.");
        return;
      }

      const email = emailInput.value.trim();
      if (!isEmailLike(email)) {
        setFieldMessage("auth-email", "invalid", "Enter a valid email address.");
        emailInput.focus();
        return;
      }

      setFieldMessage("auth-email");

      persistReturnTo(returnTo);

      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = true;
      }

      setStatus(statusElement, "Sending magic link…", "default");

      try {
        const requestBody = { email };
        const timeZone = resolveBrowserTimeZone();
        if (timeZone) {
          requestBody.timeZone = timeZone;
        }

        const result = await requestJson("/v1/auth/magic/start", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });

        if (!result.ok) {
          const message = result.body?.message || result.body?.error || "Could not send magic link.";
          showError(message);
          setStatus(statusElement, "", "default");
          return;
        }

        setStatus(statusElement, "Magic link sent. Open the email link to continue.", "success");
      } catch {
        showError("Network error while requesting magic link.");
        setStatus(statusElement, "", "default");
      } finally {
        if (submitButton instanceof HTMLButtonElement) {
          submitButton.disabled = false;
        }
      }
    });

    if (emailInput instanceof HTMLInputElement) {
      emailInput.addEventListener("input", () => {
        setFieldMessage("auth-email");
      });
    }

    try {
      await checkSession();
    } catch {
      setStatus(statusElement, "", "default");
    }
  }

  async function initAuthCallbackPage() {
    if (
      window.location.pathname !== "/auth/callback" &&
      window.location.pathname !== "/auth/callback/"
    ) {
      return;
    }

    const statusElement = document.getElementById("auth-callback-status");
    const errorElement = document.getElementById("auth-callback-error");
    const recoveryLink = document.getElementById("auth-callback-recovery");
    const completeButton = document.querySelector('[data-action="complete-magic-link"]');
    let completionTimer = null;
    let completionStarted = false;
    const params = new URLSearchParams(window.location.search);
    let callbackState = null;
    try {
      const storedCallback = sessionStorage.getItem(CALLBACK_STORAGE_KEY);
      callbackState = storedCallback ? JSON.parse(storedCallback) : null;
      const capturedAt = callbackState?.capturedAt;
      if (
        typeof capturedAt !== "number" ||
        !Number.isFinite(capturedAt) ||
        capturedAt > Date.now() ||
        Date.now() - capturedAt > CALLBACK_RECOVERY_MAX_AGE_MS
      ) {
        sessionStorage.removeItem(CALLBACK_STORAGE_KEY);
        callbackState = null;
      }
    } catch {
      callbackState = null;
    }
    const incomingToken = params.get("token");
    const incomingCode = params.get("code");
    const incomingOauthError = params.has("error");
    const hasIncomingEnvelope = window.location.search.length > 0 || window.location.hash.length > 0;
    const token = incomingToken ??
      (!hasIncomingEnvelope && typeof callbackState?.token === "string" ? callbackState.token : null);
    const oauthError = incomingOauthError || (!hasIncomingEnvelope && callbackState?.oauthError === true);
    const code = incomingCode ??
      (!hasIncomingEnvelope && typeof callbackState?.code === "string" ? callbackState.code : null);
    const callbackReturnTo = normalizeReturnTo(
      params.get("returnTo") ?? (!hasIncomingEnvelope ? callbackState?.returnTo : null),
    );
    const callbackCapturedAt = hasIncomingEnvelope ? Date.now() : callbackState?.capturedAt;

    try {
      sessionStorage.setItem(
        CALLBACK_STORAGE_KEY,
        JSON.stringify({
          capturedAt: callbackCapturedAt,
          ...(token ? { token } : {}),
          ...(code ? { code } : {}),
          ...(oauthError ? { oauthError: true } : {}),
          ...(callbackReturnTo ? { returnTo: callbackReturnTo } : {}),
        }),
      );
    } catch {
      // The in-memory values still support completion when session storage is unavailable.
    }
    window.history.replaceState(null, "", "/auth/callback");

    function clearCallbackState() {
      try {
        sessionStorage.removeItem(CALLBACK_STORAGE_KEY);
      } catch {
        // Ignore storage failures.
      }
    }

    function showCallbackError(message, fatal = false, moveFocus = false) {
      if (errorElement) {
        errorElement.textContent = message;
        errorElement.hidden = false;
      }

      setStatus(statusElement, "", "default");
      if (recoveryLink instanceof HTMLAnchorElement) {
        recoveryLink.hidden = false;
      }
      if (completeButton instanceof HTMLButtonElement) {
        completeButton.hidden = fatal;
        completeButton.disabled = fatal;
      }
      if (fatal && moveFocus && recoveryLink instanceof HTMLAnchorElement) {
        recoveryLink.focus();
      }
    }

    function clearCallbackError() {
      if (!errorElement) {
        return;
      }

      errorElement.hidden = true;
      errorElement.textContent = "";
      if (recoveryLink instanceof HTMLAnchorElement) {
        recoveryLink.hidden = true;
      }
    }

    const storedReturnTo = readStoredReturnTo("/setup");
    const returnTo = callbackReturnTo ?? storedReturnTo;
    if (recoveryLink instanceof HTMLAnchorElement) {
      recoveryLink.href = `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
      recoveryLink.addEventListener("click", clearCallbackState);
    }

    if (oauthError) {
      clearCallbackState();
      showCallbackError("Sign in failed. The authorization request could not be completed.", true);
      return;
    }

    if (token) {
      if (!(completeButton instanceof HTMLButtonElement)) {
        showCallbackError("Sign-in confirmation control was not available.");
        return;
      }

      completeButton.hidden = false;
      completeButton.disabled = false;
      const completeMagicLink = async () => {
        if (completionStarted) {
          return;
        }

        completionStarted = true;
        if (completionTimer !== null) {
          window.clearTimeout(completionTimer);
          completionTimer = null;
        }
        clearCallbackError();
        completeButton.disabled = true;
        setStatus(statusElement, "Completing magic-link sign-in…", "default");
        const abortController = new AbortController();
        const requestTimeout = window.setTimeout(() => {
          abortController.abort();
        }, COMPLETION_REQUEST_TIMEOUT_MS);
        let result;
        try {
          result = await requestJson("/v1/auth/magic/complete", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
            },
            signal: abortController.signal,
            body: JSON.stringify({ token }),
          });
        } catch {
          completionStarted = false;
          showCallbackError("Sign in could not be completed. Please try again.");
          return;
        } finally {
          window.clearTimeout(requestTimeout);
        }

        if (!result.ok) {
          if (result.status === 400 || result.status === 401) {
            clearCallbackState();
            showCallbackError("Sign in failed. Invalid or expired magic link.", true, true);
          } else {
            completionStarted = false;
            showCallbackError("Sign in could not be completed. Please try again.");
          }
          return;
        }

        clearCallbackState();
        clearStoredReturnTo();
        setStatus(statusElement, "Sign-in complete. Redirecting…", "success");
        navigateTo(returnTo, "replace");
      };
      completeButton.addEventListener("click", () => {
        void completeMagicLink();
      });
      completionTimer = window.setTimeout(() => {
        completionTimer = null;
        void completeMagicLink();
      }, 3000);
      return;
    }

    if (code) {
      clearCallbackState();
      clearStoredReturnTo();
      setStatus(statusElement, "OAuth callback received. Redirecting…", "success");
      setTimeout(() => {
        navigateTo(returnTo, "replace");
      }, 700);
      return;
    }

    clearCallbackState();
    showCallbackError("Sign in failed. The callback link is incomplete.", true);
  }

  void initSignInPage();
  void initAuthCallbackPage();
})();
