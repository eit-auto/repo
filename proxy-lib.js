/**
 * ProxyLib - Reusable library for MeshCentral Proxy authentication and operations
 * Wraps /auth, /validate, /command, and /nodes endpoints
 * Requires: RewstLib (for orgVariables.get)
 */

const ProxyLib = (() => {
    const PROXY_URL = 'https://llink.equinoxits.com:1139';
    
    /**
     * Retrieve API key from org variables
     * @returns {Promise<string>} API key value
     */
    async function getApiKey() {
        try {
            const apiKeyVar = await RewstLib.orgVariables.get('proxy_api_meshcentral');
            
            if (!apiKeyVar || !apiKeyVar.value) {
                throw new Error('proxy_api_meshcentral not found in org variables');
            }
            
            console.log('[ProxyLib] API key retrieved');
            return apiKeyVar.value;
        } catch (error) {
            console.error('[ProxyLib] getApiKey error:', error);
            throw error;
        }
    }
    
    /**
     * Authenticate with proxy to get session token
     * @param {string} user - Username (e.g., bradf@equinoxits.com)
     * @param {string} origin - Origin URL (e.g., https://equinoxits-tools.rew.st)
     * @param {object} options - Optional config (apiKey, etc)
     * @returns {Promise<{status, sessionToken, credentialName, expiresIn}>}
     */
    async function authenticate(user, origin, options = {}) {
        try {
            if (!user || !origin) {
                throw new Error('user and origin are required');
            }
            
            let apiKey = options.apiKey;
            if (!apiKey) {
                apiKey = await getApiKey();
            }
            
            console.log('[ProxyLib] Authenticating user:', user);
            
            const response = await fetch(`${PROXY_URL}/auth`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Proxy-Token': apiKey
                },
                body: JSON.stringify({
                    origin: origin,
                    user: user
                })
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
            throw error;
        }
    }
    
    /**
     * Get all nodes from MeshCentral organized by mesh group
     * @param {string} sessionToken - Session token (from authenticate)
     * @param {string} user - Username
     * @param {object} options - Optional config
     * @returns {Promise<{success, result}>} result is object with mesh groups as keys
     */
    async function getNodes(sessionToken, user, options = {}) {
        try {
            if (!sessionToken || !user) {
                throw new Error('sessionToken and user are required');
            }
            
            console.log('[ProxyLib] Retrieving nodes for user:', user);
            
            const response = await fetch(`${PROXY_URL}/nodes`, {
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
            
            if (!data.success) {
                throw new Error(data.error || 'Failed to retrieve nodes');
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
    
    // Public API
    return {
        getApiKey,
        authenticate,
        validateSession,
        executeCommand,
        getNodes,
        getStatus
    };
})();