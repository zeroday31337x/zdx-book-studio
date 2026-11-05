document.addEventListener("DOMContentLoaded", async () => {
  const message = document.getElementById("loginMessage");
  try {
    const response = await fetch("/api/auth/me", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    if (response.ok) {
      window.location.replace("/index.html");
      return;
    }
  } catch {
    // If the session check fails, continue to Cognito sign-in.
  }
  if (message) message.textContent = "Redirecting to secure ZeroDriveX sign-in…";
  window.location.replace("/api/auth/oidc/start");
});
