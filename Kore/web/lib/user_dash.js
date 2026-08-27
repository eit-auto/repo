const dateEl = document.getElementById('userPortalDate');
if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

const greetingWord = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
})();
const greetingEl = document.getElementById('userPortalGreeting');
if (greetingEl) greetingEl.textContent = greetingWord;

// user-portal.js is already loaded by BASE's own module script by the time
// this runs; re-importing the same URL is a no-op (modules only evaluate
// once), so this is safe even if page load order ever changes. Importing
// user-portal.js (rather than base.js directly) is what gets us
// getCurrentUserPortalUser() — and user-portal.js's own top-level
// `import '/lib/base.js'` guarantees base.js has already run too.
await import('/lib/user-portal.js');
await import('/lib/plugins-front.js');
const user = await window.getCurrentUserPortalUser();
if (greetingEl && user && user.fullName) {
    const firstName = user.fullName.trim().split(/\s+/)[0];
    greetingEl.textContent = greetingWord + ', ' + firstName;
}

/**
 * Fetch a dashboard pod's definition from kore_sys.dashboard_pods.
 * source_config comes back as a JSON string from some drivers and an
 * already-parsed object from others — normalize to an object either way.
 * @param {string} sessionToken
 * @param {string} user
 * @param {string} podName
 * @returns {Promise<object|null>}
 */
async function getDashboardPod(sessionToken, user, podName) {
    try {
        const escaped = String(podName).replace(/'/g, "''");
        const result = await executeSqlQuery(
            sessionToken,
            user,
            'kore_sys',
            `SELECT pod_name, display_name, description, source_config FROM dashboard_pods WHERE pod_name = '${escaped}' AND active = 1`
        );
        if (!result.result || result.result.length === 0) return null;
        const row = result.result[0];
        return {
            ...row,
            source_config: typeof row.source_config === 'string' ? JSON.parse(row.source_config) : row.source_config,
        };
    } catch (error) {
        console.error(`Error fetching dashboard pod "${podName}":`, error);
        return null;
    }
}

/** Read a dotted path ('board.name', '_info.dateEntered') out of a nested object. */
function getByPath(obj, path) {
    if (!path) return undefined;
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** Compact "Xm/Xh/Xd" formatting — no "ago" suffix, kept tight for a table column. */
function formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const then = new Date(dateStr);
    if (isNaN(then.getTime())) return '';
    const diffMin = Math.round((Date.now() - then.getTime()) / 60000);
    if (diffMin < 60) return `${Math.max(diffMin, 0)}m`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    return `${Math.round(diffHr / 24)}d`;
}

/** Absolute date, nicely formatted (e.g. "Aug 19, 2026") — distinct from
 *  formatRelativeTime above, which the ticket tables' Age/Last Touch
 *  columns still use. */
function formatNiceDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Time-of-day only (e.g. "9:00 AM"), in the viewer's own browser/OS
 *  timezone — deliberately not forced to any particular zone, unlike the
 *  query-boundary helpers below which must be. Showing a meeting's start
 *  time in whatever zone the viewer is actually in is correct regardless
 *  of which zone the underlying query window was anchored to. */
function formatClockTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The UTC offset (in minutes, positive = ahead of UTC) that `timeZone` is
 *  actually observing at the given instant — via Intl round-tripping
 *  rather than a fixed number, since zones like America/Denver shift
 *  between standard and daylight time across the year. */
function getTimeZoneOffsetMinutes(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const hour = parts.hour === '24' ? '00' : parts.hour; // Intl can emit 24 for midnight with hour12:false
    const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
    return Math.round((asUTC - date.getTime()) / 60000);
}

/** The real UTC instant corresponding to local midnight, `daysOffset` days
 *  from today, in `timeZone` — e.g. daysOffset 0 = "the start of today in
 *  Denver," correctly accounting for whichever DST offset actually
 *  applies on that date (not a fixed UTC-6/UTC-7 assumption). */
function timeZoneDayBoundary(daysOffset, timeZone) {
    const shifted = new Date(Date.now() + daysOffset * 86400000);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(shifted).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    const utcGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0));
    const offsetMinutes = getTimeZoneOffsetMinutes(utcGuess, timeZone);
    return new Date(utcGuess.getTime() - offsetMinutes * 60000);
}

/** Formats a Date as its own UTC wall-clock reading — "8/24/2026 06:00:00"
 *  — for APIs (like this one) that expect a plain date/time string but
 *  actually interpret it as UTC regardless of what timezone it visually
 *  represents. Pair with timeZoneDayBoundary(): compute the real UTC
 *  instant for local midnight, then render THAT instant's UTC clock
 *  reading, rather than formatting local midnight's own numbers directly
 *  (which would silently send the wrong instant). */
function formatAsUtcClock(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    return `${m}/${d}/${y} ${hh}:${mm}:${ss}`;
}

/**
 * Named computations available to a plugin_table mapping's dynamic_inputs
 * (see renderPluginTablePod) — config names one of these by key, JS
 * supplies the actual logic. Currently just the one this pod needs, but
 * structured as a registry so a future pod needing a different computed
 * input isn't stuck hardcoding it into the fetch loop.
 */
const DYNAMIC_INPUT_COMPUTERS = {
    /** spec: {timezone, days_offset} — start of the day `days_offset` days
     *  from today, in `timezone`, expressed as that instant's UTC clock
     *  reading. See formatAsUtcClock() for why that double-conversion is
     *  necessary rather than just formatting local midnight's own numbers. */
    day_boundary_as_utc_clock: (spec) =>
        formatAsUtcClock(timeZoneDayBoundary(spec.days_offset || 0, spec.timezone || window.timezone || 'UTC')),
};

// =========================================================================
// Pod renderer registry. Every pod in the DOM is a "dumb" shell — it only
// knows its own pod_name (via data-pod-id). loadAndRenderPod() fetches
// that pod's row from dashboard_pods, and dispatches to whichever renderer
// matches source_config.type. Everything about how a pod looks and where
// its data comes from (columns, labels, widths, item lists, PSA mappings)
// lives in source_config — none of it is hardcoded here. Adding a new pod
// type means adding one entry to POD_RENDERERS; adding/editing an actual
// pod (even changing its columns or data) is a dashboard_pods row edit,
// no code change.
// =========================================================================

const POD_RENDERERS = {
    plugin_table: renderPluginTablePod,
    static_list: renderStaticListPod,
    shortcuts: renderShortcutsPod,
    static_grid: renderStaticGridPod,
};

/**
 * Load and render one pod element: fetch its dashboard_pods row, set its
 * title, and hand off to the renderer matching source_config.type.
 * @param {HTMLElement} podEl - the .up-pod element (has data-pod-id)
 */
async function loadAndRenderPod(podEl) {
    const podName = podEl.dataset.podId;
    const titleEl = podEl.querySelector('.up-pod-title');
    const bodyEl = podEl.querySelector('.up-pod-body');
    if (!bodyEl) return;

    bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">Loading\u2026</span></div>`;

    try {
        // base.js populates this at module load — no call/await needed.
        const sessionToken = window.sessionToken;
        // PHASE 2: identity from the session, not localStorage. userId is still
        // threaded through to getDashboardPod/executeSqlQuery below because that
        // helper still validates a truthy `user` argument (which it never
        // transmits); that parameter comes out in the next step.
        const me = await window.getCurrentUser().catch(() => null);
        const userId = me && me.userId;
        if (!sessionToken || !userId) {
            console.warn(`loadAndRenderPod(${podName}): missing session context`, { hasSessionToken: !!sessionToken, userId });
            bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">Unable to load \u2014 not signed in.</span></div>`;
            return;
        }

        const pod = await getDashboardPod(sessionToken, userId, podName);
        if (!pod) {
            bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">Pod not configured.</span></div>`;
            return;
        }
        if (titleEl) titleEl.textContent = pod.display_name || podName;

        const config = pod.source_config || {};
        const renderer = POD_RENDERERS[config.type];
        if (!renderer) {
            bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">Unknown pod type "${escapeHtml(config.type || '')}".</span></div>`;
            return;
        }

        await renderer(bodyEl, config, sessionToken, userId, podEl);
    } catch (error) {
        console.error(`Error loading pod "${podName}":`, error);
        bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">Couldn't load this pod.</span></div>`;
    }
}

