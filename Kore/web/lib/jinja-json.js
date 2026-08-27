// ============================================================================
// JINJA-JSON2 Library
// CodeMirror 6 + Jinja Editor Helper Functions
// ============================================================================

import '/lib/base.js';

// Module-level variables for dynamic context updates
let contextData = null;

// Make contextData accessible from console and other scripts
window.jinjaContextData = () => contextData;
Object.defineProperty(window, 'contextData', {
    get: () => contextData,
    set: (val) => { contextData = val; }
});

// Auto-run setupCodeMirror when this file loads
setupCodeMirror();

// ============================================================================
// Setup: Run automatically on load
// ============================================================================

function setupCodeMirror() {
    // Create and inject import map if not already present
    if (!document.querySelector('script[type="importmap"]')) {
        const importMap = document.createElement('script');
        importMap.type = 'importmap';
        importMap.textContent = JSON.stringify({
            imports: {
                'codemirror': '/node_modules/codemirror/dist/index.js',
                'style-mod': '/node_modules/style-mod/src/style-mod.js',
                'w3c-keyname': '/node_modules/w3c-keyname/index.js',
                'crelt': '/node_modules/crelt/index.js',
                '@marijn/find-cluster-break': '/node_modules/@marijn/find-cluster-break/src/index.js',
                '@lezer/common': '/node_modules/@lezer/common/dist/index.js',
                '@lezer/highlight': '/node_modules/@lezer/highlight/dist/index.js',
                '@lezer/lr': '/node_modules/@lezer/lr/dist/index.js',
                '@lezer/css': '/node_modules/@lezer/css/dist/index.js',
                '@lezer/html': '/node_modules/@lezer/html/dist/index.js',
                '@lezer/javascript': '/node_modules/@lezer/javascript/dist/index.js',
                '@lezer/json': '/node_modules/@lezer/json/dist/index.js',
                '@codemirror/state': '/node_modules/@codemirror/state/dist/index.js',
                '@codemirror/view': '/node_modules/@codemirror/view/dist/index.js',
                '@codemirror/language': '/node_modules/@codemirror/language/dist/index.js',
                '@codemirror/commands': '/node_modules/@codemirror/commands/dist/index.js',
                '@codemirror/search': '/node_modules/@codemirror/search/dist/index.js',
                '@codemirror/autocomplete': '/node_modules/@codemirror/autocomplete/dist/index.js',
                '@codemirror/lint': '/node_modules/@codemirror/lint/dist/index.js',
                '@codemirror/lang-html': '/node_modules/@codemirror/lang-html/dist/index.js',
                '@codemirror/lang-css': '/node_modules/@codemirror/lang-css/dist/index.js',
                '@codemirror/lang-javascript': '/node_modules/@codemirror/lang-javascript/dist/index.js',
                '@codemirror/lang-jinja': '/node_modules/@codemirror/lang-jinja/dist/index.js',
                '@codemirror/lang-json': '/node_modules/@codemirror/lang-json/dist/index.js'
            }
        }, null, 2);
        document.head.insertBefore(importMap, document.head.firstChild);
        console.log('[jinja-json] Import map injected');
    } else {
        console.log('[jinja-json] Import map already exists');
    }
}

// ============================================================================
// Jinja Filters Metadata (Loaded Dynamically)
// ============================================================================

let JINJA_FILTERS_METADATA = [];
let filtersLoaded = false;

/**
 * Load filters from Persephone /filters endpoint
 * Fails gracefully if endpoint unavailable
 */
async function loadFiltersMetadata() {
    if (filtersLoaded) return; // Only load once
    
    try {
        const response = await fetch('/engine/filters');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        if (data.filters && Array.isArray(data.filters)) {
            JINJA_FILTERS_METADATA = data.filters;
            filtersLoaded = true;
            console.log(`[jinja-json] Loaded ${JINJA_FILTERS_METADATA.length} filters`);
        } else {
            throw new Error('Invalid filter data structure');
        }
    } catch (error) {
        console.warn(`[jinja-json] Failed to load filters from /filters endpoint:`, error.message);
        // Fail gracefully - filters simply won't be available for autocomplete
        filtersLoaded = true; // Mark as attempted to avoid retries
    }
}

// ============================================================================
// Jinja Editor Creation: Call this to create an editor
// ============================================================================

