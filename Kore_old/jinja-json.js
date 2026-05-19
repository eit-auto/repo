// ============================================================================
// JINJA-JSON2 Library
// CodeMirror 6 + Jinja Editor Helper Functions
// ============================================================================

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
        const response = await fetch('/filters');
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

async function createJinjaEditor(containerId, templateText, contextData, renderCommands = null) {
    // Load filters metadata from endpoint (once)
    await loadFiltersMetadata();
    
    // Import all needed modules
    const { EditorView } = await import('codemirror');
    const { EditorState, StateField, RangeSet } = await import('@codemirror/state');
    const { jinja } = await import('@codemirror/lang-jinja');
    const { autocompletion } = await import('@codemirror/autocomplete');
    const { syntaxHighlighting, HighlightStyle, foldGutter, indentOnInput } = await import('@codemirror/language');
    const { tags: t } = await import('@lezer/highlight');
    const { linter } = await import('@codemirror/lint');
    const { defaultKeymap, indentWithTab, history, historyKeymap, redo } = await import('@codemirror/commands');
    const { keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration } = await import('@codemirror/view');
    const { searchKeymap, highlightSelectionMatches } = await import('@codemirror/search');

    // Custom Jinja comment command (uses {# #} instead of //)
    const jinjaCommentCommand = (view) => {
        const changes = [];
        for (const range of view.state.selection.ranges) {
            const line = view.state.doc.lineAt(range.from);
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
                console.log('Jinja bracket field created with', decorations.size, 'decorations');
                return decorations;
            },
            update(value, tr) {
                if (tr.docChanged) {
                    const decorations = createBracketDecorations(tr.state.doc, false);
                    console.log('Jinja bracket field updated with', decorations.size, 'decorations');
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

    const createFilterCompletion = () => {
        return (context) => {
            // Look backwards for a pipe character
            const beforeCursor = context.state.sliceDoc(0, context.pos);
            const lastPipe = beforeCursor.lastIndexOf('|');
            
            if (lastPipe === -1) return null;
            
            // Get everything after the pipe
            const afterPipe = beforeCursor.slice(lastPipe + 1);
            
            // Accept if it's just spaces and word chars (including empty)
            if (!/^[\s\w]*$/.test(afterPipe)) return null;

            const completions = JINJA_FILTERS_METADATA.map((filter, index) => {
                // Determine label: name + () if has parameters
                const hasParams = filter.parameters && filter.parameters.length > 0;
                const label = hasParams ? filter.name + '()' : filter.name;
                
                // Return info as a function that creates a DOM element with HTML content
                const infoFn = () => {
                    const div = document.createElement('div');
                    let html = `<strong>${filter.description || ''}</strong>`;
                    
                    if (filter.parameters && filter.parameters.length > 0) {
                        html += '<div style="margin-top: 8px;"><strong>Parameters:</strong><ul style="margin: 4px 0; padding-left: 20px;">';
                        filter.parameters.forEach(param => {
                            html += `<li><code>${param.name}</code> <em>(${param.type})</em>: ${param.description}</li>`;
                        });
                        html += '</ul></div>';
                    }
                    
                    if (filter.examples && filter.examples.length > 0) {
                        html += '<div style="margin-top: 8px;"><strong>Examples:</strong><ul style="margin: 4px 0; padding-left: 20px;">';
                        filter.examples.forEach(example => {
                            html += `<li><code>${example.template}</code> &#8594; <code>${example.output}</code></li>`;
                        });
                        html += '</ul></div>';
                    }
                    
                    div.innerHTML = html;
                    return div;
                };
                
                return {
                    label: label,
                    detail: filter.category ? `[${filter.category}]` : '',
                    info: infoFn,
                    apply: label
                };
            });

            const result = {
                from: lastPipe + 1,
                to: context.pos,
                options: completions
            };
            
            // After a tiny delay, set up hover handlers on the completion items
            setTimeout(() => {
                const completion = document.querySelector('.cm-completionInfo');
                const listContainer = document.querySelector('.cm-completion ul');
                
                if (listContainer) {
                    const items = listContainer.querySelectorAll('li');
                    items.forEach((item, idx) => {
                        // Remove previous listeners by cloning
                        const newItem = item.cloneNode(true);
                        item.parentNode.replaceChild(newItem, item);
                        
                        newItem.addEventListener('mouseover', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            
                            // Remove cm-option-selected from all items
                            listContainer.querySelectorAll('li').forEach(li => {
                                li.classList.remove('cm-option-selected');
                            });
                            
                            // Add to this item
                            newItem.classList.add('cm-option-selected');
                            
                            // Manually trigger the keyboard event to update info panel
                            const keyEvent = new KeyboardEvent('keydown', {
                                key: 'ArrowDown',
                                code: 'ArrowDown',
                                keyCode: 40,
                                bubbles: true
                            });
                            listContainer.dispatchEvent(keyEvent);
                        });
                    });
                }
            }, 10);
            
            return result;
        };
    };

    const createCtxCompletion = (contextData) => {
        return (context) => {
            const beforeCursor = context.state.sliceDoc(0, context.pos);
            
            // Check for CTX.something pattern
            const ctxMatch = beforeCursor.match(/CTX\.(\w*)$/);
            
            if (!ctxMatch) return null;
            
            // Get all properties from current context data
            const contextProps = Object.keys(contextData).sort();
            const partial = ctxMatch[1].toLowerCase();
            
            // Filter properties that start with the partial text
            const filtered = contextProps
                .filter(prop => prop.toLowerCase().startsWith(partial))
                .map(prop => ({
                    label: prop,
                    detail: `(${typeof contextData[prop]})`,
                    type: 'variable'
                }));
            
            if (filtered.length === 0) return null;
            
            return {
                from: beforeCursor.lastIndexOf('CTX.') + 4, // Start after CTX.
                to: context.pos,
                options: filtered
            };
        };
    };

    // Define highlight style for better variable coloring
    const highlightStyle = HighlightStyle.define([
        { tag: t.keyword, color: '#c678dd' },
        { tag: t.variableName, color: '#61afef' },
        { tag: t.propertyName, color: '#61afef' }
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
    
    // Create completion sources
    const ctxCompletion = createCtxCompletion(contextData);
    const filterCompletion = createFilterCompletion();

    // Filter out the default comment keybindings and add our Jinja-specific ones
    const filteredDefaultKeymap = defaultKeymap.filter(binding => 
        binding.key !== 'Ctrl-/' && binding.key !== 'Cmd-/'
    );

    // Build complete keymap with our custom commands
    const completeKeymap = [
        ...(renderCommands ? renderCommands : []),
        ...jinjaCommentKeymap,
        ...filteredDefaultKeymap,
        indentWithTab,
        ...historyKeymap,
        ...searchKeymap,
        { key: 'Ctrl-Shift-z', run: redo },
        { key: 'Cmd-Shift-z', run: redo }
    ];

    // Create editor state
    const state = EditorState.create({
        doc: templateText,
        extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            foldGutter(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            indentOnInput(),
            syntaxHighlighting(highlightStyle),
            autocompletion({ override: [ctxCompletion, filterCompletion] }),
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
                '.cm-content': { backgroundColor: '#1a3540', color: '#e0e0e0' }
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
        `;
        document.head.appendChild(style);
    }

    // Add scrollbar class to editor-wrapper for base.css styling
    const wrapper = document.getElementById('editor-wrapper');
    if (wrapper) {
        wrapper.classList.add('scrollbar');
    }

    // Create and return editor view
    const editor = new EditorView({
        state,
        parent: document.getElementById(containerId)
    });

    return editor;
}

// ============================================================================
// JSON Editor Creation: Call this to create a JSON editor
// ============================================================================

async function createJsonEditor(containerId, jsonData) {
    // Convert jsonData to JSON string if it's an object
    const jsonText = typeof jsonData === 'string' ? jsonData : JSON.stringify(jsonData, null, 2);

    // Import all needed modules
    const { basicSetup, EditorView } = await import('codemirror');
    const { EditorState, StateField, RangeSet } = await import('@codemirror/state');
    const { Decoration } = await import('@codemirror/view');
    const { json } = await import('@codemirror/lang-json');
    const { syntaxHighlighting, HighlightStyle } = await import('@codemirror/language');
    const { tags: t } = await import('@lezer/highlight');
    const { linter } = await import('@codemirror/lint');
    const { defaultKeymap, indentWithTab } = await import('@codemirror/commands');
    const { keymap } = await import('@codemirror/view');

    console.log('createJsonEditor: Decoration imported:', typeof Decoration, Decoration);

    // Define bracket decoration helpers for JSON (ignoreJinja = true)
    const createBracketDecorations = (doc, ignoreJinja = false) => {
        console.log('createBracketDecorations called, Decoration is:', typeof Decoration);
        const text = doc.toString();
        const decorations = [];
        const colorMap = {};
        const unbalancedMap = {};
        const stack = [];

        // Parse brackets (no Jinja brackets for JSON)
        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (char === '{') {
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
                console.log('JSON bracket field created with', decorations.size, 'decorations');
                return decorations;
            },
            update(value, tr) {
                if (tr.docChanged) {
                    const decorations = createBracketDecorations(tr.state.doc, true);
                    console.log('JSON bracket field updated with', decorations.size, 'decorations');
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

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

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
            diagnostics.push({
                from: b.pos,
                to: b.pos + 1,
                severity: 'error',
                message: `Unmatched ${b.char}`
            });
        });

        return diagnostics;
    };

    // Create bracket field and extension
    const jsonBracketField = createJsonBracketField();
    const bracketDecorationsExt = createBracketDecorationsExtension(jsonBracketField);

    // Create editor state
    const state = EditorState.create({
        doc: jsonText,
        extensions: [
            basicSetup,
            EditorView.lineWrapping,
            keymap.of([...defaultKeymap, indentWithTab]),
            jsonBracketField,
            bracketDecorationsExt.provide(jsonBracketField),
            syntaxHighlighting(highlightStyle),
            linter(validateBrackets),
            json(),
            EditorView.theme({
                '.cm-editor': { height: '100%', width: '100%', flex: '1', overflow: 'hidden', minWidth: '0' },
                '.cm-content': { backgroundColor: '#1a3540', color: '#e0e0e0' }
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
        `;
        document.head.appendChild(style);
    }

    // Add scrollbar class to json-editor-wrapper for base.css styling
    const wrapper = document.getElementById('json-editor-wrapper');
    if (wrapper) {
        wrapper.classList.add('scrollbar');
    }

    // Create and return editor view
    const editor = new EditorView({
        state,
        parent: document.getElementById(containerId)
    });

    return editor;
}

// ============================================================================
// Output Editor Creation: Read-only display with bracket coloring and folding
// ============================================================================

async function createOutputEditor(containerId, outputText) {
    // Ensure outputText is a string
    const text = typeof outputText === 'string' ? outputText : String(outputText);

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
    const { defaultKeymap, indentWithTab } = await import('@codemirror/commands');
    const { keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor } = await import('@codemirror/view');

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
            EditorView.editable.of(false), // Read-only
            EditorState.readOnly.of(true),
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            foldGutter(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            rectangularSelection(),
            crosshairCursor(),
            keymap.of([...defaultKeymap, indentWithTab]),
            syntaxHighlighting(highlightStyle),
            outputBracketField,
            EditorView.lineWrapping,
            EditorView.theme({
                '.cm-editor': { height: '100%', width: '100%', flex: '1', overflow: 'hidden', minWidth: '0' },
                '.cm-content': { backgroundColor: '#1a3540', color: '#e0e0e0' }
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
        const response = await fetch('/render-template', {
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
        } else {
            return { success: false, error: data.error || 'Unknown rendering error' };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Legacy stub for backwards compatibility (deprecated)
function renderTemplate(template, context) {
    let output = template;
    
    // Replace variables: {{ key }}
    Object.entries(context).forEach(([key, value]) => {
        const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
        output = output.replace(pattern, valueStr);
    });
    
    // Remove Jinja comments: {# ... #}
    output = output.replace(/\{#[\s\S]*?#\}/g, '');
    
    // Basic for loop handling (simplified)
    output = output.replace(/\{%\s*for\s+\w+\s+in\s+\w+\s*%\}[\s\S]*?\{%\s*endfor\s*%\}/g, '');
    
    // Basic if handling (simplified)
    output = output.replace(/\{%\s*if\s+[\s\S]*?%\}[\s\S]*?\{%\s*endif\s*%\}/g, '');
    output = output.replace(/\{%[\s\S]*?%\}/g, '');
    
    return output.trim();
}

// ============================================================================
// Initialize all editors with sample data
// ============================================================================

async function initializeEditors(jsonContainerId, jinjaContainerId, outputContainerId) {
    // Load filters metadata from endpoint (once)
    await loadFiltersMetadata();
    
    // Expanded sample context data
    const contextData = {
        name: "Alice Johnson",
        email: "alice@example.com",
        role: "Senior Developer",
        department: "Engineering",
        items: ["apple", "banana", "cherry", "date", "elderberry"],
        show_footer: true,
        show_header: true,
        active: true,
        score: 95,
        organization: {
            name: "Acme Corp",
            id: 123,
            location: "San Francisco",
            founded: 2010
        },
        tags: ["python", "javascript", "react", "nodejs"],
        projects: [
            { name: "Project A", status: "completed", progress: 100 },
            { name: "Project B", status: "in-progress", progress: 75 },
            { name: "Project C", status: "planned", progress: 0 }
        ]
    };

    // Expanded sample template
    const sampleTemplate = `{# Employee Report Template #}
=================================
EMPLOYEE INFORMATION REPORT
=================================

{% if show_header %}
Date: 2025-05-01
Generated for: {{ organization.name }}
{% endif %}

Name: {{ name }}
Email: {{ email }}
Role: {{ role }}
Department: {{ department }}
Score: {{ score }}/100

---------------------------------
ORGANIZATION DETAILS
---------------------------------
Organization: {{ organization.name }}
Location: {{ organization.location }}
Founded: {{ organization.founded }}
ID: {{ organization.id }}

---------------------------------
TECHNOLOGIES
---------------------------------
{% for tag in tags %}
  ? {{ tag }}
{% endfor %}

---------------------------------
PROJECTS
---------------------------------
{% for project in projects %}
[{{ project.status | upper }}] {{ project.name }} - {{ project.progress }}%
{% endfor %}

---------------------------------
ITEMS
---------------------------------
{% for item in items %}
  ? {{ item }}
{% endfor %}

{% if show_footer %}
---------------------------------
End of Report
---------------------------------
{% endif %}`;

    // Create the JSON editor with context data
    createJsonEditor(jsonContainerId, contextData);

    // Setup render command first (it only needs contextData)
    // We'll create a placeholder for jinjaEditor that gets set after creation
    let jinjaEditorRef = null;
    const renderCommands = [
        { 
            key: 'Ctrl-Enter', 
            run: async () => { 
                if (jinjaEditorRef) {
                    const templateText = jinjaEditorRef.state.doc.toString();
                    const result = await renderTemplateWithPersephone(templateText, contextData);
                    
                    if (result.success) {
                        createOutputEditor(outputContainerId, result.result);
                    } else {
                        createOutputEditor(outputContainerId, `ERROR: ${result.error}`);
                    }
                }
                return true; 
            } 
        },
        { 
            key: 'Cmd-Enter', 
            run: async () => { 
                if (jinjaEditorRef) {
                    const templateText = jinjaEditorRef.state.doc.toString();
                    const result = await renderTemplateWithPersephone(templateText, contextData);
                    
                    if (result.success) {
                        createOutputEditor(outputContainerId, result.result);
                    } else {
                        createOutputEditor(outputContainerId, `ERROR: ${result.error}`);
                    }
                }
                return true; 
            } 
        }
    ];

    // Create the Jinja editor with render commands
    const jinjaEditor = await createJinjaEditor(jinjaContainerId, sampleTemplate, contextData, renderCommands);
    jinjaEditorRef = jinjaEditor;

    // Initialize output editor (empty)
    createOutputEditor(outputContainerId, '');

    return { jinjaEditor, contextData };
}

// Export for use in other modules
export { createJinjaEditor, createJsonEditor, createOutputEditor, renderTemplate, renderTemplateWithPersephone, initializeEditors };