// ---------------------------------------------------------------------
// plugin_table renderer — a table backed by a plugin task, once per
// configured stack entry (e.g. Service/Project Tickets via a PSA).
// config shape:
//   { type: 'plugin_table', stack_category: 'PSA',
//     columns: [{key, label, weight, render, default_direction}, ...],
//     sort: [{key, direction: 'asc'|'desc'}, ...],
//     highlight_rules: [{when: [{key, op, value, unit?}, ...], style}, ...],
//     type_mappings: { [type_id]: { task_id, plugin, label, input_map,
//                                    static_inputs, dynamic_inputs,
//                                    field_map, status_class_map } } }
// column.render: 'status_badge' | 'relative_time' | 'clock_time' | omitted
// (plain text). column.key is what field_map's keys must match for that
// column to be populated — a column with no source mapping it just
// renders blank. A field_map value can also be a template string with
// {path} placeholders ('{project.name}: {summary}') to combine multiple
// raw fields into one column — see resolveFieldMapValue().
// column.default_direction ('asc'|'desc', default 'asc') is the direction
// a fresh click on that column's header starts with.
// column.width: 'auto' shrinks that column to fit its own content instead
// of taking a proportional share of the table (see renderColumnsTable) —
// useful for a short fixed-format column (a time, a number) sitting next
// to one that should soak up whatever space is left (e.g. a title).
//
// A mapping's inputs are assembled from three layers, merged in this
// order (later layers win on any overlap, though in practice each
// targets disjoint input names):
//   1. static_inputs  - fixed values, same on every call
//   2. input_map      - {taskInputName: stackEntryField} — pulled from the
//                        user's own stack entry (e.g. their CWM identifier)
//   3. dynamic_inputs  - {taskInputName: {compute, ...spec}} — computed
//                        fresh on every load via DYNAMIC_INPUT_COMPUTERS,
//                        for things static config can't express (e.g.
//                        "today's date window").
// `sort` is the default ordering (multi-key — evaluated in array order,
// each entry breaking ties from the one before it). Clicking a column
// header in the pod overrides it with a single-key sort on that column,
// toggling direction on repeat clicks — that's ephemeral UI state, not
// written back to config, so the pod reverts to the configured default
// sort on next page load.
//
// highlight_rules tints a whole row when it matches. Each rule's `when`
// is a list of conditions ALL of which must pass (AND); rules are tried
// in array order and the first match wins, so put more specific rules
// first. A condition is {key, op, value} — key is a column key, op is one
// of 'gt'/'gte'/'lt'/'lte' (numeric) or 'eq'/'neq'/'contains' (string,
// case-insensitive) — plus an optional `unit` ('minutes'|'hours'|'days')
// for relative_time columns, which turns the comparison into "how long
// ago that timestamp was, in this unit" rather than a raw value compare.
// `style` is one of 'red'/'orange'/'yellow' (see the up-row-highlight-*
// classes in Dashboard.html) — a small named palette rather than
// arbitrary config-supplied colors, for visual consistency with the rest
// of the dashboard.
//
// Single-condition rule = the simple "flag this column past a threshold"
// case (e.g. Age > 30 days); multi-condition rules combine across
// columns (e.g. a specific board AND an age threshold together).
// ---------------------------------------------------------------------

/** A field_map entry is normally a plain dot-path ('board.name'). It can
 *  also be a template string containing one or more {path} placeholders
 *  ('{project.name}: {summary}'), which combines multiple raw fields into
 *  one column's value — each placeholder is resolved via getByPath and
 *  missing values become empty string rather than "undefined". Only
 *  columns using this style produce a string, never a number/date;
 *  combined columns are always treated as plain text (no relative_time/
 *  clock_time render makes sense on a combined value). */
function resolveFieldMapValue(raw, fieldMapping) {
    if (typeof fieldMapping !== 'string') return undefined;
    if (!fieldMapping.includes('{')) return getByPath(raw, fieldMapping);
    return fieldMapping.replace(/\{([^}]+)\}/g, (_, path) => {
        const v = getByPath(raw, path.trim());
        return v != null ? v : '';
    });
}

/** Normalize one raw plugin-task row into a generic {key: value} object
 *  shaped by `columns`, applying each column's `render` transform.
 *  Alongside the display value, every column also gets a `${key}__sort`
 *  entry holding the real underlying value for sorting — a relative-time
 *  column displays "5d" but sorts on the actual timestamp, since sorting
 *  those display strings as text would not put them in chronological
 *  order. */
function normalizeRow(raw, mapping, columns) {
    const fieldMap = mapping.field_map || {};
    const statusMap = mapping.status_class_map || {};
    const row = { __source: mapping.label || '' };
    columns.forEach(col => {
        const value = resolveFieldMapValue(raw, fieldMap[col.key]);
        if (col.render === 'relative_time') {
            row[col.key] = formatRelativeTime(value);
            const parsed = value ? new Date(value).getTime() : NaN;
            row[`${col.key}__sort`] = isNaN(parsed) ? null : parsed;
        } else if (col.render === 'clock_time') {
            row[col.key] = formatClockTime(value);
            const parsed = value ? new Date(value).getTime() : NaN;
            row[`${col.key}__sort`] = isNaN(parsed) ? null : parsed;
        } else if (col.render === 'status_badge') {
            const statusValue = value || '';
            row[col.key] = statusValue;
            row[`${col.key}__class`] = statusMap[statusValue] || statusMap._default || 'status-pending';
            row[`${col.key}__sort`] = statusValue;
        } else {
            row[col.key] = value != null ? String(value) : '';
            row[`${col.key}__sort`] = value != null ? value : '';
        }
    });
    return row;
}

/** Multi-key comparator: walks sortSpec in order, using each entry to
 *  break ties left by the ones before it. Rows missing a sort value
 *  always sort to the end for that key, regardless of direction — a
 *  missing date isn't meaningfully "oldest" or "newest". */
function compareRows(a, b, sortSpec) {
    for (const { key, direction } of sortSpec) {
        const rawA = a[`${key}__sort`];
        const rawB = b[`${key}__sort`];
        const missingA = rawA === null || rawA === undefined || rawA === '';
        const missingB = rawB === null || rawB === undefined || rawB === '';
        if (missingA && missingB) continue;
        if (missingA) return 1;
        if (missingB) return -1;

        const cmp = typeof rawA === 'number' && typeof rawB === 'number'
            ? rawA - rawB
            : String(rawA).localeCompare(String(rawB));
        if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
    }
    return 0;
}

const DURATION_MS = { minutes: 60000, hours: 3600000, days: 86400000 };

function compareValues(a, op, b) {
    switch (op) {
        case 'gt': return Number(a) > Number(b);
        case 'gte': return Number(a) >= Number(b);
        case 'lt': return Number(a) < Number(b);
        case 'lte': return Number(a) <= Number(b);
        case 'eq': return String(a).toLowerCase() === String(b).toLowerCase();
        case 'neq': return String(a).toLowerCase() !== String(b).toLowerCase();
        case 'contains': return String(a).toLowerCase().includes(String(b).toLowerCase());
        default: return false;
    }
}

/** One highlight_rules condition against one row. With `unit` set, the
 *  column's raw __sort value (a timestamp, for relative_time columns) is
 *  converted to "how long ago, in this unit" before comparing — so
 *  {key:'age', op:'gt', value:30, unit:'days'} means the ticket is more
 *  than 30 days old, not that its raw timestamp exceeds 30. */
