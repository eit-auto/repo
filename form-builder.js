// Username from rewstUser (initialized by security.js)
// No need to set userName separately - we use rewstUser.username directly in formConfig

// ============================================
// REWST APP LIBRARY (Simplified)
// ============================================
class RewstApp {
    constructor(config = {}) {
        this.graphqlUrl = config.graphqlPath || '/graphql';
        this.orgId = config.orgId || null;
        this.isInitialized = config.orgId ? true : false;
        this.debugMode = config.debug || false;
    }

    _log(...args) {
        if (this.debugMode) console.log('[Rewst]', ...args);
    }

    _error(message, error) {
        console.error(`[Rewst Error] ${message}`);
        if (error) console.error('Details:', error);
    }

    async getWorkflowTriggers(workflowId) {
        const query = `
            query getTriggers($id: ID!) {
                workflowTriggers: workflow(where: {id: $id}) {
                    triggers {
                        id
                        enabled
                        orgInstances {
                            id
                            orgId
                        }
                    }
                }
            }
        `;

        const result = await this._graphql('getTriggers', query, { id: workflowId });
        return result.workflowTriggers?.triggers || [];
    }

    async runWorkflowSmart(workflowId, inputData = {}, options = {}) {
        if (!this.isInitialized) {
            throw new Error('Rewst not initialized. Call rewst.init(orgId) first!');
        }

        console.log('[runWorkflowSmart] ENTRY - Starting workflow execution:', workflowId);
        this._log('Running workflow (smart mode):', workflowId);

        console.log('[runWorkflowSmart] Executing workflow via runWorkflowWithWait');
        const result = await this.runWorkflowWithWait(workflowId, inputData, options);
        console.log('[runWorkflowSmart] Execution completed - Returning result');
        return result;
    }

    async runWorkflowWithWait(workflowId, inputData = {}, options = {}) {
        const query = `
            mutation testWorkflow($id: ID!, $orgId: ID!, $input: JSON) {
                testResult: testWorkflow(id: $id, orgId: $orgId, input: $input) {
                    executionId
                }
            }
        `;

        const testResult = await this._graphql('testWorkflow', query, { 
            id: workflowId, 
            orgId: this.orgId,
            input: inputData 
        });
        this._log('Workflow execution started:', testResult.testResult.executionId);
        
        return await this._waitForCompletion(testResult.testResult.executionId, options.onProgress);
    }

    async runWorkflowWithTrigger(triggerInstanceId, triggerId, inputData = {}, options = {}) {
        const query = `
            mutation testTrigger($input: JSON, $triggerInstance: OrgTriggerInstanceInput!) {
                testResult: testWorkflowTrigger(triggerInstance: $triggerInstance, input: $input) {
                    executionId
                }
            }
        `;

        const result = await this._graphql('testTrigger', query, {
            input: inputData,
            triggerInstance: {
                id: triggerInstanceId,
                orgId: this.orgId,
                isManualActivation: true,
                organization: { id: this.orgId, name: 'Current Org' },
                trigger: { id: triggerId, vars: [], orgId: this.orgId }
            }
        });

        return await this._waitForCompletion(result.testResult.executionId, options.onProgress);
    }

    async getExecutionStatus(executionId) {
        const query = `
            query getExecution($id: ID!) {
                workflowExecution(where: {id: $id}) {
                    id
                    childExecutions {
                        id
                    }
                    completionHandledExecution {
                        id
                    }
                    completionHandlerExecutions {
                        id
                    }
                    conductor {
                        errors
                        output
                    }
                    createdAt
                    numAwaitingResponseTasks
                    numSuccessfulTasks
                    organization {
                        id
                        name
                    }
                    orgId
                    originatingExecutionId
                    parentExecution {
                        id
                    }
                    parentExecutionId
                    parentTaskExecutionId
                    pendingTasks {
                        id
                    }
                    processedCompletionAt
                    status
                    subExecutions {
                        id
                    }
                    taskLogs {
                        id
                        createdAt
                        updatedAt
                        status
                        message
                    }
                    updatedAt
                    workflow {
                        id
                        name
                    }
                }
            }
        `;


        const pollInterval = 2000;
        const maxAttempts = 150;
        let attempts = 0;

        await new Promise(resolve => setTimeout(resolve, 500));

        while (attempts < maxAttempts) {
            try {
                const execution = await this.getExecutionStatus(executionId);

                if (onProgress) {
                    try {
                        onProgress(execution.status, execution.numSuccessfulTasks);
                    } catch (e) {}
                }

                const terminalStates = ['COMPLETED', 'SUCCESS', 'succeeded', 'FAILED', 'failed', 'ERROR'];
                const isComplete = terminalStates.some(s => execution.status.toUpperCase() === s.toUpperCase());

                if (isComplete) {
                    const isFailed = ['FAILED', 'failed', 'ERROR'].some(s => execution.status.toUpperCase() === s.toUpperCase());
                    if (isFailed) {
                        throw new Error(`Workflow failed: ${execution.status} - ${execution.conductor?.errors ? JSON.stringify(execution.conductor.errors) : 'No error details'}`);
                    }
                    
                    // Check if conductor.output is populated
                    if (!execution.conductor || !execution.conductor.output) {
                        this._log('Workflow completed but conductor.output is null, polling a few more times...');
                        
                        // Poll up to 3 more times with 2 second intervals
                        for (let extraAttempts = 0; extraAttempts < 3; extraAttempts++) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            const retryExecution = await this.getExecutionStatus(executionId);
                            
                            if (retryExecution.conductor && retryExecution.conductor.output) {
                                this._log('conductor.output now available after extra polling');
                                return { ...retryExecution, success: true };
                            }
                            this._log(`Extra poll attempt ${extraAttempts + 1}/3 - conductor.output still null`);
                        }
                        
                        // Return even if output is still null after extra attempts
                        this._log('Returning execution even though conductor.output is still null');
                    }
                    
                    return { ...execution, success: true };
                }

                await new Promise(resolve => setTimeout(resolve, pollInterval));
                attempts++;

            } catch (err) {
                this._error('Error checking execution status', err);
                throw err;
            }
        }

        throw new Error('Workflow execution timeout');
    }

    async runWorkflow(workflowId, inputData = {}) {
        if (!this.isInitialized) {
            throw new Error('Rewst not initialized. Missing orgId.');
        }

        this._log('Running workflow:', workflowId);

        // Try direct execution first
        try {
            const query = `
                mutation testWorkflow($id: ID!, $orgId: ID!, $input: JSON) {
                    testResult: testWorkflow(id: $id, orgId: $orgId, input: $input) {
                        executionId
                    }
                }
            `;

            const result = await this._graphql('testWorkflow', query, { 
                id: workflowId, 
                orgId: this.orgId,
                input: inputData 
            });
            
            this._log('Workflow execution started:', result.testResult.executionId);
            return result.testResult;
            
        } catch (firstError) {
            this._log('Direct execution failed, trying trigger-based execution');
            
            // Fallback to trigger-based execution
            const triggers = await this.getWorkflowTriggers(workflowId);
            
            if (!triggers || triggers.length === 0) {
                throw new Error('Workflow has no triggers configured');
            }

            const enabledTrigger = triggers.find(t => t.enabled);
            if (!enabledTrigger) {
                throw new Error('No enabled triggers found');
            }

            const instance = enabledTrigger.orgInstances?.find(inst => inst.orgId === this.orgId);
            if (!instance) {
                throw new Error(`No trigger instance found for org ${this.orgId}`);
            }

            const triggerQuery = `
                mutation testTrigger($input: JSON, $triggerInstance: OrgTriggerInstanceInput!) {
                    testResult: testWorkflowTrigger(triggerInstance: $triggerInstance, input: $input) {
                        executionId
                    }
                }
            `;

            const triggerResult = await this._graphql('testTrigger', triggerQuery, {
                input: inputData,
                triggerInstance: {
                    id: instance.id,
                    orgId: this.orgId,
                    isManualActivation: true,
                    organization: { id: this.orgId, name: 'Current Org' },
                    trigger: { id: enabledTrigger.id, vars: [], orgId: this.orgId }
                }
            });

            this._log('Workflow execution started via trigger:', triggerResult.testResult.executionId);
            return triggerResult.testResult;
        }
    }

    async _graphql(operationName, query, variables) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetch(this.graphqlUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, variables, operationName }),
                signal: controller.signal
            });

            if (!response.ok) {
                const responseText = await response.text();
                throw new Error(`HTTP ${response.status}: ${responseText}`);
            }
            
            const data = await response.json();
            if (data.errors) {
                throw new Error(data.errors[0]?.message || 'GraphQL error');
            }
            
            return data.data;
        } catch (err) {
            throw err;
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ============================================
// INITIALIZATION
// ============================================

const rewst = new RewstApp({ 
    graphqlPath: '/graphql',
    orgId: ORG_ID,
    debug: true
});

// ============================================
// FIELD CONFIGURATION
// ============================================
const fieldConfigs = [];

// ============================================
// ELEMENT TYPE CONFIGURATION
// ============================================
// Centralized configuration for all element types
const ELEMENT_TYPE_DEFAULTS = {
    'array': {
        items: {},
        repeating_input_mode: false,
        source: ''
    },
    'checkbox': {
        default_checked: false
    },
    'radio': {
        options: {
            option1: 'value1',
            option2: 'value2'
        },
        default_select: 'option1'
    },
    'text': {
        default_value: null
    },
    'form_extend': {
        extend_var: null
    },
    'textarea': {
        default_value: null
    },
    'html': {
        content: ''
    },
    'horizontal_line': {
        content: '<hr style="margin: 10px 0;"><br>'
    },
    'date': {
        default_value: null
    },
    'date_time': {
        default_value: null
    },
    'dropdown_static': {
        options: {
            option1: 'Value 1',
            option2: 'Value 2',
            option3: 'Value 3'
        },
        default_value: null,
        multi_select: false,
        result_var: ''
    },
    'dropdown': {
        workflow_id: '',
        workflow_input: {},
        label_name: 'name',
        value_name: 'id',
        default_selector: 'default',
        multi_select: false,
        result_var: ''
    },
    'dropdown_graphql': {
        graphql_op: '',
        label_name: 'name',
        value_name: 'id',
        multi_select: false,
        result_var: ''
    },
    'dropdown_mysql': {
        query: '',
        label_field: '',
        value_field: '',
        multi_select: false,
        default_value: null,
        result_var: ''
    },
    'dropdown_mesh': {
        mode: 'powershell',             // 'cmd' | 'powershell' | 'nodes'
        node_selection_type: 'fixed',   // 'fixed' | 'query' (for cmd/powershell modes)
        node_id: '',                    // For fixed/variable node selection (hardcoded, [[field]], or [[var]])
        node_query: '',                 // For query-based node selection
        command: '',                    // For cmd/powershell modes
        label_field: '',
        value_field: '',
        multi_select: false,
        default_value: null,
        result_var: ''
    },
    'data_retrieval': {
        data_source_type: 'mesh_powershell',        // 'mesh_cmd' | 'mesh_powershell' | 'mesh_nodes' | 'mysql' | 'workflow' | 'graphql'
        // Mesh fields
        node_selection_type: 'fixed',
        node_id: '',
        node_query: '',
        command: '',
        // MySQL fields
        query: ''
    },
    'dropdown_prefetch': {
        source_element_name: '',        // Field name of data_retrieval element
        result_path: '',                // Path to data array: "ad_users" or "data.users"
        label_field: '',
        value_field: '',
        multi_select: false,
        default_value: null,
        result_var: ''
    },
    'datatable': {
        data_variable: '',              // Variable name/path to JSON array
        list_view: false                // true = list format, false = table format
    }
};

// List of all available element types
const ELEMENT_TYPES = Object.keys(ELEMENT_TYPE_DEFAULTS);

/**
 * Palette display configuration
 * Maps internal element types to their display names in the palette
 * Consolidates dropdown variants (dropdown, dropdown_static, dropdown_graphql) into single "Dropdown" entry
 */
const PALETTE_DISPLAY = {
    'array': 'Array',
    'checkbox': 'Checkbox',
    'radio': 'Radio',
    'text': 'Text',
    'form_extend': 'Form Extend',
    'textarea': 'Textarea',
    'html': 'HTML',
    'horizontal_line': 'Horizontal Line',
    'date': 'Date',
    'date_time': 'Date Time',
    'dropdown': 'Dropdown',  // Consolidates dropdown, dropdown_static, dropdown_graphql, dropdown_mysql, dropdown_mesh, dropdown_prefetch
    'data_retrieval': 'Data Retrieval',
    'datatable': 'Datatable'
};

// ============================================
// ORG VARIABLE OPERATIONS
// ============================================
async function fetchExistingFormsList() {
    
    try {
        console.log('[FETCH FORMS] Starting fetch...');
        
        // Use the exact same GraphQL query that works for Open Existing
        const response = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `{
                    visibleOrgVariables(
                        visibleForOrgId: "${ORG_ID}"
                        search: { 
                            organization: { id: { _eq: "${ORG_ID}" } }
                            name: { _ilike: "form_%" }
                        }
                    ) {
                        id
                        name
                        value
                        category
                        cascade
                        createdAt
                        updatedAt
                        organization {
                            id
                            name
                        }
                        packConfig {
                            id
                            name
                        }
                    }
                }`
            })
        });
        
        const data = await response.json();
        console.log('[FETCH FORMS] Response received:', data);
        
        if (data.errors) {
            console.error('[FETCH FORMS] GraphQL errors:', data.errors);
            const errorMessages = data.errors.map(err => err.message).join('\n');
            throw new Error(`Failed to fetch existing forms:\n${errorMessages}`);
        }
        
        const orgVariables = data.data?.visibleOrgVariables || [];
        console.log('[FETCH FORMS] Found', orgVariables.length, 'forms');
        
        return orgVariables.map(variable => {
            try {
                const parsed = JSON.parse(variable.value);
                return {
                    form_id: variable.name,
                    form_name: parsed.form_name || variable.name,
                    form_config: variable.value,
                    form_config_parsed: parsed
                };
            } catch (e) {
                console.warn('[FETCH FORMS] Could not parse form config for:', variable.name);
                return {
                    form_id: variable.name,
                    form_name: variable.name,
                    form_config: variable.value,
                    form_config_parsed: null
                };
            }
        });
    } catch (error) {
        console.error('[FETCH FORMS] Exception:', error.message);
        throw error;
    }
}


// ============================================
// WORKFLOW FETCHING
// ============================================
// Workflows are fetched and populated by RewstLib.workflows.fetchAndPopulate()
let availableWorkflows = [];
let availableWorkflowsOG = [];

// ============================================
// OPEN EXISTING FORM FUNCTIONALITY
// ============================================
let availableForms = [];
let formsAlreadyFetched = false;
let formsCurrentlyFetching = false; // Track if fetch is in progress
let formsFetchPromise = null; // Store the promise so multiple calls can await the same fetch
let loadedFormId = null; // Track the ID of the currently loaded form

// DOM element references declared early so they're available throughout the code
let openExistingLoading = null;
let openExistingDropdown = null;
let loadFormBtn = null;
let deleteFormBtn = null;
let columnsSelect = null;
let formColumnsSelect = null;
let settingsPanel = null;
let emptySettings = null;
let settingsForm = null;

async function fetchExistingForms() {
    // If already fetched, return immediately
    if (formsAlreadyFetched) {
        console.log('Forms already fetched, skipping...');
        return;
    }
    
    // If currently fetching, wait for that to complete
    if (formsCurrentlyFetching && formsFetchPromise) {
        console.log('Forms currently being fetched, waiting for completion...');
        return await formsFetchPromise;
    }
    
    // Set flag and create promise
    formsCurrentlyFetching = true;
    
    formsFetchPromise = (async () => {
        try {
            console.log('Fetching form configurations from org variables...');
            
            // GraphQL query to fetch form_* org variables
            const response = await fetch('/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: `{
                        visibleOrgVariables(
                            visibleForOrgId: "${ORG_ID}"
                            search: { 
                                organization: { id: { _eq: "${ORG_ID}" } }
                                name: { _ilike: "form_%" }
                            }
                        ) {
                            id
                            name
                            value
                            category
                            cascade
                            createdAt
                            updatedAt
                            organization {
                                id
                                name
                            }
                            packConfig {
                                id
                                name
                            }
                        }
                    }`
                })
            });

            const data = await response.json();

            if (data.errors) {
                throw new Error(`GraphQL Error: ${data.errors[0]?.message || 'Unknown error'}`);
            }

            // Extract org variables
            const variables = data.data?.visibleOrgVariables || [];
            
            if (!variables || variables.length === 0) {
                console.warn('No form variables found');
                
                // Show dropdown with error message
                if (openExistingDropdown) {
                    openExistingDropdown.innerHTML = '<option value="">-- No forms available --</option>';
                }
                
                formsCurrentlyFetching = false;
                formsAlreadyFetched = true;
                return { success: false, error: 'No forms available' };
            }

            // Build form objects from variables
            availableForms = variables.map(v => {
                let formName = v.name;
                let formConfig = null;
                
                try {
                    formConfig = JSON.parse(v.value);
                    if (formConfig.form_name) {
                        formName = formConfig.form_name;
                    }
                } catch (e) {
                    console.warn(`Failed to parse form config for ${v.name}:`, e);
                    // If not valid JSON, use the variable name
                }
                
                return {
                    id: v.id,
                    form_id: v.name.replace('form_', ''),
                    form_name: formName,
                    form_config: v.value,
                    form_config_parsed: formConfig
                };
            });

            console.log('Successfully extracted forms:', availableForms);
            console.log('Number of forms:', availableForms.length);
            
            // Populate the dropdown
            if (openExistingDropdown) {
                openExistingDropdown.innerHTML = '<option value="">-- Select a form --</option>';
                availableForms.forEach((form, index) => {
                    const option = document.createElement('option');
                    option.value = index; // Use index to reference the form in availableForms array
                    option.textContent = form.form_name;
                    openExistingDropdown.appendChild(option);
                });
            }
            
            formsAlreadyFetched = true;
            formsCurrentlyFetching = false;
            
            return { success: true };
        } catch (error) {
            console.error('Error fetching existing forms:', error);
            console.error('Error stack:', error.stack);
            
            // Show dropdown with error message
            if (openExistingDropdown) {
                openExistingDropdown.innerHTML = '<option value="">-- Error loading forms --</option>';
            }
            
            formsCurrentlyFetching = false;
            return { success: false, error: error.message };
        }
    })();
    
    return await formsFetchPromise;
}

// Handle Open Existing checkbox toggle
// Automatically fetch forms on page load (no checkbox needed)
(async () => {
    if (openExistingDropdown && openExistingLoading && loadFormBtn && deleteFormBtn) {
        // Check if forms are already fetched
        if (formsAlreadyFetched) {
            // Already fetched, dropdown is already visible
            console.log('Forms already fetched');
        } else if (formsCurrentlyFetching) {
            // Currently fetching, show loading
            console.log('Forms currently fetching, showing loading...');
            openExistingLoading.style.display = 'block';
            openExistingDropdown.style.display = 'none';
            
            // Wait for the fetch to complete
            await formsFetchPromise;
            
            // Show the dropdown
            openExistingLoading.style.display = 'none';
            openExistingDropdown.style.display = 'block';
        } else {
            // Not fetched and not fetching, start fetching
            console.log('Starting fetch...');
            openExistingLoading.style.display = 'block';
            openExistingDropdown.style.display = 'none';
            
            await fetchExistingForms();
            
            // Show the dropdown
            openExistingLoading.style.display = 'none';
            openExistingDropdown.style.display = 'block';
        }
    }
})();

// ============================================
// HELPER FUNCTIONS FOR FIELD CREATION
// ============================================
/**
 * Create a new field config with default values based on element type
 */
function createFieldConfig(elementType, elementId, sequenceNumber, columnPosition, elementUid) {
    // Default dropdown to dropdown_static
    let actualType = elementType;
    let configType = elementType;
    if (elementType === 'dropdown') {
        actualType = 'dropdown_static';
        configType = 'dropdown_static';
    }
    
    const defaults = ELEMENT_TYPE_DEFAULTS[actualType] || {};
    
    const config = {
        uid: elementUid,
        field_name: elementId,
        field_displayname: `${elementType.charAt(0).toUpperCase() + elementType.slice(1).replace(/_/g, ' ')} ${droppedElementCount[elementType]}`,
        description: '',
        type: configType,
        dependant_fields: null,
        condition_1: null,
        condition_1_action: null,
        condition_2: null,
        condition_2_action: null,
        hidden: false,
        required: false,
        column: columnPosition,
        sequence: sequenceNumber,
        ...defaults
    };
    
    // form_extend elements are always hidden
    if (configType === 'form_extend') {
        config.hidden = true;
    }
    
    return config;
}

/**
 * Save type-specific field values from the form
 */
function saveTypeSpecificFields(fieldConfig) {
    const elementType = fieldConfig.type;
    
    try {
        // For dropdowns, clean up fields that don't belong to the selected type
        if (['dropdown', 'dropdown_static', 'dropdown_graphql', 'dropdown_mysql', 'dropdown_mesh'].includes(elementType)) {
            if (elementType === 'dropdown_static') {
                // Static: clear workflow, graphql, mysql, and mesh fields
                delete fieldConfig.workflow_id;
                delete fieldConfig.label_name;
                delete fieldConfig.value_name;
                delete fieldConfig.default_selector;
                delete fieldConfig.workflow_input;
                delete fieldConfig.graphql_op;
                delete fieldConfig.graphql_op_variables;
                delete fieldConfig.query;
                delete fieldConfig.label_field;
                delete fieldConfig.value_field;
                delete fieldConfig.node_id;
                delete fieldConfig.command;
                delete fieldConfig.command_type;
            } else if (elementType === 'dropdown') {
                // Workflow: clear static, graphql, mysql, and mesh fields
                delete fieldConfig.options;
                delete fieldConfig.graphql_op;
                delete fieldConfig.graphql_op_variables;
                delete fieldConfig.query;
                delete fieldConfig.label_field;
                delete fieldConfig.value_field;
                delete fieldConfig.node_id;
                delete fieldConfig.command;
                delete fieldConfig.command_type;
            } else if (elementType === 'dropdown_graphql') {
                // GraphQL: clear static, workflow, mysql, and mesh fields
                delete fieldConfig.options;
                delete fieldConfig.workflow_id;
                delete fieldConfig.label_name;
                delete fieldConfig.value_name;
                delete fieldConfig.default_selector;
                delete fieldConfig.workflow_input;
                delete fieldConfig.query;
                delete fieldConfig.label_field;
                delete fieldConfig.value_field;
                delete fieldConfig.node_id;
                delete fieldConfig.command;
                delete fieldConfig.command_type;
            } else if (elementType === 'dropdown_mysql') {
                // MySQL: clear static, workflow, graphql, and mesh fields
                delete fieldConfig.options;
                delete fieldConfig.workflow_id;
                delete fieldConfig.label_name;
                delete fieldConfig.value_name;
                delete fieldConfig.default_selector;
                delete fieldConfig.workflow_input;
                delete fieldConfig.graphql_op;
                delete fieldConfig.graphql_op_variables;
                delete fieldConfig.node_id;
                delete fieldConfig.command;
                delete fieldConfig.command_type;
            } else if (elementType === 'dropdown_mesh') {
                // MeshCentral: clear static, workflow, graphql, and mysql fields
                delete fieldConfig.options;
                delete fieldConfig.workflow_id;
                delete fieldConfig.label_name;
                delete fieldConfig.value_name;
                delete fieldConfig.default_selector;
                delete fieldConfig.workflow_input;
                delete fieldConfig.graphql_op;
                delete fieldConfig.graphql_op_variables;
                delete fieldConfig.query;
            }
        }
        
        if (elementType === 'checkbox' && document.getElementById('default_checked')) {
            fieldConfig.default_checked = document.getElementById('default_checked').checked;
        } else if (elementType === 'radio') {
            fieldConfig.default_select = document.getElementById('default_select')?.value || null;
            
            // Collect options from individual text fields
            const radioOptionRows = document.querySelectorAll('.radio-option-row');
            const options = {};
            radioOptionRows.forEach(row => {
                const labelInput = row.querySelector('.radio-option-label');
                const valueInput = row.querySelector('.radio-option-value');
                if (labelInput && valueInput) {
                    const label = labelInput.value.trim();
                    const value = valueInput.value.trim();
                    if (label && value) {
                        options[label] = value;
                    }
                }
            });
            fieldConfig.options = options;
        } else if (['text', 'textarea', 'date', 'date_time'].includes(elementType) && document.getElementById('default_value')) {
            fieldConfig.default_value = document.getElementById('default_value').value || null;
        } else if (elementType === 'html' && document.getElementById('content')) {
            fieldConfig.content = document.getElementById('content').value || '';
        } else if (elementType === 'horizontal_line') {
            // For horizontal_line, content is always the configured default and not editable
            fieldConfig.content = ELEMENT_TYPE_DEFAULTS['horizontal_line'].content;
        } else if (elementType === 'dropdown_static') {
            fieldConfig.default_value = document.getElementById('default_value')?.value || null;
            fieldConfig.multi_select = document.getElementById('multi_select')?.checked || false;
            fieldConfig.result_var = document.getElementById('result_var')?.value || '';
            
            // Collect options from individual text fields
            const optionRows = document.querySelectorAll('.option-row');
            const options = {};
            optionRows.forEach(row => {
                const labelInput = row.querySelector('.option-label');
                const valueInput = row.querySelector('.option-value');
                if (labelInput && valueInput) {
                    const label = labelInput.value.trim();
                    const value = valueInput.value.trim();
                    if (label && value) {
                        options[label] = value;
                    }
                }
            });
            fieldConfig.options = options;
        } else if (elementType === 'dropdown') {
            fieldConfig.workflow_id = document.getElementById('workflow_id')?.value || null;
            fieldConfig.label_name = document.getElementById('label_name')?.value || null;
            fieldConfig.value_name = document.getElementById('value_name')?.value || null;
            fieldConfig.default_selector = document.getElementById('default_selector')?.value || 'default';
            fieldConfig.multi_select = document.getElementById('multi_select')?.checked || false;
            fieldConfig.result_var = document.getElementById('result_var')?.value || '';
            
            // Collect workflow inputs from individual text fields
            const workflowInputRows = document.querySelectorAll('.workflow-input-row');
            const workflowInput = {};
            workflowInputRows.forEach(row => {
                const keyInput = row.querySelector('.workflow-input-key');
                const valueInput = row.querySelector('.workflow-input-value');
                if (keyInput && valueInput) {
                    const key = keyInput.value.trim();
                    let value = valueInput.value.trim();
                    if (key) {
                        // Try to parse value as JSON if it looks like JSON, otherwise use as string
                        try {
                            if (value.startsWith('{') || value.startsWith('[') || value === 'true' || value === 'false' || !isNaN(value)) {
                                value = JSON.parse(value);
                            }
                        } catch (e) {
                            // Keep as string if not valid JSON
                        }
                        workflowInput[key] = value;
                    }
                }
            });
            fieldConfig.workflow_input = workflowInput;
        } else if (elementType === 'dropdown_graphql') {
            fieldConfig.graphql_op = document.getElementById('graphql_op')?.value || '';
            fieldConfig.label_name = document.getElementById('label_name')?.value || 'name';
            fieldConfig.value_name = document.getElementById('value_name')?.value || 'id';
            fieldConfig.multi_select = document.getElementById('multi_select')?.checked || false;
            fieldConfig.result_var = document.getElementById('result_var')?.value || '';
            
            // Collect graphql operation variable values from dynamic inputs
            fieldConfig.graphql_op_variables = {};
            const graphqlOpInputsContainer = document.getElementById('graphql_op_inputs_container');
            if (graphqlOpInputsContainer && fieldConfig.graphql_op) {
                const operation = RewstLib.graphqlOperations.get(fieldConfig.graphql_op);
                if (operation && operation.inputs) {
                    operation.inputs.forEach(input => {
                        const inputElement = document.getElementById(`graphql_op_input_${input.name}`);
                        if (inputElement) {
                            if (inputElement.type === 'checkbox') {
                                fieldConfig.graphql_op_variables[input.name] = inputElement.checked;
                            } else {
                                fieldConfig.graphql_op_variables[input.name] = inputElement.value;
                            }
                        }
                    });
                }
            }
        } else if (elementType === 'dropdown_mysql') {
            fieldConfig.query = document.getElementById('mysql_query')?.value || '';
            fieldConfig.label_field = document.getElementById('mysql_label_field')?.value || '';
            fieldConfig.value_field = document.getElementById('mysql_value_field')?.value || '';
            fieldConfig.multi_select = document.getElementById('multi_select')?.checked || false;
            fieldConfig.result_var = document.getElementById('result_var')?.value || '';
        } else if (elementType === 'dropdown_mesh') {
            // Save mode from dropdown
            fieldConfig.mode = document.getElementById('mesh_mode')?.value || 'powershell';
            
            // Conditional field saving based on mode
            if (fieldConfig.mode === 'cmd' || fieldConfig.mode === 'powershell') {
                // Save node selection type
                fieldConfig.node_selection_type = document.getElementById('mesh_node_selection_type')?.value || 'fixed';
                
                // Save conditional node selection fields based on type
                if (fieldConfig.node_selection_type === 'fixed') {
                    fieldConfig.node_id = document.getElementById('mesh_node_id')?.value || '';
                    fieldConfig.node_query = '';
                } else if (fieldConfig.node_selection_type === 'query') {
                    fieldConfig.node_query = document.getElementById('mesh_node_query_cmd')?.value || '';
                    fieldConfig.node_id = '';
                }
                
                fieldConfig.command = document.getElementById('mesh_command')?.value || '';
            } else if (fieldConfig.mode === 'nodes') {
                fieldConfig.node_query = document.getElementById('mesh_node_query')?.value || '';
                // Clear command mode fields
                fieldConfig.node_id = '';
                fieldConfig.command = '';
                fieldConfig.node_selection_type = 'fixed'; // Reset to default
            }
            
            // Common fields for all modes
            fieldConfig.label_field = document.getElementById('mesh_label_field')?.value || '';
            fieldConfig.value_field = document.getElementById('mesh_value_field')?.value || '';
            fieldConfig.multi_select = document.getElementById('multi_select')?.checked || false;
            fieldConfig.result_var = document.getElementById('result_var')?.value || '';
        } else if (elementType === 'data_retrieval') {
            // Save data retrieval fields
            fieldConfig.data_source_type = document.getElementById('retrieval_type')?.value || 'mesh_powershell';
            
            // Conditional field saving based on data source type
            if (fieldConfig.data_source_type === 'mesh_cmd' || fieldConfig.data_source_type === 'mesh_powershell') {
                fieldConfig.node_selection_type = document.getElementById('retrieval_node_selection_type')?.value || 'fixed';
                
                if (fieldConfig.node_selection_type === 'fixed') {
                    fieldConfig.node_id = document.getElementById('retrieval_node_id')?.value || '';
                    fieldConfig.node_query = '';
                } else if (fieldConfig.node_selection_type === 'query') {
                    fieldConfig.node_query = document.getElementById('retrieval_node_query')?.value || '';
                    fieldConfig.node_id = '';
                }
                
                fieldConfig.command = document.getElementById('retrieval_command')?.value || '';
                fieldConfig.query = '';
            } else if (fieldConfig.data_source_type === 'mysql') {
                fieldConfig.query = document.getElementById('retrieval_query')?.value || '';
                fieldConfig.node_id = '';
                fieldConfig.node_query = '';
                fieldConfig.command = '';
            }
        } else if (elementType === 'dropdown_prefetch') {
            // Save prefetch dropdown fields
            fieldConfig.source_element_name = document.getElementById('prefetch_source_element_name')?.value || '';
            fieldConfig.result_path = document.getElementById('prefetch_result_path')?.value || '';
            fieldConfig.label_field = document.getElementById('prefetch_label_field')?.value || '';
            fieldConfig.value_field = document.getElementById('prefetch_value_field')?.value || '';
            fieldConfig.multi_select = document.getElementById('multi_select')?.checked || false;
            fieldConfig.result_var = document.getElementById('result_var')?.value || '';
        } else if (elementType === 'datatable') {
            // Save datatable fields
            fieldConfig.data_variable = document.getElementById('datatable_data_variable')?.value || '';
            fieldConfig.list_view = document.getElementById('datatable_list_view')?.checked || false;
        } else if (elementType === 'form_extend') {
            fieldConfig.extend_var = document.getElementById('extend_var')?.value || null;
            
            // Collect extend_var operation variable values from dynamic inputs
            fieldConfig.extend_var_variables = {};
            const extendVarInputsContainer = document.getElementById('extend_var_inputs_container');
            if (extendVarInputsContainer && fieldConfig.extend_var) {
                const operation = RewstLib.graphqlOperations.get(fieldConfig.extend_var);
                if (operation && operation.inputs) {
                    operation.inputs.forEach(input => {
                        const inputElement = document.getElementById(`extend_var_input_${input.name}`);
                        if (inputElement) {
                            if (inputElement.type === 'checkbox') {
                                fieldConfig.extend_var_variables[input.name] = inputElement.checked;
                            } else {
                                fieldConfig.extend_var_variables[input.name] = inputElement.value;
                            }
                        }
                    });
                }
            }
        } else if (elementType === 'array') {
            // Array items are saved via the modal (saveArrayItems)
            // fieldConfig.items is already updated when user clicks Confirm in modal
            // No need to re-collect from DOM since they're no longer there
            fieldConfig.repeating_input_mode = document.getElementById('repeating_input_mode')?.checked || false;
            fieldConfig.source = document.getElementById('repeating_input_source')?.value || '';
            console.log('[SAVE] Array items already saved via modal:', fieldConfig.items);
            console.log('[SAVE] Repeating input mode:', fieldConfig.repeating_input_mode, 'Source:', fieldConfig.source);
        }
    } catch (error) {
        console.error('Error saving type-specific fields:', error);
    }
}

function loadFormConfiguration(config) {
    console.log('Loading form configuration:', config);
    
    // Clear existing form
    fieldConfigs.length = 0;
    const topSpanningZone = document.getElementById('topSpanningZone');
    const bottomSpanningZone = document.getElementById('bottomSpanningZone');
    if (topSpanningZone) topSpanningZone.innerHTML = '<div style="color: #999; text-align: center; padding: 10px;">Span All Columns</div>';
    if (bottomSpanningZone) bottomSpanningZone.innerHTML = '<div style="color: #999; text-align: center; padding: 10px;">Span All Columns</div>';
    if (leftFormColumn) leftFormColumn.innerHTML = '';
    if (rightFormColumn) rightFormColumn.innerHTML = '';
    if (thirdFormColumn) thirdFormColumn.innerHTML = '';
    
    // Reset element counters
    ELEMENT_TYPES.forEach(type => {
        droppedElementCount[type] = 0;
    });
    
    // Set form name (handle form_name, formName, and extend_title)
    const formNameValue = config.extend_title || config.formName || config.form_name;
    if (formNameValue) {
        // For FormExtendBuilder, set extend_title
        const extendTitleInput = document.getElementById('extend_title');
        if (extendTitleInput) {
            extendTitleInput.value = formNameValue;
        }
        // For FormBuilder, set form_name input
        if (formNameInput) {
            formNameInput.value = formNameValue;
        }
    }
    
    // Set show name (handle show_form, showName, and show_title)
    const showNameValue = config.show_title !== undefined ? config.show_title : (config.showName !== undefined ? config.showName : config.show_form);
    if (showNameValue !== undefined) {
        // For FormExtendBuilder
        const showNameCheckbox = document.getElementById('show_name_modal');
        if (showNameCheckbox) {
            showNameCheckbox.checked = showNameValue;
        }
        // For FormBuilder
        if (hiddenShowName) {
            hiddenShowName.checked = showNameValue;
        }
    }
    
    // Set show vertical separator (Extend-specific)
    const showVertSepValue = config.show_vert_sep;
    if (showVertSepValue !== undefined) {
        const showVertSepCheckbox = document.getElementById('show_vert_sep');
        if (showVertSepCheckbox) {
            showVertSepCheckbox.checked = showVertSepValue;
        }
    }
    
    // Set columns (handle both columnCount and column_count)
    const columnCountValue = config.columnCount || config.column_count;
    if (hiddenFormColumns && columnCountValue) {
        hiddenFormColumns.value = columnCountValue.toString();
        updateColumnDisplay();
    }
    
    // Set submit workflow (handle both submitWorkflow and form_workflow)
    const submitWorkflowValue = config.submitWorkflow || config.form_workflow;
    if (hiddenSubmitWorkflow && submitWorkflowValue) {
        hiddenSubmitWorkflow.value = submitWorkflowValue;
    }
    
    // Load field configs (handle both fieldConfigs and field_configs)
    const fieldConfigsArray = config.fieldConfigs || config.field_configs;
    if (fieldConfigsArray && Array.isArray(fieldConfigsArray)) {
        // First, add all configs to fieldConfigs array and ensure backward compatibility
        fieldConfigsArray.forEach(fieldConfig => {
            // Ensure sequence exists (for backward compatibility with old forms)
            if (fieldConfig.sequence === undefined) {
                const elementsInColumn = fieldConfigs.filter(f => f.column === (fieldConfig.column || 1)).length;
                fieldConfig.sequence = elementsInColumn + 1;
            }
            
            // Add to fieldConfigs array
            fieldConfigs.push(fieldConfig);
            
            // Update element counter for this type
            const typeMatch = fieldConfig.field_name.match(/^(\w+)_(\d+)$/);
            if (typeMatch) {
                const type = typeMatch[1];
                const num = parseInt(typeMatch[2]);
                if (droppedElementCount[type] !== undefined && num > droppedElementCount[type]) {
                    droppedElementCount[type] = num;
                }
            }
        });
        
        // Sort by column, then by sequence to render in correct visual order
        const sortedConfigs = [...fieldConfigs].sort((a, b) => {
            const colA = a.column !== undefined ? a.column : 1;
            const colB = b.column !== undefined ? b.column : 1;
            if (colA !== colB) return colA - colB;
            return (a.sequence || 0) - (b.sequence || 0);
        });
        
        // Render elements in sorted order
        sortedConfigs.forEach(fieldConfig => {
            // Create visual element
            const newElement = document.createElement('div');
            newElement.draggable = true;
            newElement.dataset.uid = fieldConfig.uid;
            newElement.dataset.fieldName = fieldConfig.field_name;
            newElement.style.cssText = 'background: #1a3540; padding: 8px 12px; border: 1px solid #555; border-radius: 4px; color: white; margin: 6px 0; font-weight: 600; display: flex; justify-content: space-between; align-items: center; cursor: move; font-size: 14px;';
            
            // Use field_displayname if available, otherwise fallback to field_name
            const displayLabel = fieldConfig.field_displayname && fieldConfig.field_displayname.trim() ? fieldConfig.field_displayname : fieldConfig.field_name;
            newElement.innerHTML = `<span style="flex: 1; text-align: center;">${displayLabel}</span><button style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0; margin-left: 10px;">×</button>`;
            
            // Attach event listeners
            attachElementEventListeners(newElement);
            
            // Add to appropriate column or spanning zone
            const columnNum = fieldConfig.column !== undefined ? fieldConfig.column : 1;
            const topSpanningZone = document.getElementById('topSpanningZone');
            const bottomSpanningZone = document.getElementById('bottomSpanningZone');
            
            if (columnNum === 0) {
                // Top spanning zone
                if (topSpanningZone) {
                    topSpanningZone.appendChild(newElement);
                }
            } else if (columnNum === 99) {
                // Bottom spanning zone
                if (bottomSpanningZone) {
                    bottomSpanningZone.appendChild(newElement);
                }
            } else if (columnNum === 1 && leftFormColumn) {
                leftFormColumn.appendChild(newElement);
            } else if (columnNum === 2 && rightFormColumn) {
                rightFormColumn.appendChild(newElement);
            } else if (columnNum === 3 && thirdFormColumn) {
                thirdFormColumn.appendChild(newElement);
            }
        });
        
        // Don't reset sequences on load - trust the saved sequence values
        // updateElementSequences() should only be called when user manually reorders fields
    }
    
    // Update displays
    updateSaveButtonState();
    
    // Sync radio buttons with loaded column count
    const columnValue = hiddenFormColumns.value;
    const columnRadios = document.querySelectorAll('input[name="formColumns"]');
    columnRadios.forEach(radio => {
        radio.checked = radio.value === columnValue;
    });
    
    // Update checkbox disabled state based on loaded column count
    const showVertSepCheckbox = document.getElementById('show_vert_sep');
    if (showVertSepCheckbox) {
        const columnCount = parseInt(columnValue);
        showVertSepCheckbox.disabled = columnCount === 1;
        // If the form had vertical separators enabled, check it
        if (config.show_vert_sep || config.showVertSep) {
            showVertSepCheckbox.checked = true;
        } else {
            showVertSepCheckbox.checked = false;
        }
    }
    
    // Load output variable name
    let hiddenOutputVar = document.getElementById('hidden_output_var');
    if (!hiddenOutputVar) {
        hiddenOutputVar = document.createElement('input');
        hiddenOutputVar.type = 'hidden';
        hiddenOutputVar.id = 'hidden_output_var';
        document.body.appendChild(hiddenOutputVar);
    }
    hiddenOutputVar.value = config.output_var || config.outputVar || '';
    
    // Load submit_type
    const submitTypeValue = config.submit_type || 'workflow';
    if (hiddenSubmitType) {
        hiddenSubmitType.value = submitTypeValue;
    }
    
    // Load graphql_submit operation
    const graphqlOperationValue = config.graphql_submit?.operation || '';
    if (hiddenGraphQLSubmitOp) {
        hiddenGraphQLSubmitOp.value = graphqlOperationValue;
    }
    
    // Load form permissions from config into permissionsSelect
    const permissionsSelect = document.getElementById('permissionsSelect');
    if (permissionsSelect) {
        const permissionsValue = config.permissions || [];
        permissionsSelect.setAttribute('data-selected-values', JSON.stringify(permissionsValue));
        console.log('[LOAD] Loaded form permissions:', permissionsSelect.getAttribute('data-selected-values'));
    }
    
    // Load graphql_submit variables into dynamically generated inputs
    if (graphqlOperationValue) {
        // Trigger the operation selection to generate inputs
        const graphqlSubmitOpSelect = document.getElementById('graphql_submit_op');
        if (graphqlSubmitOpSelect) {
            graphqlSubmitOpSelect.value = graphqlOperationValue;
            graphqlSubmitOpSelect.dispatchEvent(new Event('change'));
            
            // After inputs are generated, populate their values
            setTimeout(() => {
                const graphqlVars = config.graphql_submit?.variables || {};
                console.log('[LOAD] GraphQL variables to restore:', graphqlVars);
                
                Object.entries(graphqlVars).forEach(([varName, varValue]) => {
                    const input = document.getElementById(`graphql_input_${varName}`);
                    console.log('[LOAD] Looking for input:', `graphql_input_${varName}`, 'found:', !!input);
                    if (input) {
                        if (input.type === 'checkbox') {
                            input.checked = varValue;
                        } else {
                            input.value = varValue;
                        }
                        console.log('[LOAD] Set', varName, 'to:', varValue);
                    }
                });
                
                // Store in hidden field for persistence
                const hiddenGraphQLSubmitVars = document.getElementById('hidden_graphql_submit_vars') || (() => {
                    const field = document.createElement('input');
                    field.type = 'hidden';
                    field.id = 'hidden_graphql_submit_vars';
                    document.body.appendChild(field);
                    return field;
                })();
                hiddenGraphQLSubmitVars.value = JSON.stringify(graphqlVars);
                console.log('[LOAD] Stored graphql variables:', hiddenGraphQLSubmitVars.value);
                
                // Update the JSON preview AFTER variables are stored
                updateFieldConfigsDisplay();
            }, 200);
        } else {
            // If no graphql operation, update preview immediately
            updateFieldConfigsDisplay();
        }
    } else {
        // If no graphql operation, update preview immediately
        updateFieldConfigsDisplay();
    }
    
    console.log('Form loaded successfully');
    console.log('Loaded field configs:', fieldConfigs);
}

