// ============================================================================
// PLUGINS MODULE
// ============================================================================
// This module contains all plugin management functions and related UI logic.
// Dependencies: settings.js (for currentUser, sessionToken, helper functions)
// ============================================================================

// ============================================================================
// PLUGIN STATE VARIABLES
// ============================================================================

let pendingPluginCode = '';
let currentPluginName = '';
let currentPluginVersion = 0;
let originalPluginConfig = null;
let currentPlugin = null;  // Store full plugin object
let currentEditingHeaders = [];
let currentDatabases = {};
let selectedSqlDatabaseName = null;
let pluginTasksCache = {};


// ============================================================================
// PLUGIN UI STATE MANAGEMENT
// ============================================================================

function updateSaveButtonState() {
    const saveBtn = document.getElementById('savePluginBtn');
    if (saveBtn) {
        let hasChanges = window.hasUnsavedChanges();
        
        // Also check if headers have changed
        if (!hasChanges && originalPluginConfig) {
            const originalHeaders = originalPluginConfig.config?.headers || [];
            const originalJson = JSON.stringify(originalHeaders);
            const currentJson = JSON.stringify(currentEditingHeaders);
            hasChanges = originalJson !== currentJson;
            if (hasChanges) {
                console.log('Save button activated due to header changes');
            }
        }
        
        saveBtn.disabled = !hasChanges;
    }
}

function openCodeModal(code, onSave) {
    showFormModal('View Code', [{name: 'code', type: 'textarea', label: 'Code', placeholder: '', value: code || '', rows: 15}], (formData) => {
        if (onSave) {
            onSave(formData.code);
        } else {
            // Default behavior if no callback (for existing plugins)
            console.log('Code updated');
        }
    });
}

async function openTasksModal() {
    const pluginName = currentPluginName;
    console.log('[openTasksModal] Plugin name:', pluginName);
    
    if (!pluginName) {
        showStatusBanner('No plugin selected', 'error');
        return;
    }

    const tasks = await fetchPluginTasks(pluginName);
    console.log('[openTasksModal] Tasks fetched:', tasks);
    
    if (tasks.length === 0) {
        showModal({
            title: 'Plugin Tasks',
            content: '<p style="color: var(--text-muted);">No tasks available for this plugin.</p>',
            buttons: [
                {
                    label: 'Close',
                    type: 'secondary',
                    onClick: () => {}
                }
            ]
        });
        return;
    }

    // Build dropdown and task details HTML
    const taskOptions = tasks.map(t => `<option value="${t.task_id}">${escapeHtml(t.display_name)}</option>`).join('');
    
    let tasksHtml = `
        <div id="taskStatusMessage" style="margin-bottom: 15px;"></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; align-items: flex-end;">
            <div>
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Task</label>
                <select id="taskSelector" style="width: 100%;">
                    <option value="">-- Select a Task --</option>
                    ${taskOptions}
                </select>
            </div>
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
                <button type="button" id="saveTaskBtn" class="btn" data-color="green" onclick="saveTaskConfig()" disabled>Save</button>
                <button type="button" class="btn" data-color="secondary" onclick="resetTaskConfig()">Reset</button>
            </div>
        </div>
        <div id="taskDetailsContainer" style="display: none;"></div>
    `;

    showModal({
        title: 'Plugin Tasks',
        content: tasksHtml,
        width: 'auto',
        closeOnBackdrop: false,
        buttons: [
            {
                label: 'Close',
                type: 'secondary',
                onClick: () => {
                    console.log('[Close button] Clicked, unsaved changes:', window.pluginTaskHasUnsavedChanges);
                    if (window.pluginTaskHasUnsavedChanges) {
                        showUnsaved(
                            () => {
                                // Save button clicked - save task config silently and close modal
                                saveTaskConfig(null); // null = suppress status message
                                window.pluginTaskHasUnsavedChanges = false;
                                showStatusBanner('Task saved successfully', 'success', 'pluginsStatusMessage');
                                // Close the modal
                                setTimeout(() => {
                                    document.getElementById('modal-backdrop')?.click();
                                }, 100);
                            },
                            () => {
                                // Discard button clicked - close modal with no message
                                window.pluginTaskHasUnsavedChanges = false;
                                setTimeout(() => {
                                    document.getElementById('modal-backdrop')?.click();
                                }, 100);
                            }
                        );
                        return false; // Prevent closing when showing unsaved dialog
                    }
                    // No unsaved changes, allow close
                    return true;
                }
            }
        ]
    });

    // Store original task configs for reset functionality
    window.pluginTasksOriginalConfigs = {};
    tasks.forEach(task => {
        window.pluginTasksOriginalConfigs[task.task_id] = JSON.parse(JSON.stringify(task));
    });
    window.pluginTasksCurrentConfig = null;

    // Setup task selection handler
    setTimeout(() => {
        const taskSelector = document.getElementById('taskSelector');
        const detailsContainer = document.getElementById('taskDetailsContainer');
        
        if (taskSelector) {
            taskSelector.addEventListener('change', (e) => {
                const taskId = parseInt(e.target.value);
                if (taskId) {
                    const task = tasks.find(t => t.task_id === taskId);
                    if (task) {
                        // Store current config for reset
                        window.pluginTasksCurrentConfig = JSON.parse(JSON.stringify(task));
                        detailsContainer.innerHTML = buildTaskDetailsHtml(task);
                        detailsContainer.style.display = 'block';
                        
                        // Initialize unsaved changes tracking for this task
                        initializeTaskUnsavedTracking(task.task_id);
                    }
                } else {
                    detailsContainer.style.display = 'none';
                    clearTaskUnsavedTracking();
                }
            });
        }
    }, 100);
}

function initializeTaskUnsavedTracking(taskId) {
    const detailsContainer = document.getElementById('taskDetailsContainer');
    const saveBtn = document.getElementById('saveTaskBtn');
    
    // Add change listeners to all input fields in task details
    const inputs = detailsContainer.querySelectorAll('input, select, textarea');
    inputs.forEach(input => {
        input.addEventListener('change', () => {
            if (saveBtn) {
                saveBtn.disabled = false;
            }
            window.pluginTaskHasUnsavedChanges = true;
        });
        input.addEventListener('input', () => {
            if (saveBtn) {
                saveBtn.disabled = false;
            }
            window.pluginTaskHasUnsavedChanges = true;
        });
    });
    
    // Reset unsaved changes flag when initialized
    window.pluginTaskHasUnsavedChanges = false;
}

