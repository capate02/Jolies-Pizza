(() => {
    const apiBase = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    const surfaces = { admin: /\/admin\//i, staff: /\/staff\//i, customer: /\/customer\//i };
    const surface = Object.entries(surfaces).find(([, pattern]) => pattern.test(location.pathname))?.[0]
        || (/\/(login|signup)\.html$/i.test(location.pathname) ? "customer" : null);
    if (!surface) return;

    const safeColor = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback;
    const applyTheme = theme => {
        if (!theme) return;
        const accent = safeColor(theme.accent, surface === "admin" ? "#e3131b" : "#d71920");
        const page = safeColor(theme.page, "#f8f9fb");
        const sidebar = safeColor(theme.sidebar, surface === "admin" ? "#070b0f" : "#a90000");
        const radius = ["8px", "12px", "18px"].includes(theme.radius) ? theme.radius : "12px";
        const root = document.documentElement;
        root.style.setProperty("--red", accent);
        root.style.setProperty("--bg", page);
        root.style.setProperty("--sidebar", sidebar);
        root.style.setProperty("--sidebar-active", accent);
        root.style.setProperty("--system-accent", accent);
        root.style.setProperty("--system-page", page);
        root.style.setProperty("--system-sidebar", sidebar);
        root.style.setProperty("--system-radius", radius);
        document.body.classList.add(`system-theme-${surface}`);
        if (!document.getElementById("system-theme-overrides")) {
            const style = document.createElement("style");
            style.id = "system-theme-overrides";
            style.textContent = `
                body.system-theme-admin,body.system-theme-staff,body.system-theme-customer{background-color:var(--system-page)!important}
                body.system-theme-admin .sidebar,body.system-theme-staff .sidebar{background:linear-gradient(180deg,var(--system-sidebar),color-mix(in srgb,var(--system-sidebar) 76%,#000))!important}
                body.system-theme-admin .sidebar .nav-item.active{background:var(--system-accent)!important;color:#fff!important}
                body.system-theme-staff .sidebar .nav-item.active{background:var(--system-accent)!important;color:#fff!important}
                body.system-theme-customer .main-nav a.active{color:var(--system-accent)!important;border-color:var(--system-accent)!important}
                body.system-theme-admin .stat-card,body.system-theme-admin .panel,body.system-theme-admin .card,body.system-theme-admin .side-card,
                body.system-theme-staff .stat-card,body.system-theme-staff .panel,body.system-theme-staff .card,body.system-theme-staff .report-card,
                body.system-theme-customer .info-card,body.system-theme-customer .message-card,body.system-theme-customer .product-card,body.system-theme-customer .menu-card{border-radius:var(--system-radius)!important}
            `;
            document.head.append(style);
        }
    };

    const applyBusiness = business => {
        if (!business) return;
        window.joliesBusiness = business;
        const displayName = String(business.siteName || "Jolie's Pizza").split(" - ")[0];
        const values = { brand: displayName, siteName: business.siteName, email: business.email, contact: business.contact, address: business.address, hours: business.hours };
        document.querySelectorAll("[data-business-field]").forEach(node => {
            const value = values[node.dataset.businessField];
            if (typeof value === "string" && value) node.textContent = value;
        });
        const map = document.getElementById("businessMapFrame");
        if (map && business.mapEmbedUrl) map.src = business.mapEmbedUrl;
    };

    fetch(`${apiBase}/api/public/site-config`, { cache: "no-store" })
        .then(response => response.ok ? response.json() : Promise.reject(new Error("Business information could not be loaded.")))
        .then(config => {
            applyTheme(config.design?.[surface]);
            applyBusiness(config.business);
        })
        .catch(error => console.warn("Shared site settings could not be loaded:", error.message));
})();
