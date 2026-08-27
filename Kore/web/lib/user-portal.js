/**
 * user-portal.js — User Portal-wide client code (loaded on every User
 * Portal page via BASE, the way admin pages load base.js's own header
 * builder). Split out of base.js to keep a clean admin/user separation:
 * this file only ever needs to load on User Portal pages, not admin ones.
 *
 * Depends on base.js (theme system, escapeHtml/getUser/getSessionToken/
 * getCurrentUserData/checkUserPermission/logout — all exposed via
 * window.X there). Importing it here guarantees base.js has finished
 * executing before any of this file's top-level code runs, via the real
 * ES module dependency graph — not document-order timing between two
 * separate <script type="module"> tags.
 */
import '/lib/base.js';

/**
 * Fetches the current user's permission-filtered menu tree from
 * GET /kore/user-menus (see resources.js). Returns [] on any failure so a
 * broken/slow endpoint degrades to "no role menus" rather than breaking the
 * whole header.
 * Shape per node: { id, label, children: [...same shape...], items: [{label, type, resourceId}] }
 *
 * No manual cache here — the response carries Cache-Control: private,
 * max-age=30, so the browser's own HTTP cache dedupes repeat requests
 * (including across tabs/windows in the same profile). A normal reload can
 * be served from that cache; Ctrl+Shift+R forces revalidation, which is why
 * that's still the move while actively testing menu/permission changes.
 */
async function getUserPortalMenus() {
    try {
        const response = await fetch('/kore/user-menus', { method: 'GET', credentials: 'include' });
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        const data = await response.json();
        return data.menus || [];
    } catch (err) {
        console.warn('[UserHeader] Failed to load user menus:', err.message);
        return [];
    }
}

/**
 * Fallback current-user row for the User Portal header/dashboard, used only
 * if the real lookup below fails (e.g. no logged-in user, or the request
 * errors out).
 * MUST stay generic — this previously hardcoded one specific real person's
 * name/email, which meant ANY user hitting the fallback (any auth hiccup,
 * any transient failure) silently saw that person's identity in the header
 * instead of their own. A fallback must never resolve to a specific real
 * identity; genuinely-unknown is the only honest state to show here.
 * No single "role" here on purpose — a user can belong to multiple
 * role menus at once, so there's no one label to show.
 */
const USER_PORTAL_CURRENT_USER_ROW = {
    userId: null,
    email: '',
    fullName: 'User'
};
/**
 * Real current-user fetch for the User Portal, shared by buildUserHeader()
 * and Dashboard.html's greeting so there's exactly one code path to swap out.
 *
 * UPDATED: window.getSessionToken() no longer authenticates via a
 * hardcoded admin credential — base.js now establishes window.sessionToken
 * from the browser's real per-user session cookie at module load, so this
 * reads that directly. The other half of the original TODO still stands
 * though: this still goes through executeSqlQuery()/window.getCurrentUserData()
 * for "who's logged in," the same pattern the rest of the admin data layer
 * uses, rather than a dedicated server-side "who am I" endpoint. This
 * function remains the single call site to update if that lands — nothing
 * else should call window.getCurrentUserData() directly for "who's logged in".
 *
 * Result is cached for the life of the page load (one lookup per page).
 */
let _userPortalUserPromise = null;
async function getCurrentUserPortalUser() {
    if (_userPortalUserPromise) return _userPortalUserPromise;

    _userPortalUserPromise = (async () => {
        try {
            // No localStorage probe: getCurrentUserData() resolves identity
            // from the session server-side, so a stale or missing kore_userId
            // no longer blocks a perfectly valid session (which is exactly
            // what used to push this into the mock-data fallback).
            const data = await window.getCurrentUserData(window.sessionToken);
            if (!data || !data.full_name) throw new Error('No user row returned');

            return { fullName: data.full_name, email: data.email };
        } catch (err) {
            console.warn('[UserPortal] Falling back to mock user data:', err.message);
            return { fullName: USER_PORTAL_CURRENT_USER_ROW.fullName, email: USER_PORTAL_CURRENT_USER_ROW.email };
        }
    })();

    return _userPortalUserPromise;
}

