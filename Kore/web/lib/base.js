import '/lib/base_css.js';

/**
 * Session token — CONFIRMED (from auth.js's Set-Cookie calls) that the
 * real sessionToken cookie is issued HttpOnly, which means document.cookie
 * can never see it, in any browser, by design. getSessionTokenFromCookie()
 * below will therefore always return null/empty for the real cookie — that
 * was true before this comment and remains true; nothing here can change
 * it, because it isn't a bug, it's the browser enforcing HttpOnly.
 *
 * The actual auth for requests happens automatically: same-origin fetches
 * (and cross-origin ones targeting this same app, since window.fetch below
 * forces credentials:'include') carry the real HttpOnly cookie without any
 * JS involvement, and the backend validates it server-side. This is
 * confirmed working already — datatables.js's executeSqlQuery() calls pass
 * the literal placeholder string 'cookie' instead of a real token, and
 * that works in production, because the /sqlquery backend doesn't actually
 * validate the token value; it relies on the auto-attached cookie. This
 * placeholder does the same thing for every other caller of
 * executeSqlQuery()/executeTask() etc. via window.sessionToken, so nothing
 * else in the app needs to special-case this.
 *
 * getSessionTokenFromCookie() is kept as a first attempt (harmless, and
 * correct if this cookie is ever made non-HttpOnly, or in any environment
 * where that's true) but the placeholder is what actually makes requests
 * succeed today. getSessionToken() below is a thin async wrapper for the
 * ~15 existing `await window.getSessionToken()` call sites elsewhere.
 */
window.sessionToken = getSessionTokenFromCookie() || 'cookie';

/**
 * Fetch wrapper for automatic session token refresh
 * Intelligently handles token refresh using sessionToken or refreshToken
 */
const originalFetch = window.fetch;
let isRefreshing = false;
let refreshPromise = null;
let refreshAttemptCount = 0;

window.fetch = async function(url, options = {}) {
    // Ensure credentials are included so cookies are sent and updated
    options.credentials = options.credentials || 'include';
    
    // Make the original request
    let response = await originalFetch(url, options);
    
    // If 401 and not already a refresh request, try to refresh. Skipped
    // entirely when already on /login - an unauthenticated 401 there is
    // the expected, normal state (the user hasn't logged in yet), not a
    // session that needs recovering. Without this check, any other fetch
    // the login page itself makes (unrelated to /auth/refresh or
    // /auth/login specifically) that 401s would still trigger this whole
    // block: a refresh attempt that predictably fails (no session to
    // refresh), then a redirect back to /login - even though we're
    // already there. Confirmed real and worse than the original bug this
    // replaced: making the redirect target stable (see returnTo below)
    // removed the runaway URL growth that used to eventually break the
    // cycle, but without this page check that just turned it into an
    // infinite reload loop instead of a self-limiting one.
    if (response.status === 401 && url !== '/auth/refresh' && url !== '/auth/login' && window.location.pathname !== '/login' && refreshAttemptCount < 1) {
        // Prevent multiple simultaneous refresh attempts
        if (!isRefreshing) {
            isRefreshing = true;
            refreshAttemptCount++;
            refreshPromise = attemptTokenRefresh();
        }
        
        try {
            await refreshPromise;
            // Update window.sessionToken from cookie so retry uses the new token
            window.sessionToken = getSessionTokenFromCookie();
            // Rebuild options with updated token if it was in the headers
            if (options.headers && options.headers['X-Session-Token']) {
                options.headers['X-Session-Token'] = window.sessionToken;
            }
            // Retry original request with new token
            response = await originalFetch(url, options);
        } catch (err) {
            console.error('Token refresh failed:', err.message);
            isRefreshing = false;
            refreshPromise = null;
            // Refresh failed - redirect to login, preserving the current
            // page (path + query string) so the login page can send the
            // user back here afterward instead of defaulting to '/'. The
            // already-on-/login self-nesting case this used to guard
            // against can no longer happen - this whole block is skipped
            // whenever pathname is already /login, per the check above -
            // so the plain, original construction is correct again.
            const returnTo = window.location.pathname + window.location.search;
            window.location.href = '/login?redirect=' + encodeURIComponent(returnTo);
            return response;
        }
        isRefreshing = false;
        refreshPromise = null;
    }
    
    // Reset counter on successful response
    if (response.ok) {
        refreshAttemptCount = 0;
    }
    
    return response;
};

/**
 * System timezone (e.g. 'America/Denver') — an org-wide setting, not the
 * viewer's own browser timezone, for things that need to be anchored to
 * wherever the business actually is regardless of who's looking (e.g. a
 * dashboard pod's "today" query window). Lives in kore_sys.system_config
 * (the same singleton row getSecurityConfig() above already reads),
 * fetched once and cached.
 *
 * window.timezone is set synchronously to a safe 'UTC' fallback right
 * away. The real value is fetched LAZILY - on the first call to
 * getSystemTimezone(), not at module load. Anything that needs the true
 * system timezone must `await getSystemTimezone()` before reading
 * window.timezone; the result is cached, so repeated awaits are free.
 *
 * Lazy rather than eager because base.js loads on every page including
 * unauthenticated ones. Fetching at module load meant a logged-out visit
 * fired a query that could only ever 401, producing console errors before
 * the redirect to login and doing work nothing would use. user_dash.js
 * (the only consumer) already awaits this explicitly before its
 * dynamic_inputs computers read window.timezone.
 */
window.timezone = 'UTC';
let _systemTimezonePromise = null;
async function getSystemTimezone() {
    if (_systemTimezonePromise) return _systemTimezonePromise;
    _systemTimezonePromise = (async () => {
        try {
            // No pre-flight "am I logged in" check is possible here: the
            // sessionToken cookie is HttpOnly, so JS cannot read it, which is
            // why base.js:29 falls back to the literal string 'cookie' and
            // window.sessionToken is ALWAYS truthy. The old guard was
            // `!window.sessionToken || !userId`, and the userId half - a
            // localStorage read - was the only part that ever did anything.
            //
            // So this simply attempts the fetch and treats failure as normal.
            // On a page load with no valid session (login page, expired
            // session, cleared cookies) it returns 401 and we keep the
            // fallback, which is the correct outcome either way.
            const result = await executeSqlQuery(window.sessionToken, null, 'kore_sys', 'SELECT timezone FROM system_config WHERE id = 1');
            const tz = result.result && result.result[0] && result.result[0].timezone;
            if (tz) window.timezone = tz;
        } catch (error) {
            // Non-fatal by design - every caller reads window.timezone, which
            // already holds a usable fallback. Warn rather than error so an
            // unauthenticated page load doesn't look like a crash.
            console.warn('Could not fetch system timezone, keeping fallback:', error.message);
        }
        return window.timezone;
    })();
    return _systemTimezonePromise;
}
// NOT called eagerly - see the note above. Consumers await it on demand.

/**
 * Attempt to refresh the session token
 * Uses /auth/refresh which intelligently tries:
 *   1. sessionToken (if valid)
 *   2. refreshToken (if sessionToken expired)
 *   3. Returns 401 if both are invalid
 */
async function attemptTokenRefresh() {
    try {
        const response = await originalFetch('/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error(`Refresh failed: ${response.status}`);
        }
        
        return response;
    } catch (err) {
        console.error('Token refresh error:', err);
        throw err;
    }
}

/**
 * Utility: Generate a random UUID v4
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Utility: Generate a short random ID with optional prefix
 * e.g. generateId('step') => 'step-a3f9x2'
 */
function generateId(prefix = '') {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = prefix ? prefix + '-' : '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}
window.generateId = generateId;

/**
 * Theme Management
 */
let activeTheme = localStorage.getItem('kore-theme') || 'default';

function setTheme(themeName) {
    if (!theme[themeName]) {
        console.warn(`Theme "${themeName}" not found`);
        return;
    }
    
    activeTheme = themeName;
    localStorage.setItem('kore-theme', themeName);
    
    // Update all colors
    updateHeaderColors();
    updateBodyColors();
    
    // Dispatch event so other components can update
    window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme: themeName } }));
}

function updateHeaderColors() {
    const t = theme[activeTheme];
    const root = document.documentElement;
    
    root.style.setProperty('--brand-light', t.eq.light);
    root.style.setProperty('--brand-dark', t.eq.dark);
    root.style.setProperty('--brand-lighter', t.eq.lighter);
    root.style.setProperty('--brand-light-tint', `color-mix(in srgb, ${t.eq.light} 25%, transparent)`);
    root.style.setProperty('--bg-drawer', t.bg.drawer);
    root.style.setProperty('--bg-titlePod', t.bg.titlePod);
    root.style.setProperty('--text-header', t.text.header);
    root.style.setProperty('--border-primary', t.border.primary);
    root.style.setProperty('--border-bright', t.border.bright);
    root.style.setProperty('--overlay-dark', overlayColors.dark);
    root.style.setProperty('--overlay-darkShadow', overlayColors.darkShadow);
    root.style.setProperty('--overlay-medium', overlayColors.blueMedium);
}

/**
 * Apply the current theme's --text-input color to a single <select>'s
 * dropdown arrow. base_css.js's stylesheet rule bakes in a static black
 * arrow as a fallback (data URIs can't reference CSS variables directly),
 * so the real theming happens by overriding background-image inline here.
 * updateBodyColors() calls this for every <select> present at theme-init
 * time; anything creating <select> elements afterward (e.g. form-viewer's
 * dropdown fields) needs to call this itself once inserted into the DOM.
 * @param {HTMLSelectElement} el
 */
function applySelectArrowColor(el) {
    const t = theme[activeTheme];
    if (!t || !el) return;
    const arrowColor = encodeURIComponent(t.text.input);
    el.style.backgroundImage = `url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${arrowColor}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e")`;
}

function updateBodyColors() {
    const t = theme[activeTheme];
    const root = document.documentElement;
    
    root.style.setProperty('--bg-primary', t.bg.primary);
    root.style.setProperty('--bg-secondary', t.bg.secondary);
    root.style.setProperty('--bg-input', t.bg.input);
    root.style.setProperty('--bg-subpanel', t.bg.subpanel);
    root.style.setProperty('--bg-panel1', t.bg.panel1);
    root.style.setProperty('--bg-panel2', t.bg.panel2);
    root.style.setProperty('--bg-panel3', t.bg.panel3);
    root.style.setProperty('--bg-panel4', t.bg.panel4);
    root.style.setProperty('--bg-panel5', t.bg.panel5);
    root.style.setProperty('--text-primary', t.text.primary);
    root.style.setProperty('--text-muted', t.text.muted);
    root.style.setProperty('--text-accent', t.text.accent);
    root.style.setProperty('--text-input', t.text.input);

    // Update select arrow color to match --text-input
    document.querySelectorAll('select').forEach(el => applySelectArrowColor(el));
    root.style.setProperty('--overlay-white-faint', overlayColors.whiteFaint);
    root.style.setProperty('--secondary-slate', t.secondary.slate);
    root.style.setProperty('--secondary-medium', t.secondary.medium);
    root.style.setProperty('--secondary-neutral', t.secondary.neutral);
    root.style.setProperty('--highlight-red', t.highlight.red);
    root.style.setProperty('--highlight-orange', t.highlight.orange);
    root.style.setProperty('--highlight-yellow', t.highlight.yellow);
}

function getAvailableThemes() {
    return Object.keys(theme);
}

/**
 * Expose statusColors as CSS custom properties.
 * These are universal (non-theme-dependent), so unlike updateHeaderColors/
 * updateBodyColors this only needs to run once, not on every setTheme() call.
 */
function applyStatusColors() {
    const root = document.documentElement;

    root.style.setProperty('--status-green', statusColors.green);
    root.style.setProperty('--status-green-dark', statusColors.greenDark);
    root.style.setProperty('--status-red', statusColors.red);
    root.style.setProperty('--status-red-dark', statusColors.redDark);
    root.style.setProperty('--status-red-hover', statusColors.redHover);
    root.style.setProperty('--status-red-input', statusColors.redInput);
    root.style.setProperty('--status-red-input-hover', statusColors.redInputHover);
}

/**
 * Inject component styles from base.css
 */
function injectComponentStyles() {
    const styleTag = document.createElement('style');
    styleTag.textContent = componentStyles;
    document.head.appendChild(styleTag);
}

/**
 * Cache for the built navigation menu
 */
let cachedNavigationMenuHTML = null;

/**
 * Menu items configuration: path, icon, label, resource (for permission check)
 */
const MENU_ITEMS = [
    { path: '/admin', icon: 'i-dashboard', label: 'Dashboard', resource: 'page' },
    { path: '/workflows', icon: 'i-workflows', label: 'Workflows', resource: 'page' },
    { path: '/workflow-execs', icon: 'i-workflows-exec', label: 'Workflow Executions', resource: 'page' },
    { path: '/forms', icon: 'i-form', label: 'Forms', resource: 'page' },
    { path: '/datatables', icon: 'i-datatable', label: 'Datatables', resource: 'page' },
    { path: '/code-test', icon: 'i-code', label: 'Code Test', resource: 'page' },
    { path: '/task-test', icon: 'i-code', label: 'Plugin Task Test', resource: 'page' },
];

const MENU_ITEMS_BOTTOM = [
    { path: '/settings', icon: 'i-settings', label: 'Settings', resource: 'page' },
    { path: '/userprefs', icon: 'i-user', label: 'User Preferences', resource: 'page' },
];

/**
 * Build navigation menu with permission checks
 * Caches the result so permission checks only happen once
 * @returns {Promise<string>} - HTML for the nav-drawer content
 */
async function buildNavigationMenu() {
    // Return cached menu if available
    if (cachedNavigationMenuHTML) {
        console.log('[Header] Using cached navigation menu');
        return cachedNavigationMenuHTML;
    }

    console.log('[Header] Building navigation menu with permission checks');
    
    try {
        // Get current user ID by validating the session token
        let userId = null;
        try {
            const tokenResponse = await fetch('/auth/validate-token', { 
                method: 'POST', 
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            });
            console.log('[Header] Token validation response status:', tokenResponse.status);
            
            if (tokenResponse.ok) {
                const tokenData = await tokenResponse.json();
                console.log('[Header] Token validation response data:', tokenData);
                userId = tokenData.userId;
                console.log('[Header] Extracted userId:', userId);
            } else {
                const errorText = await tokenResponse.text();
                console.warn('[Header] Token validation failed with status', tokenResponse.status, ':', errorText);
            }
        } catch (tokenErr) {
            console.warn('[Header] Could not validate session token:', tokenErr);
        }

        if (!userId) {
            console.warn('[Header] Could not determine user ID for permission checks');
        }

        // Build top menu items with permission checks
        let topMenuHTML = '';
        for (const item of MENU_ITEMS) {
            let hasAccess = true;
            
            if (userId) {
                try {
                    hasAccess = await checkUserPermission({
                        resource: item.resource,
                        action: 'view',
                        scope: item.path
                    });
                } catch (err) {
                    console.error(`[Header] Error checking permission for ${item.path}:`, err);
                    hasAccess = false;
                }
            }

            if (hasAccess) {
                topMenuHTML += `<a href="${item.path}" style="color: #7ec8ff; font-size: 0.9rem; text-decoration: none; display: flex; align-items: center; padding: 6px 0; transition: opacity 0.2s; gap: 6px;" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'"><svg width="26" height="26" style="flex-shrink: 0;"><use href="#${item.icon}"/></svg><span>${item.label}</span></a>`;
            }
        }

        // Build bottom menu items with permission checks
        let bottomMenuHTML = '';
        for (const item of MENU_ITEMS_BOTTOM) {
            let hasAccess = true;
            
            if (userId) {
                try {
                    hasAccess = await checkUserPermission({
                        resource: item.resource,
                        action: 'view',
                        scope: item.path
                    });
                } catch (err) {
                    console.error(`[Header] Error checking permission for ${item.path}:`, err);
                    hasAccess = false;
                }
            }

            if (hasAccess) {
                bottomMenuHTML += `<a href="${item.path}" style="color: #7ec8ff; font-size: 0.9rem; text-decoration: none; display: flex; align-items: center; padding: 6px 0; transition: opacity 0.2s; gap: 6px;" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'"><svg width="26" height="26" style="flex-shrink: 0;"><use href="#${item.icon}"/></svg><span>${item.label}</span></a>`;
            }
        }

        // Assemble final menu HTML
        cachedNavigationMenuHTML = topMenuHTML + 
            `<div style="margin-top: auto;">` + 
            bottomMenuHTML +
            `<div style="color: #7ec8ff; font-size: 0.9rem; padding: 6px 0; cursor: pointer; transition: opacity 0.2s; display: flex; align-items: center; gap: 6px;" onclick="logout()" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'"><svg width="26" height="26" style="flex-shrink: 0;"><use href="#i-logout"/></svg><span>Logout</span></div>` +
            `</div>`;

        console.log('[Header] Navigation menu cached');
        return cachedNavigationMenuHTML;
    } catch (error) {
        console.error('[Header] Error building navigation menu:', error);
        // Fallback to basic menu if permission checks fail
        return `<a href="/admin" style="color: #7ec8ff; font-size: 0.9rem; text-decoration: none; display: flex; align-items: center; padding: 6px 0; transition: opacity 0.2s; gap: 6px;"><svg width="26" height="26" style="flex-shrink: 0;"><use href="#i-dashboard"/></svg><span>Dashboard</span></a>
                <div style="margin-top: auto;">
                    <div style="color: #7ec8ff; font-size: 0.9rem; padding: 6px 0; cursor: pointer; transition: opacity 0.2s; display: flex; align-items: center; gap: 6px;" onclick="logout()"><svg width="26" height="26" style="flex-shrink: 0;"><use href="#i-logout"/></svg><span>Logout</span></div>
                </div>`;
    }
}

/**
 * Builds and styles the Equinox Kore header and navigation.
 * @param {string} pageTitle - The text to display in the center of the header.
 */
