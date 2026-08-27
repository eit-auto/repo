import '/lib/base.js';

// ============================================
// Datatable Builder - Main JavaScript File
// ============================================
// Mirrors the conventions used by form-builder.js: shared unsaved-changes
// tracking, showStatusBanner/showModal from base.js, and the same
// GET/PUT resource pattern used against /kore/<resource>/:id.
//
// Adapted from the legacy Rewst-based "DataTable Config Builder": the
// permission model here is the generic user/group system shared by every
// Kore resource (view/create/update/delete via /kore/permissions) rather
// than the old 4-role-multiselect setup. "SQL Mode" (any configured
// datasource, not just MySQL) re-implements the old ProxyLib schema
// discovery using the generic executeSqlQuery() helper against
// INFORMATION_SCHEMA: picking a Table pre-populates Column Settings from
// its real column definitions, same as the old builder did.

const API_BASE = 'https://app.equinoxits.com:1139';

// ============================================
// STATE
// ============================================
let columns = [];
let filters = [];
let inputVariables = [];
let availableWorkflows = [];
let sqlDatasources = [];
let loadedDatatableId = null;
// Whether the current user can edit THIS datatable's schema/definition
// (backend 'datatable_admin'/edit) - defaults to true so a brand-new,
// not-yet-saved datatable (no id, no GET response to source this from
// yet) isn't blocked client-side; the POST create endpoint enforces
// 'datatable_admin'/create separately regardless. Only set to false once
// an existing datatable is loaded and its GET response says otherwise -
// see getDatatableConfigFromDatabase().
let canAdminEditDatatable = true;
let pageInitialized = false;

// Cache of table -> [{name, type, isPrimaryKey, isGenerated, isNullable,
// enumValues}] for the currently-selected SQL Database, populated lazily
// as tables are discovered/selected in the Table dropdown.
let tableColumnInfo = {};
// Set while restoring a saved config so selecting the Table dropdown
// programmatically doesn't trigger the "pre-populate columns" flow.
let suppressTableAutoPopulate = false;

// DOM refs (assigned in initializeApp)
let datatableName, datatableDesc, sqlMode, sqlDatabase, sqlDatabaseGroup,
    sqlTable, sqlTableGroup, sqlQuery, sqlQueryGroup, dataWorkflow,
    dataWorkflowGroup, updateWorkflow, updateWorkflowGroup,
    sqlUpdateWorkflowHookToggle, sqlUpdateWorkflowHookToggleGroup, outputVar,
    columnsList, filtersList, inputVariablesList, jsonOutput,
    validationOutput, saveBtn;

// ============================================
// URL / DATABASE HELPERS
// ============================================
function getDatatableIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('id');
}

async function getDatatableConfigFromDatabase(datatableId) {
    try {
        if (!datatableId) return null;

        const response = await fetch(`${API_BASE}/kore/datatables/${datatableId}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        canAdminEditDatatable = data.canAdminEdit === true;
        return data.definition || null;
    } catch (error) {
        console.error('[FETCH CONFIG] Error fetching datatable:', error);
        return null;
    }
}

// ============================================
// WORKFLOWS / SQL DATASOURCES
// ============================================
async function loadAvailableWorkflows() {
    try {
        const result = await executeSqlQuery(
            'cookie', null, 'kore_sys',
            `SELECT id, name FROM kore_sys.workflows ORDER BY name`
        );
        availableWorkflows = result?.result || [];
        populateWorkflowDropdowns();
    } catch (err) {
        console.error('[Workflows] Failed to load:', err);
        availableWorkflows = [];
    }
}

async function loadSqlDatasources() {
    try {
        const result = await executeSqlQuery(
            'cookie', null, 'kore_sys',
            `SELECT config FROM kore_sys.plugins WHERE name = 'sqlquery'`
        );
        const row = result?.result?.[0];
        const raw = row?.config;
        const config = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : null;
        sqlDatasources = config?.databases ? Object.keys(config.databases) : [];
        populateSqlDatabaseDropdown();
    } catch (err) {
        console.error('[SQL Datasources] Failed to load:', err);
        sqlDatasources = [];
    }
}

function populateWorkflowDropdowns() {
    [dataWorkflow, updateWorkflow].forEach(select => {
        if (!select) return;
        const current = select.value;
        select.innerHTML = '<option value="">-- Select workflow --</option>' +
            availableWorkflows.map(w => `<option value="${w.id}">${w.name}</option>`).join('');
        if (current) select.value = current;
    });
}

function populateSqlDatabaseDropdown() {
    if (!sqlDatabase) return;
    const current = sqlDatabase.value;
    sqlDatabase.innerHTML = '<option value="">-- Select database --</option>' +
        sqlDatasources.map(ds => `<option value="${ds}">${ds}</option>`).join('');
    if (current) sqlDatabase.value = current;
}

// ============================================
// SQL MODE - TABLE / COLUMN DISCOVERY
// ============================================
async function loadTablesForDatasource(datasource) {
    if (!datasource) {
        sqlTable.innerHTML = '<option value="">-- Select a database first --</option>';
        sqlTable.disabled = true;
        return;
    }

    sqlTable.disabled = true;
    sqlTable.innerHTML = '<option value="">Loading tables...</option>';

    try {
        const result = await executeSqlQuery(
            'cookie', null, datasource,
            `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
             ORDER BY TABLE_NAME`
        );
        const tableNames = (result?.result || []).map(r => r.TABLE_NAME || r.table_name).filter(Boolean);

        sqlTable.innerHTML = '<option value="">-- Select a table --</option>' +
            tableNames.map(t => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('');
        sqlTable.disabled = tableNames.length === 0;
    } catch (err) {
        console.error('[SQL Tables] Failed to load tables for', datasource, err);
        sqlTable.innerHTML = '<option value="">-- Failed to load tables --</option>';
        sqlTable.disabled = true;
    }
}

async function loadColumnsForTable(datasource, table) {
    if (tableColumnInfo[table]) return tableColumnInfo[table];

    const result = await executeSqlQuery(
        'cookie', null, datasource,
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, COLUMN_KEY, EXTRA, COLUMN_DEFAULT, IS_NULLABLE
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table.replace(/'/g, "''")}'
         ORDER BY ORDINAL_POSITION`
    );

    const rows = result?.result || [];
    const cols = rows.map(row => {
        const cname = row.COLUMN_NAME || row.column_name;
        let dtype = (row.DATA_TYPE || row.data_type || '').toLowerCase();
        const columnType = row.COLUMN_TYPE || row.column_type || '';
        const ckey = row.COLUMN_KEY || row.column_key || '';
        const extra = row.EXTRA || row.extra || '';
        const columnDefault = row.COLUMN_DEFAULT ?? row.column_default;
        const isNullable = row.IS_NULLABLE || row.is_nullable || 'YES';

        // tinyint(1) with a 0/1 default is conventionally a boolean flag
        if (dtype === 'tinyint' && (columnDefault === '0' || columnDefault === '1' || columnDefault === 0 || columnDefault === 1)) {
            dtype = 'boolean';
        }

        let enumValues = '';
        if (dtype === 'enum' && columnType) {
            const match = columnType.match(/enum\((.*?)\)/i);
            if (match && match[1]) {
                enumValues = match[1].split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '')).join(',');
            }
        }

        // The Column Settings type <select> only offers a fixed set of
        // options (int, varchar, text, datetime, date, boolean, enum,
        // float, decimal, json, bigint). Any DATA_TYPE MySQL reports that
        // isn't exactly one of those - smallint, char, longtext, timestamp,
        // double, a plain (non-boolean) tinyint, etc. - has no matching
        // <option>, so the browser silently selects the first option
        // (int) instead. Map every variant MySQL can report down to one
        // of the dropdown's actual values so the imported type shows up
        // correctly instead of silently defaulting to int.
        const DTYPE_NORMALIZE = {
            smallint: 'int', mediumint: 'int', tinyint: 'int',
            char: 'varchar',
            text: 'text', longtext: 'text', mediumtext: 'text', tinytext: 'text',
            timestamp: 'datetime',
            double: 'float', real: 'float'
        };

        return {
            name: cname,
            type: DTYPE_NORMALIZE[dtype] || dtype,
            isPrimaryKey: ckey === 'PRI',
            isGenerated: extra.includes('auto_increment') || extra.includes('GENERATED'),
            isNullable: isNullable === 'YES',
            enumValues
        };
    });

    tableColumnInfo[table] = cols;
    return cols;
}

