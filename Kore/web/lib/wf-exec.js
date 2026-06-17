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
function startStepDurationTimer(stepId) {
    // Clear existing timer if any
    if (stepDurationTimers[stepId]) {
        clearInterval(stepDurationTimers[stepId].timerId);
    }
    
    const startTime = Date.now();
    
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
    
    // Update the toggle arrow (find span in the clicked element)
    const clickedDiv = event.currentTarget;
    const toggleSpan = clickedDiv.querySelector('span');
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
    const { limit = 50, offset = 0, status = null, workflowId = null } = options;
    
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
async function executeWorkflow(parameters) {
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
        
        try {
            const execution = await fetchExecutionDetail(executionId);
            
            // Re-render with latest data
            await renderExecutionDetail(execution, container, backButton);
            
            // Stop polling if execution completed or was cancelled (but not cancelling - still in progress)
            if (execution.status !== 'running' && execution.status !== 'pending' && execution.status !== 'cancelling') {
                stopPollingExecution(executionId);
                // Wait for any in-flight step DB writes to complete, then do final render
                await new Promise(resolve => setTimeout(resolve, 1000));
                const finalExecution = await fetchExecutionDetail(executionId);
                await renderExecutionDetail(finalExecution, container, backButton);
            }
        } catch (error) {
            console.error('[GenerateExecDetail] Polling error:', error);
            // Continue polling despite errors
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
    header.innerHTML = `
        ${backButton ? '<button class="btn" data-size="sm" data-color="slate" onclick="window.history.back()">← Back</button>' : ''}
        <h2 style="margin: 0; flex: 1; font-size: 16px;">Execution Details: ${escapeHtml(String(execution.workflowName || 'Unknown'))}</h2>
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
    document.getElementById('exec-summary').innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Execution ID:</span>
                <span style="font-family: monospace; font-size: 13px; word-break: break-all;">${escapeHtml(String(execution.executionId))}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Status:</span>
                <span class="status-badge ${statusClass}">${execution.status}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Started:</span>
                <span style="font-size: 13px;">${formatTimestamp(execution.triggeredAt)}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Duration:</span>
                <span style="font-family: monospace; font-size: 13px;" id="exec-duration-display">${duration}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Completed:</span>
                <span style="font-size: 13px;">${execution.completedAt ? formatTimestamp(execution.completedAt) : '—'}</span>
            </div>
            <div style="display: flex; gap: 4px; align-items: baseline;">
                <span style="color: var(--text-muted); font-size: 12px;">Triggered By:</span>
                <span style="font-size: 13px;">${escapeHtml(String(execution.triggeredByUser || execution.triggeredBy || 'System'))}</span>
            </div>
        </div>
    `;
    
    // Control execution duration timer
    if (execution.status === 'running' || execution.status === 'pending' || execution.status === 'cancelling') {
        startExecutionDurationTimer(execution.triggeredAt);
    } else {
        stopExecutionDurationTimer(execution.duration);
    }

    // Update errors section
    const errorsEl = document.getElementById('exec-errors');
    if (execution.errors && execution.errors.length > 0) {
        errorsEl.innerHTML = `
            <div class="panel-level-2" style="border-left: 3px solid #ff6b6b;">
                <div style="color: #ff6b6b; font-weight: 600; margin-bottom: 10px;">Errors</div>
                <pre style="background: var(--bg-primary); border-radius: 4px; padding: 10px; overflow-x: auto; color: #ff6b6b; margin: 0;">${escapeHtml(formatJson(execution.errors))}</pre>
            </div>
        `;
        errorsEl.style.display = 'block';
    } else {
        errorsEl.style.display = 'none';
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

                // Key by executionSequence so repeated steps (loops) each get their own element
                const stepId = `step-seq-${seq}`;
                let stepEl = stepsContainer.querySelector(`[data-step-seq="${seq}"]`);

                // Get result data
                let resultData = null;
                const hasResult = step && step.output;
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
                if (stepsWithTimersStarted[stepId] && stepStatus === 'running' && !executionIsTerminal) {
                    return;
                }

                if (stepsRenderedFinal[stepId]) {
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

                if (hasResult) {
                    const contentId = `${stepId}-content`;
                    const editorId = `${stepId}-editor`;

                    stepEl.innerHTML =
                        '<div data-section-id="step-' + stepId + '" style="display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; font-size: 13px;" onclick="toggleSection(' + "'" + contentId + "'" + ', ' + "'step-" + stepId + "'" + ', event)">' +
                        (effectiveStatus === 'running' ? spinnerHtml : '<span style="font-weight: bold;">▶</span>') +
                        '<strong>' + escapeHtml(stepName) + '</strong> ' + seqLabel +
                        '<span style="color: var(--text-muted); font-size: 12px;" id="duration-' + stepId + '">' + durationDisplay + '</span>' +
                        statusBadge +
                        '</div>' +
                        '<div id="' + contentId + '" style="display: none; margin-top: 10px; min-height: 200px;">' +
                        '<div id="' + editorId + '" style="height: 300px; background: var(--bg-primary); border-radius: 6px; overflow: hidden;"></div>' +
                        '</div>';

                    if (effectiveStatus === 'running') {
                        if (!stepsWithTimersStarted[stepId]) {
                            startStepDurationTimer(stepId);
                            stepsWithTimersStarted[stepId] = true;
                        }
                    } else {
                        if (stepsWithTimersStarted[stepId]) {
                            stopStepDurationTimer(stepId, step.duration);
                            delete stepsWithTimersStarted[stepId];
                        }
                        stepsRenderedFinal[stepId] = true;
                    }

                    if (expandedSections['step-' + stepId]) {
                        const contentDiv = stepEl.querySelector('#' + contentId);
                        if (contentDiv) {
                            contentDiv.style.display = 'block';
                            stepEl.querySelector('span').textContent = '▼';
                        }
                    }

                    editorsToRender.push({ containerId: editorId, data: resultData.result });

                } else {
                    stepEl.innerHTML =
                        '<div style="display: flex; align-items: center; gap: 10px; font-size: 13px;">' +
                        (effectiveStatus === 'running' ? spinnerHtml : '') +
                        '<strong>' + escapeHtml(stepName) + '</strong> ' + seqLabel +
                        '<span style="color: var(--text-muted); font-size: 12px;" id="duration-' + stepId + '">' + durationDisplay + '</span>' +
                        statusBadge +
                        '</div>';

                    if (effectiveStatus === 'running') {
                        if (!stepsWithTimersStarted[stepId]) {
                            startStepDurationTimer(stepId);
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