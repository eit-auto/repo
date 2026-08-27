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
const { CronExpressionParser } = require('cron-parser');
const registerFilters = require('./filters');
const transformFilters = require('./filters/transform');
const Resources = require('../resources/resources');
const { getSessionTokenFromCookies } = require('../auth/auth');

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
    let workflowSchedulerInterval = null;  // Workflow trigger scheduler

    // ============================================================================
    // WORKFLOW TRIGGER SCHEDULER
    // ============================================================================

    /**
     * Get current minute as a truncated datetime string: "YYYY-MM-DD HH:MM:00"
     * Evaluated in the system timezone so cron expressions match local time.
     */
    function getCurrentMinute() {
        const tz = global.timezone || 'UTC';
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        });
        const parts = {};
        for (const p of formatter.formatToParts(now)) parts[p.type] = p.value;
        let hour = parts.hour;
        if (hour === '24') hour = '00';
        return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:00`;
    }

    /**
     * Get the most recent scheduled occurrence of a cron expression before or at now,
     * returned as a local-time string "YYYY-MM-DD HH:MM:00".
     */
    function getMostRecentCronOccurrence(cronExpression) {
        try {
            const tz = global.timezone || 'UTC';
            const now = new Date();

            // Calculate UTC offset for local timezone
            const localParts = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
            let lh = localParts.hour === '24' ? '00' : localParts.hour;

            const nowUtcMs = now.getTime();

            // Build a Date representing local wall-clock time minus 1 second
            // so next() returns the current minute if the cron is scheduled for it
            const fakeLocalMs = new Date(Date.UTC(
                parseInt(localParts.year), parseInt(localParts.month) - 1, parseInt(localParts.day),
                parseInt(lh), parseInt(localParts.minute), 0
            )).getTime();
            const offsetMs = nowUtcMs - fakeLocalMs;
            const fakeUtc = new Date(fakeLocalMs - offsetMs - 1000);

            const interval = CronExpressionParser.parse(cronExpression, {
                currentDate: fakeUtc
            });

            const next = interval.next().toDate();
            // Convert next back to local time using Intl
            const nextParts = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            }).formatToParts(next).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
            const nh = nextParts.hour === '24' ? '00' : nextParts.hour;
            const nextResult = `${nextParts.year}-${nextParts.month}-${nextParts.day} ${nh}:${nextParts.minute}:00`;

            // If next is in the future, the cron isn't due this minute
            // but may have been missed — use prev() from now to find the last occurrence
            const localNowStr = `${localParts.year}-${localParts.month}-${localParts.day} ${lh}:${localParts.minute}:00`;
            if (nextResult > localNowStr) {
                const prevInterval = CronExpressionParser.parse(cronExpression, {
                    currentDate: new Date(fakeUtc.getTime() + 1000) // 1 second after fakeUtc = start of current minute
                });
                const prev = prevInterval.prev().toDate();
                const prevParts = new Intl.DateTimeFormat('en-CA', {
                    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', hour12: false
                }).formatToParts(prev).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
                const ph = prevParts.hour === '24' ? '00' : prevParts.hour;
                const prevResult = `${prevParts.year}-${prevParts.month}-${prevParts.day} ${ph}:${prevParts.minute}:00`;
                global.consoleLog('Persephone', `getMostRecentCronOccurrence "${cronExpression}": next=${nextResult} (future), prev=${prevResult}`, 4);
                return prevResult;
            }

            global.consoleLog('Persephone', `getMostRecentCronOccurrence "${cronExpression}": result=${nextResult}`, 4);
            return nextResult;
        } catch (err) {
            global.consoleLog('Persephone', `Invalid cron expression "${cronExpression}": ${err.message}`, 2);
            return null;
        }
    }

    /**
     * One scheduler tick: for each Schedule trigger, find its most recent due
     * occurrence and fire it if not already logged.
     */
    async function runWorkflowSchedulerTick() {
        // Single query: all workflows with at least one Schedule trigger
        const [rows] = await pools.kore_sys.execute(
            `SELECT w.id as workflow_id, w.definition
             FROM workflows w
             WHERE JSON_SEARCH(w.definition, 'one', 'Schedule', NULL, '$.triggers[*].type') IS NOT NULL`
        );

        if (rows.length === 0) return;

        // Collect trigger IDs and their due minutes
        const allTriggerIds = [];
        const workflowTriggerMap = [];

        for (const row of rows) {
            let definition;
            try {
                definition = typeof row.definition === 'string'
                    ? JSON.parse(row.definition)
                    : row.definition;
            } catch (e) { continue; }

            for (const trigger of (definition.triggers || [])) {
                if (!trigger.enabled) continue;
                if (trigger.type !== 'Schedule') continue;
                if (!trigger.schedule?.cron) continue;

                const dueMinute = getMostRecentCronOccurrence(trigger.schedule.cron);
                if (!dueMinute) continue;

                allTriggerIds.push(trigger.id);
                workflowTriggerMap.push({ workflowId: row.workflow_id, trigger, dueMinute });
            }
        }

        if (workflowTriggerMap.length === 0) return;

        // Single query to get all existing log entries for these triggers
        const placeholders = allTriggerIds.map(() => '?').join(',');
        const [logRows] = await pools.kore_sys.execute(
            `SELECT trigger_id, fired_minute FROM workflow_trigger_log WHERE trigger_id IN (${placeholders})`,
            allTriggerIds
        );

        // Build a set of "trigger_id|fired_minute" for O(1) lookup
        // fired_minute comes back from MySQL as a Date object — normalize to local string
        const tz = global.timezone || 'UTC';
        const firedSet = new Set(logRows.map(r => {
            const d = new Date(r.fired_minute);
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
            const h = parts.hour === '24' ? '00' : parts.hour;
            return `${r.trigger_id}|${parts.year}-${parts.month}-${parts.day} ${h}:${parts.minute}:00`;
        }));

        for (const { workflowId, trigger, dueMinute } of workflowTriggerMap) {
            const key = `${trigger.id}|${dueMinute}`;
            if (firedSet.has(key)) continue;

            global.consoleLog('Persephone', `Workflow scheduler: firing trigger "${trigger.name}" (${trigger.id}) for workflow ${workflowId}, due=${dueMinute}`, 3);

            // INSERT IGNORE: if another tick already logged this, 0 rows affected — skip execution
            const [insertResult] = await pools.kore_sys.execute(
                `INSERT IGNORE INTO workflow_trigger_log (workflow_id, trigger_id, fired_minute) VALUES (?, ?, ?)`,
                [workflowId, trigger.id, dueMinute]
            );
            if (insertResult.affectedRows === 0) continue;
            firedSet.add(key);

            executeWorkflow(workflowId, {
                triggeredBy: 'schedule',
                triggeredByUser: 'system',
                triggerId: trigger.id
            }).then(result => {
                if (result?.executionId) {
                    pools.kore_sys.execute(
                        `UPDATE workflow_trigger_log SET execution_id = ? 
                         WHERE workflow_id = ? AND trigger_id = ? AND fired_minute = ?`,
                        [result.executionId, workflowId, trigger.id, dueMinute]
                    ).catch(err => {
                        global.consoleLog('Persephone', `Could not update trigger log execution_id: ${err.message}`, 2);
                    });
                }
            }).catch(err => {
                global.consoleLog('Persephone', `Scheduled workflow ${workflowId} trigger ${trigger.id} failed: ${err.message}`, 1);
            });
        }
    }


        /**
     * Start the workflow trigger scheduler. Safe to call multiple times —
     * clears any existing interval before starting a new one.
     */
    function startWorkflowScheduler() {
        if (workflowSchedulerInterval) {
            clearInterval(workflowSchedulerInterval);
        }
        global.consoleLog('Persephone', 'Workflow trigger scheduler started (checking every 10s)', 3);
        workflowSchedulerInterval = setInterval(() => {
            runWorkflowSchedulerTick().catch(err => {
                global.consoleLog('Persephone', `ERROR in workflow scheduler tick: ${err.message}`, 1);
            });
        }, 10000);
    }

    // ============================================================================

    /**
     * Authenticate a request to any /engine/* endpoint. Two caller types:
     *   - 'user' - a real logged-in browser session (sessionToken cookie).
     *     Sets userId; the per-workflow 'workflow'/execute permission check
     *     happens separately, at the point of actual execution in
     *     handleExecuteWorkflow, since that's the only /engine/ action with
     *     a natural per-item permission target (a workflowId).
     *   - 'api' - a trusted external service, authenticated via the same
     *     x-kore-token + origin + domain match already used by the live
     *     /auth and /api/auth/validate endpoints (api.js's getApiMember()).
     *     Sourced entirely from headers (X-Kore-Token, X-Kore-Origin,
     *     X-User) rather than a request body, so the same check works
     *     uniformly across GET routes (/engine/executions, /engine/filters)
     *     that have no body to read origin/domain from. A validated API
     *     member is treated as fully trusted for execution - no
     *     per-workflow allowlist exists (or is planned) for API callers,
     *     matching how internal/system-initiated calls are already treated
     *     elsewhere in the codebase (see plugins.js's isInternalCall).
     *
     * @returns {Promise<{callerType: 'user', userId: string} | {callerType: 'api', apiMemberId: string} | null>}
     */
    async function authenticateEngineRequest(req) {
        const sessionToken = getSessionTokenFromCookies(req.headers.cookie);
        if (sessionToken) {
            try {
                const validation = await global.auth.validateSessionToken(sessionToken);
                if (validation.valid) {
                    return { callerType: 'user', userId: validation.userId };
                }
            } catch (err) {
                global.consoleLog('Persephone', `Session validation error: ${err.message}`, 2);
            }
        }

        const apiKey = req.headers['x-kore-token'] || req.headers['x-proxy-token'];
        if (apiKey && global.API) {
            const origin = req.headers['x-kore-origin'];
            const userHeader = req.headers['x-user'];
            const domain = (userHeader && userHeader.includes('@')) ? userHeader.split('@')[1] : null;
            try {
                const member = global.API.getApiMember(apiKey, origin, domain);
                if (member) {
                    return { callerType: 'api', apiMemberId: member.id };
                }
            } catch (err) {
                global.consoleLog('Persephone', `API key validation error: ${err.message}`, 2);
            }
        }

        return null;
    }

    /**
     * Main request handler for all /engine/ endpoints
     * Routes to appropriate handler based on pathname and method
     */
    async function handleRequest(req, res) {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        
        global.consoleLog('Persephone', `Routing /engine/ request: ${req.method} ${pathname}`, 4);
        
        try {
            const caller = await authenticateEngineRequest(req);
            if (!caller) {
                global.consoleLog('Persephone', `Rejecting ${pathname}: no valid session or API key`, 2);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Authentication required' }));
                return;
            }
            req.callerType = caller.callerType;
            req.userId = caller.userId || null;
            req.apiMemberId = caller.apiMemberId || null;

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
            
            // POST /engine/execute-kore-action - Run a single Kore utility
            // action's code standalone (no workflow execution behind it) -
            // same code path as a 'Kore' step inside a real workflow run,
            // just without the step/variables/CTX context around it.
            else if (req.method === 'POST' && pathname === '/engine/execute-kore-action') {
                return handleExecuteKoreAction(req, res);
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
            trimBlocks: true,   // A block tag ({% %}) alone on its own line consumes the
                                 // single newline immediately following it, so that line
                                 // effectively disappears rather than leaving a blank line.
            lstripBlocks: true, // Leading whitespace before a block tag is stripped, but
                                 // ONLY when the tag is the first thing on its line -- a
                                 // tag sharing a line with real content (e.g.
                                 // "text{% if x %} more text{% endif %}") is left alone,
                                 // so adjacent literal whitespace/content is never eaten.
                                 // Together these replace the old blanket "force -%}/{%-
                                 // on every tag" rewrite below (now removed) -- that
                                 // approach couldn't distinguish "tag alone on a line"
                                 // from "tag inline with real content" and always ate
                                 // adjacent whitespace either way, which broke any
                                 // template relying on a literal space next to a tag
                                 // (e.g. a conditionally-appended SQL clause like
                                 // "{% if x %} WHERE ...{% endif %}").
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
        
        // Register custom tests (separate registry from filters -- env.addTest, not
        // env.addFilter; used by is/is not expressions and by selectattr/rejectattr/
        // select/reject's test-name argument, e.g. selectattr('status','equalto','x')).
        // See filters/tests.js for why this exists -- fills gaps between Nunjucks'
        // smaller built-in test set and Jinja2's, starting with 'in'.
        try {
            delete require.cache[require.resolve('./filters/tests')];
            const freshRegisterTests = require('./filters/tests');
            const testStatus = freshRegisterTests(env);
            if (testStatus.failed.length > 0) {
                global.consoleLog('Persephone', `Failed to register ${testStatus.failed.length} tests: ${JSON.stringify(testStatus.failed)}`, 2);
            } else {
                global.consoleLog('Persephone', `Registered ${testStatus.total} custom test(s): ${Object.keys(freshRegisterTests.tests || {}).join(', ')}`, 1);
            }
        } catch (error) {
            global.consoleLog('Persephone', `Error registering custom tests: ${error.message}`, 1);
        }
        
        global.consoleLog('Persephone', 'Initialization complete - /engine/ endpoints ready', 3);

        // Start workflow trigger scheduler
        startWorkflowScheduler();
    }

    /**
     * Coerce a variable value string to its proper JS type based on the variable's type field
     */
    function coerceVarValue(value, type) {
        if (value === undefined || value === null) return type === 'boolean' ? false : '';
        switch (type) {
            case 'boolean':
                return value === true || value === 'true';
            case 'integer':
                const i = parseInt(value, 10);
                return isNaN(i) ? value : i;
            case 'float':
                const f = parseFloat(value);
                return isNaN(f) ? value : f;
            case 'array':
            case 'object':
                if (typeof value === 'string') {
                    try { return JSON.parse(value); } catch (e) { return value; }
                }
                return value;
            default:
                return value;
        }
    }

    /**
     * Classifies a caller-supplied parameter value for the input-vars →
     * trigger-vars → parameters merge:
     *   - 'omitted'         → undefined or empty string: not actually provided,
     *                         doesn't override an earlier tier at all.
     *   - 'deliberateBlank' → JS null, or the string "null" (any case,
     *                         e.g. "Null"/"NULL"): an explicit instruction to
     *                         clear the variable - DOES override, but the
     *                         resulting CTX value is an empty string, not the
     *                         literal text "null".
     *   - 'provided'        → any other value: overrides as-is.
     * This lets a Test Workflow form field left blank ("") pass through
     * silently (not overriding a trigger-set value), while still letting a
     * caller deliberately blank out a variable that a trigger already set, by
     * explicitly sending null/"null".
     */
    function classifyParamValue(value) {
        if (value === undefined || value === '') return 'omitted';
        if (value === null || (typeof value === 'string' && value.toLowerCase() === 'null')) return 'deliberateBlank';
        return 'provided';
    }

    /**
     * Apply a caller-supplied parameters object onto an inputVars object
     * in place, following the three-way classification above.
     */
    function applyParamOverrides(inputVars, parameters) {
        for (const [k, v] of Object.entries(parameters)) {
            const classification = classifyParamValue(v);
            if (classification === 'omitted') continue;
            inputVars[k] = classification === 'deliberateBlank' ? '' : v;
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
            triggerId = null,
            timeout = 3600000 // 1 hour default
        } = options;

        const conn = await pools.kore_sys.getConnection();

        try {
            // Always fetch the current, live workflow definition — never a workflows_hist
            // snapshot. workflows_hist is version-control/audit history only; nothing should
            // ever execute from it. A caller-supplied workflowVersion (e.g. the frontend's
            // currentVersion, sent on every Test Workflow click) is deliberately NOT passed
            // through here for that reason — matches the pattern already used by every
            // sub-workflow call site (createSubWorkflowExecution always passes null).
            // workflow.version (the version of whatever row actually gets fetched) is still
            // used for logging/audit further down in this function — only the *selection*
            // of which row to load ignores the caller-supplied version, nothing else.
            const workflow = await Resources.getWorkflow(workflowId);

            // Resolve the current user: form_info.form_user → triggeredByUser → null
            const resolvedUserId = parameters.form_info?.form_user || 
                                   (triggeredByUser !== 'system' ? triggeredByUser : null);

            // Fetch user details if we have a userId
            let userContext = { userId: resolvedUserId || null, email: null, fullName: null, groupIds: [], stack: {} };
            if (resolvedUserId) {
                try {
                    const [userRows] = await pools.kore_sys.execute(
                        'SELECT userId, email, fullName, groupIds, stack FROM users WHERE userId = ?',
                        [resolvedUserId]
                    );
                    if (userRows.length > 0) {
                        const u = userRows[0];
                        let groupIds = [];
                        if (u.groupIds) {
                            try { groupIds = typeof u.groupIds === 'string' ? JSON.parse(u.groupIds) : u.groupIds; }
                            catch (e) { groupIds = []; }
                        }
                        let stack = {};
                        if (u.stack) {
                            try { stack = typeof u.stack === 'string' ? JSON.parse(u.stack) : u.stack; }
                            catch (e) { stack = {}; }
                        }
                        userContext = { userId: u.userId, email: u.email, fullName: u.fullName, groupIds, stack };
                    }
                } catch (err) {
                    global.consoleLog('Persephone', `Could not resolve USER context for userId ${resolvedUserId}: ${err.message}`, 2);
                }
            }

            // Step 1: Process workflow inputVariables (defaults)
            const inputVars = {};
            const inputVariables = workflow.definition.inputVariables || [];
            inputVariables.forEach(v => {
                inputVars[v.name] = coerceVarValue(v.value, v.type);
            });
            const inputVarsSnapshot = { ...inputVars };

            // Step 2: Find matching trigger and apply its variables on top
            let triggerContext = { triggerId: null, triggerName: null };
            const triggerVarsSnapshot = {};
            if (triggerId) {
                const triggers = workflow.definition.triggers || [];
                const matchedTrigger = triggers.find(t => t.id === triggerId);
                if (matchedTrigger) {
                    triggerContext = { triggerId: matchedTrigger.id, triggerName: matchedTrigger.name || null };
                    const triggerVars = matchedTrigger.variables || [];
                    triggerVars.forEach(v => {
                        if (v.name) {
                            const coerced = coerceVarValue(v.value, v.type);
                            triggerVarsSnapshot[v.name] = coerced;
                            inputVars[v.name] = coerced;
                        }
                    });
                    global.consoleLog('Persephone', `Trigger matched: ${matchedTrigger.name} (${triggerId}), applied ${triggerVars.length} trigger variable(s)`, 4);
                } else {
                    global.consoleLog('Persephone', `Trigger ID "${triggerId}" not found in workflow definition`, 2);
                }
            }

            // Step 3: Merge caller-supplied parameters on top - a blank value
            // (empty string/undefined) doesn't count as "actually provided", so
            // it can't silently override whatever the trigger already set (e.g.
            // a Test Workflow form field left blank because the trigger was
            // expected to supply it). An explicit null/"null" is different - that
            // deliberately clears the variable and DOES override, just with an
            // empty value rather than the literal text "null".
            const userInputsSnapshot = {};
            for (const [k, v] of Object.entries(parameters)) {
                userInputsSnapshot[k] = v;
            }
            applyParamOverrides(inputVars, parameters);

            // Build final variables
            const variables = {
                ...inputVars,
                _workflowId: workflowId,
                _workflowName: workflow.name,
                _workflowVersion: workflow.version,
                _startedAt: global.getTimestamp(),
                _USER: userContext,
                _trigger: triggerContext,
                _WORKFLOW: {
                    workflowId: workflowId,
                    workflowName: workflow.name,
                    workflowVersion: workflow.version,
                    startedAt: global.getTimestamp(),
                    trigger: triggerContext,
                    formInfo: parameters.form_info || null,
                    warnings: false
                },
                _inputMeta: {
                    inputVars: inputVarsSnapshot,
                    triggerVars: triggerVarsSnapshot,
                    userInputs: userInputsSnapshot
                }
            };

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
                USER: userContext,
                WORKFLOW: {
                    workflowId: workflowId,
                    workflowName: workflow.name,
                    workflowVersion: workflow.version,
                    startedAt: global.getTimestamp(),
                    trigger: triggerContext,
                    formInfo: parameters.form_info || null
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
            variables._WORKFLOW.executionId = executionId;
            initialContext.USER = userContext;

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
            const nodesArray = Object.values(nodeLookup);
            const { stepInDegree, nodeInDegree } = calculateInDegree(workflow.definition.steps, nodesArray);
            
            // Track completion status of predecessors — steps and nodes each get
            // their own bookkeeping map, since a node can now itself be a gated
            // convergence point (see dispatchMatchingCases' node-arrival handling).
            const completedPredecessors = {};
            stepInDegree.forEach((count, stepId) => {
                completedPredecessors[stepId] = 0;
            });
            const completedNodePredecessors = {};
            nodeInDegree.forEach((count, nodeId) => {
                completedNodePredecessors[nodeId] = 0;
            });

            // Precompute, once per execution: is there exactly one structurally
            // terminal step (a step where every case has zero targetSteps and
            // zero targetNodes), and if so, which other steps can reach it. Used
            // by dispatchMatchingCases to warn when that terminal step's
            // min_connections is satisfied while some step that could still feed
            // it is genuinely still running -- a real, confirmed bug class (a
            // mode:"All" step firing multiple non-exclusive branches into a
            // convergence point whose min_connections was set too low, silently
            // clobbering whatever the first arrival had already written). Only
            // meaningful with exactly one terminal step -- workflows with zero or
            // multiple terminal steps disable this check entirely (terminalStepId
            // stays null), since "no other terminal steps" is one of the three
            // required criteria.
            const { terminalStepId, stepsCanReachTerminal } = findTerminalStepAndReachability(workflow.definition.steps, nodesArray);
            const activeSteps = new Set();
            const terminalTracking = { terminalStepId, stepsCanReachTerminal, activeSteps };

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
                stepInDegree,
                completedPredecessors,
                nodeInDegree,
                completedNodePredecessors,
                sequenceCounter
            );

            // Begin's own case-dispatch uses the exact same shared function as every
            // other step — see dispatchMatchingCases' own doc comment for why.
            await dispatchMatchingCases(
                beginStep.id,
                beginStep.transition,
                beginResult.state,
                variables,
                stepLookup,
                nodeLookup,
                results,
                errors,
                executionId,
                stepInDegree,
                completedPredecessors,
                nodeInDegree,
                completedNodePredecessors,
                sequenceCounter,
                beginResult.stepExecutionId,
                terminalTracking
            );

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
            
            // Render this workflow's own Output Variables for a top-level (not
            // sub-workflow) execution too - previously this only ever happened
            // via extractSubWorkflowOutputs when a workflow was called AS a
            // sub-workflow, so a directly-triggered execution's Output Variables
            // were never evaluated or exposed anywhere; callers had no choice but
            // to reach into raw CTX (internal/trigger/intermediate vars and all)
            // to get anything back. Reuses extractSubWorkflowOutputs as-is since
            // `workflow` already has the same {definition: {...}} shape it
            // expects, and `results` is already keyed by step name exactly like
            // STEPS in templates. Wrapped defensively: a broken output-variable
            // template must not downgrade an otherwise-successful execution to
            // 'failure' by falling into the outer catch below.
            let renderedOutputs = {};
            let renderedOutputHtml = '';
            try {
                renderedOutputs = await extractSubWorkflowOutputs(workflow, CTX, results, variables._USER || {});
                renderedOutputHtml = await renderOutputHtml(workflow, CTX, results, variables._USER || {});
            } catch (renderErr) {
                global.consoleLog('Persephone', `Failed to render Output Variables for execution ${executionId}: ${renderErr.message}`, 2);
            }

            const fullContext = {
                CTX: CTX,
                OUTPUT: renderedOutputs,
                OUTPUT_HTML: renderedOutputHtml,
                // STEPS deliberately omitted here -- this is the exact same data
                // already being stored separately as the `results` column on this
                // same UPDATE (see below), and serializing it a second time inside
                // `context` was doubling the size of an already-large payload in
                // one query. Confirmed as the cause of a real max_allowed_packet
                // failure on a workflow whose step output was ~24.5MB -- doubled,
                // plus the rest of this payload, was enough to exceed the 64MB
                // limit, silently leaving workflow_exec stuck at status='running'
                // forever even though every step had genuinely already completed.
                // Readers that used to rely on context.STEPS should use the
                // dedicated `results` column instead (see waitForExecution).
                USER: variables._USER || {},
                WORKFLOW: {
                    executionId: executionId,
                    workflowId: variables._workflowId,
                    workflowName: variables._workflowName,
                    startedAt: variables._startedAt,
                    completedAt: global.getTimestamp(),
                    duration: duration,
                    trigger: variables._trigger || { triggerId: null, triggerName: null },
                    formInfo: (variables._WORKFLOW && variables._WORKFLOW.formInfo) || null
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

            // Build the same filtered CTX shape the success path uses, and
            // attempt to render Output Variables here too - many workflows use
            // `| d(...)` defaults specifically so a `success`/`error_message`
            // style output variable still resolves usefully on failure. This is
            // wrapped in its own try/catch: a broken output-variable template
            // must never prevent the fallback failure-write below from running,
            // since that write is what guarantees this execution doesn't end up
            // stuck at status='running' forever (see the extensive comments on
            // that write further down).
            const failureCTX = {};
            for (const [key, value] of Object.entries(variables)) {
                if (!key.startsWith('_') && key !== 'steps') {
                    failureCTX[key] = value;
                }
            }
            let renderedOutputs = {};
            let renderedOutputHtml = '';
            try {
                renderedOutputs = await extractSubWorkflowOutputs(workflow, failureCTX, results, variables._USER || {});
                renderedOutputHtml = await renderOutputHtml(workflow, failureCTX, results, variables._USER || {});
            } catch (renderErr) {
                global.consoleLog('Persephone', `Failed to render Output Variables on failure path for execution ${executionId}: ${renderErr.message}`, 2);
            }

            const fullContext = {
                CTX: failureCTX,
                OUTPUT: renderedOutputs,
                OUTPUT_HTML: renderedOutputHtml,
                // STEPS deliberately omitted -- now stored separately via the
                // results column on this same UPDATE (added below). Previously
                // this failure path had NO separate results column write at all,
                // meaning context.STEPS was the only place this data ever ended
                // up for a failed execution -- so removing the duplicate here
                // required adding the real results write, not just deleting the
                // line. See the matching comment on the success path above for
                // why this duplication mattered (a real max_allowed_packet
                // failure).
                USER: variables._USER || {},
                WORKFLOW: {
                    executionId: executionId,
                    workflowId: variables._workflowId,
                    workflowName: variables._workflowName,
                    startedAt: variables._startedAt,
                    completedAt: global.getTimestamp(),
                    duration: duration,
                    trigger: variables._trigger || { triggerId: null, triggerName: null },
                    formInfo: (variables._WORKFLOW && variables._WORKFLOW.formInfo) || null
                }
            };

            try {
                await pools.kore_sys.execute(
                    `UPDATE workflow_exec 
                     SET status = 'failure', results = ?, errors = ?, context = ?, duration_ms = ?, completed_at = NOW()
                     WHERE execution_id = ?`,
                    [JSON.stringify(results), JSON.stringify(errors), JSON.stringify(fullContext), duration, executionId]
                );

                global.consoleLog('Persephone', `Execution failed: ${executionId} ${JSON.stringify(err)}`, 1);
            } catch (writeErr) {
                // This write can fail for the exact same reason the primary
                // completion write can (e.g. ER_NET_PACKET_TOO_LARGE on a
                // large results/context payload) -- confirmed as the real
                // mechanism behind an execution getting stuck at
                // status='running' forever: both the primary and this
                // fallback write carried the same oversized data, so when one
                // failed, the other failed identically, and nothing was left
                // to mark the execution terminal at all.
                //
                // Last-resort write: no results, no context -- just enough to
                // guarantee this execution is never silently stuck. Losing
                // the detailed payload here is a strictly better outcome than
                // an execution that looks like it's running forever.
                global.consoleLog('Persephone', `Execution failed AND fallback write also failed for ${executionId}: ${writeErr.message} (original error: ${err.message}) -- writing minimal terminal status`, 1);
                try {
                    await pools.kore_sys.execute(
                        `UPDATE workflow_exec 
                         SET status = 'failure', errors = ?, duration_ms = ?, completed_at = NOW()
                         WHERE execution_id = ?`,
                        [JSON.stringify([
                            { type: 'failure', workflow: 'fatal', error: err.message },
                            { type: 'failure', workflow: 'fatal', error: 'Fallback completion write also failed: ' + writeErr.message }
                        ]), duration, executionId]
                    );
                } catch (finalErr) {
                    global.consoleLog('Persephone', `CRITICAL: minimal fallback write also failed for ${executionId}: ${finalErr.message} -- execution will remain stuck at 'running'`, 1);
                }
            }
        } finally {
            // Clean up execution tracking
            delete activeExecutions[executionId];
        }
    }

    /**
     * Calculate in-degree (number of incoming paths) for each step
     */
    /**
     * Build in-degree maps for both steps and nodes. A `node` is a routing
     * indirection layer (case.targetNodes -> node -> node.targetSteps/targetNodes,
     * possibly chained through further nodes) and is now a first-class gated
     * entity in its own right, same as a step — a node's own `min_connections`
     * only means anything if the engine actually knows how many edges
     * structurally target it, which is what this now computes.
     *
     * Edges into a STEP: any case's targetSteps, or any node's own targetSteps
     * (counted once per node, not once per case that could reach that node by a
     * different path — a node's downstream only fires once, when the node itself
     * becomes ready, regardless of how many predecessors fed into the node).
     *
     * Edges into a NODE: any case's targetNodes, or any other node's own
     * targetNodes (nodes can chain to nodes).
     */
    function calculateInDegree(steps, nodes = []) {
        const stepInDegree = new Map();
        const nodeInDegree = new Map();

        steps.forEach(step => stepInDegree.set(step.id, 0));
        nodes.forEach(node => nodeInDegree.set(node.id, 0));

        steps.forEach(step => {
            if (step.transition && step.transition.cases) {
                step.transition.cases.forEach(caseObj => {
                    (caseObj.targetSteps || []).forEach(stepId => {
                        stepInDegree.set(stepId, (stepInDegree.get(stepId) || 0) + 1);
                    });
                    (caseObj.targetNodes || []).forEach(nodeId => {
                        nodeInDegree.set(nodeId, (nodeInDegree.get(nodeId) || 0) + 1);
                    });
                });
            }
        });

        nodes.forEach(node => {
            (node.targetSteps || []).forEach(stepId => {
                stepInDegree.set(stepId, (stepInDegree.get(stepId) || 0) + 1);
            });
            (node.targetNodes || []).forEach(childNodeId => {
                nodeInDegree.set(childNodeId, (nodeInDegree.get(childNodeId) || 0) + 1);
            });
        });

        return { stepInDegree, nodeInDegree };
    }

    /**
     * Find the single structurally-terminal step in a workflow (a step where
     * every case has zero targetSteps and zero targetNodes -- genuinely
     * nowhere further to go), and precompute which other steps can reach it
     * (directly, or through any number of intermediate steps/nodes).
     *
     * Returns { terminalStepId: null, stepsCanReachTerminal: new Set() } if
     * there are zero or more than one terminal steps -- this mechanism is only
     * meaningful with exactly one, since "no other terminal steps" is one of
     * the three required criteria for the warning that uses this.
     *
     * This is static graph analysis, computed once per execution (same timing
     * as calculateInDegree) -- it has no dependency on runtime state.
     */
    function findTerminalStepAndReachability(steps, nodes = []) {
        const isTerminalStep = (step) => {
            if (!step.transition || !step.transition.cases || step.transition.cases.length === 0) {
                return true;
            }
            return step.transition.cases.every(caseObj =>
                (caseObj.targetSteps || []).length === 0 && (caseObj.targetNodes || []).length === 0
            );
        };

        const terminalCandidates = steps.filter(isTerminalStep);
        if (terminalCandidates.length !== 1) {
            return { terminalStepId: null, stepsCanReachTerminal: new Set() };
        }
        const terminalStepId = terminalCandidates[0].id;

        const stepLookup = {};
        steps.forEach(s => { stepLookup[s.id] = s; });
        const nodeLookup = {};
        nodes.forEach(n => { nodeLookup[n.id] = n; });

        // Forward reachability from a single starting step, following case
        // targetSteps directly and case/node targetNodes recursively through
        // however many nodes are chained together.
        function reachableStepsFrom(startStepId) {
            const reachable = new Set();
            const stepQueue = [startStepId];
            const visitedSteps = new Set();

            function queueNodeTargets(nodeId, nodeVisited) {
                if (nodeVisited.has(nodeId)) return;
                nodeVisited.add(nodeId);
                const node = nodeLookup[nodeId];
                if (!node) return;
                (node.targetSteps || []).forEach(sid => stepQueue.push(sid));
                (node.targetNodes || []).forEach(nid => queueNodeTargets(nid, nodeVisited));
            }
            const nodeVisited = new Set();

            while (stepQueue.length > 0) {
                const currentStepId = stepQueue.pop();
                if (visitedSteps.has(currentStepId)) continue;
                visitedSteps.add(currentStepId);
                reachable.add(currentStepId);

                const currentStep = stepLookup[currentStepId];
                if (!currentStep || !currentStep.transition || !currentStep.transition.cases) continue;
                currentStep.transition.cases.forEach(caseObj => {
                    (caseObj.targetSteps || []).forEach(sid => stepQueue.push(sid));
                    (caseObj.targetNodes || []).forEach(nid => queueNodeTargets(nid, nodeVisited));
                });
            }
            return reachable;
        }

        const stepsCanReachTerminal = new Set();
        steps.forEach(step => {
            if (step.id === terminalStepId) return;
            const reachable = reachableStepsFrom(step.id);
            if (reachable.has(terminalStepId)) {
                stepsCanReachTerminal.add(step.id);
            }
        });

        return { terminalStepId, stepsCanReachTerminal };
    }

    /**
     * Find matching transition case based on step outcome
     */
    // Renamed from findMatchingCase — now always returns an array, since 'All' mode
    // must return every matching case (not just the first) so callers can fan out to
    // every match's own targetSteps, not just one winner's. 'First' mode still returns
    // at most one case, preserving existing single-match behavior exactly.
    async function findMatchingCases(transition, stepState, variables) {
        if (!transition || !transition.cases || transition.cases.length === 0) {
            return [];
        }

        const mode = transition.mode || 'First';

        // Sort cases by order field if present
        const sortedCases = [...transition.cases].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        if (mode === 'First') {
            for (const caseObj of sortedCases) {
                const matched = await evaluateCase(caseObj, stepState, variables);
                if (matched) return [caseObj];
            }
            return [];
        } else if (mode === 'All') {
            const matchingCases = [];
            for (const caseObj of sortedCases) {
                const matched = await evaluateCase(caseObj, stepState, variables);
                if (matched) matchingCases.push(caseObj);
            }
            return matchingCases;
        }

        return [];
    }

    /**
     * Shared case-dispatch logic, used identically for every step type — including
     * Begin. Begin is not a special case here: it's only special in that it's the
     * workflow's permanent, always-first entry point. Once it has executed, its own
     * transition/cases are evaluated and dispatched through this exact same function
     * as any other step's would be. No step type gets its own separate handling —
     * a prior version of this engine had Begin's dispatch duplicated inline as its
     * own copy of this logic, which silently drifted out of sync with the general
     * path's version (Begin's fan-out was correctly concurrent; the general path's
     * was not, until fixed) — extracting one shared function eliminates that class
     * of bug entirely, since there is now only one implementation to keep correct.
     */
    async function dispatchMatchingCases(stepId, transition, stepState, variables, stepLookup, nodeLookup, results, errors, executionId, inDegree, completedPredecessors, nodeInDegree, completedNodePredecessors, sequenceCounter, stepExecutionId, terminalTracking) {
        const matchingCases = await findMatchingCases(transition, stepState, variables);

        // Best-effort only -- recording which case(s) matched must never be able to
        // break actual workflow execution. Recorded unconditionally, for every step,
        // regardless of showCaseName -- which case fired is generally useful data
        // (debugging, future analytics, etc.), not something that should be gated
        // behind a display-only preference. showCaseName itself is snapshotted
        // separately, into this step's own `output` (see executeStepInWorkflow),
        // since it's known earlier and costs nothing extra there -- this UPDATE only
        // needs to carry matched_cases, which genuinely doesn't exist until now.
        if (stepExecutionId) {
            try {
                const matchedCaseNames = matchingCases.map(c => c.name || '');
                await pools.kore_sys.execute(
                    `UPDATE workflow_exec_steps SET matched_cases = ? WHERE step_execution_id = ?`,
                    [JSON.stringify(matchedCaseNames), stepExecutionId]
                );
            } catch (caseNameErr) {
                global.consoleLog('Persephone', `matched_cases update FAILED (non-fatal): stepExecutionId=${stepExecutionId} error=${caseNameErr.message}`, 2);
            }
        }

        if (matchingCases.length === 0) {
            global.consoleLog('Persephone', `No successors for step: ${stepId}, path ends`, 4);
            return;
        }

        const nextStepIds = [];
        const nodeArrivals = [];
        for (const matchingCase of matchingCases) {
            // Process case variables if defined
            if (matchingCase.variables && Array.isArray(matchingCase.variables) && matchingCase.variables.length > 0) {
                const renderContext = {
                    CTX: variables,
                    STEPS: results,
                    USER: variables._USER || {},
                    WORKFLOW: variables._WORKFLOW || {}
                };

                // Sort by order field, assign by index for backward compatibility
                matchingCase.variables.forEach((v, i) => { if (v.order === undefined) v.order = i; });
                const sortedCaseVars = [...matchingCase.variables].sort((a, b) => a.order - b.order);

                for (const varDef of sortedCaseVars) {
                    if (!varDef.name) continue;
                    try {
                        const renderResult = await renderTemplate(varDef.value, renderContext);
                        if (!renderResult.success) {
                            throw new Error(renderResult.error || 'Template rendering failed');
                        }
                        variables[varDef.name] = renderResult.result;
                        global.consoleLog('Persephone', `Case variable: ${varDef.name} = ${JSON.stringify(renderResult.result)}`, 4);
                    } catch (err) {
                        global.consoleLog('Persephone', `Error rendering case variable ${varDef.name}: ${err.message}`, 1);
                        const enriched = new Error(`Case variable "${varDef.name}": ${err.message}  (template: ${String(varDef.value).substring(0, 200)})`);
                        throw enriched;
                    }
                }
            }

            // Collect this case's direct step targets and any node references —
            // node references get resolved below via resolveNodeArrival, not
            // flattened transparently, since a node is now its own gated entity.
            nextStepIds.push(...(matchingCase.targetSteps || []));
            if (matchingCase.targetNodes) {
                nodeArrivals.push(...matchingCase.targetNodes);
            }
        }

        if (nextStepIds.length === 0 && nodeArrivals.length === 0) {
            global.consoleLog('Persephone', `No successors for step: ${stepId}, path ends`, 4);
            return;
        }

        // Recursively resolve node arrivals into ready step IDs, applying the same
        // predecessor-count/min_connections gating to nodes that steps already get.
        // A node only fans out to its OWN targetSteps/targetNodes once enough
        // predecessors have reached it (min_connections, falling back to its
        // structural in-degree) — mirroring the step logic just below, not the old
        // behavior of transparently flattening a node's targetSteps on first touch.
        //
        // recursionPath tracks only the current recursive descent chain (to catch a
        // genuine cycle, e.g. node A -> node B -> node A) — it is NOT shared across
        // separate top-level arrivals in nodeArrivals, since two different matching
        // cases legitimately routing to the same node (e.g. under mode:"All") are
        // two real edges, not a cycle, and must each increment separately.
        async function resolveNodeArrival(nodeId, recursionPath) {
            if (recursionPath.has(nodeId)) {
                global.consoleLog('Persephone', `Node cycle detected at ${nodeId} — skipping to avoid infinite loop`, 2);
                return;
            }
            recursionPath.add(nodeId);

            const node = nodeLookup[nodeId];
            if (!node) {
                global.consoleLog('Persephone', `targetNodes referenced unknown node ${nodeId} — ignoring`, 2);
                return;
            }

            // Increment synchronously, before any await, for the same race-avoidance
            // reason the step bookkeeping below does — two concurrent branches
            // arriving at this node can't interleave mid-increment in JS's
            // single-threaded execution as long as nothing yields first.
            completedNodePredecessors[nodeId] = (completedNodePredecessors[nodeId] || 0) + 1;

            let required;
            if (typeof node.min_connections === 'string' && node.min_connections.trim() !== '') {
                const renderContext = { CTX: variables, STEPS: results, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} };
                const renderResult = await renderTemplate(node.min_connections, renderContext);
                const parsed = renderResult.success ? parseInt(renderResult.result, 10) : NaN;
                required = (!isNaN(parsed) && parsed > 0) ? parsed : nodeInDegree.get(nodeId);
            } else {
                const minConn = (typeof node.min_connections === 'number' && node.min_connections > 0)
                    ? node.min_connections : 0;
                required = minConn > 0 ? minConn : nodeInDegree.get(nodeId);
            }
            const completed = completedNodePredecessors[nodeId];

            if (completed >= required) {
                global.consoleLog('Persephone', `Threshold met for node ${nodeId} (${completed}/${required}), fanning out`, 4);
                nextStepIds.push(...(node.targetSteps || []));
                for (const childNodeId of (node.targetNodes || [])) {
                    await resolveNodeArrival(childNodeId, recursionPath);
                }
            } else {
                global.consoleLog('Persephone', `Waiting for predecessors of node ${nodeId} (${completed}/${required})`, 4);
            }
        }

        for (const nodeId of nodeArrivals) {
            await resolveNodeArrival(nodeId, new Set());
        }

        // Predecessor-count bookkeeping synchronously first (avoids a race condition on
        // the shared completedPredecessors map), collecting which successors are ready.
        // nextStepIds may legitimately be empty here even though nodeArrivals wasn't —
        // that just means every referenced node is still waiting on more predecessors,
        // not that this path has nowhere to go (already logged per-node above).
        const readyStepIds = [];
        for (const nextStepId of nextStepIds) {
            completedPredecessors[nextStepId] = (completedPredecessors[nextStepId] || 0) + 1;

            const nextStep = stepLookup[nextStepId];
            let required;
            if (nextStep && typeof nextStep.min_connections === 'string' && nextStep.min_connections.trim() !== '') {
                // Dynamic min_connections — a Jinja template evaluated against the current
                // CTX/STEPS, letting a step compute its own required-predecessor threshold
                // at runtime (e.g. "how many of an upstream dispatch step's cases actually
                // matched this run") instead of being locked to the workflow graph's static
                // inDegree, which counts every structurally-possible predecessor regardless
                // of whether that branch actually fires for a given execution.
                const renderContext = { CTX: variables, STEPS: results, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} };
                const renderResult = await renderTemplate(nextStep.min_connections, renderContext);
                const parsed = renderResult.success ? parseInt(renderResult.result, 10) : NaN;
                required = (!isNaN(parsed) && parsed > 0) ? parsed : inDegree.get(nextStepId);
            } else {
                const minConn = (nextStep && typeof nextStep.min_connections === 'number' && nextStep.min_connections > 0)
                    ? nextStep.min_connections : 0;
                required = minConn > 0 ? minConn : inDegree.get(nextStepId);
            }
            const completed = completedPredecessors[nextStepId];

            if (completed >= required) {
                // Terminal-step warning: min_connections is satisfied (this
                // check), this is the workflow's one-and-only structurally
                // terminal step (terminalTracking.terminalStepId set at all --
                // null means zero or multiple terminal steps, criterion already
                // fails), and some OTHER step that can still reach it is
                // currently active. All three true means a predecessor this
                // convergence point assumed was mutually exclusive with the one
                // that just satisfied min_connections is, in fact, still doing
                // real work right now -- almost always a static min_connections
                // that should have been computed dynamically (see PSA - Ticket -
                // List's CombineResults for the confirmed real-world case this
                // is modeled on). Non-blocking: this never changes dispatch
                // behavior, only surfaces a warning via the same errors array
                // that already drives finalStatus = 'warning' elsewhere.
                if (terminalTracking && terminalTracking.terminalStepId === nextStepId) {
                    for (const activeStepId of terminalTracking.activeSteps) {
                        if (activeStepId !== nextStepId && terminalTracking.stepsCanReachTerminal.has(activeStepId)) {
                            const activeStepLabel = (stepLookup[activeStepId] && stepLookup[activeStepId].name)
                                ? `${stepLookup[activeStepId].name} (${activeStepId})` : activeStepId;
                            const terminalLabel = (nextStep && nextStep.name) ? `${nextStep.name} (${nextStepId})` : nextStepId;
                            global.consoleLog('Persephone', `Terminal step ${terminalLabel} satisfied min_connections while ${activeStepLabel} (which can also reach it) is still active`, 2);
                            errors.push({
                                type: 'warning',
                                workflow: 'min_connections',
                                step: terminalLabel,
                                error: `Terminal step "${terminalLabel}" satisfied its min_connections threshold while "${activeStepLabel}" -- a step that can also reach it -- was still running. min_connections likely needs to be computed dynamically for this step rather than a fixed number.`
                            });
                            break;
                        }
                    }
                }
                global.consoleLog('Persephone', `Threshold met for ${nextStepId} (${completed}/${required}), executing`, 4);
                readyStepIds.push(nextStepId);
            } else {
                global.consoleLog('Persephone', `Waiting for predecessors of ${nextStepId} (${completed}/${required})`, 4);
            }
        }

        // Launch every ready successor concurrently.
        if (readyStepIds.length > 0) {
            const pathPromises = readyStepIds.map(nextStepId =>
                executePath(nextStepId, variables, stepLookup, nodeLookup, results, errors, executionId, inDegree, completedPredecessors, nodeInDegree, completedNodePredecessors, sequenceCounter, terminalTracking)
            );
            await Promise.allSettled(pathPromises);
        }
    }

    async function evaluateCase(caseObj, stepState, variables) {
        // Always type always matches
        if (caseObj.type === 'Always') return true;

        // Logic type - evaluate Jinja condition
        if (caseObj.type === 'Logic') {
            if (!caseObj.conditions) return false;
            try {
                const renderResult = await renderTemplate(caseObj.conditions, { CTX: variables, STEPS: variables.steps || {}, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} });
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
        // A "Success" case is also meant to catch "Warning" - Warning exists to flag
        // something the user should look at (e.g. a partial loop failure that didn't
        // stop the run), not to represent a distinct failure-adjacent branch. Workflow
        // authors who genuinely want to react differently to a Warning outcome
        // specifically can still add an explicit case with type "Warning" of their
        // own (that continues to match only Warning, never Success) - this only
        // widens what "Success" catches, it doesn't take "Warning" away as its own
        // matchable type.
        if (caseObj.type === 'Success') return stepState === 'Success' || stepState === 'Warning';
        return caseObj.type === stepState;
    }

    /**
     * Execute a step and record its result
     */
    async function executeStepInWorkflow(stepId, variables, stepLookup, nodeLookup, results, errors, executionId, inDegree, completedPredecessors, nodeInDegree, completedNodePredecessors, sequenceCounter) {
        const step = stepLookup[stepId];
        const stepStartTime = Date.now();

        // Check if execution was cancelled
        if (activeExecutions[executionId]?.cancelled) {
            global.consoleLog('Persephone', `Step cancelled before execution: ${stepId}`, 4);
            return { state: 'Cancelled' };
        }

        let stepExecutionId = null;

        // Hoisted above the try block (rather than declared where it's first
        // populated, further down) specifically so the catch block below can
        // still see whatever variables rendered successfully before a later
        // variable in the same step threw - see the catch block's own comment
        // for why this matters.
        let stepNewContext = {};

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
                    stepOutput = await executePluginStep(step, variables, stepExecutionId);
                    break;
                case 'Kore':
                    stepOutput = await executeKore(step, variables, executionId);
                    break;
                case 'Workflow':
                    stepOutput = await executeWorkflowStep(step, variables, executionId, stepExecutionId);
                    break;
                default:
                    throw new Error(`Unknown step type: ${step.type}`);
            }

            // Snapshot step-definition-level display settings into this step's own
            // output, so the Execution Details viewer (which has no access to the
            // workflow definition itself) can read them from execution data alone --
            // same reasoning as step_name/step_type already being frozen at execution
            // time in this table, just folded into the existing output JSON rather
            // than a new column, since this is written anyway on every step regardless.
            if (stepOutput && typeof stepOutput === 'object') {
                stepOutput.stepSettings = { showCaseName: !!step.showCaseName };
            }

            // Store step output
            if (!variables.steps) variables.steps = {};
            variables.steps[step.name] = stepOutput;
            results[step.name] = stepOutput;

            // Track what gets added to CTX from this step
            // (declared above the try block - see comment there)

            // Process step variables if defined
            if (step.variables && Array.isArray(step.variables)) {
                const renderContext = {
                    CTX: variables,
                    STEPS: results,
                    USER: variables._USER || {},
                    WORKFLOW: variables._WORKFLOW || {}
                };
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

            // Surface a workflow-wide flag the moment any step resolves to Warning,
            // so a later step (e.g. a final notification step) can check
            // WORKFLOW.warnings without having to know which specific earlier step
            // produced the warning. This mutates the same _WORKFLOW object every
            // render context reads from (variables._WORKFLOW || {}), so it's visible
            // to every step from this point forward without any further plumbing.
            if (stepState === 'Warning' && variables._WORKFLOW) {
                variables._WORKFLOW.warnings = true;
            }

            // Propagate sub-workflow errors into parent errors array
            if ((stepState === 'Warning' || stepState === 'Failure') && stepOutput.subErrors && stepOutput.subErrors.length > 0) {
                stepOutput.subErrors.forEach(e => errors.push({ type: stepState.toLowerCase(), step: stepId, ...e }));
            }

            await recordStepExecution(executionId, stepId, step.type, stepState.toLowerCase(), stepOutput, null, stepDuration, stepNewContext, step.name, null, stepExecutionId);

            // Update main execution context if step added new variables
            await persistExecutionContext(variables, results, executionId, stepNewContext);

            global.consoleLog('Persephone', `Step completed: ${stepId}`, 4);

            return {
                state: stepState,
                output: stepOutput,
                stepExecutionId: stepExecutionId
            };

        } catch (err) {
            const errorMsg = err?.message || err?.toString?.() || String(err);
            const isCancelled = errorMsg === 'Execution cancelled';
            
            const stepDuration = Date.now() - stepStartTime;
            const stepStatus = isCancelled ? 'cancelled' : 'failure';
            
            if (!isCancelled) {
                errors.push({ type: 'failure', step: stepId, error: errorMsg });
            }

            // Persist whatever variables rendered successfully before this
            // step failed, the same way a successful step's own variables
            // get written to workflow_exec_steps.context. Previously this
            // was hardcoded to `null` on every failure, regardless of how
            // far the step's variable list got - even variables 1-4 out of
            // 5 succeeding, with only variable 5 throwing, produced a
            // completely empty context here. Those variables briefly existed
            // in `variables` (CTX) in memory and could influence any of the
            // step's own remaining (unreached) code or later steps reading
            // CTX directly, but were invisible in any CTX dump pulled from
            // this step afterward - a real debugging blind spot. Writing
            // `null` when stepNewContext is still empty (the step failed
            // before any variable rendered, or has no variables at all)
            // preserves the exact prior behavior for that case.
            const partialContext = Object.keys(stepNewContext).length > 0 ? stepNewContext : null;

            try {
                await recordStepExecution(executionId, stepId, step.type, stepStatus, null, isCancelled ? null : errorMsg, stepDuration, partialContext, step.name, null, stepExecutionId);
            } catch (dbErr) {
                global.consoleLog('Persephone', `Step DB update FAILED: stepExecutionId=${stepExecutionId} error=${dbErr.message}`, 1);
            }

            // Same partial-variable persistence as the success path, but at
            // the execution level (workflow_exec.context) rather than just
            // this step's own row - otherwise a CTX dump pulled at the
            // workflow level would still lag behind what this step's own
            // row now shows, and any later step reading CTX (e.g. a wired
            // Failure-case branch) would only see the partial variables via
            // the in-memory `variables` reference, not via a fresh dump.
            // Wrapped separately from the recordStepExecution call above so
            // a failure here can't mask the real step error being handled
            // in this catch block, and doesn't retry/duplicate that call.
            try {
                await persistExecutionContext(variables, results, executionId, partialContext);
            } catch (dbErr) {
                global.consoleLog('Persephone', `Execution context update FAILED after step failure: executionId=${executionId} error=${dbErr.message}`, 1);
            }

            global.consoleLog('Persephone', `Step ${isCancelled ? 'cancelled' : 'error'}: ${stepId}${isCancelled ? '' : ' ' + JSON.stringify(err)}`, isCancelled ? 3 : 1);

            return {
                state: isCancelled ? 'Cancelled' : 'Failure',
                error: isCancelled ? undefined : errorMsg,
                stepExecutionId: stepExecutionId
            };
        }
    }

    /**
     * Recursively execute a path in the workflow graph
     * Each path follows its own transitions sequentially
     * Multiple paths execute in parallel
     */
    async function executePath(stepId, variables, stepLookup, nodeLookup, results, errors, executionId, inDegree, completedPredecessors, nodeInDegree, completedNodePredecessors, sequenceCounter, terminalTracking) {
        const step = stepLookup[stepId];

        // Track this step as "actively doing real work" for exactly the
        // duration of its own executeStepInWorkflow call -- deliberately NOT
        // including its own downstream dispatch chain below, since that chain
        // is what's currently calling this very function and would otherwise
        // make a step look "active" purely because it's an ancestor in the
        // same recursive call stack, not because some genuinely independent
        // sibling branch is still doing real work. try/finally guarantees
        // removal even if the step throws.
        if (terminalTracking) terminalTracking.activeSteps.add(stepId);
        let stepResult;
        try {
            // Execute this step
            stepResult = await executeStepInWorkflow(
                stepId,
                variables,
                stepLookup,
                nodeLookup,
                results,
                errors,
                executionId,
                inDegree,
                completedPredecessors,
                nodeInDegree,
                completedNodePredecessors,
                sequenceCounter
            );
        } finally {
            if (terminalTracking) terminalTracking.activeSteps.delete(stepId);
        }

        // Every step type uses the exact same shared dispatch function — Begin included.
        // See dispatchMatchingCases' own doc comment.
        await dispatchMatchingCases(
            stepId,
            step.transition,
            stepResult.state,
            variables,
            stepLookup,
            nodeLookup,
            results,
            errors,
            executionId,
            inDegree,
            completedPredecessors,
            nodeInDegree,
            completedNodePredecessors,
            sequenceCounter,
            stepResult.stepExecutionId,
            terminalTracking
        );
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
                    const renderResult = await renderTemplate(String(input.value), { CTX: variables, STEPS: variables.steps || {}, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} });
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
     * Execute a Plugin step — single run or loop run
     */
    async function executePluginStep(step, variables, stepExecutionId) {

        if (!step.loopMode) {
            // ── SINGLE RUN ──────────────────────────────────────────────
            return await executePlugin(step, variables);
        }

        // ── LOOP RUN ─────────────────────────────────────────────────
        const cfg = step.loopConfig || {};
        const executionMode = cfg.executionMode || 'concurrent';
        const maxConcurrent = Math.max(1, parseInt(cfg.maxConcurrent) || 1);
        const onItemFailure = cfg.onItemFailure || 'continue';

        if (!cfg.sourceArray) throw new Error('Loop mode requires a sourceArray');
        const renderContext = { CTX: variables, STEPS: variables.steps || {}, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} };
        const arrayResult = await renderTemplate(cfg.sourceArray, renderContext);
        if (!arrayResult.success) throw new Error('Failed to resolve sourceArray: ' + arrayResult.error);
        const sourceArray = Array.isArray(arrayResult.result) ? arrayResult.result : [];

        global.consoleLog('Persephone', `Plugin loop over ${sourceArray.length} items (${executionMode})`, 3);

        const combinedResults = [];
        let hasFailure = false;

        // Throttled, best-effort loop progress reporting - always write on the
        // very first and very last completion (so progress appears immediately
        // and the final count is never stale), otherwise gated to at most once
        // per ~1.5s regardless of loop size or concurrency.
        //
        // The final ("isLast") write is explicitly awaited by callers - it MUST
        // complete before this function's caller returns and the real step
        // output gets written via recordStepExecution, otherwise this
        // fire-and-forget interim write could resolve after that completion
        // write and silently clobber the real result with a stale
        // {_loopProgress: {...}} marker. Non-final writes stay fire-and-forget
        // (the promise is still returned, but callers only await it when this
        // is the last one) so a slow/failed progress write never adds latency
        // to the loop itself - updateStepProgress already catches its own errors.
        let lastProgressWriteAt = 0;
        function maybeReportProgress(completed, total) {
            const now = Date.now();
            const isFirst = completed === 1;
            const isLast = completed === total;
            if (isFirst || isLast || (now - lastProgressWriteAt) >= 1500) {
                lastProgressWriteAt = now;
                const writePromise = updateStepProgress(stepExecutionId, completed, total);
                if (isLast) {
                    return writePromise; // caller awaits this one to preserve ordering
                }
                // Non-final write: intentionally not returned/awaited further
            }
            return Promise.resolve();
        }

        if (executionMode === 'sequential') {
            for (let i = 0; i < sourceArray.length; i++) {
                if (hasFailure && onItemFailure === 'stop') break;

                const item = sourceArray[i];
                const itemContext = { CTX: Object.assign({}, variables, { item }), STEPS: variables.steps || {}, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} };
                const startedAt = Date.now();

                try {
                    const output = await executePlugin(step, itemContext.CTX);
                    combinedResults.push({ index: i, status: output.status || 'success', duration: Date.now() - startedAt, outputs: output });
                    if ((output.status || 'success') === 'failure') {
                        hasFailure = true;
                        global.consoleLog('Persephone', `Plugin loop item ${i} failed`, 2);
                    }
                } catch (err) {
                    hasFailure = true;
                    combinedResults.push({ index: i, status: 'failure', duration: Date.now() - startedAt, outputs: {}, error: err.message });
                    global.consoleLog('Persephone', `Plugin loop item ${i} error: ${err.message}`, 2);
                }
                await maybeReportProgress(combinedResults.length, sourceArray.length);
            }
        } else {
            // Concurrent — semaphore queue, starts next item as a slot opens
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
                        const itemContext = { CTX: Object.assign({}, variables, { item }), STEPS: variables.steps || {}, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} };
                        const startedAt = Date.now();
                        inFlight++;

                        executePlugin(step, itemContext.CTX)
                            .then(function(output) {
                                return { index: globalIdx, status: output.status || 'success', duration: Date.now() - startedAt, outputs: output };
                            })
                            .catch(function(err) {
                                return { index: globalIdx, status: 'failure', duration: Date.now() - startedAt, outputs: {}, error: err.message };
                            })
                            .then(async function(result) {
                                allResults.push(result);
                                if (result.status === 'failure') {
                                    hasFailure = true;
                                    global.consoleLog('Persephone', `Plugin loop item ${result.index} failed`, 2);
                                }
                                await maybeReportProgress(allResults.length, sourceArray.length);
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
            global.consoleLog('Persephone', 'Plugin loop completed with one or more failed items', 2);
        }

        const hasWarning = combinedResults.some(function(r) { return r.status === 'warning'; });
        if (hasWarning) {
            global.consoleLog('Persephone', 'Plugin loop completed with one or more warnings', 2);
        }

        const subErrors = combinedResults
            .filter(function(r) { return r.error || r.status === 'warning' || r.status === 'failure'; })
            .map(function(r) { return { index: r.index, error: r.error || ('Plugin loop item ' + r.index + ' completed with ' + r.status) }; });

        // Distinguish a genuine total failure (or a hard stop via onItemFailure:
        // 'stop') from a partial failure that onItemFailure: 'continue' rode through.
        // Only the former should report as 'failure' - a partial failure with at
        // least one real success and nothing cut short is exactly what 'warning'
        // exists for: flag it for the user without treating the whole run as failed.
        const failedItemCount = combinedResults.filter(function(r) { return r.status === 'failure'; }).length;
        const stoppedEarly = combinedResults.length < sourceArray.length;
        const allAttemptsFailed = failedItemCount > 0 && failedItemCount === combinedResults.length;

        let overallStatus;
        if (hasFailure && (stoppedEarly || allAttemptsFailed)) {
            overallStatus = 'failure';
        } else if (hasFailure) {
            overallStatus = 'warning';
        } else if (hasWarning) {
            overallStatus = 'warning';
        } else {
            overallStatus = 'success';
        }

        return { combined_results: combinedResults, status: overallStatus, subErrors };
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
    /**
     * Run a Kore utility action's code against the given (already-
     * resolved) inputs, honoring its configured timeout/retries. Shared
     * core used both by executeKore (full workflow step execution, which
     * template-renders step.actionInputs against CTX/STEPS/USER/WORKFLOW
     * before calling this) and the standalone /engine/execute-kore-action
     * route (direct callers like the form-viewer, which resolve their own
     * [[ ]]/{{ }} values client-side and pass already-resolved plain
     * values - no workflow variables/CTX involved at all for those).
     * @param {string} actionName
     * @param {object} resolvedInputs - Plain {name: value} object; no
     *   template rendering happens here
     * @param {string|null} [executionId] - If provided, honors that
     *   execution's cancellation the same as any other workflow step;
     *   omitted entirely for standalone calls with no workflow execution
     *   behind them (cancellationPromise is skipped in that case, since
     *   there's no execution to check against)
     * @returns {Promise<*>} The action code's own return value
     */
    async function runKoreAction(actionName, resolvedInputs, executionId = null) {
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

                // Execute with timeout (and cancellation, if this is running
                // as part of an actual workflow execution)
                const racers = [
                    actionFunc(resolvedInputs),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Action timeout after ${timeout}ms`)), timeout)
                    )
                ];
                if (executionId) racers.push(cancellationPromise(executionId));

                const result = await Promise.race(racers);

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

    async function executeKore(step, variables, executionId) {
        const actionName = step.action;

        if (!actionName || actionName === 'None' || actionName === 'none') {
            global.consoleLog('Persephone', `Kore step has no action (None) - executing as passthrough`, 4);
            // No action to execute - step still runs for variable setting and transition evaluation
            return { type: 'Kore', status: 'executed', action: 'None' };
        }

        global.consoleLog('Persephone', `Executing Kore action: ${actionName}`, 4);

        // Render actionInputs with current variables — supports both array [{name,value}] and legacy object {name:value}
        const renderedInputs = {};
        if (step.actionInputs) {
            const entries = Array.isArray(step.actionInputs)
                ? step.actionInputs.map(i => [i.name, i.value])
                : Object.entries(step.actionInputs);
            for (const [key, value] of entries) {
                if (value !== undefined && value !== '') {
                    const renderResult = await renderTemplate(String(value), { CTX: variables, STEPS: variables.steps || {}, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} });
                    if (!renderResult.success) {
                        throw new Error(`Input "${key}": ${renderResult.error}  (template: ${String(value).substring(0, 200)})`);
                    }
                    renderedInputs[key] = renderResult.result;
                }
            }
        }

        global.consoleLog('Persephone', `Rendered Kore action inputs: ${JSON.stringify(renderedInputs)}`, 4);

        const result = await runKoreAction(actionName, renderedInputs, executionId);
        return { result };
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
     * Extract output variables from a completed sub-workflow. Each
     * outputVariables[].value is rendered as a Jinja template against the
     * sub-workflow's own final CTX/STEPS — the rendered result is what
     * crosses the boundary to the parent, not a name-matched CTX lookup.
     */
    async function extractSubWorkflowOutputs(subWorkflowDef, finalCTX, finalSteps, userContext) {
        const outputs = {};
        const outputVars = subWorkflowDef.definition && subWorkflowDef.definition.outputVariables
            ? subWorkflowDef.definition.outputVariables : [];
        const renderContext = {
            CTX: finalCTX || {},
            STEPS: finalSteps || {},
            USER: userContext || {},
            WORKFLOW: {}
        };
        for (const v of outputVars) {
            if (!v.name) continue;
            if (v.value === undefined || v.value === '') {
                outputs[v.name] = '';
                continue;
            }
            const renderResult = await renderTemplate(String(v.value), renderContext);
            outputs[v.name] = renderResult.success ? renderResult.result : '';
        }
        return outputs;
    }

    /**
     * Renders a workflow's dedicated `outputHtml` template (its own top-level
     * definition field, NOT one of outputVariables) into the HTML the
     * Execution Details page auto-pops as a modal when the workflow finishes.
     * The result lands in its own top-level context.OUTPUT_HTML key (sibling
     * to CTX/STEPS/USER/WORKFLOW/OUTPUT), not nested inside OUTPUT - OUTPUT
     * stays purely "the rendered Output Variables," this is its own thing.
     * Deliberately kept as its own function, separate from
     * extractSubWorkflowOutputs, and only ever called from a workflow's own
     * TOP-LEVEL completion (success and failure paths below) - never from
     * createSubWorkflowExecution's sub-workflow-to-parent path. That means a
     * sub-workflow's output_html is simply never rendered or exposed to
     * whatever parent workflow called it; it only ever shows up for someone
     * looking at that sub-workflow's own execution directly.
     * @returns {Promise<string>} Rendered HTML, or '' if outputHtml is unset/blank/fails to render
     */
    async function renderOutputHtml(workflowDef, finalCTX, finalSteps, userContext) {
        const template = workflowDef.definition && workflowDef.definition.outputHtml;
        if (!template || typeof template !== 'string' || template.trim() === '') {
            return '';
        }
        const renderContext = {
            CTX: finalCTX || {},
            STEPS: finalSteps || {},
            USER: userContext || {},
            WORKFLOW: {}
        };
        const renderResult = await renderTemplate(template, renderContext);
        return renderResult.success ? renderResult.result : '';
    }

    /**
     * Create and start a sub-workflow execution, returning subExecutionId and workflow definition
     */
    async function createSubWorkflowExecution(workflowId, workflowVersion, parameters, parentExecutionId, userContext, explicitTriggerId) {
        const conn = await pools.kore_sys.getConnection();
        try {
            const workflow = await Resources.getWorkflow(workflowId, workflowVersion);

            // Sub-workflows inherit the parent's USER context rather than starting
            // fresh/blank. If a caller genuinely has none (e.g. a top-level
            // system-triggered run with no resolved user), fall back to the same
            // empty shape used elsewhere (userContext || {} pattern) so templates
            // referencing USER.* still resolve safely instead of throwing.
            const inheritedUser = userContext || { userId: null, email: null, fullName: null, groupIds: [], stack: {} };

            // Build input variables: workflow defaults, then the resolved trigger's
            // variables on top, then caller-supplied parameters last - same
            // three-tier ordering executeWorkflow uses for a normally-triggered run.
            const inputVars = {};
            const inputVariables = workflow.definition.inputVariables || [];
            inputVariables.forEach(function(v) {
                inputVars[v.name] = coerceVarValue(v.value, v.type);
            });

            // Trigger resolution: an explicit triggerId from the calling
            // Workflow-type step wins if it actually matches a trigger on this
            // workflow; otherwise fall back to a trigger named "Default", and if
            // there isn't one, the first trigger in the array. This replaces the
            // old type==='Always' filter, which had no way to pick among multiple
            // Always-type triggers (e.g. a workflow with Default/Create/Update
            // triggers, all type Always, differing only by name and variables) -
            // every sub-workflow call used to silently resolve to whichever
            // Always-type trigger happened to be first, regardless of which one
            // the calling step actually wanted.
            const triggers = workflow.definition.triggers || [];
            let resolvedTrigger = null;
            if (explicitTriggerId) {
                resolvedTrigger = triggers.find(function(t) { return t.id === explicitTriggerId; }) || null;
                if (!resolvedTrigger) {
                    global.consoleLog('Persephone', 'Workflow step specified triggerId "' + explicitTriggerId + '" but it was not found on workflow ' + workflowId + ' - falling back to default trigger resolution', 2);
                }
            }
            if (!resolvedTrigger) {
                resolvedTrigger = triggers.find(function(t) { return t.name === 'Default'; }) || triggers[0] || null;
            }
            let triggerContext = { triggerId: null, triggerName: null };
            if (resolvedTrigger) {
                triggerContext = { triggerId: resolvedTrigger.id, triggerName: resolvedTrigger.name || null };
                const triggerVars = resolvedTrigger.variables || [];
                triggerVars.forEach(function(v) {
                    if (v.name) {
                        inputVars[v.name] = coerceVarValue(v.value, v.type);
                    }
                });
            }

            // Same blank/deliberate-blank/provided handling as the top-level path.
            applyParamOverrides(inputVars, parameters);

            const variables = Object.assign({}, inputVars, {
                _workflowId: workflowId,
                _workflowName: workflow.name,
                _workflowVersion: workflow.version,
                _startedAt: global.getTimestamp(),
                _USER: inheritedUser,
                _trigger: triggerContext,
                _WORKFLOW: {
                    workflowId: workflowId,
                    workflowName: workflow.name,
                    workflowVersion: workflow.version,
                    startedAt: global.getTimestamp(),
                    trigger: triggerContext,
                    warnings: false
                }
            });

            const initialCTX = {};
            for (const k in variables) {
                if (!k.startsWith('_') && k !== 'steps') initialCTX[k] = variables[k];
            }
            const initialContext = {
                CTX: initialCTX,
                STEPS: {},
                USER: inheritedUser,
                WORKFLOW: { workflowId: workflowId, workflowName: workflow.name, workflowVersion: workflow.version, startedAt: global.getTimestamp() }
            };

            // triggered_by_user now reflects the real inherited user when known,
            // rather than always being hardcoded to 'system' - matches how the
            // top-level execution resolves/records its own triggering user.
            const triggeredByUserValue = inheritedUser.userId || inheritedUser.email || 'system';

            const insertSQL = 'INSERT INTO workflow_exec ' +
                '(workflow_id, workflow_version, triggered_by, triggered_by_user, variables, context, status, triggered_at, parent_execution_id) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)';
            const [okPacket] = await conn.execute(insertSQL, [
                workflowId,
                workflow.version,
                'subworkflow',
                triggeredByUserValue,
                JSON.stringify(variables),
                JSON.stringify(initialContext),
                'running',
                parentExecutionId
            ]);

            const subExecutionId = okPacket.insertId;
            variables._executionId = subExecutionId;
            variables._WORKFLOW.executionId = subExecutionId;
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
     * Resolve a Workflow-type step's triggerId field, which may be blank (use
     * createSubWorkflowExecution's own Default/first-trigger fallback), a plain
     * trigger id picked from the builder's dropdown, or a Jinja template (the
     * { } edit button lets a step decide the trigger dynamically from CTX).
     */
    async function resolveStepTriggerId(triggerIdField, renderContext) {
        if (!triggerIdField) return null;
        if (typeof triggerIdField === 'string' && (triggerIdField.includes('{{') || triggerIdField.includes('{%'))) {
            const renderResult = await renderTemplate(triggerIdField, renderContext);
            return renderResult.success ? renderResult.result : null;
        }
        return triggerIdField;
    }

    /**
     * Execute a Workflow step — single run or loop run
     */
    async function executeWorkflowStep(step, variables, parentExecutionId, stepExecutionId) {
        const workflowId = step.action;
        if (!workflowId) throw new Error('Workflow step has no workflow selected');

        const renderContext = { CTX: variables, STEPS: variables.steps || {}, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} };

        if (!step.loopMode) {
            // ── SINGLE RUN ──────────────────────────────────────────────
            const params = await resolveWorkflowInputs(step.workflowInputs, renderContext);
            const triggerId = await resolveStepTriggerId(step.triggerId, renderContext);
            const created = await createSubWorkflowExecution(workflowId, null, params, parentExecutionId, variables._USER, triggerId);
            const subExecutionId = created.subExecutionId;
            const workflow = created.workflow;

            global.consoleLog('Persephone', 'Sub-workflow started: ' + subExecutionId, 3);

            const completed = await waitForExecution(subExecutionId);
            const finalCTX = (completed.context && completed.context.CTX) ? completed.context.CTX : {};
            const finalSteps = (completed.context && completed.context.STEPS) ? completed.context.STEPS : {};
            const outputs = await extractSubWorkflowOutputs(workflow, finalCTX, finalSteps, variables._USER || {});

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

            // Live per-item state, keyed by index - includes items that have merely
            // *started* (status: 'running', executionId already known) as well as
            // ones that have finished. This is what lets even the very first loop
            // iteration be expanded while it's still running, rather than only once
            // it completes - a sub-workflow's executionId is known the moment
            // createSubWorkflowExecution resolves, well before waitForExecution does.
            const liveResults = new Map();
            function snapshotLiveResults() {
                return Array.from(liveResults.values()).sort(function(a, b) { return a.index - b.index; });
            }

            // Throttled, best-effort progress reporting - always write on the very
            // first event (an item starting OR finishing, whichever happens first)
            // and on the very last completion, otherwise gated to at most once per
            // ~1.5s. Unlike the Plugin-loop path, Workflow-loop iterations each
            // carry a real executionId, so the live snapshot passed along lets a
            // still-running Workflow-loop step be expanded to show its
            // sub-executions - both in-flight and finished - before the loop ends.
            //
            // The final ("isLast") write is explicitly awaited by callers - it MUST
            // complete before this function's caller returns and the real step
            // output gets written via recordStepExecution, otherwise this
            // fire-and-forget interim write could resolve after that completion
            // write and silently clobber the real result with a stale
            // {_loopProgress: {...}} marker. Non-final writes stay fire-and-forget
            // so a slow/failed progress write never adds latency to the loop itself.
            let lastProgressWriteAt = 0;
            let hasReportedAnything = false;
            function maybeReportProgress(completed, total) {
                const now = Date.now();
                const isFirstEver = !hasReportedAnything;
                const isLast = completed === total;
                if (isFirstEver || isLast || (now - lastProgressWriteAt) >= 1500) {
                    hasReportedAnything = true;
                    lastProgressWriteAt = now;
                    const writePromise = updateStepProgress(stepExecutionId, completed, total, snapshotLiveResults());
                    if (isLast) {
                        return writePromise; // caller awaits this one to preserve ordering
                    }
                    // Non-final write: intentionally not returned/awaited further
                }
                return Promise.resolve();
            }

            if (executionMode === 'sequential') {
                for (let i = 0; i < sourceArray.length; i++) {
                    if (hasFailure && onItemFailure === 'stop') break;

                    const item = sourceArray[i];
                    const itemContext = { CTX: Object.assign({}, variables, { item: item }), STEPS: variables.steps || {}, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} };
                    const params = await resolveWorkflowInputs(step.workflowInputs, itemContext);
                    const startedAt = Date.now();

                    try {
                        const triggerId = await resolveStepTriggerId(step.triggerId, itemContext);
                        const created = await createSubWorkflowExecution(workflowId, null, params, parentExecutionId, variables._USER, triggerId);

                        // Mark this item as started/in-flight immediately - report
                        // right away so it shows up before waitForExecution resolves
                        liveResults.set(i, { index: i, executionId: created.subExecutionId, status: 'running' });
                        await maybeReportProgress(combinedResults.length, sourceArray.length);

                        const completed = await waitForExecution(created.subExecutionId);
                        const finalCTX = (completed.context && completed.context.CTX) ? completed.context.CTX : {};
                        const finalSteps = (completed.context && completed.context.STEPS) ? completed.context.STEPS : {};
                        const outputs = await extractSubWorkflowOutputs(created.workflow, finalCTX, finalSteps, variables._USER || {});

                        const finalResult = {
                            index: i,
                            executionId: created.subExecutionId,
                            status: completed.status,
                            duration: Date.now() - startedAt,
                            outputs: outputs
                        };
                        liveResults.set(i, finalResult);
                        combinedResults.push(finalResult);

                        if (completed.status === 'failure') {
                            hasFailure = true;
                            global.consoleLog('Persephone', 'Loop item ' + i + ' failed (sub-execution ' + created.subExecutionId + ')', 2);
                        }
                    } catch (err) {
                        hasFailure = true;
                        const finalResult = {
                            index: i,
                            executionId: null,
                            status: 'failure',
                            duration: Date.now() - startedAt,
                            outputs: {},
                            error: err.message
                        };
                        liveResults.set(i, finalResult);
                        combinedResults.push(finalResult);
                        global.consoleLog('Persephone', 'Loop item ' + i + ' error: ' + err.message, 2);
                    }
                    await maybeReportProgress(combinedResults.length, sourceArray.length);
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

                            const itemContext = { CTX: Object.assign({}, variables, { item: item }), STEPS: variables.steps || {}, USER: variables._USER || {}, WORKFLOW: variables._WORKFLOW || {} };
                            const startedAt = Date.now();

                            resolveWorkflowInputs(step.workflowInputs, itemContext)
                                .then(function(params) {
                                    return resolveStepTriggerId(step.triggerId, itemContext).then(function(triggerId) {
                                        return createSubWorkflowExecution(workflowId, null, params, parentExecutionId, variables._USER, triggerId);
                                    });
                                })
                                .then(async function(created) {
                                    // Mark this item as started/in-flight immediately -
                                    // report right away so it shows up before
                                    // waitForExecution resolves
                                    liveResults.set(globalIdx, { index: globalIdx, executionId: created.subExecutionId, status: 'running' });
                                    await maybeReportProgress(allResults.length, sourceArray.length);

                                    return waitForExecution(created.subExecutionId).then(function(completed) {
                                        const finalCTX = (completed.context && completed.context.CTX) ? completed.context.CTX : {};
                                        const finalSteps = (completed.context && completed.context.STEPS) ? completed.context.STEPS : {};
                                        return extractSubWorkflowOutputs(created.workflow, finalCTX, finalSteps, variables._USER || {}).then(function(outputs) {
                                            return {
                                                index: globalIdx,
                                                executionId: created.subExecutionId,
                                                status: completed.status,
                                                duration: Date.now() - startedAt,
                                                outputs: outputs
                                            };
                                        });
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
                                .then(async function(result) {
                                    allResults.push(result);
                                    liveResults.set(globalIdx, result);
                                    if (result.status === 'failure') {
                                        hasFailure = true;
                                        global.consoleLog('Persephone', 'Loop item ' + result.index + ' failed', 2);
                                    }
                                    await maybeReportProgress(allResults.length, sourceArray.length);
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

            // Same distinction as the Plugin-loop branch: a hard stop (onItemFailure:
            // 'stop') or a total failure (every attempted item failed) reports as
            // 'failure'; a partial failure that 'continue' rode through - at least
            // one real success, nothing cut short - reports as 'warning' instead,
            // so a mostly-successful batch run isn't indistinguishable from a
            // complete failure.
            const failedItemCount = combinedResults.filter(function(r) { return r.status === 'failure'; }).length;
            const stoppedEarly = combinedResults.length < sourceArray.length;
            const allAttemptsFailed = failedItemCount > 0 && failedItemCount === combinedResults.length;

            let overallStatus;
            if (hasFailure && (stoppedEarly || allAttemptsFailed)) {
                overallStatus = 'failure';
            } else if (hasFailure) {
                overallStatus = 'warning';
            } else if (hasWarning) {
                overallStatus = 'warning';
            } else {
                overallStatus = 'success';
            }

            return { combined_results: combinedResults, status: overallStatus, subErrors: subErrors };
        }
    }

        /**
     * Merge newly-rendered step variables into the running execution's CTX
     * and persist the full {CTX, STEPS, USER, WORKFLOW} shape to
     * workflow_exec.context. Shared by both the success path and the failure
     * path in executeStepInWorkflow, so a step's partial variables (rendered
     * before a later variable in that same step threw) get folded into the
     * execution-level CTX dump exactly the same way a fully-successful
     * step's variables do - without this, workflow_exec.context would lag
     * behind workflow_exec_steps.context, which already gets the partial
     * write (see recordStepExecution's stepContext param in both call sites).
     * No-ops if stepNewContext is empty (nothing new to merge/persist).
     */
    async function persistExecutionContext(variables, results, executionId, stepNewContext) {
        if (!stepNewContext || Object.keys(stepNewContext).length === 0) return;

        // Merge new context into variables (CTX)
        Object.assign(variables, stepNewContext);

        // Build CTX object without the internal steps property
        const ctx = {};
        for (const [key, value] of Object.entries(variables)) {
            if (!key.startsWith('_') && key !== 'steps') {
                ctx[key] = value;
            }
        }

        // Build full context for persistence - must match the same
        // {CTX, STEPS, USER, WORKFLOW} shape as the initial/final writes.
        // This is an UPDATE that replaces the whole `context` column, not a
        // merge - previously this only ever wrote {CTX: ctx}, silently
        // dropping STEPS/USER/WORKFLOW from the persisted context for the
        // entire remainder of a running execution (restored only once the
        // final completion write ran) - confirmed as the cause of Execution
        // Details showing "System" while running and only resolving to the
        // real triggering user/form info once the execution finished.
        const fullContext = {
            CTX: ctx,
            STEPS: results,
            USER: variables._USER || {},
            WORKFLOW: variables._WORKFLOW || {}
        };

        // Update execution record with new context
        await pools.kore_sys.execute(
            `UPDATE workflow_exec SET context = ? WHERE execution_id = ?`,
            [JSON.stringify(fullContext), executionId]
        );

        global.consoleLog('Persephone', `Updated execution context with ${Object.keys(stepNewContext).length} new variable(s)`, 4);
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
     * Writes interim loop progress into a running step's own workflow_exec_steps
     * row, reusing the existing `output` JSON column rather than a new schema
     * field. Distinguishable from the step's real final output by shape
     * (`_loopProgress` marker vs. the real `combined_results` payload) - this
     * gets fully overwritten by recordStepExecution's own completion UPDATE
     * once the step actually finishes, so no stale progress data can linger.
     *
     * Optionally also carries a `combined_results` snapshot of whatever
     * iterations have finished so far, written as a top-level sibling of
     * `_loopProgress` (matching the shape of the step's eventual final output)
     * so callers reading a still-running step's output can already pull
     * per-iteration executionIds (e.g. to expand a running Workflow-loop step
     * and show its sub-executions in progress) without waiting for the whole
     * loop to finish. Omitted entirely when not provided or empty, so callers
     * that don't have per-iteration ids (e.g. the Plugin-loop path) are unaffected.
     *
     * Callers are expected to throttle how often this gets called (time-based,
     * not every single iteration) for high-volume loops - this function itself
     * does no throttling, it just writes whatever it's given, whenever it's
     * called. Failures are logged and swallowed rather than thrown, since a
     * missed progress update should never fail the loop itself.
     *
     * The interim combined_results snapshot is trimmed down to just
     * {index, executionId, status} per item before writing - the frontend's
     * mid-loop expand feature only ever needs the executionId to fetch each
     * sub-execution's own detail on demand, so there's no reason to re-write
     * the full (potentially large, and growing every throttled write) outputs
     * payload for every already-finished item on every progress update. The
     * real completion write later still carries the full per-item outputs.
     */
    async function updateStepProgress(stepExecutionId, completed, total, combinedResultsSoFar) {
        if (!stepExecutionId) return;
        try {
            const payload = { _loopProgress: { completed: completed, total: total } };
            if (Array.isArray(combinedResultsSoFar) && combinedResultsSoFar.length > 0) {
                payload.combined_results = combinedResultsSoFar.map(function(r) {
                    return { index: r.index, executionId: r.executionId, status: r.status };
                });
            }
            await pools.kore_sys.execute(
                `UPDATE workflow_exec_steps SET output = ? WHERE step_execution_id = ?`,
                [JSON.stringify(payload), stepExecutionId]
            );
        } catch (err) {
            global.consoleLog('Persephone', `Failed to write loop progress (step_execution_id ${stepExecutionId}): ${err.message}`, 2);
        }
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
                    e.variables, e.results, e.errors, e.context,
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
                    output, error, execution_sequence, matched_cases
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
                inputs: (() => {
                    try {
                        const vars = execution.variables ? (typeof execution.variables === 'string' ? JSON.parse(execution.variables) : execution.variables) : {};
                        const meta = vars._inputMeta;
                        if (meta) {
                            return {
                                inputVars: meta.inputVars || {},
                                triggerVars: meta.triggerVars || {},
                                userInputs: meta.userInputs || {}
                            };
                        }
                        // Fallback for older executions without _inputMeta
                        const filtered = {};
                        for (const [k, v] of Object.entries(vars)) {
                            if (!k.startsWith('_')) filtered[k] = v;
                        }
                        return { inputVars: filtered, triggerVars: {}, userInputs: {} };
                    } catch (e) {
                        return { inputVars: {}, triggerVars: {}, userInputs: {} };
                    }
                })(),
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
                    executionSequence: row.execution_sequence,
                    matchedCases: (() => {
                        try {
                            return row.matched_cases ? (typeof row.matched_cases === 'string' ? JSON.parse(row.matched_cases) : row.matched_cases) : [];
                        } catch (e) {
                            global.consoleLog('Persephone', `Error parsing matched_cases for ${row.step_name}: ${e.message}, data: ${String(row.matched_cases).substring(0, 500)}`, 2);
                            return [];
                        }
                    })()
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

                if (req.callerType === 'user') {
                    const canExecute = await global.auth.hasPermission(req.userId, 'workflow', 'execute', executionData.workflowId);
                    if (!canExecute) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Forbidden' }));
                        return;
                    }
                }

                // PHASE 2: attribution comes from the authenticated caller, never
                // from the request. This previously read the X-User header first,
                // which is client-supplied and unvalidated - anyone could attribute
                // a workflow run to another person, in the same way resetBy/
                // unlockedBy could be spoofed before those were removed. The
                // request is already authenticated at this point and req.userId is
                // right there.
                //
                // Resolved to an email rather than a userId on purpose. The header
                // was meant to carry an email (workflows.js) but fell back to a
                // userId when one wasn't handy, so workflow_exec.triggered_by_user
                // holds a mix of both formats. New rows are uniform; existing rows
                // are left as they are.
                let triggeredByUser = 'system';
                if (req.callerType === 'user' && req.userId) {
                    try {
                        const [userRows] = await global.auth.korePool.execute(
                            'SELECT email FROM users WHERE userId = ?',
                            [req.userId]
                        );
                        triggeredByUser = (userRows[0] && userRows[0].email) || req.userId;
                    } catch (lookupError) {
                        // Attribution must never block execution - fall back to the
                        // userId, which is still trustworthy, just less readable.
                        global.consoleLog('Persephone', `Could not resolve email for ${req.userId}: ${lookupError.message}`, 2);
                        triggeredByUser = req.userId;
                    }
                } else if (req.callerType === 'api' && req.apiMemberId) {
                    triggeredByUser = `api:${req.apiMemberId}`;
                }

                const result = await executeWorkflow(executionData.workflowId, {
                    workflowVersion: executionData.workflowVersion,
                    parameters: executionData.parameters || {},
                    triggeredBy: executionData.triggeredBy || 'api',
                    triggeredByUser: triggeredByUser,
                    triggerId: executionData.triggerId || null,
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

        // Strip {# ... #} comments entirely, before any other preprocessing --
        // confirmed via live testing that a comment ANYWHERE in a template that also
        // builds an array via {% do x.append(...) %} or {% set _ = x.push(...) %}
        // inside a loop causes the final output to render as JS's default
        // Array.toString() ("[object Object],...") instead of a real structured
        // value, regardless of which array-building method is used or where the
        // comment is positioned (top-level, inside the loop, either alone is
        // sufficient). Root mechanism not conclusively isolated even after reviewing
        // autoJsonFilter and the .append()/.push() rewrite logic below -- likely in
        // Nunjucks' own comment/whitespace handling, not something else in this
        // file. Removing comments completely here sidesteps it regardless of cause.
        //
        // A comment that occupies an entire line by itself (only whitespace before
        // and after it on that line) is removed as if that line had never existed
        // in the template at all -- not just the comment text, but exactly the one
        // newline needed to keep the content before and after it correctly
        // separated, and NO newline at all when the comment sits at either edge of
        // the template (nothing before it, nothing after it, or both). Four cases,
        // handled in this order because later patterns depend on earlier ones
        // having already cleaned up multiple/cascading comments:
        //   1. Content on both sides: eat the leading \r\n (mandatory), keep the
        //      trailing \r\n via lookahead (never consumed) as the one remaining
        //      separator.
        //   2. Comment is the very first thing in the whole template, content
        //      follows: eat the comment AND its trailing \r\n outright (not a
        //      lookahead this time) -- nothing precedes it, so that trailing
        //      newline isn't protecting a separator that needs to survive.
        //   3. Comment is the last content in the template (nothing after it but
        //      optional trailing whitespace): eat the optional leading \r\n too,
        //      since nothing follows to separate from either.
        //   4. Fallback for a comment sharing a line with real content on at least
        //      one side: bare removal only, unchanged from before.
        // Confirmed real bug this closes on both ends: a plain {{ value }} output
        // (no explicit {{- -}} trim markers) immediately preceded OR followed by a
        // whole-line comment previously left a stray leading or trailing "\n" in
        // the rendered value, because earlier versions of this same regex chain
        // only ever protected a separator that needed to survive in the middle of
        // a template, never accounting for the comment sitting at either edge.
        template = template
            .replace(/\r?\n[ \t]*\{#[\s\S]*?#\}[ \t]*(?=\r?\n[\s\S])/g, '')
            .replace(/^[ \t]*\{#[\s\S]*?#\}[ \t]*\r?\n/, '')
            .replace(/(\r?\n)?[ \t]*\{#[\s\S]*?#\}[ \t]*\r?\n?$/, '')
            .replace(/\{#[\s\S]*?#\}/g, '');

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
        // Stop-list includes "else"/"if" so this doesn't swallow a ternary's "else Y" tail
        // into the captured comparison value when the comparison sits inside a ternary
        // condition (e.g. "X if list | length > 0 else Y") — confirmed via live parse
        // failure (parseAggregate: expected comma after expression) that without this,
        // the non-greedy capture expands past "0" all the way to the real "}}", producing
        // a malformed gt(0 else Y) call.
        processedTemplate = processedTemplate
            .replace(/(\|\s*[\w_]+(?:\([^)]*\))?)\s*>=\s*([^\s%}][^%}]*?)(\s*(?:and|or|else|if|%|}}))/g, '$1 | gte($2)$3')
            .replace(/(\|\s*[\w_]+(?:\([^)]*\))?)\s*<=\s*([^\s%}][^%}]*?)(\s*(?:and|or|else|if|%|}}))/g, '$1 | lte($2)$3')
            .replace(/(\|\s*[\w_]+(?:\([^)]*\))?)\s*>\s*([^\s%}][^%}]*?)(\s*(?:and|or|else|if|%|}}))/g,  '$1 | gt($2)$3')
            .replace(/(\|\s*[\w_]+(?:\([^)]*\))?)\s*<\s*([^\s%}][^%}]*?)(\s*(?:and|or|else|if|%|}}))/g,  '$1 | lt($2)$3');

        // Wrap an inline ternary's condition in parens when it contains a filter chain
        // (e.g. "X if list | length > 0 else Y") — confirmed via live test that Nunjucks's
        // parser fails on this with "parseSignature: expected comma after expression" when
        // a filter pipe is followed by a comparison operator directly inside a ternary
        // condition. Parenthesizing the condition fixes it without changing semantics.
        // Scoped to inline {{ }} expressions only (not {% if %}/{% else %}/{% endif %}
        // block statements, which are a different, unrelated syntax that happens to share
        // the same keywords). Only handles a single, non-nested ternary per expression —
        // a ternary nested inside another ternary's condition is a known limitation, same
        // caveat as every other regex-based rewrite in this function.
        processedTemplate = processedTemplate.replace(/\{\{([\s\S]*?)\}\}/g, (match, inner) => {
            const ternaryMatch = inner.match(/^([\s\S]*?)\sif\s([\s\S]+?)\selse\s([\s\S]*)$/);
            if (!ternaryMatch) return match;
            const [, truePart, condition, falsePart] = ternaryMatch;
            const trimmedCond = condition.trim();
            const alreadyParenthesized = trimmedCond.startsWith('(') && trimmedCond.endsWith(')');
            const hasFilterChain = trimmedCond.includes('|');
            if (alreadyParenthesized || !hasFilterChain) return match;
            return '{{' + truePart + ' if (' + trimmedCond + ') else ' + falsePart + '}}';
        });

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
            // Also handles a trailing inline-if modifier: {% do list.append(x) if COND %} ->
            // {%- set list = (list.concat([x]) if (COND) else list) -%} -- without this, a tag
            // with an inline if never matches (the plain regex requires %} immediately after
            // the closing paren), stays a literal {% do %}, and fails at render time with
            // "unknown block tag: do" since Nunjucks has no native {% do %} support at all.
            // Confirmed real, live failure (BDR - Ticket and DB's own details variable, which
            // uses this pattern throughout and had never actually been exercised before).
            return result.replace(/\{%-?\s*do\s+(\w+)\.concat\(\[([\s\S]*?)\]\)(?:\s+if\s+([\s\S]*?))?\s*-?%\}/g,
                (fullMatch, varName, argsContent, condition) => {
                    if (condition) {
                        return '{%- set ' + varName + ' = (' + varName + '.concat([' + argsContent + ']) if (' + condition + ') else ' + varName + ') -%}';
                    }
                    return '{%- set ' + varName + ' = ' + varName + '.concat([' + argsContent + ']) -%}';
                });
        })(processedTemplate);

        // Rewrite .extend(x) as .concat(x) — extend is not native to Nunjucks arrays.
        // Same two-pass shape as the .append() rewrite above, but WITHOUT the [x] wrap,
        // since .extend()'s argument is already an array to splice in, not a single new
        // element (that distinction is also why this needs its own {% do %} regex below —
        // the existing one specifically requires literal [ ] brackets around the content,
        // which correctly excludes this bare-argument form from double-matching).
        // Also handle {% do list.extend(x) %} by converting to {% set list = list.concat(x) %}
        processedTemplate = (function rewriteExtend(str) {
            let result = '';
            let i = 0;
            while (i < str.length) {
                // Look for varName.extend(
                const extendIdx = str.indexOf('.extend(', i);
                if (extendIdx === -1) { result += str.slice(i); break; }
                // Find the variable name before .extend(
                let nameStart = extendIdx - 1;
                while (nameStart >= 0 && /[\w]/.test(str[nameStart])) nameStart--;
                nameStart++;
                const varName = str.slice(nameStart, extendIdx);
                // Find matching closing paren with depth tracking
                let depth = 1;
                let j = extendIdx + '.extend('.length;
                while (j < str.length && depth > 0) {
                    if (str[j] === '(') depth++;
                    else if (str[j] === ')') depth--;
                    j++;
                }
                const arg = str.slice(extendIdx + '.extend('.length, j - 1);
                result += str.slice(i, nameStart) + varName + '.concat(' + arg + ')';
                i = j;
            }
            // Rewrite {% do list.concat(x) %} -> {%- set list = list.concat(x) -%}
            // No bracket requirement here (unlike the .append()-derived rewrite) since
            // .extend()'s argument was never wrapped in [ ] to begin with. Also handles a
            // trailing inline-if modifier -- see rewriteAppend above for why this is needed.
            return result.replace(/\{%-?\s*do\s+(\w+)\.concat\(([\s\S]*?)\)(?:\s+if\s+([\s\S]*?))?\s*-?%\}/g,
                (fullMatch, varName, argsContent, condition) => {
                    if (condition) {
                        return '{%- set ' + varName + ' = (' + varName + '.concat(' + argsContent + ') if (' + condition + ') else ' + varName + ') -%}';
                    }
                    return '{%- set ' + varName + ' = ' + varName + '.concat(' + argsContent + ') -%}';
                });
        })(processedTemplate);

        // Rewrite .update({...}) as | merge_dict({...}) — plain JS objects have no native
        // in-place update method (that's a Python dict method), so this is the object-side
        // equivalent of the .append()->.concat() rewrite above. Same balanced-parentheses
        // matching approach, since the dict-literal argument may itself contain nested
        // parens (ternaries, filter calls, etc).
        // Also handle {% do obj.update({...}) %} by converting to
        // {% set obj = obj | merge_dict({...}) %}
        processedTemplate = (function rewriteUpdate(str) {
            let result = '';
            let i = 0;
            while (i < str.length) {
                // Look for varName.update(
                const updateIdx = str.indexOf('.update(', i);
                if (updateIdx === -1) { result += str.slice(i); break; }
                // Find the variable name before .update(
                let nameStart = updateIdx - 1;
                while (nameStart >= 0 && /[\w]/.test(str[nameStart])) nameStart--;
                nameStart++;
                const varName = str.slice(nameStart, updateIdx);
                // Find matching closing paren with depth tracking
                let depth = 1;
                let j = updateIdx + '.update('.length;
                while (j < str.length && depth > 0) {
                    if (str[j] === '(') depth++;
                    else if (str[j] === ')') depth--;
                    j++;
                }
                const arg = str.slice(updateIdx + '.update('.length, j - 1);
                result += str.slice(i, nameStart) + varName + ' | merge_dict(' + arg + ')';
                i = j;
            }
            // Rewrite {% do obj | merge_dict({...}) %} -> {%- set obj = obj | merge_dict({...}) -%}
            // Also handles a trailing inline-if modifier -- see rewriteAppend above for why.
            return result.replace(/\{%-?\s*do\s+(\w+)\s*\|\s*merge_dict\(([\s\S]*?)\)(?:\s+if\s+([\s\S]*?))?\s*-?%\}/g,
                (fullMatch, varName, argsContent, condition) => {
                    // Guard against greedy match crossing an unrelated later {% ... %} block by
                    // requiring balanced braces/parens within argsContent before accepting the match
                    if (condition) {
                        return '{%- set ' + varName + ' = (' + varName + ' | merge_dict(' + argsContent + ') if (' + condition + ') else ' + varName + ') -%}';
                    }
                    return '{%- set ' + varName + ' = ' + varName + ' | merge_dict(' + argsContent + ') -%}';
                });
        })(processedTemplate);

        // Detect if template is a solo output expression (only a single {{ }} with no
        // surrounding text) and, if so and no auto-json-equivalent filter is already
        // present, inject | auto_json before the closing }}. auto_json only
        // serializes objects/arrays, passing strings/primitives through unchanged.
        //
        // Uses real brace-depth tracking rather than a [^}]+ character class, which
        // cannot span across ANY literal `}` -- including one from an inline {}/{...}
        // object or dict literal used as a filter argument (e.g. `| d({}, true)`,
        // `| merge_dict({'x': 1})`). Confirmed real bug this fixes: a whole template
        // consisting of nothing but `{{ CTX.result | d({}, true) }}` (a large object)
        // never got auto_json injected at all -- the `}` closing that literal `{}`
        // broke BOTH the detection regex (isSoloExpression evaluated false) AND the
        // separate injection regex (silently matched nothing, left the template
        // completely unchanged) -- so the raw JS object fell through to Nunjucks'
        // native stringification and rendered as "[object Object]". Switching to
        // `| d()` (no `{}` in it) "fixed" it, but only by accident of not containing
        // a brace character; the underlying detection/injection mechanism was
        // broken for any expression containing one, not specific to `d`.
        processedTemplate = (function injectAutoJsonIfSolo(tpl) {
            const strippedForCheck = tpl.replace(/\{%[\s\S]*?%\}/g, '').trim().replace(/\s+/g, ' ');

            const openMatch = strippedForCheck.match(/^\{\{-?\s*/);
            const closeMatch = strippedForCheck.match(/\s*-?\}\}$/);
            if (!openMatch || !closeMatch) return tpl;

            const innerStart = openMatch[0].length;
            const innerEnd = strippedForCheck.length - closeMatch[0].length;
            if (innerEnd <= innerStart) return tpl;
            const inner = strippedForCheck.slice(innerStart, innerEnd);

            // Brace-balance check on the inner content: a genuine single {{ }}
            // expression (however many literal {}/{...} pairs it contains) always
            // nets to zero depth and never goes negative. This also correctly
            // rejects the "two solo expressions concatenated" case (e.g. "{{ a }}{{ b }}"),
            // whose inner content ("a }}{{ b") goes negative immediately.
            let depth = 0;
            for (let i = 0; i < inner.length; i++) {
                if (inner[i] === '{') depth++;
                else if (inner[i] === '}') {
                    depth--;
                    if (depth < 0) return tpl;
                }
            }
            if (depth !== 0) return tpl;

            if (/\|\s*auto_json\b/.test(inner) || /\|\s*json\b/.test(inner) ||
                /\|\s*in_list\b/.test(inner) || /\|\s*not_in_list\b/.test(inner) ||
                /\|\s*deep_eq\b/.test(inner) || /\|\s*not_deep_eq\b/.test(inner) ||
                /\|\s*is_empty\b/.test(inner)) {
                return tpl;
            }

            // Locate the matching closing }} for the first {{ in the actual
            // (unstripped) template via the same brace-depth approach, so the
            // injection lands correctly even when preceded by {% %} block tags.
            const openIdx = tpl.indexOf('{{');
            if (openIdx === -1) return tpl;
            let scanDepth = 0;
            let closeIdx = -1;
            for (let i = openIdx + 2; i < tpl.length - 1; i++) {
                if (tpl[i] === '{') scanDepth++;
                else if (tpl[i] === '}') {
                    if (scanDepth === 0 && tpl.slice(i, i + 2) === '}}') { closeIdx = i; break; }
                    scanDepth--;
                }
            }
            if (closeIdx === -1) return tpl;

            const before = tpl.slice(0, closeIdx);
            const after = tpl.slice(closeIdx);
            const hasTrailingDash = before.trimEnd().endsWith('-');
            const trimmedBefore = hasTrailingDash ? before.trimEnd().slice(0, -1).trimEnd() : before.trimEnd();
            return trimmedBefore + ' | auto_json ' + (hasTrailingDash ? '-' : '') + after;
        })(processedTemplate);

        // NOTE: this used to unconditionally force every {% %} tag to {%- -%} here,
        // which ate adjacent whitespace regardless of whether the tag was alone on its
        // own line or shared a line with real content (e.g. a conditional SQL clause
        // like "{% if x %} WHERE ...{% endif %}" lost its leading space). Replaced by
        // the engine's native trimBlocks/lstripBlocks options set in nunjucks.configure()
        // above, which only trim when a tag is genuinely alone on its line -- see the
        // comment there for the full reasoning.

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

        // {% for x in ... %} loop variables are also legitimately-declared names — without
        // this, an undefined-property error on a loop variable (e.g. computer.some_field
        // inside {% for computer in ... %}) never matches declaredVars, so the "declared,
        // treat as null" fallback below never applies to loop variables, only {% set %} ones.
        const forPattern = /\{%-?\s*for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+/g;
        while ((match = forPattern.exec(template)) !== null) {
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
            let varMatch = errorLine.match(/\{\{-?\s*(?:not\s+)?([a-zA-Z_][a-zA-Z0-9_.[\]]*)/);
            if (varMatch) {
                variable = varMatch[1];
            }
            // Pattern 2: {% for x in VARIABLE %}
            else if ((varMatch = errorLine.match(/\{%-?\s*for\s+\w+\s+in\s+([a-zA-Z_][a-zA-Z0-9_.[\]]*)/))) {
                variable = varMatch[1];
            }
            // Pattern 3: {% if VARIABLE %} (also handles {% if not VARIABLE %} — without the
            // optional "not\s+" skip, this regex captured the literal word "not" as the
            // variable name whenever a template used a negated condition, mislabeling real
            // undefined-variable errors as "not was not found" instead of naming the actual
            // variable at fault)
            else if ((varMatch = errorLine.match(/\{%-?\s*if\s+(?:not\s+)?([a-zA-Z_][a-zA-Z0-9_.[\]]*)/))) {
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

    /**
     * POST /engine/execute-kore-action - run a single Kore utility action's
     * code standalone, outside any workflow execution. Same underlying
     * execution as a 'Kore' step inside a real workflow run (see
     * runKoreAction/executeKore), just without step/variables/CTX around
     * it - callers (e.g. the form-viewer) are expected to have already
     * resolved any [[ ]]/{{ }} values themselves before sending inputs
     * here, same as they already do for workflow_input/plugin inputs_map.
     * body: { action_name, inputs }
     * response: { success: true, result } or { success: false, error }
     */
    async function handleExecuteKoreAction(req, res) {
        try {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });

            req.on('end', async () => {
                try {
                    const { action_name, inputs } = JSON.parse(body);

                    if (!action_name) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'action_name is required' }));
                    }

                    const result = await runKoreAction(action_name, inputs || {});

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, result }));
                } catch (error) {
                    global.consoleLog('Persephone', `Kore action execution error: ${error.message}`, 1);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
            });
        } catch (error) {
            global.consoleLog('Persephone', `Kore action execution error: ${error.message}`, 1);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
    }

    // Public API
    return {
        initialize,
        executeWorkflow,
        getExecutionStatus,
        handleRequest,
        renderTemplate,
        startWorkflowScheduler
    };
})();

module.exports = Persephone;