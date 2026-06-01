/**
 * Persephone - Automation Engine for Kore
 * 
 * Core workflow execution engine with Nunjucks templating
 * Integrates with Kore's MySQL database and authentication
 * 
 * API Endpoints:
 *   POST   /kore/workflows               - Create new workflow
 *   GET    /kore/workflows/:id           - Get latest active workflow version
 *   GET    /kore/workflows/:id/:version  - Get specific workflow version
 *   DELETE /kore/workflows/:id/:version  - Archive workflow version
 *   
 *   POST   /kore/execute                 - Execute workflow
 *   GET    /kore/executions/:executionId - Get execution status/results
 *   POST   /kore/executions/:executionId/cancel - Cancel running execution
 *   
 *   GET    /kore/executions              - List executions (with filters)
 * 
 * @version 0.500 - [KORE_VERSION_INCREMENT_ON_UPDATE]
 */

const fs = require('fs');
const path = require('path');
const url = require('url');
const nunjucks = require('nunjucks');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');
const registerFilters = require('./filters');
const transformFilters = require('./filters/transform');

/**
 * Get current timestamp formatted in configured timezone
 */
function getTimestamp() {
    const tz = global.timezone || 'UTC';
    return new Date().toLocaleString('en-US', { 
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/(\d+)\/(\d+)\/(\d+),\s(\d+):(\d+):(\d+)/, '$3-$1-$2T$4:$5:$6');
}

// ===== PERSEPHONE ENGINE =====
const Persephone = (() => {
    let pools = {
        kore: null,
        rewst: null,
        cwa: null
    };

    // Route registry for dynamic route handling
    const routes = [];

    /**
     * Register an endpoint with the route registry
     */
    function registerRoute(pattern, handler) {
        routes.push({ pattern, handler });
    }

    /**
     * Check if a URL matches any registered route and handle it
     */
    function handleRegisteredRoute(req, res) {
        console.log(`[Persephone] Checking route for: ${req.url}`);
        for (const route of routes) {
            if (typeof route.pattern === 'string') {
                // Exact match or startsWith for query params
                if (req.url === route.pattern || req.url.startsWith(route.pattern + '?')) {
                    console.log(`[Persephone] Matched string route: ${route.pattern}`);
                    return route.handler(req, res);
                }
            } else if (route.pattern instanceof RegExp) {
                // Regex match
                if (route.pattern.test(req.url)) {
                    console.log(`[Persephone] Matched regex route: ${route.pattern}`);
                    return route.handler(req, res);
                }
            }
        }
        console.log(`[Persephone] No route matched for: ${req.url}`);
        return false; // No route matched
    }

    /**
     * Initialize Persephone with MySQL pools for all three databases
     */
    async function initialize(korePool, rewstPool, cwaPool) {
        pools.kore_sys = korePool;
        pools.rewst = rewstPool;
        pools.cwa = cwaPool;
        const env = nunjucks.configure({ 
            autoescape: false,
            throwOnUndefined: true  // Throw on undefined, none/true/false are defined values
        });
        
        // Register custom filters
        try {
            const filterStatus = registerFilters(env);
            if (filterStatus.failed.length > 0) {
                console.warn(`[Persephone] Failed to register ${filterStatus.failed.length} filters:`, filterStatus.failed);
            }
        } catch (error) {
            console.error(`[Persephone] Error registering filters: ${error.message}`);
        }
        
        // Register transform filters (type conversion and transformation)
        try {
            Object.entries(transformFilters).forEach(([name, fn]) => {
                env.addFilter(name, fn);
            });
        } catch (error) {
            console.error(`[Persephone] Error registering transform filters: ${error.message}`);
        }
        
        // Register Persephone API routes
        // workflow-folders must come BEFORE workflows since it's more specific
        registerRoute(/^\/kore\/workflow-folders(\/.*)?(\?.*)?$/, handleWorkflowFoldersRequest);
        registerRoute(/^\/kore\/workflows(\/.*)?(\?.*)?$/, handleWorkflowRequest);
        registerRoute('/kore/execute', handleExecuteRequest);
        registerRoute('/kore/executions', handleExecutionRequest);
        registerRoute(/^\/kore\/filters(\/.*)?(\?.*)?$/, handleFilterRequest);
        registerRoute('/kore/render-template', handleRenderTemplate);
    }

    /**
     * Validate workflow JSON structure and Nunjucks templates
     */
    async function validateWorkflow(definition) {
        const errors = [];

        // Validate critical top-level fields
        if (!definition.id) {
            errors.push('Workflow must have an id');
        }
        if (!definition.name) {
            errors.push('Workflow must have a name');
        }
        if (!definition.version) {
            errors.push('Workflow must have a version');
        }

        // Basic structure validation
        if (!definition.steps || !Array.isArray(definition.steps)) {
            errors.push('Workflow must have a steps array');
        }

        // Validate metadata exists and is an object (but not its sub-elements)
        if (!definition.metadata || typeof definition.metadata !== 'object') {
            errors.push('Workflow must have a metadata object');
        }

        // Validate each step
        if (Array.isArray(definition.steps)) {
            for (let i = 0; i < definition.steps.length; i++) {
                const step = definition.steps[i];
                if (!step.id) errors.push(`Step ${i} missing id`);
                if (!step.type) errors.push(`Step ${i} missing type`);

                // Validate Nunjucks templates in step
                if (step.command && typeof step.command === 'string') {
                    try {
                        nunjucks.renderString(step.command, {});
                    } catch (err) {
                        errors.push(`Step ${step.id} command template error: ${err.message}`);
                    }
                }
                if (step.query && typeof step.query === 'string') {
                    try {
                        nunjucks.renderString(step.query, {});
                    } catch (err) {
                        errors.push(`Step ${step.id} query template error: ${err.message}`);
                    }
                }
            }
        }

        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }

    /**
     * Create or update a workflow definition
     */
    async function createWorkflow(workflowData) {
        const { id, name, version, definition, folder_id, createdBy } = workflowData;

        if (!id || !name || !version || !definition) {
            throw new Error('id, name, version, and definition are required');
        }

        // Validate workflow structure
        const validation = await validateWorkflow(definition);
        if (!validation.isValid) {
            throw new Error(`Workflow validation failed: ${validation.errors.join(', ')}`);
        }

        // Add/update metadata, preserve everything else in definition as-is
        const now = global.getTimestamp();
        const definitionToStore = {
            ...definition,
            metadata: {
                ...(definition.metadata || {}),
                created_at: definition.metadata?.created_at || now,
                created_by: definition.metadata?.created_by || createdBy || 'api',
                updated_at: now,
                updated_by: createdBy || 'api'
            }
        };

        const conn = await pools.kore_sys.getConnection();
        try {
            // Insert into workflows (id, name, version, folder_id, definition)
            await conn.execute(
                `INSERT INTO kore_sys.workflows 
                 (id, name, version, folder_id, definition) 
                 VALUES (?, ?, ?, ?, ?)`,
                [id, name, version, folder_id || null, JSON.stringify(definitionToStore)]
            );

            // Insert into workflows_hist (workflow_id, version, definition)
            await conn.execute(
                `INSERT INTO kore_sys.workflows_hist 
                 (workflow_id, version, definition) 
                 VALUES (?, ?, ?)`,
                [id, version, JSON.stringify(definitionToStore)]
            );

            console.log(`[Persephone] Workflow created: ${id} (${name})@${version}`);
            return { id, name, version };
        } finally {
            conn.release();
        }
    }

    /**
     * List all workflows (current version only)
     */
    async function listWorkflows() {
        const conn = await pools.kore_sys.getConnection();
        try {
            const [rows] = await conn.execute(
                `SELECT w.id, w.name, w.version, w.folder_id, w.definition, 
                        f.name as folder_name, f.parent_id as folder_parent_id,
                        GROUP_CONCAT(p.permissionId) as permissionIds
                 FROM kore_sys.workflows w
                 LEFT JOIN kore_sys.workflow_folders f ON w.folder_id = f.id
                 LEFT JOIN kore_sys.permissions p ON p.resource = 'workflow' AND p.scope = w.id
                 GROUP BY w.id, w.name, w.version, w.folder_id, w.definition, f.name, f.parent_id
                 ORDER BY w.name ASC`
            );

            return rows.map(row => {
                const definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
                
                // Determine folder display name
                let folderName = null;
                if (row.folder_id && row.folder_name) {
                    folderName = row.folder_name;
                }
                
                // Parse comma-separated permissionIds into array
                const permissionIds = row.permissionIds ? row.permissionIds.split(',') : [];
                
                return {
                    id: row.id,
                    name: row.name,
                    version: row.version,
                    folder_id: row.folder_id || null,
                    folder_name: folderName,
                    definition: definition,
                    permissionIds: permissionIds
                };
            });
        } finally {
            conn.release();
        }
    }

    /**
     * Get all workflow folders
     */
    async function getWorkflowFolders() {
        const conn = await pools.kore_sys.getConnection();
        try {
            const [rows] = await conn.execute(
                `SELECT id, name, parent_id 
                 FROM kore_sys.workflow_folders 
                 ORDER BY name ASC`
            );

            return rows.map(row => ({
                id: row.id,
                name: row.name,
                parent_id: row.parent_id
            }));
        } finally {
            conn.release();
        }
    }

    /**
     * Create a new workflow folder
     */
    async function createWorkflowFolder(folderData) {
        const { id, name, parent_id } = folderData;

        if (!id || !name) {
            throw new Error('id and name are required');
        }

        const conn = await pools.kore_sys.getConnection();
        try {
            await conn.execute(
                `INSERT INTO kore_sys.workflow_folders 
                 (id, name, parent_id) 
                 VALUES (?, ?, ?)`,
                [id, name, parent_id || null]
            );

            return {
                id,
                name,
                parent_id: parent_id || null
            };
        } finally {
            conn.release();
        }
    }

    async function updateWorkflowFolder(folderId, updates) {
        const conn = await pools.kore_sys.getConnection();
        try {
            // Build the update query based on what's provided
            const updateFields = [];
            const values = [];

            if (updates.name) {
                updateFields.push('name = ?');
                values.push(updates.name);
            }

            if (updates.hasOwnProperty('parent_id')) {
                updateFields.push('parent_id = ?');
                values.push(updates.parent_id || null);
            }

            if (updateFields.length === 0) {
                throw new Error('No fields to update');
            }

            values.push(folderId);

            await conn.execute(
                `UPDATE kore_sys.workflow_folders SET ${updateFields.join(', ')} WHERE id = ?`,
                values
            );

            return { success: true };
        } finally {
            conn.release();
        }
    }

    async function handleUpdateWorkflowFolder(req, res, folderId) {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const result = await updateWorkflowFolder(folderId, data);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (error) {
                console.error('[Persephone] Update folder error:', error.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }

    async function deleteWorkflowFolder(folderId) {
        const conn = await pools.kore_sys.getConnection();
        try {
            // Get folder info to check for children
            const [folders] = await conn.execute(
                `SELECT id, parent_id FROM kore_sys.workflow_folders WHERE id = ?`,
                [folderId]
            );
            
            if (folders.length === 0) {
                throw new Error('Folder not found');
            }

            const folder = folders[0];

            // Check for child folders
            const [children] = await conn.execute(
                `SELECT id FROM kore_sys.workflow_folders WHERE parent_id = ?`,
                [folderId]
            );

            if (children.length > 0) {
                // Remove parent_id from child folders (move to root level)
                await conn.execute(
                    `UPDATE kore_sys.workflow_folders SET parent_id = NULL WHERE parent_id = ?`,
                    [folderId]
                );
            } else {
                // No children - set workflows to null folder_id
                await conn.execute(
                    `UPDATE kore_sys.workflows SET folder_id = NULL WHERE folder_id = ?`,
                    [folderId]
                );
            }

            // Delete the folder
            await conn.execute(
                `DELETE FROM kore_sys.workflow_folders WHERE id = ?`,
                [folderId]
            );

            return { success: true };
        } finally {
            conn.release();
        }
    }

    async function handleDeleteWorkflowFolder(req, res, folderId) {
        try {
            const result = await deleteWorkflowFolder(folderId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (error) {
            console.error('[Persephone] Delete folder error:', error.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    /**
     * Get workflow by UUID
     */
    async function getWorkflow(workflowId, version = null) {
        const conn = await pools.kore_sys.getConnection();
        try {
            let query, params;

            if (version) {
                // Get specific version from history
                query = `SELECT * FROM workflows_hist 
                        WHERE workflow_id = ? AND version = ?`;
                params = [workflowId, version];
            } else {
                // Get current version from main table
                query = `SELECT * FROM workflows 
                        WHERE id = ?`;
                params = [workflowId];
            }

            const [rows] = await conn.execute(query, params);
            if (rows.length === 0) return null;

            const row = rows[0];
            const definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;

            return {
                id: row.id || row.workflow_id,
                name: row.name,
                version: row.version,
                folder_id: row.folder_id || null,
                definition
            };
        } finally {
            conn.release();
        }
    }

    /**
     * Execute a workflow
     */
    async function executeWorkflow(workflowId, options = {}) {
        const {
            workflowVersion = null,
            parameters = {},
            triggeredBy = 'api',
            triggeredByUser = 'system',
            timeout = 3600000 // 1 hour default
        } = options;

        const executionId = uuidv4();
        const conn = await pools.kore_sys.getConnection();

        try {
            // Get workflow definition
            const workflow = await getWorkflow(workflowId, workflowVersion);

            // Initialize variables with workflow defaults + parameters
            const variables = {
                ...workflow.definition.variables,
                ...parameters,
                _executionId: executionId,
                _workflowId: workflowId,
                _workflowVersion: workflow.version,
                _startedAt: global.getTimestamp()
            };

            // Create execution record
            await conn.execute(
                `INSERT INTO pers_executions 
                 (execution_id, workflow_id, workflow_version, triggered_by, triggered_by_user, parameters, variables, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
                [
                    executionId,
                    workflowId,
                    workflow.version,
                    triggeredBy,
                    triggeredByUser,
                    JSON.stringify(parameters),
                    JSON.stringify(variables)
                ]
            );

            console.log(`[Persephone] Execution started: ${executionId}`);

            // Execute workflow asynchronously
            executeWorkflowSteps(executionId, workflow, variables, conn).catch(err => {
                console.error(`[Persephone] Execution failed: ${executionId}`, err);
            });

            return { executionId, status: 'running', startedAt: global.getTimestamp() };
        } catch (error) {
            console.error(`[Persephone] Execute workflow error:`, error);
            throw error;
        } finally {
            conn.release();
        }
    }

    /**
     * Execute workflow steps (internal)
     */
    async function executeWorkflowSteps(executionId, workflow, variables, conn) {
        const startTime = Date.now();
        const results = {};
        const errors = [];
        let stepsFailed = false;

        try {
            for (const step of workflow.definition.steps) {
                if (stepsFailed && !step.continueOnError) {
                    // Skip remaining steps if one failed
                    await recordStepExecution(conn, executionId, step.id, step.type, 'skipped', null, null);
                    continue;
                }

                const stepStartTime = Date.now();

                try {
                    console.log(`[Persephone] Executing step: ${step.id} (${step.type})`);

                    let stepOutput;

                    // Execute step based on type
                    switch (step.type) {
                        case 'command':
                            stepOutput = await executeCommand(step, variables);
                            break;
                        case 'query':
                            stepOutput = await executeQuery(step, variables);
                            break;
                        case 'condition':
                            stepOutput = await executeCondition(step, variables);
                            break;
                        case 'foreach':
                            stepOutput = await executeForeach(step, variables);
                            break;
                        case 'action':
                            stepOutput = await executeAction(step, variables);
                            break;
                        default:
                            throw new Error(`Unknown step type: ${step.type}`);
                    }

                    // Store step output in variables for next steps
                    if (!variables.steps) variables.steps = {};
                    variables.steps[step.id] = stepOutput;
                    results[step.id] = stepOutput;

                    const stepDuration = Date.now() - stepStartTime;
                    await recordStepExecution(conn, executionId, step.id, step.type, 'completed', stepOutput, null, stepDuration);

                } catch (err) {
                    stepsFailed = true;
                    const errorMsg = err?.message || err?.toString?.() || String(err);
                    errors.push({ step: step.id, error: errorMsg });

                    const stepDuration = Date.now() - stepStartTime;
                    await recordStepExecution(conn, executionId, step.id, step.type, 'failed', null, errorMsg, stepDuration);

                    console.error(`[Persephone] Step error: ${step.id}`, err);

                    if (!step.continueOnError) {
                        throw err;
                    }
                }
            }

            // Update execution as completed
            const duration = Date.now() - startTime;
            await conn.execute(
                `UPDATE pers_executions 
                 SET status = 'completed', results = ?, errors = ?, duration_ms = ?, completed_at = NOW()
                 WHERE execution_id = ?`,
                [JSON.stringify(results), JSON.stringify(errors), duration, executionId]
            );

            console.log(`[Persephone] Execution completed: ${executionId} (${duration}ms)`);

        } catch (err) {
            // Update execution as failed
            const duration = Date.now() - startTime;
            errors.push({ workflow: 'fatal', error: err.message });

            await conn.execute(
                `UPDATE pers_executions 
                 SET status = 'failed', errors = ?, duration_ms = ?, completed_at = NOW()
                 WHERE execution_id = ?`,
                [JSON.stringify(errors), duration, executionId]
            );

            console.error(`[Persephone] Execution failed: ${executionId}`, err);
        }
    }

    /**
     * Execute command step (template rendering + MeshCentral execution)
     */
    async function executeCommand(step, variables) {
        // Render template with current variables
        const renderedCommand = nunjucks.renderString(step.command, variables);
        console.log(`[Persephone] Rendered command: ${renderedCommand.substring(0, 100)}`);

        // TODO: Integrate with Kore's MeshCentral command execution
        // For now, return mock result
        return {
            command: renderedCommand,
            nodeId: nunjucks.renderString(step.nodeId || '', variables),
            status: 'executed'
        };
    }

    /**
     * Execute query step (template rendering + database execution)
     */
    async function executeQuery(step, variables) {
        const database = step.database || 'kore_sys'; // Default to kore_sys database
        const pool = pools[database];

        if (!pool) {
            throw new Error(`Database pool not available: ${database}`);
        }

        const renderedQuery = nunjucks.renderString(step.query, variables);
        console.log(`[Persephone] Executing query on ${database}: ${renderedQuery.substring(0, 100)}`);

        const conn = await pool.getConnection();
        try {
            const [results] = await conn.execute(renderedQuery);
            
            const result = {
                database: database,
                query: renderedQuery,
                rowsAffected: results.affectedRows || results.length,
                rows: Array.isArray(results) ? results : []
            };

            console.log(`[Persephone] Query result: ${result.rowsAffected} rows affected/returned`);
            return result;
        } finally {
            conn.release();
        }
    }

    /**
     * Execute condition step
     */
    async function executeCondition(step, variables) {
        const condition = nunjucks.renderString(step.condition, variables);
        // Make variables available to eval by injecting them into scope
        // eslint-disable-next-line no-eval
        const result = (function() {
            // Extract variables into local scope for eval
            const steps = variables.steps || {};
            const params = variables.parameters || {};
            
            // Evaluate with access to variables
            return eval(condition);
        })();
        
        return {
            condition: step.condition,
            result: result
        };
    }

    /**
     * Execute foreach loop
     */
    async function executeForeach(step, variables) {
        // TODO: Implement loop execution
        return { loopCount: 0 };
    }

    /**
     * Execute action step (variable assignment, etc.)
     */
    async function executeAction(step, variables) {
        // Execute arbitrary action
        if (step.action) {
            nunjucks.renderString(step.action, variables);
        }
        return { action: 'executed' };
    }

    /**
     * Record step execution in database
     */
    async function recordStepExecution(conn, executionId, stepId, stepType, status, output, error, duration) {
        const stepExecutionId = uuidv4();

        await conn.execute(
            `INSERT INTO pers_execution_steps
             (step_execution_id, execution_id, step_id, step_type, status, output, error, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                stepExecutionId,
                executionId,
                stepId,
                stepType,
                status,
                output ? JSON.stringify(output) : null,
                error,
                duration || null
            ]
        );
    }

    /**
     * Get execution status
     */
    async function getExecutionStatus(executionId) {
        const conn = await pools.kore_sys.getConnection();
        try {
            const [execRows] = await conn.execute(
                `SELECT * FROM pers_executions WHERE execution_id = ?`,
                [executionId]
            );

            if (execRows.length === 0) {
                throw new Error(`Execution not found: ${executionId}`);
            }

            const execution = execRows[0];

            // Get step details
            const [stepRows] = await conn.execute(
                `SELECT * FROM pers_execution_steps 
                 WHERE execution_id = ?
                 ORDER BY started_at ASC`,
                [executionId]
            );

            return {
                executionId: execution.execution_id,
                workflowId: execution.workflow_id,
                workflowVersion: execution.workflow_version,
                status: execution.status,
                triggeredAt: execution.triggered_at,
                completedAt: execution.completed_at,
                duration: execution.duration_ms,
                results: execution.results ? (typeof execution.results === 'string' ? JSON.parse(execution.results) : execution.results) : null,
                errors: execution.errors ? (typeof execution.errors === 'string' ? JSON.parse(execution.errors) : execution.errors) : null,
                steps: stepRows.map(row => ({
                    stepId: row.step_id,
                    stepType: row.step_type,
                    status: row.status,
                    startedAt: row.started_at,
                    completedAt: row.completed_at,
                    duration: row.duration_ms,
                    output: row.output ? (typeof row.output === 'string' ? JSON.parse(row.output) : row.output) : null,
                    error: row.error
                }))
            };
        } finally {
            conn.release();
        }
    }

    async function updateWorkflow(workflowData) {
        const { id, name, version, definition, folder_id, createdBy } = workflowData;

        if (!id || !name || !version || !definition) {
            throw new Error('id, name, version, and definition are required');
        }

        // Validate workflow structure
        const validation = await validateWorkflow(definition);
        if (!validation.isValid) {
            throw new Error(`Workflow validation failed: ${validation.errors.join(', ')}`);
        }

        // Update metadata timestamps, preserve everything else in definition as-is
        const now = global.getTimestamp();
        const definitionToStore = {
            ...definition,
            metadata: {
                ...(definition.metadata || {}),
                updated_at: now,
                updated_by: createdBy || 'api'
            }
        };

        const conn = await pools.kore_sys.getConnection();
        try {
            // First, get the current version to check if it changed
            const [currentRows] = await conn.execute(
                `SELECT version FROM workflows WHERE id = ?`,
                [id]
            );
            
            const currentVersion = currentRows.length > 0 ? currentRows[0].version : null;
            const versionChanged = currentVersion !== version;

            // Update workflows (id, name, version, folder_id, definition)
            await conn.execute(
                `UPDATE workflows 
                 SET name = ?, version = ?, folder_id = ?, definition = ?
                 WHERE id = ?`,
                [name, version, folder_id || null, JSON.stringify(definitionToStore), id]
            );

            // Only insert into history if version changed
            if (versionChanged) {
                await conn.execute(
                    `INSERT INTO workflows_hist 
                     (workflow_id, version, definition) 
                     VALUES (?, ?, ?)`,
                    [id, version, JSON.stringify(definitionToStore)]
                );
            }

            console.log(`[Persephone] Workflow updated: ${id} (${name})@${version}`);
            return { id, name, version };
        } finally {
            conn.release();
        }
    }

    async function handleWorkflowRequest(req, res) {
        const url = require('url');
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        const parts = pathname.split('/').filter(p => p);

        if (req.method === 'POST') {
            handleCreateWorkflow(req, res);
        } else if (req.method === 'GET') {
            if (parts.length === 2) {
                handleListWorkflows(req, res);
            } else if (parts.length === 3) {
                handleGetWorkflow(req, res, parts[2], null);
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid workflow path' }));
            }
        } else if (req.method === 'PUT') {
            if (parts.length === 3) {
                handleUpdateWorkflow(req, res, parts[2]);
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'PUT requires workflow id' }));
            }
        } else if (req.method === 'DELETE') {
            if (parts.length >= 4) {
                handleArchiveWorkflow(req, res, parts[2], parts[3]);
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'DELETE requires id and version' }));
            }
        } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
    }

    async function handleWorkflowFoldersRequest(req, res) {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const pathParts = url.pathname.split('/').filter(p => p);
            const folderId = pathParts[2]; // Extract folder ID from /kore/workflow-folders/:id
            
            if (req.method === 'GET') {
                const folders = await getWorkflowFolders();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ folders }));
            } else if (req.method === 'POST') {
                await handleCreateWorkflowFolder(req, res);
            } else if (req.method === 'PUT') {
                if (folderId) {
                    await handleUpdateWorkflowFolder(req, res, folderId);
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Folder ID is required' }));
                }
            } else if (req.method === 'DELETE') {
                if (folderId) {
                    await handleDeleteWorkflowFolder(req, res, folderId);
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Folder ID is required' }));
                }
            } else {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
        } catch (error) {
            console.error('[Persephone] Workflow folders error:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async function handleCreateWorkflowFolder(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const folderData = JSON.parse(body);
                if (!folderData.id || !folderData.name) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'id and name are required' }));
                    return;
                }
                const result = await createWorkflowFolder({
                    id: folderData.id,
                    name: folderData.name,
                    parent_id: folderData.parent_id || null
                });
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (error) {
                console.error('[Persephone] Create workflow folder error:', error.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }

    async function handleCreateWorkflow(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const workflowData = JSON.parse(body);
                if (!workflowData.id || !workflowData.version || !workflowData.definition) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'id, version, and definition are required' }));
                    return;
                }
                const result = await createWorkflow({
                    id: workflowData.id,
                    name: workflowData.name || 'Untitled',
                    version: workflowData.version,
                    folder_id: workflowData.folder_id || null,
                    definition: workflowData.definition,
                    createdBy: req.headers['x-user'] || 'api'
                });
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (error) {
                console.error('[Persephone] Create workflow error:', error.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }

    async function handleListWorkflows(req, res) {
        try {
            const workflows = await listWorkflows();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ workflows }));
        } catch (error) {
            console.error('[Persephone] List workflows error:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async function handleGetWorkflow(req, res, workflowId, version) {
        try {
            const workflow = await getWorkflow(workflowId, version);
            if (!workflow) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Workflow not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(workflow));
        } catch (error) {
            console.error('[Persephone] Get workflow error:', error.message);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async function handleUpdateWorkflow(req, res, workflowId) {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const workflowData = JSON.parse(body);
                if (!workflowData.version || !workflowData.definition) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'version and definition are required' }));
                    return;
                }
                const result = await updateWorkflow({
                    id: workflowId,
                    name: workflowData.name,
                    version: workflowData.version,
                    definition: workflowData.definition,
                    folder_id: workflowData.folder_id,
                    createdBy: req.headers['x-user'] || 'api'
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (error) {
                console.error('[Persephone] Update workflow error:', error.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }

    async function handleArchiveWorkflow(req, res, workflowId, version) {
        try {
            if (!workflowId || !version) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'workflowId and version are required' }));
                return;
            }

            const conn = await pools.kore_sys.getConnection();
            try {
                // Delete the workflow version from the database
                const result = await conn.execute(
                    'DELETE FROM kore_sys.workflows WHERE id = ? AND version = ?',
                    [workflowId, version]
                );

                if (result[0].affectedRows === 0) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Workflow version not found' }));
                    return;
                }

                // Also delete the workflow history
                await conn.execute(
                    'DELETE FROM kore_sys.workflows_hist WHERE workflow_id = ? AND version = ?',
                    [workflowId, version]
                );

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    workflowId, 
                    version, 
                    status: 'deleted', 
                    message: 'Workflow version and history deleted successfully' 
                }));
            } finally {
                conn.release();
            }
        } catch (error) {
            console.error('[Persephone] Delete workflow error:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async function handleExecuteRequest(req, res) {
        const url = require('url');
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;

        if (req.method === 'POST' && pathname === '/kore/execute') {
            handleExecuteWorkflow(req, res);
        } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
    }

    async function handleExecuteWorkflow(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const executionData = JSON.parse(body);
                if (!executionData.workflowId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'workflowId is required' }));
                    return;
                }
                const result = await executeWorkflow(executionData.workflowId, {
                    workflowVersion: executionData.workflowVersion,
                    parameters: executionData.parameters || {},
                    triggeredBy: executionData.triggeredBy || 'api',
                    triggeredByUser: req.headers['x-user'] || 'system',
                    timeout: executionData.timeout
                });
                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (error) {
                console.error('[Persephone] Execute workflow error:', error.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }

    async function handleExecutionRequest(req, res) {
        const url = require('url');
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        const parts = pathname.split('/').filter(p => p);

        if (req.method === 'GET' && parts.length === 3) {
            handleGetExecutionStatus(req, res, parts[2]);
        } else if (req.method === 'POST' && parts.length === 4 && parts[3] === 'cancel') {
            handleCancelExecution(req, res, parts[2]);
        } else if (req.method === 'GET' && parts.length === 2) {
            handleListExecutions(req, res);
        } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
    }

    async function handleGetExecutionStatus(req, res, executionId) {
        try {
            const status = await getExecutionStatus(executionId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status));
        } catch (error) {
            console.error('[Persephone] Get execution status error:', error.message);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async function handleCancelExecution(req, res, executionId) {
        try {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ executionId, message: 'Execution cancel requested' }));
        } catch (error) {
            console.error('[Persephone] Cancel execution error:', error.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async function handleListExecutions(req, res) {
        try {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ executions: [], total: 0 }));
        } catch (error) {
            console.error('[Persephone] List executions error:', error.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    /**
     * Mark lines that are purely control/comment structures
     * Lines where first non-space chars are {% or {# and last non-space chars are %} or #}
     */
    function markControlLines(template) {
        const MARKER = '__CONTROL_LINE_MARKER__';
        const lines = template.split('\n');
        
        return lines.map(line => {
            const trimmed = line.trim();
            // Check if line starts with {% or {# and ends with %} or #}
            if ((trimmed.startsWith('{%') && trimmed.endsWith('%}')) ||
                (trimmed.startsWith('{#') && trimmed.endsWith('#}'))) {
                // This is a pure control/comment line - add marker
                return line + MARKER;
            }
            return line;
        }).join('\n');
    }

    /**
     * Clean up rendered output by removing lines with control/comment markers
     */
    function cleanRenderOutput(output) {
        const MARKER = '__CONTROL_LINE_MARKER__';
        return output
            .split('\n')
            .filter(line => !line.includes(MARKER))
            .join('\n');
    }

    /**
     * Render a Jinja2 template with given context
     */
    async function renderTemplate(template, context) {
        try {
            // Mark lines that are purely control/comment structures
            const markedTemplate = markControlLines(template);
            
            // Render the template
            const result = nunjucks.renderString(markedTemplate, context);
            
            // Clean up by removing marked lines
            const cleanedResult = cleanRenderOutput(result);
            
            return { success: true, result: cleanedResult };
        } catch (error) {
            // Parse Nunjucks error to extract variable name and line info
            const errorInfo = parseNunjucksError(error, template);
            
            // If it's a null value (variable declared but set to none), treat as success
            if (errorInfo.isNull) {
                return { success: true, result: '' };
            }
            
            return { 
                success: false, 
                error: errorInfo.message,
                errorType: errorInfo.errorType,
                variable: errorInfo.variable,
                lineNumber: errorInfo.lineNumber,
                column: errorInfo.column,
                context: 'variable_ref'
            };
        }
    }
    
    /**
     * Get variables declared with {% set %} in template
     */
    function getDeclaredVariables(template) {
        const declared = new Set();
        const setPattern = /\{%\s*set\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;
        let match;
        
        while ((match = setPattern.exec(template)) !== null) {
            declared.add(match[1]);
        }
        
        return declared;
    }
    
    /**
     * Check if error is a syntax error (malformed tags)
     */
    function isSyntaxError(message, template, lineNumber) {
        // Check for common Nunjucks syntax errors
        if (message.includes('expected variable name') ||
            message.includes('expected name') ||
            message.includes('unexpected end') ||
            message.includes('expected') ||
            message.includes('syntax')) {
            return true;
        }
        
        // Check for mismatched closing tags in the template
        if (lineNumber > 0 && lineNumber <= template.split('\n').length) {
            const line = template.split('\n')[lineNumber - 1];
            
            // Check for {{ with %} or {% with }}
            if ((line.includes('{{') && line.includes('%}')) ||
                (line.includes('{%') && line.includes('}}'))) {
                // Make sure they're not both properly closed
                const hasProperClose = (line.includes('{{') && line.includes('}}')) ||
                                       (line.includes('{%') && line.includes('%}'));
                if (!hasProperClose) {
                    return true;
                }
            }
        }
        
        return false;
    }
    
    /**
     * Format syntax error message to be more helpful
     */
    function formatSyntaxError(message, template, lineNumber) {
        // Extract line and column info
        const column = message.match(/Column (\d+)/) ? parseInt(message.match(/Column (\d+)/)[1]) : 1;
        
        // Handle "expected block end in * statement" - needs %}
        if (message.match(/expected block end in .+ statement/)) {
            return `Expected %} (Line ${lineNumber}, Column ${column})`;
        }
        
        // Handle "expected variable end" - needs }}
        if (message.includes('expected variable end')) {
            return `Expected }} (Line ${lineNumber}, Column ${column})`;
        }
        
        // Return original message if we don't recognize it
        return message;
    }
    
    /**
     * Parse Nunjucks errors to extract structured info
     */
    function parseNunjucksError(error, template) {
        const message = error.message;
        const lines = template.split('\n');
        const declaredVars = getDeclaredVariables(template);
        
        let variable = 'unknown';
        let lineNumber = 1;
        let column = 1;
        
        // Extract line number from Nunjucks error
        if (error.lineno) {
            lineNumber = error.lineno;
        } else {
            const lineMatch = message.match(/\[Line (\d+)/);
            if (lineMatch) {
                lineNumber = parseInt(lineMatch[1]);
            }
        }
        
        // Extract column from Nunjucks error
        if (error.colno) {
            column = error.colno;
        } else {
            const colMatch = message.match(/Column (\d+)/);
            if (colMatch) {
                column = parseInt(colMatch[1]);
            }
        }
        
        // Check if this is a syntax error first
        if (isSyntaxError(message, template, lineNumber)) {
            const formattedMessage = formatSyntaxError(message, template, lineNumber);
            return {
                message: formattedMessage,
                errorType: 'syntax_error',
                variable: 'unknown',
                lineNumber: lineNumber,
                column: column
            };
        }
        
        // Try to extract variable name from the template line
        if (lineNumber > 0 && lineNumber <= lines.length) {
            const errorLine = lines[lineNumber - 1];
            
            // Pattern 1: {{ VARIABLE }}
            let varMatch = errorLine.match(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)/);
            if (varMatch) {
                variable = varMatch[1];
            }
            // Pattern 2: {% for x in VARIABLE %}
            else if ((varMatch = errorLine.match(/\{%\s*for\s+\w+\s+in\s+([a-zA-Z_][a-zA-Z0-9_.]*)/))) {
                variable = varMatch[1];
            }
            // Pattern 3: {% if VARIABLE %}
            else if ((varMatch = errorLine.match(/\{%\s*if\s+([a-zA-Z_][a-zA-Z0-9_.]*)/))) {
                variable = varMatch[1];
            }
        }
        
        // Check if variable is declared - if so, it's a null/none value, not undefined
        const rootVar = variable.includes('.') ? variable.split('.')[0] : variable;
        if (declaredVars.has(rootVar)) {
            // Variable was declared, so just render as empty string
            return {
                message: '',  // Empty result, no error
                errorType: null,
                variable: variable,
                lineNumber: lineNumber,
                column: column,
                isNull: true  // Signal to treat as success with empty output
            };
        }
        
        // Format error message for truly undefined variable
        const varName = variable.includes('.') ? variable.split('.').pop() : variable;
        const errorMessage = `${varName} was not found (Line ${lineNumber}, Column ${column})`;
        
        return {
            message: errorMessage,
            errorType: 'undefined_variable',
            variable: variable,
            lineNumber: lineNumber,
            column: column
        };
    }
    
    /**
     * Get variables declared with {% set %} or loop variables in template
     */
    
    /**
     * Handle filter metadata requests
     */
    async function handleFilterRequest(req, res) {
        console.log(`[Persephone] handleFilterRequest called`);
        try {
            // Parse URL to get filter name if specified
            const parsedUrl = url.parse(req.url, true);
            const filterName = parsedUrl.pathname.replace('/kore/filters', '').replace(/^\//, '');
            
            console.log(`[Persephone] URL: ${req.url}`);
            console.log(`[Persephone] Pathname: ${parsedUrl.pathname}`);
            console.log(`[Persephone] FilterName: "${filterName}"`);
            console.log(`[Persephone] FilterName is empty? ${filterName === ''}`);
            // Load filter definitions
            let filterDefs;
            try {
                const jsonPath = path.join(__dirname, 'filters', 'jinja-filters.json');
                console.log(`[Persephone] Filter path: ${jsonPath}`);
                const rawData = fs.readFileSync(jsonPath, 'utf8');
                console.log(`[Persephone] Filter file loaded successfully`);
                filterDefs = JSON.parse(rawData);
                console.log(`[Persephone] filterDefs structure:`, Object.keys(filterDefs));
                console.log(`[Persephone] filterDefs.filters exists?`, !!filterDefs.filters);
                if (filterDefs.filters) {
                    console.log(`[Persephone] filterDefs.filters is array?`, Array.isArray(filterDefs.filters));
                    console.log(`[Persephone] filterDefs.filters length:`, filterDefs.filters.length);
                }
            } catch (error) {
                console.error(`[Persephone] Filter file error: ${error.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Failed to load filter definitions' }));
            }
            
            // If specific filter requested
            if (filterName) {
                const filter = filterDefs.filters.find(f => f.name === filterName);
                if (!filter) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: `Filter '${filterName}' not found` }));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(filter));
            }
            
            // Return all filters
            console.log(`[Persephone] Returning ${filterDefs.filters.length} filters`);
            console.log(`[Persephone] Sending response with status 200`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const responseData = JSON.stringify(filterDefs);
            console.log(`[Persephone] Response size: ${responseData.length} bytes`);
            res.end(responseData);
            console.log(`[Persephone] Response sent`);
        } catch (error) {
            console.error('[Persephone] Filter request error:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    /**
     * Handle template rendering request
     */
    async function handleRenderTemplate(req, res) {
        try {
            // Read request body
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            
            req.on('end', async () => {
                try {
                    const { template, context } = JSON.parse(body);
                    
                    if (!template) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: 'Template is required' }));
                    }
                    
                    const contextData = context || {};
                    const renderResult = await renderTemplate(template, contextData);
                    
                    if (renderResult.success) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ result: renderResult.result }));
                    } else {
                        // Pass through structured error with all fields
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: renderResult.error,
                            errorType: renderResult.errorType,
                            variable: renderResult.variable,
                            lineNumber: renderResult.lineNumber,
                            column: renderResult.column,
                            context: renderResult.context
                        }));
                    }
                } catch (error) {
                    console.error('[Persephone] Template rendering error:', error.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                }
            });
        } catch (error) {
            console.error('[Persephone] Template rendering error:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    // Public API
    return {
        initialize,
        validateWorkflow,
        createWorkflow,
        updateWorkflow,
        listWorkflows,
        getWorkflow,
        getWorkflowFolders,
        createWorkflowFolder,
        executeWorkflow,
        getExecutionStatus,
        handleWorkflowRequest,
        handleWorkflowFoldersRequest,
        handleExecuteRequest,
        handleExecutionRequest,
        renderTemplate,
        handleRenderTemplate,
        registerRoute,
        handleRegisteredRoute
    };
})();

module.exports = Persephone;