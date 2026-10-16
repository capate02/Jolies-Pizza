(() => {
  const API = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = n => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const cart = new Map(); let menu = [], gcash = {}, latestReceipt = null;
  function getSession() {
    for (const store of [localStorage, sessionStorage]) try {
      const u = JSON.parse(store.getItem("loggedInUser") || "null");
      if (u?.sessionToken && ["staff", "admin"].includes(String(u.role).toLowerCase())) return u;
    } catch { /* try next storage */ }
    return null;
  }
  async function api(path, options = {}) {
    const user = getSession(); if (!user) throw Error("Sign in with a staff or admin account first.");
    const response = await fetch(`${API}${path}`, { ...options, headers: { Authorization: `Bearer ${user.sessionToken}`, ...(options.body ? { "Content-Type": "application/json" } : {}) }, cache: "no-store" });
    const data = await response.json(); if (!response.ok || !data.success) throw Error(data.message || "Request failed."); return data;
  }
  function toast(message) { const el = $("walkinToast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 3000); }
  function total() { return [...cart.values()].reduce((sum, line) => sum + line.price * line.quantity, 0); }
  function renderCart() {
    const items = [...cart.values()];
    $("cartCount").textContent = `${items.reduce((n, i) => n + i.quantity, 0)} item${items.length === 1 ? "" : "s"}`;
    $("menuCartCount").textContent = `${items.reduce((n, i) => n + i.quantity, 0)} items in order`;
    $("cartItems").innerHTML = items.length ? items.map(i => `<div class="cart-row"><div><strong>${esc(i.name)}</strong><small>${esc(i.category || "Menu item")}</small></div><div class="qty-controls"><button data-qty="-1" data-id="${i.id}" aria-label="Remove one">−</button><strong>${i.quantity}</strong><button data-qty="1" data-id="${i.id}" aria-label="Add one">+</button></div><strong>${money(i.price * i.quantity)}</strong></div>`).join("") : '<p class="empty-cart">Choose menu items to start this order.</p>';
    $("summaryItems").innerHTML = items.length ? items.map(i => `<div class="summary-line"><span>${i.quantity}× ${esc(i.name)}</span><strong>${money(i.price * i.quantity)}</strong></div>`).join("") : '<p class="empty-cart">No items yet.</p>';
    $("cartTotal").textContent = $("summaryTotal").textContent = money(total()); $("openPayment").disabled = !items.length;
  }
  function renderMenu() {
    const q = $("menuSearch").value.toLowerCase(), category = $("menuCategory").value;
    const list = menu.filter(p => p.is_available && (!q || `${p.name} ${p.description || ""} ${p.category_name || ""}`.toLowerCase().includes(q)) && (category === "all" || String(p.category_id) === category));
    $("menuGrid").innerHTML = list.length ? list.map(p => `<article class="menu-product">${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy">` : ""}<h3>${esc(p.name)}</h3><small>${esc(p.category_name || "")}</small><strong>${money(p.price)}</strong><button type="button" data-add="${p.id}"><i class="fa-solid fa-plus"></i> Add</button></article>`).join("") : '<p>No available menu items found.</p>';
  }
  async function loadMenu() {
    try {
      const data = await api("/api/staff/walk-in/menu"); menu = data.products || [];
      const cats = [...new Map(menu.map(p => [p.category_id, p.category_name]).filter(([id]) => id)).entries()];
      $("menuCategory").innerHTML = '<option value="all">All categories</option>' + cats.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join("");
      renderMenu();
    } catch (error) { $("menuGrid").innerHTML = `<p>${esc(error.message)}</p>`; }
  }
  async function loadGcash() {
    try {
      gcash = await api("/api/config/gcash");
      const bits = [gcash.accountName, gcash.accountNumber].filter(Boolean);
      $("gcashAccount").textContent = bits.length ? bits.join(" · ") : "Shop GCash is not configured yet. Add GCASH_ACCOUNT_NAME and GCASH_ACCOUNT_NUMBER to backend/.env.";
      if (gcash.qrImageUrl) { $("gcashQR").src = gcash.qrImageUrl; $("gcashQR").hidden = false; }
    } catch (e) { $("gcashAccount").textContent = e.message; }
  }
  function showReceipt(order, status, method) {
    const business = window.joliesBusiness || { siteName: "Jolie's Pizza", address: "San Roque, Northern Samar" };
    latestReceipt = { order, status, method, business };
    $("receiptPaper").innerHTML = `<h2>${esc(business.siteName)}</h2><p class="receipt-meta">${esc(business.address)}<br>Dine-in · Payment receipt</p><hr><div class="summary-line"><span>Order</span><strong>#${esc(order.orderNumber)}</strong></div><div class="summary-line"><span>Customer</span><strong>${esc(order.customerName || $("customerName").value || "Walk-in Customer")}</strong></div><div class="summary-line"><span>Date</span><strong>${new Date().toLocaleString("en-PH")}</strong></div>${(order.items || []).map(i => `<div class="summary-line"><span>${i.quantity}× ${esc(i.name)}</span><strong>${money(i.lineTotal)}</strong></div>`).join("")}<div class="cart-total"><span>Total</span><strong>${money(order.total)}</strong></div><p class="receipt-state">${method === "GCash" ? `GCash proof received · Payment ${status}` : `Cash received · Payment ${status}`}</p><p class="receipt-meta">${esc(business.contact || "")} · ${esc(business.email || "")}<br>Please keep this receipt for your records.</p>`;
    $("receiptModal").showModal();
  }
  async function imageData(file) {
    if (!file) return "";
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw Error("Choose a PNG, JPEG, or WebP receipt image.");
    const img = await createImageBitmap(file); const scale = Math.min(1, 1100 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    let quality = .78, data = canvas.toDataURL("image/jpeg", quality);
    while (data.length > 760000 && quality > .35) { quality -= .1; data = canvas.toDataURL("image/jpeg", quality); }
    if (data.length > 900000) throw Error("Receipt image is too large. Choose a smaller image."); return data;
  }
  $("openMenu").addEventListener("click", () => { loadMenu(); $("menuModal").showModal(); });
  $("openPayment").addEventListener("click", () => { if (!cart.size) return; $("paymentTotal").textContent = money(total()); $("paymentModal").showModal(); loadGcash(); });
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => $(b.dataset.close).close()));
  $("menuSearch").addEventListener("input", renderMenu); $("menuCategory").addEventListener("change", renderMenu);
  $("menuGrid").addEventListener("click", e => { const b = e.target.closest("[data-add]"); if (!b) return; const p = menu.find(x => Number(x.id) === Number(b.dataset.add)); if (!p) return; const line = cart.get(p.id) || { id: p.id, name: p.name, price: Number(p.price), category: p.category_name, quantity: 0 }; line.quantity++; cart.set(p.id, line); renderCart(); toast(`${p.name} added.`); });
  $("cartItems").addEventListener("click", e => { const b = e.target.closest("[data-qty]"); if (!b) return; const line = cart.get(Number(b.dataset.id)); if (!line) return; line.quantity += Number(b.dataset.qty); if (line.quantity <= 0) cart.delete(line.id); renderCart(); });
  document.querySelectorAll("input[name=walkinMethod]").forEach(r => r.addEventListener("change", () => { $("gcashPanel").hidden = document.querySelector("input[name=walkinMethod]:checked").value !== "GCash"; }));
  $("submitOrder").addEventListener("click", async () => {
    const button = $("submitOrder"), method = document.querySelector("input[name=walkinMethod]:checked").value;
    button.disabled = true;
    try {
      const proofImageData = method === "GCash" ? await imageData($("proofImage").files[0]) : "";
      const result = await api("/api/staff/walk-in/orders", { method: "POST", body: JSON.stringify({ customerName: $("customerName").value.trim() || "Walk-in Customer", customerPhone: $("customerPhone").value.trim(), paymentMethod: method, proofReference: $("proofReference").value.trim(), proofImageData, items: [...cart.values()].map(i => ({ productId: i.id, quantity: i.quantity, size: "Regular" })) }) });
      $("paymentModal").close(); cart.clear(); renderCart(); $("customerName").value = ""; $("customerPhone").value = ""; $("proofReference").value = ""; $("proofImage").value = "";
      showReceipt({ ...result.order, customerName: result.order.customerName || "Walk-in Customer" }, method === "Cash" ? "Paid" : "Pending staff verification", method);
      toast(method === "GCash" ? "Order saved. Review the proof in Payments and confirm the transfer." : "Cash payment recorded.");
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  $("printReceipt").addEventListener("click", () => window.print());
  $("downloadReceipt").addEventListener("click", () => {
    if (!latestReceipt) return;
    const content = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(latestReceipt.business.siteName)} receipt ${esc(latestReceipt.order.orderNumber)}</title><style>body{font:14px Arial,sans-serif;color:#202124;background:#f3f4f6;margin:0;padding:24px}.receipt{max-width:420px;margin:20px auto;padding:28px;background:#fff;border:1px solid #ddd;border-radius:12px}.receipt h2{text-align:center}.receipt-meta{text-align:center;color:#667085;line-height:1.6}.summary-line{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px dashed #d0d5dd}.cart-total{display:flex;justify-content:space-between;padding-top:18px;font-weight:bold;font-size:18px}.receipt-state{margin-top:16px;padding:12px;border-radius:8px;background:#ecfdf3;color:#027a48;text-align:center;font-weight:bold}</style></head><body><main class="receipt">${$("receiptPaper").innerHTML}</main></body></html>`;
    const file = new Blob([content], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(file); const link = document.createElement("a");
    link.href = url; link.download = `Jolies-Pizza-${latestReceipt.order.orderNumber}-receipt.html`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("menuToggle")?.addEventListener("click", e => { const open = $("sidebar").classList.toggle("open"); e.currentTarget.setAttribute("aria-expanded", String(open)); });
  renderCart(); loadMenu();
})();