function clearTaskUnsavedTracking() {
    const saveBtn = document.getElementById('saveTaskBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
    }
    window.pluginTaskHasUnsavedChanges = false;
}

async function saveTaskConfig(statusContainer = 'taskStatusMessage') {
    if (!window.pluginTasksCurrentConfig) {
        showStatusBanner('No task selected', 'warning', statusContainer);
        return;
    }

    const taskId = window.pluginTasksCurrentConfig.task_id;
    const detailsContainer = document.getElementById('taskDetailsContainer');
    const saveBtn = document.getElementById('saveTaskBtn');

    if (!detailsContainer) {
        showStatusBanner('Task details container not found', 'error', statusContainer);
        return;
    }
    
    const endpoint = detailsContainer.querySelector('input[placeholder*="API endpoint"]')?.value || '';
    const methodSelect = detailsContainer.querySelector('select[style*="width"]');
    const method = methodSelect?.value || 'NA';

    const labelField = detailsContainer.querySelector('.plugin-task-label-field')?.value 
        || window.pluginTasksCurrentConfig.label_field 
        || '';

    const valueField = detailsContainer.querySelector('.plugin-task-value-field')?.value 
        || window.pluginTasksCurrentConfig.value_field 
        || '';

    console.log('[saveTaskConfig] Saving task', taskId, { endpoint, method, labelField, valueField });

    const user = getUser();
    const cfg = window.pluginTasksCurrentConfig;

    cfg.endpoint = endpoint;
    cfg.method = method;
    cfg.label_field = labelField;
    cfg.value_field = valueField;

    const result = await executeSqlQuery(
        'cookie',
        user,
        'kore_sys',
        `
            UPDATE kore_sys.plugin_tasks
            SET
                display_name = '${escapeSql(cfg.display_name)}',
                description = '${escapeSql(cfg.description)}',
                static_params = '${escapeSql(JSON.stringify(cfg.static_params || {}))}',
                inputs = '${escapeSql(JSON.stringify(cfg.inputs || []))}',
                outputs = '${escapeSql(JSON.stringify(cfg.outputs || []))}',
                label_field = '${escapeSql(cfg.label_field)}',
                value_field = '${escapeSql(cfg.value_field)}',
                endpoint = '${escapeSql(cfg.endpoint)}',
                method = '${escapeSql(cfg.method)}'
            WHERE task_id = ${Number(cfg.task_id)};
        `
    );

    console.log('[saveTaskConfig] SQL update result:', result);

    if (statusContainer === 'taskStatusMessage') {
        showStatusBanner('Task saved successfully', 'success', statusContainer);
    }
    
    if (saveBtn) {
        saveBtn.disabled = true;
    }

    window.clearUnsavedChanges();
}


function resetTaskConfig() {
    if (!window.pluginTasksCurrentConfig) {
        showStatusBanner('No task selected', 'warning', 'taskStatusMessage');
        return;
    }

    const taskId = window.pluginTasksCurrentConfig.task_id;
    const originalConfig = window.pluginTasksOriginalConfigs[taskId];
    const saveBtn = document.getElementById('saveTaskBtn');
    
    if (originalConfig) {
        window.pluginTasksCurrentConfig = JSON.parse(JSON.stringify(originalConfig));
        const detailsContainer = document.getElementById('taskDetailsContainer');
        detailsContainer.innerHTML = buildTaskDetailsHtml(originalConfig);
        showStatusBanner('Task reset to original configuration', 'info', 'taskStatusMessage');
        
        // Reset unsaved changes and disable save button
        if (saveBtn) {
            saveBtn.disabled = true;
        }
        window.clearUnsavedChanges();
        
        // Re-initialize unsaved tracking with the reset content
        initializeTaskUnsavedTracking(taskId);
    }
}

function buildTaskDetailsHtml(task) {
    let html = '';
    
    // Description (full width)
    if (task.description) {
        html += `
            <div style="margin-bottom: 20px;">
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Description</label>
                <textarea readonly style="width: 100%; height: 60px; padding: 8px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px; resize: none;">${escapeHtml(task.description)}</textarea>
            </div>
        `;
    }
    
    // Two-column layout
    html += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">';
    
    // LEFT COLUMN
    html += '<div>';
    
    // Result Format (left column)
    if (task.label_field || task.value_field) {
        html += `
            <div style="margin-bottom: 20px;">
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 8px; font-weight: 600;">Result Format</label>
        `;
        
        if (task.label_field) {
            html += `
                <div style="margin-bottom: 8px;">
                    <input type="text" value="${escapeHtml(task.label_field)}" style="width: 100%;">
                </div>
            `;
        }
        
        html += `
            </div>
        `;
    }

    // Value Field (left column, below Result Format)
    if (task.value_field) {
        html += `
            <div style="margin-bottom: 20px;">
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Value Field</label>
                <input type="text" value="${escapeHtml(task.value_field)}" style="width: 100%;">
            </div>
        `;
    }
    
    // Static Parameters (left column)
    html += `
        <div style="margin-bottom: 20px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 8px; font-weight: 600;">Static Parameters</label>
            <button type="button" class="btn" data-color="green" data-size="sm" style="margin-bottom: 10px; width: 100%;" onclick="addDictEntry('staticParamsContainer_${task.task_id}')">Add Parameter</button>
            <div id="staticParamsContainer_${task.task_id}" style="display: flex; flex-direction: column; gap: 3px;"></div>
        </div>
    `;
    
    html += '</div>'; // End left column
    
    // RIGHT COLUMN
    html += '<div>';
    
    // Endpoint (right column, top)
    html += `
        <div style="margin-bottom: 20px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Endpoint</label>
            <input type="text" value="${escapeHtml(task.endpoint || '')}" placeholder="API endpoint (if applicable)" style="width: 100%;">
        </div>
    `;
    
    // Method (right column, top)
    html += `
        <div style="margin-bottom: 20px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Method</label>
            <select style="width: 100%;">
                <option value="NA" ${(task.method || 'NA') === 'NA' ? 'selected' : ''}>NA</option>
                <option value="GET" ${(task.method || 'NA') === 'GET' ? 'selected' : ''}>GET</option>
                <option value="PUT" ${(task.method || 'NA') === 'PUT' ? 'selected' : ''}>PUT</option>
                <option value="POST" ${(task.method || 'NA') === 'POST' ? 'selected' : ''}>POST</option>
            </select>
        </div>
    `;
    
    // Input Parameters (right column)
    html += `
        <div style="margin-bottom: 20px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 8px; font-weight: 600;">Input Parameters</label>
            <button type="button" class="btn" data-color="green" data-size="sm" style="margin-bottom: 10px; width: 100%;" onclick="addListEntry('inputsContainer_${task.task_id}')">Add Input</button>
            <div id="inputsContainer_${task.task_id}" style="display: flex; flex-direction: column; gap: 8px;">
    `;
    
    if (!task.inputs || task.inputs.length === 0) {
        html += '<p style="color: var(--text-muted); font-size: 12px; padding: 8px;">No inputs yet</p>';
    } else {
        task.inputs.forEach(input => {
            html += `
                <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; padding: 8px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 4px;">
                    <input type="text" value="${escapeHtml(input.name || '')}" placeholder="Name" >
                    <input type="text" value="${escapeHtml(input.label || '')}" placeholder="Label" >
                    <button type="button" class="btn" data-color="red" data-size="sm" onclick="this.parentElement.remove()">&#128711;</button>
                </div>
            `;
        });
    }
    
    html += `
            </div>
        </div>
    `;
    
    // Output Fields (right column)
    html += `
        <div style="margin-bottom: 20px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 8px; font-weight: 600;">Output Fields</label>
            <button type="button" class="btn" data-color="green" data-size="sm" style="margin-bottom: 10px; width: 100%;" onclick="addListEntry('outputsContainer_${task.task_id}')">Add Output</button>
            <div id="outputsContainer_${task.task_id}" style="display: flex; flex-direction: column; gap: 3px;">
    `;
    
    if (!task.outputs || task.outputs.length === 0) {
        html += '<p style="color: var(--text-muted); font-size: 12px; padding: 3px;">No outputs yet</p>';
    } else {
        task.outputs.forEach(output => {
            html += `
                <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 3px; align-items: center; padding: 3px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 4px;">
                    <input type="text" value="${escapeHtml(output.name || '')}" placeholder="Name" >
                    <input type="text" value="${escapeHtml(output.label || '')}" placeholder="Label" >
                    <button type="button" class="btn" data-color="red" data-size="sm" onclick="this.parentElement.remove()">&#128711;</button>
                </div>
            `;
        });
    }
    
    html += `
            </div>
        </div>
    `;
    
    html += '</div>'; // End right column
    html += '</div>'; // End grid
    
    // Populate static params after creating the container
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const staticParamsContainer = tempDiv.querySelector(`#staticParamsContainer_${task.task_id}`);
    if (staticParamsContainer) {
        Object.entries(task.static_params || {}).forEach(([key, value]) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr auto; gap: 3px; align-items: center;';
            row.innerHTML = `
                <input type="text" value="${escapeHtml(key)}" placeholder="Key" >
                <input type="text" value="${escapeHtml(String(value))}" placeholder="Value" >
                <button type="button" class="btn" data-color="red" data-size="sm" onclick="this.parentElement.remove()">&#128711;</button>
            `;
            staticParamsContainer.appendChild(row);
        });
    }
    
    return tempDiv.innerHTML;
}