// ============================================
// COLUMN MANAGEMENT
// ============================================
const leftFormColumn = document.getElementById('leftFormColumn');
const rightFormColumn = document.getElementById('rightFormColumn');
const thirdFormColumn = document.getElementById('thirdFormColumn');
const columnDivider1 = document.getElementById('columnDivider1');
const columnDivider2 = document.getElementById('columnDivider2');

// Hidden fields that sync with modal values
const hiddenShowName = document.createElement('input');
hiddenShowName.type = 'checkbox';
hiddenShowName.id = 'show_name';
hiddenShowName.checked = true;
hiddenShowName.style.display = 'none';
document.body.appendChild(hiddenShowName);

const hiddenFormColumns = document.createElement('select');
hiddenFormColumns.id = 'form_columns';
hiddenFormColumns.style.display = 'none';
hiddenFormColumns.innerHTML = '<option value="1" selected>1</option><option value="2">2</option><option value="3">3</option>';
document.body.appendChild(hiddenFormColumns);

const hiddenSubmitWorkflow = document.createElement('select');
hiddenSubmitWorkflow.id = 'form_submit_workflow';
hiddenSubmitWorkflow.style.display = 'none';
hiddenSubmitWorkflow.innerHTML = '<option value="">-- Select a workflow --</option>';
document.body.appendChild(hiddenSubmitWorkflow);

const hiddenSubmitType = document.createElement('input');
hiddenSubmitType.type = 'hidden';
hiddenSubmitType.id = 'hidden_submit_type';
hiddenSubmitType.value = 'workflow';
document.body.appendChild(hiddenSubmitType);

const hiddenGraphQLSubmitOp = document.createElement('input');
hiddenGraphQLSubmitOp.type = 'hidden';
hiddenGraphQLSubmitOp.id = 'hidden_graphql_submit_op';
hiddenGraphQLSubmitOp.value = '';
document.body.appendChild(hiddenGraphQLSubmitOp);

const hiddenGraphQLSubmitVars = document.createElement('input');
hiddenGraphQLSubmitVars.type = 'hidden';
hiddenGraphQLSubmitVars.id = 'hidden_graphql_submit_vars';
hiddenGraphQLSubmitVars.value = '{}';
document.body.appendChild(hiddenGraphQLSubmitVars);

// DOM element references used throughout the code
// Initialize DOM element references
openExistingLoading = document.getElementById('open_existing_loading');
openExistingDropdown = document.getElementById('open_existing_dropdown');
loadFormBtn = document.getElementById('loadFormBtn');
deleteFormBtn = document.getElementById('deleteFormBtn');
columnsSelect = hiddenFormColumns;
formColumnsSelect = hiddenFormColumns;
settingsPanel = document.getElementById('settingsPanel');
emptySettings = document.getElementById('emptySettings');
settingsForm = document.getElementById('settingsForm');

// ============================================
// LOAD AND DELETE BUTTON HANDLERS
// ============================================
// Enable/disable Load button based on dropdown selection
if (openExistingDropdown && loadFormBtn) {
    openExistingDropdown.addEventListener('change', () => {
        loadFormBtn.disabled = !openExistingDropdown.value;
    });
    
    loadFormBtn.addEventListener('click', async () => {
        console.log('=== LOAD BUTTON CLICKED ===');
        console.log('Dropdown value:', openExistingDropdown.value);
        console.log('Available forms:', availableForms);
        
        // Check if there are unsaved changes in element settings (only if panel is open)
        if (selectedElementUid && settingsPanel && settingsPanel.style.display === 'block' && hasUnsavedFormChanges()) {
            console.log('Unsaved element changes detected before loading form');
            const fieldDisplayName = originalElementSettings ? originalElementSettings.field_displayname : 'Unknown';
            const confirmed = await confirmUnsavedChanges(fieldDisplayName);
            if (!confirmed) {
                console.log('User cancelled loading form due to unsaved element changes');
                return; // Don't load form
            }
            console.log('User confirmed to discard element changes and load form');
            // Close element settings without saving
            await closeElementSettings(true);
        }
        
        const selectedIndex = parseInt(openExistingDropdown.value);
        console.log('Selected index:', selectedIndex);
        
        if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= availableForms.length) {
            console.error('Invalid form selection');
            return;
        }
        
        const selectedForm = availableForms[selectedIndex];
        console.log('Selected form:', selectedForm);
        console.log('Form ID:', selectedForm.id);
        console.log('Form config type:', typeof selectedForm.form_config);
        console.log('Form config value:', selectedForm.form_config);
        
        // Store the form ID and UUID globally
        loadedFormId = {
            uuid: selectedForm.id,
            name: 'form_' + selectedForm.form_id
        };
        console.log('Stored form info:', loadedFormId);
        
        // Parse form_config (it might be a JSON string)
        let formConfig;
        if (typeof selectedForm.form_config === 'string') {
            try {
                formConfig = JSON.parse(selectedForm.form_config);
                console.log('Parsed from JSON string');
            } catch (e) {
                console.error('Error parsing form_config:', e);
                return;
            }
        } else {
            formConfig = selectedForm.form_config;
            console.log('Using object directly');
        }
        
        console.log('Final parsed config:', formConfig);
        console.log('Calling loadFormConfiguration...');
        
        // Load the form configuration
        loadFormConfiguration(formConfig);
    });
}

// Delete button handler
const deleteFormConfirmModal = document.getElementById('deleteFormConfirmModal');
const deleteFormConfirmYes = document.getElementById('deleteFormConfirmYes');
const deleteFormConfirmNo = document.getElementById('deleteFormConfirmNo');

if (deleteFormBtn && deleteFormConfirmModal && deleteFormConfirmYes && deleteFormConfirmNo) {
    // FormBuilder flow: uses openExistingDropdown
    if (openExistingDropdown) {
        // Enable/disable Delete button based on dropdown selection
        openExistingDropdown.addEventListener('change', () => {
            deleteFormBtn.disabled = !openExistingDropdown.value;
        });
    }
    
    // Show delete confirmation modal (works for both FormBuilder and FormExtendBuilder)
    deleteFormBtn.addEventListener('click', () => {
        // Check if a form is selected (FormBuilder uses openExistingDropdown, FormExtendBuilder uses loadedFormId)
        const hasSelection = (openExistingDropdown && openExistingDropdown.value) || loadedFormId;
        if (!hasSelection) {
            console.error('No form selected to delete');
            return;
        }
        deleteFormConfirmModal.classList.add('active');
    });
    
    // Cancel delete
    deleteFormConfirmNo.addEventListener('click', () => {
        deleteFormConfirmModal.classList.remove('active');
    });
    
    // Confirm delete
    deleteFormConfirmYes.addEventListener('click', async () => {
        let formUUID, formName;
        
        // FormBuilder flow
        if (openExistingDropdown && openExistingDropdown.value) {
            const selectedIndex = parseInt(openExistingDropdown.value);
            
            if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= availableForms.length) {
                console.error('Invalid form selection for delete');
                deleteFormConfirmModal.classList.remove('active');
                return;
            }
            
            const selectedForm = availableForms[selectedIndex];
            formUUID = selectedForm.id;
            formName = selectedForm.name;
        }
        // FormExtendBuilder flow
        else if (loadedFormId) {
            formUUID = loadedFormId.uuid;
            formName = loadedFormId.name;
        }
        // Fallback
        else {
            console.error('No form selected to delete');
            deleteFormConfirmModal.classList.remove('active');
            return;
        }
        
        console.log('Deleting form:', { uuid: formUUID, name: formName });
        
        deleteFormConfirmModal.classList.remove('active');
        
        try {
            // Execute deleteOrgVariable GraphQL mutation
            const query = `
                mutation deleteOrgVariable($id: ID!) {
                    deleteOrgVariable(id: $id)
                }
            `;
            
            const response = await fetch('/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: query,
                    variables: { id: formUUID }
                })
            });
            
            const result = await response.json();
            
            if (result.errors) {
                console.error('GraphQL error:', result.errors);
                alert('Error deleting form: ' + (result.errors[0]?.message || 'Unknown error'));
                return;
            }
            
            console.log('Form deleted successfully');
            
            // FormBuilder cleanup
            if (openExistingDropdown && availableForms) {
                const selectedIndex = parseInt(openExistingDropdown.value);
                availableForms.splice(selectedIndex, 1);
                
                // Update dropdown
                const deletedOption = openExistingDropdown.options[selectedIndex + 1]; // +1 because first option is placeholder
                if (deletedOption) {
                    openExistingDropdown.removeChild(deletedOption);
                }
                
                // Reset dropdown
                openExistingDropdown.value = '';
                deleteFormBtn.disabled = true;
                if (loadFormBtn) loadFormBtn.disabled = true;
            }
            
            // FormExtendBuilder cleanup
            if (loadedFormId) {
                fieldConfigs.length = 0;
                loadedFormId = null;
                resetForm();
            }
            
            // Show success message
            showSuccessMessage('Form Configuration Deleted Successfully');
            
        } catch (error) {
            console.error('Error deleting form:', error);
            alert('Error deleting form: ' + error.message);
        }
    });
    
    // Close modal on outside click
    deleteFormConfirmModal.addEventListener('click', (e) => {
        if (e.target === deleteFormConfirmModal) {
            deleteFormConfirmModal.classList.remove('active');
        }
    });
}

// Handle column changes
function updateColumnDisplay() {
    if (!formColumnsSelect) {
        console.error('formColumnsSelect not found');
        return;
    }
    
    if (!leftFormColumn || !rightFormColumn || !thirdFormColumn) {
        console.error('Column elements not found');
        return;
    }
    
    const numColumns = parseInt(formColumnsSelect.value);
    console.log('Updating columns to:', numColumns);
    console.log('Column elements:', {
        left: !!leftFormColumn,
        right: !!rightFormColumn,
        third: !!thirdFormColumn,
        div1: !!columnDivider1,
        div2: !!columnDivider2
    });
    
    // Get spanning zones
    const topSpanningZone = document.getElementById('topSpanningZone');
    const bottomSpanningZone = document.getElementById('bottomSpanningZone');
    
    if (numColumns === 1) {
        console.log('Setting to 1 column');
        
        // Hide spanning zones for single column
        if (topSpanningZone) topSpanningZone.style.display = 'none';
        if (bottomSpanningZone) bottomSpanningZone.style.display = 'none';
        
        // Move elements from column 2 and 3 to column 1
        const column2Elements = Array.from(rightFormColumn.children);
        const column3Elements = Array.from(thirdFormColumn.children);
        
        column2Elements.forEach(element => {
            if (element.dataset.uid) {
                // Update the fieldConfig
                const fieldConfig = fieldConfigs.find(f => f.uid === element.dataset.uid);
                if (fieldConfig) {
                    fieldConfig.column = 1;
                }
                // Move the element
                leftFormColumn.appendChild(element);
            }
        });
        
        column3Elements.forEach(element => {
            if (element.dataset.uid) {
                // Update the fieldConfig
                const fieldConfig = fieldConfigs.find(f => f.uid === element.dataset.uid);
                if (fieldConfig) {
                    fieldConfig.column = 1;
                }
                // Move the element
                leftFormColumn.appendChild(element);
            }
        });
        
        rightFormColumn.style.display = 'none';
        columnDivider1.style.display = 'none';
        thirdFormColumn.style.display = 'none';
        columnDivider2.style.display = 'none';
        
        // Update the JSON display
        updateFieldConfigsDisplay();
        
    } else if (numColumns === 2) {
        console.log('Setting to 2 columns');
        
        // Show spanning zones for 2 or more columns
        if (topSpanningZone) topSpanningZone.style.display = 'block';
        if (bottomSpanningZone) bottomSpanningZone.style.display = 'block';
        
        // Move elements from column 3 to column 1
        const column3Elements = Array.from(thirdFormColumn.children);
        
        column3Elements.forEach(element => {
            if (element.dataset.uid) {
                // Update the fieldConfig
                const fieldConfig = fieldConfigs.find(f => f.uid === element.dataset.uid);
                if (fieldConfig) {
                    fieldConfig.column = 1;
                }
                // Move the element
                leftFormColumn.appendChild(element);
            }
        });
        
        rightFormColumn.style.display = 'block';
        columnDivider1.style.display = 'block';
        thirdFormColumn.style.display = 'none';
        columnDivider2.style.display = 'none';
        
        console.log('Column 2 display:', rightFormColumn.style.display);
        console.log('Divider 1 display:', columnDivider1.style.display);
        
        // Update the JSON display
        updateFieldConfigsDisplay();
        
    } else if (numColumns === 3) {
        console.log('Setting to 3 columns');
        
        // Show spanning zones for 2 or more columns
        if (topSpanningZone) topSpanningZone.style.display = 'block';
        if (bottomSpanningZone) bottomSpanningZone.style.display = 'block';
        
        rightFormColumn.style.display = 'block';
        columnDivider1.style.display = 'block';
        thirdFormColumn.style.display = 'block';
        columnDivider2.style.display = 'block';
        
        console.log('All columns display:', {
            col2: rightFormColumn.style.display,
            col3: thirdFormColumn.style.display
        });
    }
}

if (formColumnsSelect) {
    console.log('formColumnsSelect found, setting up event listeners');
    
    // Set initial state on page load - wait for DOM to be fully ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            console.log('DOM loaded, calling updateColumnDisplay');
            
            // Initialize permissionsSelect with admin role default (created by security.js)
            const permissionsSelect = document.getElementById('permissionsSelect');
            if (permissionsSelect) {
                permissionsSelect.setAttribute('data-selected-values', JSON.stringify(['role-admin']));
                console.log('[INIT] Set permissionsSelect.dataset.selectedValues to role-admin');
            }
            
            updateColumnDisplay();
            updateFieldConfigsDisplay();
            // Initialize checkbox disabled state
            const showVertSepCheckbox = document.getElementById('show_vert_sep');
            if (showVertSepCheckbox) {
                showVertSepCheckbox.disabled = formColumnsSelect.value === '1';
            }
        });
    } else {
        console.log('DOM already loaded, calling updateColumnDisplay');
        
        // Initialize permissionsSelect with admin role default (created by security.js)
        const permissionsSelect = document.getElementById('permissionsSelect');
        if (permissionsSelect) {
            permissionsSelect.setAttribute('data-selected-values', JSON.stringify(['role-admin']));
            console.log('[INIT] Set permissionsSelect.dataset.selectedValues to role-admin');
        }
        
        updateColumnDisplay();
        updateFieldConfigsDisplay();
        // Initialize checkbox disabled state
        const showVertSepCheckbox = document.getElementById('show_vert_sep');
        if (showVertSepCheckbox) {
            showVertSepCheckbox.disabled = formColumnsSelect.value === '1';
        }
    }
    
    // Add change listener
    formColumnsSelect.addEventListener('change', (e) => {
        console.log('Column select changed to:', e.target.value);
        updateColumnDisplay();
        updateFieldConfigsDisplay();
        // Update checkbox disabled state based on column count
        const showVertSepCheckbox = document.getElementById('show_vert_sep');
        if (showVertSepCheckbox) {
            const columnCount = parseInt(e.target.value);
            showVertSepCheckbox.disabled = columnCount === 1;
            // If disabling and it was checked, uncheck it
            if (columnCount === 1 && showVertSepCheckbox.checked) {
                showVertSepCheckbox.checked = false;
                if (columnDivider1) columnDivider1.style.display = 'none';
                if (columnDivider2) columnDivider2.style.display = 'none';
            }
        }
    });
    
    // Add change listeners to radio buttons
    const columnRadios = document.querySelectorAll('input[name="formColumns"]');
    columnRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            console.log('Column radio changed to:', e.target.value);
            // Update hidden select to match
            formColumnsSelect.value = e.target.value;
            // Trigger column display update
            updateColumnDisplay();
            updateFieldConfigsDisplay();
            // Update checkbox disabled state based on column count
            const showVertSepCheckbox = document.getElementById('show_vert_sep');
            if (showVertSepCheckbox) {
                const columnCount = parseInt(e.target.value);
                showVertSepCheckbox.disabled = columnCount === 1;
                // If disabling and it was checked, uncheck it
                if (columnCount === 1 && showVertSepCheckbox.checked) {
                    showVertSepCheckbox.checked = false;
                    if (columnDivider1) columnDivider1.style.display = 'none';
                    if (columnDivider2) columnDivider2.style.display = 'none';
                }
            }
        });
    });
    
    // Add change listener for show vertical separators checkbox
    const showVertSepCheckbox = document.getElementById('show_vert_sep');
    if (showVertSepCheckbox) {
        showVertSepCheckbox.addEventListener('change', (e) => {
            console.log('Show vertical separators:', e.target.checked);
            // Toggle dividers visibility based on checkbox
            if (columnDivider1) columnDivider1.style.display = e.target.checked ? 'block' : 'none';
            if (columnDivider2) columnDivider2.style.display = e.target.checked ? 'block' : 'none';
            // Update JSON preview
            updateFieldConfigsDisplay();
        });
    }
} else {
    console.error('formColumnsSelect not found!');
}

// Add event listener to form name input
const formNameInput = document.getElementById('form_name');
if (formNameInput) {
    formNameInput.addEventListener('input', () => {
        updateFieldConfigsDisplay();
        updateSaveButtonState();
    });
}

// Add event listener to show name checkbox
const showNameCheckbox = document.getElementById('show_name');
if (showNameCheckbox) {
    showNameCheckbox.addEventListener('change', () => {
        updateFieldConfigsDisplay();
    });
}

// Add event listener to submit workflow dropdown
const submitWorkflowSelect = document.getElementById('form_submit_workflow');
if (submitWorkflowSelect) {
    submitWorkflowSelect.addEventListener('change', () => {
        updateFieldConfigsDisplay();
    });
}

// Add event listener to columns dropdown (using formColumnsSelect already declared above)
if (formColumnsSelect) {
    formColumnsSelect.addEventListener('change', () => {
        updateFieldConfigsDisplay();
    });
}

// Handle Show JSON checkbox
function initShowJsonCheckbox() {
    console.log('initShowJsonCheckbox called, readyState:', document.readyState);
    
    const showJsonCheckbox = document.getElementById('showJsonCheckbox');
    const fieldConfigsPanel = document.getElementById('fieldConfigsPanel');
    
    console.log('Show JSON checkbox element:', showJsonCheckbox);
    console.log('Field configs panel element:', fieldConfigsPanel);
    
    if (showJsonCheckbox && fieldConfigsPanel) {
        console.log('Both elements found, adding event listener');
        console.log('Panel initial display:', fieldConfigsPanel.style.display);
        
        showJsonCheckbox.addEventListener('change', (e) => {
            console.log('Checkbox changed! Checked:', e.target.checked);
            const newDisplay = e.target.checked ? 'block' : 'none';
            console.log('Setting panel display to:', newDisplay);
            fieldConfigsPanel.style.display = newDisplay;
            console.log('Panel display is now:', fieldConfigsPanel.style.display);
        });
        console.log('Show JSON checkbox initialized successfully');
    } else {
        console.error('Show JSON elements not found:', {
            checkbox: !!showJsonCheckbox,
            panel: !!fieldConfigsPanel
        });
    }
}

// Initialize on DOM ready
console.log('Script loading, readyState:', document.readyState);
if (document.readyState === 'loading') {
    console.log('DOM still loading, adding DOMContentLoaded listener');
    document.addEventListener('DOMContentLoaded', initShowJsonCheckbox);
} else {
    console.log('DOM already loaded, calling initShowJsonCheckbox immediately');
    initShowJsonCheckbox();
}

function updateFieldConfigsDisplay() {
    const display = document.getElementById('fieldConfigsDisplay');
    
    // Detect if this is FormExtendBuilder (has extend_title) or FormBuilder (has form_name)
    const extendTitleInput = document.getElementById('extend_title');
    const isFormExtend = !!extendTitleInput;
    
    let formConfig;
    
    if (isFormExtend) {
        // FormExtendBuilder config structure
        const formName = extendTitleInput.value;
        const showTitle = document.getElementById('show_name_modal') ? document.getElementById('show_name_modal').checked : true;
        const columnCount = document.querySelector('input[name="formColumns"]:checked') ? parseInt(document.querySelector('input[name="formColumns"]:checked').value) : 2;
        const showVertSep = document.getElementById('show_vert_sep') ? document.getElementById('show_vert_sep').checked : false;
        
        formConfig = {
            extend_title: formName,
            show_title: showTitle,
            column_count: columnCount,
            show_vert_sep: showVertSep,
            user: (typeof rewstUser !== 'undefined' && rewstUser ? rewstUser.username : 'unknown_user'),
            permissions: [],
            field_configs: fieldConfigs
        };
        
        // Load permissions from permissionsSelect
        const permissionsSelect = document.getElementById('permissionsSelect');
        if (permissionsSelect && permissionsSelect.getAttribute('data-selected-values')) {
            try {
                const parsedPerms = JSON.parse(permissionsSelect.getAttribute('data-selected-values'));
                formConfig.permissions = Array.isArray(parsedPerms) ? parsedPerms : [];
                console.log('[UPDATE-DISPLAY] Loaded permissions from permissionsSelect:', formConfig.permissions);
            } catch (e) {
                console.warn('Failed to parse form permissions:', e);
                formConfig.permissions = [];
            }
        } else {
            console.log('[UPDATE-DISPLAY] No permissions in permissionsSelect, using default []');
            formConfig.permissions = [];
        }
    } else {
        // FormBuilder config structure
        // Get form name
        const formName = formNameInput ? formNameInput.value : '';
        
        // Get show name checkbox
        const showName = showNameCheckbox ? showNameCheckbox.checked : true;
        
        // Get column count
        const columnCount = columnsSelect ? parseInt(columnsSelect.value) : 2;
        
        // Get submit workflow
        const submitWorkflowId = submitWorkflowSelect ? submitWorkflowSelect.value : '';
        const submitWorkflow = submitWorkflowId ? availableWorkflows.find(w => w.id === submitWorkflowId) : null;
        const submitWorkflowName = submitWorkflow ? submitWorkflow.name : '';
        const submitWorkflowType = submitWorkflow ? submitWorkflow.type : '';
        
        // Build complete form configuration object
        formConfig = {
            form_name: formName,
            show_form: showName,
            column_count: columnCount,
            show_vert_sep: document.getElementById('show_vert_sep') ? document.getElementById('show_vert_sep').checked : false,
            form_workflow: submitWorkflowId,
            output_var: document.getElementById('hidden_output_var') ? document.getElementById('hidden_output_var').value : '',
            submit_type: document.getElementById('hidden_submit_type') ? document.getElementById('hidden_submit_type').value : 'workflow',
            graphql_submit: {
                operation: document.getElementById('hidden_graphql_submit_op') ? document.getElementById('hidden_graphql_submit_op').value : '',
                variables: {}
            },
            user: (typeof rewstUser !== 'undefined' && rewstUser ? rewstUser.username : 'unknown_user'),
            permissions: [],
            field_configs: fieldConfigs
        };
        
        // Populate graphql_submit variables from hidden field
        const hiddenGraphQLSubmitVars = document.getElementById('hidden_graphql_submit_vars');
        if (hiddenGraphQLSubmitVars && hiddenGraphQLSubmitVars.value) {
            try {
                formConfig.graphql_submit.variables = JSON.parse(hiddenGraphQLSubmitVars.value);
            } catch (e) {
                console.warn('Failed to parse stored graphql variables:', e);
                formConfig.graphql_submit.variables = {};
            }
        }
        
        // Load permissions from permissionsSelect
        const permissionsSelect = document.getElementById('permissionsSelect');
        if (permissionsSelect && permissionsSelect.getAttribute('data-selected-values')) {
            try {
                const parsedPerms = JSON.parse(permissionsSelect.getAttribute('data-selected-values'));
                formConfig.permissions = Array.isArray(parsedPerms) ? parsedPerms : [];
                console.log('[UPDATE-DISPLAY] Loaded permissions from permissionsSelect:', formConfig.permissions);
            } catch (e) {
                console.warn('Failed to parse form permissions:', e);
                formConfig.permissions = [];
            }
        } else {
            console.log('[UPDATE-DISPLAY] No permissions in permissionsSelect, using default []');
            formConfig.permissions = [];
        }
    }
    
    const formName = isFormExtend ? extendTitleInput.value : (formNameInput ? formNameInput.value : '');
    const hasFields = fieldConfigs.length > 0;
    
    console.log('[UPDATE-DISPLAY] Final formConfig permissions:', formConfig.permissions, 'Type:', typeof formConfig.permissions, 'Is Array:', Array.isArray(formConfig.permissions));
    
    if (!hasFields && !formName) {
        display.innerHTML = '<span style="color: #999;">[No configuration yet]</span>';
    } else {
        display.textContent = JSON.stringify(formConfig, null, 2);
    }
}

// Track dropped elements
let droppedElementCount = {};
let selectedElementUid = null; // Changed from selectedElementId to use UID
let originalElementSettings = null; // Store original settings to detect changes
let formHasBeenModified = false; // Track if form has been modified since load

