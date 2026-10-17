(() => {
    const gcash = document.getElementById("gcashPaymentMethod");
    const notice = document.getElementById("gcashUnavailable");
    if (!gcash || !notice) return;

    const apiBase = ["3000", "5500"].includes(window.location.port)
        ? "http://localhost:5000"
        : "";

    fetch(`${apiBase}/api/config/payment-methods`, { cache: "no-store" })
        .then(response => response.ok ? response.json() : null)
        .then(config => {
            if (!config || config.gcashEnabled !== false) return;
            gcash.disabled = true;
            gcash.closest(".payment-option")?.classList.add("gcash-disabled");
            notice.hidden = false;
            if (gcash.checked) {
                gcash.checked = false;
                const cash = document.querySelector('input[name="paymentMethod"][value="Cash on Delivery"]');
                if (cash) cash.checked = true;
            }
        })
        .catch(error => console.warn("GCash availability could not be checked.", error));
})();
