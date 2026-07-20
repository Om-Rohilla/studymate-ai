/**
 * auth-helper.js
 *
 * Injected into every page via <script src="auth-helper.js">.
 * Responsibilities:
 *   1. Validate the stored JWT locally (check expiry without a network call).
 *   2. If valid, fetch the user profile (from localStorage cache first).
 *   3. Render either a "Sign In" button or an authenticated user avatar + dropdown.
 *   4. Provide Sync Progress and Sign Out actions.
 *
 * Security notes:
 *   - JWT is NOT verified cryptographically client-side (impossible without the secret).
 *     Local expiry check only guards against obviously expired tokens to avoid
 *     unnecessary API calls. The server always performs full verification.
 *   - Password hash and oauth_provider are never stored in localStorage.
 *   - On sign-out all auth-related localStorage keys are cleared.
 */

(function () {
  "use strict";

  const API_BASE = "http://127.0.0.1:8000/api";

  // ── Injected styles ──────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.innerHTML = `
    .nav-auth-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #ffffff !important;
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      margin-left: 0.5rem;
      font-size: 0.8rem;
    }
    .nav-auth-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.25);
      color: #ffffff !important;
      transform: translateY(-1px);
    }

    /* Profile menu */
    .user-profile-menu {
      position: relative;
      display: inline-block;
      margin-left: 1rem;
    }
    .avatar-circle {
      width: 38px; height: 38px;
      border-radius: 50%;
      background: var(--primary-gradient);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 1.05rem;
      border: 2px solid var(--border-color);
      transition: var(--transition);
      cursor: pointer;
      user-select: none;
    }
    .avatar-circle:hover {
      border-color: var(--primary);
      transform: scale(1.05);
    }

    /* Dropdown */
    .profile-dropdown {
      position: absolute;
      top: calc(100% + 10px);
      right: 0;
      width: 245px;
      background: rgba(18,24,41,0.97);
      backdrop-filter: var(--glass-blur);
      -webkit-backdrop-filter: var(--glass-blur);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      box-shadow: var(--card-shadow);
      padding: 0.75rem 0;
      z-index: 1000;
      display: none;
      flex-direction: column;
      animation: dropIn 0.2s ease-out;
    }
    .profile-dropdown.open { display: flex; }
    @keyframes dropIn {
      from { opacity:0; transform:translateY(-6px); }
      to   { opacity:1; transform:translateY(0); }
    }

    .dd-header {
      padding: 0.5rem 1.25rem 0.75rem;
      display: flex; flex-direction: column;
    }
    .dd-name  { font-weight: 700; font-size: 0.95rem; color: var(--text-primary); }
    .dd-email { font-size: 0.78rem; color: var(--text-secondary); word-break: break-all; }
    .dd-divider { height:1px; background: rgba(255,255,255,0.07); margin: 0.4rem 0; }

    .dd-item {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-family: inherit;
      font-size: 0.9rem;
      text-align: left;
      padding: 0.65rem 1.25rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
      transition: var(--transition);
    }
    .dd-item svg {
      width: 18px; height: 18px;
      fill: none; stroke: currentColor;
      stroke-width: 2;
      flex-shrink: 0;
    }
    .dd-item:hover { background: rgba(255,255,255,0.04); color: var(--text-primary); }
    .dd-item.danger:hover { background: rgba(239,68,68,0.08); color: #f87171; }

    .sync-icon.spin { animation: spinIt 1s linear infinite; }
    @keyframes spinIt { to { transform: rotate(360deg); } }

    /* Toast */
    .ah-toast {
      position: fixed;
      bottom: 22px; right: 22px;
      background: rgba(18,24,41,0.95);
      backdrop-filter: var(--glass-blur);
      border: 1px solid var(--border-color);
      padding: 0.8rem 1.2rem;
      border-radius: 10px;
      box-shadow: var(--card-shadow);
      z-index: 10000;
      font-size: 0.875rem;
      display: flex;
      align-items: center;
      gap: 0.6rem;
      animation: toastIn 0.3s ease-out;
    }
    @keyframes toastIn {
      from { transform:translateY(40px); opacity:0; }
      to   { transform:translateY(0);    opacity:1; }
    }
  `;
  document.head.appendChild(style);

  // ── JWT local expiry check ───────────────────────────────────────────────────
  function isTokenLocallyValid(token) {
    if (!token) return false;
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      return payload.exp && payload.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  }

  // ── Main auth initialiser ────────────────────────────────────────────────────
  async function initAuth() {
    const navbar = document.getElementById("navbar");
    if (!navbar) return;

    const token = localStorage.getItem("sm_auth_token");

    // Fast-path: token is missing or locally expired — clear and show Sign In
    if (!isTokenLocallyValid(token)) {
      localStorage.removeItem("sm_auth_token");
      localStorage.removeItem("sm_user");
      renderSignIn(navbar);
      return;
    }

    // Try localStorage cache first to avoid a network round-trip
    let user = null;
    try {
      const cached = localStorage.getItem("sm_user");
      user = cached ? JSON.parse(cached) : null;
    } catch {
      user = null;
    }

    // If no cache, verify with the server
    if (!user) {
      try {
        const res = await fetch(`${API_BASE}/auth/me`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (res.ok) {
          user = await res.json();
          localStorage.setItem("sm_user", JSON.stringify(user));
        } else {
          // Server rejected the token — clean up
          localStorage.removeItem("sm_auth_token");
          localStorage.removeItem("sm_user");
        }
      } catch {
        // Network error — show cached state if possible, otherwise Sign In
      }
    }

    if (user) {
      renderUserProfile(navbar, user, token);
    } else {
      renderSignIn(navbar);
    }
  }

  // ── Render: Sign In button ───────────────────────────────────────────────────
  function renderSignIn(navbar) {
    const btn = document.createElement("a");
    btn.href = "login.html";
    btn.className = "nav-auth-btn";
    btn.id = "nav-auth-btn";
    btn.innerHTML = `
      <span>Sign In</span>
      <svg style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round"
          d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"/>
      </svg>
    `;
    navbar.appendChild(btn);
  }

  // ── Render: User profile dropdown ────────────────────────────────────────────
  function renderUserProfile(navbar, user, token) {
    const initial = user.full_name ? user.full_name.charAt(0).toUpperCase() : "U";

    const wrap = document.createElement("div");
    wrap.className = "user-profile-menu";
    wrap.id = "user-profile-menu";
    wrap.innerHTML = `
      <div class="avatar-circle" id="ah-avatar" role="button" tabindex="0"
           aria-label="User menu" aria-haspopup="true" aria-expanded="false">
        ${initial}
      </div>
      <div class="profile-dropdown" id="ah-dropdown" role="menu">
        <div class="dd-header">
          <span class="dd-name">${escHtml(user.full_name || "StudyMate User")}</span>
          <span class="dd-email">${escHtml(user.email || "")}</span>
        </div>
        <div class="dd-divider"></div>
        <button class="dd-item" id="ah-sync-btn" role="menuitem">
          <svg class="sync-icon" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
          </svg>
          <span>Sync Progress</span>
        </button>
        <button class="dd-item danger" id="ah-logout-btn" role="menuitem">
          <svg viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"/>
          </svg>
          <span>Sign Out</span>
        </button>
      </div>
    `;

    navbar.appendChild(wrap);

    const avatar   = wrap.querySelector("#ah-avatar");
    const dropdown = wrap.querySelector("#ah-dropdown");

    // Toggle dropdown
    function toggleDropdown() {
      const isOpen = dropdown.classList.toggle("open");
      avatar.setAttribute("aria-expanded", String(isOpen));
    }
    avatar.addEventListener("click", (e) => { e.stopPropagation(); toggleDropdown(); });
    avatar.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDropdown(); } });
    document.addEventListener("click", () => {
      dropdown.classList.remove("open");
      avatar.setAttribute("aria-expanded", "false");
    });

    // Sync
    const syncBtn  = wrap.querySelector("#ah-sync-btn");
    const syncIcon = syncBtn.querySelector(".sync-icon");
    syncBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      syncIcon.classList.add("spin");
      syncBtn.disabled = true;

      const payload = {
        chats:          localStorage.getItem("sm_chats"),
        notes:          localStorage.getItem("sm_notes"),
        quiz_highscore: localStorage.getItem("sm_quiz_highscore"),
        cards:          localStorage.getItem("sm_cards"),
        planner_plan:   localStorage.getItem("sm_planner_plan"),
        tickets:        localStorage.getItem("sm_tickets"),
      };

      // Strip null values
      Object.keys(payload).forEach(k => { if (!payload[k]) delete payload[k]; });

      try {
        const res = await fetch(`${API_BASE}/auth/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          showToast("Study progress synced to cloud!", "success");
        } else {
          showToast("Sync failed. Please try again.", "error");
        }
      } catch {
        showToast("Network error. Sync failed.", "error");
      } finally {
        syncIcon.classList.remove("spin");
        syncBtn.disabled = false;
      }
    });

    // Logout
    wrap.querySelector("#ah-logout-btn").addEventListener("click", () => {
      localStorage.removeItem("sm_auth_token");
      localStorage.removeItem("sm_user");
      showToast("Signed out successfully.", "success");
      setTimeout(() => { window.location.replace("index.html"); }, 800);
    });
  }

  // ── Toast ────────────────────────────────────────────────────────────────────
  function showToast(message, type) {
    const existing = document.querySelector(".ah-toast");
    if (existing) existing.remove();

    const color = type === "success" ? "var(--success)" : "var(--danger)";
    const icon  = type === "success"
      ? `<svg style="width:18px;height:18px;stroke:${color}" viewBox="0 0 24 24" fill="none" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
      : `<svg style="width:18px;height:18px;stroke:${color}" viewBox="0 0 24 24" fill="none" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.73-3L13.73 5a2 2 0 00-3.46 0L3.2 16a2 2 0 001.73 3z"/></svg>`;

    const toast = document.createElement("div");
    toast.className = "ah-toast";
    toast.innerHTML = `${icon}<span style="color:var(--text-primary)">${escHtml(message)}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = "opacity 0.45s ease";
      toast.style.opacity    = "0";
      setTimeout(() => toast.remove(), 480);
    }, 3000);
  }

  // ── XSS guard ────────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAuth);
  } else {
    initAuth();
  }
})();
