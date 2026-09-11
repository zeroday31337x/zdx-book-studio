const $ = id => document.getElementById(id);
let temporaryPassword = "";

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `${response.status} ${response.statusText}`);
  return body;
}

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  message("Signing in…");
  const email = $("email").value.trim();
  const password = $("password").value;
  try {
    const result = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    if (result.user?.mustChangePassword) {
      temporaryPassword = password;
      $("loginForm").hidden = true;
      $("changeForm").hidden = false;
      message("Temporary credentials accepted. Choose a permanent password.");
      return;
    }
    location.replace("/");
  } catch (error) { message(error.message, true); }
});

$("changeForm").addEventListener("submit", async event => {
  event.preventDefault();
  const next = $("newPassword").value;
  const confirm = $("confirmPassword").value;
  if (next !== confirm) return message("Passwords do not match.", true);
  if (next.length < 14) return message("Use at least 14 characters.", true);
  try {
    await request("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: temporaryPassword, newPassword: next }) });
    const email = $("email").value.trim();
    temporaryPassword = "";
    await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: next }) });
    location.replace("/");
  } catch (error) { message(error.message, true); }
});

function message(text, isError = false) {
  const el = $("loginMessage");
  el.textContent = text || "";
  el.className = `login-message ${isError ? "error" : ""}`;
}

request("/api/auth/me").then(() => location.replace("/")).catch(() => {});
