import '/lib/base.js';
import '/lib/jinja-json.js';

/**
 * wf-exec.js
 * Workflow execution management and display functions
 */

// Add spinner CSS animation to document head
(function injectSpinnerCSS() {
    if (!document.getElementById('wf-exec-spinner-css')) {
        const style = document.createElement('style');
        style.id = 'wf-exec-spinner-css';
        style.textContent = `
            @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }
})();

// Global variable to store execution results
let lastExecutionResults = null;

// Track last rendered context to avoid unnecessary re-renders
let lastContextValue = null;

// Store polling intervals keyed by executionId to prevent duplicates and enable cleanup
const activePollingIntervals = {};

// Store which sections are expanded across renders (for polling persistence)
const expandedSections = {};

// Track running timers for step durations (key: stepId, value: { startTime, timerId })
const stepDurationTimers = {};

// Track which steps already have timers started (to avoid restarting on re-render)
const stepsWithTimersStarted = {};

// Track which steps have been rendered in their final state (to skip re-rendering)
const stepsRenderedFinal = {};

// Track the last-rendered loop progress {completed, total} per step, so the
// early-return skip below (which normally avoids re-rendering a still-running
// step every poll cycle) can make an exception specifically when there's a
// genuinely new progress value to show - without this, a loop step's progress
// line would render once and then freeze until the step actually finishes.
const lastRenderedLoopProgress = {};

// Track expanded Workflow steps and their sub-execution IDs for polling
// key: stepId (step-seq-N), value: array of executionIds
const expandedSubExecutions = {};

// Cache of each terminal execution's rendered output_html (its own dedicated
// workflow field, not an Output Variable) - key: executionId, populated by
// renderExecutionDetail whenever present so the "View Output" button's
// onclick (which can only safely carry a plain
// executionId, not an arbitrary HTML blob, in an inline attribute) has
// somewhere to look it up from.
const executionOutputHtmlCache = {};

// Track which running Workflow steps have already had their sub-execution ID(s)
// picked up, so the early-return skip below can make an exception the moment a
// still-running Workflow step's child execution becomes available - without
// this, a Workflow step would render once with no result yet and then freeze
// in its non-expandable single-line form for the rest of its run, even after
// the sub-workflow starts and a child executionId shows up in step.output.
const stepsWithSubExecAvailable = {};

// Track execution duration timer (for the overall workflow)
let executionDurationTimer = null;
let executionStartTime = null;

/**
 * Clean up state from previous execution before starting a new one
 */
function cleanupPreviousExecution() {
    // Clear all polling intervals
    for (const [executionId, interval] of Object.entries(activePollingIntervals)) {
        clearInterval(interval);
    }
    Object.keys(activePollingIntervals).forEach(key => delete activePollingIntervals[key]);
    
    // Clear all step duration timers
    for (const timerId of Object.values(stepDurationTimers)) {
        if (timerId.timerId) clearInterval(timerId.timerId);
    }
    Object.keys(stepDurationTimers).forEach(key => delete stepDurationTimers[key]);
    Object.keys(stepsWithTimersStarted).forEach(key => delete stepsWithTimersStarted[key]);
    Object.keys(stepsRenderedFinal).forEach(key => delete stepsRenderedFinal[key]);
    Object.keys(lastRenderedLoopProgress).forEach(key => delete lastRenderedLoopProgress[key]);
    Object.keys(expandedSubExecutions).forEach(key => delete expandedSubExecutions[key]);
    Object.keys(stepsWithSubExecAvailable).forEach(key => delete stepsWithSubExecAvailable[key]);
    
    // Clear execution duration timer
    if (executionDurationTimer) {
        clearInterval(executionDurationTimer);
        executionDurationTimer = null;
        executionStartTime = null;
    }
    
    // Reset execution state variables
    lastExecutionResults = null;
    lastContextValue = null;
    Object.keys(expandedSections).forEach(key => delete expandedSections[key]);
    
    // Clear execution details container
    const container = document.getElementById('execution-detail-container');
    if (container) {
        container.innerHTML = '';
        container.removeAttribute('data-initialized');
    }
}

/**
 * Start or update the execution duration timer
 */
function startExecutionDurationTimer(triggeredAt) {
    // Stop existing timer if any
    if (executionDurationTimer) {
        clearInterval(executionDurationTimer);
    }
    
    executionStartTime = new Date(triggeredAt).getTime();
    
    executionDurationTimer = setInterval(() => {
        const durationEl = document.getElementById('exec-duration-display');
        if (durationEl) {
            const elapsed = Date.now() - executionStartTime;
            durationEl.textContent = formatDuration(elapsed);
        }
    }, 100);
}

/**
 * Stop execution duration timer and set final duration
 */
function stopExecutionDurationTimer(finalDuration) {
    if (executionDurationTimer) {
        clearInterval(executionDurationTimer);
        executionDurationTimer = null;
    }
    
    const durationEl = document.getElementById('exec-duration-display');
    if (durationEl) {
        durationEl.textContent = formatDuration(finalDuration);
    }
}
function startStepDurationTimer(stepId, startedAt) {
    // Clear existing timer if any
    if (stepDurationTimers[stepId]) {
        clearInterval(stepDurationTimers[stepId].timerId);
    }
    
    // Use the step's real start time when available (e.g. the page was loaded
    // or refreshed while the step was already mid-run), same as
    // startExecutionDurationTimer does with triggeredAt - falling back to "now"
    // only if for some reason no startedAt was passed in.
    const startTime = startedAt ? new Date(startedAt).getTime() : Date.now();
    
    const timerId = setInterval(() => {
        try {
            const durationEl = document.getElementById(`duration-${stepId}`);
            if (durationEl) {
                const elapsed = Date.now() - startTime;
                const formatted = formatDuration(elapsed);
                durationEl.textContent = formatted;
            }
        } catch (e) {
            console.error('[Timer Error]', e);
        }
    }, 100);
    
    stepDurationTimers[stepId] = { startTime, timerId };
}

/**
 * Stop duration timer for a step and set final duration
 */
function stopStepDurationTimer(stepId, finalDuration) {
    if (stepDurationTimers[stepId]) {
        clearInterval(stepDurationTimers[stepId].timerId);
        delete stepDurationTimers[stepId];
    }
    
    const durationEl = document.getElementById(`duration-${stepId}`);
    if (durationEl) {
        durationEl.textContent = formatDuration(finalDuration);
    }
}

/**
 * Format duration in milliseconds to seconds with up to 2 decimals
 */
function formatDuration(ms) {
    if (!ms) return '0s';
    const seconds = ms / 1000;
    return `${seconds.toFixed(2)}s`;
}

/**
 * Format timestamp to readable date string
 */
function formatTimestamp(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    return date.toLocaleString();
}

/**
 * Get CSS class for execution status
 */
function getStatusClass(status) {
    const statusMap = {
        'SUCCEEDED': 'status-success',
        'FAILED': 'status-error',
        'RUNNING': 'status-running',
        'PENDING': 'status-pending',
        'success': 'status-success',
        'failed': 'status-error',
        'failure': 'status-failure',
        'running': 'status-running',
        'pending': 'status-pending',
        'warning': 'status-warning',
        'cancelled': 'status-cancelled',
        'cancelling': 'status-cancelled'
    };
    return statusMap[status] || 'status-default';
}

/**
 * Format JSON/object to readable string
 */
function formatJson(obj) {
    try {
        if (typeof obj === 'string') {
            return JSON.stringify(JSON.parse(obj), null, 2);
        }
        return JSON.stringify(obj, null, 2);
    } catch (e) {
        return String(obj);
    }
}

/**
 * Toggle a section's visibility and save state to expandedSections
 */
function toggleSection(contentDivId, sectionId, event) {
    event.stopPropagation();
    const contentDiv = document.getElementById(contentDivId);
    if (!contentDiv) return;
    
    const isCurrentlyHidden = contentDiv.style.display === 'none';
    contentDiv.style.display = isCurrentlyHidden ? 'block' : 'none';
    
    // Update the toggle arrow (find span in the clicked element). Prefer a
    // dedicated [data-chevron] marker when present - some headers (e.g. a
    // running Workflow step) also contain a spinner span, and a plain
    // querySelector('span') would grab that instead of the actual chevron.
    const clickedDiv = event.currentTarget;
    const toggleSpan = clickedDiv.querySelector('[data-chevron]') || clickedDiv.querySelector('span');
    if (toggleSpan) {
        toggleSpan.textContent = isCurrentlyHidden ? '▼' : '▶';
    }
    
    // Save state to global expandedSections
    if (isCurrentlyHidden) {
        expandedSections[sectionId] = true;
    } else {
        delete expandedSections[sectionId];
    }
}

/**
 * Show a persistent execution banner with click action
 */
function showPersistentExecutionBanner(message, type) {
    // Show banner with persistTime=Infinity and clickAction to open results
    showStatusBanner(message, type, 'statusMessage', 5000, Infinity, showExecutionResults);
}

/**
 * Fetch execution summaries from /engine/executions
 * @param {Object} options - Query options
 * @param {number} options.limit - Number of executions to fetch (default: 50)
 * @param {number} options.offset - Offset for pagination (default: 0)
 * @param {string} options.status - Filter by status (e.g., 'success', 'failure', 'running')
 * @param {string} options.workflowId - Filter by workflow ID
 * @returns {Promise<{executions: Array, total: number, limit: number, offset: number}>}
 */
async function fetchExecutionSummaries(options = {}) {
    const { limit = 50, offset = 0, status = null, workflowId = null, showSubworkflows = false } = options;
    
    try {
        const sessionToken = window.sessionToken || getSessionTokenFromCookie();
        const headers = {
            'Content-Type': 'application/json'
        };
        if (sessionToken) {
            headers['X-Session-Token'] = sessionToken;
        }

        // Build query parameters
        const params = new URLSearchParams();
        params.append('limit', limit);
        params.append('offset', offset);
        if (status) params.append('status', status);
        if (workflowId) params.append('workflowId', workflowId);
        if (showSubworkflows) params.append('showSubworkflows', 'true');

        const response = await fetch(`/engine/executions?${params.toString()}`, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        return data;

    } catch (error) {
        console.error('[FetchExecutions] Error:', error);
        throw error;
    }
}

/**
 * Fetch a single execution with full context
 * @param {string} executionId - The execution ID
 * @returns {Promise<Object>} Full execution details
 */
async function fetchExecutionDetail(executionId) {
    try {
        let sessionToken = window.sessionToken;
        if (!sessionToken && typeof getSessionTokenFromCookie === 'function') {
            sessionToken = getSessionTokenFromCookie();
        }
        const headers = {
            'Content-Type': 'application/json'
        };
        if (sessionToken) {
            headers['X-Session-Token'] = sessionToken;
        }

        const response = await fetch(`/engine/executions/${executionId}`, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const execution = await response.json();
        return execution;

    } catch (error) {
        console.error('[FetchExecutionDetail] Error:', error);
        throw error;
    }
}

/**
 * Execute a workflow with given parameters
 */
async function executeWorkflow(parameters, triggerId = null) {
    try {
        showStatusBanner('Starting workflow execution...', 'info');

        // Debug: log the state before execution
        console.log('[TestWorkflow] Current state:', {
            currentWorkflowId,
            currentVersion,
            parametersReceived: parameters
        });

        const requestBody = {
            workflowId: currentWorkflowId,
            workflowVersion: currentVersion,
            parameters: parameters,
            triggeredBy: 'test',
            triggerId: triggerId || null,
            timeout: 600000  // 10 minutes
        };

        console.log('[TestWorkflow] Executing workflow:', requestBody);

        // Validate required fields
        if (!currentWorkflowId) {
            throw new Error('Workflow ID is missing. Please reload the workflow.');
        }
        if (!currentVersion) {
            throw new Error('Workflow version is missing. Please reload the workflow.');
        }

        // Prepare headers with sessionToken from cookie or window variable
        const headers = {
            'Content-Type': 'application/json'
        };
        
        const sessionToken = window.sessionToken || getSessionTokenFromCookie();
        if (sessionToken) {
            headers['X-Session-Token'] = sessionToken;
        }

        // PHASE 2: no X-User header. /engine/execute derives attribution from
        // the authenticated session, so sending an identity here did nothing
        // except let a caller claim to be someone else in
        // workflow_exec.triggered_by_user.

        const response = await fetch('/engine/execute', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`;
            try {
                const errorData = await response.json();
                if (errorData?.error) {
                    errorMessage = errorData.error;
                } else if (errorData?.message) {
                    errorMessage = errorData.message;
                }
            } catch (parseError) {
                // If JSON parsing fails, try to get text
                try {
                    const errorText = await response.text();
                    if (errorText) {
                        errorMessage = errorText.substring(0, 200); // Limit length
                    }
                } catch (textError) {
                    // Response has no body
                }
            }
            throw new Error(errorMessage);
        }

        const result = await response.json();
        const executionId = result.executionId;

        // Fetch execution details to make banner clickable
        const execution = await fetchExecutionDetail(executionId);
        lastExecutionResults = execution;
        
        showPersistentExecutionBanner(`Workflow execution started: ${executionId} (click to view progress)`, 'success');
        console.log('[TestWorkflow] Execution started:', result);

        // Poll for execution status
        pollExecutionStatus(executionId);

    } catch (error) {
        console.error('[TestWorkflow] Error:', error);
        showStatusBanner(`Workflow execution failed: ${error.message}`, 'error');
    }
}

