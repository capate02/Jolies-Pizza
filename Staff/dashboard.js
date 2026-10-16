(() => {
  const API = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const money = value => `₱${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  let orders = [];

  function token() {
    for (const storage of [localStorage, sessionStorage]) try {
      const user = JSON.parse(storage.getItem("loggedInUser") || "null");
      if (user?.sessionToken && ["staff", "admin"].includes(String(user.role).toLowerCase())) return user.sessionToken;
    } catch { /* Try the other browser store. */ }
    return "";
  }
  async function request(path, options = {}) {
    const sessionToken = token(); if (!sessionToken) throw new Error("Sign in with a staff account to load the dashboard.");
    const response = await fetch(`${API}${path}`, { ...options, headers: { Authorization: `Bearer ${sessionToken}`, ...(options.body ? { "Content-Type": "application/json" } : {}) }, cache: "no-store" });
    const data = await response.json(); if (!response.ok || !data.success) throw new Error(data.message || "Dashboard request failed."); return data;
  }
  function notify(message) {
    const toast = $("#toast"); if (!toast) return;
    toast.textContent = message; toast.style.opacity = "1"; toast.style.transform = "translateY(0)";
    clearTimeout(notify.timer); notify.timer = setTimeout(() => { toast.style.opacity = "0"; toast.style.transform = "translateY(15px)"; }, 2400);
  }
  function fulfillmentLabel(type) {
    const value = String(type || "").toLowerCase();
    if (value.includes("deliver")) return ["Delivery", "delivery"];
    if (value.includes("pick")) return ["Pick Up", "pickup"];
    return ["Dine In", "dine"];
  }
  function statusFilter(order) {
    if (order.status === "Pending" || order.status === "Confirmed") return "new";
    if (order.status === "Preparing") return "preparing";
    return "ready";
  }
  function renderOrders() {
    const list = $("#orderList");
    const tip = $(".queue-tip", list);
    const selected = $(".queue-tab.active")?.dataset.filter || "new";
    $$(".order-row", list).forEach(node => node.remove());
    const markup = orders.map(order => {
      const [label, typeClass] = fulfillmentLabel(order.fulfillmentType);
      const filter = statusFilter(order);
      const action = order.status === "Pending" || order.status === "Confirmed"
        ? `<button class="start-order" type="button" data-order="${escapeHTML(order.orderNumber)}">Start</button>`
        : `<span class="start-order started-order">${escapeHTML(order.status === "Preparing" ? "Preparing" : "Ready")}</span>`;
      const time = new Date(order.createdAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
      return `<div class="order-row" data-status="${filter}" data-order="${escapeHTML(order.orderNumber)}"><span class="order-number">#${escapeHTML(order.orderNumber)}</span><span class="order-type ${typeClass}">${label}</span><span class="customer-name">${escapeHTML(order.customerName)}</span><span class="order-time">${time}</span>${action}<span class="order-details">${Number(order.itemCount)} item${Number(order.itemCount) === 1 ? "" : "s"} · ${escapeHTML(order.itemSummary)}</span></div>`;
    }).join("");
    if (tip) list.insertAdjacentHTML("afterbegin", markup || '<div class="order-empty">No active orders right now.</div>');
    else list.innerHTML = markup || '<div class="order-empty">No active orders right now.</div>';
    $$(".order-row", list).forEach(row => row.hidden = row.dataset.status !== selected);
    const counts = { new: orders.filter(order => statusFilter(order) === "new").length, preparing: orders.filter(order => statusFilter(order) === "preparing").length, ready: orders.filter(order => statusFilter(order) === "ready").length };
    const tabs = $$(".queue-tab");
    tabs.forEach(tab => { const name = tab.dataset.filter; tab.textContent = `${name[0].toUpperCase()}${name.slice(1)} (${counts[name] || 0})`; });
    const badge = $(".queue-badge"); if (badge) badge.textContent = orders.length;
  }
  function renderInventory(alerts) {
    const list = $(".inventory-list");
    if (!list) return;
    list.innerHTML = alerts.length ? alerts.map(item => `<div class="inventory-item"><div class="inventory-image"><i class="fa-solid fa-cube"></i></div><div class="inventory-info"><strong>${escapeHTML(item.name)}</strong><span>${Number(item.stock)} left · restock level ${Number(item.threshold)}</span></div><span class="stock-status low">Low Stock</span></div>`).join("") : '<div class="inventory-empty">No low-stock ingredients reported.</div>';
    const link = list.closest(".dashboard-card")?.querySelector(".view-link"); if (link) { link.href = "inventory.html"; link.textContent = "View all"; }
  }
  function renderNotifications() {
    const list = $(".notification-list"); if (!list) return;
    const latest = [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 4);
    list.innerHTML = latest.length ? latest.map(order => `<div class="notification-item"><div class="notification-icon"><i class="fa-regular fa-clipboard"></i></div><div class="notification-content"><strong>${escapeHTML(order.status)} order received</strong><span>#${escapeHTML(order.orderNumber)} · ${escapeHTML(order.customerName)}</span></div><span class="notification-time">${new Date(order.createdAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</span></div>`).join("") : '<div class="notification-empty">No recent orders.</div>';
    const link = list.closest(".dashboard-card")?.querySelector(".view-link"); if (link) { link.href = "notifications.html"; }
  }
  function updateSales(data) {
    const cards = $$(".stat-card");
    if (cards[0]) { $(".stat-value", cards[0]).textContent = data.summary.newOrders; $(".stat-note", cards[0]).textContent = "Needs attention"; }
    if (cards[1]) $(".stat-value", cards[1]).textContent = data.summary.preparing;
    if (cards[2]) $(".stat-value", cards[2]).textContent = data.summary.readyOrders;
    if (cards[3]) { $(".stat-value", cards[3]).textContent = data.summary.completedToday; $(".stat-note", cards[3]).textContent = "Completed today"; }
    if (cards[4]) { $(".stat-value", cards[4]).textContent = money(data.summary.salesToday); $(".stat-note", cards[4]).textContent = "Paid orders today"; }
    const period = $("#salesPeriod")?.value || "Today";
    const salesValue = $(".sales-value"); const salesTitle = $(".sales-title");
    if (salesValue) salesValue.textContent = money(data.summary.salesToday);
    if (salesTitle) salesTitle.textContent = `${period} Sales`;
    const breakdown = $$(".sales-breakdown .breakdown-row");
    const report = data.report;
    const salesByType = report?.fulfillmentSales || [];
    const total = salesByType.reduce((sum, row) => sum + Number(row.amount), 0);
    ["dine", "pick", "deliver"].forEach((name, index) => {
      const match = salesByType.find(row => String(row.type).toLowerCase().includes(name === "pick" ? "pick" : name));
      const row = breakdown[index];
      if (row) { const fields = row.querySelectorAll("span, strong"); if (fields[1]) fields[1].textContent = name === "dine" ? "Dine In" : name === "pick" ? "Pick Up" : "Delivery"; if (fields[2]) fields[2].textContent = money(match?.amount || 0); if (fields[3]) fields[3].textContent = `${total ? (Number(match?.amount || 0) / total * 100).toFixed(1) : "0.0"}%`; }
    });
    if (breakdown[3]) { const strong = breakdown[3].querySelectorAll("strong"); if (strong[1]) strong[1].textContent = data.summary.ordersToday; }
    const paths = $$(".chart svg path");
    if (paths.length >= 2 && report?.daily?.length) {
      const values = report.daily.map(row => Number(row.sales)); const max = Math.max(1, ...values);
      const points = values.map((value, index) => ({ x: values.length < 2 ? 250 : index / (values.length - 1) * 500, y: 128 - value / max * 96 }));
      const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
      paths[0].setAttribute("d", `${line} L500,150 L0,150 Z`); paths[1].setAttribute("d", line);
    }
  }
  async function load() {
    try {
      const [dashboard, report] = await Promise.all([request("/api/staff/dashboard"), request("/api/staff/reports?period=today")]);
      orders = dashboard.orders || [];
      try {
        const profile = JSON.parse(localStorage.getItem("joliesStaffProfile") || "{}");
        const account = JSON.parse(localStorage.getItem("loggedInUser") || sessionStorage.getItem("loggedInUser") || "{}");
        const fullName = account.fullName || account.full_name || account.name || profile.name;
        const firstName = String(fullName || "").trim().split(/\s+/)[0];
        if (firstName && $(".welcome h1")) $(".welcome h1").textContent = `Good morning, ${firstName}! 👋`;
      } catch { /* The dashboard data still loads if browser profile data is unavailable. */ }
      const now = new Date();
      const headerDate = $(".header-date strong"); const headerTime = $(".header-date span");
      if (headerDate) headerDate.textContent = now.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
      if (headerTime) headerTime.textContent = `${now.toLocaleDateString("en-PH", { weekday: "long" })} · ${now.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}`;
      dashboard.report = report;
      renderOrders(); renderInventory(dashboard.inventoryAlerts || []); renderNotifications(); updateSales(dashboard);
    } catch (error) {
      orders = []; renderOrders(); renderInventory([]); renderNotifications();
      $$(".stat-value").forEach(node => node.textContent = "—");
      notify(error.message);
    }
  }
  document.addEventListener("click", async event => {
    const view = event.target.closest("#viewOrders");
    if (view) { event.preventDefault(); location.href = "orders.html"; return; }
    const tab = event.target.closest(".queue-tab");
    if (tab) {
      $$(".queue-tab").forEach(item => item.classList.toggle("active", item === tab));
      $$(".order-row", $("#orderList")).forEach(row => row.hidden = row.dataset.status !== tab.dataset.filter);
      return;
    }
    const start = event.target.closest(".start-order[data-order]"); if (!start) return;
    start.disabled = true;
    try {
      await request(`/api/staff/orders/${encodeURIComponent(start.dataset.order)}/status`, { method: "POST", body: JSON.stringify({ status: "Preparing" }) });
      notify(`${start.dataset.order} is now preparing.`); await load();
    } catch (error) { notify(error.message); start.disabled = false; }
  });
  $("#salesPeriod")?.addEventListener("change", async event => {
    const period = event.target.value === "Today" ? "today" : event.target.value === "This Month" ? "month" : "week";
    try { const data = await request(`/api/staff/reports?period=${period}`); const current = data.current; const value = $(".sales-value"); if (value) value.textContent = money(current.sales); const title = $(".sales-title"); if (title) title.textContent = `${event.target.value} Sales`; const breakdown = $$(".sales-breakdown .breakdown-row"); const total = data.fulfillmentSales.reduce((sum, row) => sum + row.amount, 0);["dine", "pick", "deliver"].forEach((key, i) => { const match = data.fulfillmentSales.find(row => String(row.type).toLowerCase().includes(key === "pick" ? "pick" : key)); const cells = breakdown[i]?.querySelectorAll("span,strong"); if (cells?.[2]) cells[2].textContent = money(match?.amount || 0); if (cells?.[3]) cells[3].textContent = `${total ? (Number(match?.amount || 0) / total * 100).toFixed(1) : "0.0"}%`; }); if (breakdown[3]?.querySelectorAll("strong")[1]) breakdown[3].querySelectorAll("strong")[1].textContent = current.orders; } catch (error) { notify(error.message); }
  });
  load(); setInterval(load, 60000);
})();