// Initialize counters for each type
ELEMENT_TYPES.forEach(type => {
    droppedElementCount[type] = 0;
});

// UID management for unique element identification
let elementUidCounter = 0;
function generateElementUid() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let uid = '';
    for (let i = 0; i < 5; i++) {
        uid += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return uid;
}

// ============================================
// HELPER FUNCTION - ATTACH EVENT LISTENERS
// ============================================
function attachElementEventListeners(element) {
    // Click handler to open settings - uses UID instead of field_name
    const clickHandler = async (e) => {
        if (e.target.tagName !== 'BUTTON') {
            // If clicking the same element that's already open, do nothing
            if (selectedElementUid === element.dataset.uid) {
                console.log('Same element already selected, ignoring click');
                return;
            }
            
            // Check if there are unsaved changes in another element's settings
            if (selectedElementUid && hasUnsavedFormChanges()) {
                console.log('Unsaved changes detected, prompting user');
                // Get the field display name from originalElementSettings
                const fieldDisplayName = originalElementSettings ? originalElementSettings.field_displayname : 'Unknown';
                const confirmed = await confirmUnsavedChanges(fieldDisplayName);
                if (!confirmed) {
                    console.log('User cancelled switch');
                    return; // Don't switch
                }
                console.log('User confirmed switch, discarding changes');
            }
            showElementSettings(element.dataset.uid);
        }
    };
    element.addEventListener('click', clickHandler);
    
    // Drag handlers for moving between columns - uses UID
    element.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('elementuid', element.dataset.uid);
        element.style.opacity = '0.5';
        element.classList.add('dragging');
    });
    
    element.addEventListener('dragend', (e) => {
        element.style.opacity = '1';
        element.classList.remove('dragging');
        
        // Update sequences after drag ends (reordering complete)
        updateElementSequences();
    });
    
    // Delete button handler - uses UID
    const deleteBtn = element.querySelector('button');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const currentUid = element.dataset.uid;
            const deleteOptionModal = document.getElementById('deleteOptionModal');
            const deleteOptionYes = document.getElementById('deleteOptionYes');
            const deleteOptionNo = document.getElementById('deleteOptionNo');
            
            deleteOptionModal.classList.add('active');
            
            deleteOptionYes.onclick = () => {
                fieldConfigs.splice(fieldConfigs.findIndex(f => f.uid === currentUid), 1);
                updateFieldConfigsDisplay();
                updateSaveButtonState();
                element.remove();
                
                // Update sequences after deletion
                updateElementSequences();
                
                if (selectedElementUid === currentUid) {
                    closeElementSettings();
                }
                
                deleteOptionModal.classList.remove('active');
            };
            
            deleteOptionNo.onclick = () => {
                deleteOptionModal.classList.remove('active');
            };
        });
    }
}

// ============================================
// DRAG AND DROP - FIXED VERSION
// ============================================
function initializeDragAndDrop() {
    // Get column elements (might not exist yet)
    
    if (!leftFormColumn) {
        console.error('Column elements not found in DOM');
        return;
    }
    
    console.log('Initializing drag and drop with columns:', {
        left: !!leftFormColumn,
        right: !!rightFormColumn,
        third: !!thirdFormColumn
    });
    
    // Get all draggable elements
    const draggableElements = document.querySelectorAll('.draggable-element');
    console.log('Draggable elements found:', draggableElements.length);
    
    // Add drag listeners to all draggable elements
    draggableElements.forEach(element => {
        element.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', element.dataset.type);
            // IMPORTANT: Also set as application type for better compatibility
            e.dataTransfer.setData('application/x-element-type', element.dataset.type);
            element.style.opacity = '0.6';
            console.log('Dragging:', element.dataset.type);
        });
        
        element.addEventListener('dragend', () => {
            element.style.opacity = '1';
        });
    });
    
    // Make columns drop targets
    const columnsToTarget = [leftFormColumn, rightFormColumn, thirdFormColumn].filter(col => col !== null);
    console.log('Columns to target:', columnsToTarget.length);
    
    // Add spanning zones to drop targets
    const topSpanningZone = document.getElementById('topSpanningZone');
    const bottomSpanningZone = document.getElementById('bottomSpanningZone');
    const spanningZones = [topSpanningZone, bottomSpanningZone].filter(zone => zone !== null);
    
    columnsToTarget.forEach((column, idx) => {
        console.log(`Setting up drop handlers for column ${idx} (${column.id})`);
        
        column.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('DRAGENTER event on column', column.id);
        });

        column.addEventListener('dragover', (e) => {
            e.preventDefault(); // CRITICAL: Must prevent default
            e.stopPropagation();
            
            // Check if we're dragging a field (moving between columns) or a new element
            const types = Array.from(e.dataTransfer.types);
            if (types.includes('elementuid')) {
                e.dataTransfer.dropEffect = 'move';
            } else {
                e.dataTransfer.dropEffect = 'copy';
            }
            
            column.style.background = 'rgba(102, 126, 234, 0.1)';
            column.style.borderColor = '#667eea';
            
            // Find the element we should insert before (for reordering)
            const afterElement = getDragAfterElement(column, e.clientY);
            const draggingElement = document.querySelector('.dragging');
            
            if (draggingElement && types.includes('elementuid')) {
                // If we're dragging an existing element, show where it will go
                if (afterElement == null) {
                    column.appendChild(draggingElement);
                } else {
                    column.insertBefore(draggingElement, afterElement);
                }
            }
        });

        column.addEventListener('dragleave', (e) => {
            // Only reset if we're actually leaving the column (not entering a child)
            const rect = column.getBoundingClientRect();
            const x = e.clientX;
            const y = e.clientY;
            
            if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
                column.style.background = 'transparent';
                column.style.borderColor = '#666';
            }
        });

        column.addEventListener('drop', (e) => {
            console.log('=== DROP EVENT FIRED! ===');
            
            e.preventDefault();
            e.stopPropagation();
            
            column.style.background = 'transparent';
            column.style.borderColor = '#666';
            
            // Check if this is a field being moved (has elementuid) or a new element type
            const elementuid = e.dataTransfer.getData('elementuid');
            
            if (elementuid && elementuid.length > 0) {
                // Moving an existing field (either between columns or reordering within column)
                console.log('Moving field:', elementuid);
                
                // Element was already moved in dragover, just update the fieldConfig
                const fieldConfig = fieldConfigs.find(f => f.uid === elementuid);
                if (fieldConfig) {
                    let columnPosition = 1;
                    if (column === rightFormColumn) {
                        columnPosition = 2;
                    } else if (column === thirdFormColumn) {
                        columnPosition = 3;
                    }
                    
                    // Only log if column actually changed
                    if (fieldConfig.column !== columnPosition) {
                        console.log(`Updated field column from ${fieldConfig.column} to ${columnPosition}`);
                        fieldConfig.column = columnPosition;
                    } else {
                        console.log('Reordering within same column');
                    }
                }
                
                // Sequences will be updated in dragend handler
                return;
            }
            
            // Try multiple ways to get the new element type data
            let elementType = e.dataTransfer.getData('text/plain');
            if (!elementType) {
                elementType = e.dataTransfer.getData('application/x-element-type');
            }
            if (!elementType) {
                elementType = e.dataTransfer.getData('text');
            }
            
            console.log('Retrieved element type:', elementType);
            
            // Otherwise, it's a new element from the sidebar
            if (!elementType) {
                console.error('No element type could be retrieved from dataTransfer!');
                console.log('Available types:', Array.from(e.dataTransfer.types));
                return;
            }
            
            console.log('Creating new element of type:', elementType);
            
            if (!droppedElementCount[elementType]) {
                droppedElementCount[elementType] = 0;
            }
            droppedElementCount[elementType]++;
            
            let columnPosition = 1;
            if (column === rightFormColumn) {
                columnPosition = 2;
            } else if (column === thirdFormColumn) {
                columnPosition = 3;
            }
            
            const elementId = `${elementType}_${droppedElementCount[elementType]}`;
            const elementUid = generateElementUid(); // Generate unique ID
            
            // Calculate sequence number (count of elements in this column + 1)
            const elementsInColumn = fieldConfigs.filter(f => f.column === columnPosition).length;
            const sequenceNumber = elementsInColumn + 1;
            
            // Create fieldConfig based on type using centralized defaults
            let newFieldConfig = createFieldConfig(elementType, elementId, sequenceNumber, columnPosition, elementUid);
            
            // Add to fieldConfigs array
            fieldConfigs.push(newFieldConfig);
            
            // Update the display panel
            updateFieldConfigsDisplay();
            
            // Update save button state
            updateSaveButtonState();
            
            console.log('New fieldConfig added:', newFieldConfig);
            
            // Create visual element
            const newElement = document.createElement('div');
            newElement.draggable = true;
            newElement.dataset.uid = elementUid; // Use UID instead of field_name
            newElement.dataset.fieldName = elementId; // Keep for display purposes
            newElement.style.cssText = 'background: #1a3540; padding: 8px 12px; border: 1px solid #555; border-radius: 4px; color: white; margin: 6px 0; font-weight: 600; display: flex; justify-content: space-between; align-items: center; cursor: move; font-size: 14px;';
            
            // Use field_displayname if available, otherwise fallback to field_name
            const displayLabel = newFieldConfig.field_displayname && newFieldConfig.field_displayname.trim() ? newFieldConfig.field_displayname : newFieldConfig.field_name;
            newElement.innerHTML = `<span style="flex: 1; text-align: center;">${displayLabel}</span><button style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0; margin-left: 10px;">×</button>`;
            
            // Attach all event listeners using helper function
            attachElementEventListeners(newElement);
            
            column.appendChild(newElement);
        });
    });
    
    // ============================================
    // SPANNING ZONES DRAG AND DROP HANDLERS
    // ============================================
    spanningZones.forEach((zone, idx) => {
        const zoneName = zone.id === 'topSpanningZone' ? 'top' : 'bottom';
        console.log(`Setting up drop handlers for ${zoneName} spanning zone`);
        
        zone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const types = Array.from(e.dataTransfer.types);
            if (types.includes('elementuid')) {
                e.dataTransfer.dropEffect = 'move';
            } else {
                e.dataTransfer.dropEffect = 'copy';
            }
            
            zone.style.background = 'rgba(102, 126, 234, 0.2)';
            zone.style.borderColor = '#667eea';
            
            // Find the element we should insert before (for reordering within spanning zone)
            const afterElement = getDragAfterElement(zone, e.clientY);
            const draggingElement = document.querySelector('.dragging');
            
            if (draggingElement && types.includes('elementuid')) {
                if (afterElement == null) {
                    zone.appendChild(draggingElement);
                } else {
                    zone.insertBefore(draggingElement, afterElement);
                }
            }
        });

        zone.addEventListener('dragleave', (e) => {
            const rect = zone.getBoundingClientRect();
            const x = e.clientX;
            const y = e.clientY;
            
            if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
                zone.style.background = 'rgba(0,0,0,0.1)';
                zone.style.borderColor = '#666';
            }
        });

        zone.addEventListener('drop', (e) => {
            console.log('=== DROP EVENT ON SPANNING ZONE! ===');
            
            e.preventDefault();
            e.stopPropagation();
            
            zone.style.background = 'rgba(0,0,0,0.1)';
            zone.style.borderColor = '#666';
            
            const elementuid = e.dataTransfer.getData('elementuid');
            
            if (elementuid && elementuid.length > 0) {
                // Moving existing field to spanning zone
                console.log('Moving field to spanning zone:', elementuid);
                
                const fieldConfig = fieldConfigs.find(f => f.uid === elementuid);
                if (fieldConfig) {
                    // Top spanning zone is column 0, bottom is column 99
                    const targetColumn = zone.id === 'topSpanningZone' ? 0 : 99;
                    if (fieldConfig.column !== targetColumn) {
                        console.log(`Updated field column from ${fieldConfig.column} to ${targetColumn} (${zoneName} spanning)`);
                        fieldConfig.column = targetColumn;
                    } else {
                        console.log(`Reordering within ${zoneName} spanning zone`);
                    }
                }
                return;
            }
            
            // Creating new element in spanning zone
            let elementType = e.dataTransfer.getData('text/plain');
            if (!elementType) {
                elementType = e.dataTransfer.getData('application/x-element-type');
            }
            if (!elementType) {
                elementType = e.dataTransfer.getData('text');
            }
            
            if (!elementType) {
                console.error('No element type could be retrieved from dataTransfer!');
                return;
            }
            
            console.log(`Creating new element of type in ${zoneName} spanning zone:`, elementType);
            
            if (!droppedElementCount[elementType]) {
                droppedElementCount[elementType] = 0;
            }
            droppedElementCount[elementType]++;
            
            // Top spanning zone is column 0, bottom is column 99
            const columnPosition = zone.id === 'topSpanningZone' ? 0 : 99;
            const elementId = `${elementType}_${droppedElementCount[elementType]}`;
            const elementUid = generateElementUid();
            
            // Calculate sequence number
            const elementsInColumn = fieldConfigs.filter(f => f.column === columnPosition).length;
            const sequenceNumber = elementsInColumn + 1;
            
            // Create fieldConfig using centralized defaults
            let newFieldConfig = createFieldConfig(elementType, elementId, sequenceNumber, columnPosition, elementUid);
            
            fieldConfigs.push(newFieldConfig);
            updateFieldConfigsDisplay();
            updateSaveButtonState();
            
            // Create visual element
            const newElement = document.createElement('div');
            newElement.draggable = true;
            newElement.dataset.uid = elementUid;
            newElement.dataset.fieldName = elementId;
            newElement.style.cssText = 'background: #1a3540; padding: 8px 12px; border: 1px solid #555; border-radius: 4px; color: white; margin: 6px 0; font-weight: 600; display: flex; justify-content: space-between; align-items: center; cursor: move; font-size: 14px;';
            newElement.innerHTML = `<span style="flex: 1; text-align: center;">${newFieldConfig.field_displayname}</span><button style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0; margin-left: 10px;">×</button>`;
            
            attachElementEventListeners(newElement);
            zone.appendChild(newElement);
        });
    });
}

// Initialize drag and drop
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('Initializing drag and drop...');
        initializeDragAndDrop();
    });
} else {
    console.log('Initializing drag and drop immediately...');
    initializeDragAndDrop();
}