async function handleTableSelected(datasource, table) {
    if (!table) return;

    const applyColumns = async () => {
        const tableInfo = await loadColumnsForTable(datasource, table);
        columns = tableInfo.map(col => ({
            col_name: col.name, col_label: '', col_desc: '',
            data_type: col.type, enum_values: col.enumValues || '', map: {},
            map_type: 'static', map_query: '', map_id_col: '', map_value_col: '',
            required: false, p_key: col.isPrimaryKey, hide_table: false,
            hide_edit: col.isPrimaryKey, gen: col.isGenerated,
            editable: !col.isGenerated, span: false, not_null: !col.isNullable, null_for_blank: false
        }));
        sqlQuery.value = `SELECT * FROM ${table}`;
        renderColumns();
        updateOutput();
    };

    if (suppressTableAutoPopulate) return; // restoring a saved config, not a user pick

    if (columns.length > 0) {
        showConfirm(
            'Replace Columns?',
            `Selecting "${table}" will pre-populate Column Settings from its schema, replacing the ${columns.length} column(s) currently configured. Continue?`,
            applyColumns,
            'Replace Columns'
        );
    } else {
        applyColumns();
    }
}


// COLUMN SETTINGS
// ============================================
// Which column types get the Mapping button. Originally numeric-only
// (int-family, for FK-style id -> label lookups), widened to include
// varchar/text since status/category code columns are just as common a
// case for value -> label mapping. Left out: boolean (already has a
// fixed True/False display), datetime/date/json (mapping doesn't make
// sense), enum (already has its own dedicated enum_values editor).
const MAPPABLE_TYPES = ['int', 'smallint', 'bigint', 'tinyint', 'varchar', 'text'];

function addColumn() {
    columns.push({
        col_name: '', col_label: '', col_desc: '', data_type: 'varchar',
        enum_values: '', map: {}, map_type: 'static', map_query: '',
        map_id_col: '', map_value_col: '', required: false, p_key: false,
        hide_table: false, hide_edit: false, gen: false, editable: true,
        span: false, not_null: false, null_for_blank: false
    });
    renderColumns();
    updateOutput();
}

function removeColumn(idx) {
    columns.splice(idx, 1);
    renderColumns();
    updateOutput();
}

function moveColumn(idx, direction) {
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= columns.length) return;
    [columns[idx], columns[target]] = [columns[target], columns[idx]];
    renderColumns();
    updateOutput();
}

function updateColumnByIndex(idx, field, value) {
    if (idx < 0 || idx >= columns.length) return;
    columns[idx][field] = value;
    if (field === 'data_type' || field === 'not_null') renderColumns();
    updateOutput();
}

