(() => {
    const API = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    const $ = id => document.getElementById(id);
    const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const money = n => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    let current = [], selected = "", page = 1, total = 0, timer;
    function token() { for (const s of [localStorage, sessionStorage]) try { const u = JSON.parse(s.getItem("loggedInUser") || "null"); if (u?.sessionToken && String(u.role).toLowerCase() === "admin") return u.sessionToken; } catch {} return ""; }
    async function api(path) {
        const t = token(); if (!t) throw Error("Sign in as an administrator to view the payment history.");
        const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" }); const d = await r.json();
        if (!r.ok || !d.success) throw Error(d.message || "Could not load payment history."); return d;
    }
    function badge(status) { return status === "Paid" ? "completed" : String(status || "Pending").toLowerCase().replaceAll(" ", "-"); }
    function detail(p) {
        $("detailPaymentId").textContent = p.id;
        $("detailOrderId").textContent = `#${p.orderId}`;
        $("detailReference").textContent = p.reference || "—";
        $("detailMethod").textContent = p.method;
        $("detailAccount").textContent = p.phone || (p.walkIn ? "Walk-in" : "—");
        $("detailAmount").textContent = money(p.amount);
        $("detailStatusText").textContent = p.status;
        $("detailPaidAt").textContent = p.paidAt ? new Date(p.paidAt).toLocaleString("en-PH") : "—";
        $("detailCustomer").textContent = p.customer;
        $("detailCustomerPhone").textContent = p.phone || "—";
        $("detailStatus").textContent = p.status === "Paid" ? "Completed" : p.status;
        $("detailStatus").className = `status ${badge(p.status)}`;
        const sections = document.querySelectorAll("#paymentDetails .detail-section");
        const orderSection = [...sections].find(section => /Order Summary/.test(section.textContent));
        if (orderSection) {
            orderSection.innerHTML = `<div class="section-heading"><h3>Order Summary</h3><span>${p.walkIn ? "Walk-in · Dine-in" : esc(p.fulfillmentType)}</span></div>${p.items.map(i => `<div class="order-line"><span>${Number(i.quantity)}× ${esc(i.name)} ${esc(i.size || "")}</span><strong>${money(i.lineTotal)}</strong></div>`).join("")}<div class="order-line"><span>Subtotal</span><strong>${money(p.subtotal)}</strong></div><div class="order-line"><span>Delivery Fee</span><strong>${money(p.deliveryFee)}</strong></div><div class="order-line"><strong>Total</strong><strong>${money(p.amount)}</strong></div>`;
        }
        const actions = document.querySelector("#paymentDetails .details-actions");
        if (actions) actions.innerHTML = `<button class="download-receipt" id="adminReceiptPrint" type="button">Print receipt</button>${p.proofImageData ? `<img class="payment-proof" src="${p.proofImageData}" alt="GCash transfer receipt">` : ""}`;
        $("adminReceiptPrint")?.addEventListener("click", () => window.print());
    }
    async function open(id) { try { const d = await api(`/api/admin/payments/${encodeURIComponent(id)}`); selected = id; detail(d.payment); } catch (e) { $("paymentTableBody").innerHTML = `<tr><td colspan="8">${esc(e.message)}</td></tr>`; } }
    async function load() {
        const q = new URLSearchParams({ page: String(page), pageSize: "10", search: $("searchInput")?.value.trim() || "", status: $("statusFilter")?.value || "all", method: $("methodFilter")?.value || "all", date: $("adminPaymentDate")?.value || "" });
        const body = $("paymentTableBody"); body.innerHTML = '<tr><td colspan="8">Loading saved payments…</td></tr>';
        try {
            const d = await api(`/api/admin/payments?${q}`); current = d.payments || []; total = d.total || 0;
            body.innerHTML = current.length ? current.map(p => `<tr data-payment="${esc(p.id)}"><td><strong>${esc(p.id)}</strong><small>${esc(p.reference)}</small></td><td>#${esc(p.orderId)}</td><td><strong>${esc(p.customer)}</strong><small>${p.walkIn ? "Walk-in · Dine-in" : esc(p.phone || "")}</small></td><td>${money(p.amount)}</td><td>${esc(p.method)}</td><td><span class="status ${badge(p.status)}">${esc(p.status === "Paid" ? "Completed" : p.status)}</span></td><td>${new Date(p.createdAt).toLocaleString("en-PH", { dateStyle: "short", timeStyle: "short" })}</td><td><button type="button" class="view-payment" data-payment="${esc(p.id)}">View</button></td></tr>`).join("") : '<tr><td colspan="8">No saved payments match these filters.</td></tr>';
            if ($("resultText")) $("resultText").textContent = total ? `Showing ${(page - 1) * 10 + 1} to ${Math.min(page * 10, total)} of ${total} payments` : "Showing 0 payments";
            const pager = document.querySelector(".page-buttons");
            if (pager) { const pages = Math.max(1, Math.ceil(total / 10)); pager.innerHTML = `<button class="page-arrow" data-page="${Math.max(1, page - 1)}" ${page <= 1 ? "disabled" : ""}>‹</button>${Array.from({ length: pages }, (_, i) => i + 1).map(n => `<button class="page-number ${n === page ? "active" : ""}" data-page="${n}">${n}</button>`).join("")}<button class="page-arrow" data-page="${Math.min(pages, page + 1)}" ${page >= pages ? "disabled" : ""}>›</button>`; }
            if (current.length && (!selected || !current.some(p => p.id === selected))) await open(current[0].id);
            const paid = current.filter(p => p.status === "Paid");
            const sum = id => { const el = $(id); if (el) el.textContent = money(paid.filter(p => p.method === ({ codTotal: "Cash on Delivery", gcashTotal: "GCash", mayaTotal: "Maya", cardTotal: "Credit / Debit Card" }[id] || p.method)).reduce((s,p)=>s+p.amount,0)); };
            sum("codTotal"); sum("gcashTotal"); sum("mayaTotal"); sum("cardTotal");
        } catch (e) { body.innerHTML = `<tr><td colspan="8">${esc(e.message)} <button type="button" id="retryPayments">Retry</button></td></tr>`; $("retryPayments")?.addEventListener("click", load); }
    }
    ["searchInput", "statusFilter", "methodFilter", "adminPaymentDate"].forEach(id => $(id)?.addEventListener(id === "searchInput" ? "input" : "change", () => { clearTimeout(timer); timer = setTimeout(() => { page = 1; load(); }, 160); }));
    document.querySelectorAll(".payment-tab[data-status]").forEach(tab => tab.addEventListener("click", () => {
        document.querySelectorAll(".payment-tab[data-status]").forEach(item => item.classList.toggle("active", item === tab));
        $("statusFilter").value = tab.dataset.status === "all" ? "all" : tab.dataset.status;
        page = 1; load();
    }));
    document.querySelector(".page-buttons")?.addEventListener("click", event => { const button = event.target.closest("[data-page]"); if (!button || button.disabled) return; page = Number(button.dataset.page); load(); });
    $("filterBtn")?.addEventListener("click", () => { let input = $("adminPaymentDate"); if (!input) { input = document.createElement("input"); input.type = "date"; input.id = "adminPaymentDate"; input.setAttribute("aria-label", "Filter payments by date"); $("filterBtn").before(input); input.addEventListener("change", load); } input.showPicker?.(); });
    $("paymentTableBody")?.addEventListener("click", event => { const row = event.target.closest("[data-payment]"); if (row) open(row.dataset.payment); });
    if ($("paymentTableBody")) { load(); setInterval(load, 30000); }
})();