// ============================================
// ELEMENT SETTINGS FUNCTIONS
// ============================================
function showElementSettings(elementUid) {
    selectedElementUid = elementUid;
    formHasBeenModified = false; // Reset flag when loading new element settings
    const fieldConfig = fieldConfigs.find(f => f.uid === elementUid);
    
    if (!fieldConfig) return;
    
    // Store a deep copy of the original settings for change detection
    originalElementSettings = JSON.parse(JSON.stringify(fieldConfig));
    
    // Show the close button, but only show save button if there are unsaved changes
    document.getElementById('closeSettings').style.display = 'block';
    // Save button will be shown/hidden based on form changes via input listeners
    document.getElementById('saveSettings').style.display = 'none';
    
    emptySettings.style.display = 'none';
    settingsPanel.style.display = 'block';
    
    // Build the form
    let formHTML = ``;
    
    // Add Dropdown Type selector for dropdown elements
    if (['dropdown', 'dropdown_static', 'dropdown_graphql', 'dropdown_mysql', 'dropdown_mesh', 'dropdown_prefetch'].includes(fieldConfig.type)) {
        formHTML += `
            <div class="mb-15">
                <label class="form-label">Dropdown Type</label>
                <select id="dropdown_type" class="form-input">
                    <option value="dropdown" ${fieldConfig.type === 'dropdown' ? 'selected' : ''}>Workflow</option>
                    <option value="dropdown_static" ${fieldConfig.type === 'dropdown_static' ? 'selected' : ''}>Static</option>
                    <option value="dropdown_graphql" ${fieldConfig.type === 'dropdown_graphql' ? 'selected' : ''}>GraphQL</option>
                    <option value="dropdown_mysql" ${fieldConfig.type === 'dropdown_mysql' ? 'selected' : ''}>MySQL Query</option>
                    <option value="dropdown_mesh" ${fieldConfig.type === 'dropdown_mesh' ? 'selected' : ''}>MeshCentral Command</option>
                    <option value="dropdown_prefetch" ${fieldConfig.type === 'dropdown_prefetch' ? 'selected' : ''}>Pre-fetched Data</option>
                </select>
            </div>
            
            <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px;">
                <input type="checkbox" id="multi_select" ${fieldConfig.multi_select ? 'checked' : ''} class="checkbox-input">
                <label for="multi_select" style="margin: 0; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">Multi-select</label>
            </div>
        `;
    }
    
    formHTML += `
        <div class="mb-15">
            <label class="form-label">Field Name</label>
            <input type="text" id="field_name" value="${fieldConfig.field_name}" class="form-input">
        </div>
    `;
    
    // Display Name and Description only for non-form_extend elements
    if (fieldConfig.type !== 'form_extend') {
        formHTML += `
            <div class="mb-15">
                <label class="form-label">Display Name</label>
                <input type="text" id="field_displayname" value="${fieldConfig.field_displayname}" class="form-input">
            </div>
            
            <div class="mb-15">
                <label class="form-label">Description</label>
                <input type="text" id="description" value="${fieldConfig.description || ''}" class="form-input">
            </div>
        `;
    }
    
    // Extend Variable field for form_extend elements
    if (fieldConfig.type === 'form_extend') {
        // Get form_extend operations from library metadata
        const allOps = RewstLib.graphqlOperations.getAll();
        let extendVarOptions = '<option value="">Select an extend variable...</option>';
        for (const [opKey, opConfig] of Object.entries(allOps)) {
            if (opConfig.type === 'form_extend') {
                extendVarOptions += `<option value="${opKey}" ${fieldConfig.extend_var === opKey ? 'selected' : ''}>${opConfig.name}</option>`;
            }
        }
        
        formHTML += `
            <div class="mb-15">
                <label class="form-label">Extend Variable</label>
                <select id="extend_var" class="form-input">
                    ${extendVarOptions}
                </select>
            </div>
            <div id="extend_var_inputs_container" class="mb-15"></div>
        `;
    }
    
    // Hidden and Required checkboxes only for non-form_extend elements
    if (fieldConfig.type !== 'form_extend') {
        formHTML += `

        <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px;">
            <input type="checkbox" id="hidden" ${fieldConfig.hidden ? 'checked' : ''} class="checkbox-input">
            <label for="hidden" style="margin: 0; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">Hidden</label>
        </div>
        
        <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px;">
            <input type="checkbox" id="required" ${fieldConfig.required ? 'checked' : ''} class="checkbox-input">
            <label for="required" style="margin: 0; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">Required</label>
        </div>
        ${['dropdown_static', 'dropdown', 'dropdown_graphql', 'dropdown_mysql', 'dropdown_mesh', 'dropdown_prefetch'].includes(fieldConfig.type) ? `
        <div style='margin-bottom: 15px;'>
            <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Results Variable Name</label>
            <input type='text' id='result_var' value='${fieldConfig.result_var || fieldConfig.field_name + '_data' || ''}' placeholder='e.g., dropdown_1_data' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
            <div style='color: #999; font-size: 12px; margin-top: 6px;'>Variable name to store the dropdown results. Defaults to {field_name}_data</div>
        </div>
        ` : ''}
    `;
    }
    
    // Add type-specific fields
    if (fieldConfig.type === 'array') {
        formHTML += `
            <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px;">
                <input type="checkbox" id="repeating_input_mode" ${fieldConfig.repeating_input_mode ? 'checked' : ''} class="checkbox-input">
                <label for="repeating_input_mode" style="margin: 0; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">Repeating Input Mode</label>
            </div>
            
            <div id="items_section" style="display: ${fieldConfig.repeating_input_mode ? 'none' : 'block'}; margin-bottom: 20px;">
                <label style="color: #ffffff; font-weight: 600; font-size: 14px; margin: 0 0 8px 0; display: block;">Items</label>
                <button type="button" id="editArrayItemsBtn" class="btn btn-blue" style="width: 100%;">Edit Array</button>
            </div>
            
            <div id="source_section" style="display: ${fieldConfig.repeating_input_mode ? 'block' : 'none'}; margin-bottom: 15px;">
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Source</label>
                <input type='text' id='repeating_input_source' value='${fieldConfig.source || ''}' placeholder='e.g., script_data.detail2.parameters' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                <div style='color: #999; font-size: 12px; margin-top: 6px;'>This mode generates input fields from an array source. Each array item becomes a parameter with name and value fields.</div>
            </div>
        `;
    }
    
    if (fieldConfig.type === 'checkbox') {
        formHTML += `
            <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px;">
                <input type="checkbox" id="default_checked" ${fieldConfig.default_checked ? 'checked' : ''} class="checkbox-input">
                <label for="default_checked" style="margin: 0; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">Default Checked</label>
            </div>
        `;
    } else if (fieldConfig.type === 'radio') {
        formHTML += `
            <div class="mb-20">
                <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 8px;">
                    <div style="flex: 1;">
                        <label style="color: #ffffff; font-weight: 600; font-size: 14px; margin: 0 0 8px 0; display: block;">Options</label>
                        <div class="flex-gap-8">
                            <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Label</div>
                            <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Value</div>
                        </div>
                    </div>
                    <div>
                        <button id="addRadioOptionBtn" class="btn-builder-blue" title="Add Option">+</button>
                    </div>
                </div>
                <div id="radioOptionsList" style="display: flex; flex-direction: column; gap: 8px;">
        `;
        
        // Add existing options as editable fields
        if (fieldConfig.options && typeof fieldConfig.options === 'object') {
            Object.entries(fieldConfig.options).forEach(([key, value], index) => {
                formHTML += `
                    <div class="radio-option-row" data-index="${index}" style="display: flex; gap: 8px; align-items: center;">
                        <input type="text" class="radio-option-label" value="${key}" placeholder="Label" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                        <input type="text" class="radio-option-value" value="${value}" placeholder="Value" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                        <button class="delete-radio-option-btn" class="btn-builder-red" title="Delete Option">⊘</button>
                    </div>
                `;
            });
        }
        
        formHTML += `
                </div>
            </div>
            <div class="mb-15">
                <label class="form-label">Default Select</label>
                <select id="default_select" class="form-input">
                    <option value="">-- None --</option>
        `;
        
        // Add options from the radio options list
        if (fieldConfig.options && typeof fieldConfig.options === 'object') {
            Object.entries(fieldConfig.options).forEach(([key, value]) => {
                const isSelected = fieldConfig.default_select === key ? 'selected' : '';
                formHTML += `<option value="${key}" ${isSelected}>${key}</option>`;
            });
        }
        
        formHTML += `
                </select>
            </div>
        `;
    } else if (fieldConfig.type === 'text') {
        formHTML += `
            <div class="mb-15">
                <label class="form-label">Default Value</label>
                <input type="text" id="default_value" value="${fieldConfig.default_value || ''}" class="form-input">
            </div>
        `;
    } else if (fieldConfig.type === 'textarea') {
        formHTML += `
            <div class="mb-15">
                <label class="form-label">Default Value</label>
                <textarea id="default_value" style="width: 100%; height: 80px; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;">${fieldConfig.default_value || ''}</textarea>
            </div>
        `;
    } else if (fieldConfig.type === 'html') {
        formHTML += `
            <div class="mb-15">
                <label class="form-label">Content</label>
                <div style="margin-bottom: 8px; padding: 10px; background: rgba(102, 126, 234, 0.1); border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 4px; font-size: 12px; color: #ffffff;">
                    <div style="font-weight: 600; margin-bottom: 4px;">💡 Reference other fields:</div>
                    <div style="color: #ccc;">Use <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace;">[[field_name]]</code> to reference values from other form elements.</div>
                    <div style="margin-top: 6px; color: #ccc;">Example: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace;">&lt;p&gt;Selected date: [[date_1]]&lt;/p&gt;</code></div>
                </div>
                <textarea id="content" style="width: 100%; height: 120px; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: 'Courier New', monospace;">${fieldConfig.content || ''}</textarea>
            </div>
        `;
    } else if (fieldConfig.type === 'horizontal_line') {
        formHTML += `
            <div style="padding: 12px; background: rgba(102, 126, 234, 0.1); border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 4px; font-size: 14px; color: #ffffff; margin-bottom: 15px;">
                <div style="font-weight: 600;">📏 Horizontal Line</div>
                <div style="color: #ccc; margin-top: 6px; font-size: 12px;">This element displays a horizontal line separator. The content is automatically set to &lt;hr style="margin: 10px 0;"&gt;&lt;br&gt;.</div>
            </div>
        `;
    } else if (fieldConfig.type === 'date') {
        formHTML += `
            <div class="mb-15">
                <label class="form-label">Default Value</label>
                <input type="date" id="default_value" value="${fieldConfig.default_value || ''}" class="form-input">
            </div>
        `;
    } else if (fieldConfig.type === 'date_time') {
        formHTML += `
            <div class="mb-15">
                <label class="form-label">Default Value</label>
                <input type="datetime-local" id="default_value" value="${fieldConfig.default_value || ''}" class="form-input">
            </div>
        `;
    } else if (fieldConfig.type === 'dropdown_static') {
        formHTML += `
            <div class="mb-20">
                <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 8px;">
                    <div style="flex: 1;">
                        <label style="color: #ffffff; font-weight: 600; font-size: 14px; margin: 0 0 8px 0; display: block;">Options</label>
                        <div class="flex-gap-8">
                            <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Label</div>
                            <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Value</div>
                        </div>
                    </div>
                    <div>
                        <button id="addOptionBtn" class="btn-builder-blue" title="Add Option">+</button>
                    </div>
                </div>
                <div id="optionsList" style="display: flex; flex-direction: column; gap: 8px;">
        `;
        
        // Add existing options as editable fields
        if (fieldConfig.options && typeof fieldConfig.options === 'object') {
            Object.entries(fieldConfig.options).forEach(([key, value], index) => {
                formHTML += `
                    <div class="option-row" data-index="${index}" style="display: flex; gap: 8px; align-items: center;">
                        <input type="text" class="option-label" value="${key}" placeholder="Label" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                        <input type="text" class="option-value" value="${value}" placeholder="Value" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                        <button class="delete-option-btn" class="btn-builder-red" title="Delete Option">⊘</button>
                    </div>
                `;
            });
        }
        
        formHTML += `
                </div>
            </div>
            <div class="mb-15">
                <label class="form-label">Default Value</label>
                <select id="default_value" class="form-input">
                    <option value="">-- Select a default value --</option>
        `;
        
        if (fieldConfig.options && typeof fieldConfig.options === 'object') {
            Object.entries(fieldConfig.options).forEach(([key, value]) => {
                const isSelected = fieldConfig.default_value === value ? 'selected' : '';
                formHTML += `<option value="${value}" ${isSelected}>${value}</option>`;
            });
        }
        
        formHTML += `
                </select>
            </div>
        `;
    } else if (fieldConfig.type === 'dropdown') {
        // Use option generator workflows only
        const optionsGeneratorWorkflows = availableWorkflowsOG;
        
        let workflowDatalist = '';
        optionsGeneratorWorkflows.forEach(workflow => {
            workflowDatalist += `<option value="${workflow.id}" label="${workflow.name}">`;
        });
        
        // Find the current workflow name (if it exists in filtered list)
        const currentWorkflow = optionsGeneratorWorkflows.find(w => w.id === fieldConfig.workflow_id);
        const currentWorkflowName = currentWorkflow ? currentWorkflow.name : '';
        
        formHTML += `
            <div style="margin-bottom: 15px; position: relative;">
                <label class="form-label">Workflow (Option Generators Only)</label>
                <input type="text" id="workflow_id_search" placeholder="Search or select a workflow..." value="${currentWorkflowName}" autocomplete="off" style="width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 6px; color: #ffffff; box-sizing: border-box; position: relative; z-index: 10;">
                <datalist id="workflow_list">
                    ${workflowDatalist}
                </datalist>
                <input type="hidden" id="workflow_id" value="${fieldConfig.workflow_id || ''}">
                <div id="workflow_dropdown" style="position: absolute; top: 100%; left: 0; right: 0; background: #1a3540; border: 1px solid #555; border-top: none; border-radius: 0 0 6px 6px; max-height: 200px; overflow-y: auto; display: none; z-index: 1001;"></div>
            </div>
        `;
        
        formHTML += `
            <div class="mb-15">
                <label class="form-label">Label Name</label>
                <input type="text" id="label_name" value="${fieldConfig.label_name || ''}" class="form-input">
            </div>
            <div class="mb-15">
                <label class="form-label">Value Name</label>
                <input type="text" id="value_name" value="${fieldConfig.value_name || ''}" class="form-input">
            </div>
            <div class="mb-15">
                <label class="form-label">Default Selector Name</label>
                <input type="text" id="default_selector" value="${fieldConfig.default_selector || 'default'}" class="form-input">
            </div>
            <div class="mb-20">
                <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 8px;">
                    <div style="flex: 1;">
                        <label style="color: #ffffff; font-weight: 600; font-size: 14px; margin: 0 0 8px 0; display: block;">Workflow Input</label>
                        <div class="flex-gap-8">
                            <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Key</div>
                            <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Value</div>
                        </div>
                    </div>
                    <div>
                        <button id="addWorkflowInputBtn" class="btn-builder-blue" title="Add Input">+</button>
                    </div>
                </div>
                <div id="workflowInputList" style="display: flex; flex-direction: column; gap: 8px;">
        `;
        
        // Add existing workflow inputs as editable fields
        if (fieldConfig.workflow_input && typeof fieldConfig.workflow_input === 'object') {
            Object.entries(fieldConfig.workflow_input).forEach(([key, value], index) => {
                formHTML += `
                    <div class="workflow-input-row" data-index="${index}" style="display: flex; gap: 8px; align-items: center;">
                        <input type="text" class="workflow-input-key" value="${key}" placeholder="Key" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                        <input type="text" class="workflow-input-value" value="${typeof value === 'object' ? JSON.stringify(value) : value}" placeholder="Value" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                        <button class="delete-workflow-input-btn" class="btn-builder-red" title="Delete Input">⊘</button>
                    </div>
                `;
            });
        }
        
        formHTML += `
                </div>
        `;
    } else if (fieldConfig.type === 'dropdown_graphql') {
        formHTML += `
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>GraphQL Operation</label>
                <select id='graphql_op' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                    <option value=''>-- Select Operation --</option>
                </select>
            </div>
            <div id='graphql_op_inputs_container' style='margin-bottom: 15px;'></div>
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Label Name</label>
                <input type='text' id='label_name' value='${fieldConfig.label_name || ''}' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
            </div>
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Value Name</label>
                <input type='text' id='value_name' value='${fieldConfig.value_name || ''}' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
            </div>
        `;
    } else if (fieldConfig.type === 'dropdown_mysql') {
        formHTML += `
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>SQL Query</label>
                <textarea id='mysql_query' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: monospace; font-size: 13px; min-height: 120px;'>${fieldConfig.query || ''}</textarea>
                <div style='color: #999; font-size: 12px; margin-top: 6px;'>Use [[field_name]] for form field placeholders, e.g.: SELECT id, name FROM table WHERE org = [[org_field]]</div>
            </div>
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Label Field (Column Name)</label>
                <input type='text' id='mysql_label_field' value='${fieldConfig.label_field || ''}' placeholder='e.g., name' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
            </div>
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Value Field (Column Name)</label>
                <input type='text' id='mysql_value_field' value='${fieldConfig.value_field || ''}' placeholder='e.g., id' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
            </div>
        `;
    } else if (fieldConfig.type === 'dropdown_mesh') {
        formHTML += `
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Mode</label>
                <select id='mesh_mode' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                    <option value='cmd' ${fieldConfig.mode === 'cmd' ? 'selected' : ''}>CMD Command</option>
                    <option value='powershell' ${fieldConfig.mode === 'powershell' ? 'selected' : ''}>PowerShell Command</option>
                    <option value='nodes' ${fieldConfig.mode === 'nodes' ? 'selected' : ''}>Get Nodes</option>
                </select>
            </div>
        `;
        
        // Conditional fields based on mode
        if (fieldConfig.mode === 'cmd' || fieldConfig.mode === 'powershell') {
            formHTML += `
                <div style='margin-bottom: 15px;'>
                    <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Node Selection Type</label>
                    <select id='mesh_node_selection_type' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                        <option value='fixed' ${fieldConfig.node_selection_type === 'fixed' ? 'selected' : ''}>Fixed/Variable Node</option>
                        <option value='query' ${fieldConfig.node_selection_type === 'query' ? 'selected' : ''}>Node Query</option>
                    </select>
                </div>
            `;
            
            // Conditional node selection fields
            if (fieldConfig.node_selection_type === 'fixed') {
                formHTML += `
                    <div style='margin-bottom: 15px;'>
                        <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Fixed/Variable Node</label>
                        <input type='text' id='mesh_node_id' value='${fieldConfig.node_id || ''}' placeholder='e.g., node123 or [[node_field]] or [[org_var]]' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                        <div style='color: #999; font-size: 12px; margin-top: 6px;'>MeshCentral node ID, form field reference, or org variable reference. Supports [[field_name]] or [[var_name]] syntax.</div>
                    </div>
                `;
            } else if (fieldConfig.node_selection_type === 'query') {
                formHTML += `
                    <div style='margin-bottom: 15px;'>
                        <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Node Query</label>
                        <textarea id='mesh_node_query_cmd' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: monospace; font-size: 13px; min-height: 100px;'>${fieldConfig.node_query || ''}</textarea>
                        <div style='color: #999; font-size: 12px; margin-top: 6px;'>Query to find the node. Examples: node.name CONTAINS "primary" | node.tags CONTAINS "org-123"</div>
                    </div>
                `;
            }
            
            formHTML += `
                <div style='margin-bottom: 15px;'>
                    <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Command/Script</label>
                    <textarea id='mesh_command' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: monospace; font-size: 13px; min-height: 120px;'>${fieldConfig.command || ''}</textarea>
                    <div style='color: #999; font-size: 12px; margin-top: 6px;'>Script/command, supports [[field_name]] placeholders. Command must output JSON array.</div>
                </div>
            `;
        } else if (fieldConfig.mode === 'nodes') {
            formHTML += `
                <div style='margin-bottom: 15px;'>
                    <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Node Query Filter (Optional)</label>
                    <textarea id='mesh_node_query' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: monospace; font-size: 13px; min-height: 100px;'>${fieldConfig.node_query || ''}</textarea>
                    <div style='color: #999; font-size: 12px; margin-top: 6px;'>Optional: Filter nodes by query. Leave empty to get all nodes.<br>
                    Examples: node.name CONTAINS "primary" | node.tags CONTAINS "org-123" AND mesh.desc CONTAINS "prod"</div>
                </div>
            `;
        }
        
        // Common fields for all modes
        formHTML += `
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Label Field (JSON Key)</label>
                <input type='text' id='mesh_label_field' value='${fieldConfig.label_field || ''}' placeholder='e.g., name' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
            </div>
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Value Field (JSON Key)</label>
                <input type='text' id='mesh_value_field' value='${fieldConfig.value_field || ''}' placeholder='e.g., id' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
            </div>
        `;
    } else if (fieldConfig.type === 'data_retrieval') {
        // Data Retrieval element - hidden data fetching element
        formHTML += `
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Data Source Type</label>
                <select id='retrieval_type' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                    <option value='mesh_cmd' ${fieldConfig.data_source_type === 'mesh_cmd' ? 'selected' : ''}>MeshCentral CMD</option>
                    <option value='mesh_powershell' ${fieldConfig.data_source_type === 'mesh_powershell' ? 'selected' : ''}>MeshCentral PowerShell</option>
                    <option value='mesh_nodes' ${fieldConfig.data_source_type === 'mesh_nodes' ? 'selected' : ''}>MeshCentral Nodes</option>
                    <option value='mysql' ${fieldConfig.data_source_type === 'mysql' ? 'selected' : ''}>MySQL Query</option>
                    <option value='workflow' ${fieldConfig.data_source_type === 'workflow' ? 'selected' : ''}>Workflow</option>
                    <option value='graphql' ${fieldConfig.data_source_type === 'graphql' ? 'selected' : ''}>GraphQL</option>
                </select>
                <div style='color: #999; font-size: 12px; margin-top: 6px;'>Data will be stored in page variable: <strong>${fieldConfig.field_name || '[field_name]'}</strong></div>
            </div>
        `;
        
        // Conditional fields based on data source type
        if (fieldConfig.data_source_type === 'mesh_cmd' || fieldConfig.data_source_type === 'mesh_powershell') {
            formHTML += `
                <div style='margin-bottom: 15px;'>
                    <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Node Selection Type</label>
                    <select id='retrieval_node_selection_type' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                        <option value='fixed' ${fieldConfig.node_selection_type === 'fixed' ? 'selected' : ''}>Fixed/Variable Node</option>
                        <option value='query' ${fieldConfig.node_selection_type === 'query' ? 'selected' : ''}>Node Query</option>
                    </select>
                </div>
            `;
            
            if (fieldConfig.node_selection_type === 'fixed') {
                formHTML += `
                    <div style='margin-bottom: 15px;'>
                        <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Fixed/Variable Node</label>
                        <input type='text' id='retrieval_node_id' value='${fieldConfig.node_id || ''}' placeholder='e.g., node123 or [[field]] or [[var]]' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                    </div>
                `;
            } else if (fieldConfig.node_selection_type === 'query') {
                formHTML += `
                    <div style='margin-bottom: 15px;'>
                        <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Node Query</label>
                        <textarea id='retrieval_node_query' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: monospace; font-size: 13px; min-height: 100px;'>${fieldConfig.node_query || ''}</textarea>
                    </div>
                `;
            }
            
            formHTML += `
                <div style='margin-bottom: 15px;'>
                    <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Command/Script</label>
                    <textarea id='retrieval_command' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: monospace; font-size: 13px; min-height: 120px;'>${fieldConfig.command || ''}</textarea>
                    <div style='color: #999; font-size: 12px; margin-top: 6px;'>Command must return JSON data, typically an object with arrays (e.g., {ad_users: [...], ad_groups: [...]})</div>
                </div>
            `;
        } else if (fieldConfig.data_source_type === 'mysql') {
            formHTML += `
                <div style='margin-bottom: 15px;'>
                    <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>SQL Query</label>
                    <textarea id='retrieval_query' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: monospace; font-size: 13px; min-height: 120px;'>${fieldConfig.query || ''}</textarea>
                    <div style='color: #999; font-size: 12px; margin-top: 6px;'>Use [[field_name]] placeholders. Should return an array or object with arrays.</div>
                </div>
            `;
        }
    } else if (fieldConfig.type === 'dropdown_prefetch') {
        // Dropdown Prefetch element - uses data from data_retrieval element
        formHTML += `
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Data Source</label>
                <select id='prefetch_source_element_name' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                    <option value=''>-- Select Data Source --</option>
        `;
        
        // Populate with available data_retrieval elements
        const dataRetrievalElements = fieldConfigs.filter(f => f.type === 'data_retrieval');
        dataRetrievalElements.forEach(el => {
            const selected = fieldConfig.source_element_name === el.field_name ? 'selected' : '';
            formHTML += `<option value='${el.field_name}' ${selected}>${el.field_name}</option>`;
        });
        
        formHTML += `
                </select>
                <div style='color: #999; font-size: 12px; margin-top: 6px;'>Select a Data Retrieval element. Data will be fetched from formData.page_variables.{field_name}</div>
            </div>
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Result Path (Optional)</label>
                <input type='text' id='prefetch_result_path' value='${fieldConfig.result_path || ''}' placeholder='e.g., ad_users or data.users' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                <div style='color: #999; font-size: 12px; margin-top: 6px;'>Path to array in the returned data. Use dot notation (e.g., "ad_users" for {ad_users: [...]}, or "data.users" for nested structures). Leave empty if data is directly an array.</div>
            </div>
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Label Field</label>
                <input type='text' id='prefetch_label_field' value='${fieldConfig.label_field || ''}' placeholder='e.g., name' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
            </div>
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Value Field</label>
                <input type='text' id='prefetch_value_field' value='${fieldConfig.value_field || ''}' placeholder='e.g., id' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
            </div>
        `;
    } else if (fieldConfig.type === 'datatable') {
        // Datatable element - display data in table format
        formHTML += `
            <div style='margin-bottom: 15px;'>
                <label style='display: block; margin-bottom: 8px; color: #ffffff; font-weight: 600; font-size: 14px;'>Data Variable</label>
                <input type='text' id='datatable_data_variable' value='${fieldConfig.data_variable || ''}' placeholder='e.g., ad_users or data.users' style='width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box;'>
                <div style='color: #999; font-size: 12px; margin-top: 6px;'>Path to the JSON array to display. Use dot notation for nested structures (e.g., "ad_users" or "data.users").</div>
            </div>
            
            <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px;">
                <input type="checkbox" id="datatable_list_view" ${fieldConfig.list_view ? 'checked' : ''} class="checkbox-input">
                <label for="datatable_list_view" style="margin: 0; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">List View</label>
            </div>
        `;
    }
    let dependantFieldsHTML = '';
    
    // Add common fields - Dependent Fields
    // Parse dependant_fields - handle both old string format and new object format
    let currentDependantFieldsObj = {};
    if (fieldConfig.dependant_fields) {
        if (typeof fieldConfig.dependant_fields === 'string') {
            // Old format: convert "field1,field2" to object with all properties set to true
            // DEFENSIVE: Filter out "null" string
            const fields = fieldConfig.dependant_fields.split(',').map(f => f.trim()).filter(f => f && f !== 'null');
            fields.forEach(f => {
                currentDependantFieldsObj[f] = { blocking: true, block_hidden: true, incl_hidden: true };
            });
        } else if (typeof fieldConfig.dependant_fields === 'object') {
            // New format: already an object
            // DEFENSIVE: Remove "null" key if it exists
            currentDependantFieldsObj = { ...fieldConfig.dependant_fields };
            if ('null' in currentDependantFieldsObj) {
                console.warn('[ELEMENT-SETTINGS] Found malformed "null" key in dependant_fields, removing it');
                delete currentDependantFieldsObj['null'];
            }
        }
    }
    const currentDependantFields = Object.keys(currentDependantFieldsObj);
    
    const otherFields = fieldConfigs.filter(config => config.field_name !== fieldConfig.field_name);
    
    if (otherFields.length > 0) {
        otherFields.forEach(config => {
            const isChecked = currentDependantFields.includes(config.field_name) ? 'checked' : '';
            const isBlocking = currentDependantFieldsObj[config.field_name]?.blocking !== false;
            dependantFieldsHTML += `
                <div style="padding: 10px; border-bottom: 1px solid #555; display: flex; align-items: center; gap: 10px;" class="dependant-field-option" data-field-name="${config.field_name}">
                    <input type="checkbox" value="${config.field_name}" ${isChecked} style="cursor: pointer; flex-shrink: 0;" onclick="event.stopPropagation();">
                    <div style="flex: 1; min-width: 0;">
                        <div style="color: #ffffff; font-weight: 500;">${config.field_displayname}</div>
                        <div style="color: #999; font-size: 12px;">${config.field_name}</div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                        <input type="checkbox" class="blocking-checkbox" data-field-name="${config.field_name}" ${isBlocking ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px;" onclick="event.stopPropagation();" title="Enable blocking (show waiting message)">
                        <span style="color: #999; font-size: 12px; white-space: nowrap;">Block</span>
                    </div>
                </div>
            `;
        });
    } else {
        dependantFieldsHTML = '<div style="padding: 10px; color: #999; text-align: center;">No other fields added yet</div>';
    }
    
    formHTML += `
        <div class="mb-15">
            <label class="form-label">Dependent Fields</label>
            <button type="button" id="editDependentFieldsBtn" class="btn btn-blue" style="width: 100%;">
                ${currentDependantFields.length > 0 ? currentDependantFields.length + ' field(s) selected' : 'Select dependent fields...'}
            </button>
            <input type="hidden" id="dependant_fields" value="${fieldConfig.dependant_fields && typeof fieldConfig.dependant_fields === 'object' ? RewstLib.utils.escapeHtml(JSON.stringify(fieldConfig.dependant_fields)) : ''}">
        </div>
    `;
    
    // Set Show/Hide Conditions for all element types
    formHTML += `
        
        <div class="mb-15">
            <label style="display: flex; align-items: center; gap: 8px; color: #ffffff; font-weight: 600; font-size: 14px; margin-bottom: 0; cursor: pointer;">
                <input type="checkbox" id="enable_conditions" ${fieldConfig.condition_1 || fieldConfig.condition_2 ? 'checked' : ''} class="checkbox-input">
                Set Show/Hide Conditions
            </label>
        </div>
        
        <div id="conditions_container" style="${fieldConfig.condition_1 || fieldConfig.condition_2 ? 'display: block;' : 'display: none;'}">
            <div class="mb-15">
                <label class="form-label">Condition 1</label>
                <input type="text" id="condition_1" value="${RewstLib.utils.escapeHtml(fieldConfig.condition_1 || '')}" class="form-input">
            </div>
            
            <div class="mb-15">
                <label class="form-label">Condition 1 Action</label>
                <select id="condition_1_action" class="form-input">
                    <option value="">-- None --</option>
                    <option value="show" ${fieldConfig.condition_1_action === 'show' ? 'selected' : ''}>Show</option>
                    <option value="hide" ${fieldConfig.condition_1_action === 'hide' ? 'selected' : ''}>Hide</option>
                </select>
            </div>
            
            <div class="mb-15">
                <label class="form-label">Condition 2</label>
                <input type="text" id="condition_2" value="${RewstLib.utils.escapeHtml(fieldConfig.condition_2 || '')}" class="form-input">
            </div>
            
            <div class="mb-20">
                <label class="form-label">Condition 2 Action</label>
                <select id="condition_2_action" class="form-input">
                    <option value="">-- None --</option>
                    <option value="show" ${fieldConfig.condition_2_action === 'show' ? 'selected' : ''}>Show</option>
                    <option value="hide" ${fieldConfig.condition_2_action === 'hide' ? 'selected' : ''}>Hide</option>
                </select>
            </div>
        </div>
    `;
    
    settingsForm.innerHTML = formHTML;
    
    // Add change listener for dropdown_type selector
    const dropdownTypeSelect = document.getElementById('dropdown_type');
    if (dropdownTypeSelect) {
        dropdownTypeSelect.addEventListener('change', (e) => {
            const newType = e.target.value;
            
            // Clear fields that don't belong to the new type
            if (newType === 'dropdown_static') {
                // Static dropdown: keep options, clear workflow, graphql, mysql, and mesh fields
                delete fieldConfig.workflow_id;
                delete fieldConfig.label_name;
                delete fieldConfig.value_name;
                delete fieldConfig.default_selector;
                delete fieldConfig.workflow_input;
                delete fieldConfig.graphql_op;
                delete fieldConfig.graphql_op_variables;
                delete fieldConfig.query;
                delete fieldConfig.label_field;
                delete fieldConfig.value_field;
                delete fieldConfig.node_id;
                delete fieldConfig.command;
                delete fieldConfig.command_type;
            } else if (newType === 'dropdown') {
                // Workflow dropdown: keep workflow fields, clear static, graphql, mysql, and mesh fields
                delete fieldConfig.options;
                delete fieldConfig.graphql_op;
                delete fieldConfig.graphql_op_variables;
                delete fieldConfig.query;
                delete fieldConfig.label_field;
                delete fieldConfig.value_field;
                delete fieldConfig.node_id;
                delete fieldConfig.command;
                delete fieldConfig.command_type;
            } else if (newType === 'dropdown_graphql') {
                // GraphQL dropdown: keep graphql fields, clear static, workflow, mysql, and mesh fields
                delete fieldConfig.options;
                delete fieldConfig.workflow_id;
                delete fieldConfig.label_name;
                delete fieldConfig.value_name;
                delete fieldConfig.default_selector;
                delete fieldConfig.workflow_input;
                delete fieldConfig.query;
                delete fieldConfig.label_field;
                delete fieldConfig.value_field;
                delete fieldConfig.node_id;
                delete fieldConfig.command;
                delete fieldConfig.command_type;
            } else if (newType === 'dropdown_mysql') {
                // MySQL dropdown: keep mysql fields, clear static, workflow, graphql, and mesh fields
                delete fieldConfig.options;
                delete fieldConfig.workflow_id;
                delete fieldConfig.label_name;
                delete fieldConfig.value_name;
                delete fieldConfig.default_selector;
                delete fieldConfig.workflow_input;
                delete fieldConfig.graphql_op;
                delete fieldConfig.graphql_op_variables;
                delete fieldConfig.node_id;
                delete fieldConfig.command;
                delete fieldConfig.command_type;
            } else if (newType === 'dropdown_mesh') {
                // MeshCentral dropdown: keep mesh fields, clear static, workflow, graphql, and mysql fields
                delete fieldConfig.options;
                delete fieldConfig.workflow_id;
                delete fieldConfig.label_name;
                delete fieldConfig.value_name;
                delete fieldConfig.default_selector;
                delete fieldConfig.workflow_input;
                delete fieldConfig.graphql_op;
                delete fieldConfig.graphql_op_variables;
                delete fieldConfig.query;
            }
            
            fieldConfig.type = newType;
            formHasBeenModified = true;
            // Rebuild the form to show appropriate settings for new type
            showElementSettings(elementUid);
        });
    }
    
    // Populate GraphQL operation dropdown from metadata (form_field type only)
    if (fieldConfig.type === 'dropdown_graphql') {
        const graphqlOpSelect = document.getElementById('graphql_op');
        if (graphqlOpSelect && RewstLib && RewstLib.graphqlOperations) {
            const allOperations = RewstLib.graphqlOperations.getAll();
            Object.entries(allOperations).forEach(([operationKey, operation]) => {
                if (operation.type === 'form_field') {
                    const option = document.createElement('option');
                    option.value = operationKey;
                    option.textContent = operation.name;
                    if (fieldConfig.graphql_op === operationKey) {
                        option.selected = true;
                    }
                    graphqlOpSelect.appendChild(option);
                }
            });
            
            // Add change event listener for dynamic input generation
            graphqlOpSelect.addEventListener('change', (e) => {
                const operationName = e.target.value;
                const graphqlOpInputsContainer = document.getElementById('graphql_op_inputs_container');
                graphqlOpInputsContainer.innerHTML = ''; // Clear previous inputs
                
                if (operationName) {
                    const operation = RewstLib.graphqlOperations.get(operationName);
                    if (operation && operation.inputs) {
                        operation.inputs.forEach(input => {
                            let inputHTML = '';
                            const inputId = `graphql_op_input_${input.name}`;
                            const requiredAttr = input.required ? 'required' : '';
                            
                            if (input.type === 'text') {
                                inputHTML = `
                                    <div class="mb-15">
                                        <label style="display: block; color: #ffffff; font-weight: 600; margin-bottom: 8px; font-size: 14px;">${input.label}</label>
                                        <input type="text" id="${inputId}" class="form-field-input" class="form-input" ${requiredAttr}>
                                    </div>
                                `;
                            } else if (input.type === 'textarea') {
                                inputHTML = `
                                    <div class="mb-15">
                                        <label style="display: block; color: #ffffff; font-weight: 600; margin-bottom: 8px; font-size: 14px;">${input.label}</label>
                                        <textarea id="${inputId}" class="form-field-input" style="width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: inherit; min-height: 80px;" ${requiredAttr}></textarea>
                                    </div>
                                `;
                            } else if (input.type === 'checkbox') {
                                inputHTML = `
                                    <div class="mb-15">
                                        <label style="display: flex; align-items: center; gap: 10px; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">
                                            <input type="checkbox" id="${inputId}" class="checkbox-input" ${requiredAttr}>
                                            ${input.label}
                                        </label>
                                    </div>
                                `;
                            }
                            
                            if (inputHTML) {
                                graphqlOpInputsContainer.innerHTML += inputHTML;
                            }
                        });
                        
                        // Populate existing values from fieldConfig if they exist
                        if (fieldConfig.graphql_op_variables) {
                            Object.entries(fieldConfig.graphql_op_variables).forEach(([varName, varValue]) => {
                                const input = document.getElementById(`graphql_op_input_${varName}`);
                                if (input) {
                                    if (input.type === 'checkbox') {
                                        input.checked = varValue;
                                    } else {
                                        input.value = varValue;
                                    }
                                }
                            });
                        }
                    }
                }
            });
            
            // Trigger change event if existing graphql_op is set to generate inputs
            if (fieldConfig.graphql_op) {
                graphqlOpSelect.dispatchEvent(new Event('change'));
            }
        }
    }
    
    // Add change event listener for extend_var dynamic input generation (form_extend only)
    if (fieldConfig.type === 'form_extend') {
        setTimeout(() => {
            const extendVarSelect = document.getElementById('extend_var');
            const extendVarInputsContainer = document.getElementById('extend_var_inputs_container');
            
            if (extendVarSelect && extendVarInputsContainer) {
                extendVarSelect.addEventListener('change', (e) => {
                    const operationName = e.target.value;
                    extendVarInputsContainer.innerHTML = ''; // Clear previous inputs
                    
                    if (operationName) {
                        const operation = RewstLib.graphqlOperations.get(operationName);
                        if (operation && operation.inputs) {
                            operation.inputs.forEach(input => {
                                let inputHTML = '';
                                const inputId = `extend_var_input_${input.name}`;
                                const requiredAttr = input.required ? 'required' : '';
                                
                                if (input.type === 'text') {
                                    const defaultVal = input.defaultValue ? input.defaultValue : '';
                                    inputHTML = `
                                        <div class="mb-15">
                                            <label style="display: block; color: #ffffff; font-weight: 600; margin-bottom: 8px; font-size: 14px;">${input.label}</label>
                                            <input type="text" id="${inputId}" class="form-field-input" class="form-input" value="${defaultVal}" ${requiredAttr}>
                                        </div>
                                    `;
                                } else if (input.type === 'textarea') {
                                    inputHTML = `
                                        <div class="mb-15">
                                            <label style="display: block; color: #ffffff; font-weight: 600; margin-bottom: 8px; font-size: 14px;">${input.label}</label>
                                            <textarea id="${inputId}" class="form-field-input" style="width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: inherit; min-height: 80px;" ${requiredAttr}></textarea>
                                        </div>
                                    `;
                                } else if (input.type === 'checkbox') {
                                    inputHTML = `
                                        <div class="mb-15">
                                            <label style="display: flex; align-items: center; gap: 10px; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">
                                                <input type="checkbox" id="${inputId}" class="checkbox-input" ${requiredAttr}>
                                                ${input.label}
                                            </label>
                                        </div>
                                    `;
                                }
                                
                                if (inputHTML) {
                                    extendVarInputsContainer.innerHTML += inputHTML;
                                }
                            });
                            
                            // Populate existing values from fieldConfig if they exist
                            if (fieldConfig.extend_var_variables) {
                                Object.entries(fieldConfig.extend_var_variables).forEach(([varName, varValue]) => {
                                    const input = document.getElementById(`extend_var_input_${varName}`);
                                    if (input) {
                                        if (input.type === 'checkbox') {
                                            input.checked = varValue;
                                        } else {
                                            input.value = varValue;
                                        }
                                    }
                                });
                            }
                        }
                    }
                });
                
                // Trigger change event if existing extend_var is set to generate inputs
                if (fieldConfig.extend_var) {
                    extendVarSelect.dispatchEvent(new Event('change'));
                }
            }
        }, 0);
    }
    
    // Add event listeners
    document.getElementById('saveSettings').addEventListener('click', saveElementSettings);
    document.getElementById('closeSettings').addEventListener('click', closeElementSettings);
    
    // Add input listeners to form fields to detect changes and show/hide save button
    const formInputs = settingsForm.querySelectorAll('input, textarea, select');
    formInputs.forEach(input => {
        const updateSaveButtonVisibility = () => {
            formHasBeenModified = true; // User has touched the form
            const saveButton = document.getElementById('saveSettings');
            const validationError = validateFormExtendSettings();
            
            if (hasUnsavedFormChanges() && !validationError) {
                saveButton.style.display = 'inline-block';
                saveButton.disabled = false;
            } else {
                saveButton.style.display = 'none';
                saveButton.disabled = true;
            }
        };
        input.addEventListener('change', updateSaveButtonVisibility);
        input.addEventListener('input', updateSaveButtonVisibility);
    });
    
    // Add listeners for dropdown_static options
    if (fieldConfig.type === 'dropdown_static') {
        const addOptionBtn = document.getElementById('addOptionBtn');
        const optionsList = document.getElementById('optionsList');
        
        if (addOptionBtn && optionsList) {
            addOptionBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const index = optionsList.children.length;
                const newRow = document.createElement('div');
                newRow.className = 'option-row';
                newRow.dataset.index = index;
                newRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';
                newRow.innerHTML = `
                    <input type="text" class="option-label" value="" placeholder="Label" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                    <input type="text" class="option-value" value="" placeholder="Value" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                    <button class="delete-option-btn" class="btn-builder-red" title="Delete Option">⊘</button>
                `;
                optionsList.appendChild(newRow);
                attachDeleteOptionListener(newRow.querySelector('.delete-option-btn'));
                
                // Add input listeners to detect changes
                newRow.querySelector('.option-label').addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
                newRow.querySelector('.option-value').addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
                
                // Trigger save button on adding new option
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            });
            
            // Attach delete listeners to existing buttons and input listeners
            document.querySelectorAll('.delete-option-btn').forEach(btn => {
                attachDeleteOptionListener(btn);
            });
            
            // Add input listeners to existing options
            document.querySelectorAll('.option-label, .option-value').forEach(input => {
                input.addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
            });
        }
    }
    
    // Add listeners for radio options
    if (fieldConfig.type === 'radio') {
        const addRadioOptionBtn = document.getElementById('addRadioOptionBtn');
        const radioOptionsList = document.getElementById('radioOptionsList');
        
        if (addRadioOptionBtn && radioOptionsList) {
            addRadioOptionBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const index = radioOptionsList.children.length;
                const newRow = document.createElement('div');
                newRow.className = 'radio-option-row';
                newRow.dataset.index = index;
                newRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';
                newRow.innerHTML = `
                    <input type="text" class="radio-option-label" value="" placeholder="Label" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                    <input type="text" class="radio-option-value" value="" placeholder="Value" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                    <button class="delete-radio-option-btn" class="btn-builder-red" title="Delete Option">⊘</button>
                `;
                radioOptionsList.appendChild(newRow);
                attachDeleteRadioOptionListener(newRow.querySelector('.delete-radio-option-btn'));
                
                // Add input listener to update default select when label changes
                const labelInput = newRow.querySelector('.radio-option-label');
                labelInput.addEventListener('input', updateRadioDefaultSelect);
                
                // Add input listeners to detect changes
                newRow.querySelector('.radio-option-label').addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
                newRow.querySelector('.radio-option-value').addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
                
                // Trigger save button on adding new radio option
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
                
                updateRadioDefaultSelect();
            });
            
            // Attach delete listeners to existing buttons
            document.querySelectorAll('.delete-radio-option-btn').forEach(btn => {
                attachDeleteRadioOptionListener(btn);
            });
            
            // Attach input listeners to existing label fields and add save button listeners
            document.querySelectorAll('.radio-option-label').forEach(input => {
                input.addEventListener('input', updateRadioDefaultSelect);
                input.addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
            });
            
            // Add input listeners to existing radio option values
            document.querySelectorAll('.radio-option-value').forEach(input => {
                input.addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
            });
        }
    }
    
    // Add listeners for dropdown workflow inputs
    if (fieldConfig.type === 'dropdown') {
        const addWorkflowInputBtn = document.getElementById('addWorkflowInputBtn');
        const workflowInputList = document.getElementById('workflowInputList');
        
        if (addWorkflowInputBtn && workflowInputList) {
            addWorkflowInputBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const index = workflowInputList.children.length;
                const newRow = document.createElement('div');
                newRow.className = 'workflow-input-row';
                newRow.dataset.index = index;
                newRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';
                newRow.innerHTML = `
                    <input type="text" class="workflow-input-key" value="" placeholder="Key" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                    <input type="text" class="workflow-input-value" value="" placeholder="Value" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; width: 50%;">
                    <button class="delete-workflow-input-btn" class="btn-builder-red" title="Delete Input">⊘</button>
                `;
                workflowInputList.appendChild(newRow);
                attachDeleteWorkflowInputListener(newRow.querySelector('.delete-workflow-input-btn'));
                
                // Add input listeners to detect changes
                newRow.querySelector('.workflow-input-key').addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
                newRow.querySelector('.workflow-input-value').addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
                
                // Trigger save button on adding new workflow input
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            });
            
            // Attach delete listeners to existing buttons and input listeners
            document.querySelectorAll('.delete-workflow-input-btn').forEach(btn => {
                attachDeleteWorkflowInputListener(btn);
            });
            
            // Add input listeners to existing workflow inputs
            document.querySelectorAll('.workflow-input-key, .workflow-input-value').forEach(input => {
                input.addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
            });
        }
    }
    
    // Add listeners for dropdown_mysql
    if (fieldConfig.type === 'dropdown_mysql') {
        const mysqlQueryInput = document.getElementById('mysql_query');
        const mysqlLabelFieldInput = document.getElementById('mysql_label_field');
        const mysqlValueFieldInput = document.getElementById('mysql_value_field');
        
        [mysqlQueryInput, mysqlLabelFieldInput, mysqlValueFieldInput].forEach(input => {
            if (input) {
                input.addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
            }
        });
    }
    
    // Add listeners for dropdown_mesh
    if (fieldConfig.type === 'dropdown_mesh') {
        const meshModeSelect = document.getElementById('mesh_mode');
        const meshNodeSelectionTypeSelect = document.getElementById('mesh_node_selection_type');
        const meshNodeIdInput = document.getElementById('mesh_node_id');
        const meshNodeQueryCmdInput = document.getElementById('mesh_node_query_cmd');
        const meshCommandInput = document.getElementById('mesh_command');
        const meshNodeQueryInput = document.getElementById('mesh_node_query');
        const meshLabelFieldInput = document.getElementById('mesh_label_field');
        const meshValueFieldInput = document.getElementById('mesh_value_field');
        
        // Mode dropdown listener - rebuild form on mode change
        if (meshModeSelect) {
            meshModeSelect.addEventListener('change', (e) => {
                fieldConfig.mode = e.target.value;
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
                // Rebuild form to show/hide conditional fields
                showElementSettings(elementUid);
            });
        }
        
        // Node Selection Type dropdown listener - rebuild form on change
        if (meshNodeSelectionTypeSelect) {
            meshNodeSelectionTypeSelect.addEventListener('change', (e) => {
                fieldConfig.node_selection_type = e.target.value;
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
                // Rebuild form to show/hide conditional node selection fields
                showElementSettings(elementUid);
            });
        }
        
        // Input listeners for conditional fields
        [meshNodeIdInput, meshNodeQueryCmdInput, meshCommandInput, meshNodeQueryInput, meshLabelFieldInput, meshValueFieldInput].forEach(input => {
            if (input) {
                input.addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
            }
        });
    }
    
    // Add listeners for data_retrieval
    if (fieldConfig.type === 'data_retrieval') {
        const retrievalTypeSelect = document.getElementById('retrieval_type');
        const retrievalNodeSelectionTypeSelect = document.getElementById('retrieval_node_selection_type');
        const retrievalNodeIdInput = document.getElementById('retrieval_node_id');
        const retrievalNodeQueryInput = document.getElementById('retrieval_node_query');
        const retrievalCommandInput = document.getElementById('retrieval_command');
        const retrievalQueryInput = document.getElementById('retrieval_query');
        
        // Type dropdown listener - rebuild form on type change
        if (retrievalTypeSelect) {
            retrievalTypeSelect.addEventListener('change', (e) => {
                fieldConfig.data_source_type = e.target.value;
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
                showElementSettings(elementUid);
            });
        }
        
        // Node Selection Type dropdown listener - rebuild form on change
        if (retrievalNodeSelectionTypeSelect) {
            retrievalNodeSelectionTypeSelect.addEventListener('change', (e) => {
                fieldConfig.node_selection_type = e.target.value;
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
                showElementSettings(elementUid);
            });
        }
        
        // Input listeners
        [retrievalNodeIdInput, retrievalNodeQueryInput, retrievalCommandInput, retrievalQueryInput].forEach(input => {
            if (input) {
                input.addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
            }
        });
    }
    
    // Add listeners for dropdown_prefetch
    if (fieldConfig.type === 'dropdown_prefetch') {
        const prefetchSourceSelect = document.getElementById('prefetch_source_element_name');
        const prefetchResultPathInput = document.getElementById('prefetch_result_path');
        const prefetchLabelFieldInput = document.getElementById('prefetch_label_field');
        const prefetchValueFieldInput = document.getElementById('prefetch_value_field');
        
        // Input listeners
        [prefetchSourceSelect, prefetchResultPathInput, prefetchLabelFieldInput, prefetchValueFieldInput].forEach(input => {
            if (input) {
                input.addEventListener('input', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
                input.addEventListener('change', () => {
                    formHasBeenModified = true;
                    updateElementSettingsSaveButtonVisibility();
                });
            }
        });
    }
    
    // Add listener for result_var (all dropdown types)
    const isDropdownType = ['dropdown_static', 'dropdown', 'dropdown_graphql', 'dropdown_mysql', 'dropdown_mesh', 'dropdown_prefetch'].includes(fieldConfig.type);
    if (isDropdownType) {
        const resultVarInput = document.getElementById('result_var');
        if (resultVarInput) {
            resultVarInput.addEventListener('input', () => {
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            });
        }
    }
    
    // Add listeners for datatable
    if (fieldConfig.type === 'datatable') {
        const dataVariableInput = document.getElementById('datatable_data_variable');
        const listViewCheckbox = document.getElementById('datatable_list_view');
        
        if (dataVariableInput) {
            dataVariableInput.addEventListener('input', () => {
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            });
        }
        
        if (listViewCheckbox) {
            listViewCheckbox.addEventListener('change', () => {
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            });
        }
    }
    
    if (fieldConfig.type === 'array') {
        const editArrayItemsBtn = document.getElementById('editArrayItemsBtn');
        const repeatingInputModeCheckbox = document.getElementById('repeating_input_mode');
        const itemsSection = document.getElementById('items_section');
        const sourceSection = document.getElementById('source_section');
        const sourceInput = document.getElementById('repeating_input_source');
        
        if (editArrayItemsBtn) {
            editArrayItemsBtn.addEventListener('click', (e) => {
                e.preventDefault();
                openArrayItemsModal(fieldConfig);
            });
        }
        
        if (repeatingInputModeCheckbox) {
            repeatingInputModeCheckbox.addEventListener('change', () => {
                const isRepeatingMode = repeatingInputModeCheckbox.checked;
                
                // Toggle visibility of Items and Source sections
                if (itemsSection) {
                    itemsSection.style.display = isRepeatingMode ? 'none' : 'block';
                }
                if (sourceSection) {
                    sourceSection.style.display = isRepeatingMode ? 'block' : 'none';
                }
                
                // Trigger form modification
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            });
        }
        
        if (sourceInput) {
            sourceInput.addEventListener('input', () => {
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            });
        }
    }
    
    function updateRadioDefaultSelect() {
        const defaultSelect = document.getElementById('default_select');
        if (!defaultSelect) return;
        
        const currentValue = defaultSelect.value;
        const radioOptionRows = document.querySelectorAll('.radio-option-row');
        
        // Clear and rebuild options
        defaultSelect.innerHTML = '<option value="">-- None --</option>';
        
        radioOptionRows.forEach(row => {
            const label = row.querySelector('.radio-option-label').value.trim();
            if (label) {
                const option = document.createElement('option');
                option.value = label;
                option.textContent = label;
                if (label === currentValue) {
                    option.selected = true;
                }
                defaultSelect.appendChild(option);
            }
        });
    }
    
    function attachDeleteRadioOptionListener(btn) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            
            const deleteOptionModal = document.getElementById('deleteOptionModal');
            const deleteOptionYes = document.getElementById('deleteOptionYes');
            const deleteOptionNo = document.getElementById('deleteOptionNo');
            const rowToDelete = btn.closest('.radio-option-row');
            
            // Show the modal
            deleteOptionModal.classList.add('active');
            
            // Handler for Yes button
            const handleYes = () => {
                rowToDelete.remove();
                updateRadioDefaultSelect();
                deleteOptionModal.classList.remove('active');
                deleteOptionYes.removeEventListener('click', handleYes);
                deleteOptionNo.removeEventListener('click', handleNo);
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            };
            
            // Handler for No button
            const handleNo = () => {
                deleteOptionModal.classList.remove('active');
                deleteOptionYes.removeEventListener('click', handleYes);
                deleteOptionNo.removeEventListener('click', handleNo);
            };
            
            // Attach handlers
            deleteOptionYes.addEventListener('click', handleYes);
            deleteOptionNo.addEventListener('click', handleNo);
            
            // Close on outside click
            const handleOutsideClick = (event) => {
                if (event.target === deleteOptionModal) {
                    handleNo();
                    deleteOptionModal.removeEventListener('click', handleOutsideClick);
                }
            };
            deleteOptionModal.addEventListener('click', handleOutsideClick);
        });
    }
    
    function attachDeleteOptionListener(btn) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            
            const deleteOptionModal = document.getElementById('deleteOptionModal');
            const deleteOptionYes = document.getElementById('deleteOptionYes');
            const deleteOptionNo = document.getElementById('deleteOptionNo');
            const rowToDelete = btn.closest('.option-row');
            
            // Show the modal
            deleteOptionModal.classList.add('active');
            
            // Handler for Yes button
            const handleYes = () => {
                rowToDelete.remove();
                deleteOptionModal.classList.remove('active');
                deleteOptionYes.removeEventListener('click', handleYes);
                deleteOptionNo.removeEventListener('click', handleNo);
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            };
            
            // Handler for No button
            const handleNo = () => {
                deleteOptionModal.classList.remove('active');
                deleteOptionYes.removeEventListener('click', handleYes);
                deleteOptionNo.removeEventListener('click', handleNo);
            };
            
            // Attach handlers
            deleteOptionYes.addEventListener('click', handleYes);
            deleteOptionNo.addEventListener('click', handleNo);
            
            // Close on outside click
            const handleOutsideClick = (event) => {
                if (event.target === deleteOptionModal) {
                    handleNo();
                    deleteOptionModal.removeEventListener('click', handleOutsideClick);
                }
            };
            deleteOptionModal.addEventListener('click', handleOutsideClick);
        });
    }
    
    function attachDeleteArrayItemListener(btn) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            
            const deleteArrayItemModal = document.getElementById('deleteArrayItemModal');
            const deleteArrayItemYes = document.getElementById('deleteArrayItemYes');
            const deleteArrayItemNo = document.getElementById('deleteArrayItemNo');
            const rowToDelete = btn.closest('.array-item-row');
            
            // Show the modal
            deleteArrayItemModal.classList.add('active');
            
            // Handler for Yes button
            const handleYes = () => {
                rowToDelete.remove();
                deleteArrayItemModal.classList.remove('active');
                deleteArrayItemYes.removeEventListener('click', handleYes);
                deleteArrayItemNo.removeEventListener('click', handleNo);
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            };
            
            // Handler for No button
            const handleNo = () => {
                deleteArrayItemModal.classList.remove('active');
                deleteArrayItemYes.removeEventListener('click', handleYes);
                deleteArrayItemNo.removeEventListener('click', handleNo);
            };
            
            // Attach handlers
            deleteArrayItemYes.addEventListener('click', handleYes);
            deleteArrayItemNo.addEventListener('click', handleNo);
            
            // Close on outside click
            const handleOutsideClick = (event) => {
                if (event.target === deleteArrayItemModal) {
                    handleNo();
                    deleteArrayItemModal.removeEventListener('click', handleOutsideClick);
                }
            };
            deleteArrayItemModal.addEventListener('click', handleOutsideClick);
        });
    }
    
    function attachDeleteWorkflowInputListener(btn) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            
            const deleteOptionModal = document.getElementById('deleteOptionModal');
            const deleteOptionYes = document.getElementById('deleteOptionYes');
            const deleteOptionNo = document.getElementById('deleteOptionNo');
            const rowToDelete = btn.closest('.workflow-input-row');
            
            // Show the modal
            deleteOptionModal.classList.add('active');
            
            // Handler for Yes button
            const handleYes = () => {
                rowToDelete.remove();
                deleteOptionModal.classList.remove('active');
                deleteOptionYes.removeEventListener('click', handleYes);
                deleteOptionNo.removeEventListener('click', handleNo);
                formHasBeenModified = true;
                updateElementSettingsSaveButtonVisibility();
            };
            
            // Handler for No button
            const handleNo = () => {
                deleteOptionModal.classList.remove('active');
                deleteOptionYes.removeEventListener('click', handleYes);
                deleteOptionNo.removeEventListener('click', handleNo);
            };
            
            // Attach handlers
            deleteOptionYes.addEventListener('click', handleYes);
            deleteOptionNo.addEventListener('click', handleNo);
            
            // Close on outside click
            const handleOutsideClick = (event) => {
                if (event.target === deleteOptionModal) {
                    handleNo();
                    deleteOptionModal.removeEventListener('click', handleOutsideClick);
                }
            };
            deleteOptionModal.addEventListener('click', handleOutsideClick);
        });
    }
    
    // Add toggle listener for conditions checkbox
    const enableConditionsCheckbox = document.getElementById('enable_conditions');
    const conditionsContainer = document.getElementById('conditions_container');
    
    if (enableConditionsCheckbox && conditionsContainer) {
        enableConditionsCheckbox.addEventListener('change', (e) => {
            conditionsContainer.style.display = e.target.checked ? 'block' : 'none';
        });
    }
    
    // Add event listener for Edit Dependent Fields button
    const editDependentFieldsBtn = document.getElementById('editDependentFieldsBtn');
    if (editDependentFieldsBtn) {
        editDependentFieldsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openDependentFieldsModal(fieldConfig);
        });
    }
    
    // Add workflow search functionality if this is a dropdown element
    if (fieldConfig.type === 'dropdown') {
        setTimeout(() => {
            const searchInput = document.getElementById('workflow_id_search');
            const hiddenInput = document.getElementById('workflow_id');
            const dropdown = document.getElementById('workflow_dropdown');
            
            const optionsGeneratorWorkflows = availableWorkflowsOG;
            
            if (searchInput && dropdown) {
                // Show dropdown on focus if empty
                searchInput.addEventListener('focus', () => {
                    if (searchInput.value.length === 0) {
                        dropdown.innerHTML = optionsGeneratorWorkflows.map(w => {
                            const escapedName = w.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                            return `<div style="padding: 10px; cursor: pointer; color: #ffffff; border-bottom: 1px solid #555; transition: background 0.2s;" onmouseover="this.style.background = '#444';" onmouseout="this.style.background = 'transparent';" onclick="document.getElementById('workflow_id_search').value = '${escapedName}'; document.getElementById('workflow_id').value = '${w.id}'; document.getElementById('workflow_dropdown').style.display = 'none';">${w.name}</div>`;
                        }).join('');
                        dropdown.style.display = 'block';
                    }
                });
                
                // Filter on input
                searchInput.addEventListener('input', (e) => {
                    const searchTerm = e.target.value.toLowerCase();
                    const matches = optionsGeneratorWorkflows.filter(w => 
                        w.name.toLowerCase().includes(searchTerm)
                    );
                    
                    if (searchTerm.length > 0) {
                        if (matches.length > 0) {
                            dropdown.innerHTML = matches.map(w => {
                                const escapedName = w.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                                return `<div style="padding: 10px; cursor: pointer; color: #ffffff; border-bottom: 1px solid #555; transition: background 0.2s;" onmouseover="this.style.background = '#444';" onmouseout="this.style.background = 'transparent';" onclick="document.getElementById('workflow_id_search').value = '${escapedName}'; document.getElementById('workflow_id').value = '${w.id}'; document.getElementById('workflow_dropdown').style.display = 'none';">${w.name}</div>`;
                            }).join('');
                            dropdown.style.display = 'block';
                        } else {
                            dropdown.innerHTML = '<div style="padding: 10px; color: #999; text-align: center;">No option generator workflows found</div>';
                            dropdown.style.display = 'block';
                        }
                    } else {
                        dropdown.style.display = 'none';
                    }
                });
                
                // Hide dropdown on blur
                searchInput.addEventListener('blur', () => {
                    setTimeout(() => {
                        dropdown.style.display = 'none';
                    }, 200);
                });
            }
        }, 0);
    }
}