function evaluateCondition(row, cond) {
    const rawValue = row[`${cond.key}__sort`];
    if (cond.unit) {
        if (rawValue === null || rawValue === undefined) return false;
        const elapsed = (Date.now() - rawValue) / (DURATION_MS[cond.unit] || DURATION_MS.days);
        return compareValues(elapsed, cond.op, cond.value);
    }
    return compareValues(rawValue, cond.op, cond.value);
}

/** First matching rule's `style` wins; rules are checked in config order,
 *  so more specific rules should be listed before more general ones. */
function getRowHighlightStyle(row, rules) {
    for (const rule of rules || []) {
        if ((rule.when || []).every(cond => evaluateCondition(row, cond))) return rule.style;
    }
    return null;
}

function renderRowCell(col, row, allowWrap) {
    // .up-ticket-table td forces white-space:nowrap by default (keeps
    // width:'auto' columns compact and single-line) — but the flexible
    // fill column needs the opposite: without this override, a long title
    // would rather grow the whole table wider than its container than
    // wrap, which is exactly what caused the horizontal scroll this is
    // fixing. Only applied for the fill column in a mixed-width table —
    // see renderColumnsTable.
    const wrapStyle = allowWrap ? ' style="white-space:normal;word-break:break-word"' : '';
    if (col.render === 'status_badge') {
        return `<td${wrapStyle}><span class="status-badge ${escapeHtml(row[`${col.key}__class`])}">${escapeHtml(row[col.key])}</span></td>`;
    }
    return `<td${wrapStyle}>${escapeHtml(row[col.key])}</td>`;
}

/**
 * @param {Array} sortSpec - current sort, used only to show the
 *   active-column indicator arrow on its header.
 * @param {Function} [onHeaderClick] - called with a column's key when its
 *   header is clicked; omit to render plain (non-clickable) headers.
 */
function renderColumnsTable(bodyEl, rows, columns, sortSpec, onHeaderClick, highlightRules) {
    if (!rows.length) {
        bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">No items.</span></div>`;
        return;
    }
    const primarySort = sortSpec && sortSpec[0];

    // A column with width:'auto' shrinks to fit its own content (min
    // width needed) instead of taking a proportional share — the shared
    // .up-ticket-table class defaults to table-layout:fixed, which can't
    // do that (every column needs an explicit width for fixed layout to
    // work at all), so any table using this switches to table-layout:auto
    // instead. Columns without width:'auto' get a 100% width *hint* on
    // their <col>, which under auto layout means "give this one whatever
    // space the auto-fit columns don't need" — the standard technique for
    // a single flexible column alongside shrink-to-fit ones. Cells' own
    // white-space:nowrap (already set by .up-ticket-table td) is what
    // makes the auto-fit columns actually shrink-wrap instead of wrapping.
    const hasAutoWidthColumn = columns.some(c => c.width === 'auto');
    const totalWeight = columns.reduce((sum, c) => sum + (c.weight || 1), 0);
    const tableStyle = hasAutoWidthColumn ? ' style="table-layout:auto"' : '';
    const colgroup = hasAutoWidthColumn
        ? columns.map(c => c.width === 'auto' ? '<col>' : '<col style="width:100%">').join('')
        : columns.map(c => `<col style="width:${((c.weight || 1) / totalWeight * 100).toFixed(2)}%">`).join('');

    bodyEl.innerHTML = `
        <table class="up-ticket-table"${tableStyle}>
            <colgroup>
                ${colgroup}
            </colgroup>
            <thead>
                <tr>${columns.map(c => {
                    const isSorted = primarySort && primarySort.key === c.key;
                    const arrow = isSorted ? (primarySort.direction === 'desc' ? ' \u25bc' : ' \u25b2') : '';
                    const clickable = onHeaderClick ? ' style="cursor:pointer;user-select:none"' : '';
                    return `<th data-sort-key="${escapeHtml(c.key)}"${clickable}>${escapeHtml(c.label)}${arrow}</th>`;
                }).join('')}</tr>
            </thead>
            <tbody>
                ${rows.map(r => {
                    const firstVal = columns.length ? String(r[columns[0].key] ?? '') : '';
                    const highlightStyle = getRowHighlightStyle(r, highlightRules);
                    const rowClass = highlightStyle ? ` class="up-row-highlight-${escapeHtml(highlightStyle)}"` : '';
                    return `
                    <tr${rowClass} title="${escapeHtml(firstVal)}${r.__source ? ' \u00b7 ' + escapeHtml(r.__source) : ''}">
                        ${columns.map(c => renderRowCell(c, r, hasAutoWidthColumn && c.width !== 'auto')).join('')}
                    </tr>
                `;
                }).join('')}
            </tbody>
        </table>
    `;

    if (onHeaderClick) {
        bodyEl.querySelectorAll('th[data-sort-key]').forEach(th => {
            th.addEventListener('click', () => onHeaderClick(th.dataset.sortKey));
        });
    }
}

async function renderPluginTablePod(bodyEl, config, sessionToken, userId) {
    const columns = config.columns || [];

    // PHASE 2: the current user's stack comes from /auth/me rather than
    // getUserStack(token, userId, userId) — a self-lookup that passed the same
    // client-supplied id as both caller and target, and interpolated it into
    // SQL. getUserStack() itself is retained for the Settings case of viewing
    // ANOTHER user's stack, which is a genuine admin lookup.
    const me = await window.getCurrentUser();
    const stack = me.stack || {};
    const stackKey = (config.stack_category || '').toLowerCase();
    const stackEntries = stack[stackKey] || [];
    if (!stackEntries.length) {
        bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">No ${escapeHtml(config.stack_category || 'source')} configured for your account.</span></div>`;
        return;
    }

    const results = await Promise.allSettled(stackEntries.map(async entry => {
        const mapping = config.type_mappings && config.type_mappings[String(entry.type_id)];
        if (!mapping) return []; // no mapping defined yet for this vendor's type_id

        // static_inputs are fixed values sent to every call of this
        // mapping's task, independent of the user's stack entry. input_map
        // values are derived from the stack entry. dynamic_inputs are
        // computed fresh on every load (e.g. "today's date window") via
        // DYNAMIC_INPUT_COMPUTERS — applied last, so it'd win on any
        // overlap, though in practice all three target disjoint input names.
        const inputs = { ...(mapping.static_inputs || {}) };
        Object.entries(mapping.input_map || {}).forEach(([taskInputName, stackField]) => {
            inputs[taskInputName] = entry[stackField];
        });
        // Ensure window.timezone is the real system setting, not the
        // eager-init 'UTC' fallback, before any dynamic_inputs compute
        // function reads it (day_boundary_as_utc_clock in particular).
        if (mapping.dynamic_inputs && Object.keys(mapping.dynamic_inputs).length) {
            await window.getSystemTimezone();
        }
        Object.entries(mapping.dynamic_inputs || {}).forEach(([taskInputName, spec]) => {
            const compute = DYNAMIC_INPUT_COMPUTERS[spec.compute];
            if (compute) inputs[taskInputName] = compute(spec);
            else console.warn(`Unknown dynamic_inputs compute type "${spec.compute}" for input "${taskInputName}"`);
        });

        const response = await executeTask(mapping.task_id, inputs);
        const rows = response.result || [];
        return rows.map(raw => normalizeRow(raw, mapping, columns));
    }));

    const allRows = [];
    results.forEach(r => {
        if (r.status === 'fulfilled') allRows.push(...r.value);
        else console.error('Error fetching plugin_table rows from a configured source:', r.reason);
    });

    // Config's default sort to start; clicking a header replaces it with a
    // single-key sort on that column (toggling direction on repeat
    // clicks), entirely client-side against the already-fetched rows — no
    // re-fetch needed just to re-order what's already on screen.
    let sortSpec = Array.isArray(config.sort) && config.sort.length ? config.sort : [];

    function draw() {
        const sorted = sortSpec.length ? [...allRows].sort((a, b) => compareRows(a, b, sortSpec)) : allRows;
        renderColumnsTable(bodyEl, sorted, columns, sortSpec, onHeaderClick, config.highlight_rules);
    }

    function onHeaderClick(colKey) {
        const current = sortSpec[0];
        if (current && current.key === colKey) {
            sortSpec = [{ key: colKey, direction: current.direction === 'asc' ? 'desc' : 'asc' }];
        } else {
            // First click on a column not currently sorted: use that
            // column's own configured starting direction (default_direction
            // in its columns[] entry), not a hardcoded ascending — e.g.
            // Age might want oldest-first (asc) while Last Touch might
            // want newest-first (desc) as its natural first click.
            const col = columns.find(c => c.key === colKey);
            sortSpec = [{ key: colKey, direction: (col && col.default_direction) || 'asc' }];
        }
        draw();
    }

    draw();
}

