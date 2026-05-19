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
    
    // If 401 and not already a refresh request, try to refresh
    if (response.status === 401 && url !== '/auth/refresh' && refreshAttemptCount < 1) {
        // Prevent multiple simultaneous refresh attempts
        if (!isRefreshing) {
            isRefreshing = true;
            refreshAttemptCount++;
            refreshPromise = attemptTokenRefresh();
        }
        
        try {
            await refreshPromise;
            // Retry original request with new token
            response = await originalFetch(url, options);
        } catch (err) {
            console.error('Token refresh failed:', err.message);
            // Refresh failed, redirect to login
            window.location.href = '/login';
            return response;
            isRefreshing = false;
        }
    }
    
    // Reset counter on successful response
    if (response.ok) {
        refreshAttemptCount = 0;
    }
    
    return response;
};

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
    root.style.setProperty('--bg-drawer', t.bg.drawer);
    root.style.setProperty('--bg-titlePod', t.bg.titlePod);
    root.style.setProperty('--text-header', t.text.header);
    root.style.setProperty('--border-primary', t.border.primary);
    root.style.setProperty('--border-bright', t.border.bright);
    root.style.setProperty('--overlay-dark', overlayColors.dark);
    root.style.setProperty('--overlay-darkShadow', overlayColors.darkShadow);
    root.style.setProperty('--overlay-medium', overlayColors.blueMedium);
    
    // Update SVG filter color
    updateSVGFilterColor();
}

function updateSVGFilterColor() {
    const feFlood = document.querySelector('feFlood');
    if (feFlood) {
        feFlood.setAttribute('flood-color', theme[activeTheme].eq.light);
    }
}

function updateBodyColors() {
    const t = theme[activeTheme];
    const root = document.documentElement;
    
    root.style.setProperty('--bg-primary', t.bg.primary);
    root.style.setProperty('--bg-input', t.bg.input);
    root.style.setProperty('--bg-subpanel', t.bg.subpanel);
    root.style.setProperty('--bg-panel1', t.bg.panel1);
    root.style.setProperty('--bg-panel2', t.bg.panel2);
    root.style.setProperty('--bg-panel3', t.bg.panel3);
    root.style.setProperty('--text-primary', t.text.primary);
    root.style.setProperty('--text-muted', t.text.muted);
    root.style.setProperty('--text-accent', t.text.accent);
    root.style.setProperty('--overlay-white-faint', overlayColors.whiteFaint);
    root.style.setProperty('--secondary-slate', t.secondary.slate);
    root.style.setProperty('--secondary-medium', t.secondary.medium);
    root.style.setProperty('--secondary-neutral', t.secondary.neutral);
}

