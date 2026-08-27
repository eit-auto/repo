/**
 * docs.js — Codex (Kore's internal docs system) client-side logic.
 *
 * Powers both /docs (docs.html — browse/search landing page) and
 * /doc?id=... (doc.html — single doc detail page) from one file, since
 * both pages load it via the same <script type="module" src="/lib/docs.js">
 * tag and there's no per-page bundling in this app. Which page we're on
 * is detected by which page-specific element is present in the DOM
 * (#docsList vs #docContent) — see init() at the bottom.
 *
 * Depends on base.js (escapeHtml, the credentialed fetch wrapper with
 * auto session-refresh) — imported below the same way user-portal.js
 * does it, to guarantee load order via the real ES module graph rather
 * than <script> tag ordering.
 *
 * Talks to the endpoints added in resources.js:
 *   GET /kore/docs                 (list, filters as query params)
 *   GET /kore/docs/:id             (single doc, latest version)
 *   GET /kore/docs/:id/:version    (single doc, historical version) — not
 *                                  wired into the UI yet, but getDoc()
 *                                  below accepts a version so a future
 *                                  "view history" control has somewhere
 *                                  to plug in.
 */
import '/lib/base.js';

// ============================================================
// MARKDOWN RENDERING
//
// Small and dependency-free rather than pulling in a library. Supports:
// headings (h1-h6), paragraphs, bold/italic, strikethrough, inline code,
// fenced code blocks, links, images, blockquotes (nested), horizontal
// rules, tables, and nested ordered/unordered lists.
//
// HTML-escapes the raw content FIRST, then runs markdown syntax
// transforms on the escaped text, so doc authors can't inject arbitrary
// HTML/script through the content field. One consequence worth knowing:
// since escaping runs before parsing, syntax that literally uses `>` or
// `"` (blockquotes, link/image titles) has to be matched against their
// escaped forms (&gt;, &quot;) further down - not a bug, just how the
// ordering works out.
//
// Known limitations (by design, not oversights):
// - Bold/italic use * and ** only, not _ and __ - underscore delimiters
//   are ambiguous with snake_case words in doc content (e.g.
//   "the docs_hist table" would otherwise partially italicize).
// - A list item's text must be on one line - no multi-line/multi-
//   paragraph content inside a single list item.
// ============================================================