/**
 * Poll execution status and display results
 */
async function pollExecutionStatus(executionId, maxAttempts = 60, interval = 2000) {
    let attempts = 0;
    
    const pollInterval = setInterval(async () => {
        attempts++;
        
        try {
            const sessionToken = window.sessionToken || getSessionTokenFromCookie();
            const headers = {
                'Content-Type': 'application/json'
            };
            if (sessionToken) {
                headers['X-Session-Token'] = sessionToken;
            }
            
            const response = await fetch(`/engine/executions/${executionId}`, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const execution = await response.json();

            // Check if execution is complete
            if (execution.status === 'success') {
                clearInterval(pollInterval);
                lastExecutionResults = execution;
                showPersistentExecutionBanner(`Workflow execution completed: ${execution.executionId} (click to view results)`, 'success');
                console.log('[TestWorkflow] Execution completed:', execution);
            } else if (execution.status === 'failure') {
                clearInterval(pollInterval);
                lastExecutionResults = execution;
                const errorMsg = execution.errors && execution.errors.length > 0 
                    ? execution.errors[0].error 
                    : 'Unknown error';
                showPersistentExecutionBanner(`Workflow execution failed: ${errorMsg} (click to view results)`, 'error');
                console.error('[TestWorkflow] Execution failed:', execution);
            } else if (execution.status === 'warning') {
                clearInterval(pollInterval);
                lastExecutionResults = execution;
                showPersistentExecutionBanner(`Workflow execution completed with warnings (click to view results)`, 'warning');
                console.log('[TestWorkflow] Execution completed with warnings:', execution);
            } else if (execution.status === 'cancelled') {
                clearInterval(pollInterval);
                lastExecutionResults = execution;
                showPersistentExecutionBanner(`Workflow execution cancelled (click to view results)`, 'warning');
                console.log('[TestWorkflow] Execution cancelled:', execution);
            } else if (execution.status === 'running' || execution.status === 'cancelling') {
                // Still running/cancelling - show clickable banner to view current execution
                lastExecutionResults = execution;
                const bannerMsg = execution.status === 'cancelling'
                    ? `Workflow cancelling... (${attempts * (interval/1000)}s) - click to view progress`
                    : `Workflow executing... (${attempts * (interval/1000)}s) - click to view progress`;
                showPersistentExecutionBanner(bannerMsg, 'info');
            }

            // Stop polling if max attempts reached
            if (attempts >= maxAttempts) {
                clearInterval(pollInterval);
                showStatusBanner(`Workflow execution timeout (${maxAttempts * (interval/1000)}s)`, 'warning');
            }

        } catch (error) {
            console.error('[TestWorkflow] Poll error:', error);
            clearInterval(pollInterval);
            showStatusBanner(`Failed to get execution status: ${error.message}`, 'error');
        }
    }, interval);
}

/**
 * Show execution results in a modal
 */
function showExecutionResults() {
    if (lastExecutionResults) {
        const executionId = lastExecutionResults.executionId;
        
        // Reset render-skip state so modal always does a full render on open
        lastContextValue = null;
        Object.keys(stepsRenderedFinal).forEach(key => delete stepsRenderedFinal[key]);
    Object.keys(lastRenderedLoopProgress).forEach(key => delete lastRenderedLoopProgress[key]);
        
        showModal({
            title: '',
            content: '<div id="execDetailContainer" style="padding: 0;"></div>',
            buttons: [
                {
                    label: 'Close',
                    type: 'secondary',
                    onClick: () => closeModal()
                }
            ],
            suppressBodyScroll: false,
            resizable: true,
            width: '90vw',
            height: 'auto'
        });
        
        // After modal is created, render the execution details
        setTimeout(() => {
            const container = document.getElementById('execDetailContainer');
            if (container) {
                generateExecDetailHTML(executionId, container);
            }
        }, 100);
    }
}

/**
 * Generate and render execution detail
 * Fetches execution detail using executionId, generates HTML, and inserts into provided container
 * Sets up automatic polling if execution is still running
 * @param {string} executionId - The execution ID to fetch details for
 * @param {HTMLElement} container - The DOM container to insert the HTML into
 * @param {boolean} backButton - Show or hide the Back button (default: false)
 */
async function generateExecDetailHTML(executionId, container, backButton = false) {
    
    if (!executionId) {
        container.innerHTML = '<div style="color: #ff6b6b; padding: 10px;">No execution ID provided</div>';
        return;
    }
    
    if (!container) {
        console.error('No container provided to generateExecDetailHTML');
        return;
    }
    
    try {
        const execution = await fetchExecutionDetail(executionId);
        
        console.log('[GenerateExecDetail] Execution status:', execution.status);
        console.log('[GenerateExecDetail] Full execution object:', execution);
        
        // Render initial HTML
        await renderExecutionDetail(execution, container, backButton);
        
        // If execution is running, set up polling to refresh
        if (execution.status === 'running' || execution.status === 'pending' || execution.status === 'cancelling') {
            console.log('[GenerateExecDetail] Setting up polling for:', executionId);
            startPollingExecution(executionId, container, backButton);
        } else {
            console.log('[GenerateExecDetail] Execution already completed with status:', execution.status);
            // Execution is complete, stop any existing polling
            stopPollingExecution(executionId);
        }
        
    } catch (error) {
        console.error('[RenderExecutionDetail] Outer catch - Full error:', error);
        console.error('[RenderExecutionDetail] Error stack:', error.stack);
        container.innerHTML = `<div style="color: #ff6b6b; padding: 10px;">Error: ${error.message}</div>`;
    }
}

/**
 * Show a modal with a finished execution's rendered output_html (its own
 * dedicated workflow field, not an Output Variable). Called both by the
 * persistent "View Output" header button (any
 * time, for any terminal execution that has one) and automatically by
 * startPollingExecution below (only immediately upon a live running -> terminal
 * transition someone is actively watching).
 *
 * Rendered inside a sandboxed <iframe srcdoc="..."> rather than dropped
 * straight into the modal's innerHTML. output_html is commonly a FULL HTML
 * document authored elsewhere (its own <!DOCTYPE>/<head>/<style>, e.g. an
 * emailed report) - a browser's HTML parser can't keep a <head>/<style> as a
 * child of a <div> when set via innerHTML, so that styling either gets
 * silently dropped or ends up unscoped and colliding with the app's own CSS.
 * An iframe gives it a genuinely separate document context instead, so it
 * renders exactly as authored and can't leak style either direction.
 *
 * Sandboxed with `allow-same-origin` but NOT `allow-scripts` - the report
 * still can't execute any code or make network calls, but that flag alone
 * lets the parent page read the iframe's rendered content height (below) so
 * the iframe/modal can size itself to the actual report instead of a fixed
 * height that's either too short (forcing an unwanted scrollbar) or too
 * tall (wasted empty space for a short report).
 * @param {number|string} executionId
 */
function showOutputHtmlModal(executionId) {
    const html = executionOutputHtmlCache[executionId];
    if (!html) return;

    // Reasonable default before the actual content height is known (avoids a
    // near-invisible sliver while the iframe's document is still loading)
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.style.cssText = 'width: 100%; height: 300px; display: block; background: #fff; border: 3px solid var(--brand-light); border-radius: 10px; overflow: hidden; box-sizing: border-box;';
    iframe.srcdoc = html;

    // Resize the iframe (and re-clamp the modal's max-height) to the report's
    // actual rendered height once it's loaded, capped so a genuinely huge
    // report gets its own internal scrollbar rather than an unbounded modal.
    iframe.onload = () => {
        try {
            const doc = iframe.contentWindow.document;
            const contentHeight = Math.max(
                doc.documentElement ? doc.documentElement.scrollHeight : 0,
                doc.body ? doc.body.scrollHeight : 0
            );
            if (contentHeight > 0) {
                const cap = Math.floor(window.innerHeight * 0.8);
                // +20px slack, not just a couple pixels - scrollHeight can
                // under-measure slightly (body default margins, sub-pixel
                // rounding), and too little buffer left a hairline internal
                // scrollbar on the iframe itself even though the report
                // content visually fit.
                iframe.style.height = Math.min(contentHeight + 20, cap) + 'px';
            }
        } catch (e) {
            console.warn('[showOutputHtmlModal] Could not measure iframe content height, keeping default:', e.message);
        }
    };

    showModal({
        title: 'Workflow Output',
        content: iframe,
        width: '80vw',
        closeOnBackdrop: true,
        buttons: [
            { label: 'Close', type: 'secondary', onClick: () => {} }
        ]
    });

    // The width option above only sets inline style.width, which the
    // .modal-container CSS class's own max-width:600px still constrains -
    // override that directly too, same pattern used in
    // openWorkflowJinjaEditorModal, so this report actually gets real room
    // instead of being squeezed into the default modal size. Height is
    // deliberately NOT forced here (unlike width) - letting the modal size
    // itself to its content (header + iframe's own now-dynamic height +
    // footer) is exactly what avoids the wasted-space/phantom-scroll problem;
    // max-height still caps how tall that's allowed to grow for a huge report.
    setTimeout(() => {
        const allModals = document.querySelectorAll('.modal-container');
        const modal = allModals[allModals.length - 1];
        if (modal) {
            modal.style.maxWidth = '90vw';
            modal.style.maxHeight = '90vh';
        }
    }, 0);
}

/**
 * Start polling an execution for updates
 * @param {string} executionId - The execution ID to poll
 * @param {HTMLElement} container - The container to update
 * @param {boolean} backButton - Whether back button is shown
 */
function startPollingExecution(executionId, container, backButton) {
    // Clear any existing polling for this execution
    stopPollingExecution(executionId);
    
    const interval = setInterval(async () => {
        // Check if container still exists in DOM
        if (!document.body.contains(container)) {
            stopPollingExecution(executionId);
            return;
        }
        
        let fetchedExecution = null;
        try {
            fetchedExecution = await fetchExecutionDetail(executionId);
            
            // Re-render with latest data
            await renderExecutionDetail(fetchedExecution, container, backButton);

            // Refresh any expanded sub-executions on Workflow steps
            for (const [stepId, subExecIds] of Object.entries(expandedSubExecutions)) {
                if (expandedSections['step-' + stepId]) {
                    const subContainer = document.querySelector('#' + stepId + '-subexec');
                    if (subContainer) {
                        const executionIsTerminal = fetchedExecution.status !== 'running' && fetchedExecution.status !== 'pending' && fetchedExecution.status !== 'cancelling';
                        await renderSubExecutionSteps(subExecIds, subContainer, executionIsTerminal);
                    }
                }
            }
            
            // Stop polling if execution completed or was cancelled (but not cancelling - still in progress)
            if (fetchedExecution.status !== 'running' && fetchedExecution.status !== 'pending' && fetchedExecution.status !== 'cancelling') {
                stopPollingExecution(executionId);
                // Wait for any in-flight step DB writes to complete, then do final render
                await new Promise(resolve => setTimeout(resolve, 1000));
                const finalExecution = await fetchExecutionDetail(executionId);
                await renderExecutionDetail(finalExecution, container, backButton);

                // Auto-popup the output_html modal - this only ever runs from a
                // live running -> terminal transition someone was actively
                // watching (startPollingExecution is only ever started in the
                // first place when the execution began non-terminal; opening the
                // details page for an already-finished execution never reaches
                // this code path at all, so it can't double-fire there). Applies
                // to every terminal state, not just success - a workflow that
                // only sets output_html on some paths will simply have it come
                // back empty/missing on the others and this quietly does
                // nothing in that case. output_html is its own dedicated
                // workflow field (not an Output Variable), so it lands in its
                // own top-level context.OUTPUT_HTML, not inside OUTPUT.
                const outputHtml = finalExecution.context && finalExecution.context.OUTPUT_HTML;
                if (typeof outputHtml === 'string' && outputHtml.trim().length > 0) {
                    showOutputHtmlModal(finalExecution.executionId);
                }
            }
        } catch (error) {
            console.error('[GenerateExecDetail] Polling error:', error);
            // A failed render here (e.g. a stale/torn-down DOM element) must not
            // leave polling running forever if the execution has actually
            // already finished on the backend -- that makes a workflow that
            // completed promptly look stuck indefinitely in the UI. We already
            // have the execution's real status from the fetch above (it's what
            // was being rendered when the render itself threw), so use that to
            // decide whether to stop polling even though this render attempt
            // failed, rather than unconditionally continuing to poll.
            if (fetchedExecution && fetchedExecution.status !== 'running' && fetchedExecution.status !== 'pending' && fetchedExecution.status !== 'cancelling') {
                console.warn('[GenerateExecDetail] Execution is already terminal despite render error -- stopping polling anyway:', fetchedExecution.status);
                stopPollingExecution(executionId);
            }
            // Otherwise (fetch itself failed, or execution is genuinely still
            // running), continue polling despite the error -- unchanged from
            // before.
        }
    }, 2000); // Poll every 2 seconds
    
    activePollingIntervals[executionId] = interval;
}

/**
 * Stop polling an execution
 * @param {string} executionId - The execution ID to stop polling
 */
function stopPollingExecution(executionId) {
    if (activePollingIntervals[executionId]) {
        clearInterval(activePollingIntervals[executionId]);
        delete activePollingIntervals[executionId];
    }
    
    // Clean up execution duration timer
    if (executionDurationTimer) {
        clearInterval(executionDurationTimer);
        executionDurationTimer = null;
    }
    
    // NOTE: Step duration timers are intentionally NOT cleared here.
    // They are managed by renderExecutionDetail - started when a step goes running,
    // stopped and replaced with final duration when the step completes.
}

/**
 * Render execution details HTML into container
 * @param {Object} execution - The execution object with all details
 * @param {HTMLElement} container - The container to render into
 * @param {boolean} backButton - Whether to show back button
 */
async function renderExecutionDetail(execution, container, backButton = false) {
    console.log('[RenderExecutionDetail] Starting render for execution:', execution.executionId);
    
    // Initialize container structure on first render
    if (!container.hasAttribute('data-initialized')) {
        console.log('[RenderExecutionDetail] Initializing container');
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 5px;';
        wrapper.id = 'execution-detail-wrapper';
        
        // Header
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 10px;';
        header.id = 'exec-header';
        wrapper.appendChild(header);
        
        // Summary
        const summary = document.createElement('div');
        summary.className = 'panel-level-2';
        summary.style.cssText = 'padding: 6px; max-width: 100%; overflow: hidden;';
        summary.id = 'exec-summary';
        wrapper.appendChild(summary);
        
        // Errors (created but hidden initially)
        const errors = document.createElement('div');
        errors.id = 'exec-errors';
        errors.style.display = 'none';
        wrapper.appendChild(errors);

        // Warnings (created but hidden initially)
        const warnings = document.createElement('div');
        warnings.id = 'exec-warnings';
        warnings.style.display = 'none';
        wrapper.appendChild(warnings);
        
        // Inputs
        const inputs = document.createElement('div');
        inputs.id = 'exec-inputs';
        inputs.style.display = 'none';
        wrapper.appendChild(inputs);

        // Context
        const context = document.createElement('div');
        context.id = 'exec-context';
        context.style.display = 'none';
        wrapper.appendChild(context);
        
        // Step Results
        const stepResults = document.createElement('div');
        stepResults.className = 'panel-level-2';
        stepResults.style.cssText = 'padding: 6px; max-width: 100%; overflow: hidden;';
        stepResults.id = 'exec-step-results';
        stepResults.style.display = 'none';
        wrapper.appendChild(stepResults);
        
        container.appendChild(wrapper);
        container.setAttribute('data-initialized', 'true');
    }
    
    // Auto-expand Step Results section
    expandedSections['step-results'] = true;

    // Update header
    const header = document.getElementById('exec-header');
    const cancelButtonHtml = (execution.status === 'running' || execution.status === 'pending')
        ? `<button class="btn" data-size="sm" data-color="red" onclick="window.cancelExecution(${execution.executionId})">Cancel</button>`
        : execution.status === 'cancelling'
        ? `<button class="btn" data-size="sm" data-color="slate" disabled>Cancelling...</button>`
        : '';

    // "View Output" button - shown whenever the workflow is finished (any
    // terminal state: success/warning/failure/cancelled) AND it has a
    // non-empty rendered output_html. output_html is its own dedicated
    // workflow field (not an Output Variable, and never sent to a parent
    // workflow if this one runs as a sub-workflow), so it lands in its own
    // top-level context.OUTPUT_HTML, not inside OUTPUT. A workflow that only
    // sets it on some paths (e.g. success only) naturally has it come back
    // empty/missing on the others, so this button - and the auto-popup in
    // startPollingExecution below - simply don't appear/fire in that case.
    const isTerminalStatus = execution.status !== 'running' && execution.status !== 'pending' && execution.status !== 'cancelling';
    const outputHtml = execution.context && execution.context.OUTPUT_HTML;
    const hasOutputHtml = typeof outputHtml === 'string' && outputHtml.trim().length > 0;
    if (hasOutputHtml) {
        executionOutputHtmlCache[execution.executionId] = outputHtml;
    }
    const viewOutputButtonHtml = (isTerminalStatus && hasOutputHtml)
        ? `<button class="btn" data-size="sm" data-color="blue" onclick="showOutputHtmlModal(${execution.executionId})">View Output</button>`
        : '';

    header.innerHTML = `
        ${backButton ? '<button class="btn" data-size="sm" data-color="slate" onclick="window.history.back()">← Back</button>' : ''}
        <h2 style="margin: 0; flex: 1; font-size: 16px;">Execution Details: ${escapeHtml(String(execution.workflowName || 'Unknown'))}</h2>
        <span style="font-family: monospace; font-size: 12px; color: var(--text-muted); white-space: nowrap;">Execution ID: ${escapeHtml(String(execution.executionId))}</span>
        ${viewOutputButtonHtml}
        ${cancelButtonHtml}
    `;

    // Update summary
    let duration = formatDuration(execution.duration);
    
    // For running executions, calculate elapsed time from triggeredAt
    if ((execution.status === 'running' || execution.status === 'pending') && execution.triggeredAt) {
        const startTime = new Date(execution.triggeredAt).getTime();
        const elapsedMs = Date.now() - startTime;
        duration = formatDuration(elapsedMs);
    }
    
    const statusClass = getStatusClass(execution.status);
    const triggeredByName = (execution.context && execution.context.USER && execution.context.USER.fullName) || execution.triggeredByUser || execution.triggeredBy || 'System';
    const formInfo = execution.context && execution.context.WORKFLOW && execution.context.WORKFLOW.formInfo;
    const workflowTrigger = execution.context && execution.context.WORKFLOW && execution.context.WORKFLOW.trigger;
    const triggeredFromText = (formInfo && formInfo.form_name)
        ? 'Form: ' + formInfo.form_name
        : (workflowTrigger && workflowTrigger.triggerName)
            ? 'Workflow Trigger: ' + workflowTrigger.triggerName
            : 'Workflow Trigger: (unspecified)';
    document.getElementById('exec-summary').innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Status:</span>
                <span class="status-badge ${statusClass}">${execution.status}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Started:</span>
                <span style="font-size: 13px;">${formatTimestamp(execution.triggeredAt)}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Triggered By:</span>
                <span style="font-size: 13px;">${escapeHtml(String(triggeredByName))}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Completed:</span>
                <span style="font-size: 13px;">${execution.completedAt ? formatTimestamp(execution.completedAt) : '—'}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Triggered From:</span>
                <span style="font-size: 13px;">${escapeHtml(triggeredFromText)}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Duration:</span>
                <span style="font-family: monospace; font-size: 13px;" id="exec-duration-display">${duration}</span>
            </div>
        </div>
    `;
    
    // Control execution duration timer
    if (execution.status === 'running' || execution.status === 'pending' || execution.status === 'cancelling') {
        startExecutionDurationTimer(execution.triggeredAt);
    } else {
        stopExecutionDurationTimer(execution.duration);
    }

    // Update errors and warnings sections
    const errorsEl = document.getElementById('exec-errors');
    const warningsEl = document.getElementById('exec-warnings');

    if (execution.errors && execution.errors.length > 0) {
        // Build a stepId -> stepName lookup from execution.steps (confirmed field
        // names directly from the API's getExecutionStatus: stepId: row.step_id,
        // stepName: row.step_name), so each error/warning's raw step id can be
        // displayed as "stepName (id)" instead of the bare id alone. Falls back
        // to the raw value unchanged for entries with no matching step (e.g. a
        // fatal/workflow-level error, which has no `step` field at all).
        const stepNameById = {};
        (execution.steps || []).forEach(s => {
            if (s.stepId) stepNameById[s.stepId] = s.stepName;
        });
        const withReadableStep = e => {
            if (!e.step) return e;
            const name = stepNameById[e.step];
            return name ? Object.assign({}, e, { step: `${name} (${e.step})` }) : e;
        };

        const failureItems = execution.errors.filter(e => !e.type || e.type === 'failure').map(withReadableStep);
        const warningItems = execution.errors.filter(e => e.type === 'warning').map(withReadableStep);

        if (failureItems.length > 0) {
            errorsEl.innerHTML = `
                <div class="panel-level-2" style="padding: 6px; border-left: 3px solid #ff6b6b;">
                    <div data-section-id="exec-errors-section" style="display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; font-size: 13px;" onclick="toggleSection('exec-errors-content', 'exec-errors-section', event)">
                        <span style="font-weight: bold;">▶</span>
                        <strong style="color: #ff6b6b;">Errors (${failureItems.length})</strong>
                    </div>
                    <div id="exec-errors-content" style="display: none; margin-top: 10px; min-height: 100px;">
                        <div id="exec-errors-editor" style="height: 300px; background: var(--bg-primary); border-radius: 6px; overflow: hidden;"></div>
                    </div>
                </div>
            `;
            errorsEl.style.display = 'block';
            if (expandedSections['exec-errors-section']) {
                const content = errorsEl.querySelector('#exec-errors-content');
                if (content) {
                    content.style.display = 'block';
                    errorsEl.querySelector('span').textContent = '▼';
                }
            }
            const errorsJsonString = JSON.stringify(failureItems, null, 2);
            await createOutputEditor('exec-errors-editor', errorsJsonString);
        } else {
            errorsEl.style.display = 'none';
        }

        if (warningItems.length > 0) {
            warningsEl.innerHTML = `
                <div class="panel-level-2" style="padding: 6px; border-left: 3px solid #f0a500;">
                    <div data-section-id="exec-warnings-section" style="display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; font-size: 13px;" onclick="toggleSection('exec-warnings-content', 'exec-warnings-section', event)">
                        <span style="font-weight: bold;">▶</span>
                        <strong style="color: #f0a500;">Warnings (${warningItems.length})</strong>
                    </div>
                    <div id="exec-warnings-content" style="display: none; margin-top: 10px; min-height: 100px;">
                        <div id="exec-warnings-editor" style="height: 300px; background: var(--bg-primary); border-radius: 6px; overflow: hidden;"></div>
                    </div>
                </div>
            `;
            warningsEl.style.display = 'block';
            if (expandedSections['exec-warnings-section']) {
                const content = warningsEl.querySelector('#exec-warnings-content');
                if (content) {
                    content.style.display = 'block';
                    warningsEl.querySelector('span').textContent = '▼';
                }
            }
            const warningsJsonString = JSON.stringify(warningItems, null, 2);
            await createOutputEditor('exec-warnings-editor', warningsJsonString);
        } else {
            warningsEl.style.display = 'none';
        }
    } else {
        errorsEl.style.display = 'none';
        warningsEl.style.display = 'none';
    }

    // Update execution context section
    const inputsEl = document.getElementById('exec-inputs');
    if (execution.inputs || execution.context?.WORKFLOW || execution.context?.USER) {
        const execContext = {
            INPUT_VARS: execution.inputs?.inputVars || {},
            TRIGGER_VARS: execution.inputs?.triggerVars || {},
            USER_INPUTS: execution.inputs?.userInputs || {},
            ...(execution.context?.WORKFLOW ? { WORKFLOW: execution.context.WORKFLOW } : {}),
            ...(execution.context?.USER ? { USER: execution.context.USER } : {})
        };
        const currentInputsStr = JSON.stringify(execContext);
        if (inputsEl._lastValue !== currentInputsStr) {
            inputsEl._lastValue = currentInputsStr;
            inputsEl.innerHTML = `
                <div class="panel-level-2" style="padding: 6px; max-width: 100%; overflow: hidden;">
                    <div data-section-id="inputs" style="display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; font-size: 13px;" onclick="toggleSection('exec-inputs-content', 'inputs', event)">
                        <span style="font-weight: bold;">▶</span>
                        <strong>Execution Context</strong>
                    </div>
                    <div id="exec-inputs-content" style="display: none; margin-top: 10px; min-height: 100px;">
                        <div id="exec-inputs-editor" style="height: 300px; background: var(--bg-primary); border-radius: 6px; overflow: hidden;"></div>
                    </div>
                </div>
            `;
            inputsEl.style.display = 'block';

            if (expandedSections['inputs']) {
                const contentDiv = inputsEl.querySelector('#exec-inputs-content');
                if (contentDiv) {
                    contentDiv.style.display = 'block';
                    inputsEl.querySelector('span').textContent = '▼';
                }
            }

            const jsonString = JSON.stringify(execContext, null, 2);
            await createOutputEditor('exec-inputs-editor', jsonString);
        }
    } else {
        inputsEl.style.display = 'none';
    }

    // Update context section
    const contextEl = document.getElementById('exec-context');
    if (execution.context && execution.context.CTX && Object.keys(execution.context.CTX).length > 0) {
        // Check if context has changed since last render
        const currentContextStr = JSON.stringify(execution.context.CTX);
        const contextChanged = lastContextValue !== currentContextStr;
        
        if (contextChanged) {
            lastContextValue = currentContextStr;
            
            contextEl.innerHTML = `
                <div class="panel-level-2" style="padding: 6px; max-width: 100%; overflow: hidden;">
                    <div data-section-id="context" style="display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; font-size: 13px;" onclick="toggleSection('exec-ctx-content', 'context', event)">
                        <span style="font-weight: bold;">▶</span>
                        <strong>Context</strong>
                    </div>
                    <div id="exec-ctx-content" style="display: none; margin-top: 10px; min-height: 200px;">
                        <div id="exec-ctx-editor" style="height: 300px; background: var(--bg-primary); border-radius: 6px; overflow: hidden;"></div>
                    </div>
                </div>
            `;
            contextEl.style.display = 'block';
            
            // Restore expanded state if it was previously set
            if (expandedSections['context']) {
                const contentDiv = contextEl.querySelector('#exec-ctx-content');
                if (contentDiv) {
                    contentDiv.style.display = 'block';
                    contextEl.querySelector('span').textContent = '▼';
                }
            }
            
            // Render the context editor
            const jsonString = typeof execution.context.CTX === 'string' 
                ? JSON.stringify(JSON.parse(execution.context.CTX), null, 2) 
                : JSON.stringify(execution.context.CTX, null, 2);
            await createOutputEditor('exec-ctx-editor', jsonString);
        }
    } else {
        contextEl.style.display = 'none';
    }

    // Update step results section
    const stepResultsEl = document.getElementById('exec-step-results');
    
    // Sort steps by executionSequence to maintain proper execution order
    const sortedSteps = execution.steps ? [...execution.steps].sort((a, b) => {
        return (a.executionSequence ?? Infinity) - (b.executionSequence ?? Infinity);
    }) : [];

    if (sortedSteps.length > 0) {
        stepResultsEl.style.display = 'block';
        
        // Create step results header if it doesn't exist
        let headerDiv = stepResultsEl.querySelector('[data-section-id="step-results"]');
        if (!headerDiv) {
            headerDiv = document.createElement('div');
            headerDiv.setAttribute('data-section-id', 'step-results');
            headerDiv.style.cssText = 'display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; font-size: 13px;';
            headerDiv.onclick = (e) => toggleSection('exec-steps-content', 'step-results', e);
            headerDiv.innerHTML = '<span style="font-weight: bold;">▶</span><strong>Step Results</strong>';
            stepResultsEl.appendChild(headerDiv);
            
            const contentDiv = document.createElement('div');
            contentDiv.id = 'exec-steps-content';
            contentDiv.style.cssText = 'display: none; margin-top: 10px;';
            stepResultsEl.appendChild(contentDiv);
        }
        
        // Get or create steps container
        let stepsContainer = stepResultsEl.querySelector('#exec-steps-content');
        
        // Update each step in sorted order
        const editorsToRender = [];
        sortedSteps.forEach(step => {
            try {
                const stepName = step.stepName || `Step ${step.executionSequence || '?'}`;
                const stepStatus = step.status;
                const stepStatusClass = getStatusClass(stepStatus);
                const seq = step.executionSequence ?? '?';

                // "Show Case Name" is a per-step display preference, snapshotted at
                // execution time into step.output.stepSettings.showCaseName (see
                // recordStepExecution in persephone.js). When enabled, the matched
                // case name(s) (step.matchedCases) take the primary/bold spot, with
                // the step's own name demoted to a secondary "(Step: X)" label -
                // skips unnamed cases (empty string) since there's nothing
                // meaningful to show for those, falling back to the plain step name.
                const showCaseNameSetting = step.output && step.output.stepSettings && step.output.stepSettings.showCaseName;
                const matchedCaseNames = (step.matchedCases || []).filter(c => c && String(c).trim().length > 0);
                const displayNameHtml = (showCaseNameSetting && matchedCaseNames.length > 0)
                    ? '<strong>' + escapeHtml(matchedCaseNames.join(', ')) + '</strong> <span style="color: var(--text-muted); font-weight: normal;">(Step: ' + escapeHtml(stepName) + ')</span>'
                    : '<strong>' + escapeHtml(stepName) + '</strong>';

                // Key by executionSequence so repeated steps (loops) each get their own element
                const stepId = `step-seq-${seq}`;
                let stepEl = stepsContainer.querySelector(`[data-step-seq="${seq}"]`);

                // Get result data
                let resultData = null;
                // An interim loop-progress marker (written mid-loop by the engine,
                // {_loopProgress: {completed, total}}) is NOT a real result - it's a
                // lightweight, best-effort status write to the same `output` column
                // a step's real final output eventually occupies. Exclude it from
                // hasResult explicitly so it doesn't get routed into the full
                // code-editor/final-result rendering below (which assumes a real
                // completed shape) - instead it's rendered as a simple progress line
                // on the still-running display further down.
                const loopProgress = (step && step.output && step.output._loopProgress) ? step.output._loopProgress : null;
                const hasResult = step && step.output && !loopProgress;
                if (hasResult) {
                    resultData = { result: step.output };
                }

                if (!stepEl) {
                    stepEl = document.createElement('div');
                    stepEl.setAttribute('data-step-seq', seq);
                    stepEl.className = 'panel-level-3';
                    stepEl.style.cssText = 'padding: 6px; margin-left: 20px; max-width: 100%; overflow: hidden;';
                    stepsContainer.appendChild(stepEl);
                }

                if (stepStatus === 'running') {
                    stepEl.style.backgroundColor = '#242424';
                } else {
                    stepEl.style.backgroundColor = '';
                }

                const executionIsTerminal = execution.status !== 'running' && execution.status !== 'pending' && execution.status !== 'cancelling';
                const lastProgress = lastRenderedLoopProgress[stepId];
                const loopProgressChanged = loopProgress && (!lastProgress || lastProgress.completed !== loopProgress.completed || lastProgress.total !== loopProgress.total);
                const isWorkflowStep = step.stepType === 'Workflow';

                // Determine sub-execution IDs for Workflow steps. This works whether the
                // step has fully completed (single executionId, or a final combined_results
                // array), or is still running a loop (the engine writes combined_results
                // incrementally as iterations finish, the same way it writes _loopProgress) -
                // so this can be non-empty even while loopProgress is also present.
                let subExecutionIds = [];
                if (isWorkflowStep && step.output) {
                    if (step.output.executionId) {
                        // Single run
                        subExecutionIds = [step.output.executionId];
                    } else if (step.output.combined_results) {
                        // Loop run (may be partial while still running)
                        subExecutionIds = step.output.combined_results
                            .map(r => r.executionId)
                            .filter(Boolean);
                    }
                }
                const showExpandable = isWorkflowStep && subExecutionIds.length > 0;

                // A finished Plugin-loop step's output is {combined_results: [...]}
                // with no executionId per item (unlike a Workflow loop) - its full
                // result is already local, so it gets its own expandable iteration
                // list rendered directly from that data instead of the raw JSON editor.
                const isPluginLoopResult = !isWorkflowStep && hasResult && step.output && Array.isArray(step.output.combined_results);

                // A running Workflow step's sub-execution id(s) show up in step.output
                // partway through - once any become available, we need to break out of
                // the early-return below so the step switches from its plain single-line
                // display into the expandable form (loop-progress changes already do this
                // for the iteration counter; this covers the ids becoming available too).
                const subExecJustBecameAvailable = showExpandable && !stepsWithSubExecAvailable[stepId];
                if (stepsWithTimersStarted[stepId] && stepStatus === 'running' && !executionIsTerminal && !loopProgressChanged && !subExecJustBecameAvailable) {
                    return;
                }
                if (loopProgress) {
                    lastRenderedLoopProgress[stepId] = { completed: loopProgress.completed, total: loopProgress.total };
                }
                if (showExpandable) {
                    stepsWithSubExecAvailable[stepId] = true;
                }

                if (stepsRenderedFinal[stepId] && !isWorkflowStep) {
                    return;
                }

                if (stepsWithTimersStarted[stepId] && stepStatus !== 'running') {
                    stopStepDurationTimer(stepId, step.duration);
                    delete stepsWithTimersStarted[stepId];
                }

                let effectiveStatus = stepStatus;
                let effectiveStatusClass = stepStatusClass;
                if (stepStatus === 'running' && executionIsTerminal) {
                    effectiveStatus = 'cancelled';
                    effectiveStatusClass = getStatusClass('cancelled');
                    const elapsed = stepDurationTimers[stepId] ? Date.now() - stepDurationTimers[stepId].startTime : (step.duration || 0);
                    stopStepDurationTimer(stepId, elapsed);
                    delete stepsWithTimersStarted[stepId];
                }

                const durationMs = step.duration || 0;
                const durationDisplay = formatDuration(durationMs);
                const spinnerHtml = '<span style="display: inline-block; width: 14px; height: 14px; border: 2px solid var(--text-muted); border-top-color: var(--text-primary); border-radius: 50%; animation: spin 0.8s linear infinite;"></span>';
                const statusBadge = effectiveStatus ? `<span class="status-badge ${effectiveStatusClass}" style="margin-left: auto;">${effectiveStatus}</span>` : '';
                const seqLabel = `<span style="color: var(--text-muted); font-weight: normal; font-size: 11px;">#${seq}</span>`;

                if (hasResult || showExpandable) {
                    const contentId = `${stepId}-content`;

                    // Small inline badge showing loop iteration count next to the
                    // header, so it's visible even while collapsed. While running,
                    // this comes from the interim _loopProgress marker; once
                    // finished, that marker is gone (replaced by the real
                    // combined_results), so fall back to combined_results.length -
                    // only for genuine loops (combined_results present), not a
                    // single Workflow run (which has step.output.executionId
                    // directly instead, and shouldn't show a "1/1" badge).
                    const finishedLoopCount = (!loopProgress && step.output && Array.isArray(step.output.combined_results))
                        ? step.output.combined_results.length
                        : null;
                    const loopProgressBadge = loopProgress
                        ? '<span style="color: var(--text-muted); font-size: 11px;">' +
                          escapeHtml(String(loopProgress.completed)) + ' / ' + escapeHtml(String(loopProgress.total)) + ' iterations</span>'
                        : (finishedLoopCount !== null
                            ? '<span style="color: var(--text-muted); font-size: 11px;">' +
                              escapeHtml(String(finishedLoopCount)) + ' / ' + escapeHtml(String(finishedLoopCount)) + ' iterations</span>'
                            : '');

                    // Only rebuild innerHTML if not yet rendered final, or if it's a Workflow step (children may update)
                    const alreadyFinal = stepsRenderedFinal[stepId] && !isWorkflowStep;
                    if (!alreadyFinal) {
                        const editorId = `${stepId}-editor`;
                        const contentInner = isWorkflowStep
                            ? '<div id="' + stepId + '-subexec" style="padding: 4px 0;"></div>'
                            : isPluginLoopResult
                                ? '<div id="' + stepId + '-plugin-loop" style="padding: 4px 0;"></div>'
                                : '<div id="' + editorId + '" style="height: 300px; background: var(--bg-primary); border-radius: 6px; overflow: hidden;"></div>';

                        stepEl.innerHTML =
                            '<div data-section-id="step-' + stepId + '" style="display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; font-size: 13px;">' +
                            (effectiveStatus === 'running' ? spinnerHtml : '') +
                            '<span data-chevron style="font-weight: bold;">▶</span>' +
                            displayNameHtml + ' ' + seqLabel +
                            '<span style="color: var(--text-muted); font-size: 12px;" id="duration-' + stepId + '">' + durationDisplay + '</span>' +
                            loopProgressBadge +
                            statusBadge +
                            '</div>' +
                            '<div id="' + contentId + '" style="display: none; margin-top: 6px;">' +
                            contentInner +
                            '</div>';

                        // Plugin-loop iterations are already fully local - render them
                        // immediately rather than lazily on expand (no fetch to defer)
                        if (isPluginLoopResult) {
                            const pluginLoopContainer = stepEl.querySelector('#' + stepId + '-plugin-loop');
                            renderPluginLoopIterations(step.output.combined_results, pluginLoopContainer, stepId);
                        }

                        // Attach onclick — Workflow steps get a custom handler that also fetches children
                        const headerEl = stepEl.querySelector('[data-section-id="step-' + stepId + '"]');
                        if (headerEl) {
                            if (showExpandable) {
                                headerEl.onclick = (e) => {
                                    toggleSection(contentId, 'step-' + stepId, e);
                                    // If now expanded, fetch sub-executions
                                    if (expandedSections['step-' + stepId]) {
                                        const subContainer = stepEl.querySelector('#' + stepId + '-subexec');
                                        if (subContainer) {
                                            renderSubExecutionSteps(subExecutionIds, subContainer, executionIsTerminal);
                                        }
                                    }
                                };
                            } else {
                                headerEl.onclick = (e) => toggleSection(contentId, 'step-' + stepId, e);
                            }
                        }
                    }

                    if (effectiveStatus === 'running') {
                        if (!stepsWithTimersStarted[stepId]) {
                            startStepDurationTimer(stepId, step.startedAt);
                            stepsWithTimersStarted[stepId] = true;
                        }
                    } else {
                        if (stepsWithTimersStarted[stepId]) {
                            stopStepDurationTimer(stepId, step.duration);
                            delete stepsWithTimersStarted[stepId];
                        }
                        if (!isWorkflowStep) stepsRenderedFinal[stepId] = true;
                    }

                    const isExpanded = expandedSections['step-' + stepId];
                    const contentDiv = stepEl.querySelector('#' + contentId);
                    if (contentDiv) {
                        if (isExpanded) {
                            contentDiv.style.display = 'block';
                            const chevron = stepEl.querySelector('[data-section-id="step-' + stepId + '"] [data-chevron]');
                            if (chevron) chevron.textContent = '▼';
                        }

                        // For Workflow steps: register sub-executions for poll cycle refresh
                        if (showExpandable) {
                            expandedSubExecutions[stepId] = subExecutionIds;
                            // If already expanded (e.g. after poll re-render), refresh children
                            if (isExpanded) {
                                const subContainer = stepEl.querySelector('#' + stepId + '-subexec');
                                if (subContainer) {
                                    renderSubExecutionSteps(subExecutionIds, subContainer, executionIsTerminal);
                                }
                            }
                        }
                    }

                    if (hasResult && !isWorkflowStep && !isPluginLoopResult) {
                        editorsToRender.push({ containerId: `${stepId}-editor`, data: resultData.result });
                    }

                } else {
                    const loopProgressHtml = loopProgress
                        ? '<div style="margin-left: 24px; margin-top: 2px; font-size: 12px; color: var(--text-muted);">Loop Iterations Finished: ' +
                          escapeHtml(String(loopProgress.completed)) + ' / ' + escapeHtml(String(loopProgress.total)) + '</div>'
                        : '';
                    stepEl.innerHTML =
                        '<div style="display: flex; align-items: center; gap: 10px; font-size: 13px;">' +
                        (effectiveStatus === 'running' ? spinnerHtml : '') +
                        displayNameHtml + ' ' + seqLabel +
                        '<span style="color: var(--text-muted); font-size: 12px;" id="duration-' + stepId + '">' + durationDisplay + '</span>' +
                        statusBadge +
                        '</div>' +
                        loopProgressHtml;

                    if (effectiveStatus === 'running') {
                        if (!stepsWithTimersStarted[stepId]) {
                            startStepDurationTimer(stepId, step.startedAt);
                            stepsWithTimersStarted[stepId] = true;
                        }
                    } else {
                        if (stepsWithTimersStarted[stepId]) {
                            stopStepDurationTimer(stepId, step.duration);
                            delete stepsWithTimersStarted[stepId];
                        }
                        stepsRenderedFinal[stepId] = true;
                    }
                }
            } catch (err) {
                console.error('[RenderExecutionDetail] Error rendering step:', { step, error: err.message, stack: err.stack });
            }
        });

        // Render all editors
        for (const editor of editorsToRender) {
            try {
                let jsonString = '';
                if (editor.data) {
                    jsonString = typeof editor.data === 'string' 
                        ? JSON.stringify(JSON.parse(editor.data), null, 2) 
                        : JSON.stringify(editor.data, null, 2);
                }
                await createOutputEditor(editor.containerId, jsonString);
            } catch (err) {
                console.error('[RenderExecution] Editor render error:', err);
                // Fallback to displaying the error
                const container = document.getElementById(editor.containerId);
                if (container) {
                    container.innerHTML = `<div style="color: #ff6b6b; padding: 10px;">Error rendering output: ${err.message}</div>`;
                }
            }
        }
        
        // Restore step results expanded state
        if (expandedSections['step-results']) {
            const contentDiv = stepResultsEl.querySelector('#exec-steps-content');
            if (contentDiv) {
                contentDiv.style.display = 'block';
                stepResultsEl.querySelector('span').textContent = '▼';
            }
        }
    } else {
        stepResultsEl.style.display = 'none';
    }
}