function _userPortalBuildUser(row) {
    const parts = row.fullName.trim().split(/\s+/);
    const initials = (parts[0][0] + (parts[parts.length - 1][0] || '')).toUpperCase();
    return { firstName: parts[0], fullName: row.fullName, initials: initials, email: row.email };
}

/**
 * Real navigation target for a leaf item (a form or datatable).
 * ASSUMPTION pending confirmation: user-facing form/datatable viewer pages
 * live at /forms/:id and /datatables/:id. Adjust here if the real route
 * convention differs — this is the only place that needs to change.
 */
function _userPortalItemHref(item) {
    if (item.type === 'form') return `/form?form_id=${encodeURIComponent(item.resourceId)}`;
    if (item.type === 'datatable') return `/datatable?id=${encodeURIComponent(item.resourceId)}`;
    return '#';
}

function _userPortalLeafItemHTML(item) {
    return `<a href="${_userPortalItemHref(item)}" style="display:block;text-decoration:none;padding:5px 10px;border-radius:6px;font-size:12.5px;color:var(--text-header)">- ${window.escapeHtml(item.label)}</a>`;
}

/**
 * Recursively renders one menu node (and everything nested under it) for
 * either the desktop nav or the mobile panel. Supports arbitrary depth —
 * unlike the old fixed pill -> category -> item shape, a real user_menus
 * tree can nest categories inside categories indefinitely (e.g.
 * NOC/SOC -> Audit -> Backups -> items).
 *
 * Every node already has its own globally-unique id (from user_menus), so
 * that id is used directly as the DOM key — no synthetic index needed. The
 * mobile copy of the tree gets an 'm-' prefix on every key so it can't
 * collide with the desktop copy rendered in the same document.
 *
 * @param {object} node - { id, label, children, items }
 * @param {?string} parentKey - the parent node's DOM key, or null for a
 *   top-level pill (top-level siblings share a synthetic 'root' parent key
 *   so they still accordion against each other).
 * @param {boolean} mobile - which copy of the tree this is.
 */
function _userPortalRenderNode(node, parentKey, mobile) {
    const prefix = mobile ? 'm-' : '';
    const nodeKey = prefix + node.id;
    const effectiveParentKey = parentKey === null ? (prefix + 'root') : parentKey;
    const isTopLevel = parentKey === null;

    const childrenHTML = (node.children || []).map(child => _userPortalRenderNode(child, nodeKey, mobile)).join('');
    const itemsHTML = (node.items || []).map(_userPortalLeafItemHTML).join('');
    const innerHTML = childrenHTML + itemsHTML;

    if (isTopLevel && !mobile) {
        return `
        <div class="up-role-menu-root" data-menu-root style="position:relative">
            <div class="up-role-pill" data-node-key="${nodeKey}" data-parent-key="${effectiveParentKey}" style="padding:8px 12px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px;white-space:nowrap;position:relative">
                ${window.escapeHtml(node.label)} <span style="font-size:20px;line-height:1">&#9662;</span>
            </div>
            <div class="up-role-dropdown" data-panel-for="${nodeKey}" style="position:absolute;top:100%;left:0;background:var(--bg-panel3);border-radius:0 8px 8px 8px;box-shadow:0 16px 40px var(--overlay-darkShadow);padding:6px;min-width:230px;z-index:50">${innerHTML}</div>
        </div>`;
    }

    if (isTopLevel && mobile) {
        return `
        <div data-menu-root>
            <div class="up-mobile-role-pill" data-node-key="${nodeKey}" data-parent-key="${effectiveParentKey}" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;color:var(--text-primary)">
                <span>${window.escapeHtml(node.label)}</span><span class="up-caret" style="font-size:20px;line-height:1;color:var(--secondary-slate)">&#9656;</span>
            </div>
            <div class="up-mobile-role-panel" data-panel-for="${nodeKey}" style="padding:2px 0 4px 14px">${innerHTML}</div>
        </div>`;
    }

    // Nested category row, any depth >= 1 (same shape whether under a
    // top-level pill or under another category) — indentation via padding
    // shows hierarchy naturally as depth increases.
    return `
    <div>
        <div class="up-item-row" data-node-key="${nodeKey}" data-parent-key="${effectiveParentKey}" style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 10px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;color:var(--text-primary)">
            <span>${window.escapeHtml(node.label)}</span><span class="up-caret-sm" style="font-size:22px;line-height:1;color:var(--secondary-slate)">&#9656;</span>
        </div>
        <div class="up-submenu" data-panel-for="${nodeKey}" style="padding:2px 0 4px 14px">${innerHTML}</div>
    </div>`;
}

