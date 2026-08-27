import '/lib/base.js';

// ============================================================================
// This module contains all plugin management functions and related UI logic.
// No external dependencies - uses base.js for authentication (getSessionToken, getUser)
// ============================================================================

// ============================================================================
// PLUGIN STATE VARIABLES
// ============================================================================

// Authentication - session token only. There was previously a cached
// `currentUser` here, populated from window.getUser() (localStorage) and sent
// as updated_by/username on plugin writes. The server never used those fields:
// created_by/updated_by are set from the verified authenticated user in every
// handler (see plugins.js handleAddPlugin / handleUpdatePlugin /
// handleUpdatePluginSecureConfig). The client no longer holds or asserts an
// identity at all.
// window.sessionToken itself no longer needs a local cache here: base.js
// establishes window.sessionToken once at module load (a synchronous
// cookie read), so every function below just reads it directly.
let pendingPluginCode = '';
let currentPluginName = '';
let currentPluginVersion = 0;
let originalPluginConfig = null;
let currentPlugin = null;  // Store full plugin object
let currentEditingHeaders = [];
let currentDatabases = {};
/**
 * Staged, unsaved "code" edit for the currently-open existing plugin -
 * same role as currentEditingHeaders/currentDatabases/currentSmtpProfiles:
 * a live value the person can change before Save Settings persists it,
 * kept separate from originalPluginConfig (the untouched snapshot from
 * when this plugin was loaded, used as the unsaved-changes baseline).
 * Initialized from plugin.code in populatePluginForm(), updated by
 * openExistingPluginCodeModal()'s onSave callback, read by
 * savePluginSettings() when building the update payload, and compared
 * against originalPluginConfig.code in updateSaveButtonState() to decide
 * whether Save Settings should be enabled - mutating
 * originalPluginConfig.code directly (an earlier version of this fix)
 * destroys the only baseline available for that comparison, so the two
 * have to stay separate the same way currentEditingHeaders and
 * originalPluginConfig.config.headers do.
 */
let currentPluginCode = '';
let selectedSqlDatabaseName = null;
let pluginTasksCache = {};


// ============================================================================
// UTILITY STEPS STATE
// (merged in from wf-utilsteps.js - manages workflow utility steps/Kore
// actions configuration and caching, fetched from /kore/workflow-utils)
// ============================================================================

let utilStepsCache = null;  // Cached array of all utility steps


// ============================================================================
// FETCH AND CACHE UTILITY STEPS
// ============================================================================

/**
 * Fetch all workflow utility steps from backend
 * Uses cache on subsequent calls
 * @returns {Promise<Array>} Array of utility step definitions
 */
async function fetchUtilSteps() {
    console.log('[fetchUtilSteps] Called');

    // Return from cache if already loaded
    if (utilStepsCache !== null) {
        console.log('[fetchUtilSteps] Returning cached util steps:', utilStepsCache.length, 'items');
        return utilStepsCache;
    }

    try {
        const response = await fetch('/kore/workflow-utils', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(window.sessionToken && { 'X-Session-Token': window.sessionToken })
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('[fetchUtilSteps] API error:', response.status, errorData.error);
            utilStepsCache = [];
            return [];
        }

        const data = await response.json();
        const utils = data.utils || [];

        console.log('[fetchUtilSteps] Loaded', utils.length, 'utility steps');

        // Cache the results
        utilStepsCache = utils;
        return utils;
    } catch (error) {
        console.error('[fetchUtilSteps] Error:', error.message);
        utilStepsCache = [];
        return [];
    }
}


// ============================================================================
// LOOKUP FUNCTIONS
// ============================================================================

/**
 * Get a specific utility step by action name
 * @param {string} actionName - The action_name to look up
 * @returns {Promise<Object|null>} The utility step definition or null if not found
 */
async function getUtilStep(actionName) {
    const utils = await fetchUtilSteps();
    return utils.find(u => u.action_name === actionName) || null;
}

/**
 * Get all utility steps in a specific category
 * @param {string} category - The category to filter by
 * @returns {Promise<Array>} Array of utility steps in that category
 */
async function getUtilStepsByCategory(category) {
    const utils = await fetchUtilSteps();
    return utils.filter(u => u.category === category);
}

/**
 * Get all available categories
 * @returns {Promise<Array>} Array of unique category names
 */
async function getUtilCategories() {
    const utils = await fetchUtilSteps();
    const categories = new Set(utils.map(u => u.category).filter(Boolean));
    return Array.from(categories).sort();
}

/**
 * Clear the cache (useful for refreshing after backend updates)
 */
function clearUtilStepsCache() {
    utilStepsCache = null;
    console.log('[clearUtilStepsCache] Cache cleared');
}


/**
 * Execute a plugin task via /executeTask endpoint
 * @param {number} taskId - The task ID to execute
 * @param {object} inputs - Input values for the task
 * @returns {Promise} - Response from the endpoint
 */
async function executeTask(taskId, inputs = {}) {
    try {
        console.log('[executeTask] Executing task:', { taskId, inputs });

        const response = await fetch('https://app.equinoxits.com:1139/executeTask', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': window.sessionToken
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
        const response = await fetch('https://app.equinoxits.com:1139/kore/plugins/list', {
            method: 'GET',
            headers: {
                'X-Session-Token': window.sessionToken,
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
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/${encodeURIComponent(pluginName)}/tasks`, {
            method: 'GET',
            headers: {
                'X-Session-Token': window.sessionToken,
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
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/details?name=${encodeURIComponent(pluginName)}`, {
            method: 'GET',
            headers: {
                'X-Session-Token': window.sessionToken,
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
 * Get a plugin's secure_config field list, fully masked (no reveal at all).
 * Never returns plaintext - see Kore Plugin System Reference §2.1.
 * @param {string} pluginName - The plugin name
 * @returns {Promise<Array<{key: string, masked: string}>>}
 */
async function getPluginSecureConfig(pluginName) {
    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/secure-config?name=${encodeURIComponent(pluginName)}`, {
            method: 'GET',
            headers: {
                'X-Session-Token': window.sessionToken,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data.fields || [];
    } catch (error) {
        console.error('[getPluginSecureConfig] Error:', error.message);
        throw error;
    }
}

/**
 * Write new values into a plugin's secure_config (merge, not replace).
 * @param {string} pluginName - The plugin name
 * @param {Object} updates - { key: newValue, ... } - only keys being changed
 * @returns {Promise<Object>}
 */
async function updatePluginSecureConfig(pluginName, updates) {
    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/secure-config/update?name=${encodeURIComponent(pluginName)}`, {
            method: 'POST',
            headers: {
                'X-Session-Token': window.sessionToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                // No updated_by: handleUpdatePluginSecureConfig takes the
                // acting user from the authenticated session and ignores any
                // client-supplied value, so sending one was dead weight that
                // only existed to justify a localStorage identity lookup.
                updates
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data;
    } catch (error) {
        console.error('[updatePluginSecureConfig] Error:', error.message);
        throw error;
    }
}

/**
 * Cap the masked value preview at 14 mask characters so long secrets don't
 * stretch the row - the value is already fully masked server-side, so this
 * is pure display truncation, not a reveal of any kind.
 * @param {string} masked - The masked value as returned by the API
 */
function formatMaskedPreview(masked) {
    const str = masked || '';
    if (str.length <= 14) return str;
    return '\u2022'.repeat(14);
}

/**
 * Currently-loaded plugin's secure_config key names, kept in sync by
 * loadSecureConfigFields(). Used by the Add Key modal to block adding a
 * key name that already exists (should be an Edit instead).
 */
let currentSecureConfigKeys = [];

/**
 * Fetch and render the masked secure_config fields for a plugin into
 * #secureConfigFieldsContainer. The panel itself stays visible for any
 * loaded plugin (even with zero secure_config keys yet) so Add Key is
 * always reachable. Each row shows the key name, a front-truncated masked
 * preview, and an Edit button that opens the edit modal.
 * @param {string} pluginName - The plugin name
 */
async function loadSecureConfigFields(pluginName) {
    const panel = document.getElementById('secureConfigContainer');
    const container = document.getElementById('secureConfigFieldsContainer');
    if (!panel || !container) return;

    panel.style.display = 'block';

    try {
        const fields = await getPluginSecureConfig(pluginName);
        currentSecureConfigKeys = (fields || []).map((f) => f.key);

        if (!fields || fields.length === 0) {
            container.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; margin: 0;">No secure fields configured yet.</p>';
            return;
        }

        container.innerHTML = '';

        fields.forEach((field) => {
            const row = document.createElement('div');
            row.className = 'form-group';
            row.innerHTML = `
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 3px; font-weight: 600;">${escapeHtml(field.key)}</label>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <span style="font-family: monospace; color: var(--text-muted); font-size: 12px;">${escapeHtml(formatMaskedPreview(field.masked))}</span>
                    <button type="button" class="btn" data-color="blue" data-size="sm" style="white-space: nowrap;">Edit</button>
                </div>
            `;
            const editBtn = row.querySelector('button');
            editBtn.addEventListener('click', () => openSecureConfigEditModal(pluginName, field.key, field.masked));
            container.appendChild(row);
        });
    } catch (error) {
        console.error('[loadSecureConfigFields] Error:', error.message);
        panel.style.display = 'none';
    }
}

/**
 * Open a modal to replace a single secure_config value: shows the key name
 * and a front-truncated masked preview (read-only), plus a New Value
 * textarea. Saves immediately via secure-config/update on click.
 * @param {string} pluginName - The plugin name
 * @param {string} key - The secure_config key being edited
 * @param {string} masked - The full masked value (for the preview display)
 */
function openSecureConfigEditModal(pluginName, key, masked) {
    const content = `
        <div style="display: flex; flex-direction: column; gap: 12px;">
            <div class="form-group">
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Key</label>
                <input type="text" value="${escapeHtml(key)}" readonly style="width: 100%;">
            </div>
            <div class="form-group">
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Current Value (masked)</label>
                <div style="font-family: monospace; font-size: 12px; color: var(--text-primary); word-break: break-all; white-space: pre-wrap;">${escapeHtml(masked)}</div>
            </div>
            <div class="form-group">
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">New Value</label>
                <textarea id="secureConfigEditNewValue" rows="4" placeholder="Enter new value" style="width: 100%; resize: vertical; word-break: break-all;"></textarea>
            </div>
        </div>
    `;

    window.showModal({
        title: `Edit Secure Value - ${key}`,
        content,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary', onClick: () => {} },
            {
                label: 'Save',
                type: 'success',
                onClick: async () => {
                    const textarea = document.getElementById('secureConfigEditNewValue');
                    const newValue = textarea ? textarea.value.trim() : '';

                    if (!newValue) {
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', 'Enter a new value before saving', 'error');
                        }
                        return false; // keep modal open
                    }

                    try {
                        await updatePluginSecureConfig(pluginName, { [key]: newValue });
                        await loadSecureConfigFields(pluginName);
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', `${key} updated`, 'success');
                        }
                        return true; // close modal
                    } catch (error) {
                        console.error('[openSecureConfigEditModal] Error:', error.message);
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', `Failed to update ${key}: ${error.message}`, 'error');
                        }
                        return false; // keep modal open
                    }
                }
            }
        ]
    });
}

/**
 * Open a modal to add a brand-new secure_config key (for seeding the first
 * value for a plugin, or adding an additional one alongside existing keys).
 * Blocks reusing a key name that's already loaded - that should go through
 * the Edit modal instead, so a typo can't silently overwrite an existing
 * credential. Uses currentPluginName from module state (called from a
 * static HTML button with no args).
 */
function openAddSecureConfigKeyModal() {
    if (!currentPluginName) return;

    const content = `
        <div style="display: flex; flex-direction: column; gap: 12px;">
            <div class="form-group">
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Key Name</label>
                <input type="text" id="secureConfigAddKeyName" placeholder="e.g. refreshToken" style="width: 100%;">
            </div>
            <div class="form-group">
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Value</label>
                <textarea id="secureConfigAddKeyValue" rows="4" placeholder="Enter value" style="width: 100%; resize: vertical; word-break: break-all;"></textarea>
            </div>
        </div>
    `;

    window.showModal({
        title: 'Add Secure Key',
        content,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary', onClick: () => {} },
            {
                label: 'Add',
                type: 'success',
                onClick: async () => {
                    const nameInput = document.getElementById('secureConfigAddKeyName');
                    const valueTextarea = document.getElementById('secureConfigAddKeyValue');
                    const key = nameInput ? nameInput.value.trim() : '';
                    const value = valueTextarea ? valueTextarea.value.trim() : '';

                    if (!key || !value) {
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', 'Enter both a key name and a value before saving', 'error');
                        }
                        return false; // keep modal open
                    }

                    if (currentSecureConfigKeys.includes(key)) {
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', `"${key}" already exists - use Edit to replace it instead`, 'error');
                        }
                        return false; // keep modal open
                    }

                    try {
                        await updatePluginSecureConfig(currentPluginName, { [key]: value });
                        await loadSecureConfigFields(currentPluginName);
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', `${key} added`, 'success');
                        }
                        return true; // close modal
                    } catch (error) {
                        console.error('[openAddSecureConfigKeyModal] Error:', error.message);
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', `Failed to add ${key}: ${error.message}`, 'error');
                        }
                        return false; // keep modal open
                    }
                }
            }
        ]
    });
}