// Expose functions to global scope
/**
 * Render the step list inside an expanded sub-execution container
 */
function renderSubExecStepList(subExecution, stepsContainer) {
    if (!subExecution.steps || subExecution.steps.length === 0) return;
    const sorted = [...subExecution.steps].sort((a, b) =>
        (a.executionSequence ?? Infinity) - (b.executionSequence ?? Infinity));
    const subIsTerminal = subExecution.status !== 'running' && subExecution.status !== 'pending';
    const spinnerHtml = '<span style="display: inline-block; width: 12px; height: 12px; border: 2px solid var(--text-muted); border-top-color: var(--text-primary); border-radius: 50%; animation: spin 0.8s linear infinite;"></span>';

    sorted.forEach(step => {
        const stepName = step.stepName || 'Step ' + step.executionSequence;
        const seq = step.executionSequence ?? '?';
        const subStepId = 'subexec-' + subExecution.executionId + '-step-' + seq;
        const effectiveStatus = (step.status === 'running' && subIsTerminal) ? 'cancelled' : step.status;
        const effectiveClass = getStatusClass(effectiveStatus);
        const durationDisplay = formatDuration(step.duration || 0);
        const hasOutput = step.output && Object.keys(step.output).length > 0;
        const hasError = !!step.error;
        const isExpandable = hasOutput || hasError;
        const contentId = subStepId + '-content';
        const editorId = subStepId + '-editor';

        // Same "Show Case Name" handling as the top-level step renderer above
        const showCaseNameSetting = step.output && step.output.stepSettings && step.output.stepSettings.showCaseName;
        const matchedCaseNames = (step.matchedCases || []).filter(c => c && String(c).trim().length > 0);
        const displayNameHtml = (showCaseNameSetting && matchedCaseNames.length > 0)
            ? '<strong>' + escapeHtml(matchedCaseNames.join(', ')) + '</strong> <span style="color: var(--text-muted); font-weight: normal;">(Step: ' + escapeHtml(stepName) + ')</span>'
            : '<strong>' + escapeHtml(stepName) + '</strong>';

        let stepEl = stepsContainer.querySelector('[data-sub-step-id="' + subStepId + '"]');
        if (!stepEl) {
            stepEl = document.createElement('div');
            stepEl.setAttribute('data-sub-step-id', subStepId);
            stepEl.className = 'panel-level-5';
            stepEl.style.cssText = 'padding: 3px 0 3px 6px; margin-bottom: 2px;';
            stepsContainer.appendChild(stepEl);
        }

        // Build header
        const headerHtml =
            '<div data-sub-step-header style="display: flex; align-items: center; gap: 8px; font-size: 12px;' +
            (isExpandable ? ' cursor: pointer; user-select: none;' : '') + '">' +
            (effectiveStatus === 'running' ? spinnerHtml : (isExpandable ? '<span style="font-weight: bold;">▶</span>' : '')) +
            displayNameHtml +
            '<span style="color: var(--text-muted); font-size: 11px;">#' + seq + '</span>' +
            '<span style="color: var(--text-muted); font-size: 11px;">' + durationDisplay + '</span>' +
            '<span class="status-badge ' + effectiveClass + '" style="margin-left: auto; font-size: 11px;">' + effectiveStatus + '</span>' +
            '</div>';

        const contentHtml = isExpandable
            ? '<div id="' + contentId + '" style="display: none; margin-top: 6px;">' +
              (hasError
                  ? '<pre style="background: var(--bg-primary); border-radius: 4px; padding: 8px; color: #ff6b6b; font-size: 11px; margin: 0; white-space: pre-wrap;">' + escapeHtml(step.error) + '</pre>'
                  : '<div id="' + editorId + '" style="height: 200px; background: var(--bg-primary); border-radius: 6px; overflow: hidden;"></div>') +
              '</div>'
            : '';

        stepEl.innerHTML = headerHtml + contentHtml;

        // Attach expand onclick for expandable steps
        if (isExpandable) {
            const headerEl = stepEl.querySelector('[data-sub-step-header]');
            const sectionKey = subStepId + '-expanded';
            if (headerEl) {
                headerEl.onclick = (e) => {
                    e.stopPropagation();
                    const contentDiv = stepEl.querySelector('#' + contentId);
                    if (!contentDiv) return;
                    const isHidden = contentDiv.style.display === 'none';
                    contentDiv.style.display = isHidden ? 'block' : 'none';
                    const chevron = headerEl.querySelector('span[style*="font-weight"]');
                    if (chevron) chevron.textContent = isHidden ? '▼' : '▶';
                    if (isHidden && hasOutput && !hasError) {
                        // Lazy-render CodeMirror editor on first expand
                        const editorEl = document.getElementById(editorId);
                        if (editorEl && !editorEl.querySelector('.cm-editor')) {
                            const jsonString = typeof step.output === 'string'
                                ? JSON.stringify(JSON.parse(step.output), null, 2)
                                : JSON.stringify(step.output, null, 2);
                            createOutputEditor(editorId, jsonString);
                        }
                    }
                };
            }
        }
    });
}