function saveElementSettings() {
    try {
        const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid);
        if (!fieldConfig) {
            console.error('Field config not found for uid:', selectedElementUid);
            return;
        }
        
        // Store the old field name before updating (for display purposes)
        const oldFieldName = fieldConfig.field_name;
        const newFieldName = document.getElementById('field_name')?.value;
        
        if (!newFieldName) {
            console.error('Field name input not found');
            return;
        }
        
        // Update common fields
        fieldConfig.field_name = newFieldName;
        fieldConfig.field_displayname = document.getElementById('field_displayname')?.value || '';
        fieldConfig.description = document.getElementById('description')?.value?.trim() || '';
        fieldConfig.type = document.getElementById('type')?.value || fieldConfig.type;
        fieldConfig.hidden = document.getElementById('hidden')?.checked || false;
        fieldConfig.required = document.getElementById('required')?.checked || false;
        
        // form_extend elements are always hidden
        if (fieldConfig.type === 'form_extend') {
            fieldConfig.hidden = true;
        }
        
        // Handle dependant_fields from hidden input (populated by modal)
        const dependantFieldsInput = document.getElementById('dependant_fields');
        const dependantFieldsValue = dependantFieldsInput?.value;
        
        console.log('[SAVE-SETTINGS] Reading dependant_fields from hidden input:', dependantFieldsValue);
        
        // Parse JSON format, handle null/empty
        if (dependantFieldsValue && dependantFieldsValue !== 'null' && dependantFieldsValue.trim() !== '') {
            try {
                const parsed = JSON.parse(dependantFieldsValue);
                
                // DEFENSIVE: Ensure "null" key never exists
                if (parsed && typeof parsed === 'object' && 'null' in parsed) {
                    console.warn('[SAVE-SETTINGS] Found malformed "null" key in dependant_fields, removing it');
                    delete parsed['null'];
                    if (Object.keys(parsed).length === 0) {
                        fieldConfig.dependant_fields = null;
                    } else {
                        fieldConfig.dependant_fields = parsed;
                    }
                } else {
                    fieldConfig.dependant_fields = parsed;
                }
                
                console.log('[SAVE-SETTINGS] Parsed dependant_fields from JSON:', fieldConfig.dependant_fields);
                
                // Verify all properties are present
                if (fieldConfig.dependant_fields && typeof fieldConfig.dependant_fields === 'object') {
                    Object.entries(fieldConfig.dependant_fields).forEach(([fieldName, props]) => {
                        console.log(`  Field "${fieldName}": blocking=${props.blocking}, block_hidden=${props.block_hidden}, incl_hidden=${props.incl_hidden}`);
                    });
                }
            } catch (e) {
                console.warn('[SAVE-SETTINGS] Failed to parse JSON, falling back to comma-separated format:', e.message);
                // If not valid JSON, assume it's old comma-separated format
                const fields = dependantFieldsValue.split(',').map(f => f.trim()).filter(f => f && f !== 'null');
                if (fields.length > 0) {
                    fieldConfig.dependant_fields = {};
                    fields.forEach(f => {
                        fieldConfig.dependant_fields[f] = { blocking: true, block_hidden: true, incl_hidden: true };
                    });
                } else {
                    fieldConfig.dependant_fields = null;
                }
            }
        } else {
            fieldConfig.dependant_fields = null;
            console.log('[SAVE-SETTINGS] No dependant_fields value, setting to null');
        }
        
        // Validation: form_extend elements must have at least one dependent field
        const validationError = validateFormExtendSettings();
        if (validationError) {
            showValidationErrorModal(validationError);
            return;
        }
        
        fieldConfig.condition_1 = document.getElementById('condition_1')?.value || null;
        fieldConfig.condition_1_action = document.getElementById('condition_1_action')?.value || null;
        fieldConfig.condition_2 = document.getElementById('condition_2')?.value || null;
        fieldConfig.condition_2_action = document.getElementById('condition_2_action')?.value || null;
        
        // Update type-specific fields
        saveTypeSpecificFields(fieldConfig);
        
        // Update the DOM element
        const domElement = document.querySelector(`[data-uid="${selectedElementUid}"]`);
        if (domElement) {
            // Update the data attribute with new field name (for display)
            domElement.dataset.fieldName = newFieldName;
            
            // Update the display name in the visual element using fallback logic
            const displaySpan = domElement.querySelector('span');
            if (displaySpan) {
                const displayLabel = fieldConfig.field_displayname && fieldConfig.field_displayname.trim() 
                    ? fieldConfig.field_displayname 
                    : fieldConfig.field_name;
                displaySpan.textContent = displayLabel;
            }
            
            // Clone the element to remove all old event listeners
            const newElement = domElement.cloneNode(true);
            domElement.parentNode.replaceChild(newElement, domElement);
            
            // Re-attach all event listeners using our helper function
            attachElementEventListeners(newElement);
        }
        
        console.log('Settings saved:', fieldConfig);
        updateFieldConfigsDisplay();
        updateSaveButtonState();
        
        // Update the original settings to match the newly saved config
        // This clears the unsaved changes flag
        originalElementSettings = JSON.parse(JSON.stringify(fieldConfig));
        formHasBeenModified = false; // Reset modification flag after save
        
        // Hide the save button since there are no unsaved changes now
        document.getElementById('saveSettings').style.display = 'none';
    } catch (error) {
        console.error('Error saving element settings:', error);
        alert('Error saving element settings: ' + error.message);
    }
}

function hasSettingsChanged() {
    if (!selectedElementUid || !originalElementSettings) return false;
    
    const currentConfig = fieldConfigs.find(f => f.uid === selectedElementUid);
    if (!currentConfig) return false;
    
    // Compare JSON representations
    return JSON.stringify(originalElementSettings) !== JSON.stringify(currentConfig);
}

function getCurrentSettingsFromForm() {
    // Build a config object from the current form values
    const tempConfig = {};
    
    const fieldNameInput = document.getElementById('field_name');
    const fieldDisplaynameInput = document.getElementById('field_displayname');
    const descriptionInput = document.getElementById('description');
    const typeInput = document.getElementById('type');
    const hiddenInput = document.getElementById('hidden');
    const requiredInput = document.getElementById('required');
    
    if (fieldNameInput) tempConfig.field_name = fieldNameInput.value;
    if (fieldDisplaynameInput) tempConfig.field_displayname = fieldDisplaynameInput.value;
    if (descriptionInput) tempConfig.description = descriptionInput.value || ''; // Normalize empty to empty string
    if (typeInput) tempConfig.type = typeInput.value;
    if (hiddenInput) tempConfig.hidden = hiddenInput.checked;
    if (requiredInput) tempConfig.required = requiredInput.checked;
    
    // Get type-specific fields based on the element type
    if (tempConfig.type) {
        // For checkbox
        const defaultCheckedInput = document.getElementById('default_checked');
        if (defaultCheckedInput) {
            tempConfig.default_checked = defaultCheckedInput.checked;
        }
        
        // For text, textarea, date, date_time
        const defaultValueInput = document.getElementById('default_value');
        if (defaultValueInput) {
            tempConfig.default_value = defaultValueInput.value || null;
        }
        
        // For HTML type
        const contentInput = document.getElementById('content');
        if (contentInput) {
            tempConfig.content = contentInput.value || '';
            console.log('Content field value from form:', tempConfig.content);
        }
        
        // For radio
        const defaultSelectInput = document.getElementById('default_select');
        if (defaultSelectInput) {
            tempConfig.default_select = defaultSelectInput.value || null;
        }
        
        // For array
        const arrayItemRows = document.querySelectorAll('.array-item-row');
        if (arrayItemRows.length > 0) {
            const items = {};
            arrayItemRows.forEach(row => {
                const labelInput = row.querySelector('.array-item-label');
                const valueInput = row.querySelector('.array-item-value');
                if (labelInput && valueInput) {
                    const label = labelInput.value.trim();
                    const value = valueInput.value.trim();
                    if (label && value) {
                        items[label] = value;
                    }
                }
            });
            tempConfig.items = items;
        }
    }
    
    console.log('Current form values:', tempConfig);
    return tempConfig;
}

// Helper function to show unsaved changes modal and return a promise
function confirmUnsavedChanges(fieldDisplayName = null) {
    return new Promise((resolve) => {
        const modal = document.getElementById('unsavedChangesModal');
        const messageElement = document.getElementById('unsavedChangesMessage');
        const cancelBtn = document.getElementById('unsavedChangesCancel');
        const continueBtn = document.getElementById('unsavedChangesContinue');
        
        // Set the message with field name if provided
        if (fieldDisplayName) {
            messageElement.textContent = `You have unsaved changes for field "${fieldDisplayName}". Are you sure you want to continue without saving?`;
        } else {
            messageElement.textContent = 'You have unsaved changes. Are you sure you want to continue without saving?';
        }
        
        modal.classList.add('active');
        
        const handleCancel = () => {
            modal.classList.remove('active');
            cancelBtn.removeEventListener('click', handleCancel);
            continueBtn.removeEventListener('click', handleContinue);
            modal.removeEventListener('click', handleOutsideClick);
            resolve(false); // User cancelled
        };
        
        const handleContinue = () => {
            modal.classList.remove('active');
            cancelBtn.removeEventListener('click', handleCancel);
            continueBtn.removeEventListener('click', handleContinue);
            modal.removeEventListener('click', handleOutsideClick);
            resolve(true); // User confirmed to discard changes
        };
        
        const handleOutsideClick = (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        };
        
        cancelBtn.addEventListener('click', handleCancel);
        continueBtn.addEventListener('click', handleContinue);
        modal.addEventListener('click', handleOutsideClick);
    });
}

function hasUnsavedFormChanges() {
    // If form has been modified by the user, there are unsaved changes
    // The flag is set whenever user interacts with any input
    if (formHasBeenModified) {
        console.log('Form has been modified - unsaved changes detected');
        return true;
    }
    
    console.log('Form has not been modified');
    return false;
}

function updateElementSettingsSaveButtonVisibility() {
    const saveButton = document.getElementById('saveSettings');
    const validationError = validateFormExtendSettings();
    
    if (hasUnsavedFormChanges() && !validationError) {
        saveButton.style.display = 'inline-block';
        saveButton.disabled = false;
    } else {
        saveButton.style.display = 'none';
        saveButton.disabled = true;
    }
}

/**
 * Validate form_extend element settings
 * Returns null if valid, error message string if invalid
 */
function validateFormExtendSettings() {
    if (selectedElementUid) {
        const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid);
        if (fieldConfig && fieldConfig.type === 'form_extend') {
            const dependantFieldsInput = document.getElementById('dependant_fields');
            const dependantFieldsValue = dependantFieldsInput?.value;
            if (!dependantFieldsValue) {
                return 'Form Extend elements must have at least one Dependent Field selected.';
            }
        }
        if (fieldConfig && fieldConfig.type === 'datatable') {
            const dataVariableInput = document.getElementById('datatable_data_variable');
            const dataVariableValue = dataVariableInput?.value?.trim();
            if (!dataVariableValue) {
                return 'Datatable elements must have a Data Variable specified.';
            }
        }
    }
    return null;
}

function showValidationErrorModal(message) {
    document.getElementById('validationErrorContent').textContent = message;
    document.getElementById('validationErrorModal').classList.add('active');
}

function hideValidationErrorModal() {
    document.getElementById('validationErrorModal').classList.remove('active');
}

async function closeElementSettings(forceClose = false) {
    // Check for unsaved changes
    if (!forceClose && hasUnsavedFormChanges()) {
        const fieldDisplayName = originalElementSettings ? originalElementSettings.field_displayname : 'Unknown';
        const confirmed = await confirmUnsavedChanges(fieldDisplayName);
        if (!confirmed) {
            return; // Don't close
        }
    }
    
    selectedElementUid = null;
    originalElementSettings = null;
    formHasBeenModified = false; // Reset modification flag when closing
    
    // Hide the save and close buttons
    document.getElementById('saveSettings').style.display = 'none';
    document.getElementById('closeSettings').style.display = 'none';
    
    settingsPanel.style.display = 'none';
    emptySettings.style.display = 'block';
    settingsForm.innerHTML = '';
}

// ============================================
// SAVE FUNCTIONALITY
// ============================================
const saveFormBtn = document.getElementById('saveFormBtn');
const saveConfirmModal = document.getElementById('saveConfirmModal');
const saveModalCloseBtn = document.getElementById('saveModalCloseBtn');

// Function to check if save button should be enabled
function updateSaveButtonState() {
    // Guard: only run if the save button exists and critical objects are initialized
    if (!saveFormBtn || typeof fieldConfigs === 'undefined') return;
    
    // Detect if this is FormExtendBuilder (has extend_title) or FormBuilder (has form_name)
    const extendTitleInput = document.getElementById('extend_title');
    const isFormExtend = !!extendTitleInput;
    
    // Get form name - FormBuilder uses 'form_name', FormExtendBuilder uses 'extend_title'
    const formNameElement = isFormExtend ? extendTitleInput : document.getElementById('form_name');
    const formName = formNameElement ? formNameElement.value.trim() : '';
    
    const hasElements = fieldConfigs.length > 0;
    
    // Check if all form_extend elements have at least one dependent field
    const formExtendWithoutDependants = fieldConfigs.filter(f => {
        if (f.type !== 'form_extend') return false;
        if (!f.dependant_fields) return true;
        if (typeof f.dependant_fields === 'string') return f.dependant_fields === '';
        if (typeof f.dependant_fields === 'object') return Object.keys(f.dependant_fields).length === 0;
        return true;
    });
    const allFormExtendsHaveDependants = formExtendWithoutDependants.length === 0;
    
    let canSave;
    
    if (isFormExtend) {
        // FormExtendBuilder: only needs form name, has fields, and form_extends properly configured
        canSave = formName !== '' && hasElements && allFormExtendsHaveDependants;
    } else {
        // FormBuilder: needs form name, submit workflow/graphql, fields, dropdowns, and form_extends
        const submitTypeElement = document.getElementById('hidden_submit_type');
        const submitType = submitTypeElement ? submitTypeElement.value : 'workflow';
        
        const submitWorkflow = (hiddenSubmitWorkflow && hiddenSubmitWorkflow.value) ? hiddenSubmitWorkflow.value : '';
        
        const graphqlOpElement = document.getElementById('hidden_graphql_submit_op');
        const graphqlOperation = graphqlOpElement ? graphqlOpElement.value : '';
        
        // Check if all dropdowns have proper configuration
        const dropdownsWithoutConfig = fieldConfigs.filter(f => {
            if (f.type === 'dropdown') {
                return !f.workflow_id || f.workflow_id === '';
            } else if (f.type === 'dropdown_graphql') {
                return !f.graphql_op || f.graphql_op === '';
            } else if (f.type === 'dropdown_mysql') {
                return !f.query || f.query === '' || !f.label_field || f.label_field === '' || !f.value_field || f.value_field === '';
            } else if (f.type === 'dropdown_mesh') {
                // Check based on mode
                if (f.mode === 'cmd' || f.mode === 'powershell') {
                    // Check node selection based on type
                    let nodeSelectValid = false;
                    if (f.node_selection_type === 'fixed') {
                        nodeSelectValid = f.node_id && f.node_id !== '';
                    } else if (f.node_selection_type === 'query') {
                        nodeSelectValid = f.node_query && f.node_query !== '';
                    }
                    return !nodeSelectValid || !f.command || f.command === '' || !f.label_field || f.label_field === '' || !f.value_field || f.value_field === '';
                } else if (f.mode === 'nodes') {
                    return !f.label_field || f.label_field === '' || !f.value_field || f.value_field === '';
                }
                return false;
            } else if (f.type === 'dropdown_prefetch') {
                // Check prefetch dropdown configuration
                return !f.source_element_name || f.source_element_name === '' || !f.label_field || f.label_field === '' || !f.value_field || f.value_field === '';
            } else if (f.type === 'data_retrieval') {
                // Check data retrieval configuration
                if (f.data_source_type === 'mesh_cmd' || f.data_source_type === 'mesh_powershell') {
                    let nodeSelectValid = false;
                    if (f.node_selection_type === 'fixed') {
                        nodeSelectValid = f.node_id && f.node_id !== '';
                    } else if (f.node_selection_type === 'query') {
                        nodeSelectValid = f.node_query && f.node_query !== '';
                    }
                    return !nodeSelectValid || !f.command || f.command === '';
                } else if (f.data_source_type === 'mysql') {
                    return !f.query || f.query === '';
                }
                return false;
            }
            return false;
        });
        const allDropdownsConfigured = dropdownsWithoutConfig.length === 0;
        
        // Determine if submit requirements are met based on submit_type
        let submitIsValid = false;
        if (submitType === 'workflow') {
            submitIsValid = submitWorkflow !== '';
        } else if (submitType === 'graphql') {
            submitIsValid = graphqlOperation !== '';
        }
        
        canSave = formName !== '' && submitIsValid && hasElements && allDropdownsConfigured && allFormExtendsHaveDependants;
    }
    
    saveFormBtn.disabled = !canSave;
    
    // Build validation tooltip content
    const validationItems = document.getElementById('validationItems');
    if (validationItems) {
        const items = [
            { label: 'Form Name', valid: formName !== '' }
        ];
        
        if (isFormExtend) {
            // FormExtendBuilder validation items
            items.push({ label: 'Form Elements', valid: hasElements });
        } else {
            // FormBuilder validation items
            const submitTypeElement = document.getElementById('hidden_submit_type');
            const submitType = submitTypeElement ? submitTypeElement.value : 'workflow';
            const submitWorkflow = (hiddenSubmitWorkflow && hiddenSubmitWorkflow.value) ? hiddenSubmitWorkflow.value : '';
            const graphqlOpElement = document.getElementById('hidden_graphql_submit_op');
            const graphqlOperation = graphqlOpElement ? graphqlOpElement.value : '';
            
            // Add submit requirement based on type
            if (submitType === 'workflow') {
                items.push({ label: 'Submit Workflow', valid: submitWorkflow !== '' });
            } else if (submitType === 'graphql') {
                items.push({ label: 'GraphQL Operation', valid: graphqlOperation !== '' });
            }
            
            items.push({ label: 'Form Elements', valid: hasElements });
            
            // Add validation for each dropdown without proper configuration
            const dropdownsWithoutConfig = fieldConfigs.filter(f => {
                if (f.type === 'dropdown') {
                    return !f.workflow_id || f.workflow_id === '';
                } else if (f.type === 'dropdown_graphql') {
                    return !f.graphql_op || f.graphql_op === '';
                } else if (f.type === 'dropdown_mysql') {
                    return !f.query || f.query === '' || !f.label_field || f.label_field === '' || !f.value_field || f.value_field === '';
                } else if (f.type === 'dropdown_mesh') {
                    // Check based on mode
                    if (f.mode === 'cmd' || f.mode === 'powershell') {
                        // Check node selection based on type
                        let nodeSelectValid = false;
                        if (f.node_selection_type === 'fixed') {
                            nodeSelectValid = f.node_id && f.node_id !== '';
                        } else if (f.node_selection_type === 'query') {
                            nodeSelectValid = f.node_query && f.node_query !== '';
                        }
                        return !nodeSelectValid || !f.command || f.command === '' || !f.label_field || f.label_field === '' || !f.value_field || f.value_field === '';
                    } else if (f.mode === 'nodes') {
                        return !f.label_field || f.label_field === '' || !f.value_field || f.value_field === '';
                    }
                    return false;
                } else if (f.type === 'dropdown_prefetch') {
                    // Check prefetch dropdown configuration
                    return !f.source_element_uid || f.source_element_uid === '' || !f.label_field || f.label_field === '' || !f.value_field || f.value_field === '';
                }
                return false;
            });
            dropdownsWithoutConfig.forEach(dropdown => {
                let missingLabel = 'Configuration';
                if (dropdown.type === 'dropdown') {
                    missingLabel = 'Workflow';
                } else if (dropdown.type === 'dropdown_graphql') {
                    missingLabel = 'GraphQL Operation';
                } else if (dropdown.type === 'dropdown_mysql') {
                    missingLabel = 'Query/Fields';
                } else if (dropdown.type === 'dropdown_mesh') {
                    if (dropdown.mode === 'cmd' || dropdown.mode === 'powershell') {
                        if (!dropdown.node_selection_type) {
                            missingLabel = 'Node Selection';
                        } else if (dropdown.node_selection_type === 'fixed') {
                            missingLabel = 'Fixed/Variable Node/Command/Fields';
                        } else if (dropdown.node_selection_type === 'query') {
                            missingLabel = 'Node Query/Command/Fields';
                        }
                    } else if (dropdown.mode === 'nodes') {
                        missingLabel = 'Fields';
                    }
                } else if (dropdown.type === 'dropdown_prefetch') {
                    missingLabel = 'Source/Fields';
                }
                items.push({
                    label: `${dropdown.field_name} ${missingLabel}`,
                    valid: false
                });
            });
        }
        
        // Add validation for each form_extend without dependent fields (both apps)
        const formExtendWithoutDependants = fieldConfigs.filter(f => {
            if (f.type !== 'form_extend') return false;
            if (!f.dependant_fields) return true;
            if (typeof f.dependant_fields === 'string') return f.dependant_fields === '';
            if (typeof f.dependant_fields === 'object') return Object.keys(f.dependant_fields).length === 0;
            return true;
        });
        formExtendWithoutDependants.forEach(formExtend => {
            items.push({
                label: `${formExtend.field_name} Dependent Fields`,
                valid: false
            });
        });
        
        validationItems.innerHTML = items.map(item => `
            <div style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
                <span style="color: ${item.valid ? '#28a745' : '#dc3545'}; font-weight: bold; font-size: 16px;">${item.valid ? '✓' : '✗'}</span>
                <span style="color: #ffffff;">${item.label}</span>
            </div>
        `).join('');
    }
}

// Call on page load to set initial state
updateSaveButtonState();
const saveConfirmYes = document.getElementById('saveConfirmYes');
const saveConfirmNo = document.getElementById('saveConfirmNo');

// Add hover listeners for validation tooltip
const saveValidationTooltip = document.getElementById('saveValidationTooltip');
if (saveFormBtn && saveValidationTooltip) {
    saveFormBtn.addEventListener('mouseenter', () => {
        if (saveFormBtn.disabled) {
            saveValidationTooltip.style.display = 'block';
        }
    });
    
    saveFormBtn.addEventListener('mouseleave', () => {
        saveValidationTooltip.style.display = 'none';
    });
}

// ============================================
// GENERAL SETTINGS MODAL
// ============================================
const generalSettingsModal = document.getElementById('generalSettingsModal');
const generalSettingsBtn = document.getElementById('generalSettingsBtn');
const generalSettingsSave = document.getElementById('generalSettingsSave');
const generalSettingsCancel = document.getElementById('generalSettingsCancel');

const showNameModal = document.getElementById('show_name_modal');
const submitWorkflowModal = document.getElementById('form_submit_workflow_modal');
const submitTypeRadios = document.querySelectorAll('input[name="submit_type"]');
const submitWorkflowSection = document.getElementById('submit_workflow_section');
const submitGraphQLSection = document.getElementById('submit_graphql_section');
const outputVarSection = document.getElementById('output_var_section');
const graphqlSubmitOp = document.getElementById('graphql_submit_op');
const graphqlInputsContainer = document.getElementById('graphql_inputs_container');

// Populate GraphQL operation dropdown from metadata (submit type only)
if (graphqlSubmitOp && RewstLib && RewstLib.graphqlOperations) {
    const allOperations = RewstLib.graphqlOperations.getAll();
    Object.entries(allOperations).forEach(([operationKey, operation]) => {
        if (operation.type === 'submit') {
            const option = document.createElement('option');
            option.value = operationKey;
            option.textContent = operation.name;
            graphqlSubmitOp.appendChild(option);
        }
    });
}

// Add event listener to Submit Workflow modal dropdown
if (submitWorkflowModal) {
    submitWorkflowModal.addEventListener('change', () => {
        updateSaveButtonState();
    });
}

if (graphqlSubmitOp) {
    graphqlSubmitOp.addEventListener('change', (e) => {
        const operationName = e.target.value;
        graphqlInputsContainer.innerHTML = ''; // Clear previous inputs
        
        if (operationName) {
            const operation = RewstLib.graphqlOperations.get(operationName);
            if (operation && operation.inputs) {
                operation.inputs.forEach(input => {
                    let inputHTML = '';
                    const inputId = `graphql_input_${input.name}`;
                    const requiredAttr = input.required ? 'required' : '';
                    
                    if (input.type === 'text') {
                        inputHTML = `
                            <div class="mb-15">
                                <label style="display: block; color: #ffffff; font-weight: 600; margin-bottom: 8px; font-size: 14px;">${input.label}</label>
                                <input type="text" id="${inputId}" class="form-field-input" class="form-input" ${requiredAttr}>
                            </div>
                        `;
                    } else if (input.type === 'textarea') {
                        inputHTML = `
                            <div class="mb-15">
                                <label style="display: block; color: #ffffff; font-weight: 600; margin-bottom: 8px; font-size: 14px;">${input.label}</label>
                                <textarea id="${inputId}" class="form-field-input" style="width: 100%; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: inherit; min-height: 80px;" ${requiredAttr}></textarea>
                            </div>
                        `;
                    } else if (input.type === 'checkbox') {
                        inputHTML = `
                            <div class="mb-15">
                                <label style="display: flex; align-items: center; gap: 10px; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">
                                    <input type="checkbox" id="${inputId}" class="checkbox-input" ${requiredAttr}>
                                    ${input.label}
                                </label>
                            </div>
                        `;
                    }
                    
                    if (inputHTML) {
                        graphqlInputsContainer.innerHTML += inputHTML;
                    }
                });
            }
        }
        // Update button state when graphql operation changes
        updateSaveButtonState();
    });
}

// Add event listeners to submit_type radio buttons
submitTypeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        if (e.target.value === 'workflow') {
            submitWorkflowSection.style.display = 'block';
            submitGraphQLSection.style.display = 'none';
            outputVarSection.style.display = 'block';
        } else if (e.target.value === 'graphql') {
            submitWorkflowSection.style.display = 'none';
            submitGraphQLSection.style.display = 'block';
            outputVarSection.style.display = 'none';
        }
        // Update button state when submit type changes
        updateSaveButtonState();
    });
});

