/**
 * Kore Plugin Management System
 * 
 * Loads, manages, and executes plugins from the kore_sys database.
 * Handles plugin lifecycle, operation management, and route handling.
 * 
 * Public Methods:
 *   initialize(korePool, getTimestamp, isIPWhitelisted, checkRateLimit)
 *   loadAllPlugins()
 *   loadPlugin(pluginName)
 *   reloadPlugin(pluginName)
 *   reloadAllPlugins()
 *   getHandler(route) -> { plugin, handler } or null
 *   getPlugin(name) -> plugin object or null
 *   listPlugins() -> array of plugin info
 * 
 * @version 0.500 - [KORE_VERSION_INCREMENT_ON_UPDATE]
 */

// plugins.js lives in D:\kore\plugins\, one directory deeper than kore.js
// (D:\kore\kore.js), which itself requires auth.js as './auth/auth'
// (i.e. D:\kore\auth\auth.js) — so from here it's one level up.
const { getSessionTokenFromCookies } = require('../auth/auth');

class KorePlugins {
    constructor() {
        this.pool = null;
        this.getTimestamp = null;
        this.isIPWhitelisted = null;
        this.checkRateLimit = null;
        this.loadedPlugins = {};
        this.operationManagers = {};
    }

    /**
     * Authenticates a request and returns the resolved userId, or writes a
     * 401 response and returns null. Several plugin-admin handlers
     * (handleAddPlugin, handleUpdatePlugin, handleListPlugins,
     * handleGetPluginDetails, the secure-config handlers, and
     * _handleTaskDetails) are dispatched either directly by kore.js's own
     * router or via a URL handleRoute() doesn't recognize as a plugin
     * route (see _handleTaskDetails's /kore/tasks/:taskId, notably absent
     * from the isPluginRoute check) - so none of them can assume
     * req.userId is already set the way handleRoute's own dispatch
     * targets can. This mirrors handleRoute's existing cookie/header
     * token validation exactly, so every handler that needs an
     * authenticated userId for a permission check gets one the same way.
     */
    async _authenticateRequest(req, res) {
        const cookieToken = getSessionTokenFromCookies(req.headers.cookie);
        const headerToken = req.headers['x-session-token'];
        const sessionToken = cookieToken || headerToken;

        const validation = sessionToken
            ? await global.auth.validateSessionToken(sessionToken)
            : { valid: false };

        if (!validation.valid) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Valid session token required' }));
            return null;
        }

