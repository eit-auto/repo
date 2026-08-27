/* ============================================================================
   THEME - Color Palette
   ============================================================================ */

if (typeof theme === 'undefined') {
  window.theme = {
  default: {
    // Primary Brand Colors
    eq: {
      dark: '#002b59',
      light: '#0070b9',
      lighter: '#4cb5ff',
    },

    // Secondary Brand Colors
    secondary: {
      light: '#c6def3',
      medium: '#82acd7',
      slate: '#7592b0',
      neutral: '#aab1ba',
    },

    // Background Colors
    bg: {
      primary: '#BBBBD0',
      secondary: '#191A24',
      input: '#191A24',
      subpanel: '#1d2b3d',
      drawer: '#0d1520',
      titlePod: '#000F23',
      panel1_: '#2a3a5f',
      panel2_: '#212c47',
      panel3_: '#1a2238',
      panel1: '#002b59',
      panel2: '#00254C',
      panel3: '#001F40',
      panel4: '#001933',
      panel5: '#001226',
    },

    // Text Colors
    text: {
      primary: '#ffffff',
      muted: '#82acd7',
      header: '#c6def3',
      accent: '#4ade80',
      input: '#ffffff',
    },

    // Border & Divider Colors
    border: {
      primary: '#314a59',
      bright: 'rgba(0, 112, 185, 0.9)',
    },

    // Semantic/Component Colors
    badge: {
      background: '#002b59',
      text: '#4cb5ff',
      border: '#0070b9',
    },

    // Row-highlight colors (config-driven, see dashboard_pods.source_config's
    // highlight_rules — e.g. the Service/Project Tickets pods). Dark, fully
    // opaque shades meant to sit behind normal light table text, not the
    // brighter/translucent tones badge/status colors use.
    highlight: {
      red: '#4a1518',
      orange: '#4a2f10',
      yellow: '#4a3f14',
    },
  },
};
}

/* ============================================================================
   OVERLAY & SHADOW COLORS - Constants
   ============================================================================ */

if (typeof overlayColors === 'undefined') {
  window.overlayColors = {
    dark: 'rgba(0, 0, 0, 0.7)',
    darkShadow: 'rgba(0, 0, 0, 0.5)',
    blueMedium: 'rgba(0, 112, 185, 0.5)',
    whiteFaint: 'rgba(255, 255, 255, 0.05)',
  };
}

/* ============================================================================
   STATUS & BUTTON COLORS - Universal (non-theme-dependent)
   ============================================================================ */

if (typeof statusColors === 'undefined') {
  window.statusColors = {
    green: '#4caf50',
    greenDark: '#5a8f6a',
    red: '#b8242f',
    redDark: '#8b5a5f',
    redHover: '#c62828',
    redInput: '#dc3545',
    redInputHover: '#c82333',
  };
}

/* ============================================================================
   REUSABLE COMPONENT STYLES
   ============================================================================ */