function addDictEntry(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const html = `
        <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center;">
            <input type="text" placeholder="Key" >
            <input type="text" placeholder="Value" >
            <button type="button" class="btn" data-color="red" data-size="sm" onclick="this.parentElement.remove()">&#128711;</button>
        </div>
    `;
    container.insertAdjacentHTML('beforeend', html);
}

function addListEntry(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Remove "No items" message if present
    const noItemsMsg = container.querySelector('p[style*="color: var(--text-muted)"]');
    if (noItemsMsg) noItemsMsg.remove();

    const html = `
        <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; padding: 8px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 4px;">
            <input type="text" placeholder="Name" >
            <input type="text" placeholder="Label" >
            <button type="button" class="btn" data-color="red" data-size="sm" onclick="this.parentElement.remove()">&#128711;</button>
        </div>
    `;
    container.insertAdjacentHTML('beforeend', html);
}


async function fetchPluginTasks(pluginName) {
    console.log('[fetchPluginTasks] Called for plugin:', pluginName);
    // Return from cache if already loaded
    if (pluginTasksCache[pluginName]) {
        console.log('[fetchPluginTasks] Returning cached tasks:', pluginTasksCache[pluginName]);
        return pluginTasksCache[pluginName];
    }
    try {
        console.log('[fetchPluginTasks] currentPlugin:', currentPlugin);
        if (!currentPlugin) {
            console.log('[fetchPluginTasks] No currentPlugin, returning empty array');
            return [];
        }
        const user = getUser();
        console.log('[fetchPluginTasks] User:', user, 'Plugin ID:', currentPlugin.id);
        const result = await executeSqlQuery(
            'cookie', user, 'kore_sys',
            `SELECT task_id, display_name, description, static_params, inputs, outputs, label_field, value_field, endpoint, method
             FROM kore_sys.plugin_tasks
             WHERE plugin_id = ${currentPlugin.id} AND active = TRUE
             ORDER BY display_name`
        );
        console.log('[fetchPluginTasks] SQL Query result:', result);
        const tasks = (result?.result || []).map(t => ({
            ...t,
            static_params: typeof t.static_params === 'object' ? t.static_params : JSON.parse(t.static_params || '{}'),
            inputs: typeof t.inputs === 'object' ? t.inputs : JSON.parse(t.inputs || '[]'),
            outputs: typeof t.outputs === 'object' ? t.outputs : JSON.parse(t.outputs || '[]')
        }));
        console.log('[fetchPluginTasks] Parsed tasks:', tasks);
        pluginTasksCache[pluginName] = tasks;
        return tasks;
    } catch (err) {
        console.error('[Plugin Tasks] Failed to load for plugin:', pluginName, err);
        return [];
    }
}


// ============================================================================
// PLUGIN CRUD OPERATIONS
// ============================================================================