function _escapeHtml(str) {
    if (window.escapeHtml) return window.escapeHtml(str);
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function _mdInline(line, codeSpanStore) {
    // 1. Protect inline code spans so nothing below touches their content
    let text = line.replace(/`([^`]+)`/g, (m, code) => {
        const idx = codeSpanStore.length;
        codeSpanStore.push(code);
        return `\u0001CODESPAN${idx}\u0001`;
    });

    // 2. Images (before links - image syntax is link syntax prefixed
    // with !, and would otherwise get double-processed)
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (m, alt, url, title) => {
        const titleAttr = title ? ` title="${title}"` : '';
        return `<img src="${url}" alt="${alt}"${titleAttr}>`;
    });

    // 3. Links
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (m, label, url, title) => {
        const titleAttr = title ? ` title="${title}"` : '';
        return `<a href="${url}"${titleAttr} target="_blank" rel="noopener">${label}</a>`;
    });

    // 4. Bold, 5. Strikethrough, 6. Italic (order matters: bold before
    // italic so ** is fully consumed before the single-* pass runs)
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // 7. Restore code spans
    text = text.replace(/\u0001CODESPAN(\d+)\u0001/g, (m, idx) => `<code>${codeSpanStore[Number(idx)]}</code>`);

    return text;
}

function _mdSplitTableRow(line) {
    let trimmed = line.trim();
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);

    const cells = [];
    let current = '';
    for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
            current += '|';
            i++;
        } else if (trimmed[i] === '|') {
            cells.push(current.trim());
            current = '';
        } else {
            current += trimmed[i];
        }
    }
    cells.push(current.trim());
    return cells;
}

function _mdIsTableSeparatorLine(line) {
    const cells = _mdSplitTableRow(line);
    if (cells.length === 0) return false;
    return cells.every(c => /^:?-+:?$/.test(c));
}

function _mdGetAlignment(sepCell) {
    const left = sepCell.startsWith(':');
    const right = sepCell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
}

function _mdBuildTableHtml(headerCells, sepCells, bodyRows, codeSpanStore) {
    const aligns = sepCells.map(_mdGetAlignment);
    const alignAttr = (i) => aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
    let html = '<table class="md-table"><thead><tr>';
    headerCells.forEach((cell, i) => { html += `<th${alignAttr(i)}>${_mdInline(cell, codeSpanStore)}</th>`; });
    html += '</tr></thead><tbody>';
    bodyRows.forEach(row => {
        html += '<tr>';
        headerCells.forEach((_, i) => { html += `<td${alignAttr(i)}>${_mdInline(row[i] || '', codeSpanStore)}</td>`; });
        html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
}

/**
 * Builds one or more nested <ul>/<ol> lists from a contiguous run of
 * list-item lines, using an indentation-based stack. Handles mixed
 * ordered/unordered nesting at different indent levels.
 */
function _mdBuildNestedList(runLines, codeSpanStore) {
    const stack = []; // {indent, type, buffer: string[]}
    const topLevelOutputs = [];

    function closeTop() {
        const finished = stack.pop();
        const closedHtml = `<${finished.type}>${finished.buffer.join('')}</${finished.type}>`;
        if (stack.length) {
            const parent = stack[stack.length - 1];
            const lastIdx = parent.buffer.length - 1;
            parent.buffer[lastIdx] = parent.buffer[lastIdx].replace(/<\/li>$/, closedHtml + '</li>');
        } else {
            topLevelOutputs.push(closedHtml);
        }
    }

    for (const rawLine of runLines) {
        if (rawLine.trim() === '') continue;
        const m = rawLine.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!m) continue;
        const indent = m[1].length;
        const marker = m[2];
        const type = /\d+\./.test(marker) ? 'ol' : 'ul';
        const text = m[3];

        while (stack.length && stack[stack.length - 1].indent > indent) closeTop();

        if (!stack.length || stack[stack.length - 1].indent < indent) {
            stack.push({ indent, type, buffer: [] });
        } else if (stack[stack.length - 1].type !== type) {
            closeTop();
            stack.push({ indent, type, buffer: [] });
        }

        stack[stack.length - 1].buffer.push(`<li>${_mdInline(text, codeSpanStore)}</li>`);
    }

    while (stack.length) closeTop();

    return topLevelOutputs.join('\n');
}

function _mdIsListLine(line) {
    return /^(\s*)([-*+]|\d+\.)\s+/.test(line);
}

function _mdIsHorizontalRule(line) {
    const t = line.trim();
    return /^(-{3,}|\*{3,}|_{3,})$/.test(t.replace(/\s+/g, ''));
}

/**
 * ::: fence syntax - ":::type Title" ... ":::". Same safe-by-construction
 * pattern as fenced code blocks: the whole doc is HTML-escaped before any
 * of this runs, so there's no way a fence (or its title, which still goes
 * through _mdInline) can introduce real markup. Currently only "details"
 * is a recognized type, rendering to a real <details><summary> - closed
 * by default, expandable on click. An unrecognized type still parses
 * (nesting-safe) but renders its content unwrapped rather than silently
 * dropping it, so a typoed fence type degrades gracefully instead of
 * eating the whole section.
 */
function _mdIsFenceOpen(line) {
    return line.trim().match(/^:::(\w+)(?:\s+(.*))?$/);
}
function _mdIsFenceClose(line) {
    return line.trim() === ':::';
}

/**
 * Parses a block of lines into an array of HTML block strings. Recursive
 * so blockquotes (which strip one level of `&gt;` and re-parse their
 * inner lines through this same function) get nested-blockquote and
 * nested-block support for free.
 */
function _mdParseBlocks(lines, codeSpanStore) {
    const output = [];
    let paragraphBuffer = [];

    function flushParagraph() {
        if (paragraphBuffer.length) {
            output.push(`<p>${paragraphBuffer.join(' ')}</p>`);
            paragraphBuffer = [];
        }
    }

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed === '') {
            flushParagraph();
            i++;
            continue;
        }

        // A code-block placeholder occupies its own line - emit it as a
        // block-level element, not wrapped in <p>.
        const codeBlockMatch = trimmed.match(/^\u0000CODEBLOCK(\d+)\u0000$/);
        if (codeBlockMatch) {
            flushParagraph();
            output.push(trimmed);
            i++;
            continue;
        }

        if (_mdIsHorizontalRule(line)) {
            flushParagraph();
            output.push('<hr>');
            i++;
            continue;
        }

        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            flushParagraph();
            const level = h[1].length;
            output.push(`<h${level}>${_mdInline(h[2], codeSpanStore)}</h${level}>`);
            i++;
            continue;
        }

        const fenceOpen = _mdIsFenceOpen(line);
        if (fenceOpen) {
            flushParagraph();
            const fenceType = fenceOpen[1].toLowerCase();
            const fenceTitle = (fenceOpen[2] || '').trim();

            // Depth-tracked scan for the matching close, not just the next
            // ":::" - lets a details block nest inside another one.
            let depth = 1;
            let j = i + 1;
            const innerLines = [];
            while (j < lines.length) {
                const l = lines[j];
                if (_mdIsFenceOpen(l)) depth++;
                else if (_mdIsFenceClose(l)) {
                    depth--;
                    if (depth === 0) { j++; break; }
                }
                innerLines.push(l);
                j++;
            }
            i = j; // if unclosed, this just consumes to end of doc rather than throwing

            const innerHtml = _mdParseBlocks(innerLines, codeSpanStore).join('\n');
            if (fenceType === 'details') {
                const summary = fenceTitle ? _mdInline(fenceTitle, codeSpanStore) : 'Details';
                output.push(`<details><summary>${summary}</summary><div class="details-body">${innerHtml}</div></details>`);
            } else {
                // Unrecognized fence type - render the content unwrapped
                // rather than silently dropping a whole section over a typo.
                output.push(innerHtml);
            }
            continue;
        }

        // Blockquote marker is &gt; here, not a raw >, since the whole
        // string was HTML-escaped before this ran.
        if (trimmed.startsWith('&gt;')) {
            flushParagraph();
            const quoteLines = [];
            while (i < lines.length && lines[i].trim().startsWith('&gt;')) {
                quoteLines.push(lines[i].replace(/^\s*&gt;\s?/, ''));
                i++;
            }
            output.push(`<blockquote>${_mdParseBlocks(quoteLines, codeSpanStore).join('\n')}</blockquote>`);
            continue;
        }

        if (line.includes('|') && i + 1 < lines.length && _mdIsTableSeparatorLine(lines[i + 1])) {
            flushParagraph();
            const headerCells = _mdSplitTableRow(line);
            const sepCells = _mdSplitTableRow(lines[i + 1]);
            i += 2;
            const bodyRows = [];
            while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
                bodyRows.push(_mdSplitTableRow(lines[i]));
                i++;
            }
            output.push(_mdBuildTableHtml(headerCells, sepCells, bodyRows, codeSpanStore));
            continue;
        }

        if (_mdIsListLine(line)) {
            flushParagraph();
            // Collect the contiguous run of list-item lines, absorbing
            // blank lines only when another list item follows them -
            // a blank line leading into a non-list paragraph should end
            // the run rather than being swallowed into it.
            let runEnd = i;
            let j = i;
            while (j < lines.length) {
                const l = lines[j];
                if (l.trim() === '') {
                    let k = j;
                    while (k < lines.length && lines[k].trim() === '') k++;
                    if (k < lines.length && _mdIsListLine(lines[k])) {
                        j = k;
                        continue;
                    }
                    break;
                }
                if (_mdIsListLine(l)) {
                    runEnd = j + 1;
                    j++;
                    continue;
                }
                break;
            }
            const runLines = lines.slice(i, runEnd);
            i = runEnd;
            output.push(_mdBuildNestedList(runLines, codeSpanStore));
            continue;
        }

        paragraphBuffer.push(_mdInline(trimmed, codeSpanStore));
        i++;
    }
    flushParagraph();

    return output;
}

function renderMarkdown(md) {
    if (!md) return '';

    // Escape everything up front; every transform below operates on
    // already-escaped text, so none of it can reintroduce real tags.
    let text = _escapeHtml(md).replace(/\r\n/g, '\n');

    // Pull fenced code blocks out first (```lang\n...\n```) so nothing
    // inside them gets touched by any pass below. Restored verbatim at
    // the very end - codeBlocks lives in this function's closure and is
    // read by the final restore step, not by _mdParseBlocks itself
    // (which only ever sees the placeholder tokens).
    const codeBlocks = [];
    text = text.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
        return `\u0000CODEBLOCK${idx}\u0000`;
    });

    const codeSpanStore = [];
    const lines = text.split('\n');
    const blocks = _mdParseBlocks(lines, codeSpanStore);

    let html = blocks.join('\n');
    html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (match, idx) => codeBlocks[Number(idx)]);

    return html;
}
window.renderMarkdown = renderMarkdown;

// ============================================================
// SHARED HELPERS
// ============================================================

const DOC_TYPE_LABELS = {
    workflow: 'Workflow',
    form: 'Form',
    plugin: 'Plugin',
    plugin_task: 'Plugin Task',
    datatable: 'Datatable',
    general: 'General'
};

// Plural forms and a fixed display order, used only for grouping the
// Related panel by type (docRelatedPanel below) - kept separate from
// DOC_TYPE_LABELS itself so the per-item singular badges used elsewhere
// (docs list rows, a doc's own type badge) are untouched.
const DOC_TYPE_LABELS_PLURAL = {
    workflow: 'Workflows',
    form: 'Forms',
    plugin: 'Plugins',
    plugin_task: 'Plugin Tasks',
    datatable: 'Datatables',
    general: 'General'
};
const DOC_TYPE_ORDER = ['workflow', 'form', 'datatable', 'plugin', 'plugin_task', 'general'];

function docTypeLabel(type) {
    return DOC_TYPE_LABELS[type] || 'General';
}
window.docTypeLabel = docTypeLabel;

// ============================================================
// LINKED RESOURCE PICKER — shared between docs.html's New Doc modal
// (below) and doc-builder.js's Linked Resource field. Lives here rather
// than in doc-builder.js because doc-builder.js already does
// `import '/lib/docs.js'` for renderMarkdown, and ES module imports don't
// share scope - only what's attached to window is reachable from an
// importing module - so this is the one place both screens can reach.
// Every function takes an `ids` object naming the caller's own DOM
// element ids, so each screen can wire it to its own markup without
// duplicating the fetch/render logic itself.
//
// ids shape: { selectId, taskRowId, pluginSelectId, taskSelectId }
//
// Note on plugins specifically: unlike workflows/forms/datatables,
// plugins are keyed by NAME (plugin.name), not a generated id - there's
// no separate id field, per plugins-front.js. A plugin option's value is
// that name string.
//
// Plugin Task is a step further: tasks only exist scoped to a specific
// plugin (GET /kore/plugins/:pluginName/tasks per plugins-front.js), task
// ids aren't globally unique - only unique within their plugin - and
// there's no flat "all tasks" list. So it gets its own two-select row
// (Plugin, then Task within that plugin) instead of the single select
// the other four types share, and the pair is combined into one
// composite "pluginName:taskId" string for storage in the existing
// linkedResourceId column, rather than adding a second column just for
// this one type. linkedResourceHref() below parses that same format back
// apart for the doc viewer's link.
// ============================================================

const RESOURCE_LIST_ENDPOINTS = {
    workflow: { url: '/kore/workflows', listKey: 'workflows', valueField: 'id', labelField: 'name' },
    form: { url: '/kore/forms', listKey: 'forms', valueField: 'id', labelField: 'name' },
    datatable: { url: '/kore/datatables', listKey: 'datatables', valueField: 'id', labelField: 'name' },
    // Cookie auth (credentials:'include') works here same as the three
    // above. plugins-front.js's own calls to this endpoint still use the
    // legacy X-Session-Token/getSessionToken() flow (a POST to /auth that
    // always authenticates as a fixed admin identity, unrelated to who's
    // actually logged in) - that's outdated on plugins-front.js's end, not
    // something to replicate here.
    plugin: { url: '/kore/plugins/list', listKey: 'plugins', valueField: 'name', labelField: 'display_name' }
};

let _resourceOptionsCache = {}; // type -> [{value, label}]
let _pluginTaskOptionsCache = {}; // pluginName -> [{value, label}]

async function fetchResourceOptions(type) {
    if (_resourceOptionsCache[type]) return _resourceOptionsCache[type];

    const config = RESOURCE_LIST_ENDPOINTS[type];
    if (!config) return [];

    let options = [];
    try {
        const response = await fetch(config.url, { method: 'GET', credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            const rows = data[config.listKey] || [];
            options = rows.map(row => ({
                value: row[config.valueField],
                label: row[config.labelField] || row[config.valueField]
            }));
        } else {
            console.error(`[Codex] Failed to load ${type} options: HTTP ${response.status}`);
        }
    } catch (err) {
        console.error(`[Codex] Failed to load ${type} options:`, err.message);
    }

    options.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    _resourceOptionsCache[type] = options;
    return options;
}
window.fetchResourceOptions = fetchResourceOptions;

async function fetchPluginTaskOptions(pluginName) {
    if (_pluginTaskOptionsCache[pluginName]) return _pluginTaskOptionsCache[pluginName];

    let options = [];
    try {
        const response = await fetch(`/kore/plugins/${encodeURIComponent(pluginName)}/tasks`, { method: 'GET', credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            options = (data.tasks || []).map(t => ({ value: t.task_id, label: t.display_name || t.task_id }));
        } else {
            console.error(`[Codex] Failed to load tasks for ${pluginName}: HTTP ${response.status}`);
        }
    } catch (err) {
        console.error(`[Codex] Failed to load tasks for ${pluginName}:`, err.message);
    }

    options.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    _pluginTaskOptionsCache[pluginName] = options;
    return options;
}
window.fetchPluginTaskOptions = fetchPluginTaskOptions;

function parsePluginTaskId(id) {
    if (!id) return { pluginName: null, taskId: null };
    const sepIdx = id.indexOf(':');
    if (sepIdx === -1) return { pluginName: id, taskId: null };
    return { pluginName: id.slice(0, sepIdx), taskId: id.slice(sepIdx + 1) };
}
window.parsePluginTaskId = parsePluginTaskId;

/**
 * Looks up a linked resource's *current live* display name for a given
 * type+id pair, via the same cached fetchResourceOptions()/
 * fetchPluginTaskOptions() calls the linked-resource picker uses.
 *
 * This is doc-builder.js's tool, not a general title-display helper -
 * docs' `title` column is itself the maintained, always-real display
 * name now (kept in sync at save time by doc-builder, and in bulk by the
 * refresh-titles maintenance task server-side - see resources.js's
 * refreshDynamicTitles()), so anything just *displaying* a doc's title
 * (cards, Related, Plugin/Tasks panels, the viewer heading) reads
 * `doc.title` directly and doesn't need this at all. This exists
 * specifically for the moment a dynamic_title doc is being edited or
 * saved and the builder needs to know the resource's name *right now*,
 * live, to show in the (disabled) title field and to send as the actual
 * title value on Save.
 *
 * Returns null (not a fallback string) if unresolved, since callers here
 * need to distinguish "couldn't resolve" from "resolved to something" -
 * doc-builder.js decides what to show/send in that case, not this function.
 */
async function resolveLiveResourceTitle(linkedResourceType, linkedResourceId) {
    if (!linkedResourceType || linkedResourceType === 'general' || !linkedResourceId) return null;
    try {
        if (linkedResourceType === 'plugin_task') {
            const { pluginName, taskId } = parsePluginTaskId(linkedResourceId);
            if (!pluginName || taskId === null) return null;
            const options = await fetchPluginTaskOptions(pluginName);
            const match = options.find(o => String(o.value) === String(taskId));
            if (!match) return null;
            const capitalizedPluginName = pluginName.toUpperCase();
            return `${capitalizedPluginName} - ${match.label}`;
        }
        const options = await fetchResourceOptions(linkedResourceType);
        const match = options.find(o => String(o.value) === String(linkedResourceId));
        return match ? match.label : null;
    } catch (err) {
        console.error('[Codex] Failed to resolve live resource title:', err.message);
        return null;
    }
}
window.resolveLiveResourceTitle = resolveLiveResourceTitle;

/**
 * Fetches every doc of a given linkedResourceType, cached per type for
 * the lifetime of the page. Backs the Plugin/Tasks cross-reference
 * panels below - unlike fetchAllDocs() (used by the browse page, which
 * needs every doc for client-side filtering), these panels only ever
 * need one type at a time.
 */
let _docsByTypeCache = {}; // type -> [doc, ...]
async function fetchDocsByType(type) {
    if (_docsByTypeCache[type]) return _docsByTypeCache[type];
    const response = await fetch(`/kore/docs?type=${encodeURIComponent(type)}`, { method: 'GET', credentials: 'include' });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    const docs = data.docs || [];
    _docsByTypeCache[type] = docs;
    return docs;
}

/**
 * Finds the one active plugin doc for a given plugin name, or null.
 * At most one can exist - _assertNoDuplicateLinkedResource enforces
 * that server-side - so there's no ambiguity to resolve here.
 */
async function findPluginDocByName(pluginName) {
    const pluginDocs = await fetchDocsByType('plugin');
    return pluginDocs.find(d => d.linkedResourceId === pluginName) || null;
}

/**
 * Finds every plugin_task doc belonging to a given plugin, sorted
 * alphabetically by title (per the flat-list, alphabetical, nudge-on-
 * empty design - see the Tasks panel in renderDoc()). Sorts on the
 * doc's own maintained `title` column directly - no live resolution
 * needed here, see resolveLiveResourceTitle()'s doc comment above.
 */
async function findTaskDocsForPlugin(pluginName) {
    const taskDocs = await fetchDocsByType('plugin_task');
    const matches = taskDocs.filter(d => {
        const { pluginName: p } = parsePluginTaskId(d.linkedResourceId);
        return p === pluginName;
    });
    matches.sort((a, b) => a.title.localeCompare(b.title));
    return matches;
}

/**
 * Populates the Task sub-select for whichever plugin is currently chosen.
 * Called both on Plugin-select change and while preselecting a saved task.
 */
async function renderLinkedTaskPicker(ids, pluginName, selectedTaskId) {
    const taskSelect = document.getElementById(ids.taskSelectId);
    if (!taskSelect) return;

    if (!pluginName) {
        taskSelect.innerHTML = '<option value="">— Choose a plugin first —</option>';
        taskSelect.value = '';
        taskSelect.disabled = true;
        return;
    }

    taskSelect.disabled = true;
    taskSelect.innerHTML = '<option value="">Loading...</option>';

    const options = await fetchPluginTaskOptions(pluginName);

    if (options.length === 0) {
        taskSelect.innerHTML = '<option value="">No tasks for this plugin</option>';
        taskSelect.disabled = true;
        return;
    }

    taskSelect.innerHTML = '<option value="">— None —</option>' + options.map(o =>
        `<option value="${window.escapeHtml(String(o.value))}">${window.escapeHtml(String(o.label))}</option>`
    ).join('');

    if (selectedTaskId && options.some(o => String(o.value) === String(selectedTaskId))) {
        taskSelect.value = String(selectedTaskId);
    } else {
        taskSelect.value = '';
    }

    taskSelect.disabled = false;
}
window.renderLinkedTaskPicker = renderLinkedTaskPicker;

/**
 * (Re)populates a linked-resource control set for the given type -
 * either the single select (workflow/form/plugin/datatable) or the
 * Plugin+Task pair, toggling which one is visible.
 * @param {object} ids - { selectId, taskRowId, pluginSelectId, taskSelectId }
 * @param {string} type - linkedResourceType value
 * @param {?string} selectedValue - id/name (or "plugin:task" composite
 *   for plugin_task) to preselect if still valid; pass null for a fresh
 *   type change (a resource id valid for one type isn't meaningful once
 *   the type has switched).
 */
async function renderLinkedResourcePicker(ids, type, selectedValue) {
    const select = document.getElementById(ids.selectId);
    const taskRow = document.getElementById(ids.taskRowId);
    if (!select || !taskRow) return;

    if (type === 'plugin_task') {
        select.style.display = 'none';
        taskRow.style.display = 'flex';

        const pluginSelect = document.getElementById(ids.pluginSelectId);
        const { pluginName, taskId } = parsePluginTaskId(selectedValue);

        pluginSelect.disabled = true;
        pluginSelect.innerHTML = '<option value="">Loading...</option>';
        const pluginOptions = await fetchResourceOptions('plugin');

        if (pluginOptions.length === 0) {
            pluginSelect.innerHTML = '<option value="">No plugins available</option>';
            await renderLinkedTaskPicker(ids, null, null);
            return;
        }

        pluginSelect.innerHTML = '<option value="">— None —</option>' + pluginOptions.map(o =>
            `<option value="${window.escapeHtml(String(o.value))}">${window.escapeHtml(String(o.label))}</option>`
        ).join('');

        if (pluginName && pluginOptions.some(o => String(o.value) === String(pluginName))) {
            pluginSelect.value = String(pluginName);
            pluginSelect.disabled = false;
            await renderLinkedTaskPicker(ids, pluginName, taskId);
        } else {
            pluginSelect.value = '';
            pluginSelect.disabled = false;
            await renderLinkedTaskPicker(ids, null, null);
        }
        return;
    }

    // Any other type: show the single select, hide the plugin+task row
    select.style.display = '';
    taskRow.style.display = 'none';

    if (type === 'general') {
        select.innerHTML = '<option value="">— No linked resource for General —</option>';
        select.value = '';
        select.disabled = true;
        return;
    }

    select.disabled = true;
    select.innerHTML = '<option value="">Loading...</option>';

    const options = await fetchResourceOptions(type);

    if (options.length === 0) {
        select.innerHTML = '<option value="">No options available</option>';
        select.disabled = true;
        return;
    }

    select.innerHTML = '<option value="">— None —</option>' + options.map(o =>
        `<option value="${window.escapeHtml(String(o.value))}">${window.escapeHtml(String(o.label))}</option>`
    ).join('');

    // Preserve the current selection only if it's still a real option -
    // a stale id from a deleted resource silently falls back to blank
    // rather than staying selected and invisible in the option list.
    if (selectedValue && options.some(o => String(o.value) === String(selectedValue))) {
        select.value = String(selectedValue);
    } else {
        select.value = '';
    }

    select.disabled = false;
}
window.renderLinkedResourcePicker = renderLinkedResourcePicker;

/**
 * Reads the current value from a picker built by renderLinkedResourcePicker.
 */
function getLinkedResourcePickerValue(ids, type) {
    if (type === 'plugin_task') {
        const pluginName = document.getElementById(ids.pluginSelectId)?.value;
        const taskId = document.getElementById(ids.taskSelectId)?.value;
        if (!pluginName || !taskId) return null;
        return `${pluginName}:${taskId}`;
    }
    const select = document.getElementById(ids.selectId);
    return select && select.value ? select.value : null;
}
window.getLinkedResourcePickerValue = getLinkedResourcePickerValue;

/**
 * Href for a doc's linked resource, based on linkedResourceType. All
 * confirmed: form -> /form?form_id=, datatable -> /datatable?id=,
 * workflow -> /workflow-edit?id=. plugin and plugin_task deliberately
 * return null - there's no admin-side viewer page to link to for either,
 * so renderDoc() just hides the Linked Resource row entirely for those
 * two types rather than showing a dead link.
 */
function linkedResourceHref(type, id) {
    if (!id) return null;
    switch (type) {
        case 'form': return `/form?form_id=${encodeURIComponent(id)}`;
        case 'datatable': return `/datatable?id=${encodeURIComponent(id)}`;
        case 'workflow': return `/workflow-edit?id=${encodeURIComponent(id)}`;
        case 'plugin': return null;
        case 'plugin_task': return null;
        default: return null;
    }
}

/**
 * Short "Aug 12" style date, matching the dashboard's activity-list format.
 * Pass includeYear=true for the fuller "Aug 12, 2026" used on the detail page.
 */
function formatDate(dateStr, includeYear = false) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const opts = { month: 'short', day: 'numeric' };
    if (includeYear) opts.year = 'numeric';
    return d.toLocaleDateString('en-US', opts);
}

function escapeAttr(str) {
    return String(str || '').replace(/"/g, '&quot;');
}

// ============================================================
// DOCS LIST PAGE (docs.html)
// ============================================================

let _allDocs = [];
let _docFolders = [];
// canCreateDocs/canManageFolders come back from every /kore/docs fetch
// (see fetchAllDocs) - used to hide Import/New Doc and the folder panel's
// create/edit buttons for anyone without doc_admin/doc_folder rights,
// rather than showing controls that would just 403 on click. Default
// false until the first fetch resolves, so those controls start hidden
// and only appear once we actually know the user is allowed to see them -
// safer than defaulting to shown and having to hide them a beat later.
let _canCreateDocs = false;
let _canManageFolders = false;
let _canViewRestrictedTypes = false;
let _canRefreshTitles = false;
// types starts empty - no type filter, every type shown on first load.
// Previously defaulted to ['general','form','datatable'] specifically to
// exclude workflow/plugin/plugin_task until broadened - no longer wanted.
let _docsFilterState = { folderId: 'all', tag: null, search: '', types: [] };

async function fetchAllDocs() {
    const response = await fetch('/kore/docs', { method: 'GET', credentials: 'include' });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    _canCreateDocs = !!data.canCreateDocs;
    _canManageFolders = !!data.canManageFolders;
    _canViewRestrictedTypes = !!data.canViewRestrictedTypes;
    _canRefreshTitles = !!data.canRefreshTitles;
    applyDocsPermissionUI();
    return data.docs || [];
}

/**
 * Applies the two doc-level permission flags to the UI - hides Import/
 * New Doc (docs.html only has these; doc.html/doc-builder.html don't call
 * fetchAllDocs at all, so this is a no-op there) and hides the folder
 * panel's create ("+") and edit (pencil) buttons via their known ids from
 * base.js's buildFoldersPanel. Called after every fetchAllDocs() AND
 * after buildDocsFoldersPanel() (which (re)creates those folder buttons
 * fresh each time it runs, so hiding them only once wouldn't survive a
 * folder-panel reload) - safe to call redundantly since it's idempotent.
 */
function applyDocsPermissionUI() {
    const importBtn = document.querySelector('button[onclick="openImportDocModal()"]');
    const newDocBtn = document.querySelector('button[onclick="openCreateDocModal()"]');
    const refreshTitlesBtn = document.querySelector('button[onclick="triggerTitleRefresh()"]');
    if (importBtn) importBtn.style.display = _canCreateDocs ? '' : 'none';
    if (newDocBtn) newDocBtn.style.display = _canCreateDocs ? '' : 'none';
    if (refreshTitlesBtn) refreshTitlesBtn.style.display = _canRefreshTitles ? '' : 'none';

    const createFolderBtn = document.getElementById('createFolderBtn');
    const editFolderBtn = document.getElementById('editFolderBtn');
    if (createFolderBtn) createFolderBtn.style.display = _canManageFolders ? '' : 'none';
    if (editFolderBtn) editFolderBtn.style.display = _canManageFolders ? '' : 'none';
}

async function fetchDocFolders() {
    const response = await fetch('/kore/doc-folders', { method: 'GET', credentials: 'include' });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    return data.folders || [];
}

function applyDocsFilters() {
    const { folderId, tag, search, types } = _docsFilterState;
    const term = search.trim().toLowerCase();

    return _allDocs.filter(doc => {
        if (folderId === 'no_folder') {
            if (doc.folderId) return false;
        } else if (folderId && folderId !== 'all') {
            if (doc.folderId !== folderId) return false;
        }
        if (types.length > 0 && !types.includes(doc.linkedResourceType)) return false;
        if (tag && !(doc.tags || []).includes(tag)) return false;
        if (term && !doc.title.toLowerCase().includes(term)) return false;
        return true;
    });
}

/**
 * Resource-type filter, built with base.js's generic multi-select widget
 * (renderMultiSelectContainer + initializeMultiSelect) rather than a
 * bespoke pill row - reuses its search/Select All/tag-with-remove-button
 * behavior for free. Empty selection means "no type filter" (show every
 * type), matching how the widget is used elsewhere in the app - filtering
 * down to zero results on an empty selection would be surprising.
 *
 * Options are limited to what the user can actually view - Workflow/
 * Plugin/Plugin Task are left out entirely (not just empty when
 * selected) for anyone without _canViewRestrictedTypes, so the filter
 * never offers a choice that's guaranteed to return nothing.
 */
const _CLIENT_RESTRICTED_TYPES = new Set(['workflow', 'plugin', 'plugin_task']);
function initDocsTypeFilter() {
    const container = document.getElementById('docsTypeFilterContainer');
    if (!container) return;

    container.innerHTML = window.renderMultiSelectContainer('docsTypeFilter', 'docsTypeFilter');

    const options = Object.entries(DOC_TYPE_LABELS)
        .filter(([value]) => _canViewRestrictedTypes || !_CLIENT_RESTRICTED_TYPES.has(value))
        .map(([value, label]) => ({ value, label }));

    window.initializeMultiSelect(container, options, _docsFilterState.types, {
        searchable: false,
        onChange: (selected) => {
            _docsFilterState.types = selected;
            renderDocsList();
        }
    });
}

function renderDocsList() {
    const container = document.getElementById('docsList');
    if (!container) return;

    const filtered = applyDocsFilters();

    if (filtered.length === 0) {
        container.innerHTML = `<div style="padding:20px 10px;font-size:13px;color:var(--text-muted)">No docs match your filters.</div>`;
        return;
    }

    container.innerHTML = filtered.map(doc => `
        <a href="/doc?id=${encodeURIComponent(doc.id)}" style="text-decoration:none">
            <div class="docs-item-row">
                <div class="docs-item-title">${_escapeHtml(doc.title)}</div>
                <span class="docs-item-badge">${docTypeLabel(doc.linkedResourceType)}</span>
            </div>
        </a>
    `).join('');
}

function renderTagCloud() {
    const cloud = document.getElementById('docsTagCloud');
    if (!cloud) return;

    const tagSet = new Set();
    for (const doc of _allDocs) {
        for (const t of (doc.tags || [])) tagSet.add(t);
    }
    const tags = Array.from(tagSet).sort();

    if (tags.length === 0) {
        cloud.innerHTML = `<div style="font-size:12px;color:var(--text-muted)">No tags yet.</div>`;
        return;
    }

    cloud.innerHTML = tags.map(tag =>
        `<span class="docs-tag-chip" data-tag="${escapeAttr(tag)}">${_escapeHtml(tag)}</span>`
    ).join('');

    cloud.querySelectorAll('.docs-tag-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const tag = chip.dataset.tag;
            _docsFilterState.tag = (_docsFilterState.tag === tag) ? null : tag;
            cloud.querySelectorAll('.docs-tag-chip').forEach(c =>
                c.classList.toggle('active', c.dataset.tag === _docsFilterState.tag)
            );
            renderDocsList();
        });
    });
}

/**
 * Folder tree sidebar, built via base.js's generic buildFoldersPanel (the
 * same mechanism the Forms page uses). Not going through the higher-level
 * buildWorkflowFoldersPanel/onFolderSelectedGeneric convenience wrapper
 * because that hardcodes `item.folder_id` (snake_case) for filtering -
 * docs.folderId is camelCase, so onDocFolderSelect below does that
 * filtering itself instead.
 *
 * buildFoldersPanel auto-selects "All" once it finishes rendering, which
 * fires onDocFolderSelect and renders the doc list - so no separate
 * initial renderDocsList() call is needed after this runs.
 */
async function buildDocsFoldersPanel() {
    try {
        _docFolders = await fetchDocFolders();
    } catch (err) {
        console.error('[Codex] Failed to load doc folders:', err.message);
        _docFolders = [];
    }

    window.buildFoldersPanel(
        'foldersPanelContainer',
        _docFolders,
        onDocFolderSelect,
        (folderId, updates, onReload) => window.performEditFolderGeneric('doc-folders', folderId, updates, onReload),
        (folderId, onReload) => window.performDeleteFolderGeneric('doc-folders', folderId, 'docs', onReload),
        () => window.openCreateFolderModalGeneric('doc-folders', _docFolders, onDocFolderSelect, buildDocsFoldersPanel),
        buildDocsFoldersPanel
    );

    // buildFoldersPanel just recreated the create/edit buttons fresh -
    // re-apply the permission-based hiding, since it doesn't know about
    // _canManageFolders and builds both buttons unconditionally.
    applyDocsPermissionUI();
}

function onDocFolderSelect(folder) {
    _docsFilterState.folderId = folder.id;
    renderDocsList();
}

/**
 * Bound to the search input's oninput="filterDocs(this.value)" in
 * docs.html. Exposed on window since this module's own scope isn't
 * reachable from an inline HTML attribute handler.
 */
function filterDocs(value) {
    _docsFilterState.search = value || '';
    renderDocsList();
}
window.filterDocs = filterDocs;

/**
 * Exposed on window because performDeleteFolderGeneric('doc-folders', ...,
 * 'docs', ...) looks up `window.loadDocs` by name after a folder delete,
 * the same convention forms.js's loadForms/workflows.js's loadWorkflows
 * follow for their own item types.
 */
async function loadDocs() {
    try {
        _allDocs = await fetchAllDocs();
    } catch (err) {
        console.error('[Codex] Failed to reload docs:', err.message);
    }
    renderTagCloud();
    renderDocsList();
    return _allDocs;
}
window.loadDocs = loadDocs;

/**
 * "New Doc" button handler. Follows the same shape as Forms'
 * openCreateModal: showFormModal for the fields, POST on submit, then
 * navigate to the new doc. Pre-fills folderId from whichever folder is
 * currently selected in the sidebar (if any) so creating a doc while
 * browsing "Onboarding" lands it in "Onboarding" without an extra step.
 *
 * NOTE: doc-builder (the actual content editor) doesn't exist yet -
 * that's the next page to build. This creates an empty doc and redirects
 * there in anticipation of it, same as Forms creating then redirecting
 * into /form-builder rather than the read-only /form viewer.
 */
/**
 * Stacked error modal (window.showModal called while another modal is
 * still open, using its own modalStack z-index/offset support) - used by
 * both the New Doc and Import modals below rather than an inline banner,
 * so a rejected submission stays visible without losing what was typed
 * and without closing the modal underneath.
 */
function showDocModalError(message) {
    window.showModal({
        title: 'Error',
        content: `<p style="color: var(--text-primary); margin: 0;">${window.escapeHtml(message)}</p>`,
        buttons: [{ label: 'OK', type: 'primary', onClick: () => {} }]
    });
}

const CREATE_DOC_PICKER_IDS = {
    selectId: 'createDocLinkedIdSelect',
    taskRowId: 'createDocLinkedTaskRow',
    pluginSelectId: 'createDocLinkedPluginSelect',
    taskSelectId: 'createDocLinkedTaskSelect'
};

async function onCreateDocTypeChange() {
    const type = document.getElementById('createDocTypeSelect').value;
    await renderLinkedResourcePicker(CREATE_DOC_PICKER_IDS, type, null);

    // Dynamic title defaults ON (opt-out) for every non-general type -
    // matches doc-builder's own checkbox behavior, just pre-checked here
    // since this is a fresh doc rather than an existing one being loaded.
    const dynamicTitleCheckbox = document.getElementById('createDocDynamicTitleCheckbox');
    if (type === 'general') {
        dynamicTitleCheckbox.checked = false;
        dynamicTitleCheckbox.disabled = true;
    } else {
        dynamicTitleCheckbox.checked = true;
        dynamicTitleCheckbox.disabled = false;
    }
}
window.onCreateDocTypeChange = onCreateDocTypeChange;

async function onCreateDocPluginChange() {
    const pluginName = document.getElementById('createDocLinkedPluginSelect').value;
    await renderLinkedTaskPicker(CREATE_DOC_PICKER_IDS, pluginName, null);
}
window.onCreateDocPluginChange = onCreateDocPluginChange;

/**
 * "New Doc" button handler. Type selection dynamically shows the matching
 * Linked Resource picker (single select, or the Plugin+Task pair for
 * plugin_task) via the shared renderLinkedResourcePicker. Validates title
 * + checks for a duplicate linked resource (reusing the already-loaded
 * _allDocs list - same UX-convenience-layer note as doc-builder.js's
 * equivalent check; the server enforces the real constraint either way)
 * before submitting, showing a stacked error modal and leaving this modal
 * open on any rejection. Redirects into doc-builder (the content editor)
 * on success.
 */
/**
 * "Refresh Titles" button handler. Server-side (admin-permission-gated,
 * see resources.js's handleRefreshDynamicTitles) sweep of every
 * dynamic_title doc's cached title against its live linked resource - see
 * refreshDynamicTitles() there for why this is a title-only write with no
 * version bump. A non-admin clicking this just gets the server's 403
 * surfaced as a normal error banner; the button itself isn't hidden for
 * non-admins since there's no cheap client-side way to know in advance
 * whether the caller holds that permission.
 */
async function triggerTitleRefresh() {
    try {
        const response = await fetch('/kore/docs/refresh-titles', { method: 'POST', credentials: 'include' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

        window.showStatusBanner(
            `Refreshed ${data.updated} title${data.updated === 1 ? '' : 's'} (${data.unchanged} already current, ${data.unresolved} unresolved) of ${data.total} dynamic-title docs.`,
            'success'
        );

        // Re-fetch so any changed titles show immediately rather than
        // waiting for a manual page reload.
        _allDocs = await fetchAllDocs();
        renderDocsList();
        renderTagCloud();
    } catch (error) {
        console.error('[Codex] Error refreshing titles:', error.message);
        window.showStatusBanner(`Error refreshing titles: ${error.message}`, 'error');
    }
}
window.triggerTitleRefresh = triggerTitleRefresh;

function openCreateDocModal() {
    const modalContent = document.createElement('div');
    modalContent.innerHTML = `
        <div style="margin-bottom: 14px;">
            <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary);">Title</label>
            <input type="text" id="createDocTitleInput" placeholder="Enter doc title" style="width: 100%; box-sizing: border-box;">
        </div>
        <div style="display: flex; gap: 12px;">
            <div style="flex: 1;">
                <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary);">Type</label>
                <select id="createDocTypeSelect" onchange="onCreateDocTypeChange()" style="width: 100%;">
                    <option value="general">General</option>
                    <option value="workflow">Workflow</option>
                    <option value="form">Form</option>
                    <option value="plugin">Plugin</option>
                    <option value="plugin_task">Plugin Task</option>
                    <option value="datatable">Datatable</option>
                </select>
            </div>
            <div style="flex: 1;">
                <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary);">Linked Resource</label>
                <select id="createDocLinkedIdSelect" disabled style="width: 100%;">
                    <option value="">— No linked resource for General —</option>
                </select>
                <div id="createDocLinkedTaskRow" style="display: none; gap: 8px; margin-top: 6px;">
                    <select id="createDocLinkedPluginSelect" onchange="onCreateDocPluginChange()" style="flex: 1;"></select>
                    <select id="createDocLinkedTaskSelect" style="flex: 1;" disabled></select>
                </div>
            </div>
        </div>
        <label style="display: flex; align-items: center; gap: 6px; margin-top: 12px; font-size: 12px; color: var(--text-secondary); cursor: pointer;">
            <input type="checkbox" id="createDocDynamicTitleCheckbox" disabled>
            Dynamic title — keep in sync with the linked resource's current name
        </label>
    `;

    window.showModal({
        title: 'New Doc',
        content: modalContent,
        resizable: false,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Create',
                type: 'success',
                // Same sync-onClick + async-IIFE shape as the Import
                // modal below, for the same reason: showModal's button
                // handler reads onClick()'s return value BEFORE awaiting
                // it, so an async onClick's `return false` never actually
                // prevents the auto-close (the captured value is always
                // a Promise, never `=== false`). See the Import modal's
                // comment for the full explanation.
                onClick: () => {
                    (async () => {
                        const title = modalContent.querySelector('#createDocTitleInput').value.trim();
                        if (!title) {
                            showDocModalError('Title is required.');
                            return;
                        }

                        const type = document.getElementById('createDocTypeSelect').value;
                        const linkedResourceId = getLinkedResourcePickerValue(CREATE_DOC_PICKER_IDS, type);

                        if (linkedResourceId && type !== 'general') {
                            const duplicate = _allDocs.find(d => d.linkedResourceType === type && d.linkedResourceId === linkedResourceId);
                            if (duplicate) {
                                showDocModalError(`A doc already exists for this ${docTypeLabel(type)}: "${duplicate.title}". Pick a different resource, or edit that doc instead.`);
                                return;
                            }
                        }

                        const dynamicTitle = document.getElementById('createDocDynamicTitleCheckbox').checked;
                        const payload = { title, dynamicTitle, linkedResourceType: type, linkedResourceId };

                        const currentFolder = _docsFilterState.folderId;
                        if (currentFolder && currentFolder !== 'all' && currentFolder !== 'no_folder') {
                            payload.folderId = currentFolder;
                        }

                        try {
                            const response = await fetch('/kore/docs', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                credentials: 'include',
                                body: JSON.stringify(payload)
                            });
                            if (!response.ok) {
                                const data = await response.json().catch(() => ({}));
                                throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
                            }
                            const result = await response.json();
                            window.closeModal();
                            window.location.href = `/doc-builder?id=${encodeURIComponent(result.id)}`;
                        } catch (error) {
                            console.error('[Codex] Error creating doc:', error.message);
                            showDocModalError(error.message);
                        }
                    })();
                    return false;
                }
            }
        ],
        width: '520px'
    });
}
window.openCreateDocModal = openCreateDocModal;

/**
 * "Import" button handler — paste a doc definition JSON (e.g. one
 * generated by Claude) instead of filling in fields by hand. Mirrors
 * workflows.js's openImportModal (textarea + folder tree below it, per
 * your steer that Workflows was the better reference than Forms here),
 * adapted for docs' flat field shape instead of a `definition` blob and
 * for docs.folderId being camelCase.
 *
 * Expected JSON shape: { id?, title, linkedResourceType?, linkedResourceId?,
 * content?, tags?, related? }. Only `title` is required; everything else
 * defaults the same way createDoc() on the server does.
 *
 * `id`, if supplied, is respected as-is rather than auto-generated -
 * createDoc() validates it's not already taken and errors clearly rather
 * than silently substituting a different one. Lets a planned batch of
 * related docs reference each other's real ids upfront, instead of
 * guessing at what auto-generation will produce.
 *
 * `linkedResourceId` and `related` are ids-only, no name lookup - if the
 * pasted definition doesn't have the real id, leave it out and set it
 * later rather than guessing from a title.
 *
 * `folderId` is deliberately NOT part of this shape. Folder is a
 * UI/import-time choice made via the tree picker below, not doc content
 * - it's not something Claude should be generating as part of a
 * definition, so there's no fallback to a JSON field for it.
 */
function openImportDocModal() {
    window.pendingImportFolder = null;

    const modalContent = document.createElement('div');
    modalContent.style.cssText = 'display: flex; flex-direction: column; height: 100%;';
    modalContent.innerHTML = `
        <div style="margin-bottom: 14px; flex: 1; display: flex; flex-direction: column; min-height: 0;">
            <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary); flex-shrink: 0;">Doc Definition JSON</label>
            <textarea id="importDocDefinitionInput" placeholder="Paste the doc definition JSON here"
                style="width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.8rem; padding: 10px;
                       border: 1px solid var(--border-primary); border-radius: 4px; background: var(--bg-input); color: var(--text-primary); resize: vertical; flex: 1; min-height: 0;"></textarea>
        </div>
        <div style="flex-shrink: 0;">
            <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary);">Folder (optional)</label>
            <div id="importDocFolderTree" style="border: 1px solid var(--border-primary); border-radius: 4px; max-height: 200px; overflow-y: auto; background: var(--bg-input); padding: 8px;"></div>
        </div>
    `;

    // Rejection feedback opens as its own stacked modal (window.showModal
    // supports this natively via modalStack's z-index/offset logic) rather
    // than an inline banner - the Import modal underneath is left open,
    // never closed, so the pasted JSON isn't lost.
    window.showModal({
        title: 'Import Doc',
        content: modalContent,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Import',
                type: 'success',
                // NOT `async () => {...}` - showModal's button handler
                // captures onClick()'s return value BEFORE awaiting it, so
                // for an async function that value is always a Promise,
                // never actually `=== false`, and the modal auto-closes
                // regardless of what the async body returns. Working
                // around that locally here rather than patching base.js
                // (shared across the whole app) for a fix only asked for
                // in this modal. onClick is a plain sync function that
                // always returns false (so showModal never auto-closes),
                // with an inner async IIFE doing the real work and closing
                // the modal itself only when it actually succeeds.
                onClick: () => {
                    (async () => {
                        const rawJson = modalContent.querySelector('#importDocDefinitionInput').value.trim();
                        if (!rawJson) {
                            showDocModalError('Paste a doc definition JSON before importing.');
                            return;
                        }

                        let definition;
                        try {
                            definition = JSON.parse(rawJson);
                        } catch (e) {
                            showDocModalError(`Invalid JSON: ${e.message}`);
                            return;
                        }

                        if (!definition.title) {
                            showDocModalError('Definition must include a "title".');
                            return;
                        }

                        try {
                            const importType = definition.linkedResourceType || 'general';
                            const payload = {
                                title: definition.title,
                                dynamicTitle: importType !== 'general' && !!definition.dynamicTitle,
                                linkedResourceType: importType,
                                linkedResourceId: definition.linkedResourceId || null,
                                content: definition.content || null,
                                tags: Array.isArray(definition.tags) ? definition.tags : [],
                                related: Array.isArray(definition.related) ? definition.related : [],
                                // Folder comes ONLY from the tree picker below -
                                // not from the pasted JSON. See note above.
                                folderId: window.pendingImportFolder || null
                            };
                            // Only included if the definition actually supplies
                            // one - createDoc() (resources.js) auto-generates an
                            // id itself when this is omitted, same as before.
                            // Respecting a caller-specified id here means a
                            // pre-planned id can be referenced correctly by
                            // other docs' `related` in the same batch, rather
                            // than guessed at and found wrong only after the
                            // fact (a real, concrete instance of exactly this
                            // happened earlier this session).
                            if (definition.id) {
                                payload.id = definition.id;
                            }

                            const response = await fetch('/kore/docs', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                credentials: 'include',
                                body: JSON.stringify(payload)
                            });

                            if (!response.ok) {
                                const data = await response.json().catch(() => ({}));
                                throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
                            }

                            const result = await response.json();
                            window.closeModal(); // explicit - see comment on onClick above
                            window.location.href = `/doc-builder?id=${encodeURIComponent(result.id)}`;
                        } catch (error) {
                            console.error('[Codex] Error importing doc:', error.message);
                            showDocModalError(error.message);
                        }
                    })();
                    return false;
                }
            }
        ],
        width: '600px',
        height: '90vh'
    });

    // Populate the folder tree the same way workflows.js's import modal does
    setTimeout(() => {
        const folders = _docFolders || [];
        const treeContainer = modalContent.querySelector('#importDocFolderTree');
        if (!treeContainer) return;

        const resetHighlights = () => {
            treeContainer.querySelectorAll('[data-item-id]').forEach(el => { el.style.background = 'transparent'; });
            noFolderDiv.style.background = 'transparent';
        };

        const noFolderDiv = document.createElement('div');
        noFolderDiv.style.cssText = 'padding: 8px; cursor: pointer; border-radius: 3px; margin-bottom: 4px; height: 20px; font-size: 0.8rem; background: rgba(126, 200, 255, 0.2);';
        noFolderDiv.textContent = 'No Folder';
        noFolderDiv.onclick = () => {
            window.pendingImportFolder = null;
            resetHighlights();
            noFolderDiv.style.background = 'rgba(126, 200, 255, 0.2)';
        };
        treeContainer.appendChild(noFolderDiv);

        if (folders.length > 0) {
            const treeDiv = document.createElement('div');
            window.renderTree(folders, treeDiv, {
                onItemClick: (folder) => {
                    window.pendingImportFolder = folder.id;
                    resetHighlights();
                    const selectedEl = treeDiv.querySelector(`[data-item-id="${folder.id}"]`);
                    if (selectedEl) selectedEl.style.background = 'rgba(126, 200, 255, 0.2)';
                }
            });
            treeContainer.appendChild(treeDiv);
        }
    }, 0);
}
window.openImportDocModal = openImportDocModal;

async function initDocsListPage() {
    try {
        _allDocs = await fetchAllDocs();
    } catch (err) {
        console.error('[Codex] Failed to load docs:', err.message);
        const container = document.getElementById('docsList');
        if (container) {
            container.innerHTML = `<div style="padding:20px 10px;font-size:13px;color:var(--text-muted)">Couldn't load docs. Try refreshing.</div>`;
        }
        return;
    }

    initDocsTypeFilter();

    // Default open/closed state, set once - not inside renderTagCloud()
    // itself, since that re-renders repeatedly over the page's lifetime
    // (new docs, tag changes, etc.) and would reset a person's manual
    // toggle every time it ran. 899px matches this page's own existing
    // mobile breakpoint (see the @media rule at the top of docs.html).
    const tagsSection = document.getElementById('docsTagsSection');
    if (tagsSection) tagsSection.open = window.innerWidth > 899;

    renderTagCloud();
    await buildDocsFoldersPanel();
}

