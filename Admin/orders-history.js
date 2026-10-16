(() => {
    const API_BASE_URL = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    const pageSize = 10;
    let page = 1;
    let total = 0;
    let requestTimer;
    let currentOrders = [];

    const element = id => document.getElementById(id);
    const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const money = value => `₱${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const statusClass = status => ({ Pending: "pending", Confirmed: "pending", Preparing: "preparing", "Out for Delivery": "out-delivery", Completed: "completed", Cancelled: "cancelled" }[status] || "pending");
    const dateText = value => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
    };

    function getAdminToken() {
        for (const storage of [localStorage, sessionStorage]) {
            try {
                const user = JSON.parse(storage.getItem("loggedInUser") || "null");
                if (user?.sessionToken && String(user.role).toLowerCase() === "admin") return user.sessionToken;
            } catch (error) { console.warn("Could not read admin session.", error); }
        }
        return "";
    }

    async function loadOrders() {
        const body = element("ordersBody");
        if (!body) return;
        const token = getAdminToken();
        if (!token) {
            body.innerHTML = '<tr data-order="" data-customer="" data-type="" data-status=""><td colspan="9">Sign in with an admin account to view customer order history.</td></tr>';
            return;
        }

        const query = new URLSearchParams({
            page: String(page), pageSize: String(pageSize),
            search: element("orderSearch")?.value.trim() || "",
            status: element("statusFilter")?.value === "All" ? "" : element("statusFilter")?.value || "",
            type: element("typeFilter")?.value === "All" ? "" : element("typeFilter")?.value || "",
            days: element("dateFilter")?.value === "all" ? "" : element("dateFilter")?.value || ""
        });
        body.innerHTML = '<tr data-order="" data-customer="" data-type="" data-status=""><td colspan="9">Loading customer order history…</td></tr>';
        try {
            const response = await fetch(`${API_BASE_URL}/api/admin/orders?${query}`, {
                headers: { Authorization: `Bearer ${token}` }, cache: "no-store"
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || "Could not load customer order history.");
            currentOrders = result.orders || [];
            total = Number(result.total || 0);
            renderOrders(currentOrders);
            renderStats(result.statusCounts || {});
            renderPagination();
        } catch (error) {
            body.innerHTML = `<tr data-order="" data-customer="" data-type="" data-status=""><td colspan="9">${escapeHTML(error.message)} <button type="button" id="retryOrders">Retry</button></td></tr>`;
            element("retryOrders")?.addEventListener("click", loadOrders);
        }
    }

    function renderOrders(orders) {
        const body = element("ordersBody");
        if (!orders.length) {
            body.innerHTML = '<tr data-order="" data-customer="" data-type="" data-status=""><td colspan="9">No customer orders match these filters.</td></tr>';
            return;
        }
        body.innerHTML = orders.map((order, index) => {
            const type = order.fulfillmentType === "pickup" ? "Pickup" : "Delivery";
            const itemCount = (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
            const paymentStatus = order.paymentStatus || "Pending";
            const paymentClass = /paid|completed/i.test(paymentStatus) ? "paid" : "online";
            return `<tr data-index="${index}" data-order="${escapeHTML(order.orderNumber)}" data-customer="${escapeHTML(order.customerName)}" data-type="${escapeHTML(order.fulfillmentType)}" data-status="${escapeHTML(order.status)}">
                <td><strong>#${escapeHTML(order.orderNumber)}</strong></td>
                <td>${escapeHTML(order.customerName)}</td>
                <td><span class="type ${type === "Pickup" ? "takeaway" : "delivery"}">${type}</span></td>
                <td>${itemCount}</td><td>${money(order.total)}</td>
                <td><span class="status ${statusClass(order.status)}">${escapeHTML(order.status)}</span></td>
                <td><span class="payment ${paymentClass}">${escapeHTML(paymentStatus)} · ${escapeHTML(order.paymentMethod || "")}</span></td>
                <td>${escapeHTML(dateText(order.createdAt))}</td>
                <td><button type="button" class="action-btn view-order" data-index="${index}">View Details</button></td>
            </tr>`;
        }).join("");
        body.querySelectorAll(".view-order").forEach(button => button.addEventListener("click", () => showOrder(orders[Number(button.dataset.index)])));
        body.querySelectorAll("tr[data-index]").forEach(row => row.addEventListener("click", event => {
            if (!event.target.closest("button")) showOrder(orders[Number(row.dataset.index)]);
        }));
    }

    function renderStats(counts) {
        const cards = document.querySelectorAll(".order-stat");
        const allOrders = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
        const values = [allOrders, counts.Pending || 0, counts.Preparing || 0, counts["Out for Delivery"] || 0, counts.Completed || 0, counts.Cancelled || 0];
        cards.forEach((card, index) => {
            const value = card.querySelector("h2");
            if (value) value.textContent = Number(values[index] || 0).toLocaleString("en-PH");
            const caption = card.querySelector("small");
            if (caption && index > 0) caption.textContent = allOrders ? `${((Number(values[index] || 0) / allOrders) * 100).toFixed(1)}% of all orders` : "0% of all orders";
        });
    }

    function renderPagination() {
        const pages = Math.max(1, Math.ceil(total / pageSize));
        const start = total ? ((page - 1) * pageSize) + 1 : 0;
        const end = Math.min(page * pageSize, total);
        const showing = element("showingText");
        if (showing) showing.textContent = total ? `Showing ${start}–${end} of ${total} customer orders` : "No customer orders";
        const controls = element("pageButtons");
        if (controls) controls.innerHTML = Array.from({ length: Math.min(pages, 7) }, (_, index) => {
            const pageNumber = pages <= 7 ? index + 1 : Math.max(1, Math.min(pages - 6, page - 3)) + index;
            return `<button type="button" class="${pageNumber === page ? "active" : ""}" data-page="${pageNumber}">${pageNumber}</button>`;
        }).join("");
        controls?.querySelectorAll("button").forEach(button => button.addEventListener("click", () => { page = Number(button.dataset.page); loadOrders(); }));
        const previous = element("previousPage");
        const next = element("nextPage");
        if (previous) previous.disabled = page <= 1;
        if (next) next.disabled = page >= pages;
    }

    function showOrder(order) {
        if (!order) return;
        const panel = element("orderDetails");
        const status = panel?.querySelector(".details-status-row .status");
        const paymentBadge = panel?.querySelector(".details-status-row .payment");
        if (status) { status.textContent = order.status; status.className = `status ${statusClass(order.status)}`; }
        if (paymentBadge) { paymentBadge.textContent = order.paymentStatus || "Payment pending"; paymentBadge.className = `payment ${/paid|completed/i.test(order.paymentStatus || "") ? "paid" : "online"}`; }
        element("detailOrderId").textContent = `#${order.orderNumber}`;
        panel.querySelector(".order-date").textContent = dateText(order.createdAt);

        const sections = panel.querySelectorAll(".detail-section");
        const customerSection = sections[0];
        customerSection.querySelector("strong").textContent = order.customerName || "Customer";
        customerSection.querySelector("span").textContent = [order.customerPhone, order.customerEmail].filter(Boolean).join(" · ") || "No contact details";
        const typeLabel = order.fulfillmentType === "pickup" ? "Pickup" : "Delivery";
        element("detailType").textContent = typeLabel === "Pickup" ? `Pickup${order.pickupTime ? ` · ${String(order.pickupTime).slice(0, 5)}` : ""}` : "Delivery";
        const itemSection = sections[1];
        panel.querySelector(".order-address")?.remove();
        const items = order.items || [];
        itemSection.querySelector("h3").textContent = `Order Items (${items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)})`;
        itemSection.querySelectorAll(".order-item").forEach(item => item.remove());
        items.forEach(item => {
            const row = document.createElement("div");
            row.className = "order-item";
            row.innerHTML = `<span class="item-image">🍕</span><span>${Number(item.quantity)}× ${escapeHTML(item.name)}${item.size ? ` · ${escapeHTML(item.size)}` : ""}</span><strong>${money(item.lineTotal)}</strong>`;
            itemSection.appendChild(row);
        });
        const totals = panel.querySelector(".totals");
        totals.innerHTML = `<div><span>Subtotal</span><strong>${money(order.subtotal)}</strong></div><div><span>Delivery fee</span><strong>${money(order.deliveryFee)}</strong></div><div class="total-row"><span>Total</span><strong>${money(order.total)}</strong></div>`;
        const paymentRows = panel.querySelectorAll(".payment-section .payment-row strong");
        if (paymentRows[0]) paymentRows[0].textContent = order.paymentMethod || "—";
        if (paymentRows[1]) paymentRows[1].textContent = order.paymentStatus || "Pending";
        const actions = panel.querySelector(".detail-actions");
        if (actions) actions.hidden = true;
        if (order.deliveryAddress) {
            const address = document.createElement("div");
            address.className = "detail-section order-address";
            address.innerHTML = `<h3>Order destination</h3><span>${escapeHTML(order.deliveryAddress)}</span>`;
            itemSection.after(address);
        }
        panel.classList.add("show");
    }

    function scheduleLoad(resetPage = true) {
        clearTimeout(requestTimer);
        requestTimer = setTimeout(() => { if (resetPage) page = 1; loadOrders(); }, 250);
    }

    document.addEventListener("DOMContentLoaded", () => {
        const requestedOrder = new URLSearchParams(location.search).get("order");
        if (requestedOrder && element("orderSearch")) element("orderSearch").value = requestedOrder;
        const status = element("statusFilter");
        if (status && ![...status.options].some(option => option.value === "Confirmed")) {
            status.add(new Option("Confirmed", "Confirmed"), status.options[2] || null);
        }
        ["orderSearch", "statusFilter", "typeFilter", "dateFilter"].forEach(id => {
            element(id)?.addEventListener(id === "orderSearch" ? "input" : "change", () => scheduleLoad(true));
        });
        element("searchBtn")?.addEventListener("click", () => scheduleLoad(true));
        element("previousPage")?.addEventListener("click", () => { if (page > 1) { page--; loadOrders(); } });
        element("nextPage")?.addEventListener("click", () => { if (page * pageSize < total) { page++; loadOrders(); } });
        element("filterBtn")?.addEventListener("click", () => scheduleLoad(true));
        const exportButton = element("exportBtn");
        if (exportButton) {
            const replacement = exportButton.cloneNode(true);
            exportButton.replaceWith(replacement);
            replacement.addEventListener("click", () => {
                const csv = [["Order ID", "Customer", "Email", "Phone", "Fulfillment", "Items", "Subtotal", "Delivery Fee", "Total", "Status", "Payment Method", "Payment Status", "Created At"]];
                currentOrders.forEach(order => csv.push([order.orderNumber, order.customerName, order.customerEmail, order.customerPhone, order.fulfillmentType, order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0), order.subtotal, order.deliveryFee, order.total, order.status, order.paymentMethod, order.paymentStatus, dateText(order.createdAt)]));
                const content = csv.map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
                const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
                const link = document.createElement("a"); link.href = url; link.download = "jolies-pizza-customer-order-history.csv"; link.click(); URL.revokeObjectURL(url);
            });
        }
        element("closeDetails")?.addEventListener("click", () => element("orderDetails")?.classList.remove("show"));
        loadOrders();
    });
})();
