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


/**
 * Execute a plugin task via /executeTask endpoint
 * @param {number} taskId - The task ID to execute
 * @param {object} inputs - Input values for the task
 * @returns {Promise} - Response from the endpoint
 */
async function executeTask(taskId, inputs = {}) {
    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        console.log('[executeTask] Executing task:', { taskId, inputs });

        const response = await fetch('https://app.equinoxits.com:1139/executeTask', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({
                task_id: taskId,
                inputs: inputs
            })
        });

        const data = await response.json();

        console.log('[executeTask] Response status:', response.status, 'Headers:', response.headers);
        console.log('[executeTask] Result:', data);

        // If response is not ok but we have data with results, return it anyway
        // This handles cases where handlers return data despite a non-2xx status
        if (!response.ok && !data.result && !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data;
    } catch (error) {
        console.error('[executeTask] Error:', error.message);
        throw error;
    }
}

/**
 * List all loaded plugins
 * @returns {Promise} - Array of plugin info
 */
async function listPlugins() {
    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        const response = await fetch('https://app.equinoxits.com:1139/kore/plugins/list', {
            method: 'GET',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data.plugins || [];
    } catch (error) {
        console.error('[listPlugins] Error:', error.message);
        throw error;
    }
}

/**
 * Get tasks for a specific plugin
 * @param {string} pluginName - The plugin name
 * @returns {Promise} - Array of tasks
 */
async function getPluginTasks(pluginName) {
    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/${encodeURIComponent(pluginName)}/tasks`, {
            method: 'GET',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data.tasks || [];
    } catch (error) {
        console.error('[getPluginTasks] Error:', error.message);
        throw error;
    }
}

/**
 * Get detailed plugin configuration
 * @param {string} pluginName - The plugin name
 * @returns {Promise} - Plugin details with config
 */
async function getPluginDetails(pluginName) {
    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/details?name=${encodeURIComponent(pluginName)}`, {
            method: 'GET',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        const plugin = data.plugin;
        // Parse config if it's a string
        if (typeof plugin.config === 'string') {
            plugin.config = JSON.parse(plugin.config);
        }

        return plugin;
    } catch (error) {
        console.error('[getPluginDetails] Error:', error.message);
        throw error;
    }
}

/**
 * Resolve @config.* references to actual config values
 * @param {string} refString - Reference string like "@config.databases"
 * @param {object} pluginConfig - Plugin config object
 * @returns {array|object|null} - Resolved value or null
 */
function resolveConfigReference(refString, pluginConfig) {
    console.log('resolveConfigReference called with:', refString);
    console.log('pluginConfig structure:', {
        name: pluginConfig?.name,
        hasConfig: !!pluginConfig?.config,
        configKeys: pluginConfig?.config ? Object.keys(pluginConfig.config) : 'N/A'
    });
    
    if (!refString || !refString.startsWith('@config.') || !pluginConfig) {
        console.log('Early return - missing params');
        return null;
    }
    
    const path = refString.substring(8);
    console.log('Path to resolve:', path);
    const parts = path.split('.');
    
    let value = pluginConfig.config || pluginConfig;
    console.log('Starting with value:', value);
    
    for (const part of parts) {
        if (value && typeof value === 'object') {
            value = value[part];
            console.log(`After accessing .${part}:`, value);
        } else {
            console.log('Not an object, returning null');
            return null;
        }
    }
    
    if (typeof value === 'object') {
        const result = Array.isArray(value) ? value : Object.keys(value || {});
        console.log('Final result:', result);
        return result;
    }
    
    console.log('Value is not an object, returning null');
    return null;
}

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
        showStatusBanner('No plugin selected', 'error', 'pluginsStatusMessage');
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

    const taskOptions = tasks.map(t => `<option value="${t.task_id}">${escapeHtml(t.display_name)}</option>`).join('');
    
    let tasksHtml = `
        <div id="taskStatusMessage" style="margin-bottom: 15px;"></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 10px; align-items: flex-end;">
            <div>
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Task</label>
                <select id="taskSelector" style="width: 100%;">
                    <option value="">-- Select a Task --</option>
                    ${taskOptions}
                </select>
            </div>
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
                <button type="button" class="btn" data-color="primary" onclick="addNewTask()">+ Add Task</button>
                <button type="button" id="saveTaskBtn" class="btn" data-color="green" onclick="saveTaskConfig()" disabled style="display: none;">Save</button>
                <button type="button" class="btn" data-color="secondary" onclick="resetTaskConfig()" style="display: none;">Reset</button>
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
                            async () => {
                                await saveTaskConfig(null);
                                window.pluginTaskHasUnsavedChanges = false;
                                showStatusBanner('Task saved successfully', 'success', 'pluginsStatusMessage');
                            },
                            () => {
                                window.pluginTaskHasUnsavedChanges = false;
                            }
                        );
                    }
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
    window.pluginTaskHasUnsavedChanges = false;

    // Setup task selection handler
    setTimeout(() => {
        const taskSelector = document.getElementById('taskSelector');
        const detailsContainer = document.getElementById('taskDetailsContainer');
        
        if (taskSelector) {
            taskSelector.addEventListener('change', (e) => {
                const taskId = parseInt(e.target.value, 10);

                if (taskId) {
                    // DESTROY CURRENT FORM COMPLETELY
                    detailsContainer.innerHTML = '';
                    detailsContainer.style.display = 'none';
                    window.pluginTasksCurrentConfig = null;
                    window.pluginTaskHasUnsavedChanges = false;
                    
                    const saveBtn = document.getElementById('saveTaskBtn');
                    if (saveBtn) {
                        saveBtn.disabled = true;
                    }
                    
                    // Get fresh task data from pluginTasksOriginalConfigs (the source of truth after fetches)
                    const originalTask = window.pluginTasksOriginalConfigs[taskId];

                    if (originalTask) {
                        // Store fresh copy from original configs
                        window.pluginTasksCurrentConfig = JSON.parse(JSON.stringify(originalTask));
                        
                        // REBUILD FORM FROM SCRATCH
                        detailsContainer.innerHTML = buildTaskDetailsHtml(window.pluginTasksCurrentConfig, originalPluginConfig);
                        detailsContainer.style.display = 'block';
                        
                        // Initialize toggle buttons for input details
                        setTimeout(() => {
                            initializeInputDetailsToggles(detailsContainer);
                        }, 0);

                        // Show Save and Reset buttons
                        const saveBtn = document.getElementById('saveTaskBtn');
                        const resetBtn = document.querySelector('button[onclick="resetTaskConfig()"]');
                        if (saveBtn) {
                            saveBtn.style.display = 'inline-block';
                        }
                        if (resetBtn) {
                            resetBtn.style.display = 'inline-block';
                        }

                        // Reinitialize event tracking
                        initializeTaskUnsavedTracking(taskId);
                        syncPluginTaskConfigFromDom();
                    }
                } else {
                    unloadSelectedPluginTask();
                }
            });
        }
    }, 100);
}

function unloadSelectedPluginTask() {
    const detailsContainer = document.getElementById('taskDetailsContainer');
    const saveBtn = document.getElementById('saveTaskBtn');
    const resetBtn = document.querySelector('button[onclick="resetTaskConfig()"]');
    const statusContainer = document.getElementById('taskStatusMessage');

    window.pluginTasksCurrentConfig = null;
    window.pluginTaskHasUnsavedChanges = false;

    if (detailsContainer) {
        detailsContainer.oninput = null;
        detailsContainer.onchange = null;
        detailsContainer.innerHTML = '';
        detailsContainer.style.display = 'none';
        delete detailsContainer.dataset.taskId;
    }

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.style.display = 'none';
    }

    if (resetBtn) {
        resetBtn.style.display = 'none';
    }

    if (statusContainer) {
        statusContainer.innerHTML = '';
    }

    if (typeof window.clearUnsavedChanges === 'function') {
        window.clearUnsavedChanges();
    }
}

function initializeTaskUnsavedTracking(taskId) {
    const detailsContainer = document.getElementById('taskDetailsContainer');
    const saveBtn = document.getElementById('saveTaskBtn');

    if (!detailsContainer) return;

    detailsContainer.dataset.taskId = taskId;

    detailsContainer.oninput = () => {
        syncPluginTaskConfigFromDom();
        markPluginTaskDirty();
    };

    detailsContainer.onchange = () => {
        syncPluginTaskConfigFromDom();
        markPluginTaskDirty();
    };

    if (saveBtn) {
        saveBtn.disabled = true;
    }

    window.pluginTaskHasUnsavedChanges = false;
}

function markPluginTaskDirty() {
    const saveBtn = document.getElementById('saveTaskBtn');

    if (saveBtn) {
        saveBtn.disabled = false;
    }

    window.pluginTaskHasUnsavedChanges = true;
}

function clearTaskUnsavedTracking() {
    const detailsContainer = document.getElementById('taskDetailsContainer');
    const saveBtn = document.getElementById('saveTaskBtn');

    if (detailsContainer) {
        detailsContainer.oninput = null;
        detailsContainer.onchange = null;
    }

    if (saveBtn) {
        saveBtn.disabled = true;
    }

    window.pluginTaskHasUnsavedChanges = false;
    window.pluginTasksCurrentConfig = null;
}

function syncPluginTaskConfigFromDom() {
    const cfg = window.pluginTasksCurrentConfig;
    const detailsContainer = document.getElementById('taskDetailsContainer');

    if (!cfg || !detailsContainer) return;

    cfg.display_name = detailsContainer.querySelector('.plugin-task-name-field')?.value || '';
    cfg.description = detailsContainer.querySelector('.plugin-task-description')?.value || cfg.description || '';
    cfg.label_field = detailsContainer.querySelector('.plugin-task-label-field')?.value || '';
    cfg.value_field = detailsContainer.querySelector('.plugin-task-value-field')?.value || '';
    cfg.endpoint = detailsContainer.querySelector('.plugin-task-endpoint')?.value || '';
    cfg.method = detailsContainer.querySelector('.plugin-task-method')?.value || 'NA';

    cfg.static_params = collectPluginTaskStaticParams(detailsContainer);
    cfg.inputs = collectPluginTaskList(detailsContainer, '.plugin-task-inputs-container');
    cfg.outputs = collectPluginTaskList(detailsContainer, '.plugin-task-outputs-container');
}

function collectPluginTaskStaticParams(root) {
    const params = {};
    const container = root.querySelector('.plugin-task-static-params-container');

    if (!container) return params;

    container.querySelectorAll('.plugin-task-dict-row').forEach(row => {
        const key = row.querySelector('.plugin-task-dict-key')?.value.trim() || '';
        const rawValue = row.querySelector('.plugin-task-dict-value')?.value.trim() || '';

        if (!key) return;

        params[key] = parsePluginTaskStaticParamValue(rawValue);
    });

    return params;
}

function collectPluginTaskList(root, containerSelector) {
    const items = [];
    const container = root.querySelector(containerSelector);

    if (!container) return items;

    container.querySelectorAll('.plugin-task-list-row').forEach(row => {
        const name = row.querySelector('.plugin-task-list-name')?.value.trim() || '';
        const label = row.querySelector('.plugin-task-list-label')?.value.trim() || '';

        if (!name && !label) return;

        const item = { name, label };
        
        // Collect input-specific extended properties
        const typeField = row.querySelector('.plugin-task-input-type');
        const requiredField = row.querySelector('.plugin-task-input-required');
        const optionsField = row.querySelector('.plugin-task-input-options');
        const defaultField = row.querySelector('.plugin-task-input-default');
        
        if (typeField?.value) item.type = typeField.value;
        if (requiredField?.checked) item.required = true;
        if (optionsField?.value) {
            // Parse options - can be JSON array or comma-separated
            try {
                const val = optionsField.value.trim();
                item.options = val.startsWith('[') ? JSON.parse(val) : val.split(',').map(s => s.trim());
            } catch (e) {
                console.warn('Failed to parse options:', optionsField.value);
                item.options = optionsField.value;
            }
        }
        if (defaultField?.value) item.default = defaultField.value;
        
        // Collect output-specific extended properties
        const outputTypeField = row.querySelector('.plugin-task-output-type');
        const outputDescriptionField = row.querySelector('.plugin-task-output-description');
        
        if (outputTypeField?.value) item.type = outputTypeField.value;
        if (outputDescriptionField?.value) item.description = outputDescriptionField.value;

        items.push(item);
    });

    return items;
}

function parsePluginTaskStaticParamValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;

    if (value !== '' && !Number.isNaN(Number(value))) {
        return Number(value);
    }

    return value;
}

function formatOptionsDisplay(options, pluginConfig) {
    /**
     * Format options for display, showing both reference and resolved values if applicable
     */
    if (Array.isArray(options)) {
        return JSON.stringify(options);
    }
    
    if (typeof options === 'string') {
        return options;
    }
    
    return '';
}

function initializeInputDetailsToggles(container) {
    /**
     * Initialize toggle buttons for input/output details sections
     */
    container.querySelectorAll('.plugin-task-toggle-details').forEach(toggleBtn => {
        const row = toggleBtn.closest('.plugin-task-list-row');
        const detailsDiv = row?.querySelector('.plugin-task-input-details') || row?.querySelector('.plugin-task-output-details');
        if (!detailsDiv) return;
        
        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const isHidden = detailsDiv.style.display === 'none';
            detailsDiv.style.display = isHidden ? 'block' : 'none';
            toggleBtn.textContent = isHidden ? 'Fewer options' : 'More options';
        });
    });
    
    // Also handle output toggle buttons separately for clarity
    container.querySelectorAll('.plugin-task-toggle-output-details').forEach(toggleBtn => {
        const row = toggleBtn.closest('.plugin-task-list-row');
        const detailsDiv = row?.querySelector('.plugin-task-output-details');
        if (!detailsDiv) return;
        
        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const isHidden = detailsDiv.style.display === 'none';
            detailsDiv.style.display = isHidden ? 'block' : 'none';
            toggleBtn.textContent = isHidden ? 'Fewer options' : 'More options';
        });
    });
}

function removePluginTaskConfigRow(button) {
    const row = button?.closest('.plugin-task-dict-row, .plugin-task-list-row');

    if (row) {
        row.remove();
    }

    syncPluginTaskConfigFromDom();
    markPluginTaskDirty();
}

async function saveTaskConfig(statusContainer = 'taskStatusMessage') {
    if (!window.pluginTasksCurrentConfig) {
        if (statusContainer) {
            showStatusBanner('No task selected', 'warning', statusContainer);
        }
        return;
    }

    syncPluginTaskConfigFromDom();
    const cfg = window.pluginTasksCurrentConfig;
    const isNewTask = cfg.task_id === null;

    console.log('[saveTaskConfig] Saving task config:', structuredClone(cfg));

    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/${encodeURIComponent(currentPluginName)}/tasks`, {
            method: 'POST',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                task_id: isNewTask ? null : cfg.task_id,
                plugin_id: currentPlugin.id,
                display_name: cfg.display_name,
                description: cfg.description,
                static_params: cfg.static_params || {},
                inputs: cfg.inputs || [],
                outputs: cfg.outputs || [],
                label_field: cfg.label_field,
                value_field: cfg.value_field,
                endpoint: cfg.endpoint,
                method: cfg.method
            })
        });

        const result = await response.json();
        if (!response.ok) {
            showStatusBanner('Error saving task: ' + (result.error || 'Unknown error'), 'error', statusContainer);
            return null;
        }

        console.log('[saveTaskConfig] API result:', result);
        await refreshPluginTaskSelector(isNewTask ? null : cfg.task_id);
        const taskId = cfg.task_id || result.task_id;

        if (window.pluginTasksOriginalConfigs && taskId) {
            window.pluginTasksOriginalConfigs[taskId] = JSON.parse(JSON.stringify(cfg));
        }

        if (currentPluginName && pluginTasksCache[currentPluginName]) {
            const cachedTask = pluginTasksCache[currentPluginName].find(t => Number(t.task_id) === Number(taskId));
            if (cachedTask) {
                Object.assign(cachedTask, JSON.parse(JSON.stringify(cfg)));
            }
        }

        if (statusContainer === 'taskStatusMessage') {
            showStatusBanner(isNewTask ? 'Task created successfully' : 'Task saved successfully', 'success', statusContainer);
        }
        
        const saveBtn = document.getElementById('saveTaskBtn');
        if (saveBtn) {
            saveBtn.disabled = true;
        }

        window.pluginTaskHasUnsavedChanges = false;
        if (typeof window.clearUnsavedChanges === 'function') {
            window.clearUnsavedChanges();
        }

        return result;
    } catch (error) {
        console.error('[saveTaskConfig] Error:', error);
        showStatusBanner('Error saving task: ' + error.message, 'error', statusContainer);
        return null;
    }
}