function getAvailableThemes() {
    return Object.keys(theme);
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
 * Builds and styles the Equinox Kore header and navigation.
 * @param {string} pageTitle - The text to display in the center of the header.
 */
function buildKoreHeader(pageTitle = "Kore System") {
    const style = document.createElement('style');
    style.textContent = `
        :root {
            --header-height: 29px; 
            --header-drop: 41px;
            --header-clearance: 50px; 
            --badge-size: 54px;      
            --pod-height: 44px;      
            --badge-top: 9px;        
            --pod-top: 6px;         
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
            --notch-start: 80px;
            --notch-end: 94px; 
        }

        /* 1. Nav Drawer */
        .nav-drawer { 
            position: fixed; 
            top: var(--header-height); 
            right: -150px; 
            width: 150px; 
            height: calc(100% - var(--header-height)); 
            background-color: var(--bg-drawer); 
            border-left: 1px solid var(--border-primary); 
            z-index: 1001; 
            padding: 40px 10px 15px; 
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            transition: right 0.4s cubic-bezier(0.165, 0.84, 0.44, 1); 
        }
        .nav-drawer.open { right: 0; box-shadow: -10px 10px 30px var(--overlay-darkShadow); }

        /* 2. Main Header Rail */
        .header {
            position: fixed;
            top: 0; left: 0; right: 0;
            height: var(--header-drop);
            background-color: var(--brand-dark); 
            z-index: 1002;
            clip-path: polygon(
                0% 0%, 100% 0%, 100% 100%, 
                calc(100% - var(--notch-start)) 100%, 
                calc(100% - var(--notch-end)) var(--header-height), 
                var(--notch-end) var(--header-height), 
                var(--notch-start) 100%, 0% 100%
            );
        }

        /* 3. Horizontal Data Streams */
        .header-data-streams {
            position: fixed; 
            top: 0; left: 0; right: 0;
            height: var(--header-height); 
            z-index: 1003; 
            pointer-events: none;
            overflow: hidden;
        }

        .stream-line-h {
            position: absolute;
            height: 1px;
            background: linear-gradient(to right, transparent, var(--brand-light), transparent);
            opacity: 0.9;
        }

        /* 4. Phantom Border & Glow */
        .header-shadow-phantom {
            position: fixed;
            top: 0; left: 0; right: 0;
            height: var(--header-drop);
            z-index: 1004; 
            pointer-events: none;
            filter: url(#glow-border) drop-shadow(0 10px 15px var(--overlay-darkShadow));
        }

        .phantom-shape-fill {
            width: 100%; height: 100%;
            background: var(--brand-dark);
            clip-path: polygon(
                0% 0%, 100% 0%, 100% 100%, 
                calc(100% - var(--notch-start)) 100%, 
                calc(100% - var(--notch-end)) var(--header-height), 
                var(--notch-end) var(--header-height), 
                var(--notch-start) 100%, 0% 100%
            );
        }

        /* 5. Top Interaction Layer */
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
        .logo-img { width: 44px; height: 44px; object-fit: contain; }

        .title-pod {
            position: absolute;
            top: var(--pod-top);
            height: var(--pod-height);
            left: 50%;
            transform: translateX(-50%);
            background-color: var(--bg-titlePod);
            border: 2px solid var(--border-bright);
            padding: 0 40px;
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
            font-weight: 500; 
            text-transform: uppercase; 
            letter-spacing: 3px; 
            white-space: nowrap;
            text-shadow: 0 0 12px var(--border-bright);
        }

        .hamburger-lines { 
            width: 28px; height: 4px; 
            background-color: var(--brand-dark); 
            position: relative;
        }
        .hamburger-lines::before, .hamburger-lines::after { 
            content: ''; position: absolute; 
            width: 28px; height: 4px; 
            background-color: var(--brand-dark); 
            transition: all 0.3s ease;
        }
        .hamburger-lines::before { top: -10px; }
        .hamburger-lines::after { top: 10px; }

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

    const svgFilter = `
    <svg width="0" height="0" style="position:absolute;">
      <filter id="glow-border" x="-20%" y="-20%" width="140%" height="140%">
        <feMorphology in="SourceAlpha" result="expanded" operator="dilate" radius="2"/>
        <feFlood flood-color="${theme[activeTheme].eq.light}" result="blue"/>
        <feComposite in="blue" in2="expanded" operator="in" />
        <feComposite in="SourceGraphic" />
      </filter>
    </svg>`;
    document.body.insertAdjacentHTML('beforeend', svgFilter);

    const headerHTML = `
    <div class="header-shadow-phantom"><div class="phantom-shape-fill"></div></div>
    <header class="header"></header>
    <div class="header-data-streams" id="h-streams"></div>
    <div class="ui-layer">
        <a href="index.html" class="logo-circle"><img src="https://llink.equinoxits.com/images/kore-icon.png" class="logo-img"></a>
        <div class="title-pod"><div class="variable-title">${pageTitle}</div></div>
        <div class="menu-circle" id="hamburger"><div class="hamburger-lines"></div></div>
    </div>
    <nav class="nav-drawer" id="drawer">
        <a href="index.html" style="color: var(--brand-light); font-size: 0.9rem; text-decoration: none; display: flex; align-items: center; padding: 6px 0; transition: opacity 0.2s; gap: 6px;" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'"><span style="font-size: 1.3em; flex-shrink: 0; width: 24px; text-align: center;">&#9684;</span><span>Dashboard</span></a>
        <div style="margin-top: auto;">
            <a href="settings.html" style="color: var(--brand-light); font-size: 0.9rem; text-decoration: none; display: flex; align-items: center; padding: 6px 0; transition: opacity 0.2s; gap: 6px;" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'"><span style="font-size: 1.5em; flex-shrink: 0; width: 24px; text-align: center;">&#9881;</span><span>Settings</span></a>
            <div style="color: var(--brand-light); font-size: 0.9rem; padding: 6px 0; cursor: pointer; transition: opacity 0.2s; display: flex; align-items: center; gap: 6px;" onclick="logout()" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'"><span style="font-size: 1.3em; flex-shrink: 0; width: 24px; text-align: center;">&#10006;</span><span>Logout</span></div>
        </div>
    </nav>`;

    document.body.insertAdjacentHTML('afterbegin', headerHTML);

    const streamContainer = document.getElementById('h-streams');
    const rows = [5, 11, 17, 23]; 
    rows.forEach(y => {
        const line = document.createElement('div');
        line.className = 'stream-line-h';
        line.style.top = y + 'px';
        line.style.left = (Math.random() * 25) + '%';
        line.style.width = (15 + Math.random() * 45) + '%';
        streamContainer.appendChild(line);
    });

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
    }
    
    // Initial call and listen to resize
    adjustTitleSize();
    window.addEventListener('resize', adjustTitleSize);
}

// Auto-execute: inject component styles and initialize theme
injectComponentStyles();
setTheme(activeTheme);

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
        closeOnBackdrop = true
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
    modal.className = 'modal-container';
    modal.innerHTML = `
        <div class="modal-header">
            <h2>${title}</h2>
        </div>
        <div class="modal-body" id="modal-body-content">
            ${typeof content === 'string' ? content : ''}
        </div>
        <div class="modal-footer" id="modal-footer">
        </div>
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
            
            button.textContent = btn.label;
            button.addEventListener('click', async () => {
                if (btn.onClick) {
                    const result = btn.onClick();
                    // Wait for async functions (Promises)
                    if (result instanceof Promise) {
                        await result;
                    }
                }
                closeModal();
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

    // Backdrop click to close (only add listener once per backdrop)
    if (closeOnBackdrop && !backdrop.hasBackdropListener) {
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) closeModal();
        });
        backdrop.hasBackdropListener = true;
    }

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
 * Get session token
 */
async function getSessionToken() {
    const authBody = {
        origin: "https://localhost",
        user: "admin@equinoxits.com"
    };

    const response = await fetch('https://app.equinoxits.com:1139/auth', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Kore-Token': '393d5ca334f5b1b9e7127544460def61ca6be55eab20da08f1746f11f5d0b4e9'
        },
        body: JSON.stringify(authBody)
    });

    const data = await response.json();
    return data.sessionToken;
}

