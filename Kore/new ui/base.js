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
    root.style.setProperty('--text-primary', t.text.primary);
    root.style.setProperty('--text-muted', t.text.muted);
    root.style.setProperty('--text-accent', t.text.accent);
    root.style.setProperty('--overlay-white-faint', overlayColors.whiteFaint);
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
            --header-clearance: 52px; 
            --badge-size: 58px;      
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
            right: -350px; 
            width: 300px; 
            height: calc(100% - var(--header-height)); 
            background-color: var(--bg-drawer); 
            border-left: 1px solid var(--border-primary); 
            z-index: 1001; 
            padding: 60px 20px 20px; 
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

        .logo-circle { left: 10px; }
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
        <div class="logo-circle"><img src="https://llink.equinoxits.com/images/kore-icon.png" class="logo-img"></div>
        <div class="title-pod"><div class="variable-title">${pageTitle}</div></div>
        <div class="menu-circle" id="hamburger"><div class="hamburger-lines"></div></div>
    </div>
    <nav class="nav-drawer" id="drawer">
        <h2 style="color: var(--brand-light); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 20px;">Control Center</h2>
        <p style="color: ${theme[activeTheme].text.muted}; font-size: 0.85rem; margin-bottom: 12px;">• Analytics Dashboard</p>
        <p style="color: ${theme[activeTheme].text.muted}; font-size: 0.85rem; margin-bottom: 12px;">• Node Configurations</p>
        <p style="color: ${theme[activeTheme].text.muted}; font-size: 0.85rem;">• Security Protocols</p>
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