async function refreshPluginTaskSelector(selectedTaskId = null) {
    if (!currentPluginName) return;

    const taskSelector = document.getElementById('taskSelector');
    if (!taskSelector) return;

    delete pluginTasksCache[currentPluginName];

    const tasks = await fetchPluginTasks(currentPluginName);

    window.pluginTasksOriginalConfigs = {};
    tasks.forEach(task => {
        window.pluginTasksOriginalConfigs[task.task_id] = JSON.parse(JSON.stringify(task));
    });

    const selectedId = selectedTaskId || taskSelector.value;

    taskSelector.innerHTML = `
        <option value="">-- Select a Task --</option>
        ${tasks.map(t => `
            <option value="${t.task_id}" ${Number(t.task_id) === Number(selectedId) ? 'selected' : ''}>
                ${escapeHtml(t.display_name)}
            </option>
        `).join('')}
    `;
}

function resetTaskConfig() {
    if (!window.pluginTasksCurrentConfig) {
        showStatusBanner('No task selected', 'warning', 'taskStatusMessage');
        return;
    }

    const taskId = window.pluginTasksCurrentConfig.task_id;
    const originalConfig = window.pluginTasksOriginalConfigs?.[taskId];
    const saveBtn = document.getElementById('saveTaskBtn');
    const detailsContainer = document.getElementById('taskDetailsContainer');

    if (!originalConfig || !detailsContainer) return;

    window.pluginTasksCurrentConfig = JSON.parse(JSON.stringify(originalConfig));

    detailsContainer.innerHTML = buildTaskDetailsHtml(window.pluginTasksCurrentConfig, originalPluginConfig);
    detailsContainer.style.display = 'block';
    
    // Initialize toggle buttons for input details
    setTimeout(() => {
        initializeInputDetailsToggles(detailsContainer);
    }, 0);

    showStatusBanner('Task reset to original configuration', 'info', 'taskStatusMessage');

    if (saveBtn) {
        saveBtn.disabled = true;
    }

    window.pluginTaskHasUnsavedChanges = false;

    if (typeof window.clearUnsavedChanges === 'function') {
        window.clearUnsavedChanges();
    }

    initializeTaskUnsavedTracking(taskId);
    syncPluginTaskConfigFromDom();
}

