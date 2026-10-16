(() => {
    const API = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    const $ = id => document.getElementById(id);
    const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const money = value => `₱${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    let rows = [], selected = "", page = 1, total = 0, timer;
    function token() {
        for (const store of [localStorage, sessionStorage]) try {
            const u = JSON.parse(store.getItem("loggedInUser") || "null");
            if (u?.sessionToken && ["staff", "admin"].includes(String(u.role).toLowerCase())) return u.sessionToken;
        } catch { /* try other storage */ }
        return "";
    }
    async function request(path, options = {}) {
        const t = token(); if (!t) throw Error("Sign in with a staff account to view payment history.");
        const response = await fetch(`${API}${path}`, { ...options, headers: { Authorization: `Bearer ${t}`, ...(options.body ? { "Content-Type": "application/json" } : {}) }, cache: "no-store" });
        const data = await response.json(); if (!response.ok || !data.success) throw Error(data.message || "Payment request failed."); return data;
    }
    function notify(message) { const el = $("toast"); if (el) { el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2400); } else alert(message); }
    function statusClass(s) { return String(s || "pending").toLowerCase().replaceAll(" ", "-"); }
    async function load() {
        const body = $("paymentsTableBody"); if (!body) return;
        const query = new URLSearchParams({ page: String(page), pageSize: "10", search: $("paymentSearch")?.value || "", method: $("methodFilter")?.value || "all", date: $("dateFilter")?.value || "" });
        const active = document.querySelector(".payment-tab.active")?.dataset.status || "all";
        query.set("status", active === "all" ? "all" : active === "Refunded" ? "Refunded" : active);
        body.innerHTML = '<tr><td colspan="8" class="empty-row">Loading payment history…</td></tr>';
        try {
            const data = await request(`/api/staff/payments?${query}`); rows = data.payments || []; total = data.total || 0;
            if (!rows.length && active === "Refunded") { query.set("status", "Voided"); const extra = await request(`/api/staff/payments?${query}`); rows = extra.payments || []; }
            renderRows(); updateStats(); if (!selected && rows[0]) openDetails(rows[0].id);
        } catch (e) { body.innerHTML = `<tr><td colspan="8" class="empty-row">${escapeHTML(e.message)} <button type="button" data-reload>Retry</button></td></tr>`; }
    }
    function renderRows() {
        const body = $("paymentsTableBody");
        const sort = $("sortSelect")?.value || "newest";
        const ordered = [...rows].sort((a, b) => sort === "oldest" ? new Date(a.createdAt) - new Date(b.createdAt) : sort === "highest" ? b.amount - a.amount : sort === "lowest" ? a.amount - b.amount : new Date(b.createdAt) - new Date(a.createdAt));
        body.innerHTML = ordered.length ? ordered.map(p => `<tr data-id="${escapeHTML(p.id)}" class="${p.id === selected ? "selected" : ""}">
            <td><span class="payment-id">${escapeHTML(p.id)}</span></td><td>${escapeHTML(p.orderId)}</td><td class="customer-cell"><strong>${escapeHTML(p.customer)}</strong>${p.walkIn ? '<small>Walk-in · Dine-in</small>' : `<small>${escapeHTML(p.phone || "")}</small>`}</td>
            <td><strong>${money(p.amount)}</strong></td><td><span class="method-badge ${p.method.toLowerCase().includes("cash") ? "cash" : "gcash"}">${escapeHTML(p.method)}</span></td><td><span class="status-badge ${statusClass(p.status)}">${escapeHTML(p.status)}</span></td><td>${new Date(p.createdAt).toLocaleString("en-PH", { hour: "numeric", minute: "2-digit" })}</td><td><button class="view-button" data-view="${escapeHTML(p.id)}" aria-label="View payment"><i class="fa-regular fa-eye"></i></button></td></tr>`).join("") : '<tr><td colspan="8" class="empty-row">No saved payments match these filters.</td></tr>';
        $("showingText").textContent = total ? `Showing ${(page - 1) * 10 + 1} to ${Math.min(page * 10, total)} of ${total} payments` : "Showing 0 payments";
        const pages = Math.max(1, Math.ceil(total / 10));
        $("pagination").innerHTML = `<button class="page-button" data-page="${Math.max(1, page - 1)}" ${page === 1 ? "disabled" : ""}>‹</button><span class="page-button active">${page}</span><button class="page-button" data-page="${Math.min(pages, page + 1)}" ${page >= pages ? "disabled" : ""}>›</button>`;
    }
    async function updateStats() {
        try {
            const all = await request("/api/staff/payments?page=1&pageSize=50"); const list = all.payments || [];
            const today = new Date().toLocaleDateString("en-CA");
            const paid = list.filter(p => p.status === "Paid"), pending = list.filter(p => p.status === "Pending"), refunds = list.filter(p => ["Refunded", "Voided"].includes(p.status));
            if ($("todayTotal")) $("todayTotal").textContent = money(list.filter(p => p.status === "Paid" && new Date(p.paidAt || p.createdAt).toLocaleDateString("en-CA") === today).reduce((s, p) => s + p.amount, 0));
            if ($("paidCount")) $("paidCount").textContent = paid.length;
            if ($("refundCount")) $("refundCount").textContent = refunds.length;
            if ($("refundTotal")) $("refundTotal").textContent = `${money(refunds.reduce((s, p) => s + p.amount, 0))} total`;
            if ($("pendingCount")) $("pendingCount").textContent = pending.length;
            if ($("pendingTotal")) $("pendingTotal").textContent = `${money(pending.reduce((s, p) => s + p.amount, 0))} total`;
            for (const [id, method] of [["cashDeliveryTotal", "Cash on Delivery"], ["gcashTotal", "GCash"], ["cardTotal", "Credit / Debit Card"], ["cashTotal", "Cash"]]) if ($(id)) $(id).textContent = money(list.filter(p => p.method === method && p.status === "Paid").reduce((s, p) => s + p.amount, 0));
        } catch { /* list gives the detailed error */ }
    }
    async function openDetails(id) {
        try {
            const { payment: p } = await request(`/api/staff/payments/${encodeURIComponent(id)}`); selected = id; renderRows();
            const actions = [{ key: "paid", label: "Mark as Paid", enabled: p.status === "Pending" }, { key: "refund", label: "Issue Refund", enabled: p.status === "Paid" }, { key: "pending", label: "Mark as Pending", enabled: p.status === "Paid" }, { key: "void", label: "Void Payment", enabled: p.status === "Pending" }];
            $("detailsBody").innerHTML = `<div class="payment-detail-top"><div><h3>${escapeHTML(p.id)}</h3><span>${escapeHTML(p.orderId)} · ${new Date(p.createdAt).toLocaleString("en-PH")}</span></div><span class="status-badge ${statusClass(p.status)}">${escapeHTML(p.status)}</span></div>
                <section class="detail-section"><h4>Customer Information</h4><div class="info-row"><span>Name</span><strong>${escapeHTML(p.customer)}</strong></div><div class="info-row"><span>Phone</span><strong>${escapeHTML(p.phone || "—")}</strong></div><div class="info-row"><span>Service</span><strong>${p.walkIn ? "Walk-in · Dine-in" : escapeHTML(p.fulfillmentType)}</strong></div></section>
                <section class="detail-section"><h4>Order Summary</h4>${p.items.map(i => `<div class="detail-item"><span>${Number(i.quantity)}× ${escapeHTML(i.name)} ${escapeHTML(i.size || "")}</span><strong>${money(i.lineTotal)}</strong></div>`).join("")}<div class="summary-line total"><span>Total</span><strong>${money(p.amount)}</strong></div></section>
                <section class="detail-section"><h4>Payment Information</h4><div class="info-row"><span>Method</span><strong>${escapeHTML(p.method)}</strong></div><div class="info-row"><span>Status</span><strong>${escapeHTML(p.status)}</strong></div><div class="info-row"><span>Reference</span><strong>${escapeHTML(p.reference)}</strong></div><div class="info-row"><span>Received by</span><strong>${escapeHTML(p.receivedBy)}</strong></div>${p.proofReference ? `<div class="info-row"><span>Transfer ref.</span><strong>${escapeHTML(p.proofReference)}</strong></div>` : ""}${p.proofImageData ? `<img class="payment-proof" src="${p.proofImageData}" alt="Customer GCash transfer receipt">` : ""}</section>
                <section class="actions-section"><h4>Actions</h4><div class="payment-actions">${actions.map(a => `<button type="button" data-action="${a.key}" ${a.enabled ? "" : "disabled"}>${escapeHTML(a.label)}</button>`).join("")}</div></section>
                <button class="view-button" type="button" data-receipt>Print customer receipt</button>`;
            $("detailsCard")?.classList.remove("details-collapsed");
        } catch (e) { notify(e.message); }
    }
    async function action(key) {
        const messages = { paid: "Mark this payment as paid? Verify the cash or GCash transfer first.", refund: "Record that this payment was refunded?", pending: "Move this payment back to pending?", void: "Void this pending payment?" };
        if (!confirm(messages[key])) return;
        try { await request(`/api/staff/payments/${encodeURIComponent(selected)}/action`, { method: "POST", body: JSON.stringify({ action: key }) }); notify("Payment history updated."); await load(); await openDetails(selected); }
        catch (e) { notify(e.message); }
    }
    document.addEventListener("click", e => {
        const row = e.target.closest("tr[data-id]"); if (row) openDetails(row.dataset.id);
        if (e.target.closest("[data-reload]")) load();
        const pg = e.target.closest("[data-page]"); if (pg && !pg.disabled) { page = Number(pg.dataset.page); load(); }
        const act = e.target.closest("[data-action]"); if (act) action(act.dataset.action);
        if (e.target.closest("[data-receipt]")) window.print();
    });
    document.querySelectorAll(".payment-tab").forEach(tab => tab.addEventListener("click", () => { document.querySelectorAll(".payment-tab").forEach(t => t.classList.toggle("active", t === tab)); page = 1; load(); }));
    ["paymentSearch", "methodFilter", "dateFilter", "sortSelect"].forEach(id => $(id)?.addEventListener(id === "paymentSearch" ? "input" : "change", () => { clearTimeout(timer); timer = setTimeout(() => { page = 1; load(); }, 180); }));
    $("closeDetails")?.addEventListener("click", () => $("detailsCard")?.classList.toggle("details-collapsed"));
    $("menuToggle")?.addEventListener("click", e => { const open = $("sidebar")?.classList.toggle("open"); e.currentTarget.setAttribute("aria-expanded", String(Boolean(open))); });
    if ($("paymentsTableBody")) { load(); setInterval(load, 30000); }
})();