// Open modal and sync values from hidden fields to modal
generalSettingsBtn.addEventListener('click', async () => {
    // Check if there are unsaved changes in element settings
    if (selectedElementUid && hasUnsavedFormChanges()) {
        console.log('Unsaved element changes detected before opening general settings');
        const fieldDisplayName = originalElementSettings ? originalElementSettings.field_displayname : 'Unknown';
        const confirmed = await confirmUnsavedChanges(fieldDisplayName);
        if (!confirmed) {
            console.log('User cancelled opening general settings due to unsaved element changes');
            return; // Don't open general settings
        }
        console.log('User confirmed to discard element changes and open general settings');
        // Close element settings without saving
        await closeElementSettings(true);
    }
    
    // Wait for user roles to be initialized if not already done
    if (!allUserRoles || allUserRoles.length === 0) {
        console.log('[GENERAL-SETTINGS] Waiting for user roles to initialize...');
        try {
            await initializeUserRoles();
            console.log('[GENERAL-SETTINGS] User roles initialized, continuing...');
        } catch (error) {
            console.error('[GENERAL-SETTINGS] Failed to initialize user roles:', error);
            // Continue anyway - permissions section will show warning
        }
    }
    
    if (showNameModal) {
        showNameModal.checked = hiddenShowName.checked;
    }
    if (submitWorkflowModal) {
        submitWorkflowModal.value = hiddenSubmitWorkflow.value;
    }
    const outputVarInput = document.getElementById('output_var_name');
    if (outputVarInput) {
        outputVarInput.value = document.getElementById('hidden_output_var') ? document.getElementById('hidden_output_var').value : '';
    }
    
    // Sync submit_type radio buttons
    if (hiddenSubmitType) {
        const submitTypeValue = hiddenSubmitType.value || 'workflow';
        const submitTypeRadios = document.querySelectorAll('input[name="submit_type"]');
        submitTypeRadios.forEach(radio => {
            radio.checked = radio.value === submitTypeValue;
        });
        
        // Show/hide sections based on submit type
        const submitWorkflowSection = document.getElementById('submit_workflow_section');
        const submitGraphQLSection = document.getElementById('submit_graphql_section');
        const outputVarSection = document.getElementById('output_var_section');
        
        if (submitTypeValue === 'workflow') {
            if (submitWorkflowSection) submitWorkflowSection.style.display = 'block';
            if (submitGraphQLSection) submitGraphQLSection.style.display = 'none';
            if (outputVarSection) outputVarSection.style.display = 'block';
        } else if (submitTypeValue === 'graphql') {
            if (submitWorkflowSection) submitWorkflowSection.style.display = 'none';
            if (submitGraphQLSection) submitGraphQLSection.style.display = 'block';
            if (outputVarSection) outputVarSection.style.display = 'none';
        }
    }
    
    // Sync graphql_submit operation and trigger input generation
    const hiddenGraphQLSubmitVars = document.getElementById('hidden_graphql_submit_vars');
    const graphqlSubmitOpSelect = document.getElementById('graphql_submit_op');
    if (hiddenGraphQLSubmitOp && graphqlSubmitOpSelect) {
        graphqlSubmitOpSelect.value = hiddenGraphQLSubmitOp.value;
        graphqlSubmitOpSelect.dispatchEvent(new Event('change'));
        
        // Populate existing variable values from hidden field
        setTimeout(() => {
            if (hiddenGraphQLSubmitVars && hiddenGraphQLSubmitVars.value) {
                try {
                    const graphqlVars = JSON.parse(hiddenGraphQLSubmitVars.value);
                    console.log('[MODAL] GraphQL variables from hidden field:', graphqlVars);
                    const graphqlInputsContainer = document.getElementById('graphql_inputs_container');
                    if (graphqlInputsContainer) {
                        Object.entries(graphqlVars).forEach(([varName, varValue]) => {
                            const input = document.getElementById(`graphql_input_${varName}`);
                            console.log('[MODAL] Looking for input:', `graphql_input_${varName}`, 'found:', !!input);
                            if (input) {
                                if (input.type === 'checkbox') {
                                    input.checked = varValue;
                                } else {
                                    input.value = varValue;
                                }
                                console.log('[MODAL] Set', varName, 'to:', varValue);
                            }
                        });
                    }
                } catch (e) {
                    console.warn('Failed to parse graphql variables:', e);
                }
            }
        }, 200);
    }
    
    // Listener for permissions being saved from modal
    // This will be attached to the document and fire when user saves permissions in the security modal
    const handlePermissionsSaved = () => {
        console.log('[GENERAL-SETTINGS] Permissions modal saved');
        updateFieldConfigsDisplay();
    };
    
    // Remove previous listener to avoid duplicates
    document.removeEventListener('permissionsSaved', handlePermissionsSaved);
    // Add listener for when permissions are saved in modal
    document.addEventListener('permissionsSaved', handlePermissionsSaved);
    
    generalSettingsModal.classList.add('active');
});

// Close modal handlers
const closeGeneralSettings = () => {
    generalSettingsModal.classList.remove('active');
};

generalSettingsCancel.addEventListener('click', closeGeneralSettings);

// Click outside to close
generalSettingsModal.addEventListener('click', (e) => {
    if (e.target === generalSettingsModal) {
        closeGeneralSettings();
    }
});

// Save button - sync modal values back to hidden fields and trigger updates
generalSettingsSave.addEventListener('click', () => {
    // Sync checkbox
    if (showNameModal) {
        hiddenShowName.checked = showNameModal.checked;
    }
    
    // Sync columns dropdown and trigger column update
    // Sync submit workflow
    if (submitWorkflowModal) {
        hiddenSubmitWorkflow.value = submitWorkflowModal.value;
    }
    
    // Sync output variable name
    const outputVarInput = document.getElementById('output_var_name');
    if (outputVarInput) {
        let hiddenOutputVar = document.getElementById('hidden_output_var');
        if (!hiddenOutputVar) {
            // Create hidden field if it doesn't exist
            hiddenOutputVar = document.createElement('input');
            hiddenOutputVar.type = 'hidden';
            hiddenOutputVar.id = 'hidden_output_var';
            document.body.appendChild(hiddenOutputVar);
        }
        hiddenOutputVar.value = outputVarInput.value;
    }
    
    // Sync submit_type
    const selectedSubmitType = document.querySelector('input[name="submit_type"]:checked')?.value || 'workflow';
    if (hiddenSubmitType) {
        hiddenSubmitType.value = selectedSubmitType;
    }
    
    // Sync graphql_submit operation
    const graphqlSubmitOpSelect = document.getElementById('graphql_submit_op');
    if (graphqlSubmitOpSelect && hiddenGraphQLSubmitOp) {
        hiddenGraphQLSubmitOp.value = graphqlSubmitOpSelect.value;
    }
    
    // Sync graphql_submit variables to a hidden field
    const graphqlInputsContainer = document.getElementById('graphql_inputs_container');
    const hiddenGraphQLSubmitVars = document.getElementById('hidden_graphql_submit_vars') || (() => {
        const field = document.createElement('input');
        field.type = 'hidden';
        field.id = 'hidden_graphql_submit_vars';
        document.body.appendChild(field);
        return field;
    })();
    
    if (graphqlInputsContainer) {
        const variables = {};
        const inputs = graphqlInputsContainer.querySelectorAll('[id^="graphql_input_"]');
        inputs.forEach(input => {
            const varName = input.id.replace('graphql_input_', '');
            if (input.type === 'checkbox') {
                variables[varName] = input.checked;
            } else {
                variables[varName] = input.value;
            }
        });
        hiddenGraphQLSubmitVars.value = JSON.stringify(variables);
    } else {
        hiddenGraphQLSubmitVars.value = '{}';
    }
    
    // Sync form permissions
    // permissionsSelect.dataset.selectedValues is the source of truth
    // It's already updated when user saves from the permissions modal
    // No sync needed - just ensure preview is updated
    
    // Update the JSON preview display
    updateFieldConfigsDisplay();
    
    // Update save button state in case workflow selection changed
    updateSaveButtonState();
    
    closeGeneralSettings();
});

const validationErrorModal = document.getElementById('validationErrorModal');
const validationModalCloseBtn = document.getElementById('validationModalCloseBtn');
const validationErrorContent = document.getElementById('validationErrorContent');
const validationErrorOk = document.getElementById('validationErrorOk');

// Validation functions
function validateFieldConfigs() {
    const errors = [];
    
    // Check for duplicate field names
    const fieldNames = {};
    const duplicates = [];
    
    fieldConfigs.forEach(config => {
        if (fieldNames[config.field_name]) {
            if (!duplicates.includes(config.field_name)) {
                duplicates.push(config.field_name);
            }
        } else {
            fieldNames[config.field_name] = true;
        }
    });
    
    if (duplicates.length > 0) {
        const duplicateList = duplicates.map(name => `<strong>${name}</strong>`).join(', ');
        errors.push(`Duplicate field name(s) found: ${duplicateList}`);
    }
    
    // Check for dropdown fields without workflows
    const missingWorkflows = [];
    
    fieldConfigs.forEach(config => {
        if (config.type === 'dropdown' && (!config.workflow_id || config.workflow_id === '')) {
            missingWorkflows.push(config.field_name);
        }
    });
    
    if (missingWorkflows.length > 0) {
        missingWorkflows.forEach(fieldName => {
            errors.push(`<strong>${fieldName}</strong> is not configured properly - Please select a workflow.`);
        });
    }
    
    // Check form-level submit configuration based on submit_type (FormBuilder only, not FormExtend)
    const extendTitleInput = document.getElementById('extend_title');
    const isFormExtend = !!extendTitleInput;
    
    if (!isFormExtend) {
        // FormBuilder-specific validation
        const submitType = document.getElementById('hidden_submit_type') ? document.getElementById('hidden_submit_type').value : 'workflow';
        const submitWorkflow = hiddenSubmitWorkflow ? hiddenSubmitWorkflow.value : '';
        const graphqlOperation = document.getElementById('hidden_graphql_submit_op') ? document.getElementById('hidden_graphql_submit_op').value : '';
        
        console.log('[VALIDATE] submitType:', submitType, 'submitWorkflow:', submitWorkflow, 'graphqlOperation:', graphqlOperation);
        
        if (submitType === 'workflow') {
            if (!submitWorkflow || submitWorkflow === '') {
                errors.push('Please select a <strong>Submit Workflow</strong> in General Settings.');
            }
        } else if (submitType === 'graphql') {
            if (!graphqlOperation || graphqlOperation === '') {
                errors.push('Please select a <strong>GraphQL Operation</strong> in General Settings.');
            }
        }
    }
    
    console.log('[VALIDATE] Final errors:', errors);
    return errors;
}

function showValidationError(errors) {
    const errorHtml = errors.map(error => `<p style="margin: 0 0 15px 0;">${error}</p>`).join('');
    validationErrorContent.innerHTML = errorHtml;
    validationErrorModal.classList.add('active');
}

function showSuccessMessage(message) {
    const successMessageModal = document.getElementById('successMessageModal');
    const successMessageText = document.getElementById('successMessageText');
    
    successMessageText.textContent = message;
    successMessageModal.classList.add('active');
    
    // Auto-close after 1 second and refresh existing forms list
    setTimeout(() => {
        successMessageModal.classList.remove('active');
        // Refresh the existing forms list
        fetchExistingForms().catch(error => {
            console.error('Error refreshing forms list:', error);
        });
    }, 1000);
}

if (saveFormBtn) {
    saveFormBtn.addEventListener('click', async () => {
        console.log('[SAVE] Save button clicked, button disabled:', saveFormBtn.disabled);
        
        // Don't proceed if button is disabled
        if (saveFormBtn.disabled) {
            console.log('[SAVE] Button is disabled, returning');
            return;
        }
        
        console.log('[SAVE] Proceeding with save logic');
        
        // Check if there are unsaved changes in element settings (only if panel is open)
        const settingsPanel = document.getElementById('settingsPanel');
        if (selectedElementUid && settingsPanel && settingsPanel.style.display === 'block' && hasUnsavedFormChanges()) {
            console.log('Unsaved element changes detected before form save');
            const fieldDisplayName = originalElementSettings ? originalElementSettings.field_displayname : 'Unknown';
            const confirmed = await confirmUnsavedChanges(fieldDisplayName);
            if (!confirmed) {
                console.log('User cancelled form save due to unsaved element changes');
                return; // Don't save form
            }
            console.log('User confirmed to discard element changes and save form');
            // Close element settings without saving
            await closeElementSettings(true);
        }
        
        // Validate before showing confirmation
        const errors = validateFieldConfigs();
        
        if (errors.length > 0) {
            // Show validation errors
            showValidationError(errors);
        } else {
            // Show the confirmation modal
            saveConfirmModal.classList.add('active');
        }
    });
}

if (saveModalCloseBtn) {
    saveModalCloseBtn.addEventListener('click', () => {
        saveConfirmModal.classList.remove('active');
    });
}

if (saveConfirmNo) {
    saveConfirmNo.addEventListener('click', () => {
        saveConfirmModal.classList.remove('active');
    });
}

if (saveConfirmYes) {
    saveConfirmYes.addEventListener('click', async () => {
        console.log('[SAVE HANDLER] Click event triggered');
        
        // Prevent duplicate execution
        if (saveConfirmYes.disabled) {
            console.log('[SAVE HANDLER] Button already disabled - ABORTING to prevent duplicate');
            return;
        }
        saveConfirmYes.disabled = true;
        console.log('[SAVE HANDLER] Button disabled, proceeding with save');
        
        // Close the confirmation modal
        saveConfirmModal.classList.remove('active');
        
        // Show saving status modal
        const savingStatusModal = document.getElementById('savingStatusModal');
        const savingSpinner = document.getElementById('savingSpinner');
        const savingMessage = document.getElementById('savingMessage');
        const savingOkButton = document.getElementById('savingOkButton');
        
        savingSpinner.style.display = 'block';
        savingMessage.textContent = 'Saving...';
        savingOkButton.style.display = 'none';
        savingStatusModal.classList.add('active');
        
        try {
            // Update sequences based on current DOM order before saving
            updateElementSequences();
            
            // Build the form configuration
            // Detect if this is FormExtendBuilder (has extend_title) or FormBuilder (has form_name)
            const extendTitleInput = document.getElementById('extend_title');
            const isFormExtend = !!extendTitleInput;
            
            let formConfig;
            
            if (isFormExtend) {
                // FormExtendBuilder config structure
                const formName = extendTitleInput.value;
                const showTitle = document.getElementById('show_name_modal') ? document.getElementById('show_name_modal').checked : true;
                const columnCount = document.querySelector('input[name="formColumns"]:checked') ? parseInt(document.querySelector('input[name="formColumns"]:checked').value) : 2;
                const showVertSep = document.getElementById('show_vert_sep') ? document.getElementById('show_vert_sep').checked : false;
                
                formConfig = {
                    extend_title: formName,
                    show_title: showTitle,
                    column_count: columnCount,
                    show_vert_sep: showVertSep,
                    user: (typeof rewstUser !== 'undefined' && rewstUser ? rewstUser.username : 'unknown_user'),
                    permissions: [],
                    field_configs: fieldConfigs
                };
            } else {
                // FormBuilder config structure
                const formName = formNameInput ? formNameInput.value : '';
                const showName = showNameCheckbox ? showNameCheckbox.checked : true;
                const columnCount = columnsSelect ? parseInt(columnsSelect.value) : 2;
                const submitWorkflowId = submitWorkflowSelect ? submitWorkflowSelect.value : '';
                
                formConfig = {
                    form_name: formName,
                    show_form: showName,
                    column_count: columnCount,
                    show_vert_sep: document.getElementById('show_vert_sep') ? document.getElementById('show_vert_sep').checked : false,
                    form_workflow: submitWorkflowId,
                    output_var: document.getElementById('hidden_output_var') ? document.getElementById('hidden_output_var').value : '',
                    submit_type: document.getElementById('hidden_submit_type') ? document.getElementById('hidden_submit_type').value : 'workflow',
                    graphql_submit: {
                        operation: document.getElementById('hidden_graphql_submit_op') ? document.getElementById('hidden_graphql_submit_op').value : '',
                        variables: {}
                    },
                    user: (typeof rewstUser !== 'undefined' && rewstUser ? rewstUser.username : 'unknown_user'),
                    permissions: [],
                    field_configs: fieldConfigs
                };
            }
            
            // Save common properties
            if (!isFormExtend) {
                // Populate graphql_submit variables from dynamically generated inputs (FormBuilder only)
                const graphqlInputsContainer = document.getElementById('graphql_inputs_container');
                const hiddenGraphQLSubmitVars = document.getElementById('hidden_graphql_submit_vars');
                
                // Try to get from hidden field first (from general settings), then from DOM
                if (hiddenGraphQLSubmitVars && hiddenGraphQLSubmitVars.value) {
                    try {
                        formConfig.graphql_submit.variables = JSON.parse(hiddenGraphQLSubmitVars.value);
                    } catch (e) {
                        console.warn('Failed to parse stored graphql variables:', e);
                        formConfig.graphql_submit.variables = {};
                    }
                } else if (graphqlInputsContainer) {
                    const inputs = graphqlInputsContainer.querySelectorAll('[id^="graphql_input_"]');
                    inputs.forEach(input => {
                        const varName = input.id.replace('graphql_input_', '');
                        if (input.type === 'checkbox') {
                            formConfig.graphql_submit.variables[varName] = input.checked;
                        } else {
                            formConfig.graphql_submit.variables[varName] = input.value;
                        }
                    });
                }
                
                // Add form_id if we're updating an existing form (FormBuilder only)
                if (loadedFormId) {
                    formConfig.form_id = loadedFormId.name;
                }
            }
            
            // Populate form permissions from hidden field (for both FormBuilder and FormExtend)
            const hiddenFormPermissionsSave = document.getElementById('hidden_form_permissions');
            if (hiddenFormPermissionsSave && hiddenFormPermissionsSave.value) {
                try {
                    formConfig.permissions = JSON.parse(hiddenFormPermissionsSave.value);
                } catch (e) {
                    console.warn('Failed to parse form permissions:', e);
                    formConfig.permissions = [];
                }
            }
            
            console.log('Form configuration to save:', formConfig);
            
            let orgVariableName, orgVariableUUID, orgVariableValue, targetOrgId;
            
            if (isFormExtend) {
                // FormExtendBuilder: use extend type name and client org ID
                const extendTypeDropdown = document.getElementById('form_extend_type_dropdown');
                const clientDropdown = document.getElementById('select_client_dropdown');
                
                if (!extendTypeDropdown || !extendTypeDropdown.value) {
                    throw new Error('Please select an Extend Type');
                }
                
                if (!clientDropdown || !clientDropdown.value) {
                    throw new Error('Please select a Client');
                }
                
                orgVariableName = extendTypeDropdown.value;
                targetOrgId = clientDropdown.value;
                orgVariableUUID = loadedFormId ? loadedFormId.uuid : null;
                orgVariableValue = JSON.stringify(formConfig);
                
                console.log('[SAVE HANDLER] FormExtend - Using name:', orgVariableName, 'for client org:', targetOrgId);
            } else {
                // FormBuilder: use form_# numbering under window.ORG_ID
                targetOrgId = window.ORG_ID;
                
                // Determine the next sequential form number
                let nextFormNumber = 1;
                
                if (!loadedFormId) {
                    // Only find next number when creating (not updating)
                    console.log('[SAVE HANDLER] Determining next form number...');
                    
                    let existingForms = [];
                    try {
                        existingForms = await fetchExistingFormsList();
                        console.log('[SAVE HANDLER] Existing forms:', existingForms);
                    } catch (fetchError) {
                        // If we can't fetch existing forms, abort the save
                        console.error('[SAVE HANDLER] Failed to fetch existing forms:', fetchError.message);
                        
                        savingSpinner.style.display = 'none';
                        savingMessage.textContent = 'Error: Could not fetch existing forms.\n\n' + fetchError.message;
                        savingMessage.style.color = '#dc3545';
                        savingOkButton.style.display = 'block';
                        saveConfirmYes.disabled = false;
                        
                        throw fetchError;
                    }
                    
                    // Extract form numbers from form_X names
                    const formNumbers = existingForms.map(form => {
                        const match = form.form_id.match(/form_(\d+)/);
                        return match ? parseInt(match[1]) : 0;
                    }).filter(n => !isNaN(n));
                    
                    if (formNumbers.length > 0) {
                        nextFormNumber = Math.max(...formNumbers) + 1;
                    }
                    
                    console.log('[SAVE HANDLER] Next form number:', nextFormNumber);
                }
                
                orgVariableName = loadedFormId ? loadedFormId.name : `form_${nextFormNumber}`;
                orgVariableUUID = loadedFormId ? loadedFormId.uuid : null;
                orgVariableValue = JSON.stringify(formConfig);
                
                console.log('[SAVE HANDLER] FormBuilder - Using name:', orgVariableName);
            }
            
            console.log('[SAVE HANDLER] Org Variable Name:', orgVariableName);
            console.log('[SAVE HANDLER] Org Variable UUID:', orgVariableUUID);
            console.log('[SAVE HANDLER] Target Org ID:', targetOrgId);
            console.log('[SAVE HANDLER] Org Variable Value length:', orgVariableValue.length);
            
            // Execute the org variable save
            if (loadedFormId) {
                // Update existing variable
                console.log('[SAVE HANDLER] Updating existing org variable');
                
                // For FormExtend updates, switch to client org context
                if (isFormExtend) {
                    const originalOrgId = window.ORG_ID;
                    window.ORG_ID = targetOrgId;
                    
                    try {
                        await RewstLib.orgVariables.update(orgVariableUUID, orgVariableName, orgVariableValue);
                    } finally {
                        window.ORG_ID = originalOrgId;
                    }
                } else {
                    await RewstLib.orgVariables.update(orgVariableUUID, orgVariableName, orgVariableValue);
                }
            } else {
                // Create new variable
                console.log('[SAVE HANDLER] Creating new org variable under org:', targetOrgId);
                
                // For FormExtend, we need to create the variable under the client's org ID
                if (isFormExtend) {
                    // Temporarily switch org context to save under client org
                    const originalOrgId = window.ORG_ID;
                    window.ORG_ID = targetOrgId;
                    
                    try {
                        await RewstLib.orgVariables.create(orgVariableName, orgVariableValue);
                    } finally {
                        // Restore original org ID
                        window.ORG_ID = originalOrgId;
                    }
                } else {
                    // FormBuilder uses standard creation
                    await RewstLib.orgVariables.create(orgVariableName, orgVariableValue);
                }
            }
            
            // Update saving status to success
            savingSpinner.style.display = 'none';
            savingMessage.textContent = loadedFormId ? 'Successfully Updated' : 'Successfully Saved';
            savingMessage.style.color = '#ffffff';
            
            // Auto-close after 1 second and reload page
            setTimeout(() => {
                savingStatusModal.classList.remove('active');
                savingMessage.style.color = '#ffffff';
                saveConfirmYes.disabled = false;
                
                // Reload the page to refresh the dropdown
                location.reload();
            }, 1000);
            
        } catch (error) {
            console.error('Error saving form configuration:', error);
            
            // Store the error for detail viewing
            window.lastSaveError = error;
            
            // Try to extract sql_result from error message
            let displayMessage = 'Failed to Save';
            let showDetailsButton = true;
            
            try {
                // First, try to get from window.lastSaveResult
                if (window.lastSaveResult && window.lastSaveResult.conductor && window.lastSaveResult.conductor.output && window.lastSaveResult.conductor.output.result) {
                    const result = window.lastSaveResult.conductor.output.result;
                    console.log('Found result in lastSaveResult:', result);
                    
                    if (result && result.trim()) {
                        displayMessage = result;
                        showDetailsButton = false;
                    }
                }
                
                // If not found, try to parse from error.message
                if (showDetailsButton && error.message) {
                    console.log('Parsing error.message for sql_result');
                    const errorMsg = error.message;
                    
                    // Look for JSON array in the error message (after the dash)
                    const dashIndex = errorMsg.indexOf(' - [');
                    if (dashIndex !== -1) {
                        const jsonStr = errorMsg.substring(dashIndex + 3); // Skip ' - '
                        console.log('Extracted JSON string:', jsonStr);
                        
                        try {
                            // Parse the JSON array
                            const errorArray = JSON.parse(jsonStr);
                            console.log('Parsed error array:', errorArray);
                            
                            // Look for result.sql_result in the first error object
                            if (errorArray.length > 0 && errorArray[0].result && errorArray[0].result.sql_result) {
                                let sqlResult = errorArray[0].result.sql_result;
                                console.log('Found sql_result:', sqlResult);
                                
                                // Remove brackets if present
                                if (sqlResult.startsWith('[') && sqlResult.endsWith(']')) {
                                    sqlResult = sqlResult.substring(1, sqlResult.length - 1);
                                }
                                
                                if (sqlResult && sqlResult.trim()) {
                                    displayMessage = sqlResult;
                                    showDetailsButton = false;
                                }
                            }
                        } catch (parseError) {
                            console.error('Error parsing JSON from error message:', parseError);
                        }
                    }
                }
            } catch (parseError) {
                console.error('Error extracting result:', parseError);
                // Fall back to default message
            }
            
            // Update saving status to failed
            savingSpinner.style.display = 'none';
            
            if (showDetailsButton) {
                savingMessage.innerHTML = displayMessage + '<br><span style="font-size: 12px; font-weight: normal; margin-top: 8px; display: block;">Click "Show Details" for more information</span>';
            } else {
                // Show "Failed to Save" header with the error message below
                savingMessage.innerHTML = '<div style="color: #ffffff; font-size: 18px; font-weight: 600; margin-bottom: 12px;">Failed to Save</div><div style="color: #ffffff; font-size: 14px; font-weight: normal; line-height: 1.5;">' + displayMessage + '</div>';
            }
            
            savingMessage.style.color = '#dc3545';
            savingOkButton.style.display = 'flex';
            savingOkButton.style.gap = '10px';
            savingOkButton.style.justifyContent = 'center';
            
            // Update OK button to include Show Details button if needed
            if (showDetailsButton) {
                savingOkButton.innerHTML = `
                    <button id="showErrorDetailsBtn" style="padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">Show Details</button>
                    <button id="savingStatusOkNew" class="btn btn-grey" class="px-30">OK</button>
                `;
            } else {
                savingOkButton.innerHTML = `
                    <button id="savingStatusOkNew" class="btn btn-blue" class="px-30">OK</button>
                `;
            }
            
            // Show error details button handler (only if button exists)
            setTimeout(() => {
                const showErrorDetailsBtn = document.getElementById('showErrorDetailsBtn');
                if (showErrorDetailsBtn) {
                    showErrorDetailsBtn.onclick = () => {
                        // Close the status modal
                        savingStatusModal.classList.remove('active');
                        savingMessage.style.color = '#ffffff';
                        savingMessage.innerHTML = '';
                        saveConfirmYes.disabled = false;
                        
                        // Show the workflow response modal with error details
                        const workflowResponseModal = document.getElementById('workflowResponseModal');
                        const workflowResponseContent = document.getElementById('workflowResponseContent');
                        const workflowResponseCloseBtn = document.getElementById('workflowResponseCloseBtn');
                        const workflowResponseOk = document.getElementById('workflowResponseOk');
                        
                        // Format the error as JSON
                        const errorDetails = {
                            error: error.message,
                            stack: error.stack,
                            timestamp: new Date().toISOString()
                        };
                        workflowResponseContent.textContent = JSON.stringify(errorDetails, null, 2);
                        
                        // Show the modal
                        workflowResponseModal.classList.add('active');
                        
                        // Close handlers
                        const closeResponseModal = () => {
                            workflowResponseModal.classList.remove('active');
                        };
                        
                        workflowResponseCloseBtn.onclick = closeResponseModal;
                        workflowResponseOk.onclick = closeResponseModal;
                        workflowResponseModal.onclick = (e) => {
                            if (e.target === workflowResponseModal) {
                                closeResponseModal();
                            }
                        };
                    };
                }
                
                document.getElementById('savingStatusOkNew').onclick = () => {
                    savingStatusModal.classList.remove('active');
                    savingMessage.style.color = '#ffffff';
                    savingMessage.innerHTML = '';
                    saveConfirmYes.disabled = false;
                };
            }, 0);
        }
    });
}

// Validation error modal handlers
if (validationModalCloseBtn) {
    validationModalCloseBtn.addEventListener('click', () => {
        validationErrorModal.classList.remove('active');
    });
}

if (validationErrorOk) {
    validationErrorOk.addEventListener('click', () => {
        validationErrorModal.classList.remove('active');
    });
}

// Close modals when clicking outside
saveConfirmModal.addEventListener('click', (e) => {
    if (e.target === saveConfirmModal) {
        saveConfirmModal.classList.remove('active');
    }
});

validationErrorModal.addEventListener('click', (e) => {
    if (e.target === validationErrorModal) {
        validationErrorModal.classList.remove('active');
    }
});

// ============================================
// RESET FUNCTIONALITY
// ============================================
const resetFormBtn = document.getElementById('resetFormBtn');

if (resetFormBtn) {
    resetFormBtn.addEventListener('click', () => {
        console.log('Reset button clicked');
        
        // Reset Select Client dropdown (FormExtendBuilder-specific)
        const clientDropdown = document.getElementById('select_client_dropdown');
        if (clientDropdown) {
            clientDropdown.value = '';
        }
        
        // Reset Form Extend Type dropdown (FormExtendBuilder-specific)
        const extendTypeDropdown = document.getElementById('form_extend_type_dropdown');
        if (extendTypeDropdown) {
            extendTypeDropdown.value = '';
        }
        
        // Clear form extend title (FormExtendBuilder-specific)
        const extendTitleInput = document.getElementById('extend_title');
        if (extendTitleInput) {
            extendTitleInput.value = '';
        }
        
        // Clear form name
        if (formNameInput) {
            formNameInput.value = '';
        }
        
        // Reset show name checkbox to default (checked)
        if (hiddenShowName) {
            hiddenShowName.checked = true;
        }
        
        // Reset columns to 1
        if (hiddenFormColumns) {
            hiddenFormColumns.value = '1';
            updateColumnDisplay();
        }
        
        // Reset submit workflow to empty
        if (hiddenSubmitWorkflow) {
            hiddenSubmitWorkflow.value = '';
        }
        
        // Reset general settings to defaults
        // Reset show name checkbox to default (checked)
        if (hiddenShowName) {
            hiddenShowName.checked = true;
        }
        
        // Reset submit type to workflow (default)
        const submitTypeRadios = document.querySelectorAll('input[name="submit_type"]');
        submitTypeRadios.forEach(radio => {
            if (radio.value === 'workflow') {
                radio.checked = true;
            }
        });
        
        // Reset hidden submit type field
        if (hiddenSubmitType) {
            hiddenSubmitType.value = 'workflow';
        }
        
        // Reset output variable name
        const hiddenOutputVar = document.getElementById('hidden_output_var');
        if (hiddenOutputVar) {
            hiddenOutputVar.value = '';
        }
        
        // Reset form permissions to default (role-admin)
        const permissionsSelect = document.getElementById('permissionsSelect');
        if (permissionsSelect) {
            permissionsSelect.setAttribute('data-selected-values', JSON.stringify(['role-admin']));
        }
        
        // Reset GraphQL submit operation
        if (hiddenGraphQLSubmitOp) {
            hiddenGraphQLSubmitOp.value = '';
        }
        
        // Clear GraphQL inputs if modal is open
        const graphqlInputsContainer = document.getElementById('graphql_inputs_container');
        if (graphqlInputsContainer) {
            graphqlInputsContainer.innerHTML = '';
        }
        
        // Clear all field configs
        fieldConfigs.length = 0;
        
        // Clear all dropped elements from columns
        const leftFormColumn = document.getElementById('leftFormColumn');
        const rightFormColumn = document.getElementById('rightFormColumn');
        const thirdFormColumn = document.getElementById('thirdFormColumn');
        
        if (leftFormColumn) leftFormColumn.innerHTML = '';
        if (rightFormColumn) rightFormColumn.innerHTML = '';
        if (thirdFormColumn) thirdFormColumn.innerHTML = '';
        
        // Reset element counters
        ELEMENT_TYPES.forEach(type => {
            droppedElementCount[type] = 0;
        });
        
        // Close settings panel if open
        if (selectedElementUid) {
            closeElementSettings();
        }
        
        // Clear the loaded form ID (back to create mode)
        loadedFormId = null;
        
        // Update displays
        updateFieldConfigsDisplay();
        updateSaveButtonState();
        
        console.log('Form reset - ready to create new form');
    });
}

// ============================================
// PREVIEW FUNCTIONALITY
// ============================================
const previewBtn = document.getElementById('previewBtn');
const previewModal = document.getElementById('previewModal');
const previewModalCloseBtn = document.getElementById('previewModalCloseBtn');
const previewContent = document.getElementById('previewContent');

