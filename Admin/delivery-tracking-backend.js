window.deliveryTrackingBackend = true;

(() => {
    const API_BASE = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    const $ = id => document.getElementById(id);
    const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    let records = [];
    let selectedOrder = null;
    let refreshTimer = null;
    let currentPage = 1;
    const PAGE_SIZE = 10;
    const token = () => {
        for (const store of [localStorage, sessionStorage]) {
            try {
                const account = JSON.parse(store.getItem("loggedInUser") || "null");
                if (account?.sessionToken && String(account.role).toLowerCase() === "admin") return account.sessionToken;
            } catch { }
        }
        return "";
    };
    async function api(path, options = {}) {
        const sessionToken = token();
        if (!sessionToken) throw new Error("Sign in with an admin account to view delivery history.");
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: { Authorization: `Bearer ${sessionToken}`, ...(options.body ? { "Content-Type": "application/json" } : {}) },
            cache: "no-store"
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || "Could not load delivery records.");
        return result;
    }
    const toast = message => {
        const node = $("toast");
        if (!node) return;
        node.textContent = message;
        node.classList.add("show");
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => node.classList.remove("show"), 3000);
    };
    const statusBucket = status => status === "Out for Delivery" ? "out" : status === "Completed" ? "delivered" : status === "Cancelled" ? "cancelled" : "pending";
    const statusLabel = status => status === "Completed" ? "Delivered" : status || "Unknown";
    const statusClass = status => statusBucket(status);
    const dateTime = value => {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
    };
    const time = value => {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
    };
    const peso = value => `₱${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const initials = name => String(name || "").trim().split(/\s+/).slice(0, 2).map(part => part[0] || "").join("").toUpperCase() || "—";

    function populateFilters() {
        const status = $("statusFilter");
        const rider = $("riderFilter");
        const previousStatus = status?.value || "all";
        const previousRider = rider?.value || "all";
        const statuses = [...new Set(records.map(record => record.status).filter(Boolean))];
        const riders = [...new Set(records.map(record => record.rider).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        if (status) status.innerHTML = '<option value="all">All Status</option>' + statuses.map(value => `<option value="${escapeHTML(value)}">${escapeHTML(statusLabel(value))}</option>`).join("");
        if (status && statuses.includes(previousStatus)) status.value = previousStatus;
        if (rider) rider.innerHTML = '<option value="all">All Riders</option>' + riders.map(value => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join("");
        if (rider && riders.includes(previousRider)) rider.value = previousRider;
    }

    function filteredRecords() {
        const query = $("searchInput")?.value.trim().toLowerCase() || "";
        const status = $("statusFilter")?.value || "all";
        const rider = $("riderFilter")?.value || "all";
        const selectedTab = document.querySelector(".delivery-tab.active")?.dataset.status || "all";
        return records.filter(record => {
            const fields = [record.orderNumber, record.customerName, record.customerPhone, record.address, record.rider, record.status].join(" ").toLowerCase();
            const bucket = statusBucket(record.status);
            return (!query || fields.includes(query)) && (status === "all" || status === record.status) &&
                (rider === "all" || rider === record.rider) && (selectedTab === "all" || selectedTab === bucket);
        });
    }

    function renderStats() {
        const count = id => $(id) && ($(id).textContent = records.filter(record => record.status === id).length);
        const out = records.filter(record => record.status === "Out for Delivery").length;
        const done = records.filter(record => record.status === "Completed").length;
        const pending = records.filter(record => ["Pending", "Confirmed", "Preparing"].includes(record.status)).length;
        const cancelled = records.filter(record => record.status === "Cancelled").length;
        const cards = document.querySelectorAll(".delivery-stats .stat-card h2, .delivery-stats .stat-card strong, .delivery-stats .stat-value");
        const values = [records.length, out, done, pending, cancelled];
        cards.forEach((card, index) => { if (index < values.length) card.textContent = String(values[index]); });
        const tabs = document.querySelectorAll(".delivery-tab");
        tabs.forEach(tab => {
            const bucket = tab.dataset.status;
            const value = bucket === "all" ? records.length : records.filter(record => statusBucket(record.status) === bucket).length;
            const label = tab.dataset.baseLabel || tab.textContent.replace(/\s*\(\d+\)\s*$/, "").trim();
            tab.dataset.baseLabel = label;
            tab.textContent = `${label} (${value})`;
        });
    }

    function renderTable() {
        const body = $("deliveryBody");
        if (!body) return;
        const matching = filteredRecords();
        const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
        currentPage = Math.min(currentPage, pageCount);
        const rows = matching.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
        body.innerHTML = rows.length ? rows.map(record => {
            const bucket = statusBucket(record.status);
            const rider = record.rider
                ? `<div class="rider-cell"><div class="rider-avatar">${escapeHTML(initials(record.rider))}</div><div><strong>${escapeHTML(record.rider)}</strong><small>${escapeHTML(record.riderPhone || "Rider")}</small></div></div>`
                : '<div class="no-rider">Not assigned</div>';
            return `<tr data-order="${escapeHTML(record.orderNumber)}" data-status="${bucket}" data-rider="${escapeHTML(record.rider)}" class="${record.orderNumber === selectedOrder ? "selected" : ""}">
                <td><strong>#${escapeHTML(record.orderNumber)}</strong><small>${escapeHTML(time(record.createdAt))}</small></td>
                <td><strong>${escapeHTML(record.customerName)}</strong><small>${escapeHTML(record.customerPhone)}</small></td>
                <td><strong>⌖ &nbsp;${escapeHTML(record.address || "Address unavailable")}</strong><small>${escapeHTML(record.location ? `GPS updated ${time(record.location.updatedAt)}` : "Delivery address")}</small></td>
                <td>${rider}</td>
                <td><span class="delivery-status ${bucket}">${escapeHTML(statusLabel(record.status))}</span><small>${escapeHTML(record.paymentStatus || "")}</small></td>
                <td><strong>${escapeHTML(dateTime(record.createdAt))}</strong><small>${escapeHTML(record.status === "Completed" ? "Delivered" : record.status === "Out for Delivery" ? "On the way" : "Order time")}</small></td>
                <td><div class="row-actions"><button type="button" class="view-btn" data-order="${escapeHTML(record.orderNumber)}" aria-label="View delivery details">View</button></div></td>
            </tr>`;
        }).join("") : '<tr><td colspan="7" class="empty-row">No delivery orders match these filters.</td></tr>';
        const resultText = $("resultText");
        const start = matching.length ? (currentPage - 1) * PAGE_SIZE + 1 : 0;
        const end = Math.min(currentPage * PAGE_SIZE, matching.length);
        if (resultText) resultText.textContent = `Showing ${start} to ${end} of ${matching.length} deliveries`;
        const pager = document.querySelector(".pagination .page-buttons");
        if (pager) {
            pager.innerHTML = `<button type="button" data-page="${Math.max(1, currentPage - 1)}" aria-label="Previous page" ${currentPage === 1 ? "disabled" : ""}>‹</button>` +
                Array.from({ length: pageCount }, (_, index) => index + 1).map(page => `<button type="button" data-page="${page}" class="${page === currentPage ? "active" : ""}">${page}</button>`).join("") +
                `<button type="button" data-page="${Math.min(pageCount, currentPage + 1)}" aria-label="Next page" ${currentPage === pageCount ? "disabled" : ""}>›</button>`;
        }
        renderStats();
    }

    function addTimeline(details) {
        let panel = $("deliveryHistoryPanel");
        const statusControl = document.querySelector(".status-control");
        if (!panel && statusControl) {
            panel = document.createElement("section");
            panel.id = "deliveryHistoryPanel";
            panel.className = "detail-section delivery-history-panel";
            statusControl.before(panel);
        }
        if (!panel) return;
        const history = details.history || [];
        panel.innerHTML = `<h3>Delivery History</h3>${history.length ? `<ol>${history.map(event => `<li><span class="history-dot"></span><div><strong>${escapeHTML(statusLabel(event.status))}</strong><small>${escapeHTML(dateTime(event.createdAt))}${event.changedBy ? ` · ${escapeHTML(event.changedBy)}` : ""}</small>${event.note ? `<small>${escapeHTML(event.note)}</small>` : ""}</div></li>`).join("")}</ol>` : `<p>Order placed ${escapeHTML(dateTime(details.createdAt))}. No status history is available yet.</p>`}`;
    }

    function renderDetails(details) {
        selectedOrder = details.orderNumber;
        const set = (id, value) => { if ($(id)) $(id).textContent = value || "—"; };
        set("detailOrder", `#${details.orderNumber}`);
        set("detailCustomerName", details.customerName);
        set("detailCustomerPhone", details.customerPhone ? `☎  ${details.customerPhone}` : "Phone not provided");
        set("detailCustomerAddress", details.address || "Delivery address unavailable.");
        set("detailRider", details.rider || "Rider not assigned");
        set("detailTotal", peso(details.total));
        const status = $("detailStatus");
        if (status) { status.className = `delivery-status ${statusClass(details.status)}`; status.textContent = statusLabel(details.status); }
        const riderPhone = $("detailPhone");
        if (riderPhone) {
            riderPhone.textContent = details.riderPhone ? `☎  ${details.riderPhone}` : "Rider phone unavailable";
            riderPhone.href = details.riderPhone ? `tel:${details.riderPhone.replace(/[^+\d]/g, "")}` : "#";
        }
        const avatar = document.querySelector(".large-rider-avatar");
        if (avatar) avatar.textContent = initials(details.rider);
        const meta = document.querySelector(".rider-meta strong");
        if (meta) meta.textContent = [details.vehicleDescription, details.licensePlate ? `Plate No. ${details.licensePlate}` : ""].filter(Boolean).join(" · ") || "Vehicle details not provided";
        const list = $("orderItemsList");
        if (list) list.innerHTML = details.items?.length ? details.items.map(item => `<div class="order-line"><span>${escapeHTML(item.name)}</span><span>${Number(item.quantity)}×</span><strong>${peso(item.lineTotal)}</strong></div>`).join("") : '<p>No item details recorded.</p>';
        const live = document.querySelector(".live-tracking span");
        if (live) live.innerHTML = details.location ? `<i></i> GPS updated ${escapeHTML(dateTime(details.location.updatedAt))}` : "No live GPS location";
        const map = document.querySelector(".map-box");
        if (map) {
            map.style.cssText = "display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;background:#f1f4f8;color:#536174;padding:16px;text-align:center;";
            map.innerHTML = details.location
                ? `<strong>Latest rider location</strong><span>${details.location.latitude.toFixed(6)}, ${details.location.longitude.toFixed(6)}</span><small>Updated ${escapeHTML(dateTime(details.location.updatedAt))}</small>`
                : "GPS coordinates are not currently available for this delivery.";
        }
        const statusSelect = $("deliveryStatus");
        if (statusSelect) {
            const next = details.status === "Pending" ? "Confirmed" : details.status === "Confirmed" ? "Preparing" : details.status === "Preparing" ? "Out for Delivery" : details.status === "Out for Delivery" ? "Completed" : "";
            const choices = [details.status, next, ...(!["Completed", "Cancelled"].includes(details.status) ? ["Cancelled"] : [])].filter(Boolean);
            statusSelect.innerHTML = choices.map(value => `<option value="${escapeHTML(value)}">${escapeHTML(statusLabel(value))}</option>`).join("");
            statusSelect.value = choices[0];
            statusSelect.disabled = !next && ["Completed", "Cancelled"].includes(details.status);
        }
        addTimeline(details);
        renderTable();
    }

    async function loadDetail(orderNumber) {
        try {
            const result = await api(`/api/admin/deliveries/${encodeURIComponent(orderNumber)}`);
            renderDetails(result.delivery);
        } catch (error) { toast(error.message); }
    }
    async function load() {
        try {
            const result = await api("/api/admin/deliveries");
            records = result.deliveries || [];
            populateFilters();
            renderTable();
            if (selectedOrder && records.some(item => item.orderNumber === selectedOrder)) await loadDetail(selectedOrder);
            else if (records.length) await loadDetail(records[0].orderNumber);
            else {
                selectedOrder = null;
                $("deliveryBody").innerHTML = '<tr><td colspan="7" class="empty-row">No delivery orders have been placed yet.</td></tr>';
                ["detailOrder", "detailCustomerName", "detailCustomerPhone", "detailCustomerAddress", "detailRider", "detailPhone"].forEach(id => { if ($(id)) $(id).textContent = "—"; });
                const history = $("deliveryHistoryPanel"); if (history) history.innerHTML = "<h3>Delivery History</h3><p>No delivery record selected.</p>";
            }
        } catch (error) {
            const body = $("deliveryBody"); if (body) body.innerHTML = `<tr><td colspan="7" class="empty-row">${escapeHTML(error.message)}</td></tr>`;
            toast(error.message);
        }
    }

    function downloadCsv() {
        const rows = filteredRecords();
        const values = [["Order", "Customer", "Phone", "Address", "Rider", "Rider phone", "Status", "Order date", "Total", "Payment"]];
        rows.forEach(row => values.push([row.orderNumber, row.customerName, row.customerPhone, row.address, row.rider, row.riderPhone, statusLabel(row.status), dateTime(row.createdAt), row.total, row.paymentStatus]));
        const csv = values.map(row => row.map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "delivery-history.csv"; anchor.click(); URL.revokeObjectURL(url);
    }

    document.addEventListener("DOMContentLoaded", () => {
        const account = (() => { try { return JSON.parse(localStorage.getItem("loggedInUser") || sessionStorage.getItem("loggedInUser") || "null"); } catch { return null; } })();
        if (account?.fullName) { const title = document.querySelector(".profile-btn strong"); if (title) title.textContent = account.fullName; }
        document.querySelectorAll(".delivery-tab").forEach(tab => tab.addEventListener("click", () => {
            document.querySelectorAll(".delivery-tab").forEach(item => item.classList.toggle("active", item === tab));
            if ($("statusFilter")) $("statusFilter").value = "all";
            currentPage = 1;
            renderTable();
        }));
        const resetAndRender = () => { currentPage = 1; renderTable(); };
        $("searchInput")?.addEventListener("input", resetAndRender);
        $("searchBtn")?.addEventListener("click", resetAndRender);
        $("statusFilter")?.addEventListener("change", resetAndRender);
        $("riderFilter")?.addEventListener("change", resetAndRender);
        $("filterBtn")?.addEventListener("click", resetAndRender);
        $("exportBtn")?.addEventListener("click", downloadCsv);
        $("deliveryBody")?.addEventListener("click", event => {
            const button = event.target.closest("[data-order]");
            const row = event.target.closest("tr[data-order]");
            const orderNumber = button?.dataset.order || row?.dataset.order;
            if (orderNumber) void loadDetail(orderNumber);
        });
        document.querySelector(".pagination .page-buttons")?.addEventListener("click", event => {
            const button = event.target.closest("button[data-page]");
            if (!button || button.disabled) return;
            currentPage = Number(button.dataset.page) || 1;
            renderTable();
        });
        $("refreshDetails")?.addEventListener("click", () => selectedOrder ? loadDetail(selectedOrder) : load());
        $("viewOrderBtn")?.addEventListener("click", () => {
            if (selectedOrder) location.href = `orders.html?order=${encodeURIComponent(selectedOrder)}`;
        });
        $("autoRefresh")?.addEventListener("change", event => {
            clearInterval(refreshTimer);
            if (event.target.checked) refreshTimer = setInterval(load, 30000);
        });
        $("updateStatusBtn")?.addEventListener("click", async () => {
            if (!selectedOrder || !$("deliveryStatus")?.value || $("deliveryStatus").value === records.find(item => item.orderNumber === selectedOrder)?.status) return;
            const nextStatus = $("deliveryStatus").value;
            try {
                const result = await api(`/api/staff/orders/${encodeURIComponent(selectedOrder)}/status`, { method: "POST", body: JSON.stringify({ status: nextStatus }) });
                toast(result.message);
                await load();
            } catch (error) { toast(error.message); }
        });
        const logout = async () => {
            if (!confirm("Are you sure you want to log out?")) return;
            try { await api("/api/logout", { method: "POST" }); } catch { }
            localStorage.removeItem("loggedInUser"); sessionStorage.removeItem("loggedInUser"); location.href = "../login.html";
        };
        $("profileLogout")?.addEventListener("click", logout);
        $("logoutBtn")?.addEventListener("click", logout);
        if ($("autoRefresh")?.checked) refreshTimer = setInterval(load, 30000);
        void load();
    });
})();