async function buildKoreHeader(pageTitle = "Kore System") {
    const style = document.createElement('style');
    style.textContent = `
        :root {
            --header-height: 25px; 
            --header-drop: 25px;
            --header-clearance: 27px; 
            --badge-size: 34px;      
            --pod-height: 24px;      
            --badge-top: 6px;
            --pod-top: 12px;         
            --brand-light: ${theme[activeTheme].eq.light};
            --brand-dark: ${theme[activeTheme].eq.dark};
            --bg-drawer: ${theme[activeTheme].bg.drawer};
            --bg-titlePod: ${theme[activeTheme].bg.titlePod};
            --text-header: ${theme[activeTheme].text.header};
            --border-primary: ${theme[activeTheme].border.primary};
            --border-bright: ${theme[activeTheme].border.bright};
            --overlay-dark: ${overlayColors.dark};
            --overlay-darkShadow: ${overlayColors.darkShadow};
            --overlay-medium: ${overlayColors.blueMedium};
        }

        /* 1. Nav Drawer */
        .nav-drawer { 
            position: fixed; 
            top: var(--header-height); 
            right: -200px; 
            width: 200px; 
            height: calc(100% - var(--header-height) + 10px); 
            background-color: var(--bg-drawer); 
            border-left: 1px solid var(--border-primary); 
            z-index: 1001; 
            padding: 10px 10px 15px; 
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            transition: right 0.4s cubic-bezier(0.165, 0.84, 0.44, 1); 
        }
        .nav-drawer.open { right: 0; box-shadow: -4px 0 6px 0 var(--overlay-dark); }

        /* 2. Main Header Rail */
        .header {
            position: fixed;
            top: 0; left: -10px; right: -10px;
            height: var(--header-drop);
            background-color: var(--brand-dark); 
            border-bottom: 3px solid var(--brand-light);
            box-shadow: 0 4px 6px 0 var(--overlay-dark);
            z-index: 1002;
        }

        /* 3. Shadow Layer - Phantoms below rail */
        .shadow-layer {
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 1001;
            pointer-events: none;
        }

        .phantom-circle-left, .phantom-circle-right {
            position: absolute;
            top: var(--badge-top);
            width: var(--badge-size);
            height: var(--badge-size);
            border-radius: 50%;
        }

        .phantom-circle-left { left: 10px; box-shadow: 4px 6px 6px 0 var(--overlay-dark); }
        .phantom-circle-right { right: 10px; box-shadow: -4px 6px 6px 0 var(--overlay-dark); }

        .phantom-pod {
            position: absolute;
            top: var(--pod-top);
            height: var(--pod-height);
            left: 50%;
            transform: translateX(-50%);
            padding: 0 25px;
            border-radius: 22px;
            min-width: 180px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 6px 6px 0 var(--overlay-dark);
        }

        .phantom-title {
            font-size: 1rem;
            font-weight: 750;
            text-transform: uppercase;
            letter-spacing: 3px;
            white-space: nowrap;
            visibility: hidden;
        }

        /* Mobile/Narrow Screen Adjustments */
        @media (max-width: 650px) {
            .phantom-circle-left { left: 5px; }
            .phantom-circle-right { right: 5px; }

            .phantom-pod {
                padding: 0 20px;
                min-width: auto;
            }
        }

        /* Very Narrow Screens */
        @media (max-width: 500px) {
            .phantom-title {
                white-space: normal;
                line-height: 1.2;
            }

            .phantom-pod {
                left: 50px;
                right: 50px;
                transform: none;
                min-width: auto;
            }
        }

        /* 4. Top Interaction Layer */
        .ui-layer {
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 1005;
            pointer-events: none;
        }

        .logo-circle, .menu-circle {
            position: absolute;
            top: var(--badge-top);
            width: var(--badge-size);
            height: var(--badge-size);
            display: flex;
            align-items: center;
            justify-content: center;
            background-color: white; 
            border-radius: 50%; 
            border: 3px solid var(--brand-light); 
            pointer-events: auto;
        }

        .logo-circle { left: 10px; text-decoration: none; }
        .menu-circle { right: 10px; cursor: pointer; }
        .logo-img { width: 28px; height: 28px; object-fit: contain; }

        .title-pod {
            position: absolute;
            top: var(--pod-top);
            height: var(--pod-height);
            left: 50%;
            transform: translateX(-50%);
            background-color: var(--bg-titlePod);
            border: 2px solid var(--border-bright);
            padding: 0 25px;
            border-radius: 22px; 
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 180px;
            pointer-events: auto;
            box-shadow: inset 0 2px 8px var(--overlay-dark), inset 0 0 8px var(--overlay-medium);
        }

        .variable-title { 
            color: var(--text-header); 
            font-size: 1rem;
            font-weight: 750;
            text-transform: uppercase; 
            letter-spacing: 3px; 
            white-space: nowrap;
            text-shadow: 0 0 6px var(--border-bright);
        }

        .hamburger-lines { 
            width: 25px; height: 3px; 
            background-color: var(--brand-dark); 
            position: relative;
        }
        .hamburger-lines::before, .hamburger-lines::after { 
            content: ''; position: absolute; 
            width: 25px; height: 3px; 
            background-color: var(--brand-dark); 
            transition: all 0.3s ease;
        }
        .hamburger-lines::before { top: -6.7px; }
        .hamburger-lines::after { top: 6.7px; }

        .menu-circle.active .hamburger-lines { background: transparent; }
        .menu-circle.active .hamburger-lines::before { transform: rotate(45deg); top: 0; }
        .menu-circle.active .hamburger-lines::after { transform: rotate(-45deg); top: 0; }

        /* Mobile/Narrow Screen Adjustments */
        @media (max-width: 650px) {
            :root {
                --badge-size: 40px;
                --pod-height: 40px;
                --badge-top: 12px;
                --pod-top: 8px;
            }
            
            .logo-circle { left: 5px; }
            .menu-circle { right: 5px; }
            
            .title-pod {
                padding: 0 20px;
                min-width: auto;
            }
        }

        /* Very Narrow Screens - Allow Text Wrapping */
        @media (max-width: 500px) {
            .variable-title {
                white-space: normal;
                line-height: 1.2;
            }

            .title-pod {
                left: 50px;
                right: 50px;
                transform: none;
                min-width: auto;
            }
        }
    `;
    document.head.appendChild(style);

    const headerHTML = `
    <div class="shadow-layer">
        <div class="phantom-circle-left"></div>
        <div class="phantom-pod"><div class="phantom-title">${pageTitle}</div></div>
        <div class="phantom-circle-right"></div>
    </div>
    <header class="header"></header>
    <div class="ui-layer">
        <a href="/admin" class="logo-circle"><img src="https://llink.equinoxits.com/images/kore-icon.png" class="logo-img"></a>
        <div class="title-pod"><div class="variable-title">${pageTitle}</div></div>
        <div class="menu-circle" id="hamburger"><div class="hamburger-lines"></div></div>
    </div>
    <nav class="nav-drawer" id="drawer"></nav>`;

    document.body.insertAdjacentHTML('afterbegin', headerHTML);
    
    // Build and populate the navigation menu (with permission checks and caching)
    const navDrawer = document.getElementById('drawer');
    if (navDrawer) {
        const menuHTML = await buildNavigationMenu();
        navDrawer.innerHTML = menuHTML;
    }
    
    // Load icon definitions from external file if not already present
    if (!document.getElementById('kore-icons')) {
        fetch('/img/icons.svg')
            .then(response => response.text())
            .then(svg => {
                // Remove XML declaration if present
                svg = svg.replace(/<\?xml[^?]*\?>/, '').trim();
                document.body.insertAdjacentHTML('afterbegin', svg);
            })
            .catch(err => console.warn('Could not load icons.svg:', err));
    }

    const hamburger = document.getElementById('hamburger');
    const drawer = document.getElementById('drawer');

    hamburger.addEventListener('click', (e) => {
        e.stopPropagation();
        hamburger.classList.toggle('active');
        drawer.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
        if (!drawer.contains(e.target) && !hamburger.contains(e.target) && drawer.classList.contains('open')) {
            hamburger.classList.remove('active');
            drawer.classList.remove('open');
        }
    });

    // Responsive title sizing based on available space
    function adjustTitleSize() {
        const titlePod = document.querySelector('.title-pod');
        const variableTitle = document.querySelector('.variable-title');
        const phantomTitle = document.querySelector('.phantom-title');
        
        if (!titlePod || !variableTitle) return;
        
        const windowWidth = window.innerWidth;
        
        // Calculate available space based on current screen size
        let badgeSize, margin, padding;
        if (windowWidth < 650) {
            badgeSize = 40;
            margin = 5;
            padding = 20;
        } else {
            badgeSize = 58;
            margin = 10;
            padding = 40;
        }
        
        // Available space: window width - logo badge - menu badge - title pod padding
        const badgeAndMargin = (badgeSize + margin * 2) * 2; // both sides
        const availableWidth = windowWidth - badgeAndMargin - (padding * 2);
        
        // Calculate font size based on available width
        let fontSize = 1; // default 1rem
        if (availableWidth < 250) {
            fontSize = 0.65;
        } else if (availableWidth < 350) {
            fontSize = 0.75;
        } else if (availableWidth < 500) {
            fontSize = 0.85;
        }
        
        variableTitle.style.fontSize = fontSize + 'rem';
        if (phantomTitle) phantomTitle.style.fontSize = fontSize + 'rem';
    }
    
    // Initial call and listen to resize
    adjustTitleSize();
    window.addEventListener('resize', adjustTitleSize);
}


// Auto-execute: inject component styles and initialize theme
injectComponentStyles();
applyStatusColors();

// --bg-canvas is fixed and never changes with theme
document.documentElement.style.setProperty('--bg-canvas', '#152030');

setTheme(activeTheme);

/**
 * Dynamically-created <select> elements (document.createElement('select'),
 * or any HTML built via innerHTML/template strings after page load) never
 * pick up the themed arrow color on their own - only the one-time sweep in
 * updateBodyColors() (called above via setTheme) and any call site that
 * manually invokes applySelectArrowColor() get it. Every other dynamic
 * select is left with base_css.js's static black fallback arrow, which is
 * why arrows have been inconsistent across pages (permission rows, menu
 * item type/resource pickers, plugin config dropdowns, etc.).
 *
 * Rather than requiring every current and future call site to remember to
 * call applySelectArrowColor() itself, watch the whole document for any
 * <select> being added anywhere and theme it automatically. This covers
 * all existing dynamic selects and any added in the future with no further
 * changes needed at their call sites.
 */
function observeDynamicSelects() {
    if (window._selectArrowObserver) return; // don't double-init on re-import

    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                if (node.tagName === 'SELECT') {
                    applySelectArrowColor(node);
                } else if (node.querySelectorAll) {
                    node.querySelectorAll('select').forEach(applySelectArrowColor);
                }
            });
        }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    window._selectArrowObserver = observer;
}
observeDynamicSelects();

/**
 * Modal Management System
 */

let modalStack = [];


/**
 * Show a modal dialog
 * @param {Object} options - Modal configuration
 * @param {string} options.title - Modal title
 * @param {string|HTMLElement} options.content - Modal body content (HTML string or element)
 * @param {Array} options.buttons - Array of button objects: {label, onClick, type: 'primary'|'secondary'|'danger'}
 * @param {Function} options.onClose - Callback when modal closes
 * @param {boolean} options.closeOnBackdrop - Close when clicking backdrop (default: true)
 */
