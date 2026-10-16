(() => {
    const API_BASE = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
    let staff = [];
    let counts = {};
    let selectedId = null;
    let activeTab = "all";
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
        if (!session) throw new Error("Please sign in with an admin account to manage staff.");
        const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${session}`, ...(options.body ? { "Content-Type": "application/json" } : {}) }, cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || "Staff request failed.");
        return result;
    }
    function toast(message) {
        const box = $("toast"); if (!box) return;
        box.textContent = message; box.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => box.classList.remove("show"), 2800);
    }
    function fresh(node) { if (!node) return null; const replacement = node.cloneNode(true); node.replaceWith(replacement); return replacement; }
    function formatDate(value, options = { dateStyle: "medium" }) {
        if (!value) return "—";
        const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-PH", options);
    }
    function displayStatus(person) {
        if (person.approvalStatus === "pending") return "Pending Approval";
        if (person.approvalStatus === "declined") return "Declined";
        return person.isActive ? "Approved" : "Inactive";
    }
    function filteredStaff() {
        const search = $("staffSearch")?.value.trim().toLowerCase() || "";
        const role = $("roleFilter")?.value || "all";
        const status = $("statusFilter")?.value || "all";
        return staff.filter(person => {
            const text = `${person.fullName} ${person.email} ${person.phone} ${person.position}`.toLowerCase();
            const state = person.approvalStatus;
            return (!search || text.includes(search)) && (role === "all" || person.position === role) &&
                (status === "all" || state === status) && (activeTab === "all" || state === activeTab);
        });
    }
    function renderStats() {
        const cards = document.querySelectorAll(".stats-grid .stat-card h2");
        const total = staff.length;
        const approved = staff.filter(person => person.approvalStatus === "approved" && person.isActive).length;
        const inactive = staff.filter(person => person.approvalStatus === "declined" || !person.isActive).length;
        const pending = Number(counts.pending || 0);
        const newThisMonth = staff.filter(person => {
            const date = new Date(person.createdAt); const now = new Date();
            return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
        }).length;
        [total, approved, inactive, pending, newThisMonth].forEach((value, index) => { if (cards[index]) cards[index].textContent = value; });
        const pendingTab = document.querySelector('.staff-toolbar .tab[data-status="pending"]');
        if (pendingTab) pendingTab.textContent = `Pending Approval (${pending})`;
    }
    function renderTable() {
        const body = $("staffTableBody"); if (!body) return;
        const people = filteredStaff();
        body.innerHTML = people.length ? people.map(person => {
            const id = `STF-${String(person.id).padStart(5, "0")}`;
            const initials = String(person.fullName || "S").trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
            const status = displayStatus(person);
            const statusClass = person.approvalStatus === "pending" ? "pending" : person.approvalStatus === "declined" || !person.isActive ? "inactive" : "active";
            const actions = person.approvalStatus === "pending"
                ? `<button type="button" class="table-action approve" data-action="approve" data-id="${person.id}" title="Approve account">✓</button><button type="button" class="table-action decline" data-action="decline" data-id="${person.id}" title="Decline account">×</button>`
                : `<button type="button" class="table-action edit" data-action="edit" data-id="${person.id}" title="Edit details">✎</button>`;
            return `<tr data-id="${person.id}" class="${person.id === selectedId ? "selected" : ""}">
                <td><strong>${id}</strong></td><td><div class="name-cell"><div class="staff-avatar">${escape(initials)}</div><div class="name-info"><strong>${escape(person.fullName)}</strong><span>${escape(person.email)}</span></div></div></td>
                <td><span class="role-badge">${escape(person.position)}</span></td><td><div class="contact-info"><span>${escape(person.phone || "No phone")}</span></div></td>
                <td><span class="status-badge ${statusClass}">${status}</span></td><td>${escape(person.shift)}</td>
                <td>${person.lastTimeIn ? escape(formatDate(person.lastTimeIn, { dateStyle: "short", timeStyle: "short" })) : "—"}</td>
                <td>${person.lastTimeOut ? escape(formatDate(person.lastTimeOut, { dateStyle: "short", timeStyle: "short" })) : person.lastTimeIn ? "Still clocked in" : "—"}</td>
                <td>${escape(formatDate(person.createdAt, { dateStyle: "medium" }))}</td>
                <td><div class="action-buttons">${actions}<button type="button" class="table-action delete" data-action="delete" data-id="${person.id}" title="Delete account">⌫</button></div></td>
            </tr>`;
        }).join("") : '<tr><td colspan="10" class="empty-row">No staff accounts match this filter.</td></tr>';
        const showing = $("paginationText"); if (showing) showing.textContent = `Showing ${people.length} of ${staff.length} staff accounts`;
        body.querySelectorAll("tr[data-id]").forEach(row => row.addEventListener("click", event => {
            const action = event.target.closest("[data-action]");
            if (action) { handleAction(action.dataset.action, Number(action.dataset.id)); return; }
            selectStaff(Number(row.dataset.id));
        }));
        renderStats();
    }
    function setDetail(id) {
        const person = staff.find(item => item.id === id); if (!person) return;
        selectedId = id;
        const status = displayStatus(person);
        $("detailStatus").textContent = status;
        $("detailStatus").className = `detail-status ${person.approvalStatus === "pending" ? "pending-status" : person.approvalStatus === "declined" || !person.isActive ? "inactive-status" : "active-status"}`;
        $("detailPhoto").textContent = String(person.fullName).trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
        $("detailName").textContent = person.fullName;
        $("detailRole").textContent = person.position;
        $("detailEmail").textContent = person.email;
        $("detailPhone").textContent = person.phone || "No phone number";
        $("detailGender").textContent = "Not provided";
        $("detailBirthday").textContent = "Not provided";
        $("detailAddress").textContent = person.address || "Not provided";
        $("detailId").textContent = `STF-${String(person.id).padStart(5, "0")}`;
        $("detailJoined").textContent = formatDate(person.createdAt, { dateStyle: "medium" });
        $("detailRole2").textContent = person.position;
        $("detailShift").textContent = person.shift;
        const edit = $("editStaffBtn");
        if (edit) { edit.hidden = person.approvalStatus !== "approved"; edit.textContent = "Edit Staff Information"; }
        let attendance = $("attendanceDetails");
        if (!attendance) {
            attendance = document.createElement("section"); attendance.id = "attendanceDetails"; attendance.className = "detail-section attendance-details";
            document.querySelector(".staff-details .edit-staff-btn")?.before(attendance);
        }
        attendance.innerHTML = `<h4>Attendance (Recent)</h4><p>Loading time-in and time-out records…</p>`;
        const decisionBox = document.getElementById("staffApprovalActions");
        if (decisionBox) decisionBox.remove();
        if (person.approvalStatus === "pending") {
            const box = document.createElement("div"); box.id = "staffApprovalActions"; box.className = "staff-approval-actions";
            box.innerHTML = `<button type="button" class="approve-account" data-id="${person.id}">Approve Account</button><button type="button" class="decline-account" data-id="${person.id}">Decline Request</button>`;
            attendance.after(box);
            box.addEventListener("click", event => { const button = event.target.closest("button"); if (button) handleAction(button.classList.contains("approve-account") ? "approve" : "decline", Number(button.dataset.id)); });
        }
        const deleteButton = document.getElementById("deleteStaffAccount");
        if (deleteButton) deleteButton.remove();
        const remove = document.createElement("button"); remove.id = "deleteStaffAccount"; remove.className = "delete-staff-account"; remove.type = "button"; remove.textContent = "Delete Staff Account";
        attendance.after(remove); remove.addEventListener("click", () => handleAction("delete", id));
        renderTable();
        loadAttendance(id, attendance);
    }
    async function loadAttendance(id, target) {
        try {
            const result = await api(`/api/admin/staff/${id}/attendance`);
            if (selectedId !== id) return;
            target.innerHTML = `<h4>Attendance (Recent)</h4>${result.attendance?.length ? `<div class="attendance-list">${result.attendance.map(record => `<div class="attendance-row"><span>${escape(formatDate(record.timeIn, { dateStyle: "medium" }))}</span><span>In: <strong>${escape(formatDate(record.timeIn, { timeStyle: "short" }))}</strong></span><span>Out: <strong>${record.timeOut ? escape(formatDate(record.timeOut, { timeStyle: "short" })) : "Still clocked in"}</strong></span></div>`).join("")}</div>` : "<p>No attendance records yet. Time-in is recorded at staff login, and time-out at logout.</p>"}`;
        } catch (error) { target.innerHTML = `<h4>Attendance</h4><p>${escape(error.message)}</p>`; }
    }
    function selectStaff(id) { setDetail(id); }
    function openEdit(person) {
        $("modalTitle").textContent = "Edit Staff Information";
        $("formName").value = person.fullName;
        $("formEmail").value = person.email; $("formEmail").readOnly = true;
        $("formPhone").value = person.phone || "";
        $("formRole").innerHTML = ["Manager", "Kitchen Staff", "Cashier", "Rider", "Delivery Staff"].map(role => `<option ${role === person.position ? "selected" : ""}>${role}</option>`).join("");
        $("formShift").value = person.shift === "Not set" ? "" : person.shift;
        $("formAddress").value = person.address || "";
        const statusLabel = $("formStatus")?.closest("label"); if (statusLabel) statusLabel.hidden = true;
        $("staffModal").classList.add("show");
    }
    async function handleAction(action, id) {
        const person = staff.find(item => item.id === id); if (!person) return;
        if (action === "edit") return openEdit(person);
        if (action === "approve" || action === "decline") {
            const decision = action === "approve" ? "approved" : "declined";
            if (!confirm(`${action === "approve" ? "Approve" : "Decline"} ${person.fullName}'s staff account request?`)) return;
            try { const result = await api(`/api/admin/staff/${id}/approval`, { method: "PATCH", body: JSON.stringify({ decision }) }); toast(result.message); await load(); if (staff.some(item => item.id === id)) setDetail(id); }
            catch (error) { toast(error.message); }
            return;
        }
        if (action === "delete" && confirm(`Permanently delete ${person.fullName}'s staff account? This also removes its attendance records and active sessions.`)) {
            try { const result = await api(`/api/admin/staff/${id}`, { method: "DELETE" }); toast(result.message); selectedId = null; await load(); }
            catch (error) { toast(error.message); }
        }
    }
    async function load() {
        try {
            const query = new URLSearchParams({ search: $("staffSearch")?.value.trim() || "", status: activeTab === "all" ? "" : activeTab });
            const result = await api(`/api/admin/staff?${query}`); staff = result.staff || []; counts = result.counts || {};
            const roles = [...new Set(staff.map(person => person.position).filter(Boolean))].sort();
            const roleFilter = $("roleFilter"); const selectedRole = roleFilter?.value || "all";
            if (roleFilter) { roleFilter.innerHTML = '<option value="all">All Roles</option>' + roles.map(role => `<option value="${escape(role)}">${escape(role)}</option>`).join(""); roleFilter.value = roles.includes(selectedRole) ? selectedRole : "all"; }
            renderTable();
            if (selectedId && staff.some(person => person.id === selectedId)) setDetail(selectedId);
            else if (staff.length) selectStaff(staff[0].id);
            else { $("detailName").textContent = "No staff selected"; $("detailEmail").textContent = ""; }
        } catch (error) { $("staffTableBody").innerHTML = `<tr><td colspan="10" class="empty-row">${escape(error.message)}</td></tr>`; toast(error.message); }
    }
    document.addEventListener("DOMContentLoaded", () => {
        const tabContainer = document.querySelector(".staff-toolbar .tabs");
        if (tabContainer) {
            const replacement = fresh(tabContainer);
            replacement.innerHTML = '<button class="tab active" data-status="all" type="button">All Staff</button><button class="tab" data-status="pending" type="button">Pending Approval</button><button class="tab" data-status="approved" type="button">Approved</button><button class="tab" data-status="declined" type="button">Declined</button>';
            replacement.addEventListener("click", event => { const button = event.target.closest(".tab"); if (!button) return; activeTab = button.dataset.status; replacement.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab === button)); load(); });
        }
        ["staffTableBody", "staffSearch", "roleFilter", "statusFilter", "addStaffBtn", "editStaffBtn", "staffForm", "modalClose"].forEach(id => fresh($(id)));
        const statusFilter = $("statusFilter");
        if (statusFilter) statusFilter.innerHTML = '<option value="all">All Status</option><option value="pending">Pending Approval</option><option value="approved">Approved</option><option value="declined">Declined</option>';
        $("staffSearch")?.addEventListener("input", () => { clearTimeout(load.timer); load.timer = setTimeout(load, 250); });
        $("searchBtn")?.addEventListener("click", load);
        $("filterBtn")?.addEventListener("click", load);
        $("roleFilter")?.addEventListener("change", renderTable);
        $("statusFilter")?.addEventListener("change", () => { activeTab = "all"; document.querySelectorAll(".staff-toolbar .tab").forEach(tab => tab.classList.toggle("active", tab.dataset.status === "all")); load(); });
        $("addStaffBtn")?.addEventListener("click", () => { activeTab = "pending"; document.querySelectorAll(".staff-toolbar .tab").forEach(tab => tab.classList.toggle("active", tab.dataset.status === "pending")); load(); });
        $("editStaffBtn")?.addEventListener("click", () => { const person = staff.find(item => item.id === selectedId); if (person) openEdit(person); });
        $("modalClose")?.addEventListener("click", () => { $("staffModal").classList.remove("show"); $("staffForm").reset(); });
        $("staffModal")?.addEventListener("click", event => { if (event.target === $("staffModal")) $("staffModal").classList.remove("show"); });
        $("staffForm")?.addEventListener("submit", async event => {
            event.preventDefault(); const id = selectedId;
            const body = { fullName: $("formName").value.trim(), phone: $("formPhone").value.trim(), position: $("formRole").value, shift: $("formShift").value.trim(), address: $("formAddress").value.trim() };
            try { await api(`/api/admin/staff/${id}`, { method: "PATCH", body: JSON.stringify(body) }); $("staffModal").classList.remove("show"); await load(); toast("Staff information updated."); }
            catch (error) { toast(error.message); }
        });
        $("roleFilter")?.addEventListener("change", renderTable);
        const pager = document.querySelector(".staff-card .pagination .page-buttons"); if (pager) pager.hidden = true;
        const addButton = $("addStaffBtn"); if (addButton) addButton.innerHTML = "<span>⌕</span> Review Requests";
        load();
    });
})();
