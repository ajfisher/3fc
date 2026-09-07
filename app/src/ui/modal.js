(() => {
  const overlays = Array.from(document.querySelectorAll("[data-modal]"));
  const note = document.getElementById("modal-note");
  let activeOverlay = null;
  let activeTrigger = null;

  function findOverlay(id) {
    return overlays.find((entry) => entry.getAttribute("data-modal") === id) || null;
  }

  function openOverlay(id, trigger) {
    const overlay = findOverlay(id);
    if (!overlay) {
      return;
    }

    if (activeOverlay) {
      activeOverlay.setAttribute("hidden", "");
    }
    overlay.removeAttribute("hidden");
    document.body.classList.add("modal-open");
    activeOverlay = overlay;
    activeTrigger = trigger;
    overlay.querySelector('[data-ui="prompt-dialog"] [data-modal-close]')?.focus();
  }

  function closeOverlay(id) {
    const overlay = findOverlay(id);
    if (!overlay) {
      return;
    }

    overlay.setAttribute("hidden", "");
    if (activeOverlay === overlay) {
      activeOverlay = null;
      activeTrigger?.focus();
      activeTrigger = null;
    }

    const hasOpenOverlay = overlays.some((entry) => !entry.hasAttribute("hidden"));
    if (!hasOpenOverlay) {
      document.body.classList.remove("modal-open");
    }
  }

  function setNote(message) {
    if (note) {
      note.textContent = message;
    }
  }

  document.querySelectorAll("[data-modal-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-modal-open");
      if (id) {
        openOverlay(id, button);
      }
    });
  });

  document.querySelectorAll("[data-modal-close]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-modal-close");
      if (id) {
        closeOverlay(id);
        setNote(`Cancelled modal action: ${id}`);
      }
    });
  });

  document.querySelectorAll("[data-modal-confirm]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-modal-confirm");
      if (id) {
        closeOverlay(id);
        setNote(`Confirmed modal action: ${id}`);
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (!activeOverlay) {
      return;
    }

    if (event.key === "Tab") {
      const controls = [...activeOverlay.querySelectorAll('[data-ui="prompt-dialog"] button:not([disabled]), [data-ui="prompt-dialog"] a[href]')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();

    const id = activeOverlay.getAttribute("data-modal");
    if (id) {
      closeOverlay(id);
      setNote(`Cancelled modal action: ${id}`);
    }
  });
})();
