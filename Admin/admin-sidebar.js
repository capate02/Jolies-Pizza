(() => {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  const nav = sidebar.querySelector(".side-nav, .sidebar-nav");
  if (!nav) return;

  const current = decodeURIComponent(location.pathname.split("/").pop() || "dashboard.html").toLowerCase();
  const logout = nav.querySelector(".logout-item") || sidebar.querySelector(".logout-item");
  const pages = [
    ["Dashboard", "dashboard.html", "dashboard"],
    ["Orders", "orders.html", "orders"],
    ["Delivery Tracking", "delivery-tracking.html", "delivery"],
    ["Online Payments", "online-payments.html", "payments"],
    ["Notifications", "notifications.html", "notifications"],
    ["Reports", "reports.html", "reports"],
    ["Staff Management", "staff-management.html", "staff"],
    ["Settings", "settings.html", "settings"]
  ];
  const link = ([label, href, icon]) => `<a class="nav-item${current === href.toLowerCase() ? " active" : ""}" href="${href}" data-page="${label}"${current === href.toLowerCase() ? ' aria-current="page"' : ""}><span class="nav-icon" data-icon="${icon}"></span><span>${label}</span></a>`;
  const submenu = (items, active) => `<div class="submenu${active ? " open" : ""}">${items.map(([label, href]) => { const isCurrent = current === decodeURIComponent(href).toLowerCase(); return `<a class="submenu-item${isCurrent ? " active-sub" : ""}" href="${href}"${isCurrent ? ' aria-current="page"' : ""}><span class="submenu-dot"></span>${label}</a>`; }).join("")}</div>`;
  const menuActive = ["menu-management.html", "categories.html"].includes(current);
  const inventoryActive = ["inventory overview.html", "inventory stock-items.html", "inventory stock-in.html", "inventory stock-out.html"].includes(current);
  let menu = `<div class="nav-group${menuActive ? " expanded" : ""}" data-nav-group="menu"><button type="button" class="nav-item nav-group-toggle${menuActive ? " active" : ""}" aria-expanded="${menuActive}" aria-controls="menuSubmenu"><span class="nav-icon" data-icon="menu"></span><span>Menu Management</span><span class="nav-chevron" aria-hidden="true">⌄</span></button>${submenu([["Menu Items", "menu-management.html"], ["Categories", "categories.html"]], menuActive).replace('class="submenu', 'id="menuSubmenu" class="submenu')}</div>`;
  menu += `<div class="nav-group${inventoryActive ? " expanded" : ""}" data-nav-group="inventory"><button type="button" class="nav-item nav-group-toggle${inventoryActive ? " active" : ""}" aria-expanded="${inventoryActive}" aria-controls="inventorySubmenu"><span class="nav-icon" data-icon="inventory"></span><span>Inventory</span><span class="nav-chevron" aria-hidden="true">⌄</span></button>${submenu([["Overview", "inventory%20overview.html"], ["Stock Items", "inventory%20stock-items.html"], ["Stock In", "inventory%20stock-in.html"], ["Stock Out", "inventory%20stock-out.html"]], inventoryActive).replace('class="submenu', 'id="inventorySubmenu" class="submenu')}</div>`;
  const notificationLink = `<a class="nav-item${current === "notifications.html" ? " active" : ""}" href="notifications.html" data-page="Notifications"${current === "notifications.html" ? ' aria-current="page"' : ""}><span class="nav-icon" data-icon="notifications"></span><span>Notifications</span><span class="notification-count" id="sidebarPending" hidden></span></a>`;
  nav.innerHTML = pages.slice(0, 2).map(link).join("") + menu + pages.slice(2, 4).map(link).join("") + notificationLink + pages.slice(5).map(link).join("");
  if (logout) nav.append(logout);

  nav.querySelectorAll(".nav-group-toggle").forEach(button => button.addEventListener("click", () => {
    const group = button.closest(".nav-group");
    const expanded = group.classList.toggle("expanded");
    button.setAttribute("aria-expanded", String(expanded));
    group.querySelector(".submenu")?.classList.toggle("open", expanded);
  }));

  document.dispatchEvent(new Event("admin-sidebar-rendered"));

  function getAdminToken() {
    for (const storage of [localStorage, sessionStorage]) try {
      const user = JSON.parse(storage.getItem("loggedInUser") || "null");
      if (user?.sessionToken && String(user.role).toLowerCase() === "admin") return user.sessionToken;
    } catch { /* check the other store */ }
    return "";
  }
  async function refreshNotifications() {
    const badge = nav.querySelector(".notification-count");
    if (!badge) return;
    const token = getAdminToken();
    if (!token) { badge.hidden = true; return; }
    try {
      const apiBase = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
      const response = await fetch(`${apiBase}/api/admin/inventory/requests?status=pending`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || "Could not refresh notifications.");
      const count = (result.requests || []).filter(request => request.status === "pending").length;
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.hidden = count === 0;
      badge.setAttribute("aria-label", `${count} pending notification${count === 1 ? "" : "s"}`);
    } catch {
      badge.hidden = true;
    }
  }
  void refreshNotifications();
  window.setInterval(refreshNotifications, 30000);
})();
