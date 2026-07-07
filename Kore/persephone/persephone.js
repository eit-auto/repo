/**
 * Persephone - Automation Execution Engine for Kore
 *
 * Core workflow execution engine with Nunjucks templating.
 * Workflow/folder CRUD has moved to resources/resources.js.
 *
 * API Endpoints (execution only):
 *   POST   /kore/execute                          - Execute workflow
 *   GET    /kore/executions/:executionId          - Get execution status/results
 *   POST   /kore/executions/:executionId/cancel   - Cancel running execution
 *   GET    /kore/executions                       - List executions (with filters)
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
const Resources = require('../resources/resources');

/**
 * Track active executions for cancellation support
 */
const activeExecutions = {}; // { executionId: { cancelled: false } }

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
    
    let plugins = null;  // Plugins module reference for workflow execution
    let env = null;      // Nunjucks environment - recreated on reload

    /**
     * Main request handler for all /engine/ endpoints
     * Routes to appropriate handler based on pathname and method
     */
    async function handleRequest(req, res) {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        
        global.consoleLog('Persephone', `Routing /engine/ request: ${req.method} ${pathname}`, 4);
        
        try {
            // POST /engine/execute - Execute workflow
            if (req.method === 'POST' && pathname === '/engine/execute') {
                return handleExecuteRequest(req, res);
            }
            
            // /engine/executions/* - List, get status, or cancel execution
            else if (pathname.startsWith('/engine/executions')) {
                return handleExecutionRequest(req, res);
            }
            
            // /engine/filters* - Get filters (all or specific)
            else if (pathname.startsWith('/engine/filters')) {
                return handleFilterRequest(req, res);
            }
            
            // POST /engine/render-template - Render a Jinja2 template
            else if (req.method === 'POST' && pathname === '/engine/render-template') {
                return handleRenderTemplate(req, res);
            }
            
            // No matching route
            else {
                global.consoleLog('Persephone', `No route matched for: ${req.method} ${pathname}`, 3);
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (error) {
            global.consoleLog('Persephone', `Request handler error: ${error.message}`, 1);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    /**
     * Drain active workflow executions before reload
     * Waits for running workflows to complete with timeout
     */
    async function drainActiveExecutions(korePool) {
        try {
            const executionTimeout = 60000; // 60 second timeout for executions to complete
            const drainDeadline = Date.now() + executionTimeout;
            
            let runningCount = 0;
            let checkCount = 0;
            let lastReportedCount = -1;
            
            while (Date.now() < drainDeadline) {
                try {
                    const [execRows] = await korePool.query(
                        'SELECT COUNT(*) as count FROM workflow_exec WHERE status = ?',
                        ['running']
                    );
                    runningCount = execRows[0]?.count || 0;
                    
                    if (runningCount === 0) {
                        if (checkCount > 0) {
                            global.consoleLog('Persephone', 'All running executions completed - safe to reload', 3);
                        }
                        return;
                    }
                    
                    // Log only when count changes or first check
                    if (checkCount === 0 || runningCount !== lastReportedCount) {
                        global.consoleLog('Persephone', `Waiting for ${runningCount} running workflow execution(s) to complete...`, 3);
                        lastReportedCount = runningCount;
                    }
                    checkCount++;
                    
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                } catch (dbError) {
                    global.consoleLog('Persephone', `Could not check running executions: ${dbError.message}`, 2);
                    return; // Don't block reload if DB check fails
                }
            }
            
            // Timeout reached
            if (runningCount > 0) {
                global.consoleLog('Persephone', `WARNING: ${runningCount} workflow execution(s) still running after ${executionTimeout}ms - forcing reload`, 2);
            }
            
        } catch (error) {
            global.consoleLog('Persephone', `Error draining executions: ${error.message}`, 2);
            // Don't block reload on drain errors
        }
    }

    /**
     * Initialize Persephone with MySQL pool for kore_sys database only
     * External database queries are handled via Plugin system /sqlquery endpoint
     * 
     * On first call: Sets up dependencies
     * On re-initialization: Drains active executions, then resets and reloads
     */
    async function initialize(korePool, pluginsModule) {
        // If reinitializing (kore_sys pool already set), drain active executions first
        if (pools.kore_sys) {
            global.consoleLog('Persephone', 'Draining active workflow executions before reload...', 3);
            await drainActiveExecutions(korePool);
        }
        
        // Clear require cache for Persephone dependencies to ensure fresh reload
        const modulesToClear = [
            './filters',
            './filters/transform',
            './filters/utils',
            './filters/datetime',
            '../resources/resources'
        ];
        
        for (const modulePath of modulesToClear) {
            try {
                delete require.cache[require.resolve(modulePath)];
            } catch (e) {
                // Module might not be cached yet, that's fine
            }
        }
        
        // Re-require dependencies after cache clear
        const freshRegisterFilters = require('./filters');
        const freshTransformFilters = require('./filters/transform');
        
        // Clear nunjucks compiled template cache
        if (nunjucks.loaders && nunjucks.loaders[0]) {
            nunjucks.loaders[0].cache = {};
        }
        
        pools.kore_sys = korePool;
        plugins = pluginsModule;  // Store plugins module reference for workflow execution
        env = nunjucks.configure({ 
            autoescape: false,
            throwOnUndefined: true,  // Throw on undefined, none/true/false are defined values
            finalize: function(value) {
                if (value !== null && typeof value === 'object') {
                    return JSON.stringify(value);
                }
                return value;
            }
        });
        
        // Register custom filters
        try {
            const filterStatus = freshRegisterFilters(env);
            if (filterStatus.failed.length > 0) {
                global.consoleLog('Persephone', `Failed to register ${filterStatus.failed.length} filters: ${JSON.stringify(filterStatus.failed)}`, 2);
            }
        } catch (error) {
            global.consoleLog('Persephone', `Error registering filters: ${error.message}`, 1);
        }
        
        // Register transform filters (type conversion and transformation)
        try {
            Object.entries(freshTransformFilters).forEach(([name, fn]) => {
                env.addFilter(name, fn);
            });
            
            // Register utility filters
            const utilFilters = require('./filters/utils');
            Object.entries(utilFilters).forEach(([name, fn]) => {
                env.addFilter(name, fn);
            });
        } catch (error) {
            global.consoleLog('Persephone', `Error registering transform filters: ${error.message}`, 1);
        }
        
        // Register global functions and all datetime filters
        try {
            const datetimeFilters = require('./filters/datetime');
            env.addGlobal('now', datetimeFilters.now);
            Object.entries(datetimeFilters).forEach(([name, fn]) => {
                if (name !== 'now' && typeof fn === 'function') {
                    env.addFilter(name, fn);
                }
            });
        } catch (error) {
            global.consoleLog('Persephone', `Error registering global functions: ${error.message}`, 1);
        }
        
        global.consoleLog('Persephone', 'Initialization complete - /engine/ endpoints ready', 3);
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

        const conn = await pools.kore_sys.getConnection();

        try {
            // Get workflow definition (from Resources module)
            const workflow = await Resources.getWorkflow(workflowId, workflowVersion);

            // Initialize variables with workflow defaults + parameters
            // We'll add _executionId after the INSERT
            const variables = {
                ...workflow.definition.variables,
                ...parameters,
                _workflowId: workflowId,
                _workflowVersion: workflow.version,
                _startedAt: global.getTimestamp()
            };

            // Create execution record with initial context
            // Build CTX with only user-defined variables (filter out internal _ prefixed and steps)
            const initialCTX = {};
            for (const [key, value] of Object.entries(variables)) {
                if (!key.startsWith('_') && key !== 'steps') {
                    initialCTX[key] = value;
                }
            }
            
            const initialContext = {
                CTX: initialCTX,
                STEPS: {},
                WORKFLOW: {
                    workflowId: workflowId,
                    workflowVersion: workflow.version,
                    startedAt: global.getTimestamp()
                }
            };
            
            // Insert execution record and get auto-generated ID
            const [okPacket] = await conn.execute(
                `INSERT INTO workflow_exec 
                 (workflow_id, workflow_version, triggered_by, triggered_by_user, variables, context, status, triggered_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'running', NOW())`,
                [
                    workflowId,
                    workflow.version,
                    triggeredBy,
                    triggeredByUser,
                    JSON.stringify(variables),
                    JSON.stringify(initialContext)
                ]
            );
            
            const executionId = okPacket.insertId;
            
            // Initialize execution tracking
            activeExecutions[executionId] = { cancelled: false };
            
            // Now add executionId to variables and context
            variables._executionId = executionId;
            initialContext.WORKFLOW.executionId = executionId;

            global.consoleLog('Persephone', `Execution started: ${executionId}`, 3);

            // Execute workflow asynchronously
            executeWorkflowSteps(executionId, workflow, variables).catch(err => {
                global.consoleLog('Persephone', `Execution failed: ${executionId} ${JSON.stringify(err)}`, 1);
            });

            return { executionId, status: 'running', startedAt: global.getTimestamp() };
        } catch (error) {
            global.consoleLog('Persephone', `Execute workflow error: ${JSON.stringify(error)}`, 1);
            throw error;
        } finally {
            conn.release();
        }
    }

    /**
     * Get a pool connection with a timeout — rejects cleanly if no connection
     * is available within the given ms rather than waiting indefinitely.
     */
    function getConnectionWithTimeout(pool, timeoutMs = 10000) {
        return new Promise(function(resolve, reject) {
            const timer = setTimeout(function() {
                reject(new Error('Database connection timeout: pool exhausted after ' + timeoutMs + 'ms'));
            }, timeoutMs);
            pool.getConnection()
                .then(function(conn) {
                    clearTimeout(timer);
                    resolve(conn);
                })
                .catch(function(err) {
                    clearTimeout(timer);
                    reject(err);
                });
        });
    }

    /**
     * Execute workflow steps using graph traversal
     * Follows transitions to execute steps concurrently across paths
     */
    async function executeWorkflowSteps(executionId, workflow, variables) {
        const startTime = Date.now();
        const results = {};
        const errors = [];
        const stepLookup = {};
        const sequenceCounter = { value: 0 };  // Shared counter for step execution order
        
        // Build step lookup map
        workflow.definition.steps.forEach(step => {
            stepLookup[step.id] = step;
        });

        // Build node lookup map for resolving targetNodes -> targetSteps
        const nodeLookup = {};
        if (workflow.definition.nodes) {
            workflow.definition.nodes.forEach(node => {
                nodeLookup[node.id] = node;
            });
        }

        try {
            // Pre-calculate in-degree (number of incoming paths) for each step
            const inDegree = calculateInDegree(workflow.definition.steps, nodeLookup);
            
            // Track completion status of predecessors
            const completedPredecessors = {};
            inDegree.forEach((count, stepId) => {
                completedPredecessors[stepId] = 0;
            });

            // Find the Begin step
            const beginStep = workflow.definition.steps.find(s => s.type === 'Begin');
            if (!beginStep) {
                throw new Error('Workflow must have a Begin step');
            }

            global.consoleLog('Persephone', `Starting workflow execution from Begin step: ${beginStep.id}`, 4);

            // Execute the workflow graph starting from Begin
            // This handles both the single path (Begin → Plugin) and multi-path scenarios
            const beginResult = await executeStepInWorkflow(
                beginStep.id,
                variables,
                stepLookup,
                nodeLookup,
                results,
                errors,
                executionId,
                inDegree,
                completedPredecessors,
                sequenceCounter
            );

            // Find matching case for Begin step
            const beginCase = await findMatchingCase(beginStep.transition, beginResult.state, variables);
            
            if (beginCase) {
                // Resolve targetSteps including via nodes
                const beginNextSteps = [...(beginCase.targetSteps || [])];
                if (beginCase.targetNodes) {
                    beginCase.targetNodes.forEach(nodeId => {
                        const node = nodeLookup[nodeId];
                        if (node && node.targetSteps) beginNextSteps.push(...node.targetSteps);
                    });
                }
                if (beginNextSteps.length > 0) {
                    // Launch all successor paths in parallel
                    const pathPromises = beginNextSteps.map(stepId =>
                        executePath(stepId, variables, stepLookup, nodeLookup, results, errors, executionId, inDegree, completedPredecessors, sequenceCounter)
                    );
                    await Promise.allSettled(pathPromises);
                }
            }

            // Update execution as completed
            const duration = Date.now() - startTime;
            
            // Build CTX with only user-defined variables (filter out internal _ prefixed and steps)
            const CTX = {};
            for (const [key, value] of Object.entries(variables)) {
                if (!key.startsWith('_') && key !== 'steps') {
                    CTX[key] = value;
                }
            }
            
            // Determine final workflow status
            let finalStatus = 'success';  // Default: all succeeded

            if (errors.length > 0) {
                // Any errors → at least warning
                finalStatus = 'warning';

                // Check if the last step that actually ran was a failure or warning
                const [lastStepRows] = await pools.kore_sys.execute(
                    `SELECT status FROM workflow_exec_steps 
                     WHERE execution_id = ? 
                     ORDER BY execution_sequence DESC 
                     LIMIT 1`,
                    [executionId]
                );
                if (lastStepRows.length > 0 && lastStepRows[0].status === 'failure') {
                    finalStatus = 'failure';
                }
            } else {
                // No errors in errors[] — check if any step output carries a warning or failure status
                const hasWarning = Object.values(results).some(r => r && r.status === 'warning');
                const hasFailure = Object.values(results).some(r => r && r.status === 'failure');
                if (hasFailure) {
                    finalStatus = 'failure';
                } else if (hasWarning) {
                    finalStatus = 'warning';
                }
            }
            
            // Check if execution was cancelled - if so, override final status
            if (activeExecutions[executionId]?.cancelled) {
                finalStatus = 'cancelled';
            }
            
            const fullContext = {
                CTX: CTX,
                STEPS: results,
                WORKFLOW: {
                    executionId: executionId,
                    workflowId: variables._workflowId,
                    startedAt: variables._startedAt,
                    completedAt: global.getTimestamp(),
                    duration: duration
                }
            };
            await pools.kore_sys.execute(
                `UPDATE workflow_exec 
                 SET status = ?, results = ?, errors = ?, context = ?, duration_ms = ?, completed_at = NOW()
                 WHERE execution_id = ?`,
                [finalStatus, JSON.stringify(results), JSON.stringify(errors), JSON.stringify(fullContext), duration, executionId]
            );

            global.consoleLog('Persephone', `Execution completed: ${executionId} (${duration}ms) with status: ${finalStatus}`, 3);

        } catch (err) {
            // Update execution as failed
            const duration = Date.now() - startTime;
            errors.push({ type: 'failure', workflow: 'fatal', error: err.message });
            
            const fullContext = {
                CTX: variables,
                STEPS: results,
                WORKFLOW: {
                    executionId: executionId,
                    workflowId: variables._workflowId,
                    startedAt: variables._startedAt,
                    completedAt: global.getTimestamp(),
                    duration: duration
                }
            };

            await pools.kore_sys.execute(
                `UPDATE workflow_exec 
                 SET status = 'failure', errors = ?, context = ?, duration_ms = ?, completed_at = NOW()
                 WHERE execution_id = ?`,
                [JSON.stringify(errors), JSON.stringify(fullContext), duration, executionId]
            );

            global.consoleLog('Persephone', `Execution failed: ${executionId} ${JSON.stringify(err)}`, 1);
        } finally {
            // Clean up execution tracking
            delete activeExecutions[executionId];
        }
    }

    /**
     * Calculate in-degree (number of incoming paths) for each step
     */
    function calculateInDegree(steps, nodeLookup = {}) {
        const inDegree = new Map();
        
        // Initialize all steps with 0 in-degree
        steps.forEach(step => {
            inDegree.set(step.id, 0);
        });

        // Helper to get all target step IDs including via nodes
        function resolveTargetSteps(caseObj) {
            const stepIds = [...(caseObj.targetSteps || [])];
            if (caseObj.targetNodes) {
                caseObj.targetNodes.forEach(nodeId => {
                    const node = nodeLookup[nodeId];
                    if (node && node.targetSteps) {
                        stepIds.push(...node.targetSteps);
                    }
                });
            }
            return stepIds;
        }

        // Count incoming paths from each step's transition
        steps.forEach(step => {
            if (step.transition && step.transition.cases) {
                step.transition.cases.forEach(caseObj => {
                    resolveTargetSteps(caseObj).forEach(targetStepId => {
                        inDegree.set(targetStepId, (inDegree.get(targetStepId) || 0) + 1);
                    });
                });
            }
        });

        return inDegree;
    }

    /**
     * Find matching transition case based on step outcome
     */
    async function findMatchingCase(transition, stepState, variables) {
        if (!transition || !transition.cases || transition.cases.length === 0) {
            return null;
        }

        const mode = transition.mode || 'First';

        // Sort cases by order field if present
        const sortedCases = [...transition.cases].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        if (mode === 'First') {
            for (const caseObj of sortedCases) {
                const matched = await evaluateCase(caseObj, stepState, variables);
                if (matched) return caseObj;
            }
        } else if (mode === 'All') {
            const matchingCases = [];
            for (const caseObj of sortedCases) {
                const matched = await evaluateCase(caseObj, stepState, variables);
                if (matched) matchingCases.push(caseObj);
            }
            return matchingCases.length > 0 ? matchingCases[0] : null;
        }

        return null;
    }

    async function evaluateCase(caseObj, stepState, variables) {
        // Always type always matches
        if (caseObj.type === 'Always') return true;

        // Logic type - evaluate Jinja condition
        if (caseObj.type === 'Logic') {
            if (!caseObj.conditions) return false;
            try {
                const renderResult = await renderTemplate(caseObj.conditions, { CTX: variables, STEPS: variables.steps || {} });
                if (!renderResult.success) {
                    global.consoleLog('Persephone', `Logic case condition error: ${renderResult.error}`, 2);
                    return false;
                }
                const result = renderResult.result;
                // Treat as falsy: false, null, undefined, 0, '', 'false', 'none', 'False', 'None'
                if (result === false || result === null || result === undefined || result === 0) return false;
                if (typeof result === 'string') {
                    const lower = result.trim().toLowerCase();
                    if (lower === 'false' || lower === 'none' || lower === '' || lower === '0') return false;
                }
                return true;
            } catch (err) {
                global.consoleLog('Persephone', `Logic case evaluation error: ${err.message}`, 2);
                return false;
            }
        }

        // Standard type match (success, failure, etc.)
        return caseObj.type === stepState;
    }

    /**
     * Execute a step and record its result
     */
    async function executeStepInWorkflow(stepId, variables, stepLookup, nodeLookup, results, errors, executionId, inDegree, completedPredecessors, sequenceCounter) {
        const step = stepLookup[stepId];
        const stepStartTime = Date.now();

        // Check if execution was cancelled
        if (activeExecutions[executionId]?.cancelled) {
            global.consoleLog('Persephone', `Step cancelled before execution: ${stepId}`, 4);
            return { state: 'Cancelled' };
        }

        let stepExecutionId = null;

        try {
            global.consoleLog('Persephone', `Executing step: ${stepId} (${step.type})`, 4);
            
            // Record step as running at the start of execution
            stepExecutionId = await recordStepExecution(
                executionId, stepId, step.type, 'running', null, null, null, null, step.name, ++sequenceCounter.value
            );

            let stepOutput;

            // Execute step based on type
            switch (step.type) {
                case 'Begin':
                    stepOutput = { type: 'Begin', status: 'executed' };
                    break;
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
                case 'Plugin':
                    stepOutput = await executePlugin(step, variables);
                    break;
                case 'Kore':
                    stepOutput = await executeKore(step, variables, executionId);
                    break;
                case 'Workflow':
                    stepOutput = await executeWorkflowStep(step, variables, executionId);
                    break;
                default:
                    throw new Error(`Unknown step type: ${step.type}`);
            }

            // Store step output
            if (!variables.steps) variables.steps = {};
            variables.steps[step.name] = stepOutput;
            results[step.name] = stepOutput;

            // Track what gets added to CTX from this step
            let stepNewContext = {};

            // Process step variables if defined
            if (step.variables && Array.isArray(step.variables)) {
                const renderContext = {
                    CTX: variables,
                    STEPS: results
                };

                // Sort variables by order field before execution to ensure correct processing order
                // Assign order by index for variables that don't have it (backward compatibility)
                step.variables.forEach((v, i) => { if (v.order === undefined) v.order = i; });
                const sortedVariables = [...step.variables].sort((a, b) => a.order - b.order);
                for (const varDef of sortedVariables) {
                    try {
                        const renderResult = await renderTemplate(varDef.value, renderContext);
                        if (!renderResult.success) {
                            throw new Error(renderResult.error || 'Template rendering failed');
                        }
                        variables[varDef.name] = renderResult.result;
                        stepNewContext[varDef.name] = renderResult.result;
                        global.consoleLog('Persephone', `Step variable: ${varDef.name} = ${JSON.stringify(renderResult.result)}`, 4);
                    } catch (err) {
                        global.consoleLog('Persephone', `Error rendering step variable ${varDef.name}: ${err.message}`, 1);
                        const enriched = new Error(`Variable "${varDef.name}": ${err.message}  (template: ${String(varDef.value).substring(0, 200)})`);
                        throw enriched;
                    }
                }
            }

            const stepDuration = Date.now() - stepStartTime;
            const stepState = stepOutput && stepOutput.status === 'failure' ? 'Failure'
                : stepOutput && stepOutput.status === 'warning' ? 'Warning'
                : 'Success';

            // Propagate sub-workflow errors into parent errors array
            if ((stepState === 'Warning' || stepState === 'Failure') && stepOutput.subErrors && stepOutput.subErrors.length > 0) {
                stepOutput.subErrors.forEach(e => errors.push({ type: stepState.toLowerCase(), step: stepId, ...e }));
            }

            await recordStepExecution(executionId, stepId, step.type, stepState.toLowerCase(), stepOutput, null, stepDuration, stepNewContext, step.name, null, stepExecutionId);

            // Update main execution context if step added new variables
            if (Object.keys(stepNewContext).length > 0) {
                // Merge new context into variables (CTX)
                Object.assign(variables, stepNewContext);
                
                // Build CTX object without the internal steps property
                const ctx = {};
                for (const [key, value] of Object.entries(variables)) {
                    if (!key.startsWith('_') && key !== 'steps') {
                        ctx[key] = value;
                    }
                }
                
                // Build full context for persistence
                const fullContext = {
                    CTX: ctx
                };
                
                // Update execution record with new context
                await pools.kore_sys.execute(
                    `UPDATE workflow_exec SET context = ? WHERE execution_id = ?`,
                    [JSON.stringify(fullContext), executionId]
                );
                
                global.consoleLog('Persephone', `Updated execution context with ${Object.keys(stepNewContext).length} new variable(s)`, 4);
            }

            global.consoleLog('Persephone', `Step completed: ${stepId}`, 4);

            return {
                state: stepState,
                output: stepOutput
            };

        } catch (err) {
            const errorMsg = err?.message || err?.toString?.() || String(err);
            const isCancelled = errorMsg === 'Execution cancelled';
            
            const stepDuration = Date.now() - stepStartTime;
            const stepStatus = isCancelled ? 'cancelled' : 'failure';
            
            if (!isCancelled) {
                errors.push({ type: 'failure', step: stepId, error: errorMsg });
            }
            
            try {
                await recordStepExecution(executionId, stepId, step.type, stepStatus, null, isCancelled ? null : errorMsg, stepDuration, null, step.name, null, stepExecutionId);
            } catch (dbErr) {
                global.consoleLog('Persephone', `Step DB update FAILED: stepExecutionId=${stepExecutionId} error=${dbErr.message}`, 1);
            }

            global.consoleLog('Persephone', `Step ${isCancelled ? 'cancelled' : 'error'}: ${stepId}${isCancelled ? '' : ' ' + JSON.stringify(err)}`, isCancelled ? 3 : 1);

            return {
                state: isCancelled ? 'Cancelled' : 'Failure',
                error: isCancelled ? undefined : errorMsg
            };
        }
    }

    /**
     * Recursively execute a path in the workflow graph
     * Each path follows its own transitions sequentially
     * Multiple paths execute in parallel
     */
    async function executePath(stepId, variables, stepLookup, nodeLookup, results, errors, executionId, inDegree, completedPredecessors, sequenceCounter) {
        const step = stepLookup[stepId];

        // Execute this step
        const stepResult = await executeStepInWorkflow(
            stepId,
            variables,
            stepLookup,
            nodeLookup,
            results,
            errors,
            executionId,
            inDegree,
            completedPredecessors,
            sequenceCounter
        );

        // Find matching case for this step's outcome
        const matchingCase = await findMatchingCase(step.transition, stepResult.state, variables);

        if (matchingCase) {
            // Resolve all target step IDs including via nodes
            const nextStepIds = [...(matchingCase.targetSteps || [])];
            if (matchingCase.targetNodes) {
                matchingCase.targetNodes.forEach(nodeId => {
                    const node = nodeLookup[nodeId];
                    if (node && node.targetSteps) {
                        nextStepIds.push(...node.targetSteps);
                    }
                });
            }

            if (nextStepIds.length > 0) {
                // Process each successor step
                for (const nextStepId of nextStepIds) {
                    // Increment the predecessor completion count
                    completedPredecessors[nextStepId] = (completedPredecessors[nextStepId] || 0) + 1;

                    const nextStep = stepLookup[nextStepId];
                    const minConn = (nextStep && nextStep.min_connections) ? nextStep.min_connections : 0;
                    const required = minConn > 0 ? minConn : inDegree.get(nextStepId);
                    const completed = completedPredecessors[nextStepId];

                    // Check if threshold is met
                    if (completed >= required) {
                        global.consoleLog('Persephone', `Threshold met for ${nextStepId} (${completed}/${required}), executing`, 4);
                        await executePath(nextStepId, variables, stepLookup, nodeLookup, results, errors, executionId, inDegree, completedPredecessors, sequenceCounter);
                    } else {
                        global.consoleLog('Persephone', `Waiting for predecessors of ${nextStepId} (${completed}/${required})`, 4);
                    }
                }
            } else {
                global.consoleLog('Persephone', `No successors for step: ${stepId}, path ends`, 4);
            }
        } else {
            global.consoleLog('Persephone', `No successors for step: ${stepId}, path ends`, 4);
        }
    }

    /**
     * Execute command step (template rendering + MeshCentral execution)
     */
    async function executeCommand(step, variables) {
        // Render template with current variables
        const renderedCommand = env.renderString(step.command, variables);
        global.consoleLog('Persephone', `Rendered command: ${renderedCommand.substring(0, 100)}`, 4);

        // TODO: Integrate with Kore's MeshCentral command execution
        // For now, return mock result
        return {
            command: renderedCommand,
            nodeId: env.renderString(step.nodeId || '', variables),
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

        const renderedQuery = env.renderString(step.query, variables);
        global.consoleLog('Persephone', `Executing query on ${database}: ${renderedQuery.substring(0, 100)}`, 4);

        const conn = await pool.getConnection();
        try {
            const [results] = await conn.execute(renderedQuery);
            
            const result = {
                database: database,
                query: renderedQuery,
                rowsAffected: results.affectedRows || results.length,
                rows: Array.isArray(results) ? results : []
            };

            global.consoleLog('Persephone', `Query result: ${result.rowsAffected} rows affected/returned`, 4);
            return result;
        } finally {
            conn.release();
        }
    }

    /**
     * Execute condition step
     */
    async function executeCondition(step, variables) {
        const condition = env.renderString(step.condition, variables);
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
            env.renderString(step.action, variables);
        }
        return { action: 'executed' };
    }

    /**
     * Execute plugin step (render inputs and call plugin task)
     */
    async function executePlugin(step, variables) {
        const taskId = step.action;
        
        if (!taskId) {
            throw new Error('Plugin step requires action (task_id)');
        }

        global.consoleLog('Persephone', `Executing plugin task: ${taskId}`, 4);

        // Render taskInputs with current variables
        const renderedInputs = {};
        if (step.taskInputs && Array.isArray(step.taskInputs)) {
            for (const input of step.taskInputs) {
                if (input.name && input.value !== undefined) {
                    const renderResult = await renderTemplate(String(input.value), { CTX: variables, STEPS: variables.steps || {} });
                    if (!renderResult.success) {
                        throw new Error(`Input "${input.name}": ${renderResult.error}  (template: ${String(input.value).substring(0, 200)})`);
                    }
                    renderedInputs[input.name] = renderResult.result;
                }
            }
        }

        global.consoleLog('Persephone', `Rendered plugin inputs: ${JSON.stringify(renderedInputs)}`, 4);

        // Call plugins.executeTask - get Plugins from global scope at execution time
        if (!global.Plugins || !global.Plugins.executeTask) {
            throw new Error('Plugins module not available');
        }

        const result = await global.Plugins.executeTask(taskId, renderedInputs);
        
        if (!result.success) {
            throw new Error(`Plugin task failed: ${result.error || result.message}`);
        }

        return result;
    }

    /**
     * Returns a promise that rejects when the execution is cancelled
     */
    function cancellationPromise(executionId) {
        return new Promise((_, reject) => {
            const check = setInterval(() => {
                if (!activeExecutions[executionId]) {
                    clearInterval(check); // Execution finished normally, clean up
                } else if (activeExecutions[executionId].cancelled) {
                    clearInterval(check);
                    reject(new Error('Execution cancelled'));
                }
            }, 200);
        });
    }

    /**
     * Execute Kore action step (fetch action definition and execute code)
     */
    async function executeKore(step, variables, executionId) {
        const actionName = step.action;
        
        if (!actionName || actionName === 'None' || actionName === 'none') {
            global.consoleLog('Persephone', `Kore step has no action (None) - executing as passthrough`, 4);
            // No action to execute - step still runs for variable setting and transition evaluation
            return { type: 'Kore', status: 'executed', action: 'None' };
        }

        global.consoleLog('Persephone', `Executing Kore action: ${actionName}`, 4);

        // Fetch action definition from Resources (includes code)
        let actionDef;
        try {
            actionDef = await Resources.getWorkflowUtil(actionName);
        } catch (error) {
            throw new Error(`Failed to load Kore action "${actionName}": ${error.message}`);
        }

        if (!actionDef.enabled) {
            throw new Error(`Kore action "${actionName}" is not enabled`);
        }

        if (!actionDef.code) {
            throw new Error(`Kore action "${actionName}" has no executable code`);
        }

        // Render actionInputs with current variables
        const renderedInputs = {};
        if (step.actionInputs && typeof step.actionInputs === 'object') {
            for (const [key, value] of Object.entries(step.actionInputs)) {
                if (value !== undefined) {
                    const renderResult = await renderTemplate(String(value), { CTX: variables, STEPS: variables.steps || {} });
                    if (!renderResult.success) {
                        throw new Error(`Input "${key}": ${renderResult.error}  (template: ${String(value).substring(0, 200)})`);
                    }
                    renderedInputs[key] = renderResult.result;
                }
            }
        }

        global.consoleLog('Persephone', `Rendered Kore action inputs: ${JSON.stringify(renderedInputs)}`, 4);

        // Get action config with timeout and retries
        const config = actionDef.action_config || {};
        const timeout = config.timeout || 30000;
        const retries = config.retries || 0;

        // Execute the action code with retries
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                global.consoleLog('Persephone', `Executing Kore action "${actionName}" (attempt ${attempt + 1}/${retries + 1})`, 4);

                // Create an async function from the code string
                // Wrap the code in an async IIFE so 'await' works in the code body
                const actionFunc = new Function('inputs', `return (async () => { ${actionDef.code} })()`);

                // Execute with timeout
                const result = await Promise.race([
                    actionFunc(renderedInputs),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Action timeout after ${timeout}ms`)), timeout)
                    ),
                    cancellationPromise(executionId)
                ]);

                global.consoleLog('Persephone', `Kore action "${actionName}" completed successfully`, 3);
                return result;
            } catch (error) {
                lastError = error;
                global.consoleLog('Persephone', `Kore action "${actionName}" attempt ${attempt + 1} failed: ${error.message}`, 1);

                if (attempt < retries) {
                    global.consoleLog('Persephone', `Retrying Kore action "${actionName}"...`, 3);
                    // Optional: add delay between retries
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        // All retries exhausted
        throw lastError || new Error(`Kore action "${actionName}" failed after ${retries + 1} attempts`);
    }

    /**
     * Wait for a sub-workflow execution to complete by polling the DB directly
     */
    async function waitForExecution(subExecutionId) {
        const pollInterval = 500;
        const maxWait = 3600000;
        const deadline = Date.now() + maxWait;
        while (Date.now() < deadline) {
            const [rows] = await pools.kore_sys.execute(
                'SELECT status, results, context, errors FROM workflow_exec WHERE execution_id = ?',
                [subExecutionId]
            );
            if (!rows.length) throw new Error('Sub-workflow execution not found: ' + subExecutionId);
            const row = rows[0];
            if (!['running', 'pending'].includes(row.status)) {
                return {
                    status: row.status,
                    context: row.context ? (typeof row.context === 'string' ? JSON.parse(row.context) : row.context) : null,
                    errors: row.errors ? (typeof row.errors === 'string' ? JSON.parse(row.errors) : row.errors) : null
                };
            }
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
        throw new Error('Sub-workflow execution timed out: ' + subExecutionId);
    }

    /**
     * Resolve workflowInputs mapping against current variables, returning a plain parameters object
     */
    async function resolveWorkflowInputs(workflowInputs, renderContext) {
        const params = {};
        if (!workflowInputs || !Array.isArray(workflowInputs)) return params;
        for (const input of workflowInputs) {
            if (!input.name) continue;
            const val = input.value || '';
            if (val === '') {
                params[input.name] = '';
                continue;
            }
            const rendered = await renderTemplate(val, renderContext);
            params[input.name] = rendered.success ? rendered.result : '';
        }
        return params;
    }

    /**
     * Extract output variables from a completed sub-workflow's final CTX
     */
    function extractSubWorkflowOutputs(subWorkflowDef, finalCTX) {
        const outputs = {};
        const outputVars = subWorkflowDef.definition && subWorkflowDef.definition.outputVariables
            ? subWorkflowDef.definition.outputVariables : [];
        for (const v of outputVars) {
            if (v.name && finalCTX && v.name in finalCTX) {
                outputs[v.name] = finalCTX[v.name];
            }
        }
        return outputs;
    }

    /**
     * Create and start a sub-workflow execution, returning subExecutionId and workflow definition
     */
    async function createSubWorkflowExecution(workflowId, workflowVersion, parameters, parentExecutionId) {
        const conn = await pools.kore_sys.getConnection();
        try {
            const workflow = await Resources.getWorkflow(workflowId, workflowVersion);

            // Build input variables: workflow defaults merged with mapped parameters
            const inputVars = {};
            const inputVariables = workflow.definition.inputVariables || [];
            inputVariables.forEach(function(v) {
                inputVars[v.name] = v.value !== undefined ? v.value : '';
            });
            Object.assign(inputVars, parameters);

            const variables = Object.assign({}, inputVars, {
                _workflowId: workflowId,
                _workflowVersion: workflow.version,
                _startedAt: global.getTimestamp()
            });

            const initialCTX = {};
            for (const k in variables) {
                if (!k.startsWith('_') && k !== 'steps') initialCTX[k] = variables[k];
            }
            const initialContext = {
                CTX: initialCTX,
                STEPS: {},
                WORKFLOW: { workflowId: workflowId, workflowVersion: workflow.version, startedAt: global.getTimestamp() }
            };

            const insertSQL = 'INSERT INTO workflow_exec ' +
                '(workflow_id, workflow_version, triggered_by, triggered_by_user, variables, context, status, triggered_at, parent_execution_id) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)';
            const [okPacket] = await conn.execute(insertSQL, [
                workflowId,
                workflow.version,
                'subworkflow',
                'system',
                JSON.stringify(variables),
                JSON.stringify(initialContext),
                'running',
                parentExecutionId
            ]);

            const subExecutionId = okPacket.insertId;
            variables._executionId = subExecutionId;
            activeExecutions[subExecutionId] = { cancelled: false };

            // Fire off execution asynchronously
            executeWorkflowSteps(subExecutionId, workflow, variables).catch(function(err) {
                global.consoleLog('Persephone', 'Sub-workflow execution failed: ' + subExecutionId + ' ' + err.message, 1);
            });

            return { subExecutionId: subExecutionId, workflow: workflow };
        } finally {
            conn.release();
        }
    }

    /**
     * Execute a Workflow step — single run or loop run
     */
    async function executeWorkflowStep(step, variables, parentExecutionId) {
        const workflowId = step.action;
        if (!workflowId) throw new Error('Workflow step has no workflow selected');

        const renderContext = { CTX: variables, STEPS: variables.steps || {} };

        if (!step.loopMode) {
            // ── SINGLE RUN ──────────────────────────────────────────────
            const params = await resolveWorkflowInputs(step.workflowInputs, renderContext);
            const created = await createSubWorkflowExecution(workflowId, null, params, parentExecutionId);
            const subExecutionId = created.subExecutionId;
            const workflow = created.workflow;

            global.consoleLog('Persephone', 'Sub-workflow started: ' + subExecutionId, 3);

            const completed = await waitForExecution(subExecutionId);
            const finalCTX = (completed.context && completed.context.CTX) ? completed.context.CTX : {};
            const outputs = extractSubWorkflowOutputs(workflow, finalCTX);

            if (completed.status === 'failure') {
                global.consoleLog('Persephone', 'Sub-workflow ' + subExecutionId + ' failed', 2);
                return { result: outputs, executionId: subExecutionId, status: 'failure', subErrors: completed.errors || [] };
            }

            if (completed.status === 'warning') {
                global.consoleLog('Persephone', 'Sub-workflow ' + subExecutionId + ' completed with warnings', 2);
            }

            return { result: outputs, executionId: subExecutionId, status: completed.status, subErrors: completed.errors || [] };

        } else {
            // ── LOOP RUN ─────────────────────────────────────────────────
            const cfg = step.loopConfig || {};
            const executionMode = cfg.executionMode || 'concurrent';
            const maxConcurrent = Math.max(1, parseInt(cfg.maxConcurrent) || 1);
            const onItemFailure = cfg.onItemFailure || 'continue';

            if (!cfg.sourceArray) throw new Error('Loop mode requires a sourceArray');
            const arrayResult = await renderTemplate(cfg.sourceArray, renderContext);
            if (!arrayResult.success) throw new Error('Failed to resolve sourceArray: ' + arrayResult.error);
            const sourceArray = Array.isArray(arrayResult.result) ? arrayResult.result : [];

            global.consoleLog('Persephone', 'Loop run over ' + sourceArray.length + ' items (' + executionMode + ')', 3);

            const combinedResults = [];
            let hasFailure = false;

            if (executionMode === 'sequential') {
                for (let i = 0; i < sourceArray.length; i++) {
                    if (hasFailure && onItemFailure === 'stop') break;

                    const item = sourceArray[i];
                    const itemContext = { CTX: Object.assign({}, variables, { item: item }), STEPS: variables.steps || {} };
                    const params = await resolveWorkflowInputs(step.workflowInputs, itemContext);
                    const startedAt = Date.now();

                    try {
                        const created = await createSubWorkflowExecution(workflowId, null, params, parentExecutionId);
                        const completed = await waitForExecution(created.subExecutionId);
                        const finalCTX = (completed.context && completed.context.CTX) ? completed.context.CTX : {};
                        const outputs = extractSubWorkflowOutputs(created.workflow, finalCTX);

                        combinedResults.push({
                            index: i,
                            executionId: created.subExecutionId,
                            status: completed.status,
                            duration: Date.now() - startedAt,
                            outputs: outputs
                        });

                        if (completed.status === 'failure') {
                            hasFailure = true;
                            global.consoleLog('Persephone', 'Loop item ' + i + ' failed (sub-execution ' + created.subExecutionId + ')', 2);
                        }
                    } catch (err) {
                        hasFailure = true;
                        combinedResults.push({
                            index: i,
                            executionId: null,
                            status: 'failure',
                            duration: Date.now() - startedAt,
                            outputs: {},
                            error: err.message
                        });
                        global.consoleLog('Persephone', 'Loop item ' + i + ' error: ' + err.message, 2);
                    }
                }
            } else {
                // Concurrent — semaphore queue, starts next item as soon as a slot opens
                let inFlight = 0;
                let nextIndex = 0;
                const allResults = [];

                await new Promise(function(resolveQueue) {
                    function tryStart() {
                        while (inFlight < maxConcurrent && nextIndex < sourceArray.length) {
                            if (hasFailure && onItemFailure === 'stop') {
                                if (inFlight === 0) resolveQueue();
                                return;
                            }

                            const globalIdx = nextIndex++;
                            const item = sourceArray[globalIdx];
                            inFlight++;

                            const itemContext = { CTX: Object.assign({}, variables, { item: item }), STEPS: variables.steps || {} };
                            const startedAt = Date.now();

                            resolveWorkflowInputs(step.workflowInputs, itemContext)
                                .then(function(params) {
                                    return createSubWorkflowExecution(workflowId, null, params, parentExecutionId);
                                })
                                .then(function(created) {
                                    return waitForExecution(created.subExecutionId).then(function(completed) {
                                        const finalCTX = (completed.context && completed.context.CTX) ? completed.context.CTX : {};
                                        const outputs = extractSubWorkflowOutputs(created.workflow, finalCTX);
                                        return {
                                            index: globalIdx,
                                            executionId: created.subExecutionId,
                                            status: completed.status,
                                            duration: Date.now() - startedAt,
                                            outputs: outputs
                                        };
                                    });
                                })
                                .catch(function(err) {
                                    return {
                                        index: globalIdx,
                                        executionId: null,
                                        status: 'failure',
                                        duration: Date.now() - startedAt,
                                        outputs: {},
                                        error: err.message
                                    };
                                })
                                .then(function(result) {
                                    allResults.push(result);
                                    if (result.status === 'failure') {
                                        hasFailure = true;
                                        global.consoleLog('Persephone', 'Loop item ' + result.index + ' failed', 2);
                                    }
                                    inFlight--;
                                    if (nextIndex >= sourceArray.length && inFlight === 0) {
                                        resolveQueue();
                                    } else {
                                        tryStart();
                                    }
                                });
                        }

                        if (nextIndex >= sourceArray.length && inFlight === 0) {
                            resolveQueue();
                        }
                    }

                    tryStart();
                });

                allResults.sort(function(a, b) { return a.index - b.index; });
                combinedResults.push.apply(combinedResults, allResults);
            }

            if (hasFailure) {
                global.consoleLog('Persephone', 'Loop run completed with one or more failed items', 2);
            }

            const hasWarning = combinedResults.some(function(r) { return r.status === 'warning'; });
            if (hasWarning) {
                global.consoleLog('Persephone', 'Loop run completed with one or more warnings', 2);
            }

            // Collect sub-errors from warning/failure items
            const subErrors = combinedResults
                .filter(function(r) { return r.error || r.status === 'warning' || r.status === 'failure'; })
                .map(function(r) { return { index: r.index, executionId: r.executionId, error: r.error || ('Sub-workflow ' + r.executionId + ' completed with ' + r.status) }; });

            const overallStatus = hasFailure ? 'failure' : (hasWarning ? 'warning' : 'success');
            return { combined_results: combinedResults, status: overallStatus, subErrors: subErrors };
        }
    }

        /**
     * Record or update step execution in database
     * If stepExecutionId is provided, updates existing record
     * If stepExecutionId is not provided, inserts new record and returns the ID
     */
    async function recordStepExecution(executionId, stepId, stepType, status, output, error, duration, stepContext, stepName, executionSequence, stepExecutionId = null) {
        // If no stepExecutionId provided, this is a new record (INSERT)
        if (!stepExecutionId) {
            const [okPacket] = await pools.kore_sys.execute(
                `INSERT INTO workflow_exec_steps
                 (execution_id, step_id, step_name, step_type, status, output, error, duration_ms, context, started_at, completed_at, execution_sequence)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
                [
                    executionId,
                    stepId,
                    stepName,
                    stepType,
                    status,
                    output ? JSON.stringify(output) : null,
                    error,
                    duration || null,
                    stepContext ? JSON.stringify(stepContext) : null,
                    executionSequence
                ]
            );
            
            stepExecutionId = okPacket.insertId;
        } else {
            // stepExecutionId provided, update existing record
            await pools.kore_sys.execute(
                `UPDATE workflow_exec_steps 
                 SET status = ?, output = ?, error = ?, duration_ms = ?, context = ?, completed_at = NOW()
                 WHERE step_execution_id = ?`,
                [
                    status,
                    output ? JSON.stringify(output) : null,
                    error,
                    duration || null,
                    stepContext ? JSON.stringify(stepContext) : null,
                    stepExecutionId
                ]
            );
        }
        
        return stepExecutionId;
    }

    /**
     * Get execution status
     */
    async function getExecutionStatus(executionId) {
        const conn = await pools.kore_sys.getConnection();
        try {
            global.consoleLog('Persephone', `Getting execution status for: ${executionId}`, 4);
            
            const [execRows] = await conn.execute(
                `SELECT 
                    e.execution_id, e.workflow_id, e.workflow_version, e.status,
                    e.triggered_at, e.completed_at, e.duration_ms,
                    e.triggered_by, e.triggered_by_user,
                    e.results, e.errors, e.context,
                    w.name as workflow_name
                 FROM workflow_exec e
                 LEFT JOIN workflows w ON e.workflow_id = w.id
                 WHERE e.execution_id = ?`,
                [executionId]
            );

            if (execRows.length === 0) {
                throw new Error(`Execution not found: ${executionId}`);
            }
            
            global.consoleLog('Persephone', `Found execution, fetching steps...`, 4);

            const execution = execRows[0];

            // Get step details
            global.consoleLog('Persephone', `Getting steps for execution...`, 4);
            
            const [stepRows] = await conn.execute(
                `SELECT 
                    step_id, step_name, step_type, status,
                    started_at, completed_at, duration_ms,
                    output, error, execution_sequence
                 FROM workflow_exec_steps 
                 WHERE execution_id = ?
                 ORDER BY execution_sequence ASC`,
                [executionId]
            );
            
            global.consoleLog('Persephone', `Found ${stepRows.length} steps, building response...`, 4);

            global.consoleLog('Persephone', `Building response object with ${stepRows.length} steps...`, 4);
            
            const response = {
                executionId: execution.execution_id,
                workflowId: execution.workflow_id,
                workflowName: execution.workflow_name,
                workflowVersion: execution.workflow_version,
                status: execution.status,
                triggeredAt: execution.triggered_at,
                completedAt: execution.completed_at,
                duration: execution.duration_ms,
                results: (() => {
                    try {
                        return execution.results ? (typeof execution.results === 'string' ? JSON.parse(execution.results) : execution.results) : null;
                    } catch (e) {
                        global.consoleLog('Persephone', `Error parsing results: ${e.message}, data: ${String(execution.results).substring(0, 500)}`, 2);
                        return execution.results;
                    }
                })(),
                errors: (() => {
                    try {
                        return execution.errors ? (typeof execution.errors === 'string' ? JSON.parse(execution.errors) : execution.errors) : null;
                    } catch (e) {
                        global.consoleLog('Persephone', `Error parsing errors: ${e.message}, data: ${String(execution.errors).substring(0, 500)}`, 2);
                        return execution.errors;
                    }
                })(),
                context: (() => {
                    try {
                        return execution.context ? (typeof execution.context === 'string' ? JSON.parse(execution.context) : execution.context) : null;
                    } catch (e) {
                        global.consoleLog('Persephone', `Error parsing context: ${e.message}, data: ${String(execution.context).substring(0, 500)}`, 2);
                        return execution.context;
                    }
                })(),
                steps: stepRows.map(row => ({
                    stepId: row.step_id,
                    stepName: row.step_name,
                    stepType: row.step_type,
                    status: row.status,
                    startedAt: row.started_at,
                    completedAt: row.completed_at,
                    duration: row.duration_ms,
                    output: (() => {
                        try {
                            return row.output ? (typeof row.output === 'string' ? JSON.parse(row.output) : row.output) : null;
                        } catch (e) {
                            global.consoleLog('Persephone', `Error parsing step output for ${row.step_name}: ${e.message}, data: ${String(row.output).substring(0, 500)}`, 2);
                            return row.output;
                        }
                    })(),
                    error: row.error,
                    executionSequence: row.execution_sequence
                }))
            };
            
            global.consoleLog('Persephone', `Response object created, stringifying for JSON...`, 4);
            
            return response;
        } finally {
            conn.release();
        }
    }
    async function handleExecuteRequest(req, res) {
        handleExecuteWorkflow(req, res);
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
                global.consoleLog('Persephone', `Execute workflow error: ${error.message}`, 1);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }

    async function handleExecutionRequest(req, res) {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        const parts = pathname.split('/').filter(p => p);
        // parts: [engine, executions] or [engine, executions, :executionId] or [engine, executions, :executionId, cancel]

        if (req.method === 'GET' && parts.length === 3) {
            // GET /engine/executions/:executionId
            handleGetExecutionStatus(req, res, parts[2]);
        } else if (req.method === 'POST' && parts.length === 4 && parts[3] === 'cancel') {
            // POST /engine/executions/:executionId/cancel
            handleCancelExecution(req, res, parts[2]);
        } else if (req.method === 'GET' && parts.length === 2) {
            // GET /engine/executions
            handleListExecutions(req, res);
        } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
    }

    async function handleGetExecutionStatus(req, res, executionId) {
        try {
            global.consoleLog('Persephone', `handleGetExecutionStatus: calling getExecutionStatus for ${executionId}`, 4);
            const status = await getExecutionStatus(executionId);
            global.consoleLog('Persephone', `handleGetExecutionStatus: got status object, keys: ${Object.keys(status).join(', ')}`, 4);
            global.consoleLog('Persephone', `handleGetExecutionStatus: stringifying status...`, 4);
            const jsonStr = JSON.stringify(status);
            global.consoleLog('Persephone', `handleGetExecutionStatus: stringify successful, length: ${jsonStr.length}`, 4);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(jsonStr);
        } catch (error) {
            global.consoleLog('Persephone', `Get execution status error: ${error.message}`, 2);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async function handleCancelExecution(req, res, executionId) {
        const conn = await pools.kore_sys.getConnection();
        try {
            // Set cancellation flag
            if (activeExecutions[executionId]) {
                activeExecutions[executionId].cancelled = true;
            }
            
            // Update execution record in database - 'cancelling' until in-flight steps finish
            await conn.execute(
                `UPDATE workflow_exec SET status = ? WHERE execution_id = ?`,
                ['cancelling', executionId]
            );
            
            global.consoleLog('Persephone', `Execution cancelling: ${executionId}`, 3);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ executionId, status: 'cancelling', message: 'Execution cancelling' }));
        } catch (error) {
            global.consoleLog('Persephone', `Cancel execution error: ${error.message}`, 1);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        } finally {
            conn.release();
        }
    }

    async function handleListExecutions(req, res) {
        try {
            const url = require('url');
            const parsedUrl = url.parse(req.url, true);
            const query = parsedUrl.query;

            // Parse query parameters
            const limit = Math.min(parseInt(query.limit || '50', 10), 1000);  // Max 1000
            const offset = parseInt(query.offset || '0', 10);
            const status = query.status;  // Optional: filter by status
            const workflowId = query.workflowId;  // Optional: filter by workflow
            const showSubworkflows = query.showSubworkflows === 'true';  // Default: exclude subworkflows

            const conn = await pools.kore_sys.getConnection();
            try {
                // Build WHERE clause
                let whereConditions = [];
                let params = [];

                if (status) {
                    whereConditions.push('status = ?');
                    params.push(status);
                }
                if (workflowId) {
                    whereConditions.push('workflow_id = ?');
                    params.push(workflowId);
                }
                if (!showSubworkflows) {
                    whereConditions.push('parent_execution_id IS NULL');
                }

                const whereClause = whereConditions.length > 0 
                    ? 'WHERE ' + whereConditions.join(' AND ')
                    : '';

                // Get total count
                const [countRows] = await conn.execute(
                    `SELECT COUNT(*) as total FROM workflow_exec ${whereClause}`,
                    params
                );
                const total = countRows[0].total;

                // Get paginated results with workflow name
                const [rows] = await conn.execute(
                    `SELECT 
                        e.execution_id, e.workflow_id, e.workflow_version, e.status,
                        e.triggered_at, e.completed_at, e.duration_ms,
                        e.triggered_by, e.triggered_by_user,
                        w.name as workflow_name
                     FROM workflow_exec e
                     LEFT JOIN workflows w ON e.workflow_id = w.id
                     ${whereClause}
                     ORDER BY e.triggered_at DESC
                     LIMIT ${limit} OFFSET ${offset}`,
                    params
                );

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    executions: rows.map(row => ({
                        executionId: row.execution_id,
                        workflowId: row.workflow_id,
                        workflowName: row.workflow_name,
                        workflowVersion: row.workflow_version,
                        status: row.status,
                        triggeredAt: row.triggered_at,
                        completedAt: row.completed_at,
                        duration: row.duration_ms,
                        triggeredBy: row.triggered_by,
                        triggeredByUser: row.triggered_by_user
                    })),
                    total: total,
                    limit: limit,
                    offset: offset
                }));
            } finally {
                conn.release();
            }
        } catch (error) {
            global.consoleLog('Persephone', `List executions error: ${error.message}`, 1);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    /**
     * Automatically apply json filter to object/array outputs
     */
    function autoJsonFilter(template, context) {
        // Regex to find {{ ... }}, {{- ... }}, {{ ... -}}, or {{- ... -}} expressions
        // Matches patterns like: {{ VARIABLE }}, {{ VAR.prop }}, {{ VAR[0] }}, {{ VAR.prop[0].name }}
        const regex = /\{\{-?\s*([a-zA-Z_][a-zA-Z0-9_.\[\]]*)\s*-?\}\}/g;
        
        // Ensure template is a string
        if (typeof template !== 'string') {
            // If it's an object/array, stringify it
            if (typeof template === 'object' && template !== null) {
                return JSON.stringify(template);
            }
            // For numbers, booleans, etc., convert to string
            return String(template);
        }
        
        return template.replace(regex, (match, varName) => {
            // Parse variable name which may include array indices like CTX.test[0]
            // Split on dots for properties, but preserve brackets
            let value = context;
            let remaining = varName;
            
            // Handle array/property access: CTX.test[0].name
            const pattern = /^([a-zA-Z_][a-zA-Z0-9_]*)(.*)$/;
            let m = pattern.exec(remaining);
            
            if (m) {
                const firstKey = m[1];
                const rest = m[2];  // e.g., ".test[0].name"
                
                // Get initial value
                if (firstKey in context) {
                    value = context[firstKey];
                } else {
                    return match;  // Variable not found, return unchanged
                }
                
                // Parse remaining path like ".test[0].name"
                const pathPattern = /\.([a-zA-Z_][a-zA-Z0-9_]*)|(\[(\d+)\])/g;
                let pathMatch;
                while ((pathMatch = pathPattern.exec(rest)) !== null) {
                    if (pathMatch[1]) {
                        // Property access like .test
                        if (value && typeof value === 'object' && pathMatch[1] in value) {
                            value = value[pathMatch[1]];
                        } else {
                            value = undefined;
                            break;
                        }
                    } else if (pathMatch[3]) {
                        // Array access like [0]
                        const index = parseInt(pathMatch[3], 10);
                        if (Array.isArray(value) && index < value.length) {
                            value = value[index];
                        } else {
                            value = undefined;
                            break;
                        }
                    }
                }
            }
            
            // If the value is an object or array, wrap with json filter
            if (value !== null && typeof value === 'object') {
                // Preserve the whitespace control characters from the original match
                const hasLeadingDash = match.includes('{{-');
                const hasTrailingDash = match.includes('-}}');
                const leading = hasLeadingDash ? '{{- ' : '{{ ';
                const trailing = hasTrailingDash ? ' -}}' : ' }}';
                return `${leading}${varName} | json${trailing}`;
            }
            
            // Otherwise return unchanged
            return match;
        });
    }

    /**
     * Shared template pre-processing: autoJsonFilter, solo expression detection, block tag normalization
     */
    function preprocessTemplate(template, context) {
        // Ensure template is a string
        if (typeof template !== 'string') {
            if (typeof template === 'object' && template !== null) {
                template = JSON.stringify(template);
            } else {
                template = String(template);
            }
        }

        // Collapse multi-line {{ }} and {% %} expressions into single lines
        // Must happen before autoJsonFilter so regexes aren't confused by newlines
        const collapsedTemplate = template
            .replace(/\{\{([\s\S]*?)\}\}/g, (match, inner) => {
                if (!inner.includes('\n')) return match;
                return '{{' + inner.replace(/\s*\n\s*/g, ' ').trim() + '}}';
            })
            .replace(/\{%([\s\S]*?)%\}/g, (match, inner) => {
                if (!inner.includes('\n')) return match;
                return '{%' + inner.replace(/\s*\n\s*/g, ' ').trim() + '%}';
            });

        // Rewrite empty literal comparisons and in/not-in with [] or {} BEFORE autoJsonFilter
        // — autoJsonFilter injects | auto_json which breaks these pattern matches
        // == [] / != [] / == {} / != {}
        const preRewritten = collapsedTemplate
            .replace(/([^\s|({]+(?:\s*\|[^=!<>%}]+)?)\s*==\s*\[\s*\]/g, '$1 | deep_eq([])')
            .replace(/([^\s|({]+(?:\s*\|[^=!<>%}]+)?)\s*!=\s*\[\s*\]/g, '$1 | not_deep_eq([])')
            .replace(/([^\s|({]+(?:\s*\|[^=!<>%}]+)?)\s*==\s*\{\s*\}/g, '$1 | deep_eq({})')
            .replace(/([^\s|({]+(?:\s*\|[^=!<>%}]+)?)\s*!=\s*\{\s*\}/g, '$1 | not_deep_eq({})')
            .replace(/([^\s%}(]+(?:\s*\|[^%}]+?)?)\s+not\s+in\s+(\[[^\]]*(?:\[\s*\]|\{\s*\})[^\]]*\])/g, '$1 | not_in_list($2)')
            .replace(/([^\s%}(]+(?:\s*\|[^%}]+?)?)\s+in\s+(\[[^\]]*(?:\[\s*\]|\{\s*\})[^\]]*\])/g, '$1 | in_list($2)');

        // Auto-apply json filter to object/array outputs resolvable from context
        let processedTemplate = autoJsonFilter(preRewritten, context);

        // Normalize bare | d and | d() to | d(none) so the core default filter
        // receives an explicit null argument when none is specified
        processedTemplate = processedTemplate
            .replace(/\|\s*d\s*\(\s*\)/g, '| d(none)')
            .replace(/\|\s*d\s*(?!\s*[\(\w])/g, '| d(none)')
            .replace(/\|\s*default\s*\(\s*\)/g, '| default(none)')
            .replace(/\|\s*default\s*(?!\s*[\(\w])/g, '| default(none)');
        // Rewrite datetime comparison operators to filter calls so Nunjucks can evaluate them
        // e.g. "x | parse_datetime >= y" -> "x | parse_datetime | gte(y)"
        // Matches expressions inside {% %} and {{ }} blocks
        processedTemplate = processedTemplate
            .replace(/(\|\s*[\w_]+(?:\([^)]*\))?)\s*>=\s*([^\s%}][^%}]*?)(\s*(?:and|or|%|}}))/g, '$1 | gte($2)$3')
            .replace(/(\|\s*[\w_]+(?:\([^)]*\))?)\s*<=\s*([^\s%}][^%}]*?)(\s*(?:and|or|%|}}))/g, '$1 | lte($2)$3')
            .replace(/(\|\s*[\w_]+(?:\([^)]*\))?)\s*>\s*([^\s%}][^%}]*?)(\s*(?:and|or|%|}}))/g,  '$1 | gt($2)$3')
            .replace(/(\|\s*[\w_]+(?:\([^)]*\))?)\s*<\s*([^\s%}][^%}]*?)(\s*(?:and|or|%|}}))/g,  '$1 | lt($2)$3');

        // Rewrite .append(x) as .concat([x]) — append is not native to Nunjucks arrays
        // Also handle {% do list.append(x) %} by converting to {% set list = list.concat([x]) %}
        // Uses balanced-parentheses matching to handle nested parens in arguments
        processedTemplate = (function rewriteAppend(str) {
            let result = '';
            let i = 0;
            while (i < str.length) {
                // Look for varName.append(
                const appendIdx = str.indexOf('.append(', i);
                if (appendIdx === -1) { result += str.slice(i); break; }
                // Find the variable name before .append(
                let nameStart = appendIdx - 1;
                while (nameStart >= 0 && /[\w]/.test(str[nameStart])) nameStart--;
                nameStart++;
                const varName = str.slice(nameStart, appendIdx);
                // Find matching closing paren with depth tracking
                let depth = 1;
                let j = appendIdx + '.append('.length;
                while (j < str.length && depth > 0) {
                    if (str[j] === '(') depth++;
                    else if (str[j] === ')') depth--;
                    j++;
                }
                const arg = str.slice(appendIdx + '.append('.length, j - 1);
                result += str.slice(i, nameStart) + varName + '.concat([' + arg + '])';
                i = j;
            }
            // Rewrite {% do list.concat([x]) %} -> {%- set list = list.concat([x]) -%}
            return result.replace(/\{%-?\s*do\s+(\w+)\.concat\(\[([\s\S]*?)\]\)\s*-?%\}/g,
                '{%- set $1 = $1.concat([$2]) -%}');
        })(processedTemplate);

        // Detect if template is a solo output expression (only a single {{ }} with no surrounding text)
        const strippedForCheck = processedTemplate.replace(/\{%[\s\S]*?%\}/g, '').trim().replace(/\s+/g, ' ');
        const isSoloExpression = /^\{\{-?\s*[^}]+\s*-?\}\}$/.test(strippedForCheck);

        // If solo expression and no | auto_json already applied, inject | auto_json before the closing }}
        // auto_json only serializes objects/arrays, passes strings/primitives through unchanged
        if (isSoloExpression && !strippedForCheck.includes('| auto_json') && !strippedForCheck.includes('| json') && !strippedForCheck.includes('|json') && !strippedForCheck.includes('| in_list') && !strippedForCheck.includes('| not_in_list') && !strippedForCheck.includes('| deep_eq') && !strippedForCheck.includes('| not_deep_eq') && !strippedForCheck.includes('| is_empty')) {
            processedTemplate = processedTemplate.replace(
                /(\{\{-?\s*)([^}]+?)(\s*-?\}\})/,
                '$1$2 | auto_json$3'
            );
        }

        // Normalize block tags to always use whitespace control dashes
        processedTemplate = processedTemplate
            .replace(/\{%-/g, '\x00BLOCKOPEN\x00')
            .replace(/-%}/g, '\x00BLOCKCLOSE\x00')
            .replace(/\{#-/g, '\x00COMMENTOPEN\x00')
            .replace(/-#}/g, '\x00COMMENTCLOSE\x00')
            .replace(/\{%/g, '{%-')
            .replace(/%}/g, '-%}')
            .replace(/\{#/g, '{#-')
            .replace(/#}/g, '-#}')
            .replace(/\x00BLOCKOPEN\x00/g, '{%-')
            .replace(/\x00BLOCKCLOSE\x00/g, '-%}')
            .replace(/\x00COMMENTOPEN\x00/g, '{#-')
            .replace(/\x00COMMENTCLOSE\x00/g, '-#}');

        return processedTemplate;
    }

    /**
     * Render a Jinja2 template with given context
     */
    async function renderTemplate(template, context) {
        try {
            const processedTemplate = preprocessTemplate(template, context);
            
            // Render the template
            const result = env.renderString(processedTemplate, context);
            
            // If the result is valid JSON, return it as a parsed object so downstream
            // steps can access properties directly (e.g. CTX.first_result.id)
            try {
                const parsed = JSON.parse(result);
                return { success: true, result: parsed };
            } catch (e) {
                // Not JSON - return as plain string
                return { success: true, result: result };
            }
        } catch (error) {
            // Parse Nunjucks error to extract variable name and line info
            const errorInfo = parseNunjucksError(error, template);
            
            // If it's a null value (variable declared but set to none), treat as success
            if (errorInfo.isNull) {
                return { success: true, result: '' };
            }
            
            // If variable had | d or | default applied, return null as the default value
            if (errorInfo.isDefault) {
                return { success: true, result: null };
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
        
        // Check if this is a filter not found error
        const filterNotFoundMatch = message.match(/filter not found:\s*(\w+)/i) ||
                                    message.match(/unknown filter:\s*(\w+)/i) ||
                                    message.match(/filter\s+["']?(\w+)["']?\s+(not found|is not defined)/i);
        if (filterNotFoundMatch) {
            return {
                message: `Unknown filter: ${filterNotFoundMatch[1]} (Line ${lineNumber}, Column ${column})`,
                errorType: 'filter_not_found',
                filterName: filterNotFoundMatch[1],
                variable: 'unknown',
                lineNumber: lineNumber,
                column: column
            };
        }

        // Check if this is a filter error by parsing the message
        // Filters throw errors like "filter_name: error message"
        const filterMatch = message.match(/Error:\s*([a-z_]+):\s*(.+?)(?:\n|$)/i);
        if (filterMatch) {
            const filterName = filterMatch[1];
            const filterErrorMsg = filterMatch[2];
            return {
                message: `${filterName}: ${filterErrorMsg}`,
                errorType: 'filter_error',
                filterName: filterName,
                variable: 'unknown',
                lineNumber: lineNumber,
                column: column
            };
        }
        
        // Check if this is a syntax error
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
            
            // Pattern 1: {{ VARIABLE }} or {{- VARIABLE -}} (with optional whitespace-control dashes and array indices)
            let varMatch = errorLine.match(/\{\{-?\s*([a-zA-Z_][a-zA-Z0-9_.[\]]*)/);
            if (varMatch) {
                variable = varMatch[1];
            }
            // Pattern 2: {% for x in VARIABLE %}
            else if ((varMatch = errorLine.match(/\{%-?\s*for\s+\w+\s+in\s+([a-zA-Z_][a-zA-Z0-9_.[\]]*)/))) {
                variable = varMatch[1];
            }
            // Pattern 3: {% if VARIABLE %}
            else if ((varMatch = errorLine.match(/\{%-?\s*if\s+([a-zA-Z_][a-zA-Z0-9_.[\]]*)/))) {
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
        
        // Check if the error line uses | d or | default on this variable
        // If so, treat as null result rather than an error (throwOnUndefined fires before filters run)
        if (lineNumber > 0 && lineNumber <= lines.length) {
            const errorLine = lines[lineNumber - 1];
            if (/\|\s*(?:d|default)\s*(?:\(|\s*-?}}|\s*}})/i.test(errorLine)) {
                return {
                    message: '',
                    errorType: null,
                    variable: variable,
                    lineNumber: lineNumber,
                    column: column,
                    isDefault: true
                };
            }
        }
        
        // If we couldn't confidently identify a specific variable from the template line,
        // don't mislabel this as an undefined variable error - surface the original
        // Nunjucks error message instead so the real problem isn't masked.
        if (variable === 'unknown') {
            return {
                message: `${message} (Line ${lineNumber}, Column ${column})`,
                errorType: 'unrecognized_error',
                variable: variable,
                lineNumber: lineNumber,
                column: column
            };
        }
        
        // Format error message for truly undefined variable
        const errorMessage = `${variable} was not found (Line ${lineNumber}, Column ${column})`;
        
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
        global.consoleLog('Persephone', 'handleFilterRequest called', 4);
        try {
            // Parse URL to get filter name if specified
            const parsedUrl = url.parse(req.url, true);
            const filterName = parsedUrl.pathname.replace('/engine/filters', '').replace(/^\//, '');
            
            global.consoleLog('Persephone', `URL: ${req.url}`, 4);
            global.consoleLog('Persephone', `Pathname: ${parsedUrl.pathname}`, 4);
            global.consoleLog('Persephone', `FilterName: "${filterName}"`, 4);
            global.consoleLog('Persephone', `FilterName is empty? ${filterName === ''}`, 4);
            // Load filter definitions
            let filterDefs;
            try {
                const jsonPath = path.join(__dirname, 'filters', 'jinja-filters.json');
                global.consoleLog('Persephone', `Filter path: ${jsonPath}`, 4);
                const rawData = fs.readFileSync(jsonPath, 'utf8');
                global.consoleLog('Persephone', 'Filter file loaded successfully', 4);
                filterDefs = JSON.parse(rawData);
                global.consoleLog('Persephone', `filterDefs structure: ${JSON.stringify(Object.keys(filterDefs))}`, 4);
                global.consoleLog('Persephone', `filterDefs.filters exists? ${!!filterDefs.filters}`, 4);
                if (filterDefs.filters) {
                    global.consoleLog('Persephone', `filterDefs.filters is array? ${Array.isArray(filterDefs.filters)}`, 4);
                    global.consoleLog('Persephone', `filterDefs.filters length: ${filterDefs.filters.length}`, 4);
                }
            } catch (error) {
                global.consoleLog('Persephone', `Filter file error: ${error.message}`, 1);
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
            global.consoleLog('Persephone', `Returning ${filterDefs.filters.length} filters`, 4);
            global.consoleLog('Persephone', 'Sending response with status 200', 4);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const responseData = JSON.stringify(filterDefs);
            global.consoleLog('Persephone', `Response size: ${responseData.length} bytes`, 4);
            res.end(responseData);
            global.consoleLog('Persephone', 'Response sent', 4);
        } catch (error) {
            global.consoleLog('Persephone', `Filter request error: ${error.message}`, 1);
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
                    global.consoleLog('Persephone', `Template rendering error: ${error.message}`, 1);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                }
            });
        } catch (error) {
            global.consoleLog('Persephone', `Template rendering error: ${error.message}`, 1);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    // Public API
    return {
        initialize,
        executeWorkflow,
        getExecutionStatus,
        handleRequest,
        renderTemplate
    };
})();

module.exports = Persephone;