/**
 * Render the individual iteration results of a finished Plugin-loop step.
 * Unlike Workflow-loop iterations (which are separate trackable executions,
 * fetched on demand via renderSubExecutionSteps), Plugin-loop iterations have
 * no executionId of their own - their full result already lives in
 * step.output.combined_results, so this renders directly from that local data,
 * synchronously, with no fetch involved.
 * @param {Array} combinedResults - Array of {index, status, duration, outputs, error?}
 * @param {HTMLElement} container - Where to render the iteration list
 * @param {string} stepId - Parent step's element key, used to namespace child element ids
 */
function renderPluginLoopIterations(combinedResults, container, stepId) {
    if (!container) return;
    const sorted = [...combinedResults].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));

    sorted.forEach(item => {
        const iterId = stepId + '-iter-' + item.index;
        const statusClass = getStatusClass(item.status);
        const durationDisplay = formatDuration(item.duration || 0);
        const hasOutput = item.outputs && Object.keys(item.outputs).length > 0;
        const hasError = !!item.error;
        const isExpandable = hasOutput || hasError;
        const contentId = iterId + '-content';
        const editorId = iterId + '-editor';

        const iterEl = document.createElement('div');
        iterEl.setAttribute('data-plugin-iter-id', iterId);
        iterEl.className = 'panel-level-4';
        iterEl.style.cssText = 'padding: 3px 0 3px 6px; margin-bottom: 2px;';

        const headerHtml =
            '<div data-plugin-iter-header style="display: flex; align-items: center; gap: 8px; font-size: 12px;' +
            (isExpandable ? ' cursor: pointer; user-select: none;' : '') + '">' +
            (isExpandable ? '<span data-chevron style="font-weight: bold;">▶</span>' : '') +
            '<strong>Iteration ' + item.index + '</strong>' +
            '<span style="color: var(--text-muted); font-size: 11px;">' + durationDisplay + '</span>' +
            '<span class="status-badge ' + statusClass + '" style="margin-left: auto; font-size: 11px;">' + item.status + '</span>' +
            '</div>';

        const contentHtml = isExpandable
            ? '<div id="' + contentId + '" style="display: none; margin-top: 6px;">' +
              (hasError
                  ? '<pre style="background: var(--bg-primary); border-radius: 4px; padding: 8px; color: #ff6b6b; font-size: 11px; margin: 0; white-space: pre-wrap;">' + escapeHtml(item.error) + '</pre>'
                  : '<div id="' + editorId + '" style="height: 200px; background: var(--bg-primary); border-radius: 6px; overflow: hidden;"></div>') +
              '</div>'
            : '';

        iterEl.innerHTML = headerHtml + contentHtml;
        container.appendChild(iterEl);

        if (isExpandable) {
            const headerEl = iterEl.querySelector('[data-plugin-iter-header]');
            if (headerEl) {
                headerEl.onclick = (e) => {
                    e.stopPropagation();
                    const contentDiv = iterEl.querySelector('#' + contentId);
                    if (!contentDiv) return;
                    const isHidden = contentDiv.style.display === 'none';
                    contentDiv.style.display = isHidden ? 'block' : 'none';
                    const chevron = headerEl.querySelector('[data-chevron]');
                    if (chevron) chevron.textContent = isHidden ? '▼' : '▶';
                    if (isHidden && hasOutput && !hasError) {
                        // Lazy-render CodeMirror editor on first expand
                        const editorEl = document.getElementById(editorId);
                        if (editorEl && !editorEl.querySelector('.cm-editor')) {
                            const jsonString = JSON.stringify(item.outputs, null, 2);
                            createOutputEditor(editorId, jsonString);
                        }
                    }
                };
            }
        }
    });
}