async function openAddPluginModal() {
    try {
        const sessionTokenLocal = await window.getSessionToken();
        const result = await window.executeSqlQuery(
            sessionTokenLocal,
            currentUser,
            'kore_sys',
            'SELECT plugin_config FROM system_config LIMIT 1'
        );

        if (!result.result || result.result.length === 0) {
            showStatusBanner('Unable to load plugin configuration', 'error');
            return;
        }

        let config;
        try {
            config = typeof result.result[0].plugin_config === 'string' 
                ? JSON.parse(result.result[0].plugin_config) 
                : result.result[0].plugin_config;
        } catch (e) {
            showStatusBanner('Error parsing plugin configuration', 'error');
            return;
        }

        if (!config || !config.types) {
            showStatusBanner('Unable to load plugin configuration', 'error');
            return;
        }

        const fields = [];

        // Type field FIRST - always visible
        fields.push({
            name: 'pluginType',
            type: 'select',
            label: 'Type',
            options: ['', ...Object.keys(config.types)],
            required: true,
            value: ''
        });

        // Basic Information Section - hide until type selected
        fields.push({ type: 'section', label: 'Basic Information', pluginTypes: ['api', 'service'] });

        // These fields show when a type is selected
        fields.push({
            name: 'pluginName',
            type: 'text',
            label: 'Name',
            placeholder: 'plugin-name (no spaces)',
            required: true,
            value: '',
            pluginTypes: ['api', 'service']
        });
        fields.push({
            name: 'pluginDisplayName',
            type: 'text',
            label: 'Display Name',
            required: true,
            value: '',
            pluginTypes: ['api', 'service']
        });
        fields.push({
            name: 'pluginDescription',
            type: 'textarea',
            label: 'Description',
            rows: 2,
            value: '',
            pluginTypes: ['api', 'service']
        });
        fields.push({
            name: 'configRateLimit',
            type: 'number',
            label: 'Rate Limit (req/min)',
            required: true,
            value: '100',
            pluginTypes: ['api', 'service']
        });
        fields.push({
            name: 'configRoutes',
            type: 'textarea',
            label: 'Routes',
            placeholder: '/route1\n/route2',
            required: true,
            rows: 2,
            value: '',
            pluginTypes: ['api', 'service']
        });
        fields.push({
            name: 'pluginEnabled',
            type: 'checkbox',
            label: 'Enabled',
            checked: true,
            pluginTypes: ['api', 'service']
        });

        // API-only fields
        fields.push({
            name: 'viewCode',
            type: 'button',
            label: 'View Code',
            buttonText: 'View Code',
            onClick: () => {
                openCodeModal(pendingPluginCode, (code) => {
                    pendingPluginCode = code;
                });
            },
            pluginTypes: ['api']
        });
        fields.push({
            name: 'baseUrl',
            type: 'text',
            label: 'Base URL',
            required: true,
            value: '',
            pluginTypes: ['api']
        });
        fields.push({
            name: 'apiPath',
            type: 'text',
            label: 'API Path',
            required: true,
            value: '',
            pluginTypes: ['api']
        });
        fields.push({
            name: 'authType',
            type: 'select',
            label: 'Auth Type',
            options: ['', 'bearer', 'oauth'],
            required: true,
            value: '',
            pluginTypes: ['api']
        });

        // Auth-specific fields
        fields.push({
            name: 'apiKey',
            type: 'password',
            label: 'API Key',
            required: true,
            value: '',
            authTypes: ['bearer'],
            pluginTypes: ['api']
        });
        fields.push({
            name: 'publicKey',
            type: 'textarea',
            label: 'Public Key',
            required: true,
            rows: 2,
            value: '',
            authTypes: ['oauth'],
            pluginTypes: ['api']
        });
        fields.push({
            name: 'privateKey',
            type: 'textarea',
            label: 'Private Key',
            required: true,
            rows: 2,
            value: '',
            authTypes: ['oauth'],
            pluginTypes: ['api']
        });

        // Custom headers field
        fields.push({
            name: 'headers',
            type: 'custom:headers',
            label: 'Additional Headers',
            required: false,
            pluginTypes: ['api']
        });

        // Show the form modal
        showFormModal('Add Plugin', fields, async (formData) => {
            // Extract headers from DOM since custom:headers field doesn't populate formData
            const headerDivs = document.querySelectorAll('[id^="header_"]');
            const headers = [];
            headerDivs.forEach(div => {
                const inputs = div.querySelectorAll('input[type="text"]');
                if (inputs.length === 2) {
                    const key = inputs[0].value.trim();
                    const value = inputs[1].value.trim();
                    if (key && value) {
                        headers.push({ key, value });
                    }
                }
            });
            
            if (headers.length > 0) {
                formData.headers = headers;
            }
            
            if (!formData.pluginType) {
                window.showStatusBanner('Please select a plugin type', 'error', 'pluginsStatusMessage');
                return;
            }

            // Transform flat form data into plugin structure
            const code = pendingPluginCode;
            pendingPluginCode = ''; // Reset for next time
            
            const pluginType = formData.pluginType;
            
            const pluginData = {
                name: formData.pluginName,
                display_name: formData.pluginDisplayName,
                description: formData.pluginDescription,
                enabled: formData.pluginEnabled ? 1 : 0,
                version: 1,
                code: code,
                config: {
                    type: pluginType,
                    rateLimit: parseInt(formData.configRateLimit) || 100,
                    routes: formData.configRoutes.split('\n').filter(r => r.trim())
                }
            };
            
            // Add API-specific config
            if (pluginType === 'api') {
                pluginData.config.baseUrl = formData.baseUrl;
                pluginData.config.apiPath = formData.apiPath;
                pluginData.config.authType = formData.authType;
                
                // Add auth-specific fields
                if (formData.authType === 'bearer' && formData.apiKey) {
                    pluginData.config.apiKey = formData.apiKey;
                } else if (formData.authType === 'oauth') {
                    pluginData.config.publicKey = formData.publicKey;
                    pluginData.config.privateKey = formData.privateKey;
                }
                
                // Add headers if any
                if (formData.headers && Array.isArray(formData.headers) && formData.headers.length > 0) {
                    pluginData.config.headers = formData.headers;
                }
            }
            
            pluginData.username = currentUser;
            
            try {
                const response = await addPlugin(pluginData);
                
                if (response.status === 201) {
                    window.showStatusBanner('Plugin created successfully!', 'success', 'pluginsStatusMessage');
                    await loadPluginsList();
                } else {
                    const error = await response.json();
                    window.showStatusBanner('Error: ' + (error.error || 'Unknown error'), 'error', 'pluginsStatusMessage');
                }
            } catch (error) {
                window.showStatusBanner('Error saving plugin: ' + error.message, 'error', 'pluginsStatusMessage');
            }
        });
    } catch (error) {
        showStatusBanner('Error loading plugin configuration', 'error');
    }
}

