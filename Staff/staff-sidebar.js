(() => {
    const currentPage = location.pathname.split("/").pop().toLowerCase();
    document.querySelectorAll(".sidebar-nav a.nav-item[href]").forEach(link => {
        const target = link.getAttribute("href").split("?")[0].split("#")[0].toLowerCase();
        const isCurrent = target === currentPage;
        link.classList.toggle("active", isCurrent);
        if (isCurrent) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });
})();