/**
 * Render sub-execution steps inside an expanded Workflow step
 * For loop runs, renders one section per sub-execution with its steps nested inside
 */
async function renderSubExecutionSteps(executionIds, container, parentIsTerminal) {
    for (const subExecId of executionIds) {
        try {
            const subExecution = await fetchExecutionDetail(subExecId);
            const isLoop = executionIds.length > 1;

            // Get or create a container for this sub-execution
            let subExecEl = container.querySelector('[data-sub-exec-id="' + subExecId + '"]');
            if (!subExecEl) {
                subExecEl = document.createElement('div');
                subExecEl.setAttribute('data-sub-exec-id', subExecId);
                subExecEl.className = 'panel-level-4';
                subExecEl.style.cssText = 'padding: 4px 0 4px 6px; margin-bottom: 4px;';
                container.appendChild(subExecEl);
            }

            const statusClass = getStatusClass(subExecution.status);
            const statusBadge = '<span class="status-badge ' + statusClass + '">' + subExecution.status + '</span>';
            const workflowName = subExecution.workflowName || ('Sub-execution #' + subExecId);
            const headerText = isLoop
                ? workflowName + ' <span style="color: var(--text-muted); font-size: 11px;">#' + subExecId + '</span>'
                : workflowName + ' <span style="color: var(--text-muted); font-size: 11px;">#' + subExecId + '</span>';
            const subContentId = 'subexec-' + subExecId + '-steps';

            // Build or update header
            let headerEl = subExecEl.querySelector('[data-sub-exec-header]');
            if (!headerEl) {
                headerEl = document.createElement('div');
                headerEl.setAttribute('data-sub-exec-header', '1');
                headerEl.style.cssText = 'display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; user-select: none;';
                subExecEl.appendChild(headerEl);

                const stepsContainer = document.createElement('div');
                stepsContainer.id = subContentId;
                stepsContainer.style.cssText = 'display: none; margin-top: 4px; padding-left: 12px;';
                subExecEl.appendChild(stepsContainer);
            }

            // Attach onclick with immediate child rendering on expand
            headerEl.onclick = (e) => {
                e.stopPropagation();
                const stepsDiv = subExecEl.querySelector('#' + subContentId);
                if (!stepsDiv) return;
                const isHidden = stepsDiv.style.display === 'none';
                stepsDiv.style.display = isHidden ? 'block' : 'none';
                const chevron = headerEl.querySelector('span[data-chevron]');
                if (chevron) chevron.textContent = isHidden ? '▼' : '▶';
                if (isHidden) {
                    expandedSections['subexec-hdr-' + subExecId] = true;
                    renderSubExecStepList(subExecution, stepsDiv);
                } else {
                    delete expandedSections['subexec-hdr-' + subExecId];
                }
            };

            const isExpanded = expandedSections['subexec-hdr-' + subExecId];
            headerEl.innerHTML =
                '<span data-chevron style="font-weight: bold;">' + (isExpanded ? '▼' : '▶') + '</span>' +
                '<span>' + headerText + '</span> ' +
                '<span style="margin-left: auto;">' + statusBadge + '</span>';

            // Re-render steps if already expanded (poll refresh)
            if (isExpanded) {
                const stepsContainer = subExecEl.querySelector('#' + subContentId);
                if (stepsContainer) {
                    stepsContainer.style.display = 'block';
                    renderSubExecStepList(subExecution, stepsContainer);
                }
            }
        } catch (err) {
            console.error('[renderSubExecutionSteps] Error fetching sub-execution ' + subExecId + ':', err);
        }
    }
}

