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
                const [rows] = await connection.query('SELECT id, name, display_name, code, rate_limit, config FROM `plugins` WHERE enabled = true ORDER BY display_name');
                
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
                const [rows] = await connection.query('SELECT id, name, display_name, code, rate_limit, config FROM `plugins` WHERE name = ? AND enabled = true', [pluginName]);
                
                if (rows.length === 0) {
                    throw new Error(`Plugin ${pluginName} not found or not enabled`);
                }
                
                this._loadPluginObject(rows[0]);
                
                return {
                    success: true,
                    plugin: {
                        name: pluginName,
                        routes: this.loadedPlugins[pluginName]?.routes || [],
                        rateLimit: rows[0].rate_limit
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
                const processedInputs = this.processVariables(mergedInputs);

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
    processVariables(obj) {
        const variablePattern = /\$\(([^)]+)\)/g;
        const result = JSON.parse(JSON.stringify(obj)); // Deep copy
        
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
            const processedInputs = this.processVariables(mergedInputs);
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
                              urlPath.startsWith('/kore/plugins/details') ||
                              urlPath.match(/^\/kore\/plugins\/[^/]+\/tasks$/) ||
                              this.getHandler(urlPath);
        
        // Session token validation - only for actual plugin routes
        if (isPluginRoute) {
            const isInternalCall = req.socket && req.socket.remoteAddress === 'internal';
            const sessionToken = req.headers['x-session-token'];
            
            if (!isInternalCall && !sessionToken) {
                global.consoleLog('Plugins', `Rejecting ${urlPath}: external call without session token`, 2);
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'Session token required' }));
                return true;
            }

            if (!isInternalCall) {
                global.consoleLog('Plugins', 'External call authenticated (token present)', 4);
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

        // Management endpoints
        if (urlPath === '/kore/plugins/list') {
            global.consoleLog('Plugins', 'Handling /kore/plugins/list', 4);
            await this._handleListPlugins(req, res);
            return true;
        }

        if (urlPath.startsWith('/kore/plugins/details')) {
            global.consoleLog('Plugins', 'Handling /kore/plugins/details', 4);
            await this._handlePluginDetails(req, res);
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
                const { task_id, inputs } = data;

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
                const processedInputs = this.processVariables(mergedInputs);
                global.consoleLog('Plugins', `Processed inputs (variables resolved): ${JSON.stringify(processedInputs)}`, 4);
                global.consoleLog('Plugins', `Routing to handler: ${task.route}`, 4);

                // Create a mock request object with processed inputs
                const mockReq = {
                    method: task.method || 'GET',
                    url: task.route,
                    headers: req.headers,
                    socket: req.socket,
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
    async _handleListPlugins(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            const plugins = this.listPlugins();
            res.writeHead(200);
            res.end(JSON.stringify({ plugins }));
        } catch (error) {
            global.consoleLog('Plugins', `ERROR listing plugins: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to list plugins' }));
        }
    }

    /**
     * Internal: Handle GET /kore/plugins/details?name=pluginName
     */
    async _handlePluginDetails(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            const urlParams = new URL(req.url, 'http://localhost').searchParams;
            const pluginName = urlParams.get('name');

            if (!pluginName) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'name parameter required' }));
                return;
            }

            const plugin = this.getPlugin(pluginName);
            if (!plugin) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Plugin not found' }));
                return;
            }

            res.writeHead(200);
            res.end(JSON.stringify({ plugin }));
        } catch (error) {
            global.consoleLog('Plugins', `ERROR getting plugin details: ${error.message}`, 1);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to get plugin details' }));
        }
    }

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
                await this._getTasks(res, plugin.id, plugin);
            } else if (req.method === 'POST') {
                await this._saveTasks(req, res, plugin.id);
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
    async _getTasks(res, pluginId, plugin = {}) {
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

                const tasks = rows.map(task => ({
                    ...task,
                    static_params: typeof task.static_params === 'string' ? JSON.parse(task.static_params) : task.static_params,
                    inputs: typeof task.inputs === 'string' ? JSON.parse(task.inputs) : task.inputs,
                    outputs: typeof task.outputs === 'string' ? JSON.parse(task.outputs) : task.outputs
                }));

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
            const urlPath = req.url.split('?')[0];
            const taskId = parseInt(urlPath.match(/\/(\d+)$/)[1]);
            
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
                        const resolvedOptions = await this.getResolvedTaskInputOptions(task, { ...plugin, config: pluginConfig });
                        
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
    async _saveTasks(req, res, pluginId) {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const taskData = JSON.parse(body);
                const connection = await this.pool.getConnection();

                try {
                    if (!taskData.task_id) {
                        // INSERT new task
                        const [result] = await connection.query(
                            'INSERT INTO plugin_tasks (plugin_id, plugin_name, display_name, description, static_params, inputs, outputs, label_field, value_field, endpoint, route, method, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)',
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
                        // UPDATE existing task
                        await connection.query(
                            'UPDATE plugin_tasks SET plugin_name = ?, display_name = ?, description = ?, static_params = ?, inputs = ?, outputs = ?, label_field = ?, value_field = ?, endpoint = ?, route = ?, method = ? WHERE task_id = ?',
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
        
        // Store loaded plugin
        this.loadedPlugins[pluginRow.name] = {
            id: pluginRow.id,
            name: pluginRow.name,
            display_name: pluginRow.display_name,
            routes: routes,
            handlers: pluginExports.handlers || {},
            config: pluginConfig,
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