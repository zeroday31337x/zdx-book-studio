document.addEventListener("DOMContentLoaded", async () => {
  const button = document.querySelector('a[href="/api/auth/oidc/start"]');
  if (!button) return;
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    if (response.ok) window.location.replace("/index.html");
  } catch { /* Keep the Cognito sign-in action available if the session check fails. */ }
});
