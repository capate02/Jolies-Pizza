(() => {
    function readProfile() {
        try {
            const profile = JSON.parse(localStorage.getItem("joliesStaffProfile") || "{}");
            let account = null;
            for (const storage of [window.localStorage, window.sessionStorage]) {
                for (const key of ["loggedInUser", "currentUser", "user"]) {
                    try {
                        const candidate = JSON.parse(storage.getItem(key) || "null");
                        if (candidate && String(candidate.role || "").toLowerCase() === "staff") {
                            account = candidate;
                            break;
                        }
                    } catch { /* Ignore unrelated or invalid session values. */ }
                }
                if (account) break;
            }
            return {
                ...profile,
                name: account?.fullName || account?.full_name || account?.name || account?.email || profile.name || "Staff",
                role: profile.role || "Kitchen Staff"
            };
        } catch {
            return {};
        }
    }

    function syncSidebarProfile() {
        const profile = readProfile();
        const name = String(profile.name || "Mark Santos").trim();
        const role = String(profile.role || "Kitchen Staff").trim();
        document.querySelectorAll(".staff-profile").forEach(card => {
            const info = card.querySelector(".staff-info");
            if (!info) return;
            const nameNode = info.querySelector("strong");
            const roleNode = info.querySelector("span:not(.online-status)");
            if (nameNode) nameNode.textContent = name;
            if (roleNode) roleNode.textContent = role;
            const avatar = card.querySelector(".staff-avatar");
            if (avatar) avatar.innerHTML = profile.avatar
                ? `<img src="${String(profile.avatar).replace(/[&<>\"]/g, "")}" alt="">`
                : "👨🏻‍🍳";
            if (!card.querySelector(".staff-profile-edit")) {
                const edit = document.createElement("a");
                edit.className = "staff-profile-edit";
                edit.href = "profile.html?edit=personal";
                edit.setAttribute("aria-label", "Edit kitchen staff details");
                edit.title = "Edit staff details";
                edit.innerHTML = '<i class="fa-solid fa-pen"></i>';
                card.append(edit);
            }
        });
    }

    syncSidebarProfile();
    window.addEventListener("storage", event => {
        if (event.key === "joliesStaffProfile") syncSidebarProfile();
    });
})();
