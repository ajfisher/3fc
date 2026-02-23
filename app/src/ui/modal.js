(() => {
  const overlays = Array.from(document.querySelectorAll("[data-modal]"));
  const note = document.getElementById("modal-note");
  let activeOverlay = null;

  function findOverlay(id) {
    return overlays.find((entry) => entry.getAttribute("data-modal") === id) || null;
  }

  function openOverlay(id) {
    const overlay = findOverlay(id);
    if (!overlay) {
      return;
    }

    overlay.removeAttribute("hidden");
    document.body.classList.add("modal-open");
    activeOverlay = overlay;
  }

  function closeOverlay(id) {
    const overlay = findOverlay(id);
    if (!overlay) {
      return;
    }

    overlay.setAttribute("hidden", "");
    if (activeOverlay === overlay) {
      activeOverlay = null;
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
        openOverlay(id);
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
    if (event.key !== "Escape" || !activeOverlay) {
      return;
    }

    const id = activeOverlay.getAttribute("data-modal");
    if (id) {
      closeOverlay(id);
      setNote(`Cancelled modal action: ${id}`);
    }
  });
})();