window.expandedSubExecutions = expandedSubExecutions;
window.executeWorkflow = executeWorkflow;
window.fetchExecutionDetail = fetchExecutionDetail;
window.fetchExecutionSummaries = fetchExecutionSummaries;
window.formatDuration = formatDuration;
window.formatJson = formatJson;
window.formatTimestamp = formatTimestamp;
window.generateExecDetailHTML = generateExecDetailHTML;
window.getStatusClass = getStatusClass;
window.pollExecutionStatus = pollExecutionStatus;
/**
 * Cancel a running execution
 */
async function cancelExecution(executionId) {
    showConfirm(
        'Cancel Execution',
        'Are you sure you want to cancel this execution?',
        async () => {
            try {
                const response = await fetch(`/engine/executions/${executionId}/cancel`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(window.sessionToken && { 'X-Session-Token': window.sessionToken })
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const result = await response.json();
                console.log('[CancelExecution] Execution cancelled:', result);
                showStatusBanner('Execution cancelled', 'success');
                
                // The next poll will fetch the updated status
            } catch (error) {
                console.error('[CancelExecution] Error:', error);
                showStatusBanner('Failed to cancel execution: ' + error.message, 'error');
            }
        },
        'Cancel Execution'
    );
}

window.cancelExecution = cancelExecution;
window.renderExecutionDetail = renderExecutionDetail;
window.showExecutionResults = showExecutionResults;
window.showOutputHtmlModal = showOutputHtmlModal;
window.showPersistentExecutionBanner = showPersistentExecutionBanner;
window.startPollingExecution = startPollingExecution;
window.stopPollingExecution = stopPollingExecution;
window.toggleSection = toggleSection;
window.cleanupPreviousExecution = cleanupPreviousExecution;
window.stepsWithTimersStarted = stepsWithTimersStarted;
window.stepsRenderedFinal = stepsRenderedFinal;
window.stepDurationTimers = stepDurationTimers;
window.startStepDurationTimer = startStepDurationTimer;
window.stopStepDurationTimer = stopStepDurationTimer;