// Function to generate preview HTML
function generatePreview(orientation = 'landscape') {
    // Generate preview HTML based on current form configuration
    const formName = formNameInput ? formNameInput.value : '';
    
    const showName = showNameCheckbox ? showNameCheckbox.checked : true;
    
    const columnCount = columnsSelect ? parseInt(columnsSelect.value) : 1;
    
    const showVertSepCheckbox = document.getElementById('show_vert_sep');
    const showVertSep = showVertSepCheckbox ? showVertSepCheckbox.checked : false;
    
    console.log('generatePreview - showVertSepCheckbox:', showVertSepCheckbox);
    console.log('generatePreview - showVertSep:', showVertSep);
    console.log('generatePreview - columnCount:', columnCount);
    
    // Build preview HTML
    let previewHTML = '<div class="form-container">';
    
    // Add form name if enabled
    if (showName && formName) {
        previewHTML += '<h2 style="color: #ffffff; margin-top: 0; margin-bottom: 30px; text-align: center;">' + formName + '</h2>';
    }
    
    // Group fields by column
    const columnFields = {};
    columnFields[0] = []; // Top spanning fields
    columnFields[99] = []; // Bottom spanning fields
    for (let i = 1; i <= columnCount; i++) {
        columnFields[i] = [];
    }
    
    fieldConfigs.forEach(config => {
        const col = config.column !== undefined ? config.column : 1;
        if (columnFields[col] !== undefined) {
            columnFields[col].push(config);
        } else {
            // If column doesn't exist in our mapping, default to column 1
            columnFields[1].push(config);
        }
    });
    
    // Sort spanning fields by sequence
    const sortedTopSpanningFields = columnFields[0].sort((a, b) => {
        const seqA = a.sequence || 0;
        const seqB = b.sequence || 0;
        return seqA - seqB;
    });
    
    const sortedBottomSpanningFields = columnFields[99].sort((a, b) => {
        const seqA = a.sequence || 0;
        const seqB = b.sequence || 0;
        return seqA - seqB;
    });
    
    // Build columns HTML based on orientation
    if (orientation === 'portrait') {
        // Portrait mode: single column with all fields in order
        previewHTML += '<div class="form-columns" style="display: flex; flex-direction: column; gap: 30px; align-items: flex-start;">';
        
        // Render top spanning fields first (full width)
        sortedTopSpanningFields.forEach(config => {
            if (config.hidden) return;
            previewHTML += '<div style="width: 100%;">' + renderFieldHTML(config, fieldConfigs) + '</div>';
        });
        
        // Then render regular columns in a single column
        previewHTML += '<div class="form-column" style="flex: 1; width: 100%;">';
        
        // Render all fields from column 1, then 2, then 3
        for (let i = 1; i <= columnCount; i++) {
            // Sort fields by sequence before rendering
            const sortedFields = columnFields[i].sort((a, b) => {
                const seqA = a.sequence || 0;
                const seqB = b.sequence || 0;
                return seqA - seqB;
            });
            
            sortedFields.forEach(config => {
                if (config.hidden) return; // Skip hidden fields in preview
                
                previewHTML += renderFieldHTML(config, fieldConfigs);
            });
        }
        
        previewHTML += '</div>'; // Close form-column
        
        // Render bottom spanning fields last (full width)
        sortedBottomSpanningFields.forEach(config => {
            if (config.hidden) return;
            previewHTML += '<div style="width: 100%;">' + renderFieldHTML(config, fieldConfigs) + '</div>';
        });
        
        previewHTML += '</div>'; // Close wrapper
    } else {
        // Landscape mode: maintain column layout
        previewHTML += '<div style="display: flex; flex-direction: column; gap: 20px;">';
        
        // Render top spanning fields first (full width)
        sortedTopSpanningFields.forEach(config => {
            if (config.hidden) return;
            previewHTML += '<div style="width: 100%;">' + renderFieldHTML(config, fieldConfigs) + '</div>';
        });
        
        // Then render columnar layout
        previewHTML += '<div class="form-columns" style="display: flex; gap: 30px; align-items: flex-start;">';
        
        for (let i = 1; i <= columnCount; i++) {
            // Add vertical separator before column (except for first column)
            if (i > 1 && showVertSep) {
                console.log('Adding separator at column', i, 'showVertSep:', showVertSep);
                previewHTML += '<div style="width: 1px; background: #ffffff; flex-shrink: 0; margin: 0 10px; align-self: stretch; min-height: 100px;"></div>';
            }
            
            previewHTML += '<div class="form-column" style="flex: 1;">';
            
            // Sort fields by sequence before rendering
            const sortedFields = columnFields[i].sort((a, b) => {
                const seqA = a.sequence || 0;
                const seqB = b.sequence || 0;
                return seqA - seqB;
            });
            
            sortedFields.forEach(config => {
                if (config.hidden) return; // Skip hidden fields in preview
                
                previewHTML += renderFieldHTML(config, fieldConfigs);
            });
            
            previewHTML += '</div>';
        }
        
        previewHTML += '</div>'; // Close form-columns
        
        // Render bottom spanning fields last (full width)
        sortedBottomSpanningFields.forEach(config => {
            if (config.hidden) return;
            previewHTML += '<div style="width: 100%;">' + renderFieldHTML(config, fieldConfigs) + '</div>';
        });
        
        previewHTML += '</div>'; // Close wrapper div
    }
    
    // Add submit and reset buttons
    previewHTML += '<div style="display: flex; gap: 10px; margin-top: 30px; justify-content: center;">';
    previewHTML += '<button disabled style="width: 150px; padding: 14px; background: #6c757d; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: not-allowed; opacity: 0.6;">Reset</button>';
    previewHTML += '<button disabled style="width: 150px; padding: 14px; background: #667eea; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: not-allowed; opacity: 0.6;">Submit</button>';
    previewHTML += '</div>';
    
    // Close form-container
    previewHTML += '</div>';
    
    // Display the preview
    previewContent.innerHTML = previewHTML;
    
    // Set preview container width based on orientation and column count
    const previewContainer = document.getElementById('previewContainer');
    if (previewContainer) {
        let containerWidth = '35%';
        
        if (orientation === 'portrait') {
            // Portrait mode: always use single column width
            containerWidth = '35%';
        } else {
            // Landscape mode: width based on column count
            if (columnCount === 2) {
                containerWidth = '70%';
            } else if (columnCount === 3) {
                containerWidth = '90%';
            }
        }
        
        previewContainer.style.width = containerWidth;
        previewContainer.style.maxWidth = containerWidth;
    }
}

// Helper function to escape HTML
// Helper function to determine where to insert element during drag
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('[draggable="true"]:not(.dragging)')];
    
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Function to update sequences based on DOM order within each column
function updateElementSequences() {
    console.log('Updating element sequences based on DOM order...');
    
    const topSpanningZone = document.getElementById('topSpanningZone');
    const bottomSpanningZone = document.getElementById('bottomSpanningZone');
    const leftFormColumn = document.getElementById('leftFormColumn');
    const rightFormColumn = document.getElementById('rightFormColumn');
    const thirdFormColumn = document.getElementById('thirdFormColumn');
    
    const columns = [
        { element: topSpanningZone, number: 0 }, // Top spanning zone
        { element: leftFormColumn, number: 1 },
        { element: rightFormColumn, number: 2 },
        { element: thirdFormColumn, number: 3 },
        { element: bottomSpanningZone, number: 99 } // Bottom spanning zone
    ];
    
    columns.forEach(col => {
        if (!col.element) return;
        
        // Get all child elements with data-uid
        const elements = Array.from(col.element.children).filter(el => el.dataset.uid);
        
        elements.forEach((element, index) => {
            const uid = element.dataset.uid;
            const fieldConfig = fieldConfigs.find(f => f.uid === uid);
            
            if (fieldConfig) {
                const newSequence = index + 1;
                const newColumn = col.number;
                
                // Update both column and sequence based on current DOM position
                if (fieldConfig.sequence !== newSequence || fieldConfig.column !== newColumn) {
                    console.log(`Updating ${fieldConfig.field_name} from column ${fieldConfig.column} seq ${fieldConfig.sequence} to column ${newColumn} seq ${newSequence}`);
                    fieldConfig.column = newColumn;
                    fieldConfig.sequence = newSequence;
                }
            }
        });
    });
    
    updateFieldConfigsDisplay();
}


// Function to process HTML templates and replace field references
function processHTMLTemplate(htmlContent, allFieldConfigs) {
    if (!htmlContent) return '';
    
    // Replace [[field_name]] with field display names or values
    // This allows HTML elements to reference other form fields
    // Using [[ ]] instead of {{ }} to avoid conflicts with Jinja templating
    let processedHTML = htmlContent;
    
    // Find all [[field_name]] patterns
    const fieldReferencePattern = /\[\[([a-zA-Z0-9_]+)\]\]/g;
    const matches = htmlContent.matchAll(fieldReferencePattern);
    
    for (const match of matches) {
        const fieldName = match[1];
        const fieldConfig = allFieldConfigs.find(f => f.field_name === fieldName);
        
        if (fieldConfig) {
            // Replace with the field's display name for preview
            // In actual form, this would be replaced with the field's value
            const replacement = `<span style="color: #667eea; font-weight: 600;">[${fieldConfig.field_displayname}]</span>`;
            processedHTML = processedHTML.replace(match[0], replacement);
        } else {
            // Field not found, leave the placeholder visible
            const replacement = `<span style="color: #dc3545; font-weight: 600;">[${fieldName} - Not Found]</span>`;
            processedHTML = processedHTML.replace(match[0], replacement);
        }
    }
    
    return processedHTML;
}

// Function to render individual field HTML
function renderFieldHTML(config, allFieldConfigs) {
    // HTML type and horizontal_line type render content directly without any wrapper
    if (config.type === 'html' || config.type === 'horizontal_line') {
        // Process the HTML content to replace field references
        return processHTMLTemplate(config.content || '', allFieldConfigs);
    }
    
    let html = `<div class="form-group">`;
    
    if (config.type === 'checkbox') {
        html += `
            <div class="checkbox-wrapper">
                <input type="checkbox" ${config.default_checked ? 'checked' : ''} disabled>
                <div>
                    <label>${config.field_displayname}</label>
                    ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
                </div>
            </div>
        `;
    } else if (config.type === 'text') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <input type="text" value="${config.default_value || ''}" disabled>
        `;
    } else if (config.type === 'textarea') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <textarea disabled>${config.default_value || ''}</textarea>
        `;
    } else if (config.type === 'date') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <input type="date" value="${config.default_value || ''}" disabled>
        `;
    } else if (config.type === 'date_time') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <input type="datetime-local" value="${config.default_value || ''}" disabled>
        `;
    } else if (config.type === 'radio') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <div class="radio-group">
        `;
        
        if (config.options && typeof config.options === 'object') {
            Object.entries(config.options).forEach(([key, value]) => {
                const isChecked = config.default_select === key ? 'checked' : '';
                html += `
                    <div class="radio-item">
                        <input type="radio" ${isChecked} disabled>
                        <label>${key}</label>
                    </div>
                `;
            });
        }
        
        html += `</div>`;
    } else if (config.type === 'dropdown_static') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <select disabled>
                <option value="">Select a Value</option>
        `;
        
        if (config.options && typeof config.options === 'object') {
            Object.entries(config.options).forEach(([key, value]) => {
                const isSelected = config.default_value === value ? 'selected' : '';
                html += `<option value="${value}" ${isSelected}>${value}</option>`;
            });
        }
        
        html += `</select>`;
    } else if (config.type === 'dropdown') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <select disabled>
                <option value="">-- Select a ${config.field_displayname.toLowerCase()} --</option>
            </select>
        `;
    } else if (config.type === 'dropdown_graphql') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <select disabled>
                <option value="">-- Select a ${config.field_displayname.toLowerCase()} (GraphQL) --</option>
            </select>
        `;
    } else if (config.type === 'dropdown_mysql') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <select disabled>
                <option value="">-- Select a ${config.field_displayname.toLowerCase()} (MySQL) --</option>
            </select>
        `;
    } else if (config.type === 'dropdown_mesh') {
        html += `
            <label>${config.field_displayname}</label>
            ${config.description ? `<div class="field-description">${RewstLib.utils.escapeHtml(config.description)}</div>` : ''}
            <select disabled>
                <option value="">-- Select a ${config.field_displayname.toLowerCase()} (MeshCentral) --</option>
            </select>
        `;
    }
    
    html += `</div>`;
    return html;
}

if (previewBtn) {
    previewBtn.addEventListener('click', async () => {
        // Check if there are unsaved changes in element settings (only if panel is open)
        const settingsPanel = document.getElementById('settingsPanel');
        if (selectedElementUid && settingsPanel && settingsPanel.style.display === 'block' && hasUnsavedFormChanges()) {
            console.log('Unsaved element changes detected before preview');
            const fieldDisplayName = originalElementSettings ? originalElementSettings.field_displayname : 'Unknown';
            const confirmed = await confirmUnsavedChanges(fieldDisplayName);
            if (!confirmed) {
                console.log('User cancelled preview due to unsaved element changes');
                return; // Don't show preview
            }
            console.log('User confirmed to discard element changes and show preview');
            // Close element settings without saving
            await closeElementSettings(true);
        }
        
        // Reset orientation to landscape when opening
        const landscapeRadio = document.querySelector('input[name="previewOrientation"][value="landscape"]');
        if (landscapeRadio) {
            landscapeRadio.checked = true;
        }
        
        generatePreview('landscape');
        previewModal.classList.add('active');
    });
}

// Add event listeners for orientation radio buttons
if (previewModal) {
    const orientationRadios = previewModal.querySelectorAll('input[name="previewOrientation"]');
    orientationRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            generatePreview(e.target.value);
        });
    });
}

if (previewModalCloseBtn) {
    previewModalCloseBtn.addEventListener('click', () => {
        previewModal.classList.remove('active');
    });
}

// Close preview modal on outside click
if (previewModal) {
    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) {
            previewModal.classList.remove('active');
        }
    });
}

// ============================================
// INITIALIZE WORKFLOWS
// ============================================
async function initializeWorkflows() {
    try {
        if (!RewstLib) {
            console.error('RewstLib not loaded, cannot fetch workflows');
            return;
        }
        
        console.log('Fetching all workflows and option generators from RewstLib...');
        const allWorkflows = await RewstLib.workflows.getAll();
        const ogWorkflows = await RewstLib.workflows.getAllOG();
        
        if (!allWorkflows || allWorkflows.length === 0) {
            console.warn('No workflows found');
            return;
        }
        
        console.log('All workflows fetched:', allWorkflows.length, 'workflows');
        console.log('Option generator workflows fetched:', ogWorkflows.length, 'workflows');
        availableWorkflows = allWorkflows;
        availableWorkflowsOG = ogWorkflows;
        
        // Populate both the modal dropdown and the hidden select with ALL workflows
        const submitWorkflowModal = document.getElementById('form_submit_workflow_modal');
        const submitWorkflowHidden = document.getElementById('form_submit_workflow');
        
        allWorkflows.forEach(workflow => {
            // Add to modal dropdown
            if (submitWorkflowModal) {
                const option = document.createElement('option');
                option.value = workflow.id;
                option.textContent = workflow.name;
                submitWorkflowModal.appendChild(option);
            }
            
            // Add to hidden select
            if (submitWorkflowHidden) {
                const option = document.createElement('option');
                option.value = workflow.id;
                option.textContent = workflow.name;
                submitWorkflowHidden.appendChild(option);
            }
        });
        
        console.log('Workflows populated in dropdowns');
    } catch (error) {
        console.error('Error initializing workflows:', error);
    }
}

// ============================================
// FORM EXTEND BUILDER SPECIFIC FUNCTIONS
// ============================================

/**
 * Reset the form builder UI to initial state
 * Clears title, fields, columns, and counters
 */
function resetForm() {
    console.log('Resetting form...');
    
    // Reset Select Client dropdown (FormExtendBuilder-specific)
    const clientDropdown = document.getElementById('select_client_dropdown');
    if (clientDropdown) {
        clientDropdown.value = '';
    }
    
    // Reset Form Extend Type dropdown (FormExtendBuilder-specific)
    const extendTypeDropdown = document.getElementById('form_extend_type_dropdown');
    if (extendTypeDropdown) {
        extendTypeDropdown.value = '';
    }
    
    // Clear form extend title (FormExtendBuilder-specific)
    const extendTitleInput = document.getElementById('extend_title');
    if (extendTitleInput) {
        extendTitleInput.value = '';
    }
    
    // Clear form name (FormBuilder-specific)
    const formNameInput = document.getElementById('form_name');
    if (formNameInput) {
        formNameInput.value = '';
    }
    
    // Reset show name checkbox to default (checked)
    const showNameCheckbox = document.getElementById('show_name_modal');
    if (showNameCheckbox) {
        showNameCheckbox.checked = true;
    }
    
    // Reset show vertical separator
    const showVertSepCheckbox = document.getElementById('show_vert_sep');
    if (showVertSepCheckbox) {
        showVertSepCheckbox.checked = false;
    }
    
    // Reset columns to default (1)
    const formColumnsRadio = document.querySelector('input[name="formColumns"][value="1"]');
    if (formColumnsRadio) {
        formColumnsRadio.checked = true;
    }
    const hiddenFormColumns = document.getElementById('hiddenFormColumns');
    if (hiddenFormColumns) {
        hiddenFormColumns.value = '1';
        updateColumnDisplay();
    }
    
    // Clear all field configs
    fieldConfigs.length = 0;
    
    // Clear all dropped elements from columns
    const leftFormColumn = document.getElementById('leftFormColumn');
    const rightFormColumn = document.getElementById('rightFormColumn');
    const thirdFormColumn = document.getElementById('thirdFormColumn');
    
    if (leftFormColumn) leftFormColumn.innerHTML = '';
    if (rightFormColumn) rightFormColumn.innerHTML = '';
    if (thirdFormColumn) thirdFormColumn.innerHTML = '';
    
    // Reset element counters
    ELEMENT_TYPES.forEach(type => {
        droppedElementCount[type] = 0;
    });
    
    // Close settings panel if open
    if (selectedElementUid) {
        closeElementSettings();
    }
    
    // Clear the loaded form ID (back to create mode)
    loadedFormId = null;
    
    // Update displays
    updateFieldConfigsDisplay();
    updateSaveButtonState();
    
    console.log('Form reset - ready to create new form');
}

/**
 * Initialize the client/organization selection dropdown
 * Populates from RewstLib.organizations.getSubOrganizations()
 */
async function initializeSelectClient() {
    try {
        const dropdown = document.getElementById('select_client_dropdown');
        if (!dropdown) {
            console.warn('[INIT] select_client_dropdown element not found');
            return;
        }
        
        const loading = document.getElementById('select_client_loading');
        if (loading) loading.style.display = 'flex';
        
        if (!RewstLib) {
            console.error('[INIT] RewstLib not loaded');
            if (loading) loading.style.display = 'none';
            return;
        }
        
        console.log('[INIT] Fetching sub-organizations...');
        const clients = await RewstLib.organizations.getSubOrganizations(window.ORG_ID);
        
        if (loading) loading.style.display = 'none';
        
        if (!clients || clients.length === 0) {
            console.warn('[INIT] No clients found');
            dropdown.innerHTML = '<option value="">-- No clients available --</option>';
            return;
        }
        
        console.log('[INIT] Clients loaded:', clients.length);
        
        // Clear existing options and add new ones
        dropdown.innerHTML = '<option value="">-- Select a client --</option>';
        
        clients.forEach(client => {
            const option = document.createElement('option');
            option.value = client.id;
            option.textContent = client.name;
            dropdown.appendChild(option);
        });
        
        console.log('[INIT] Client dropdown populated with', clients.length, 'clients');
    } catch (error) {
        console.error('[INIT] Error initializing clients:', error);
        const loading = document.getElementById('select_client_loading');
        if (loading) loading.style.display = 'none';
    }
}

/**
 * Initialize the form extend types dropdown
 * Populates from RewstLib GraphQL operations
 */
function initializeFormExtendTypes() {
    try {
        const dropdown = document.getElementById('form_extend_type_dropdown');
        if (!dropdown) {
            console.warn('[INIT] form_extend_type_dropdown element not found');
            return;
        }
        
        if (!RewstLib) {
            console.error('[INIT] RewstLib not loaded');
            return;
        }
        
        console.log('[INIT] Fetching GraphQL operations...');
        const allOperations = RewstLib.graphqlOperations.getAll();
        
        // Convert object to array and filter for form_extend type
        const formExtendOps = Object.entries(allOperations)
            .filter(([key, op]) => op.type === 'form_extend')
            .map(([key, op]) => ({ key, ...op }));
        
        if (!formExtendOps || formExtendOps.length === 0) {
            console.warn('[INIT] No form_extend operations found');
            dropdown.innerHTML = '<option value="">-- No form extend types available --</option>';
            return;
        }
        
        console.log('[INIT] Form extend types loaded:', formExtendOps.length);
        
        // Clear existing options and add new ones
        dropdown.innerHTML = '<option value="">-- Select a form extend type --</option>';
        
        formExtendOps.forEach(op => {
            const option = document.createElement('option');
            option.value = op.key;
            option.textContent = op.name || op.key;
            option.dataset.description = op.description || '';
            dropdown.appendChild(option);
        });
        
        console.log('[INIT] Form extend type dropdown populated with', formExtendOps.length, 'types');
    } catch (error) {
        console.error('[INIT] Error initializing form extend types:', error);
    }
}

/**
 * Convert snake_case or camelCase to Title Case
 * @param {string} str - String to convert
 * @returns {string} Title case string
 */
function formatElementTypeName(str) {
    if (!str) return '';
    // Convert snake_case to spaces
    let formatted = str.replace(/_/g, ' ');
    // Convert camelCase to spaces
    formatted = formatted.replace(/([a-z])([A-Z])/g, '$1 $2');
    // Capitalize each word
    return formatted.replace(/\b\w/g, char => char.toUpperCase());
}

/**
 * Initialize the element palette dynamically from PALETTE_DISPLAY
 * Creates draggable element cards from palette configuration
 * Consolidates dropdown variants into a single "Dropdown" entry
 * Sorted alphabetically by display name
 */
function initializeElementPalette() {
    try {
        const container = document.getElementById('elementPaletteContainer');
        if (!container) {
            console.warn('[INIT] elementPaletteContainer not found');
            return;
        }
        
        // Set gap spacing between draggables
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '5px';
        
        // Clear existing elements
        container.innerHTML = '';
        
        // Create draggable element for each type in PALETTE_DISPLAY, sorted alphabetically
        const paletteEntries = Object.entries(PALETTE_DISPLAY)
            .sort((a, b) => a[1].localeCompare(b[1]));  // Sort by display name (a[1], b[1])
        
        console.log('[INIT] Creating palette with', paletteEntries.length, 'elements');
        
        paletteEntries.forEach(([type, displayName]) => {
            const element = document.createElement('div');
            element.className = 'draggable-element';
            element.setAttribute('draggable', 'true');
            element.setAttribute('data-type', type);
            element.textContent = displayName;
            
            container.appendChild(element);
        });
        
        console.log('[INIT] Element palette populated with', paletteEntries.length, 'elements (sorted alphabetically)');
    } catch (error) {
        console.error('[INIT] Error initializing element palette:', error);
    }
}

/**
 * Auto-load form configuration when both client and extend type selections are made
 * Fetches from org variable and loads form configuration
 */
async function checkAndAutoLoad() {
    const clientDropdown = document.getElementById('select_client_dropdown');
    const extendTypeDropdown = document.getElementById('form_extend_type_dropdown');
    
    const clientId = clientDropdown?.value;
    const extendType = extendTypeDropdown?.value;
    
    if (clientId && extendType) {
        console.log('[AUTO-LOAD] Both selections made:', { clientId, extendType });
        
        try {
            // Check if there are unsaved changes in element settings (only if panel is open)
            if (selectedElementUid && settingsPanel && settingsPanel.style.display === 'block' && hasUnsavedFormChanges()) {
                console.log('[AUTO-LOAD] Unsaved element changes detected before loading form');
                const fieldDisplayName = originalElementSettings ? originalElementSettings.field_displayname : 'Unknown';
                const confirmed = await confirmUnsavedChanges(fieldDisplayName);
                if (!confirmed) {
                    console.log('[AUTO-LOAD] User cancelled loading form due to unsaved element changes');
                    return; // Don't load form
                }
                console.log('[AUTO-LOAD] User confirmed to discard element changes and load form');
                // Close element settings without saving
                await closeElementSettings(true);
            }
            
            // Fetch the form config from org variable
            const orgVar = await RewstLib.orgVariables.get(extendType, clientId);
            
            if (!orgVar || !orgVar.value) {
                console.log('[AUTO-LOAD] No form config found for this selection');
                return;
            }
            
            console.log('[AUTO-LOAD] Form config found:', orgVar.name);
            
            // Parse form_config (it might be a JSON string)
            let formConfig;
            if (typeof orgVar.value === 'string') {
                try {
                    formConfig = JSON.parse(orgVar.value);
                    console.log('[AUTO-LOAD] Parsed form config from JSON string');
                } catch (e) {
                    console.error('[AUTO-LOAD] Error parsing form config:', e);
                    return;
                }
            } else {
                formConfig = orgVar.value;
                console.log('[AUTO-LOAD] Using form config object directly');
            }
            
            console.log('[AUTO-LOAD] Final parsed config:', formConfig);
            
            // Store org variable info globally (similar to loadedFormId in Load button)
            loadedFormId = {
                uuid: orgVar.id,
                name: extendType
            };
            console.log('[AUTO-LOAD] Stored org variable info:', loadedFormId);
            
            // Load the form configuration
            console.log('[AUTO-LOAD] Calling loadFormConfiguration...');
            loadFormConfiguration(formConfig);
            
        } catch (error) {
            console.error('[AUTO-LOAD] Error fetching form config:', error);
        }
    }
}

// ============================================
// ARRAY ITEMS MODAL
// ============================================

let currentArrayFieldConfig = null;

/**
 * Initialize Array Items Modal HTML if it doesn't exist
 */
function initializeArrayItemsModal() {
    if (!document.getElementById('arrayItemsModalBackdrop')) {
        const modalHtml = `
        <div id="arrayItemsModalBackdrop" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.7); z-index: 9998; display: none;"></div>
        <div id="arrayItemsModal" style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #234656; border: 2px solid #404040; border-radius: 8px; padding: 2rem; z-index: 9999; min-width: 1000px; max-height: 80vh; overflow-y: auto; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3); display: none; flex-direction: column; gap: 1.5rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; color: #ffffff; font-size: 1.25rem;">Array Items</h3>
                <button onclick="closeArrayItemsModal()" style="background: none; border: none; color: #ffffff; font-size: 1.5rem; cursor: pointer; padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">×</button>
            </div>
            
            <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 8px;">
                <div style="flex: 1;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr 0.8fr 1fr; gap: 8px;">
                        <div style="color: #999; font-size: 12px; font-weight: 600;">Name</div>
                        <div style="color: #999; font-size: 12px; font-weight: 600;">Display Name</div>
                        <div style="color: #999; font-size: 12px; font-weight: 600;">Type</div>
                        <div style="color: #999; font-size: 12px; font-weight: 600;">Value</div>
                    </div>
                </div>
                <div>
                    <button id="addArrayItemModalBtn" class="btn btn-blue btn-small" title="Add Item" style="min-width: auto;">+</button>
                </div>
            </div>
            
            <div id="arrayItemsModalList" style="display: flex; flex-direction: column; gap: 12px; max-height: 400px; overflow-y: auto;"></div>
            
            <div style="display: flex; gap: 0.75rem; justify-content: flex-end;">
                <button onclick="closeArrayItemsModal()" class="btn btn-bluegrey btn-small">Cancel</button>
                <button onclick="saveArrayItems()" class="btn btn-green btn-small">Confirm</button>
            </div>
        </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        console.log('[ARRAY-MODAL] Initialized Array Items Modal HTML');
    }
}

/**
 * Open Array Items Modal and populate with current items
 * @param {object} fieldConfig - The field configuration object containing items
 */
function openArrayItemsModal(fieldConfig) {
    currentArrayFieldConfig = fieldConfig;
    
    initializeArrayItemsModal();
    
    const modal = document.getElementById('arrayItemsModal');
    const backdrop = document.getElementById('arrayItemsModalBackdrop');
    const arrayItemsModalList = document.getElementById('arrayItemsModalList');
    const addArrayItemModalBtn = document.getElementById('addArrayItemModalBtn');
    
    if (!modal || !backdrop || !arrayItemsModalList) {
        console.error('[ARRAY-MODAL] Modal elements not found');
        return;
    }
    
    // Clear existing items
    arrayItemsModalList.innerHTML = '';
    
    // Normalize items: convert old format (object) to new format (array) if needed
    let items = [];
    if (fieldConfig.items) {
        if (Array.isArray(fieldConfig.items)) {
            // Already in new format
            items = fieldConfig.items;
        } else if (typeof fieldConfig.items === 'object') {
            // Convert old format {label: value} to new format
            items = Object.entries(fieldConfig.items).map(([key, value]) => ({
                name: key,
                display_name: key,
                type: 'text',
                value: value
            }));
            console.log('[ARRAY-MODAL] Converted old format to new format:', items);
        }
    }
    
    // Populate with existing items
    items.forEach((item, index) => {
        renderArrayItemRow(arrayItemsModalList, item, index);
    });
    
    // Add button listener
    addArrayItemModalBtn.onclick = (e) => {
        e.preventDefault();
        const newItem = {
            name: '',
            display_name: '',
            type: 'text',
            value: ''
        };
        renderArrayItemRow(arrayItemsModalList, newItem, arrayItemsModalList.children.length);
    };
    
    // Show modal
    modal.style.display = 'flex';
    backdrop.style.display = 'block';
    console.log('[ARRAY-MODAL] Opened Array Items Modal');
}

/**
 * Render a single array item row with type-specific fields
 * @param {HTMLElement} container - Container to append row to
 * @param {object} item - Item object with name, display_name, type, etc.
 * @param {number} index - Index of item
 */
function renderArrayItemRow(container, item, index) {
    const rowContainer = document.createElement('div');
    rowContainer.className = 'array-item-row-container';
    rowContainer.dataset.index = index;
    rowContainer.style.cssText = 'background: #1a3540; padding: 12px; border-radius: 4px; border: 1px solid #404040;';
    
    // Main row with name, display_name, type, value field
    const mainRow = document.createElement('div');
    mainRow.style.cssText = 'display: grid; grid-template-columns: auto auto 1fr 1fr 0.8fr 1fr auto; gap: 8px; align-items: center; margin-bottom: 12px;';
    mainRow.innerHTML = `
        <button class="array-item-move-up-btn" title="Move Up" style="min-width: auto; padding: 6px 8px; background: #5a9fb8; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px; font-weight: 600;">↑</button>
        <button class="array-item-move-down-btn" title="Move Down" style="min-width: auto; padding: 6px 8px; background: #5a9fb8; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px; font-weight: 600;">↓</button>
        <input type="text" class="array-item-name" value="${RewstLib.utils.escapeHtml(item.name || '')}" placeholder="Field Name" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
        <input type="text" class="array-item-display-name" value="${RewstLib.utils.escapeHtml(item.display_name || '')}" placeholder="Display Name" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
        <select class="array-item-type" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
            <option value="text" ${item.type === 'text' ? 'selected' : ''}>Text</option>
            <option value="dropdown_static" ${item.type === 'dropdown_static' ? 'selected' : ''}>Static Dropdown</option>
            <option value="dropdown_graphql" ${item.type === 'dropdown_graphql' ? 'selected' : ''}>GraphQL Dropdown</option>
            <option value="dropdown_workflow" ${item.type === 'dropdown_workflow' ? 'selected' : ''}>Workflow Dropdown</option>
        </select>
        <div id="arrayItemValueField_${index}" style="width: 100%;"></div>
        <button class="delete-array-item-modal-btn" title="Delete Item" style="min-width: auto; padding: 6px 10px; background: #b8242f; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 14px; font-weight: 600;">×</button>
    `;
    rowContainer.appendChild(mainRow);
    
    // Render the value field based on type
    const valueFieldContainer = mainRow.querySelector(`#arrayItemValueField_${index}`);
    renderArrayItemValueField(valueFieldContainer, item);
    
    // Type-specific config section (below main row)
    const configSection = document.createElement('div');
    configSection.className = 'array-item-config';
    configSection.style.cssText = 'padding-top: 12px; border-top: 1px solid #404040;';
    renderArrayItemConfig(configSection, item);
    rowContainer.appendChild(configSection);
    
    container.appendChild(rowContainer);
    
    // Attach event listeners
    const typeSelect = mainRow.querySelector('.array-item-type');
    typeSelect.addEventListener('change', (e) => {
        item.type = e.target.value;
        valueFieldContainer.innerHTML = '';
        renderArrayItemValueField(valueFieldContainer, item);
        configSection.innerHTML = '';
        renderArrayItemConfig(configSection, item);
        console.log('[ARRAY-MODAL] Changed item type to:', e.target.value);
    });
    
    const upBtn = mainRow.querySelector('.array-item-move-up-btn');
    const downBtn = mainRow.querySelector('.array-item-move-down-btn');
    
    upBtn.addEventListener('click', (e) => {
        e.preventDefault();
        moveArrayItem(rowContainer, 'up');
    });
    
    downBtn.addEventListener('click', (e) => {
        e.preventDefault();
        moveArrayItem(rowContainer, 'down');
    });
    
    attachDeleteArrayItemModalListener(mainRow.querySelector('.delete-array-item-modal-btn'), rowContainer);
    
    // Update button states
    updateArrayItemButtonStates();
}

/**
 * Render the value field for the main row based on item type
 * @param {HTMLElement} container - Container to render field into
 * @param {object} item - Item object with configuration
 */
function renderArrayItemValueField(container, item) {
    if (item.type === 'text') {
        container.innerHTML = `
            <input type="text" class="array-item-text-value" value="${RewstLib.utils.escapeHtml(item.value || '')}" placeholder="Default Value" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px; width: 100%;">
        `;
        
        const valueInput = container.querySelector('.array-item-text-value');
        valueInput.addEventListener('input', (e) => {
            item.value = e.target.value;
        });
    } else if (item.type === 'dropdown_graphql') {
        // Build dropdown of available GraphQL operations filtered by type === 'form_field'
        let opOptions = '<option value="">-- Select Operation --</option>';
        if (RewstLib && RewstLib.graphqlOperations) {
            const allOperations = RewstLib.graphqlOperations.getAll();
            Object.entries(allOperations).forEach(([operationKey, operation]) => {
                if (operation.type === 'form_field') {
                    const selected = item.graphql_op === operationKey ? 'selected' : '';
                    opOptions += `<option value="${operationKey}" ${selected}>${operation.name}</option>`;
                }
            });
        }
        
        container.innerHTML = `
            <select class="array-item-graphql-op" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px; width: 100%;">
                ${opOptions}
            </select>
        `;
        
        const opSelect = container.querySelector('.array-item-graphql-op');
        opSelect.addEventListener('change', (e) => {
            item.graphql_op = e.target.value;
        });
    } else if (item.type === 'dropdown_static') {
        // Static dropdown - show option count or placeholder
        const optCount = item.options ? Object.keys(item.options).length : 0;
        container.innerHTML = `
            <div style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #999; font-size: 12px; display: flex; align-items: center;">
                ${optCount} options
            </div>
        `;
    } else if (item.type === 'dropdown_workflow') {
        // Workflow dropdown - show workflow selector
        let workflowOptions = '<option value="">-- Select Workflow --</option>';
        if (typeof availableWorkflowsOG !== 'undefined' && availableWorkflowsOG.length > 0) {
            availableWorkflowsOG.forEach(workflow => {
                const selected = item.workflow_id === workflow.id ? 'selected' : '';
                workflowOptions += `<option value="${workflow.id}" ${selected}>${workflow.name}</option>`;
            });
        }
        
        container.innerHTML = `
            <select class="array-item-workflow-id" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px; width: 100%;">
                ${workflowOptions}
            </select>
        `;
        
        const workflowSelect = container.querySelector('.array-item-workflow-id');
        workflowSelect.addEventListener('change', (e) => {
            item.workflow_id = e.target.value;
        });
    }
}

/**
 * Render type-specific configuration fields for array item
 * @param {HTMLElement} container - Container to render config fields into
 * @param {object} item - Item object with configuration
 */