function showModal(options = {}) {
    const {
        title = 'Modal',
        content = '',
        buttons = [],
        onClose = null,
        closeOnBackdrop = true,
        resizable = false,
        suppressBodyScroll = false,
        width = null,
        height = null
    } = options;

    // Create backdrop if it doesn't exist
    let backdrop = document.getElementById('modal-backdrop');
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'modal-backdrop';
        backdrop.className = 'modal-backdrop';
        document.body.appendChild(backdrop);
    }

    // Create modal container
    const modal = document.createElement('div');
    modal.className = 'modal-container' + (resizable ? ' modal-resizable' : '') + (suppressBodyScroll ? ' modal-no-scroll' : '');
    modal.innerHTML = `
        <div class="modal-header">
            <h2>${title}</h2>
        </div>
        <div class="modal-body${suppressBodyScroll ? ' modal-body-no-scroll' : ''}" id="modal-body-content" style="height:0px">
            ${typeof content === 'string' ? content : ''}
        </div>
        <div class="modal-footer" id="modal-footer">
        </div>
        ${resizable ? '<div class="modal-resize-handle"></div>' : ''}
    `;

    // Add content if it's an HTMLElement
    if (content instanceof HTMLElement) {
        modal.querySelector('#modal-body-content').innerHTML = '';
        modal.querySelector('#modal-body-content').appendChild(content);
    }

    // Add buttons
    const footer = modal.querySelector('#modal-footer');
    if (buttons.length > 0) {
        buttons.forEach(btn => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn';
            
            // Map button types to data-color
            if (btn.type === 'secondary') {
                button.setAttribute('data-color', 'grey');
            } else if (btn.type === 'danger') {
                button.setAttribute('data-color', 'red');
            } else if (btn.type === 'success') {
                button.setAttribute('data-color', 'green');
            }
            // 'primary' uses default .btn color
            
            // Apply custom styles if provided
            if (btn.style) {
                Object.assign(button.style, btn.style);
            }
            
            button.textContent = btn.label;
            button.addEventListener('click', async () => {
                if (btn.onClick) {
                    let result = btn.onClick();
                    // Wait for async functions (Promises) - and use the RESOLVED
                    // value for the close-check below, not the Promise object
                    // itself (which is never === false, so without this
                    // reassignment an async onClick could never prevent the
                    // modal from closing no matter what it actually returned).
                    if (result instanceof Promise) {
                        result = await result;
                    }
                    // Only close modal if onClick didn't return false (allowing onClick to handle closing)
                    if (result !== false) {
                        closeModal();
                    }
                } else {
                    closeModal();
                }
            });
            footer.appendChild(button);
        });
    } else {
        // Default close button if no buttons provided
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'btn';
        closeBtn.setAttribute('data-color', 'grey');
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', closeModal);
        footer.appendChild(closeBtn);
    }

    // Push to stack first so we can calculate correct z-index and stack depth
    const modalData = {
        element: modal,
        backdrop: backdrop,
        onClose: onClose
    };
    modalStack.push(modalData);

    // Calculate z-index based on stack depth (higher for newer modals)
    const zIndex = 2001 + (modalStack.length * 10);
    const stackDepth = modalStack.length - 1;
    
    // Apply positioning styles
    modal.style.position = 'absolute';
    modal.style.top = '50%';
    modal.style.left = '50%';
    modal.style.zIndex = zIndex;
    // Wide drop shadow extending in all directions
    modal.style.boxShadow = '0 0 180px 90px rgba(0, 0, 0, 0.75)';
    
    if (width) modal.style.width = width;
    if (height) modal.style.height = height;
    if (width === 'auto') { modal.style.maxWidth = '95vw'; }
    if (height === 'auto') { modal.style.maxHeight = '90vh'; modal.style.overflowY = 'auto'; }
    
    if (stackDepth > 0) {
        const offsetX = stackDepth * 30;
        const offsetY = stackDepth * 30;
        modal.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
    } else {
        modal.style.transform = `translate(-50%, -50%)`;
        // Primary modal also gets backdrop effect shadow
        modal.style.boxShadow = '0 30px 100px rgba(0, 0, 0, 0.8), 0 0 60px rgba(0, 0, 0, 0.4), 0 0 180px 90px rgba(0, 0, 0, 0.75)';
    }
    
    // Append to DOM
    backdrop.appendChild(modal);
    backdrop.classList.add('active');

    // Add resize functionality if resizable
    if (resizable) {
        const resizeHandle = modal.querySelector('.modal-resize-handle');
        if (resizeHandle) {
            let isResizing = false;
            let startX = 0;
            let startY = 0;
            let startWidth = 0;
            let startHeight = 0;

            resizeHandle.addEventListener('mousedown', (e) => {
                isResizing = true;
                startX = e.clientX;
                startY = e.clientY;
                startWidth = modal.offsetWidth;
                startHeight = modal.offsetHeight;
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                
                const deltaX = e.clientX - startX;
                const deltaY = e.clientY - startY;
                
                modal.style.width = Math.max(300, startWidth + deltaX) + 'px';
                modal.style.height = Math.max(200, startHeight + deltaY) + 'px';
            });

            document.addEventListener('mouseup', () => {
                isResizing = false;
            });
        }
    }

    // Backdrop click to close - handle listener based on closeOnBackdrop setting
    if (!backdrop.backdropClickHandler) {
        backdrop.backdropClickHandler = (e) => {
            if (e.target === backdrop && backdrop.closeOnBackdrop !== false) {
                closeModal();
            }
        };
        backdrop.addEventListener('click', backdrop.backdropClickHandler);
    }
    // Update the current closeOnBackdrop setting on the backdrop
    backdrop.closeOnBackdrop = closeOnBackdrop;

    // ESC key to close
    const escapeHandler = (e) => {
        if (e.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', escapeHandler);
    modalData.escapeHandler = escapeHandler;

    // Focus first button or input
    const firstButton = modal.querySelector('button');
    const firstInput = modal.querySelector('input, textarea, select');
    if (firstInput) firstInput.focus();
    else if (firstButton) firstButton.focus();
}

/**
 * Close the current modal
 */
function closeModal() {
    if (modalStack.length > 0) {
        const currentModal = modalStack.pop();
        const { element, backdrop, onClose, escapeHandler } = currentModal;
        
        // Remove the modal element
        element.remove();
        
        // Remove escape listener
        if (escapeHandler) {
            document.removeEventListener('keydown', escapeHandler);
        }
        
        // Call onClose callback
        if (onClose) onClose();
        
        // If no more modals, hide the backdrop
        if (modalStack.length === 0) {
            backdrop.classList.remove('active');
        }
    }
}

/**
 * Show a simple alert dialog
 * @param {string} title - Alert title
 * @param {string} message - Alert message
 */
function showAlert(title, message) {
    showModal({
        title: title,
        content: `<p style="color: var(--text-primary); margin: 0;">${message}</p>`,
        closeOnBackdrop: true,  // Alert is informational only, can close on backdrop click
        buttons: [
            {
                label: 'OK',
                type: 'primary',
                onClick: () => {}
            }
        ]
    });
}

/**
 * Show a confirmation dialog
 * @param {string} title - Dialog title
 * @param {string} message - Dialog message
 * @param {Function} onConfirm - Callback if user confirms
 * @param {string} confirmLabel - Label for confirm button (default: 'Confirm')
 */
function showConfirm(title, message, onConfirm, confirmLabel = 'Confirm') {
    showModal({
        title: title,
        content: `<p style="color: var(--text-primary); margin: 0;">${message}</p>`,
        closeOnBackdrop: false,  // Confirmation requires explicit choice
        buttons: [
            {
                label: 'Cancel',
                type: 'secondary',
                onClick: () => {}
            },
            {
                label: confirmLabel,
                type: 'primary',
                onClick: onConfirm
            }
        ]
    });
}

/**
 * Show a delete confirmation dialog
 * @param {string} message - Confirmation message
 * @param {Function} onConfirm - Callback if user confirms deletion
 */
function showDeleteConfirm(message, onConfirm) {
    showModal({
        title: 'Delete',
        content: `<p style="color: var(--text-primary); margin: 0;">${message}</p>`,
        closeOnBackdrop: false,  // Delete is a critical action, requires explicit choice
        buttons: [
            {
                label: 'Cancel',
                type: 'secondary',
                onClick: () => {}
            },
            {
                label: 'Delete',
                type: 'danger',
                onClick: onConfirm
            }
        ]
    });
}

/**
 * Show unsaved changes dialog
 * @param {Function} onSave - Callback to save changes
 * @param {Function} onDiscard - Callback to discard changes
 */
function showUnsaved(onSave, onDiscard) {
    showModal({
        title: 'Unsaved Changes',
        content: `<p style="color: var(--text-primary); margin: 0;">You have unsaved changes. What would you like to do?</p>`,
        closeOnBackdrop: false,  // Unsaved changes requires explicit choice
        buttons: [
            {
                label: 'Cancel',
                type: 'secondary',
                onClick: () => {}
            },
            {
                label: 'Discard',
                type: 'danger',
                onClick: onDiscard
            },
            {
                label: 'Save Changes',
                type: 'success',
                onClick: onSave
            }
        ]
    });
}
/**
 * Get session token.
 * Previously authenticated via a hardcoded admin credential + static API
 * key against the external SQL/plugin API (app.equinoxits.com:1139) — a
 * secret shipped in cleartext to every browser that loaded this file.
 * Now just returns window.sessionToken, established once at module load
 * above (see that comment for the full explanation): the real cookie is
 * HttpOnly and unreadable here, so this is a placeholder that satisfies
 * callers' own non-empty checks while the actual auth happens via the
 * auto-attached HttpOnly cookie server-side — confirmed working already
 * via datatables.js's identical 'cookie' placeholder convention. Kept
 * async (and still named getSessionToken) so every existing
 * `await window.getSessionToken()` call site across the codebase keeps
 * working unchanged — new code should prefer reading window.sessionToken
 * directly, since there's no longer a network call here to await.
 */
async function getSessionToken() {
    return window.sessionToken;
}

/**
 * Build a small "?" icon that shows a tooltip with the given explanation
 * when clicked. Pairs with the global click-handler below, which is
 * delegated at the document level so this works anywhere infoIcon()'s
 * output is inserted, with no per-instance wiring needed.
 * @param {string} explanation - Tooltip text
 * @returns {string} HTML string for the icon
 */
function infoIcon(explanation) {
    // Escape any quotes in the explanation for the data attribute
    const escaped = (explanation || '').replace(/"/g, '&quot;');
    return `<span class="info-icon" data-explanation="${escaped}" style="display: inline-block; width: 12px; height: 12px; margin-left: 6px; background: white; border-radius: 50%; border: 1px solid #667eea; color: #667eea; font-size: 12px; font-weight: bold; line-height: 12px; text-align: center; cursor: pointer; flex-shrink: 0;">?</span>`;
}

// Info Icon Click Handler - delegated globally so any infoIcon() output,
// anywhere in the DOM, shows/hides its tooltip without needing its own
// listener attached.
(() => {
    let activeTooltip = null;

    document.addEventListener('click', (e) => {
        const icon = e.target.closest('.info-icon');

        if (icon) {
            e.preventDefault();
            e.stopPropagation();

            // Close existing tooltip if clicking a different icon
            if (activeTooltip && activeTooltip !== icon) {
                activeTooltip.tooltip?.remove();
                activeTooltip.tooltip = null;
                activeTooltip = null;
            }

            // Toggle tooltip
            if (icon.tooltip) {
                icon.tooltip.remove();
                icon.tooltip = null;
                activeTooltip = null;
            } else {
                // Create and show tooltip
                const tooltip = document.createElement('div');
                tooltip.className = 'info-tooltip';
                tooltip.textContent = icon.dataset.explanation;
                document.body.appendChild(tooltip);

                // Position tooltip above the icon
                const rect = icon.getBoundingClientRect();
                const tooltipRect = tooltip.getBoundingClientRect();
                tooltip.style.left = (rect.left + rect.width / 2 - tooltipRect.width / 2) + 'px';
                tooltip.style.top = (rect.top - tooltipRect.height - 10) + 'px';

                icon.tooltip = tooltip;
                activeTooltip = icon;
            }
        } else {
            // Close tooltip when clicking anywhere else
            if (activeTooltip) {
                activeTooltip.tooltip?.remove();
                activeTooltip.tooltip = null;
                activeTooltip = null;
            }
        }
    });
})();

/**
 * Build a searchable multi-select widget's markup: a display area showing
 * selected items as removable tags, a checklist dropdown (with search and
 * Select All), and a hidden native <select multiple> kept in sync so
 * other code can read the current selection the same way it would read
 * any other <select>'s .selectedOptions.
 *
 * This only builds the container - call initializeMultiSelect() on it
 * afterward to make it interactive.
 * @param {string} fieldId - id to assign the hidden <select> (so callers
 *   can address it exactly like any other field input)
 * @param {string} fieldName - name attribute for the hidden <select>
 * @returns {string} HTML string
 */
function renderMultiSelectContainer(fieldId, fieldName) {
    return `
        <div class="multi-select-container">
            <div class="multi-select-display">
                <div class="multi-select-tags"></div>
                <button type="button" class="multi-select-clear-all" style="display: none;">Clear All</button>
                <div class="multi-select-toggle">▼</div>
            </div>
            <div class="multi-select-options"></div>
            <select id="${fieldId}" name="${fieldName}" class="multi-select-hidden-select" multiple></select>
        </div>
    `;
}

/**
 * Make a multi-select container (from renderMultiSelectContainer)
 * interactive: tags for each selected item (with a remove button),
 * a checklist dropdown with search and Select All, and a Clear All
 * button. Keeps the container's hidden <select multiple> in sync with
 * the current selection on every change.
 *
 * Safe to call again on the same container (e.g. after a dependent
 * field's options change) - it clears and rebuilds from scratch rather
 * than assuming any prior state.
 * @param {HTMLElement} container - The .multi-select-container element
 * @param {Array<{value: *, label: string}>} options
 * @param {Array<*>} [selectedValues] - Initially-selected values
 * @param {object} [config]
 * @param {boolean} [config.searchable=true] - Show the search input
 * @param {function(Array<string>): void} [config.onChange] - Called with
 *   the current selected values (as strings) after any change
 */
function initializeMultiSelect(container, options, selectedValues = [], config = {}) {
    if (!container) {
        console.error('[MultiSelect] Container not provided');
        return;
    }

    const tagsContainer = container.querySelector('.multi-select-tags');
    const dropdown = container.querySelector('.multi-select-options');
    const clearAllBtn = container.querySelector('.multi-select-clear-all');
    const hiddenSelect = container.querySelector('.multi-select-hidden-select');

    if (!tagsContainer || !dropdown || !hiddenSelect) {
        console.error('[MultiSelect] Container is missing expected child elements');
        return;
    }

    // Shared, mutable state that persists across re-initialization calls
    // on the same container - options/selected/searchable/onChange live
    // here (on the DOM node itself), not as plain closure variables.
    // Container-level listeners (toggleDropdown, tag-remove, Clear All -
    // attached only once, below) are permanently bound to whichever call's
    // closure happened to attach them, but that closure's inner functions
    // (updateTags, populateDropdown) all read from this shared object by
    // reference - so even the very first call's toggleDropdown, invoked
    // much later, sees whatever the most recent call wrote here, rather
    // than being stuck on stale options from options/selected values that
    // existed the very first time this ran.
    if (!container._msState) {
        container._msState = {};
    }
    const state = container._msState;
    state.options = options;
    state.selected = (selectedValues || []).map(v => String(v));
    state.searchable = config.searchable !== false;
    state.onChange = typeof config.onChange === 'function' ? config.onChange : null;

    // Rebuild the hidden select's options fresh each time
    hiddenSelect.innerHTML = '';
    state.options.forEach(option => {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = option.label;
        opt.selected = state.selected.includes(String(option.value));
        hiddenSelect.appendChild(opt);
    });

    function syncHiddenSelect() {
        Array.from(hiddenSelect.options).forEach(opt => {
            opt.selected = state.selected.includes(opt.value);
        });
    }

    function updateTags() {
        tagsContainer.innerHTML = '';

        if (state.selected.length === 0) {
            const placeholder = document.createElement('span');
            placeholder.className = 'multi-select-placeholder';
            placeholder.textContent = '-- Select options --';
            tagsContainer.appendChild(placeholder);
            if (clearAllBtn) clearAllBtn.style.display = 'none';
        } else {
            state.selected.forEach(value => {
                const option = state.options.find(o => String(o.value) === value);
                if (!option) return;
                const tag = document.createElement('span');
                tag.className = 'multi-select-tag';
                tag.innerHTML = `${escapeHtml(option.label)} <button type="button" class="multi-select-tag-remove" data-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(option.label)}">×</button>`;
                tagsContainer.appendChild(tag);
            });
            if (clearAllBtn) clearAllBtn.style.display = 'inline-block';
        }

        syncHiddenSelect();
        if (state.onChange) state.onChange(state.selected);
    }

    function populateDropdown(filterText = '') {
        // Preserve the search input's own element (and focus) across
        // re-populates - only rebuild what comes after it.
        let searchDiv = dropdown.querySelector('.multi-select-search');

        if (!searchDiv && state.searchable) {
            searchDiv = document.createElement('div');
            searchDiv.className = 'multi-select-search';
            searchDiv.innerHTML = `
                <div style="position: relative; width: 100%;">
                    <input type="text" class="multi-select-search-input" placeholder="Search...">
                    <button type="button" class="multi-select-search-clear" style="display: none;">✕</button>
                </div>
            `;
            dropdown.appendChild(searchDiv);

            const searchInput = searchDiv.querySelector('.multi-select-search-input');
            const clearBtn = searchDiv.querySelector('.multi-select-search-clear');

            setTimeout(() => searchInput.focus(), 0);

            searchInput.addEventListener('input', (e) => {
                clearBtn.style.display = e.target.value ? 'block' : 'none';
                populateDropdown(e.target.value);
            });

            clearBtn.addEventListener('click', (e) => {
                e.preventDefault();
                searchInput.value = '';
                clearBtn.style.display = 'none';
                populateDropdown('');
                searchInput.focus();
            });
        } else if (searchDiv) {
            const searchInput = searchDiv.querySelector('.multi-select-search-input');
            const clearBtn = searchDiv.querySelector('.multi-select-search-clear');
            if (searchInput) searchInput.value = filterText;
            if (clearBtn) clearBtn.style.display = filterText ? 'block' : 'none';
        }

        // Remove everything after the search input (Select All + options),
        // to rebuild fresh against the current filter/selection.
        let nextEl = searchDiv ? searchDiv.nextElementSibling : dropdown.firstElementChild;
        while (nextEl) {
            const toRemove = nextEl;
            nextEl = nextEl.nextElementSibling;
            toRemove.remove();
        }

        const filteredOptions = filterText.trim() === ''
            ? state.options
            : state.options.filter(opt => String(opt.label).toLowerCase().includes(filterText.toLowerCase()));

        if (filteredOptions.length > 0) {
            const selectAllDiv = document.createElement('div');
            selectAllDiv.className = 'multi-select-option multi-select-select-all';
            const selectAllId = 'ms-select-all-' + generateId();
            const allSelected = filteredOptions.every(opt => state.selected.includes(String(opt.value)));
            selectAllDiv.innerHTML = `<input type="checkbox" id="${selectAllId}" ${allSelected ? 'checked' : ''}><label for="${selectAllId}"><strong>Select All</strong></label>`;

            selectAllDiv.querySelector('input').addEventListener('change', (e) => {
                if (e.target.checked) {
                    filteredOptions.forEach(opt => {
                        const v = String(opt.value);
                        if (!state.selected.includes(v)) state.selected.push(v);
                    });
                } else {
                    const filteredValues = filteredOptions.map(opt => String(opt.value));
                    state.selected = state.selected.filter(v => !filteredValues.includes(v));
                }
                updateTags();
                populateDropdown(filterText);
            });

            dropdown.appendChild(selectAllDiv);

            const separator = document.createElement('div');
            separator.className = 'multi-select-separator';
            dropdown.appendChild(separator);
        }

        if (filteredOptions.length === 0) {
            const noMatches = document.createElement('div');
            noMatches.className = 'multi-select-no-matches';
            noMatches.textContent = 'No matches';
            dropdown.appendChild(noMatches);
        } else {
            filteredOptions.forEach(option => {
                const optionDiv = document.createElement('div');
                optionDiv.className = 'multi-select-option';
                const optId = 'ms-opt-' + generateId();
                const isChecked = state.selected.includes(String(option.value));
                optionDiv.innerHTML = `<input type="checkbox" id="${optId}" value="${escapeHtml(String(option.value))}" ${isChecked ? 'checked' : ''}><label for="${optId}">${escapeHtml(option.label)}</label>`;

                optionDiv.querySelector('input').addEventListener('change', (e) => {
                    const v = String(option.value);
                    if (e.target.checked) {
                        if (!state.selected.includes(v)) state.selected.push(v);
                    } else {
                        state.selected = state.selected.filter(sv => sv !== v);
                    }
                    updateTags();
                    populateDropdown(filterText);
                });

                dropdown.appendChild(optionDiv);
            });
        }
    }

    function closeDropdown() {
        dropdown.classList.remove('open');
    }

    function toggleDropdown() {
        document.querySelectorAll('.multi-select-options.open').forEach(el => {
            if (el !== dropdown) el.classList.remove('open');
        });
        dropdown.classList.toggle('open');
        if (dropdown.classList.contains('open')) populateDropdown();
    }

    // Attach container-level listeners only once, even if this function
    // runs again later (e.g. options refreshed) - re-adding them would
    // stack duplicate handlers. This is safe now that everything above
    // reads from the shared container._msState rather than closure
    // variables: whichever call's toggleDropdown/populateDropdown ends up
    // bound to these listeners will still see whatever the latest call
    // wrote to state.
    if (!container.hasAttribute('data-ms-listeners-attached')) {
        container.setAttribute('data-ms-listeners-attached', 'true');

        const displayArea = container.querySelector('.multi-select-display');
        if (displayArea) {
            displayArea.addEventListener('click', (e) => {
                if (e.target.classList.contains('multi-select-tag-remove')) return;
                e.stopPropagation();
                toggleDropdown();
            });
        }

        container.addEventListener('click', (e) => {
            if (e.target.classList.contains('multi-select-tag-remove')) {
                e.preventDefault();
                e.stopPropagation();
                state.selected = state.selected.filter(v => v !== e.target.dataset.value);
                updateTags();
                hiddenSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', (e) => {
                e.preventDefault();
                state.selected = [];
                updateTags();
                if (dropdown.classList.contains('open')) populateDropdown('');
                hiddenSelect.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }

        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) closeDropdown();
        });
    }

    updateTags();
    if (dropdown.classList.contains('open')) populateDropdown();
}

/**
 * Build a searchable single-select widget's markup: a display area
 * showing the current selection as text, a checklist dropdown with
 * search, and a hidden native <select> kept in sync so other code can
 * read the current value the same way it would read any other <select>.
 *
 * This only builds the container - call initializeSearchableSelect() on
 * it afterward to make it interactive.
 * @param {string} fieldId - id to assign the hidden <select>
 * @param {string} fieldName - name attribute for the hidden <select>
 * @returns {string} HTML string
 */
function renderSearchableSelectContainer(fieldId, fieldName) {
    return `
        <div class="single-select-container">
            <div class="single-select-display">
                <span class="single-select-value"></span>
                <div class="single-select-toggle">▼</div>
            </div>
            <div class="multi-select-options"></div>
            <select id="${fieldId}" name="${fieldName}" class="single-select-hidden-select"></select>
        </div>
    `;
}

/**
 * Make a searchable single-select container (from
 * renderSearchableSelectContainer) interactive: current selection shown
 * as text, a checklist dropdown with search, clicking an option selects
 * it and closes the dropdown. Keeps the container's hidden <select> in
 * sync with the current value on every change.
 *
 * Reuses the .multi-select-options/.multi-select-search* classes for the
 * dropdown panel itself (visually identical to the multi-select widget's
 * own dropdown), since only the display area and row behavior differ for
 * single-select.
 *
 * Safe to call again on the same container (e.g. after a dependent
 * field's options change) - it clears and rebuilds from scratch rather
 * than assuming any prior state. Shared, mutable state lives on the
 * container itself (container._ssState) rather than as plain closure
 * variables, for the same reason initializeMultiSelect does this - the
 * container-level listeners are attached only once, so without shared
 * state they'd stay bound to stale data from whichever call happened to
 * attach them first.
 * @param {HTMLElement} container - The .single-select-container element
 * @param {Array<{value: *, label: string}>} options
 * @param {*} [selectedValue] - Initially-selected value
 * @param {object} [config]
 * @param {boolean} [config.searchable=true] - Show the search input
 * @param {function(string): void} [config.onChange] - Called with the
 *   current selected value (as a string) after any change
 */
function initializeSearchableSelect(container, options, selectedValue = '', config = {}) {
    if (!container) {
        console.error('[SearchableSelect] Container not provided');
        return;
    }

    const valueDisplay = container.querySelector('.single-select-value');
    const dropdown = container.querySelector('.multi-select-options');
    const hiddenSelect = container.querySelector('.single-select-hidden-select');

    if (!valueDisplay || !dropdown || !hiddenSelect) {
        console.error('[SearchableSelect] Container is missing expected child elements');
        return;
    }

    if (!container._ssState) {
        container._ssState = {};
    }
    const state = container._ssState;
    state.options = options;
    state.selected = selectedValue === null || selectedValue === undefined ? '' : String(selectedValue);
    state.searchable = config.searchable !== false;
    state.onChange = typeof config.onChange === 'function' ? config.onChange : null;

    // Rebuild the hidden select's options fresh each time
    hiddenSelect.innerHTML = '';
    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = '-- Select --';
    hiddenSelect.appendChild(placeholderOption);
    state.options.forEach(option => {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = option.label;
        opt.selected = state.selected === String(option.value);
        hiddenSelect.appendChild(opt);
    });

    function updateDisplay() {
        const match = state.options.find(o => String(o.value) === state.selected);
        valueDisplay.textContent = match ? match.label : '-- Select --';
        valueDisplay.classList.toggle('single-select-placeholder', !match);

        hiddenSelect.value = match ? state.selected : '';
        if (state.onChange) state.onChange(state.selected);
    }

    function selectOption(value) {
        state.selected = value;
        updateDisplay();
        closeDropdown();

        // Setting hiddenSelect.value programmatically (inside
        // updateDisplay) never fires a native change event on its own -
        // only real user interaction with a native control does that.
        // The rest of the form (handleFormFieldChange, conditional
        // visibility, data-driven fields) all runs off event delegation
        // listening for input/change bubbling up to #formContainer, so
        // without this, selecting something here would update the value
        // but nothing else would ever find out.
        hiddenSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function populateDropdown(filterText = '') {
        let searchDiv = dropdown.querySelector('.multi-select-search');

        if (!searchDiv && state.searchable) {
            searchDiv = document.createElement('div');
            searchDiv.className = 'multi-select-search';
            searchDiv.innerHTML = `
                <div style="position: relative; width: 100%;">
                    <input type="text" class="multi-select-search-input" placeholder="Search...">
                    <button type="button" class="multi-select-search-clear" style="display: none;">✕</button>
                </div>
            `;
            dropdown.appendChild(searchDiv);

            const searchInput = searchDiv.querySelector('.multi-select-search-input');
            const clearBtn = searchDiv.querySelector('.multi-select-search-clear');

            setTimeout(() => searchInput.focus(), 0);

            searchInput.addEventListener('input', (e) => {
                clearBtn.style.display = e.target.value ? 'block' : 'none';
                populateDropdown(e.target.value);
            });

            clearBtn.addEventListener('click', (e) => {
                e.preventDefault();
                searchInput.value = '';
                clearBtn.style.display = 'none';
                populateDropdown('');
                searchInput.focus();
            });
        } else if (searchDiv) {
            const searchInput = searchDiv.querySelector('.multi-select-search-input');
            const clearBtn = searchDiv.querySelector('.multi-select-search-clear');
            if (searchInput) searchInput.value = filterText;
            if (clearBtn) clearBtn.style.display = filterText ? 'block' : 'none';
        }

        // Remove everything after the search input, to rebuild fresh
        // against the current filter.
        let nextEl = searchDiv ? searchDiv.nextElementSibling : dropdown.firstElementChild;
        while (nextEl) {
            const toRemove = nextEl;
            nextEl = nextEl.nextElementSibling;
            toRemove.remove();
        }

        const filteredOptions = filterText.trim() === ''
            ? state.options
            : state.options.filter(opt => String(opt.label).toLowerCase().includes(filterText.toLowerCase()));

        if (filteredOptions.length === 0) {
            const noMatches = document.createElement('div');
            noMatches.className = 'multi-select-no-matches';
            noMatches.textContent = 'No matches';
            dropdown.appendChild(noMatches);
        } else {
            filteredOptions.forEach(option => {
                const optionDiv = document.createElement('div');
                optionDiv.className = 'multi-select-option single-select-option';
                if (state.selected === String(option.value)) optionDiv.classList.add('single-select-option--selected');
                optionDiv.textContent = option.label;

                optionDiv.addEventListener('click', () => {
                    selectOption(String(option.value));
                });

                dropdown.appendChild(optionDiv);
            });
        }
    }

    function closeDropdown() {
        dropdown.classList.remove('open');
    }

    function toggleDropdown() {
        document.querySelectorAll('.multi-select-options.open').forEach(el => {
            if (el !== dropdown) el.classList.remove('open');
        });
        dropdown.classList.toggle('open');
        if (dropdown.classList.contains('open')) populateDropdown();
    }

    if (!container.hasAttribute('data-ss-listeners-attached')) {
        container.setAttribute('data-ss-listeners-attached', 'true');

        const displayArea = container.querySelector('.single-select-display');
        if (displayArea) {
            displayArea.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDropdown();
            });
        }

        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) closeDropdown();
        });
    }

    updateDisplay();
    if (dropdown.classList.contains('open')) populateDropdown();
}