        return validation.userId;
    }

    /**
     * Initialize plugins module with dependencies
     * On first call: Sets up dependencies
     * On re-initialization: Drains active operations, then resets and reloads
     */
    async initialize(korePool, getTimestamp, isIPWhitelisted, checkRateLimit) {
        this.getTimestamp = getTimestamp;
        
        // If reinitializing (pool already set), drain active operations first
        if (this.pool) {
            global.consoleLog('Plugins', 'Draining active plugin operations before reload...', 4);
            await this._drainActiveOperations();
        }
        
        // Setup dependencies
        this.pool = korePool;
        this.getTimestamp = getTimestamp;
        this.isIPWhitelisted = isIPWhitelisted;
        this.checkRateLimit = checkRateLimit;
        
        // Clear existing plugins and operation managers for complete reload
        this.loadedPlugins = {};
        this.operationManagers = {};
        
        global.consoleLog('Plugins', 'Initialized', 3);
    }

    /**
     * Drain active operations across all loaded plugins before reload
     * Waits for operations to complete with timeout
     */
    async _drainActiveOperations() {
        const operationTimeout = 30000; // 30 second timeout per plugin
        const plugins = Object.keys(this.loadedPlugins);
        
        if (plugins.length === 0) {
            return;
        }
        
        const drainDeadline = Date.now() + (operationTimeout * plugins.length);
        const drainedPlugins = [];
        const timedOutPlugins = [];
        
        for (const pluginName of plugins) {
            const opManager = this.operationManagers[pluginName];
            if (!opManager || !opManager.activeOperations || opManager.activeOperations.size === 0) {
                continue;
            }
            
            global.consoleLog('Plugins', `Draining ${opManager.activeOperations.size} active operations for plugin ${pluginName}...`, 4);
            
            // Wait for this plugin's active operations to complete
            let waitTime = 0;
            while (opManager.activeOperations.size > 0 && Date.now() < drainDeadline) {
                await new Promise(resolve => setTimeout(resolve, 100));
                waitTime += 100;
            }
            
            if (opManager.activeOperations.size > 0) {
                // Timeout reached with operations still active
                const activeCount = opManager.activeOperations.size;
                timedOutPlugins.push({
                    plugin: pluginName,
                    activeOperations: activeCount,
                    timeoutMs: waitTime
                });
                global.consoleLog('Plugins', `Plugin ${pluginName} had ${activeCount} operations that did not complete (timeout after ${waitTime}ms)`, 2);
            } else {
                drainedPlugins.push(pluginName);
            }
        }
        
        if (timedOutPlugins.length > 0) {
            global.consoleLog('Plugins', `WARNING: ${timedOutPlugins.length} plugin(s) had active operations that did not complete - forcing reload`, 2);
        } else if (drainedPlugins.length > 0) {
            global.consoleLog('Plugins', `Successfully drained operations for ${drainedPlugins.length} plugin(s)`, 3);
        }
    }

    /**
     * Load all enabled plugins from the database
     */
    async loadAllPlugins() {
        try {
            if (!this.pool) {
                global.consoleLog('Plugins', 'WARNING: Pool not available, cannot load plugins', 2);
                return;
            }
            
            const connection = await this.pool.getConnection();
            try {
                const [rows] = await connection.query('SELECT id, name, display_name, code, config, secure_config FROM `plugins` WHERE enabled = true ORDER BY display_name');
                
                let loadedCount = 0;
                for (const pluginRow of rows) {
                    try {
                        this._loadPluginObject(pluginRow);
                        loadedCount++;
                    } catch (pluginError) {
                        global.consoleLog('Plugins', `ERROR loading plugin ${pluginRow.name}: ${pluginError.message}`, 1);
                    }
                }
                
                this._initializeOperationManagers();
                global.consoleLog('Plugins', `Plugins loaded: ${loadedCount}/${rows.length} plugins`, 3);
                
            } finally {
                connection.release();
            }
        } catch (error) {
            global.consoleLog('Plugins', `ERROR loading plugins from database: ${error.message}`, 1);
        }
    }

    /**
     * Load or reload a specific plugin by name
     */
    async loadPlugin(pluginName) {
        try {
            if (!this.pool) {
                throw new Error('Pool not available');
            }
            
            const connection = await this.pool.getConnection();
            try {
                const [rows] = await connection.query('SELECT id, name, display_name, code, config, secure_config FROM `plugins` WHERE name = ? AND enabled = true', [pluginName]);
                
                if (rows.length === 0) {
                    throw new Error(`Plugin ${pluginName} not found or not enabled`);
                }
                
                this._loadPluginObject(rows[0]);
                
                return {
                    success: true,
                    plugin: {
                        name: pluginName,
                        routes: this.loadedPlugins[pluginName]?.routes || [],
                        // Was rows[0].rate_limit (the raw DB column, being dropped
                        // - see Plugins System Guide.md §2/§7) - that never matched
                        // what's actually enforced anyway, which has always come
                        // from config.rateLimit (see _loadPluginObject below).
                        // Reporting the same loaded value listPlugins() already
                        // reports, so this confirmation is now consistent with
                        // what's really in effect rather than a stale/wrong number.
                        rateLimit: this.loadedPlugins[pluginName]?.rateLimit
                    }
                };
                
            } finally {
                connection.release();
            }
        } catch (error) {
            global.consoleLog('Plugins', `ERROR loading plugin ${pluginName}: ${error.message}`, 1);
            throw error;
        }
    }

    /**
     * Reload a specific plugin from the database
     */
    async reloadPlugin(pluginName) {
        try {
            await this.loadPlugin(pluginName);
            this.operationManagers[pluginName] = new PluginOperationManager(this.getTimestamp, pluginName, this);
            
            global.consoleLog('Plugins', `Plugin reloaded: ${pluginName}`, 3);
            return {
                success: true,
                message: `Plugin ${pluginName} reloaded successfully`
            };
        } catch (error) {
            global.consoleLog('Plugins', `ERROR reloading plugin ${pluginName}: ${error.message}`, 1);
            throw error;
        }
    }

    /**
     * Reload all plugins from the database
     */
    async reloadAllPlugins() {
        try {
            global.consoleLog('Plugins', 'Reloading all plugins...', 3);
            this.loadedPlugins = {};
            this.operationManagers = {};
            await this.loadAllPlugins();
            
            const pluginCount = Object.keys(this.loadedPlugins).length;
            global.consoleLog('Plugins', `All plugins reloaded: ${pluginCount} plugins`, 3);
            
            return {
                success: true,
                pluginsLoaded: pluginCount,
                plugins: Object.keys(this.loadedPlugins)
            };
        } catch (error) {
            global.consoleLog('Plugins', `ERROR reloading all plugins: ${error.message}`, 1);
            throw error;
        }
    }

    /**
     * Get a handler for a specific route from loaded plugins
     */
    getHandler(route) {
        for (const pluginName in this.loadedPlugins) {
            const plugin = this.loadedPlugins[pluginName];
            if (plugin.routes.includes(route) && plugin.handlers[route]) {
                return {
                    plugin: plugin,
                    handler: plugin.handlers[route]
                };
            }
        }
        return null;
    }

    /**
     * Get plugin by name
     */
    getPlugin(name) {
        return this.loadedPlugins[name] || null;
    }

    /**
     * Get the operation manager for a plugin
     */
    getOperationManager(pluginName) {
        return this.operationManagers[pluginName] || null;
    }

    /**
     * List all loaded plugins with basic info
     */
    listPlugins() {
        return Object.values(this.loadedPlugins).map(p => ({
            id: p.id,
            name: p.name,
            display_name: p.display_name,
            routes: p.routes,
            rateLimit: p.rateLimit
        }));
    }


    // ============================================================
    // HTTP ENDPOINT HANDLERS
    // Moved from kore.js - these were plugin-management endpoints
    // that belonged here, not in the general server file. korePool/
    // getTimestamp() (kore.js module-level) became this.pool/
    // this.getTimestamp() (already available via initialize() - see
    // constructor). global.Plugins.<method>() calls became this.<method>()
    // where they called back into this same class.
    // ============================================================

    /**
     * HTTP endpoint to load/reload a specific plugin
     * POST /kore/plugins/load?name=pluginName
     */
    async handleLoadPlugin(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            const url = require('url');
            const parsedUrl = url.parse(req.url, true);
            const pluginName = parsedUrl.query.name;

            if (!pluginName) {
                res.writeHead(400);
                res.end(JSON.stringify({
                    status: 'error',
                    message: 'Missing plugin name parameter'
                }));
                return;
            }

            global.consoleLog('Plugins', `Loading plugin: ${pluginName}`, 3);
            const result = await this.loadPlugin(pluginName);

            res.writeHead(200);
            res.end(JSON.stringify(result));
        } catch (error) {
            global.consoleLog('Plugins', `ERROR loading plugin: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({
                status: 'error',
                message: error.message
            }));
        }
    }

    /**
     * HTTP endpoint to reload all plugins
     * POST /kore/plugins/reload-all
     * (Separate from the /api/plugins/reload-all async-job mechanism still
     * in kore.js - this is the simple, synchronous one the Settings UI
     * actually calls, confirmed via plugins-front.js.)
     */
    async handleReloadAllPlugins(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            global.consoleLog('Plugins', 'Reloading all plugins...', 3);
            const result = await this.reloadAllPlugins();

            res.writeHead(200);
            res.end(JSON.stringify(result));
        } catch (error) {
            global.consoleLog('Plugins', `ERROR reloading all plugins: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({
                status: 'error',
                message: error.message
            }));
        }
    }

    /**
     * HTTP endpoint to get full details of a specific plugin
     * GET /kore/plugins/details?name=pluginName
     *
     * routes/rateLimit are read from config here (config.routes/
     * config.configRoutes, config.rateLimit/config.configRateLimit),
     * NOT from routes/rate_limit DB columns - those columns were dropped
     * (see Plugins System Guide.md §1/§7). The original kore.js version of
     * this handler still referenced them directly in its SELECT, which
     * would have broken the moment those columns were gone - fixed here
     * as part of the move, not left as a separate bug to hit later.
     */
    async handleGetPluginDetails(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            const url = require('url');
            const parsedUrl = url.parse(req.url, true);
            const pluginName = parsedUrl.query.name;

            if (!pluginName) {
                res.writeHead(400);
                res.end(JSON.stringify({
                    error: 'Missing plugin name parameter'
                }));
                return;
            }

            const userId = await this._authenticateRequest(req, res);
            if (!userId) return;

            const canView = await global.auth.hasPermission(userId, 'plugin', 'view', pluginName);
            if (!canView) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Forbidden' }));
                return;
            }

            if (!this.pool) {
                res.writeHead(500);
                res.end(JSON.stringify({
                    error: 'Database connection not available'
                }));
                return;
            }

            const connection = await this.pool.getConnection();
            try {
                const [rows] = await connection.query(
                    'SELECT id, name, display_name, description, version, code, config, enabled, created_at, updated_at, created_by, updated_by FROM plugins WHERE name = ?',
                    [pluginName]
                );

                if (rows.length === 0) {
                    res.writeHead(404);
                    res.end(JSON.stringify({
                        error: 'Plugin not found'
                    }));
                    return;
                }

                const plugin = rows[0];
                const parsedConfig = typeof plugin.config === 'string' ? JSON.parse(plugin.config) : (plugin.config || {});

                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    plugin: {
                        id: plugin.id,
                        name: plugin.name,
                        display_name: plugin.display_name,
                        description: plugin.description,
                        version: plugin.version,
                        code: plugin.code,
                        routes: parsedConfig.routes || parsedConfig.configRoutes || [],
                        rateLimit: parsedConfig.rateLimit || parsedConfig.configRateLimit || 100,
                        config: parsedConfig,
                        enabled: plugin.enabled,
                        created_at: plugin.created_at,
                        updated_at: plugin.updated_at,
                        created_by: plugin.created_by,
                        updated_by: plugin.updated_by
                    }
                }));
            } finally {
                connection.release();
            }
        } catch (error) {
            global.consoleLog('Plugins', `ERROR getting plugin details: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({
                error: error.message
            }));
        }
    }

    /**
     * Internal: mask a secure_config value - the entire value, with no
     * reveal, regardless of plugin type. Non-string values are
     * JSON-stringified first. Never returns the plaintext.
     */
    _maskSecureValue(value) {
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        if (!str) return '';
        return '\u2022'.repeat(str.length);
    }

    /**
     * GET /kore/plugins/secure-config?name=X
     * Returns the plugin's secure_config keys with fully masked values -
     * see Kore Plugin System Reference §2.1. Full plaintext is never sent
     * to the front end; values are re-set, not re-displayed.
     */
    async handleGetPluginSecureConfig(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            const url = require('url');
            const parsedUrl = url.parse(req.url, true);
            const pluginName = parsedUrl.query.name;

            if (!pluginName) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing plugin name parameter' }));
                return;
            }

            const userId = await this._authenticateRequest(req, res);
            if (!userId) return;

            const canEdit = await global.auth.hasPermission(userId, 'plugin', 'edit', pluginName);
            if (!canEdit) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Forbidden' }));
                return;
            }

            const plugin = this.loadedPlugins[pluginName];
            if (!plugin) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: `Plugin ${pluginName} not found or not loaded` }));
                return;
            }

            const secureConfig = plugin.secureConfig || {};
            const fields = Object.keys(secureConfig).map((key) => ({
                key,
                masked: this._maskSecureValue(secureConfig[key])
            }));

            res.writeHead(200);
            res.end(JSON.stringify({
                success: true,
                plugin: pluginName,
                fields
            }));
        } catch (error) {
            global.consoleLog('Plugins', `ERROR getting secure_config for plugin: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    /**
     * POST /kore/plugins/secure-config/update?name=X
     * Body: { updates: { key: newValue, ... } }
     * Merges new values into the plugin's secure_config via updateSecureConfig()
     * (encrypt + persist + refresh in-memory copy), then writes an audit_log
     * entry recording which keys changed and who changed them (the verified
     * authenticated user, not a client-supplied field) - never the values
     * themselves.
     */
    async handleUpdatePluginSecureConfig(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
            return;
        }

        const urlParts = req.url.split('?');
        const queryString = urlParts[1] || '';
        const params = new URLSearchParams(queryString);
        const pluginName = params.get('name');

        if (!pluginName) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing plugin name in query string' }));
            return;
        }

        const userId = await this._authenticateRequest(req, res);
        if (!userId) return;

        const canEdit = await global.auth.hasPermission(userId, 'plugin', 'edit', pluginName);
        if (!canEdit) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
            if (body.length > 1e6) {
                req.connection.destroy();
            }
        });

        req.on('end', async () => {
            try {
                let payload;
                try {
                    payload = JSON.parse(body);
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
                    return;
                }

                const updates = payload.updates;
                if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Body must include a non-empty "updates" object' }));
                    return;
                }

                const plugin = this.loadedPlugins[pluginName];
                if (!plugin) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: `Plugin ${pluginName} not found or not loaded` }));
                    return;
                }

                await this.updateSecureConfig(pluginName, updates);

                const performedBy = userId;
                const changedKeys = Object.keys(updates);

                if (global.logAudit) {
                    try {
                        const clientIP = req.socket ? req.socket.remoteAddress : undefined;
                        // Log that these keys changed and who changed them - never the values.
                        await global.logAudit(
                            'secure_config_update',
                            'plugin',
                            plugin.id,
                            pluginName,
                            performedBy,
                            { keys: changedKeys },
                            clientIP
                        );
                    } catch (auditError) {
                        global.consoleLog('Plugins', `WARNING: audit log failed for secure_config update on ${pluginName}: ${auditError.message}`, 2);
                    }
                }

                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: `secure_config updated for plugin ${pluginName}`,
                    keys: changedKeys
                }));

                global.consoleLog('Plugins', `secure_config updated for plugin ${pluginName} by ${performedBy} (keys: ${changedKeys.join(', ')})`, 3);
            } catch (error) {
                global.consoleLog('Plugins', `ERROR updating secure_config for plugin ${pluginName}: ${error.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }

    /**
     * Internal: convert ISO datetime string to MySQL format (YYYY-MM-DD HH:MM:SS).
     * Only used by handleUpdatePlugin below, for plugin_history rows.
     */
    _convertToMySQLDatetime(isoString) {
        if (!isoString) return this.getTimestamp().replace('T', ' ').split('.')[0];
        const converted = isoString.replace('T', ' ').split('.')[0].replace('Z', '');
        return converted;
    }

    /**
     * POST /kore/plugins/add
     * Create a new plugin
     * Body: { name, display_name, description, enabled, version, code, config }
     * created_by/updated_by are set from the verified authenticated user,
     * not read from the request body.
     */
    async handleAddPlugin(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
            return;
        }

        const userId = await this._authenticateRequest(req, res);
        if (!userId) return;

        const canCreate = await global.auth.hasPermission(userId, 'plugin', 'create');
        if (!canCreate) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
            if (body.length > 1e6) {
                req.connection.destroy();
            }
        });

        req.on('end', async () => {
            const connection = await this.pool.getConnection();
            try {
                let pluginData;
                try {
                    pluginData = JSON.parse(body);
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
                    return;
                }

                const { name, display_name, description, enabled, version, code, config } = pluginData;

                if (!name || !display_name) {
                    res.writeHead(400);
                    res.end(JSON.stringify({
                        error: 'Missing required fields: name, display_name'
                    }));
                    return;
                }

                const [existingPlugin] = await connection.query(
                    'SELECT id FROM plugins WHERE name = ?',
                    [name]
                );

                if (existingPlugin.length > 0) {
                    res.writeHead(409);
                    res.end(JSON.stringify({ error: 'Plugin with this name already exists' }));
                    return;
                }

                const createdAt = this.getTimestamp();
                const updatedAt = createdAt;

                let enabledValue = 0;
                if (enabled === true || enabled === 1 || enabled === '1' || enabled === 'true' || enabled === 'on') {
                    enabledValue = 1;
                }

                const [insertResult] = await connection.query(
                    `INSERT INTO plugins 
                    (name, display_name, description, enabled, version, code, config, created_at, updated_at, created_by, updated_by) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        name,
                        display_name,
                        description || null,
                        enabledValue,
                        version || '1.0',
                        code || '',
                        typeof config === 'string' ? config : JSON.stringify(config || {}),
                        createdAt,
                        updatedAt,
                        userId,
                        userId
                    ]
                );

                const pluginId = insertResult.insertId;

                try {
                    await this.loadPlugin(name);
                    global.consoleLog('Plugins', `New plugin created and loaded: ${name} (ID: ${pluginId})`, 3);
                } catch (loadError) {
                    global.consoleLog('Plugins', `Plugin created but failed to load: ${name} - ${loadError.message}`, 2);
                }

                const [createdPluginRows] = await connection.query(
                    'SELECT id, name, display_name, description, version, code, config, enabled, created_at, updated_at, created_by, updated_by FROM plugins WHERE id = ?',
                    [pluginId]
                );

                const createdPlugin = createdPluginRows[0];

                if (typeof createdPlugin.config === 'string') {
                    try {
                        createdPlugin.config = JSON.parse(createdPlugin.config);
                    } catch (e) {
                        createdPlugin.config = {};
                    }
                }

                res.writeHead(201);
                res.end(JSON.stringify({
                    success: true,
                    message: 'Plugin created successfully',
                    plugin: createdPlugin
                }));

            } catch (error) {
                global.consoleLog('Plugins', `Error creating plugin: ${error.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({ error: error.message }));
            } finally {
                connection.release();
            }
        });
    }

    /**
     * POST /kore/plugins/update?name=pluginName
     * Update an existing plugin's settings
     */
    async handleUpdatePlugin(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
            return;
        }

        const urlParts = req.url.split('?');
        const queryString = urlParts[1] || '';
        const params = new URLSearchParams(queryString);
        const pluginName = params.get('name');

        if (!pluginName) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing plugin name in query string' }));
            return;
        }

        const userId = await this._authenticateRequest(req, res);
        if (!userId) return;

        const canEdit = await global.auth.hasPermission(userId, 'plugin', 'edit', pluginName);
        if (!canEdit) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
            if (body.length > 1e6) {
                req.connection.destroy();
            }
        });

        req.on('end', async () => {
            const connection = await this.pool.getConnection();
            try {
                let updates;
                try {
                    updates = JSON.parse(body);
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
                    return;
                }

                const updateFields = [];
                const updateValues = [];

                if (updates.hasOwnProperty('display_name')) {
                    updateFields.push('display_name = ?');
                    updateValues.push(updates.display_name);
                }
                if (updates.hasOwnProperty('version')) {
                    updateFields.push('version = ?');
                    updateValues.push(updates.version);
                }
                if (updates.hasOwnProperty('description')) {
                    updateFields.push('description = ?');
                    updateValues.push(updates.description);
                }
                if (updates.hasOwnProperty('enabled')) {
                    updateFields.push('enabled = ?');
                    updateValues.push(updates.enabled ? 1 : 0);
                }
                if (updates.hasOwnProperty('config')) {
                    updateFields.push('config = ?');
                    updateValues.push(JSON.stringify(updates.config));
                }
                if (updates.hasOwnProperty('code')) {
                    updateFields.push('code = ?');
                    updateValues.push(updates.code);
                }
                if (updates.hasOwnProperty('updated_at')) {
                    updateFields.push('updated_at = ?');
                    updateValues.push(updates.updated_at);
                }
                // updated_by is always the verified authenticated user, not
                // whatever the client sends - unlike the other conditional
                // fields above, this isn't something the caller gets to opt
                // into supplying.
                updateFields.push('updated_by = ?');
                updateValues.push(userId);

                if (updateFields.length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No valid fields to update' }));
                    return;
                }

                updateValues.push(pluginName);

                const query = `UPDATE plugins SET ${updateFields.join(', ')} WHERE name = ?`;
                global.consoleLog('Plugins', `Updating plugin: ${pluginName}`, 3);

                const [result] = await connection.query(query, updateValues);

                if (result.affectedRows === 0) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: `Plugin ${pluginName} not found` }));
                    return;
                }

                const [pluginRows] = await connection.query(
                    'SELECT id FROM plugins WHERE name = ?',
                    [pluginName]
                );

                if (pluginRows.length > 0) {
                    const pluginId = pluginRows[0].id;

                    if (updates.originalConfig) {
                        const origConfig = updates.originalConfig;

                        const historyQuery = `
                            INSERT INTO plugin_history (plugin_id, version, display_name, description, enabled, config, created_at, updated_at, created_by, updated_by)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE
                                display_name = VALUES(display_name),
                                description = VALUES(description),
                                enabled = VALUES(enabled),
                                config = VALUES(config),
                                updated_at = VALUES(updated_at),
                                updated_by = VALUES(updated_by)
                        `;

                        const historyValues = [
                            pluginId,
                            origConfig.version,
                            origConfig.display_name,
                            origConfig.description,
                            origConfig.enabled,
                            origConfig.config ? JSON.stringify(origConfig.config) : null,
                            this._convertToMySQLDatetime(origConfig.created_at),
                            this._convertToMySQLDatetime(origConfig.updated_at),
                            origConfig.created_by,
                            origConfig.updated_by
                        ];

                        global.consoleLog('Plugins', `DEBUG: Saving plugin_history for ${pluginName} v${origConfig.version}`, 4);

                        try {
                            await connection.query(historyQuery, historyValues);
                            global.consoleLog('Plugins', `Plugin history saved for ${pluginName} v${origConfig.version}`, 3);
                        } catch (historyError) {
                            global.consoleLog('Plugins', `Warning: Failed to save plugin history: ${historyError.message}`, 2);
                        }
                    }
                }

                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: `Plugin ${pluginName} updated successfully`,
                    timestamp: this.getTimestamp()
                }));

                global.consoleLog('Plugins', `Plugin ${pluginName} updated by ${userId}`, 3);
            } catch (error) {
                global.consoleLog('Plugins', `ERROR updating plugin: ${error.message}`, 1);
                res.writeHead(500);
                res.end(JSON.stringify({
                    error: error.message,
                    timestamp: this.getTimestamp()
                }));
            } finally {
                connection.release();
            }
        });
    }

    /**
     * HTTP endpoint to list all loaded plugins
     * GET /kore/plugins/list
     * (This is the real, working version - replaces the dead, unreachable
     * _handleListPlugins() that used to live in this file but was always
     * shadowed by kore.js's own copy of this same route. See Plugins
     * System Guide.md §7.)
     */
    async handleListPlugins(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            const userId = await this._authenticateRequest(req, res);
            if (!userId) return;

            const allPlugins = this.listPlugins();
            const plugins = [];
            for (const plugin of allPlugins) {
                const canView = await global.auth.hasPermission(userId, 'plugin', 'view', plugin.name);
                if (canView) plugins.push(plugin);
            }

            res.writeHead(200);
            res.end(JSON.stringify({
                status: 'success',
                pluginsLoaded: plugins.length,
                plugins: plugins
            }));
        } catch (error) {
            global.consoleLog('Plugins', `ERROR listing plugins: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({
                status: 'error',
                message: error.message
            }));
        }
    }

    /**
     * GET /kore/plugin-tasks/admin - unfiltered flat list of every task
     * across every plugin, for the Permissions tab's plugin_task scope
     * picker (mirrors resources.js's /kore/datatables/admin). Deliberately
     * unfiltered by plugin_task/view - the Permissions tab itself is
     * already gated by canManagePermissionsFor(), same as every other
     * resource's admin picker endpoint, so this doesn't need its own
     * per-item permission check on top of that.
     * Scope value is the composite "pluginName:taskId" string, matching
     * the existing doc-linking convention (resources.js's
     * CONCAT(pt.plugin_name, ':', pt.task_id)).
     */
    async handleListPluginTasksAdmin(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            const userId = await this._authenticateRequest(req, res);
            if (!userId) return;

            if (!this.pool) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Database connection not available' }));
                return;
            }

            const connection = await this.pool.getConnection();
            try {
                const [rows] = await connection.query(
                    `SELECT pt.task_id, pt.display_name AS task_display_name,
                            p.name AS plugin_name, p.display_name AS plugin_display_name
                     FROM plugin_tasks pt
                     JOIN plugins p ON p.id = pt.plugin_id
                     WHERE pt.active = TRUE
                     ORDER BY p.display_name, pt.display_name`
                );

                const tasks = rows.map(r => ({
                    id: `${r.plugin_name}:${r.task_id}`,
                    label: `${r.plugin_display_name || r.plugin_name}: ${r.task_display_name}`
                }));

                res.writeHead(200);
                res.end(JSON.stringify({ tasks }));
            } finally {
                connection.release();
            }
        } catch (error) {
            global.consoleLog('Plugins', `ERROR listing plugin tasks (admin): ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    /**
     * HTTP handler for direct plugin route requests (e.g. POST /aurora,
     * POST /msgraph) - resolved via getHandler(), NOT the /executeTask
     * task-based path (see _handleExecuteTask above). helpers here is
     * { isIPWhitelisted, checkRateLimit, config, secureConfig,
     * updateSecureConfig }. It does NOT include taskInputs/processVariables,
     * unlike /executeTask's helpers - those are task-execution-specific and
     * don't apply to a direct route call with no plugin_tasks row behind it.
     * secureConfig/updateSecureConfig WERE also missing here until cwm and
     * sqlquery started depending on them for live requests (not just the
     * Plugin Task Test page's /executeTask path) - see Plugins System
     * Guide.md §2.
     */
    async handlePluginRequest(req, res) {
        const clientIP = req.socket.remoteAddress;
        const route = req.url.split('?')[0];

        global.consoleLog('Plugins', '=== PLUGIN REQUEST ===', 4);
        global.consoleLog('Plugins', `Route: ${route}`, 4);

        const pluginHandler = this.getHandler(route);

        if (!pluginHandler) {
            global.consoleLog('Plugins', `No plugin handler found for ${route}`, 2);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Plugin not found' }));
            return;
        }

        const { plugin, handler } = pluginHandler;

        if (!this.isIPWhitelisted(clientIP)) {
            const rateLimitEndpoint = route;
            const rateLimitCheck = this.checkRateLimit(clientIP, rateLimitEndpoint);
            if (!rateLimitCheck.allowed) {
                global.consoleLog('Plugins', `Rate limit exceeded for IP ${clientIP} on ${route}`, 2);
                res.writeHead(429, {
                    'Content-Type': 'application/json',
                    'Retry-After': rateLimitCheck.resetIn
                });
                res.end(JSON.stringify({
                    error: 'Rate limit exceeded',
                    resetIn: rateLimitCheck.resetIn
                }));
                return;
            }
        }

        const manager = this.getOperationManager(plugin.name);
        if (!manager) {
            global.consoleLog('Plugins', `No operation manager for plugin ${plugin.name}`, 1);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Plugin manager not initialized' }));
            return;
        }

        if (manager.reloadQueued || manager.isReloading) {
            global.consoleLog('Plugins', `Operation rejected for ${plugin.name} due to pending reload`, 2);
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Plugin is reloading',
                reloadId: manager.reloadQueued?.id
            }));
            return;
        }

        const opId = `op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        manager.startOperation(opId);

        const helpers = {
            isIPWhitelisted: this.isIPWhitelisted,
            checkRateLimit: this.checkRateLimit,
            config: plugin.config,
            // Added because cwm and sqlquery now read secureConfig at
            // runtime on this real (non-test) route path - previously this
            // helpers object omitted it (see the doc comment above this
            // function), which was harmless while no plugin actually used
            // it here, but broke both once they started depending on
            // secure_config for live requests (not just /executeTask's
            // Plugin Task Test page, which already had this).
            secureConfig: plugin.secureConfig || {},
            updateSecureConfig: (partialObject) => this.updateSecureConfig(plugin.name, partialObject)
        };

        try {
            await handler(req, res, helpers);
        } catch (error) {
            global.consoleLog('Plugins', `ERROR in plugin ${plugin.name}: ${error.message}`, 1);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: `Module error: ${error.message}`
                }));
            }
        } finally {
            await manager.endOperation(opId);
        }
    }

    /**
     * Resolve a config reference like "@config.databases" to actual values
     * Returns: array of values or null if reference is invalid
     */
    resolveConfigReference(refString, pluginConfig) {
        if (!refString || !refString.startsWith('@config.')) {
            return null;
        }
        
        if (!pluginConfig || !pluginConfig.config) {
            return null;
        }
        
        const path = refString.substring(8); // Remove "@config." prefix
        const parts = path.split('.');
        
        let value = pluginConfig.config;
        for (const part of parts) {
            if (value && typeof value === 'object') {
                value = value[part];
            } else {
                return null;
            }
        }
        
        // Convert object to array of keys, array stays as array
        if (typeof value === 'object') {
            return Array.isArray(value) ? value : Object.keys(value || {});
        }
        
        return null;
    }

    /**
     * Get resolved input options for a task (resolves @config.* and @task.* references)
     * Returns: Promise resolving to Object with input names as keys and resolved options as values
     */
    async getResolvedTaskInputOptions(task, pluginConfig, taskInputValues = {}) {
        const resolved = {};
        
        if (!task.inputs || !Array.isArray(task.inputs)) {
            return resolved;
        }
        
        for (const input of task.inputs) {
            if (input.type === 'select' && input.options) {
                if (Array.isArray(input.options)) {
                    // Check if any option is a reference (@config.* or @task.*)
                    const hasReferences = input.options.some(opt => 
                        typeof opt === 'string' && (opt.startsWith('@config.') || opt.startsWith('@task.'))
                    );
                    
                    if (hasReferences) {
                        resolved[input.name] = await this._resolveInputOptions(input, pluginConfig, taskInputValues);
                    } else {
                        resolved[input.name] = input.options;
                    }
                } else if (typeof input.options === 'string' && input.options.startsWith('@config.')) {
                    // Legacy: single string @config reference
                    const resolvedVal = this.resolveConfigReference(input.options, pluginConfig);
                    resolved[input.name] = resolvedVal || [];
                } else {
                    resolved[input.name] = input.options;
                }
            }
        }
        
        return resolved;
    }

    /**
     * Resolve an input's option references (@config.* and @task.*)
     * Returns: Promise resolving to array of resolved options
     */
    async _resolveInputOptions(input, pluginConfig, taskInputValues = {}) {
        const resolved = [];
        
        for (const option of input.options) {
            if (typeof option === 'string' && option.startsWith('@task.')) {
                // Extract task_id from @task.task_id
                const taskId = option.substring(6); // Remove '@task.' prefix
                
                try {
                    // Get option task inputs if specified, with template variables resolved
                    let optionInputs = {};
                    if (input.optionTaskInputs) {
                        // Check BEFORE running the subtask whether every {fieldName} placeholder
                        // this option depends on actually has a value yet (e.g. a "Team" dropdown
                        // whose source task needs customerTenantId, which the calling task's own
                        // form may not have had filled in when this resolution ran). Running the
                        // subtask anyway would send it a literal unresolved "{fieldName}" string,
                        // which fails against the real API and gets silently swallowed into an
                        // empty result either way -- skipping outright avoids the wasted call
                        // (a real cost for plugins like msgraph, where this means a full token
                        // redemption) and makes "dependency not met" distinguishable in logs from
                        // "genuinely zero results."
                        const missingFields = this._getUnresolvedTemplateFields(input.optionTaskInputs, taskInputValues);
                        if (missingFields.length > 0) {
                            global.consoleLog('Plugins', `Skipping @task.${taskId} option resolution for input "${input.name}" -- missing dependency field(s): ${missingFields.join(', ')}`, 4);
                            continue;
                        }
                        optionInputs = this._resolveTemplateVariables(input.optionTaskInputs, taskInputValues);
                    }
                    
                    // Execute the referenced task
                    const taskOptions = await this._executeTaskForOptions(taskId, optionInputs);
                    
                    if (Array.isArray(taskOptions)) {
                        resolved.push(...taskOptions);
                    }
                } catch (error) {
                    global.consoleLog('Plugins', `Error resolving @task.${taskId}: ${error.message}`, 1);
                    // Continue with empty options on error
                }
            } else if (typeof option === 'string' && option.startsWith('@config.')) {
                // Handle existing @config.* references
                const configOptions = this.resolveConfigReference(option, pluginConfig);
                if (Array.isArray(configOptions)) {
                    resolved.push(...configOptions);
                }
            } else {
                // Static option
                resolved.push(option);
            }
        }
        
        return resolved.length > 0 ? resolved : [];
    }

    /**
     * Scan an optionTaskInputs template object (e.g. {"customerTenantId": "{customerTenantId}"})
     * for {fieldName} placeholders, and return the names of any whose value is missing/empty in
     * taskInputValues -- i.e. dependencies that aren't satisfied yet. Empty array means every
     * dependency this option needs is currently available.
     */
    _getUnresolvedTemplateFields(obj, taskInputValues) {
        const missing = [];
        for (const value of Object.values(obj)) {
            if (typeof value === 'string') {
                for (const match of value.matchAll(/{([^}]+)}/g)) {
                    const fieldName = match[1];
                    const fieldValue = taskInputValues[fieldName];
                    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
                        missing.push(fieldName);
                    }
                }
            }
        }
        return missing;
    }

    /**
     * Resolve template variables like {fieldName} with values from taskInputValues
     */
    _resolveTemplateVariables(obj, taskInputValues) {
        const result = JSON.parse(JSON.stringify(obj)); // Deep copy
        
        for (const [key, value] of Object.entries(result)) {
            if (typeof value === 'string') {
                // Replace {fieldName} with value from taskInputValues
                result[key] = value.replace(/{([^}]+)}/g, (match, fieldName) => {
                    return taskInputValues[fieldName] !== undefined ? taskInputValues[fieldName] : match;
                });
            }
        }
        
        return result;
    }

    /**
     * Execute a task internally and return its options output
     */
    async _executeTaskForOptions(taskId, inputs = {}) {
        try {
            if (!this.pool) {
                throw new Error('Database pool not available');
            }

            const connection = await this.pool.getConnection();
            try {
                const [rows] = await connection.query(
                    'SELECT * FROM plugin_tasks WHERE task_id = ? AND active = TRUE',
                    [taskId]
                );

                if (rows.length === 0) {
                    throw new Error(`Task ${taskId} not found`);
                }

                const task = rows[0];
                
                // Parse static_params
                let staticParams = {};
                if (task.static_params) {
                    try {
                        staticParams = typeof task.static_params === 'string' ? JSON.parse(task.static_params) : task.static_params;
                    } catch (e) {
                        global.consoleLog('Plugins', `Could not parse static_params for task ${taskId}`, 2);
                    }
                }

                // Parse inputs metadata (needed by processVariables to know which
                // keys are pathParam-targeted, for trimming stray whitespace)
                let taskInputsMeta = [];
                if (task.inputs) {
                    try {
                        taskInputsMeta = typeof task.inputs === 'string' ? JSON.parse(task.inputs) : task.inputs;
                        if (!Array.isArray(taskInputsMeta)) taskInputsMeta = [];
                    } catch (e) {
                        global.consoleLog('Plugins', `Could not parse inputs for task ${taskId}`, 2);
                    }
                }

                // Get plugin name
                const [pluginRows] = await connection.query(
                    'SELECT name FROM plugins WHERE id = ?',
                    [task.plugin_id]
                );

                if (pluginRows.length === 0) {
                    throw new Error(`Plugin not found for task ${taskId}`);
                }

                const pluginName = pluginRows[0].name;
                const plugin = this.getPlugin(pluginName);
                
                if (!plugin) {
                    throw new Error(`Plugin not loaded: ${pluginName}`);
                }

                const handler = this.getHandler(task.route);
                if (!handler) {
                    throw new Error(`No handler found for route: ${task.route}`);
                }

                // Merge inputs
                const mergedInputs = {
                    endpoint: task.endpoint,
                    ...staticParams,
                    ...inputs
                };

                // Process variables
                const processedInputs = this.processVariables(mergedInputs, taskInputsMeta);

                // Create mock request/response for internal execution
                return await new Promise((resolve, reject) => {
                    // Create a robust mock socket that handles common handler operations
                    const mockSocket = {
                        remoteAddress: 'internal',
                        listeners: {},
                        timeouts: [],
                        
                        // Set timeout - actually schedule it
                        setTimeout: function(timeout, callback) {
                            if (timeout && timeout > 0) {
                                const timeoutId = global.setTimeout(() => {
                                    if (callback) callback();
                                }, timeout);
                                this.timeouts.push(timeoutId);
                            }
                        },
                        
                        // Register event listener
                        on: function(event, callback) {
                            if (!this.listeners[event]) {
                                this.listeners[event] = [];
                            }
                            this.listeners[event].push(callback);
                            return this;
                        },
                        
                        // Register one-time event listener
                        once: function(event, callback) {
                            const wrappedCallback = (...args) => {
                                callback(...args);
                                this.removeListener(event, wrappedCallback);
                            };
                            return this.on(event, wrappedCallback);
                        },
                        
                        // Remove event listener
                        removeListener: function(event, callback) {
                            if (this.listeners[event]) {
                                this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
                            }
                            return this;
                        },
                        
                        // Alias for removeListener
                        off: function(event, callback) {
                            return this.removeListener(event, callback);
                        },
                        
                        // Emit event to listeners
                        emit: function(event, ...args) {
                            if (this.listeners[event]) {
                                this.listeners[event].forEach(callback => {
                                    try {
                                        callback(...args);
                                    } catch (error) {
                                        global.consoleLog('Plugins', `[internal socket] Error in event listener: ${JSON.stringify(error)}`, 1);
                                    }
                                });
                            }
                            return this;
                        },
                        
                        // Write data (no-op for internal calls)
                        write: function(data) {
                            return true;
                        },
                        
                        // End socket (cleanup)
                        end: function() {
                            this.timeouts.forEach(id => global.clearTimeout(id));
                            this.listeners = {};
                            return this;
                        },
                        
                        // Destroy socket immediately
                        destroy: function() {
                            this.end();
                        },
                        
                        // Pause data flow (no-op for internal)
                        pause: function() {
                            return this;
                        },
                        
                        // Resume data flow (no-op for internal)
                        resume: function() {
                            return this;
                        }
                    };

                    const mockReq = {
                        method: task.method || 'GET',
                        url: task.route,
                        headers: {},
                        socket: mockSocket,
                        body: JSON.stringify(processedInputs),
                        on: function(event, callback) {
                            if (event === 'data') {
                                callback(Buffer.from(this.body));
                            } else if (event === 'end') {
                                callback();
                            }
                        }
                    };

                    let responseResolved = false;
                    const mockRes = {
                        writeHead: (code, headers) => {
                            mockRes.statusCode = code;
                        },
                        end: (data) => {
                            if (responseResolved) return;
                            responseResolved = true;
                            try {
                                const parsed = JSON.parse(data);
                                // Extract options from response - look for 'options', 'data', or 'result' field
                                let optionsData = parsed.options || parsed.data || parsed.result || [];
                                
                                // Convert dict/object to array if needed
                                if (!Array.isArray(optionsData) && typeof optionsData === 'object' && optionsData !== null) {
                                    optionsData = Object.values(optionsData);
                                }
                                
                                // Transform objects using task's label_field and value_field if provided
                                if (Array.isArray(optionsData) && optionsData.length > 0 && typeof optionsData[0] === 'object') {
                                    const firstItem = optionsData[0];
                                    
                                    if (task.label_field && task.value_field) {
                                        optionsData = optionsData.map(item => {
                                            // Check if label_field is a template (contains @fieldName@ pattern)
                                            let label = task.label_field;
                                            if (label.includes('@')) {
                                                // Replace @fieldName@ patterns with actual values
                                                label = label.replace(/@([a-zA-Z_][a-zA-Z0-9_]*(?:\/[a-zA-Z_][a-zA-Z0-9_]*)*)?@/g, (match, fieldPath) => {
                                                    // Navigate nested fields like "model/name"
                                                    let value = item;
                                                    if (fieldPath) {
                                                        const parts = fieldPath.split('/');
                                                        for (const part of parts) {
                                                            value = value && value[part];
                                                        }
                                                    }
                                                    return value !== undefined ? String(value) : match;
                                                });
                                            } else {
                                                // Simple field name
                                                label = item[task.label_field];
                                            }
                                            
                                            return {
                                                value: item[task.value_field],
                                                label: String(label)
                                            };
                                        });
                                    } else if (task.value_field) {
                                        // value_field defined but not label_field: default to 'name'
                                        optionsData = optionsData.map(item => ({
                                            value: item[task.value_field],
                                            label: String(item.name || item.id || item.value || '')
                                        }));
                                    } else if ('id' in firstItem && 'name' in firstItem && !('value' in firstItem) && !('label' in firstItem)) {
                                        // Fallback: Transform id/name objects to value/label format
                                        optionsData = optionsData.map(item => ({
                                            value: item.id,
                                            label: item.name
                                        }));
                                    }
                                }
                                
                                resolve(optionsData);
                            } catch (e) {
                                reject(new Error(`Invalid JSON response from task ${taskId}: ${e.message}`));
                            }
                        },
                        write: (data) => {
                            // Accumulate response data if needed
                        },
                        headersSent: false,
                        setHeader: () => {}
                    };

                    // Execute handler with timeout
                    const timeout = setTimeout(() => {
                        if (!responseResolved) {
                            responseResolved = true;
                            reject(new Error(`Task ${taskId} execution timeout (30s)`));
                        }
                    }, 30000); // 30 second timeout

                    try {
                        const { handler: handlerFunc, plugin: pluginObj } = handler;
                        handlerFunc(mockReq, mockRes, {
                            isIPWhitelisted: this.isIPWhitelisted,
                            checkRateLimit: this.checkRateLimit,
                            config: pluginObj.config,
                            secureConfig: pluginObj.secureConfig || {},
                            updateSecureConfig: (partialObject) => this.updateSecureConfig(pluginObj.name, partialObject),
                            taskInputs: task.inputs ? (typeof task.inputs === 'string' ? JSON.parse(task.inputs) : task.inputs) : [],
                            processVariables: this.processVariables.bind(this)
                        }).catch((error) => {
                            if (!responseResolved) {
                                responseResolved = true;
                                clearTimeout(timeout);
                                reject(error);
                            }
                        });
                    } catch (error) {
                        if (!responseResolved) {
                            responseResolved = true;
                            clearTimeout(timeout);
                            reject(error);
                        }
                    }
                });

            } finally {
                connection.release();
            }
        } catch (error) {
            global.consoleLog('Plugins', `Error executing task for options: ${error.message}`, 1);
            throw error;
        }
    }

    /**
     * Process variables in input values
     * Supports: $(now), $(now - 365), $(now + 7), etc.
     * Returns values formatted as [YYYY-MM-DD] for CWM date conditions
     */
    processVariables(obj, taskInputsMeta = []) {
        const variablePattern = /\$\(([^)]+)\)/g;
        const result = JSON.parse(JSON.stringify(obj)); // Deep copy

        // Trailing/leading whitespace on a pasted or hand-typed identifier
        // (e.g. a ticket ID with a trailing space) causes the resulting
        // endpoint URL/path-param value to be silently malformed downstream
        // in the plugin handler, producing an opaque API error rather than a
        // clear one -- confirmed real bug against CWM's Get Service Ticket
        // task. Trimming is scoped ONLY to inputs whose own definition
        // targets 'pathParam', not applied blanket to every string value --
        // a free-text field (e.g. a note body) may have meaningful leading/
        // trailing whitespace that shouldn't be silently altered.
        const pathParamKeys = new Set(
            (taskInputsMeta || [])
                .filter(inp => inp && inp.target === 'pathParam')
                .map(inp => inp.name)
        );

        const processValue = (value) => {
            if (typeof value !== 'string') return value;
            
            return value.replace(variablePattern, (match, expression) => {
                try {
                    // Handle "now", "now - 365", "now + 7", etc.
                    if (expression.includes('now')) {
                        const now = new Date();
                        let date = new Date(now);
                        
                        // Parse the expression: "now", "now - 365", "now + 7"
                        if (expression !== 'now') {
                            const operator = expression.includes('-') ? '-' : '+';
                            const numberPart = expression.split(operator)[1].trim();
                            const days = parseInt(numberPart, 10);
                            
                            if (!isNaN(days)) {
                                if (operator === '-') {
                                    date.setDate(date.getDate() - days);
                                } else {
                                    date.setDate(date.getDate() + days);
                                }
                            }
                        }
                        
                        // Format as [YYYY-MM-DD] for CWM
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        return `[${year}-${month}-${day}]`;
                    }
                    
                    return match; // Return unchanged if not recognized
                } catch (error) {
                    global.consoleLog('Plugins', `Error processing variable ${match}: ${error.message}`, 1);
                    return match;
                }
            });
        };
        
        // Process all string values in the object
        for (const [key, value] of Object.entries(result)) {
            result[key] = processValue(value);
            if (pathParamKeys.has(key) && typeof result[key] === 'string') {
                result[key] = result[key].trim();
            }
        }
        
        return result;
    }

    /**
     * Execute a plugin task
     * Stub for future implementation
     */
    async executeTask(taskId, inputs) {
        global.consoleLog('Plugins', `Executing task ${taskId} with inputs: ${JSON.stringify(inputs)}`, 4);
        
        try {
            if (!this.pool) {
                throw new Error('Database pool not available');
            }

            const connection = await this.pool.getConnection();
            let task;
            let pluginId;
            
            try {
                // Load task from database
                const [rows] = await connection.query(
                    'SELECT * FROM plugin_tasks WHERE task_id = ? AND active = TRUE',
                    [taskId]
                );

                if (rows.length === 0) {
                    return {
                        success: false,
                        error: 'Task not found',
                        taskId: taskId
                    };
                }

                task = rows[0];
                pluginId = task.plugin_id;

                // Parse static_params
                try {
                    if (typeof task.static_params === 'string') {
                        task.static_params = task.static_params ? JSON.parse(task.static_params) : {};
                    } else if (typeof task.static_params === 'object' && task.static_params !== null) {
                        task.static_params = task.static_params;
                    } else {
                        task.static_params = {};
                    }
                } catch (parseError) {
                    global.consoleLog('Plugins', `WARNING: Could not parse static_params for task ${taskId}: ${parseError.message}`, 2);
                    task.static_params = {};
                }

                // Parse inputs
                try {
                    if (typeof task.inputs === 'string') {
                        task.inputs = task.inputs ? JSON.parse(task.inputs) : [];
                    } else if (Array.isArray(task.inputs)) {
                        task.inputs = task.inputs;
                    } else if (typeof task.inputs === 'object' && task.inputs !== null) {
                        task.inputs = [];
                    } else {
                        task.inputs = [];
                    }
                } catch (parseError) {
                    global.consoleLog('Plugins', `WARNING: Could not parse inputs for task ${taskId}: ${parseError.message}`, 2);
                    task.inputs = [];
                }

                // Get the plugin name from the plugin_id
                const [pluginRows] = await connection.query(
                    'SELECT name FROM plugins WHERE id = ?',
                    [pluginId]
                );

                if (pluginRows.length === 0) {
                    return {
                        success: false,
                        error: 'Plugin not found',
                        taskId: taskId
                    };
                }

                task.pluginName = pluginRows[0].name;
                
            } finally {
                connection.release();
            }

            global.consoleLog('Plugins', `Task loaded: ${task.display_name}, plugin: ${task.pluginName}, route: ${task.route}`, 4);

            // Check for passthrough mode - delegate to subTask instead
            if (task.static_params.subTaskMode === 'passthrough' && task.static_params.subTask) {
                let subTaskId = task.static_params.subTask;
                // Resolve @task.* reference if present
                if (typeof subTaskId === 'string' && subTaskId.startsWith('@task.')) {
                    subTaskId = subTaskId.substring(6); // Remove '@task.' prefix
                }
                global.consoleLog('Plugins', `Task ${taskId} using passthrough mode, delegating to task ${subTaskId}`, 4);
                
                // Merge relevant config parameters (datasource, etc.) with inputs
                const delegateInputs = {
                    ...task.static_params,
                    ...inputs
                };
                // Remove internal parameters that shouldn't be passed down
                delete delegateInputs.subTask;
                delete delegateInputs.subTaskMode;
                
                return this.executeTask(subTaskId, delegateInputs);
            }

            // Check for enrichBefore mode - run a subtask first and merge its result
            // into `inputs` under `subTaskResultKey`, then CONTINUE on to this task's
            // own plugin/handler/route as normal (unlike passthrough, which returns
            // immediately and never reaches the original handler at all). This is how
            // a task can pull in one piece of subtask-sourced context (e.g. a DB-backed
            // config value another plugin already has credentials for) without needing
            // its own copy of those credentials, while still doing its own primary work.
            //
            // static_params shape: {"subTaskMode": "enrichBefore", "subTask": "@task.N",
            // "subTaskInputs": {...}, "subTaskResultKey": "some_key"}. A failed subtask
            // does not fail the primary call -- `subTaskResultKey` is set to `null` and
            // the primary handler runs anyway; it's the handler's own job to degrade
            // sensibly (e.g. fall back to a default) if the enrichment value is missing.
            //
            // NOTE for future work: this only covers "get some context before I run".
            // Two related-but-distinct modes were discussed and deliberately NOT built
            // here, kept as separate future work rather than folded into this one:
            //   - "enrichAfter": run a subtask independently and bolt its result onto
            //     the primary handler's *own already-produced response* as a sibling
            //     key, after the fact. The primary handler's own code never sees or
            //     uses the enrichment value -- useful for cheaply attaching unrelated
            //     context to a response, but NOT a substitute for enrichBefore when the
            //     handler's own logic needs to actually consume the value.
            //   - "handoff" (a real pipeline/chain): the primary handler's own OUTPUT
            //     becomes the INPUT to a subtask, and the subtask's result becomes the
            //     final result of the whole task -- "process this, then hand the result
            //     to X for further transformation". Genuinely different from both modes
            //     above; worth its own design pass rather than conflating with either.
            if (task.static_params.subTaskMode === 'enrichBefore' && task.static_params.subTask) {
                let subTaskId = task.static_params.subTask;
                if (typeof subTaskId === 'string' && subTaskId.startsWith('@task.')) {
                    subTaskId = subTaskId.substring(6);
                }
                const resultKey = task.static_params.subTaskResultKey || 'subtask_result';
                global.consoleLog('Plugins', `Task ${taskId} enrichBefore with subtask ${subTaskId} -> ${resultKey}`, 4);
                try {
                    const enrichResult = await this.executeTask(subTaskId, task.static_params.subTaskInputs || {});
                    inputs = { ...inputs, [resultKey]: enrichResult.result };
                } catch (error) {
                    global.consoleLog('Plugins', `enrichBefore subtask ${subTaskId} failed: ${error.message}`, 2);
                    inputs = { ...inputs, [resultKey]: null };
                }
            }

            // Find the plugin object
            const plugin = this.getPlugin(task.pluginName);
            if (!plugin) {
                return {
                    success: false,
                    error: `Plugin not loaded: ${task.pluginName}`,
                    taskId: taskId
                };
            }
            
            // Get the plugin handler for the task's route
            const handler = this.getHandler(task.route);
            if (!handler) {
                return {
                    success: false,
                    error: `No handler found for route: ${task.route}`,
                    taskId: taskId
                };
            }

            // Merge static_params with runtime inputs
            const mergedInputs = { 
                endpoint: task.endpoint,
                ...task.static_params, 
                ...inputs 
            };
            global.consoleLog('Plugins', `Merged inputs: ${JSON.stringify(mergedInputs)}`, 4);
            
            // Process variables (e.g., $(now - 365)) in merged inputs
            const processedInputs = this.processVariables(mergedInputs, task.inputs);
            global.consoleLog('Plugins', `Processed inputs (variables resolved): ${JSON.stringify(processedInputs)}`, 4);
            global.consoleLog('Plugins', `Executing handler: ${task.route}`, 4);

            // Execute the handler directly and capture result
            return new Promise((resolve) => {
                // Create a mock response object
                const mockRes = {
                    statusCode: 200,
                    headers: {},
                    setHeader: function(key, value) {
                        this.headers[key] = value;
                    },
                    writeHead: function(code) {
                        this.statusCode = code;
                    },
                    end: function(data) {
                        try {
                            const parsed = JSON.parse(data);
                            const responseStatusCode = this.statusCode || 200;
                            const isSuccess = responseStatusCode >= 200 && responseStatusCode < 300;
                            
                            // Extract the actual data from various possible formats
                            let result = parsed.options || parsed.data || parsed.result || parsed;
                            
                            // Extract error message
                            let message = parsed.message;
                            if (!message && !isSuccess) {
                                message = parsed.error || parsed.error_message || parsed.errorMessage || 'Operation failed';
                            }
                            
                            // Apply label_field formatting if result is array of objects
                            if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
                                result = result.map(item => {
                                    let label;
                                    
                                    if (task.label_field) {
                                        label = task.label_field;
                                        if (label.includes('@')) {
                                            label = label.replace(/@([a-zA-Z_][a-zA-Z0-9_]*(?:\/[a-zA-Z_][a-zA-Z0-9_]*)*)?@/g, (match, fieldPath) => {
                                                let value = item;
                                                if (fieldPath) {
                                                    const parts = fieldPath.split('/');
                                                    for (const part of parts) {
                                                        value = value && value[part];
                                                    }
                                                }
                                                return value !== undefined ? String(value) : match;
                                            });
                                        } else {
                                            label = item[task.label_field];
                                        }
                                    } else {
                                        label = item.name || item.id || item.value || '';
                                    }
                                    
                                    return {
                                        ...item,
                                        _label: String(label)
                                    };
                                });
                            }
                            
                            // FUTURE WORK, not built: "enrichAfter" would splice in right here --
                            // after `result`/`isSuccess` are known but before resolve() -- running
                            // a subtask independently and merging its result onto `result` as a
                            // sibling key (`result = {...result, [resultKey]: enrichResult.result}`,
                            // guarded to plain-object `result` shapes only, skipped for arrays like
                            // this function's own label_field-formatted lists). Distinct from
                            // "handoff" (also not built): piping `result` itself INTO a subtask as
                            // that subtask's input, with the subtask's own result becoming the
                            // final result of this task entirely -- a real pipeline/chain, not just
                            // an attached sibling key. See the enrichBefore design note earlier in
                            // this function for the full three-way comparison.
                            resolve({
                                success: isSuccess,
                                result: result,
                                message: message || (isSuccess ? 'Operation completed successfully' : 'Operation failed'),
                                taskId: taskId
                            });
                        } catch (e) {
                            global.consoleLog('Plugins', `Could not parse response: ${e.message}`, 2);
                            resolve({
                                success: false,
                                result: null,
                                message: 'Invalid response format from plugin',
                                taskId: taskId
                            });
                        }
                    }
                };

                // Create mock request
                const mockReq = {
                    method: task.method || 'GET',
                    url: task.route,
                    headers: {},
                    socket: {
                        remoteAddress: 'internal',
                        setTimeout: function() {} // No-op for workflow execution
                    },
                    body: JSON.stringify(processedInputs),
                    on: function(event, callback) {
                        if (event === 'data') {
                            callback(Buffer.from(this.body));
                        } else if (event === 'end') {
                            callback();
                        }
                    }
                };

                // Call the plugin handler with helpers
                const { handler: handlerFunc } = handler;
                handlerFunc(mockReq, mockRes, {
                    isIPWhitelisted: this.isIPWhitelisted,
                    checkRateLimit: this.checkRateLimit,
                    config: plugin.config,
                    secureConfig: plugin.secureConfig || {},
                    updateSecureConfig: (partialObject) => this.updateSecureConfig(task.pluginName, partialObject),
                    taskInputs: task.inputs ? (typeof task.inputs === 'string' ? JSON.parse(task.inputs) : task.inputs) : [],
                    processVariables: this.processVariables.bind(this)
                });
            });
            
        } catch (error) {
            global.consoleLog('Plugins', `ERROR executing task ${taskId}: ${error.message}`, 1);
            return {
                success: false,
                error: error.message,
                taskId: taskId
            };
        }
    }

    /**
     * Route plugin requests
     * Returns true if route was handled, false otherwise
     */
    async handleRoute(req, res) {
        const urlPath = req.url.split('?')[0];
        global.consoleLog('Plugins', `handleRoute checking: ${urlPath}`, 4);

        // Determine if this is a plugin route before applying auth
        const isPluginRoute = urlPath === '/executeTask' || 
                              urlPath === '/plugins/execute' ||
                              urlPath === '/kore/plugins/list' ||
                              urlPath === '/kore/plugin-tasks/admin' ||
                              urlPath.startsWith('/kore/plugins/details') ||
                              urlPath.match(/^\/kore\/plugins\/[^/]+\/tasks$/) ||
                              this.getHandler(urlPath);
        
        // Session token validation - only for actual plugin routes.
        // Cookie takes priority over the header: front-end code (base.js's
        // window.sessionToken, datatables.js's executeSqlQuery calls) now
        // deliberately sends a non-empty placeholder in X-Session-Token
        // for every browser request, since the real sessionToken cookie is
        // HttpOnly and unreadable in JS - the actual auth is the
        // auto-attached cookie. If the header were checked first, that
        // placeholder would shadow the real cookie and fail validation.
        // The header is still checked as a fallback for any genuine
        // server-to-server/API-key caller that has no cookie at all.
        // Whichever one is present gets actually validated via
        // global.auth.validateSessionToken() - the same check kore.js's
        // static-file middleware and auth.js's /auth/validate-token use.
        // Previously this only checked that the header was non-empty,
        // without validating it at all - any truthy string passed.
        if (isPluginRoute) {
            const isInternalCall = req.socket && req.socket.remoteAddress === 'internal';

            if (!isInternalCall) {
                const cookieToken = getSessionTokenFromCookies(req.headers.cookie);
                const headerToken = req.headers['x-session-token'];
                const sessionToken = cookieToken || headerToken;

                const validation = sessionToken
                    ? await global.auth.validateSessionToken(sessionToken)
                    : { valid: false };

                if (!validation.valid) {
                    global.consoleLog('Plugins', `Rejecting ${urlPath}: invalid or missing session token`, 2);
                    res.setHeader('Content-Type', 'application/json');
                    res.writeHead(401);
                    res.end(JSON.stringify({ error: 'Valid session token required' }));
                    return true;
                }

                req.userId = validation.userId;
                global.consoleLog('Plugins', `External call authenticated as user ${validation.userId}`, 4);
            } else {
                global.consoleLog('Plugins', 'Internal call (bypassing token requirement)', 4);
            }
        }

        if (urlPath === '/executeTask') {
            global.consoleLog('Plugins', 'Handling /executeTask', 4);
            await this._handleExecuteTask(req, res);
            return true;
        }

        if (urlPath === '/plugins/execute') {
            global.consoleLog('Plugins', 'Handling /plugins/execute', 4);
            await this._handleExecute(req, res);
            return true;
        }

        if (urlPath.match(/^\/kore\/plugins\/[^/]+\/tasks$/)) {
            global.consoleLog('Plugins', 'Handling /kore/plugins/*/tasks', 4);
            await this._handlePluginTasks(req, res);
            return true;
        }

        if (urlPath.match(/^\/kore\/tasks\/\d+$/)) {
            global.consoleLog('Plugins', 'Handling /kore/tasks/:taskId', 4);
            await this._handleTaskDetails(req, res);
            return true;
        }

        if (urlPath === '/kore/plugin-tasks/admin') {
            global.consoleLog('Plugins', 'Handling /kore/plugin-tasks/admin', 4);
            await this.handleListPluginTasksAdmin(req, res);
            return true;
        }

        global.consoleLog('Plugins', `No route match for: ${urlPath}`, 4);
        return false;
    }

    /**
     * Internal: Handle POST /executeTask
     * Loads task from plugin_tasks and routes to the appropriate plugin handler
     */
    async _handleExecuteTask(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { task_id } = data;
                let { inputs } = data;

                if (!task_id) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'task_id is required' }));
                    return;
                }

                global.consoleLog('Plugins', `/executeTask - Loading task ${task_id}`, 4);

                // Load task from database
                if (!this.pool) {
                    throw new Error('Database pool not available');
                }

                const connection = await this.pool.getConnection();
                let task;
                let pluginId;
                try {
                    const [rows] = await connection.query(
                        'SELECT * FROM plugin_tasks WHERE task_id = ? AND active = TRUE',
                        [task_id]
                    );

                    if (rows.length === 0) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: 'Task not found' }));
                        return;
                    }

                    task = rows[0];
                    pluginId = task.plugin_id;

                    // Real user-initiated calls only (isInternalCall calls -
                    // e.g. a workflow invoking a task server-side - bypass
                    // user-session auth entirely upstream in handleRoute and
                    // never get a req.userId, so there's no user to check
                    // permission against; they're already implicitly
                    // trusted the same way handleRoute treats them).
                    const isInternalCall = req.socket && req.socket.remoteAddress === 'internal';
                    if (!isInternalCall) {
                        const taskScope = `${task.plugin_name}:${task.task_id}`;
                        const canExecute = await global.auth.hasPermission(req.userId, 'plugin_task', 'execute', taskScope);
                        if (!canExecute) {
                            res.writeHead(403);
                            res.end(JSON.stringify({ error: 'Forbidden' }));
                            return;
                        }
                    }

                    // Parse static_params - handle both JSON string and object
                    try {
                        if (typeof task.static_params === 'string') {
                            task.static_params = task.static_params ? JSON.parse(task.static_params) : {};
                        } else if (typeof task.static_params === 'object' && task.static_params !== null) {
                            // Already an object, use as-is
                            task.static_params = task.static_params;
                        } else {
                            // Null, undefined, or other type
                            task.static_params = {};
                        }
                    } catch (parseError) {
                        global.consoleLog('Plugins', `WARNING: Could not parse static_params for task ${task_id}: ${parseError.message}`, 2);
                        task.static_params = {};
                    }

                    // Parse inputs - handle both JSON string and array
                    try {
                        if (typeof task.inputs === 'string') {
                            task.inputs = task.inputs ? JSON.parse(task.inputs) : [];
                        } else if (Array.isArray(task.inputs)) {
                            // Already an array, use as-is
                            task.inputs = task.inputs;
                        } else if (typeof task.inputs === 'object' && task.inputs !== null) {
                            // Object but not array, treat as empty
                            task.inputs = [];
                        } else {
                            // Null, undefined, or other type
                            task.inputs = [];
                        }
                    } catch (parseError) {
                        global.consoleLog('Plugins', `WARNING: Could not parse inputs for task ${task_id}: ${parseError.message}`, 2);
                        task.inputs = [];
                    }

                    // Get the plugin name from the plugin_id
                    const [pluginRows] = await connection.query(
                        'SELECT name FROM plugins WHERE id = ?',
                        [pluginId]
                    );

                    if (pluginRows.length === 0) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: 'Plugin not found' }));
                        return;
                    }

                    task.pluginName = pluginRows[0].name;
                } finally {
                    connection.release();
                }

                global.consoleLog('Plugins', `Task loaded: ${task.display_name}, plugin: ${task.pluginName}, route: ${task.route}`, 4);

                // Check for passthrough mode - delegate to subTask instead
                if (task.static_params.subTaskMode === 'passthrough' && task.static_params.subTask) {
                    let subTaskId = task.static_params.subTask;
                    // Resolve @task.* reference if present
                    if (typeof subTaskId === 'string' && subTaskId.startsWith('@task.')) {
                        subTaskId = subTaskId.substring(6); // Remove '@task.' prefix
                    }
                    global.consoleLog('Plugins', `Task ${task_id} using passthrough mode, delegating to task ${subTaskId}`, 4);
                    
                    // Merge relevant config parameters (datasource, etc.) with inputs
                    const delegateInputs = {
                        ...task.static_params,
                        ...inputs
                    };
                    // Remove internal parameters that shouldn't be passed down
                    delete delegateInputs.subTask;
                    delete delegateInputs.subTaskMode;
                    
                    const result = await this.executeTask(subTaskId, delegateInputs);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }

                // Check for enrichBefore mode - see the matching block in executeTask()
                // for the full design note (future enrichAfter/handoff modes included).
                // Mirrored here since this HTTP entry point builds mergedInputs/
                // processedInputs independently rather than delegating to executeTask().
                if (task.static_params.subTaskMode === 'enrichBefore' && task.static_params.subTask) {
                    let subTaskId = task.static_params.subTask;
                    if (typeof subTaskId === 'string' && subTaskId.startsWith('@task.')) {
                        subTaskId = subTaskId.substring(6);
                    }
                    const resultKey = task.static_params.subTaskResultKey || 'subtask_result';
                    global.consoleLog('Plugins', `Task ${task_id} enrichBefore with subtask ${subTaskId} -> ${resultKey}`, 4);
                    try {
                        const enrichResult = await this.executeTask(subTaskId, task.static_params.subTaskInputs || {});
                        inputs = { ...inputs, [resultKey]: enrichResult.result };
                    } catch (error) {
                        global.consoleLog('Plugins', `enrichBefore subtask ${subTaskId} failed: ${error.message}`, 2);
                        inputs = { ...inputs, [resultKey]: null };
                    }
                }

                // Find the plugin object
                const plugin = this.getPlugin(task.pluginName);
                if (!plugin) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: `Plugin not loaded: ${task.pluginName}` }));
                    return;
                }
                
                // Get the plugin handler for the task's route
                const handler = this.getHandler(task.route);
                if (!handler) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: `No handler found for route: ${task.route}` }));
                    return;
                }

                // Merge static_params with user inputs, ensuring endpoint is included
                const mergedInputs = { 
                    endpoint: task.endpoint,
                    ...task.static_params, 
                    ...inputs 
                };
                global.consoleLog('Plugins', `Merged inputs: ${JSON.stringify(mergedInputs)}`, 4);
                
                // Process variables (e.g., $(now - 365)) in merged inputs
                const processedInputs = this.processVariables(mergedInputs, task.inputs);
                global.consoleLog('Plugins', `Processed inputs (variables resolved): ${JSON.stringify(processedInputs)}`, 4);
                global.consoleLog('Plugins', `Routing to handler: ${task.route}`, 4);

                // Create a mock request object with processed inputs
                const mockReq = {
                    method: task.method || 'GET',
                    url: task.route,
                    headers: req.headers,
                    socket: req.socket,
                    // Carry the authenticated identity through to the plugin
                    // handler. handleRoute() sets req.userId from the validated
                    // session token, and the permission check above uses it -
                    // but without this line it stopped here, so anything a
                    // plugin does downstream (notably sqlquery executing SQL)
                    // had no attributable caller. The socket IS forwarded, so
                    // such calls correctly looked external; they just had no
                    // user attached. Internal callers have no req.userId to
                    // begin with, so this is undefined for them, which is the
                    // same as before.
                    userId: req.userId,
                    body: JSON.stringify(processedInputs),
                    on: function(event, callback) {
                        if (event === 'data') {
                            // Already have the body, so just call callback with it
                            callback(Buffer.from(this.body));
                        } else if (event === 'end') {
                            // Immediately call end callback
                            callback();
                        }
                    }
                };

                // Call the plugin handler
                const { plugin: pluginObj, handler: handlerFunc } = handler;
                
                // Wrap res.end() to normalize response format and apply label_field formatting
                const originalEnd = res.end.bind(res);
                
                res.end = function(data) {
                    if (data) {
                        try {
                            const parsed = JSON.parse(data);
                            const responseStatusCode = this.statusCode || 200;
                            const isSuccess = responseStatusCode >= 200 && responseStatusCode < 300;
                            
                            // Extract the actual data from various possible formats
                            let result = parsed.options || parsed.data || parsed.result || parsed;
                            
                            // Extract error message from handler response if it exists
                            let message = parsed.message;
                            if (!message && !isSuccess) {
                                // Try to get error message from various error response formats
                                message = parsed.error || parsed.error_message || parsed.errorMessage || 'Operation failed';
                            }
                            
                            // If result is an array of objects, apply label_field formatting or default
                            if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
                                result = result.map(item => {
                                    let label;
                                    
                                    if (task.label_field) {
                                        // Apply configured label_field formatting
                                        label = task.label_field;
                                        if (label.includes('@')) {
                                            // Replace @fieldName@ patterns with actual values
                                            label = label.replace(/@([a-zA-Z_][a-zA-Z0-9_]*(?:\/[a-zA-Z_][a-zA-Z0-9_]*)*)?@/g, (match, fieldPath) => {
                                                // Navigate nested fields like "model/name"
                                                let value = item;
                                                if (fieldPath) {
                                                    const parts = fieldPath.split('/');
                                                    for (const part of parts) {
                                                        value = value && value[part];
                                                    }
                                                }
                                                return value !== undefined ? String(value) : match;
                                            });
                                        } else {
                                            // Simple field name
                                            label = item[task.label_field];
                                        }
                                    } else {
                                        // Default: use 'name' field if available
                                        label = item.name || item.id || item.value || '';
                                    }
                                    
                                    // Return item with _label property
                                    return {
                                        ...item,
                                        _label: String(label)
                                    };
                                });
                            }
                            
                            // Build standardized response
                            const normalizedResponse = {
                                success: isSuccess,
                                result: result,
                                message: message || (isSuccess ? 'Operation completed successfully' : 'Operation failed')
                            };
                            
                            data = JSON.stringify(normalizedResponse);
                        } catch (e) {
                            // If parsing fails, wrap in standard format
                            global.consoleLog('Plugins', `Could not parse response: ${e.message}`, 2);
                            const errorResponse = {
                                success: false,
                                result: null,
                                message: 'Invalid response format from plugin'
                            };
                            data = JSON.stringify(errorResponse);
                        }
                    }
                    
                    return originalEnd(data);
                };
                
                await handlerFunc(mockReq, res, {
                    isIPWhitelisted: this.isIPWhitelisted,
                    checkRateLimit: this.checkRateLimit,
                    config: pluginObj.config,
                    secureConfig: pluginObj.secureConfig || {},
                    updateSecureConfig: (partialObject) => this.updateSecureConfig(pluginObj.name, partialObject),
                    taskInputs: task.inputs,
                    processVariables: this.processVariables.bind(this)
                });

            } catch (error) {
                global.consoleLog('Plugins', `ERROR in /executeTask: ${error.message}`, 1);
                if (!res.headersSent) {
                    res.writeHead(500);
                    res.end(JSON.stringify({
                        success: false,
                        result: null,
                        message: error.message
                    }));
                }
            }
        });
    }

    /**
     * Internal: Handle GET /kore/plugins/list
     */
    /**
     * Internal: Handle GET /kore/plugins/:name/tasks or POST save task
     */
    async _handlePluginTasks(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            const match = req.url.match(/^\/kore\/plugins\/([^/]+)\/tasks/);
            if (!match) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid plugin name' }));
                return;
            }

            const pluginName = decodeURIComponent(match[1]);
            global.consoleLog('Plugins', `_handlePluginTasks for plugin: ${pluginName}`, 4);
            
            const plugin = this.getPlugin(pluginName);
            if (!plugin) {
                global.consoleLog('Plugins', `Plugin not found: ${pluginName}`, 2);
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Plugin not found' }));
                return;
            }

            if (req.method === 'GET') {
                await this._getTasks(res, plugin.id, plugin, req.userId);
            } else if (req.method === 'POST') {
                await this._saveTasks(req, res, plugin.id, plugin.name, req.userId);
            } else {
                res.writeHead(405);
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
        } catch (error) {
            global.consoleLog('Plugins', `ERROR handling plugin tasks: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to handle plugin tasks' }));
        }
    }

    /**
     * Internal: GET tasks for a plugin
     * Resolves dynamic options (@config.* and @task.* references) in task inputs
     */
    async _getTasks(res, pluginId, plugin = {}, userId) {
        try {
            if (!this.pool) {
                throw new Error('Database pool not available');
            }

            const connection = await this.pool.getConnection();
            try {
                global.consoleLog('Plugins', `Querying tasks for plugin ID: ${pluginId}`, 4);
                const [rows] = await connection.query(
                    'SELECT * FROM plugin_tasks WHERE plugin_id = ? AND active = TRUE ORDER BY display_name',
                    [pluginId]
                );

                global.consoleLog('Plugins', `Found ${rows.length} tasks for plugin ID ${pluginId}`, 4);

                // Filter to tasks the user has admin 'view' on, and annotate
                // each with a separate 'execute' flag - the Task Test page's
                // own dropdown-rendering code is what actually restricts
                // itself to canExecute:true tasks; the real security gate is
                // the hard check in _handleExecuteTask, not this filtering.
                const tasks = [];
                for (const task of rows) {
                    const scope = `${plugin.name}:${task.task_id}`;
                    const canView = await global.auth.hasPermission(userId, 'plugin_task', 'view', scope);
                    if (!canView) continue;

                    const canExecute = await global.auth.hasPermission(userId, 'plugin_task', 'execute', scope);
                    tasks.push({
                        ...task,
                        static_params: typeof task.static_params === 'string' ? JSON.parse(task.static_params) : task.static_params,
                        inputs: typeof task.inputs === 'string' ? JSON.parse(task.inputs) : task.inputs,
                        outputs: typeof task.outputs === 'string' ? JSON.parse(task.outputs) : task.outputs,
                        canExecute
                    });
                }

                res.writeHead(200);
                res.end(JSON.stringify({ tasks }));
            } finally {
                connection.release();
            }
        } catch (error) {
            global.consoleLog('Plugins', `ERROR in _getTasks: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    /**
     * Internal: GET specific task details with resolved options
     */
    async _handleTaskDetails(req, res) {
        try {
            const userId = await this._authenticateRequest(req, res);
            if (!userId) return;

            const urlPath = req.url.split('?')[0];
            const taskId = parseInt(urlPath.match(/\/(\d+)$/)[1]);

            // Optional ?values=<url-encoded JSON> -- currently-typed sibling field values
            // from the calling task's own form, forwarded so a select input's
            // optionTaskInputs {fieldName} templates can resolve against them (e.g. a
            // Team picker whose source task needs the customerTenantId already typed
            // into this same form, not just static config). Absent on the normal
            // initial-load case, where no sibling values exist yet.
            let taskInputValues = {};
            const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
            if (queryString) {
                const params = new URLSearchParams(queryString);
                const valuesParam = params.get('values');
                if (valuesParam) {
                    try {
                        taskInputValues = JSON.parse(valuesParam);
                    } catch (e) {
                        global.consoleLog('Plugins', `WARNING: Could not parse values query param for task ${taskId}: ${e.message}`, 2);
                    }
                }
            }
            
            if (!this.pool) {
                throw new Error('Database pool not available');
            }

            const connection = await this.pool.getConnection();
            try {
                const [rows] = await connection.query(
                    'SELECT * FROM plugin_tasks WHERE task_id = ? AND active = TRUE',
                    [taskId]
                );

                if (rows.length === 0) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Task not found' }));
                    return;
                }

                const taskScope = `${rows[0].plugin_name}:${rows[0].task_id}`;
                const canView = await global.auth.hasPermission(userId, 'plugin_task', 'view', taskScope);
                const canExecute = await global.auth.hasPermission(userId, 'plugin_task', 'execute', taskScope);
                if (!canView && !canExecute) {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'Forbidden' }));
                    return;
                }

                const task = {
                    ...rows[0],
                    static_params: typeof rows[0].static_params === 'string' ? JSON.parse(rows[0].static_params) : rows[0].static_params,
                    inputs: typeof rows[0].inputs === 'string' ? JSON.parse(rows[0].inputs) : rows[0].inputs,
                    outputs: typeof rows[0].outputs === 'string' ? JSON.parse(rows[0].outputs) : rows[0].outputs
                };

                // Get plugin for config access
                const [pluginRows] = await connection.query(
                    'SELECT id, name, config FROM plugins WHERE id = ?',
                    [task.plugin_id]
                );
                
                const plugin = pluginRows.length > 0 ? pluginRows[0] : {};
                const pluginConfig = plugin.config ? (typeof plugin.config === 'string' ? JSON.parse(plugin.config) : plugin.config) : {};

                // Resolve dynamic options in inputs
                if (Array.isArray(task.inputs)) {
                    try {
                        const resolvedOptions = await this.getResolvedTaskInputOptions(task, { ...plugin, config: pluginConfig }, taskInputValues);
                        
                        // Apply resolved options back to inputs
                        task.inputs = task.inputs.map(input => {
                            if (resolvedOptions[input.name] && input.type === 'select') {
                                return {
                                    ...input,
                                    options: resolvedOptions[input.name]
                                };
                            }
                            return input;
                        });
                    } catch (resolveError) {
                        global.consoleLog('Plugins', `WARNING: Error resolving options for task ${taskId}: ${resolveError.message}`, 2);
                        // Continue with unresolved options on error
                    }
                }

                res.writeHead(200);
                res.end(JSON.stringify({ task }));
            } finally {
                connection.release();
            }
        } catch (error) {
            global.consoleLog('Plugins', `ERROR in _handleTaskDetails: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    /**
     * Internal: POST save task
     */
    async _saveTasks(req, res, pluginId, pluginName, userId) {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const taskData = JSON.parse(body);

                if (!taskData.task_id) {
                    const canCreate = await global.auth.hasPermission(userId, 'plugin_task', 'create');
                    if (!canCreate) {
                        res.writeHead(403);
                        res.end(JSON.stringify({ error: 'Forbidden' }));
                        return;
                    }
                } else {
                    const canEdit = await global.auth.hasPermission(userId, 'plugin_task', 'edit', `${pluginName}:${taskData.task_id}`);
                    if (!canEdit) {
                        res.writeHead(403);
                        res.end(JSON.stringify({ error: 'Forbidden' }));
                        return;
                    }
                }

                const connection = await this.pool.getConnection();

                try {
                    if (!taskData.task_id) {
                        // INSERT new task
                        // updated_at set via NOW() directly in SQL, not a
                        // bound param from the client payload - deliberately
                        // server-guaranteed on every save, unlike
                        // plugins.updated_at (handleUpdatePlugin), which only
                        // gets set if the caller happens to include it in
                        // their own payload. Confirmed the one real caller
                        // (plugins-front.js) does include it, but that's a
                        // fragile guarantee to depend on for something the
                        // doc staleness dashboard treats as reliable - see
                        // Bugs.md. Not repeating that pattern here.
                        const [result] = await connection.query(
                            'INSERT INTO plugin_tasks (plugin_id, plugin_name, display_name, description, static_params, inputs, outputs, label_field, value_field, endpoint, route, method, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, NOW())',
                            [
                                pluginId,
                                taskData.plugin_name,
                                taskData.display_name,
                                taskData.description || '',
                                JSON.stringify(taskData.static_params || {}),
                                JSON.stringify(taskData.inputs || []),
                                JSON.stringify(taskData.outputs || []),
                                taskData.label_field || '',
                                taskData.value_field || '',
                                taskData.endpoint || '',
                                taskData.route || '',
                                taskData.method || 'NA'
                            ]
                        );
                        res.writeHead(200);
                        res.end(JSON.stringify({ success: true, task_id: result.insertId }));
                    } else {
                        // UPDATE existing task - same server-guaranteed updated_at
                        await connection.query(
                            'UPDATE plugin_tasks SET plugin_name = ?, display_name = ?, description = ?, static_params = ?, inputs = ?, outputs = ?, label_field = ?, value_field = ?, endpoint = ?, route = ?, method = ?, updated_at = NOW() WHERE task_id = ?',
                            [
                                taskData.plugin_name,
                                taskData.display_name,
                                taskData.description || '',
                                JSON.stringify(taskData.static_params || {}),
                                JSON.stringify(taskData.inputs || []),
                                JSON.stringify(taskData.outputs || []),
                                taskData.label_field || '',
                                taskData.value_field || '',
                                taskData.endpoint || '',
                                taskData.route || '',
                                taskData.method || 'NA',
                                taskData.task_id
                            ]
                        );
                        res.writeHead(200);
                        res.end(JSON.stringify({ success: true, task_id: taskData.task_id }));
                    }
                } finally {
                    connection.release();
                }
            } catch (error) {
                global.consoleLog('Plugins', `ERROR saving task: ${error.message}`, 1);
                res.writeHead(400);
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }

    /**
     * Internal: Handle POST /plugins/execute
     */
    async _handleExecute(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }
        
        try {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const { task_id, inputs } = data;
                    
                    if (!task_id) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'task_id is required' }));
                        return;
                    }
                    
                    global.consoleLog('Plugins', `Plugin execute request - Task ID: ${task_id}`, 4);
                    
                    const result = await this.executeTask(task_id, inputs || {});
                    
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                } catch (parseError) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
        } catch (error) {
            global.consoleLog('Plugins', `ERROR in plugin execute: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({ 
                error: 'Plugin execute error',
                message: error.message
            }));
        }
    }

    /**
     * Merge partialObject into a plugin's decrypted secure_config, re-encrypt, persist to DB,
     * and update the in-memory copy so subsequent calls in this process see the change immediately.
     * Called from handler code via helpers.updateSecureConfig(partialObject), and available for
     * an admin-facing endpoint to call directly as this.updateSecureConfig(pluginName, partialObject).
     */
    async updateSecureConfig(pluginName, partialObject) {
        try {
            if (!this.pool) {
                throw new Error('Pool not available');
            }
            if (!global.cryptoUtils) {
                throw new Error('cryptoUtils not available on global');
            }

            const plugin = this.loadedPlugins[pluginName];
            if (!plugin) {
                throw new Error(`Plugin ${pluginName} not loaded`);
            }

            const mergedSecureConfig = { ...(plugin.secureConfig || {}), ...(partialObject || {}) };
            const encrypted = global.cryptoUtils.encryptJson(mergedSecureConfig);

            await this.pool.execute('UPDATE `plugins` SET secure_config = ? WHERE name = ?', [encrypted, pluginName]);

            // Update in-memory copy so subsequent calls in this process see the change without a reload
            plugin.secureConfig = mergedSecureConfig;

            global.consoleLog('Plugins', `secure_config updated for plugin ${pluginName} (keys: ${Object.keys(partialObject || {}).join(', ')})`, 4);

            return { success: true };
        } catch (error) {
            global.consoleLog('Plugins', `ERROR updating secure_config for plugin ${pluginName}: ${error.message}`, 1);
            throw error;
        }
    }

    /**
     * Internal: Load a plugin object from database row
     */
    _loadPluginObject(pluginRow) {
        // Create a plugin object with utilities it can use
        const pluginObj = { exports: {} };
        const pluginCode = pluginRow.code;
        
        try {
            const pluginFunction = new Function('module', 'exports', 'require', 'console', 'global', pluginCode);
            pluginFunction(
                pluginObj,
                pluginObj.exports,
                require,
                console,
                global
            );
        } catch (execError) {
            throw new Error(`Failed to execute plugin code: ${execError.message}`);
        }
        
        const pluginExports = pluginObj.exports;
        
        // Parse config
        let pluginConfig = {};
        if (pluginRow.config) {
            try {
                pluginConfig = typeof pluginRow.config === 'string' ? JSON.parse(pluginRow.config) : pluginRow.config;
            } catch (e) {
                global.consoleLog('Plugins', `WARNING: Could not parse config for plugin ${pluginRow.name}`, 2);
            }
        }
        
        // Get routes from config (migrated from separate column)
        let routes = [];
        if (pluginConfig.routes) {
            routes = Array.isArray(pluginConfig.routes) ? pluginConfig.routes : [];
        } else if (pluginConfig.configRoutes) {
            // Support legacy configRoutes format
            routes = Array.isArray(pluginConfig.configRoutes) ? pluginConfig.configRoutes : [];
        }
        
        // Decrypt secure_config (opt-in, encrypted credential storage - separate from plain config)
        let pluginSecureConfig = {};
        if (pluginRow.secure_config) {
            try {
                pluginSecureConfig = global.cryptoUtils.decryptJson(pluginRow.secure_config);
            } catch (e) {
                global.consoleLog('Plugins', `WARNING: Could not decrypt secure_config for plugin ${pluginRow.name}: ${e.message}`, 2);
            }
        }
        
        // Store loaded plugin
        this.loadedPlugins[pluginRow.name] = {
            id: pluginRow.id,
            name: pluginRow.name,
            display_name: pluginRow.display_name,
            routes: routes,
            handlers: pluginExports.handlers || {},
            config: pluginConfig,
            secureConfig: pluginSecureConfig,
            rateLimit: pluginConfig.rateLimit || pluginConfig.configRateLimit || 100,
            exported: pluginExports
        };
    }

    /**
     * Internal: Initialize operation managers for all loaded plugins
     */
    _initializeOperationManagers() {
        for (const pluginName in this.loadedPlugins) {
            if (!this.operationManagers[pluginName]) {
                this.operationManagers[pluginName] = new PluginOperationManager(this.getTimestamp, pluginName, this);
            }
        }
    }
}