function addNewTask() {
    // Check if there are unsaved changes on the current task
    if (window.pluginTaskHasUnsavedChanges && window.pluginTasksCurrentConfig) {
        showUnsaved(
            () => {
                // Save current task, then load blank form
                saveTaskConfig();
                window.pluginTaskHasUnsavedChanges = false;
                loadBlankTaskForm();
            },
            () => {
                // Discard current task and load blank form
                window.pluginTaskHasUnsavedChanges = false;
                loadBlankTaskForm();
            }
        );
    } else {
        // No unsaved changes, just load blank form
        loadBlankTaskForm();
    }
}

function loadBlankTaskForm() {
    const detailsContainer = document.getElementById('taskDetailsContainer');
    const saveBtn = document.getElementById('saveTaskBtn');
    const resetBtn = document.querySelector('button[onclick="resetTaskConfig()"]');
    const taskSelector = document.getElementById('taskSelector');

    // Create a new task object with blank values
    const newTask = {
        task_id: null,  // null indicates new task
        display_name: '',
        description: '',
        label_field: '',
        value_field: '',
        endpoint: '',
        method: 'NA',
        static_params: {},
        inputs: [],
        outputs: []
    };

    // Clear state
    window.pluginTasksCurrentConfig = newTask;
    window.pluginTaskHasUnsavedChanges = false;
    
    // Clear form
    detailsContainer.innerHTML = '';
    detailsContainer.style.display = 'none';

    // Deselect task selector
    if (taskSelector) {
        taskSelector.value = '';
    }

    // Show buttons and rebuild form
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.style.display = 'inline-block';
    }
    if (resetBtn) {
        resetBtn.style.display = 'inline-block';
    }

    // Build and display the blank form
    detailsContainer.innerHTML = buildTaskDetailsHtml(newTask, originalPluginConfig);
    detailsContainer.style.display = 'block';

    // Initialize toggle buttons for input details
    setTimeout(() => {
        initializeInputDetailsToggles(detailsContainer);
    }, 0);

    // Initialize tracking for new task
    initializeTaskUnsavedTracking(null);
    syncPluginTaskConfigFromDom();
}

