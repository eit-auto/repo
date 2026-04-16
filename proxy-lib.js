/**
 * ProxyLib - Reusable library for MeshCentral Proxy authentication and operations
 * Wraps /auth, /validate, /command, and /nodes endpoints
 * Requires: RewstLib (for orgVariables.get)
 */

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
            
            const response = await fetch(`${PROXY_URL}/command`, {
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
            
            const response = await fetch(`${PROXY_URL}/nodes`, {
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
    async function executeQuery(sessionToken, user, query, options = {}) {
        try {
            if (!sessionToken || !user || !query) {
                throw new Error('sessionToken, user, and query are required');
            }
            
            console.log('[ProxyLib] Executing query');
            
            const response = await fetch(`${PROXY_URL}/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Token': sessionToken
                },
                body: JSON.stringify({
                    query: query,
                    user: user
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            
            if (!data.success) {
                throw new Error(data.errors || 'Query execution failed');
            }
            
            console.log('[ProxyLib] Query executed successfully, returned', data.rowCount, 'rows');
            return data;
        } catch (error) {
            console.error('[ProxyLib] executeQuery error:', error);
            throw error;
        }
    }
    
    /**
     * Execute CWA/LabTech MySQL query
     * @param {string} sessionToken - Session token (from authenticate)
     * @param {string} user - Username
     * @param {string} query - SQL query to execute
     * @param {object} options - Optional config
     * @returns {Promise<{success, result, rowCount}>}
     */
    async function executeCwaQuery(sessionToken, user, query, options = {}) {
        try {
            if (!sessionToken || !user || !query) {
                throw new Error('sessionToken, user, and query are required');
            }
            
            console.log('[ProxyLib] Executing CWA query');
            
            const response = await fetch(`${PROXY_URL}/cwaquery`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Token': sessionToken
                },
                body: JSON.stringify({
                    query: query,
                    user: user
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            
            if (!data.success) {
                throw new Error(data.errors || 'CWA query execution failed');
            }
            
            console.log('[ProxyLib] CWA query executed successfully, returned', data.rowCount, 'rows');
            return data;
        } catch (error) {
            console.error('[ProxyLib] executeCwaQuery error:', error);
            throw error;
        }
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
            
            const response = await fetch(`${PROXY_URL}/api-cwm`, {
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
                    timeout: options.timeout || 30000
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
                authBox.textContent = `✓ Authenticated (${authResult.credentialName}) - Ready to execute`;
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
                authBox.textContent = `✗ Auth Error: ${error.message}`;
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