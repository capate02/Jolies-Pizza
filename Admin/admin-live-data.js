(() => {
    const formatMoney = value => new Intl.NumberFormat("en-PH", {
        style: "currency", currency: "PHP", minimumFractionDigits: 2
    }).format(Number(value || 0));
    const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

    const applyDesign = design => {
        if (!design) return;
        const root = document.documentElement;
        root.style.setProperty("--red", design.accent || "#e3131b");
        root.style.setProperty("--red-dark", design.accent || "#c90f16");
        root.style.setProperty("--bg", design.page || "#f7f8fa");
        root.style.setProperty("--sidebar", design.sidebar || "#070b0f");
        root.style.setProperty("--sidebar-active", design.accent || "#e3131b");
        root.style.setProperty("--admin-card-radius", design.radius || "12px");
        if (!document.getElementById("admin-design-overrides")) {
            const style = document.createElement("style");
            style.id = "admin-design-overrides";
            style.textContent = ".stat-card,.panel,.report-card,.chart-card,.content-card{border-radius:var(--admin-card-radius)!important}";
            document.head.append(style);
        }
    };

    const adminToken = () => {
        for (const storage of [localStorage, sessionStorage]) try {
            const user = JSON.parse(storage.getItem("loggedInUser") || "null");
            if (user?.sessionToken && String(user.role).toLowerCase() === "admin") return user.sessionToken;
        } catch { /* Check the other store. */ }
        return "";
    };
    const apiBase = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    const getJson = async url => {
        const response = await fetch(`${apiBase}${url}`, { headers: { Authorization: `Bearer ${adminToken()}` }, credentials: "same-origin", cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Unable to load admin data.");
        return result;
    };
    const loadStaffReports = async () => {
        const body = document.getElementById("staffReportSubmissions");
        if (!body) return;
        try {
            const data = await getJson("/api/admin/reports/submissions");
            body.innerHTML = data.reports.length ? data.reports.map(item => {
                const summary = item.report?.current || {};
                const status = item.status === "reviewed" ? "Reviewed" : "Submitted";
                return `<tr><td>${new Date(item.createdAt).toLocaleString()}</td><td>${escapeHtml(item.submittedBy)}</td><td>${escapeHtml(item.period)}</td><td>${formatMoney(summary.sales)}</td><td>${Number(summary.orders || 0)}</td><td>${escapeHtml(item.note || "—")}</td><td>${status}</td><td>${item.status === "submitted" ? `<button type="button" class="review-staff-report" data-report-id="${Number(item.id)}">Mark reviewed</button>` : escapeHtml(item.reviewedBy || "Done")}</td></tr>`;
            }).join("") : '<tr><td colspan="8">No reports have been submitted by staff yet.</td></tr>';
        } catch (error) { body.innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`; }
    };

    document.addEventListener("DOMContentLoaded", async () => {
        const dashboard = location.pathname.toLowerCase().endsWith("dashboard.html");
        const reports = location.pathname.toLowerCase().endsWith("reports.html");
        if (!dashboard && !reports) return;
        try {
            const settings = await getJson("/api/admin/settings");
            applyDesign(settings.settings?.design?.admin || settings.settings?.design);
        } catch (error) { console.warn("Admin interface design was not loaded:", error.message); }

        try {
            if (dashboard) {
                const chosen = document.getElementById("salesPeriod")?.value || "This Week";
                const period = /month/i.test(chosen) ? "month" : "week";
                const data = await getJson(`/api/admin/dashboard?period=${period}`);
                const cards = [...document.querySelectorAll(".stats-grid .stat-card")];
                if (cards[0]) cards[0].querySelector("h2").textContent = formatMoney(data.summary.sales);
                if (cards[1]) cards[1].querySelector("h2").textContent = String(data.summary.orders);
                if (cards[2]) cards[2].querySelector("h2").textContent = formatMoney(data.summary.averageOrderValue);
                if (cards[3]) {
                    cards[3].querySelector("h2").textContent = "—";
                    const note = cards[3].querySelector(".trend");
                    if (note) note.textContent = "Cost data is not recorded";
                }
                const tables = [...document.querySelectorAll(".table-panel tbody")];
                if (tables[0]) tables[0].innerHTML = data.topItems.length ? data.topItems.map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.name)}</td><td>—</td><td>${item.quantity}</td><td>${formatMoney(item.sales)}</td></tr>`).join("") : '<tr><td colspan="5">No menu sales in this period.</td></tr>';
                if (tables[1]) tables[1].innerHTML = data.recentOrders.length ? data.recentOrders.map(order => `<tr><td><b>${escapeHtml(order.order_number)}</b></td><td>${escapeHtml(order.customer_name || "Walk-in Customer")}</td><td>${formatMoney(order.total)}</td><td>${escapeHtml(order.status)}</td><td>${new Date(order.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td></tr>`).join("") : '<tr><td colspan="5">No orders recorded yet.</td></tr>';
                window.adminDashboardData = data;
            }
            if (reports) {
                const now = new Date();
                const to = localDate(now);
                const fromDate = new Date(now);
                fromDate.setDate(fromDate.getDate() - 6);
                const from = localDate(fromDate);
                const data = await getJson(`/api/admin/reports?from=${from}&to=${to}`);
                const cards = [...document.querySelectorAll(".stats-grid .stat-card")];
                const values = [formatMoney(data.summary.sales), String(data.summary.orders), formatMoney(data.summary.averageOrderValue), String(data.summary.customers), formatMoney(data.summary.refunds)];
                cards.forEach((card, index) => { const value = card.querySelector("h2"); if (value && values[index] !== undefined) value.textContent = values[index]; });
                const range = document.querySelector(".report-filters .input-button span");
                if (range) range.textContent = `${from} - ${to}`;
                const dailyBody = document.querySelector(".sales-table tbody");
                if (dailyBody) dailyBody.innerHTML = data.daily.length ? data.daily.map(row => `<tr><td>${new Date(`${row.date}T12:00:00`).toLocaleDateString()}</td><td>${row.orders}</td><td>${formatMoney(row.sales)}</td><td>${formatMoney(0)}</td><td>${formatMoney(0)}</td><td>${formatMoney(row.sales)}</td></tr>`).join("") : '<tr><td colspan="6">No orders recorded in this period.</td></tr>';
                const itemBody = document.querySelector(".top-selling tbody");
                if (itemBody) itemBody.innerHTML = data.topItems.length ? data.topItems.map((item, index) => `<tr><td><span class="rank">${index + 1}</span>${escapeHtml(item.name)}</td><td>${item.quantity}</td><td>${formatMoney(item.sales)}</td></tr>`).join("") : '<tr><td colspan="3">No menu sales in this period.</td></tr>';
                window.adminReportsData = data;
                await loadStaffReports();
            }
        } catch (error) {
            console.error("Admin data could not be loaded:", error);
            const toast = document.getElementById("toast");
            if (toast) { toast.textContent = error.message; toast.classList.add("show"); }
        }
    });
    document.addEventListener("click", async event => {
        const button = event.target.closest(".review-staff-report");
        if (!button) return;
        button.disabled = true;
        try {
            const response = await fetch(`${apiBase}/api/admin/reports/submissions/${button.dataset.reportId}/review`, {
                method: "POST", headers: { Authorization: `Bearer ${adminToken()}` }, cache: "no-store"
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || "Unable to update the report.");
            await loadStaffReports();
        } catch (error) { button.disabled = false; window.alert(error.message); }
    });
})();
