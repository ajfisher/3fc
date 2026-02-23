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

  function buildApiUrl(path) {
    const normalizedBase = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    return new URL(normalizedPath, normalizedBase).toString();
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
    if (state === "default") {
      element.removeAttribute("data-state");
      return;
    }

    element.setAttribute("data-state", state);
  }

  function isEmailLike(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function persistReturnTo(returnTo) {
    try {
      localStorage.setItem(RETURN_TO_STORAGE_KEY, returnTo);
    } catch {
      // Ignore storage failures.
    }
  }

  function consumeReturnTo(fallback = "/setup") {
    try {
      const value = localStorage.getItem(RETURN_TO_STORAGE_KEY);
      if (value && value.length > 0) {
        localStorage.removeItem(RETURN_TO_STORAGE_KEY);
        return value;
      }
    } catch {
      // Ignore storage failures.
    }

    return fallback;
  }

  async function initSignInPage() {
    const form = document.getElementById("auth-magic-form");
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const emailInput = form.querySelector("#auth-email");
    const returnToInput = form.querySelector("#auth-return-to");
    const statusElement = document.getElementById("auth-status");
    const errorElement = document.getElementById("auth-error");
    const sessionElement = document.getElementById("auth-session");
    const sessionEmail = document.getElementById("auth-session-email");
    const submitButton = form.querySelector('[data-action="send-magic-link"]');

    const returnTo =
      returnToInput instanceof HTMLInputElement && returnToInput.value.trim().length > 0
        ? returnToInput.value.trim()
        : "/setup";

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

    function setSessionState(authenticated, email = null) {
      if (!sessionElement || !sessionEmail) {
        return;
      }

      if (authenticated) {
        sessionElement.hidden = false;
        sessionEmail.textContent = email ?? "unknown";
        return;
      }

      sessionElement.hidden = true;
      sessionEmail.textContent = "";
    }

    async function checkSession() {
      const result = await requestJson("/v1/auth/session", {
        method: "GET",
        credentials: "include",
      });

      if (result.ok && result.body?.session?.email) {
        clearError();
        setStatus(statusElement, "Session active. Redirecting to setup…", "success");
        setSessionState(true, result.body.session.email);
        setTimeout(() => {
          window.location.replace(returnTo);
        }, 500);
        return;
      }

      setSessionState(false, null);
      setStatus(statusElement, "Not signed in. Send a magic link to continue.", "default");
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
        showError("Enter a valid email address.");
        emailInput.focus();
        return;
      }

      persistReturnTo(returnTo);

      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = true;
      }

      setStatus(statusElement, "Sending magic link…", "default");

      try {
        const result = await requestJson("/v1/auth/magic/start", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email }),
        });

        if (!result.ok) {
          const message = result.body?.message || result.body?.error || "Could not send magic link.";
          showError(message);
          setStatus(statusElement, "Magic-link request failed.", "error");
          return;
        }

        setStatus(statusElement, "Magic link sent. Open the email link to continue.", "success");
      } catch {
        showError("Network error while requesting magic link.");
        setStatus(statusElement, "Magic-link request failed.", "error");
      } finally {
        if (submitButton instanceof HTMLButtonElement) {
          submitButton.disabled = false;
        }
      }
    });

    try {
      setStatus(statusElement, "Checking session…", "default");
      await checkSession();
    } catch {
      showError("Could not verify session state.");
      setStatus(statusElement, "Session check failed.", "error");
      setSessionState(false, null);
    }
  }

  async function initAuthCallbackPage() {
    if (window.location.pathname !== "/auth/callback") {
      return;
    }

    const statusElement = document.getElementById("auth-callback-status");
    const errorElement = document.getElementById("auth-callback-error");
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const oauthError = params.get("error");
    const code = params.get("code");

    function showCallbackError(message) {
      if (errorElement) {
        errorElement.textContent = message;
        errorElement.hidden = false;
      }

      setStatus(statusElement, "Sign-in callback failed.", "error");
    }

    const returnTo = consumeReturnTo("/setup");

    if (oauthError) {
      showCallbackError(`OAuth provider returned: ${oauthError}.`);
      return;
    }

    if (token) {
      setStatus(statusElement, "Completing magic-link sign-in…", "default");
      const result = await requestJson("/v1/auth/magic/complete", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });

      if (!result.ok) {
        const message = result.body?.message || result.body?.error || "Magic-link completion failed.";
        showCallbackError(message);
        return;
      }

      setStatus(statusElement, "Sign-in complete. Redirecting…", "success");
      setTimeout(() => {
        window.location.replace(returnTo);
      }, 700);
      return;
    }

    if (code) {
      setStatus(statusElement, "OAuth callback received. Redirecting…", "success");
      setTimeout(() => {
        window.location.replace(returnTo);
      }, 700);
      return;
    }

    showCallbackError("Missing callback token or authorization code.");
  }

  void initSignInPage();
  void initAuthCallbackPage();
})();