function renderColumns() {
    if (!columnsList) return;
    if (columns.length === 0) {
        columnsList.innerHTML = '<div class="dt-empty-note">No columns configured yet</div>';
        return;
    }

    columnsList.innerHTML = columns.map((col, idx) => `
        <div class="panel-level-3 dt-row-card">
            <div class="dt-row-card-main">
                <input type="text" value="${escapeAttr(col.col_name)}" placeholder="Column name"
                       onchange="window.dtUpdateColumn(${idx}, 'col_name', this.value)">

                <div class="dt-row-fields">
                    <input type="text" value="${escapeAttr(col.col_label)}" placeholder="Display name"
                           onchange="window.dtUpdateColumn(${idx}, 'col_label', this.value)">
                    <input type="text" value="${escapeAttr(col.col_desc)}" placeholder="Description"
                           onchange="window.dtUpdateColumn(${idx}, 'col_desc', this.value)">
                </div>

                <div class="form-group--inline">
                    <label for="type_${idx}" style="margin-right: 4px;">Type</label>
                    <select id="type_${idx}" onchange="window.dtUpdateColumn(${idx}, 'data_type', this.value)">
                        ${['int', 'varchar', 'text', 'datetime', 'date', 'boolean', 'enum', 'float', 'decimal', 'json', 'bigint']
                            .map(t => `<option value="${t}" ${col.data_type === t ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                </div>

                ${col.data_type === 'enum' ? `
                    <input type="text" value="${escapeAttr(col.enum_values)}" placeholder="Comma-separated values (active,inactive,pending)"
                           onchange="window.dtUpdateColumn(${idx}, 'enum_values', this.value)">
                ` : ''}

                <div class="dt-checkbox-grid">
                    <div class="form-group--inline"><input type="checkbox" id="pkey_${idx}" ${col.p_key ? 'checked' : ''} onchange="window.dtUpdateColumn(${idx}, 'p_key', this.checked)"><label for="pkey_${idx}">Primary Key</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="required_${idx}" ${col.required ? 'checked' : ''} onchange="window.dtUpdateColumn(${idx}, 'required', this.checked)"><label for="required_${idx}">Required</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="span_${idx}" ${col.span ? 'checked' : ''} onchange="window.dtUpdateColumn(${idx}, 'span', this.checked)"><label for="span_${idx}">Span</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="gen_${idx}" ${col.gen ? 'checked' : ''} onchange="window.dtUpdateColumn(${idx}, 'gen', this.checked)"><label for="gen_${idx}">Generated</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="hideTable_${idx}" ${col.hide_table ? 'checked' : ''} onchange="window.dtUpdateColumn(${idx}, 'hide_table', this.checked)"><label for="hideTable_${idx}">Hide in Table</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="editable_${idx}" ${col.editable ? 'checked' : ''} onchange="window.dtUpdateColumn(${idx}, 'editable', this.checked)"><label for="editable_${idx}">Editable</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="hideEdit_${idx}" ${col.hide_edit ? 'checked' : ''} onchange="window.dtUpdateColumn(${idx}, 'hide_edit', this.checked)"><label for="hideEdit_${idx}">Hide in Edit</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="notNull_${idx}" ${col.not_null ? 'checked' : ''} onchange="window.dtUpdateColumn(${idx}, 'not_null', this.checked)"><label for="notNull_${idx}">Not Null</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="nullForBlank_${idx}" ${col.null_for_blank ? 'checked' : ''} ${col.not_null ? 'disabled' : ''} onchange="window.dtUpdateColumn(${idx}, 'null_for_blank', this.checked)" title="${col.not_null ? 'Not applicable - Not Null already requires a value' : 'Send NULL instead of an empty string when this field is left blank'}"><label for="nullForBlank_${idx}" style="${col.not_null ? 'opacity: 0.5;' : ''}">Blank = NULL</label></div>
                </div>
            </div>
            <div class="dt-row-card-side">
                <div class="dt-move-buttons">
                    <button class="btn" data-color="grey" ${idx === 0 ? 'disabled' : ''} onclick="window.dtMoveColumn(${idx}, 'up')">▲</button>
                    <button class="btn" data-color="grey" ${idx === columns.length - 1 ? 'disabled' : ''} onclick="window.dtMoveColumn(${idx}, 'down')">▼</button>
                </div>
                ${MAPPABLE_TYPES.includes(col.data_type) ? `<button class="btn" data-color="blue" data-size="sm" onclick="window.dtOpenMappingModal(${idx})">Mapping</button>` : ''}
                <button class="btn" data-color="red" data-size="sm" onclick="window.dtRemoveColumn(${idx})">Remove</button>
            </div>
        </div>
    `).join('');
}

// ---- Column value mapping modal ----
function openMappingModal(colIdx) {
    const col = columns[colIdx];
    let mappingType = col.map_type || 'static';
    let mappingPairs = mappingType === 'static'
        ? Object.entries(col.map || {}).map(([value, label]) => ({ value, label }))
        : [];

    const content = document.createElement('div');
    content.style.cssText = 'display: flex; flex-direction: column; gap: 14px; min-width: 420px;';

    function render() {
        content.innerHTML = `
            <div class="form-group">
                <label>Mapping Type</label>
                <select id="mappingTypeSelect">
                    <option value="static" ${mappingType === 'static' ? 'selected' : ''}>Static</option>
                    <option value="mysql" ${mappingType === 'mysql' ? 'selected' : ''}>MySQL</option>
                </select>
            </div>
            <div id="mappingPairsContainer" style="display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto;"></div>
            ${mappingType === 'static' ? '<button id="addMappingPairBtn" class="btn" data-color="blue" data-size="sm">Add</button>' : ''}
        `;

        const pairsContainer = content.querySelector('#mappingPairsContainer');

        if (mappingType === 'static') {
            pairsContainer.innerHTML = mappingPairs.map((pair, i) => `
                <div style="display: flex; gap: 8px; align-items: flex-end;">
                    <div class="form-group" style="flex: 1; margin-bottom: 0;">
                        <label>Value</label>
                        <input type="text" data-pair-field="value" data-pair-idx="${i}" value="${escapeAttr(pair.value)}" placeholder="e.g., 1">
                    </div>
                    <div class="form-group" style="flex: 2; margin-bottom: 0;">
                        <label>Label</label>
                        <input type="text" data-pair-field="label" data-pair-idx="${i}" value="${escapeAttr(pair.label)}" placeholder="e.g., Active">
                    </div>
                    <button class="btn" data-color="red" data-size="sm" data-remove-pair="${i}">✕</button>
                </div>
            `).join('');

            pairsContainer.querySelectorAll('input[data-pair-field]').forEach(input => {
                input.addEventListener('change', (e) => {
                    const i = parseInt(e.target.dataset.pairIdx);
                    mappingPairs[i][e.target.dataset.pairField] = e.target.value;
                });
            });
            pairsContainer.querySelectorAll('[data-remove-pair]').forEach(btn => {
                btn.addEventListener('click', () => {
                    mappingPairs.splice(parseInt(btn.dataset.removePair), 1);
                    render();
                });
            });

            content.querySelector('#addMappingPairBtn')?.addEventListener('click', () => {
                mappingPairs.push({ value: '', label: '' });
                render();
            });
        } else {
            pairsContainer.innerHTML = `
                <div class="dt-row-fields">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label>ID Column</label>
                        <input type="text" id="mapIdCol" value="${escapeAttr(col.map_id_col)}" placeholder="e.g., id">
                    </div>
                    <div class="form-group" style="margin-bottom: 0;">
                        <label>Value Column</label>
                        <input type="text" id="mapValueCol" value="${escapeAttr(col.map_value_col)}" placeholder="e.g., name">
                    </div>
                </div>
                <div class="form-group" style="margin-bottom: 0; margin-top: 8px;">
                    <label>Query</label>
                    <textarea id="mapQuery" rows="4" placeholder="SELECT id, name FROM table_name">${escapeHtml(col.map_query)}</textarea>
                </div>
            `;
        }

        content.querySelector('#mappingTypeSelect').addEventListener('change', (e) => {
            mappingType = e.target.value;
            render();
        });
    }

    render();

    showModal({
        title: 'Column Value Mapping',
        content,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Save',
                type: 'success',
                onClick: () => {
                    col.map_type = mappingType;
                    if (mappingType === 'static') {
                        const mapObj = {};
                        mappingPairs.forEach(p => {
                            if (p.value && p.label) mapObj[p.value] = p.label;
                        });
                        col.map = mapObj;
                    } else {
                        col.map = {};
                        col.map_id_col = content.querySelector('#mapIdCol')?.value || '';
                        col.map_value_col = content.querySelector('#mapValueCol')?.value || '';
                        col.map_query = content.querySelector('#mapQuery')?.value || '';
                    }
                    renderColumns();
                    updateOutput();
                }
            }
        ]
    });
}

// ============================================
// FILTERS
// ============================================
function addFilter() {
    filters.push({ col_name: '', display_label: '', condition: '', default_checked: true });
    renderFilters();
    updateOutput();
}

function removeFilter(idx) {
    filters.splice(idx, 1);
    renderFilters();
    updateOutput();
}

function updateFilterByIndex(idx, field, value) {
    if (idx < 0 || idx >= filters.length) return;
    filters[idx][field] = value;
    updateOutput();
}

function renderFilters() {
    if (!filtersList) return;
    if (filters.length === 0) {
        filtersList.innerHTML = '<div class="dt-empty-note">No filters configured yet</div>';
        return;
    }

    filtersList.innerHTML = filters.map((filter, idx) => `
        <div class="panel-level-3 dt-row-card">
            <div class="dt-row-card-main">
                <div class="form-group" style="margin-bottom: 0;">
                    <label>Column</label>
                    <select onchange="window.dtUpdateFilter(${idx}, 'col_name', this.value)">
                        <option value="">-- Select Column --</option>
                        ${columns.map(c => `<option value="${escapeAttr(c.col_name)}" ${filter.col_name === c.col_name ? 'selected' : ''}>${escapeHtml(c.col_name)}</option>`).join('')}
                    </select>
                </div>
                <input type="text" value="${escapeAttr(filter.display_label)}" placeholder="Display label (e.g., Show Inactive?)"
                       onchange="window.dtUpdateFilter(${idx}, 'display_label', this.value)">
                <input type="text" value="${escapeAttr(filter.condition)}" placeholder="SQL condition (e.g., = 1 or not in (9,99))"
                       onchange="window.dtUpdateFilter(${idx}, 'condition', this.value)">
                <div class="form-group--inline">
                    <input type="checkbox" id="filterDefault_${idx}" ${filter.default_checked ? 'checked' : ''} onchange="window.dtUpdateFilter(${idx}, 'default_checked', this.checked)">
                    <label for="filterDefault_${idx}">Default Checked</label>
                </div>
            </div>
            <div class="dt-row-card-side">
                <button class="btn" data-color="red" data-size="sm" onclick="window.dtRemoveFilter(${idx})">Remove</button>
            </div>
        </div>
    `).join('');
}

// ============================================
// INPUT VARIABLES
// ============================================
function addInputVariable() {
    inputVariables.push({
        name: '', value: '', dspl_name: '', required: false, fromUrl: false,
        datatable_var: false, fromDataset: false, dataset_source: 'workflow',
        workflow: '', workflow_output_var: '', proxy_query: '', output_id: 'id', output_label: 'name'
    });
    renderInputVariables();
    updateOutput();
}

function removeInputVariable(idx) {
    inputVariables.splice(idx, 1);
    renderInputVariables();
    updateOutput();
}

function moveInputVariable(idx, direction) {
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= inputVariables.length) return;
    [inputVariables[idx], inputVariables[target]] = [inputVariables[target], inputVariables[idx]];
    renderInputVariables();
    updateOutput();
}

function updateInputVariable(idx, field, value) {
    if (idx < 0 || idx >= inputVariables.length) return;
    inputVariables[idx][field] = value;
    if (field === 'fromDataset' || field === 'dataset_source') renderInputVariables();
    updateOutput();
}

function renderInputVariables() {
    if (!inputVariablesList) return;

    const templateNote = document.getElementById('templateVarsNote');
    if (templateNote) templateNote.style.display = inputVariables.length > 0 ? 'block' : 'none';

    if (inputVariables.length === 0) {
        inputVariablesList.innerHTML = '';
        return;
    }

    inputVariablesList.innerHTML = inputVariables.map((iv, idx) => {
        const datasetSection = iv.fromDataset ? `
            <div style="border-top: 1px solid var(--border-primary); padding-top: 8px; margin-top: 4px;">
                <div class="form-group" style="margin-bottom: 8px;">
                    <label>Dataset Source</label>
                    <select onchange="window.dtUpdateInputVar(${idx}, 'dataset_source', this.value)">
                        <option value="workflow" ${iv.dataset_source === 'workflow' ? 'selected' : ''}>Workflow</option>
                        <option value="mysql" ${iv.dataset_source === 'mysql' ? 'selected' : ''}>MySQL Query</option>
                    </select>
                </div>
                ${iv.dataset_source === 'workflow' ? `
                    <div class="form-group" style="margin-bottom: 8px;">
                        <label>Dataset Selector Workflow</label>
                        <select onchange="window.dtUpdateInputVar(${idx}, 'workflow', this.value)">
                            <option value="">-- Select Workflow --</option>
                            ${availableWorkflows.map(w => `<option value="${w.id}" ${iv.workflow === w.id ? 'selected' : ''}>${w.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin-bottom: 8px;">
                        <label>Workflow Output Variable</label>
                        <input type="text" value="${escapeAttr(iv.workflow_output_var)}" placeholder="e.g., dataset_result" onchange="window.dtUpdateInputVar(${idx}, 'workflow_output_var', this.value)">
                    </div>
                ` : `
                    <div class="form-group" style="margin-bottom: 8px;">
                        <label>SQL Query</label>
                        <textarea rows="3" placeholder="SELECT id, name FROM table WHERE..." onchange="window.dtUpdateInputVar(${idx}, 'proxy_query', this.value)">${escapeHtml(iv.proxy_query)}</textarea>
                    </div>
                `}
                <div class="dt-row-fields">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label>Output ID Variable</label>
                        <input type="text" value="${escapeAttr(iv.output_id)}" placeholder="id" onchange="window.dtUpdateInputVar(${idx}, 'output_id', this.value)">
                    </div>
                    <div class="form-group" style="margin-bottom: 0;">
                        <label>Output Label Variable</label>
                        <input type="text" value="${escapeAttr(iv.output_label)}" placeholder="name" onchange="window.dtUpdateInputVar(${idx}, 'output_label', this.value)">
                    </div>
                </div>
            </div>
        ` : '';

        return `
        <div class="panel-level-3 dt-row-card">
            <div class="dt-row-card-main">
                <div class="dt-row-fields">
                    <input type="text" value="${escapeAttr(iv.name)}" placeholder="Variable name" onchange="window.dtUpdateInputVar(${idx}, 'name', this.value)">
                    <input type="text" value="${escapeAttr(iv.value)}" placeholder="Value or [[variableName]]" onchange="window.dtUpdateInputVar(${idx}, 'value', this.value)">
                </div>
                <input type="text" value="${escapeAttr(iv.dspl_name)}" placeholder="Display name for UI" onchange="window.dtUpdateInputVar(${idx}, 'dspl_name', this.value)">
                <div class="dt-checkbox-grid">
                    <div class="form-group--inline"><input type="checkbox" id="ivRequired_${idx}" ${iv.required ? 'checked' : ''} onchange="window.dtUpdateInputVar(${idx}, 'required', this.checked)"><label for="ivRequired_${idx}">Required</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="ivFromUrl_${idx}" ${iv.fromUrl ? 'checked' : ''} onchange="window.dtUpdateInputVar(${idx}, 'fromUrl', this.checked)"><label for="ivFromUrl_${idx}">From URL</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="ivPayload_${idx}" ${iv.datatable_var ? 'checked' : ''} onchange="window.dtUpdateInputVar(${idx}, 'datatable_var', this.checked)"><label for="ivPayload_${idx}">Include in Payload</label></div>
                    <div class="form-group--inline"><input type="checkbox" id="ivDataset_${idx}" ${iv.fromDataset ? 'checked' : ''} onchange="window.dtUpdateInputVar(${idx}, 'fromDataset', this.checked)"><label for="ivDataset_${idx}">From Dataset Selector</label></div>
                </div>
                ${datasetSection}
            </div>
            <div class="dt-row-card-side">
                <div class="dt-move-buttons">
                    <button class="btn" data-color="grey" ${idx === 0 ? 'disabled' : ''} onclick="window.dtMoveInputVar(${idx}, 'up')">▲</button>
                    <button class="btn" data-color="grey" ${idx === inputVariables.length - 1 ? 'disabled' : ''} onclick="window.dtMoveInputVar(${idx}, 'down')">▼</button>
                </div>
                <button class="btn" data-color="red" data-size="sm" onclick="window.dtRemoveInputVar(${idx})">Remove</button>
            </div>
        </div>
        `;
    }).join('');
}

// ============================================
// PERMISSIONS
// ============================================
async function openPermissionsModal() {
    if (!loadedDatatableId) {
        showStatusBanner('Save the datatable before managing permissions.', 'warning');
        return;
    }

    await loadAllUsersAndGroupsForModal();

    const permissions = await loadPermissionsForResource({
        resource: 'datatable',
        endpoint: `${API_BASE}/kore/permissions`,
        method: 'POST',
        body: { resource: 'datatable', scope: loadedDatatableId }
    }).catch(() => []);
    const activePermissions = (permissions || []).filter(p => p.revokedAt === null);

    const container = document.createElement('div');
    showModal({
        title: 'Datatable Permissions',
        content: container,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [{ label: 'Close', type: 'secondary' }]
    });

    displayPermissionsForm(container, activePermissions, {
        actions: ['view', 'create', 'edit', 'delete', '*'],
        addButtonLabel: 'Add Permission',
        saveButtonLabel: 'Save Permissions',
        onSave: async () => {
            const result = await savePermissionsForResource(
                { resource: 'datatable', endpoint: `${API_BASE}/kore/permissions` },
                loadedDatatableId,
                container
            ).catch(err => ({ success: false, error: err.message }));

            if (result.success !== false) {
                showStatusBanner('Permissions saved.', 'success');
            } else {
                showStatusBanner(`Failed to save permissions: ${result.error}`, 'error');
            }
        }
    });
}

async function loadAllUsersAndGroupsForModal() {
    try {
        const sessionToken = await getSessionToken();
        const [users, groups] = await Promise.all([
            getUsers(sessionToken, null),
            getGroups(sessionToken, null)
        ]);
        window.allUsersAndGroups = { users: users || [], groups: groups || [] };
    } catch (error) {
        console.error('Error loading users and groups:', error);
        window.allUsersAndGroups = { users: [], groups: [] };
    }
}

// ============================================
// BUILD CONFIG / VALIDATION / OUTPUT
// ============================================
function buildDatatableConfig() {
    return {
        name: datatableName.value || 'unnamed_table',
        desc: datatableDesc.value,
        edit_type: document.querySelector('input[name="editType"]:checked')?.value || 'window',
        sql_mode: sqlMode.checked,
        sql_database: sqlMode.checked ? (sqlDatabase.value || '') : '',
        table_name: sqlMode.checked ? (sqlTable.value || '') : '',
        sql_query: sqlMode.checked ? (sqlQuery.value || '') : '',
        data_workflow: sqlMode.checked ? '' : (dataWorkflow.value || ''),
        update_workflow: updateWorkflow.value || '',
        output_var: outputVar.value || '',
        input_vars: {
            ...Object.fromEntries(inputVariables
                .filter(iv => iv.name && iv.name.trim())
                .map(iv => [iv.name, iv.value]))
        },
        input_var_config: inputVariables.map(iv => {
            const cfg = { name: iv.name };
            if (iv.dspl_name) cfg.dspl_name = iv.dspl_name;
            if (iv.required) cfg.required = true;
            if (iv.fromUrl) cfg.from_url = true;
            if (iv.datatable_var) cfg.datatable_var = true;
            if (iv.fromDataset) {
                cfg.from_dataset = true;
                cfg.dataset_source = iv.dataset_source || 'workflow';
                if (iv.dataset_source === 'workflow' && iv.workflow) cfg.workflow = iv.workflow;
                if (iv.dataset_source === 'workflow' && iv.workflow_output_var) cfg.workflow_output_var = iv.workflow_output_var;
                if (iv.dataset_source === 'mysql' && iv.proxy_query) cfg.proxy_query = iv.proxy_query;
                if (iv.output_id) cfg.output_id = iv.output_id;
                if (iv.output_label) cfg.output_label = iv.output_label;
            }
            return cfg;
        }),
        col_settings: columns.map(col => {
            const c = { col_name: col.col_name, type: col.data_type, editable: !!col.editable, not_null: !!col.not_null };
            if (col.col_label) c.col_label = col.col_label;
            if (col.col_desc) c.col_desc = col.col_desc;
            if (col.data_type === 'enum' && col.enum_values) c.enum_values = col.enum_values;
            if (MAPPABLE_TYPES.includes(col.data_type)) {
                if (col.map_type === 'mysql') {
                    c.map_type = 'mysql';
                    if (col.map_query) c.map_query = col.map_query;
                    if (col.map_id_col) c.map_id_col = col.map_id_col;
                    if (col.map_value_col) c.map_value_col = col.map_value_col;
                } else if (col.map && Object.keys(col.map).length > 0) {
                    c.map_type = 'static';
                    c.map = col.map;
                }
            }
            if (col.required) c.required = true;
            if (col.p_key) c.p_key = true;
            if (col.hide_table) c.hide_table = true;
            if (col.hide_edit) c.hide_edit = true;
            if (col.gen) c.gen = true;
            if (col.span) c.span = true;
            if (col.null_for_blank && !col.not_null) c.null_for_blank = true;
            return c;
        }),
        filters: filters.filter(f => f.col_name && f.col_name.trim())
    };
}

function getValidationErrors(config) {
    const errors = [];

    if (!datatableName.value.trim()) errors.push('Datatable Name is required');

    if (config.sql_mode) {
        if (!config.sql_database) errors.push('SQL Database is required when using SQL Mode');
        if (!config.table_name) errors.push('Table is required when using SQL Mode');
        if (!config.sql_query.trim()) errors.push('SQL Query is required when using SQL Mode');
    } else if (!config.data_workflow) {
        errors.push('Data Workflow is required');
    }

    // In SQL Mode, writes are generated directly from col_settings (see the
    // old Viewer's generateDynamicSQL) - no workflow required. Add/Update/
    // Delete Workflow stays required for workflow-mode datatables, and
    // remains available as an optional post-write hook in SQL Mode.
    if (!config.sql_mode && !config.update_workflow) {
        errors.push('Add/Update/Delete Workflow is required');
    }
    if (!config.output_var.trim()) errors.push('Output Variable Name is required');

    const columnsWithoutName = columns.filter(c => !c.col_name || !c.col_name.trim());
    if (columnsWithoutName.length > 0) {
        errors.push(`${columnsWithoutName.length} column${columnsWithoutName.length > 1 ? 's' : ''} missing a name`);
    }

    const varsWithoutName = inputVariables.filter(iv => !iv.name || !iv.name.trim());
    if (varsWithoutName.length > 0) {
        errors.push(`${varsWithoutName.length} input variable${varsWithoutName.length > 1 ? 's' : ''} missing a name`);
    }

    const names = inputVariables.map(iv => iv.name).filter(n => n && n.trim());
    const dupes = names.filter((n, i) => names.findIndex(n2 => n2.toLowerCase() === n.toLowerCase()) !== i);
    if (dupes.length > 0) errors.push(`Duplicate input variable name(s): ${[...new Set(dupes)].join(', ')}`);

    inputVariables.filter(iv => iv.fromDataset).forEach(iv => {
        if (iv.dataset_source === 'workflow' && !iv.workflow) {
            errors.push(`Input variable "${iv.name || '(unnamed)'}" needs a Dataset Selector Workflow`);
        }
        if (iv.dataset_source === 'workflow' && !iv.workflow_output_var?.trim()) {
            errors.push(`Input variable "${iv.name || '(unnamed)'}" needs a Workflow Output Variable`);
        }
        if (iv.dataset_source === 'mysql' && !iv.proxy_query?.trim()) {
            errors.push(`Input variable "${iv.name || '(unnamed)'}" needs a SQL Query`);
        }
        if (!iv.output_id?.trim() || !iv.output_label?.trim()) {
            errors.push(`Input variable "${iv.name || '(unnamed)'}" needs Output ID and Output Label variables`);
        }
    });

    return errors;
}

function updateOutput() {
    const config = buildDatatableConfig();
    const errors = getValidationErrors(config);

    saveBtn.disabled = errors.length > 0 || !canAdminEditDatatable;

    if (validationOutput) {
        if (errors.length > 0) {
            validationOutput.innerHTML = `
                <div style="color: #ff6b6b;"><strong>Blocking Validations:</strong>
                    <ul class="dt-validation-list">${errors.map(e => `<li class="dt-validation-item">${escapeHtml(e)}</li>`).join('')}</ul>
                </div>
                ${columns.length === 0 ? '<div style="color: #ffa500; margin-top: 8px;">⚠ No columns defined</div>' : ''}
            `;
        } else {
            validationOutput.innerHTML = `
                <div style="color: #4caf50;"><strong>✓ No validation issues</strong></div>
                ${columns.length === 0 ? '<div style="color: #ffa500; margin-top: 8px;">⚠ No columns defined</div>' : ''}
            `;
        }
    }

    if (jsonOutput) jsonOutput.textContent = JSON.stringify(config, null, 2);

    // Save-button validation tooltip, mirroring the Form Builder's pattern
    const validationItems = document.getElementById('validationItems');
    if (validationItems) {
        validationItems.innerHTML = errors.map(e => `<div style="color: #ff8a8a; font-size: 12px;">• ${escapeHtml(e)}</div>`).join('');
    }

    if (pageInitialized) markAsChanged();
}

function markAsChanged() {
    checkUnsavedChanges(buildDatatableConfig());
}

// ============================================
// SAVE / RESET
// ============================================
async function saveDatatableToDatabase() {
    if (!canAdminEditDatatable) {
        showStatusBanner('You have view-only access to this datatable and cannot save changes.', 'error');
        return;
    }

    const datatableId = loadedDatatableId || getDatatableIdFromUrl();
    if (!datatableId) {
        showStatusBanner('No id in the URL — nothing to save against.', 'error');
        return;
    }

    const config = buildDatatableConfig();
    const errors = getValidationErrors(config);
    if (errors.length > 0) {
        showStatusBanner('Resolve validation errors before saving.', 'error');
        return;
    }

    if (!checkUnsavedChanges(config)) {
        showStatusBanner('No changes to save.', 'info');
        return;
    }

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        const payload = { name: config.name, version: null, definition: config, folder_id: null };
        const response = await fetch(`${API_BASE}/kore/datatables/${datatableId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        initializeUnsavedTracking(buildDatatableConfig());
        clearUnsavedChanges();
        showStatusBanner(`Datatable "${config.name}" saved successfully.`, 'success');
    } catch (err) {
        console.error('[SAVE DATATABLE] Error:', err);
        showStatusBanner(`Save failed: ${err.message}`, 'error');
    } finally {
        saveBtn.textContent = 'Save';
        updateOutput();
    }
}

async function applyConfigToForm(config) {
    datatableName.value = config.name && config.name !== 'unnamed_table' ? config.name : '';
    datatableDesc.value = config.desc || config.description || '';

    const editTypeRadio = document.querySelector(`input[name="editType"][value="${config.edit_type || 'window'}"]`);
    if (editTypeRadio) editTypeRadio.checked = true;

    sqlMode.checked = !!config.sql_mode;
    toggleSqlFields();
    sqlQuery.value = config.sql_query || '';
    dataWorkflow.value = config.data_workflow || '';
    updateWorkflow.value = config.update_workflow || '';
    outputVar.value = config.output_var || '';

    if (sqlMode.checked && config.update_workflow) {
        // A saved SQL-mode config already has a workflow hook configured -
        // reveal it instead of leaving it hidden-but-set.
        sqlUpdateWorkflowHookToggle.checked = true;
        toggleSqlFields();
        updateWorkflow.value = config.update_workflow;
    }

    if (sqlMode.checked && config.sql_database) {
        suppressTableAutoPopulate = true;
        sqlDatabase.value = config.sql_database || '';
        await loadTablesForDatasource(config.sql_database);
        sqlTable.value = config.table_name || '';
        suppressTableAutoPopulate = false;
    } else {
        sqlDatabase.value = config.sql_database || '';
    }

    columns = (config.col_settings || []).map(c => ({
        col_name: c.col_name || '', col_label: c.col_label || '', col_desc: c.col_desc || '',
        data_type: c.type || 'varchar', enum_values: c.enum_values || '', map: c.map || {},
        map_type: c.map_type || 'static', map_query: c.map_query || '', map_id_col: c.map_id_col || '',
        map_value_col: c.map_value_col || '', required: !!c.required, p_key: !!c.p_key,
        hide_table: !!c.hide_table, hide_edit: !!c.hide_edit, gen: !!c.gen,
        editable: c.editable !== false, span: !!c.span, not_null: !!c.not_null,
        null_for_blank: !!c.null_for_blank
    }));

    filters = (config.filters || []).map(f => ({
        col_name: f.col_name || '', display_label: f.display_label || '',
        condition: f.condition || '', default_checked: f.default_checked !== false
    }));

    inputVariables = [];
    const inputVars = config.input_vars || {};
    const inputVarConfig = config.input_var_config || [];
    Object.entries(inputVars).forEach(([name, value]) => {
        const cfg = inputVarConfig.find(v => v.name === name) || {};
        inputVariables.push({
            name, value: value || '', dspl_name: cfg.dspl_name || '',
            required: !!cfg.required, fromUrl: !!cfg.from_url, datatable_var: !!cfg.datatable_var,
            fromDataset: !!cfg.from_dataset, dataset_source: cfg.dataset_source || 'workflow',
            workflow: cfg.workflow || '', workflow_output_var: cfg.workflow_output_var || '', proxy_query: cfg.proxy_query || '',
            output_id: cfg.output_id || 'id', output_label: cfg.output_label || 'name'
        });
    });

    renderColumns();
    renderFilters();
    renderInputVariables();
    updateOutput();
}

function resetConfiguration() {
    const doReset = async () => {
        if (loadedDatatableId) {
            const config = await getDatatableConfigFromDatabase(loadedDatatableId);
            if (config) {
                await applyConfigToForm(config);
                initializeUnsavedTracking(buildDatatableConfig());
                clearUnsavedChanges();
                showStatusBanner('Reset to last saved version.', 'info');
                return;
            }
        }
        await applyConfigToForm({ name: '', col_settings: [], filters: [], input_vars: {}, input_var_config: [] });
        initializeUnsavedTracking(buildDatatableConfig());
        clearUnsavedChanges();
    };

    if (hasUnsavedChanges()) {
        showConfirm('Reset Datatable', 'You have unsaved changes. Resetting will discard them. Continue?', doReset, 'Reset');
    } else {
        doReset();
    }
}

function toggleSqlFields() {
    const useSql = sqlMode.checked;
    sqlDatabaseGroup.style.display = useSql ? 'flex' : 'none';
    sqlTableGroup.style.display = useSql ? 'flex' : 'none';
    sqlQueryGroup.style.display = useSql ? 'flex' : 'none';
    dataWorkflowGroup.style.display = useSql ? 'none' : 'flex';

    const updateWorkflowLabel = document.getElementById('updateWorkflowLabel');
    if (updateWorkflowLabel) {
        updateWorkflowLabel.textContent = useSql
            ? 'Add/Update/Delete Workflow (optional post-write hook)'
            : 'Add/Update/Delete Workflow';
    }

    sqlUpdateWorkflowHookToggleGroup.style.display = useSql ? 'flex' : 'none';
    if (useSql) {
        // In SQL Mode the workflow field is opt-in: hidden unless the hook
        // checkbox is on, or a workflow is already set (e.g. loading a
        // saved config) - see applyConfigToForm for that case.
        const showHook = sqlUpdateWorkflowHookToggle.checked;
        updateWorkflowGroup.style.display = showHook ? 'flex' : 'none';
        if (!showHook) updateWorkflow.value = '';
    } else {
        updateWorkflowGroup.style.display = 'flex';
    }

    if (useSql && !outputVar.value) outputVar.value = 'sql_result';
    if (useSql && sqlDatabase.value) {
        loadTablesForDatasource(sqlDatabase.value);
    } else if (!useSql) {
        sqlTable.innerHTML = '<option value="">-- Select a database first --</option>';
        sqlTable.disabled = true;
    }
}

// ============================================
// SMALL HELPERS
// ============================================
function escapeAttr(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================
// INITIALIZATION
// ============================================
function initializeApp() {
    datatableName = document.getElementById('datatableName');
    datatableDesc = document.getElementById('datatableDesc');
    sqlMode = document.getElementById('sqlMode');
    sqlDatabase = document.getElementById('sqlDatabase');
    sqlDatabaseGroup = document.getElementById('sqlDatabaseGroup');
    sqlTable = document.getElementById('sqlTable');
    sqlTableGroup = document.getElementById('sqlTableGroup');
    sqlQuery = document.getElementById('sqlQuery');
    sqlQueryGroup = document.getElementById('sqlQueryGroup');
    dataWorkflow = document.getElementById('dataWorkflow');
    dataWorkflowGroup = document.getElementById('dataWorkflowGroup');
    updateWorkflow = document.getElementById('updateWorkflow');
    updateWorkflowGroup = document.getElementById('updateWorkflowGroup');
    sqlUpdateWorkflowHookToggle = document.getElementById('sqlUpdateWorkflowHookToggle');
    sqlUpdateWorkflowHookToggleGroup = document.getElementById('sqlUpdateWorkflowHookToggleGroup');
    outputVar = document.getElementById('outputVar');
    columnsList = document.getElementById('columnsList');
    filtersList = document.getElementById('filtersList');
    inputVariablesList = document.getElementById('inputVariablesList');
    jsonOutput = document.getElementById('jsonOutput');
    validationOutput = document.getElementById('validationOutput');
    saveBtn = document.getElementById('saveTableBtn');

    // Fail fast and clearly if the deployed HTML doesn't match this JS
    // (e.g. a stale _datatable-builder.html without the latest markup)
    // rather than crashing partway through with a cryptic null-reference
    // stack trace and leaving the page half-initialized.
    const requiredEls = {
        datatableName, datatableDesc, sqlMode, sqlDatabase, sqlDatabaseGroup,
        sqlTable, sqlTableGroup, sqlQuery, sqlQueryGroup, dataWorkflow,
        dataWorkflowGroup, updateWorkflow, updateWorkflowGroup,
        sqlUpdateWorkflowHookToggle, sqlUpdateWorkflowHookToggleGroup,
        outputVar, columnsList, filtersList, inputVariablesList,
        jsonOutput, validationOutput, saveBtn
    };
    const missing = Object.entries(requiredEls).filter(([, el]) => !el).map(([name]) => name);
    if (missing.length > 0) {
        console.error('[Datatable Builder] Missing expected elements - the deployed _datatable-builder.html is likely out of sync with datatable-builder.js:', missing);
        const statusEl = document.getElementById('statusMessage');
        if (statusEl) {
            statusEl.textContent = `Page failed to initialize: missing element(s) ${missing.join(', ')}. The HTML and JS files are out of sync - redeploy both together.`;
            statusEl.classList.add('active', 'status-error');
        }
        return;
    }

    // Field listeners
    [datatableName, datatableDesc, sqlQuery, dataWorkflow, updateWorkflow, outputVar].forEach(el => {
        el.addEventListener('input', updateOutput);
        el.addEventListener('change', updateOutput);
    });
    document.querySelectorAll('input[name="editType"]').forEach(el => el.addEventListener('change', updateOutput));

    sqlMode.addEventListener('change', () => {
        toggleSqlFields();
        updateOutput();
    });

    sqlUpdateWorkflowHookToggle.addEventListener('change', () => {
        toggleSqlFields();
        updateOutput();
    });

    sqlDatabase.addEventListener('change', () => {
        sqlTable.value = '';
        loadTablesForDatasource(sqlDatabase.value);
        updateOutput();
    });

    sqlTable.addEventListener('change', () => {
        handleTableSelected(sqlDatabase.value, sqlTable.value);
        updateOutput();
    });

    // Buttons
    document.getElementById('addColumnBtn').addEventListener('click', addColumn);
    document.getElementById('addFilterBtn').addEventListener('click', addFilter);
    document.getElementById('addInputVarBtn').addEventListener('click', addInputVariable);
    document.getElementById('resetTableBtn').addEventListener('click', resetConfiguration);
    saveBtn.addEventListener('click', saveDatatableToDatabase);
    document.getElementById('permissionsBtn').addEventListener('click', () => {
        document.getElementById('menuDropdown').style.display = 'none';
        openPermissionsModal();
    });
    document.getElementById('viewJsonBtn').addEventListener('click', () => {
        document.getElementById('menuDropdown').style.display = 'none';
        document.querySelector('[data-tab="jsonTab"]').click();
    });
    document.getElementById('copyJsonBtn').addEventListener('click', () => {
        navigator.clipboard.writeText(jsonOutput.textContent)
            .then(() => showStatusBanner('Copied to clipboard.', 'success'))
            .catch(() => showStatusBanner('Failed to copy.', 'error'));
    });

    // Menu dropdown toggle
    const menuBtn = document.getElementById('menuBtn');
    const menuDropdown = document.getElementById('menuDropdown');
    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menuDropdown.style.display = menuDropdown.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { menuDropdown.style.display = 'none'; });

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });

    // Save-button validation tooltip hover
    const saveWrapper = saveBtn.parentElement;
    const tooltip = document.getElementById('saveValidationTooltip');
    saveWrapper.addEventListener('mouseenter', () => {
        if (saveBtn.disabled) tooltip.style.display = 'block';
    });
    saveWrapper.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

// Expose row-action handlers used by inline HTML event attributes
window.dtUpdateColumn = updateColumnByIndex;
window.dtMoveColumn = moveColumn;
window.dtRemoveColumn = removeColumn;
window.dtOpenMappingModal = openMappingModal;
window.dtUpdateFilter = updateFilterByIndex;
window.dtRemoveFilter = removeFilter;
window.dtUpdateInputVar = updateInputVariable;
window.dtMoveInputVar = moveInputVariable;
window.dtRemoveInputVar = removeInputVariable;

// ============================================
// PAGE BOOTSTRAP
// ============================================
(async () => {
    initializeApp();

    // Populate the workflow and SQL-datasource <select> options before
    // applying a saved config - setting .value on a <select> that only
    // has the placeholder option (because these hadn't loaded yet)
    // silently fails to select anything, which was leaving Data Workflow/
    // Update Workflow/SQL Database showing the placeholder even when the
    // saved config had a real value.
    await Promise.all([loadAvailableWorkflows(), loadSqlDatasources()]);

    const datatableId = getDatatableIdFromUrl();
    if (datatableId) {
        const config = await getDatatableConfigFromDatabase(datatableId);
        if (config) {
            await applyConfigToForm(config);
            loadedDatatableId = datatableId;
            if (!canAdminEditDatatable) {
                showStatusBanner('You have view-only access to this datatable. Saving is disabled.', 'info');
            }
        } else {
            showStatusBanner('Failed to load datatable configuration.', 'error');
        }
    } else {
        console.log('[INIT] No id URL parameter provided');
    }

    initializeUnsavedTracking(buildDatatableConfig());
    updateOutput();

    setupPageUnsavedChangesProtection(saveDatatableToDatabase, resetUnsavedChangesTracking);

    pageInitialized = true;
})();