/** Get sessionToken from browser cookies - Returns {string|null} The sessionToken value or null if not found */
function getSessionTokenFromCookie() {
    const name = 'sessionToken=';
    const decodedCookie = decodeURIComponent(document.cookie);
    const cookieArray = decodedCookie.split(';');
    for (let cookie of cookieArray) {
        cookie = cookie.trim();
        if (cookie.indexOf(name) === 0) {
            return cookie.substring(name.length);
        }
    }
    return null;
}

/**
 * Get organizations from kore database
 */
async function getOrganizations(sessionToken, user) {
    try {
        const result = await executeSqlQuery(
            sessionToken,
            user,
            'kore_sys',
            'SELECT * FROM kore_data.orgs WHERE org_id <> 1 ORDER BY org_name'
        );
        console.log('Raw executeSqlQuery result:', result);
        console.log('Result data:', result.result);
        return result.result || [];
    } catch (error) {
        console.error('Error fetching organizations:', error);
        return [];
    }
}

async function getUsers(sessionToken, user) {
    try {
        const result = await executeSqlQuery(
            sessionToken,
            user,
            'kore_sys',
            'SELECT userId, fullName, email, active, status, mfaEnabled, createdAt, lastLoginAt, lockedUntil, groupIds FROM users ORDER BY fullName'
        );
        return result.result || [];
    } catch (error) {
        console.error('Error fetching users:', error);
        return [];
    }
}

async function getGroups(sessionToken, user) {
    try {
        const result = await executeSqlQuery(
            sessionToken,
            user,
            'kore_sys',
            'SELECT groupId, name, description, active, createdAt, createdBy, groupIds FROM user_groups ORDER BY name'
        );
        return result.result || [];
    } catch (error) {
        console.error('Error fetching groups:', error);
        return [];
    }
}

async function getSecurityConfig(sessionToken, user) {
    try {
        const result = await executeSqlQuery(
            sessionToken,
            user,
            'kore_sys',
            'SELECT security_config FROM system_config WHERE id = 1'
        );
        if (result.result && result.result.length > 0) {
            const config = result.result[0].security_config;
            return typeof config === 'string' ? JSON.parse(config) : config;
        }
        return null;
    } catch (error) {
        console.error('Error fetching security config:', error);
        return null;
    }
}

/**
 * Execute SQL query
 */
