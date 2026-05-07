/**
 * KORE Library - Shared authentication and API utilities
 * Requires: RewstLib (for orgVariables.get)
 */

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
        onClose = null
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
        background: #234656;
        border-radius: 8px;
        padding: 15px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        min-width: 400px;
        max-width: 600px;
        max-height: 80vh;
        overflow-y: auto;
    `;

    // Title
    const titleEl = document.createElement('h2');
    titleEl.style.cssText = 'margin: 0 0 20px 0; color: #ffffff; font-size: 1.3rem;';
    titleEl.textContent = title;
    modalBox.appendChild(titleEl);

    // Content
    const contentEl = document.createElement('div');
    contentEl.style.cssText = 'color: #e0e0e0; margin-bottom: 20px; line-height: 1.5;';
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
            labelEl.style.cssText = 'display: block; color: #ffffff; font-size: 13px; margin-bottom: 3px; font-weight: 600;';
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
            border: 1px solid #556870;
            border-radius: 6px;
            background: #1a3540;
            color: #ffffff;
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
            color: #ff6b6b;
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
    modalBox.appendChild(buttonContainer);

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
        color: #888888;
        font-size: 0.9rem;
        user-select: none;
        box-sizing: border-box;
        margin-bottom: -6px;
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
        color: #666666;
        line-height: 1;
        align-self: flex-start;
        margin-top: -2px;
        cursor: ${hasChildren ? 'pointer' : 'default'};
    `;
    toggleBtn.innerHTML = hasChildren ? '&#43;' : '';
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
    itemName.style.cssText = `flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1rem; margin: 0; display: flex; align-items: center; color: #ffffff;`;
    
    // Build ancestor boxes for levels > 1
    if (level > 1) {
        for (let i = 1; i < level; i++) {
            const ancestorBox = document.createElement('span');
            ancestorBox.style.cssText = `width: 16px; display: inline-flex; align-items: flex-start; justify-content: center; flex-shrink: 0; font-size: 1rem; line-height: 1.2; margin: 0; padding: 0 0 0 1px; border: 0; color: #666666;`;
            
            // Check if ancestor at level i has siblings below
            const ancestorHasSiblings = ancestorSiblingInfo[i - 1] || false;
            
            const char = ancestorHasSiblings ? String.fromCharCode(9474) : ' '; // │ or space
            ancestorBox.appendChild(document.createTextNode(char));
            itemName.appendChild(ancestorBox);
        }
    }
    
    // Final connector box (├ or └)
    if (level > 0) {
        const connectorBox = document.createElement('span');
        connectorBox.style.cssText = `width: 16px; display: inline-flex; align-items: flex-start; justify-content: center; flex-shrink: 0; font-size: 1rem; line-height: 1.2; margin: 0; padding: 0; border: 0; color: #666666;`;
        
        const treeChar = isLastChild ? String.fromCharCode(9492) : String.fromCharCode(9500); // └ or ├
        connectorBox.appendChild(document.createTextNode(treeChar));
        itemName.appendChild(connectorBox);
    }
    
    // Item name text
    const nameText = document.createElement('span');
    nameText.textContent = item.name;
    itemName.appendChild(nameText);
    
    folderRow.appendChild(itemName);

    // Click to toggle
    if (hasChildren) {
        folderRow.style.cursor = 'pointer';
        folderRow.onclick = toggleChildren;
    }

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