// ============================================================
// DOC DETAIL PAGE (doc.html)
// ============================================================

function getDocIdFromQuery() {
    return new URLSearchParams(window.location.search).get('id');
}

let _currentViewedDocId = null;

async function fetchDoc(docId) {
    const response = await fetch(`/kore/docs/${encodeURIComponent(docId)}`, { method: 'GET', credentials: 'include' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
}

async function renderDoc(doc) {
    _currentViewedDocId = doc.id;

    const titleEl = document.getElementById('docTitle');
    if (titleEl) titleEl.textContent = doc.title;

    const badgeEl = document.getElementById('docTypeBadge');
    if (badgeEl) badgeEl.textContent = docTypeLabel(doc.linkedResourceType);

    const dateEl = document.getElementById('docUpdatedDate');
    if (dateEl) dateEl.textContent = `Updated ${formatDate(doc.updatedAt, true)}`;

    const editBtn = document.getElementById('docEditBtn');
    if (editBtn) editBtn.style.display = doc.canEdit === false ? 'none' : '';

    const contentEl = document.getElementById('docContent');
    if (contentEl) {
        contentEl.innerHTML = doc.content
            ? renderMarkdown(doc.content)
            : `<p style="color:var(--text-muted)">This doc doesn't have any content yet.</p>`;
    }

    // Linked resource — hide the row entirely for general docs with nothing to link to
    const linkedRow = document.getElementById('docLinkedResourceRow');
    const linkedValue = document.getElementById('docLinkedResourceValue');
    const href = linkedResourceHref(doc.linkedResourceType, doc.linkedResourceId);
    if (linkedRow && linkedValue) {
        if (href) {
            linkedValue.innerHTML = `<a href="${href}" style="color:var(--brand-lighter);text-decoration:none">View ${docTypeLabel(doc.linkedResourceType)} &#8594;</a>`;
            linkedRow.style.display = '';
        } else {
            linkedRow.style.display = 'none';
        }
    }

    // Folder
    const folderRow = document.getElementById('docFolderRow');
    const folderValue = document.getElementById('docFolderValue');
    if (folderRow && folderValue) {
        if (doc.folder_name) {
            folderValue.textContent = doc.folder_name;
            folderRow.style.display = '';
        } else {
            folderRow.style.display = 'none';
        }
    }

    // Tags
    const tagsPanel = document.getElementById('docTagsPanel');
    const tagsEl = document.getElementById('docTags');
    if (tagsPanel && tagsEl) {
        if (doc.tags && doc.tags.length > 0) {
            tagsEl.innerHTML = doc.tags.map(tag =>
                `<a href="/docs" style="text-decoration:none"><span class="doc-tag-chip">${_escapeHtml(tag)}</span></a>`
            ).join('');
            tagsPanel.style.display = '';
        } else {
            tagsPanel.style.display = 'none';
        }
    }

    // Plugin (plugin_task docs only) — the one doc for this task's parent
    // plugin, nudging toward creating one if it doesn't exist yet rather
    // than hiding the panel outright, since this is a good spot to
    // surface a documentation gap.
    const pluginPanel = document.getElementById('docPluginPanel');
    const pluginValue = document.getElementById('docPluginValue');
    if (pluginPanel && pluginValue) {
        if (doc.linkedResourceType === 'plugin_task') {
            const { pluginName } = parsePluginTaskId(doc.linkedResourceId);
            pluginPanel.style.display = '';
            pluginValue.innerHTML = `<span style="color:var(--text-muted)">Loading...</span>`;
            try {
                const pluginDoc = pluginName ? await findPluginDocByName(pluginName) : null;
                if (pluginDoc) {
                    pluginValue.innerHTML = `<a href="/doc?id=${encodeURIComponent(pluginDoc.id)}" style="color:var(--brand-lighter);text-decoration:none">${_escapeHtml(pluginDoc.title)} &#8594;</a>`;
                } else {
                    pluginValue.innerHTML = `<span style="color:var(--text-muted)">No doc yet for the "${_escapeHtml(pluginName || '')}" plugin.</span>`;
                }
            } catch (err) {
                console.error('[Codex] Failed to load parent plugin doc:', err.message);
                pluginValue.innerHTML = `<span style="color:var(--text-muted)">Couldn't load the parent plugin doc.</span>`;
            }
        } else {
            pluginPanel.style.display = 'none';
        }
    }

    // Tasks (plugin docs only) — every documented task belonging to this
    // plugin, flat list, alphabetical by title. Nudges toward filling gaps
    // when empty rather than hiding, same reasoning as Plugin above - even
    // a plugin with 100 documented tasks is an acceptable page length as
    // a flat list.
    const tasksPanel = document.getElementById('docTasksPanel');
    const tasksList = document.getElementById('docTasksList');
    if (tasksPanel && tasksList) {
        if (doc.linkedResourceType === 'plugin') {
            tasksPanel.style.display = '';
            tasksList.innerHTML = `<span style="color:var(--text-muted);font-size:13px">Loading...</span>`;
            try {
                const taskDocs = await findTaskDocsForPlugin(doc.linkedResourceId);
                if (taskDocs.length > 0) {
                    tasksList.innerHTML = taskDocs.map(t =>
                        `<a href="/doc?id=${encodeURIComponent(t.id)}" class="doc-related-link">${_escapeHtml(t.title)}</a>`
                    ).join('');
                } else {
                    tasksList.innerHTML = `<span style="color:var(--text-muted);font-size:13px">No tasks documented yet for this plugin.</span>`;
                }
            } catch (err) {
                console.error('[Codex] Failed to load task docs:', err.message);
                tasksList.innerHTML = `<span style="color:var(--text-muted);font-size:13px">Couldn't load task docs.</span>`;
            }
        } else {
            tasksPanel.style.display = 'none';
        }
    }

    // Related docs - grouped by type, badge as a section header rather
    // than repeated per item, since several related docs commonly share
    // a type (e.g. multiple related workflows).
    const relatedPanel = document.getElementById('docRelatedPanel');
    const relatedList = document.getElementById('docRelatedList');
    if (relatedPanel && relatedList) {
        if (doc.related && doc.related.length > 0) {
            const byType = new Map();
            doc.related.forEach(r => {
                const t = r.linkedResourceType || 'general';
                if (!byType.has(t)) byType.set(t, []);
                byType.get(t).push(r);
            });
            const renderGroup = (t, items) => {
                const rendered = items
                    .map(r => `<a href="/doc?id=${encodeURIComponent(r.id)}" class="doc-related-link">${_escapeHtml(r.title)}</a>`)
                    .join('');
                const header = DOC_TYPE_LABELS_PLURAL[t] || 'General';
                return `<div class="doc-related-group"><div class="doc-item-badge doc-related-group-header">${header}</div>${rendered}</div>`;
            };
            const known = DOC_TYPE_ORDER.filter(t => byType.has(t)).map(t => renderGroup(t, byType.get(t)));
            // Fallback for any type outside the fixed order list, so an
            // unexpected/future type never silently disappears from the
            // panel instead of just being grouped imperfectly.
            const unknown = [...byType.keys()]
                .filter(t => !DOC_TYPE_ORDER.includes(t))
                .map(t => renderGroup(t, byType.get(t)));
            relatedList.innerHTML = known.concat(unknown).join('');
            relatedPanel.style.display = '';
        } else {
            relatedPanel.style.display = 'none';
        }
    }

    document.title = `${doc.title} — Codex`;
}

function renderDocNotFound() {
    const contentEl = document.getElementById('docContent');
    if (contentEl) {
        contentEl.innerHTML = `<p style="color:var(--text-muted)">This doc doesn't exist, or you don't have permission to view it.</p>`;
    }
    const titleEl = document.getElementById('docTitle');
    if (titleEl) titleEl.textContent = 'Doc not found';

    const editBtn = document.getElementById('docEditBtn');
    if (editBtn) editBtn.style.display = 'none';

    ['docLinkedResourceRow', 'docFolderRow'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    ['docTagsPanel', 'docPluginPanel', 'docTasksPanel', 'docRelatedPanel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
}

function editCurrentDoc() {
    if (!_currentViewedDocId) return;
    window.location.href = `/doc-builder?id=${encodeURIComponent(_currentViewedDocId)}`;
}
window.editCurrentDoc = editCurrentDoc;

async function initDocPage() {
    const docId = getDocIdFromQuery();
    if (!docId) {
        renderDocNotFound();
        return;
    }

    try {
        const doc = await fetchDoc(docId);
        if (!doc) {
            renderDocNotFound();
            return;
        }
        await renderDoc(doc);
    } catch (err) {
        console.error('[Codex] Failed to load doc:', err.message);
        renderDocNotFound();
    }
}

// ============================================================
// ENTRY POINT
// ============================================================

function init() {
    if (document.getElementById('docsList')) {
        initDocsListPage();
    } else if (document.getElementById('docContent')) {
        initDocPage();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}