async function executeSqlQuery(sessionToken, user, datasource, query, options = {}) {
    try {
        // PHASE 2: `user` is no longer validated, and never was transmitted -
        // the body below sends only {datasource, query}. It existed as a
        // required argument that every caller satisfied by reading
        // localStorage.kore_userId, which is exactly the client-asserted
        // identity this phase removes. Left in the signature for now so
        // callers can drop their getUser() lookups independently; the
        // parameter itself comes out in a single mechanical pass.
        //
        // `sessionToken` is likewise not the real credential for browser
        // callers. plugins.js:2101 reads `cookieToken || headerToken`, cookie
        // FIRST and deliberately, because the sessionToken cookie is HttpOnly
        // and unreadable from JS - which is why several callers pass the
        // literal string 'cookie' here and still authenticate correctly. The
        // header is a fallback for server-to-server callers with no cookie.
        if (!sessionToken || !datasource || !query) {
            throw new Error('sessionToken, datasource, and query are required');
        }
        
        const response = await fetch(`https://app.equinoxits.com:1139/sqlquery`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({
                datasource: datasource,
                query: query
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            const err = new Error(data.error || `HTTP ${response.status}`);
            err.status = response.status;
            throw err;
        }
        
        if (!data.success) {
            throw new Error(data.error || 'Query execution failed');
        }
        
        return data;
    } catch (error) {
        // 401 is a normal, expected outcome - an unauthenticated or expired
        // session, which the caller handles by falling back or redirecting to
        // login. Logging it at error level put a stack trace in the console for
        // something that isn't a fault, on top of the browser's own
        // unsuppressable "Failed to load resource: 401" line. Everything else
        // still logs as an error, since a failed query with a live session is a
        // real problem.
        //
        // The error is rethrown either way - this only controls log severity,
        // never whether the caller learns about the failure.
        if (error.status === 401) {
            console.warn('executeSqlQuery: not authenticated -', error.message);
        } else {
            console.error('executeSqlQuery error:', error);
        }
        throw error;
    }
}

/* ============================================================================
   UNSAVED CHANGES TRACKING SYSTEM
   ============================================================================ */

let unsavedChangesData = {
    original: null,
    hasChanges: false
};

/**
 * Deep equality check - compares two objects/values for equality
 * @param {*} obj1 - First object to compare
 * @param {*} obj2 - Second object to compare
 * @returns {boolean} True if objects are deeply equal
 */
function deepEqual(obj1, obj2) {
    if (obj1 === obj2) return true;
    if (obj1 == null || obj2 == null) return obj1 === obj2;
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object') return false;
    
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    if (keys1.length !== keys2.length) return false;
    
    for (let key of keys1) {
        if (!keys2.includes(key)) return false;
        if (!deepEqual(obj1[key], obj2[key])) return false;
    }
    
    return true;
}

/**
 * Initialize unsaved changes tracking with original data
 * @param {object} originalData - Original data object to track against
 */
function initializeUnsavedTracking(originalData) {
    // Deep copy the original data
    unsavedChangesData.original = JSON.parse(JSON.stringify(originalData));
    unsavedChangesData.hasChanges = false;
}

/**
 * Check if current data differs from original and update unsaved flag
 * @param {object} currentData - Current data object to compare
 * @returns {boolean} True if there are unsaved changes
 */
function checkUnsavedChanges(currentData) {
    if (!unsavedChangesData.original) {
        console.warn('initializeUnsavedTracking() must be called first');
        return false;
    }
    
    const hasChanges = !deepEqual(unsavedChangesData.original, currentData);
    unsavedChangesData.hasChanges = hasChanges;
    return hasChanges;
}

/**
 * Get current unsaved changes flag
 * @returns {boolean} True if there are unsaved changes
 */
function hasUnsavedChanges() {
    return unsavedChangesData.hasChanges;
}

/**
 * Get array of field names that have changed
 * @param {object} currentData - Current data to compare
 * @returns {array} Array of field names that differ from original
 */
function getChangedFields(currentData) {
    if (!unsavedChangesData.original) return [];
    
    const changed = [];
    const allKeys = new Set([
        ...Object.keys(unsavedChangesData.original),
        ...Object.keys(currentData || {})
    ]);
    
    for (let key of allKeys) {
        if (!deepEqual(unsavedChangesData.original[key], currentData?.[key])) {
            changed.push(key);
        }
    }
    
    return changed;
}

/**
 * Clear unsaved changes flag (call after successful save)
 */
function clearUnsavedChanges() {
    unsavedChangesData.hasChanges = false;
}

/**
 * Reset form to original values (call on discard)
 * Note: This resets the tracking data, caller must reset form fields
 */
function resetUnsavedChangesTracking() {
    if (unsavedChangesData.original) {
        initializeUnsavedTracking(unsavedChangesData.original);
    }
}

/**
 * Show a status banner notification (non-blocking, auto-dismisses)
 * @param {string} message - Message to display
 * @param {string} type - Type: 'success', 'error', 'info', 'warning'
 * @param {string} containerId - ID of container element (default: 'statusMessage')
 * @param {number} duration - How long to show in ms (default: 5000)
 */
function showStatusBanner(message, type = 'info', containerId = 'statusMessage', duration = 5000, persistTime = null, clickAction = null) {
    // Inject CSS on first call
    if (!document.getElementById('statusBannerStyles')) {
        const style = document.createElement('style');
        style.id = 'statusBannerStyles';
        style.textContent = `
            .status-message {
                padding: 12px 15px;
                border-radius: 6px;
                margin-bottom: 15px;
                font-size: 13px;
                display: none;
            }
            
            .status-message.active {
                display: block;
            }
            
            .status-message.status-success {
                background: rgba(76, 175, 80, 0.15);
                border: 1px solid #4caf50;
                color: #4caf50;
            }
            
            .status-message.status-error {
                background: rgba(184, 36, 47, 0.15);
                border: 1px solid #b8242f;
                color: #b8242f;
            }
            
            .status-message.status-info {
                background: rgba(87, 112, 213, 0.15);
                border: 1px solid #5770d5;
                color: #5770d5;
            }
            
            .status-message.status-warning {
                background: rgba(184, 154, 63, 0.15);
                border: 1px solid #b89a3f;
                color: #b89a3f;
            }
        `;
        document.head.appendChild(style);
    }
    
    const container = document.getElementById(containerId);
    
    if (!container) {
        console.warn(`Status message container with ID "${containerId}" not found`);
        return;
    }
    
    // Set message and styling
    container.textContent = message;
    container.className = `status-message active status-${type}`;
    
    // Add click handler if clickAction is provided or if banner is persistent
    if (clickAction || persistTime === Infinity) {
        container.style.cursor = 'pointer';
        container.style.textDecoration = 'underline';
        
        // Handle click
        container.onclick = () => {
            if (clickAction) {
                // Execute custom action
                if (typeof clickAction === 'function') {
                    clickAction();
                }
            } else {
                // Default behavior: hide banner
                container.classList.remove('active');
            }
        };
    }
    
    // Auto-hide after duration. If persistTime is Infinity, banner stays visible indefinitely
    // If persistTime is null or not provided, default to 2 seconds
    const hideDelay = persistTime === Infinity ? null : (persistTime ?? 2000);
    
    if (hideDelay !== null) {
        setTimeout(() => {
            container.classList.remove('active');
        }, hideDelay);
    }
}

/**
 * Hide status banner
 * @param {string} containerId - ID of container element (default: 'statusMessage')
 */
function hideStatusBanner(containerId = 'statusMessage') {
    const container = document.getElementById(containerId);
    if (container) {
        container.classList.remove('active');
    }
}

/**
 * Show a generic form modal
 * @param {string} title - Modal title
 * @param {array} fields - Form fields: {name, type, value, placeholder, rows, monospace, required}
 * @param {Function} onSave - Callback with (formData) object
 */
function showFormModal(title, fields, onSave, readOnly = false, resizable = false, suppressBodyScroll = false, submitButtonLabel = 'Save') {
    let formHtml = '';
    let buttonHandlers = {};
    
    fields.forEach(field => {
        // Handle section headers
        if (field.type === 'section') {
            let sectionStyle = "margin-top: 20px; margin-bottom: 10px; font-weight: 600; color: var(--text-primary); font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;";
            let sectionAttrs = '';
            if (field.pluginTypes) {
                sectionStyle += " display: none;";
                sectionAttrs = ` data-plugin-types="${field.pluginTypes.join(',')}"`;
            }
            formHtml += `<div style="${sectionStyle}"${sectionAttrs}>${field.label}</div>`;
            return;
        }
        
        // Handle buttons
        if (field.type === 'button') {
            if (field.onClick) {
                buttonHandlers[field.name] = field.onClick;
            }
            
            // Build wrapper for button with optional conditional visibility
            let buttonWrapperAttrs = `id="field_wrapper_${field.name}" style="`;
            if (field.authTypes || field.pluginTypes) {
                buttonWrapperAttrs += ` display: none;`;
            }
            buttonWrapperAttrs += `"`;
            if (field.authTypes) {
                buttonWrapperAttrs += ` data-auth-types="${field.authTypes.join(',')}"`;
            }
            if (field.pluginTypes) {
                buttonWrapperAttrs += ` data-plugin-types="${field.pluginTypes.join(',')}"`;
            }
            
            formHtml += `<div ${buttonWrapperAttrs}>`;
            formHtml += `<button type="button" class="btn" data-color="blue" id="btn_${field.name}" style="width: 100%; margin-bottom: 10px;">${field.buttonText || field.label}</button>`;
            formHtml += `</div>`;
            return;
        }
        
        // Build wrapper div with optional data attributes for conditional visibility
        let wrapperAttrs = `id="field_wrapper_${field.name}" style="`;
        
        // For custom editors, make them fill available space
        if (field.type === 'custom:jinja-editor' || field.type === 'custom:json-editor') {
            wrapperAttrs += `flex: 1; display: flex; flex-direction: column; min-height: 0;`;
        }
        
        if (field.authTypes || field.pluginTypes) {
            wrapperAttrs += ` display: none;`;
        }
        wrapperAttrs += `"`;
        if (field.authTypes) {
            wrapperAttrs += ` data-auth-types="${field.authTypes.join(',')}"`;
        }
        if (field.pluginTypes) {
            wrapperAttrs += ` data-plugin-types="${field.pluginTypes.join(',')}"`;
        }
        
        formHtml += `<div ${wrapperAttrs}>`;
        
        // Handle custom headers
        if (field.type === 'custom:headers') {
            formHtml += `<label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 8px; font-weight: 600;">${field.label}</label>`;
            formHtml += `<div id="field_${field.name}" style="display: flex; flex-direction: column; gap: 8px;"></div>`;
            formHtml += `<button type="button" class="btn" data-color="blue" data-size="sm" onclick="addHeaderRow('field_${field.name}')" style="margin-top: 8px;">Add Header</button>`;
            formHtml += `</div>`;
            return;
        }

        // Handle dynamic dictionary (key-value pairs)
        if (field.type === 'custom:dynamic-dict') {
            formHtml += `<label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 8px; font-weight: 600;">${field.label}</label>`;
            formHtml += `<button type="button" class="btn" data-color="green" data-size="sm" style="margin-bottom: 10px; width: 100%;" onclick="addDictEntry('field_${field.name}')">Add Parameter</button>`;
            formHtml += `<div id="field_${field.name}" style="display: flex; flex-direction: column; gap: 8px;"></div>`;
            formHtml += `</div>`;
            return;
        }

        // Handle dynamic list (array of objects)
        if (field.type === 'custom:dynamic-list') {
            formHtml += `<label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 8px; font-weight: 600;">${field.label}</label>`;
            formHtml += `<button type="button" class="btn" data-color="green" data-size="sm" style="margin-bottom: 10px; width: 100%;" onclick="addListEntry('field_${field.name}')">Add Item</button>`;
            formHtml += `<div id="field_${field.name}" style="display: flex; flex-direction: column; gap: 8px;"></div>`;
            formHtml += `</div>`;
            return;
        }
        
        // Handle Jinja editor
        if (field.type === 'custom:jinja-editor') {
            const containerStyle = field.containerStyle || 'width: 100%; height: 300px; border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden;';
            formHtml += `<div id="field_${field.name}" style="${containerStyle}"></div>`;
            formHtml += `</div>`;
            return;
        }
        
        // Handle JSON editor
        if (field.type === 'custom:json-editor') {
            const containerStyle = field.containerStyle || 'width: 100%; height: 300px; border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden;';
            formHtml += `<div id="field_${field.name}" style="${containerStyle}"></div>`;
            formHtml += `</div>`;
            return;
        }
        
        // Add label for all field types except checkbox
        if (field.type !== 'checkbox') {
            formHtml += `<label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">${field.label}${field.required ? ' *' : ''}</label>`;
        }
        
        if (field.type === 'textarea') {
            formHtml += `<textarea id="field_${field.name}" placeholder="${field.placeholder || ''}" style="width: 100%; height: ${field.rows ? field.rows * 20 : 100}px; font-family: ${field.monospace ? 'monospace' : 'inherit'}; resize: vertical;">${escapeHtml(field.value || '')}</textarea>`;
        } else if (field.type === 'checkbox') {
            formHtml += `<div style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="field_${field.name}" ${field.checked ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;">
                <label for="field_${field.name}" style="color: var(--text-muted); font-size: 11px; cursor: pointer; margin: 0;">${field.label}</label>
            </div>`;
        } else if (field.type === 'select') {
            formHtml += `<select id="field_${field.name}" style="width: 100%;">`;
            if (field.options) {
                field.options.forEach(option => {
                    formHtml += `<option value="${option}" ${field.value === option ? 'selected' : ''}>${option}</option>`;
                });
            }
            formHtml += `</select>`;
        } else {
            formHtml += `<input type="${field.type || 'text'}" id="field_${field.name}" placeholder="${field.placeholder || ''}" value="${escapeHtml(field.value || '')}" style="width: 100%;">`;
        }
        
        formHtml += `</div>`;
    });
    
    showModal({
        title: title,
        content: `<div style="display: flex; flex-direction: column; height: 100%; gap: 0;">${formHtml}</div>`,
        closeOnBackdrop: false,  // Forms shouldn't close on backdrop click
        resizable: resizable,
        suppressBodyScroll: suppressBodyScroll,
        buttons: readOnly ? [
            { label: 'Close', type: 'secondary', onClick: () => {} }
        ] : [
            { label: 'Cancel', type: 'secondary', onClick: () => {} },
            { 
                label: submitButtonLabel, 
                type: 'success', 
                onClick: async () => {
                    const formData = {};
                    fields.forEach(field => {
                        if (field.type === 'section' || field.type === 'button') return;
                        
                        const element = document.getElementById(`field_${field.name}`);
                        if (!element) return;
                        
                        if (field.type === 'checkbox') {
                            formData[field.name] = element.checked;
                        } else if (field.type === 'custom:headers') {
                            formData[field.name] = [];
                        } else if (field.type === 'custom:jinja-editor') {
                            // Get value from CodeMirror editor
                            if (window._jinjaEditors && window._jinjaEditors[`field_${field.name}`]) {
                                formData[field.name] = window._jinjaEditors[`field_${field.name}`].state.doc.toString();
                            } else {
                                formData[field.name] = field.value || '';
                            }
                        } else if (field.type === 'custom:json-editor') {
                            // Get value from CodeMirror editor
                            if (window._jsonEditors && window._jsonEditors[`field_${field.name}`]) {
                                formData[field.name] = window._jsonEditors[`field_${field.name}`].state.doc.toString();
                            } else {
                                formData[field.name] = field.value || '';
                            }
                        } else {
                            formData[field.name] = element.value;
                        }
                    });
                    if (onSave) {
                        let result = onSave(formData);
                        // Wait for async functions (Promises), using the resolved
                        // value below - see the matching fix in showModal's own
                        // button handler for why this reassignment matters.
                        if (result instanceof Promise) {
                            result = await result;
                        }
                        return result;
                    }
                }
            }
        ]
    });
    
    // Attach button click handlers
    Object.keys(buttonHandlers).forEach(buttonName => {
        const btn = document.getElementById(`btn_${buttonName}`);
        if (btn) {
            btn.addEventListener('click', buttonHandlers[buttonName]);
        }
    });
    
    // Initialize Jinja editors
    if (!window._jinjaEditors) {
        window._jinjaEditors = {};
    }
    if (!window._jsonEditors) {
        window._jsonEditors = {};
    }
    
    setTimeout(() => {
        fields.forEach(field => {
            if (field.type === 'custom:jinja-editor') {
                const containerId = `field_${field.name}`;
                if (document.getElementById(containerId) && typeof createJinjaEditor === 'function') {
                    createJinjaEditor(containerId, field.value || '').then(editor => {
                        window._jinjaEditors[containerId] = editor;
                    });
                }
            } else if (field.type === 'custom:json-editor') {
                const containerId = `field_${field.name}`;
                if (document.getElementById(containerId) && typeof createJsonEditor === 'function') {
                    createJsonEditor(containerId, field.value || '').then(editor => {
                        window._jsonEditors[containerId] = editor;
                    });
                }
            }
        });
    }, 100);
    
    // Add event listener for conditional field visibility
    const authTypeSelect = document.getElementById('field_authType');
    const pluginTypeSelect = document.getElementById('field_pluginType');
    
    // Combined visibility update function that handles both authTypes and pluginTypes
    const updateAllConditionalFields = () => {
        const selectedAuth = authTypeSelect ? authTypeSelect.value : '';
        const selectedType = pluginTypeSelect ? pluginTypeSelect.value : '';
        
        document.querySelectorAll('[data-auth-types], [data-plugin-types]').forEach(wrapper => {
            let shouldShow = true;
            
            // Check authTypes condition
            if (wrapper.hasAttribute('data-auth-types')) {
                const authTypes = wrapper.getAttribute('data-auth-types').split(',');
                shouldShow = shouldShow && authTypes.includes(selectedAuth);
            }
            
            // Check pluginTypes condition
            if (wrapper.hasAttribute('data-plugin-types')) {
                const pluginTypes = wrapper.getAttribute('data-plugin-types').split(',');
                shouldShow = shouldShow && selectedType && pluginTypes.includes(selectedType);
            }
            
            wrapper.style.display = shouldShow ? 'block' : 'none';
        });
    };
    
    // Set up event listeners for both selects
    if (authTypeSelect) {
        authTypeSelect.addEventListener('change', updateAllConditionalFields);
    }
    
    if (pluginTypeSelect) {
        pluginTypeSelect.addEventListener('change', updateAllConditionalFields);
    }
    
    // Call once on initial load
    updateAllConditionalFields();
}

function addHeaderRow(containerId) {
    const container = document.getElementById(containerId);
    const rowId = 'header_' + Date.now();
    const row = document.createElement('div');
    row.id = rowId;
    row.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    row.innerHTML = `
        <input type="text" placeholder="Header name" style="flex: 1; padding: 6px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px;">
        <input type="text" placeholder="Header value" style="flex: 2; padding: 6px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px;">
        <button type="button" class="btn" data-color="red" data-size="sm" onclick="document.getElementById('${rowId}').remove()">Remove</button>
    `;
    container.appendChild(row);
}

/**
 * Switch between tabs
 * @param {string} tabName - ID of the tab panel to show
 * @param {Event} event - The click event from the tab button
 */
function switchTab(tabName, event) {
    event.preventDefault();

    // Optional page-level gating: a page can set window.__tabGate to a map
    // of { tabPanelId: boolean } (see settings.js's applySettingsTabGating)
    // to block switching into a tab the current user isn't permitted to
    // see - covers direct switchTab(...) calls (like the General tab's own
    // onclick) that don't go through a page-specific wrapper function.
    // Pages that never set __tabGate get switchTab's original, ungated
    // behavior.
    if (window.__tabGate && window.__tabGate[tabName] === false) {
        console.warn(`[switchTab] Blocked switch to disallowed tab: ${tabName}`);
        return;
    }

    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    document.getElementById(tabName).classList.add('active');
    event.target.classList.add('active');
}

/**
 * Escape HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} Escaped text safe for HTML
 */
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

function escapeSql(value) {
    if (value === null || value === undefined) return '';

    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "''");
}

/**
 * Get organization stack (system integrations) from kore database
 * @param {string} sessionToken - Session token
 * @param {string} user - Current user
 * @param {number} orgId - Organization ID
 * @returns {Object|null} org_stack row or null if not found
 */
async function getOrgStack(sessionToken, user, orgId) {
    // NOTE: org_stack table is deprecated post-Rewst. Stack data now lives in kore_data.orgs.stack (JSON column).
    try {
        const result = await executeSqlQuery(
            sessionToken,
            user,
            'kore_sys',
            `SELECT stack FROM kore_data.orgs WHERE org_id = ${orgId}`
        );
        if (!result.result || result.result.length === 0) return {};
        const raw = result.result[0].stack;
        if (!raw) return {};
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
        console.error('Error fetching org stack:', error);
        return {};
    }
}

/**
 * Get a user's tech-stack mapping (kore_sys.users.stack, JSON column) -
 * mirrors getOrgStack above. userId is a string (UUID), unlike org_id, so
 * it's quoted/escaped rather than interpolated as a bare number.
 */
async function getUserStack(sessionToken, user, targetUserId) {
    try {
        const escapedUserId = String(targetUserId).replace(/'/g, "''");
        const result = await executeSqlQuery(
            sessionToken,
            user,
            'kore_sys',
            `SELECT stack FROM kore_sys.users WHERE userId = '${escapedUserId}'`
        );
        if (!result.result || result.result.length === 0) return {};
        const raw = result.result[0].stack;
        if (!raw) return {};
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
        console.error('Error fetching user stack:', error);
        return {};
    }
}

/**
 * Setup unsaved changes protection for page navigation (reload/close/navigate away)
 * Shows the unsaved modal if user has unsaved changes
 * @param {function} onSaveCallback - Async function to call when user chooses to save
 * @param {function} onDiscardCallback - Function to call when user chooses to discard
 */
function setupPageUnsavedChangesProtection(onSaveCallback, onDiscardCallback) {
    // For out-of-page navigation (refresh, close tab, etc.), just let the browser
    // show its native dialog. The modal is handled by in-page navigation instead.
    window.addEventListener('beforeunload', (event) => {
        if (window.hasUnsavedChanges()) {
            // Let the browser show its native dialog for out-of-page navigation
            event.preventDefault();
            event.returnValue = '';
        }
    });
}

/**
 * Get all stack type options for a given category (e.g. 'RMM', 'PSA',
 * 'Control', 'RPA', 'BDR', 'SEC') from the unified kore_data.stack_types
 * table (type_id, category, name). Replaces the old one-table-per-category
 * design (stack_rmm, stack_psa, etc.) now that all categories share a
 * single table distinguished by the category column.
 */
async function getStackTypes(sessionToken, user, category) {
    try {
        const escapedCategory = String(category).replace(/'/g, "''");
        const result = await executeSqlQuery(
            sessionToken,
            user,
            'kore_sys',
            `SELECT type_id, category, name FROM kore_data.stack_types WHERE category = '${escapedCategory}' ORDER BY name`
        );
        return result.result || [];
    } catch (error) {
        console.error(`Error fetching ${category} stack types:`, error);
        return [];
    }
}

/**
 * Send email via SMTP endpoint
 * @param {string} sessionToken - Session token for authentication
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} html - HTML body (optional)
 * @param {string} plainText - Plain text body (optional)
 * @param {string} from - Sender email address (optional)
 * @param {string} cc - CC email address (optional)
 * @param {string} bcc - BCC email address (optional)
 * @param {string} profile - Email profile (default: "default")
 * @returns {Promise<Object>} API response
 */
async function emailSmtp(sessionToken, to, subject, html = null, plainText = null, from = null, cc = null, bcc = null, profile = 'default') {
    try {
        const payload = {
            profile,
            to,
            subject
        };

        // Add optional fields only if provided
        if (html) payload.html = html;
        if (plainText) payload.plainText = plainText;
        if (from) payload.from = from;
        if (cc) payload.cc = cc;
        if (bcc) payload.bcc = bcc;

        const response = await fetch('/kore/email/smtp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            let errorMessage = `SMTP request failed with status ${response.status}`;
            try {
                // Read the response body once
                const responseText = await response.text();
                
                // Try to parse as JSON first
                try {
                    const errorData = JSON.parse(responseText);
                    if (errorData.error) {
                        // The error field may contain full PowerShell output, extract meaningful part
                        const errorStr = errorData.error;
                        
                        // Look for quoted text starting with "The SMTP"
                        const match = errorStr.match(/"(The SMTP[^"]*?)"/);
                        if (match && match[1]) {
                            errorMessage = match[1].trim();
                        } else {
                            // Fallback: use the full error from the field
                            errorMessage = errorStr;
                        }
                    } else if (errorData.message) {
                        errorMessage = errorData.message;
                    }
                } catch (jsonError) {
                    // Response is plain text, extract meaningful error
                    if (responseText) {
                        // Look for quoted text starting with "The SMTP"
                        const match = responseText.match(/"(The SMTP[^"]*?)"/);
                        if (match && match[1]) {
                            errorMessage = match[1].trim();
                        }
                    }
                }
            } catch (e) {
                console.error('Error parsing response:', e);
            }
            throw new Error(errorMessage);
        }

        return await response.json();
    } catch (error) {
        console.error('Error sending email via SMTP:', error);
        throw error;
    }
}

/**
 * Logout - clear session and redirect to login
 */
async function logout() {
    try {
        // Legacy cleanup: kore_userId is no longer written or read (identity
        // comes from the session), but browsers that logged in before that
        // change still hold a stale copy. Clearing it here sweeps it out as
        // people log out; it can be dropped once no live browser could
        // plausibly still have one.
        localStorage.removeItem('kore_userId');
        
        // Call logout endpoint to clear the session cookie
        const response = await fetch('/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        // Redirect to login regardless of response
        window.location.href = '/login';
    } catch (err) {
        // Even if logout fails, redirect to login
        console.error('Logout error:', err.message);
        window.location.href = '/login';
    }
}

// ============================================================================
// USER PREFERENCES FUNCTIONS
// ============================================================================

/**
 * Default user preferences
 */
const DEFAULT_USER_PREFERENCES = {
    notifications: {
        login_alerts: false,
        password_change_alerts: false,
        security_alerts: false,
        system_updates: false,
        frequency: 'immediate'
    },
    ui: {
        theme: 'default',
        sidebar_collapsed: false
    }
};

/**
 * The current user, resolved server-side from the session cookie.
 *
 * REVIEW PHASE 2. Replaces the previous approach of reading
 * localStorage.kore_userId and interpolating it into a SQL string sent to
 * /sqlquery. That made the browser the authority on its own identity, which
 * meant (a) the value could be edited from the console, and it went straight
 * into a WHERE clause, and (b) it could silently drift from the real session -
 * which it did, when the forced-password-change path stored an email in that
 * key and every identity-dependent call started failing or targeting nothing.
 *
 * Cached for the life of the page load. Identity cannot change without a
 * navigation, and several callers (header, dashboard, permission checks) each
 * want it once - a single in-flight promise keeps that to one request rather
 * than a burst of identical ones. Cache the PROMISE, not the result, so
 * concurrent callers during the initial load share the same request.
 */
let _currentUserPromise = null;

async function getCurrentUser(forceRefresh = false) {
    if (_currentUserPromise && !forceRefresh) return _currentUserPromise;

    _currentUserPromise = (async () => {
        const response = await fetch('/auth/me', { credentials: 'same-origin' });
        if (!response.ok) {
            // Clear the cache so a later call can retry rather than being
            // stuck on a rejected promise for the rest of the page's life.
            _currentUserPromise = null;
            throw new Error(response.status === 401
                ? 'Not authenticated'
                : `Failed to load current user: HTTP ${response.status}`);
        }
        return response.json();
    })();

    return _currentUserPromise;
}

/**
 * Get current user's profile data (email, full name)
 *
 * Kept as a thin wrapper over getCurrentUser() because existing callers
 * destructure the snake_case shape it has always returned. New code should
 * call getCurrentUser() directly. The sessionToken parameter is ignored - it
 * was never used for identity even before this change.
 */
async function getCurrentUserData(sessionToken) {
    try {
        const user = await getCurrentUser();
        return {
            user_id: user.userId,
            email: user.email,
            full_name: user.fullName
        };
    } catch (error) {
        console.error('Error fetching current user data:', error);
        throw error;
    }
}

/**
 * Get user notification preferences with defaults
 *
 * PHASE 2: reads from /auth/me rather than a SQL lookup keyed on a
 * client-supplied userId. The userId parameter is retained for call
 * compatibility but ignored - this only ever returned the CURRENT user's
 * preferences in practice, and taking the id from the caller meant a browser
 * could request anyone's.
 */
async function getUserNotificationPreferences(sessionToken, userId) {
    try {
        const user = await getCurrentUser();
        const preferences = user.preferences || {};
        return preferences.notifications || DEFAULT_USER_PREFERENCES.notifications;
    } catch (error) {
        console.error('Error fetching user notification preferences:', error);
        return DEFAULT_USER_PREFERENCES.notifications;
    }
}

/**
 * Update user profile (email and full name)
 */
async function updateUserProfile(sessionToken, userId, data) {
    try {
        // PHASE 2: the userId parameter is ignored - the server takes identity
        // from the session. It previously chose the target row, so a browser
        // could rewrite another user's name and email.
        const response = await fetch('/auth/me/profile', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName: data.full_name,
                email: data.email
            })
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `Profile update failed: HTTP ${response.status}`);
        }

        // Identity just changed on the server; drop the cached copy so the next
        // getCurrentUser() reflects it rather than serving a stale name/email.
        _currentUserPromise = null;

        return result.success === true;
    } catch (error) {
        console.error('Error updating user profile:', error);
        throw error;
    }
}

/**
 * Change user password
 */
async function changeUserPassword(sessionToken, userId, data) {
    try {
        const response = await fetch('https://app.equinoxits.com:1139/auth/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({
                userId: userId,
                currentPassword: data.current_password,
                newPassword: data.new_password
            })
        });

        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.error || 'Password change failed');
        }

        return result.success === true;
    } catch (error) {
        console.error('Error changing password:', error);
        throw error;
    }
}

/**
 * Update user notification preferences
 */
async function updateUserNotificationPreferences(sessionToken, userId, preferences) {
    try {
        // PHASE 2: the read-modify-write cycle is gone - the server merges with
        // JSON_MERGE_PATCH, so two tabs editing different preference keys no
        // longer clobber each other. Only the notifications sub-object is sent;
        // everything else in preferences (shortcuts, dashboard_layout) is left
        // untouched by the merge rather than being round-tripped through the
        // client, which is how a stale read used to wipe concurrent changes.
        const current = await getCurrentUser();
        const currentNotifications = (current.preferences && current.preferences.notifications) || {};

        const response = await fetch('/auth/me/preferences', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                notifications: { ...currentNotifications, ...preferences },
                updated_at: new Date().toISOString()
            })
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `Preferences update failed: HTTP ${response.status}`);
        }

        _currentUserPromise = null;

        return result.success === true;
    } catch (error) {
        console.error('Error updating notification preferences:', error);
        throw error;
    }
}

/**
 * Resize a modal container to fit its content, up to 95% of viewport height
 * Enables scrolling on modal-body-content if content exceeds available space
 * @param {string} modalSelector - CSS selector for the modal container (default: '.modal-container')
 * @param {string} contentSelector - CSS selector for the content div (default: '#modal-body-content')
 */
function resizeModalToContent(modalSelector = '.modal-container', contentSelector = '#modal-body-content') {
    const modal = document.querySelector(modalSelector);
    const modalBody = document.querySelector('.modal-body');
    const modalBodyContent = document.querySelector(contentSelector);
    
    if (modal && modalBodyContent) {
        const viewportHeight = window.innerHeight;
        const maxModalHeight = viewportHeight * 0.90;
        
        // Temporarily remove scrolling to get true content height
        if (modalBody) {
            modalBody.style.overflowY = 'visible';
            modalBody.style.maxHeight = 'none';
        }
        
        // Measure true content height
        const contentHeight = modalBodyContent.scrollHeight;
        
        // Calculate modal header/footer overhead - add extra buffer
        const overhead = 130;
        const desiredHeight = contentHeight + overhead;
        
        // Set modal height - capped at 90vh
        const finalHeight = Math.min(desiredHeight, maxModalHeight);
        modal.style.height = `${finalHeight}px`;
        modal.style.minHeight = 'auto';
        
        // Now check if scrolling is needed based on actual content vs max allowed
        if (desiredHeight > maxModalHeight) {
            const maxContentHeight = maxModalHeight - overhead;
            if (modalBody) {
                modalBody.style.overflowY = 'auto';
                modalBody.style.maxHeight = `${maxContentHeight}px`;
            }
        }
    }
}

/**
 * Render a hierarchical tree structure
 * @param {Array} items - Array of items with id, name, parent_id, and optional children
 * @param {HTMLElement} container - Container element to render the tree into
 * @param {Object} options - Configuration options
 * @param {Function} options.onItemClick - Callback when an item is clicked
 * @param {String} options.containerClass - CSS class of the container for deselecting siblings (default: '.panel-level-3')
 */
