/**
 * Rewst Integration Library
 * Version: 2.1.0
 * 
 * Centralized library for Rewst workflow automation integration.
 * Provides GraphQL queries, workflow management, org variable operations,
 * form rendering, conditional visibility, and form validation.
 * 
 * Usage:
 *   const workflows = await RewstLib.workflows.getAll();
 *   const orgVar = await RewstLib.orgVariables.get('database_name');
 *   await RewstLib.workflows.execute(workflowId, payload);
 *   RewstLib.forms.evaluateConditionalVisibility(fieldConfigs);
 *   RewstLib.forms.validateForm(formData, fieldConfigs);
 */
const RewstLib = (function() {
  'use strict';
  // ========================================
  // CONFIGURATION
  // ========================================
  const config = {
    graphqlEndpoint: '/graphql',
    skip_cache: false  // Global flag to skip caching on all workflows
  };
  // ========================================
  // USER INITIALIZATION
  // ========================================
  // User is now passed in via HTML constant REWST_USER
  // (Jinja templates must be in inline HTML, not external scripts)
  const rewst_user = null;
  function getUser() {
    return rewst_user;
  }
  // ========================================
  // CACHE
  // ========================================
  let workflowsCache = null;
  // ========================================
  // CORE GRAPHQL FUNCTIONS
  // ========================================
  /**
   * Execute a GraphQL query
   * @param {string} query - GraphQL query string
   * @param {object} variables - Optional variables for the query
   * @returns {Promise<object>} Query result data
   */
  async function graphqlQuery(query, variables = {}) {
    try {
      const response = await fetch(config.graphqlEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables })
      });
      const data = await response.json();
      if (!response.ok) {
        console.error('GraphQL HTTP error:', response.status, data);
        throw new Error(`GraphQL HTTP ${response.status}: ${data.errors?.[0]?.message || 'Unknown error'}`);
      }
      if (data.errors) {
        console.error('GraphQL errors:', data.errors);
        throw new Error(`GraphQL Error: ${data.errors[0]?.message || 'Unknown error'}`);
      }
      return data.data;
    } catch (error) {
      console.error('GraphQL query failed:', error);
      throw error;
    }
  }
  // ========================================
  // WORKFLOW FUNCTIONS
  // ========================================
  /**
   * Get all workflows
   * @param {boolean} useCache - Whether to use cached results (default: true)
   * @returns {Promise<Array>} Array of workflow objects with id, name, and type
   */
  async function getAllWorkflows(useCache = true) {
    if (useCache && workflowsCache) {
      return workflowsCache;
    }
    const query = `
      query {
        workflows {
          id
          name
        }
      }
    `;
    const data = await graphqlQuery(query);
    const workflows = data.workflows || [];
    workflowsCache = workflows;
    return workflows;
  }
  /**
   * Get all option generator workflows
   * @param {boolean} useCache - Whether to use cached results (default: true)
   * @returns {Promise<Array>} Array of option generator workflow objects with id and name
   */
  async function getAllWorkflowsOG(useCache = true) {
    if (useCache && workflowsCache) {
      return workflowsCache;
    }
    const query = `
      query {
        workflows(isOptionsGenerator: true) {
          id
          name
        }
      }
    `;
    const data = await graphqlQuery(query);
    const workflows = data.workflows || [];
    workflowsCache = workflows;
    return workflows;
  }
  /**
   * Execute a workflow and wait for completion
   * @param {string} workflowId - Workflow ID
   * @param {object} inputData - Input variables for the workflow
   * @param {object} options - Optional: {onProgress: function, useCache: boolean}
   * @returns {Promise<object>} Execution result with conductor output
   */
  async function executeWorkflow(workflowId, inputData = {}, options = {}) {
    // Create cache key based on workflow ID and input parameters
    const cacheKey = `workflow_cache_${workflowId}_${JSON.stringify(inputData)}`;
    // Determine if caching should be used
    // Priority: options.useCache > options.skip_cache > config.skip_cache > default (true)
    let useCache = true;
    if (options.skip_cache === true) {
      useCache = false;
    } else if (options.useCache === false) {
      useCache = false;
    } else if (config.skip_cache === true) {
      useCache = false;
    }
    console.log('[EXECUTE] Cache enabled:', useCache, '(skip_cache config:', config.skip_cache, ', option:', options.skip_cache, ')');
    // Check cache if enabled
    if (useCache) {
      const cachedResult = sessionStorage.getItem(cacheKey);
      if (cachedResult) {
        console.log('[EXECUTE] Using cached result for workflow:', workflowId);
        return JSON.parse(cachedResult);
      }
    }
    const mutation = `
      mutation testWorkflow($id: ID!, $orgId: ID!, $input: JSON) {
        testResult: testWorkflow(id: $id, orgId: $orgId, input: $input) {
          executionId
        }
      }
    `;
    const variables = {
      id: workflowId,
      orgId: window.ORG_ID,
      input: inputData
    };
    console.log('[EXECUTE] Starting workflow execution:', {id: workflowId, orgId: window.ORG_ID});
    const result = await graphqlQuery(mutation, variables);
    // Check both result.testResult (from direct response) and result.data.testResult (wrapped response)
    const testResult = result.testResult || (result.data && result.data.testResult);
    if (!testResult || !testResult.executionId) {
      throw new Error('Failed to start workflow execution: ' + JSON.stringify(result));
    }
    const executionId = testResult.executionId;
    console.log('[EXECUTE] Workflow started with execution ID:', executionId);
    // Wait for completion
    const executionResult = await waitForWorkflowCompletion(executionId, options.onProgress);
    // Cache the result (if caching is enabled)
    if (useCache) {
      sessionStorage.setItem(cacheKey, JSON.stringify(executionResult));
    }
    return executionResult;
  }
  /**
   * Find workflow by name
   * @param {string} name - Workflow name to search for
   * @returns {Promise<object|null>} Workflow object or null if not found
   */
  async function findWorkflowByName(name) {
    const workflows = await getAllWorkflows();
    return workflows.find(w => w.name === name) || null;
  }
  /**
   * Find workflow by ID
   * @param {string} id - Workflow ID to search for
   * @returns {Promise<object|null>} Workflow object or null if not found
   */
  async function findWorkflowById(id) {
    const workflows = await getAllWorkflows();
    return workflows.find(w => w.id === id) || null;
  }
  // ========================================
  // ORGANIZATION FUNCTIONS
  // ========================================
  /**
   * Get all sub-organizations subordinate to a parent org
   * @param {string} parentOrgId - Parent organization ID
   * @returns {Promise<Array>} Array of sub-organization objects with id and name
   */
  async function getSubOrganizations(parentOrgId) {
    const query = `
      query GetSubOrganizations($parentOrgId: ID!) {
        organizations(
          where: { managingOrgId: $parentOrgId }
          order: [["name"]]
        ) {
          id
          name
        }
      }
    `;
    const data = await graphqlQuery(query, { parentOrgId });
    return data.organizations || [];
  }
  // ========================================
  // ORG VARIABLE FUNCTIONS
  // ========================================
  /**
   * Get all org variables matching a pattern
   * @param {string} pattern - Search pattern (e.g., "datatable_%")
   * @returns {Promise<Array>} Array of org variable objects
   */
  async function getOrgVariables(pattern = '%') {
    const query = `{
      visibleOrgVariables(
        visibleForOrgId: "${window.ORG_ID}"
        search: { 
          organization: { id: { _eq: "${window.ORG_ID}" } }
          name: { _ilike: "${pattern}" }
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
      }
    }`;
    const data = await graphqlQuery(query);
    return data.visibleOrgVariables || [];
  }
  /**
   * Get a specific org variable by name
   * @param {string} varName - Variable name to retrieve
   * @returns {Promise<string|null>} Variable value or null if not found
   */
  async function getOrgVariable(varName) {
    const variables = await getOrgVariables(varName);
    if (variables.length === 0) return null;
    const variable = variables[0];
    console.log('[REWSTLIB] getOrgVariable found:', variable.name, '- value present:', !!variable.value);
    return variable;
  }
  /**
   * Get all datatable configurations
   * @returns {Promise<Array>} Array of datatable config objects
   */
  async function getDatatableConfigs() {
    const variables = await getOrgVariables('datatable_%');
    return variables.map(v => {
      let configName = v.name;
      let configData = null;
      try {
        configData = JSON.parse(v.value);
        if (configData.name) {
          configName = configData.name;
        } else if (configData.datatable_name) {
          configName = configData.datatable_name;
        }
      } catch (e) {
        console.warn('Failed to parse datatable config:', v.name);
      }
      return {
        config_id: v.name.replace('datatable_', ''),
        config_name: configName,
        config_raw: v.value,
        config_parsed: configData,
        orgVarId: v.id,
        orgVarName: v.name
      };
    });
  }
  /**
   * Create a new org variable
   * @param {string} name - Variable name
   * @param {string} value - Variable value (can be JSON string)
   * @param {object} options - Optional: {category, cascade}
   * @returns {Promise<object>} Created org variable with id, name, value, etc.
   */
  async function createOrgVariable(name, value, options = {}) {
    const mutation = `
      mutation createOrgVariable($orgVariable: OrgVariableCreateInput!) {
        createOrgVariable(orgVariable: $orgVariable) {
          id
          name
          value
          category
          cascade
          orgId
          createdAt
          updatedAt
        }
      }
    `;
    const variables = {
      orgVariable: {
        name: name,
        value: value,
        orgId: window.ORG_ID,
        category: options.category || 'general',
        cascade: options.cascade !== undefined ? options.cascade : false
      }
    };
    console.log('[REWSTLIB] Creating org variable:', name);
    try {
      const data = await graphqlQuery(mutation, variables);
      if (data.createOrgVariable) {
        console.log('[REWSTLIB] Successfully created org variable:', data.createOrgVariable.id);
        return data.createOrgVariable;
      } else {
        throw new Error('Unexpected response: ' + JSON.stringify(data));
      }
    } catch (error) {
      console.error('[REWSTLIB] Failed to create org variable:', error.message);
      throw error;
    }
  }
  /**
   * Update an existing org variable
   * @param {string} id - Variable ID
   * @param {string} name - Variable name
   * @param {string} value - Variable value (can be JSON string)
   * @param {object} options - Optional: {category, cascade}
   * @returns {Promise<object>} Updated org variable
   */
  async function updateOrgVariable(id, name, value, options = {}) {
    const mutation = `
      mutation updateOrgVariables($orgVariables: [OrgVariableUpdateInput!]!) {
        updateOrgVariables(orgVariables: $orgVariables) {
          id
          name
          value
          category
          cascade
          orgId
          createdAt
          updatedAt
        }
      }
    `;
    const variables = {
      orgVariables: [
        {
          id: id,
          name: name,
          value: value,
          orgId: window.ORG_ID,
          category: options.category,
          cascade: options.cascade
        }
      ]
    };
    console.log('[REWSTLIB] Updating org variable:', name);
    try {
      const data = await graphqlQuery(mutation, variables);
      if (data.updateOrgVariables && data.updateOrgVariables.length > 0) {
        console.log('[REWSTLIB] Successfully updated org variable:', data.updateOrgVariables[0].id);
        return data.updateOrgVariables[0];
      } else {
        throw new Error('Unexpected response: ' + JSON.stringify(data));
      }
    } catch (error) {
      console.error('[REWSTLIB] Failed to update org variable:', error.message);
      throw error;
    }
  }
  // ========================================
  // FORM RENDERING & CONDITIONAL VISIBILITY
  // ========================================
  /**
   * Evaluate a condition string against form data
   * @param {string} conditionString - Condition expression (e.g., "field_name == 'value'")
   * @param {object} formData - Current form data with field values
   * @returns {boolean} Whether condition evaluates to true
   */
  function evaluateCondition(conditionString, formData) {
    if (!conditionString) return true;
    try {
      // Replace field references with their values from formData
      let expression = conditionString;
      // Sort keys by length (longest first) to avoid replacing substrings
      const sortedKeys = Object.keys(formData).sort((a, b) => b.length - a.length);
      sortedKeys.forEach(key => {
        const value = formData[key];
        // Handle string values with quotes, boolean/null without
        const replacement = typeof value === 'string' ? `'${value}'` : value;
        // Use word boundary to avoid partial replacements
        expression = expression.replace(new RegExp(`\\b${key}\\b`, 'g'), replacement);
      });
      console.log('[FORMS] Evaluating expression:', expression);
      // Evaluate the expression
      return eval(expression);
    } catch (e) {
      console.error('Error evaluating condition:', conditionString, e);
      return false;
    }
  }
  /**
   * Evaluate conditional visibility for all fields
   * @param {Array} allFieldConfigs - Array of all field configurations
   */
  function evaluateConditionalVisibility(allFieldConfigs) {
    // Collect current form values
    const formData = {};
    allFieldConfigs.forEach(config => {
      const input = document.querySelector(`input[name="${config.field_name}"], select[name="${config.field_name}"], textarea[name="${config.field_name}"]`);
      if (input) {
        if (input.type === 'checkbox') {
          formData[config.field_name] = input.checked;
        } else if (input.type === 'radio') {
          const checkedRadio = document.querySelector(`input[name="${config.field_name}"]:checked`);
          formData[config.field_name] = checkedRadio ? checkedRadio.value : null;
        } else {
          formData[config.field_name] = input.value;
        }
      }
    });
    // Evaluate conditions for each field
    allFieldConfigs.forEach(config => {
      const formGroup = document.querySelector(`[data-field-name="${config.field_name}"]`);
      if (!formGroup) return;
      let shouldShow = !config.hidden; // Start with opposite of hidden
      // Check condition_1 if it exists
      if (config.condition_1 && config.condition_1_action === 'show') {
        const conditionMet = evaluateCondition(config.condition_1, formData);
        shouldShow = conditionMet;
        console.log(`[FORMS] Field ${config.field_name}: condition_1 = "${config.condition_1}", result = ${conditionMet}, shouldShow = ${shouldShow}`);
      }
      // Check condition_2 if it exists
      if (config.condition_2 && config.condition_2_action === 'show') {
        const conditionMet = evaluateCondition(config.condition_2, formData);
        shouldShow = shouldShow && conditionMet;
      }
      // Apply visibility
      formGroup.style.display = shouldShow ? '' : 'none';
    });
  }
  /**
   * Validate form data against field configurations
   * @param {object} formData - Form data to validate
   * @param {Array} fieldConfigs - Field configurations with validation rules
   * @returns {object} Validation result {isValid: boolean, errors: {fieldName: [errors]}}
   */
  function validateForm(formData, fieldConfigs) {
    const errors = {};
    let isValid = true;
    fieldConfigs.forEach(config => {
      if (config.required) {
        const value = formData[config.field_name];
        // Check if field is hidden - don't require hidden fields
        const fieldElement = document.querySelector(`[data-field-name="${config.field_name}"]`);
        if (fieldElement && fieldElement.style.display === 'none') {
          return; // Skip validation for hidden fields
        }
        // Validate required fields
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
          if (!errors[config.field_name]) {
            errors[config.field_name] = [];
          }
          errors[config.field_name].push(`${config.field_displayname} is required`);
          isValid = false;
        }
      }
      // Additional field-type specific validation
      if (formData[config.field_name]) {
        const value = formData[config.field_name];
        if (config.type === 'email') {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(value)) {
            if (!errors[config.field_name]) {
              errors[config.field_name] = [];
            }
            errors[config.field_name].push(`${config.field_displayname} must be a valid email address`);
            isValid = false;
          }
        }
        if (config.min_length && value.length < config.min_length) {
          if (!errors[config.field_name]) {
            errors[config.field_name] = [];
          }
          errors[config.field_name].push(`${config.field_displayname} must be at least ${config.min_length} characters`);
          isValid = false;
        }
        if (config.max_length && value.length > config.max_length) {
          if (!errors[config.field_name]) {
            errors[config.field_name] = [];
          }
          errors[config.field_name].push(`${config.field_displayname} must not exceed ${config.max_length} characters`);
          isValid = false;
        }
      }
    });
    return {
      isValid,
      errors
    };
  }
  /**
   * Submit form and execute workflow
   * @param {string} workflowId - Workflow to execute on form submission
   * @param {object} formData - Form data to submit
   * @param {Array} fieldConfigs - Field configurations
   * @param {object} options - Optional: {onSuccess: function, onError: function}
   * @returns {Promise<object>} Workflow execution result
   */
  async function submitForm(workflowId, formData, fieldConfigs, options = {}) {
    try {
      // Validate form
      const validation = validateForm(formData, fieldConfigs);
      if (!validation.isValid) {
        console.error('[FORMS] Form validation failed:', validation.errors);
        if (options.onError) {
          options.onError(validation.errors);
        }
        throw new Error('Form validation failed');
      }
      // Execute workflow
      console.log('[FORMS] Submitting form data:', formData);
      const result = await executeWorkflow(workflowId, formData, options);
      if (options.onSuccess) {
        options.onSuccess(result);
      }
      return result;
    } catch (error) {
      console.error('[FORMS] Form submission failed:', error);
      if (options.onError) {
        options.onError(error);
      }
      throw error;
    }
  }
  // ========================================
  // UTILITY FUNCTIONS
  // ========================================
  /**
   * Escape HTML special characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  /**
   * Format date to YYYY-MM-DD
   * @param {Date|string} date - Date to format
   * @returns {string} Formatted date string
   */
  function formatDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().split('T')[0];
  }
  /**
   * Format datetime to ISO string
   * @param {Date|string} date - Date to format
   * @returns {string} ISO datetime string
   */
  function formatDateTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString();
  }
  /**
   * Clear all workflow result caches
   */
  /**
   * Clear workflow cache(s)
   * @param {string} workflowId - Optional: workflow ID (if not provided, clears all)
   * @param {object} inputData - Optional: input data for specific cache entry
   */
  function clearWorkflowCache(workflowId = null, inputData = null) {
    const keys = Object.keys(sessionStorage);
    if (!workflowId) {
      // Clear all workflow caches
      keys.forEach(key => {
        if (key.startsWith('workflow_cache_')) {
          sessionStorage.removeItem(key);
        }
      });
      console.log('[CACHE] Cleared all workflow caches');
    } else if (inputData) {
      // Clear cache for specific workflow + input combo
      const cacheKey = `workflow_cache_${workflowId}_${JSON.stringify(inputData)}`;
      sessionStorage.removeItem(cacheKey);
      console.log('[CACHE] Cleared workflow cache for specific input:', workflowId);
    } else {
      // Clear all caches for this workflow
      keys.forEach(key => {
        if (key.startsWith(`workflow_cache_${workflowId}_`)) {
          sessionStorage.removeItem(key);
        }
      });
      console.log('[CACHE] Cleared workflow cache for:', workflowId);
    }
  }
  /**
   * Alias for clearing all workflow caches
   */
  function clearAllWorkflowCaches() {
    clearWorkflowCache();
  }
  /**
   * Clear the global workflows list cache
   */
  function clearWorkflowsCache() {
    workflowsCache = null;
    console.log('[CACHE] Cleared workflows list cache');
  }
  /**
   * Get current org ID
   * @returns {string} Organization ID
   */
  function getOrgId() {
    return window.ORG_ID;
  }
  /**
   * Set org ID (use with caution)
   * @param {string} orgId - New organization ID
   */
  function setOrgId(orgId) {
    window.ORG_ID = orgId;
    clearWorkflowsCache(); // Clear cache when org changes
  }
  /**
   * Get global skip_cache setting
   * @returns {boolean} Whether to skip caching globally
   */
  function getSkipCache() {
    return config.skip_cache;
  }
  /**
   * Set global skip_cache setting
   * @param {boolean} skip - Whether to skip caching for all workflows
   */
  function setSkipCache(skip) {
    config.skip_cache = skip;
    console.log('[CONFIG] skip_cache set to:', skip);
  }
  // ========================================
  // PUBLIC API
  // ========================================
  /**
   * Wait for a workflow execution to complete
   * @param {string} executionId - Execution ID
   * @param {function} onProgress - Optional callback for progress updates
   * @returns {Promise<object>} Execution result with conductor output
   */
  async function waitForWorkflowCompletion(executionId, onProgress) {
    const query = `
      query getExecution($id: ID!) {
        workflowExecution(where: {id: $id}) {
          id
          status
          conductor {
            errors
            output
          }
          numSuccessfulTasks
        }
      }
    `;
    let attempts = 0;
    const maxAttempts = 150; // 5 minutes at 2 second intervals
    let emptyOutputRetries = 0;
    const maxEmptyOutputRetries = 10;
    while (attempts < maxAttempts) {
      try {
        const result = await graphqlQuery(query, { id: executionId });
        // Extract execution from result (could be direct or nested under data)
        const execution = result.workflowExecution || (result.data && result.data.workflowExecution);
        if (!execution) {
          console.log('[EXECUTE] Attempt', attempts + 1, '- execution not yet queryable, retrying...');
          // First few attempts might fail if execution not yet queryable
          if (attempts < 5) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          throw new Error('Execution not found after retries: ' + executionId);
        }
        if (onProgress) {
          try {
            onProgress(execution.status, execution.numSuccessfulTasks);
          } catch (e) {}
        }
        const terminalStates = ['COMPLETED', 'SUCCESS', 'succeeded', 'FAILED', 'failed', 'ERROR'];
        if (terminalStates.some(s => execution.status?.toUpperCase?.() === s.toUpperCase())) {
          console.log('[EXECUTE] Workflow completed with status:', execution.status);
          // Check if output is empty
          const output = execution.conductor?.output;
          if (!output || (typeof output === 'object' && Object.keys(output).length === 0)) {
            console.log('[EXECUTE] Output is empty, retrying... (', emptyOutputRetries + 1, '/', maxEmptyOutputRetries, ')');
            if (emptyOutputRetries < maxEmptyOutputRetries) {
              emptyOutputRetries++;
              await new Promise(resolve => setTimeout(resolve, 2500));
              attempts = Math.max(0, attempts - 1); // Don't count empty output retries against main timeout
              continue;
            }
          }
          return {
            conductor: {
              output: output || {},
              errors: execution.conductor?.errors || [],
              status: execution.status
            }
          };
        }
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error('[EXECUTE] Error querying execution:', error.message);
        attempts++;
        if (attempts >= maxAttempts) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error('Workflow execution timeout after 5 minutes');
  }
  /**
   * Parse URL parameters into an object
   * @returns {object} URL parameters as key-value pairs
   */
  function parseURLParams() {
    const params = {};
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return params;
  }
  /**
   * Set button state with color class
   * @param {HTMLElement} button - Button element
   * @param {string} text - Button text
   * @param {string} colorClass - Color class (btn-blue, btn-green, btn-red, btn-gold, etc)
   * @param {boolean} disabled - Whether button should be disabled
   */
  function setButtonState(button, text, colorClass, disabled = false) {
    if (!button) return;
    button.textContent = text;
    button.disabled = disabled;
    // Remove all color classes
    button.classList.remove('btn-blue', 'btn-green', 'btn-red', 'btn-gold', 'btn-grey', 'btn-bluegrey');
    // Add the new color class
    if (colorClass) {
      button.classList.add(colorClass);
    }
  }
  /**
   * Generate grammatically correct phrase with article and optional formatting
   * @param {string} text - The text to include in the phrase
   * @param {string} verb - The verb to use (default: 'Select')
   * @param {object} options - Optional formatting options
   *   - capitalize: bool (default: true) - Capitalize the verb
   *   - article: bool (default: true) - Include 'a' or 'an'
   *   - dashPrefix: bool (default: true) - Add '-- ' prefix and ' --' suffix
   * @returns {string} Grammatically correct phrase
   * @example
   *   getGrammaticalPhrase('Organizations')  // "-- Select an Organizations --"
   *   getGrammaticalPhrase('User', 'Add')    // "-- Add a User --"
   *   getGrammaticalPhrase('Email', 'Enter', {article: false})  // "-- Enter Email --"
   */
  function getGrammaticalPhrase(text, verb = 'Select', options = {}) {
    const {
      capitalize = true,
      article = true,
      dashPrefix = true
    } = options;
    
    let result = '';
    
    if (dashPrefix) result += '-- ';
    result += capitalize ? verb.charAt(0).toUpperCase() + verb.slice(1) : verb;
    result += ' ';
    
    if (article) {
      const articleWord = text.match(/^[aeiou]/i) ? 'an' : 'a';
      result += articleWord + ' ';
    }
    
    result += text;
    if (dashPrefix) result += ' --';
    
    return result;
  }
  function getUrlParameter(name) {
    const params = parseURLParams();
    return params[name] || null;
  }
  /**
   * Get form_id from parent window (for iframes)
   * @returns {string|null} Form ID from parent or null
   */
  function getFormIdFromParent() {
    try {
      if (window.parent !== window) {
        console.log('[FORMS] In iframe, checking parent window...');
        const parentUrl = window.parent.location.href;
        const parentParams = new URLSearchParams(window.parent.location.search);
        const parentFormId = parentParams.get('form_id');
        if (parentFormId) {
          return parentFormId;
        }
      }
    } catch (e) {
      console.log('[FORMS] Cannot access parent window (cross-origin):', e.message);
    }
    return null;
  }
  /**
   * Detect form_id from URL parameters
   * @returns {string|null} Form ID or null
   */
  function detectUrlFormId() {
    let urlFormId = getUrlParameter('form_id');
    if (!urlFormId) {
      const parentFormId = getFormIdFromParent();
      if (parentFormId) {
        urlFormId = parentFormId;
      }
    }
    console.log('[FORMS] Detected form_id:', urlFormId);
    return urlFormId;
  }
  /**
   * Escape HTML special characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  /**
   * Format task name from camelCase/snake_case to readable format
   * @param {string} taskName - Task name
   * @returns {string} Formatted task name
   */
  function formatTaskName(taskName) {
    if (!taskName) return '';
    // Convert snake_case to spaces
    let formatted = taskName.replace(/_/g, ' ');
    // Convert camelCase to spaces
    formatted = formatted.replace(/([a-z])([A-Z])/g, '$1 $2');
    // Capitalize each word
    return formatted.replace(/\b\w/g, char => char.toUpperCase());
  }

  /**
   * Parse boolean value from various formats
   * @param {*} value - Value to parse (boolean, 0/1, 'true'/'false', etc.)
   * @returns {boolean} Parsed boolean value
   */
  function parseBooleanValue(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes';
    }
    return !!value;
  }

  /**
   * Format datetime display value (mm/dd/yy hh:mm am/pm)
   * @param {string|Date} value - ISO datetime string
   * @returns {string} Formatted datetime
   */
  function formatDateTimeDisplay(value) {
    if (!value) return '';
    const strValue = String(value);
    
    // Parse ISO 8601 datetime (e.g., "2025-12-30T14:06:04+00:00")
    const match = strValue.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (match) {
      const [, year, month, day, hours, minutes] = match;
      
      const m = String(month).padStart(2, '0');
      const d = String(day).padStart(2, '0');
      const y = String(year).slice(-2);
      
      let h = parseInt(hours);
      const ampm = h >= 12 ? 'pm' : 'am';
      h = h % 12 || 12;
      const mm = String(minutes).padStart(2, '0');
      
      return `${m}/${d}/${y} ${h}:${mm} ${ampm}`;
    }
    return strValue;
  }

  /**
   * Format date display value (mm/dd/yy)
   * @param {string|Date} value - ISO date string
   * @returns {string} Formatted date
   */
  function formatDateDisplay(value) {
    if (!value) return '';
    const strValue = String(value);
    
    // Parse ISO date (e.g., "2025-12-30")
    const match = strValue.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const [, year, month, day] = match;
      const m = String(month).padStart(2, '0');
      const d = String(day).padStart(2, '0');
      const y = String(year).slice(-2);
      return `${m}/${d}/${y}`;
    }
    return strValue;
  }

  /**
   * Format cell value for display based on field type
   * @param {string} colName - Column name
   * @param {*} value - Cell value
   * @param {object} fieldTypes - Field type mapping
   * @returns {string} Formatted cell value
   */
  function formatCellValue(colName, value, fieldTypes = {}) {
    if (!value) return '';
    
    const fieldType = fieldTypes[colName];
    
    if (fieldType === 'datetime') {
      return formatDateTimeDisplay(value);
    } else if (fieldType === 'date') {
      return formatDateDisplay(value);
    }
    
    return escapeHtml(String(value));
  }


  return {
    // Configuration
    config: {
      getOrgId,
      setOrgId,
      getSkipCache,
      setSkipCache,
      graphqlEndpoint: config.graphqlEndpoint
    },
    // User
    user: {
      get: getUser,
      username: rewst_user
    },
    // GraphQL
    graphql: {
      query: graphqlQuery
    },
    // Workflows
    workflows: {
      getAll: getAllWorkflows,
      getAllOG: getAllWorkflowsOG,
      execute: executeWorkflow,
      findByName: findWorkflowByName,
      findById: findWorkflowById,
      clearCache: clearWorkflowsCache,
      clearAllWorkflowCaches: clearAllWorkflowCaches,
      clearWorkflowCache: clearWorkflowCache
    },
    // Organizations
    organizations: {
      getSubOrganizations
    },
    // Org Variables
    orgVariables: {
      get: getOrgVariable,
      getAll: getOrgVariables,
      getDatatableConfigs: getDatatableConfigs,
      create: createOrgVariable,
      update: updateOrgVariable
    },
    // Forms
    forms: {
      evaluateCondition,
      evaluateConditionalVisibility,
      validateForm,
      submitForm,
      getUrlParameter,
      getFormIdFromParent,
      detectUrlFormId,
      escapeHtml,
      formatTaskName
    },
    // Utilities
    utils: {
      parseURLParams,
      formatDate,
      formatDateTime,
      setButtonState,
      getGrammaticalPhrase,
      parseBooleanValue,
      formatDateTimeDisplay,
      formatDateDisplay,
      formatCellValue,
      getUrlParameter,
      escapeHtml
    },
    // Version
    version: '2.1.1'
  };
})();
// Make available globally
if (typeof window !== 'undefined') {
  window.RewstLib = RewstLib;
}