/**
 * SMTP profile editor state - staged in memory, only persisted to the
 * plugin's config when "Save Settings" is clicked (same pattern as the SQL
 * panel's currentDatabases below).
 */
let currentSmtpProfiles = {};

/**
 * Show/hide and populate the SMTP Profiles panel - only relevant for the
 * smtp plugin itself. Stages a deep copy of config.smtp_profiles into
 * currentSmtpProfiles for editing.
 * @param {string} pluginName - The currently-loaded plugin's name
 * @param {object} config - The currently-loaded plugin's parsed config
 */
function loadSmtpProfilesPanel(pluginName, config) {
    const panel = document.getElementById('smtpProfilesContainer');
    if (!panel) return;

    if (pluginName !== 'smtp') {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    currentSmtpProfiles = JSON.parse(JSON.stringify((config && config.smtp_profiles) || {}));

    const select = document.getElementById('smtpProfileSelect');
    select.innerHTML = '<option value="">-- Select Profile --</option>';
    Object.keys(currentSmtpProfiles).forEach((profileName) => {
        const option = document.createElement('option');
        option.value = profileName;
        option.textContent = profileName;
        select.appendChild(option);
    });

    const form = document.getElementById('smtpProfileForm');
    if (form) form.style.display = 'none';

    const testBtn = document.getElementById('smtpTestBtn');
    const deleteBtn = document.getElementById('smtpDeleteBtn');
    if (testBtn) testBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;
}

function selectSmtpProfile() {
    const select = document.getElementById('smtpProfileSelect');
    const name = select.value;

    const form = document.getElementById('smtpProfileForm');
    const testBtn = document.getElementById('smtpTestBtn');
    const deleteBtn = document.getElementById('smtpDeleteBtn');

    if (!name) {
        if (form) form.style.display = 'none';
        if (testBtn) testBtn.disabled = true;
        if (deleteBtn) deleteBtn.disabled = true;
        return;
    }

    const profile = currentSmtpProfiles[name] || {};
    document.getElementById('smtpProfileHost').value = profile.smtp_host || '';
    document.getElementById('smtpProfilePort').value = profile.smtp_port || '';
    document.getElementById('smtpProfileUseTls').checked = !!profile.smtp_use_tls;
    document.getElementById('smtpProfileUsername').value = profile.smtp_username || '';
    document.getElementById('smtpProfileFrom').value = profile.smtp_from || '';

    if (form) form.style.display = 'block';
    if (testBtn) testBtn.disabled = false;
    if (deleteBtn) deleteBtn.disabled = false;
}

/**
 * Read the currently-shown profile form fields into currentSmtpProfiles
 * under the given name. Called right before Save Settings assembles the
 * full config, so whatever's currently on screen for the selected profile
 * is captured - same call pattern as the SQL panel's saveSqlDatabaseForm.
 */
function saveSmtpProfileForm(name) {
    if (!name) return;
    currentSmtpProfiles[name] = {
        smtp_host: document.getElementById('smtpProfileHost').value,
        smtp_port: parseInt(document.getElementById('smtpProfilePort').value, 10) || 587,
        smtp_use_tls: document.getElementById('smtpProfileUseTls').checked,
        smtp_username: document.getElementById('smtpProfileUsername').value,
        smtp_from: document.getElementById('smtpProfileFrom').value
    };
}

function addSmtpProfile() {
    window.showFormModal('New SMTP Profile', [
        {
            type: 'text',
            name: 'profileName',
            label: 'Profile Name',
            placeholder: 'e.g., default, gmail, office365',
            value: '',
            required: true
        }
    ], (formData) => {
        const profileName = document.getElementById('field_profileName').value.trim();

        if (!profileName) {
            window.showAlert('Validation Error', 'Profile name is required');
            return false;
        }
        if (currentSmtpProfiles[profileName]) {
            window.showAlert('Validation Error', 'A profile with this name already exists');
            return false;
        }

        currentSmtpProfiles[profileName] = {
            smtp_host: '',
            smtp_port: 587,
            smtp_use_tls: true,
            smtp_username: '',
            smtp_from: ''
        };

        const select = document.getElementById('smtpProfileSelect');
        const option = document.createElement('option');
        option.value = profileName;
        option.textContent = profileName;
        select.appendChild(option);
        select.value = profileName;

        selectSmtpProfile();
    });
}

function deleteSmtpProfile() {
    const select = document.getElementById('smtpProfileSelect');
    const name = select.value;
    if (!name) return;

    showConfirmModal('Delete SMTP Profile', `Delete SMTP profile "${name}"? This takes effect once you click Save Settings. Its stored password (if any) will remain in secure storage but become unused.`, () => {
        delete currentSmtpProfiles[name];

        const option = Array.from(select.options).find(opt => opt.value === name);
        if (option) option.remove();

        select.value = '';
        selectSmtpProfile();

        showStatusBanner(`SMTP profile "${name}" removed - click Save Settings to persist.`, 'success', 'pluginsStatusMessage');
    });
}

/**
 * Send a test email through the smtp plugin's own route directly
 * (POST /email/smtp) - same mechanism as the General tab's E-mail pod test
 * button, duplicated here in this module (rather than shared) since
 * plugins-front.js shouldn't depend on settings.js, which is the page that
 * imports it, not the other way around.
 */
async function sendSmtpPluginTestEmail(profileName, to, subject, html, plainText) {
    const response = await fetch('https://app.equinoxits.com:1139/email/smtp', {
        method: 'POST',
        headers: {
            'X-Session-Token': window.sessionToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            profile_name: profileName,
            to,
            subject,
            html,
            plainText
        })
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
}

function testSmtpPluginProfile() {
    const select = document.getElementById('smtpProfileSelect');
    const profileName = select ? select.value : '';
    if (!profileName) return;

    const modalContent = `
        <div style="display: flex; flex-direction: column; gap: 10px;">
            <div>
                <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Send Test Email To</label>
                <input type="email" id="smtpPluginTestEmailInput" placeholder="recipient@example.com" style="width: 100%;">
            </div>
        </div>
    `;

    window.showModal({
        title: `Test SMTP Profile - ${profileName}`,
        content: modalContent,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary', onClick: () => {} },
            {
                label: 'Send',
                type: 'success',
                onClick: async () => {
                    const input = document.getElementById('smtpPluginTestEmailInput');
                    const testEmail = input ? input.value.trim() : '';

                    if (!testEmail) {
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', 'Email address is required', 'error');
                        }
                        return false; // keep modal open
                    }

                    try {
                        await sendSmtpPluginTestEmail(
                            profileName,
                            testEmail,
                            'Test Email',
                            '<h2>Test Email</h2><p>This is a test email from the Kore Plugins tab.</p>',
                            'Test Email from the Kore Plugins tab.'
                        );
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', `Test email sent to ${testEmail}`, 'success');
                        }
                        return true; // close modal
                    } catch (error) {
                        console.error('[testSmtpPluginProfile] Error:', error.message);
                        if (window.showStatusMessage) {
                            window.showStatusMessage('pluginsStatusMessage', `Failed to send test email: ${error.message}`, 'error');
                        }
                        return false; // keep modal open
                    }
                }
            }
        ]
    });
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

        // Also check if code has changed - see currentPluginCode's
        // declaration comment for why this can't just be folded into
        // getCurrentPluginFormData()/window.hasUnsavedChanges() above:
        // there's no live on-screen code field for this to track
        // automatically the way display name/description/etc. are.
        if (!hasChanges && originalPluginConfig) {
            hasChanges = (originalPluginConfig.code || '') !== currentPluginCode;
            if (hasChanges) {
                console.log('Save button activated due to code changes');
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

/**
 * Wires "View Code" up to actually persist an edit for an ALREADY-LOADED
 * existing plugin - previously this button called openCodeModal(...,
 * null), and openCodeModal's no-callback branch is a straight no-op
 * (console.log only) - so editing code here silently discarded the edit
 * with no error, no warning, nothing. Confirmed directly while testing
 * the Import flow's code-handling (a bare "TEMP" plugin body failing to
 * load surfaced this same "code edits need a real save path" gap from a
 * different angle).
 *
 * Mirrors the Add-modal's own onSave (`(code) => { pendingPluginCode =
 * code; }`), but stages into currentPluginCode instead of mutating
 * originalPluginConfig.code directly - the latter is this plugin's
 * untouched original snapshot and doubles as the unsaved-changes
 * baseline (see currentPluginCode's own declaration comment for why an
 * earlier version of this fix, which wrote straight into
 * originalPluginConfig.code, silently broke Save Settings' disabled
 * state: comparing a value against itself never shows a difference).
 * updateSaveButtonState() now diffs currentPluginCode against
 * originalPluginConfig.code the same way it already diffs
 * currentEditingHeaders against originalPluginConfig.config.headers.
 */
function openExistingPluginCodeModal() {
    openCodeModal(currentPluginCode, (code) => {
        currentPluginCode = code;
        updateSaveButtonState();
        window.showStatusBanner('Code updated - click Save Settings to persist.', 'success', 'pluginsStatusMessage', 4000);
    });
}

/**
 * Shared read-only "View JSON" modal for both plugins and tasks - shows
 * the definition as pretty-printed JSON with a one-click Copy. Copy
 * mirrors doc-builder.js's copyDocId() pattern (navigator.clipboard.
 * writeText + success/error status banner) exactly. Deliberately
 * read-only - just Close, no Cancel/Import here - this is a viewer, not
 * an editor; pasting an edited copy back in is what Import Plugin /
 * Import (Update) / Import Task are for.
 */
function showJsonViewModal(title, dataObject, statusContainer) {
    const jsonText = JSON.stringify(dataObject, null, 2);
    const modalContent = document.createElement('div');
    modalContent.style.cssText = 'display: flex; flex-direction: column; height: 100%;';
    modalContent.innerHTML = `
        <textarea readonly style="width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.8rem; padding: 10px;
                   border: 1px solid var(--border-primary); border-radius: 4px; background: var(--bg-input); color: var(--text-primary); resize: vertical; flex: 1; min-height: 0;">${escapeHtml(jsonText)}</textarea>
    `;

    window.showModal({
        title: title,
        content: modalContent,
        resizable: true,
        buttons: [
            {
                label: 'Copy JSON',
                type: 'secondary',
                onClick: () => {
                    navigator.clipboard.writeText(jsonText).then(() => {
                        window.showStatusBanner('JSON copied to clipboard.', 'success', statusContainer, 2500);
                    }).catch(() => {
                        window.showStatusBanner('Could not copy JSON.', 'error', statusContainer);
                    });
                    return false; // keep the modal open after copying, same reasoning as elsewhere in this file
                }
            },
            { label: 'Close', type: 'primary' }
        ],
        width: '600px',
        height: '90vh'
    });
}

/**
 * Assembles the SAME { name, display_name, description, enabled, version,
 * code, config } shape Import Plugin / Import (Update) expect, from the
 * live on-screen state - i.e. a preview of exactly what Save Settings
 * would currently send, not necessarily what's in the DB right now if
 * there are unsaved edits. Deliberately duplicates
 * savePluginSettings()'s own config-assembly logic (including flushing
 * the currently-open SQL/SMTP sub-form the same way Save does) rather
 * than extracting a shared helper, to avoid touching that already-working
 * function for this addition - keep the two in sync by hand if either
 * one's shape changes.
 */
function viewPluginJson() {
    const configType = document.getElementById('configTypeValue').textContent;
    const config = {
        type: configType,
        rateLimit: parseInt(document.getElementById('configRateLimit').value, 10) || 100,
        routes: document.getElementById('configRoutes').value.split('\n').filter(r => r.trim())
    };

    if (configType === 'api') {
        const bearerFields = document.getElementById('bearerAuthFields');
        const clientFields = document.getElementById('clientAuthFields');
        if (bearerFields && bearerFields.style.display !== 'none') {
            config.baseUrl = document.getElementById('configBaseUrl').value;
            config.apiPath = document.getElementById('configApiPath').value;
        } else if (clientFields && clientFields.style.display !== 'none') {
            config.baseUrl = document.getElementById('configClientBaseUrl').value;
            config.apiPath = document.getElementById('configClientApiPath').value;
            config.clientId = document.getElementById('configClientId').value;
            config.publicKey = document.getElementById('configPublicKey').value;
        }
        if (currentEditingHeaders && currentEditingHeaders.length > 0) {
            config.headers = currentEditingHeaders;
        }
    } else if (configType === 'sql') {
        const currentDb = document.getElementById('sqlDatabaseSelect')?.value;
        if (currentDb) {
            saveSqlDatabaseForm(currentDb);
        }
        config.databases = currentDatabases;
    } else if (configType === 'service' && currentPluginName === 'smtp') {
        const currentProfile = document.getElementById('smtpProfileSelect')?.value;
        if (currentProfile) {
            saveSmtpProfileForm(currentProfile);
        }
        config.smtp_profiles = currentSmtpProfiles;
    }

    const definition = {
        name: currentPluginName,
        display_name: document.getElementById('pluginDisplayName').value,
        description: document.getElementById('pluginDescription').value,
        enabled: document.getElementById('pluginEnabled').checked,
        version: currentPluginVersion || '1.0',
        code: currentPluginCode || '',
        config: config
    };

    showJsonViewModal('Plugin Definition', definition, 'pluginsStatusMessage');
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

    // Previously short-circuited into a dead-end "No tasks available"
    // modal (Close button only) whenever a plugin had zero tasks - which
    // meant there was no way to add the FIRST task for a plugin through
    // this UI at all, manual or imported. Every freshly-created/imported
    // plugin starts at zero tasks, so this blocked the exact case it
    // needed to support most. The normal header row below already
    // degrades fine with an empty task list (the selector just shows its
    // placeholder option), so there's nothing the zero-tasks case actually
    // needed a separate branch for.
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
                <button type="button" class="btn" data-color="blue" onclick="openImportTaskModal()">Import Task</button>
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
                        // This onClick runs inside showModal's own button
                        // handling, where NOT returning false auto-closes
                        // the modal immediately once the handler returns -
                        // same convention used by the Import modals
                        // elsewhere in this file. Previously this branch
                        // called showUnsaved() (which opens its own
                        // stacked confirmation dialog) but never returned
                        // false, so the Plugin Tasks modal underneath was
                        // torn down right away regardless - the
                        // confirmation prompt never got a real chance to
                        // matter. Returning false here keeps the modal
                        // open until the person actually answers the
                        // prompt, and each of showUnsaved's own callbacks
                        // now explicitly closes it once that's decided.
                        showUnsaved(
                            async () => {
                                await saveTaskConfig(null);
                                window.pluginTaskHasUnsavedChanges = false;
                                showStatusBanner('Task saved successfully', 'success', 'pluginsStatusMessage');
                                window.closeModal();
                            },
                            () => {
                                window.pluginTaskHasUnsavedChanges = false;
                                window.closeModal();
                            }
                        );
                        return false;
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
    cfg.plugin_name = currentPluginName;
    cfg.route = detailsContainer.querySelector('.plugin-task-route')?.value || '';
    cfg.label_field = detailsContainer.querySelector('.plugin-task-label-field')?.value || '';
    cfg.value_field = detailsContainer.querySelector('.plugin-task-value-field')?.value || '';
    cfg.endpoint = detailsContainer.querySelector('.plugin-task-endpoint')?.value || '';
    cfg.method = detailsContainer.querySelector('.plugin-task-method')?.value || 'NA';

    cfg.static_params = collectPluginTaskStaticParams(detailsContainer, cfg.static_params);
    cfg.inputs = collectPluginTaskList(detailsContainer, '.plugin-task-inputs-container');
    cfg.outputs = collectPluginTaskList(detailsContainer, '.plugin-task-outputs-container');
}

/**
 * static_params is now a raw JSON textarea (see buildTaskDetailsHtml's own
 * comment on why) rather than a flat key/value list - real static_params
 * shapes vary too much (nested objects, subTask/subTaskMode patterns,
 * arrays like prependItems) for individual fields to keep up with.
 *
 * This runs on every keystroke via syncPluginTaskConfigFromDom() (see that
 * function's oninput/onchange wiring in initializeTaskUnsavedTracking), so
 * it must NOT throw or silently wipe out good data just because the JSON
 * is momentarily invalid mid-edit - that would either crash the page or
 * quietly discard a correct value the instant someone starts editing it.
 * Falls back to previousValue (the config's last successfully-parsed
 * static_params) on a parse failure, and flags the textarea's border so
 * there's a visible signal something's wrong. saveTaskConfig() does the
 * actual hard gate - it re-parses the raw textarea itself and refuses to
 * save if it's invalid, rather than silently saving whatever
 * previousValue happened to be.
 */
function collectPluginTaskStaticParams(root, previousValue) {
    const textarea = root.querySelector('.plugin-task-static-params-json');
    if (!textarea) return previousValue || {};

    const raw = textarea.value.trim();
    if (!raw) {
        textarea.style.borderColor = '';
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        textarea.style.borderColor = '';
        return parsed;
    } catch (e) {
        textarea.style.borderColor = 'var(--color-red, #c0392b)';
        return previousValue !== undefined ? previousValue : {};
    }
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
        const targetField = row.querySelector('.plugin-task-input-target');
        const urlTemplateField = row.querySelector('.plugin-task-input-urltemplate');
        const formatField = row.querySelector('.plugin-task-input-format');
        const ifCheckedField = row.querySelector('.plugin-task-input-ifchecked');
        const ifUncheckedField = row.querySelector('.plugin-task-input-ifunchecked');
        const bodyPathField = row.querySelector('.plugin-task-input-bodypath');
        const optionTaskInputsField = row.querySelector('.plugin-task-input-optiontaskinputs');

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
        if (targetField?.value) item.target = targetField.value;
        if (urlTemplateField?.value) item.urlTemplate = urlTemplateField.value;
        if (bodyPathField?.value) item.bodyPath = bodyPathField.value;

        // checkbox vs everything else are mutually exclusive - only ever
        // write the pair that matches this input's actual type, even if a
        // stale value is technically still sitting in the other (hidden)
        // field. This is what actually prevents the confirmed
        // format-on-a-checkbox bug at the data level, not just the
        // show/hide toggle in the UI (see updateTaskInputFieldVisibility()).
        if (item.type === 'checkbox') {
            if (ifCheckedField) item.ifChecked = ifCheckedField.value || '';
            if (ifUncheckedField) item.ifUnchecked = ifUncheckedField.value || '';
        } else if (formatField?.value) {
            item.format = formatField.value;
        }

        if (optionTaskInputsField?.value) {
            try {
                item.optionTaskInputs = JSON.parse(optionTaskInputsField.value.trim());
                optionTaskInputsField.style.borderColor = '';
            } catch (e) {
                optionTaskInputsField.style.borderColor = 'var(--color-red, #c0392b)';
                console.warn('Failed to parse optionTaskInputs JSON:', optionTaskInputsField.value);
            }
        }
        
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

/**
 * Swaps an input row between the "Format" field and the "If
 * Checked"/"If Unchecked" pair, based on its Type select - checkboxes use
 * ifChecked/ifUnchecked, everything else uses format; the two are never
 * both meaningful for the same input. Keeping only the relevant fields
 * visible (rather than showing all of them all the time) is a deliberate
 * defense against the exact confirmed production bug documented in the
 * Plugin System Reference: a checkbox built with "format" instead of
 * ifChecked/ifUnchecked silently does nothing at runtime, no error, no
 * visible symptom short of a live run returning unfiltered results.
 * collectPluginTaskList() also independently refuses to write out
 * "format" for a checkbox-type input regardless of this toggle's state,
 * so even a row that somehow still has a stale value sitting in a hidden
 * field can't produce that shape on save.
 */
/**
 * Shows/hides an input row's conditional fields based on its current
 * Type, Target, and Options values - previously every field (Format,
 * Body Path, Options, URL Template, Option Task Inputs) was always
 * visible regardless of whether it could do anything, which made it easy
 * to fill in a field with no effect (e.g. bodyPath on a pathParam input)
 * or miss one that actually mattered. Rules below are derived directly
 * from the real task data audited to build this editor - not guesses:
 *
 *   - Format: only meaningful for target in {conditions, condition,
 *     filter, query, body} - never seen paired with pathParam,
 *     tenantAuth, or tenantContext in real tasks, and never for
 *     checkbox (which uses ifChecked/ifUnchecked instead - see the
 *     header comment on collectPluginTaskList for why checkbox actively
 *     refuses to write "format" regardless of this toggle's state).
 *   - Body Path: only meaningful when Target = body.
 *   - Options: only meaningful for Type = select - no other type uses
 *     it anywhere in the real data.
 *   - URL Template / Option Task Inputs: only meaningful when Options
 *     actually has a value - both exist specifically to support
 *     @task.N-driven dropdowns (cascading selects, URL-templated option
 *     values), which requires Options to be set in the first place.
 *
 * Called on change of Type/Target and on input of Options, plus baked
 * into buildTaskDetailsHtml()'s and addListEntry()'s initial render via
 * the same conditions computed inline, so a freshly loaded/added row
 * starts in the correct state without waiting for an event to fire.
 */
function updateTaskInputFieldVisibility(el) {
    const row = el.closest('.plugin-task-list-row');
    if (!row) return;

    const typeField = row.querySelector('.plugin-task-input-type');
    const targetField = row.querySelector('.plugin-task-input-target');
    const optionsField = row.querySelector('.plugin-task-input-options');

    const type = typeField ? typeField.value : '';
    const target = targetField ? targetField.value : '';
    const hasOptions = !!(optionsField && optionsField.value.trim());

    const isCheckbox = type === 'checkbox';
    const isSelect = type === 'select';
    const formatApplicable = !isCheckbox && ['conditions', 'condition', 'filter', 'query', 'body'].includes(target);

    const formatRow = row.querySelector('.plugin-task-input-format-row');
    const checkboxRow = row.querySelector('.plugin-task-input-checkbox-row');
    const bodyPathRow = row.querySelector('.plugin-task-input-bodypath-row');
    const optionsRow = row.querySelector('.plugin-task-input-options-row');
    const dependentOptionsRow = row.querySelector('.plugin-task-input-dependent-options-row');

    if (formatRow) formatRow.style.display = formatApplicable ? 'block' : 'none';
    if (checkboxRow) checkboxRow.style.display = isCheckbox ? 'grid' : 'none';
    if (bodyPathRow) bodyPathRow.style.display = target === 'body' ? 'block' : 'none';
    if (optionsRow) optionsRow.style.display = isSelect ? 'block' : 'none';
    if (dependentOptionsRow) dependentOptionsRow.style.display = (isSelect && hasOptions) ? 'grid' : 'none';
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

    // Hard gate on static_params JSON validity, checked directly against
    // the live textarea rather than trusting collectPluginTaskStaticParams()'s
    // own return value - that function deliberately falls back to the
    // last-good value on a parse failure (see its own comment on why:
    // it runs on every keystroke and can't safely wipe data mid-edit), so
    // a currently-invalid textarea would otherwise save silently as
    // whatever the last VALID value happened to be, hiding the mistake
    // instead of blocking it.
    const detailsContainer = document.getElementById('taskDetailsContainer');
    const staticParamsTextarea = detailsContainer?.querySelector('.plugin-task-static-params-json');
    if (staticParamsTextarea) {
        const raw = staticParamsTextarea.value.trim();
        if (raw) {
            try {
                JSON.parse(raw);
            } catch (e) {
                showStatusBanner('Static Parameters is not valid JSON - fix it before saving.', 'error', statusContainer);
                return null;
            }
        }
    }

    syncPluginTaskConfigFromDom();
    const cfg = window.pluginTasksCurrentConfig;
    const isNewTask = cfg.task_id === null;

    console.log('[saveTaskConfig] Saving task config:', structuredClone(cfg));

    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/${encodeURIComponent(currentPluginName)}/tasks`, {
            method: 'POST',
            headers: {
                'X-Session-Token': window.sessionToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                task_id: isNewTask ? null : cfg.task_id,
                plugin_id: currentPlugin.id,
                plugin_name: currentPluginName,
                display_name: cfg.display_name,
                description: cfg.description,
                static_params: cfg.static_params || {},
                inputs: cfg.inputs || [],
                outputs: cfg.outputs || [],
                label_field: cfg.label_field,
                value_field: cfg.value_field,
                endpoint: cfg.endpoint,
                route: cfg.route,
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

/**
 * "View JSON" for the task currently open in the details pane. Reads from
 * window.pluginTasksOriginalConfigs[taskId] rather than
 * window.pluginTasksCurrentConfig - this matters more here than it does
 * for viewPluginJson()'s equivalent choice, and is worth spelling out:
 * the task selector's own change handler (and initializeTaskUnsavedTracking,
 * called right after it) runs syncPluginTaskConfigFromDom() immediately
 * on SELECTING a task - not just on Save. That means
 * pluginTasksCurrentConfig gets flattened down to whatever the visible
 * form fields can represent the moment a task is opened, well before
 * anyone clicks anything - so it's already lossy by the time this button
 * is even clickable. pluginTasksOriginalConfigs, by contrast, is a deep
 * clone taken directly from the fetch response and never touched by
 * syncPluginTaskConfigFromDom() - it's the only in-memory copy that still
 * reflects target/format/bodyPath/tenantAuth/ifChecked-ifUnchecked/nested
 * static_params exactly as they're actually stored, making this the
 * closest thing this UI has to confirming what a task really looks like
 * server-side without a direct DB query.
 *
 * Falls back to pluginTasksCurrentConfig only for a brand-new, not-yet-
 * saved task (task_id is null, so there's nothing in
 * pluginTasksOriginalConfigs to look up yet) - already been through one
 * sync pass by that point, but it's the best available view until Save.
 */
function viewTaskJson(taskId) {
    let taskJson;

    if (taskId && window.pluginTasksOriginalConfigs && window.pluginTasksOriginalConfigs[taskId]) {
        taskJson = window.pluginTasksOriginalConfigs[taskId];
    } else if (window.pluginTasksCurrentConfig) {
        taskJson = window.pluginTasksCurrentConfig;
    } else {
        showStatusBanner('No task loaded to view.', 'error', 'taskStatusMessage');
        return;
    }

    showJsonViewModal('Task Definition', taskJson, 'taskStatusMessage');
}

/**
 * "Import Task" - sits alongside the existing "+ Add Task" manual form,
 * rather than replacing it (unlike Import Plugin, which replaced Add
 * Plugin outright - see that function's own comment for why). Reason for
 * the difference: Add Plugin was replaceable because it genuinely
 * couldn't build a working sql-type plugin at all. The manual task editor
 * isn't unusable in the same way - simple root-level-input tasks (no
 * target/conditions/body-mapping needed) work fine through it - it's just
 * incomplete for anything richer. Import Task exists for that richer
 * case; the manual form stays for the simple one.
 *
 * Deliberately POSTs the parsed definition straight to the same
 * /kore/plugins/:name/tasks endpoint saveTaskConfig() uses, rather than
 * populating buildTaskDetailsHtml()'s on-screen fields the way
 * openImportPluginUpdateModal() populates the plugin edit form. This is
 * NOT the same choice made there, and deliberately so: the task editor's
 * own syncPluginTaskConfigFromDom() (called by saveTaskConfig() on every
 * save) rebuilds inputs/static_params/outputs entirely FROM THE VISIBLE
 * FORM FIELDS, which - per the plugin admin audit - has no field at all
 * for target, format, bodyPath, tenantAuth, tenantContext,
 * optionTaskInputs, checkbox ifChecked/ifUnchecked, or nested-object
 * static_params (subTaskMode, addField, etc.). Populating the visible
 * form with a rich imported definition and leaving the actual save to the
 * existing Save button would silently strip every one of those fields
 * back out the moment that button is clicked - the exact opposite of
 * what importing a rich task definition is for. Posting directly bypasses
 * that round-trip entirely; the server's own _saveTasks() stores whatever
 * JSON it's given verbatim, no field allowlist.
 *
 * Real, ongoing consequence of that choice worth knowing: if someone
 * later opens an imported task that uses any of those fields in the
 * manual editor and clicks its Save button - even without touching
 * anything - syncPluginTaskConfigFromDom() will still silently rebuild
 * inputs/static_params from the visible (incomplete) form and overwrite
 * the richer stored version. Nothing currently in the manual editor
 * guards against this. Safest practice until the editor itself grows
 * those fields: don't open an Import-created task in the manual editor
 * unless you're prepared to re-import it afterward.
 *
 * Same JSON shape _saveTasks()/saveTaskConfig() already use: { task_id?,
 * display_name, description?, static_params?, inputs?, outputs?,
 * label_field?, value_field?, endpoint?, route, method? }. `task_id`, if
 * present, updates that existing task (same create-vs-update dispatch
 * _saveTasks() already does on presence/absence of task_id); if omitted,
 * a new task is created. `plugin_name`/`plugin_id` are NOT part of this
 * shape - same "context, not content" reasoning as username/folderId
 * elsewhere: which plugin a task belongs to is implied by which plugin's
 * Tasks modal is open, not something a pasted definition should redirect
 * on its own.
 */
function openImportTaskModal() {
    if (!currentPluginName) {
        showStatusBanner('No plugin selected.', 'error', 'taskStatusMessage');
        return;
    }

    const modalContent = document.createElement('div');
    modalContent.style.cssText = 'display: flex; flex-direction: column; height: 100%;';
    modalContent.innerHTML = `
        <div style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
            <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary); flex-shrink: 0;">Task Definition JSON</label>
            <textarea id="importTaskDefinitionInput" placeholder="Paste the task definition JSON here"
                style="width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.8rem; padding: 10px;
                       border: 1px solid var(--border-primary); border-radius: 4px; background: var(--bg-input); color: var(--text-primary); resize: vertical; flex: 1; min-height: 0;"></textarea>
            <div style="margin-top: 8px; font-size: 0.75rem; color: var(--text-muted); flex-shrink: 0;">
                Required: display_name, route. Include task_id to update an existing task; omit it to create a new one.
                Saved directly - not run through the manual editor's fields, so target/format/bodyPath/tenantAuth/checkbox ifChecked-ifUnchecked/nested static_params all come through intact.
            </div>
        </div>
    `;

    window.showModal({
        title: 'Import Task',
        content: modalContent,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Import',
                type: 'success',
                onClick: () => {
                    (async () => {
                        const rawJson = modalContent.querySelector('#importTaskDefinitionInput').value.trim();
                        if (!rawJson) {
                            showPluginModalError('Paste a task definition JSON before importing.');
                            return;
                        }

                        let definition;
                        try {
                            definition = JSON.parse(rawJson);
                        } catch (e) {
                            showPluginModalError(`Invalid JSON: ${e.message}`);
                            return;
                        }

                        if (!definition.display_name) {
                            showPluginModalError('Definition must include "display_name".');
                            return;
                        }

                        if (!definition.route) {
                            showPluginModalError('Definition must include "route" - a task with no route can never be dispatched to a handler.');
                            return;
                        }

                        const inputs = Array.isArray(definition.inputs) ? definition.inputs : [];
                        const outputs = Array.isArray(definition.outputs) ? definition.outputs : [];

                        // Catches the exact confirmed production bug documented in
                        // the Plugin System Reference (cwm tasks 4/103/105): a
                        // checkbox input built with "format" instead of
                        // ifChecked/ifUnchecked silently appends nothing regardless
                        // of checked state - no error, no visible symptom short of
                        // a live run returning unfiltered results.
                        const badCheckbox = inputs.find(i => i.type === 'checkbox' && i.format !== undefined && (i.ifChecked === undefined || i.ifUnchecked === undefined));
                        if (badCheckbox) {
                            showPluginModalError(`Input "${badCheckbox.name || '(unnamed)'}" is type "checkbox" with a "format" key - checkboxes use "ifChecked"/"ifUnchecked" instead, "format" is never read for them. Fix this input before importing.`);
                            return;
                        }

                        // Catches the confirmed Task Test crash from a non-string
                        // "default" (System Reference \u00a73.5) - e.g. {"type":
                        // "number", "default": 100} instead of "default": "100".
                        const badDefault = [...inputs, ...outputs].find(i => i.default !== undefined && typeof i.default !== 'string');
                        if (badDefault) {
                            showPluginModalError(`Input/output "${badDefault.name || '(unnamed)'}" has a non-string "default" (${JSON.stringify(badDefault.default)}) - this crashes Task Test the moment the task is opened. Quote it as a string instead.`);
                            return;
                        }

                        try {
                            const payload = {
                                task_id: definition.task_id || null,
                                plugin_name: currentPluginName,
                                display_name: definition.display_name,
                                description: definition.description || '',
                                static_params: definition.static_params || {},
                                inputs: inputs,
                                outputs: outputs,
                                label_field: definition.label_field || '',
                                value_field: definition.value_field || '',
                                endpoint: definition.endpoint || '',
                                route: definition.route,
                                method: definition.method || 'NA'
                            };

                            const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/${encodeURIComponent(currentPluginName)}/tasks`, {
                                method: 'POST',
                                headers: {
                                    'X-Session-Token': window.sessionToken,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify(payload)
                            });

                            const result = await response.json().catch(() => ({}));

                            if (!response.ok || !result.success) {
                                showPluginModalError(result.error || `HTTP ${response.status}: import failed`);
                                return;
                            }

                            window.closeModal(); // explicit - see comment on onClick above in openImportPluginModal()

                            const taskId = payload.task_id || result.task_id;
                            await refreshPluginTaskSelector(taskId);

                            // refreshPluginTaskSelector() only rebuilds the <select>'s
                            // <option>s (with the right one marked selected) - it
                            // doesn't fire a change event, so the details pane won't
                            // load on its own. Dispatching one reuses the exact same
                            // load-into-editor logic openTasksModal()'s own change
                            // handler already runs for a manual selection, rather than
                            // duplicating it here.
                            const taskSelector = document.getElementById('taskSelector');
                            if (taskSelector) {
                                taskSelector.value = String(taskId);
                                taskSelector.dispatchEvent(new Event('change'));
                            }

                            showStatusBanner(`Task "${payload.display_name}" imported successfully.`, 'success', 'taskStatusMessage');
                        } catch (error) {
                            showPluginModalError('Error importing task: ' + error.message);
                        }
                    })();
                    return false;
                }
            }
        ],
        width: '600px',
        height: '90vh'
    });
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
        plugin_name: currentPluginName,
        display_name: '',
        description: '',
        label_field: '',
        value_field: '',
        endpoint: '',
        route: '',
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
        <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
            <button type="button" class="btn" data-color="blue" data-size="sm" onclick="viewTaskJson(${task.task_id ? task.task_id : 'null'})">View JSON</button>
        </div>
    `;
    
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
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Static Parameters (JSON)</label>
            <textarea class="plugin-task-static-params-json" style="width: 100%; min-height: 100px; font-family: monospace; font-size: 11px; resize: vertical;">${escapeHtml(JSON.stringify(task.static_params || {}, null, 2))}</textarea>
            <div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
                Raw JSON, not a key/value list - real static_params shapes vary too much for individual fields (nested objects, subTask/subTaskMode patterns, arrays like prependItems). Invalid JSON here blocks Save until fixed.
            </div>
        </div>
    `;
    
    html += '</div>';
    
    html += '<div>';
    
    html += `
        <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px; font-weight: 600;">Route</label>
            <select class="plugin-task-route" style="width: 100%;">
                <option value="">-- Select Route --</option>
                ${(pluginConfig?.config?.routes || []).map(r => `<option value="${escapeHtml(r)}" ${task.route === r ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
            </select>
        </div>
    `;

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
                <option value="PATCH" ${(task.method || 'NA') === 'PATCH' ? 'selected' : ''}>PATCH</option>
                <option value="DELETE" ${(task.method || 'NA') === 'DELETE' ? 'selected' : ''}>DELETE</option>
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
                                <select class="plugin-task-input-type" onchange="updateTaskInputFieldVisibility(this)" style="width: 100%; font-size: 11px;">
                                    <option value="">-- Select --</option>
                                    <option value="text" ${input.type === 'text' ? 'selected' : ''}>text</option>
                                    <option value="number" ${input.type === 'number' ? 'selected' : ''}>number</option>
                                    <option value="boolean" ${input.type === 'boolean' ? 'selected' : ''}>boolean</option>
                                    <option value="checkbox" ${input.type === 'checkbox' ? 'selected' : ''}>checkbox</option>
                                    <option value="select" ${input.type === 'select' ? 'selected' : ''}>select</option>
                                    <option value="textarea" ${input.type === 'textarea' ? 'selected' : ''}>textarea</option>
                                    <option value="object" ${input.type === 'object' ? 'selected' : ''}>object</option>
                                </select>
                            </div>
                            <div style="display: flex; align-items: flex-end; gap: 6px;">
                                <div style="flex: 1;">
                                    <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Default</label>
                                    <input type="text" class="plugin-task-input-default" value="${escapeHtml(String(input.default ?? ''))}" placeholder="Default value" style="width: 100%; font-size: 11px;">
                                </div>
                                <div style="display: flex; align-items: center; gap: 3px;">
                                    <input type="checkbox" class="plugin-task-input-required" ${input.required ? 'checked' : ''} style="width: 14px; height: 14px; cursor: pointer;">
                                    <label style="color: var(--text-muted); font-size: 10px; cursor: pointer; margin: 0; white-space: nowrap;">Required</label>
                                </div>
                            </div>
                        </div>
                        <div style="margin-bottom: 6px;">
                            <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Target</label>
                            <select class="plugin-task-input-target" onchange="updateTaskInputFieldVisibility(this)" style="width: 100%; font-size: 11px;">
                                <option value="" ${!input.target ? 'selected' : ''}>-- None (root-level) --</option>
                                <option value="pathParam" ${input.target === 'pathParam' ? 'selected' : ''}>pathParam</option>
                                <option value="conditions" ${input.target === 'conditions' ? 'selected' : ''}>conditions</option>
                                <option value="condition" ${input.target === 'condition' ? 'selected' : ''}>condition (legacy spelling - cwa tasks only)</option>
                                <option value="filter" ${input.target === 'filter' ? 'selected' : ''}>filter</option>
                                <option value="query" ${input.target === 'query' ? 'selected' : ''}>query</option>
                                <option value="body" ${input.target === 'body' ? 'selected' : ''}>body</option>
                                <option value="tenantAuth" ${input.target === 'tenantAuth' ? 'selected' : ''}>tenantAuth</option>
                                <option value="tenantContext" ${input.target === 'tenantContext' ? 'selected' : ''}>tenantContext</option>
                            </select>
                        </div>
                        <div class="plugin-task-input-format-row" style="display: ${(input.type !== 'checkbox' && ['conditions', 'condition', 'filter', 'query', 'body'].includes(input.target)) ? 'block' : 'none'}; margin-bottom: 6px;">
                            <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Format (template - use {value} for the input's value)</label>
                            <input type="text" class="plugin-task-input-format" value="${escapeHtml(input.format || '')}" placeholder='e.g. company/id={value} or {"id": {value}}' style="width: 100%; font-size: 11px;">
                        </div>
                        <div class="plugin-task-input-checkbox-row" style="display: ${input.type === 'checkbox' ? 'grid' : 'none'}; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;">
                            <div>
                                <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">If Checked</label>
                                <input type="text" class="plugin-task-input-ifchecked" value="${escapeHtml(input.ifChecked || '')}" placeholder='e.g. board/id in (1,5,6)' style="width: 100%; font-size: 11px;">
                            </div>
                            <div>
                                <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">If Unchecked</label>
                                <input type="text" class="plugin-task-input-ifunchecked" value="${escapeHtml(input.ifUnchecked || '')}" placeholder='e.g. closedFlag = false' style="width: 100%; font-size: 11px;">
                            </div>
                        </div>
                        <div class="plugin-task-input-bodypath-row" style="display: ${input.target === 'body' ? 'block' : 'none'}; margin-bottom: 6px;">
                            <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Body Path (dot-notation)</label>
                            <input type="text" class="plugin-task-input-bodypath" value="${escapeHtml(input.bodyPath || '')}" placeholder="e.g. body.content or passwordProfile.password" style="width: 100%; font-size: 11px;">
                        </div>
                        <div class="plugin-task-input-options-row" style="display: ${input.type === 'select' ? 'block' : 'none'}; margin-bottom: 6px;">
                            <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Options (comma-separated, JSON array, or @config.path)</label>
                            <input type="text" class="plugin-task-input-options" oninput="updateTaskInputFieldVisibility(this)" value="${escapeHtml(Array.isArray(input.options) ? JSON.stringify(input.options) : input.options || '')}" placeholder='["option1", "option2"] or option1, option2 or @config.databases' style="width: 100%; font-size: 11px;">
                            <div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
                                ${input.options && typeof input.options === 'string' && input.options.startsWith('@config.') ? `<div style="padding: 4px; background: var(--bg-tertiary); border-radius: 3px; margin-top: 2px;">Reference: ${escapeHtml(formatOptionsDisplay(input.options, pluginConfig))}</div>` : ''}
                            </div>
                        </div>
                        <div class="plugin-task-input-dependent-options-row" style="display: ${(input.type === 'select' && (Array.isArray(input.options) ? input.options.length > 0 : !!(input.options || '').toString().trim())) ? 'grid' : 'none'}; grid-template-columns: 1fr 1fr; gap: 6px;">
                            <div>
                                <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">URL Template (optional)</label>
                                <input type="text" class="plugin-task-input-urltemplate" value="${escapeHtml(input.urlTemplate || '')}" placeholder="e.g. https://graph.microsoft.com/v1.0/directoryObjects/{value}" style="width: 100%; font-size: 11px;">
                            </div>
                            <div>
                                <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Option Task Inputs (JSON object)</label>
                                <input type="text" class="plugin-task-input-optiontaskinputs" value="${escapeHtml(input.optionTaskInputs ? JSON.stringify(input.optionTaskInputs) : '')}" placeholder='{"customerTenantId": "{customerTenantId}"}' style="width: 100%; font-size: 11px;">
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
            <button type="button" class="btn" data-color="green" data-size="sm" style="margin-bottom: 10px; width: 100%;" onclick="addListEntry('outputsContainer_${task.task_id}', 'output')">Add Output</button>
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

function addListEntry(containerId, kind = 'input') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const noItemsMsg = container.querySelector('.plugin-task-empty-message');
    if (noItemsMsg) noItemsMsg.remove();

    // Two genuinely different row shapes share this one function - inputs
    // get the full target/format/checkbox/bodyPath/options/optionTaskInputs
    // set (mirroring buildTaskDetailsHtml()'s per-input template exactly),
    // outputs get the much simpler Type/Description pair. Previously this
    // always rendered the input template regardless of which "Add" button
    // was clicked, so a freshly-added output row came with a nonsensical
    // Required checkbox and Options field, and no Description field at
    // all - a real, if minor, pre-existing bug independent of the field
    // additions here, fixed alongside them since this is the same
    // function either way.
    const detailsHtml = kind === 'output' ? `
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                    <div>
                        <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Type</label>
                        <select class="plugin-task-output-type" style="width: 100%; font-size: 11px;">
                            <option value="">-- Select --</option>
                            <option value="string">string</option>
                            <option value="number">number</option>
                            <option value="boolean">boolean</option>
                            <option value="array">array</option>
                            <option value="object">object</option>
                        </select>
                    </div>
                    <div>
                        <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Description</label>
                        <input type="text" class="plugin-task-output-description" placeholder="Description" style="width: 100%; font-size: 11px;">
                    </div>
                </div>
    ` : `
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;">
                    <div>
                        <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Type</label>
                        <select class="plugin-task-input-type" onchange="updateTaskInputFieldVisibility(this)" style="width: 100%; font-size: 11px;">
                            <option value="">-- Select --</option>
                            <option value="text">text</option>
                            <option value="number">number</option>
                            <option value="boolean">boolean</option>
                            <option value="checkbox">checkbox</option>
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
                <div style="margin-bottom: 6px;">
                    <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Target</label>
                    <select class="plugin-task-input-target" onchange="updateTaskInputFieldVisibility(this)" style="width: 100%; font-size: 11px;">
                        <option value="" selected>-- None (root-level) --</option>
                        <option value="pathParam">pathParam</option>
                        <option value="conditions">conditions</option>
                        <option value="condition">condition (legacy spelling - cwa tasks only)</option>
                        <option value="filter">filter</option>
                        <option value="query">query</option>
                        <option value="body">body</option>
                        <option value="tenantAuth">tenantAuth</option>
                        <option value="tenantContext">tenantContext</option>
                    </select>
                </div>
                <div class="plugin-task-input-format-row" style="display: none; margin-bottom: 6px;">
                    <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Format (template - use {value} for the input's value)</label>
                    <input type="text" class="plugin-task-input-format" placeholder='e.g. company/id={value} or {"id": {value}}' style="width: 100%; font-size: 11px;">
                </div>
                <div class="plugin-task-input-checkbox-row" style="display: none; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;">
                    <div>
                        <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">If Checked</label>
                        <input type="text" class="plugin-task-input-ifchecked" placeholder='e.g. board/id in (1,5,6)' style="width: 100%; font-size: 11px;">
                    </div>
                    <div>
                        <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">If Unchecked</label>
                        <input type="text" class="plugin-task-input-ifunchecked" placeholder='e.g. closedFlag = false' style="width: 100%; font-size: 11px;">
                    </div>
                </div>
                <div class="plugin-task-input-bodypath-row" style="display: none; margin-bottom: 6px;">
                    <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Body Path (dot-notation)</label>
                    <input type="text" class="plugin-task-input-bodypath" placeholder="e.g. body.content or passwordProfile.password" style="width: 100%; font-size: 11px;">
                </div>
                <div class="plugin-task-input-options-row" style="display: none; margin-bottom: 6px;">
                    <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Options (comma-separated, JSON array, or @config.path)</label>
                    <input type="text" class="plugin-task-input-options" oninput="updateTaskInputFieldVisibility(this)" placeholder='["option1", "option2"] or option1, option2 or @config.databases' style="width: 100%; font-size: 11px;">
                </div>
                <div class="plugin-task-input-dependent-options-row" style="display: none; grid-template-columns: 1fr 1fr; gap: 6px;">
                    <div>
                        <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">URL Template (optional)</label>
                        <input type="text" class="plugin-task-input-urltemplate" placeholder="e.g. https://graph.microsoft.com/v1.0/directoryObjects/{value}" style="width: 100%; font-size: 11px;">
                    </div>
                    <div>
                        <label style="display: block; color: var(--text-muted); font-size: 10px; margin-bottom: 2px;">Option Task Inputs (JSON object)</label>
                        <input type="text" class="plugin-task-input-optiontaskinputs" placeholder='{"customerTenantId": "{customerTenantId}"}' style="width: 100%; font-size: 11px;">
                    </div>
                </div>
    `;

    const html = `
        <div class="plugin-task-list-row" style="display: flex; flex-direction: column; gap: 3px; padding: 6px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 4px;">
            <!-- Basic fields -->
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 3px; align-items: center;">
                <input type="text" class="plugin-task-list-name" placeholder="Name" style="font-size: 11px;">
                <input type="text" class="plugin-task-list-label" placeholder="Label" style="font-size: 11px;">
                <button type="button" class="btn" data-color="red" data-size="sm" onclick="removePluginTaskConfigRow(this)">×</button>
            </div>
            <!-- Expanded fields -->
            <div class="${kind === 'output' ? 'plugin-task-output-details' : 'plugin-task-input-details'}" style="display: none; border-top: 1px solid var(--border-primary); padding-top: 6px; margin-top: 3px;">
                ${detailsHtml}
            </div>
            <!-- Toggle button -->
            <button type="button" class="${kind === 'output' ? 'plugin-task-toggle-output-details' : 'plugin-task-toggle-details'}" style="align-self: flex-start; font-size: 10px; padding: 2px 6px; background: none; border: none; color: var(--text-accent); cursor: pointer; text-decoration: underline;">More options</button>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);
    
    // Setup toggle button for new entry
    const newRow = container.querySelector('.plugin-task-list-row:last-child');
    const toggleBtn = newRow.querySelector(kind === 'output' ? '.plugin-task-toggle-output-details' : '.plugin-task-toggle-details');
    const detailsDiv = newRow.querySelector(kind === 'output' ? '.plugin-task-output-details' : '.plugin-task-input-details');
    
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
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/${encodeURIComponent(pluginName)}/tasks`, {
            method: 'GET',
            headers: {
                'X-Session-Token': window.sessionToken,
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

/**
 * Stacked error modal for the plugin Import modals - same pattern as
 * docs.js's showDocModalError(). Opens on top of the still-open Import
 * modal (window.showModal supports this natively via modalStack's
 * z-index/offset logic) rather than an inline banner, so a rejected paste
 * is never silently lost underneath a banner the person might miss, and
 * the textarea's contents survive the round trip for a quick fix + retry.
 */
function showPluginModalError(message) {
    window.showModal({
        title: 'Error',
        content: `<p style="color: var(--text-primary); margin: 0;">${window.escapeHtml(message)}</p>`,
        buttons: [{ label: 'OK', type: 'primary', onClick: () => {} }]
    });
}

/**
 * "Import Plugin" - replaces the old field-by-field Add Plugin form
 * entirely. Rationale: the form version could only ever build the most
 * basic `api`-type plugin shape (see audit notes) - it had no path at all
 * for `sql`-type plugins (no fields tagged for that type anywhere), and
 * even for `api` it covered only a handful of the real config shapes
 * plugins actually use in production (two-tier auth, WebSocket transports,
 * per-datasource SQL configs, etc.) Every real plugin in the current
 * registry was, in practice, hand-built via direct SQL against the
 * `plugins` table rather than through this form. Pasting the same JSON
 * shape that a hand-written INSERT would use sidesteps the form entirely -
 * whatever shape a plugin's `config` needs, it's just present in the
 * pasted JSON, no dedicated input required for it.
 *
 * Mirrors docs.js's openImportDocModal(): textarea + Cancel/Import
 * buttons, sync onClick with an inner async IIFE (showModal's button
 * handler captures onClick()'s return value BEFORE awaiting it, so an
 * async () => {...} onClick would always hand back a Promise - never
 * actually `=== false` - and the modal would auto-close regardless of
 * whether the import actually succeeded; the plain-sync-return-false +
 * inner-IIFE shape avoids that here the same way it does there).
 *
 * Expected JSON shape: { name, display_name, description?, enabled?,
 * version?, code?, config }. `name`, `display_name`, and `config` are
 * required; `config` itself must be an object with a `type` of "api",
 * "sql", or "service" - config.type is required by the plugin admin UI's
 * own rendering logic (a plugin whose config never got issued a `type` at
 * all has no crash and no visible error, it just permanently renders with
 * no Test/Run affordance in the Task Test screen - a real, previously
 * confirmed incident, not a hypothetical). Rejecting an untyped config
 * here catches that mistake at import time instead of discovering it days
 * later on a totally different page.
 *
 * `username`/`created_by` deliberately do NOT come from the pasted JSON -
 * same reasoning docs.js applies to `folderId`: authorship is a
 * fact about who is performing the action right now, not plugin content,
 * so it always comes from the authenticated session, never from a field
 * an import definition could set on someone else's behalf. That resolution
 * happens server-side in handleAddPlugin - the client sends no identity at
 * all, so there is nothing for an import payload to override.
 */
function openImportPluginModal() {
    const modalContent = document.createElement('div');
    modalContent.style.cssText = 'display: flex; flex-direction: column; height: 100%;';
    modalContent.innerHTML = `
        <div style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
            <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary); flex-shrink: 0;">Plugin Definition JSON</label>
            <textarea id="importPluginDefinitionInput" placeholder="Paste the plugin definition JSON here"
                style="width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.8rem; padding: 10px;
                       border: 1px solid var(--border-primary); border-radius: 4px; background: var(--bg-input); color: var(--text-primary); resize: vertical; flex: 1; min-height: 0;"></textarea>
            <div style="margin-top: 8px; font-size: 0.75rem; color: var(--text-muted); flex-shrink: 0;">
                Required: name, display_name, config (config.type must be "api", "sql", or "service"). secure_config is never part of this JSON - add secrets afterward via the Secure Configuration panel.
            </div>
        </div>
    `;

    window.showModal({
        title: 'Import Plugin',
        content: modalContent,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Import',
                type: 'success',
                onClick: () => {
                    (async () => {
                        const rawJson = modalContent.querySelector('#importPluginDefinitionInput').value.trim();
                        if (!rawJson) {
                            showPluginModalError('Paste a plugin definition JSON before importing.');
                            return;
                        }

                        let definition;
                        try {
                            definition = JSON.parse(rawJson);
                        } catch (e) {
                            showPluginModalError(`Invalid JSON: ${e.message}`);
                            return;
                        }

                        if (!definition.name || !definition.display_name) {
                            showPluginModalError('Definition must include "name" and "display_name".');
                            return;
                        }

                        if (!definition.config || typeof definition.config !== 'object' || Array.isArray(definition.config)) {
                            showPluginModalError('Definition must include a "config" object.');
                            return;
                        }

                        if (!['api', 'sql', 'service'].includes(definition.config.type)) {
                            showPluginModalError('config.type must be "api", "sql", or "service" - a missing/invalid type silently breaks the Task Test screen for every task on this plugin later.');
                            return;
                        }

                        try {
                            const pluginData = {
                                name: definition.name,
                                display_name: definition.display_name,
                                description: definition.description || '',
                                enabled: definition.enabled ? 1 : 0,
                                version: definition.version || '1.0',
                                code: definition.code || '',
                                config: definition.config
                                // No username: handleAddPlugin sets created_by /
                                // updated_by from the verified authenticated user
                                // and ignores the request body.
                            };

                            const response = await addPlugin(pluginData);

                            if (response.status === 201) {
                                window.closeModal(); // explicit - see comment on onClick above
                                await loadPluginsList();
                                // Load the newly created plugin straight into the
                                // edit view - same "land on the thing you just
                                // made" spirit as docs.js's redirect to the new
                                // doc's builder page, adapted to this single-page
                                // sidebar-selection UI instead of a page navigation.
                                loadPluginDetails(pluginData.name);
                                window.showStatusBanner(`Plugin "${pluginData.name}" created successfully.`, 'success', 'pluginsStatusMessage');
                            } else {
                                const error = await response.json().catch(() => ({}));
                                showPluginModalError(error.error || `HTTP ${response.status}: import failed`);
                            }
                        } catch (error) {
                            showPluginModalError('Error importing plugin: ' + error.message);
                        }
                    })();
                    return false;
                }
            }
        ],
        width: '600px',
        height: '90vh'
    });
}

async function addPlugin(pluginPayload) {
    const response = await fetch('https://app.equinoxits.com:1139/kore/plugins/add', {
        method: 'POST',
        headers: {
            'X-Session-Token': window.sessionToken,
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
        clientBaseUrl: document.getElementById('configClientBaseUrl').value,
        clientApiPath: document.getElementById('configClientApiPath').value,
        clientId: document.getElementById('configClientId').value,
        publicKey: document.getElementById('configPublicKey').value,
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
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/reload-all`, {
            method: 'POST',
            headers: {
                'X-Session-Token': window.sessionToken,
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
        console.log('Fetching plugins list...');

        const response = await fetch('https://app.equinoxits.com:1139/kore/plugins/list', {
            method: 'GET',
            headers: {
                'X-Session-Token': window.sessionToken
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
    currentSecureConfigKeys = [];
    currentPluginCode = '';

    window.clearUnsavedChanges();
    updateSaveButtonState();
}

/**
 * "Import (Update)" for a plugin that's already selected/open in the edit
 * view. Different in kind from openImportPluginModal() above, the same
 * way doc-builder.js's openImportIntoBuilderModal() differs from docs.js's
 * list-page Import: this one populates the ALREADY-OPEN plugin's editable
 * fields from pasted JSON and nothing else - it does not call
 * addPlugin()/the /add endpoint, and it does not save anything itself.
 * The person reviews what landed in the form (Save Settings' existing
 * disabled/enabled state reflects it via the normal unsaved-changes
 * tracking) and clicks Save Settings themselves when ready. Better fit
 * for importing an update to a plugin that already exists than the
 * create-only flow above.
 *
 * Same JSON shape as Import Plugin: { name?, display_name, description?,
 * enabled?, version?, code?, config }. Deliberately does NOT touch:
 *   - name: identity of the plugin actually being edited, not something a
 *     pasted definition should silently redirect to a different plugin.
 *   - version: savePluginSettings() auto-increments this itself on Save;
 *     an imported version would just be immediately overwritten anyway.
 *   - secure_config: separate encrypted store with its own panel and its
 *     own save path - never appropriate to carry through a plaintext JSON
 *     paste in the first place.
 * matching the reasoning doc-builder.js's own version documents for why
 * it leaves id/version/folderId untouched on its own Import.
 *
 * `code`, if present, is staged into currentPluginCode rather than
 * anywhere else - savePluginSettings() reads currentPluginCode (not any
 * on-screen field) when it builds the update payload, since there's no
 * live code editor in this view. This is the same variable the "View
 * Code" button's onSave callback (openExistingPluginCodeModal()) stages
 * into - see that function and currentPluginCode's own declaration
 * comment for why it can't just write into originalPluginConfig.code
 * directly (that field is the unsaved-changes baseline; overwriting it
 * with the new value destroys the only thing it could be diffed against).
 */
function openImportPluginUpdateModal() {
    if (!currentPluginName) {
        window.showStatusBanner('Select a plugin first.', 'error', 'pluginsStatusMessage');
        return;
    }

    const modalContent = document.createElement('div');
    modalContent.style.cssText = 'display: flex; flex-direction: column; height: 100%;';
    modalContent.innerHTML = `
        <div style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
            <label style="display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-secondary); flex-shrink: 0;">Plugin Definition JSON</label>
            <textarea id="importPluginUpdateDefinitionInput" placeholder="Paste the plugin definition JSON here"
                style="width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.8rem; padding: 10px;
                       border: 1px solid var(--border-primary); border-radius: 4px; background: var(--bg-input); color: var(--text-primary); resize: vertical; flex: 1; min-height: 0;"></textarea>
            <div style="margin-top: 8px; font-size: 0.75rem; color: var(--text-muted); flex-shrink: 0;">
                Populates this plugin's fields for review - nothing is saved until you click Save Settings yourself. name, version, and secure_config are left as-is.
            </div>
        </div>
    `;

    window.showModal({
        title: 'Import (Update)',
        content: modalContent,
        resizable: true,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary' },
            {
                label: 'Import',
                type: 'success',
                onClick: () => {
                    (async () => {
                        const rawJson = modalContent.querySelector('#importPluginUpdateDefinitionInput').value.trim();
                        if (!rawJson) {
                            showPluginModalError('Paste a plugin definition JSON before importing.');
                            return;
                        }

                        let definition;
                        try {
                            definition = JSON.parse(rawJson);
                        } catch (e) {
                            showPluginModalError(`Invalid JSON: ${e.message}`);
                            return;
                        }

                        if (!definition.display_name) {
                            showPluginModalError('Definition must include "display_name".');
                            return;
                        }

                        if (definition.config && (typeof definition.config !== 'object' || Array.isArray(definition.config))) {
                            showPluginModalError('"config" must be an object.');
                            return;
                        }

                        if (definition.config && definition.config.type && !['api', 'sql', 'service'].includes(definition.config.type)) {
                            showPluginModalError('config.type must be "api", "sql", or "service".');
                            return;
                        }

                        try {
                            document.getElementById('pluginDisplayName').value = definition.display_name;
                            document.getElementById('pluginDescription').value = definition.description || '';
                            document.getElementById('pluginEnabled').checked = !!definition.enabled;

                            if (definition.config) {
                                const config = definition.config;
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

                                    // Same isClientAuth detection populatePluginForm() uses -
                                    // see that function's own comment on why presence of
                                    // clientId/publicKey (not secret presence) is the signal.
                                    const isClientAuth = config.clientId !== undefined || config.publicKey !== undefined;

                                    if (isClientAuth) {
                                        if (bearerAuthFields) bearerAuthFields.style.display = 'none';
                                        if (clientAuthFields) clientAuthFields.style.display = 'block';
                                        document.getElementById('configClientBaseUrl').value = config.baseUrl || '';
                                        document.getElementById('configClientApiPath').value = config.apiPath || '';
                                        document.getElementById('configClientId').value = config.clientId || '';
                                        document.getElementById('configPublicKey').value = config.publicKey || '';
                                    } else {
                                        if (bearerAuthFields) bearerAuthFields.style.display = 'block';
                                        if (clientAuthFields) clientAuthFields.style.display = 'none';
                                        document.getElementById('configBaseUrl').value = config.baseUrl || '';
                                        document.getElementById('configApiPath').value = config.apiPath || '';
                                    }

                                    currentEditingHeaders = JSON.parse(JSON.stringify(config.headers || []));
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
                                } else if (config.type === 'service' && currentPluginName === 'smtp') {
                                    // Reuses the existing panel-builder rather than
                                    // duplicating its rendering logic here.
                                    loadSmtpProfilesPanel(currentPluginName, config);
                                }
                            }

                            // code has no on-screen field in this view - stages
                            // into currentPluginCode instead of
                            // originalPluginConfig.code, same reasoning as
                            // openExistingPluginCodeModal() (see that function's
                            // comment): originalPluginConfig.code is the unsaved-
                            // changes baseline, and updateSaveButtonState() below
                            // needs it to stay untouched to actually detect this
                            // as a change.
                            if (definition.code) {
                                currentPluginCode = definition.code;
                            }

                            // Same dirty-check call selectPluginFromList() already uses
                            // elsewhere in this file - marks the form dirty against the
                            // baseline captured when this plugin was first loaded, so
                            // Save Settings lights up without waiting for a live
                            // oninput/onchange event that setting .value/.checked here
                            // never fires on its own. The code-specific diff happens
                            // inside updateSaveButtonState() itself.
                            window.checkUnsavedChanges(getCurrentPluginFormData());
                            updateSaveButtonState();

                            window.closeModal();
                            window.showStatusBanner('Definition imported - review the fields, then Save Settings when ready.', 'success', 'pluginsStatusMessage', 4000);
                        } catch (error) {
                            showPluginModalError('Import failed: ' + error.message);
                        }
                    })();
                    return false;
                }
            }
        ],
        width: '600px',
        height: '90vh'
    });
}


// ============================================================================
// PLUGIN DETAILS LOADING & POPULATION
// ============================================================================

async function loadPluginDetails(pluginName) {
    if (!pluginName) {
        return;
    }

    try {
        console.log('Fetching plugin details for:', pluginName);

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/details?name=${encodeURIComponent(pluginName)}`, {
            method: 'GET',
            headers: {
                'X-Session-Token': window.sessionToken
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

/**
 * Cache of {userId: displayName} built once from window.getUsers() and
 * reused for every plugin's Created By / Updated By resolution, rather than
 * re-fetching the full users list on every plugin selection.
 */
let pluginMetaUsersCache = null;

/**
 * Format a MySQL DATETIME string ("YYYY-MM-DD HH:MM:SS") as "MM/DD/YY
 * HH:MM" (24-hour, seconds dropped). Parsed via regex rather than
 * new Date(str) since that string form isn't reliably parsed the same way
 * across browsers. Falls back to the raw string for any unexpected shape.
 */
function formatPluginMetaDate(dateStr) {
    if (!dateStr) return '-';
    const match = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!match) return String(dateStr);
    const [, year, month, day, hour, minute] = match;
    return `${month}/${day}/${year.slice(-2)} ${hour}:${minute}`;
}

/**
 * Resolve a created_by/updated_by value to a display name: 'system' is
 * shown as-is, anything else is treated as a userId and looked up against
 * the users table (fullName), falling back to the raw id if not found.
 */
async function resolvePluginMetaUserName(idOrSystem) {
    if (!idOrSystem) return '-';
    if (String(idOrSystem).toLowerCase() === 'system') return idOrSystem;

    if (!pluginMetaUsersCache) {
        try {
            const users = await window.getUsers(window.sessionToken, null);
            pluginMetaUsersCache = {};
            (users || []).forEach((u) => {
                pluginMetaUsersCache[u.userId] = u.fullName || u.email || u.userId;
            });
        } catch (error) {
            console.error('[resolvePluginMetaUserName] Error fetching users:', error.message);
            pluginMetaUsersCache = {};
        }
    }

    return pluginMetaUsersCache[idOrSystem] || idOrSystem;
}

/**
 * Resolve and fill in the Created By / Updated By names asynchronously.
 * Guards against a stale response landing after the user has since
 * switched to viewing a different plugin.
 */
async function renderPluginMetaUserNames(plugin) {
    const [createdByName, updatedByName] = await Promise.all([
        resolvePluginMetaUserName(plugin.created_by),
        resolvePluginMetaUserName(plugin.updated_by)
    ]);

    if (currentPluginName !== plugin.name) return;

    const createdByEl = document.getElementById('pluginCreatedBy');
    const updatedByEl = document.getElementById('pluginUpdatedBy');
    if (createdByEl) createdByEl.textContent = createdByName;
    if (updatedByEl) updatedByEl.textContent = updatedByName;
}

function populatePluginForm(plugin) {
    currentPlugin = plugin;
    currentPluginName = plugin.name;
    currentPluginVersion = plugin.version || 0;
    originalPluginConfig = JSON.parse(JSON.stringify(plugin));
    currentPluginCode = plugin.code || '';

    document.getElementById('pluginSettingsContainer').style.display = 'flex';
    document.getElementById('pluginPlaceholder').style.display = 'none';
    
    document.getElementById('reloadPluginBtn').style.display = 'inline-block';

    document.getElementById('headerPluginName').textContent = plugin.name;
    document.getElementById('headerPluginVersion').textContent = plugin.version || '0';

    document.getElementById('pluginDisplayName').value = plugin.display_name || '';
    document.getElementById('pluginDescription').value = plugin.description || '';
    document.getElementById('pluginEnabled').checked = plugin.enabled === 1 || plugin.enabled === true;

    document.getElementById('pluginCreatedAt').textContent = formatPluginMetaDate(plugin.created_at);
    document.getElementById('pluginUpdatedAt').textContent = formatPluginMetaDate(plugin.updated_at);
    // Show the raw value immediately (userId or 'system'), then resolve
    // userId -> fullName asynchronously once the users list is available -
    // avoids blocking the rest of the form on a network round-trip.
    document.getElementById('pluginCreatedBy').textContent = plugin.created_by || '-';
    document.getElementById('pluginUpdatedBy').textContent = plugin.updated_by || '-';
    renderPluginMetaUserNames(plugin);

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

        // Detect auth type from plain-config shape, not secret presence -
        // apiKey/privateKey now live in secure_config only, so they can no
        // longer be used to tell bearer vs client auth apart. Client auth
        // always has clientId (and usually publicKey) in plain config;
        // bearer auth has neither.
        const isClientAuth = config.clientId !== undefined || config.publicKey !== undefined;

        if (isClientAuth) {
            if (bearerAuthFields) bearerAuthFields.style.display = 'none';
            if (clientAuthFields) clientAuthFields.style.display = 'block';

            document.getElementById('configClientBaseUrl').value = config.baseUrl || '';
            document.getElementById('configClientApiPath').value = config.apiPath || '';
            document.getElementById('configClientId').value = config.clientId || '';
            document.getElementById('configPublicKey').value = config.publicKey || '';
        } else {
            if (bearerAuthFields) bearerAuthFields.style.display = 'block';
            if (clientAuthFields) clientAuthFields.style.display = 'none';

            document.getElementById('configBaseUrl').value = config.baseUrl || '';
            document.getElementById('configApiPath').value = config.apiPath || '';
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

    // Secure Configuration panel - separate read/write path from the main
    // config form (masked values, its own Save button/endpoint). Not part
    // of unsaved-changes tracking below since it saves independently.
    loadSecureConfigFields(plugin.name);

    // SMTP Test panel - smtp plugin only, reads profile names straight
    // from this plugin's own loaded config.smtp_profiles (no extra fetch
    // needed, unlike Secure Configuration which needs its own endpoint).
    loadSmtpProfilesPanel(plugin.name, config);

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
        resultDiv.innerHTML = `<p style="color: #ff9800; margin: 0;">⏳ Testing connection...</p>`;
        resultDiv.style.display = 'block';

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/${encodeURIComponent(currentPluginName)}/sql/test`, {
            method: 'POST',
            headers: {
                'X-Session-Token': window.sessionToken,
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
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/load?name=${encodeURIComponent(pluginName)}`, {
            method: 'POST',
            headers: {
                'X-Session-Token': window.sessionToken,
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
            // No updated_by: handleUpdatePlugin overwrites it with the verified
            // authenticated user regardless of what the body contains
            // (plugins.js ~922). updated_at is still sent because that IS an
            // opt-in field the caller supplies.
            updated_at: new Date().toISOString().replace('T', ' ').split('.')[0],
            config: {
                type: document.getElementById('configTypeValue').textContent,
                rateLimit: parseInt(document.getElementById('configRateLimit').value, 10) || 100,
                routes: document.getElementById('configRoutes').value.split('\n').filter(r => r.trim())
            },
            originalConfig: originalPluginConfig
        };

        // Reads the staged currentPluginCode (kept in sync with any edit
        // made via "View Code" - see openExistingPluginCodeModal()) rather
        // than originalPluginConfig.code, which stays the untouched
        // baseline used for the unsaved-changes diff in
        // updateSaveButtonState(). Falls back to whatever code the plugin
        // already had if nothing was ever edited this session.
        if (currentPluginCode) {
            updates.code = currentPluginCode;
        } else if (originalPluginConfig && originalPluginConfig.code) {
            updates.code = originalPluginConfig.code;
        }

        const configType = document.getElementById('configTypeValue').textContent;

        if (configType === 'api') {
            const bearerFields = document.getElementById('bearerAuthFields');
            const clientFields = document.getElementById('clientAuthFields');

            // apiKey/privateKey are intentionally NOT assembled here - they
            // live only in secure_config now (see Secure Configuration
            // panel), and no longer have inputs on this form at all.
            if (bearerFields.style.display !== 'none') {
                updates.config.baseUrl = document.getElementById('configBaseUrl').value;
                updates.config.apiPath = document.getElementById('configApiPath').value;
            } else if (clientFields.style.display !== 'none') {
                updates.config.baseUrl = document.getElementById('configClientBaseUrl').value;
                updates.config.apiPath = document.getElementById('configClientApiPath').value;
                updates.config.clientId = document.getElementById('configClientId').value;
                updates.config.publicKey = document.getElementById('configPublicKey').value;
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
        } else if (configType === 'service' && pluginName === 'smtp') {
            // Without this branch, updates.config never included
            // smtp_profiles at all - Save Settings would silently wipe it
            // out, since updates.config only ever started from
            // {type, rateLimit, routes} for any type without its own
            // branch here.
            const currentProfile = document.getElementById('smtpProfileSelect').value;

            if (currentProfile) {
                saveSmtpProfileForm(currentProfile);
            }

            updates.config.smtp_profiles = currentSmtpProfiles;
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/update?name=${encodeURIComponent(pluginName)}`, {
            method: 'POST',
            headers: {
                'X-Session-Token': window.sessionToken,
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
                        'X-Session-Token': window.sessionToken,
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
        const response = await fetch(`https://app.equinoxits.com:1139/kore/plugins/load?name=${encodeURIComponent(pluginName)}`, {
            method: 'POST',
            headers: {
                'X-Session-Token': window.sessionToken,
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
 * Render HTML for a select field
 * @param {string} inputId - The input element ID
 * @param {object} input - The input definition
 * @param {object} pluginConfig - Plugin configuration (for resolving references)
 * @returns {string} - HTML string for the select element
 */
function renderSelectField(inputId, input, pluginConfig, taskId) {
    const options = input.options || [];
    
    let optionsHtml = options.map(opt => {
        // Handle object options (from @task references)
        if (typeof opt === 'object' && 'label' in opt) {
            return `<option value="${escapeHtml(String(opt.value))}">${escapeHtml(opt.label)}</option>`;
        }
        // Handle string options (static lists)
        return `<option value="${escapeHtml(String(opt))}">${escapeHtml(String(opt))}</option>`;
    }).join('');

    // Refresh button re-resolves this select's options against whatever is currently
    // typed into sibling fields (e.g. a tenant/company ID another select depends on).
    // Shown on every select, not just ones known to be @task.*-sourced, since the
    // client can't reliably tell dynamic from static options once they've already
    // been resolved server-side into a plain array by the time this renders.
    // taskId is embedded directly in the onclick rather than read from a page-level
    // "current task" variable -- plugins-front.js is a separate module scope from
    // whatever page imports it, so it can't see that page's own globals.
    return `<div style="display: flex; gap: 6px; align-items: center;">` +
        `<select id="${inputId}" class="form-field-input" style="flex: 1 1 auto; padding: 6px; box-sizing: border-box; font-size: 0.85rem;"><option value="">-- Select --</option>${optionsHtml}</select>` +
        `<button type="button" id="refresh_${inputId}" onclick="refreshSelectOptions('${inputId}', ${JSON.stringify(taskId)})" title="Refresh options using current field values" style="flex: 0 0 auto; padding: 6px 10px; font-size: 0.85rem; cursor: pointer; background: #f0f0f0; border: 1px solid #ccc; border-radius: 4px;">&#8635;</button>` +
        `</div>`;
}

/**
 * Re-resolve a single select input's options against this task's currently-typed
 * sibling field values (e.g. a tenant ID another select's options depend on via
 * optionTaskInputs). Only swaps out that one select's <option> list -- leaves every
 * other field on the form untouched, so nothing already filled in gets lost.
 */
async function refreshSelectOptions(inputId, taskId) {
    if (!taskId) return;

    const btn = document.getElementById(`refresh_${inputId}`);
    const select = document.getElementById(inputId);
    if (!select) return;

    const previousValue = select.value;
    if (btn) { btn.disabled = true; btn.textContent = '...'; }

    try {
        const currentValues = extractTaskInputs();
        const refreshedTask = await getTaskDetails(taskId, currentValues);

        const refreshedInput = (refreshedTask.inputs || []).find(inp => inp.name === inputId);
        if (!refreshedInput) {
            console.error(`Could not find input "${inputId}" in refreshed task details`);
            return;
        }

        const options = refreshedInput.options || [];
        const optionsHtml = options.map(opt => {
            if (typeof opt === 'object' && 'label' in opt) {
                return `<option value="${escapeHtml(String(opt.value))}">${escapeHtml(opt.label)}</option>`;
            }
            return `<option value="${escapeHtml(String(opt))}">${escapeHtml(String(opt))}</option>`;
        }).join('');

        select.innerHTML = `<option value="">-- Select --</option>${optionsHtml}`;

        // Restore the previous selection if it still exists among the refreshed options
        if (previousValue && Array.from(select.options).some(o => o.value === previousValue)) {
            select.value = previousValue;
        }
    } catch (error) {
        console.error(`Error refreshing options for ${inputId}:`, error);
        if (typeof showStatusBanner === 'function') {
            showStatusBanner(`Failed to refresh options: ${error.message}`, 'error');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#8635;'; }
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
        return '<div id="taskInputs" class="panel-level-3">No Inputs</div>';
    }
    
    let html = '<div id="taskInputs" class="panel-level-3">';
    
    inputs.forEach(input => {
        const inputId = input.name;
        
        if (input.type === 'boolean' || input.type === 'checkbox') {
            html += `<div class="form-group--inline">`;
            html += `<input type="checkbox" id="${inputId}">`;
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
                
                html += `<div style="margin-bottom: 8px;">`;
                html += `<input type="radio" id="${radioId}" name="${inputId}" value="${escapeHtml(String(optionValue))}">`;
                html += `<label for="${radioId}" style="display: inline; margin-left: 4px;">${escapeHtml(String(optionLabel))}</label>`;
                html += `</div>`;
            });
            
            html += `</fieldset>`;
        } else {
            html += `<div class="form-group">`;
            html += `<label for="${inputId}">`;
            html += `${escapeHtml(input.label || input.name)}`;
            if (input.required) {
                html += `  <span style="color: #b8242f; font-size: calc(100% - 1px);">* Required</span>`;
            }
            html += `</label>`;
            
            if (input.type === 'select') {
                html += renderSelectField(inputId, input, pluginConfig, task && task.task_id);
            } else if (input.type === 'textarea') {
                // String()-coerced defensively - a non-string default (e.g.
                // task 29's "powershell": {"default": true}, a raw boolean
                // instead of the string "true" the System Reference \u00a73.5
                // requires) would otherwise throw inside escapeHtml() the
                // instant this task's Task Test page tries to render,
                // exactly the confirmed crash that rule exists to prevent.
                html += `<textarea id="${inputId}" placeholder="${escapeHtml(String(input.default ?? ''))}"></textarea>`;
            } else if (input.type === 'number') {
                html += `<input type="number" id="${inputId}" placeholder="${escapeHtml(String(input.default ?? ''))}">`;
            } else {
                html += `<input type="text" id="${inputId}" placeholder="${escapeHtml(String(input.default ?? ''))}">`;
            }
            
            html += `</div>`;
        }
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
 * @param {object} [currentValues] - Currently-typed sibling field values on this same
 *   task's form (e.g. {customerTenantId: "..."}). Passed through as a query param so
 *   the backend can resolve any select's optionTaskInputs {fieldName} templates against
 *   them, the same way it would if these were static_params. Omit for the normal
 *   initial-load case where no sibling values exist yet.
 * @returns {Promise<object>} - Task object with resolved options
 */
async function getTaskDetails(taskId, currentValues) {
    try {
        let url = `/kore/tasks/${taskId}`;
        if (currentValues && Object.keys(currentValues).length > 0) {
            url += `?values=${encodeURIComponent(JSON.stringify(currentValues))}`;
        }

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'X-Session-Token': window.sessionToken,
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
// ============================================================================
// EXPORTS TO WINDOW
// ============================================================================
window.addDictEntry = addDictEntry;
window.addListEntry = addListEntry;
window.addNewTask = addNewTask;
window.addPlugin = addPlugin;
window.addSqlDatabase = addSqlDatabase;
window.buildTaskDetailsHtml = buildTaskDetailsHtml;
window.cancelPluginSelection = cancelPluginSelection;
window.cancelSqlDatabase = cancelSqlDatabase;
window.clearTaskUnsavedTracking = clearTaskUnsavedTracking;
window.collectPluginTaskList = collectPluginTaskList;
window.collectPluginTaskStaticParams = collectPluginTaskStaticParams;
window.deleteSqlDatabase = deleteSqlDatabase;
window.displayPlugins = displayPlugins;
window.doCancelSqlDatabase = doCancelSqlDatabase;
window.doSelectPluginFromList = doSelectPluginFromList;
window.executeTask = executeTask;
window.extractTaskInputs = extractTaskInputs;
window.fetchPluginTasks = fetchPluginTasks;
window.formatOptionsDisplay = formatOptionsDisplay;
window.getCurrentPluginFormData = getCurrentPluginFormData;
window.getPluginDetails = getPluginDetails;
window.getPluginTasks = getPluginTasks;
window.getTaskDetails = getTaskDetails;
window.refreshSelectOptions = refreshSelectOptions;
window.initializeInputDetailsToggles = initializeInputDetailsToggles;
window.updateTaskInputFieldVisibility = updateTaskInputFieldVisibility;
window.initializeTaskUnsavedTracking = initializeTaskUnsavedTracking;
window.listPlugins = listPlugins;
window.loadBlankTaskForm = loadBlankTaskForm;
window.loadPluginDetails = loadPluginDetails;
window.loadPluginsList = loadPluginsList;
window.markPluginTaskDirty = markPluginTaskDirty;
window.openImportPluginModal = openImportPluginModal;
window.openImportPluginUpdateModal = openImportPluginUpdateModal;
window.openCodeModal = openCodeModal;
window.openExistingPluginCodeModal = openExistingPluginCodeModal;
window.openEditHeadersModal = openEditHeadersModal;
window.openReloadPluginModal = openReloadPluginModal;
window.openTasksModal = openTasksModal;
window.openImportTaskModal = openImportTaskModal;
window.viewTaskJson = viewTaskJson;
window.viewPluginJson = viewPluginJson;
window.parsePluginTaskStaticParamValue = parsePluginTaskStaticParamValue;
window.populatePluginForm = populatePluginForm;
window.refreshPluginTaskSelector = refreshPluginTaskSelector;
window.reloadAllPlugins = reloadAllPlugins;
window.reloadSelectedPlugin = reloadSelectedPlugin;
window.removePluginTaskConfigRow = removePluginTaskConfigRow;
window.renderSelectField = renderSelectField;
window.renderTaskInputsHtml = renderTaskInputsHtml;
window.resetTaskConfig = resetTaskConfig;
window.resolveConfigReference = resolveConfigReference;
window.savePluginSettings = savePluginSettings;
window.getPluginSecureConfig = getPluginSecureConfig;
window.updatePluginSecureConfig = updatePluginSecureConfig;
window.loadSecureConfigFields = loadSecureConfigFields;
window.openSecureConfigEditModal = openSecureConfigEditModal;
window.openAddSecureConfigKeyModal = openAddSecureConfigKeyModal;
window.saveSqlDatabaseForm = saveSqlDatabaseForm;
window.saveTaskConfig = saveTaskConfig;
window.selectPluginFromList = selectPluginFromList;
window.selectSqlDatabase = selectSqlDatabase;
window.syncPluginTaskConfigFromDom = syncPluginTaskConfigFromDom;
window.testSmtpPluginProfile = testSmtpPluginProfile;
window.testSqlConnection = testSqlConnection;
window.addSmtpProfile = addSmtpProfile;
window.deleteSmtpProfile = deleteSmtpProfile;
window.selectSmtpProfile = selectSmtpProfile;
window.unloadSelectedPluginTask = unloadSelectedPluginTask;
window.updateSaveButtonState = updateSaveButtonState;
window.updateSqlDbTypeFields = updateSqlDbTypeFields;

// Utility Steps (merged in from wf-utilsteps.js)
window.fetchUtilSteps = fetchUtilSteps;
window.getUtilStep = getUtilStep;
window.getUtilStepsByCategory = getUtilStepsByCategory;
window.getUtilCategories = getUtilCategories;
window.clearUtilStepsCache = clearUtilStepsCache;

// Export cache for debugging
Object.defineProperty(window, 'utilStepsCache', {
    get: () => utilStepsCache,
    set: (val) => { utilStepsCache = val; }
});