function renderTree(items, container, options = {}) {
    if (!items || items.length === 0) {
        container.innerHTML = '<div style="display: flex; align-items: center; padding: 0; color: var(--text-secondary); font-size: 0.9rem; height: 20px; margin: 0;"><span style="width: 20px;"></span><span>No items</span></div>';
        return;
    }
    const itemMap = {};
    items.forEach(item => {
        itemMap[item.id] = { ...item, children: [] };
    });
    const rootItems = [];
    items.forEach(item => {
        if (item.parent_id && itemMap[item.parent_id]) {
            itemMap[item.parent_id].children.push(itemMap[item.id]);
        } else {
            rootItems.push(itemMap[item.id]);
        }
    });
    const sortItems = (arr) => arr.sort((a, b) => a.name.localeCompare(b.name));
    sortItems(rootItems);
    items.forEach(item => {
        if (itemMap[item.id].children) {
            sortItems(itemMap[item.id].children);
        }
    });
    container.innerHTML = '';
    const treeContainer = document.createElement('div');
    rootItems.forEach((item, index) => {
        const isLast = index === rootItems.length - 1;
        treeContainer.appendChild(createTreeNode(item, 0, isLast, [], options));
    });
    container.appendChild(treeContainer);
}

/**
 * Create a tree node element recursively
 * @param {Object} item - Item to create node for
 * @param {Number} level - Depth level in the tree
 * @param {Boolean} isLastChild - Whether this is the last child of its parent
 * @param {Array} ancestorSiblingInfo - Info about ancestor siblings for tree lines
 * @param {Object} options - Configuration options (same as renderTree)
 * @returns {HTMLElement} The created node element
 */
function createTreeNode(item, level = 0, isLastChild = true, ancestorSiblingInfo = [], options = {}) {
    const nodeContainer = document.createElement('div');
    nodeContainer.style.cssText = 'margin-bottom: 0px;';
    const folderRow = document.createElement('div');
    folderRow.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0;
        color: var(--text-dim);
        font-size: 0.9rem;
        user-select: none;
        box-sizing: border-box;
        height: 20px;
    `;
    const hasChildren = item.children && item.children.length > 0;
    const toggleBtn = document.createElement('span');
    toggleBtn.style.cssText = `
        display: flex;
        align-items: flex-start;
        justify-content: center;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        font-size: 1.1rem;
        color: var(--text-dim);
        line-height: 1;
        padding: 0;
        margin: 0;
        margin-top: 0;
        cursor: ${hasChildren ? 'pointer' : 'default'};
    `;
    toggleBtn.innerHTML = hasChildren ? '&#43;' : '';
    folderRow.appendChild(toggleBtn);
    const childrenContainer = document.createElement('div');
    childrenContainer.style.cssText = 'display: none;';
    const isExpanded = { state: false };
    const toggleChildren = () => {
        isExpanded.state = !isExpanded.state;
        if (isExpanded.state) {
            childrenContainer.style.display = 'block';
            toggleBtn.innerHTML = '&#45;';
        } else {
            childrenContainer.style.display = 'none';
            toggleBtn.innerHTML = '&#43;';
        }
    };
    const itemName = document.createElement('span');
    itemName.style.cssText = `flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.8rem; margin: 0; display: flex; align-items: center; color: var(--text-primary); cursor: pointer;`;
    if (level > 1) {
        for (let i = 1; i < level; i++) {
            const ancestorBox = document.createElement('span');
            ancestorBox.style.cssText = `width: 16px; display: inline-flex; align-items: flex-start; justify-content: center; flex-shrink: 0; font-size: 1rem; line-height: 1.2; margin: 0; padding: 0 0 0 1px; border: 0; color: var(--text-dim); pointer-events: none; transform: scaleX(0.7) scaleY(1.1) translateX(-1px);`;
            const ancestorHasSiblings = ancestorSiblingInfo[i - 1] || false;
            const char = ancestorHasSiblings ? String.fromCharCode(9474) : ' ';
            ancestorBox.appendChild(document.createTextNode(char));
            itemName.appendChild(ancestorBox);
        }
    }
    if (level > 0) {
        const connectorBox = document.createElement('span');
        connectorBox.style.cssText = `width: 16px; display: inline-flex; align-items: flex-start; justify-content: center; flex-shrink: 0; font-size: 1rem; line-height: 1.2; margin: 0; padding: 0; border: 0; color: var(--text-dim); pointer-events: none;`;
        const treeChar = isLastChild ? String.fromCharCode(9492) : String.fromCharCode(9500);
        connectorBox.appendChild(document.createTextNode(treeChar));
        itemName.appendChild(connectorBox);
    }
    const nameText = document.createElement('span');
    nameText.textContent = item.name;
    if (item.id === 'none') {
        nameText.style.fontStyle = 'italic';
    }
    itemName.appendChild(nameText);
    folderRow.appendChild(itemName);
    folderRow.setAttribute('data-item-id', item.id);
    folderRow.style.cssText += '; border-radius: 4px; transition: background-color 0.2s; margin: 0 4px;';
    folderRow.onmouseenter = () => {
        if (!folderRow.classList.contains('selected')) {
            folderRow.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
        }
    };
    folderRow.onmouseleave = () => {
        if (!folderRow.classList.contains('selected')) {
            folderRow.style.backgroundColor = '';
        }
    };
    if (hasChildren) {
        toggleBtn.style.cursor = 'pointer';
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            toggleChildren();
        };
    }
    itemName.onclick = (e) => {
        e.stopPropagation();
        if (options.onItemClick) {
            options.onItemClick(item);
        }
        const containerSelector = options.containerClass || '.panel-level-3';
        const listContainer = folderRow.closest(containerSelector);
        if (listContainer) {
            listContainer.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
            });
        }
        folderRow.classList.add('selected');
        folderRow.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
    };
    nodeContainer.appendChild(folderRow);
    if (hasChildren) {
        item.children.forEach((child, index) => {
            const childIsLast = index === item.children.length - 1;
            const newAncestorInfo = [...ancestorSiblingInfo];
            newAncestorInfo[level - 1] = !isLastChild;
            childrenContainer.appendChild(createTreeNode(child, level + 1, childIsLast, newAncestorInfo, options));
        });
        nodeContainer.appendChild(childrenContainer);
    }
    return nodeContainer;
}

/**
 * Load allowedIPs for a resource from any table
 * @param {string} table - Table name (e.g., 'web_pages')
 * @param {string} idColumn - ID column name (e.g., 'path')
 * @param {string} idValue - The ID value (e.g., '/workflows')
 * @returns {Promise<Array>} - Array of allowed IPs
 */
async function loadAllowedIPs(table, idColumn, idValue) {
    try {
        const params = new URLSearchParams({
            table: table,
            idColumn: idColumn,
            id: idValue
        });

        const response = await fetch(`/kore/allowed-ips?${params}`, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `Failed to load allowed IPs: ${response.status}`);
        }

        const data = await response.json();
        return data.allowedIPs || [];
    } catch (error) {
        console.error('Error loading allowed IPs:', error);
        throw error;
    }
}

/**
 * Fetch available whitelist categories from system
 * @returns {Promise<Array>} - Array of whitelist category names
 */
async function getAvailableWhitelists() {
    try {
        const response = await fetch('/kore/whitelists', {
            method: 'GET',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            console.warn('Failed to fetch whitelists:', response.status);
            return [];
        }

        const data = await response.json();
        return data.whitelists || [];
    } catch (error) {
        console.error('Error fetching whitelists:', error);
        return [];
    }
}

/**
 * Humanize whitelist category name (e.g., "internal" → "Internal")
 */
function humanizeWhitelistName(category) {
    return category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * Helper function to add an IP input field
 */
function addIPField(container, ipValue = '') {
    const fieldDiv = document.createElement('div');
    fieldDiv.style.cssText = 'display: flex; gap: 6px; align-items: center;';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ip-input';
    input.value = ipValue;
    input.placeholder = 'e.g., 192.168.1.0/24 or 10.0.0.5';
    input.style.cssText = `
        flex: 1;
        padding: 6px 8px;
        border: 1px solid var(--border-primary);
        border-radius: 4px;
        background-color: var(--bg-input);
        color: var(--text-primary);
        font-family: monospace;
        font-size: 12px;
        box-sizing: border-box;
    `;

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'btn';
    deleteBtn.setAttribute('data-color', 'red');
    deleteBtn.setAttribute('data-size', 'sm');
    deleteBtn.style.cssText = 'flex: 0 0 auto; width: 60px;';
    deleteBtn.onclick = () => fieldDiv.remove();

    fieldDiv.appendChild(input);
    fieldDiv.appendChild(deleteBtn);
    container.appendChild(fieldDiv);
}

/**
 * Display allowedIPs form for editing IP restrictions
 * @param {HTMLElement} container - Container to populate with the form
 * @param {string} table - Table name (e.g., 'web_pages')
 * @param {string} idColumn - ID column name (e.g., 'path')
 * @param {string} idValue - The ID value (e.g., '/workflows')
 * @param {Object} options - Configuration options
 * @param {Function} options.onSave - Callback function when save button is clicked
 * @param {Boolean} options.showButtons - Whether to show Save/Cancel buttons (default: true)
 * @param {Boolean} options.showSeparator - Whether to show separator at top (default: false)
 */
async function displayAllowedIPsForm(container, table, idColumn, idValue, options = {}) {
    // Clear container
    container.innerHTML = '';

    try {
        // Load current allowedIPs
        let currentIPs = [];
        try {
            currentIPs = await loadAllowedIPs(table, idColumn, idValue);
        } catch (err) {
            console.warn('Could not load current allowedIPs:', err);
        }

        // Separate whitelists from direct IPs
        const whitelistRefs = [];
        const directIPs = [];
        
        for (const item of currentIPs) {
            if (typeof item === 'string' && item.startsWith('whitelist.')) {
                whitelistRefs.push(item);
            } else {
                directIPs.push(item);
            }
        }

        // Get available whitelists
        const availableWhitelists = await getAvailableWhitelists();

        // Create form container
        const formWrapper = document.createElement('div');
        formWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 16px;';

        // Add separator at top if requested
        const showSeparator = options.showSeparator === true;
        if (showSeparator) {
            const separator = document.createElement('div');
            separator.style.cssText = 'height: 1px; background-color: var(--border-primary);';
            formWrapper.appendChild(separator);
        }

        // ===== WHITELISTS SECTION =====
        if (availableWhitelists.length > 0) {
            const whitelistSection = document.createElement('div');
            whitelistSection.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';

            const whitelistLabel = document.createElement('label');
            whitelistLabel.style.cssText = 'color: var(--text-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;';
            whitelistLabel.textContent = 'IP Whitelists';
            whitelistSection.appendChild(whitelistLabel);

            const whitelistsContainer = document.createElement('div');
            whitelistsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px; padding-left: 8px;';

            for (const category of availableWhitelists) {
                const whitelistKey = `whitelist.${category}`;
                const isChecked = whitelistRefs.includes(whitelistKey);

                const checkboxDiv = document.createElement('div');
                checkboxDiv.style.cssText = 'display: flex; align-items: center; gap: 8px;';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `whitelist_${category}`;
                checkbox.checked = isChecked;
                checkbox.className = 'whitelist-checkbox';
                checkbox.dataset.category = category;
                checkbox.style.cssText = 'width: 16px; height: 16px; cursor: pointer;';

                const label = document.createElement('label');
                label.htmlFor = `whitelist_${category}`;
                label.textContent = `${humanizeWhitelistName(category)} Whitelist`;
                label.style.cssText = 'color: var(--text-primary); font-size: 12px; cursor: pointer; margin: 0;';

                checkboxDiv.appendChild(checkbox);
                checkboxDiv.appendChild(label);
                whitelistsContainer.appendChild(checkboxDiv);
            }

            whitelistSection.appendChild(whitelistsContainer);
            formWrapper.appendChild(whitelistSection);
        }

        // ===== IP ADDRESSES SECTION =====
        const ipSection = document.createElement('div');
        ipSection.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';

        // Create header row with label and Add button
        const ipHeaderRow = document.createElement('div');
        ipHeaderRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 12px;';

        const ipLabel = document.createElement('label');
        ipLabel.style.cssText = 'color: var(--text-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin: 0;';
        ipLabel.textContent = 'Allowed IPs / CIDR Ranges';
        ipHeaderRow.appendChild(ipLabel);

        // Add button
        const addBtn = document.createElement('button');
        addBtn.textContent = 'Add IP Address';
        addBtn.className = 'btn';
        addBtn.setAttribute('data-color', 'blue');
        addBtn.setAttribute('data-size', 'sm');
        ipHeaderRow.appendChild(addBtn);
        
        ipSection.appendChild(ipHeaderRow);

        const ipsContainer = document.createElement('div');
        ipsContainer.id = 'ipsContainer';
        ipsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

        // Add existing IPs
        for (const ip of directIPs) {
            addIPField(ipsContainer, ip);
        }

        // Add button click handler
        addBtn.onclick = () => addIPField(ipsContainer, '');

        ipSection.appendChild(ipsContainer);
        formWrapper.appendChild(ipSection);

        // ===== BUTTONS SECTION (Optional) =====
        const showButtons = options.showButtons !== false; // Default to true
        
        if (showButtons) {
            const buttonWrapper = document.createElement('div');
            buttonWrapper.style.cssText = 'display: flex; gap: 8px; margin-top: 8px;';

            // Save button
            const saveBtn = document.createElement('button');
            saveBtn.textContent = 'Save';
            saveBtn.className = 'btn';
            saveBtn.setAttribute('data-color', 'green');
            saveBtn.setAttribute('data-size', 'sm');
            saveBtn.style.cssText = 'flex: 1;';
            saveBtn.onclick = async () => {
                try {
                    // Collect whitelists
                    const selectedWhitelists = Array.from(document.querySelectorAll('.whitelist-checkbox:checked'))
                        .map(cb => `whitelist.${cb.dataset.category}`);

                    // Collect IPs
                    const ips = Array.from(ipsContainer.querySelectorAll('.ip-input'))
                        .map(input => input.value.trim())
                        .filter(ip => ip.length > 0);

                    // Combine
                    const allIPs = [...selectedWhitelists, ...ips];

                    // Save to backend
                    await saveAllowedIPs(table, idColumn, idValue, allIPs);

                    if (options.onSave) {
                        options.onSave();
                    }
                } catch (err) {
                    console.error('Error saving allowed IPs:', err);
                    alert('Error saving allowed IPs: ' + err.message);
                }
            };
            buttonWrapper.appendChild(saveBtn);

            // Cancel button
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.className = 'btn';
            cancelBtn.setAttribute('data-color', 'gray');
            cancelBtn.setAttribute('data-size', 'sm');
            cancelBtn.style.cssText = 'flex: 1;';
            cancelBtn.onclick = () => {
                // Reload the form
                displayAllowedIPsForm(container, table, idColumn, idValue, options);
            };
            buttonWrapper.appendChild(cancelBtn);

            formWrapper.appendChild(buttonWrapper);
        }

        container.appendChild(formWrapper);

    } catch (error) {
        console.error('Error displaying allowedIPs form:', error);
        container.innerHTML = `<p style="color: var(--text-error); font-size: 12px;">Error loading form: ${error.message}</p>`;
    }
}

/**
 * Save allowedIPs for a resource to any table
 * @param {string} table - Table name (e.g., 'web_pages')
 * @param {string} idColumn - ID column name (e.g., 'path')
 * @param {string} idValue - The ID value (e.g., '/workflows')
 * @param {Array} allowedIPs - Array of IP addresses/whitelist references
 * @returns {Promise<Object>} - Response from server
 */
async function saveAllowedIPs(table, idColumn, idValue, allowedIPs) {
    try {
        const response = await fetch('/kore/allowed-ips', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                table: table,
                idColumn: idColumn,
                id: idValue,
                allowedIPs: allowedIPs
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `Failed to save allowed IPs: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Error saving allowed IPs:', error);
        throw error;
    }
}

/**
 * Check whether the CURRENT user has a specific permission.
 * Supports checking by: permissionId, or resource+action, or resource+action+scope
 *
 * PHASE 2: no longer takes or sends a userId. The subject is the session user,
 * resolved server-side. Previously the caller supplied it - which meant the
 * browser named the subject of its own permission check, and every call site
 * had to first obtain an id from localStorage. Callers may still pass a userId
 * property; it is ignored here and by the server.
 *
 * @param {Object} checkParams - Parameters for the permission check
 * @param {String} [checkParams.permissionId] - Permission ID (alternative to resource+action)
 * @param {String} [checkParams.resource] - Resource type (e.g., 'workflow', 'page')
 * @param {String} [checkParams.action] - Action type (e.g., 'view', 'edit', 'delete', '*')
 * @param {String} [checkParams.scope] - Resource scope/ID (optional, for resource+action checks)
 * @returns {Promise<Boolean>} - True if the current user has permission, false otherwise
 */
async function checkUserPermission(checkParams) {
    try {
        const payload = {};
        
        // Support either permissionId or resource+action
        if (checkParams.permissionId) {
            payload.permissionId = checkParams.permissionId;
        } else if (checkParams.resource && checkParams.action) {
            payload.resource = checkParams.resource;
            payload.action = checkParams.action;
            if (checkParams.scope) {
                payload.scope = checkParams.scope;
            }
        } else {
            throw new Error('Must provide either permissionId or resource+action');
        }
        
        const response = await fetch('/kore/has-permission', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            console.error('Permission check failed:', response.status);
            return false;
        }
        
        const result = await response.json();
        return result.hasPermission === true;
    } catch (error) {
        console.error('Error checking permission:', error);
        return false;
    }
}

/**
 * Batched version of checkUserPermission - evaluates many resource/action/
 * scope checks for the CURRENT user in one request, instead of one round trip
 * per check. Use this whenever more than one permission needs checking at
 * once (e.g. gating several tabs on page load) rather than calling
 * checkUserPermission() in a loop.
 *
 * PHASE 2: the userId parameter is retained for call compatibility but is no
 * longer sent - the server answers for the session user. See
 * checkUserPermission() above.
 *
 * @param {String} [userId] - Ignored; the subject is the session user
 * @param {Array<{resource: String, action: String, scope: String}>} checks
 * @returns {Promise<Object>} - Map keyed by scope (or resource if scope is
 *   omitted/null) to a boolean, e.g. { general: true, users: false }.
 *   Suited to the common case where every check shares the same
 *   resource+action and only scope varies; for mixed resource/action
 *   batches, key collisions on scope are possible - inspect the raw
 *   `results` array in that case instead.
 */
async function checkUserPermissions(userId, checks) {
    const emptyMap = {};
    if (!Array.isArray(checks) || checks.length === 0) return emptyMap;

    try {
        const response = await fetch('/kore/has-permission', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checks })
        });

        if (!response.ok) {
            console.error('Batch permission check failed:', response.status);
            return emptyMap;
        }

        const result = await response.json();
        const results = Array.isArray(result.results) ? result.results : [];

        const byScope = {};
        for (const r of results) {
            const key = (r.scope === null || r.scope === undefined) ? r.resource : r.scope;
            byScope[key] = r.hasPermission === true;
        }
        return byScope;
    } catch (error) {
        console.error('Error checking batch permissions:', error);
        return emptyMap;
    }
}

