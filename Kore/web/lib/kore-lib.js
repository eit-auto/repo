/**
 * KORE Library - Shared authentication and API utilities
 * Requires: RewstLib (for orgVariables.get)
 */

// ============================================================================
// KORE Header Styling
// ============================================================================
const koreHeaderStyle = document.createElement('style');
koreHeaderStyle.textContent = `
    #kore-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0;
        height: 70px;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border-primary);
        flex-shrink: 0;
    }
`;
document.head.appendChild(koreHeaderStyle);

// ============================================================================
// KORE Global Authentication - Direct API access
// ============================================================================
const API_KEY = '393d5ca334f5b1b9e7127544460def61ca6be55eab20da08f1746f11f5d0b4e9';
let sessionToken = null;

/**
 * Authenticate with Kore backend and get session token
 * @param {Function} onSuccess - Callback function to execute after successful authentication
 */
async function auth(onSuccess) {
    try {
        const user = getUser();
        // Extract domain from user email for Kore backend routing
        const domain = user.split('@')[1];
        
        const response = await fetch(`https://app.${domain}:1139/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Kore-Token': API_KEY
            },
            body: JSON.stringify({
                user: user,
                origin: 'https://localhost'
            })
        });
        const data = await response.json();
        if (data.sessionToken) {
            sessionToken = data.sessionToken;
            if (onSuccess) {
                onSuccess();
            }
        } else {
            console.error('Auth response missing sessionToken:', data);
        }
    } catch (err) {
        console.error('Auth error:', err.message);
    }
}

/**
 * Get the current session token
 */
function getSessionToken() {
    return sessionToken;
}

/**
 * Set the session token (useful for restoring from storage)
 */
function setSessionToken(token) {
    sessionToken = token;
}

/**
 * Get current user ID
 */
function getUser() {
    return 'bradf@equinoxits.com';
}

const ProxyLib = (() => {
    const PROXY_URL = 'https://app.equinoxits.com:1139';
    
    // Cache for in-flight authentication promises (user_keyName -> promise)
    const authInFlight = {};
    // Cache for completed authentication tokens (user_keyName -> token)
    const authCache = {};
    
    /**
     * Retrieve API key from org variables
     * @param {string} keyName - Org variable name (required)
     * @returns {Promise<string>} API key value
     */
    async function getApiKey(keyName) {
        try {
            if (!keyName) {
                throw new Error('keyName is required');
            }
            
            const apiKeyVar = await RewstLib.orgVariables.get(keyName);
            
            if (!apiKeyVar || !apiKeyVar.value) {
                throw new Error(`${keyName} not found in org variables`);
            }
            
            console.log('[ProxyLib] API key retrieved:', keyName);
            return apiKeyVar.value;
        } catch (error) {
            console.error('[ProxyLib] getApiKey error:', error);
            throw error;
        }
    }
    
    /**
     * Internal authenticate function (without caching)
     * @private
     */
    async function _authenticate(user, origin, options = {}) {
        try {
            if (!user) {
                throw new Error('user is required');
            }
            
            // Handle origin - if null or invalid, use parent window origin
            let authOrigin = origin;
            if (!authOrigin || authOrigin === 'null') {
                try {
                    authOrigin = window.parent.location.origin;
                    console.log('[ProxyLib] Origin was null/invalid, using parent origin:', authOrigin);
                } catch (e) {
                    console.warn('[ProxyLib] Could not access parent origin:', e.message);
                    throw new Error('origin is required and could not be auto-detected');
                }
            }
            
            let apiKey = options.apiKey;
            if (!apiKey) {
                if (!options.keyName) {
                    throw new Error('keyName is required (or provide apiKey directly)');
                }
                apiKey = await getApiKey(options.keyName);
            }
            
            console.log('[ProxyLib] Authenticating user:', user);
            
            const authPayload = {
                origin: authOrigin,
                user: user
            };
            
            console.log('[ProxyLib] Auth request payload:', authPayload);
            console.log('[ProxyLib] Auth request headers:', {
                'Content-Type': 'application/json',
                'X-Proxy-Token': apiKey ? `${apiKey.substring(0, 20)}...` : 'MISSING'
            });
            
            const response = await fetch(`${PROXY_URL}/auth`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Proxy-Token': apiKey
                },
                body: JSON.stringify(authPayload)
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            
            if (data.status !== 'Authorized') {
                throw new Error(data.error || 'Authentication failed');
            }
            
            console.log('[ProxyLib] Authentication successful for:', user);
            return data;
        } catch (error) {
            console.error('[ProxyLib] authenticate error:', error);
            throw error;
        }
    }
    
    /**
     * Authenticate with proxy to get session token
     * Handles caching and in-flight promise deduplication for concurrent auth requests
     * @param {string} user - Username (e.g., bradf@equinoxits.com)
     * @param {string} origin - Origin URL (e.g., https://equinoxits-tools.rew.st)
     * @param {object} options - Required: keyName OR apiKey (apiKey takes precedence)
     * @returns {Promise<{status, sessionToken, credentialName, expiresIn}>}
     */
    async function authenticate(user, origin, options = {}) {
        try {
            // Create cache key based on user and keyName
            const keyName = options.keyName || 'default';
            const cacheKey = `${user}_${keyName}`;
            
            // Check if token is already cached
            if (authCache[cacheKey]) {
                console.log('[ProxyLib] Using cached session token for:', user, 'with key:', keyName);
                return authCache[cacheKey];
            }
            
            // Check if authentication is already in-flight
            if (authInFlight[cacheKey]) {
                console.log('[ProxyLib] Waiting for in-flight authentication for:', user, 'with key:', keyName);
                return authInFlight[cacheKey];
            }
            
            // Create the authentication promise
            const authPromise = _authenticate(user, origin, options);
            
            // Store the in-flight promise
            authInFlight[cacheKey] = authPromise;
            
            try {
                const result = await authPromise;
                // Cache the result
                authCache[cacheKey] = result;
                return result;
            } finally {
                // Remove from in-flight after completion
                delete authInFlight[cacheKey];
            }
        } catch (error) {
            console.error('[ProxyLib] authenticate error:', error);
            throw error;
        }
    }
    
    /**
     * Validate existing session token
     * @param {string} sessionToken - Session token to validate
     * @param {string} user - Username
     * @param {object} options - Optional config
     * @returns {Promise<{status, credentialName, user, expiresIn}>}
     */
    async function validateSession(sessionToken, user, options = {}) {
        try {
            if (!sessionToken || !user) {
                throw new Error('sessionToken and user are required');
            }
            
            console.log('[ProxyLib] Validating session for user:', user);
            
            const response = await fetch(`${PROXY_URL}/validate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Token': sessionToken
                },
                body: JSON.stringify({
                    user: user
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            
            if (data.status !== 'Valid') {
                throw new Error(data.error || 'Session validation failed');
            }
            
            console.log('[ProxyLib] Session validation successful');
            return data;
        } catch (error) {
            console.error('[ProxyLib] validateSession error:', error);
            throw error;
        }
    }
    
    /**
     * Execute command on MeshCentral agent
     * @param {string} sessionToken - Session token (from authenticate)
     * @param {string} user - Username
     * @param {string} nodeId - MeshCentral node ID
     * @param {string} command - Command to execute
     * @param {number} commandType - 1=cmd, 2=powershell (default: 1)
     * @param {object} options - Optional config
     * @returns {Promise<{success, result}>}
     */
    async function executeCommand(sessionToken, user, nodeId, command, commandType = 1, options = {}) {
        try {
            if (!sessionToken || !user || !nodeId || !command) {
                throw new Error('sessionToken, user, nodeId, and command are required');
            }
            
            console.log('[ProxyLib] Executing command on node:', nodeId);
            
            const response = await fetch(`${PROXY_URL}/mesh/command`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Token': sessionToken
                },
                body: JSON.stringify({
                    nodeId: nodeId,
                    command: command,
                    commandType: commandType,
                    user: user,
                    reply: options.reply || true
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            
            if (!data.success) {
                throw new Error(data.error || 'Command execution failed');
            }
            
            console.log('[ProxyLib] Command executed successfully');
            return data;
        } catch (error) {
            console.error('[ProxyLib] executeCommand error:', error);
            // Check if this is a transient error worth retrying
            const isRetryable = error.message.includes('WebSocket') || error.message.includes('500');
            if (isRetryable && !options._retried) {
                console.warn('[ProxyLib] Retrying command execution...');
                options._retried = true;
                return executeCommand(sessionToken, user, nodeId, command, commandType, options);
            }
            throw error;
        }
    }
    
    /**
     * Get nodes from MeshCentral organized by mesh group, with optional filtering
     * @param {string} sessionToken - Session token (from authenticate)
     * @param {string} user - Username
     * @param {object} options - Optional config {query, ...}
     * 
     * Query syntax: Use node.* and mesh.* prefixes to query specific properties
     *   Operators: CONTAINS, NOT_CONTAINS, EQUALS, STARTS_WITH, ENDS_WITH
     *   Logic: AND, OR with parentheses for grouping
     *   Example: node.tags CONTAINS "primary_dc" AND mesh.desc CONTAINS "org-uuid"
     * 
     * NODE FIELDS (accessible via node.fieldname):
     *   - type, mtype, _id, icon, name, rname
     *   - domain, agent (object with ver, id, caps, core, root)
     *   - host, ip, firstconnect, lastbootuptime (timestamps in ms)
     *   - osdesc (OS description), av (antivirus array), defender (object)
     *   - idletime, users, lusers, upnusers (counts)
     *   - tags (array of strings), conn, pwr, agct
     *   - mesh (object - see MESH FIELDS below)
     * 
     * MESH FIELDS (accessible via mesh.fieldname):
     *   - type, _id, name, mtype
     *   - desc (description), domain
     *   - links (permissions object)
     *   - creation (timestamp in ms), creatorid, creatorname
     * 
     * @returns {Promise<{success, result}>} result is object with mesh groups as keys, each containing array of nodes
     */
    async function getNodes(sessionToken, user, options = {}) {
        try {
            if (!sessionToken || !user) {
                throw new Error('sessionToken and user are required');
            }
            
            console.log('[ProxyLib] Retrieving nodes for user:', user);
            
            const body = {
                user: user
            };
            
            // Add query if provided
            if (options.query) {
                body.query = options.query;
                console.log('[ProxyLib] Query filter:', options.query.substring(0, 100) + '...');
            }
            
            const response = await fetch(`${PROXY_URL}/mesh/nodes`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Token': sessionToken
                },
                body: JSON.stringify(body)
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            
            if (!data.success) {
                throw new Error(data.error || 'Failed to retrieve nodes');
            }
            
            // Process nodes to strip "node//" prefix from _id fields
            if (data.result && typeof data.result === 'object') {
                Object.values(data.result).forEach(meshGroup => {
                    if (Array.isArray(meshGroup)) {
                        meshGroup.forEach(node => {
                            if (node && node._id && typeof node._id === 'string') {
                                // Strip "node//" prefix if present (6 characters: n-o-d-e-/-/)
                                if (node._id.startsWith('node//')) {
                                    node._id = node._id.substring(6); // Remove "node//"
                                }
                            }
                        });
                    }
                });
            }
            
            const meshGroupCount = Object.keys(data.result || {}).length;
            console.log('[ProxyLib] Retrieved nodes:', meshGroupCount, 'mesh groups');
            return data;
        } catch (error) {
            console.error('[ProxyLib] getNodes error:', error);
            throw error;
        }
    }
    
    /**
     * Get proxy status (health check)
     * @returns {Promise<object>} Proxy status
     */
    async function getStatus(options = {}) {
        try {
            console.log('[ProxyLib] Checking proxy status');
            
            const response = await fetch(`${PROXY_URL}/status`, {
                method: 'GET'
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            console.log('[ProxyLib] Proxy status OK');
            return data;
        } catch (error) {
            console.error('[ProxyLib] getStatus error:', error);
            throw error;
        }
    }
    
    /**
     * Execute MySQL query
     * @param {string} sessionToken - Session token (from authenticate)
     * @param {string} user - Username
     * @param {string} query - SQL query to execute
     * @param {object} options - Optional config
     * @returns {Promise<{success, result, rowCount}>}
     */
    /**
     * Execute SQL query against any configured database
     * @param {string} sessionToken - Session token (from authenticate)
     * @param {string} user - Username
     * @param {string} database - Database alias (rewst, kore, cwa, etc)
     * @param {string} query - SQL query to execute
     * @param {object} options - Optional config
     * @returns {Promise<{success, result, rowCount}>}
     */
    async function executeSqlQuery(sessionToken, user, database, query, options = {}) {
        try {
            if (!sessionToken || !user || !database || !query) {
                throw new Error('sessionToken, user, database, and query are required');
            }
            
            console.log(`[ProxyLib] Executing query on database: ${database}`);
            
            const response = await fetch(`${PROXY_URL}/sqlquery`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Token': sessionToken
                },
                body: JSON.stringify({
                    database: database,
                    query: query
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            
            if (!data.success) {
                throw new Error(data.error || 'Query execution failed');
            }
            
            console.log(`[ProxyLib] Query executed successfully on ${database}, returned ${data.rowCount} rows`);
            return data;
        } catch (error) {
            console.error('[ProxyLib] executeSqlQuery error:', error);
            throw error;
        }
    }
    
    /**
     * Execute MySQL query (routes to rewst database)
     */
    async function executeQuery(sessionToken, user, query, options = {}) {
        return executeSqlQuery(sessionToken, user, 'rewst', query, options);
    }
    
    /**
     * DEPRECATED: Use executeSqlQuery instead
     * Execute CWA/LabTech MySQL query (legacy, routes to cwa database)
     */
    async function executeCwaQuery(sessionToken, user, query, options = {}) {
        return executeSqlQuery(sessionToken, user, 'cwa', query, options);
    }
    
    /**
     * Execute ConnectWise Manage API request
     * @param {string} sessionToken - Session token (from authenticate)
     * @param {string} user - Username
     * @param {string} endpoint - CWM API endpoint (e.g., "/company/companies")
     * @param {object} queryParams - Query parameters {fields, conditions, pageAll, pageSize, ...}
     * @param {string} method - HTTP method (GET, POST, PUT, DELETE - default: GET)
     * @param {object} body - Optional request body for POST/PUT operations
     * @param {object} options - Optional config
     * @returns {Promise<{success, result, totalRecords, pagesFetched, statusCode}>}
     */
    async function executeCwmApi(sessionToken, user, endpoint, queryParams = {}, method = 'GET', body = {}, options = {}) {
        try {
            if (!sessionToken || !user || !endpoint) {
                throw new Error('sessionToken, user, and endpoint are required');
            }
            
            console.log('[ProxyLib] Executing CWM API request:', method, endpoint);
            
            const response = await fetch(`${PROXY_URL}/psa-cwm`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Token': sessionToken
                },
                body: JSON.stringify({
                    user: user,
                    endpoint: endpoint,
                    method: method,
                    query: queryParams,
                    body: body,
                    timeout: options.timeout || 30000,
                    flatten: options.flatten !== undefined ? options.flatten : false
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            
            if (!data.success) {
                throw new Error(data.error || 'CWM API request failed');
            }
            
            console.log('[ProxyLib] CWM API request successful, returned', data.result ? (Array.isArray(data.result) ? data.result.length : 1) : 0, 'records');
            return data;
        } catch (error) {
            console.error('[ProxyLib] executeCwmApi error:', error);
            throw error;
        }
    }
    
    /**
     * Authenticate with UI handling
     * Convenience wrapper that handles authentication and updates UI elements
     * @param {string} user - Username
     * @param {string} origin - Origin URL
     * @param {string} keyName - Org variable name for API key
     * @param {object} uiElements - UI elements {authStatusBox, inputElement, buttonElement}
     * @returns {Promise<string>} Session token on success
     * @throws {Error} On authentication failure
     */
    async function authenticateWithKeyName(user, origin, keyName, uiElements = {}) {
        const authBox = uiElements.authStatusBox;
        const inputElement = uiElements.inputElement;
        const buttonElement = uiElements.buttonElement;
        
        try {
            console.log('[ProxyLib] Authenticating with keyName:', keyName);
            
            // Use main authenticate function
            const authResult = await authenticate(user, origin, { keyName });
            const sessionToken = authResult.sessionToken;
            
            // Update UI if provided
            if (authBox) {
                authBox.className = 'status-box success';
                authBox.textContent = `? Authenticated (${authResult.credentialName}) - Ready to execute`;
                authBox.style.display = 'block';
            }
            
            // Enable inputs if provided
            if (inputElement) inputElement.disabled = false;
            if (buttonElement) buttonElement.disabled = false;
            
            console.log('[ProxyLib] Authentication with UI handling successful');
            return sessionToken;
            
        } catch (error) {
            console.error('[ProxyLib] Authentication error:', error);
            
            // Update UI on error
            if (authBox) {
                authBox.className = 'status-box error';
                authBox.textContent = `? Auth Error: ${error.message}`;
                authBox.style.display = 'block';
            }
            
            // Disable inputs on error
            if (inputElement) inputElement.disabled = true;
            if (buttonElement) buttonElement.disabled = true;
            
            throw error;
        }
    }
    
    /**
     * Escape HTML special characters to prevent XSS
     * @param {string} text - Text to escape
     * @returns {string} Escaped text safe for innerHTML
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    /**
     * Build HTML table from array of objects
     * @param {array} rows - Array of objects (each object is a row)
     * @param {array} columns - Optional: array of column names
     * @returns {string} HTML table string
     */
    function buildTable(rows, columns = null) {
        if (!rows || rows.length === 0) {
            return '';
        }
        
        // Get columns from first row if not provided
        const cols = columns || Object.keys(rows[0]);
        
        // Build table
        let html = '<div class="table-wrapper"><table><thead><tr>';
        cols.forEach(col => {
            html += `<th>${escapeHtml(col)}</th>`;
        });
        html += '</tr></thead><tbody>';
        
        rows.forEach(row => {
            html += '<tr>';
            cols.forEach(col => {
                const value = row[col];
                const displayValue = value === null ? '(null)' : escapeHtml(String(value));
                html += `<td>${displayValue}</td>`;
            });
            html += '</tr>';
        });
        
        html += '</tbody></table></div>';
        return html;
    }
    
    // Public API
    return {
        getApiKey,
        authenticate,
        authenticateWithKeyName,
        validateSession,
        executeCommand,
        executeSqlQuery,
        executeQuery,
        executeCwaQuery,
        executeCwmApi,
        getNodes,
        getStatus,
        escapeHtml,
        buildTable
    };
})();

// Make ProxyLib available globally
if (typeof window !== 'undefined') {
    window.ProxyLib = ProxyLib;
}

// ============================================================================
// UI Utilities - Modal Messages and State Management
// ============================================================================

/**
 * Show a modal message (success, error, warning, info)
 * @param {string} type - 'success', 'error', 'warning', 'info'
 * @param {string} title - Modal title
 * @param {string} message - Modal message content
 * @param {Function} onClose - Optional callback when modal closes
 */
function showMessage(type, title, message, onClose = null) {
    const modalId = type + 'Modal'; // e.g., 'successModal', 'errorModal'
    const modal = document.getElementById(modalId);
    
    if (!modal) {
        console.warn(`Modal with id "${modalId}" not found`);
        return;
    }
    
    // Update title and message
    const titleElement = modal.querySelector('.modal-title');
    const messageElement = modal.querySelector('p[id$="Message"]') || modal.querySelector('p:not(.modal-buttons *)');
    
    if (titleElement) {
        titleElement.textContent = title;
    }
    if (messageElement) {
        messageElement.innerHTML = message;
    }
    
    // Store callback and show modal
    modal.onCloseCallback = onClose;
    modal.classList.add('show');
}

/**
 * Close a message modal
 * @param {string} type - 'success', 'error', 'warning', 'info'
 */
function closeMessage(type) {
    const modalId = type + 'Modal';
    const modal = document.getElementById(modalId);
    
    if (!modal) return;
    
    // Execute callback if present
    if (modal.onCloseCallback) {
        modal.onCloseCallback();
        modal.onCloseCallback = null;
    }
    
    modal.classList.remove('show');
}

/**
 * Update save button state based on unsaved changes
 * @param {boolean} hasUnsavedChanges - Whether there are unsaved changes
 */
function updateSaveButtonState(hasUnsavedChanges = false) {
    const saveButton = document.querySelector('[onclick="saveWorkflow()"]') || 
                      document.querySelector('button[title="Save Workflow"]');
    
    if (!saveButton) return;
    
    if (hasUnsavedChanges) {
        saveButton.classList.add('has-unsaved');
        saveButton.style.opacity = '1';
    } else {
        saveButton.classList.remove('has-unsaved');
        saveButton.style.opacity = '0.6';
    }
}

/**
 * Create and show a modal dialog with consistent styling
 * @param {Object} options - Modal configuration
 * @param {string} options.title - Modal title
 * @param {string} options.content - Modal content (can be HTML)
 * @param {Array} options.buttons - Array of button objects {label, className, callback}
 * @param {string} options.type - Modal type: 'default', 'confirm', 'input', 'success', 'error'
 * @param {Object} options.input - For 'input' type: {placeholder, value, validate}
 * @param {number} options.autoClose - Auto-close modal after N milliseconds (for success modals)
 * @param {Function} options.onClose - Callback when modal closes
 * @returns {Object} Modal control object with close() method
 */
function showModal(options) {
    const {
        title = 'Modal',
        content = '',
        buttons = [],
        type = 'default',
        input = {},
        autoClose = null,
        onClose = null,
        customWidth = null,
        customMinWidth = null
    } = options;

    // Create modal container
    const modalId = 'modal-' + Math.random().toString(36).substr(2, 9);
    const modalOverlay = document.createElement('div');
    modalOverlay.id = modalId;
    modalOverlay.style.cssText = `
        display: flex;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        z-index: 2000;
        align-items: center;
        justify-content: center;
    `;

    // Create modal box
    const modalBox = document.createElement('div');
    modalBox.style.cssText = `
        background: var(--bg-secondary);
        border-radius: 8px;
        padding: 15px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        min-width: ${customMinWidth || '400px'};
        max-width: ${customWidth || '600px'};
        max-height: 80vh;
        overflow-y: auto;
    `;

    // Title
    const titleEl = document.createElement('h2');
    titleEl.style.cssText = 'margin: 0 0 20px 0; color: var(--text-primary); font-size: 1.3rem;';
    titleEl.textContent = title;
    modalBox.appendChild(titleEl);

    // Content
    const contentEl = document.createElement('div');
    const marginBottom = options.showButtons === false ? '0' : '20px';
    contentEl.style.cssText = `color: var(--text-secondary); margin-bottom: ${marginBottom}; line-height: 1.5;`;
    if (typeof content === 'string') {
        contentEl.innerHTML = content;
    } else {
        contentEl.appendChild(content);
    }
    modalBox.appendChild(contentEl);

    // Input field (for 'input' type)
    let inputElement = null;
    let errorElement = null;
    if (type === 'input') {
        // Add label if provided
        if (input.label) {
            const labelEl = document.createElement('label');
            labelEl.style.cssText = 'display: block; color: var(--text-primary); font-size: 13px; margin-bottom: 3px; font-weight: 600;';
            labelEl.textContent = input.label;
            modalBox.appendChild(labelEl);
        }

        inputElement = document.createElement('input');
        inputElement.type = 'text';
        inputElement.placeholder = input.placeholder || '';
        inputElement.value = input.value || '';
        inputElement.style.cssText = `
            width: 100%;
            padding: 12px;
            box-sizing: border-box;
            border: 1px solid var(--table-border);
            border-radius: 6px;
            background: var(--bg-tertiary);
            color: var(--text-primary);
            font-size: 14px;
            margin-bottom: 15px;
        `;
        inputElement.onkeypress = (e) => {
            if (e.key === 'Enter' && buttons.length > 0) {
                buttons[0].callback?.();
            }
        };
        modalBox.appendChild(inputElement);

        errorElement = document.createElement('div');
        errorElement.style.cssText = `
            color: var(--color-red-input);
            font-size: 12px;
            margin-bottom: 15px;
            min-height: 0;
            display: none;
        `;
        // Show the error div when setError is called
        errorElement._setError = (msg) => {
            if (msg) {
                errorElement.textContent = msg;
                errorElement.style.display = 'block';
            } else {
                errorElement.style.display = 'none';
            }
        };
        modalBox.appendChild(errorElement);
    }

    // Buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px;';
    
    buttons.forEach(btn => {
        const button = document.createElement('button');
        button.textContent = btn.label;
        button.className = `btn ${btn.className || 'btn-blue'} btn-small`;
        button.onclick = () => {
            if (btn.callback) {
                const result = btn.callback({
                    close: closeModal,
                    inputValue: inputElement?.value,
                    setError: (msg) => { if (errorElement) errorElement._setError(msg); }
                });
            }
        };
        buttonContainer.appendChild(button);
    });
    
    // Only append button container if showButtons is true
    if (options.showButtons !== false) {
        modalBox.appendChild(buttonContainer);
    }

    // Append to body
    modalOverlay.appendChild(modalBox);
    document.body.appendChild(modalOverlay);

    // Close function
    function closeModal() {
        if (autoCloseTimeout) clearTimeout(autoCloseTimeout);
        modalOverlay.remove();
        if (onClose) onClose();
    }

    // Auto-close for success modals
    let autoCloseTimeout = null;
    if (autoClose) {
        autoCloseTimeout = setTimeout(closeModal, autoClose);
    }

    // Click outside to close (optional)
    modalOverlay.onclick = (e) => {
        if (e.target === modalOverlay) {
            closeModal();
        }
    };

    // Focus input if present
    if (inputElement) {
        inputElement.focus();
    }

    return { close: closeModal, getInputValue: () => inputElement?.value };
}

/**
 * Render a hierarchical tree structure
 * @param {Array} items - Array of items with id, name, parent_id
 * @param {HTMLElement} container - Container to render tree into
 * @param {Object} options - Configuration options
 * @param {Function} options.onItemClick - Callback when item is clicked
 * @param {Object} options.styles - Custom styles for tree elements
 */
function renderTree(items, container, options = {}) {
    if (!items || items.length === 0) {
        container.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.9rem; margin: 0;">No items</p>';
        return;
    }

    // Build a map of item ID to item object
    const itemMap = {};
    items.forEach(item => {
        itemMap[item.id] = { ...item, children: [] };
    });

    // Build parent-child relationships
    const rootItems = [];
    items.forEach(item => {
        if (item.parent_id && itemMap[item.parent_id]) {
            itemMap[item.parent_id].children.push(itemMap[item.id]);
        } else {
            rootItems.push(itemMap[item.id]);
        }
    });

    // Sort by name
    const sortItems = (arr) => arr.sort((a, b) => a.name.localeCompare(b.name));
    sortItems(rootItems);
    items.forEach(item => {
        if (itemMap[item.id].children) {
            sortItems(itemMap[item.id].children);
        }
    });

    // Render tree
    container.innerHTML = '';
    const treeContainer = document.createElement('div');
    
    rootItems.forEach((item, index) => {
        const isLast = index === rootItems.length - 1;
        treeContainer.appendChild(createTreeNode(item, 0, isLast, [], options));
    });

    container.appendChild(treeContainer);
}

/**
 * Create a single tree node with expand/collapse capability
 * @param {Object} item - Item to render (must have id, name, children)
 * @param {Number} level - Current depth level
 * @param {Boolean} isLastChild - Whether this item is the last child of its parent
 * @param {Array} ancestorSiblingInfo - Array tracking sibling status of ancestors
 * @param {Object} options - Options for rendering
 */
function createTreeNode(item, level = 0, isLastChild = true, ancestorSiblingInfo = [], options = {}) {
    const nodeContainer = document.createElement('div');
    nodeContainer.style.cssText = 'margin-bottom: 0px;';

    const folderRow = document.createElement('div');
    folderRow.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0;
        color: var(--text-dim);
        font-size: 0.9rem;
        user-select: none;
        box-sizing: border-box;
        height: 20px;
    `;

    // Expand/collapse toggle - always on far left
    const hasChildren = item.children && item.children.length > 0;
    const toggleBtn = document.createElement('span');
    toggleBtn.style.cssText = `
        display: inline-flex;
        align-items: flex-start;
        justify-content: center;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        font-size: 1.6rem;
        color: var(--text-dim);
        line-height: 1;
        align-self: flex-start;
        margin-top: -2px;
        cursor: ${hasChildren ? 'pointer' : 'default'};
    `;
    toggleBtn.innerHTML = hasChildren ? '&#43;' : '';
    // Shift + symbol up by 2px (apply additional negative margin)
    if (hasChildren) {
        toggleBtn.style.marginTop = '-5px';
    }
    folderRow.appendChild(toggleBtn);

    // Item children container
    const childrenContainer = document.createElement('div');
    childrenContainer.style.cssText = 'display: none;';
    const isExpanded = { state: false };

    // Toggle function
    const toggleChildren = () => {
        isExpanded.state = !isExpanded.state;
        if (isExpanded.state) {
            childrenContainer.style.display = 'block';
            toggleBtn.innerHTML = '&#45;';
        } else {
            childrenContainer.style.display = 'none';
            toggleBtn.innerHTML = '&#43;';
        }
    };

    // Item name with tree structure
    const itemName = document.createElement('span');
    itemName.style.cssText = `flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1rem; margin: 0; display: flex; align-items: center; color: var(--text-primary); cursor: pointer;`;
    
    // Build ancestor boxes for levels > 1
    if (level > 1) {
        for (let i = 1; i < level; i++) {
            const ancestorBox = document.createElement('span');
            ancestorBox.style.cssText = `width: 16px; display: inline-flex; align-items: flex-start; justify-content: center; flex-shrink: 0; font-size: 1rem; line-height: 1.2; margin: 0; padding: 0 0 0 1px; border: 0; color: var(--text-dim); pointer-events: none;`;
            
            // Check if ancestor at level i has siblings below
            const ancestorHasSiblings = ancestorSiblingInfo[i - 1] || false;
            
            const char = ancestorHasSiblings ? String.fromCharCode(9474) : ' '; // ? or space
            ancestorBox.appendChild(document.createTextNode(char));
            itemName.appendChild(ancestorBox);
        }
    }
    
    // Final connector box (+ or +)
    if (level > 0) {
        const connectorBox = document.createElement('span');
        connectorBox.style.cssText = `width: 16px; display: inline-flex; align-items: flex-start; justify-content: center; flex-shrink: 0; font-size: 1rem; line-height: 1.2; margin: 0; padding: 0; border: 0; color: var(--text-dim); pointer-events: none;`;
        
        const treeChar = isLastChild ? String.fromCharCode(9492) : String.fromCharCode(9500); // + or +
        connectorBox.appendChild(document.createTextNode(treeChar));
        itemName.appendChild(connectorBox);
    }
    
    // Item name text
    const nameText = document.createElement('span');
    nameText.textContent = item.name;
    // Make "None" item italic
    if (item.id === 'none') {
        nameText.style.fontStyle = 'italic';
    }
    itemName.appendChild(nameText);
    
    folderRow.appendChild(itemName);

    // Add data attribute for selection tracking and styling on click
    folderRow.setAttribute('data-item-id', item.id);
    folderRow.style.cssText += '; border-radius: 4px; transition: background-color 0.2s;';
    folderRow.onmouseenter = () => {
        if (!folderRow.classList.contains('selected')) {
            folderRow.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
        }
    };
    folderRow.onmouseleave = () => {
        if (!folderRow.classList.contains('selected')) {
            folderRow.style.backgroundColor = '';
        }
    };

    // Click toggle button to expand/collapse
    if (hasChildren) {
        toggleBtn.style.cursor = 'pointer';
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            toggleChildren();
        };
    }

    // Click item name to select it (fires callback)
    itemName.onclick = (e) => {
        e.stopPropagation();
        
        if (options.onItemClick) {
            options.onItemClick(item);
        }
        
        // Highlight this row after callback
        const listContainer = folderRow.closest('.content-panel');
        if (listContainer) {
            listContainer.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
            });
        }
        
        // Add selected class to this row
        folderRow.classList.add('selected');
        folderRow.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
    };

    nodeContainer.appendChild(folderRow);

    // Render children
    if (hasChildren) {
        item.children.forEach((child, index) => {
            const childIsLast = index === item.children.length - 1;
            // Build new ancestor info array for children
            const newAncestorInfo = [...ancestorSiblingInfo];
            newAncestorInfo[level - 1] = !isLastChild; // Current level has siblings if not last
            childrenContainer.appendChild(createTreeNode(child, level + 1, childIsLast, newAncestorInfo, options));
        });
        nodeContainer.appendChild(childrenContainer);
    }

    return nodeContainer;
}

/**
 * Generic move modal for any item type
 * @param {Object} options - Configuration object
 * @param {String} options.itemId - ID of the item being moved
 * @param {String} options.itemName - Display name of the item being moved
 * @param {String} options.headerText - Modal header (e.g., "Move Workflow", "Move Folder")
 * @param {Array} options.folders - Folder tree array
 * @param {Function} options.onConfirm - Callback when move is confirmed, receives (itemId, selectedParentId)
 * @param {String} options.currentParentId - Current parent ID to pre-select (optional)
 * @param {Boolean} options.showNoParent - Whether to show "No Parent" option (default: true)
 * @param {String} options.noParentLabel - Label for no parent option (default: "No Parent (Root Level)")
 * @param {Number} options.customWidth - Modal width (default: 500px)
 */
function showMoveModal(options) {
    const {
        itemId,
        itemName,
        headerText,
        folders,
        onConfirm,
        currentParentId,
        showNoParent = true,
        noParentLabel = 'No Parent (Root Level)',
        customWidth = '500px'
    } = options;

    if (!itemId || !itemName || !headerText || !folders || !onConfirm) {
        console.error('showMoveModal: Missing required options');
        return;
    }

    showModal({
        type: 'custom',
        title: headerText,
        content: `
            <div>
                <p style="margin: 0 0 10px 0; color: var(--text-muted); font-size: 0.9rem;">Select a parent folder for: <strong>${itemName}</strong></p>
                <div id="moveItemTree" style="background: var(--bg-tertiary); border: 1px solid var(--table-border); border-radius: 4px; padding: 8px 8px 13px 8px; height: auto; overflow: visible; margin-bottom: 15px;"></div>
            </div>
        `,
        buttons: [
            {
                label: 'Cancel',
                className: 'btn-small',
                callback: ({ close }) => close()
            },
            {
                label: 'Move',
                className: 'btn-blue btn-small',
                callback: ({ close }) => {
                    const selectedParentId = window.selectedMoveModalParent;
                    if (selectedParentId !== undefined) {
                        onConfirm(itemId, selectedParentId === 'no_parent' ? null : selectedParentId);
                    }
                    close();
                }
            }
        ],
        customWidth: customWidth,
        customMinWidth: '300px'
    });

    // Render the tree in the modal
    const treeContainer = document.getElementById('moveItemTree');
    if (treeContainer) {
        treeContainer.innerHTML = '';
        
        // Create "No Parent" option if enabled
        let noParentItem = null;
        if (showNoParent) {
            noParentItem = document.createElement('div');
            noParentItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px; height: 20px;';
            noParentItem.setAttribute('data-folder-id', 'no_parent');
            const noParentText = document.createElement('span');
            noParentText.textContent = noParentLabel;
            noParentText.style.fontStyle = 'italic';
            noParentText.style.color = 'var(--text-primary)';
            noParentItem.appendChild(noParentText);
            noParentItem.onmouseenter = () => {
                if (!noParentItem.classList.contains('selected')) {
                    noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
                }
            };
            noParentItem.onmouseleave = () => {
                if (!noParentItem.classList.contains('selected')) {
                    noParentItem.style.backgroundColor = '';
                }
            };
            noParentItem.onclick = () => {
                // Clear tree selections
                treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                    el.classList.remove('selected');
                    el.style.backgroundColor = '';
                });
                // Select No Parent
                noParentItem.classList.add('selected');
                noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                window.selectedMoveModalParent = 'no_parent';
            };
            treeContainer.appendChild(noParentItem);
        }

        // Render the actual folder tree, excluding the item being moved
        const treeDiv = document.createElement('div');
        treeDiv.id = 'moveModalTreeContent';
        const filterableFolders = (folders || []).filter(f => f.id !== itemId);
        renderTree(filterableFolders, treeDiv, {
            onItemClick: (folder) => {
                if (folder.id === itemId) {
                    return;
                }
                window.selectedMoveModalParent = folder.id;
                // Clear No Parent selection if it exists
                if (noParentItem) {
                    noParentItem.classList.remove('selected');
                    noParentItem.style.backgroundColor = '';
                }
                // Clear other tree items - only in this modal tree
                treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                    el.classList.remove('selected');
                    el.style.backgroundColor = '';
                });
                // Find and highlight the selected item
                const selectedEl = treeDiv.querySelector(`[data-item-id="${folder.id}"]`);
                if (selectedEl) {
                    selectedEl.classList.add('selected');
                    selectedEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                }
            }
        });
        treeContainer.appendChild(treeDiv);

        // Pre-select current parent if provided
        if (currentParentId) {
            setTimeout(() => {
                let currentParentEl = treeDiv.querySelector(`[data-item-id="${currentParentId}"]`);
                
                if (currentParentEl) {
                    // If parent is not visible, expand ancestors
                    if (!currentParentEl.offsetParent) {
                        let node = currentParentEl.parentElement;
                        
                        while (node && node !== treeDiv) {
                            if (node.style.display === 'none') {
                                const prevSibling = node.previousElementSibling;
                                if (prevSibling) {
                                    const toggleBtn = prevSibling.querySelector('span');
                                    if (toggleBtn && toggleBtn.textContent === '+') {
                                        toggleBtn.click();
                                    }
                                }
                            }
                            node = node.parentElement;
                        }
                        
                        // Wait for expansions to complete
                        setTimeout(() => {
                            currentParentEl.classList.add('selected');
                            currentParentEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                            window.selectedMoveModalParent = currentParentId;
                            currentParentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            // Clear No Parent selection
                            if (noParentItem) {
                                noParentItem.classList.remove('selected');
                                noParentItem.style.backgroundColor = '';
                            }
                        }, 150);
                    } else {
                        // Parent is already visible
                        currentParentEl.classList.add('selected');
                        currentParentEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                        window.selectedMoveModalParent = currentParentId;
                        currentParentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        // Clear No Parent selection
                        if (noParentItem) {
                            noParentItem.classList.remove('selected');
                            noParentItem.style.backgroundColor = '';
                        }
                    }
                } else if (currentParentId === null && noParentItem) {
                    // Current parent is null, select No Parent
                    noParentItem.classList.add('selected');
                    noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                    window.selectedMoveModalParent = 'no_parent';
                }
            }, 150);
        } else if (noParentItem) {
            // No current parent provided, pre-select No Parent by default
            noParentItem.classList.add('selected');
            noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.selectedMoveModalParent = 'no_parent';
        }
    }
}


/**
 * Show move modal for items (workflows, tasks, etc.)
 * Simplified wrapper around showMoveModal that doesn't need pre-selection of current parent
 * @param {Object} options - Configuration object
 * @param {String} options.itemId - ID of the item being moved
 * @param {String} options.itemName - Display name of the item
 * @param {String} options.headerText - Modal header (e.g., "Move Workflow")
 * @param {Array} options.folders - Folder tree array
 * @param {Function} options.onConfirm - Callback when move confirmed, receives (itemId, selectedParentId)
 * @param {String} options.noParentLabel - Label for no parent (default: "No Folder")
 * @param {Number} options.customWidth - Modal width (default: 500px)
 */
function showItemMoveModal(options) {
    const {
        itemId,
        itemName,
        headerText,
        folders,
        onConfirm,
        currentFolderId,
        noParentLabel = 'No Folder',
        customWidth = '500px'
    } = options;

    if (!itemId || !itemName || !headerText || !folders || !onConfirm) {
        console.error('showItemMoveModal: Missing required options');
        return;
    }

    showMoveModal({
        itemId,
        itemName,
        headerText,
        folders,
        onConfirm,
        showNoParent: true,
        noParentLabel,
        customWidth,
        currentParentId: currentFolderId || null
    });
}

/**
 * Helper to get currently selected folder from the panel
 */

/**
 * Build complete folders panel with tree, buttons, and callbacks
 * @param {String} containerId - ID of container to populate
 * @param {Array} folders - Array of folder objects
 * @param {Function} onFolderSelect - Callback when folder selected, receives (folder)
 * @param {Function} onEditFolder - Callback to handle edit save, receives (folderId, updates)
 * @param {Function} onDeleteFolder - Callback to handle delete, receives (folderId)
 * @param {Function} onCreateFolder - Callback for create button, receives ()
 * @param {Function} onReloadFolders - Callback to reload folders, receives (onSuccess) - should call onSuccess(folders) when done
 */
function buildFoldersPanel(containerId, folders, onFolderSelect, onEditFolder, onDeleteFolder, onCreateFolder, onReloadFolders) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`buildFoldersPanel: Container "${containerId}" not found`);
        return;
    }

    container.innerHTML = '';
    container.style.cssText = 'display: flex; flex-direction: column; gap: 10px; height: 100%;';

    // Create header with Folders title and actions bar
    const headerBar = document.createElement('div');
    headerBar.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 10px;';
    
    const title = document.createElement('h3');
    title.textContent = 'Folders';
    title.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 1rem; flex: 1;';
    headerBar.appendChild(title);
    
    // Create actions bar
    const actionsBar = document.createElement('div');
    actionsBar.style.cssText = 'display: flex; gap: 4px;';

    const editBtn = document.createElement('button');
    editBtn.id = 'editFolderBtn';
    editBtn.className = 'btn btn-small btn-grey';
    editBtn.innerHTML = '&#9998;';
    editBtn.disabled = true;
    editBtn.style.cssText = 'width: 22px; height: 22px; padding: 0; margin: 0; display: flex; align-items: flex-start; justify-content: center; padding-top: 2px;';
    editBtn.onclick = () => {
        const folder = window.folderPanelCurrentSelected;
        if (folder && folder.id !== 'all' && folder.id !== 'no_folder') {
            showFolderEditModal(folder, folders, onEditFolder, onDeleteFolder, onReloadFolders);
        }
    };
    actionsBar.appendChild(editBtn);

    const createBtn = document.createElement('button');
    createBtn.id = 'createFolderBtn';
    createBtn.className = 'btn btn-small btn-blue';
    createBtn.innerHTML = '<strong style="font-size: 1.1rem; position: relative; top: -2px;">+</strong>';
    createBtn.style.cssText = 'width: 22px; height: 22px; padding: 0; margin: 0 0 0 0; display: flex; align-items: center; justify-content: center; line-height: 0;';
    createBtn.onclick = () => onCreateFolder();
    actionsBar.appendChild(createBtn);

    headerBar.appendChild(actionsBar);
    container.appendChild(headerBar);

    // Create scrollable folder list
    const listContainer = document.createElement('div');
    listContainer.className = 'content-panel';
    listContainer.style.cssText = 'flex: 1; overflow-y: auto;';

    // Store edit button reference
    window.folderManagementEditBtn = editBtn;

    // Add All option
    const allItem = document.createElement('div');
    allItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px; height: 20px;';
    allItem.setAttribute('data-item-id', 'all');
    const allText = document.createElement('span');
    allText.textContent = 'All';
    allText.style.cssText = 'font-style: italic; color: var(--text-primary);';
    allItem.appendChild(allText);
    allItem.onmouseenter = () => {
        if (!allItem.classList.contains('selected')) {
            allItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
        }
    };
    allItem.onmouseleave = () => {
        if (!allItem.classList.contains('selected')) {
            allItem.style.backgroundColor = '';
        }
    };
    allItem.onclick = () => {
        selectFolderInList(listContainer, allItem, { id: 'all', name: 'All' }, onFolderSelect);
    };
    listContainer.appendChild(allItem);

    // Divider
    const divider1 = document.createElement('div');
    divider1.style.cssText = 'height: 1px; background: var(--table-border); margin: 4px 0;';
    listContainer.appendChild(divider1);

    // Render folder tree
    const treeContainer = document.createElement('div');
    renderTree(folders, treeContainer, {
        onItemClick: (folder) => {
            // Clear all selections in listContainer
            listContainer.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
            });
            
            // Update global state
            window.folderPanelCurrentSelected = folder;

            // Update edit button
            const editBtn = window.folderManagementEditBtn;
            if (editBtn) {
                const canEdit = folder.id !== 'all' && folder.id !== 'no_folder';
                editBtn.disabled = !canEdit;
                editBtn.style.opacity = canEdit ? '1' : '0.5';
                editBtn.style.cursor = canEdit ? 'pointer' : 'not-allowed';
            }

            // Call the folder select callback
            onFolderSelect(folder);
        }
    });
    listContainer.appendChild(treeContainer);

    // Divider
    const divider2 = document.createElement('div');
    divider2.style.cssText = 'height: 1px; background: var(--table-border); margin: 4px 0;';
    listContainer.appendChild(divider2);

    // Add No Folder option
    const noFolderItem = document.createElement('div');
    noFolderItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px; height: 20px;';
    noFolderItem.setAttribute('data-item-id', 'no_folder');
    const noFolderText = document.createElement('span');
    noFolderText.textContent = 'No Folder';
    noFolderText.style.cssText = 'font-style: italic; color: var(--text-primary);';
    noFolderItem.appendChild(noFolderText);
    noFolderItem.onmouseenter = () => {
        if (!noFolderItem.classList.contains('selected')) {
            noFolderItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
        }
    };
    noFolderItem.onmouseleave = () => {
        if (!noFolderItem.classList.contains('selected')) {
            noFolderItem.style.backgroundColor = '';
        }
    };
    noFolderItem.onclick = () => {
        selectFolderInList(listContainer, noFolderItem, { id: 'no_folder', name: 'No Folder' }, onFolderSelect);
    };
    listContainer.appendChild(noFolderItem);

    container.appendChild(listContainer);

    // Auto-select All
    const allFolder = { id: 'all', name: 'All' };
    selectFolderInList(listContainer, allItem, allFolder, onFolderSelect);
}

/**
 * Handle folder selection in list
 */
function selectFolderInList(listContainer, itemElement, folder, onFolderSelect) {
    // Clear all selections
    listContainer.querySelectorAll('[data-item-id]').forEach(el => {
        el.classList.remove('selected');
        el.style.backgroundColor = '';
    });

    // Select this item
    if (itemElement) {
        itemElement.classList.add('selected');
        itemElement.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
    }

    // Update global state
    window.folderPanelCurrentSelected = folder;

    // Update edit button
    const editBtn = window.folderManagementEditBtn;
    if (editBtn) {
        const canEdit = folder.id !== 'all' && folder.id !== 'no_folder';
        editBtn.disabled = !canEdit;
        editBtn.style.opacity = canEdit ? '1' : '0.5';
        editBtn.style.cursor = canEdit ? 'pointer' : 'not-allowed';
    }

    // Call callback
    if (onFolderSelect) {
        onFolderSelect(folder);
    }
}

/**
 * Show edit modal for a folder with Name, Parent, and Delete options
 * @param {Object} folder - Folder object with id, name, parent_id
 * @param {Array} folders - All folders array
 * @param {Function} onSave - Callback when save is clicked, receives (folderId, updates)
 * @param {Function} onDelete - Callback when delete is clicked, receives (folderId)
 */
function showFolderEditModal(folder, folders, onSave, onDelete, onReload) {
    if (!folder || folder.id === 'all' || folder.id === 'no_folder') {
        return;
    }
    
    const folderId = folder.id;
    const folderName = folder.name;
    const currentParentId = folder.parent_id || null;
    
    let editModalClose = null;
    
    showModal({
        type: 'custom',
        title: `Edit Folder`,
        content: `
            <div style="display: flex; flex-direction: column; gap: 15px;">
                <div>
                    <label style="display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 0.9rem;">Folder Name</label>
                    <input type="text" id="editFolderNameInput" value="${folderName}" style="width: 100%; padding: 8px; background: var(--bg-tertiary); border: 1px solid var(--table-border); border-radius: 4px; color: var(--text-primary); box-sizing: border-box;">
                </div>
                <div>
                    <label style="display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 0.9rem;">Parent Folder</label>
                    <div id="editFolderParentTree" style="background: var(--bg-tertiary); border: 1px solid var(--table-border); border-radius: 4px; padding: 8px; height: 200px; overflow-y: auto;"></div>
                </div>
                <div style="border-top: 1px solid var(--table-border); padding-top: 15px;">
                    <button id="deleteFolderOption" style="background: var(--color-red-dark); color: var(--text-primary); border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; width: 100%; text-align: left; display: flex; align-items: center; gap: 8px;">
                        <span>&var(--color-green);</span>
                        <span>Delete Folder</span>
                    </button>
                </div>
            </div>
        `,
        buttons: [
            {
                label: 'Cancel',
                className: 'btn-small',
                callback: ({ close }) => {
                    window.editFolderModalClose = close;
                    close();
                }
            },
            {
                label: 'Save',
                className: 'btn-blue btn-small',
                callback: ({ close }) => {
                    window.editFolderModalClose = close;
                    const newName = document.getElementById('editFolderNameInput').value.trim();
                    const newParentId = window.editFolderSelectedParent;
                    
                    if (!newName) {
                        showModal({
                            type: 'error',
                            title: 'Error',
                            content: 'Folder name cannot be empty'
                        });
                        return;
                    }
                    
                    const updates = { name: newName };
                    if (newParentId !== undefined) {
                        updates.parent_id = newParentId;
                    }
                    
                    onSave(folderId, updates, onReload);
                    close();
                }
            }
        ],
        customWidth: '500px',
        customMinWidth: '300px'
    });
    
    // Render parent folder tree
    const treeContainer = document.getElementById('editFolderParentTree');
    if (treeContainer) {
        treeContainer.innerHTML = '';
        
        // Create "No Parent" option
        const noParentItem = document.createElement('div');
        noParentItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px; height: 20px;';
        noParentItem.setAttribute('data-folder-id', 'no_parent');
        const noParentText = document.createElement('span');
        noParentText.textContent = 'No Parent (Root Level)';
        noParentText.style.fontStyle = 'italic';
        noParentText.style.color = 'var(--text-primary)';
        noParentItem.appendChild(noParentText);
        noParentItem.onmouseenter = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
            }
        };
        noParentItem.onmouseleave = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = '';
            }
        };
        noParentItem.onclick = () => {
            treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
            });
            noParentItem.classList.add('selected');
            noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.editFolderSelectedParent = null;
        };
        treeContainer.appendChild(noParentItem);
        
        // Render the actual folder tree, excluding the folder being edited and its children
        const treeDiv = document.createElement('div');
        
        // Function to get all descendant IDs
        const getDescendantIds = (folderId, foldersList) => {
            const descendants = new Set([folderId]);
            let toProcess = foldersList.filter(f => f.parent_id === folderId);
            
            while (toProcess.length > 0) {
                const current = toProcess.shift();
                descendants.add(current.id);
                toProcess.push(...foldersList.filter(f => f.parent_id === current.id));
            }
            
            return descendants;
        };
        
        const excludeIds = getDescendantIds(folderId, folders || []);
        const filterableFolders = (folders || []).filter(f => !excludeIds.has(f.id));
        
        renderTree(filterableFolders, treeDiv, {
            onItemClick: (folderItem) => {
                if (excludeIds.has(folderItem.id)) {
                    return;
                }
                window.editFolderSelectedParent = folderItem.id;
                noParentItem.classList.remove('selected');
                noParentItem.style.backgroundColor = '';
                treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                    el.classList.remove('selected');
                    el.style.backgroundColor = '';
                });
                const selectedEl = treeDiv.querySelector(`[data-item-id="${folderItem.id}"]`);
                if (selectedEl) {
                    selectedEl.classList.add('selected');
                    selectedEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                }
            }
        });
        treeContainer.appendChild(treeDiv);
        
        // Pre-select current parent
        if (currentParentId) {
            const parentEl = treeDiv.querySelector(`[data-item-id="${currentParentId}"]`);
            if (parentEl) {
                parentEl.classList.add('selected');
                parentEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                window.editFolderSelectedParent = currentParentId;
            }
        } else {
            noParentItem.classList.add('selected');
            noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.editFolderSelectedParent = null;
        }
    }
    
    // Handle delete button
    const deleteBtn = document.getElementById('deleteFolderOption');
    if (deleteBtn) {
        deleteBtn.onclick = () => {
            showModal({
                type: 'confirm',
                title: 'Delete Folder',
                content: `Are you sure you want to delete "${folderName}"?${folder.children && folder.children.length > 0 ? ' Its subfolders will be moved to the root level.' : ' Workflows in this folder will be moved to "No Folder".'}`,
                buttons: [
                    {
                        label: 'Cancel',
                        className: 'btn-small',
                        callback: ({ close }) => close()
                    },
                    {
                        label: 'Delete',
                        className: 'btn-small',
                        callback: ({ close }) => {
                            close();
                            // Close the edit modal by removing it from DOM
                            const modalOverlay = document.querySelector('[style*="position: fixed"]');
                            if (modalOverlay && modalOverlay.querySelector('input[id="editFolderNameInput"]')) {
                                modalOverlay.remove();
                            }
                            // Now perform the delete
                            onDelete(folderId, onReload);
                        }
                    }
                ]
            });
        };
    }
}

/**
 * Build a complete folders panel for workflows (or any similar use case)
 * @param {String} containerId - ID of container to populate
 * @param {String} folderTableName - Name of folder table endpoint (e.g., 'workflow-folders')
 * @param {String} itemsTableName - Name of items table in global (e.g., 'workflows')
 * @param {String} renderFunctionName - Name of render function (e.g., 'renderFilteredWorkflows')
 */
function buildWorkflowFoldersPanel(containerId, folderTableName, itemsTableName, renderFunctionName) {
    const apiUrl = `https://app.equinoxits.com:1139/kore/${folderTableName}`;
    
    // Default render function name if not provided
    if (!renderFunctionName) {
        renderFunctionName = `renderFiltered${itemsTableName.charAt(0).toUpperCase() + itemsTableName.slice(1)}`;
    }
    
    // Return promise for async/await support
    return fetch(apiUrl, {
        method: 'GET',
        headers: { 
            'X-Session-Token': sessionToken,
            'Content-Type': 'application/json'
        }
    })
    .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    })
    .then(data => {
        const folders = data.folders || [];
        window[`${itemsTableName}_folders`] = folders;
        
        // Build panel with proper callbacks
        buildFoldersPanel(
            containerId,
            folders,
            (folder) => onFolderSelectedGeneric(folder, itemsTableName, renderFunctionName),
            (folderId, updates, onReload) => performEditFolderGeneric(folderTableName, folderId, updates, onReload),
            (folderId, onReload) => performDeleteFolderGeneric(folderTableName, folderId, itemsTableName, onReload),
            () => openCreateFolderModalGeneric(folderTableName, folders, (folder) => onFolderSelectedGeneric(folder, itemsTableName, renderFunctionName), () => buildWorkflowFoldersPanel(containerId, folderTableName, itemsTableName, renderFunctionName)),
            () => buildWorkflowFoldersPanel(containerId, folderTableName, itemsTableName, renderFunctionName)
        );
    })
    .catch(error => console.error('Error loading folders:', error));
}

/**
 * Generic folder selection handler that filters items by folder
 * @param {Object} folder - Selected folder
 * @param {String} itemsTableName - Name of items table in global (e.g., 'workflows')
 * @param {String} renderFunctionName - Name of render function to call (e.g., 'renderFilteredWorkflows')
 */
function onFolderSelectedGeneric(folder, itemsTableName, renderFunctionName) {
    window.currentSelectedFolder = folder;
    
    const items = window[itemsTableName] || [];
    console.log(`onFolderSelectedGeneric: folder=${folder.id}, itemsTableName=${itemsTableName}, items.length=${items.length}`);
    console.log(`window[${itemsTableName}]:`, window[itemsTableName]);
    let filteredItems = [];
    
    if (folder.id === 'all') {
        filteredItems = items;
    } else if (folder.id === 'no_folder') {
        filteredItems = items.filter(item => !item.folder_id);
    } else {
        filteredItems = items.filter(item => item.folder_id === folder.id);
    }
    
    console.log(`Filtered items for folder ${folder.id}:`, filteredItems);
    
    // Call the render function
    if (typeof window[renderFunctionName] === 'function') {
        console.log(`Calling ${renderFunctionName} with ${filteredItems.length} items`);
        window[renderFunctionName](filteredItems);
    } else {
        console.error(`Render function ${renderFunctionName} not found`);
    }
}

/**
 * Edit folder - generic
 */
async function performEditFolderGeneric(folderTableName, folderId, updates, onReload) {
    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/${folderTableName}/${folderId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify(updates)
        });
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        showModal({
            type: 'success',
            title: 'Success',
            content: 'Folder updated successfully',
            autoClose: 2000
        });
        
        if (onReload) onReload();
    } catch (error) {
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to update folder: ${error.message}`
        });
    }
}

/**
 * Delete folder - generic
 */
async function performDeleteFolderGeneric(folderTableName, folderId, itemsTableName, onReload) {
    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/${folderTableName}/${folderId}`, {
            method: 'DELETE',
            headers: {
                'X-Session-Token': sessionToken
            }
        });
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        showModal({
            type: 'success',
            title: 'Success',
            content: 'Folder deleted successfully',
            autoClose: 2000
        });
        
        if (onReload) onReload();
        
        // Reload items if applicable
        const reloadFunction = `load${itemsTableName.charAt(0).toUpperCase() + itemsTableName.slice(1)}`;
        if (typeof window[reloadFunction] === 'function') {
            window[reloadFunction]();
        }
    } catch (error) {
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to delete folder: ${error.message}`
        });
    }
}

/**
 * Open create folder modal - generic
 */
function openCreateFolderModalGeneric(folderTableName, folders, onCreated, onReload) {
    showModal({
        type: 'custom',
        title: 'Create New Folder',
        content: `
            <div style="display: flex; flex-direction: column; gap: 15px;">
                <div>
                    <label style="display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 0.9rem;">Folder Name</label>
                    <input type="text" id="createFolderNameInput" placeholder="Enter folder name" style="width: 100%; padding: 8px; background: var(--bg-tertiary); border: 1px solid var(--table-border); border-radius: 4px; color: var(--text-primary); box-sizing: border-box;">
                </div>
                <div>
                    <label style="display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 0.9rem;">Parent Folder</label>
                    <div id="createFolderParentTree" style="background: var(--bg-tertiary); border: 1px solid var(--table-border); border-radius: 4px; padding: 8px; height: 200px; overflow-y: auto;"></div>
                </div>
            </div>
        `,
        buttons: [
            {
                label: 'Cancel',
                className: 'btn-small',
                callback: ({ close }) => close()
            },
            {
                label: 'Create',
                className: 'btn-blue btn-small',
                callback: ({ close }) => {
                    const folderName = document.getElementById('createFolderNameInput').value.trim();
                    
                    if (!folderName) {
                        showModal({
                            type: 'error',
                            title: 'Error',
                            content: 'Folder name cannot be empty'
                        });
                        return;
                    }
                    
                    performCreateFolderGeneric(folderTableName, folderName, window.createFolderSelectedParent || null, close, onReload);
                }
            }
        ],
        customWidth: '500px',
        customMinWidth: '300px'
    });
    
    // Render parent folder tree
    const treeContainer = document.getElementById('createFolderParentTree');
    if (treeContainer) {
        treeContainer.innerHTML = '';
        
        // Create "No Parent" option
        const noParentItem = document.createElement('div');
        noParentItem.style.cssText = 'border-radius: 4px; transition: background-color 0.2s; cursor: pointer; display: flex; align-items: center; padding-left: 10px; height: 20px;';
        noParentItem.setAttribute('data-folder-id', 'no_parent');
        const noParentText = document.createElement('span');
        noParentText.textContent = 'No Parent (Root Level)';
        noParentText.style.fontStyle = 'italic';
        noParentText.style.color = 'var(--text-primary)';
        noParentItem.appendChild(noParentText);
        noParentItem.onmouseenter = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.15)';
            }
        };
        noParentItem.onmouseleave = () => {
            if (!noParentItem.classList.contains('selected')) {
                noParentItem.style.backgroundColor = '';
            }
        };
        noParentItem.onclick = () => {
            treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                el.classList.remove('selected');
                el.style.backgroundColor = '';
            });
            noParentItem.classList.add('selected');
            noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
            window.createFolderSelectedParent = null;
        };
        treeContainer.appendChild(noParentItem);
        
        // Auto-select No Parent
        noParentItem.classList.add('selected');
        noParentItem.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
        window.createFolderSelectedParent = null;
        
        // Render the actual folder tree
        const treeDiv = document.createElement('div');
        renderTree(folders || [], treeDiv, {
            onItemClick: (folder) => {
                window.createFolderSelectedParent = folder.id;
                noParentItem.classList.remove('selected');
                noParentItem.style.backgroundColor = '';
                treeDiv.querySelectorAll('[data-item-id]').forEach(el => {
                    el.classList.remove('selected');
                    el.style.backgroundColor = '';
                });
                const selectedEl = treeDiv.querySelector(`[data-item-id="${folder.id}"]`);
                if (selectedEl) {
                    selectedEl.classList.add('selected');
                    selectedEl.style.backgroundColor = 'rgba(90, 159, 184, 0.3)';
                }
            }
        });
        treeContainer.appendChild(treeDiv);
    }
}

/**
 * Perform folder creation - generic
 */
async function performCreateFolderGeneric(folderTableName, folderName, parentId, closeModal, onReload) {
    try {
        const folderId = generateUUID();
        const response = await fetch(`https://app.equinoxits.com:1139/kore/${folderTableName}`, {
            method: 'POST',
            headers: {
                'X-Session-Token': sessionToken,
                'X-User': getUser(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                id: folderId,
                name: folderName,
                parent_id: parentId || null
            })
        });
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        closeModal();
        showModal({
            type: 'success',
            title: 'Success',
            content: 'Folder created successfully',
            autoClose: 2000,
            onClose: () => {
                if (onReload) onReload();
            }
        });
    } catch (error) {
        showModal({
            type: 'error',
            title: 'Error',
            content: `Failed to create folder: ${error.message}`
        });
    }
}

/**
 * Build a consistent Kore header for all pages
 * @param {string} pageTitle - The title to display in the center (e.g., "Administration")
 * @param {string} containerId - The ID of the container to insert the header into (default: 'kore-header')
 */
function buildKoreHeader(pageTitle, containerId = 'kore-header') {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`Container with ID "${containerId}" not found`);
        return;
    }

    const headerHTML = `
        <div style="flex-shrink: 0; display: flex; align-items: center; padding: 0 15px; height: 50px; background: var(--text-primary); border-radius: 0 50px 50px 0;">
            <img src="/img/kore-logo.png" alt="Kore" style="height: 50px; width: auto;">
        </div>
        <div style="flex: 1; display: flex; justify-content: center; align-items: center;">
            <div style="padding: 0 25px; height: 50px; background: var(--text-primary); border-radius: 50px; display: flex; align-items: center; color: var(--eq-blue-dark); font-size: 24px; font-weight: 700; text-transform: uppercase;">
                ${pageTitle}
            </div>
        </div>
        <div style="flex-shrink: 0; display: flex; align-items: center; padding: 0 15px; height: 50px; background: var(--text-primary); border-radius: 50px 0 0 50px;">
            <button type="button" style="background: none; border: none; color: var(--eq-blue-dark); font-size: 28px; cursor: pointer; padding: 0; line-height: 1;" onclick="toggleHeaderMenu()">&#9776;</button>
        </div>
    `;

    container.innerHTML = headerHTML;
}

/**
 * Toggle header menu (placeholder for future implementation)
 */
function toggleHeaderMenu() {
    console.log('Menu button clicked - implementation pending');
}