/**
 * Builds and styles the Equinox Kore User Portal header — vanilla JS/DOM,
 * no external template framework. Mirrors buildKoreHeader()'s overall
 * pattern (inject styles once, build markup, wire up interactivity) but the
 * bar itself is an in-flow flexbox element (not a fixed overlay), matching
 * the User Portal design mockup exactly: logo, role-based tool menus with
 * nested submenus, a search placeholder, a user menu, and a mobile hamburger
 * panel. Desktop/mobile markup both render always; a single CSS breakpoint
 * (900px, matching the mockup's isMobile threshold) switches which is shown,
 * so there's no JS resize listener driving layout.
 *
 * @param {string} pageTitle - Sets document context; the bar itself has no
 *   title pod (unlike the admin header).
 * @param {string} containerId - id of the empty mount element BASE provides.
 *   The header fills this element in place, unlike buildKoreHeader() which
 *   prepends fixed-position elements directly to <body>.
 */
/**
 * Checks whether the current logged-in user has permission to view /admin.
 *
 * PHASE 2: checkUserPermission() now resolves the subject from the session
 * server-side, so the /auth/validate-token round trip this used to do purely
 * to obtain a trustworthy userId is no longer needed - that was a workaround
 * for the cached kore_userId being untrustworthy, and the cause has been
 * removed rather than worked around.
 */
async function _userPortalCheckAdminAccess() {
    try {
        return await window.checkUserPermission({
            resource: 'page',
            action: 'view',
            scope: '/admin'
        });
    } catch (err) {
        console.warn('[UserHeader] Admin access check failed:', err.message);
        return false;
    }
}