async function addPlugin(pluginPayload) {
    const response = await fetch('https://app.equinoxits.com:1139/kore/plugins/add', {
        method: 'POST',
        headers: {
            'X-Session-Token': sessionToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(pluginPayload)
    });
    return response;
}

function getCurrentPluginFormData() {
    const data = {
        name: currentPluginName,
        display_name: document.getElementById('pluginDisplayName').value,
        description: document.getElementById('pluginDescription').value,
        enabled: document.getElementById('pluginEnabled').checked,
        type: document.getElementById('configTypeValue').textContent,
        rateLimit: parseInt(document.getElementById('configRateLimit').value) || 0,
        routes: document.getElementById('configRoutes').value,
        baseUrl: document.getElementById('configBaseUrl').value,
        apiPath: document.getElementById('configApiPath').value,
        apiKey: document.getElementById('configApiKey').value,
        clientBaseUrl: document.getElementById('configClientBaseUrl').value,
        clientApiPath: document.getElementById('configClientApiPath').value,
        clientId: document.getElementById('configClientId').value,
        publicKey: document.getElementById('configPublicKey').value,
        privateKey: document.getElementById('configPrivateKey').value,
        databases: currentDatabases,
        headers: currentEditingHeaders  // Include headers in form data
    };
    return data;
}


// ============================================================================
// PLUGIN LIST LOADING & DISPLAY
// ============================================================================

async function reloadAllPlugins() {
    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/reload-all`, {
            method: 'POST',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (response.ok) {
            showStatusBanner('All plugins reloaded successfully.', 'success');
        } else {
            showStatusBanner('Error reloading plugins: ' + (data.message || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Error reloading all plugins:', error);
        showStatusBanner('Error reloading plugins', 'error');
    }
}

async function loadPluginsList() {
    console.log('loadPluginsList called');
    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        console.log('Fetching plugins list...');
        const response = await fetch('https://app.equinoxits.com:1139/kore/plugins/list', {
            method: 'GET',
            headers: {
                'X-Session-Token': sessionToken
            }
        });

        const data = await response.json();
        console.log('Plugins list response:', response.ok, data);

        if (response.ok && data.plugins) {
            console.log('Displaying plugins:', data.plugins.map(p => p.name));
            displayPlugins(data.plugins);
        } else {
            document.getElementById('pluginListSidebar').innerHTML = '<p style="color: var(--text-muted);">No plugins loaded</p>';
        }
    } catch (error) {
        console.error('Error loading plugins:', error);
        document.getElementById('pluginListSidebar').innerHTML = '<p style="color: var(--text-muted);">Error loading plugins: ' + error.message + '</p>';
    }
}

function displayPlugins(plugins) {
    console.log('displayPlugins called with:', plugins);
    const sidebar = document.getElementById('pluginListSidebar');
    console.log('Plugin sidebar element:', sidebar);
    
    if (!plugins || plugins.length === 0) {
        sidebar.innerHTML = '<p style="color: var(--text-muted); font-size: 11px; margin: 0;">No plugins found</p>';
        return;
    }

    let html = '';
    plugins.slice().sort((a, b) => (a.display_name || a.name || '').localeCompare(b.display_name || b.name || '')).forEach(plugin => {
        const displayName = plugin.display_name || plugin.name;
        html += `
            <button class="btn" data-color="theme-neutral" data-size="sm" onclick="selectPluginFromList('${escapeHtml(plugin.name)}', this)" 
                    style="width: 100%; text-align: center;">
                ${escapeHtml(displayName)}
            </button>
        `;
    });

    console.log('Setting sidebar HTML with', plugins.length, 'plugins');
    sidebar.innerHTML = html;
}


// ============================================================================
// PLUGIN SELECTION & FORM MANAGEMENT
// ============================================================================

function selectPluginFromList(pluginName, buttonElement) {
    console.log('selectPluginFromList - checking for unsaved changes');
    const formData = getCurrentPluginFormData();
    const hasUnsaved = window.checkUnsavedChanges(formData);
    console.log('selectPluginFromList - formData:', formData);
    console.log('selectPluginFromList - hasUnsaved:', hasUnsaved, 'currentPluginName:', currentPluginName);
    
    if (hasUnsaved && currentPluginName && currentPluginName !== pluginName) {
        window.showUnsaved(
            async () => {
                // Save the current SQL database form if one is being edited
                if (selectedSqlDatabaseName) {
                    saveSqlDatabaseForm(selectedSqlDatabaseName);
                }
                // Now save the plugin settings
                await savePluginSettings();
                doSelectPluginFromList(pluginName, buttonElement);
            },
            () => {
                doSelectPluginFromList(pluginName, buttonElement);
            }
        );
    } else {
        doSelectPluginFromList(pluginName, buttonElement);
    }
}

function doSelectPluginFromList(pluginName, buttonElement) {
    loadPluginDetails(pluginName);
    
    // Reset all buttons to theme-neutral color
    const buttons = document.querySelectorAll('#pluginListSidebar button');
    buttons.forEach(btn => {
        btn.setAttribute('data-color', 'theme-neutral');
    });
    
    // Highlight the selected button with theme-brand
    if (buttonElement) {
        buttonElement.setAttribute('data-color', 'theme-brand');
    }
    
    window.clearUnsavedChanges();
}

function cancelPluginSelection() {
    // Reset all sidebar buttons to unselected state
    const buttons = document.querySelectorAll('#pluginListSidebar button');
    buttons.forEach(btn => {
        btn.setAttribute('data-color', 'theme-neutral');
    });
    
    // Hide settings container, show placeholder
    document.getElementById('pluginSettingsContainer').style.display = 'none';
    document.getElementById('pluginPlaceholder').style.display = 'block';
    
    // Hide reload button
    document.getElementById('reloadPluginBtn').style.display = 'none';
    currentPluginName = '';
    window.clearUnsavedChanges();
    updateSaveButtonState();
}


// ============================================================================
// PLUGIN DETAILS LOADING & POPULATION
// ============================================================================

async function loadPluginDetails(pluginName) {
    if (!pluginName) {
        return;
    }

    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        console.log('Fetching plugin details for:', pluginName);
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/details?name=${encodeURIComponent(pluginName)}`, {
            method: 'GET',
            headers: {
                'X-Session-Token': sessionToken
            }
        });

        const data = await response.json();
        console.log('Plugin fetch response:', response.ok, data);

        if (response.ok && data.plugin) {
            console.log('Calling populatePluginForm with:', data.plugin);
            populatePluginForm(data.plugin);
        } else {
            showStatusBanner('Plugin not found: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Plugin fetch error:', error);
        showStatusBanner('Error loading plugin details: ' + error.message, 'error');
    }
}