// ---------------------------------------------------------------------
// static_list renderer — vertical title/body/time entries (Announcements).
// config shape: { type: 'static_list', items: [{title, body, time}, ...],
//                 editable?: {permission_resource, permission_action} }
// `time` is an ISO date string, formatted relative to now at render time.
//
// `editable` is optional and generic — any pod using static_list gets an
// in-place edit modal for free by adding it, naming whichever permission
// resource/action should gate the Edit button (see checkUserPermission()
// in base.js). Without `editable`, the pod is purely display-only, same
// as before. Saving writes the whole config back to this pod's
// dashboard_pods row via saveDashboardPodConfig() — shared, org-wide
// content, unlike Shortcuts' per-user preferences.
// ---------------------------------------------------------------------

/** Newest first. Items with an unparseable/missing time sort to the end
 *  rather than crashing or floating to the top. */
function sortByDateDesc(items) {
    return [...items].sort((a, b) => {
        const timeA = new Date(a.time).getTime();
        const timeB = new Date(b.time).getTime();
        return (isNaN(timeB) ? -Infinity : timeB) - (isNaN(timeA) ? -Infinity : timeA);
    });
}

function renderStaticListItems(bodyEl, items) {
    if (!items.length) {
        bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">Nothing here yet.</span></div>`;
        return;
    }
    bodyEl.innerHTML = sortByDateDesc(items).map(item => `
        <div style="display:flex;flex-direction:column;gap:3px;padding:12px 4px;border-bottom:1px solid var(--border-primary)">
            <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">
                <span style="font-size:13.5px;font-weight:600;color:var(--text-primary)">${escapeHtml(item.title)}</span>
                <span style="font-size:12px;color:var(--secondary-slate);white-space:nowrap">${escapeHtml(formatNiceDate(item.time))}</span>
            </div>
            <span style="font-size:12.5px;color:var(--secondary-medium)">${escapeHtml(item.body)}</span>
        </div>
    `).join('');
}

/** Same header-injection pattern as Shortcuts' Edit button — see
 *  injectShortcutsEditButton for the draggable/stopPropagation rationale. */
function injectStaticListEditButton(podEl, podName, config, sessionToken, userId, bodyEl) {
    const header = podEl.querySelector('.up-pod-header');
    if (!header || header.querySelector('.up-static-list-edit-btn')) return;

    const titleEl = header.querySelector('.up-pod-title');
    const displayName = (titleEl && titleEl.textContent) || podName;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn up-static-list-edit-btn';
    btn.dataset.size = 'sm';
    btn.dataset.color = 'theme-slate';
    btn.textContent = 'Edit';
    btn.draggable = false;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
        e.stopPropagation();
        openStaticListEditor(podName, displayName, config, sessionToken, userId, bodyEl);
    });
    header.appendChild(btn);
}

/**
 * Single-list editor: add/edit/remove items directly (title + body text
 * fields). Display is always sorted newest-first (see sortByDateDesc),
 * both here and on the pod itself, so there's no manual reordering — new
 * items get the current time and simply sort to the top. Editing an
 * existing item's text leaves its original time alone.
 */
async function openStaticListEditor(podName, displayName, config, sessionToken, userId, bodyEl) {
    // Kept pre-sorted (newest first) at all times, matching the pod's own
    // display order — see sortByDateDesc(). Manual reordering was removed
    // since the pod always displays by date regardless of saved order, so
    // dragging to reorder would have had no visible effect.
    let items = sortByDateDesc((config.items || []).map(item => ({ ...item })));

    const container = document.createElement('div');
    container.innerHTML = `
        <div id="staticListEditorItems" class="custom-scrollbar" style="display:flex;flex-direction:column;gap:8px;max-height:420px;overflow-y:auto;padding-right:4px"></div>
        <button type="button" class="btn" data-size="sm" data-color="theme-brand" id="staticListEditorAddBtn" style="margin-top:10px">+ Add</button>
    `;
    const listEl = container.querySelector('#staticListEditorItems');
    const addBtn = container.querySelector('#staticListEditorAddBtn');

    function renderItems() {
        if (!items.length) {
            listEl.innerHTML = `<div style="padding:16px;text-align:center;color:var(--secondary-slate);font-size:12.5px">Nothing here yet \u2014 click "+ Add" to create one.</div>`;
            return;
        }
        listEl.innerHTML = items.map((item, i) => `
            <div class="up-editor-item" data-index="${i}"
                 style="display:flex;gap:8px;padding:10px;border-radius:6px;background:var(--bg-panel3)">
                <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
                    <input type="text" data-field="title" data-index="${i}" value="${escapeHtml(item.title || '')}" placeholder="Title">
                    <textarea data-field="body" data-index="${i}" placeholder="Body" rows="2">${escapeHtml(item.body || '')}</textarea>
                </div>
                <span class="up-editor-remove" data-index="${i}" title="Remove" style="cursor:pointer;color:var(--secondary-slate);font-size:18px;line-height:1;flex-shrink:0">&times;</span>
            </div>
        `).join('');
    }

    // Editing title/body writes straight into the items array as the
    // person types — no separate "commit" step needed before Save.
    listEl.addEventListener('input', e => {
        const field = e.target.dataset.field;
        const index = Number(e.target.dataset.index);
        if (field && items[index]) items[index][field] = e.target.value;
    });

    listEl.addEventListener('click', e => {
        const removeEl = e.target.closest('.up-editor-remove');
        if (!removeEl) return;
        items.splice(Number(removeEl.dataset.index), 1);
        renderItems();
    });

    addBtn.addEventListener('click', () => {
        items.push({ title: '', body: '', time: new Date().toISOString() });
        items = sortByDateDesc(items); // new item's "now" timestamp puts it first
        renderItems();
    });

    renderItems();

    showModal({
        title: `Edit ${displayName}`,
        content: container,
        width: '520px',
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Save',
                type: 'success',
                onClick: async () => {
                    const cleaned = items
                        .map(item => ({
                            title: (item.title || '').trim(),
                            body: (item.body || '').trim(),
                            time: item.time || new Date().toISOString(),
                        }))
                        .filter(item => item.title || item.body);
                    const newConfig = { ...config, items: cleaned };
                    await saveDashboardPodConfig(sessionToken, userId, podName, newConfig);
                    renderStaticListItems(bodyEl, cleaned);
                },
            },
        ],
    });
}

async function renderStaticListPod(bodyEl, config, sessionToken, userId, podEl) {
    if (config.editable && podEl) {
        const canEdit = await checkUserPermission({
            resource: config.editable.permission_resource,
            action: config.editable.permission_action || 'edit',
        });
        if (canEdit) {
            injectStaticListEditButton(podEl, podEl.dataset.podId, config, sessionToken, userId, bodyEl);
        }
    }
    renderStaticListItems(bodyEl, config.items || []);
}