/**
 * Create a permission form row with target/effect selects and a Delete button
 * Reusable for any resource that needs permission management
 * @param {HTMLElement} container - Container to append the row to
 * @param {Boolean} isNew - True for new permissions (removes the row outright on click), false for existing (marks the row for deletion on save - see savePermissionsForResource)
 * @param {Object} permissionData - Existing permission data {permissionId, targetType, targetId, targetName, effect}
 */
function createPermissionRow(container, isNew, permissionData = null, actions = null) {
    const row = document.createElement('div');
    row.className = 'permission-row';
    row.style.cssText = 'display: flex; gap: 8px; align-items: center; flex-wrap: nowrap;';

    const { users, groups } = window.allUsersAndGroups || { users: [], groups: [] };
    
    if (permissionData) {
        console.log('Creating permission row with data:', permissionData);
        console.log('Available users:', users);
        console.log('Available groups:', groups);
    }

    // Target dropdown
    const targetSelect = document.createElement('select');
    targetSelect.className = 'permission-target';
    targetSelect.style.cssText = 'flex: 1; min-width: 150px;';
    targetSelect.innerHTML = '<option value="">Select Group or User...</option>';

    groups.forEach(group => {
        const option = document.createElement('option');
        option.value = `group:${group.groupId}`;
        option.textContent = `Group: ${group.name}`;
        if (permissionData && permissionData.targetType === 'group' && permissionData.targetId === group.groupId) {
            option.selected = true;
        }
        targetSelect.appendChild(option);
    });

    users.forEach(user => {
        const option = document.createElement('option');
        option.value = `user:${user.userId}`;
        option.textContent = `User: ${user.fullName}`;
        if (permissionData && permissionData.targetType === 'user' && permissionData.targetId === user.userId) {
            option.selected = true;
        }
        targetSelect.appendChild(option);
    });

    // Action dropdown (if actions are specified)
    let actionSelect = null;
    if (actions && Array.isArray(actions) && actions.length > 0) {
        actionSelect = document.createElement('select');
        actionSelect.className = 'permission-action';
        actionSelect.style.cssText = 'flex: 0 0 auto; width: 100px;';
        actionSelect.innerHTML = '';

        // Only offer "Full" if the caller's actions list actually includes
        // the '*' wildcard - this is meant to mirror whether '*' is in the
        // resource's own catalog-declared validActions (see settings.js's
        // getValidActionsFor), not to be added unconditionally. Resources
        // like 'settings' and 'page' only declare ["view"] with no '*', so
        // they must not get a Full option here.
        const hasWildcard = actions.includes('*');
        if (hasWildcard) {
            const fullOption = document.createElement('option');
            fullOption.value = '*';
            fullOption.textContent = 'Full';
            actionSelect.appendChild(fullOption);
        }

        // Add individual actions (excluding '*' itself, which is rendered
        // as the "Full" option above, not as its own literal entry)
        actions.filter(action => action !== '*').forEach(action => {
            const option = document.createElement('option');
            option.value = action;
            option.textContent = action.charAt(0).toUpperCase() + action.slice(1);
            actionSelect.appendChild(option);
        });

        if (permissionData && permissionData.action) {
            actionSelect.value = permissionData.action;
        } else if (actions.length > 0) {
            actionSelect.value = actions.find(a => a !== '*') || '*';
        }
    }

    // Effect dropdown
    const effectSelect = document.createElement('select');
    effectSelect.className = 'permission-effect';
    effectSelect.style.cssText = 'flex: 0 0 auto; width: 100px;';
    effectSelect.innerHTML = '<option value="allow">Allow</option><option value="deny">Deny</option>';
    if (permissionData) {
        effectSelect.value = permissionData.effect;
    }

    // Delete button
    let actionBtn = null;
    if (isNew) {
        // New, unsaved row - removes it from the DOM outright, nothing to submit
        actionBtn = document.createElement('button');
        actionBtn.textContent = 'Delete';
        actionBtn.className = 'btn';
        actionBtn.setAttribute('data-color', 'red');
        actionBtn.setAttribute('data-size', 'sm');
        actionBtn.style.cssText = 'flex: 0 0 auto; width: 48px;';
        actionBtn.onclick = () => {
            row.remove();
        };
    } else if (permissionData) {
        // Existing row - marks for deletion on save rather than removing
        // immediately, since the actual row still exists server-side until
        // the save request goes through. dataset.revoke is an internal
        // field name only (checked by savePermissionsForResource) - not
        // renamed alongside the visible label since it's not user-facing.
        actionBtn = document.createElement('button');
        actionBtn.textContent = 'Delete';
        actionBtn.className = 'btn';
        actionBtn.setAttribute('data-color', 'red');
        actionBtn.setAttribute('data-size', 'sm');
        actionBtn.style.cssText = 'flex: 0 0 auto; width: 48px;';
        actionBtn.onclick = () => {
            row.dataset.revoke = 'true';
            row.style.opacity = '0.5';
            row.style.textDecoration = 'line-through';
            actionBtn.disabled = true;
        };
    }

    // Store permission ID if editing
    if (permissionData) {
        row.dataset.permissionId = permissionData.permissionId;
        row.dataset.isNew = 'false';
    } else {
        row.dataset.isNew = 'true';
    }

    row.appendChild(targetSelect);
    if (actionSelect) row.appendChild(actionSelect);
    row.appendChild(effectSelect);
    if (actionBtn) row.appendChild(actionBtn);

    container.appendChild(row);
}

/**
 * Load permissions for a resource from the backend
 * @param {Object} config - Configuration object
 * @param {String} config.resource - Resource type (e.g., 'page', 'workflow')
 * @param {String} config.endpoint - API endpoint (e.g., '/kore/permissions')
 * @param {String} [config.method] - HTTP method (default: 'GET')
 * @param {Object} [config.body] - Request body for POST/PUT requests (optional, used for scoped queries)
 * @returns {Promise<Object>} - Permissions data from the API
 */
async function loadPermissionsForResource(config) {
    try {
        const method = config.method || 'GET';
        
        const options = {
            method: method,
            headers: { 'Content-Type': 'application/json' }
        };
        
        // Add body if provided (for POST requests with scope)
        if (config.body) {
            options.body = JSON.stringify(config.body);
        }
        
        console.log('loadPermissionsForResource:', {
            endpoint: config.endpoint,
            method: method,
            body: config.body
        });
        
        const response = await fetch(config.endpoint, options);

        if (!response.ok) {
            throw new Error(`Failed to load ${config.resource} permissions: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error(`Error loading ${config.resource} permissions:`, error);
        throw error;
    }
}

/**
 * Display a permissions management form in a container
 * Assumes window.allUsersAndGroups is already loaded with users and groups
 * @param {HTMLElement} container - Container element to populate with the form
 * @param {Array} existingPermissions - Array of existing permission objects
 * @param {Object} options - Configuration options
 * @param {String} options.addButtonLabel - Label for the "Add" button
 * @param {String} options.saveButtonLabel - Label for the "Save" button
 * @param {Boolean} options.showSaveButton - Whether to show the Save button (default: true)
 * @param {Function} options.onSave - Callback function when save button is clicked
 */
function displayPermissionsForm(container, existingPermissions, options = {}) {
    // Clear container
    container.innerHTML = '';

    // Create Add button
    const addBtn = document.createElement('button');
    addBtn.textContent = options.addButtonLabel || 'Add Permission';
    addBtn.className = 'btn';
    addBtn.setAttribute('data-color', 'blue');
    addBtn.setAttribute('data-size', 'sm');
    addBtn.style.cssText = 'align-self: flex-end;';

    // Create wrapper for buttons if needed
    const buttonWrapper = document.createElement('div');
    buttonWrapper.style.cssText = 'display: flex; justify-content: flex-end; margin-bottom: 10px;';
    buttonWrapper.appendChild(addBtn);

    // Create permissions rows container
    const permissionsContainer = document.createElement('div');
    permissionsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;';

    // Wire up Add button - pass actions if specified
    addBtn.onclick = () => createPermissionRow(permissionsContainer, true, null, options.actions);

    // Add existing permission rows
    existingPermissions.forEach(perm => {
        createPermissionRow(permissionsContainer, false, perm, options.actions);
    });

    // Create Save button only if requested
    let saveBtn = null;
    if (options.showSaveButton !== false) {
        saveBtn = document.createElement('button');
        saveBtn.textContent = options.saveButtonLabel || 'Save Permissions';
        saveBtn.className = 'btn';
        saveBtn.setAttribute('data-color', 'green');
        saveBtn.setAttribute('data-size', 'sm');

        if (options.onSave) {
            saveBtn.onclick = options.onSave;
        }
    }

    // Assemble the form
    container.appendChild(buttonWrapper);
    container.appendChild(permissionsContainer);
    if (saveBtn) container.appendChild(saveBtn);
}

/**
 * Save permissions for a resource (batch insert/update/delete)
 * Collects permission rows from the DOM, batches changes, and sends to API
 * @param {Object} config - Configuration object
 * @param {String} config.resource - Resource type (e.g., 'page', 'workflow')
 * @param {String} config.endpoint - API endpoint (e.g., '/kore/permissions')
 * @param {String|Number} itemId - The scope/item ID being modified
 * @param {HTMLElement|Document} [container=document] - Element to scope the
 *   `.permission-row` lookup to. Defaults to the whole document for
 *   backward compatibility, but callers should pass the specific form's
 *   container - tab panels are hidden via CSS, not removed from the DOM,
 *   so an unscoped document-wide query can pick up stale rows left behind
 *   in a different (currently hidden) permissions form and submit them
 *   under the wrong resource/scope.
 * @returns {Promise<Object>} - Response from the API
 */
async function savePermissionsForResource(config, itemId, container = document) {
    try {
        const sessionToken = await getSessionToken();
        const permissionRows = container.querySelectorAll('.permission-row');
        const inserts = [];
        const updates = [];
        const deletes = [];

        // Collect permission changes from form rows
        permissionRows.forEach(row => {
            const targetValue = row.querySelector('.permission-target').value;
            const effect = row.querySelector('.permission-effect').value;
            const actionElement = row.querySelector('.permission-action');
            const action = actionElement ? actionElement.value : null;
            const [targetType, targetId] = targetValue.split(':');

            if (!targetValue) return; // Skip empty rows

            const permData = {
                targetType,
                targetId,
                effect,
                scope: itemId
            };
            
            // Add action if it exists
            if (action) {
                permData.action = action;
            }

            if (row.dataset.revoke === 'true') {
                // Permission marked for revocation
                deletes.push(row.dataset.permissionId);
            } else if (row.dataset.isNew === 'true') {
                // New permission to insert
                inserts.push(permData);
            } else {
                // Existing permission to update
                permData.permissionId = row.dataset.permissionId;
                updates.push(permData);
            }
        });

        // Build payload
        const payload = {
            resource: config.resource,
            inserts,
            updates,
            deletes
        };

        // Send to API
        const response = await fetch(config.endpoint, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `Failed to save ${config.resource} permissions: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error(`Error saving ${config.resource} permissions:`, error);
        throw error;
    }
}

/**
 * Resolve a user or group ID to its display name
 */
function resolveIdToName(id) {
    if (!id) return 'Unknown';
    
    if (!window.allUsersAndGroups) {
        return id; // Return ID if data not loaded
    }
    
    // Try to find in users
    const user = window.allUsersAndGroups.users?.find(u => u.userId === id);
    if (user) return user.fullName;
    
    // Try to find in groups
    const group = window.allUsersAndGroups.groups?.find(g => g.groupId === id);
    if (group) return group.name;
    
    return id; // Return ID if not found
}

/**
 * Load all users and groups for mapping IDs to names
 */
async function loadAllUsersAndGroupsForModal() {
    try {
        const sessionToken = await getSessionToken();

        const [users, groups] = await Promise.all([
            getUsers(sessionToken, null),
            getGroups(sessionToken, null)
        ]);

        window.allUsersAndGroups = {
            users: users || [],
            groups: groups || []
        };
        return true;
    } catch (error) {
        console.error('Error loading users and groups:', error);
        window.allUsersAndGroups = { users: [], groups: [] };
        return false;
    }
}

/**
 * Build folder panel and load folders from API
 */
function buildWorkflowFoldersPanel(containerId, folderTableName, itemsTableName, renderFunctionName) {
    const apiUrl = `https://app.equinoxits.com:1139/kore/${folderTableName}`;
    if (!renderFunctionName) {
        renderFunctionName = `renderFiltered${itemsTableName.charAt(0).toUpperCase() + itemsTableName.slice(1)}`;
    }
    return fetch(apiUrl, {
        method: 'GET',
        headers: { 
            'Content-Type': 'application/json'
        },
        credentials: 'include'  // Send cookies for session authentication
    })
    .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    })
    .then(data => {
        const folders = data.folders || [];
        window[`${itemsTableName}_folders`] = folders;
        buildFoldersPanel(
            containerId,
            folders,
            (folder) => onFolderSelectedGeneric(folder, itemsTableName, renderFunctionName),
            (folderId, updates, onReload) => performEditFolderGeneric(folderTableName, folderId, updates, onReload),
            (folderId, onReload) => performDeleteFolderGeneric(folderTableName, folderId, itemsTableName, onReload),
            () => openCreateFolderModalGeneric(folderTableName, folders, (folder) => onFolderSelectedGeneric(folder, itemsTableName, renderFunctionName), () => buildWorkflowFoldersPanel(containerId, folderTableName, itemsTableName, renderFunctionName)),
            () => buildWorkflowFoldersPanel(containerId, folderTableName, itemsTableName, renderFunctionName)
        );
    })
    .catch(error => console.error('Error loading folders:', error));
}

/**
 * Handle folder selection
 */
function onFolderSelectedGeneric(folder, itemsTableName, renderFunctionName) {
    window.currentSelectedFolder = folder;
    const items = window[itemsTableName] || [];
    console.log(`onFolderSelectedGeneric: folder=${folder.id}, itemsTableName=${itemsTableName}, items.length=${items.length}`);
    console.log(`window[${itemsTableName}]:`, window[itemsTableName]);
    let filteredItems = [];
    if (folder.id === 'all') {
        filteredItems = items;
    } else if (folder.id === 'no_folder') {
        filteredItems = items.filter(item => !item.folder_id);
    } else {
        filteredItems = items.filter(item => item.folder_id === folder.id);
    }
    console.log(`Filtered items for folder ${folder.id}:`, filteredItems);
    if (typeof window[renderFunctionName] === 'function') {
        console.log(`Calling ${renderFunctionName} with ${filteredItems.length} items`);
        window[renderFunctionName](filteredItems);
    } else {
        console.error(`Render function ${renderFunctionName} not found`);
    }
}

/**
 * Edit a folder
 */
async function performEditFolderGeneric(folderTableName, folderId, updates, onReload) {
    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/${folderTableName}/${folderId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updates)
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        showStatusBanner('Folder updated successfully', 'success');
        if (onReload) onReload();
    } catch (error) {
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to update folder: ${error.message}`
        });
    }
}

/**
 * Delete a folder
 */
async function performDeleteFolderGeneric(folderTableName, folderId, itemsTableName, onReload) {
    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/${folderTableName}/${folderId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        showStatusBanner('Folder deleted successfully', 'success');
        if (onReload) onReload();
        const reloadFunction = `load${itemsTableName.charAt(0).toUpperCase() + itemsTableName.slice(1)}`;
        if (typeof window[reloadFunction] === 'function') {
            window[reloadFunction]();
        }
    } catch (error) {
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to delete folder: ${error.message}`
        });
    }
}

/**
 * Build the folder sidebar panel UI
 */
function buildFoldersPanel(containerId, folders, onFolderSelect, onEditFolder, onDeleteFolder, onCreateFolder, onReloadFolders) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`buildFoldersPanel: Container "${containerId}" not found`);
        return;
    }
    container.innerHTML = '';
    container.style.cssText = 'display: flex; flex-direction: column; gap: 10px; height: 100%;';
    const headerBar = document.createElement('div');
    headerBar.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 10px;';
    const title = document.createElement('h3');
    title.textContent = 'Folders';
    title.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 0.95rem; flex: 1;';
    headerBar.appendChild(title);
    const actionsBar = document.createElement('div');
    actionsBar.style.cssText = 'display: flex; gap: 4px;';
    const editBtn = document.createElement('button');
    editBtn.id = 'editFolderBtn';
    editBtn.className = 'btn btn-small btn-grey';
    editBtn.innerHTML = '&#9998;';
    editBtn.disabled = true;
    editBtn.style.cssText = 'width: 22px; height: 22px; padding: 0; margin: 0; display: flex; align-items: flex-start; justify-content: center; padding-top: 2px;';
    editBtn.onclick = () => {
        const folder = window.folderPanelCurrentSelected;
        if (folder && folder.id !== 'all' && folder.id !== 'no_folder') {
            showFolderEditModal(folder, folders, onEditFolder, onDeleteFolder, onReloadFolders);
        }
    };
    actionsBar.appendChild(editBtn);
    const createBtn = document.createElement('button');
    createBtn.id = 'createFolderBtn';
    createBtn.className = 'btn btn-small';
    createBtn.setAttribute('data-color', 'green');
    createBtn.innerHTML = '<strong style="font-size: 1.1rem; position: relative; top: 1px;">+</strong>';
    createBtn.style.cssText = 'width: 22px; height: 22px; padding: 0; margin: 0 0 0 0; display: flex; align-items: center; justify-content: center; line-height: 0;';
    createBtn.onclick = () => onCreateFolder();
    actionsBar.appendChild(createBtn);
    headerBar.appendChild(actionsBar);
    container.appendChild(headerBar);
    const listContainer = document.createElement('div');
    listContainer.className = 'panel-level-3';
    listContainer.style.cssText = 'flex: 1; overflow-y: auto; padding: 0;';
    window.folderManagementEditBtn = editBtn;
    const allItem = document.createElement('div');
    allItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px; height: 20px; font-size: 0.8rem; margin: 4px 4px 0 4px;';
    allItem.setAttribute('data-item-id', 'all');
    const allText = document.createElement('span');
    allText.textContent = 'All';
    allText.style.cssText = 'font-style: italic; color: var(--text-primary); font-weight: bold;';
    allItem.appendChild(allText);
    allItem.onmouseenter = () => {
        if (!allItem.classList.contains('selected')) {
            allItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
        }
    };
    allItem.onmouseleave = () => {
        if (!allItem.classList.contains('selected')) {
            allItem.style.backgroundColor = '';
        }
    };
    allItem.onclick = () => {
        selectFolderInList(listContainer, allItem, { id: 'all', name: 'All' }, onFolderSelect);
    };
    listContainer.appendChild(allItem);
    const divider1 = document.createElement('div');
    divider1.style.cssText = 'height: 1px; background: var(--border-primary); margin: 4px 0;';
    listContainer.appendChild(divider1);
    const treeContainer = document.createElement('div');
    renderTree(folders, treeContainer, {
        onItemClick: (folder) => {
            listContainer.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
            });
            window.folderPanelCurrentSelected = folder;
            const editBtn = window.folderManagementEditBtn;
            if (editBtn) {
                const canEdit = folder.id !== 'all' && folder.id !== 'no_folder';
                editBtn.disabled = !canEdit;
                editBtn.style.opacity = canEdit ? '1' : '0.5';
                editBtn.style.cursor = canEdit ? 'pointer' : 'not-allowed';
            }
            onFolderSelect(folder);
        }
    });
    listContainer.appendChild(treeContainer);
    const divider2 = document.createElement('div');
    divider2.style.cssText = 'height: 1px; background: var(--border-primary); margin: 4px 0;';
    listContainer.appendChild(divider2);
    const noFolderItem = document.createElement('div');
    noFolderItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px; height: 20px; font-size: 0.8rem; margin: 0 4px 4px 4px;';
    noFolderItem.setAttribute('data-item-id', 'no_folder');
    const noFolderText = document.createElement('span');
    noFolderText.textContent = 'No Folder';
    noFolderText.style.cssText = 'font-style: italic; color: var(--text-primary); font-weight: bold;';
    noFolderItem.appendChild(noFolderText);
    noFolderItem.onmouseenter = () => {
        if (!noFolderItem.classList.contains('selected')) {
            noFolderItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
        }
    };
    noFolderItem.onmouseleave = () => {
        if (!noFolderItem.classList.contains('selected')) {
            noFolderItem.style.backgroundColor = '';
        }
    };
    noFolderItem.onclick = () => {
        selectFolderInList(listContainer, noFolderItem, { id: 'no_folder', name: 'No Folder' }, onFolderSelect);
    };
    listContainer.appendChild(noFolderItem);
    container.appendChild(listContainer);
    const allFolder = { id: 'all', name: 'All' };
    selectFolderInList(listContainer, allItem, allFolder, onFolderSelect);
}

