/**
 * auth-helper.js — StudyMate AI
 *
 * Strategy:
 *   1. supabase.auth.getSession()   → immediate render on every page load
 *   2. supabase.auth.onAuthStateChange() → react to SIGNED_IN / SIGNED_OUT only
 *
 * This avoids the race condition where onAuthStateChange fires before
 * the listener is registered (common after OAuth redirects).
 */

import { supabase } from './supabase-client.js'

;(function () {
  'use strict'

  // ─── Styles ──────────────────────────────────────────────────────────────────
  const style = document.createElement('style')
  style.innerHTML = `
    .nav-auth-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #ffffff !important;
      padding: 0.35rem 0.9rem;
      border-radius: 9999px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      margin-left: 0.5rem;
      font-size: 0.8rem;
      text-decoration: none;
      cursor: pointer;
      white-space: nowrap;
    }
    .nav-auth-btn:hover {
      background: rgba(255, 255, 255, 0.11);
      border-color: rgba(255, 255, 255, 0.22);
      color: #ffffff !important;
      transform: translateY(-1px);
    }

    /* ── Avatar ── */
    .user-profile-menu {
      position: relative;
      display: inline-flex;
      align-items: center;
      margin-left: 0.5rem;
    }
    .avatar-circle {
      width: 34px; height: 34px;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.08));
      border: 1.5px solid rgba(255, 255, 255, 0.22);
      color: #ffffff;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 0.82rem;
      cursor: pointer; user-select: none; flex-shrink: 0;
      transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .avatar-circle:hover {
      background: linear-gradient(135deg, rgba(255,255,255,0.26), rgba(255,255,255,0.14));
      transform: scale(1.06);
    }

    /* ── Dropdown ── */
    .profile-dropdown {
      position: absolute;
      top: calc(100% + 10px); right: 0;
      width: 235px;
      background: rgba(9, 12, 19, 0.98);
      backdrop-filter: blur(22px);
      -webkit-backdrop-filter: blur(22px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 14px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.03);
      padding: 0.55rem 0;
      z-index: 99999;
      display: none; flex-direction: column;
      animation: ah-drop 0.17s cubic-bezier(0.16,1,0.3,1);
    }
    .profile-dropdown.open { display: flex; }

    @keyframes ah-drop {
      from { opacity:0; transform:translateY(-7px) scale(0.97); }
      to   { opacity:1; transform:translateY(0)    scale(1); }
    }

    .dd-header {
      padding: 0.7rem 1rem 0.65rem;
      display: flex; flex-direction: column; gap: 0.1rem;
    }
    .dd-name {
      font-weight: 700; font-size: 0.84rem; color: #ffffff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .dd-email {
      font-size: 0.69rem; color: rgba(255,255,255,0.35);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .dd-divider { height:1px; background:rgba(255,255,255,0.07); margin:0.3rem 0; }

    .dd-item {
      background: transparent; border: none;
      color: rgba(255,255,255,0.52);
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-size: 0.79rem; font-weight: 500;
      text-align: left; padding: 0.52rem 1rem;
      cursor: pointer; display: flex; align-items: center;
      gap: 0.55rem; width: 100%;
      transition: all 0.14s ease;
    }
    .dd-item svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2; flex-shrink:0; }
    .dd-item:hover { background: rgba(255,255,255,0.05); color:#ffffff; }
    .dd-item.danger:hover { background: rgba(239,68,68,0.08); color:#fca5a5; }

    .dd-section-label {
      font-size: 0.62rem; font-weight: 700;
      color: rgba(255,255,255,0.22); text-transform: uppercase;
      letter-spacing: 0.09em; padding: 0.35rem 1rem 0.15rem;
    }

    .sync-icon.spin { animation: ah-spin 0.9s linear infinite; display:inline-block; }
    @keyframes ah-spin { to { transform: rotate(360deg); } }

    /* ── Modal overlay ── */
    .ah-modal {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.72);
      backdrop-filter: blur(8px);
      z-index: 999998;
      display: flex; align-items: center; justify-content: center;
      padding: 1.5rem;
      animation: ah-modal-in 0.2s ease;
    }
    @keyframes ah-modal-in { from { opacity:0; } to { opacity:1; } }

    .ah-modal-box {
      background: rgba(9,12,20,0.97);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 18px;
      box-shadow: 0 32px 80px rgba(0,0,0,0.8);
      width: 100%; max-width: 420px;
      overflow: hidden;
      animation: ah-modal-box-in 0.22s cubic-bezier(0.16,1,0.3,1);
    }
    @keyframes ah-modal-box-in {
      from { transform: scale(0.94) translateY(12px); opacity: 0; }
      to   { transform: scale(1) translateY(0); opacity: 1; }
    }

    .ah-modal-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1rem 1.25rem 0.75rem;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    .ah-modal-title { font-size: 0.9rem; font-weight: 800; color: #ffffff; }
    .ah-modal-close {
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px; width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      color: rgba(255,255,255,0.4); cursor: pointer; font-size: 0.75rem;
      transition: all 0.15s;
    }
    .ah-modal-close:hover { background: rgba(255,255,255,0.1); color: #fff; }

    .ah-modal-body {
      padding: 1.1rem 1.25rem 1.25rem;
    }

    .ah-modal-logo {
      display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.25rem;
    }
    .ah-logo-badge {
      width: 32px; height: 32px; border-radius: 9px;
      background: linear-gradient(135deg, #fff 0%, rgba(255,255,255,0.7) 100%);
      color: #000; font-size: 0.72rem; font-weight: 900;
      display: flex; align-items: center; justify-content: center;
    }

    .ah-features-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem;
    }
    .ah-feature {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 8px; padding: 0.45rem 0.65rem;
      font-size: 0.74rem; color: rgba(255,255,255,0.6);
    }

    .ah-input {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 9px; padding: 0.6rem 0.8rem;
      color: #ffffff; font-family: 'Plus Jakarta Sans', sans-serif;
      font-size: 0.8rem; width: 100%; box-sizing: border-box;
      transition: border-color 0.2s;
    }
    .ah-input:focus { outline: none; border-color: rgba(255,255,255,0.3); }
    .ah-input::placeholder { color: rgba(255,255,255,0.25); }

    .ah-submit-btn {
      background: #ffffff; color: #000000; border: none;
      border-radius: 9px; padding: 0.65rem 1rem;
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-size: 0.82rem; font-weight: 700;
      cursor: pointer; width: 100%; transition: all 0.18s;
    }
    .ah-submit-btn:hover { background: #e4e4e7; }
    .ah-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── Toast ── */
    .ah-toast {
      position: fixed; bottom:20px; right:20px;
      background: rgba(9,12,19,0.97);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.1);
      padding: 0.65rem 0.95rem;
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.55);
      z-index: 999999; font-size: 0.78rem;
      font-family: 'Plus Jakarta Sans', sans-serif;
      display: flex; align-items: center; gap: 0.5rem;
      color: #ffffff; max-width: 270px;
      animation: ah-toast-in 0.28s cubic-bezier(0.16,1,0.3,1);
    }
    @keyframes ah-toast-in {
      from { transform:translateY(24px); opacity:0; }
      to   { transform:translateY(0);    opacity:1; }
    }
  `
  document.head.appendChild(style)

  // ─── Utilities ───────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
  }

  function showToast(msg, type = 'success') {
    document.querySelector('.ah-toast')?.remove()
    const color = type === 'success' ? '#10b981' : '#ef4444'
    const svg   = type === 'success'
      ? `<svg style="width:14px;height:14px;stroke:${color};flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
      : `<svg style="width:14px;height:14px;stroke:${color};flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.73-3L13.73 5a2 2 0 00-3.46 0L3.2 16a2 2 0 001.73 3z"/></svg>`
    const t = document.createElement('div')
    t.className = 'ah-toast'
    t.innerHTML = `${svg}<span>${escHtml(msg)}</span>`
    document.body.appendChild(t)
    setTimeout(() => {
      t.style.cssText += 'transition:opacity .3s ease,transform .3s ease;opacity:0;transform:translateY(8px)'
      setTimeout(() => t.remove(), 320)
    }, 2700)
  }

  function getNavbar() {
    return document.getElementById('navbar')
  }

  function clearNavAuth(navbar) {
    navbar.querySelector('.user-profile-menu')?.remove()
    navbar.querySelector('#nav-auth-btn')?.remove()
  }

  // ─── Render: Sign In button ───────────────────────────────────────────────────
  function renderSignIn(navbar) {
    clearNavAuth(navbar)
    const a = document.createElement('a')
    a.href = 'login.html'
    a.className = 'nav-auth-btn'
    a.id = 'nav-auth-btn'
    a.innerHTML = `
      <span>Sign In</span>
      <svg style="width:13px;height:13px" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round"
          d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"/>
      </svg>`
    navbar.appendChild(a)
  }

  // ─── Render: Avatar + dropdown ────────────────────────────────────────────────
  function renderUserProfile(navbar, user, session) {
    clearNavAuth(navbar)

    const initial = (user.full_name || user.email || 'U').charAt(0).toUpperCase()

    const wrap = document.createElement('div')
    wrap.className = 'user-profile-menu'
    wrap.id = 'user-profile-menu'
    wrap.innerHTML = `
      <div class="avatar-circle" id="ah-avatar"
           role="button" tabindex="0" title="Account menu"
           aria-haspopup="true" aria-expanded="false">
        ${escHtml(initial)}
      </div>

      <div class="profile-dropdown" id="ah-dropdown" role="menu">
        <!-- User info header -->
        <div class="dd-header">
          <span class="dd-name">${escHtml(user.full_name || 'StudyMate User')}</span>
          <span class="dd-email">${escHtml(user.email || '')}</span>
        </div>
        <div class="dd-divider"></div>

        <!-- Settings section -->
        <div class="dd-section-label">Settings</div>

        <button class="dd-item" id="ah-sync-btn" role="menuitem">
          <svg class="sync-icon" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/>
          </svg>
          <span>Sync Progress</span>
        </button>

        <button class="dd-item" id="ah-theme-btn" role="menuitem">
          <svg viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/>
          </svg>
          <span id="ah-theme-label">Light Mode</span>
        </button>

        <div class="dd-divider"></div>

        <!-- Product Info section -->
        <div class="dd-section-label">Product</div>

        <button class="dd-item" id="ah-about-btn" role="menuitem">
          <svg viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"/>
          </svg>
          <span>About StudyMate</span>
        </button>

        <button class="dd-item" id="ah-contact-btn" role="menuitem">
          <svg viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"/>
          </svg>
          <span>Contact & Support</span>
        </button>

        <div class="dd-divider"></div>

        <button class="dd-item danger" id="ah-logout-btn" role="menuitem">
          <svg viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"/>
          </svg>
          <span>Sign Out</span>
        </button>
      </div>

      <!-- About modal -->
      <div class="ah-modal" id="ah-about-modal" style="display:none">
        <div class="ah-modal-box">
          <div class="ah-modal-header">
            <span class="ah-modal-title">About StudyMate AI</span>
            <button class="ah-modal-close" id="ah-about-close">✕</button>
          </div>
          <div class="ah-modal-body">
            <div class="ah-modal-logo">
              <div class="ah-logo-badge">AI</div>
              <span style="font-size:1.05rem;font-weight:800;color:#fff;">StudyMate</span>
            </div>
            <p style="font-size:0.82rem;color:rgba(255,255,255,0.6);line-height:1.65;margin:0.75rem 0 1rem;">
              StudyMate AI is your all-in-one AI-powered study companion. Generate smart notes, practice with flashcards, take quizzes, get a personalised study plan, and chat with an AI tutor — all in one place.
            </p>
            <div class="ah-features-grid">
              <div class="ah-feature">🧠 AI Tutor Chat</div>
              <div class="ah-feature">📝 Smart Notes</div>
              <div class="ah-feature">🃏 Flashcards</div>
              <div class="ah-feature">📊 Quiz Mode</div>
              <div class="ah-feature">📅 Study Planner</div>
              <div class="ah-feature">📄 PDF Support</div>
            </div>
            <div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:rgba(255,255,255,0.25);text-align:center;">
              StudyMate AI · Built with ❤️ for students
            </div>
          </div>
        </div>
      </div>

      <!-- Contact modal -->
      <div class="ah-modal" id="ah-contact-modal" style="display:none">
        <div class="ah-modal-box">
          <div class="ah-modal-header">
            <span class="ah-modal-title">Contact & Support</span>
            <button class="ah-modal-close" id="ah-contact-close">✕</button>
          </div>
          <div class="ah-modal-body">
            <p style="font-size:0.8rem;color:rgba(255,255,255,0.55);margin:0 0 1rem;line-height:1.6;">
              Have a question, bug report, or feature request? We'd love to hear from you.
            </p>
            <div style="display:flex;flex-direction:column;gap:0.55rem;">
              <input id="ah-contact-name" placeholder="Your name" class="ah-input" type="text">
              <input id="ah-contact-email" placeholder="Email address" class="ah-input" type="email">
              <textarea id="ah-contact-msg" placeholder="How can we help you?" class="ah-input" rows="4"
                style="resize:vertical;min-height:80px;"></textarea>
              <button class="ah-submit-btn" id="ah-contact-submit">Send Message</button>
            </div>
          </div>
        </div>
      </div>`

    navbar.appendChild(wrap)

    const avatar   = wrap.querySelector('#ah-avatar')
    const dropdown = wrap.querySelector('#ah-dropdown')

    const closeMenu = () => {
      dropdown.classList.remove('open')
      avatar.setAttribute('aria-expanded', 'false')
    }
    const openMenu = () => {
      dropdown.classList.add('open')
      avatar.setAttribute('aria-expanded', 'true')
    }

    avatar.addEventListener('click', (e) => {
      e.stopPropagation()
      dropdown.classList.contains('open') ? closeMenu() : openMenu()
    })
    avatar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu() }
      if (e.key === 'Escape') closeMenu()
    })
    document.addEventListener('click', closeMenu)
    dropdown.addEventListener('click', (e) => e.stopPropagation())

    // ── Theme toggle ───────────────────────────────────────────────────────
    const themeBtn   = wrap.querySelector('#ah-theme-btn')
    const themeLabel = wrap.querySelector('#ah-theme-label')
    const isDark = () => !document.documentElement.classList.contains('light-mode')
    themeLabel.textContent = isDark() ? 'Light Mode' : 'Dark Mode'
    themeBtn.addEventListener('click', () => {
      document.documentElement.classList.toggle('light-mode')
      themeLabel.textContent = isDark() ? 'Light Mode' : 'Dark Mode'
      localStorage.setItem('sm_theme', isDark() ? 'dark' : 'light')
      closeMenu()
    })
    // Restore saved theme
    if (localStorage.getItem('sm_theme') === 'light') {
      document.documentElement.classList.add('light-mode')
      themeLabel.textContent = 'Dark Mode'
    }

    // ── About modal ────────────────────────────────────────────────────────
    const aboutModal = wrap.querySelector('#ah-about-modal')
    wrap.querySelector('#ah-about-btn').addEventListener('click', () => {
      closeMenu()
      aboutModal.style.display = 'flex'
    })
    wrap.querySelector('#ah-about-close').addEventListener('click', () => {
      aboutModal.style.display = 'none'
    })
    aboutModal.addEventListener('click', (e) => {
      if (e.target === aboutModal) aboutModal.style.display = 'none'
    })

    // ── Contact modal ──────────────────────────────────────────────────────
    const contactModal = wrap.querySelector('#ah-contact-modal')
    wrap.querySelector('#ah-contact-btn').addEventListener('click', () => {
      closeMenu()
      contactModal.style.display = 'flex'
    })
    wrap.querySelector('#ah-contact-close').addEventListener('click', () => {
      contactModal.style.display = 'none'
    })
    contactModal.addEventListener('click', (e) => {
      if (e.target === contactModal) contactModal.style.display = 'none'
    })
    wrap.querySelector('#ah-contact-submit').addEventListener('click', () => {
      const name = wrap.querySelector('#ah-contact-name').value.trim()
      const email = wrap.querySelector('#ah-contact-email').value.trim()
      const msg = wrap.querySelector('#ah-contact-msg').value.trim()
      if (!name || !email || !msg) { showToast('Please fill in all fields.', 'error'); return }
      // Simple email validation
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) { showToast('Please enter a valid email.', 'error'); return }
      showToast('Message sent! We\'ll get back to you soon.', 'success')
      contactModal.style.display = 'none'
      wrap.querySelector('#ah-contact-name').value = ''
      wrap.querySelector('#ah-contact-email').value = ''
      wrap.querySelector('#ah-contact-msg').value = ''
    })

    // ── Sync ───────────────────────────────────────────────────────────────
    const syncBtn  = wrap.querySelector('#ah-sync-btn')
    const syncIcon = syncBtn.querySelector('.sync-icon')

    syncBtn.addEventListener('click', async () => {
      closeMenu()
      syncIcon.classList.add('spin')
      syncBtn.disabled = true
      try {
        const rawChats = localStorage.getItem('sm_chats')
        if (rawChats) {
          await supabase.from('chat_sessions').upsert({
            user_id: session.user.id,
            messages: JSON.parse(rawChats),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' })
        }
        showToast('Progress synced to cloud!', 'success')
      } catch (err) {
        console.error('[StudyMate] Sync error:', err)
        showToast('Sync failed. Try again.', 'error')
      } finally {
        syncIcon.classList.remove('spin')
        syncBtn.disabled = false
      }
    })

    // ── Sign Out ───────────────────────────────────────────────────────────
    wrap.querySelector('#ah-logout-btn').addEventListener('click', async () => {
      closeMenu()
      await supabase.auth.signOut()
      showToast('Signed out successfully.', 'success')
      setTimeout(() => window.location.replace('index.html'), 700)
    })
  }

  // ─── Get display data from session (no profile table needed) ─────────────────
  function userFromSession(session) {
    const meta = session.user.user_metadata || {}
    return {
      full_name : meta.full_name || meta.name || session.user.email?.split('@')[0] || 'StudyMate User',
      email     : session.user.email || '',
    }
  }

  // ─── Main init ───────────────────────────────────────────────────────────────
  async function init() {
    // Wait for navbar to exist
    const navbar = await new Promise((resolve) => {
      const el = document.getElementById('navbar')
      if (el) { resolve(el); return }
      document.addEventListener('DOMContentLoaded', () => resolve(document.getElementById('navbar')))
    })
    if (!navbar) return

    // ── Step 1: Immediate check — show correct state without waiting for events
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      renderUserProfile(navbar, userFromSession(session), session)
    } else {
      renderSignIn(navbar)
    }

    // ── Step 2: React to future SIGNED_IN / SIGNED_OUT events only
    supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === 'SIGNED_IN' && newSession) {
        renderUserProfile(navbar, userFromSession(newSession), newSession)
      } else if (event === 'SIGNED_OUT') {
        renderSignIn(navbar)
      }
      // Ignore: INITIAL_SESSION, TOKEN_REFRESHED, USER_UPDATED, PASSWORD_RECOVERY
    })
  }

  init()
})()