// ---------------------------------------------------------------------
// shortcuts renderer — purpose-built pod type, not a generic static list,
// because unlike Announcements this is genuinely per-user: what a person
// sees is read from (and edited into) kore_sys.users.preferences (under a
// 'shortcuts' key), keyed on their own userId. With nothing saved there
// yet (the default for every user right now), the pod correctly shows no
// shortcuts until they add some via the Edit button.
//
// config shape: { type: 'shortcuts',
//                 type_labels: {form: 'Form', datatable: 'Table'},
//                 badge_class_map: {form: 'status-running', datatable: 'status-warning', _default} }
// preferences.shortcuts shape: [{resourceId, type, label}, ...], in the
// user's chosen order.
// ---------------------------------------------------------------------

/** Minimal SQL-string escaping matching this codebase's existing
 *  convention elsewhere (see getDashboardPod) — extended to also escape
 *  backslashes, since prefs is a JSON blob that can genuinely contain them
 *  (e.g. inside an already-escaped quote), unlike the simple identifiers
 *  the existing convention was originally written for. */
function sqlEscape(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/** Fetch the CURRENT user's preferences blob.
 *
 *  PHASE 2: reads from /auth/me rather than
 *  `SELECT preferences FROM users WHERE userId = '<localStorage value>'`.
 *  The userId parameter is retained for call compatibility but ignored — it
 *  was always the current user in practice, and taking it from the client
 *  meant the browser chose whose preferences to read.
 *
 *  Dashboard keys ('dashboard_layout', 'shortcuts') live alongside
 *  'notifications' in the same blob; there is no standalone user_prefs table.
 *  A user row always exists, but preferences itself may be NULL if nothing has
 *  ever been saved — that's just {}, not an error. */
async function getUserPrefs(sessionToken, userId) {
    try {
        const user = await window.getCurrentUser();
        return user.preferences || {};
    } catch (error) {
        console.error('Error fetching user prefs:', error);
        return {};
    }
}

/** Set one top-level key in the CURRENT user's preferences blob.
 *
 *  PHASE 2: goes through PUT /auth/me/preferences, which merges server-side
 *  with JSON_MERGE_PATCH. This preserves the property the previous JSON_SET
 *  version was written for — only the given key is touched, so a dashboard
 *  layout save and a concurrent notification-prefs save can't clobber each
 *  other — while also removing the client's ability to choose WHOSE
 *  preferences get written. The old statement ended
 *  `WHERE userId = '<localStorage value>'`, so any user could edit anyone's.
 *
 *  MERGE_PATCH replaces the value at the given key rather than deep-merging
 *  into it, which is what an array like dashboard_layout needs — a
 *  deep merge would append rather than overwrite. */
async function saveUserPrefsKey(sessionToken, userId, key, value) {
    const response = await fetch('/auth/me/preferences', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value })
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Failed to save preferences: HTTP ${response.status}`);
    }

    // The cached /auth/me copy is now stale — the next read of any preference
    // key must reflect what was just written, not the value from page load.
    if (typeof window.getCurrentUser === 'function') {
        await window.getCurrentUser(true);
    }
}

/** Persist a full source_config back to a pod's dashboard_pods row.
 *  Distinct from saveUserPrefsKey above: this is shared, org-wide config
 *  (e.g. a permitted user editing Announcements' content), not a per-user
 *  preference — generic across any pod type an editor writes back to. */
async function saveDashboardPodConfig(sessionToken, userId, podName, config) {
    const name = sqlEscape(podName);
    const json = sqlEscape(JSON.stringify(config));
    const sql = `UPDATE dashboard_pods SET source_config = '${json}' WHERE pod_name = '${name}'`;
    await executeSqlQuery(sessionToken, userId, 'kore_sys', sql);
}

async function getUserShortcutItems(sessionToken, userId, config) {
    const prefs = await getUserPrefs(sessionToken, userId);
    const saved = Array.isArray(prefs.shortcuts) ? prefs.shortcuts : [];
    const typeLabels = config.type_labels || {};
    return saved.map(s => ({
        resourceId: s.resourceId,
        type: s.type,
        label: s.label,
        path: s.path || '',
        badgeLabel: typeLabels[s.type] || s.type,
    }));
}

/** Same route convention user-portal.js's private _userPortalItemHref()
 *  uses for these two resource types — duplicated here in miniature
 *  (rather than importing a function that module doesn't export) since
 *  it's two lines and unlikely to drift. */
function shortcutItemHref(item) {
    if (item.type === 'form') return `/form?form_id=${encodeURIComponent(item.resourceId)}`;
    if (item.type === 'datatable') return `/datatable?id=${encodeURIComponent(item.resourceId)}`;
    return '#';
}

/** Recursively flatten a user-menus tree (see getUserPortalMenus() in
 *  user-portal.js) into a flat list of leaf form/datatable items — the
 *  permission-filtered universe of everything a user could add as a
 *  shortcut. `path` is the joined chain of ancestor category labels
 *  (e.g. 'Techs\Automation'), for display alongside each item's name. */
function flattenMenuItems(nodes, ancestry = []) {
    const items = [];
    (nodes || []).forEach(node => {
        const nodePath = [...ancestry, node.label];
        (node.items || []).forEach(item => {
            if (item.type === 'form' || item.type === 'datatable') {
                items.push({ label: item.label, type: item.type, resourceId: item.resourceId, path: nodePath.join('\\') });
            }
        });
        if (node.children && node.children.length) {
            items.push(...flattenMenuItems(node.children, nodePath));
        }
    });
    return items;
}

async function renderShortcutsList(bodyEl, config, sessionToken, userId) {
    const items = await getUserShortcutItems(sessionToken, userId, config);
    if (!items.length) {
        bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">No shortcuts yet \u2014 click Edit to add some.</span></div>`;
        return;
    }
    const badgeMap = config.badge_class_map || {};
    bodyEl.innerHTML = items.map(item => {
        const badgeClass = badgeMap[item.type] || badgeMap._default || 'status-pending';
        return `
            <a href="${escapeHtml(shortcutItemHref(item))}" class="up-pod-row up-shortcut-row" style="text-decoration:none;color:inherit">
                <div style="display:flex;flex-direction:column;gap:2px;min-width:0;overflow:hidden">
                    <span class="up-pod-row-title">${escapeHtml(item.label)}</span>
                    ${item.path ? `<span style="font-size:9.5px;color:var(--secondary-slate);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.path)}</span>` : ''}
                </div>
                <span class="status-badge ${escapeHtml(badgeClass)}" style="flex-shrink:0">${escapeHtml(item.badgeLabel)}</span>
            </a>
        `;
    }).join('');
}

/** Adds the "Edit" button to this pod's header, right-justified via the
 *  header's existing justify-content:space-between. Guarded against
 *  double-injection in case this pod is ever re-rendered without a full
 *  page reload. draggable=false + stopPropagation on mousedown/click keep
 *  clicking it from being swallowed by the header's own drag-to-reposition
 *  handling when dashboard Edit Layout mode is active. */
function injectShortcutsEditButton(podEl, config, sessionToken, userId, bodyEl) {
    const header = podEl.querySelector('.up-pod-header');
    if (!header || header.querySelector('.up-shortcuts-edit-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn up-shortcuts-edit-btn';
    btn.dataset.size = 'sm';
    btn.dataset.color = 'theme-slate';
    btn.textContent = 'Edit';
    btn.draggable = false;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
        e.stopPropagation();
        openShortcutsEditor(config, sessionToken, userId, bodyEl);
    });
    header.appendChild(btn);
}

/**
 * Two-panel drag-and-drop editor: left is the user's current shortcuts
 * (reorderable, removable), right is everything they have access to
 * (every form/datatable from their permission-filtered menu tree),
 * draggable into the left panel to add. Save persists to user preferences
 * and refreshes the pod; Cancel discards.
 */
async function openShortcutsEditor(config, sessionToken, userId, bodyEl) {
    const [prefs, menuTree] = await Promise.all([
        getUserPrefs(sessionToken, userId),
        window.getUserPortalMenus(),
    ]);
    const typeLabels = config.type_labels || {};
    const badgeMap = config.badge_class_map || {};

    let currentItems = (Array.isArray(prefs.shortcuts) ? prefs.shortcuts : []).slice();
    const availableItems = flattenMenuItems(menuTree).sort((a, b) => a.label.localeCompare(b.label));
    const itemKey = item => `${item.type}:${item.resourceId}`;

    const container = document.createElement('div');
    container.innerHTML = `
        <div style="display:flex;gap:16px;height:420px">
            <div style="flex:1;display:flex;flex-direction:column;min-width:0">
                <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:var(--secondary-slate);margin-bottom:8px">Your Shortcuts</div>
                <div id="shortcutsEditorCurrent" class="panel-level-2 custom-scrollbar" style="flex:1;overflow-y:auto;padding:6px"></div>
            </div>
            <div style="flex:1;display:flex;flex-direction:column;min-width:0">
                <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:var(--secondary-slate);margin-bottom:8px">Available Forms &amp; Tables</div>
                <input type="text" id="shortcutsEditorFilter" placeholder="Filter\u2026" style="margin-bottom:6px">
                <div id="shortcutsEditorAvailable" class="panel-level-2 custom-scrollbar" style="flex:1;overflow-y:auto;padding:6px"></div>
            </div>
        </div>
    `;

    const currentListEl = container.querySelector('#shortcutsEditorCurrent');
    const availableListEl = container.querySelector('#shortcutsEditorAvailable');
    const filterEl = container.querySelector('#shortcutsEditorFilter');

    function renderCurrentList() {
        if (!currentItems.length) {
            currentListEl.innerHTML = `<div style="padding:16px;text-align:center;color:var(--secondary-slate);font-size:12.5px">Drag items here from the right</div>`;
            return;
        }
        currentListEl.innerHTML = currentItems.map((item, i) => `
            <div class="up-editor-item" draggable="true" data-index="${i}" data-source="current"
                 style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg-panel3);cursor:grab;margin-bottom:4px">
                <div style="display:flex;flex-direction:column;gap:2px;min-width:0;overflow:hidden">
                    <span style="font-size:13px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.label)}</span>
                    ${item.path ? `<span style="font-size:10.5px;color:var(--secondary-slate);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.path)}</span>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                    <span class="status-badge ${escapeHtml(badgeMap[item.type] || badgeMap._default || 'status-pending')}">${escapeHtml(typeLabels[item.type] || item.type)}</span>
                    <span class="up-editor-remove" data-index="${i}" title="Remove" style="cursor:pointer;color:var(--secondary-slate);font-size:16px;line-height:1">&times;</span>
                </div>
            </div>
        `).join('');
    }

    function renderAvailableList(filterText) {
        const needle = (filterText || '').toLowerCase();
        const filtered = availableItems.filter(item => !needle || item.label.toLowerCase().includes(needle));
        if (!filtered.length) {
            availableListEl.innerHTML = `<div style="padding:16px;text-align:center;color:var(--secondary-slate);font-size:12.5px">No matches</div>`;
            return;
        }
        availableListEl.innerHTML = filtered.map(item => {
            const alreadyAdded = currentItems.some(c => itemKey(c) === itemKey(item));
            return `
                <div class="up-editor-item" draggable="${!alreadyAdded}" data-key="${escapeHtml(itemKey(item))}" data-source="available"
                     style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg-panel3);cursor:${alreadyAdded ? 'default' : 'grab'};margin-bottom:4px;opacity:${alreadyAdded ? 0.4 : 1}">
                    <div style="display:flex;flex-direction:column;gap:2px;min-width:0;overflow:hidden">
                        <span style="font-size:13px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.label)}</span>
                        ${item.path ? `<span style="font-size:10.5px;color:var(--secondary-slate);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.path)}</span>` : ''}
                    </div>
                    <span class="status-badge ${escapeHtml(badgeMap[item.type] || badgeMap._default || 'status-pending')}" style="flex-shrink:0">${escapeHtml(typeLabels[item.type] || item.type)}</span>
                </div>
            `;
        }).join('');
    }

    // Reordering within the current list, and adding from the available
    // list, both land here — payload.source tells them apart.
    currentListEl.addEventListener('dragstart', e => {
        const el = e.target.closest('.up-editor-item[data-source="current"]');
        if (!el) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'current', index: Number(el.dataset.index) }));
    });
    availableListEl.addEventListener('dragstart', e => {
        const el = e.target.closest('.up-editor-item[data-source="available"]');
        if (!el || el.draggable === false) return;
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'available', key: el.dataset.key }));
    });
    currentListEl.addEventListener('dragover', e => e.preventDefault());
    currentListEl.addEventListener('drop', e => {
        e.preventDefault();
        let payload;
        try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }

        // Drop position: first existing row whose vertical midpoint is
        // below the cursor, else append to the end.
        const rows = [...currentListEl.querySelectorAll('.up-editor-item[data-source="current"]')];
        let dropIndex = rows.length;
        for (let i = 0; i < rows.length; i++) {
            const rect = rows[i].getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) { dropIndex = i; break; }
        }

        if (payload.source === 'available') {
            const item = availableItems.find(a => itemKey(a) === payload.key);
            if (!item || currentItems.some(c => itemKey(c) === itemKey(item))) return;
            currentItems.splice(dropIndex, 0, { resourceId: item.resourceId, type: item.type, label: item.label, path: item.path });
        } else if (payload.source === 'current') {
            const [moved] = currentItems.splice(payload.index, 1);
            currentItems.splice(payload.index < dropIndex ? dropIndex - 1 : dropIndex, 0, moved);
        }
        renderCurrentList();
        renderAvailableList(filterEl.value);
    });

    currentListEl.addEventListener('click', e => {
        const removeEl = e.target.closest('.up-editor-remove');
        if (!removeEl) return;
        currentItems.splice(Number(removeEl.dataset.index), 1);
        renderCurrentList();
        renderAvailableList(filterEl.value);
    });

    filterEl.addEventListener('input', () => renderAvailableList(filterEl.value));

    renderCurrentList();
    renderAvailableList('');

    window.showModal({
        title: 'Edit Shortcuts',
        content: container,
        width: '640px',
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Save',
                type: 'success',
                onClick: async () => {
                    await saveUserPrefsKey(sessionToken, userId, 'shortcuts', currentItems);
                    await renderShortcutsList(bodyEl, config, sessionToken, userId);
                },
            },
        ],
    });
}

async function renderShortcutsPod(bodyEl, config, sessionToken, userId, podEl) {
    if (podEl) injectShortcutsEditButton(podEl, config, sessionToken, userId, bodyEl);
    await renderShortcutsList(bodyEl, config, sessionToken, userId);
}

// ---------------------------------------------------------------------
// static_grid renderer — icon tiles, 2 per row (Shortcuts).
// config shape: { type: 'static_grid', items: [{name, type, iconBg}, ...] }
// iconBg is a raw CSS color/var() value from an admin-controlled config
// row, not user input — interpolated as-is, same trust boundary as the
// rest of dashboard_pods.
// ---------------------------------------------------------------------

function renderStaticGridPod(bodyEl, config) {
    const items = config.items || [];
    if (!items.length) {
        bodyEl.innerHTML = `<div class="up-pod-row"><span class="up-pod-row-sub">No shortcuts configured.</span></div>`;
        return;
    }
    bodyEl.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            ${items.map(item => `
                <div class="panel-level-2" style="gap:8px">
                    <div style="width:28px;height:28px;border-radius:7px;background:${item.iconBg || 'var(--brand-light)'}"></div>
                    <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${escapeHtml(item.name)}</span>
                    <span style="font-size:11px;color:var(--secondary-slate)">${escapeHtml(item.type)}</span>
                </div>
            `).join('')}
        </div>
    `;
}

// Load every pod in the DOM. Placed after the user-portal.js import above
// so escapeHtml() (from base.js, loaded transitively) is guaranteed
// available. Each pod is fully self-describing via its data-pod-id +
// dashboard_pods row, so this loop is the only thing that needs to know
// which pods exist on this page — no per-pod call site to maintain.
document.querySelectorAll('.up-pod[data-pod-id]').forEach(loadAndRenderPod);

// -----------------------------------------------------------------------
// Pod framework: pods sit at an explicit (col-start, row-start) cell in a
// 6-column grid with fixed 40px row tracks, sized by (col-span, row-span).
// Dragging drops a pod on any cell; if that lands on top of another pod,
// the collision resolver pushes the occupant right (if the grid has room)
// or down (otherwise), cascading as needed. Resizing works the same way —
// grow a pod and anything it now overlaps gets pushed. Layout is
// persisted per-account (kore_sys.users.preferences). Pod content stays
// owned by the render*() functions above; this section is layout only.
// -----------------------------------------------------------------------

const TOTAL_COLS = 6;
const ROW_HEIGHT = 40; // px, must match grid-auto-rows in the CSS
const MIN_COL_SPAN = 1;
const MAX_COL_SPAN = TOTAL_COLS;
const MIN_ROW_SPAN = 1;

const podGrid = document.getElementById('upPodGrid');
const editBtn = document.getElementById('upDashEditBtn');
const saveBtn = document.getElementById('upDashSaveBtn');
const cancelBtn = document.getElementById('upDashCancelBtn');

let editMode = false;
let preEditSnapshot = null; // layout captured when Edit is pressed, restored on Cancel

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

function readPodState(pod) {
    return {
        id: pod.dataset.podId,
        colStart: parseInt(pod.style.getPropertyValue('--pod-col-start'), 10) || 1,
        colSpan: parseInt(pod.style.getPropertyValue('--pod-col-span'), 10) || 1,
        rowStart: parseInt(pod.style.getPropertyValue('--pod-row-start'), 10) || 1,
        rowSpan: parseInt(pod.style.getPropertyValue('--pod-row-span'), 10) || 6,
    };
}

function writePodState(pod, state) {
    pod.style.setProperty('--pod-col-start', state.colStart);
    pod.style.setProperty('--pod-col-span', state.colSpan);
    pod.style.setProperty('--pod-row-start', state.rowStart);
    pod.style.setProperty('--pod-row-span', state.rowSpan);
}

function getCurrentLayout() {
    return [...podGrid.querySelectorAll('.up-pod')].map(readPodState);
}

function rectsOverlap(a, b) {
    return a.colStart < b.colStart + b.colSpan &&
        a.colStart + a.colSpan > b.colStart &&
        a.rowStart < b.rowStart + b.rowSpan &&
        a.rowStart + a.rowSpan > b.rowStart;
}

/**
 * After `movedId` has been placed at its new rect, push any pod that now
 * overlaps it out of the way: to the right if there's room left in the
 * 4-column grid, otherwise straight down. A pushed pod can in turn
 * displace another, so this settles pods one at a time and repeats until
 * nothing overlaps (or a safety cap is hit).
 */
function resolveCollisions(movedId, podEls) {
    const states = new Map(podEls.map(p => [p.dataset.podId, readPodState(p)]));
    const settled = new Set([movedId]);
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 50) {
        changed = false;
        iterations++;
        for (const [id, state] of states) {
            if (settled.has(id)) continue;
            const collider = [...settled].map(sid => states.get(sid)).find(s => rectsOverlap(state, s));
            if (!collider) continue;
            const rightStart = collider.colStart + collider.colSpan;
            if (rightStart + state.colSpan - 1 <= TOTAL_COLS) {
                state.colStart = rightStart;
                state.rowStart = collider.rowStart;
            } else {
                state.rowStart = collider.rowStart + collider.rowSpan;
                state.colStart = clamp(state.colStart, 1, TOTAL_COLS - state.colSpan + 1);
            }
            settled.add(id);
            changed = true;
        }
    }
    podEls.forEach(pod => writePodState(pod, states.get(pod.dataset.podId)));
}

/** Keep DOM/tab order sane (top-to-bottom, left-to-right) after a layout change. */
function reorderDomForTabOrder() {
    const pods = [...podGrid.querySelectorAll('.up-pod')];
    pods.sort((a, b) => {
        const sa = readPodState(a), sb = readPodState(b);
        return sa.rowStart - sb.rowStart || sa.colStart - sb.colStart;
    });
    pods.forEach(p => podGrid.appendChild(p));
}

/**
 * Persistence: kore_sys.users.preferences — the same column Settings'
 * notification prefs (base.js) and Shortcuts (above) already use, each
 * under their own top-level key ('dashboard_layout' here), so saving one
 * never touches another. See saveUserPrefsKey() for why this is a direct
 * atomic key write rather than fetch-mutate-write-whole-blob.
 */
async function saveUserDashboardLayout(layout) {
    const sessionToken = window.sessionToken;
    const me = await window.getCurrentUser().catch(() => null);
    const userId = me && me.userId;
    if (!sessionToken || !userId) {
        console.warn('saveUserDashboardLayout: missing session context, layout not saved');
        return;
    }
    try {
        await saveUserPrefsKey(sessionToken, userId, 'dashboard_layout', layout);
    } catch (e) {
        console.error('Could not save dashboard layout:', e);
    }
}

async function loadUserDashboardLayout() {
    const sessionToken = window.sessionToken;
    const me = await window.getCurrentUser().catch(() => null);
    const userId = me && me.userId;
    if (!sessionToken || !userId) return null;
    try {
        const prefs = await getUserPrefs(sessionToken, userId);
        return Array.isArray(prefs.dashboard_layout) ? prefs.dashboard_layout : null;
    } catch (e) {
        console.error('Could not load dashboard layout:', e);
        return null;
    }
}

function applyLayout(layout) {
    if (!Array.isArray(layout) || !layout.length) return;
    const pods = new Map([...podGrid.querySelectorAll('.up-pod')].map(p => [p.dataset.podId, p]));
    layout.forEach(entry => {
        const pod = pods.get(entry.id);
        if (!pod) return;
        const colSpan = clamp(entry.colSpan || 1, MIN_COL_SPAN, MAX_COL_SPAN);
        writePodState(pod, {
            colSpan,
            colStart: clamp(entry.colStart || 1, 1, TOTAL_COLS - colSpan + 1),
            rowSpan: clamp(entry.rowSpan || 6, MIN_ROW_SPAN, 999),
            rowStart: clamp(entry.rowStart || 1, MIN_ROW_SPAN, 999),
        });
    });
    reorderDomForTabOrder();
}

// ---------------------------------------------------------------------
// Edit mode: locked by default. Edit unlocks drag/resize; Save commits
// the current arrangement to storage; Cancel reverts to the arrangement
// that was in place when Edit was pressed.
// ---------------------------------------------------------------------

/**
 * Cosmetic-only: lets whichever pod(s) sit at the very bottom of the
 * current layout stretch down to fill leftover viewport space, instead of
 * stopping at their configured rowSpan and leaving empty room below.
 *
 * Never touches saved layout data or the pixel-based drag/resize/
 * collision math (pointToCell, onResizeStart, etc.) — those keep treating
 * the grid as a uniform fixed-ROW_HEIGHT grid exactly as before. This
 * only changes how the *last* row track renders: grid-template-rows gets
 * an explicit list of fixed ROW_HEIGHT tracks for every row actually
 * used, except the final one, which becomes minmax(ROW_HEIGHT, 1fr).
 * Whichever pod(s) end exactly on that last row get grid-row-end: -1, so
 * their bottom follows the flexible track's real size. Once set, the
 * browser's own layout engine handles viewport/window resizing on its
 * own — minmax(...,1fr) naturally reflows — so this only needs to be
 * recomputed when the *layout itself* changes (load, save, cancel), not
 * on every resize event.
 *
 * Only applied outside edit mode (see setEditMode) — while actively
 * dragging/resizing, pods show their true configured size so snapping
 * stays honest, not a visually-inflated one.
 */
function applyBottomStretch() {
    const pods = [...podGrid.querySelectorAll('.up-pod')];
    podGrid.querySelectorAll('.up-pod-stretch-bottom').forEach(p => p.classList.remove('up-pod-stretch-bottom'));

    if (!pods.length) {
        podGrid.style.gridTemplateRows = '';
        podGrid.classList.remove('up-stretch-bottom-active');
        return;
    }

    const states = pods.map(readPodState);
    const maxBottom = Math.max(...states.map(s => s.rowStart + s.rowSpan - 1));
    const fixedTracks = Math.max(maxBottom - 1, 0);

    podGrid.style.gridTemplateRows = `repeat(${fixedTracks}, ${ROW_HEIGHT}px) minmax(${ROW_HEIGHT}px, 1fr)`;
    states.forEach((state, i) => {
        if (state.rowStart + state.rowSpan - 1 === maxBottom) {
            pods[i].classList.add('up-pod-stretch-bottom');
        }
    });
    podGrid.classList.add('up-stretch-bottom-active');
}

function setEditMode(on) {
    editMode = on;
    podGrid.classList.toggle('up-edit-mode', on);
    podGrid.querySelectorAll('.up-pod-header').forEach(h => { h.draggable = on; });
    editBtn.hidden = on;
    saveBtn.hidden = !on;
    cancelBtn.hidden = !on;

    if (on) {
        podGrid.style.gridTemplateRows = '';
        podGrid.classList.remove('up-stretch-bottom-active');
        podGrid.querySelectorAll('.up-pod-stretch-bottom').forEach(p => p.classList.remove('up-pod-stretch-bottom'));
    } else {
        applyBottomStretch();
    }
}

function enterEditMode() {
    preEditSnapshot = getCurrentLayout();
    setEditMode(true);
}

async function saveEdits() {
    await saveUserDashboardLayout(getCurrentLayout());
    setEditMode(false);
}

function cancelEdits() {
    if (preEditSnapshot) applyLayout(preEditSnapshot);
    preEditSnapshot = null;
    setEditMode(false);
}

editBtn?.addEventListener('click', enterEditMode);
saveBtn?.addEventListener('click', saveEdits);
cancelBtn?.addEventListener('click', cancelEdits);

// ---------------------------------------------------------------------
// Drag to reposition — drop anywhere on the grid, not just on a pod.
// Only active while editMode is true (headers are only draggable then).
// ---------------------------------------------------------------------

function initDragReorder() {
    podGrid.querySelectorAll('.up-pod-header').forEach(header => {
        header.addEventListener('dragstart', onDragStart);
        header.addEventListener('dragend', onDragEnd);
    });
    podGrid.addEventListener('dragover', onGridDragOver);
    podGrid.addEventListener('drop', onGridDrop);
}

function onDragStart(e) {
    if (!editMode) return;
    const pod = e.currentTarget.closest('.up-pod');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', pod.dataset.podId);
    pod.classList.add('up-pod-dragging');
}

function onGridDragOver(e) {
    if (!editMode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    podGrid.classList.add('up-grid-drag-over');
}

function onGridDrop(e) {
    if (!editMode) return;
    e.preventDefault();
    podGrid.classList.remove('up-grid-drag-over');

    const draggedId = e.dataTransfer.getData('text/plain');
    const draggedPod = podGrid.querySelector(`.up-pod[data-pod-id="${CSS.escape(draggedId)}"]`);
    if (!draggedPod) return;

    const state = readPodState(draggedPod);
    const cell = pointToCell(e.clientX, e.clientY, state.colSpan);
    state.colStart = cell.col;
    state.rowStart = cell.row;
    writePodState(draggedPod, state);

    resolveCollisions(draggedId, [...podGrid.querySelectorAll('.up-pod')]);
    reorderDomForTabOrder();
    // No persistence here — changes stay in-session until Save is pressed.
}

function onDragEnd() {
    podGrid.querySelectorAll('.up-pod-dragging').forEach(p => p.classList.remove('up-pod-dragging'));
    podGrid.classList.remove('up-grid-drag-over');
}

/** Convert a viewport point to a (1-based) grid cell, clamped so a pod of
 *  the given column span stays fully inside the 4-column track. */
function pointToCell(clientX, clientY, colSpan) {
    const gridRect = podGrid.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(podGrid).columnGap) || 0;
    const colWidth = (gridRect.width - gap * (TOTAL_COLS - 1)) / TOTAL_COLS;
    const col = clamp(Math.floor((clientX - gridRect.left) / (colWidth + gap)) + 1, 1, TOTAL_COLS - colSpan + 1);
    const row = clamp(Math.floor((clientY - gridRect.top) / (ROW_HEIGHT + gap)) + 1, 1, 999);
    return { col, row };
}

// ---------------------------------------------------------------------
// Drag to resize (bottom-right handle) — column span snaps to grid
// columns, row span snaps to 100px rows; overlaps get pushed just like a
// reposition does. Handles are only interactive while editMode is true
// (gated in CSS via .up-edit-mode).
// ---------------------------------------------------------------------

function initResize() {
    podGrid.querySelectorAll('.up-pod-resize-handle').forEach(handle => {
        handle.addEventListener('pointerdown', onResizeStart);
    });
}

function onResizeStart(e) {
    if (!editMode) return;
    e.preventDefault();
    const pod = e.currentTarget.closest('.up-pod');
    pod.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const start = readPodState(pod);

    const gridRect = podGrid.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(podGrid).columnGap) || 0;
    const colWidth = (gridRect.width - gap * (TOTAL_COLS - 1)) / TOTAL_COLS;
    const maxColSpanHere = TOTAL_COLS - start.colStart + 1;

    function onMove(moveEvent) {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        const deltaCols = Math.round(deltaX / (colWidth + gap));
        const deltaRows = Math.round(deltaY / (ROW_HEIGHT + gap));
        const newColSpan = clamp(start.colSpan + deltaCols, MIN_COL_SPAN, maxColSpanHere);
        const newRowSpan = clamp(start.rowSpan + deltaRows, MIN_ROW_SPAN, 999);
        pod.style.setProperty('--pod-col-span', newColSpan);
        pod.style.setProperty('--pod-row-span', newRowSpan);
    }

    function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        resolveCollisions(pod.dataset.podId, [...podGrid.querySelectorAll('.up-pod')]);
        reorderDomForTabOrder();
        // No persistence here — changes stay in-session until Save is pressed.
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
}

/** Applied when a user has no saved dashboard_layout yet in preferences
 *  (loadUserDashboardLayout() returns null for them). Same shape as what
 *  saveUserDashboardLayout() writes, so it's a normal, editable starting
 *  point — not special-cased anywhere else in the layout code. */
const DEFAULT_DASHBOARD_LAYOUT = [
    { id: 'shortcuts', colSpan: 2, rowSpan: 3, colStart: 1, rowStart: 1 },
    { id: 'announcements', colSpan: 2, rowSpan: 3, colStart: 3, rowStart: 1 },
    { id: 'user_calendar', colSpan: 2, rowSpan: 3, colStart: 5, rowStart: 1 },
    { id: 'service_tickets', colSpan: 3, rowSpan: 6, colStart: 1, rowStart: 4 },
    { id: 'project_tickets', colSpan: 3, rowSpan: 6, colStart: 4, rowStart: 4 },
];

if (podGrid) {
    applyLayout((await loadUserDashboardLayout()) || DEFAULT_DASHBOARD_LAYOUT);
    initDragReorder();
    initResize();
    applyBottomStretch();
}