function buildTaskDetailsHtml(task, pluginConfig) {
    let html = '';
    
    html += `
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Task Name</label>
            <input type="text" class="plugin-task-name-field" value="${escapeHtml(task.display_name || '')}" placeholder="Plugin Task Name" style="width: 100%;">
        </div>
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Description</label>
            <textarea class="plugin-task-description" style="width: 100%; height: 60px; resize: none;">${escapeHtml(task.description || '')}</textarea>
        </div>
    `;
    
    html += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">';
    
    html += '<div>';
    
    html += `
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Result Format</label>
            <div style="margin-bottom: 8px;">
                <input type="text" class="plugin-task-label-field" value="${escapeHtml(task.label_field || '')}" placeholder="Label field format" style="width: 100%;">
            </div>
        </div>
    `;

    html += `
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Value Field</label>
            <input type="text" class="plugin-task-value-field" value="${escapeHtml(task.value_field || '')}" placeholder="Value field" style="width: 100%;">
        </div>
    `;
    
    html += `
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Static Parameters</label>
            <button type="button" class="btn" data-color="green" data-size="sm" style="margin-bottom: 4px; width: 100%;" onclick="addDictEntry('staticParamsContainer_${task.task_id}')">Add Parameter</button>
            <div id="staticParamsContainer_${task.task_id}" class="plugin-task-static-params-container" style="display: flex; flex-direction: column; gap: 3px;"></div>
        </div>
    `;
    
    html += '</div>';
    
    html += '<div>';
    
    html += `
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Endpoint</label>
            <input type="text" class="plugin-task-endpoint" value="${escapeHtml(task.endpoint || '')}" placeholder="API endpoint (if applicable)" style="width: 100%;">
        </div>
    `;
    
    html += `
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Method</label>
            <select class="plugin-task-method" style="width: 100%;">
                <option value="NA" ${(task.method || 'NA') === 'NA' ? 'selected' : ''}>NA</option>
                <option value="GET" ${(task.method || 'NA') === 'GET' ? 'selected' : ''}>GET</option>
                <option value="PUT" ${(task.method || 'NA') === 'PUT' ? 'selected' : ''}>PUT</option>
                <option value="POST" ${(task.method || 'NA') === 'POST' ? 'selected' : ''}>POST</option>
            </select>
        </div>
    `;
    
    html += `
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Input Parameters</label>
            <button type="button" class="btn" data-color="green" data-size="sm" style="margin-bottom: 4px; width: 100%;" onclick="addListEntry('inputsContainer_${task.task_id}')">Add Input</button>
            <div id="inputsContainer_${task.task_id}" class="plugin-task-inputs-container" style="display: flex; flex-direction: column; gap: 8px;">
    `;
    
    if (!task.inputs || task.inputs.length === 0) {
        html += '<p class="plugin-task-empty-message" style="color: var(--text-muted); font-size: 12px; padding: 8px;">No inputs yet</p>';
    } else {
        task.inputs.forEach((input, idx) => {
            const inputId = `input_${task.task_id}_${idx}`;
            html += `
                <div class="plugin-task-list-row" style="display: flex; flex-direction: column; gap: 3px; padding: 6px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 4px;">
                    <!-- Basic fields -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 3px; align-items: center;">
                        <input type="text" class="plugin-task-list-name" value="${escapeHtml(input.name || '')}" placeholder="Name" style="font-size: 11px;">
                        <input type="text" class="plugin-task-list-label" value="${escapeHtml(input.label || '')}" placeholder="Label" style="font-size: 11px;">
                        <button type="button" class="btn" data-color="red" data-size="sm" onclick="removePluginTaskConfigRow(this)">×</button>
                    </div>
                    <!-- Expanded fields -->
                    <div class="plugin-task-input-details" style="display: none; border-top: 1px solid var(--border-primary); padding-top: 6px; margin-top: 3px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;">
                            <div>
                                <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Type</label>
                                <select class="plugin-task-input-type" style="width: 100%; font-size: 11px;">
                                    <option value="">-- Select --</option>
                                    <option value="text" ${input.type === 'text' ? 'selected' : ''}>text</option>
                                    <option value="number" ${input.type === 'number' ? 'selected' : ''}>number</option>
                                    <option value="boolean" ${input.type === 'boolean' ? 'selected' : ''}>boolean</option>
                                    <option value="select" ${input.type === 'select' ? 'selected' : ''}>select</option>
                                    <option value="textarea" ${input.type === 'textarea' ? 'selected' : ''}>textarea</option>
                                    <option value="object" ${input.type === 'object' ? 'selected' : ''}>object</option>
                                </select>
                            </div>
                            <div style="display: flex; align-items: flex-end; gap: 6px;">
                                <div style="flex: 1;">
                                    <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Default</label>
                                    <input type="text" class="plugin-task-input-default" value="${escapeHtml(input.default || '')}" placeholder="Default value" style="width: 100%; font-size: 11px;">
                                </div>
                                <div style="display: flex; align-items: center; gap: 3px;">
                                    <input type="checkbox" class="plugin-task-input-required" ${input.required ? 'checked' : ''} style="width: 14px; height: 14px; cursor: pointer;">
                                    <label style="color: var(--text-muted); font-size: 10px; cursor: pointer; margin: 0; white-space: nowrap;">Required</label>
                                </div>
                            </div>
                        </div>
                        <div>
                            <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Options (comma-separated, JSON array, or @config.path)</label>
                            <input type="text" class="plugin-task-input-options" value="${escapeHtml(Array.isArray(input.options) ? JSON.stringify(input.options) : input.options || '')}" placeholder='["option1", "option2"] or option1, option2 or @config.databases' style="width: 100%; font-size: 11px;">
                            <div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
                                ${input.options && typeof input.options === 'string' && input.options.startsWith('@config.') ? `<div style="padding: 4px; background: var(--bg-tertiary); border-radius: 3px; margin-top: 2px;">Reference: ${escapeHtml(formatOptionsDisplay(input.options, pluginConfig))}</div>` : ''}
                            </div>
                        </div>
                    </div>
                    <!-- Toggle button -->
                    <button type="button" class="plugin-task-toggle-details" data-toggle-id="${inputId}" style="align-self: flex-start; font-size: 10px; padding: 2px 6px; background: none; border: none; color: var(--text-accent); cursor: pointer; text-decoration: underline;">More options</button>
                </div>
            `;
        });
    }
    
    html += `
            </div>
        </div>
    `;
    
    html += `
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 8px; font-weight: 600;">Output Fields</label>
            <button type="button" class="btn" data-color="green" data-size="sm" style="margin-bottom: 10px; width: 100%;" onclick="addListEntry('outputsContainer_${task.task_id}')">Add Output</button>
            <div id="outputsContainer_${task.task_id}" class="plugin-task-outputs-container" style="display: flex; flex-direction: column; gap: 3px;">
    `;
    
    if (!task.outputs || task.outputs.length === 0) {
        html += '<p class="plugin-task-empty-message" style="color: var(--text-muted); font-size: 12px; padding: 3px;">No outputs yet</p>';
    } else {
        task.outputs.forEach((output, idx) => {
            const outputId = `output_${task.task_id}_${idx}`;
            html += `
                <div class="plugin-task-list-row" style="display: flex; flex-direction: column; gap: 3px; padding: 6px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 4px;">
                    <!-- Basic fields -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 3px; align-items: center;">
                        <input type="text" class="plugin-task-list-name" value="${escapeHtml(output.name || '')}" placeholder="Name" style="font-size: 11px;">
                        <input type="text" class="plugin-task-list-label" value="${escapeHtml(output.label || '')}" placeholder="Label" style="font-size: 11px;">
                        <button type="button" class="btn" data-color="red" data-size="sm" onclick="removePluginTaskConfigRow(this)">×</button>
                    </div>
                    <!-- Expanded fields -->
                    <div class="plugin-task-output-details" style="display: none; border-top: 1px solid var(--border-primary); padding-top: 6px; margin-top: 3px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                            <div>
                                <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Type</label>
                                <select class="plugin-task-output-type" style="width: 100%; font-size: 11px;">
                                    <option value="">-- Select --</option>
                                    <option value="string" ${output.type === 'string' ? 'selected' : ''}>string</option>
                                    <option value="number" ${output.type === 'number' ? 'selected' : ''}>number</option>
                                    <option value="boolean" ${output.type === 'boolean' ? 'selected' : ''}>boolean</option>
                                    <option value="array" ${output.type === 'array' ? 'selected' : ''}>array</option>
                                    <option value="object" ${output.type === 'object' ? 'selected' : ''}>object</option>
                                </select>
                            </div>
                            <div>
                                <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Description</label>
                                <input type="text" class="plugin-task-output-description" value="${escapeHtml(output.description || '')}" placeholder="Description" style="width: 100%; font-size: 11px;">
                            </div>
                        </div>
                    </div>
                    <!-- Toggle button -->
                    <button type="button" class="plugin-task-toggle-output-details" data-toggle-id="${outputId}" style="align-self: flex-start; font-size: 10px; padding: 2px 6px; background: none; border: none; color: var(--text-accent); cursor: pointer; text-decoration: underline;">More options</button>
                </div>
            `;
        });
    }
    
    html += `
            </div>
        </div>
    `;
    
    html += '</div>';
    html += '</div>';
    
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    const staticParamsContainer = tempDiv.querySelector(`#staticParamsContainer_${task.task_id}`);

    if (staticParamsContainer) {
        Object.entries(task.static_params || {}).forEach(([key, value]) => {
            const row = document.createElement('div');
            row.className = 'plugin-task-dict-row';
            row.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr auto; gap: 3px; align-items: center;';
            row.innerHTML = `
                <input type="text" class="plugin-task-dict-key" value="${escapeHtml(key)}" placeholder="Key">
                <input type="text" class="plugin-task-dict-value" value="${escapeHtml(String(value))}" placeholder="Value">
                <button type="button" class="btn" data-color="red" data-size="sm" onclick="removePluginTaskConfigRow(this)">&#128711;</button>
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
        <div class="plugin-task-dict-row" style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center;">
            <input type="text" class="plugin-task-dict-key" placeholder="Key">
            <input type="text" class="plugin-task-dict-value" placeholder="Value">
            <button type="button" class="btn" data-color="red" data-size="sm" onclick="removePluginTaskConfigRow(this)">&#128711;</button>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);

    syncPluginTaskConfigFromDom();
    markPluginTaskDirty();
}

function addListEntry(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const noItemsMsg = container.querySelector('.plugin-task-empty-message');
    if (noItemsMsg) noItemsMsg.remove();

    const html = `
        <div class="plugin-task-list-row" style="display: flex; flex-direction: column; gap: 3px; padding: 6px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 4px;">
            <!-- Basic fields -->
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 3px; align-items: center;">
                <input type="text" class="plugin-task-list-name" placeholder="Name" style="font-size: 11px;">
                <input type="text" class="plugin-task-list-label" placeholder="Label" style="font-size: 11px;">
                <button type="button" class="btn" data-color="red" data-size="sm" onclick="removePluginTaskConfigRow(this)">×</button>
            </div>
            <!-- Expanded fields -->
            <div class="plugin-task-input-details" style="display: none; border-top: 1px solid var(--border-primary); padding-top: 6px; margin-top: 3px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;">
                    <div>
                        <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Type</label>
                        <select class="plugin-task-input-type" style="width: 100%; font-size: 11px;">
                            <option value="">-- Select --</option>
                            <option value="text">text</option>
                            <option value="number">number</option>
                            <option value="boolean">boolean</option>
                            <option value="select">select</option>
                            <option value="textarea">textarea</option>
                            <option value="object">object</option>
                        </select>
                    </div>
                    <div style="display: flex; align-items: flex-end; gap: 6px;">
                        <div style="flex: 1;">
                            <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Default</label>
                            <input type="text" class="plugin-task-input-default" placeholder="Default value" style="width: 100%; font-size: 11px;">
                        </div>
                        <div style="display: flex; align-items: center; gap: 3px;">
                            <input type="checkbox" class="plugin-task-input-required" style="width: 14px; height: 14px; cursor: pointer;">
                            <label style="color: var(--text-muted); font-size: 10px; cursor: pointer; margin: 0; white-space: nowrap;">Required</label>
                        </div>
                    </div>
                </div>
                <div>
                    <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Options (comma-separated, JSON array, or @config.path)</label>
                    <input type="text" class="plugin-task-input-options" placeholder='["option1", "option2"] or option1, option2 or @config.databases' style="width: 100%; font-size: 11px;">
                </div>
            </div>
            <!-- Toggle button -->
            <button type="button" class="plugin-task-toggle-details" style="align-self: flex-start; font-size: 10px; padding: 2px 6px; background: none; border: none; color: var(--text-accent); cursor: pointer; text-decoration: underline;">More options</button>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);
    
    // Setup toggle button for new entry
    const newRow = container.querySelector('.plugin-task-list-row:last-child');
    const toggleBtn = newRow.querySelector('.plugin-task-toggle-details');
    const detailsDiv = newRow.querySelector('.plugin-task-input-details');
    
    if (toggleBtn && detailsDiv) {
        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const isHidden = detailsDiv.style.display === 'none';
            detailsDiv.style.display = isHidden ? 'block' : 'none';
            toggleBtn.textContent = isHidden ? 'Fewer options' : 'More options';
        });
    }

    syncPluginTaskConfigFromDom();
    markPluginTaskDirty();
}

