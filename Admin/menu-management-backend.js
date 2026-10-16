(() => {
    const API_BASE = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    let products = [];
    let categories = [];
    let editingId = null;
    let currentPage = 1;
    const pageSize = 10;
    const $ = id => document.getElementById(id);
    const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const money = value => `₱${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const token = () => {
        for (const store of [localStorage, sessionStorage]) {
            try { const user = JSON.parse(store.getItem("loggedInUser") || "null"); if (user?.sessionToken && String(user.role).toLowerCase() === "admin") return user.sessionToken; } catch { }
        }
        return "";
    };
    async function api(path, options = {}) {
        const session = token();
        if (!session) throw new Error("Please sign in with an admin account to manage the menu.");
        const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${session}`, ...(options.body ? { "Content-Type": "application/json" } : {}) }, cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || "Menu request failed.");
        return result;
    }
    function toast(message) {
        const box = $("toast"); if (!box) return;
        box.textContent = message; box.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => box.classList.remove("show"), 2600);
    }
    function replaceWithFresh(id) {
        const old = $(id); if (!old) return null;
        const fresh = old.cloneNode(true); old.replaceWith(fresh); return fresh;
    }
    function categoryOptions(select, selected = "") {
        if (!select) return;
        select.innerHTML = categories.filter(category => category.isActive || String(category.id) === String(selected))
            .map(category => `<option value="${category.id}" ${String(category.id) === String(selected) ? "selected" : ""}>${escape(category.name)}</option>`).join("");
    }
    function renderProducts() {
        const body = $("menuTableBody"); if (!body) return;
        const search = $("searchInput")?.value.trim().toLowerCase() || "";
        const category = $("categoryFilter")?.value || "all";
        const status = $("statusFilter")?.value || "all";
        const filtered = products.filter(item => {
            const state = item.isAvailable ? "Active" : "Inactive";
            return (!search || `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(search)) &&
                (category === "all" || String(item.categoryId) === category) && (status === "all" || state === status);
        });
        const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
        currentPage = Math.min(currentPage, pageCount);
        const pageItems = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
        body.innerHTML = pageItems.length ? pageItems.map(item => `<tr>
            <td><div class="item-cell"><div class="item-image ${escape(item.categorySlug || "menu-item")}" aria-hidden="true">${item.imageUrl ? `<img src="${escape(item.imageUrl)}" alt="">` : "🍕"}</div><div class="item-info"><strong>${escape(item.name)}</strong><span>${escape(item.description)}</span></div></div></td>
            <td>${escape(item.category)}</td><td class="price">${money(item.price)}</td>
            <td><span class="status ${item.isAvailable ? "active" : "inactive"}">${item.isAvailable ? "Active" : "Inactive"}</span></td>
            <td><div class="popularity"><span class="rating-count">Order history</span></div></td>
            <td><div class="actions"><button class="action-btn edit-btn" type="button" data-id="${item.id}" title="Edit">✎</button><button class="action-btn delete delete-btn" type="button" data-id="${item.id}" title="Mark inactive" ${item.isAvailable ? "" : "disabled"}>×</button></div></td>
        </tr>`).join("") : '<tr><td colspan="6" class="empty-state">No menu items match your filters.</td></tr>';
        body.querySelectorAll(".item-image img").forEach(image => image.addEventListener("error", () => { image.remove(); image.parentElement.textContent = "🍕"; }));
        const firstItem = filtered.length ? (currentPage - 1) * pageSize + 1 : 0;
        const lastItem = Math.min(currentPage * pageSize, filtered.length);
        const count = $("resultCount"); if (count) count.textContent = filtered.length ? `Showing ${firstItem} to ${lastItem} of ${filtered.length} items` : "Showing 0 items";
        const pager = document.querySelector(".pagination .page-buttons");
        if (pager) {
            pager.innerHTML = `<button type="button" data-page="prev" aria-label="Previous page" ${currentPage === 1 ? "disabled" : ""}>‹</button>${Array.from({ length: pageCount }, (_, index) => `<button type="button" data-page="${index + 1}" class="${currentPage === index + 1 ? "active" : ""}">${index + 1}</button>`).join("")}<button type="button" data-page="next" aria-label="Next page" ${currentPage === pageCount ? "disabled" : ""}>›</button>`;
        }
        const overview = document.querySelectorAll(".overview-stat strong");
        if (overview[0]) overview[0].textContent = products.length;
        if (overview[1]) overview[1].textContent = products.filter(item => item.isAvailable).length;
        if (overview[2]) overview[2].textContent = products.filter(item => !item.isAvailable).length;
        if (overview[3]) overview[3].textContent = categories.length;
        const categoryFilter = $("categoryFilter");
        if (categoryFilter) {
            const selected = categoryFilter.value;
            categoryFilter.innerHTML = '<option value="all">All Categories</option>' + categories.map(category => `<option value="${category.id}">${escape(category.name)}</option>`).join("");
            categoryFilter.value = selected;
        }
    }
    function renderCategories() {
        const grid = document.querySelector("#categoriesView .category-management-grid");
        if (grid) grid.innerHTML = categories.map(category => `<article class="managed-category"><span class="category-icon">🍕</span><div><strong>${escape(category.name)}</strong><small>${category.itemCount} items · ${category.isActive ? "Active" : "Inactive"}</small><small>${escape(category.description)}</small></div><button type="button" class="edit-category" data-id="${category.id}" title="Edit category">✎</button></article>`).join("") || "<p>No categories have been created yet.</p>";
        const rows = document.querySelectorAll(".category-card .category-row");
        rows.forEach(row => row.remove());
        const card = $("categories");
        categories.slice(0, 5).forEach(category => {
            const row = document.createElement("div"); row.className = "category-row";
            row.innerHTML = `<span class="category-icon">🍕</span><strong>${escape(category.name)}</strong><span>${category.itemCount} items</span>`;
            card?.appendChild(row);
        });
        const select = $("itemCategory"); categoryOptions(select, select?.value);
    }
    function openProduct(item = null) {
        editingId = item?.id ?? null;
        $("modalTitle").textContent = item ? "Edit Menu Item" : "Add Menu Item";
        $("itemName").value = item?.name || "";
        $("itemDescription").value = item?.description || "";
        $("itemImageUrl").value = item?.imageUrl || "";
        $("itemPrice").value = item?.price ?? "";
        $("itemStatus").value = item?.isAvailable === false ? "Inactive" : "Active";
        categoryOptions($("itemCategory"), item?.categoryId || categories.find(category => category.isActive)?.id);
        $("menuModal").classList.add("show");
    }
    function closeProduct() { $("menuModal").classList.remove("show"); editingId = null; $("menuForm").reset(); }
    async function load() {
        try {
            const data = await api("/api/admin/menu"); products = data.products || []; categories = data.categories || [];
            renderCategories(); renderProducts();
        } catch (error) {
            const body = $("menuTableBody"); if (body) body.innerHTML = `<tr><td colspan="6">${escape(error.message)}</td></tr>`;
            toast(error.message);
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        ["menuTableBody", "searchInput", "categoryFilter", "statusFilter", "addMenuBtn", "menuForm", "modalClose", "addCategoryBtn"].forEach(replaceWithFresh);
        const oldPager = document.querySelector(".pagination .page-buttons");
        if (oldPager) { const freshPager = oldPager.cloneNode(false); oldPager.replaceWith(freshPager); freshPager.addEventListener("click", event => {
            const button = event.target.closest("button[data-page]"); if (!button || button.disabled) return;
            const target = button.dataset.page;
            if (target === "prev") currentPage = Math.max(1, currentPage - 1);
            else if (target === "next") currentPage += 1;
            else currentPage = Number(target);
            renderProducts();
        }); }
        const resetAndRender = () => { currentPage = 1; renderProducts(); };
        $("searchInput")?.addEventListener("input", resetAndRender);
        $("categoryFilter")?.addEventListener("change", resetAndRender);
        $("statusFilter")?.addEventListener("change", resetAndRender);
        $("searchBtn")?.addEventListener("click", resetAndRender);
        $("filterBtn")?.addEventListener("click", resetAndRender);
        $("addMenuBtn")?.addEventListener("click", () => openProduct());
        $("modalClose")?.addEventListener("click", closeProduct);
        $("menuModal")?.addEventListener("click", event => { if (event.target === $("menuModal")) closeProduct(); });
        $("menuForm")?.addEventListener("submit", async event => {
            event.preventDefault();
            const wasEditing = editingId !== null;
            const body = { name: $("itemName").value.trim(), description: $("itemDescription").value.trim(), imageUrl: $("itemImageUrl").value.trim(), categoryId: Number($("itemCategory").value), price: Number($("itemPrice").value), isAvailable: $("itemStatus").value === "Active" };
            try {
                await api(editingId ? `/api/admin/menu-items/${editingId}` : "/api/admin/menu-items", { method: editingId ? "PATCH" : "POST", body: JSON.stringify(body) });
                closeProduct(); await load(); toast(wasEditing ? "Menu item updated." : "Menu item added.");
            } catch (error) { toast(error.message); }
        });
        $("menuTableBody")?.addEventListener("click", async event => {
            const edit = event.target.closest(".edit-btn");
            const remove = event.target.closest(".delete-btn");
            if (edit) { const item = products.find(row => row.id === Number(edit.dataset.id)); if (item) openProduct(item); }
            if (remove && confirm("Mark this menu item inactive? It will remain in past order history.")) {
                try { await api(`/api/admin/menu-items/${remove.dataset.id}`, { method: "DELETE" }); await load(); toast("Menu item marked inactive."); }
                catch (error) { toast(error.message); }
            }
        });
        $("category-management-grid")?.addEventListener("click", categoryEdit);
        document.querySelector("#categoriesView .category-management-grid")?.addEventListener("click", categoryEdit);
        $("addCategoryBtn")?.addEventListener("click", () => { location.href = "categories.html"; });
        document.querySelector(".category-card .view-all")?.addEventListener("click", () => { location.href = "categories.html"; });
        load();
    });

    function categoryEdit(event) {
        const button = event.target.closest(".edit-category"); if (!button) return;
        location.href = `categories.html?edit=${encodeURIComponent(button.dataset.id)}`;
    }
})();
