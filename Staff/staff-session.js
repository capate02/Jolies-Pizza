(() => {
    const apiBase = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    const leave = async () => {
        let user = null;
        for (const store of [localStorage, sessionStorage]) {
            try {
                const candidate = JSON.parse(store.getItem("loggedInUser") || "null");
                if (candidate?.sessionToken && String(candidate.role).toLowerCase() === "staff") { user = candidate; break; }
            } catch { }
        }
        if (user?.sessionToken) {
            try {
                await fetch(`${apiBase}/api/logout`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${user.sessionToken}` },
                    keepalive: true
                });
            } catch (error) { console.warn("Could not record staff time-out.", error); }
        }
        localStorage.removeItem("loggedInUser");
        sessionStorage.removeItem("loggedInUser");
        location.href = "../login.html";
    };

    document.addEventListener("click", event => {
        const button = event.target.closest("#logoutButton");
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (confirm("Are you sure you want to logout?")) void leave();
    }, true);
})();