async function fetchPluginTasks(pluginName) {
    console.log('[fetchPluginTasks] Called for plugin:', pluginName);

    if (pluginTasksCache[pluginName]) {
        console.log('[fetchPluginTasks] Returning cached tasks:', pluginTasksCache[pluginName]);
        return pluginTasksCache[pluginName];
    }

    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/${encodeURIComponent(pluginName)}/tasks`, {
            method: 'GET',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.error('[fetchPluginTasks] API error:', response.status);
            return [];
        }

        const data = await response.json();
        const tasks = (data.tasks || []).map(t => ({
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
            showStatusBanner('Unable to load plugin configuration', 'error', 'pluginsStatusMessage');
            return;
        }

        let config;

        try {
            config = typeof result.result[0].plugin_config === 'string'
                ? JSON.parse(result.result[0].plugin_config)
                : result.result[0].plugin_config;
        } catch (e) {
            showStatusBanner('Error parsing plugin configuration', 'error', 'pluginsStatusMessage');
            return;
        }

        if (!config || !config.types) {
            showStatusBanner('Unable to load plugin configuration', 'error', 'pluginsStatusMessage');
            return;
        }

        const fields = [];

        fields.push({
            name: 'pluginType',
            type: 'select',
            label: 'Type',
            options: ['', ...Object.keys(config.types)],
            required: true,
            value: ''
        });

        fields.push({ type: 'section', label: 'Basic Information', pluginTypes: ['api', 'service'] });

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

        fields.push({
            name: 'headers',
            type: 'custom:headers',
            label: 'Additional Headers',
            required: false,
            pluginTypes: ['api']
        });

        showFormModal('Add Plugin', fields, async (formData) => {
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

            const code = pendingPluginCode;
            pendingPluginCode = '';
            
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
                    rateLimit: parseInt(formData.configRateLimit, 10) || 100,
                    routes: formData.configRoutes.split('\n').filter(r => r.trim())
                }
            };
            
            if (pluginType === 'api') {
                pluginData.config.baseUrl = formData.baseUrl;
                pluginData.config.apiPath = formData.apiPath;
                pluginData.config.authType = formData.authType;
                
                if (formData.authType === 'bearer' && formData.apiKey) {
                    pluginData.config.apiKey = formData.apiKey;
                } else if (formData.authType === 'oauth') {
                    pluginData.config.publicKey = formData.publicKey;
                    pluginData.config.privateKey = formData.privateKey;
                }
                
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
        showStatusBanner('Error loading plugin configuration', 'error', 'pluginsStatusMessage');
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
        rateLimit: parseInt(document.getElementById('configRateLimit').value, 10) || 0,
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
        headers: currentEditingHeaders
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
            showStatusBanner('All plugins reloaded successfully.', 'success', 'pluginsStatusMessage');
        } else {
                        showStatusBanner('Error reloading plugins: ' + (data.message || 'Unknown error'), 'error', 'pluginsStatusMessage');
        }
    } catch (error) {
        console.error('Error reloading all plugins:', error);
        showStatusBanner('Error reloading plugins', 'error', 'pluginsStatusMessage');
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
                if (selectedSqlDatabaseName) {
                    saveSqlDatabaseForm(selectedSqlDatabaseName);
                }

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
    
    const buttons = document.querySelectorAll('#pluginListSidebar button');
    buttons.forEach(btn => {
        btn.setAttribute('data-color', 'theme-neutral');
    });
    
    if (buttonElement) {
        buttonElement.setAttribute('data-color', 'theme-brand');
    }
    
    window.clearUnsavedChanges();
}

function cancelPluginSelection() {
    const buttons = document.querySelectorAll('#pluginListSidebar button');
    buttons.forEach(btn => {
        btn.setAttribute('data-color', 'theme-neutral');
    });
    
    document.getElementById('pluginSettingsContainer').style.display = 'none';
    document.getElementById('pluginPlaceholder').style.display = 'block';
    
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
                        showStatusBanner('Plugin not found: ' + (data.error || 'Unknown error'), 'error', 'pluginsStatusMessage');
        }
    } catch (error) {
        console.error('Plugin fetch error:', error);
                showStatusBanner('Error loading plugin details: ' + error.message, 'error', 'pluginsStatusMessage');
    }
}

function populatePluginForm(plugin) {
    currentPlugin = plugin;
    currentPluginName = plugin.name;
    currentPluginVersion = plugin.version || 0;
    originalPluginConfig = JSON.parse(JSON.stringify(plugin));

    document.getElementById('pluginSettingsContainer').style.display = 'flex';
    document.getElementById('pluginPlaceholder').style.display = 'none';
    
    document.getElementById('reloadPluginBtn').style.display = 'inline-block';

    document.getElementById('headerPluginName').textContent = plugin.name;
    document.getElementById('headerPluginVersion').textContent = plugin.version || '0';

    document.getElementById('pluginDisplayName').value = plugin.display_name || '';
    document.getElementById('pluginDescription').value = plugin.description || '';
    document.getElementById('pluginEnabled').checked = plugin.enabled === 1 || plugin.enabled === true;

    document.getElementById('pluginCreatedAt').value = plugin.created_at || '';
    document.getElementById('pluginCreatedBy').value = plugin.created_by || '';
    document.getElementById('pluginUpdatedAt').value = plugin.updated_at || '';
    document.getElementById('pluginUpdatedBy').value = plugin.updated_by || '';

    const config = plugin.config || {};

    document.getElementById('configTypeValue').textContent = config.type || '';
    document.getElementById('configRateLimit').value = config.rateLimit || 100;
    document.getElementById('configRoutes').value = Array.isArray(config.routes) ? config.routes.join('\n') : '';

    const apiFieldsContainer = document.getElementById('apiFieldsContainer');
    const bearerAuthFields = document.getElementById('bearerAuthFields');
    const clientAuthFields = document.getElementById('clientAuthFields');
    const sqlFieldsContainer = document.getElementById('sqlFieldsContainer');

    if (apiFieldsContainer) apiFieldsContainer.style.display = 'none';
    if (sqlFieldsContainer) sqlFieldsContainer.style.display = 'none';

    if (config.type === 'api') {
        if (apiFieldsContainer) apiFieldsContainer.style.display = 'block';
        
        if (config.publicKey || config.privateKey) {
            if (bearerAuthFields) bearerAuthFields.style.display = 'none';
            if (clientAuthFields) clientAuthFields.style.display = 'block';

            document.getElementById('configClientBaseUrl').value = config.baseUrl || '';
            document.getElementById('configClientApiPath').value = config.apiPath || '';
            document.getElementById('configClientId').value = config.clientId || '';
            document.getElementById('configPublicKey').value = config.publicKey || '';
            document.getElementById('configPrivateKey').value = config.privateKey || '';
        } else if (config.apiKey) {
            if (bearerAuthFields) bearerAuthFields.style.display = 'block';
            if (clientAuthFields) clientAuthFields.style.display = 'none';

            document.getElementById('configBaseUrl').value = config.baseUrl || '';
            document.getElementById('configApiPath').value = config.apiPath || '';
            document.getElementById('configApiKey').value = config.apiKey || '';
        }
    } else if (config.type === 'sql') {
        if (sqlFieldsContainer) sqlFieldsContainer.style.display = 'block';
        
        currentDatabases = JSON.parse(JSON.stringify(config.databases || {}));
        
        const dbSelect = document.getElementById('sqlDatabaseSelect');
        dbSelect.innerHTML = '<option value="">-- Select Database --</option>';

        for (const dbName in currentDatabases) {
            const option = document.createElement('option');
            option.value = dbName;
            option.textContent = dbName;
            dbSelect.appendChild(option);
        }
        
        const sqlDatabaseForm = document.getElementById('sqlDatabaseForm');
        if (sqlDatabaseForm) sqlDatabaseForm.style.display = 'none';

        const testBtn = document.querySelector('button[onclick="testSqlConnection()"]');
        const cancelBtn = document.querySelector('button[onclick="cancelSqlDatabase()"]');
        const deleteBtn = document.querySelector('button[onclick="deleteSqlDatabase()"]');

        if (testBtn) testBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (deleteBtn) deleteBtn.disabled = true;
    }
    
    if (config.type === 'api') {
        currentEditingHeaders = JSON.parse(JSON.stringify(config.headers || []));
    }
    
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
        
        const oldHeadersJson = JSON.stringify(currentEditingHeaders);
        const newHeadersJson = JSON.stringify(headers);
        
        console.log('Headers changed?', oldHeadersJson !== newHeadersJson);
        
        if (oldHeadersJson !== newHeadersJson) {
            currentEditingHeaders = headers;
            console.log('Updated currentEditingHeaders to:', currentEditingHeaders);
        }
        
        updateSaveButtonState();
    });
    
    setTimeout(() => {
        console.log('Looking for Add Header button...');
        
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
    
    selectedSqlDatabaseName = dbName;

    const db = currentDatabases[dbName];
    
    if (db) {
        document.getElementById('sqlDbType').value = db.type || '';
        document.getElementById('sqlDbHost').value = db.host || '';
        document.getElementById('sqlDbPort').value = db.port || '';
        document.getElementById('sqlDbUser').value = db.user || '';
        document.getElementById('sqlDbPassword').value = '';
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
    
    if (selectedSqlDatabaseName && selectedSqlDatabaseName !== name) {
        delete currentDatabases[selectedSqlDatabaseName];
    }
    
    currentDatabases[name] = {
        name: name,
        type: document.getElementById('sqlDbType').value,
        host: document.getElementById('sqlDbHost').value,
        port: parseInt(document.getElementById('sqlDbPort').value, 10) || 1433,
        user: document.getElementById('sqlDbUser').value,
        password: document.getElementById('sqlDbPassword').value,
        database: document.getElementById('sqlDbDatabase').value,
        encrypt: document.getElementById('sqlDbEncrypt').checked,
        trustServerCert: document.getElementById('sqlDbTrustServerCert').checked
    };
    
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
    selectedSqlDatabaseName = name;
}

async function testSqlConnection() {
    const dbName = selectedSqlDatabaseName;
    if (!dbName) {
        showStatusBanner('Please select a database', 'error');
        return;
    }
    
    saveSqlDatabaseForm(dbName);
    const db = currentDatabases[dbName];
    const resultDiv = document.getElementById('sqlTestResult');
    
    try {
        if (!sessionToken) {
            sessionToken = await window.getSessionToken();
        }

        resultDiv.innerHTML = `<p style="color: #ff9800; margin: 0;">⏳ Testing connection...</p>`;
        resultDiv.style.display = 'block';

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/${encodeURIComponent(currentPluginName)}/sql/test`, {
            method: 'POST',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ database: db })
        });

        const result = await response.json();
        if (response.ok && result.success) {
            resultDiv.innerHTML = `<p style="color: #4caf50; margin: 0;">✓ Connection successful</p>`;
        } else {
            resultDiv.innerHTML = `<p style="color: #b8242f; margin: 0;">✗ Connection failed: ${result.error || 'Unknown error'}</p>`;
        }
        resultDiv.style.display = 'block';
    } catch (error) {
        resultDiv.innerHTML = `<p style="color: #b8242f; margin: 0;">✗ Error: ${error.message}</p>`;
        resultDiv.style.display = 'block';
    }
}

