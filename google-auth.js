(() => {
    const buttonHost = document.getElementById("googleSignInButton");
    if (!buttonHost) return;

    const status = document.getElementById("googleAuthStatus");
    const isSignup = window.location.pathname.toLowerCase().endsWith("signup.html");
    const message = document.getElementById(isSignup ? "errorMessage" : "message");
    let authNonce = "";

    function showStatus(text, isError = false) {
        if (message) {
            message.textContent = text;
            message.style.display = "block";
            message.setAttribute("role", "status");
        } else if (status) {
            status.textContent = text;
            status.style.color = isError ? "#b00020" : "#555";
        }
    }

    function saveCustomerSession(result, remember) {
        const storage = remember ? window.localStorage : window.sessionStorage;
        ["loggedInUser", "currentUser", "user", "token", "authToken"].forEach(key => {
            window.localStorage.removeItem(key);
            window.sessionStorage.removeItem(key);
        });
        storage.setItem("loggedInUser", JSON.stringify({
            id: result.user.id,
            fullName: result.user.fullName,
            email: result.user.email,
            role: result.user.role,
            sessionToken: result.sessionToken
        }));
    }

    async function handleGoogleCredential(response) {
        const activeRole = document.querySelector(".role-card.active")?.dataset.role || "customer";
        if (activeRole.toLowerCase() !== "customer") {
            showStatus("Google sign-in is available for customer accounts only.", true);
            return;
        }

        const remember = !isSignup && Boolean(document.getElementById("remember")?.checked);
        buttonHost.style.pointerEvents = "none";
        showStatus("Signing in with Google…");

        try {
            const apiResponse = await fetch("/api/auth/google", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    credential: response.credential,
                    nonce: authNonce,
                    remember
                })
            });
            const result = await apiResponse.json();
            if (!apiResponse.ok || !result.success || !result.sessionToken || !result.user) {
                throw new Error(result.message || "Google sign-in failed.");
            }

            if (!isSignup) {
                if (remember) window.localStorage.setItem("rememberedLoginEmail", result.user.email);
                else window.localStorage.removeItem("rememberedLoginEmail");
            }
            saveCustomerSession(result, remember);
            showStatus("Google sign-in successful. Redirecting…");
            window.location.assign("Customer/home.html");
        } catch (error) {
            console.error("Google sign-in failed:", error);
            showStatus(error.message || "Unable to sign in with Google. Please try again.", true);
        } finally {
            buttonHost.style.pointerEvents = "";
        }
    }

    async function startGoogleSignIn() {
        try {
            const response = await fetch("/api/config/google-auth", { cache: "no-store" });
            const config = await response.json();
            if (!response.ok || !config.enabled || !config.clientId) {
                buttonHost.textContent = "Google sign-in is not configured yet";
                buttonHost.setAttribute("aria-disabled", "true");
                buttonHost.style.cursor = "not-allowed";
                showStatus("Add your Google Web client ID to backend/.env to enable this option.", true);
                return;
            }

            await new Promise((resolve, reject) => {
                if (window.google?.accounts?.id) return resolve();
                const script = document.createElement("script");
                script.src = "https://accounts.google.com/gsi/client?hl=en";
                script.async = true;
                script.onload = resolve;
                script.onerror = () => reject(new Error("Google sign-in could not load. Check your internet connection."));
                document.head.appendChild(script);
            });

            const nonceResponse = await fetch("/api/auth/google/nonce", { cache: "no-store" });
            const nonceResult = await nonceResponse.json();
            if (!nonceResponse.ok || !nonceResult.success || !nonceResult.nonce) {
                throw new Error("Google sign-in could not be started. Please refresh and try again.");
            }
            authNonce = nonceResult.nonce;
            window.google.accounts.id.initialize({
                client_id: config.clientId,
                nonce: authNonce,
                callback: handleGoogleCredential,
                auto_select: false
            });
            window.google.accounts.id.renderButton(buttonHost, {
                type: "standard",
                theme: "outline",
                size: "large",
                text: isSignup ? "signup_with" : "continue_with",
                shape: "rect",
                width: Math.max(220, Math.floor(buttonHost.getBoundingClientRect().width))
            });
        } catch (error) {
            console.error("Could not initialize Google sign-in:", error);
            showStatus(error.message || "Google sign-in could not be initialized.", true);
        }
    }

    startGoogleSignIn();
})();