async function buildUserHeader(pageTitle = "Kore", containerId = 'userHeader') {
    const container = document.getElementById(containerId);
    if (!container) {
        console.warn(`[UserHeader] Container #${containerId} not found`);
        return;
    }

    // Same icon sprite mechanism base.js uses for the admin drawer nav
    // (fetch, strip the XML declaration, inject inline so same-document
    // <use href="#i-..."> works) - guarded by the same 'kore-icons' id
    // check so this is a no-op if base.js already injected it on this
    // page, rather than fetching/injecting twice.
    if (!document.getElementById('kore-icons')) {
        fetch('/img/icons.svg')
            .then(response => response.text())
            .then(svg => {
                svg = svg.replace(/<\?xml[^?]*\?>/, '').trim();
                document.body.insertAdjacentHTML('afterbegin', svg);
            })
            .catch(err => console.warn('[UserHeader] Could not load icons.svg:', err));
    }

    if (!document.getElementById('user-header-styles')) {
        const style = document.createElement('style');
        style.id = 'user-header-styles';
        style.textContent = `
            .up-desktop-only { display: flex; }
            .up-mobile-only { display: none; }
            @media (max-width: 899px) {
                .up-desktop-only { display: none !important; }
                .up-mobile-only { display: block !important; }
            }
            /* The Dashboard link + role pills wrap to a second line if
               there isn't enough width for all of them, rather than
               overflowing the header horizontally. Scoped to this specific
               row (not the shared .up-desktop-only class, which also
               covers the unrelated search/user-menu group on the right —
               that one should never wrap). */
            .up-pills-row { flex-wrap: wrap; min-width: 0; }

            .up-role-pill { border-radius: 8px; color: var(--text-header); background: transparent; }
            .up-role-pill:hover { color: var(--text-primary); }
            .up-role-pill.open { border-radius: 8px 8px 0 0; background: var(--bg-panel3); color: var(--text-primary); z-index: 51; }
            .up-role-dropdown { display: none; width: max-content; }
            .up-role-dropdown.open { display: block; }
            .up-role-dropdown a { white-space: nowrap; }

            .up-mobile-role-pill.open { background: var(--brand-light-tint); }
            .up-mobile-role-panel { display: none; flex-direction: column; }
            .up-mobile-role-panel.open { display: flex; }

            .up-item-row.open { background: var(--brand-light-tint); }
            .up-submenu { display: none; flex-direction: column; }
            .up-submenu.open { display: flex; }
            .up-desktop-only .up-submenu { width: max-content; }
            .up-desktop-only .up-item-row { white-space: nowrap; }

            .up-user-menu-btn { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 4px 6px; position: relative; border-radius: 8px; background: transparent; }
            .up-user-menu-btn.open { border-radius: 8px 8px 0 0; background: var(--bg-panel3); z-index: 51; }
            .up-user-dropdown { display: none; position: absolute; top: 100%; right: 0; min-width: 200px; box-sizing: border-box; background: var(--bg-panel3); border-radius: 8px 0 8px 8px; box-shadow: 0 16px 40px var(--overlay-darkShadow); padding: 6px; z-index: 50; }
            .up-user-dropdown.open { display: block; }
            .up-user-dropdown-item { padding: 6px 10px; border-radius: 6px; font-size: 13px; font-weight: 500; color: var(--text-primary); cursor: pointer; }
            .up-user-dropdown-item:hover { background: var(--brand-light-tint); }

            .up-mobile-toggle { width: 36px; height: 36px; border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; cursor: pointer; background: transparent; }
            .up-mobile-toggle.open { background: var(--brand-light-tint); }
            .up-mobile-toggle span { width: 20px; height: 2px; background: var(--text-primary); border-radius: 1px; }
            .up-mobile-panel { display: none; flex-direction: column; gap: 4px; position: absolute; top: calc(100% + 8px); right: 0; width: 280px; background: var(--bg-panel3); border: 1px solid var(--border-primary); border-radius: 10px; box-shadow: 0 16px 40px var(--overlay-darkShadow); padding: 10px; z-index: 60; }
            .up-mobile-panel.open { display: flex; }
        `;
        document.head.appendChild(style);
    }

    const user = _userPortalBuildUser(await getCurrentUserPortalUser());
    const hasAdminAccess = await _userPortalCheckAdminAccess();
    const adminPillDesktopHTML = hasAdminAccess
        ? `<a href="/admin" target="_blank" rel="noopener noreferrer" title="Admin Portal" style="text-decoration:none;width:40px;height:32px;border-radius:8px;background:var(--secondary-medium);color:var(--text-primary);display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="20" height="20" style="flex-shrink:0"><use href="#i-settings-filled"/></svg></a>`
        : '';
    const adminPillMobileHTML = hasAdminAccess
        ? `<div style="height:1px;background:var(--border-primary);margin:6px 0"></div><a href="/admin" target="_blank" rel="noopener noreferrer" style="text-decoration:none;padding:10px 12px;border-radius:8px;font-size:14px;font-weight:600;border:1px solid var(--border-primary);color:var(--text-primary);display:flex;align-items:center;justify-content:space-between">Admin Portal <span style="font-size:14px">&#8599;</span></a>`
        : '';
    const userMenuTree = await getUserPortalMenus();
    const desktopRoleMenusHTML = userMenuTree.map(node => _userPortalRenderNode(node, null, false)).join('');
    const mobileRoleMenusHTML = userMenuTree.map(node => _userPortalRenderNode(node, null, true)).join('');

    container.innerHTML = `
    <div style="min-height:50px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0px 15px;border-bottom:3px solid var(--brand-light);background:var(--brand-dark)">
        <div style="display:flex;align-items:center;gap:20px;min-width:0">
            <a href="/" style="line-height:0;flex-shrink:0"><img src="/img/eit-fulllogo-white.png" alt="Equinox IT Services" style="height:40px;width:auto;flex-shrink:0"></a>
            <div class="up-desktop-only up-pills-row" style="gap:10px;align-items:center">
                <a href="/" title="Dashboard" style="text-decoration:none;width:40px;height:32px;border-radius:8px;background:var(--brand-light);color:var(--text-primary);display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="20" height="20" style="flex-shrink:0"><use href="#i-home-filled"/></svg></a>
                <a href="/docs" style="text-decoration:none;padding:8px 12px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;background:var(--secondary-slate);color:var(--text-primary);white-space:nowrap;display:flex;align-items:center;gap:4px;flex-shrink:0">Codex</a>
                ${desktopRoleMenusHTML}
            </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
            <div class="up-desktop-only" style="align-items:center;gap:12px;flex-shrink:1;min-width:0">
                <!-- Search (forms & tables) hidden for now - placeholder only,
                     no real search behavior wired up yet, needs more design
                     thought before it comes back. See the matching mobile
                     removal below. -->
                ${adminPillDesktopHTML}
                <div data-user-menu-root style="position:relative;flex-shrink:0">
                    <div class="up-user-menu-btn" data-user-menu-toggle="desktop">
                        <div style="width:32px;height:32px;border-radius:50%;background:var(--brand-light);display:flex;align-items:center;justify-content:center;color:var(--text-primary);font-size:12px;font-weight:600;flex-shrink:0">${window.escapeHtml(user.initials)}</div>
                    </div>
                    <div class="up-user-dropdown" data-user-menu-panel="desktop">
                        <div style="padding:6px 10px 8px;font-size:13px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${window.escapeHtml(user.fullName)}</div>
                        <div style="height:1px;background:var(--border-primary);margin:0 0 6px"></div>
                        <div class="up-user-dropdown-item" data-action="preferences">Preferences</div>
                        <div class="up-user-dropdown-item" data-action="logout">Logout</div>
                    </div>
                </div>
            </div>
            <div class="up-mobile-only" data-mobile-menu-root style="position:relative">
                <div class="up-mobile-toggle"><span></span><span></span><span></span></div>
                <div class="up-mobile-panel">
                    <a href="/" style="text-decoration:none;padding:10px 12px;border-radius:8px;font-size:14px;font-weight:600;background:var(--brand-light);color:var(--text-primary)">Dashboard</a>
                    <a href="/docs" style="text-decoration:none;padding:10px 12px;border-radius:8px;font-size:14px;font-weight:600;background:var(--secondary-slate);color:var(--text-primary)">Codex</a>
                    ${mobileRoleMenusHTML}
                    <!-- Search (forms & tables) hidden for now - see the matching
                         desktop removal above. -->
                    ${adminPillMobileHTML}
                    <div style="height:1px;background:var(--border-primary);margin:6px 0"></div>
                    <div data-user-menu-root>
                        <div class="up-user-menu-btn" data-user-menu-toggle="mobile">
                            <div style="width:32px;height:32px;border-radius:50%;background:var(--brand-light);display:flex;align-items:center;justify-content:center;color:var(--text-primary);font-size:12px;font-weight:600;flex-shrink:0">${window.escapeHtml(user.initials)}</div>
                            <div style="display:flex;flex-direction:column;justify-content:center">
                                <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${window.escapeHtml(user.fullName)}</span>
                            </div>
                        </div>
                        <div class="up-user-dropdown" data-user-menu-panel="mobile" style="position:static;box-shadow:none;padding:0 0 0 14px;background:transparent">
                            <div class="up-user-dropdown-item" data-action="preferences">Preferences</div>
                            <div class="up-user-dropdown-item" data-action="logout">Logout</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    _userPortalWireHeaderEvents(container);
}

/**
 * Closes a node's own panel plus everything nested inside it (any depth) —
 * used when closing a node that might have open descendants further down
 * the tree. querySelectorAll scoped to the panel naturally covers arbitrary
 * depth since deeper nodes are real DOM descendants of it.
 */
function _userPortalCloseDescendants(root, nodeKey) {
    const panel = root.querySelector(`[data-panel-for="${nodeKey}"]`);
    if (!panel) return;
    panel.classList.remove('open');
    panel.querySelectorAll('.open').forEach(el => el.classList.remove('open'));
    panel.querySelectorAll('.up-caret-sm').forEach(el => { el.textContent = '\u25b8'; });
    panel.querySelectorAll('.up-mobile-role-pill .up-caret').forEach(el => { el.textContent = '\u25b8'; });
}

function _userPortalWireHeaderEvents(root) {
    // Every toggle at every depth (top-level pills, desktop/mobile, and
    // nested category rows) shares one generic accordion behavior: opening
    // a node closes its siblings (everything else sharing its parentKey)
    // and whatever those siblings had open beneath them, then opens itself.
    // A single delegated set of listeners handles arbitrary tree depth —
    // there's no separate code path per nesting level.
    root.querySelectorAll('[data-node-key]').forEach(trigger => {
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const nodeKey = trigger.getAttribute('data-node-key');
            const parentKey = trigger.getAttribute('data-parent-key');
            const panel = root.querySelector(`[data-panel-for="${nodeKey}"]`);
            if (!panel) return;
            const wasOpen = panel.classList.contains('open');

            root.querySelectorAll(`[data-node-key][data-parent-key="${parentKey}"]`).forEach(sibling => {
                sibling.classList.remove('open');
                const caret = sibling.querySelector(':scope > .up-caret-sm, :scope > .up-caret');
                if (caret) caret.textContent = '\u25b8';
                _userPortalCloseDescendants(root, sibling.getAttribute('data-node-key'));
            });

            if (!wasOpen) {
                trigger.classList.add('open');
                panel.classList.add('open');
                const caret = trigger.querySelector(':scope > .up-caret-sm, :scope > .up-caret');
                if (caret) caret.textContent = '\u25be';
            }
        });
    });

    // User menu toggles (desktop + mobile instances)
    root.querySelectorAll('.up-user-menu-btn[data-user-menu-toggle]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.getAttribute('data-user-menu-toggle');
            const panel = root.querySelector(`.up-user-dropdown[data-user-menu-panel="${key}"]`);
            const wasOpen = panel.classList.contains('open');
            root.querySelectorAll('.up-user-menu-btn.open').forEach(el => el.classList.remove('open'));
            root.querySelectorAll('.up-user-dropdown.open').forEach(el => el.classList.remove('open'));
            if (!wasOpen) { btn.classList.add('open'); panel.classList.add('open'); }
        });
    });

    // User menu actions
    root.querySelectorAll('.up-user-dropdown-item[data-action]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = el.getAttribute('data-action');
            if (action === 'logout' && typeof window.logout === 'function') window.logout();
            else if (action === 'preferences') window.location.href = '/userprefs';
        });
    });

    // Mobile hamburger toggle
    const mobileToggle = root.querySelector('.up-mobile-toggle');
    const mobilePanel = root.querySelector('.up-mobile-panel');
    if (mobileToggle && mobilePanel) {
        mobileToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = mobilePanel.classList.contains('open');
            mobileToggle.classList.toggle('open', !wasOpen);
            mobilePanel.classList.toggle('open', !wasOpen);
        });
    }

    // Click-outside-to-close, scoped independently per menu category
    // (mirrors the original mockup's three independent outside-click checks)
    document.addEventListener('click', (e) => {
        if (!e.target.closest('[data-menu-root]')) {
            root.querySelectorAll('.up-role-pill.open, .up-role-dropdown.open, .up-item-row.open, .up-submenu.open, .up-mobile-role-pill.open, .up-mobile-role-panel.open').forEach(el => el.classList.remove('open'));
            root.querySelectorAll('.up-caret-sm, .up-mobile-role-pill .up-caret').forEach(el => { el.textContent = '\u25b8'; });
        }
        if (!e.target.closest('[data-user-menu-root]')) {
            root.querySelectorAll('.up-user-menu-btn.open, .up-user-dropdown.open').forEach(el => el.classList.remove('open'));
        }
        if (!e.target.closest('[data-mobile-menu-root]')) {
            if (mobileToggle) mobileToggle.classList.remove('open');
            if (mobilePanel) mobilePanel.classList.remove('open');
        }
    });
}

window.buildUserHeader = buildUserHeader;
window.getCurrentUserPortalUser = getCurrentUserPortalUser;
window.getUserPortalMenus = getUserPortalMenus;

// ============================================================================
// USER PREFERENCES PAGE (self-service "change my own password" etc. - see
// _userpreferences.html, reached via the header's Preferences dropdown item
// above). Merged in from the former standalone user.js; calls into base.js
// are explicitly window.-prefixed to match this file's own module
// convention (see file header), rather than relying on bare-identifier
// global scope the way user.js originally did as a classic script.
// ============================================================================

let _userPrefsCurrentUser = null;  // Unused: the profile/preferences endpoints take identity from the session

/**
 * Attach change/input listeners to every field in the User Preferences tab
 */
function attachUserPrefsFormListeners() {
    const prefsInputs = document.querySelectorAll('#preferencesTab input, #preferencesTab select');
    console.log('Attaching listeners to', prefsInputs.length, 'userprefs inputs');
    prefsInputs.forEach(input => {
        input.addEventListener('change', () => {
            console.log('Userprefs field changed:', input.id);
            updateUserPrefsSaveButtonState();
        });
        input.addEventListener('input', () => {
            console.log('Userprefs field input:', input.id);
            updateUserPrefsSaveButtonState();
        });
    });
}

/**
 * Switch to User Preferences tab and load user data
 */
function switchToUserPreferencesTab(event) {
    window.switchTab('preferencesTab', event);
    loadUserPreferences();
}

/**
 * Load user preferences. The page only has the Change Password section
 * (Profile Information and Notification Preferences were removed from
 * _userpreferences.html), so this just resets the password fields/button -
 * it does not fetch or populate anything from the server.
 */
async function loadUserPreferences() {
    try {
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';
        document.getElementById('changePasswordBtn').disabled = true;
    } catch (error) {
        console.error('Error loading user preferences:', error);
        window.showStatusBanner('Error loading user preferences: ' + error.message, 'error', 'userprefStatusMessage');
    }
}

/**
 * Save both user preferences (profile + notifications) together
 */
async function saveUserPreferencesData() {
    try {
        const fullName = document.getElementById('userFullName').value.trim();
        const email = document.getElementById('userEmail').value.trim();

        // Validation
        if (!fullName) {
            window.showStatusBanner('Full name is required', 'error', 'userprefStatusMessage');
            return;
        }

        if (!email) {
            window.showStatusBanner('Email is required', 'error', 'userprefStatusMessage');
            return;
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            window.showStatusBanner('Please enter a valid email address', 'error', 'userprefStatusMessage');
            return;
        }

        // Save profile
        const profileResult = await window.updateUserProfile(window.sessionToken, _userPrefsCurrentUser, {
            full_name: fullName,
            email: email
        });

        if (!profileResult) {
            window.showStatusBanner('Error updating user profile', 'error', 'userprefStatusMessage');
            return;
        }

        // Save notification preferences
        const preferences = {
            login_alerts: document.getElementById('notifyLogin').checked,
            password_change_alerts: document.getElementById('notifyPasswordChange').checked,
            security_alerts: document.getElementById('notifySecurityAlerts').checked,
            system_updates: document.getElementById('notifySystemUpdates').checked,
            frequency: document.getElementById('notificationFrequency').value
        };

        const prefsResult = await window.updateUserNotificationPreferences(window.sessionToken, _userPrefsCurrentUser, preferences);

        if (!prefsResult) {
            window.showStatusBanner('Error updating notification preferences', 'error', 'userprefStatusMessage');
            return;
        }

        // Reinitialize unsaved changes tracking with saved data
        const savedData = {
            userFullName: fullName,
            userEmail: email,
            notifyLogin: document.getElementById('notifyLogin').checked,
            notifyPasswordChange: document.getElementById('notifyPasswordChange').checked,
            notifySecurityAlerts: document.getElementById('notifySecurityAlerts').checked,
            notifySystemUpdates: document.getElementById('notifySystemUpdates').checked,
            notificationFrequency: document.getElementById('notificationFrequency').value
        };
        window.initializeUnsavedTracking(savedData);
        updateUserPrefsSaveButtonState();
        window.showStatusBanner('User preferences saved successfully', 'success', 'userprefStatusMessage');

    } catch (error) {
        console.error('Error saving user preferences:', error);
        window.showStatusBanner('Error saving preferences: ' + error.message, 'error', 'userprefStatusMessage');
    }
}

function updateUserPrefsSaveButtonState() {
    const saveBtn = document.getElementById('userPrefsSaveBtn');
    if (saveBtn) {
        const currentData = {
            userFullName: document.getElementById('userFullName').value,
            userEmail: document.getElementById('userEmail').value,
            notifyLogin: document.getElementById('notifyLogin').checked,
            notifyPasswordChange: document.getElementById('notifyPasswordChange').checked,
            notifySecurityAlerts: document.getElementById('notifySecurityAlerts').checked,
            notifySystemUpdates: document.getElementById('notifySystemUpdates').checked,
            notificationFrequency: document.getElementById('notificationFrequency').value
        };
        window.checkUnsavedChanges(currentData);
        const hasChanges = window.hasUnsavedChanges();
        saveBtn.disabled = !hasChanges;
    }
}

function checkUserPrefUnsavedChanges() {
    updateUserPrefsSaveButtonState();
}

/**
 * Check for unsaved changes in notification section
 */
function checkNotificationUnsavedChanges() {
    updateUserPrefsSaveButtonState();
}

/**
 * Check for unsaved changes in password section
 */
function checkPasswordUnsavedChanges() {
    const currentPwd = document.getElementById('currentPassword').value;
    const newPwd = document.getElementById('newPassword').value;
    const confirmPwd = document.getElementById('confirmPassword').value;
    
    const hasChanges = currentPwd.length > 0 || newPwd.length > 0 || confirmPwd.length > 0;
    document.getElementById('changePasswordBtn').disabled = !hasChanges;
}

/**
 * Change user password
 */
async function changeUserPassword() {
    try {
        const currentPwd = document.getElementById('currentPassword').value;
        const newPwd = document.getElementById('newPassword').value;
        const confirmPwd = document.getElementById('confirmPassword').value;

        // Validation
        if (!currentPwd) {
            window.showStatusBanner('Current password is required', 'error', 'userprefStatusMessage');
            return;
        }

        if (!newPwd) {
            window.showStatusBanner('New password is required', 'error', 'userprefStatusMessage');
            return;
        }

        if (newPwd !== confirmPwd) {
            window.showStatusBanner('New passwords do not match', 'error', 'userprefStatusMessage');
            return;
        }

        if (currentPwd === newPwd) {
            window.showStatusBanner('New password must be different from current password', 'error', 'userprefStatusMessage');
            return;
        }

        // Call the change-password endpoint
        const response = await fetch('/auth/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${window.sessionToken}`
            },
            body: JSON.stringify({
                oldPassword: currentPwd,
                newPassword: newPwd
            })
        });

        const result = await response.json();

        if (result.success) {
            // Clear password fields
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
            document.getElementById('changePasswordBtn').disabled = true;
            window.showStatusBanner('Password changed successfully', 'success', 'userprefStatusMessage');
        } else if (result.error) {
            window.showStatusBanner(result.error, 'error', 'userprefStatusMessage');
        } else {
            window.showStatusBanner('Error changing password', 'error', 'userprefStatusMessage');
        }

    } catch (error) {
        console.error('Error changing password:', error);
        window.showStatusBanner('Error changing password: ' + error.message, 'error', 'userprefStatusMessage');
    }
}

window.attachUserPrefsFormListeners = attachUserPrefsFormListeners;
window.changeUserPassword = changeUserPassword;
window.checkNotificationUnsavedChanges = checkNotificationUnsavedChanges;
window.checkPasswordUnsavedChanges = checkPasswordUnsavedChanges;
window.checkUserPrefUnsavedChanges = checkUserPrefUnsavedChanges;
window.loadUserPreferences = loadUserPreferences;
window.saveUserPreferencesData = saveUserPreferencesData;
window.switchToUserPreferencesTab = switchToUserPreferencesTab;
window.updateUserPrefsSaveButtonState = updateUserPrefsSaveButtonState;