function updateSqlDbTypeFields() {
    const dbType = document.getElementById('sqlDbType').value;

    document.querySelectorAll('[id^="sqlDbEncrypt"], [id^="sqlDbTrustServerCert"]').forEach(el => {
        el.parentElement.style.display = dbType === 'mssql' ? 'flex' : 'none';
    });
}

function addSqlDatabase() {
    const dbSelect = document.getElementById('sqlDatabaseSelect');
    const form = document.getElementById('sqlDatabaseForm');
    
    dbSelect.value = '';
    selectedSqlDatabaseName = null;
    
    const resultDiv = document.getElementById('sqlTestResult');
    resultDiv.style.display = 'none';
    
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
        delete currentDatabases[dbName];
        
        const option = Array.from(dbSelect.options).find(opt => opt.value === dbName);

        if (option) {
            option.remove();
        }
        
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

async function openReloadPluginModal() {
    const pluginName = currentPluginName;

    if (!pluginName) {
        showStatusBanner('No plugin selected', 'error', 'pluginsStatusMessage');
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
            showStatusBanner(`Plugin "${pluginName}" reloaded successfully.`, 'success', 'pluginsStatusMessage');
        } else {
            showStatusBanner('Error reloading plugin: ' + (data.message || 'Unknown error'), 'error', 'pluginsStatusMessage');
        }
    } catch (error) {
        console.error('Error reloading plugin:', error);
        showStatusBanner('Error reloading plugin', 'error', 'pluginsStatusMessage');
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

        let newVersion = '1.0';

        if (currentPluginVersion) {
            const parts = currentPluginVersion.toString().split('.');

            if (parts.length === 2) {
                const major = parseInt(parts[0], 10) || 1;
                const minor = (parseInt(parts[1], 10) || 0) + 1;
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
                rateLimit: parseInt(document.getElementById('configRateLimit').value, 10) || 100,
                routes: document.getElementById('configRoutes').value.split('\n').filter(r => r.trim())
            },
            originalConfig: originalPluginConfig
        };

        if (originalPluginConfig && originalPluginConfig.code) {
            updates.code = originalPluginConfig.code;
        }

        const configType = document.getElementById('configTypeValue').textContent;

        if (configType === 'api') {
            const bearerFields = document.getElementById('bearerAuthFields');
            const clientFields = document.getElementById('clientAuthFields');

            if (bearerFields.style.display !== 'none') {
                updates.config.baseUrl = document.getElementById('configBaseUrl').value;
                updates.config.apiPath = document.getElementById('configApiPath').value;
                updates.config.apiKey = document.getElementById('configApiKey').value;
            } else if (clientFields.style.display !== 'none') {
                updates.config.baseUrl = document.getElementById('configClientBaseUrl').value;
                updates.config.apiPath = document.getElementById('configClientApiPath').value;
                updates.config.clientId = document.getElementById('configClientId').value;
                updates.config.publicKey = document.getElementById('configPublicKey').value;
                updates.config.privateKey = document.getElementById('configPrivateKey').value;
            }
            
            if (currentEditingHeaders && currentEditingHeaders.length > 0) {
                updates.config.headers = currentEditingHeaders;
            }
        } else if (configType === 'sql') {
            const currentDb = document.getElementById('sqlDatabaseSelect').value;

            if (currentDb) {
                saveSqlDatabaseForm(currentDb);
            }

            updates.config.databases = currentDatabases;
        }

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
        showStatusBanner('Please select a plugin first', 'error', 'pluginsStatusMessage');
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
                        showStatusBanner('Plugin "' + pluginName + '" reloaded successfully.', 'success', 'pluginsStatusMessage');
            loadPluginDetails(pluginName);
        } else {
                        showStatusBanner('Error: ' + (data.error || 'Unknown error'), 'error', 'pluginsStatusMessage');
        }
    } catch (error) {
                showStatusBanner('Error: ' + error.message, 'error', 'pluginsStatusMessage');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

/**
 * Render HTML for task inputs
 * @param {array} inputs - Array of input definitions
 * @param {object} task - The task object (for task_id)
 * @param {object} pluginConfig - Plugin configuration (for select field rendering)
 * @returns {string} - HTML string with taskInputs wrapper and all inputs
 */
function renderTaskInputsHtml(inputs, task, pluginConfig) {
    if (!inputs || inputs.length === 0) {
        return '<div id="taskInputs"></div>';
    }
    
    let html = '<div id="taskInputs">';
    
    inputs.forEach(input => {
        const inputId = input.name;
        
        html += `<div class="panel-level-3">`;
        
        if (input.type === 'boolean' || input.type === 'checkbox') {
            const isChecked = input.default === true ? 'checked' : '';
            html += `<div class="form-group--inline">`;
            html += `<input type="checkbox" id="${inputId}" ${isChecked}>`;
            html += `<label for="${inputId}">${escapeHtml(input.label || input.name)}</label>`;
            html += `</div>`;
        } else if (input.type === 'radio') {
            html += `<fieldset>`;
            html += `<legend>${escapeHtml(input.label || input.name)}`;
            if (input.required) {
                html += `  <span style="color: #b8242f; font-size: calc(100% - 1px);">* Required</span>`;
            }
            html += `</legend>`;
            
            const options = Array.isArray(input.options) ? input.options : [];
            options.forEach((option, index) => {
                const radioId = `${inputId}_${index}`;
                const optionValue = typeof option === 'object' ? option.value : option;
                const optionLabel = typeof option === 'object' ? option.label : option;
                const isChecked = input.default === optionValue ? 'checked' : '';
                
                html += `<div style="margin-bottom: 8px;">`;
                html += `<input type="radio" id="${radioId}" name="${inputId}" value="${escapeHtml(String(optionValue))}" ${isChecked}>`;
                html += `<label for="${radioId}" style="display: inline; margin-left: 4px;">${escapeHtml(optionLabel)}</label>`;
                html += `</div>`;
            });
            
            html += `</fieldset>`;
        } else {
            html += `<label for="${inputId}">`;
            html += `${escapeHtml(input.label || input.name)}`;
            if (input.required) {
                html += `  <span style="color: #b8242f; font-size: calc(100% - 1px);">* Required</span>`;
            }
            html += `</label>`;
            
            if (input.type === 'select') {
                html += renderSelectField(inputId, input, pluginConfig);
            } else if (input.type === 'textarea') {
                html += `<textarea id="${inputId}" placeholder="${escapeHtml(input.default || '')}"></textarea>`;
            } else if (input.type === 'number') {
                html += `<input type="number" id="${inputId}" placeholder="${escapeHtml(input.default || '')}">`;
            } else {
                html += `<input type="text" id="${inputId}" placeholder="${escapeHtml(input.default || '')}">`;
            }
        }
        
        html += `</div>`;
    });
    
    html += '</div>';
    
    return html;
}
/**
 * Extract input values from the taskInputs container
 * @returns {object} - Object with field names as keys and input values
 */
function extractTaskInputs() {
    const container = document.getElementById('taskInputs');
    if (!container) {
        console.error('taskInputs container not found');
        return {};
    }
    
    const values = {};
    container.querySelectorAll('input, select, textarea').forEach(el => {
        if (!el.id) return; // Skip inputs without IDs
        
        if (el.type === 'checkbox') {
            values[el.id] = el.checked;
        } else if (el.type === 'radio') {
            const checked = container.querySelector(`input[name="${el.name}"]:checked`);
            if (checked) values[el.id] = checked.value;
        } else {
            values[el.id] = el.value;
        }
    });
    return values;
}

/**
 * Fetch task details with resolved options
 * @param {number} taskId - The task ID to fetch
 * @returns {Promise<object>} - Task object with resolved options
 */
async function getTaskDetails(taskId) {
    try {
        const response = await fetch(`/kore/tasks/${taskId}`, {
            method: 'GET',
            headers: {
                'X-Session-Token': sessionToken,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to fetch task details');
        }

        const data = await response.json();
        return data.task;
    } catch (error) {
        console.error('Error fetching task details:', error);
        throw error;
    }
}