function populatePluginForm(plugin) {
    // Store plugin info in memory
    currentPlugin = plugin;  // Store full plugin object
    currentPluginName = plugin.name;
    currentPluginVersion = plugin.version || 0;
    originalPluginConfig = JSON.parse(JSON.stringify(plugin));  // Deep copy of original plugin

    // Show settings container, hide placeholder
    document.getElementById('pluginSettingsContainer').style.display = 'flex';
    document.getElementById('pluginPlaceholder').style.display = 'none';
    
    // Show reload button
    document.getElementById('reloadPluginBtn').style.display = 'inline-block';

    // Update header
    document.getElementById('headerPluginName').textContent = plugin.name;
    document.getElementById('headerPluginVersion').textContent = plugin.version || '0';

    // Basic info
    document.getElementById('pluginDisplayName').value = plugin.display_name || '';
    document.getElementById('pluginDescription').value = plugin.description || '';
    document.getElementById('pluginEnabled').checked = plugin.enabled === 1 || plugin.enabled === true;

    // Metadata
    document.getElementById('pluginCreatedAt').value = plugin.created_at || '';
    document.getElementById('pluginCreatedBy').value = plugin.created_by || '';
    document.getElementById('pluginUpdatedAt').value = plugin.updated_at || '';
    document.getElementById('pluginUpdatedBy').value = plugin.updated_by || '';

    // Config
    const config = plugin.config || {};
    document.getElementById('configTypeValue').textContent = config.type || '';
    document.getElementById('configRateLimit').value = config.rateLimit || 100;
    document.getElementById('configRoutes').value = Array.isArray(config.routes) ? config.routes.join('\n') : '';

    // Show/hide API fields based on plugin type
    const apiFieldsContainer = document.getElementById('apiFieldsContainer');
    const bearerAuthFields = document.getElementById('bearerAuthFields');
    const clientAuthFields = document.getElementById('clientAuthFields');
    const sqlFieldsContainer = document.getElementById('sqlFieldsContainer');

    // Hide all configuration panels by default
    if (apiFieldsContainer) apiFieldsContainer.style.display = 'none';
    if (sqlFieldsContainer) sqlFieldsContainer.style.display = 'none';

    if (config.type === 'api') {
        if (apiFieldsContainer) apiFieldsContainer.style.display = 'block';
        
        // Determine auth type based on fields present
        // Check for publicKey/privateKey (client auth pattern) or apiKey (bearer auth pattern)
        if (config.publicKey || config.privateKey) {
            // Client/OAuth auth (includes MeshCentral, CWM, etc.)
            if (bearerAuthFields) bearerAuthFields.style.display = 'none';
            if (clientAuthFields) clientAuthFields.style.display = 'block';
            document.getElementById('configClientBaseUrl').value = config.baseUrl || '';
            document.getElementById('configClientApiPath').value = config.apiPath || '';
            document.getElementById('configClientId').value = config.clientId || '';
            document.getElementById('configPublicKey').value = config.publicKey || '';
            document.getElementById('configPrivateKey').value = config.privateKey || '';
        } else if (config.apiKey) {
            // Bearer token auth (Snipe-IT, etc.)
            if (bearerAuthFields) bearerAuthFields.style.display = 'block';
            if (clientAuthFields) clientAuthFields.style.display = 'none';
            document.getElementById('configBaseUrl').value = config.baseUrl || '';
            document.getElementById('configApiPath').value = config.apiPath || '';
            document.getElementById('configApiKey').value = config.apiKey || '';
        }
    } else if (config.type === 'sql') {
        // SQL type - show SQL Configurations panel
        if (sqlFieldsContainer) sqlFieldsContainer.style.display = 'block';
        
        // Initialize currentDatabases from config
        currentDatabases = JSON.parse(JSON.stringify(config.databases || {}));
        
        // Populate SQL database dropdown
        const dbSelect = document.getElementById('sqlDatabaseSelect');
        dbSelect.innerHTML = '<option value="">-- Select Database --</option>';
        for (const dbName in currentDatabases) {
            const option = document.createElement('option');
            option.value = dbName;
            option.textContent = dbName;
            dbSelect.appendChild(option);
        }
        
        // Hide the form and disable buttons since nothing is selected
        const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
        if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'none';
        const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
        const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
        const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
        if (testBtn) testBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (deleteBtn) deleteBtn.disabled = true;
    }
    
    // Store headers for editing BEFORE initializing unsaved changes tracking
    if (config.type === 'api') {
        currentEditingHeaders = JSON.parse(JSON.stringify(config.headers || []));
    }
    
    // Initialize unsaved changes tracking after all fields are populated
    const formData = getCurrentPluginFormData();
    console.log('populatePluginForm - Initial form data:', formData);
    console.log('populatePluginForm - Original config:', plugin.config);
    window.initializeUnsavedTracking(formData);
    console.log('populatePluginForm - Unsaved changes after init:', window.hasUnsavedChanges());
    updateSaveButtonState();
}


// ============================================================================
// PLUGIN HEADERS MANAGEMENT
// ============================================================================

/**
 * Open modal to edit headers for API plugin
 */
function openEditHeadersModal() {
    console.log('openEditHeadersModal - currentEditingHeaders:', currentEditingHeaders);
    
    const fields = [
        {
            name: 'headers',
            type: 'custom:headers',
            label: 'Additional Headers',
            required: false
        }
    ];

    showFormModal('Edit Headers', fields, async (formData) => {
        // Extract headers from DOM since custom:headers field doesn't populate formData
        const headerDivs = document.querySelectorAll('[id^="header_"]');
        const headers = [];
        headerDivs.forEach(div => {
            const inputs = div.querySelectorAll('input[type="text"]');
            if (inputs.length === 2) {
                const key = inputs[0].value.trim();
                const value = inputs[1].value.trim();
                if (key && value) {
                    headers.push({ key, value });
                }
            }
        });
        
        console.log('Headers extracted from modal:', headers);
        console.log('Previous headers:', currentEditingHeaders);
        
        // Check if headers actually changed
        const oldHeadersJson = JSON.stringify(currentEditingHeaders);
        const newHeadersJson = JSON.stringify(headers);
        
        console.log('Headers changed?', oldHeadersJson !== newHeadersJson);
        
        if (oldHeadersJson !== newHeadersJson) {
            // Headers changed, update
            currentEditingHeaders = headers;
            console.log('Updated currentEditingHeaders to:', currentEditingHeaders);
        }
        
        updateSaveButtonState();
    });
    
    // Wait for modal to render, then populate existing headers
    setTimeout(() => {
        console.log('Looking for Add Header button...');
        
        // Find the "Add Header" button
        const addHeaderBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.trim() === 'Add Header');
        console.log('Add Header button:', addHeaderBtn);
        
        if (addHeaderBtn && addHeaderBtn.parentElement) {
            const container = addHeaderBtn.parentElement;
            
            currentEditingHeaders.forEach((header, index) => {
                const rowId = 'header_' + (Date.now() + index);
                const headerDiv = document.createElement('div');
                headerDiv.id = rowId;
                headerDiv.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-bottom: 8px;';
                headerDiv.innerHTML = `
                    <input type="text" placeholder="Header name" value="${header.key || ''}" style="flex: 1; padding: 6px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px;">
                    <input type="text" placeholder="Header value" value="${header.value || ''}" style="flex: 2; padding: 6px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px;">
                    <button type="button" class="btn" data-color="red" data-size="sm" onclick="document.getElementById('${rowId}').remove()">Remove</button>
                `;
                
                console.log('Inserting header before Add Header button:', header);
                container.insertBefore(headerDiv, addHeaderBtn);
            });
        } else {
            console.log('Could not find Add Header button or its parent');
        }
    }, 100);
}