/**
 * Select a folder in the list
 */
function selectFolderInList(listContainer, itemElement, folder, onFolderSelect) {
    listContainer.querySelectorAll('[data-item-id]').forEach(el => {
        el.classList.remove('selected');
        el.style.backgroundColor = '';
    });
    if (itemElement) {
        itemElement.classList.add('selected');
        itemElement.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
    }
    window.folderPanelCurrentSelected = folder;
    const editBtn = window.folderManagementEditBtn;
    if (editBtn) {
        const canEdit = folder.id !== 'all' && folder.id !== 'no_folder';
        editBtn.disabled = !canEdit;
        editBtn.style.opacity = canEdit ? '1' : '0.5';
        editBtn.style.cursor = canEdit ? 'pointer' : 'not-allowed';
    }
    if (onFolderSelect) {
        onFolderSelect(folder);
    }
}

/**
 * Show modal for editing a folder
 */
function showFolderEditModal(folder, folders, onSave, onDelete, onReload) {
    if (!folder || folder.id === 'all' || folder.id === 'no_folder') {
        return;
    }
    const folderId = folder.id;
    const folderName = folder.name;
    const currentParentId = folder.parent_id || null;
    showModal({
        type: 'custom',
        title: `Edit Folder`,
        content: `
            <div style="display: flex; flex-direction: column; gap: 15px;">
                <div>
                    <label style="display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 0.9rem;">Folder Name</label>
                    <input type="text" id="editFolderNameInput" value="${folderName}" style="width: 100%; padding: 8px; background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 4px; color: var(--text-primary); box-sizing: border-box;">
                </div>
                <div>
                    <label style="display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 0.9rem;">Parent Folder</label>
                    <div id="editFolderParentTree" style="background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 4px; padding: 8px; height: 200px; overflow-y: auto;"></div>
                </div>
            </div>
        `,
        buttons: [
            {
                label: 'Cancel',
                type: 'secondary',
                onClick: () => {}
            },
            {
                label: 'Save',
                type: 'success',
                onClick: () => {
                    const newName = document.getElementById('editFolderNameInput').value.trim();
                    const newParentId = window.editFolderSelectedParent;
                    if (!newName) {
                        showModal({
                            title: 'Error',
                            content: 'Folder name cannot be empty'
                        });
                        return;
                    }
                    const updates = { name: newName };
                    if (newParentId !== undefined) {
                        updates.parent_id = newParentId;
                    }
                    onSave(folderId, updates, onReload);
                }
            }
        ],
        customWidth: '500px',
        customMinWidth: '300px'
    });
    const modalHeader = document.querySelector('.modal-header');
    if (modalHeader) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn';
        deleteBtn.setAttribute('data-color', 'red');
        deleteBtn.textContent = 'Delete';
        deleteBtn.style.cssText = 'position: absolute; right: 16px; top: 50%; transform: translateY(-50%); padding: 6px 12px;';
        deleteBtn.onclick = () => {
            window.editFolderDeleteCallback && window.editFolderDeleteCallback();
        };
        modalHeader.style.position = 'relative';
        modalHeader.appendChild(deleteBtn);
    }
    window.editFolderDeleteCallback = () => {
        showDeleteConfirm(
            `Are you sure you want to delete "${folder.name}"?${folder.children && folder.children.length > 0 ? ' Its subfolders will be moved to the root level.' : ' Workflows in this folder will be moved to "No Folder".'}`,
            () => {
                onDelete(folderId, onReload);
                closeModal(); // Close confirm modal
                closeModal(); // Close Edit Folder modal
            }
        );
    };
    const treeContainer = document.getElementById('editFolderParentTree');
    if (treeContainer) {
        treeContainer.innerHTML = '';
        const noParentItem = document.createElement('div');
        noParentItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px; height: 20px; font-size: 0.8rem;';
        noParentItem.setAttribute('data-folder-id', 'no_parent');
        const noParentText = document.createElement('span');
        noParentText.textContent = 'No Parent (Root Level)';
        noParentText.style.fontStyle = 'italic';
        noParentText.style.color = 'var(--text-primary)';
        noParentItem.appendChild(noParentText);
        noParentItem.onmouseenter = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
            }
        };
        noParentItem.onmouseleave = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = '';
            }
        };
        noParentItem.onclick = () => {
            treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
            });
            noParentItem.classList.add('selected');
            noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.editFolderSelectedParent = null;
        };
        treeContainer.appendChild(noParentItem);
        const treeDiv = document.createElement('div');
        treeDiv.style.cssText = 'margin: 0 4px;';
        const getDescendantIds = (folderId, foldersList) => {
            const descendants = new Set([folderId]);
            let toProcess = foldersList.filter(f => f.parent_id === folderId);
            while (toProcess.length > 0) {
                const current = toProcess.shift();
                descendants.add(current.id);
                toProcess.push(...foldersList.filter(f => f.parent_id === current.id));
            }
            return descendants;
        };
        const excludeIds = getDescendantIds(folderId, folders || []);
        const filterableFolders = (folders || []).filter(f => !excludeIds.has(f.id));
        renderTree(filterableFolders, treeDiv, {
            onItemClick: (folderItem) => {
                if (excludeIds.has(folderItem.id)) {
                    return;
                }
                window.editFolderSelectedParent = folderItem.id;
                noParentItem.classList.remove('selected');
                noParentItem.style.backgroundColor = '';
                treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                    el.classList.remove('selected');
                    el.style.backgroundColor = '';
                });
                const selectedEl = treeDiv.querySelector(`[data-item-id="${folderItem.id}"]`);
                if (selectedEl) {
                    selectedEl.classList.add('selected');
                    selectedEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                }
            }
        });
        treeContainer.appendChild(treeDiv);
        if (currentParentId) {
            const parentEl = treeDiv.querySelector(`[data-item-id="${currentParentId}"]`);
            if (parentEl) {
                parentEl.classList.add('selected');
                parentEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                window.editFolderSelectedParent = currentParentId;
            }
        } else {
            noParentItem.classList.add('selected');
            noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.editFolderSelectedParent = null;
        }
    }
}

/**
 * Show modal for creating a new folder
 */
function openCreateFolderModalGeneric(folderTableName, folders, onCreated, onReload) {
    showModal({
        type: 'custom',
        title: 'Create New Folder',
        content: `
            <div style="display: flex; flex-direction: column; gap: 15px;">
                <div>
                    <label style="display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 0.9rem;">Folder Name</label>
                    <input type="text" id="createFolderNameInput" placeholder="Enter folder name" style="width: 100%; padding: 8px; background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 4px; color: var(--text-primary); box-sizing: border-box;">
                </div>
                <div>
                    <label style="display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 0.9rem;">Parent Folder</label>
                    <div id="createFolderParentTree" style="background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 4px; padding: 8px; height: 200px; overflow-y: auto;"></div>
                </div>
            </div>
        `,
        buttons: [
            {
                label: 'Cancel',
                type: 'secondary',
                onClick: () => {}
            },
            {
                label: 'Create',
                type: 'success',
                onClick: () => {
                    const folderName = document.getElementById('createFolderNameInput').value.trim();
                    if (!folderName) {
                        showModal({
                            title: 'Error',
                            content: 'Folder name cannot be empty'
                        });
                        return;
                    }
                    performCreateFolderGeneric(folderTableName, folderName, window.createFolderSelectedParent || null, null, onReload);
                }
            }
        ],
        customWidth: '500px',
        customMinWidth: '300px'
    });
    const treeContainer = document.getElementById('createFolderParentTree');
    if (treeContainer) {
        treeContainer.innerHTML = '';
        const noParentItem = document.createElement('div');
        noParentItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px; height: 20px; font-size: 0.8rem;';
        noParentItem.setAttribute('data-folder-id', 'no_parent');
        const noParentText = document.createElement('span');
        noParentText.textContent = 'No Parent (Root Level)';
        noParentText.style.fontStyle = 'italic';
        noParentText.style.color = 'var(--text-primary)';
        noParentItem.appendChild(noParentText);
        noParentItem.onmouseenter = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
            }
        };
        noParentItem.onmouseleave = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = '';
            }
        };
        noParentItem.onclick = () => {
            treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
            });
            noParentItem.classList.add('selected');
            noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.createFolderSelectedParent = null;
        };
        treeContainer.appendChild(noParentItem);
        noParentItem.classList.add('selected');
        noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
        window.createFolderSelectedParent = null;
        const treeDiv = document.createElement('div');
        treeDiv.style.cssText = 'margin: 0 4px;';
        renderTree(folders || [], treeDiv, {
            onItemClick: (folder) => {
                window.createFolderSelectedParent = folder.id;
                noParentItem.classList.remove('selected');
                noParentItem.style.backgroundColor = '';
                treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                    el.classList.remove('selected');
                    el.style.backgroundColor = '';
                });
                const selectedEl = treeDiv.querySelector(`[data-item-id="${folder.id}"]`);
                if (selectedEl) {
                    selectedEl.classList.add('selected');
                    selectedEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                }
            }
        });
        treeContainer.appendChild(treeDiv);
    }
}

/**
 * Create a new folder
 */
async function performCreateFolderGeneric(folderTableName, folderName, parentId, closeModal, onReload) {
    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/${folderTableName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                id: generateUUID(),
                name: folderName,
                parent_id: parentId || null
            })
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        showStatusBanner('Folder created successfully', 'success');
        if (onReload) onReload();
    } catch (error) {
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to create folder: ${error.message}`
        });
    }
}

/**
 * Render a data table with pagination
 * @param {Object} config - Configuration object
 * @param {string} config.containerId - ID of container to render into
 * @param {Array} config.headers - Array of column header strings
 * @param {Array} config.data - Array of row data objects
 * @param {Array} config.columns - Array of column definitions
 *   Each column: { key: string, render: function(value, row) }
 * @param {Object} config.pagination - Pagination config
 *   { currentOffset: number, pageSize: number, total: number, onPageChange: function(offset) }
 * @param {Function} config.onRowClick - Optional callback when row is clicked, receives row data
 */
function renderDataTable(config) {
    const { containerId, headers, data, columns, pagination, onRowClick } = config;
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`Container with id "${containerId}" not found`);
        return;
    }

    // Build table HTML
    let tableHtml = '<table><thead><tr>';
    headers.forEach(header => {
        tableHtml += `<th>${header}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';

    // Render rows
    if (data && data.length > 0) {
        data.forEach((row, idx) => {
            const rowClass = onRowClick ? 'clickable-row' : '';
            const dataAttr = onRowClick ? `data-row-index="${idx}"` : '';
            tableHtml += `<tr class="${rowClass}" ${dataAttr}>`;
            columns.forEach(col => {
                const value = row[col.key];
                const rendered = col.render ? col.render(value, row) : value;
                tableHtml += `<td>${rendered}</td>`;
            });
            tableHtml += '</tr>';
        });
    } else {
        const colSpan = columns.length;
        tableHtml += `<tr><td colspan="${colSpan}" style="text-align: center; padding: 20px; color: var(--text-muted);">No data</td></tr>`;
    }

    tableHtml += '</tbody></table>';
    container.innerHTML = tableHtml;

    // Attach row click handlers
    if (onRowClick && data && data.length > 0) {
        const rows = container.querySelectorAll('tbody tr.clickable-row');
        rows.forEach((tr, idx) => {
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', () => onRowClick(data[idx]));
        });
    }

    // Render pagination if provided
    if (pagination && pagination.total > 0) {
        const { currentOffset, pageSize, total, onPageChange } = pagination;
        const page = Math.floor(currentOffset / pageSize) + 1;
        const end = Math.min(currentOffset + pageSize, total);
        
        const paginationHtml = `
            <div class="pagination-container">
                <button class="pagination-btn" onclick="window._datatable_prevPage()" ${currentOffset === 0 ? 'disabled' : ''}>← Prev</button>
                <span class="pagination-info">Page ${page} (${currentOffset + 1}–${end} of ${total})</span>
                <button class="pagination-btn" onclick="window._datatable_nextPage()" ${currentOffset + pageSize >= total ? 'disabled' : ''}>Next →</button>
            </div>
        `;
        container.insertAdjacentHTML('afterend', paginationHtml);
        
        // Store pagination state in window for button handlers
        window._datatable_state = {
            currentOffset,
            pageSize,
            total,
            onPageChange,
            containerId
        };
    }
}

/**
 * Previous page handler for data tables
 * @private
 */
function _datatable_prevPage() {
    const state = window._datatable_state;
    if (state && state.currentOffset > 0) {
        const newOffset = Math.max(0, state.currentOffset - state.pageSize);
        document.querySelectorAll('.pagination-container').forEach(el => el.remove());
        state.onPageChange(newOffset);
    }
}

/**
 * Next page handler for data tables
 * @private
 */
function _datatable_nextPage() {
    const state = window._datatable_state;
    if (state && state.currentOffset + state.pageSize < state.total) {
        const newOffset = state.currentOffset + state.pageSize;
        document.querySelectorAll('.pagination-container').forEach(el => el.remove());
        state.onPageChange(newOffset);
    }
}

// Expose functions to global scope
window.applySelectArrowColor = applySelectArrowColor;
window.attemptTokenRefresh = attemptTokenRefresh;
window.buildFoldersPanel = buildFoldersPanel;
window.buildKoreHeader = buildKoreHeader;
window.buildNavigationMenu = buildNavigationMenu;
window.buildWorkflowFoldersPanel = buildWorkflowFoldersPanel;
window.changeUserPassword = changeUserPassword;
window.checkUnsavedChanges = checkUnsavedChanges;
window.checkUserPermission = checkUserPermission;
window.checkUserPermissions = checkUserPermissions;
window.clearUnsavedChanges = clearUnsavedChanges;
window.closeModal = closeModal;
window.createPermissionRow = createPermissionRow;
window.createTreeNode = createTreeNode;
window.deepEqual = deepEqual;
window.displayAllowedIPsForm = displayAllowedIPsForm;
window.displayPermissionsForm = displayPermissionsForm;
window.emailSmtp = emailSmtp;
window.escapeHtml = escapeHtml;
window.escapeSql = escapeSql;
window.executeSqlQuery = executeSqlQuery;
window.generateUUID = generateUUID;
window.getAvailableThemes = getAvailableThemes;
window.getAvailableWhitelists = getAvailableWhitelists;
window.getChangedFields = getChangedFields;
window.getCurrentUserData = getCurrentUserData;
window.getCurrentUser = getCurrentUser;
window.getGroups = getGroups;
window.getOrgStack = getOrgStack;
window.getUserStack = getUserStack;
window.getOrganizations = getOrganizations;
window.getStackTypes = getStackTypes;
window.getSecurityConfig = getSecurityConfig;
window.getSessionToken = getSessionToken;
window.getSystemTimezone = getSystemTimezone;
window.getSessionTokenFromCookie = getSessionTokenFromCookie;
window.getUserNotificationPreferences = getUserNotificationPreferences;
window.getUsers = getUsers;
window.hasUnsavedChanges = hasUnsavedChanges;
window.hideStatusBanner = hideStatusBanner;
window.humanizeWhitelistName = humanizeWhitelistName;
window.infoIcon = infoIcon;
window.initializeMultiSelect = initializeMultiSelect;
window.initializeSearchableSelect = initializeSearchableSelect;
window.initializeUnsavedTracking = initializeUnsavedTracking;
window.injectComponentStyles = injectComponentStyles;
window.loadAllUsersAndGroupsForModal = loadAllUsersAndGroupsForModal;
window.loadAllowedIPs = loadAllowedIPs;
window.loadPermissionsForResource = loadPermissionsForResource;
window.logout = logout;
window.onFolderSelectedGeneric = onFolderSelectedGeneric;
window.openCreateFolderModalGeneric = openCreateFolderModalGeneric;
window.performCreateFolderGeneric = performCreateFolderGeneric;
window.performDeleteFolderGeneric = performDeleteFolderGeneric;
window.performEditFolderGeneric = performEditFolderGeneric;
window.renderDataTable = renderDataTable;
window.renderMultiSelectContainer = renderMultiSelectContainer;
window.renderSearchableSelectContainer = renderSearchableSelectContainer;
window.renderTree = renderTree;
window.resetUnsavedChangesTracking = resetUnsavedChangesTracking;
window.resizeModalToContent = resizeModalToContent;
window.resolveIdToName = resolveIdToName;
window.saveAllowedIPs = saveAllowedIPs;
window.savePermissionsForResource = savePermissionsForResource;
window.selectFolderInList = selectFolderInList;
window.setTheme = setTheme;
window.setupPageUnsavedChangesProtection = setupPageUnsavedChangesProtection;
window.showAlert = showAlert;
window.showConfirm = showConfirm;
window.showDeleteConfirm = showDeleteConfirm;
window.showFolderEditModal = showFolderEditModal;
window.showFormModal = showFormModal;
window.showModal = showModal;
window.showStatusBanner = showStatusBanner;
window.showUnsaved = showUnsaved;
window.switchTab = switchTab;
window.updateBodyColors = updateBodyColors;
window.updateHeaderColors = updateHeaderColors;
window.updateUserNotificationPreferences = updateUserNotificationPreferences;
window.updateUserProfile = updateUserProfile;
window._datatable_prevPage = _datatable_prevPage;
window._datatable_nextPage = _datatable_nextPage;