(() => {
    const mobileBreakpoint = 900;

    function isMobile() {
        return window.matchMedia(`(max-width: ${mobileBreakpoint}px)`).matches;
    }

    function getSidebar() {
        return document.getElementById("sidebar");
    }

    function getToggle() {
        return document.getElementById("menuToggle") ||
            document.getElementById("mobileMenu") ||
            document.querySelector(".menu-toggle, .mobile-menu");
    }

    function syncToggleState() {
        const sidebar = getSidebar();
        const toggle = getToggle();
        if (!sidebar || !toggle) return;
        toggle.setAttribute("aria-controls", "sidebar");
        toggle.setAttribute("aria-expanded", String(isMobile()
            ? sidebar.classList.contains("open")
            : !sidebar.classList.contains("open")));
        toggle.setAttribute("aria-label", isMobile()
            ? (sidebar.classList.contains("open") ? "Close sidebar" : "Open sidebar")
            : (sidebar.classList.contains("open") ? "Show sidebar" : "Hide sidebar"));
    }

    document.addEventListener("click", event => {
        const toggle = getToggle();
        const sidebar = getSidebar();
        if (!toggle || !sidebar) return;

        if (event.target === toggle || toggle.contains(event.target)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            sidebar.classList.toggle("open");
            syncToggleState();
            return;
        }

        if (isMobile() && sidebar.classList.contains("open") && !sidebar.contains(event.target)) {
            sidebar.classList.remove("open");
            syncToggleState();
        }
    }, true);

    document.addEventListener("keydown", event => {
        const sidebar = getSidebar();
        if (event.key !== "Escape" || !sidebar?.classList.contains("open")) return;
        sidebar.classList.remove("open");
        syncToggleState();
    });

    window.addEventListener("resize", syncToggleState);
    syncToggleState();
})();