function renderArrayItemConfig(container, item) {
    if (item.type === 'text') {
        // No additional config for text - everything is on main row
        container.style.display = 'none';
    } else if (item.type === 'dropdown_graphql') {
        // Secondary config: Label Field, Value Field, Multi-Select
        container.style.display = 'block'; // Reset display
        container.innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="color: #ccc; font-size: 12px; font-weight: 600;">Label Field</label>
                    <input type="text" class="array-item-label-name" value="${RewstLib.utils.escapeHtml(item.label_name || 'name')}" placeholder="e.g., name" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="color: #ccc; font-size: 12px; font-weight: 600;">Value Field</label>
                    <input type="text" class="array-item-value-name" value="${RewstLib.utils.escapeHtml(item.value_name || 'id')}" placeholder="e.g., id" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
                <input type="checkbox" class="array-item-multi-select" ${item.multi_select ? 'checked' : ''} style="accent-color: #5a9fb8;">
                <label style="color: #ccc; font-size: 12px; font-weight: 600; margin: 0; cursor: pointer;">Multi-Select</label>
            </div>
        `;
        
        const labelInput = container.querySelector('.array-item-label-name');
        const valueInput = container.querySelector('.array-item-value-name');
        const multiSelect = container.querySelector('.array-item-multi-select');
        
        labelInput.addEventListener('input', (e) => { item.label_name = e.target.value; });
        valueInput.addEventListener('input', (e) => { item.value_name = e.target.value; });
        multiSelect.addEventListener('change', (e) => { item.multi_select = e.target.checked; });
    } else if (item.type === 'dropdown_static') {
        // Static dropdown config: add label:value pairs
        container.style.display = 'block'; // Reset display
        const options = item.options || {};
        
        let optionsHtml = `
            <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;">
                <label style="color: #ccc; font-size: 12px; font-weight: 600;">Options</label>
                <div id="staticOptionsContainer" style="display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto;">
        `;
        
        Object.entries(options).forEach(([key, value]) => {
            optionsHtml += `
                <div style="display: flex; gap: 6px; align-items: center;">
                    <input type="text" class="static-option-label" value="${RewstLib.utils.escapeHtml(key)}" placeholder="Label" style="flex: 1; padding: 4px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                    <input type="text" class="static-option-value" value="${RewstLib.utils.escapeHtml(value)}" placeholder="Value" style="flex: 1; padding: 4px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                    <button class="delete-static-option" style="padding: 4px 8px; background: #b8242f; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px;">×</button>
                </div>
            `;
        });
        
        optionsHtml += `
                </div>
                <button id="addStaticOption" class="btn btn-blue btn-small" style="align-self: flex-start;">+ Add Option</button>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" class="array-item-multi-select" ${item.multi_select ? 'checked' : ''} style="accent-color: #5a9fb8;">
                <label style="color: #ccc; font-size: 12px; font-weight: 600; margin: 0; cursor: pointer;">Multi-Select</label>
            </div>
        `;
        
        container.innerHTML = optionsHtml;
        
        // Attach option handlers
        container.querySelectorAll('.delete-static-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                btn.closest('div').remove();
                updateStaticOptions(container, item);
            });
        });
        
        container.querySelector('#addStaticOption').addEventListener('click', (e) => {
            e.preventDefault();
            const optionsContainer = container.querySelector('#staticOptionsContainer');
            const optionRow = document.createElement('div');
            optionRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';
            optionRow.innerHTML = `
                <input type="text" class="static-option-label" placeholder="Label" style="flex: 1; padding: 4px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                <input type="text" class="static-option-value" placeholder="Value" style="flex: 1; padding: 4px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                <button class="delete-static-option" style="padding: 4px 8px; background: #b8242f; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px;">×</button>
            `;
            optionsContainer.appendChild(optionRow);
            
            optionRow.querySelector('.delete-static-option').addEventListener('click', (e) => {
                e.preventDefault();
                optionRow.remove();
                updateStaticOptions(container, item);
            });
            
            optionRow.querySelector('.static-option-label').addEventListener('input', () => updateStaticOptions(container, item));
            optionRow.querySelector('.static-option-value').addEventListener('input', () => updateStaticOptions(container, item));
        });
        
        // Input listeners for existing options
        container.querySelectorAll('.static-option-label, .static-option-value').forEach(input => {
            input.addEventListener('input', () => updateStaticOptions(container, item));
        });
        
        // Multi-select listener
        container.querySelector('.array-item-multi-select').addEventListener('change', (e) => {
            item.multi_select = e.target.checked;
        });
    } else if (item.type === 'dropdown_workflow') {
        // Workflow dropdown config: Label Name, Value Name, Default Selector, Workflow Input
        container.style.display = 'block'; // Reset display
        
        let configHtml = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="color: #ccc; font-size: 12px; font-weight: 600;">Label Field</label>
                    <input type="text" class="array-item-label-name" value="${RewstLib.utils.escapeHtml(item.label_name || '')}" placeholder="e.g., name" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="color: #ccc; font-size: 12px; font-weight: 600;">Value Field</label>
                    <input type="text" class="array-item-value-name" value="${RewstLib.utils.escapeHtml(item.value_name || '')}" placeholder="e.g., id" style="padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                </div>
            </div>
            <div style="margin-bottom: 12px;">
                <label style="color: #ccc; font-size: 12px; font-weight: 600; display: block; margin-bottom: 6px;">Default Selector Name</label>
                <input type="text" class="array-item-default-selector" value="${RewstLib.utils.escapeHtml(item.default_selector || 'default')}" placeholder="default" style="width: 100%; padding: 6px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
            </div>
            <div style="margin-bottom: 12px;">
                <label style="color: #ffffff; font-weight: 600; font-size: 12px; margin: 0 0 8px 0; display: block;">Workflow Input</label>
                <div class="workflow-input-list" style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px;">
        `;
        
        // Add existing workflow inputs
        if (item.workflow_input && typeof item.workflow_input === 'object') {
            Object.entries(item.workflow_input).forEach(([key, value]) => {
                configHtml += `
                    <div class="workflow-input-row" style="display: flex; gap: 6px; align-items: center;">
                        <input type="text" class="workflow-input-key" value="${RewstLib.utils.escapeHtml(key)}" placeholder="Key" style="flex: 1; padding: 4px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                        <input type="text" class="workflow-input-value" value="${RewstLib.utils.escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value)}" placeholder="Value" style="flex: 1; padding: 4px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                        <button class="delete-workflow-input" style="padding: 4px 8px; background: #b8242f; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px;">⊘</button>
                    </div>
                `;
            });
        }
        
        configHtml += `
                </div>
                <button id="addWorkflowInput" class="btn btn-blue btn-small" style="align-self: flex-start;">+ Add Input</button>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" class="array-item-multi-select" ${item.multi_select ? 'checked' : ''} style="accent-color: #5a9fb8;">
                <label style="color: #ccc; font-size: 12px; font-weight: 600; margin: 0; cursor: pointer;">Multi-Select</label>
            </div>
        `;
        
        container.innerHTML = configHtml;
        
        // Attach event listeners
        const labelInput = container.querySelector('.array-item-label-name');
        const valueInput = container.querySelector('.array-item-value-name');
        const defaultSelectorInput = container.querySelector('.array-item-default-selector');
        const multiSelect = container.querySelector('.array-item-multi-select');
        
        labelInput.addEventListener('input', (e) => { item.label_name = e.target.value; });
        valueInput.addEventListener('input', (e) => { item.value_name = e.target.value; });
        defaultSelectorInput.addEventListener('input', (e) => { item.default_selector = e.target.value; });
        multiSelect.addEventListener('change', (e) => { item.multi_select = e.target.checked; });
        
        // Delete workflow input listeners
        container.querySelectorAll('.delete-workflow-input').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                btn.closest('.workflow-input-row').remove();
                updateArrayWorkflowInput(container, item);
            });
        });
        
        // Add workflow input listener
        container.querySelector('#addWorkflowInput').addEventListener('click', (e) => {
            e.preventDefault();
            const inputList = container.querySelector('.workflow-input-list');
            const newRow = document.createElement('div');
            newRow.className = 'workflow-input-row';
            newRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';
            newRow.innerHTML = `
                <input type="text" class="workflow-input-key" placeholder="Key" style="flex: 1; padding: 4px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                <input type="text" class="workflow-input-value" placeholder="Value" style="flex: 1; padding: 4px; background: #234656; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 12px;">
                <button class="delete-workflow-input" style="padding: 4px 8px; background: #b8242f; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px;">⊘</button>
            `;
            inputList.appendChild(newRow);
            
            newRow.querySelector('.delete-workflow-input').addEventListener('click', (e) => {
                e.preventDefault();
                newRow.remove();
                updateArrayWorkflowInput(container, item);
            });
            
            newRow.querySelector('.workflow-input-key').addEventListener('input', () => updateArrayWorkflowInput(container, item));
            newRow.querySelector('.workflow-input-value').addEventListener('input', () => updateArrayWorkflowInput(container, item));
        });
        
        // Listeners for existing inputs
        container.querySelectorAll('.workflow-input-key, .workflow-input-value').forEach(input => {
            input.addEventListener('input', () => updateArrayWorkflowInput(container, item));
        });
    }
}

/**
 * Update workflow input in array item from DOM
 * @param {HTMLElement} container - Config container
 * @param {object} item - Item object to update
 */
function updateArrayWorkflowInput(container, item) {
    const workflowInput = {};
    container.querySelectorAll('.workflow-input-row').forEach(row => {
        const keyInput = row.querySelector('.workflow-input-key');
        const valueInput = row.querySelector('.workflow-input-value');
        if (keyInput && valueInput) {
            const key = keyInput.value.trim();
            const value = valueInput.value.trim();
            if (key) {
                workflowInput[key] = value;
            }
        }
    });
    item.workflow_input = Object.keys(workflowInput).length > 0 ? workflowInput : null;
}

/**
 * Update static dropdown options in item from DOM
 * @param {HTMLElement} container - Config container
 * @param {object} item - Item object to update
 */
function updateStaticOptions(container, item) {
    const options = {};
    container.querySelectorAll('[style*="display: flex; gap: 6px"]').forEach(row => {
        const labelInput = row.querySelector('.static-option-label');
        const valueInput = row.querySelector('.static-option-value');
        if (labelInput && valueInput) {
            const label = labelInput.value.trim();
            const value = valueInput.value.trim();
            if (label && value) {
                options[label] = value;
            }
        }
    });
    item.options = options;
}

/**
 * Close Array Items Modal
 */
function closeArrayItemsModal() {
    const modal = document.getElementById('arrayItemsModal');
    const backdrop = document.getElementById('arrayItemsModalBackdrop');
    if (modal) modal.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
    currentArrayFieldConfig = null;
    console.log('[ARRAY-MODAL] Closed Array Items Modal');
}

/**
 * Save Array Items from Modal and update fieldConfig
 */
function saveArrayItems() {
    if (!currentArrayFieldConfig) return;
    
    const arrayItemsModalList = document.getElementById('arrayItemsModalList');
    if (!arrayItemsModalList) return;
    
    const arrayItemRowContainers = arrayItemsModalList.querySelectorAll('.array-item-row-container');
    const items = [];
    
    arrayItemRowContainers.forEach(container => {
        const nameInput = container.querySelector('.array-item-name');
        const displayNameInput = container.querySelector('.array-item-display-name');
        const typeSelect = container.querySelector('.array-item-type');
        
        if (nameInput && displayNameInput && typeSelect) {
            const name = nameInput.value.trim();
            const display_name = displayNameInput.value.trim();
            const type = typeSelect.value;
            
            // Only save if name is provided
            if (!name) return;
            
            const itemData = { name, display_name, type };
            
            // Collect type-specific fields
            if (type === 'text') {
                const valueInput = container.querySelector('.array-item-text-value');
                if (valueInput) {
                    itemData.value = valueInput.value;
                }
            } else if (type === 'dropdown_graphql') {
                const opInput = container.querySelector('.array-item-graphql-op');
                const labelInput = container.querySelector('.array-item-label-name');
                const valueInput = container.querySelector('.array-item-value-name');
                const multiSelect = container.querySelector('.array-item-multi-select');
                
                itemData.graphql_op = opInput ? opInput.value : '';
                itemData.label_name = labelInput ? labelInput.value : 'name';
                itemData.value_name = valueInput ? valueInput.value : 'id';
                itemData.multi_select = multiSelect ? multiSelect.checked : false;
            } else if (type === 'dropdown_static') {
                const optionsContainer = container.querySelector('#staticOptionsContainer');
                const multiSelect = container.querySelector('.array-item-multi-select');
                
                const options = {};
                if (optionsContainer) {
                    optionsContainer.querySelectorAll('[style*="display: flex; gap: 6px"]').forEach(row => {
                        const labelInput = row.querySelector('.static-option-label');
                        const valueInput = row.querySelector('.static-option-value');
                        if (labelInput && valueInput) {
                            const label = labelInput.value.trim();
                            const value = valueInput.value.trim();
                            if (label && value) {
                                options[label] = value;
                            }
                        }
                    });
                }
                
                itemData.options = options;
                itemData.multi_select = multiSelect ? multiSelect.checked : false;
            } else if (type === 'dropdown_workflow') {
                const workflowInput = container.querySelector('.array-item-workflow-id');
                const labelInput = container.querySelector('.array-item-label-name');
                const valueInput = container.querySelector('.array-item-value-name');
                const defaultSelectorInput = container.querySelector('.array-item-default-selector');
                const multiSelect = container.querySelector('.array-item-multi-select');
                
                itemData.workflow_id = workflowInput ? workflowInput.value : '';
                itemData.label_name = labelInput ? labelInput.value : '';
                itemData.value_name = valueInput ? valueInput.value : '';
                itemData.default_selector = defaultSelectorInput ? defaultSelectorInput.value : 'default';
                itemData.multi_select = multiSelect ? multiSelect.checked : false;
                
                // Collect workflow inputs
                const workflowInputObj = {};
                container.querySelectorAll('.workflow-input-row').forEach(row => {
                    const keyInput = row.querySelector('.workflow-input-key');
                    const valueInput = row.querySelector('.workflow-input-value');
                    if (keyInput && valueInput) {
                        const key = keyInput.value.trim();
                        const value = valueInput.value.trim();
                        if (key) {
                            workflowInputObj[key] = value;
                        }
                    }
                });
                itemData.workflow_input = Object.keys(workflowInputObj).length > 0 ? workflowInputObj : null;
            }
            
            items.push(itemData);
        }
    });
    
    currentArrayFieldConfig.items = items;
    console.log('[ARRAY-MODAL] Saved array items:', items);
    
    // Mark form as modified
    if (typeof formHasBeenModified !== 'undefined') {
        formHasBeenModified = true;
        if (typeof updateElementSettingsSaveButtonVisibility === 'function') {
            updateElementSettingsSaveButtonVisibility();
        }
    }
    
    closeArrayItemsModal();
}

/**
 * Move an array item up or down
 * @param {HTMLElement} rowContainer - The row container to move
 * @param {string} direction - 'up' or 'down'
 */
function moveArrayItem(rowContainer, direction) {
    const arrayItemsModalList = document.getElementById('arrayItemsModalList');
    if (!arrayItemsModalList) return;
    
    const rows = Array.from(arrayItemsModalList.querySelectorAll('.array-item-row-container'));
    const currentIndex = rows.indexOf(rowContainer);
    
    if (direction === 'up' && currentIndex > 0) {
        // Move up: swap with previous
        arrayItemsModalList.insertBefore(rowContainer, rows[currentIndex - 1]);
        updateArrayItemButtonStates();
        console.log('[ARRAY-MODAL] Moved item up from index', currentIndex, 'to', currentIndex - 1);
    } else if (direction === 'down' && currentIndex < rows.length - 1) {
        // Move down: swap with next
        arrayItemsModalList.insertBefore(rows[currentIndex + 1], rowContainer);
        updateArrayItemButtonStates();
        console.log('[ARRAY-MODAL] Moved item down from index', currentIndex, 'to', currentIndex + 1);
    }
}

/**
 * Update disabled state of array item up/down buttons
 */
function updateArrayItemButtonStates() {
    const arrayItemsModalList = document.getElementById('arrayItemsModalList');
    if (!arrayItemsModalList) return;
    
    const rows = arrayItemsModalList.querySelectorAll('.array-item-row-container');
    rows.forEach((row, index) => {
        const upBtn = row.querySelector('.array-item-move-up-btn');
        const downBtn = row.querySelector('.array-item-move-down-btn');
        
        // Disable up button if at top
        if (upBtn) {
            upBtn.disabled = index === 0;
            upBtn.style.opacity = index === 0 ? '0.5' : '1';
            upBtn.style.cursor = index === 0 ? 'not-allowed' : 'pointer';
        }
        
        // Disable down button if at bottom
        if (downBtn) {
            downBtn.disabled = index === rows.length - 1;
            downBtn.style.opacity = index === rows.length - 1 ? '0.5' : '1';
            downBtn.style.cursor = index === rows.length - 1 ? 'not-allowed' : 'pointer';
        }
    });
}

/**
 * Attach delete listener to array item delete button in modal
 * @param {HTMLElement} btn - Delete button element
 * @param {HTMLElement} rowContainer - Row container element to remove
 */
function attachDeleteArrayItemModalListener(btn, rowContainer) {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (rowContainer) {
            rowContainer.remove();
        } else {
            // Fallback for older structure
            const row = btn.closest('.array-item-row-container') || btn.closest('.array-item-row');
            if (row) {
                row.remove();
            }
        }
        updateArrayItemButtonStates();
    });
}

// Global variable to track current field config being edited in dependent fields modal
let currentDependentFieldConfig = null;

/**
 * Initialize Dependent Fields Modal HTML (injected once into DOM)
 */
function initializeDependentFieldsModal() {
    if (!document.getElementById('dependentFieldsModalBackdrop')) {
        const modalHtml = `
        <div id="dependentFieldsModalBackdrop" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.7); z-index: 9998; display: none;"></div>
        <div id="dependentFieldsModal" style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #234656; border: 2px solid #404040; border-radius: 8px; padding: 2rem; z-index: 9999; min-width: 500px; max-height: 80vh; overflow-y: auto; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3); display: none; flex-direction: column; gap: 1.5rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; color: #ffffff; font-size: 1.25rem;">Dependent Fields</h3>
                <button onclick="closeDependentFieldsModal()" style="background: none; border: none; color: #ffffff; font-size: 1.5rem; cursor: pointer; padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">×</button>
            </div>
            
            <div id="dependentFieldsModalList" style="display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto;"></div>
            
            <div style="display: flex; gap: 0.75rem; justify-content: flex-end;">
                <button onclick="closeDependentFieldsModal()" class="btn btn-bluegrey btn-small">Cancel</button>
                <button onclick="saveDependentFields()" class="btn btn-green btn-small">Confirm</button>
            </div>
        </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        console.log('[DEPENDENT-FIELDS-MODAL] Initialized');
    }
}

/**
 * Open Dependent Fields Modal and populate with available fields
 * @param {object} fieldConfig - The field configuration object
 */
function openDependentFieldsModal(fieldConfig) {
    currentDependentFieldConfig = fieldConfig;
    
    initializeDependentFieldsModal();
    
    const modal = document.getElementById('dependentFieldsModal');
    const backdrop = document.getElementById('dependentFieldsModalBackdrop');
    const fieldsList = document.getElementById('dependentFieldsModalList');
    
    if (!modal || !backdrop || !fieldsList) {
        console.error('[DEPENDENT-FIELDS-MODAL] Modal elements not found');
        return;
    }
    
    // Clear existing fields list
    fieldsList.innerHTML = '';
    
    // Get current selections - handle both old string format and new object format
    let currentSelections = {};
    if (fieldConfig.dependant_fields) {
        if (typeof fieldConfig.dependant_fields === 'string') {
            // Old format: convert "field1,field2" to object with all properties set to true
            const fields = fieldConfig.dependant_fields.split(',').map(f => f.trim()).filter(f => f && f !== 'null');
            fields.forEach(f => {
                currentSelections[f] = { blocking: true, block_hidden: true, incl_hidden: true };
            });
        } else if (typeof fieldConfig.dependant_fields === 'object') {
            // New format: already an object
            currentSelections = { ...fieldConfig.dependant_fields };
            // Remove "null" key if it exists (defensive)
            if ('null' in currentSelections) {
                delete currentSelections['null'];
            }
        }
    }
    
    // Render all available fields (excluding current field)
    const otherFields = fieldConfigs.filter(config => config.field_name !== fieldConfig.field_name);
    
    if (otherFields.length === 0) {
        fieldsList.innerHTML = '<div style="padding: 20px; color: #999; text-align: center;">No other fields available</div>';
    } else {
        otherFields.forEach(field => {
            const isSelected = field.field_name in currentSelections;
            const isBlocking = currentSelections[field.field_name]?.blocking !== false;
            const blockHidden = currentSelections[field.field_name]?.block_hidden !== false; // Default to true
            const inclHidden = currentSelections[field.field_name]?.incl_hidden !== false; // Default to true
            
            const fieldRow = document.createElement('div');
            fieldRow.style.cssText = 'background: #1a3540; padding: 12px; border-radius: 4px; border: 1px solid #404040; display: flex; align-items: flex-start; gap: 16px;';
            
            // ===== COLUMN 1: Field selection (flex, takes remaining space)
            const col1 = document.createElement('div');
            col1.style.cssText = 'flex: 1; display: flex; flex-direction: column; gap: 4px;';
            
            const checkboxLabel = document.createElement('label');
            checkboxLabel.style.cssText = 'display: flex; align-items: center; gap: 8px; cursor: pointer; margin: 0;';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'dependent-field-checkbox';
            checkbox.setAttribute('data-field-name', field.field_name);
            checkbox.checked = isSelected;
            checkbox.style.cssText = 'accent-color: #5a9fb8; cursor: pointer;';
            
            const labelText = document.createElement('span');
            labelText.textContent = field.field_displayname;
            labelText.style.cssText = 'color: #ffffff; font-weight: 600;';
            
            checkboxLabel.appendChild(checkbox);
            checkboxLabel.appendChild(labelText);
            col1.appendChild(checkboxLabel);
            
            const fieldNameDiv = document.createElement('div');
            fieldNameDiv.textContent = field.field_name;
            fieldNameDiv.style.cssText = 'color: #999; font-size: 12px;';
            col1.appendChild(fieldNameDiv);
            
            // ===== COLUMN 2: Blocking and Incl. Hidden (stacked, shrink to fit)
            const col2 = document.createElement('div');
            col2.style.cssText = 'display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;';
            
            // Blocking checkbox
            const blockingCheckbox = document.createElement('input');
            blockingCheckbox.type = 'checkbox';
            blockingCheckbox.className = 'dependent-field-blocking';
            blockingCheckbox.setAttribute('data-field-name', field.field_name);
            blockingCheckbox.checked = isBlocking;
            blockingCheckbox.disabled = !isSelected;
            blockingCheckbox.style.cssText = 'accent-color: #5a9fb8; cursor: pointer;';
            
            const blockingLabel = document.createElement('label');
            blockingLabel.textContent = 'Blocking';
            blockingLabel.style.cssText = 'color: #ccc; font-size: 12px; font-weight: 600; margin: 0; cursor: pointer; display: inline;';
            
            const blockingContainer = document.createElement('div');
            blockingContainer.style.cssText = 'display: flex; align-items: center; gap: 6px;';
            blockingContainer.appendChild(blockingCheckbox);
            blockingContainer.appendChild(blockingLabel);
            
            // Include if Hidden checkbox
            const inclHiddenCheckbox = document.createElement('input');
            inclHiddenCheckbox.type = 'checkbox';
            inclHiddenCheckbox.className = 'dependent-field-incl-hidden';
            inclHiddenCheckbox.setAttribute('data-field-name', field.field_name);
            inclHiddenCheckbox.checked = inclHidden;
            inclHiddenCheckbox.disabled = !isSelected;
            inclHiddenCheckbox.style.cssText = 'accent-color: #5a9fb8; cursor: pointer;';
            
            const inclHiddenLabel = document.createElement('label');
            inclHiddenLabel.textContent = 'Incl. Hidden';
            inclHiddenLabel.style.cssText = 'color: #ccc; font-size: 12px; font-weight: 600; margin: 0; cursor: pointer; display: inline;';
            
            const inclHiddenContainer = document.createElement('div');
            inclHiddenContainer.style.cssText = 'display: flex; align-items: center; gap: 6px;';
            inclHiddenContainer.appendChild(inclHiddenCheckbox);
            inclHiddenContainer.appendChild(inclHiddenLabel);
            
            col2.appendChild(blockingContainer);
            col2.appendChild(inclHiddenContainer);
            
            // ===== COLUMN 3: Block if Hidden (shrink to fit)
            const col3 = document.createElement('div');
            col3.style.cssText = 'display: flex; align-items: center; gap: 6px; flex-shrink: 0;';
            
            const blockHiddenCheckbox = document.createElement('input');
            blockHiddenCheckbox.type = 'checkbox';
            blockHiddenCheckbox.className = 'dependent-field-block-hidden';
            blockHiddenCheckbox.setAttribute('data-field-name', field.field_name);
            blockHiddenCheckbox.checked = blockHidden;
            blockHiddenCheckbox.disabled = !isSelected;
            blockHiddenCheckbox.style.cssText = 'accent-color: #5a9fb8; cursor: pointer;';
            
            const blockHiddenLabel = document.createElement('label');
            blockHiddenLabel.textContent = 'Block if Hidden';
            blockHiddenLabel.style.cssText = 'color: #ccc; font-size: 12px; font-weight: 600; margin: 0; cursor: pointer;';
            
            col3.appendChild(blockHiddenCheckbox);
            col3.appendChild(blockHiddenLabel);
            
            // Assemble row
            fieldRow.appendChild(col1);
            fieldRow.appendChild(col2);
            fieldRow.appendChild(col3);
            fieldsList.appendChild(fieldRow);
            
            // Attach listeners
            checkbox.addEventListener('change', (e) => {
                blockingCheckbox.disabled = !e.target.checked;
                blockHiddenCheckbox.disabled = !e.target.checked;
                inclHiddenCheckbox.disabled = !e.target.checked;
                if (e.target.checked && !blockingCheckbox.checked) {
                    blockingCheckbox.checked = true;
                }
                if (e.target.checked && !blockHiddenCheckbox.checked) {
                    blockHiddenCheckbox.checked = true;
                }
                if (e.target.checked && !inclHiddenCheckbox.checked) {
                    inclHiddenCheckbox.checked = true;
                }
                console.log('[DEPENDENT-FIELDS-MODAL] Field', field.field_name, 'toggled to:', e.target.checked);
            });
        });
    }
    
    // Show modal
    modal.style.display = 'flex';
    backdrop.style.display = 'block';
    console.log('[DEPENDENT-FIELDS-MODAL] Opened');
}

/**
 * Close Dependent Fields Modal
 */
function closeDependentFieldsModal() {
    const modal = document.getElementById('dependentFieldsModal');
    const backdrop = document.getElementById('dependentFieldsModalBackdrop');
    if (modal) modal.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
    currentDependentFieldConfig = null;
    console.log('[DEPENDENT-FIELDS-MODAL] Closed');
}

/**
 * Save Dependent Fields selections and update fieldConfig
 */
function saveDependentFields() {
    if (!currentDependentFieldConfig) {
        console.error('[DEPENDENT-FIELDS-MODAL] No currentDependentFieldConfig');
        return;
    }
    
    const fieldsList = document.getElementById('dependentFieldsModalList');
    if (!fieldsList) {
        console.error('[DEPENDENT-FIELDS-MODAL] fieldsList not found');
        return;
    }
    
    console.log('[DEPENDENT-FIELDS-MODAL] Starting saveDependentFields...');
    console.log('[DEPENDENT-FIELDS-MODAL] currentDependentFieldConfig:', currentDependentFieldConfig);
    
    // Get all checkboxes (both checked and unchecked) for debugging
    const allCheckboxes = fieldsList.querySelectorAll('.dependent-field-checkbox');
    console.log('[DEPENDENT-FIELDS-MODAL] Total checkboxes found:', allCheckboxes.length);
    allCheckboxes.forEach((cb, idx) => {
        console.log(`  [${idx}] Checkbox:`, {
            checked: cb.checked,
            dataset: cb.dataset,
            datasetFieldName: cb.dataset.fieldName,
            getAttribute: cb.getAttribute('data-field-name'),
            value: cb.value,
            innerHTML: cb.innerHTML
        });
    });
    
    const dependentFieldsObj = {};
    const checkboxes = fieldsList.querySelectorAll('.dependent-field-checkbox:checked');
    
    console.log('[DEPENDENT-FIELDS-MODAL] Checked checkboxes found:', checkboxes.length);
    
    checkboxes.forEach((checkbox, idx) => {
        console.log(`\n[DEPENDENT-FIELDS-MODAL] Processing checkbox ${idx}:`, checkbox);
        
        // Try multiple ways to get the field name
        let fieldName = checkbox.dataset.fieldName;
        console.log(`  [${idx}] Initial dataset.fieldName:`, fieldName, typeof fieldName);
        
        if (!fieldName) {
            fieldName = checkbox.getAttribute('data-field-name');
            console.log(`  [${idx}] getAttribute('data-field-name'):`, fieldName, typeof fieldName);
        }
        
        // If still empty, try getting it from the parent or sibling
        if (!fieldName) {
            const parent = checkbox.closest('[data-field-name]');
            fieldName = parent ? parent.getAttribute('data-field-name') : null;
            console.log(`  [${idx}] From closest parent:`, fieldName, typeof fieldName);
        }
        
        console.log(`  [${idx}] Final fieldName after checks:`, fieldName, typeof fieldName);
        
        if (!fieldName || fieldName === '') {
            console.warn('[DEPENDENT-FIELDS-MODAL] Could not find field name for checkbox:', checkbox);
            console.warn('  Checkbox HTML:', checkbox.outerHTML);
            return;
        }
        
        const blockingCheckbox = fieldsList.querySelector(`.dependent-field-blocking[data-field-name="${fieldName}"]`);
        console.log(`  [${idx}] Found blocking checkbox for "${fieldName}":`, blockingCheckbox ? 'YES' : 'NO');
        
        const isBlocking = blockingCheckbox ? blockingCheckbox.checked : true;
        console.log(`  [${idx}] isBlocking:`, isBlocking);
        
        const blockHiddenCheckbox = fieldsList.querySelector(`.dependent-field-block-hidden[data-field-name="${fieldName}"]`);
        console.log(`  [${idx}] Found block_hidden checkbox for "${fieldName}":`, blockHiddenCheckbox ? 'YES' : 'NO');
        
        const blockHidden = blockHiddenCheckbox ? blockHiddenCheckbox.checked : true; // Default to true
        console.log(`  [${idx}] blockHidden:`, blockHidden);
        
        const inclHiddenCheckbox = fieldsList.querySelector(`.dependent-field-incl-hidden[data-field-name="${fieldName}"]`);
        console.log(`  [${idx}] Found incl_hidden checkbox for "${fieldName}":`, inclHiddenCheckbox ? 'YES' : 'NO');
        
        const inclHidden = inclHiddenCheckbox ? inclHiddenCheckbox.checked : true; // Default to true
        console.log(`  [${idx}] inclHidden:`, inclHidden);
        
        console.log(`[DEPENDENT-FIELDS-MODAL] Adding to object: "${fieldName}" = { blocking: ${isBlocking}, block_hidden: ${blockHidden}, incl_hidden: ${inclHidden} }`);
        dependentFieldsObj[fieldName] = { blocking: isBlocking, block_hidden: blockHidden, incl_hidden: inclHidden };
    });
    
    console.log('[DEPENDENT-FIELDS-MODAL] Final dependentFieldsObj:', dependentFieldsObj);
    console.log('[DEPENDENT-FIELDS-MODAL] Object keys:', Object.keys(dependentFieldsObj));
    
    // VERIFY all three properties are present for each field
    console.log('[DEPENDENT-FIELDS-MODAL] Verifying all properties are included:');
    Object.entries(dependentFieldsObj).forEach(([fieldName, props]) => {
        const hasBlocking = 'blocking' in props;
        const hasBlockHidden = 'block_hidden' in props;
        const hasInclHidden = 'incl_hidden' in props;
        console.log(`  Field "${fieldName}":`, {
            hasBlocking, 
            hasBlockHidden, 
            hasInclHidden,
            allPresent: hasBlocking && hasBlockHidden && hasInclHidden,
            values: props
        });
    });
    
    // Update fieldConfig
    currentDependentFieldConfig.dependant_fields = Object.keys(dependentFieldsObj).length > 0 ? dependentFieldsObj : null;
    
    console.log('[DEPENDENT-FIELDS-MODAL] Updated currentDependentFieldConfig.dependant_fields:', currentDependentFieldConfig.dependant_fields);
    
    // UPDATE HIDDEN INPUT with the new value
    const dependantFieldsInput = document.getElementById('dependant_fields');
    if (dependantFieldsInput) {
        const jsonValue = Object.keys(dependentFieldsObj).length > 0 ? JSON.stringify(dependentFieldsObj) : '';
        dependantFieldsInput.value = jsonValue;
        console.log('[DEPENDENT-FIELDS-MODAL] Updated hidden input value to:', jsonValue);
        
        // Log each field's properties for verification
        console.log('[DEPENDENT-FIELDS-MODAL] Saved fields detail:');
        Object.entries(dependentFieldsObj).forEach(([fieldName, props]) => {
            console.log(`  - ${fieldName}:`, props);
            console.log(`    blocking: ${props.blocking}, block_hidden: ${props.block_hidden}, incl_hidden: ${props.incl_hidden}`);
        });
    }
    
    // Update button text
    const editBtn = document.getElementById('editDependentFieldsBtn');
    if (editBtn) {
        const count = Object.keys(dependentFieldsObj).length;
        editBtn.textContent = count > 0 ? `${count} field(s) selected` : 'Select dependent fields...';
        console.log('[DEPENDENT-FIELDS-MODAL] Updated button text to:', editBtn.textContent);
    }
    
    // Mark form as modified
    if (typeof formHasBeenModified !== 'undefined') {
        formHasBeenModified = true;
        if (typeof updateElementSettingsSaveButtonVisibility === 'function') {
            updateElementSettingsSaveButtonVisibility();
        }
    }
    
    // Update main save button
    updateSaveButtonState();
    
    closeDependentFieldsModal();
}

// ============================================
// PAGE LOAD - FETCH FORMS AND INITIALIZE
// ============================================
console.log('Page loaded, starting initialization...');

// Initialize element palette
initializeElementPalette();

// Fetch workflows
initializeWorkflows().catch(error => {
    console.error('Error in initializeWorkflows:', error);
});

// Fetch existing forms
try {
    fetchExistingForms().then(() => {
        console.log('Background fetch of existing forms complete');
    }).catch(error => {
        console.error('Background fetch of existing forms failed:', error);
        // Continue anyway - the fetch will happen on first checkbox click
    });
} catch (error) {
    console.error('Error initiating background fetch:', error);
    // Continue anyway - the fetch will happen on first checkbox click
}