// ============================================================================
// SQL DATABASE MANAGEMENT (Plugin-related)
// ============================================================================

function selectSqlDatabase() {
    const dbSelect = document.getElementById('sqlDatabaseSelect');
    const dbName = dbSelect.value;
    
    if (!dbName) {
        const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
        if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'none';
        const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
        const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
        const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
        if (testBtn) testBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (deleteBtn) deleteBtn.disabled = true;
        return;
    }
    
    selectedSqlDatabaseName = dbName;  // Store original name
    const db = currentDatabases[dbName];
    
    if (db) {
        document.getElementById('sqlDbType').value = db.type || '';
        document.getElementById('sqlDbHost').value = db.host || '';
        document.getElementById('sqlDbPort').value = db.port || '';
        document.getElementById('sqlDbUser').value = db.user || '';
        document.getElementById('sqlDbPassword').value = '';  // Don't show stored password
        document.getElementById('sqlDbDatabase').value = db.database || '';
        document.getElementById('sqlDbEncrypt').checked = db.encrypt || false;
        document.getElementById('sqlDbTrustServerCert').checked = db.trustServerCert || false;
    }
    
    updateSqlDbTypeFields();
    const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
    if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'block';
    const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
    const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
    const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
    if (testBtn) testBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    if (deleteBtn) deleteBtn.disabled = false;
}

function saveSqlDatabaseForm(dbNameOrOriginal) {
    const name = dbNameOrOriginal || document.getElementById('sqlDbName').value;
    
    if (!name) {
        showStatusBanner('Database name is required', 'error');
        return;
    }
    
    // If renaming, delete the old entry
    if (selectedSqlDatabaseName && selectedSqlDatabaseName !== name) {
        delete currentDatabases[selectedSqlDatabaseName];
    }
    
    currentDatabases[name] = {
        name: name,
        type: document.getElementById('sqlDbType').value,
        host: document.getElementById('sqlDbHost').value,
        port: parseInt(document.getElementById('sqlDbPort').value) || 1433,
        user: document.getElementById('sqlDbUser').value,
        password: document.getElementById('sqlDbPassword').value,
        database: document.getElementById('sqlDbDatabase').value,
        encrypt: document.getElementById('sqlDbEncrypt').checked,
        trustServerCert: document.getElementById('sqlDbTrustServerCert').checked
    };
    
    // Update dropdown
    const dbSelect = document.getElementById('sqlDatabaseSelect');
    let option = Array.from(dbSelect.options).find(opt => opt.value === selectedSqlDatabaseName);
    
    if (option) {
        option.value = name;
        option.textContent = name;
    } else {
        option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        dbSelect.appendChild(option);
    }
    
    dbSelect.value = name;
    selectedSqlDatabaseName = name;  // Update tracked name
}

async function testSqlConnection() {
    const dbName = selectedSqlDatabaseName;
    
    if (!dbName) {
        showStatusBanner('Please select a database', 'error');
        return;
    }
    
    // Save form first
    saveSqlDatabaseForm(dbName);
    
    const db = currentDatabases[dbName];
    const testQuery = db.type === 'mysql' ? 'SELECT 1' : 'SELECT 1';
    
    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        // Use the executeSqlQuery function with the configuration name
        const result = await window.executeSqlQuery(sessionToken, 'admin', dbName, testQuery);
        
        const resultDiv = document.getElementById('sqlTestResult');
        if (result.success) {
            resultDiv.innerHTML = `<p style="color: #4caf50; margin: 0;">✓ Connection successful</p>`;
            resultDiv.style.display = 'block';
        } else {
            resultDiv.innerHTML = `<p style="color: #b8242f; margin: 0;">✗ Connection failed: ${result.error}</p>`;
            resultDiv.style.display = 'block';
        }
    } catch (error) {
        const resultDiv = document.getElementById('sqlTestResult');
        resultDiv.innerHTML = `<p style="color: #b8242f; margin: 0;">✗ Error: ${error.message}</p>`;
        resultDiv.style.display = 'block';
    }
}

function updateSqlDbTypeFields() {
    const dbType = document.getElementById('sqlDbType').value;
    const mssqlFields = document.querySelectorAll('[id^="sqlDbEncrypt"], [id^="sqlDbTrustServerCert"]').forEach(el => {
        el.parentElement.style.display = dbType === 'mssql' ? 'flex' : 'none';
    });
}

function addSqlDatabase() {
    const dbSelect = document.getElementById('sqlDatabaseSelect');
    const form = document.getElementById('sqlDatabaseForm');
    
    // Clear dropdown selection
    dbSelect.value = '';
    selectedSqlDatabaseName = null;  // No original name for new database
    
    // Hide test result banner
    const resultDiv = document.getElementById('sqlTestResult');
    resultDiv.style.display = 'none';
    
    // Clear all form fields
    document.getElementById('sqlDbType').value = '';
    document.getElementById('sqlDbHost').value = '';
    document.getElementById('sqlDbPort').value = '';
    document.getElementById('sqlDbUser').value = '';
    document.getElementById('sqlDbPassword').value = '';
    document.getElementById('sqlDbDatabase').value = '';
    document.getElementById('sqlDbEncrypt').checked = false;
    document.getElementById('sqlDbTrustServerCert').checked = false;
    
    updateSqlDbTypeFields();
    if (form) form.style.display = 'block';
}

function doCancelSqlDatabase() {
    document.getElementById('sqlDatabaseSelect').value = '';
    const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
    if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'none';
    const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
    const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
    const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
    if (testBtn) testBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;
    selectedSqlDatabaseName = null;
    window.clearUnsavedChanges();
}

