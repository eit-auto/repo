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
 */

const nunjucks = require('nunjucks');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');

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
        for (const route of routes) {
            if (typeof route.pattern === 'string') {
                // Exact match or startsWith for query params
                if (req.url === route.pattern || req.url.startsWith(route.pattern + '?')) {
                    return route.handler(req, res);
                }
            } else if (route.pattern instanceof RegExp) {
                // Regex match
                if (route.pattern.test(req.url)) {
                    return route.handler(req, res);
                }
            }
        }
        return false; // No route matched
    }

    /**
     * Initialize Persephone with MySQL pools for all three databases
     */
    async function initialize(korePool, rewstPool, cwaPool) {
        pools.kore = korePool;
        pools.rewst = rewstPool;
        pools.cwa = cwaPool;
        nunjucks.configure({ autoescape: false });
        
        // Register Persephone API routes
        registerRoute('/kore/workflows', handleWorkflowRequest);
        registerRoute('/kore/execute', handleExecuteRequest);
        registerRoute('/kore/executions', handleExecutionRequest);
        registerRoute('/api/render-template', handleRenderTemplate);
        
        console.log('[Persephone] Engine initialized with MySQL pools (kore, rewst, cwa)');
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
        const { id, name, version, definition, createdBy } = workflowData;

        if (!id || !name || !version || !definition) {
            throw new Error('id, name, version, and definition are required');
        }

        // Validate workflow structure
        const validation = await validateWorkflow(definition);
        if (!validation.isValid) {
            throw new Error(`Workflow validation failed: ${validation.errors.join(', ')}`);
        }

        // Add/update metadata, preserve everything else in definition as-is
        const now = new Date().toISOString();
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

        const conn = await pools.kore.getConnection();
        try {
            // Insert into pers_workflows (id, name, version, definition only)
            await conn.execute(
                `INSERT INTO pers_workflows 
                 (id, name, version, definition) 
                 VALUES (?, ?, ?, ?)`,
                [id, name, version, JSON.stringify(definitionToStore)]
            );

            // Insert into pers_workflows_hist (workflow_id, version, definition only)
            await conn.execute(
                `INSERT INTO pers_workflows_hist 
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
        const conn = await pools.kore.getConnection();
        try {
            const [rows] = await conn.execute(
                `SELECT id, name, version 
                 FROM pers_workflows 
                 ORDER BY name ASC`
            );

            return rows.map(row => ({
                id: row.id,
                name: row.name,
                version: row.version
            }));
        } finally {
            conn.release();
        }
    }

    /**
     * Get workflow by UUID
     */
    async function getWorkflow(workflowId, version = null) {
        const conn = await pools.kore.getConnection();
        try {
            let query, params;

            if (version) {
                // Get specific version from history
                query = `SELECT * FROM pers_workflows_hist 
                        WHERE workflow_id = ? AND version = ?`;
                params = [workflowId, version];
            } else {
                // Get current version from main table
                query = `SELECT * FROM pers_workflows 
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
        const conn = await pools.kore.getConnection();

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
                _startedAt: new Date().toISOString()
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

            return { executionId, status: 'running', startedAt: new Date().toISOString() };
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
        const database = step.database || 'kore'; // Default to kore database
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
        const conn = await pools.kore.getConnection();
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
        const { id, name, version, definition, createdBy } = workflowData;

        if (!id || !name || !version || !definition) {
            throw new Error('id, name, version, and definition are required');
        }

        // Validate workflow structure
        const validation = await validateWorkflow(definition);
        if (!validation.isValid) {
            throw new Error(`Workflow validation failed: ${validation.errors.join(', ')}`);
        }

        // Update metadata timestamps, preserve everything else in definition as-is
        const now = new Date().toISOString();
        const definitionToStore = {
            ...definition,
            metadata: {
                ...(definition.metadata || {}),
                updated_at: now,
                updated_by: createdBy || 'api'
            }
        };

        const conn = await pools.kore.getConnection();
        try {
            // Update pers_workflows (id, name, version, definition only)
            await conn.execute(
                `UPDATE pers_workflows 
                 SET name = ?, version = ?, definition = ?
                 WHERE id = ?`,
                [name, version, JSON.stringify(definitionToStore), id]
            );

            // Insert into pers_workflows_hist (workflow_id, version, definition only)
            await conn.execute(
                `INSERT INTO pers_workflows_hist 
                 (workflow_id, version, definition) 
                 VALUES (?, ?, ?)`,
                [id, version, JSON.stringify(definitionToStore)]
            );

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

            const conn = await pools.kore.getConnection();
            try {
                // Delete the workflow version from the database
                const result = await conn.execute(
                    'DELETE FROM pers_workflows WHERE id = ? AND version = ?',
                    [workflowId, version]
                );

                if (result[0].affectedRows === 0) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Workflow version not found' }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    workflowId, 
                    version, 
                    status: 'deleted', 
                    message: 'Workflow version deleted successfully' 
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
     * Render a Jinja2 template with given context
     */
    async function renderTemplate(template, context) {
        try {
            const result = nunjucks.renderString(template, context);
            return { success: true, result };
        } catch (error) {
            return { success: false, error: error.message };
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
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: renderResult.error }));
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
        executeWorkflow,
        getExecutionStatus,
        handleWorkflowRequest,
        handleExecuteRequest,
        handleExecutionRequest,
        renderTemplate,
        handleRenderTemplate,
        registerRoute,
        handleRegisteredRoute
    };
})();

module.exports = Persephone;