async function createJinjaEditor(containerId, templateText, contextDataParam, renderCommands = null) {
    // Assign to outer variable for dynamic CTX completion
    contextData = contextDataParam;
    
    // Store editor reference for context updates
    window.jinjaEditorInstance = window.jinjaEditorInstance || {};
    
    // Load filters metadata from endpoint (once)
    await loadFiltersMetadata();
    
    // Import all needed modules
    const { EditorView } = await import('codemirror');
    const { EditorState, StateField, RangeSet, StateEffect } = await import('@codemirror/state');
    const { jinja } = await import('@codemirror/lang-jinja');
    // autocompletion import removed - CTX completion is handled via custom CtxDropdown
    const { syntaxHighlighting, HighlightStyle, foldGutter, indentOnInput } = await import('@codemirror/language');
    const { tags: t } = await import('@lezer/highlight');
    const { linter, lintGutter } = await import('@codemirror/lint');
    const { defaultKeymap, indentWithTab, history, historyKeymap, redo } = await import('@codemirror/commands');
    const { keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration, ViewPlugin } = await import('@codemirror/view');
    const { searchKeymap, highlightSelectionMatches } = await import('@codemirror/search');

    // Custom Jinja comment command (uses {# #} instead of //)
    const jinjaCommentCommand = (view) => {
        const changes = [];
        
        for (const range of view.state.selection.ranges) {
            // Check if selection spans multiple lines
            const fromLine = view.state.doc.lineAt(range.from);
            const toLine = view.state.doc.lineAt(range.to);
            const isMultiLine = fromLine.number !== toLine.number;
            
            if (isMultiLine) {
                // For multiple lines, wrap the entire block in {# #}
                const selectedText = view.state.sliceDoc(range.from, range.to);
                const isCommented = selectedText.trim().startsWith('{#') && selectedText.trim().endsWith('#}');
                
                if (isCommented) {
                    // Uncomment: remove {# and #}
                    const uncommented = selectedText.trim().slice(2, -2).trim();
                    changes.push({
                        from: range.from,
                        to: range.to,
                        insert: uncommented
                    });
                } else {
                    // Comment: wrap in {# #}
                    changes.push({
                        from: range.from,
                        to: range.to,
                        insert: '{# ' + selectedText + ' #}'
                    });
                }
            } else {
                // Single line - use original line-by-line logic
                const line = fromLine;
                const lineStart = line.from;
                const indent = /^\s*/.exec(line.text)[0];
                const trimmed = line.text.trim();
                
                if (trimmed.startsWith('{#') && trimmed.endsWith('#}')) {
                    // Uncomment
                    const text = trimmed.slice(2, -2).trim();
                    changes.push({
                        from: lineStart,
                        to: line.to,
                        insert: indent + text
                    });
                } else {
                    // Comment
                    const text = line.text.slice(indent.length);
                    changes.push({
                        from: lineStart,
                        to: line.to,
                        insert: indent + '{# ' + text + ' #}'
                    });
                }
            }
        }
        
        if (changes.length > 0) {
            view.dispatch({ changes });
        }
        return true;
    };

    const jinjaCommentKeymap = [
        { key: 'Ctrl-/', run: jinjaCommentCommand },
        { key: 'Cmd-/', run: jinjaCommentCommand }
    ];

    // Define bracket decoration helpers (need to be after imports)
    const createBracketDecorations = (doc, ignoreJinja = false) => {
        const text = doc.toString();
        const decorations = [];
        const colorMap = {};
        const unbalancedMap = {};
        const commentMap = {};
        const stack = [];
        const hashComments = [];

        // First pass: map bracket colors and detect unmatched
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const twoChar = text.substring(i, i + 2);

            // Handle Jinja brackets
            if (!ignoreJinja && (twoChar === '{{' || twoChar === '{%' || twoChar === '{#')) {
                const type = twoChar === '{{' ? 'double' : twoChar === '{%' ? 'percent' : 'hash';
                stack.push({ pos: i, char: twoChar, type: type, isJinja: true });
                colorMap[i] = { depth: 0, type: type };
                colorMap[i + 1] = { depth: 0, type: type };
                
                // Track hash comments for content coloring
                if (type === 'hash') {
                    hashComments.push({ start: i, end: null });
                }
                
                i++; // Skip next char
            } else if (!ignoreJinja && (twoChar === '}}' || twoChar === '%}' || twoChar === '#}')) {
                if (stack.length > 0 && stack[stack.length - 1].isJinja) {
                    const matched = stack.pop();
                    colorMap[i] = { depth: 0, type: matched.type };
                    colorMap[i + 1] = { depth: 0, type: matched.type };
                    
                    // Track end of hash comment
                    if (matched.type === 'hash' && hashComments.length > 0) {
                        const lastComment = hashComments[hashComments.length - 1];
                        if (lastComment.end === null) {
                            lastComment.end = i + 1; // Include the closing #}
                        }
                    }
                } else {
                    unbalancedMap[i] = true;
                    unbalancedMap[i + 1] = true;
                }
                i++; // Skip next char
            }
            // Handle regular brackets
            else if (char === '{' && (ignoreJinja || (text[i + 1] !== '{' && text[i + 1] !== '%' && text[i + 1] !== '#'))) {
                const depth = stack.filter(b => !b.isJinja).length % 7;
                stack.push({ pos: i, char: char, depth: depth, type: 'brace', isJinja: false });
                colorMap[i] = { depth: depth, type: 'brace' };
            } else if (char === '}') {
                const brace = stack.findLast(b => b.char === '{' && !b.isJinja);
                if (brace) {
                    stack.splice(stack.indexOf(brace), 1);
                    colorMap[i] = { depth: brace.depth, type: 'brace' };
                } else {
                    unbalancedMap[i] = true;
                }
            } else if (char === '(') {
                const depth = stack.filter(b => !b.isJinja).length % 7;
                stack.push({ pos: i, char: char, depth: depth, type: 'paren', isJinja: false });
                colorMap[i] = { depth: depth, type: 'paren' };
            } else if (char === ')') {
                const paren = stack.findLast(b => b.char === '(' && !b.isJinja);
                if (paren) {
                    stack.splice(stack.indexOf(paren), 1);
                    colorMap[i] = { depth: paren.depth, type: 'paren' };
                } else {
                    unbalancedMap[i] = true;
                }
            } else if (char === '[') {
                const depth = stack.filter(b => !b.isJinja).length % 7;
                stack.push({ pos: i, char: char, depth: depth, type: 'square', isJinja: false });
                colorMap[i] = { depth: depth, type: 'square' };
            } else if (char === ']') {
                const square = stack.findLast(b => b.char === '[' && !b.isJinja);
                if (square) {
                    stack.splice(stack.indexOf(square), 1);
                    colorMap[i] = { depth: square.depth, type: 'square' };
                } else {
                    unbalancedMap[i] = true;
                }
            }
        }

        // Mark hash comment content regions
        hashComments.forEach(comment => {
            if (comment.end !== null) {
                for (let i = comment.start; i < comment.end; i++) {
                    commentMap[i] = true;
                }
            }
        });

        // Mark remaining unmatched brackets
        stack.forEach(b => {
            unbalancedMap[b.pos] = true;
            if (b.isJinja) {
                unbalancedMap[b.pos + 1] = true; // Mark both chars of two-char brackets
            }
        });

        // Create decorations from colorMap and unbalancedMap
        let i = 0;
        while (i < text.length) {
            if (unbalancedMap[i]) {
                decorations.push(Decoration.mark({
                    class: 'cm-unbalanced',
                    attributes: { style: 'color: #8b0000 !important; font-weight: bold !important; text-decoration: underline wavy #8b0000;' }
                }).range(i, i + 1));
                i++;
            } else if (commentMap[i]) {
                // Color the entire hash comment in the hash color
                decorations.push(Decoration.mark({
                    class: 'cm-bracket-hash-0',
                    attributes: { style: 'color: #ff9800 !important;' }
                }).range(i, i + 1));
                i++;
            } else if (colorMap[i]) {
                const colorInfo = colorMap[i];
                let charCount = 1;
                let color = '#e0e0e0'; // default
                
                // Determine color based on type and depth
                if (colorInfo.type === 'double') color = '#2196f3';
                else if (colorInfo.type === 'percent') color = '#4caf50';
                else if (colorInfo.type === 'hash') color = '#ff9800';
                else if (colorInfo.type === 'brace') {
                    const braceColors = ['#ffc107', '#ffca28', '#ffd54f', '#ffe082', '#ffb300', '#ffa000', '#ff6f00'];
                    color = braceColors[colorInfo.depth] || '#ffc107';
                }
                else if (colorInfo.type === 'paren') {
                    const parenColors = ['#7c3aed', '#8d5af5', '#a78bfa', '#c4b5fd', '#6d28d9', '#5b21b6', '#3f0f6b'];
                    color = parenColors[colorInfo.depth] || '#7c3aed';
                }
                else if (colorInfo.type === 'square') {
                    const squareColors = ['#00bcd4', '#26c6da', '#4dd0e1', '#80deea', '#0097a7', '#00695c', '#004d40'];
                    color = squareColors[colorInfo.depth] || '#00bcd4';
                }
                
                // Check if it's a two-character bracket
                if (colorMap[i + 1] && colorMap[i].depth === colorMap[i + 1].depth && 
                    colorMap[i].type === colorMap[i + 1].type) {
                    charCount = 2;
                }
                
                const className = `cm-bracket-${colorInfo.type}-${colorInfo.depth}`;
                decorations.push(Decoration.mark({
                    class: className,
                    attributes: { style: `color: ${color} !important;` }
                }).range(i, i + charCount));
                i += charCount;
            } else {
                i++;
            }
        }

        return RangeSet.of(decorations, true);
    };

    const createJinjaBracketField = () => {
        return StateField.define({
            create(state) {
                const decorations = createBracketDecorations(state.doc, false);
                return decorations;
            },
            update(value, tr) {
                if (tr.docChanged) {
                    const decorations = createBracketDecorations(tr.state.doc, false);
                    return decorations;
                }
                return value;
            }
        });
    };

    const createBracketDecorationsExtension = (field) => {
        return {
            provide: (stateField) => EditorView.decorations.from(field)
        };
    };

    // ===== CUSTOM FILTER COMPLETION DROPDOWN =====
    
    // ===== CTX AUTOCOMPLETE DROPDOWN =====

    class CtxDropdown {
        constructor(view) {
            this.view = view;
            this.dropdownEl = null;
            this.items = [];
            this.dotPos = -1;
            this.selectedIndex = 0;
        }

        show(items, dotPos) {
            this.items = items;
            this.dotPos = dotPos;
            this.selectedIndex = 0;
            this.render();
        }

        hide() {
            if (this.dropdownEl) {
                this.dropdownEl.remove();
                this.dropdownEl = null;
            }
        }

        render() {
            this.hide();
            if (!this.items.length) return;

            this.dropdownEl = document.createElement('div');
            this.dropdownEl.className = 'ctx-dropdown';
            this.dropdownEl.style.cssText = `
                position: fixed;
                background: #2a2a2a;
                border: 1px solid #444;
                border-radius: 4px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.6);
                z-index: 10000;
                max-height: 300px;
                overflow-y: auto;
                min-width: 150px;
                font-family: monospace;
                font-size: 13px;
                max-width: 300px;
            `;

            const list = document.createElement('ul');
            list.style.cssText = 'margin: 0; padding: 0; list-style: none;';

            this.items.forEach((item, idx) => {
                const li = document.createElement('li');
                li.dataset.index = idx;
                li.style.cssText = `
                    padding: 2px 8px;
                    cursor: pointer;
                    user-select: none;
                    border-left: 3px solid transparent;
                    transition: all 0.1s;
                    color: #a0a0a0;
                `;
                li.textContent = item.label + (item.detail ? '  ' + item.detail : '');
                li.addEventListener('mouseover', () => this.select(idx));
                li.addEventListener('click', () => this.insert(idx));
                list.appendChild(li);
            });

            this.dropdownEl.appendChild(list);
            document.body.appendChild(this.dropdownEl);

            // Position below the dot
            const coords = this.view.coordsAtPos(this.dotPos);
            if (coords) {
                const dropdownHeight = 300;
                const spaceBelow = window.innerHeight - coords.top;
                const top = spaceBelow > dropdownHeight
                    ? (coords.top + 14) + 'px'
                    : (coords.top - dropdownHeight) + 'px';
                this.dropdownEl.style.left = (coords.left + 14) + 'px';
                this.dropdownEl.style.top = top;
            }

            this.updateUI();
        }

        select(idx) {
            this.selectedIndex = Math.max(0, Math.min(idx, this.items.length - 1));
            this.updateUI();
        }

        updateUI() {
            if (!this.dropdownEl) return;
            const lis = this.dropdownEl.querySelectorAll('li');
            lis.forEach((li, idx) => {
                if (idx === this.selectedIndex) {
                    li.style.backgroundColor = '#3a5a70';
                    li.style.borderLeftColor = '#0a9fd8';
                    li.style.color = '#fff';
                } else {
                    li.style.backgroundColor = 'transparent';
                    li.style.borderLeftColor = 'transparent';
                    li.style.color = '#a0a0a0';
                }
            });
        }

        insert(idx) {
            const item = this.items[idx];
            const head = this.view.state.selection.main.head;
            // Replace from dot+1 to cursor with the selected property
            const afterDot = this.view.state.doc.sliceString(this.dotPos + 1, head);
            const partialMatch = afterDot.match(/^\w*/)[0];
            this.view.dispatch({
                changes: {
                    from: this.dotPos + 1,
                    to: this.dotPos + 1 + partialMatch.length,
                    insert: item.label
                },
                selection: { anchor: this.dotPos + 1 + item.label.length }
            });
            this.hide();
            ctxDropdown = null;
        }

        handleKey(key) {
            if (key === 'ArrowDown') { this.select(this.selectedIndex + 1); return true; }
            if (key === 'ArrowUp') { this.select(this.selectedIndex - 1); return true; }
            if (key === 'Enter' || key === 'Tab') { this.insert(this.selectedIndex); return true; }
            if (key === 'Escape') { this.hide(); ctxDropdown = null; return true; }
            return false;
        }
    }

    class FilterDropdown {
        constructor(editor, view) {
            this.editor = editor;
            this.view = view;
            this.dropdownEl = null;
            this.hintPanelEl = null;
            this.selectedIndex = -1;
            this.filters = [];
            this.pipePos = -1;
        }
        
        show(filters, pipePos) {
            this.filters = filters;
            this.pipePos = pipePos;
            this.selectedIndex = 0;
            this.render();
        }
        
        hide() {
            if (this.dropdownEl) {
                this.dropdownEl.remove();
                this.dropdownEl = null;
            }
            if (this.hintPanelEl) {
                this.hintPanelEl.remove();
                this.hintPanelEl = null;
            }
        }
        
        render() {
            this.hide();
            
            // Create dropdown container
            this.dropdownEl = document.createElement('div');
            this.dropdownEl.className = 'filter-dropdown';
            this.dropdownEl.style.cssText = `
                position: fixed;
                background: #2a2a2a;
                border: 1px solid #444;
                border-radius: 4px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.6);
                z-index: 10000;
                max-height: 300px;
                overflow-y: auto;
                min-width: 150px;
                font-family: monospace;
                font-size: 13px;
                max-width: 300px;
            `;
            
            // Create filter list
            const list = document.createElement('ul');
            list.style.cssText = 'margin: 0; padding: 0; list-style: none;';
            
            this.filters.forEach((filter, idx) => {
                const li = document.createElement('li');
                li.className = 'filter-item';
                li.dataset.index = idx;
                li.style.cssText = `
                    padding: 2px 8px;
                    cursor: pointer;
                    user-select: none;
                    border-left: 3px solid transparent;
                    transition: all 0.1s;
                `;
                
                // Create filter name only
                const hasParams = filter.parameters && filter.parameters.length > 0;
                li.textContent = hasParams ? filter.name + '()' : filter.name;
                li.style.color = '#a0a0a0';
                
                // Hover
                li.addEventListener('mouseover', () => this.select(idx));
                
                // Click to insert
                li.addEventListener('click', () => this.insert(idx));
                
                list.appendChild(li);
            });
            
            this.dropdownEl.appendChild(list);
            document.body.appendChild(this.dropdownEl);
            
            // Position dropdown with smart vertical placement
            const coords = this.view.coordsAtPos(this.pipePos);
            if (coords) {
                const dropdownHeight = 300;
                const spaceBelow = window.innerHeight - coords.top;
                const spaceAbove = coords.top;
                
                let top, bottom;
                let positioningUp = false;
                
                // If there's enough space below, position below cursor
                if (spaceBelow > dropdownHeight) {
                    top = (coords.top + 14) + 'px';
                    bottom = 'auto';
                } else if (spaceAbove > dropdownHeight) {
                    // Position above cursor - add 12px down offset + 10px more for alignment
                    top = (coords.top - dropdownHeight - 20 + 12 + 10) + 'px';
                    bottom = 'auto';
                    positioningUp = true;
                } else {
                    // Not enough space either way, position below but constrain to viewport
                    top = (coords.top + 2) + 'px';
                    bottom = 'auto';
                }
                
                this.dropdownEl.style.left = (coords.left + 14) + 'px';
                this.dropdownEl.style.top = top;
                this.dropdownEl.style.bottom = bottom;
                
                // Ensure dropdown doesn't go below viewport
                setTimeout(() => {
                    const rect = this.dropdownEl.getBoundingClientRect();
                    if (rect.bottom > window.innerHeight) {
                        const overflow = rect.bottom - window.innerHeight + 4; // 4px buffer
                        this.dropdownEl.style.top = (parseInt(this.dropdownEl.style.top) - overflow) + 'px';
                    }
                    
                    // Position hint panel: top-left of hint aligns with top-right of dropdown
                    if (this.hintPanelEl) {
                        const dropdownRect = this.dropdownEl.getBoundingClientRect();
                        let hintLeft = dropdownRect.right + 8; // 8px gap
                        
                        // Ensure hint doesn't go beyond right edge of viewport
                        if (hintLeft + 300 > window.innerWidth) {
                            hintLeft = window.innerWidth - 300 - 4; // 4px buffer from right edge
                        }
                        
                        this.hintPanelEl.style.left = hintLeft + 'px';
                        this.hintPanelEl.style.top = dropdownRect.top + 'px';
                        this.hintPanelEl.style.right = 'auto';
                    }
                }, 0);
            }
            
            // Show hint for first item
            this.updateUI();
        }
        
        select(idx) {
            this.selectedIndex = Math.max(0, Math.min(idx, this.filters.length - 1));
            this.updateUI();
        }
        
        updateUI() {
            // Update list styling
            const items = this.dropdownEl.querySelectorAll('.filter-item');
            items.forEach((item, idx) => {
                if (idx === this.selectedIndex) {
                    item.style.backgroundColor = '#3a5a70';
                    item.style.borderLeftColor = '#0a9fd8';
                    item.style.color = '#fff';
                } else {
                    item.style.backgroundColor = 'transparent';
                    item.style.borderLeftColor = 'transparent';
                    item.style.color = '#a0a0a0';
                }
            });
            
            // Update hint panel
            this.showHint(this.filters[this.selectedIndex]);
        }
        
        showHint(filter) {
            if (!this.hintPanelEl) {
                this.hintPanelEl = document.createElement('div');
                this.hintPanelEl.style.cssText = `
                    position: fixed;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    border-radius: 4px;
                    padding: 12px;
                    width: 300px;
                    max-width: 300px;
                    max-height: 500px;
                    overflow-y: auto;
                    z-index: 10001;
                    font-size: 12px;
                    line-height: 1.6;
                    color: #c0c0c0;
                `;
                document.body.appendChild(this.hintPanelEl);
            }
            
            let html = `<div style="color: #e0e0e0; font-weight: bold; margin-bottom: 8px;">${filter.name}</div>`;
            html += `<div style="color: #b0b0b0; margin-bottom: 12px;">${filter.description || ''}</div>`;
            
            if (filter.parameters && filter.parameters.length > 0) {
                html += '<div style="color: #a0d8ff; font-weight: bold; margin-top: 12px; margin-bottom: 6px;">Parameters:</div>';
                filter.parameters.forEach(param => {
                    html += `<div style="margin-left: 8px; margin-bottom: 4px;">`;
                    html += `<span style="color: #a0d8ff;">${param.name}</span> <span style="color: #888;">(${param.type})</span>`;
                    html += `<div style="color: #999; font-size: 11px; margin-top: 2px;">${param.description}</div>`;
                    html += `</div>`;
                });
            }
            
            if (filter.examples && filter.examples.length > 0) {
                html += '<div style="color: #a0d8ff; font-weight: bold; margin-top: 12px; margin-bottom: 6px;">Examples:</div>';
                filter.examples.forEach(example => {
                    html += `<div style="margin-left: 8px; margin-bottom: 6px;">`;
                    html += `<div style="color: #90ee90; background: #1a1a1a; padding: 6px; border-radius: 3px; font-family: monospace; font-size: 11px; overflow-x: auto;">`;
                    html += `${example.template} &#8594; ${example.output}`;
                    html += `</div></div>`;
                });
            }
            
            this.hintPanelEl.innerHTML = html;
        }
        
        insert(idx) {
            const filter = this.filters[idx];
            const hasParams = filter.parameters && filter.parameters.length > 0;
            const filterName = hasParams ? filter.name + '()' : filter.name;
            
            // Get current position and replace from pipe onwards
            const editor = this.view;
            const beforeCursor = editor.state.doc.sliceString(0, this.pipePos + 1);
            const lastPipe = beforeCursor.lastIndexOf('|');
            
            // Find end of existing filter text after pipe (spaces + word chars + parens only)
            const docLength = editor.state.doc.length;
            let scanPos = this.pipePos + 1;
            const docText = editor.state.doc.sliceString(scanPos, Math.min(scanPos + 100, docLength));
            const existingMatch = docText.match(/^[\s\w()]*/);
            const replaceEnd = scanPos + (existingMatch ? existingMatch[0].length : 0);
            
            // Normalize spacing: ensure exactly 1 space between pipe and filter
            const insertText = ' ' + filterName;
            
            editor.dispatch({
                changes: {
                    from: this.pipePos + 1,
                    to: replaceEnd,
                    insert: insertText
                }
            });
            
            this.hide();
            filterDropdown = null; // Reset global reference so new dropdown can be created
            filterDropdownLocked = false;
        }
        
        handleKey(key) {
            if (key === 'ArrowDown') {
                this.select(this.selectedIndex + 1);
                return true;
            } else if (key === 'ArrowUp') {
                this.select(this.selectedIndex - 1);
                return true;
            } else if (key === 'Enter' || key === 'Tab') {
                this.insert(this.selectedIndex);
                return true;
            } else if (key === 'Escape') {
                this.hide();
                return true;
            }
            return false;
        }
    }
    
    let filterDropdown = null;
    let filterDropdownLocked = false;
    let ctxDropdown = null; // When true, only explicit selection or outside click closes it
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        // Don't close on Ctrl/Meta click - that's used to re-open the dropdown
        if (e.ctrlKey || e.metaKey) return;
        // Only close filter dropdown if clicked in editor area (not in DevTools)
        if (filterDropdown && filterDropdown.dropdownEl && 
            e.target.closest('#editor-wrapper') &&
            !filterDropdown.dropdownEl.contains(e.target) && 
            (!filterDropdown.hintPanelEl || !filterDropdown.hintPanelEl.contains(e.target))) {
            filterDropdown.hide();
            filterDropdown = null;
            filterDropdownLocked = false;
        }
        if (ctxDropdown && ctxDropdown.dropdownEl &&
            !ctxDropdown.dropdownEl.contains(e.target)) {
            ctxDropdown.hide();
            ctxDropdown = null;
        }
    }, true);

    // Define highlight style for better variable coloring
    const highlightStyle = HighlightStyle.define([
        { tag: t.keyword, color: '#c678dd' },
        { tag: t.variableName, color: '#61afef' },
        { tag: t.propertyName, color: '#61afef' },
        { tag: t.name, color: '#61afef' },
        { tag: t.function(t.variableName), color: '#90ee90' }  // Filters (function calls) in green
    ]);

    // Bracket validation linting function
    const validateBrackets = (view) => {
        // view is actually the EditorView, get the state and doc from it
        const state = view.state || view;
        const text = state.doc.toString();
        const diagnostics = [];
        const stack = [];

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const twoChar = text.substring(i, i + 2);

            // Handle Jinja opening brackets
            if (twoChar === '{{' || twoChar === '{%' || twoChar === '{#') {
                stack.push({ pos: i, char: twoChar });
                i++;
            } 
            // Handle Jinja closing brackets
            else if (twoChar === '}}' || twoChar === '%}' || twoChar === '#}') {
                const opening = stack.pop();
                if (!opening) {
                    diagnostics.push({
                        from: i,
                        to: i + 2,
                        severity: 'error',
                        message: `Unmatched ${twoChar}`
                    });
                }
                i++;
            }
        }

        // Report remaining unmatched opening brackets
        stack.forEach(b => {
            diagnostics.push({
                from: b.pos,
                to: b.pos + 2,
                severity: 'error',
                message: `Unmatched ${b.char}`
            });
        });

        return diagnostics;
    };

    // Create bracket decorations
    const jinjaBracketField = createJinjaBracketField();
    const bracketDecorationsExt = createBracketDecorationsExtension(jinjaBracketField);
    
    // Track finished pipes by their absolute document position
    let finishedPipes = new Set();
    let lastDropdownPipePos = -1;

    // Monitor document changes to detect pipe character and update filter dropdown
    const documentChangeListener = EditorView.updateListener.of((update) => {
        const view = update.view;
        const pos = view.state.selection.main.head;
        const beforeCursor = view.state.doc.sliceString(Math.max(0, pos - 50), pos);
        const lastPipe = beforeCursor.lastIndexOf('|');
        
        if (lastPipe !== -1) {
            const afterPipe = beforeCursor.slice(lastPipe + 1);
            const actualPipePos = pos - (beforeCursor.length - lastPipe);
            const pipeKey = actualPipePos.toString();
            
            // Check if cursor moved away from the previous pipe
            if (lastDropdownPipePos !== -1 && actualPipePos !== lastDropdownPipePos) {
                // Cursor moved to a different pipe, mark the old one as finished
                finishedPipes.add(lastDropdownPipePos.toString());
                if (filterDropdown && !filterDropdownLocked) {
                    filterDropdown.hide();
                    filterDropdown = null;
                }
            }
            
            // Track the current pipe position
            lastDropdownPipePos = actualPipePos;
            
            // If there's a word character followed by space, mark this pipe as finished
            if (/\w\s+$/.test(afterPipe)) {
                if (filterDropdown && !filterDropdownLocked) {
                    filterDropdown.hide();
                    filterDropdown = null;
                }
                finishedPipes.add(pipeKey);  // Mark this pipe position as done
                lastDropdownPipePos = -1;
            }
            // Only show/update if text after pipe is just spaces/word chars,
            // pipe isn't finished, and update was from typing (not just cursor movement)
            else if (/^[\s\w]*$/.test(afterPipe) && !finishedPipes.has(pipeKey) && update.docChanged) {
                // Get all sorted filters
                const sortedFilters = [...JINJA_FILTERS_METADATA].sort((a, b) => a.name.localeCompare(b.name));
                
                // Filter based on what the user typed (after trimming leading space)
                const filterText = afterPipe.trim().toLowerCase();
                const filtered = filterText 
                    ? sortedFilters.filter(f => f.name.toLowerCase().startsWith(filterText))
                    : sortedFilters;
                
                // Show or update dropdown
                if (!filterDropdown) {
                    filterDropdown = new FilterDropdown(view, view);
                }
                filterDropdown.show(filtered, actualPipePos);
            }
        } else {
            // No pipe found - mark the last pipe as finished if there was one
            if (lastDropdownPipePos !== -1) {
                finishedPipes.add(lastDropdownPipePos.toString());
            }
            
            if (filterDropdown && !filterDropdownLocked) {
                filterDropdown.hide();
                filterDropdown = null;
            }
            lastDropdownPipePos = -1;
        }
        
        // Clear finished pipes if document changed (they may have moved/deleted)
        if (update.docChanged) {
            finishedPipes.clear();
        }
        
        // CTX property autocomplete - use live context from JSON editor if available
        const liveContextData = (() => {
            if (window._jinjaJsonEditor) {
                try { return JSON.parse(window._jinjaJsonEditor.state.doc.toString()); } catch(e) {}
            }
            return contextData;
        })();
        if (update.docChanged && liveContextData) {
            const head = update.state.selection.main.head;
            const before = update.state.doc.sliceString(Math.max(0, head - 50), head);
            const ctxDotMatch = before.match(/CTX\.([\w]*)$/);
            if (ctxDotMatch) {
                const dotPos = head - ctxDotMatch[1].length - 1; // position of the dot
                const partial = ctxDotMatch[1].toLowerCase();
                const props = Object.keys(liveContextData).sort()
                    .filter(k => k.toLowerCase().startsWith(partial))
                    .map(k => ({ label: k, detail: '(' + typeof liveContextData[k] + ')' }));
                if (props.length) {
                    if (!ctxDropdown) ctxDropdown = new CtxDropdown(update.view);
                    ctxDropdown.show(props, dotPos);
                } else {
                    if (ctxDropdown) { ctxDropdown.hide(); ctxDropdown = null; }
                }
            } else {
                if (ctxDropdown) { ctxDropdown.hide(); ctxDropdown = null; }
            }
        } else if (!update.docChanged) {
            // Hide CTX dropdown on cursor movement away
            if (ctxDropdown) {
                const head = update.state.selection.main.head;
                const before = update.state.doc.sliceString(Math.max(0, head - 50), head);
                if (!before.match(/CTX\.\w*$/)) {
                    ctxDropdown.hide();
                    ctxDropdown = null;
                }
            }
        }
    });

    // Monitor for selection attempts - close dropdown when user starts selecting in editor
    const editorMousedownHandler = (e) => {
        // Don't close if Ctrl/Meta held - that's a Ctrl+Click to re-open the dropdown
        if (e.ctrlKey || e.metaKey) return;
        const isInDropdown = e.target.closest('.filter-dropdown');
        const isInEditor = e.target.closest('.cm-editor');
        
        // If clicking in editor but not on dropdown, close it
        if (isInEditor && !isInDropdown && filterDropdown && !filterDropdownLocked) {
            filterDropdown.hide();
            filterDropdown = null;
        }
        if (isInEditor && ctxDropdown && ctxDropdown.dropdownEl &&
            !ctxDropdown.dropdownEl.contains(e.target)) {
            ctxDropdown.hide();
            ctxDropdown = null;
        }
    };

    // Ctrl+Click in editor re-opens filter autocomplete for the pipe near cursor
    // Note: references `editor` which is assigned after this handler is declared — closure is fine
    const editorCtrlClickHandler = (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const isInEditor = e.target.closest('.cm-editor');
        const isInDropdown = e.target.closest('.filter-dropdown');
        if (!isInEditor || isInDropdown) return;
        
        // Get click position in the document
        const clickPos = editor.posAtCoords({ x: e.clientX, y: e.clientY });
        if (clickPos === null) return;
        
        // Look for a pipe before the click position
        const beforeClick = editor.state.doc.sliceString(Math.max(0, clickPos - 50), clickPos);
        const lastPipe = beforeClick.lastIndexOf('|');
        if (lastPipe === -1) return;
        
        const afterPipe = beforeClick.slice(lastPipe + 1);
        if (!/^[\s\w()]*$/.test(afterPipe)) return;
        
        const actualPipePos = clickPos - (beforeClick.length - lastPipe);
        const pipeKey = actualPipePos.toString();
        
        // Re-activate this pipe and show dropdown (lock so cursor movement won't close it)
        finishedPipes.delete(pipeKey);
        lastDropdownPipePos = actualPipePos;
        filterDropdownLocked = true;
        
        const sortedFilters = [...JINJA_FILTERS_METADATA].sort((a, b) => a.name.localeCompare(b.name));
        const filterText = afterPipe.trim().replace(/[()]/g, '').toLowerCase();
        const filtered = filterText
            ? sortedFilters.filter(f => f.name.toLowerCase().startsWith(filterText))
            : sortedFilters;
        
        if (!filterDropdown) {
            filterDropdown = new FilterDropdown(editor, editor);
        }
        filterDropdown.show(filtered, actualPipePos);
    };

    // Handle typing bracket characters when text is selected - wrap selection
    const handleBracketWrap = (view, char) => {
        const changes = [];
        const bracketPairs = {
            '(': ')',
            '[': ']',
            '{': '}',
            '"': '"',
            "'": "'",
            '{{': '}}',
            '{%': '%}'
        };
        
        const closingChar = bracketPairs[char];
        if (!closingChar) return false;
        
        for (const range of view.state.selection.ranges) {
            if (range.empty) continue; // Skip empty selections
            
            changes.push({
                from: range.from,
                to: range.from,
                insert: char
            });
            changes.push({
                from: range.to,
                to: range.to,
                insert: closingChar
            });
        }
        
        if (changes.length > 0) {
            view.dispatch({ changes });
            return true;
        }
        return false;
    };

    // Check if cursor is currently inside a Jinja tag ({{ }}, {%  %}, {# #})
    const isInsideJinjaTag = (view) => {
        const pos = view.state.selection.main.head;
        const doc = view.state.doc.toString();
        // Scan backwards for the nearest Jinja opener
        const openers = ['{{-', '{{', '{%-', '{%', '{#-', '{#'];
        const closers = ['-}}', '}}', '-%}', '%}', '-#}', '#}'];
        let nearestOpen = -1;
        let nearestOpenEnd = -1;
        for (const opener of openers) {
            const idx = doc.lastIndexOf(opener, pos - 1);
            if (idx !== -1 && idx > nearestOpen) {
                nearestOpen = idx;
                nearestOpenEnd = idx + opener.length;
            }
        }
        if (nearestOpen === -1) return false;
        // Check that a closer follows the cursor
        for (const closer of closers) {
            const idx = doc.indexOf(closer, pos);
            if (idx !== -1) {
                // Make sure there's no other opener between nearestOpen and pos
                return true;
            }
        }
        return false;
    };

    // Filter out the default comment keybindings and add our Jinja-specific ones
    const filteredDefaultKeymap = defaultKeymap.filter(binding => 
        binding.key !== 'Ctrl-/' && binding.key !== 'Cmd-/'
    );

    // Build complete keymap with our custom commands
    const completeKeymap = [
        ...(renderCommands ? renderCommands : []),
        ...jinjaCommentKeymap,
        // Tab key - accept autocomplete if open, otherwise indent
        {
            key: 'Tab',
            run: (view) => {
                // Check if filter dropdown is open
                if (filterDropdown && filterDropdown.dropdownEl) {
                    return filterDropdown.handleKey('Tab');
                }
                // Try to accept CTX dropdown completion
                if (ctxDropdown && ctxDropdown.dropdownEl) {
                    return ctxDropdown.handleKey('Tab');
                }
                // Default: indent using the standard indentation command
                return indentWithTab.run(view);
            }
        },
        {
            key: 'Backspace',
            run: (view) => {
                const pos = view.state.selection.main.head;
                // Pairs to check for backspace deletion/downgrade
                const states = [
                    // Dash state -> downgrade to plain state
                    { before: '{{-', after: ' -}}', newBefore: '{{', newAfter: ' }}' },
                    { before: '{%-', after: ' -%}', newBefore: '{%', newAfter: ' %}' },
                    { before: '{#-', after: ' -#}', newBefore: '{#', newAfter: ' #}' },
                    // Plain state -> remove closing entirely, leave single {
                    { before: '{{', after: ' }}', newBefore: '{', newAfter: '' },
                    { before: '{%', after: ' %}', newBefore: '{', newAfter: '' },
                    { before: '{#', after: ' #}', newBefore: '{', newAfter: '' },
                    // Inner bracket pairs - remove closing when cursor is between empty pair
                    { before: '(', after: ')', newBefore: '', newAfter: '' },
                    { before: '[', after: ']', newBefore: '', newAfter: '' },
                    { before: '{', after: '}', newBefore: '', newAfter: '' },
                ];
                for (const s of states) {
                    const before = view.state.doc.sliceString(pos - s.before.length, pos);
                    const after = view.state.doc.sliceString(pos, pos + s.after.length);
                    if (before === s.before && after === s.after) {
                        const from = pos - s.before.length;
                        const to = pos + s.after.length;
                        view.dispatch({
                            changes: { from, to, insert: s.newBefore + s.newAfter },
                            selection: { anchor: from + s.newBefore.length }
                        });
                        return true;
                    }
                }
                return false;
            }
        },
        // Bracket wrapping for selections
        { key: '"', run: (view) => handleBracketWrap(view, '"') },
        { key: "'", run: (view) => handleBracketWrap(view, "'") },
        {
            key: '(',
            run: (view) => {
                if (handleBracketWrap(view, '(')) return true;
                if (isInsideJinjaTag(view)) {
                    const pos = view.state.selection.main.head;
                    view.dispatch({
                        changes: { from: pos, to: pos, insert: '()' },
                        selection: { anchor: pos + 1 }
                    });
                    return true;
                }
                return false;
            }
        },
        {
            key: '[',
            run: (view) => {
                if (handleBracketWrap(view, '[')) return true;
                if (isInsideJinjaTag(view)) {
                    const pos = view.state.selection.main.head;
                    view.dispatch({
                        changes: { from: pos, to: pos, insert: '[]' },
                        selection: { anchor: pos + 1 }
                    });
                    return true;
                }
                return false;
            }
        },
        // Jinja auto-close pairs
        {
            key: '{',
            run: (view) => {
                // Wrap selection if any
                if (handleBracketWrap(view, '{')) return true;
                const pos = view.state.selection.main.head;
                const before = view.state.doc.sliceString(pos - 1, pos);
                // Auto-close Jinja tag: if previous char is '{', insert '{ }}' (the char + closing)
                if (before === '{') {
                    view.dispatch({
                        changes: { from: pos, to: pos, insert: '{ }}' },
                        selection: { anchor: pos + 1 }
                    });
                    return true;
                }
                // Auto-close single { inside a Jinja tag
                if (isInsideJinjaTag(view)) {
                    view.dispatch({
                        changes: { from: pos, to: pos, insert: '{}' },
                        selection: { anchor: pos + 1 }
                    });
                    return true;
                }
                return false;
            }
        },
        {
            key: '%',
            run: (view) => {
                // Auto-close {%: if previous char is '{', insert '% %}'
                const pos = view.state.selection.main.head;
                const before = view.state.doc.sliceString(pos - 1, pos);
                if (before === '{') {
                    view.dispatch({
                        changes: { from: pos, to: pos, insert: '% %}' },
                        selection: { anchor: pos + 1 }
                    });
                    return true;
                }
                return false;
            }
        },
        {
            key: '#',
            run: (view) => {
                // Auto-close {#: if previous char is '{', insert '# #}'
                const pos = view.state.selection.main.head;
                const before = view.state.doc.sliceString(pos - 1, pos);
                if (before === '{') {
                    view.dispatch({
                        changes: { from: pos, to: pos, insert: '# #}' },
                        selection: { anchor: pos + 1 }
                    });
                    return true;
                }
                return false;
            }
        },
        {
            key: '-',
            run: (view) => {
                const pos = view.state.selection.main.head;
                // Check if we're inside an auto-closed pair and should add dashes
                // Pattern: cursor is after '{{ ' and before ' }}'  -> change to '{{- ' and ' -}}'
                // Pattern: cursor is after '{% ' and before ' %}'  -> change to '{%- ' and ' -%}'
                // Pattern: cursor is after '{# ' and before ' #}'  -> change to '{#- ' and ' -#}'
                const pairs = [
                    { open: '{{', closeOld: ' }}', closeNew: ' -}}' },
                    { open: '{%', closeOld: ' %}', closeNew: ' -%}' },
                    { open: '{#', closeOld: ' #}', closeNew: ' -#}' },
                ];
                for (const pair of pairs) {
                    const before = view.state.doc.sliceString(pos - pair.open.length, pos);
                    const after = view.state.doc.sliceString(pos, pos + pair.closeOld.length);
                    if (before === pair.open && after === pair.closeOld) {
                        // First update the closing pair, then insert '-' at cursor
                        // Do closing first (higher offset) to avoid position shifting
                        view.dispatch({
                            changes: { from: pos, to: pos + pair.closeOld.length, insert: pair.closeNew }
                        });
                        view.dispatch({
                            changes: { from: pos, to: pos, insert: '-' },
                            selection: { anchor: pos + 1 }
                        });
                        return true;
                    }
                }
                return false;
            }
        },
        ...filteredDefaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        { key: 'Ctrl-Shift-z', run: redo },
        { key: 'Cmd-Shift-z', run: redo },
        // Handle keyboard navigation in filter dropdown
        {
            key: 'ArrowDown',
            run: (view) => {
                if (filterDropdown && filterDropdown.dropdownEl) {
                    return filterDropdown.handleKey('ArrowDown');
                }
                if (ctxDropdown && ctxDropdown.dropdownEl) {
                    return ctxDropdown.handleKey('ArrowDown');
                }
                return false;
            }
        },
        {
            key: 'ArrowUp',
            run: (view) => {
                if (filterDropdown && filterDropdown.dropdownEl) {
                    return filterDropdown.handleKey('ArrowUp');
                }
                if (ctxDropdown && ctxDropdown.dropdownEl) {
                    return ctxDropdown.handleKey('ArrowUp');
                }
                return false;
            }
        },
        {
            key: 'Enter',
            run: (view) => {
                if (filterDropdown && filterDropdown.dropdownEl) {
                    return filterDropdown.handleKey('Enter');
                }
                if (ctxDropdown && ctxDropdown.dropdownEl) {
                    return ctxDropdown.handleKey('Enter');
                }
                return false;
            }
        },
        {
            key: 'Escape',
            run: (view) => {
                if (filterDropdown && filterDropdown.dropdownEl) {
                    return filterDropdown.handleKey('Escape');
                }
                if (ctxDropdown && ctxDropdown.dropdownEl) {
                    return ctxDropdown.handleKey('Escape');
                }
                return false;
            }
        },
    ];

    // Create update listener to mark filter names with a class for styling
    const filterColorListener = EditorView.updateListener.of((update) => {
        // Mark filter names that come after pipes
        const lines = update.view.dom.querySelectorAll('.cm-line');
        lines.forEach(line => {
            // Walk through all child nodes (including text nodes)
            const children = Array.from(line.childNodes);
            
            for (let i = 0; i < children.length; i++) {
                const node = children[i];
                
                // Check if this is a text node containing a pipe
                if (node.nodeType === Node.TEXT_NODE && node.textContent.includes('|')) {
                    // Find the next span element (should be the filter name)
                    let nextIdx = i + 1;
                    let foundFilter = false;
                    let checkCount = 0;
                    while (nextIdx < children.length && !foundFilter && checkCount < 5) {
                        const nextNode = children[nextIdx];
                        checkCount++;
                        
                        // If it's a span, check if it's a variable/property token
                        if (nextNode.nodeType === Node.ELEMENT_NODE && nextNode.tagName === 'SPAN') {
                            const className = nextNode.className;
                            // Minified token classes are 2 chars: a special char + a letter
                            // Check if className is 2 chars and second char is a letter
                            if (className && className.length === 2 && /[a-z]/.test(className[1]) && className.charCodeAt(0) > 127) {
                                // Add both class and inline style for maximum effect
                                nextNode.classList.add('cm-filter-name');
                                nextNode.style.color = '#90ee90 !important';
                                nextNode.style.fontWeight = 'bold';
                                foundFilter = true;
                                break;
                            }
                        }
                        nextIdx++;
                    }
                }
            }
        });
    });

    // Create editor state
    const state = EditorState.create({
        doc: templateText,
        extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            filterColorListener,
            history(),
            foldGutter(),
            lintGutter(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            indentOnInput(),
            syntaxHighlighting(highlightStyle),

            documentChangeListener,
            rectangularSelection(),
            crosshairCursor(),
            highlightSelectionMatches(),
            keymap.of(completeKeymap),
            linter(validateBrackets),
            jinjaBracketField,
            bracketDecorationsExt.provide(jinjaBracketField),
            jinja(),
            EditorView.lineWrapping,
            EditorView.theme({
                '.cm-editor': { height: '100%', width: '100%', flex: '1', overflow: 'hidden', minWidth: '0' },
                '.cm-content': { backgroundColor: '#1a3540', color: '#e0e0e0' },
                '.cm-selectionBackground': { backgroundColor: '#ffff00' },
                '.cm-selection': { backgroundColor: '#ffff00' }
            }, { dark: true })
        ]
    });

    // Inject CSS for wrapper styling
    const styleId = 'editor-wrapper-styles';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            #editor-wrapper {
                border-radius: 4px;
                border: 1px solid #555;
                overflow: hidden;
                height: 100%;
                width: 100%;
                min-width: 0;
            }
            #editor-wrapper .cm-editor {
                flex: 1;
                min-width: 0;
                min-height: 0;
                overflow: hidden;
            }
            #editor-wrapper .cm-scroller {
                overflow-y: auto !important;
                overflow-x: auto !important;
                min-width: 0;
                min-height: 0;
            }
            #editor-wrapper .cm-line {
                white-space: pre-wrap;
                word-wrap: break-word;
                padding-left: 1.5em;
                text-indent: -1.5em;
            }
            #editor-wrapper .cm-scroller::-webkit-scrollbar {
                width: 10px;
                height: 10px;
            }
            #editor-wrapper .cm-scroller::-webkit-scrollbar-track {
                background: #1f4051;
                border-radius: 4px;
            }
            #editor-wrapper .cm-scroller::-webkit-scrollbar-thumb {
                background: #5a9fb8;
                border-radius: 4px;
            }
            #editor-wrapper .cm-scroller::-webkit-scrollbar-thumb:hover {
                background: #7ab5d0;
            }
            
            /* Selection highlighting - bright yellow with proper z-index */
            .cm-selectionLayer {
                z-index: 1 !important;
            }
            
            .cm-selectionBackground {
                background-color: #ffff00 !important;
                z-index: 1 !important;
                pointer-events: none !important;
                opacity: 0.15 !important;
            }
            
            .cm-editor.cm-focused .cm-selectionBackground {
                background-color: #ffff00 !important;
                z-index: 1 !important;
                opacity: 0.15 !important;
            }
            
            .cm-content .cm-selectionBackground {
                background-color: #ffff00 !important;
                z-index: 1 !important;
                opacity: 0.15 !important;
            }
            
            .cm-selected {
                background-color: #ffff00 !important;
                z-index: 1 !important;
            }
            
            /* CodeMirror completion widget styling */
            .cm-completionLabel {
                color: #a0a0a0;
            }
            
            .cm-completion-label {
                color: #a0a0a0;
            }
            
            .cm-tooltip.cm-completionInfo {
                background-color: #2a2a2a !important;
                border: 1px solid #444 !important;
                border-radius: 4px !important;
                color: #c0c0c0 !important;
                box-shadow: 0 8px 24px rgba(0,0,0,0.6) !important;
            }
            
            .cm-tooltip-autocomplete {
                background-color: #2a2a2a !important;
                border: 1px solid #444 !important;
                border-radius: 4px !important;
                box-shadow: 0 8px 24px rgba(0,0,0,0.6) !important;
                max-height: 300px !important;
                height: auto !important;
            }
            
            .cm-tooltip-autocomplete > ul {
                max-height: 300px !important;
                height: auto;
            }
            
            /* Remove the "x" icon from completion items */
            .cm-completionIcon {
                display: none !important;
            }
            
            .cm-completionLabel::before {
                content: "" !important;
                display: none !important;
            }
            
            .cm-option {
                position: relative;
            }
            
            .cm-option::before {
                display: none !important;
            }
            
            .cm-tooltip-autocomplete .cm-completionLabel::before {
                display: none !important;
            }
            
            .cm-tooltip-autocomplete > ul > li {
                padding: 2px 8px !important;
                color: #a0a0a0 !important;
                border-left: 3px solid transparent !important;
                background-color: transparent;
            }
            
            .cm-tooltip-autocomplete > ul > li[aria-selected] {
                background-color: #3a5a70 !important;
                color: #fff !important;
                border-left-color: #0a9fd8 !important;
            }
            
            /* Filter names in green */
            .cm-filter-name {
                color: #90ee90 !important;
                font-weight: bold;
            }
            
            /* Linting indicator triangle in bottom right corner */
            #linting-indicator {
                position: absolute;
                bottom: 1px;
                right: 14px;
                width: 0;
                height: 0;
                border-left: 12px solid transparent;
                border-top: 12px solid transparent;
                border-right: 12px solid #FFD700;
                border-bottom: 12px solid #FFD700;
                display: none;
                z-index: 100;
            }
            
            /* If no scrollbar, move it all the way to the right */
            #editor-wrapper:not(.scrollbar) #linting-indicator {
                right: 0px;
            }
            
            #linting-indicator.has-errors {
                display: block;
            }
            
            #linting-indicator::after {
                content: '!';
                position: absolute;
                bottom: -10px;
                right: -8px;
                font-size: 12px;
                font-weight: bold;
                color: #333;
            }
        `;
        document.head.appendChild(style);
    }

    // Add scrollbar class to editor-wrapper for base.css styling
    const wrapper = document.getElementById('editor-wrapper');
    if (wrapper) {
        wrapper.classList.add('scrollbar');
        // Add linting indicator
        const indicator = document.createElement('div');
        indicator.id = 'linting-indicator';
        wrapper.style.position = 'relative';
        wrapper.appendChild(indicator);
    }
    
    // Define linting update listener (will reference view after creation)
    let lintingUpdateListener;

    // Create and return editor view
    const editor = new EditorView({
        state,
        parent: document.getElementById(containerId)
    });
    
    // Attach mousedown listener for dropdown handling
    editor.dom.addEventListener('mousedown', editorMousedownHandler, true);
    editor.dom.addEventListener('mousedown', editorCtrlClickHandler, true);
    
    // Setup linting indicator listener after view is created
    const updateLintingIndicator = () => {
        const indicator = document.getElementById('linting-indicator');
        if (!indicator) return;
        
        // Re-run the linter to check for errors
        const diagnostics = validateBrackets(editor.state);
        if (diagnostics && diagnostics.length > 0) {
            indicator.classList.add('has-errors');
        } else {
            indicator.classList.remove('has-errors');
        }
        
        // Check if scrollbar is visible and adjust position
        const scroller = editor.dom.querySelector('.cm-scroller');
        if (scroller) {
            const hasScrollbar = scroller.scrollHeight > scroller.clientHeight;
            if (hasScrollbar) {
                indicator.style.right = '14px';
            } else {
                indicator.style.right = '0px';
            }
        }
    };
    
    lintingUpdateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
            updateLintingIndicator();
        }
    });
    
    // Update view with new extensions that include linting listener
    editor.dispatch({
        effects: StateEffect.appendConfig.of([lintingUpdateListener])
    });

    return editor;
}

// ============================================================================
// JSON Editor Creation: Call this to create a JSON editor
// ============================================================================

async function createJsonEditor(containerId, jsonData, renderCommands = []) {
    // Convert jsonData to JSON string if it's an object
    let jsonText;
    if (typeof jsonData === 'string') {
        jsonText = jsonData;
    } else if (Object.keys(jsonData).length === 0) {
        // For empty objects, show { on first line and } on second
        jsonText = '{\n  "var1": "value1"\n}';
    } else {
        jsonText = JSON.stringify(jsonData, null, 2);
    }

    // Import all needed modules
    const { basicSetup, EditorView } = await import('codemirror');
    const { EditorState, StateField, RangeSet, StateEffect } = await import('@codemirror/state');
    const { json } = await import('@codemirror/lang-json');
    const { syntaxHighlighting, HighlightStyle, foldGutter, indentOnInput } = await import('@codemirror/language');
    const { tags: t } = await import('@lezer/highlight');
    const { linter, lintGutter } = await import('@codemirror/lint');
    const { defaultKeymap, indentWithTab, history, historyKeymap, redo } = await import('@codemirror/commands');
    const { keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration } = await import('@codemirror/view');

    // Define bracket decoration helpers for JSON (ignoreJinja = true)
    const createBracketDecorations = (doc, ignoreJinja = false) => {
        const text = doc.toString();
        const decorations = [];
        const colorMap = {};
        const unbalancedMap = {};
        const stack = [];

        // Parse brackets (no Jinja brackets for JSON)
        let inString = false;
        let escapeNext = false;
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            // Handle string escaping
            if (inString) {
                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }
                if (char === '\\') {
                    escapeNext = true;
                    continue;
                }
                if (char === '"') {
                    inString = false;
                }
                continue;
            }
            
            // Start of string
            if (char === '"') {
                inString = true;
                continue;
            }

            if (char === '{') {
                const depth = stack.filter(b => !b.isJinja).length % 7;
                stack.push({ pos: i, char: char, depth: depth, type: 'brace', isJinja: false });
                colorMap[i] = { depth: depth, type: 'brace' };
            } else if (char === '}') {
                const brace = stack.findLast(b => b.char === '{' && !b.isJinja);
                if (brace) {
                    stack.splice(stack.indexOf(brace), 1);
                    colorMap[i] = { depth: brace.depth, type: 'brace' };
                }
                // Don't mark closing bracket as unbalanced - let the opening bracket handling catch it
            } else if (char === '[') {
                const depth = stack.filter(b => !b.isJinja).length % 7;
                stack.push({ pos: i, char: char, depth: depth, type: 'square', isJinja: false });
                colorMap[i] = { depth: depth, type: 'square' };
            } else if (char === ']') {
                const square = stack.findLast(b => b.char === '[' && !b.isJinja);
                if (square) {
                    stack.splice(stack.indexOf(square), 1);
                    colorMap[i] = { depth: square.depth, type: 'square' };
                }
                // Don't mark closing bracket as unbalanced - let the opening bracket handling catch it
            }
        }

        // Mark remaining unmatched brackets
        stack.forEach(b => {
            unbalancedMap[b.pos] = true;
        });

        // Create decorations from colorMap and unbalancedMap
        let i = 0;
        while (i < text.length) {
            if (unbalancedMap[i]) {
                decorations.push(Decoration.mark({
                    class: 'cm-unbalanced',
                    attributes: { style: 'color: #8b0000 !important; font-weight: bold !important; text-decoration: underline wavy #8b0000;' }
                }).range(i, i + 1));
                i++;
            } else if (colorMap[i]) {
                const colorInfo = colorMap[i];
                let color = '#e0e0e0'; // default

                // Determine color based on type and depth
                if (colorInfo.type === 'brace') {
                    const braceColors = ['#ffc107', '#ffca28', '#ffd54f', '#ffe082', '#ffb300', '#ffa000', '#ff6f00'];
                    color = braceColors[colorInfo.depth] || '#ffc107';
                }
                else if (colorInfo.type === 'square') {
                    const squareColors = ['#00bcd4', '#26c6da', '#4dd0e1', '#80deea', '#0097a7', '#00695c', '#004d40'];
                    color = squareColors[colorInfo.depth] || '#00bcd4';
                }

                const className = `cm-bracket-${colorInfo.type}-${colorInfo.depth}`;
                decorations.push(Decoration.mark({
                    class: className,
                    attributes: { style: `color: ${color} !important;` }
                }).range(i, i + 1));
                i++;
            } else {
                i++;
            }
        }

        return RangeSet.of(decorations, true);
    };

    const createJsonBracketField = () => {
        return StateField.define({
            create(state) {
                const decorations = createBracketDecorations(state.doc, true);
                return decorations;
            },
            update(value, tr) {
                if (tr.docChanged) {
                    const decorations = createBracketDecorations(tr.state.doc, true);
                    return decorations;
                }
                return value;
            }
        });
    };

    const createBracketDecorationsExtension = (field) => {
        return {
            provide: (stateField) => EditorView.decorations.from(field)
        };
    };

    // Define highlight style
    const highlightStyle = HighlightStyle.define([
        { tag: t.propertyName, color: '#61afef' },
        { tag: t.string, color: '#98c379' },
        { tag: t.number, color: '#d19a66' },
        { tag: t.null, color: '#c678dd' },
        { tag: t.bool, color: '#c678dd' }
    ]);

    // Bracket validation linting function
    const validateBrackets = (view) => {
        const state = view.state || view;
        const text = state.doc.toString();
        const diagnostics = [];
        const stack = [];
        
        let inString = false;
        let escapeNext = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            // Handle string escaping
            if (inString) {
                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }
                if (char === '\\') {
                    escapeNext = true;
                    continue;
                }
                if (char === '"') {
                    inString = false;
                }
                continue;
            }
            
            // Start of string
            if (char === '"') {
                inString = true;
                continue;
            }

            if (char === '{' || char === '[') {
                stack.push({ pos: i, char: char });
            } else if (char === '}') {
                const opening = stack.pop();
                if (!opening || opening.char !== '{') {
                    diagnostics.push({
                        from: i,
                        to: i + 1,
                        severity: 'error',
                        message: 'Unmatched }'
                    });
                }
            } else if (char === ']') {
                const opening = stack.pop();
                if (!opening || opening.char !== '[') {
                    diagnostics.push({
                        from: i,
                        to: i + 1,
                        severity: 'error',
                        message: 'Unmatched ]'
                    });
                }
            }
        }

        // Report remaining unmatched opening brackets
        stack.forEach(b => {
            const closingChar = b.char === '{' ? '}' : ']';
            diagnostics.push({
                from: b.pos,
                to: b.pos + 1,
                severity: 'error',
                message: `Missing closing ${closingChar}`
            });
        });

        return diagnostics;
    };

    // Create bracket field and extension
    const jsonBracketField = createJsonBracketField();
    const bracketDecorationsExt = createBracketDecorationsExtension(jsonBracketField);
    
    // Create listener to update contextData in real-time
    const jsonUpdateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
            const jsonText = update.state.doc.toString();
            try {
                contextData = JSON.parse(jsonText);
            } catch (e) {
                // Invalid JSON, don't update contextData
            }
        }
    });

    // Create editor state
    const state = EditorState.create({
        doc: jsonText,
        extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            foldGutter(),
            lintGutter(),
            drawSelection(),
            dropCursor(),
            indentOnInput(),
            EditorState.allowMultipleSelections.of(true),
            EditorView.lineWrapping,
            keymap.of([...renderCommands, ...defaultKeymap, ...historyKeymap, { key: 'Ctrl-Shift-z', run: redo }, { key: 'Cmd-Shift-z', run: redo }, indentWithTab]),
            jsonBracketField,
            bracketDecorationsExt.provide(jsonBracketField),
            syntaxHighlighting(highlightStyle),
            linter(validateBrackets),
            json(),
            jsonUpdateListener,
            EditorView.theme({
                '.cm-editor': { height: '100%', width: '100%', flex: '1', overflow: 'hidden', minWidth: '0' },
                '.cm-content': { backgroundColor: '#1a3540', color: '#e0e0e0' },
                '.cm-selectionBackground': { backgroundColor: '#ffff00' },
                '.cm-selection': { backgroundColor: '#ffff00' }
            }, { dark: true })
        ]
    });

    // Inject CSS for JSON wrapper styling
    const jsonStyleId = 'json-editor-wrapper-styles';
    if (!document.getElementById(jsonStyleId)) {
        const style = document.createElement('style');
        style.id = jsonStyleId;
        style.textContent = `
            #json-editor-wrapper {
                border-radius: 4px;
                border: 1px solid #555;
                overflow: hidden;
                height: 100%;
                width: 100%;
                min-width: 0;
            }
            #json-editor-wrapper .cm-editor {
                flex: 1;
                min-width: 0;
                min-height: 0;
                overflow: hidden;
            }
            #json-editor-wrapper .cm-scroller {
                overflow-y: auto !important;
                overflow-x: auto !important;
                min-width: 0;
                min-height: 0;
            }
            #json-editor-wrapper .cm-line {
                white-space: pre-wrap;
                word-wrap: break-word;
                padding-left: 1.5em;
                text-indent: -1.5em;
            }
            #json-editor-wrapper .cm-scroller::-webkit-scrollbar {
                width: 10px;
                height: 10px;
            }
            #json-editor-wrapper .cm-scroller::-webkit-scrollbar-track {
                background: #1f4051;
                border-radius: 4px;
            }
            #json-editor-wrapper .cm-scroller::-webkit-scrollbar-thumb {
                background: #5a9fb8;
                border-radius: 4px;
            }
            #json-editor-wrapper .cm-scroller::-webkit-scrollbar-thumb:hover {
                background: #7ab5d0;
            }
            
            /* Linting indicator triangle in bottom right corner */
            #json-linting-indicator {
                position: absolute;
                bottom: 1px;
                right: 14px;
                width: 0;
                height: 0;
                border-left: 12px solid transparent;
                border-top: 12px solid transparent;
                border-right: 12px solid #FFD700;
                border-bottom: 12px solid #FFD700;
                display: none;
                z-index: 100;
            }
            
            #json-linting-indicator.has-errors {
                display: block;
            }
            
            #json-linting-indicator::after {
                content: '!';
                position: absolute;
                bottom: -10px;
                right: -8px;
                font-size: 12px;
                font-weight: bold;
                color: #333;
            }
        `;
        document.head.appendChild(style);
    }

    // Add scrollbar class and linting indicator to json-editor-wrapper
    const wrapper = document.getElementById('json-editor-wrapper');
    if (wrapper) {
        wrapper.classList.add('scrollbar');
        wrapper.style.position = 'relative';
        // Add linting indicator
        const indicator = document.createElement('div');
        indicator.id = 'json-linting-indicator';
        wrapper.appendChild(indicator);
    }

    // Create and return editor view
    const editor = new EditorView({
        state,
        parent: document.getElementById(containerId)
    });
    
    // Setup linting indicator listener after view is created
    const updateJsonLintingIndicator = () => {
        const indicator = document.getElementById('json-linting-indicator');
        if (!indicator) return;
        
        // Re-run the linter to check for errors
        const diagnostics = validateBrackets(editor.state);
        if (diagnostics && diagnostics.length > 0) {
            indicator.classList.add('has-errors');
        } else {
            indicator.classList.remove('has-errors');
        }
        
        // Check if scrollbar is visible and adjust position
        const scroller = editor.dom.querySelector('.cm-scroller');
        if (scroller) {
            const hasScrollbar = scroller.scrollHeight > scroller.clientHeight;
            if (hasScrollbar) {
                indicator.style.right = '14px';
            } else {
                indicator.style.right = '0px';
            }
        }
    };
    
    const jsonLintingUpdateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
            updateJsonLintingIndicator();
        }
    });
    
    // Update view with new extensions that include linting listener
    editor.dispatch({
        effects: StateEffect.appendConfig.of([jsonLintingUpdateListener])
    });

    return editor;
}

// ============================================================================
// Output Editor Creation: Read-only display with bracket coloring and folding
// ============================================================================

async function createOutputEditor(containerId, outputText, performRender = null) {
    // Ensure outputText is a string
    const text = typeof outputText === 'string' ? outputText : (outputText !== null && typeof outputText === 'object') ? JSON.stringify(outputText, null, 2) : String(outputText);

    // Get the container and clear it first
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // Remove any existing editor
    const existingEditor = container.querySelector('.cm-editor');
    if (existingEditor) {
        existingEditor.remove();
    }

    // Import all needed modules
    const { basicSetup, EditorView } = await import('codemirror');
    const { EditorState, StateField, RangeSet } = await import('@codemirror/state');
    const { Decoration } = await import('@codemirror/view');
    const { syntaxHighlighting, HighlightStyle } = await import('@codemirror/language');
    const { tags: t } = await import('@lezer/highlight');
    const { foldGutter } = await import('@codemirror/language');
    const { json } = await import('@codemirror/lang-json');
    const { defaultKeymap, indentWithTab } = await import('@codemirror/commands');
    const { keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor } = await import('@codemirror/view');
    const { searchKeymap, highlightSelectionMatches } = await import('@codemirror/search');

    // Get the computed value of --bg-primary CSS variable
    const bgPrimaryColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim() || '#1a3540';

    // Define bracket decoration helpers for output (colored brackets, no validation)
    const createBracketDecorations = (doc) => {
        const text = doc.toString();
        const decorations = [];
        const colorMap = {};
        const stack = [];

        // Parse brackets
        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (char === '{') {
                const depth = stack.filter(b => b.char === '{' || b.char === '}').length % 7;
                stack.push({ pos: i, char: char, depth: depth, type: 'brace' });
                colorMap[i] = { depth: depth, type: 'brace' };
            } else if (char === '}') {
                const brace = stack.findLast(b => b.char === '{');
                if (brace) {
                    stack.splice(stack.indexOf(brace), 1);
                    colorMap[i] = { depth: brace.depth, type: 'brace' };
                }
            } else if (char === '[') {
                const depth = stack.filter(b => b.char === '[' || b.char === ']').length % 7;
                stack.push({ pos: i, char: char, depth: depth, type: 'square' });
                colorMap[i] = { depth: depth, type: 'square' };
            } else if (char === ']') {
                const square = stack.findLast(b => b.char === '[');
                if (square) {
                    stack.splice(stack.indexOf(square), 1);
                    colorMap[i] = { depth: square.depth, type: 'square' };
                }
            }
        }

        // Create decorations from colorMap
        let i = 0;
        while (i < text.length) {
            if (colorMap[i]) {
                const colorInfo = colorMap[i];
                let color = '#e0e0e0';

                if (colorInfo.type === 'brace') {
                    const braceColors = ['#ffc107', '#ffca28', '#ffd54f', '#ffe082', '#ffb300', '#ffa000', '#ff6f00'];
                    color = braceColors[colorInfo.depth] || '#ffc107';
                } else if (colorInfo.type === 'square') {
                    const squareColors = ['#64b5f6', '#42a5f5', '#2196f3', '#1e88e5', '#1976d2', '#1565c0', '#0d47a1'];
                    color = squareColors[colorInfo.depth] || '#64b5f6';
                }

                decorations.push(Decoration.mark({
                    class: 'cm-bracket',
                    attributes: { style: `color: ${color} !important;` }
                }).range(i, i + 1));
            }
            i++;
        }

        return RangeSet.of(decorations);
    };

    // Create bracket field for live updating
    const createOutputBracketField = () => {
        return StateField.define({
            create(state) {
                return createBracketDecorations(state.doc);
            },
            update(value, transaction) {
                return createBracketDecorations(transaction.state.doc);
            },
            provide(field) {
                return EditorView.decorations.from(field);
            }
        });
    };

    // Define syntax highlighting for output
    const highlightStyle = HighlightStyle.define([
        { tag: t.string, color: '#81c784' },
        { tag: t.number, color: '#ffb74d' },
        { tag: t.bool, color: '#ba68c8' },
        { tag: t.null, color: '#64b5f6' },
        { tag: t.atom, color: '#64b5f6' },
    ]);

    // Create bracket field
    const outputBracketField = createOutputBracketField();

    // Create editor state with readOnly mode
    const state = EditorState.create({
        doc: text,
        extensions: [
            EditorState.readOnly.of(true), // Read-only but still focusable for keyboard shortcuts
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            foldGutter(),
            json(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            rectangularSelection(),
            crosshairCursor(),
            keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab]),
            highlightSelectionMatches(),
            syntaxHighlighting(highlightStyle),
            outputBracketField,
            EditorView.lineWrapping,
            EditorView.theme({
                '.cm-editor': { height: '100%', width: '100%', flex: '1', overflow: 'hidden', minWidth: '0' },
                '.cm-content': { backgroundColor: bgPrimaryColor, color: '#e0e0e0' },
                '.cm-selectionBackground': { backgroundColor: 'rgba(255, 255, 0, 0.3)' },
                '.cm-selection': { backgroundColor: 'rgba(255, 255, 0, 0.3)' }
            }, { dark: true })
        ]
    });

    // Inject CSS for output wrapper styling
    const outputStyleId = 'output-editor-wrapper-styles';
    if (!document.getElementById(outputStyleId)) {
        const style = document.createElement('style');
        style.id = outputStyleId;
        style.textContent = `
            #output-editor-wrapper {
                border-radius: 4px;
                border: 1px solid #555;
                overflow: hidden;
                height: 100%;
                width: 100%;
                min-width: 0;
            }
            #output-editor-wrapper .cm-editor {
                flex: 1;
                min-width: 0;
                min-height: 0;
                overflow: hidden;
            }
            #output-editor-wrapper .cm-scroller {
                overflow-y: auto !important;
                overflow-x: auto !important;
                min-width: 0;
                min-height: 0;
            }
            #output-editor-wrapper .cm-line {
                white-space: pre-wrap;
                word-wrap: break-word;
                padding-left: 1.5em;
                text-indent: -1.5em;
            }
            #output-editor-wrapper .cm-gutterMarker {
                cursor: pointer;
            }
            #output-editor-wrapper .cm-scroller::-webkit-scrollbar {
                width: 10px;
                height: 10px;
            }
            #output-editor-wrapper .cm-scroller::-webkit-scrollbar-track {
                background: #1f4051;
                border-radius: 4px;
            }
            #output-editor-wrapper .cm-scroller::-webkit-scrollbar-thumb {
                background: #5a9fb8;
                border-radius: 4px;
            }
            #output-editor-wrapper .cm-scroller::-webkit-scrollbar-thumb:hover {
                background: #7ab5d0;
            }
        `;
        document.head.appendChild(style);
    }

    // Add scrollbar class to output-editor-wrapper for base.css styling
    const wrapper = document.getElementById('output-editor-wrapper');
    if (wrapper) {
        wrapper.classList.add('scrollbar');
    }

    // Create and return editor view
    const editor = new EditorView({
        state,
        parent: container
    });

// Add global Ctrl+Enter handler if performRender is provided (only once) DEPRECATED
//    if (performRender && !window._jinja_render_handler_attached) {
//        const globalKeydownHandler = (e) => {
//            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
//                e.preventDefault();
//                if (window._performRender) {
//                    window._performRender();
//                }
//            }
//        };
//        document.addEventListener('keydown', globalKeydownHandler);
//        window._jinja_render_handler_attached = true;
//    }  
// Store current performRender function globally so the single handler can call it
//    if (performRender) {
//        window._performRender = performRender;
//    }

    return editor;
}

// ============================================================================
// Template Renderer and Output Update
// ============================================================================

// ============================================================================
// Persephone Template Rendering via HTTP
// ============================================================================

async function renderTemplateWithPersephone(template, context) {
    try {
        // Send request to Persephone's /render-template endpoint
        const response = await fetch('/engine/render-template', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                template: template,
                context: context
            })
        });

        const data = await response.json();

        if (response.ok && data.result !== undefined) {
            return { success: true, result: data.result };
        } else if (data.errorType) {
            // Return structured error from server
            return { 
                success: false, 
                error: data.error,
                errorType: data.errorType,
                variable: data.variable,
                lineNumber: data.lineNumber,
                context: data.context
            };
        } else {
            return { success: false, error: data.error || 'Unknown rendering error' };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}


// ============================================================================
// Initialize all editors with sample data
// ============================================================================

async function initializeEditors(jsonContainerId, jinjaContainerId, outputContainerId) {
    // Load filters metadata from endpoint (once)
    await loadFiltersMetadata();
    
    // Minimal sample context data
    let initialContextData = {};
    
    // Update module-level contextData
    contextData = initialContextData;

    // Minimal sample template
    const sampleTemplate = ``;

    // Setup render command as a shared function (used by Jinja, JSON, and Output editors)
    let jinjaEditorRef = null;
    const performRender = async () => {
        if (jinjaEditorRef && jsonEditor) {
            // Get current context from JSON editor
            const jsonText = jsonEditor.state.doc.toString();
            try {
                contextData = JSON.parse(jsonText);
            } catch (e) {
                createOutputEditor(outputContainerId, `ERROR: Invalid JSON in context - ${e.message}`, performRender);
                return true;
            }
            
            const templateText = jinjaEditorRef.state.doc.toString();
            const result = await renderTemplateWithPersephone(templateText, { CTX: contextData });
            
            if (result.success) {
                createOutputEditor(outputContainerId, result.result, performRender);
            } else {
                createOutputEditor(outputContainerId, `ERROR: ${result.error}`, performRender);
            }
        }
        return true;
    };

    // Create render commands for editors
    const renderCommands = [
        { 
            key: 'Ctrl-Enter', 
            run: performRender
        },
        { 
            key: 'Cmd-Enter', 
            run: performRender
        }
    ];

    // Create the JSON editor with context data and render commands
    const jsonEditor = await createJsonEditor(jsonContainerId, initialContextData, renderCommands);
    window._jinjaJsonEditor = jsonEditor; // expose for live CTX autocomplete

    // Create the Jinja editor with render commands
    const jinjaEditor = await createJinjaEditor(jinjaContainerId, sampleTemplate, initialContextData, renderCommands);
    jinjaEditorRef = jinjaEditor;

    // Initialize output editor (empty) with performRender callback
    createOutputEditor(outputContainerId, '', performRender);

    return { jinjaEditor, contextData };
}

// ============================================================================
// Modal Helpers for Editor Integration
// ============================================================================

/**
 * Open a Jinja editor modal for editing template content
 * @param {string} fieldLabel - Label for the field being edited
 * @param {string} initialValue - Initial template content
 * @param {function} onSaveCallback - Callback(value) called with edited content
 * @param {boolean} readOnly - If true, makes the editor read-only with no Save button (default: false)
 */
function openJinjaEditorModal(title, initialValue, onSaveCallback, readOnly = false) {
    const fields = [
        {
            type: 'custom:jinja-editor',
            name: 'content',
            label: title,
            value: initialValue || '',
            containerStyle: 'width: 100%; flex: 1; padding: 0; background-color: var(--bg-panel3); border-radius: 4px; overflow: auto; border: none;',
            readOnly: readOnly
        }
    ];
    
    showFormModal(title, fields, async (formData) => {
        if (onSaveCallback && !readOnly) {
            return await onSaveCallback(formData.content);
        }
    }, readOnly, true, true);
}

/**
 * Open a JSON editor modal for editing JSON content
 * @param {string} fieldLabel - Label for the field being edited
 * @param {string|object} initialValue - Initial JSON content (string or object)
 * @param {function} onSaveCallback - Callback(value) called with edited JSON string
 * @param {boolean} readOnly - If true, makes the editor read-only with no Save button (default: false)
 */
function openJsonEditorModal(fieldLabel, initialValue, onSaveCallback, readOnly = false) {
    const modalTitle = readOnly ? fieldLabel : `Edit: ${fieldLabel}`;
    const fields = [
        {
            type: 'custom:json-editor',
            name: 'content',
            label: fieldLabel,
            value: initialValue || '',
            containerStyle: 'width: 100%; flex: 1; padding: 0; background-color: var(--bg-panel3); border-radius: 4px; overflow: auto; border: none;',
            readOnly: readOnly
        }
    ];
    
    showFormModal(modalTitle, fields, async (formData) => {
        if (onSaveCallback && !readOnly) {
            return await onSaveCallback(formData.content);
        }
    }, readOnly, true, true);
}

// Export for use in other modules
// Functions are exposed globally: createJinjaEditor, createJsonEditor, createOutputEditor, renderTemplate, renderTemplateWithPersephone, initializeEditors, contextData
// ============================================================================
// EXPORTS TO WINDOW
// ============================================================================
window.createJinjaEditor = createJinjaEditor;
window.createJsonEditor = createJsonEditor;
window.createOutputEditor = createOutputEditor;
window.initializeEditors = initializeEditors;
window.loadFiltersMetadata = loadFiltersMetadata;
window.openJinjaEditorModal = openJinjaEditorModal;
window.openJsonEditorModal = openJsonEditorModal;
window.renderTemplateWithPersephone = renderTemplateWithPersephone;
window.setupCodeMirror = setupCodeMirror;