if (typeof componentStyles === 'undefined') {
  window.componentStyles = `
  html {
    height: 100%;
    margin: 0;
    padding: 0;
  }

  body {
    background-color: var(--bg-primary);
    color: var(--text-primary);
    font-family: 'Inter', sans-serif;
    margin: 0;
    height: 100dvh;
    padding-top: var(--header-clearance);
    box-sizing: border-box;
    overflow: hidden;
  }

  .main-container {
    padding: 25px 10px 10px 10px;
    display: grid;
    gap: 10px;
    min-height: 100%;
    height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    scrollbar-color: var(--brand-light) var(--bg-canvas);
    scrollbar-width: thin;
  }

  .main-container::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .main-container::-webkit-scrollbar-track {
    background-color: var(--bg-canvas);
  }

  .main-container::-webkit-scrollbar-thumb {
    background-color: var(--brand-light);
    border-radius: 4px;
  }

  .main-container::-webkit-scrollbar-thumb:hover {
    background-color: var(--brand-dark);
  }

  .panel-level-1 {
    background-color: var(--bg-panel1);
    border: 1px solid var(--border-primary);
    border-top: 3px solid var(--brand-light);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .panel-level-2 {
    background-color: var(--bg-panel2);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .panel-level-3 {
    background-color: var(--bg-panel3);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .panel-level-4 {
    background-color: var(--bg-panel4);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .panel-level-5 {
    background-color: var(--bg-panel5);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  /* Grid layout for content containers */
  .panel-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 15px;
  }

  /* Responsive grid: 3 columns on wide, 2 on narrow */
  .panel-grid-responsive {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 15px;
  }

  /* Table Styling */
  table {
    border-collapse: collapse;
    width: 100%;
    background-color: transparent;
  }

  table thead {
    background-color: rgba(0, 0, 0, 0.4);
  }

  table thead th {
    padding: 6px;
    text-align: left;
    border-bottom: 1px solid var(--border-primary);
    color: var(--text-primary);
    background-color: rgba(0, 0, 0, 0.4);
  }

  table tbody {
    background-color: transparent;
  }

  table tbody tr {
    border-bottom: 1px solid var(--border-primary);
  }

  table tbody tr:hover {
    background-color: rgba(76, 181, 255, 0.05);
  }

  table td {
    padding: 6px;
    text-align: left;
  }

  /* Remove background from flex container elements - but not from an
     actual panel-level-N element that happens to also be a direct flex
     child of panel-level-2 (e.g. a nested panel-level-3 section wrapper).
     The [style*="display: flex"] match is inherently a fragile substring
     check rather than a real "is this just a layout div" test, so the
     :not() here is a deliberate carve-out for anything that's genuinely a
     styled panel and needs its own background-color to win. */
  .panel-level-2 > div[style*="display: flex"]:not([class*="panel-level-"]) {
    background-color: transparent !important;
  }

  .btn {
    padding: 3px 5px;
    height: 32px;
    min-width: 32px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
    color: white;
    background-color: var(--brand-light);
    transition: opacity 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .btn:hover {
    opacity: 0.9;
  }

  /* Button Sizes */
  .btn[data-size="sm"] {
    height: 24px;
    min-width: 24px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .btn[data-size="lg"] {
    height: 40px;
    min-width: 40px;
    font-size: 1.1rem;
    font-weight: 600;
  }

  /* Button Color Variants - Use data-color attribute */
  .btn[data-color="blue"] { background-color: #5770d5; }
  .btn[data-color="blue"]:disabled { background-color: #4a5aa0; }
  .btn[data-color="grey"] { background-color: #6c757d; }
  .btn[data-color="grey"]:hover { background-color: #556167; }
  .btn[data-color="gold"] { background-color: #b89a3f; }
  .btn[data-color="gold"]:disabled { background-color: #8b6d2f; }
  .btn[data-color="bluegrey"] { background-color: #5a7a9c; }
  .btn[data-color="bluegrey"]:disabled { background-color: #475d7a; }
  .btn[data-color="slate"] { background-color: #3a4a59; }
  .btn[data-color="slate"]:disabled { background-color: #2d3a48; }
  .btn[data-color="theme-slate"] { background-color: var(--secondary-slate); }
  .btn[data-color="theme-slate"]:hover { opacity: 0.85; }
  .btn[data-color="theme-neutral"] { background-color: rgba(255, 255, 255, 0.15); }
  .btn[data-color="theme-neutral"]:hover { opacity: 0.85; }
  .btn[data-color="theme-brand"] { background-color: var(--brand-light); }
  .btn[data-color="theme-brand"]:hover { opacity: 0.85; }
  .btn[data-color="green"] { background-color: #4caf50; }
  .btn[data-color="green"]:disabled { background-color: #5a8f6a; }
  .btn[data-color="red"] { background-color: #b8242f; }
  .btn[data-color="red"]:hover { background-color: #c62828; }

  /* Close Button for Modals */
  .btn-close {
    background: none;
    border: none;
    color: var(--text-primary);
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s ease;
  }

  .btn-close:hover {
    color: var(--brand-light);
  }

  /* Scrollbar Styling */
  .scrollbar {
    scrollbar-color: var(--brand-light) var(--bg-input);
    scrollbar-width: thin;
  }

  .scrollbar::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .scrollbar::-webkit-scrollbar-track {
    background-color: var(--bg-input);
  }

  .scrollbar::-webkit-scrollbar-thumb {
    background-color: var(--brand-light);
    border-radius: 4px;
  }

  .scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: var(--brand-dark);
  }

  /* Input & Textarea Sizing */
  input,
  textarea,
  select {
    box-sizing: border-box;
  }

  input[type="text"],
  input[type="password"],
  input[type="email"],
  input[type="number"],
  input[type="url"],
  input[type="search"],
  input[type="date"],
  input[type="datetime-local"],
  input[type="time"],
  textarea,
  select {
    padding: 6px;
    background-color: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-input);
    font-weight: 600;
    font-size: 12px;
    font-family: inherit;
    transition: background-color 0.2s ease;
  }

  /* The native calendar/clock picker icon defaults to a dark glyph, which
     is nearly invisible against our dark --bg-input background. Invert it
     so it's visible against the theme. */
  input[type="date"]::-webkit-calendar-picker-indicator,
  input[type="datetime-local"]::-webkit-calendar-picker-indicator,
  input[type="time"]::-webkit-calendar-picker-indicator {
    filter: invert(1);
    cursor: pointer;
  }

  select {
    appearance: none;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 18px;
    padding-right: 28px;
    cursor: pointer;
  }

  input[type="text"]:focus,
  input[type="password"]:focus,
  input[type="email"]:focus,
  input[type="number"]:focus,
  input[type="url"]:focus,
  input[type="search"]:focus,
  input[type="date"]:focus,
  input[type="datetime-local"]:focus,
  input[type="time"]:focus,
  textarea:focus,
  select:focus {
    outline: none;
    background-color: var(--bg-input);
    border-color: var(--brand-light);
  }

  input[readonly],
  textarea[readonly] {
    background-color: var(--bg-input);
    color: #888;
    cursor: not-allowed;
  }

  /* Checkbox and Radio Styling */
  input[type="checkbox"],
  input[type="radio"] {
    cursor: pointer;
    accent-color: var(--brand-light);
    width: 14px;
    height: 14px;
    margin: 0;
    vertical-align: middle;
  }

  /* Custom Checkbox and Radio - scoped to .form-group */
  .form-group input[type="checkbox"],
  .form-group input[type="radio"] {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    background-color: var(--bg-input);
    border: 2px solid var(--border-primary);
    border-radius: 3px;
    cursor: pointer;
    position: relative;
    flex-shrink: 0;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }

  .form-group input[type="radio"] {
    border-radius: 50%;
  }

  .form-group input[type="checkbox"]:checked,
  .form-group input[type="radio"]:checked {
    background-color: var(--brand-light);
    border-color: var(--brand-light);
  }

  .form-group input[type="checkbox"]:checked::after {
    content: '';
    position: absolute;
    left: 2px;
    top: -1px;
    width: 5px;
    height: 9px;
    border: 2px solid white;
    border-top: none;
    border-left: none;
    transform: rotate(45deg);
  }

  .form-group input[type="radio"]:checked::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: white;
  }

  .form-group input[type="checkbox"]:hover,
  .form-group input[type="radio"]:hover {
    border-color: var(--brand-light);
  }

  /* Label Styling */
  label {
    color: var(--text-primary);
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
    display: inline-block;
  }

  label:hover {
    color: var(--text-header);
  }

  /* Form Group Styling */
  .form-group {
    display: flex;
    flex-direction: column;
    margin-bottom: 20px;
  }

  .form-group label {
    margin-bottom: 0;
    display: block;
    font-size: 12px;
  }

  .form-group input:not([type="checkbox"]):not([type="radio"]),
  .form-group textarea,
  .form-group select {
    width: 100%;
  }

  /* Inline form group for checkboxes and radios */
  .form-group--inline {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 4px;
    margin-bottom: 20px;
  }

  .form-group--inline label {
    margin-bottom: 0;
    display: inline-flex;
    align-items: center;
    font-size: 12px;
    font-weight: 400;
  }

  .form-group--inline input[type="checkbox"],
  .form-group--inline input[type="radio"] {
    margin-right: 6px;
  }

  /* Radio Group - container for a set of radio options, each option itself
     styled via .form-group--inline. Default layout is a vertical stack;
     add --horizontal to lay options out in a wrapping row instead. */
  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .radio-group--horizontal {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 15px;
  }

  /* .form-group--inline is also reused *inside* a field's .form-group
     wrapper - directly for checkbox fields, or nested under .radio-group
     for radio options. In both cases the outer .form-group (or
     .radio-group's own gap) already handles spacing, so the margin-bottom
     .form-group--inline normally carries (for spacing standalone
     settings-panel rows apart) needs zeroing out here instead of stacking
     on top and doubling up the space below the field. */
  .form-group .form-group--inline {
    margin-bottom: 0;
  }

  /* Info Icon Tooltip */
  .info-icon {
    position: relative;
  }

  .info-tooltip {
    position: fixed;
    background-color: #1a2838;
    color: #e0e0e0;
    font-size: 12px;
    font-weight: 400;
    padding: 8px 10px;
    border-radius: 4px;
    z-index: 10001;
    border: 1px solid #667eea;
    max-width: 250px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  }

  /* Multi-Select Widget - searchable checklist dropdown with removable
     tags, backed by a hidden native <select multiple> so other code can
     read its selection the same way as any other select. */
  .multi-select-container {
    position: relative;
  }

  .multi-select-hidden-select {
    display: none;
  }

  .multi-select-display {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 16px;
    padding: 6px 60px 6px 8px;
    background-color: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    cursor: pointer;
    position: relative;
  }

  .multi-select-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .multi-select-placeholder {
    color: var(--text-muted);
    font-size: 12px;
  }

  .multi-select-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background-color: var(--brand-light);
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 6px;
    border-radius: 3px;
    white-space: nowrap;
  }

  .multi-select-tag-remove {
    background: none;
    border: none;
    color: #ffffff;
    opacity: 0.75;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 0;
  }

  .multi-select-tag-remove:hover {
    opacity: 1;
  }

  .multi-select-toggle {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    font-size: 10px;
    pointer-events: none;
  }

  .multi-select-clear-all {
    position: absolute;
    right: 24px;
    top: 50%;
    transform: translateY(-50%);
    padding: 2px 6px;
    font-size: 11px;
    font-weight: 600;
    background-color: #b8242f;
    color: #ffffff;
    border: none;
    border-radius: 3px;
    cursor: pointer;
  }

  .multi-select-clear-all:hover {
    background-color: #c62828;
  }

  .multi-select-options {
    display: none;
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    max-height: 260px;
    overflow-y: auto;
    background-color: var(--bg-panel2);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 50;
    padding: 4px 0;
  }

  .multi-select-options.open {
    display: block;
  }

  .multi-select-search {
    padding: 6px 8px;
  }

  .multi-select-search-input {
    width: 100%;
    padding: 6px;
    padding-right: 26px;
    background-color: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-input);
    font-size: 12px;
    box-sizing: border-box;
  }

  .multi-select-search-clear {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 13px;
    padding: 0;
  }

  .multi-select-option {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 12px;
  }

  .multi-select-option:hover {
    background-color: var(--bg-input);
  }

  .multi-select-option label {
    cursor: pointer;
    margin: 0;
  }

  .multi-select-separator {
    border-bottom: 1px solid var(--border-primary);
    margin: 2px 0;
  }

  .multi-select-no-matches {
    padding: 12px 10px;
    color: var(--text-muted);
    text-align: center;
    font-size: 12px;
  }

  /* Searchable Single-Select Widget - shares the .multi-select-options/
     .multi-select-search* dropdown panel styling above; only the display
     area and option-row behavior differ from the multi-select widget. */
  .single-select-container {
    position: relative;
  }

  .single-select-hidden-select {
    display: none;
  }

  .single-select-display {
    display: flex;
    align-items: center;
    min-height: 16px;
    padding: 6px 24px 6px 8px;
    background-color: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    cursor: pointer;
    position: relative;
  }

  .single-select-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-input);
  }

  .single-select-value.single-select-placeholder {
    color: var(--text-muted);
  }

  .single-select-toggle {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    font-size: 10px;
    pointer-events: none;
  }

  .single-select-option {
    cursor: pointer;
  }

  .single-select-option--selected {
    background-color: var(--brand-light);
    color: #ffffff;
  }

  /* Modal Styling */
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    z-index: 2000;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .modal-backdrop.active {
    display: flex;
  }

  .modal-container {
    position: relative;
    background-color: var(--bg-panel1);
    border: 1px solid var(--border-primary);
    border-top: 3px solid var(--brand-light);
    border-radius: 10px;
    max-width: 600px;
    width: 100%;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    animation: modalSlideIn 0.3s ease-out;
  }

  .modal-container.modal-no-scroll {
    max-height: 100vh;
    min-height: 500px;
    overflow: hidden;
  }

  .modal-container.modal-resizable {
    max-width: none;
    max-height: none;
    width: 600px;
    height: 400px;
  }

  @keyframes modalSlideIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .modal-header {
    padding: 20px 20px 5px 20px;
    flex-shrink: 0;
  }

  .modal-header h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: 16px;
    font-weight: 700;
  }

  .modal-body {
    padding: 0 20px;
    overflow-y: auto;
    flex: 1;
  }

  .modal-body.modal-body-no-scroll {
    overflow: hidden;
    flex: 1;
  }

  .modal-body::-webkit-scrollbar {
    width: 8px;
  }

  .modal-body::-webkit-scrollbar-track {
    background-color: var(--bg-input);
  }

  .modal-body::-webkit-scrollbar-thumb {
    background-color: var(--brand-light);
    border-radius: 4px;
  }

  .modal-body::-webkit-scrollbar-thumb:hover {
    background-color: var(--brand-dark);
  }

  .custom-scrollbar {
    scrollbar-width: thin;
    scrollbar-color: var(--brand-light) var(--bg-canvas);
  }

  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  .custom-scrollbar::-webkit-scrollbar-track {
    background-color: var(--bg-canvas);
    border-radius: 3px;
  }

  .custom-scrollbar::-webkit-scrollbar-thumb {
    background-color: var(--brand-light);
    border-radius: 3px;
  }

  .custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: var(--brand-dark);
  }

  .modal-footer {
    padding: 10px 20px;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    flex-shrink: 0;
  }

  .modal-resize-handle {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 20px;
    height: 20px;
    cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, var(--brand-light) 50%);
    border-radius: 0 0 8px 0;
    opacity: 0.3;
    transition: opacity 0.2s;
  }

  .modal-resize-handle:hover {
    opacity: 0.6;
  }

  /* Tab Navigation */
  .tab-navigation {
    display: flex;
    border-bottom: 1px solid var(--border-primary);
    background-color: var(--bg-panel3);
    flex-shrink: 0;
  }

  .tab-btn {
    padding: 6px 15px;
    border: none;
    background-color: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    transition: all 0.2s ease;
    border-bottom: 3px solid transparent;
  }

  .tab-btn:hover {
    color: var(--text-primary);
  }

  .tab-btn.active {
    color: var(--brand-light);
    border-bottom-color: var(--brand-light);
  }

  .tab-panel {
    display: none;
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    flex-direction: column;
  }

  .tab-panel.active {
    display: block;
  }

  /* CodeMirror Editor Styles */
  .cm-editor {
    background-color: var(--bg-canvas);
    height: 100% !important;
  }

  .cm-content {
    background-color: transparent !important;
    color: var(--text-primary);
  }

  .cm-gutters {
    background-color: rgba(0, 0, 0, 0.2) !important;
    color: var(--text-muted);
    border-right: 1px solid var(--border-color);
  }

  .cm-activeLineGutter {
    background-color: rgba(0, 0, 0, 0.6) !important;
  }

  .cm-cursor {
    border-left-color: var(--text-primary);
  }

  /* Tab Container - Use alongside panel-level-1 for tab-based layouts */
  .tab-container {
    width: 100%;
    max-height: 100%;
    padding: 0 !important;
    overflow: hidden;
  }

  /* Draggable Element Styling for Form Builder Palette */
  .draggable-element {
    padding: 10px 12px;
    background-color: var(--bg-panel3);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 500;
    cursor: grab;
    transition: all 0.2s ease;
    user-select: none;
    text-align: center;
  }

  .draggable-element:hover {
    background-color: rgba(76, 181, 255, 0.1);
    border-color: var(--brand-light);
    color: var(--brand-light);
  }

  .draggable-element:active {
    cursor: grabbing;
    opacity: 0.7;
  }

  /* Status Badges */
  .status-badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    width: 50px;
    text-align: center;
    box-sizing: content-box;
  }

  .status-success { background-color: rgba(76, 175, 80, 0.2); color: #4caf50; }
  .status-failure { background-color: rgba(184, 36, 47, 0.2); color: #ff6b6b; }
  .status-running { background-color: rgba(87, 112, 213, 0.6); color: #a8c5ff; }
  .status-warning { background-color: rgba(184, 154, 63, 0.2); color: #b89a3f; }
  .status-skipped { background-color: rgba(170, 177, 186, 0.2); color: #aab1ba; }
  .status-pending { background-color: rgba(170, 177, 186, 0.2); color: #aab1ba; }
  .status-cancelled { background-color: rgba(255, 152, 0, 0.2); color: #ff9800; }

  /* Pagination */
  .pagination-container {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 10px;
    padding: 10px;
  }

  .pagination-btn {
    padding: 4px 10px;
    height: 28px;
    font-size: 12px;
    border: 1px solid var(--border-primary);
    background-color: rgba(0, 0, 0, 0.5);
    color: var(--text-primary);
    border-radius: 3px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .pagination-btn:hover:not(:disabled) {
    background-color: var(--bg-input);
  }

  .pagination-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .pagination-info {
    color: var(--text-muted);
    font-size: 12px;
  }

  /* Clickable Table Rows */
  table tbody tr.clickable-row {
    cursor: pointer;
  }

  table tbody tr.clickable-row:hover {
    background-color: rgba(76, 181, 255, 0.1) !important;
  }
`;
}