/**
 * Get current user ID from session token
 */
function getUser() {
    return localStorage.getItem('kore_userId');
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
            'SELECT userId, email, fullName, status, active, mfaEnabled, lockedUntil, createdAt, lastLoginAt, groupIds FROM users ORDER BY fullName, email'
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
            'SELECT groupId, name FROM user_groups ORDER BY name'
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
async function executeSqlQuery(sessionToken, user, database, query, options = {}) {
    try {
        if (!sessionToken || !user || !database || !query) {
            throw new Error('sessionToken, user, database, and query are required');
        }
        
        const response = await fetch(`https://app.equinoxits.com:1139/sqlquery`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({
                database: database,
                query: query
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }
        
        if (!data.success) {
            throw new Error(data.error || 'Query execution failed');
        }
        
        return data;
    } catch (error) {
        console.error('executeSqlQuery error:', error);
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
function showStatusBanner(message, type = 'info', containerId = 'statusMessage', duration = 5000) {
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
    
    // Auto-hide after duration
    setTimeout(() => {
        container.classList.remove('active');
    }, duration);
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
function showFormModal(title, fields, onSave) {
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
            let buttonWrapperAttrs = `id="field_wrapper_${field.name}" style="margin-bottom: 12px;`;
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
        let wrapperAttrs = `id="field_wrapper_${field.name}" style="margin-bottom: 12px;`;
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
        content: formHtml,
        closeOnBackdrop: false,  // Forms shouldn't close on backdrop click
        buttons: [
            { label: 'Cancel', type: 'secondary', onClick: () => {} },
            { 
                label: 'Save', 
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
                        } else {
                            formData[field.name] = element.value;
                        }
                    });
                    if (onSave) {
                        const result = onSave(formData);
                        // Wait for async functions (Promises)
                        if (result instanceof Promise) {
                            await result;
                        }
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

/**
 * Get organization stack (system integrations) from kore database
 * @param {string} sessionToken - Session token
 * @param {string} user - Current user
 * @param {number} orgId - Organization ID
 * @returns {Object|null} org_stack row or null if not found
 */
async function getOrgStack(sessionToken, user, orgId) {
    try {
        const result = await executeSqlQuery(
            sessionToken,
            user,
            'kore_sys',
            `SELECT * FROM kore_data.org_stack WHERE org_id = ${orgId}`
        );
        return result.result && result.result.length > 0 ? result.result[0] : null;
    } catch (error) {
        console.error('Error fetching org stack:', error);
        return null;
    }
}

/**
 * Setup unsaved changes protection for page navigation (reload/close/navigate away)
 * Shows the unsaved modal if user has unsaved changes
 * @param {function} onSaveCallback - Async function to call when user chooses to save
 * @param {function} onDiscardCallback - Function to call when user chooses to discard
 */
function setupPageUnsavedChangesProtection(onSaveCallback, onDiscardCallback) {
    let allowNavigation = false;
    let showingModal = false;
    
    window.addEventListener('beforeunload', (event) => {
        if (window.hasUnsavedChanges() && !allowNavigation && !showingModal) {
            event.preventDefault();
            event.returnValue = '';
            showingModal = true;
            
            // Show custom unsaved modal instead of browser dialog
            window.showUnsaved(
                async () => {
                    // Save changes
                    if (onSaveCallback) {
                        await onSaveCallback();
                    }
                    
                    // Allow navigation to proceed
                    allowNavigation = true;
                    showingModal = false;
                    window.location.reload();
                },
                () => {
                    // Discard changes and proceed
                    if (onDiscardCallback) {
                        onDiscardCallback();
                    }
                    
                    allowNavigation = true;
                    showingModal = false;
                    window.location.reload();
                }
            );
            
            return false;
        }
    });
}

/**
 * Get all RMM types
 */
async function getRmmTypes(sessionToken, user) {
    try {
        const result = await executeSqlQuery(sessionToken, user, 'kore_sys', 'SELECT rmm_type_id, rmm_name FROM kore_data.stack_rmm ORDER BY rmm_name');
        return result.result || [];
    } catch (error) {
        console.error('Error fetching RMM types:', error);
        return [];
    }
}

/**
 * Get all PSA types
 */
async function getPsaTypes(sessionToken, user) {
    try {
        const result = await executeSqlQuery(sessionToken, user, 'kore_sys', 'SELECT psa_type_id, psa_name FROM kore_data.stack_psa ORDER BY psa_name');
        return result.result || [];
    } catch (error) {
        console.error('Error fetching PSA types:', error);
        return [];
    }
}

/**
 * Get all Control types
 */
async function getControlTypes(sessionToken, user) {
    try {
        const result = await executeSqlQuery(sessionToken, user, 'kore_sys', 'SELECT control_type_id, control_name FROM kore_data.stack_control ORDER BY control_name');
        return result.result || [];
    } catch (error) {
        console.error('Error fetching Control types:', error);
        return [];
    }
}

/**
 * Get all RPA types
 */
async function getRpaTypes(sessionToken, user) {
    try {
        const result = await executeSqlQuery(sessionToken, user, 'kore_sys', 'SELECT rpa_type_id, rpa_name FROM kore_data.stack_rpa ORDER BY rpa_name');
        return result.result || [];
    } catch (error) {
        console.error('Error fetching RPA types:', error);
        return [];
    }
}

/**
 * Get all BDR types
 */
async function getBdrTypes(sessionToken, user) {
    try {
        const result = await executeSqlQuery(sessionToken, user, 'kore_sys', 'SELECT bdr_type_id, bdr_name FROM kore_data.stack_bdr ORDER BY bdr_name');
        return result.result || [];
    } catch (error) {
        console.error('Error fetching BDR types:', error);
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
        // Clear userId from localStorage
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
 * Get current user's profile data (email, full name)
 */
async function getCurrentUserData(sessionToken) {
    try {
        const userId = getUser();
        if (!userId) {
            throw new Error('No user ID found');
        }

        const result = await executeSqlQuery(
            sessionToken,
            userId,
            'kore_sys',
            `SELECT userId, email, fullName FROM users WHERE userId = '${userId}'`
        );

        if (result.result && result.result.length > 0) {
            const user = result.result[0];
            return {
                user_id: user.userId,
                email: user.email,
                full_name: user.fullName
            };
        }
        return null;
    } catch (error) {
        console.error('Error fetching current user data:', error);
        throw error;
    }
}

/**
 * Get user notification preferences with defaults
 */
async function getUserNotificationPreferences(sessionToken, userId) {
    try {
        const result = await executeSqlQuery(
            sessionToken,
            userId,
            'kore_sys',
            `SELECT preferences FROM users WHERE userId = '${userId}'`
        );

        if (result.result && result.result.length > 0) {
            const prefData = result.result[0].preferences;
            
            // If preferences is null or empty, return defaults
            if (!prefData) {
                return DEFAULT_USER_PREFERENCES.notifications;
            }

            // Parse if it's a string
            const preferences = typeof prefData === 'string' ? JSON.parse(prefData) : prefData;
            
            // Return notification preferences or defaults if not set
            return preferences.notifications || DEFAULT_USER_PREFERENCES.notifications;
        }
        
        return DEFAULT_USER_PREFERENCES.notifications;
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
        const fullName = data.full_name ? `'${data.full_name.replace(/'/g, "''")}'` : 'NULL';
        const email = data.email ? `'${data.email.replace(/'/g, "''")}'` : 'NULL';

        const query = `UPDATE users SET fullName = ${fullName}, email = ${email} WHERE userId = '${userId}'`;

        const result = await executeSqlQuery(
            sessionToken,
            userId,
            'kore_sys',
            query
        );

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
        // Get current preferences to merge
        const result = await executeSqlQuery(
            sessionToken,
            userId,
            'kore_sys',
            `SELECT preferences FROM users WHERE userId = '${userId}'`
        );

        let currentPrefs = DEFAULT_USER_PREFERENCES;
        
        if (result.result && result.result.length > 0 && result.result[0].preferences) {
            const prefData = result.result[0].preferences;
            currentPrefs = typeof prefData === 'string' ? JSON.parse(prefData) : prefData;
        }

        // Merge new preferences with existing ones
        const updatedPrefs = {
            ...currentPrefs,
            notifications: {
                ...currentPrefs.notifications,
                ...preferences
            },
            updated_at: new Date().toISOString()
        };

        // Escape single quotes in JSON for SQL
        const prefsJson = JSON.stringify(updatedPrefs).replace(/'/g, "''");

        const updateQuery = `UPDATE users SET preferences = '${prefsJson}' WHERE userId = '${userId}'`;

        const updateResult = await executeSqlQuery(
            sessionToken,
            userId,
            'kore_sys',
            updateQuery
        );

        return updateResult.success === true;
    } catch (error) {
        console.error('Error updating notification preferences:', error);
        throw error;
    }
}