/**
 * Manages parallel operations with safe reload queueing
 */
class PluginOperationManager {
    constructor(getTimestamp, pluginName, pluginsModule) {
        this.getTimestamp = getTimestamp;
        this.pluginName = pluginName;
        this.pluginsModule = pluginsModule;
        this.activeOperations = new Set();
        this.reloadQueued = null;
        this.isReloading = false;
    }

    // Start a normal operation (parallel, no blocking)
    startOperation(opId) {
        this.activeOperations.add(opId);
        global.consoleLog('Plugins', `[${this.pluginName}] Operation ${opId} started. Active: ${this.activeOperations.size}`, 4);
    }

    // End a normal operation
    async endOperation(opId) {
        this.activeOperations.delete(opId);
        global.consoleLog('Plugins', `[${this.pluginName}] Operation ${opId} ended. Active: ${this.activeOperations.size}`, 4);
        
        // If there's a reload queued AND no more operations, do the reload
        if (this.reloadQueued && this.activeOperations.size === 0) {
            await this.processQueuedReload();
        }
    }

    // Queue a reload (or force immediate)
    async enqueueReload(force = false) {
        const reloadId = `reload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        if (force && this.activeOperations.size > 0) {
            global.consoleLog('Plugins', `[${this.pluginName}] Force reload queued. Waiting for ${this.activeOperations.size} operations to finish...`, 4);
        }

        this.reloadQueued = {
            id: reloadId,
            force: force,
            queuedAt: Date.now()
        };

        // If no operations active, start reload immediately
        if (this.activeOperations.size === 0) {
            await this.processQueuedReload();
        }

        return reloadId;
    }

    // Process the queued reload
    async processQueuedReload() {
        if (!this.reloadQueued || this.isReloading) return;

        const reload = this.reloadQueued;
        this.isReloading = true;

        try {
            global.consoleLog('Plugins', `[${this.pluginName}] Starting reload (${reload.force ? 'force' : 'normal'})...`, 3);
            await this.pluginsModule.reloadPlugin(this.pluginName);
            global.consoleLog('Plugins', `[${this.pluginName}] Reload complete`, 3);
        } catch (error) {
            global.consoleLog('Plugins', `[${this.pluginName}] Reload failed: ${JSON.stringify(error)}`, 1);
        } finally {
            this.isReloading = false;
            this.reloadQueued = null;
        }
    }

    getStatus() {
        return {
            activeOperations: this.activeOperations.size,
            operationIds: Array.from(this.activeOperations),
            reloadQueued: this.reloadQueued ? {
                id: this.reloadQueued.id,
                force: this.reloadQueued.force,
                waitingFor: this.activeOperations.size,
                queuedAt: this.reloadQueued.queuedAt
            } : null,
            isReloading: this.isReloading
        };
    }
}

// Export as singleton
module.exports = new KorePlugins();