function cancelSqlDatabase() {
    if (window.checkUnsavedChanges(getCurrentPluginFormData())) {
        window.showUnsaved(
            () => {
                // Save the current SQL database form
                if (selectedSqlDatabaseName) {
                    saveSqlDatabaseForm(selectedSqlDatabaseName);
                }
                window.clearUnsavedChanges();
            },
            doCancelSqlDatabase
        );
    } else {
        doCancelSqlDatabase();
    }
}

function deleteSqlDatabase() {
    const dbSelect = document.getElementById('sqlDatabaseSelect');
    const dbName = dbSelect.value;
    
    if (!dbName) {
        showStatusBanner('No database selected', 'error');
        return;
    }
    
    showConfirmModal('Delete SQL Configuration', `Delete SQL configuration "${dbName}"? This cannot be undone.`, () => {
        // Remove from currentDatabases
        delete currentDatabases[dbName];
        
        // Remove from dropdown
        const option = Array.from(dbSelect.options).find(opt => opt.value === dbName);
        if (option) {
            option.remove();
        }
        
        // Reset form and buttons
        const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
        if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'none';
        dbSelect.value = '';
        const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
        const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
        const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');
        if (testBtn) testBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (deleteBtn) deleteBtn.disabled = true;
        
        showStatusBanner(`SQL configuration "${dbName}" deleted.`, 'success');
    });
}


// ============================================================================
// PLUGIN SETTINGS SAVE & RELOAD
// ============================================================================

/**
 * Reload Plugin modal state
 */
async function openReloadPluginModal() {
    const pluginName = currentPluginName;
    if (!pluginName) {
        showStatusBanner('No plugin selected', 'error');
        return;
    }

    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/load?name=${encodeURIComponent(pluginName)}`, {
            method: 'POST',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (response.ok) {
            showStatusBanner(`Plugin "${pluginName}" reloaded successfully.`, 'success');
        } else {
            showStatusBanner('Error reloading plugin: ' + (data.message || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Error reloading plugin:', error);
        showStatusBanner('Error reloading plugin', 'error');
    }
}

async function savePluginSettings() {
    const pluginName = currentPluginName;
    const btn = document.getElementById('savePluginBtn');
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        // Build the update object from form values
        // Increment version: "1.0" -> "1.1", "1.9" -> "1.10", etc.
        let newVersion = '1.0';
        if (currentPluginVersion) {
            const parts = currentPluginVersion.toString().split('.');
            if (parts.length === 2) {
                const major = parseInt(parts[0]) || 1;
                const minor = (parseInt(parts[1]) || 0) + 1;
                newVersion = `${major}.${minor}`;
            }
        }

        const updates = {
            display_name: document.getElementById('pluginDisplayName').value,
            version: newVersion,
            description: document.getElementById('pluginDescription').value,
            enabled: document.getElementById('pluginEnabled').checked ? 1 : 0,
            updated_by: currentUser,
            updated_at: new Date().toISOString().replace('T', ' ').split('.')[0],
            config: {
                type: document.getElementById('configTypeValue').textContent,
                rateLimit: parseInt(document.getElementById('configRateLimit').value) || 100,
                routes: document.getElementById('configRoutes').value.split('\n').filter(r => r.trim())
            },
            originalConfig: originalPluginConfig  // Send original config for history
        };

        // Include code if it was modified
        if (originalPluginConfig && originalPluginConfig.code) {
            updates.code = originalPluginConfig.code;
        }

        // Add API fields based on type
        const configType = document.getElementById('configTypeValue').textContent;
        if (configType === 'api') {
            const bearerFields = document.getElementById('bearerAuthFields');
            const clientFields = document.getElementById('clientAuthFields');

            if (bearerFields.style.display !== 'none') {
                // Bearer token auth
                updates.config.baseUrl = document.getElementById('configBaseUrl').value;
                updates.config.apiPath = document.getElementById('configApiPath').value;
                updates.config.apiKey = document.getElementById('configApiKey').value;
            } else if (clientFields.style.display !== 'none') {
                // Client/OAuth auth
                updates.config.baseUrl = document.getElementById('configClientBaseUrl').value;
                updates.config.apiPath = document.getElementById('configClientApiPath').value;
                updates.config.clientId = document.getElementById('configClientId').value;
                updates.config.publicKey = document.getElementById('configPublicKey').value;
                updates.config.privateKey = document.getElementById('configPrivateKey').value;
            }
            
            // Add headers from current editing state if any
            if (currentEditingHeaders && currentEditingHeaders.length > 0) {
                updates.config.headers = currentEditingHeaders;
            }
        } else if (configType === 'sql') {
            // Save current SQL database form before submitting
            const currentDb = document.getElementById('sqlDatabaseSelect').value;
            if (currentDb) {
                saveSqlDatabaseForm(currentDb);
            }
            // Include all databases in config
            updates.config.databases = currentDatabases;
        }

        // Send update to server (will create this endpoint next)
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/update?name=${encodeURIComponent(pluginName)}`, {
            method: 'POST',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updates)
        });

        const data = await response.json();

        if (response.ok) {
            window.showStatusBanner('Plugin settings saved successfully.', 'success', 'pluginsStatusMessage');
            // Auto-reload the plugin to pick up new config
            try {
                const reloadResponse = await fetch(`https://app.equinoxits.com:1139/kore/plugins/load?name=${encodeURIComponent(pluginName)}`, {
                    method: 'POST',
                    headers: {
                        'X-Session-Token': sessionToken,
                        'Content-Type': 'application/json'
                    }
                });
                if (reloadResponse.ok) {
                    window.showStatusBanner('Plugin saved successfully.', 'success', 'pluginsStatusMessage');
                }
            } catch (reloadError) {
                console.error('Error reloading plugin after save:', reloadError);
            }
            cancelPluginSelection();
        } else {
            window.showStatusBanner('Error: ' + (data.error || 'Unknown error'), 'error', 'pluginsStatusMessage');
        }
    } catch (error) {
        window.showStatusBanner('Error saving settings: ' + error.message, 'error', 'pluginsStatusMessage');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function reloadSelectedPlugin() {
    const pluginName = document.getElementById('pluginName').value;
    
    if (!pluginName) {
        showStatusBanner('Please select a plugin first', 'error');
        return;
    }

    const btn = document.getElementById('reloadPluginBtn');
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = 'Reloading...';

    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/load?name=${encodeURIComponent(pluginName)}`, {
            method: 'POST',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (response.ok) {
            showStatusBanner('Plugin "' + pluginName + '" reloaded successfully.', 'success');
            loadPluginDetails();
        } else {
            showStatusBanner('Error: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        showStatusBanner('Error: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}