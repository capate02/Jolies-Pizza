(() => {
    const API_BASE = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    let categories = [];
    let editingId = null;
    let selectedId = null;
    const $ = id => document.getElementById(id);
    const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const token = () => {
        for (const store of [localStorage, sessionStorage]) {
            try { const user = JSON.parse(store.getItem("loggedInUser") || "null"); if (user?.sessionToken && String(user.role).toLowerCase() === "admin") return user.sessionToken; } catch { }
        }
        return "";
    };
    async function api(path, options = {}) {
        const session = token();
        if (!session) throw new Error("Please sign in with an admin account to manage categories.");
        const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${session}`, ...(options.body ? { "Content-Type": "application/json" } : {}) }, cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || "Category request failed.");
        return result;
    }
    function toast(message) {
        const box = $("toast"); if (!box) return;
        box.textContent = message; box.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => box.classList.remove("show"), 2800);
    }
    function fresh(id) { const old = $(id); if (!old) return; const replacement = old.cloneNode(true); old.replaceWith(replacement); return replacement; }
    function iconFor(name) {
        const value = String(name).toLowerCase();
        if (value.includes("drink")) return "🥤"; if (value.includes("side")) return "🍟";
        if (value.includes("pasta")) return "🍝"; if (value.includes("dessert")) return "🍰";
        if (value.includes("sauce")) return "🧴"; if (value.includes("promo")) return "🏷️";
        return "🍕";
    }
    function date(value) { if (!value) return "—"; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }); }
    function render() {
        const body = $("categoryTableBody"); if (!body) return;
        const search = $("searchInput").value.trim().toLowerCase();
        const status = $("statusFilter").value;
        const filtered = categories.filter(category => `${category.name} ${category.description}`.toLowerCase().includes(search) && (status === "all" || (category.isActive ? "Active" : "Inactive") === status));
        body.innerHTML = filtered.length ? filtered.map((category, index) => `<tr data-id="${category.id}" class="${category.id === selectedId ? "selected" : ""}">
            <td>${index + 1}</td><td><div class="category-name-cell"><div class="category-icon">${iconFor(category.name)}</div><span class="category-name">${escape(category.name)}</span></div></td>
            <td>${escape(category.description || "—")}</td><td>${category.itemCount}</td>
            <td><span class="status-badge ${category.isActive ? "active" : "inactive"}">${category.isActive ? "Active" : "Inactive"}</span></td>
            <td><div class="action-buttons"><button type="button" class="action-button edit" data-action="edit" data-id="${category.id}" title="Edit">✎</button><button type="button" class="action-button delete" data-action="delete" data-id="${category.id}" title="Delete">×</button></div></td></tr>`).join("") : '<tr><td colspan="6" class="empty-state">No categories match your filters.</td></tr>';
        $("showingText").textContent = `Showing ${filtered.length ? `1 to ${filtered.length} of ` : "0 of "}${categories.length} categories`;
        const totalItems = categories.reduce((sum, item) => sum + item.itemCount, 0);
        const active = categories.filter(item => item.isActive).length;
        const inactive = categories.length - active;
        if ($("totalCategories")) $("totalCategories").textContent = categories.length;
        if ($("activeCategories")) $("activeCategories").textContent = active;
        if ($("inactiveCategories")) $("inactiveCategories").textContent = inactive;
        if ($("totalItems")) $("totalItems").textContent = totalItems;
        if ($("activePercentage")) $("activePercentage").textContent = categories.length ? `${Math.round(active / categories.length * 100)}% of total` : "0% of total";
        if ($("inactivePercentage")) $("inactivePercentage").textContent = categories.length ? `${Math.round(inactive / categories.length * 100)}% of total` : "0% of total";
        body.querySelectorAll("tr[data-id]").forEach(row => row.addEventListener("click", event => {
            const action = event.target.closest("[data-action]");
            if (action?.dataset.action === "edit") return openModal(Number(action.dataset.id));
            if (action?.dataset.action === "delete") return removeCategory(Number(action.dataset.id));
            selectCategory(Number(row.dataset.id));
        }));
    }
    function selectCategory(id) {
        const category = categories.find(item => item.id === id); if (!category) return;
        selectedId = id;
        $("detailIcon").textContent = iconFor(category.name);
        $("detailName").textContent = category.name;
        $("detailDescription").textContent = category.description || "No description";
        $("detailItems").textContent = category.itemCount;
        $("detailStatus").textContent = category.isActive ? "Active" : "Inactive";
        $("detailStatus").className = `status-badge ${category.isActive ? "active" : "inactive"}`;
        $("detailCreated").textContent = date(category.createdAt);
        $("detailUpdated").textContent = date(category.updatedAt);
        render();
    }
    function openModal(id = null) {
        const category = id == null ? null : categories.find(item => item.id === id);
        editingId = category?.id ?? null;
        $("modalTitle").textContent = category ? "Edit Category" : "Add New Category";
        $("categoryName").value = category?.name || "";
        $("categoryDescription").value = category?.description || "";
        $("categoryStatus").value = category?.isActive === false ? "Inactive" : "Active";
        $("categoryModal").classList.add("show");
    }
    function closeModal() { $("categoryModal").classList.remove("show"); $("categoryForm").reset(); editingId = null; }
    async function load() {
        try {
            const result = await api("/api/admin/menu"); categories = result.categories || [];
            render();
            const queryId = Number(new URLSearchParams(location.search).get("edit"));
            if (queryId && categories.some(item => item.id === queryId)) openModal(queryId);
            else if (categories.length) selectCategory(categories[0].id);
        } catch (error) { $("categoryTableBody").innerHTML = `<tr><td colspan="6">${escape(error.message)}</td></tr>`; toast(error.message); }
    }
    async function removeCategory(id) {
        const category = categories.find(item => item.id === id); if (!category) return;
        if (!confirm(`Delete category “${category.name}”? Categories with menu items cannot be deleted.`)) return;
        try { await api(`/api/admin/categories/${id}`, { method: "DELETE" }); categories = categories.filter(item => item.id !== id); if (selectedId === id) selectedId = categories[0]?.id || null; render(); if (selectedId) selectCategory(selectedId); toast("Category deleted."); }
        catch (error) { toast(error.message); }
    }
    document.addEventListener("DOMContentLoaded", () => {
        ["categoryTableBody", "searchInput", "searchBtn", "statusFilter", "addCategoryBtn", "categoryForm", "modalClose", "cancelModal", "prevPage", "nextPage"].forEach(fresh);
        $("searchInput")?.addEventListener("input", render);
        $("searchBtn")?.addEventListener("click", render);
        $("statusFilter")?.addEventListener("change", render);
        $("filterBtn")?.addEventListener("click", render);
        $("addCategoryBtn")?.addEventListener("click", () => openModal());
        $("modalClose")?.addEventListener("click", closeModal);
        $("cancelModal")?.addEventListener("click", closeModal);
        $("categoryModal")?.addEventListener("click", event => { if (event.target === $("categoryModal")) closeModal(); });
        $("categoryForm")?.addEventListener("submit", async event => {
            event.preventDefault();
            const body = { name: $("categoryName").value.trim(), description: $("categoryDescription").value.trim(), isActive: $("categoryStatus").value === "Active" };
            try { await api(editingId ? `/api/admin/categories/${editingId}` : "/api/admin/categories", { method: editingId ? "PATCH" : "POST", body: JSON.stringify(body) }); const wasEditing = editingId !== null; closeModal(); await load(); toast(wasEditing ? "Category updated." : "Category added."); }
            catch (error) { toast(error.message); }
        });
        load();
    });
})();
