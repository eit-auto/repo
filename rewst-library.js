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
  // GRAPHQL OPERATIONS METADATA
  // ========================================
const GRAPHQL_OPERATIONS = {
    createOrUpdateOrgVariable: {
      name: 'Create or Update Org Variable',
      description: 'Creates a new org variable or updates an existing one',
      type: 'submit',
      function: 'RewstLib.orgVariables.createOrUpdate',
      inputs: [
        { name: 'varName', label: 'Variable Name', type: 'text', required: true },
        { name: 'varValue', label: 'Variable Value', type: 'textarea', required: true },
        { name: 'orgId', label: 'Organization ID (optional)', type: 'text', required: false }
      ]
    },
    list_orgs: {
      name: 'List Organizations',
      description: 'Retrieves a list of sub-organizations',
      type: 'form_field',
      function: 'RewstLib.organizations.getSubOrganizations',
      inputs: [
        { name: 'parentOrgId', label: 'Parent Organization ID', type: 'text', required: true }
      ]
    },
    get_org_var: {
      name: 'Get Org Variable',
      description: 'Retrieves a specific organization variable',
      type: 'form_field',
      function: 'RewstLib.orgVariables.get',
      inputs: [
        { name: 'varName', label: 'Variable Name', type: 'text', required: true },
        { name: 'orgId', label: 'Organization ID (optional)', type: 'text', required: false }
      ]
    },
    pc_setup: {
      name: 'PC Setup',
      description: 'Retrieves PC setup field configurations from org variable',
      type: 'form_extend',
      function: 'RewstLib.orgVariables.get',
      inputs: [
        { name: 'varName', label: 'Variable Name', type: 'text', required: true, defaultValue: 'pc_setup' },
        { name: 'orgId', label: 'Organization ID', type: 'text', required: true }
      ]
    }
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
  async function getAllWorkflowsOG(useCache = false) {
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
  async function getSubOrganizations(parentOrgId = null) {
    const orgId = parentOrgId || window.ORG_ID;
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
    const data = await graphqlQuery(query, { parentOrgId: orgId });
    return data.organizations || [];
  }
  // ========================================
  // ORG VARIABLE FUNCTIONS
  // ========================================
  /**
   * Get all org variables matching a pattern
   * @param {string} pattern - Search pattern (e.g., "datatable_%")
   * @param {string} orgId - Optional organization ID (defaults to window.ORG_ID)
   * @returns {Promise<Array>} Array of org variable objects
   */
  async function getOrgVariables(pattern = '%', orgId = null) {
    const org = orgId || window.ORG_ID;
    const query = `{
      visibleOrgVariables(
        visibleForOrgId: "${org}"
        search: { 
          organization: { id: { _eq: "${org}" } }
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
   * @param {string} orgId - Optional organization ID (defaults to window.ORG_ID)
   * @returns {Promise<string|null>} Variable value or null if not found
   */
  async function getOrgVariable(varName, orgId = null) {
    const variables = await getOrgVariables(varName, orgId);
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
   * @param {object} options - Optional: {category, cascade, org_id}
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
    const orgId = options.org_id || window.ORG_ID;
    const variables = {
      orgVariable: {
        name: name,
        value: value,
        orgId: orgId,
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
   * @param {object} options - Optional: {category, cascade, org_id}
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
    const orgId = options.org_id || window.ORG_ID;
    const variables = {
      orgVariables: [
        {
          id: id,
          name: name,
          value: value,
          orgId: orgId,
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
  /**
   * Create or update an org variable (checks if exists, then creates or updates accordingly)
   * @param {string} name - Variable name
   * @param {string} value - Variable value (can be JSON string)
   * @param {object} options - Optional: {category, cascade, org_id}
   * @returns {Promise<object>} Created or updated org variable
   */
  async function createOrUpdateOrgVariable(name, value, options = {}) {
    try {
      const orgId = options.org_id || window.ORG_ID;
      console.log('[REWSTLIB] createOrUpdateOrgVariable: checking if variable exists -', name);
      
      // Check if variable exists
      const existingVar = await getOrgVariable(name, orgId);
      
      if (existingVar) {
        // Variable exists, update it
        console.log('[REWSTLIB] Variable exists, updating:', name);
        return await updateOrgVariable(existingVar.id, name, value, options);
      } else {
        // Variable doesn't exist, create it
        console.log('[REWSTLIB] Variable does not exist, creating:', name);
        return await createOrgVariable(name, value, options);
      }
    } catch (error) {
      console.error('[REWSTLIB] Failed to create or update org variable:', error.message);
      throw error;
    }
  }
  /**
   * Delete an org variable by ID
   * @param {string} id - Variable ID
   * @returns {Promise<boolean>} True if deletion was successful
   */
  async function deleteOrgVariableById(id) {
    const mutation = `
      mutation deleteOrgVariable($id: ID!) {
        deleteOrgVariable(id: $id)
      }
    `;
    const variables = { id };
    
    console.log('[REWSTLIB] Deleting org variable:', id);
    try {
      const data = await graphqlQuery(mutation, variables);
      if (data && data.deleteOrgVariable) {
        console.log('[REWSTLIB] Successfully deleted org variable:', id);
        return true;
      } else {
        throw new Error('Delete returned unexpected response');
      }
    } catch (error) {
      console.error('[REWSTLIB] Failed to delete org variable:', error.message);
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
      
      // Preprocess: Convert 'and' to '&&' and 'or' to '||' for user-friendly syntax
      // Use word boundaries to avoid replacing substrings
      expression = expression.replace(/\band\b/g, '&&');
      expression = expression.replace(/\bor\b/g, '||');
      
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
    console.log('[FORMS] evaluateConditionalVisibility - collected formData:', formData);
    // Evaluate conditions for each field
    allFieldConfigs.forEach(config => {
      const formGroup = document.querySelector(`[data-field-name="${config.field_name}"]`);
      console.log(`[FORMS] Checking field ${config.field_name}: formGroup found=${!!formGroup}, hidden=${config.hidden}, condition_1=${config.condition_1}`);
      if (!formGroup) {
        console.log(`[FORMS] SKIPPING ${config.field_name} - formGroup not found`);
        return;
      }
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
      console.log(`[FORMS] Setting ${config.field_name} display to: ${shouldShow ? 'visible' : 'none'}`);
      formGroup.style.display = shouldShow ? '' : 'none';
      formGroup.style.marginBottom = shouldShow ? '' : '0';
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
        // For checkboxes, require them to be checked (value === true)
        if (config.type === 'checkbox') {
          if (value !== true) {
            if (!errors[config.field_name]) {
              errors[config.field_name] = [];
            }
            errors[config.field_name].push(`${config.field_displayname} is required`);
            isValid = false;
          }
        } else if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
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
  /**
   * Handle cascading updates when a dependency field (like rewst_org_id) changes
   * Clears cache and resets dependent fields to trigger re-execution
   * @param {string} changedFieldName - Name of the field that changed
   * @param {Array} allFieldConfigs - Array of all field configurations
   * @param {object} options - Optional config {
   *   dataRetrievalCache, dataRetrievalResults,
   *   workflowCache, graphqlCache
   * }
   */
  function onDependencyFieldChanged(changedFieldName, allFieldConfigs, options = {}) {
    console.log(`[FORMS] Dependency field changed: ${changedFieldName}`);
    
    // Find all fields that depend on the changed field
    const dependentFields = allFieldConfigs.filter(config => {
      if (!config.dependant_fields) return false;
      
      // Check if this field depends on changedFieldName
      if (typeof config.dependant_fields === 'object') {
        return config.dependant_fields.hasOwnProperty(changedFieldName);
      }
      return false;
    });
    
    console.log(`[FORMS] Found ${dependentFields.length} dependent field(s): ${dependentFields.map(f => f.field_name).join(', ')}`);
    
    // For each dependent field:
    // 1. Clear cache entries
    // 2. Reset UI
    // 3. Mark for re-execution
    dependentFields.forEach(depConfig => {
      const fieldName = depConfig.field_name;
      const formGroup = document.querySelector(`[data-field-name="${fieldName}"]`);
      
      if (!formGroup) {
        console.warn(`[FORMS] Form group not found for dependent field: ${fieldName}`);
        return;
      }
      
      console.log(`[FORMS] Clearing dependent field: ${fieldName} (type: ${depConfig.type})`);
      
      // Clear cache based on field type
      if (depConfig.type === 'data_retrieval') {
        // For data_retrieval fields, clear the cache entry
        if (options.dataRetrievalCache) {
          delete options.dataRetrievalCache[fieldName];
        }
        if (options.dataRetrievalResults) {
          delete options.dataRetrievalResults[fieldName];
        }
      } else if (depConfig.type === 'dropdown' || depConfig.type === 'dropdown_workflow') {
        // For workflow-based dropdowns, clear workflow cache
        if (options.workflowCache) {
          // Clear all workflow cache entries for this field
          // We can't reconstruct the exact cache key without the full input,
          // so we clear all entries that might match
          Object.keys(options.workflowCache.results).forEach(cacheKey => {
            if (cacheKey.startsWith(depConfig.workflow_id)) {
              console.log(`[FORMS] Cleared workflow cache: ${cacheKey}`);
              delete options.workflowCache.results[cacheKey];
            }
          });
          Object.keys(options.workflowCache.inFlight).forEach(cacheKey => {
            if (cacheKey.startsWith(depConfig.workflow_id)) {
              console.log(`[FORMS] Cleared in-flight workflow: ${cacheKey}`);
              delete options.workflowCache.inFlight[cacheKey];
            }
          });
        }
      } else if (depConfig.type === 'dropdown_graphql') {
        // For GraphQL dropdowns, clear GraphQL cache
        if (options.graphqlCache && depConfig.graphql_op) {
          // Clear all GraphQL cache entries for this operation
          Object.keys(options.graphqlCache.results).forEach(cacheKey => {
            if (cacheKey.startsWith(depConfig.graphql_op)) {
              console.log(`[FORMS] Cleared GraphQL cache: ${cacheKey}`);
              delete options.graphqlCache.results[cacheKey];
            }
          });
          Object.keys(options.graphqlCache.inFlight).forEach(cacheKey => {
            if (cacheKey.startsWith(depConfig.graphql_op)) {
              console.log(`[FORMS] Cleared in-flight GraphQL: ${cacheKey}`);
              delete options.graphqlCache.inFlight[cacheKey];
            }
          });
        }
      } else if (depConfig.type === 'dropdown_mysql' || depConfig.type === 'dropdown_mesh' || depConfig.type === 'dropdown_prefetch') {
        // These are handled via data_retrieval or other mechanisms
        // Clear proxy query cache if applicable
        if (depConfig.type === 'dropdown_mysql' && options.proxyCache && options.proxyCache.queryResults) {
          Object.keys(options.proxyCache.queryResults).forEach(queryId => {
            if (queryId.includes(fieldName)) {
              delete options.proxyCache.queryResults[queryId];
            }
          });
        }
      }
      
      // Clear UI - reset to initial state
      if (depConfig.type === 'dropdown_prefetch' || depConfig.type === 'dropdown_mysql' || 
          depConfig.type === 'dropdown_graphql' || depConfig.type === 'dropdown_mesh' || 
          depConfig.type === 'dropdown' || depConfig.type === 'dropdown_workflow') {
        
        // Clear multi-select
        if (depConfig.multi_select) {
          const hiddenSelect = formGroup.querySelector('.multi-select-hidden-select');
          const tagsContainer = formGroup.querySelector('.multi-select-tags');
          const optionsDiv = formGroup.querySelector('.multi-select-options');
          
          if (hiddenSelect) {
            hiddenSelect.innerHTML = '';
            hiddenSelect.setAttribute('data-selected-values', '[]');
          }
          
          if (tagsContainer) {
            tagsContainer.innerHTML = '<span class="multi-select-placeholder">-- Select options --</span>';
          }
          
          if (optionsDiv) {
            optionsDiv.innerHTML = '';
          }
        } else {
          // Clear single-select
          const select = formGroup.querySelector('select:not(.multi-select-hidden-select)');
          if (select) {
            // Keep placeholder option if it exists
            const placeholder = select.querySelector('option[value=""]');
            select.innerHTML = '';
            if (placeholder) {
              select.appendChild(placeholder.cloneNode(true));
            }
            select.value = '';
          }
        }
      }
      
      // Mark field for re-execution by removing any cached state
      // This will be picked up by the field initialization logic on next update
      formGroup.setAttribute('data-needs-refresh', 'true');
    });
    
    console.log(`[FORMS] Cleared ${dependentFields.length} dependent field(s)`);
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
        if (execution.status && terminalStates.some(s => execution.status.toUpperCase() === s.toUpperCase())) {
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
    
    // In iframe context, try parent window first
    if (window.parent !== window) {
      try {
        const parentParams = new URLSearchParams(window.parent.location.search);
        parentParams.forEach((value, key) => {
          params[key] = value;
        });
        // If we got params from parent, return them
        if (Object.keys(params).length > 0) {
          return params;
        }
      } catch (e) {
        // If parent is cross-origin or inaccessible, fall through to current window
      }
    }
    
    // Fall back to current window's parameters
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
   *   - noResults: bool (default: false) - If true, return "None Found" instead
   * @returns {string} Grammatically correct phrase or "None Found" if no results
   * @example
   *   getGrammaticalPhrase('Organizations')  // "-- Select an Organizations --"
   *   getGrammaticalPhrase('User', 'Add')    // "-- Add a User --"
   *   getGrammaticalPhrase('Email', 'Enter', {article: false})  // "-- Enter Email --"
   *   getGrammaticalPhrase('Items', 'Select', {noResults: true})  // "None Found"
   */
  function getGrammaticalPhrase(text, verb = 'Select', options = {}) {
    const {
      capitalize = true,
      article = true,
      dashPrefix = true,
      noResults = false
    } = options;
    
    // Return "None Found" if no results available
    if (noResults) {
      return 'None Found';
    }
    
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
  if (typeof escapeHtml === 'undefined') {
    var escapeHtml = function(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    };
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

  /**
   * Get all available GraphQL operations
   * @returns {object} All GraphQL operations metadata
   */
  function getGraphQLOperations() {
    return GRAPHQL_OPERATIONS;
  }
  
  /**
   * Generate multi-select container HTML
   * @param {string} fieldName - Field name
   * @param {string} displayName - Display name for label
   * @param {string} description - Optional field description
   * @returns {string} HTML for multi-select container
   */
  function renderMultiSelectContainer(fieldName, displayName, description) {
    const multiSelectId = `ms_${fieldName}`;
    const descriptionHtml = description ? `<div class="field-description">${escapeHtml(description)}</div>` : '';
    return `
      <label>${displayName}</label>
      ${descriptionHtml}
      <div class="multi-select-container" id="${multiSelectId}">
        <div class="multi-select-display">
          <div class="multi-select-tags"></div>
          <div class="multi-select-toggle">▼</div>
        </div>
        <div class="multi-select-options"></div>
        <select name="${fieldName}" class="multi-select-hidden-select" multiple="multiple" data-selected-values="[]"></select>
      </div>
    `;
  }

  /**
   * Initialize dropdown multi-select component
   * @param {string} fieldName - Field name
   * @param {Array} optionsArray - Array of {value, label} objects
   * @param {Array} selectedValues - Optional array of pre-selected values
   */
  function initializeDropdownMultiSelect(fieldName, optionsArray, selectedValues = []) {
    const multiSelectId = `ms_${fieldName}`;
    const container = document.getElementById(multiSelectId);
    if (container && optionsArray && optionsArray.length > 0) {
      // Log the call stack to see who's calling this
      const stack = new Error().stack.split('\n').slice(1, 4).map(line => line.trim()).join(' <- ');
      const containerRef = `[DOM@${container.offsetParent ? 'visible' : 'hidden'}]`;
      const containerPath = `${container.parentElement?.className || 'no-parent'} > ${container.id}`;
      console.log(`[INIT-DROPDOWN-MS] Called for ${fieldName} with ${optionsArray.length} options. Container: ${containerRef} Path: ${containerPath}. Stack: ${stack}`);
      initializeMultiSelect(container, optionsArray, selectedValues);
      console.log(`[MULTI-SELECT] Initialized for: ${fieldName} with ${optionsArray.length} options and ${selectedValues.length} pre-selected values`);
    } else {
      if (!container) console.log(`[INIT-DROPDOWN-MS] SKIPPED for ${fieldName}: container not found (id=${multiSelectId})`);
      if (!optionsArray || optionsArray.length === 0) console.log(`[INIT-DROPDOWN-MS] SKIPPED for ${fieldName}: no options (length=${optionsArray?.length || 0})`);
    }
  }

  /**
   * Unified function to repopulate a multi-select field with options and pre-selected values
   * Used by both prefetch and non-prefetch dropdown refreshes
   * @param {string} fieldName - Field name
   * @param {Array} options - Array of {value, label} objects
   * @param {Array} preselectedValues - Optional array of pre-selected values
   */
  function repopulateMultiSelectField(fieldName, options, preselectedValues = []) {
    const multiSelectContainer = document.querySelector(`[data-field-name="${fieldName}"] .multi-select-container`);
    if (!multiSelectContainer) {
      console.error(`[REPOPULATE] Multi-select container not found for ${fieldName}`);
      return;
    }
    
    // Initialize the multi-select component with pre-selected values
    // This will handle updating the hidden select, tags, and dropdown display
    initializeDropdownMultiSelect(fieldName, options, preselectedValues);
  }

  /**
   * Map result items to options format for dropdowns
   * @param {Array} items - Array of result items
   * @param {string} valueName - Property name for value
   * @param {string} labelName - Property name for label
   * @returns {Array} Array of {value, label} objects
   */
  function mapResultsToOptions(items, valueName, labelName) {
    if (!items || !Array.isArray(items)) return [];
    return items.map(item => ({
      value: item[valueName] || item.id || item.Id,
      label: item[labelName] || item.name || item.Name
    })).filter(opt => opt.value && opt.label);
  }

  /**
   * Show "Waiting for..." message when field depends on parent field selection
   * @param {HTMLElement} formGroup - Form group container
   * @param {object} config - Field configuration
   * @param {Array} fieldConfigs - All field configurations
   */
  function showWaitingMessage(formGroup, config, fieldConfigs, blockingFieldNames) {
    // Handle both object (new format) and string (old format) for dependant_fields
    // If blockingFieldNames is provided (from variable refs), use that; otherwise extract from config
    let depFields;
    if (blockingFieldNames) {
      // Runtime-provided blocking field names (e.g., from variable reference)
      depFields = Array.isArray(blockingFieldNames) ? blockingFieldNames : [blockingFieldNames];
    } else if (config.dependant_fields && typeof config.dependant_fields === 'object') {
      depFields = Object.keys(config.dependant_fields);
    } else if (config.dependant_fields && typeof config.dependant_fields === 'string') {
      depFields = config.dependant_fields.split(',').map(f => f.trim());
    } else {
      depFields = [];
    }
    
    const parentFieldLabels = depFields.map(fieldName => {
      const parentConfig = fieldConfigs.find(f => f.field_name === fieldName);
      return parentConfig ? parentConfig.field_displayname : fieldName;
    });
    
    // Hide multi-select display or regular input
    const multiSelectDisplay = formGroup.querySelector('.multi-select-display');
    const input = formGroup.querySelector('input, select, textarea');
    
    if (multiSelectDisplay) {
      multiSelectDisplay.style.display = 'none';
    } else if (input) {
      input.style.display = 'none';
    }
    
    // Check if waiting message already exists - if so, update it instead of creating duplicate
    let waitingBox = formGroup.querySelector('.field-waiting-message');
    // Build message based on field type
    let messageText;
    if (config.type === 'dropdown_prefetch') {
      // Prefetch: no "selection" word
      messageText = `Waiting for ${parentFieldLabels.join(' and ')}`;
    } else if (config.type === 'data_retrieval') {
      // Data retrieval: include own field name
      messageText = `${config.field_displayname}: Waiting for ${parentFieldLabels.join(' and ')} selection`;
    } else {
      // Other dropdowns: standard format
      messageText = `Waiting for ${parentFieldLabels.join(' and ')} selection`;
    }
    
    if (waitingBox) {
      // Update existing message and ensure it's visible
      waitingBox.innerHTML = messageText;
      waitingBox.style.display = 'flex';
      // Apply gold styling for data_retrieval
      if (config.type === 'data_retrieval') {
        waitingBox.classList.add('data-retrieval-waiting');
      } else {
        waitingBox.classList.remove('data-retrieval-waiting');
      }
    } else {
      // Create new message
      waitingBox = document.createElement('div');
      waitingBox.className = 'field-waiting-message';
      if (config.type === 'data_retrieval') {
        waitingBox.classList.add('data-retrieval-waiting');
      }
      waitingBox.setAttribute('data-field-name', config.field_name);
      waitingBox.innerHTML = messageText;
      waitingBox.style.display = 'flex';
      formGroup.appendChild(waitingBox);
    }
  }

  /**
   * Show "Loading..." message when field is loading data
   * @param {HTMLElement} formGroup - Form group container
   * @param {object} config - Field configuration
   */
  function showLoadingMessage(formGroup, config) {
    // Hide multi-select display or regular input
    const multiSelectDisplay = formGroup.querySelector('.multi-select-display');
    const input = formGroup.querySelector('input, select, textarea');
    
    if (multiSelectDisplay) {
      multiSelectDisplay.style.display = 'none';
    } else if (input) {
      input.style.display = 'none';
    }
    
    // Disable refresh button and show spinner
    const refreshBtn = formGroup.querySelector('.dropdown-refresh-btn');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.setAttribute('data-original-text', refreshBtn.textContent);
      refreshBtn.innerHTML = '<div style="display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(90, 159, 184, 0.3); border-top-color: #5a9fb8; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>';
    }
    
    // Show existing loading message from template
    const loadingMsg = formGroup.querySelector('.field-loading-message');
    if (loadingMsg) {
      loadingMsg.style.display = 'flex';
    }
  }

  /**
   * Hide "Loading..." message and show field again
   * @param {HTMLElement} formGroup - Form group container
   * @param {object} config - Field configuration
   */
  function hideLoadingMessage(formGroup, config) {
    // Hide loading message instead of removing it
    const loadingBox = formGroup.querySelector('.field-loading-message');
    if (loadingBox) loadingBox.style.display = 'none';
    
    // Re-enable refresh button and restore original text
    const refreshBtn = formGroup.querySelector('.dropdown-refresh-btn');
    if (refreshBtn) {
      refreshBtn.disabled = false;
      const originalText = refreshBtn.getAttribute('data-original-text');
      refreshBtn.textContent = originalText || '↻';
      refreshBtn.removeAttribute('data-original-text');
    }
    
    // Show multi-select display or regular input
    const multiSelectDisplay = formGroup.querySelector('.multi-select-display');
    const input = formGroup.querySelector('input, select, textarea');
    
    if (multiSelectDisplay) {
      multiSelectDisplay.style.display = '';
    } else if (input) {
      input.style.display = '';
    }
  }

  /**
   * Hide "Waiting for..." message and show field again
   * @param {HTMLElement} formGroup - Form group container
   * @param {object} config - Field configuration
   */
  function hideWaitingMessage(formGroup, config) {
    // Hide waiting message instead of removing it
    const waitingBox = formGroup.querySelector('.field-waiting-message');
    if (waitingBox) waitingBox.style.display = 'none';
    
    // Show multi-select display or regular input
    const multiSelectDisplay = formGroup.querySelector('.multi-select-display');
    const input = formGroup.querySelector('input, select, textarea');
    
    if (multiSelectDisplay) {
      multiSelectDisplay.style.display = '';
    } else if (input) {
      input.style.display = '';
    }
  }

  /**
   * Initialize dependent fields - show waiting message for all fields with dependencies
   * @param {Array} fieldConfigs - All field configurations
   */
  function initializeDependentFields(fieldConfigs) {
    fieldConfigs.forEach(config => {
      const formGroup = document.querySelector(`[data-field-name="${config.field_name}"]`);
      if (!formGroup || !config.dependant_fields || config.hidden) return;
      
      // Check if dependant_fields is object (new format) or string (old format)
      const isObjectFormat = typeof config.dependant_fields === 'object';
      
      if (isObjectFormat) {
        // New format: only show waiting for blocking: true dependencies
        const hasBlockingDeps = Object.values(config.dependant_fields).some(dep => dep.blocking === true);
        if (hasBlockingDeps) {
          showWaitingMessage(formGroup, config, fieldConfigs);
        }
      } else {
        // Old format: show waiting for all dependencies
        showWaitingMessage(formGroup, config, fieldConfigs);
      }
    });
  }

  /**
   * Check if all dependencies for a field are met
   * @param {object} config - Field configuration
   * @param {Array} allFieldConfigs - All field configurations
   * @returns {boolean} True if all dependencies are met
   */
  function areDependenciesMet(config, allFieldConfigs) {
    if (!config.dependant_fields) return true;
    
    // Check if dependant_fields is object (new format) or string (old format)
    const isObjectFormat = typeof config.dependant_fields === 'object';
    
    if (isObjectFormat) {
      // New format: only check blocking: true dependencies
      const blockingDeps = Object.entries(config.dependant_fields)
        .filter(([_, dep]) => dep.blocking === true)
        .map(([fieldName, _]) => fieldName);
      
      return blockingDeps.every(depFieldName => {
        const depField = allFieldConfigs.find(f => f.field_name === depFieldName);
        if (!depField) return false;
        
        // Get dependency definition for this field
        const depDef = config.dependant_fields[depFieldName];
        
        // Check actual DOM visibility instead of config property
        const formGroup = document.querySelector(`[data-field-name="${depFieldName}"]`);
        const isVisible = formGroup && window.getComputedStyle(formGroup).display !== 'none';
        
        // If block_hidden: false and the dependency field is hidden, don't require it
        if (depDef.block_hidden === false && !isVisible) {
          console.log(`[DEPENDENCIES] ${depFieldName} is hidden (DOM) and block_hidden: false, ignoring`);
          return true;
        }
        
        // Otherwise, check if field is visible and has a value
        const input = document.querySelector(`input[name="${depFieldName}"], select[name="${depFieldName}"], textarea[name="${depFieldName}"]`);
        if (!input) return false;
        if (input.type === 'checkbox') return input.checked;
        if (input.type === 'radio') {
          const checkedRadio = document.querySelector(`input[name="${depFieldName}"]:checked`);
          return !!checkedRadio;
        }
        return input.value && input.value.trim() !== '';
      });
    } else {
      // Old format: check all dependencies
      const depFields = config.dependant_fields.split(',').map(f => f.trim());
      return depFields.every(depFieldName => {
        const depField = allFieldConfigs.find(f => f.field_name === depFieldName);
        if (!depField) return false;
        const input = document.querySelector(`input[name="${depFieldName}"], select[name="${depFieldName}"], textarea[name="${depFieldName}"]`);
        if (!input) return false;
        if (input.type === 'checkbox') return input.checked;
        if (input.type === 'radio') {
          const checkedRadio = document.querySelector(`input[name="${depFieldName}"]:checked`);
          return !!checkedRadio;
        }
        return input.value && input.value.trim() !== '';
      });
    }
  }

  /**
   * Process GraphQL variables - replace [[ field_name ]] tags with actual form values
   * @param {object} variables - GraphQL variables with potential [[ ]] tags
   * @param {object} formData - Current form data with field values
   * @returns {object} Processed variables with replacements applied
   */
  function processGraphQLDropdownVariables(variables, formData) {
    const processed = {};
    Object.keys(variables).forEach(key => {
      let value = variables[key];
      if (typeof value === 'string' && value.startsWith('[[') && value.endsWith(']]')) {
        const fieldName = value.slice(2, -2).trim();
        if (formData.hasOwnProperty(fieldName)) {
          const fieldValue = formData[fieldName];
          if (Array.isArray(fieldValue)) {
            processed[key] = JSON.stringify(fieldValue);
            console.log(`[DROPDOWN] Replaced [[ ${fieldName} ]] with JSON array:`, processed[key]);
          } else {
            processed[key] = fieldValue;
            console.log(`[DROPDOWN] Replaced [[ ${fieldName} ]] with:`, processed[key]);
          }
        } else {
          processed[key] = value;
          console.warn(`[DROPDOWN] Field not found: ${fieldName}`);
        }
      } else {
        processed[key] = value;
      }
    });
    return processed;
  }

  /**
   * Load GraphQL dropdown options using metadata-driven approach
   * @param {object} config - Field configuration
   * @param {object} formConfig - Form configuration
   * @returns {Promise} Array or object of dropdown options
   */
  async function loadGraphQLDropdownOptions(config, formConfig) {
    console.log(`[DROPDOWN] Loading for ${config.field_name}, operation: ${config.graphql_op}`);
    
    // Collect current form data for variable replacement
    const currentFormData = {};
    if (formConfig && formConfig.field_configs) {
      formConfig.field_configs.forEach(fc => {
        const inp = document.querySelector(`input[name="${fc.field_name}"], select[name="${fc.field_name}"], textarea[name="${fc.field_name}"]`);
        if (inp) {
          if (inp.type === 'checkbox') {
            currentFormData[fc.field_name] = inp.checked;
          } else if (inp.type === 'radio') {
            const checked = document.querySelector(`input[name="${fc.field_name}"]:checked`);
            currentFormData[fc.field_name] = checked ? checked.value : null;
          } else {
            currentFormData[fc.field_name] = inp.value;
          }
        }
      });
    }
    
    const opMetadata = RewstLib.graphqlOperations.get(config.graphql_op);
    if (!opMetadata) {
      throw new Error(`Unknown operation: ${config.graphql_op}`);
    }
    
    console.log(`[DROPDOWN] Metadata:`, opMetadata);
    
    // Map function path to library reference
    let libraryFn;
    if (opMetadata.function === 'RewstLib.organizations.getSubOrganizations') {
      libraryFn = RewstLib.organizations.getSubOrganizations;
    } else if (opMetadata.function === 'RewstLib.orgVariables.get') {
      libraryFn = RewstLib.orgVariables.get;
    } else {
      throw new Error(`Unknown function: ${opMetadata.function}`);
    }
    
    if (!libraryFn) {
      throw new Error(`Function unavailable: ${opMetadata.function}`);
    }
    
    // Process variables
    let vars = {};
    if (config.graphql_op_variables) {
      vars = processGraphQLDropdownVariables(config.graphql_op_variables, currentFormData);
      console.log(`[DROPDOWN] Processed vars:`, vars);
    } else if (config.graphql_op === 'list_orgs') {
      vars.parentOrgId = window.ORG_ID;
    }
    
    // Call library function with appropriate parameters
    let result;
    if (config.graphql_op === 'list_orgs') {
      result = await libraryFn(vars.parentOrgId || window.ORG_ID);
    } else if (config.graphql_op === 'get_org_var') {
      result = await libraryFn(vars.varName, vars.orgId);
    } else {
      throw new Error(`No mapping for: ${config.graphql_op}`);
    }
    
    console.log(`[DROPDOWN] Result:`, result);
    return result;
  }

  /**
   * Get values of all dependencies (both blocking and non-blocking)
   * @param {object} config - Field configuration
   * @param {Array} allFieldConfigs - All field configurations
   * @returns {object} Object with dependency field names and their values
   */
  function getDependencyValues(config, allFieldConfigs) {
    if (!config.dependant_fields) return {};
    
    const values = {};
    const isObjectFormat = typeof config.dependant_fields === 'object';
    
    let depFieldNames = [];
    if (isObjectFormat) {
      depFieldNames = Object.keys(config.dependant_fields);
    } else {
      depFieldNames = config.dependant_fields.split(',').map(f => f.trim());
    }
    
    depFieldNames.forEach(depFieldName => {
      const depField = allFieldConfigs.find(f => f.field_name === depFieldName);
      if (!depField) return;
      
      // Get dependency definition for this field (new format only)
      const depDef = isObjectFormat ? config.dependant_fields[depFieldName] : null;
      
      // Check actual DOM visibility instead of config property
      const formGroup = document.querySelector(`[data-field-name="${depFieldName}"]`);
      const isVisible = formGroup && window.getComputedStyle(formGroup).display !== 'none';
      
      // Skip this field if incl_hidden: false and the field is hidden (DOM check)
      if (isObjectFormat && depDef.incl_hidden === false && !isVisible) {
        console.log(`[DEPENDENCIES] Skipping ${depFieldName}: incl_hidden: false and field is hidden (DOM)`);
        return;
      }
      
      const input = document.querySelector(`input[name="${depFieldName}"], select[name="${depFieldName}"], textarea[name="${depFieldName}"]`);
      if (!input) return;
      
      if (input.type === 'checkbox') {
        values[depFieldName] = input.checked;
      } else if (input.type === 'radio') {
        const checkedRadio = document.querySelector(`input[name="${depFieldName}"]:checked`);
        values[depFieldName] = checkedRadio ? checkedRadio.value : null;
      } else {
        values[depFieldName] = input.value;
      }
    });
    
    return values;
  }

  /**
   * Update dependent fields when a parent field changes
   * @param {string} changedFieldName - Name of field that changed
   * @param {Array} allFieldConfigs - All field configurations
   * @param {object} formConfig - Form configuration
   * @param {function} onLoadFieldOptions - Callback to load field options for data-fetching types
   *   Signature: (config, allFieldConfigs, formConfig) => void
   */
  function updateDependentFields(changedFieldName, allFieldConfigs, formConfig, onLoadFieldOptions) {
    const dependentFields = allFieldConfigs.filter(config => {
      if (!config.dependant_fields) return false;
      if (typeof config.dependant_fields === 'object') {
        return changedFieldName in config.dependant_fields;
      } else {
        return config.dependant_fields.includes(changedFieldName);
      }
    });
    
    console.log(`[DEPENDENCIES] Found ${dependentFields.length} dependent fields for: ${changedFieldName}`);
    dependentFields.forEach(df => console.log(`    - ${df.field_name} depends on ${changedFieldName}`));
    
    // Process dependent fields
    dependentFields.forEach(depConfig => {
      // Check if all dependencies are still met
      const depsMet = areDependenciesMet(depConfig, allFieldConfigs);
      console.log(`[DEPENDENCIES] Dependencies for ${depConfig.field_name}: ${depsMet ? 'MET' : 'NOT MET'}`);
      
      if (!depsMet) {
        // Dependencies no longer met - show waiting message
        const formGroup = document.querySelector(`[data-field-name="${depConfig.field_name}"]`);
        if (formGroup) {
          hideLoadingMessage(formGroup, depConfig);
          showWaitingMessage(formGroup, depConfig, allFieldConfigs);
          console.log(`[DEPENDENCIES] Showing waiting message for ${depConfig.field_name}`);
        }
      } else {
        // Dependencies still met - reload options for data-fetching types
        // Callback for data-fetching field types
        const onDataFetching = (config, fieldConfigs) => {
          if (onLoadFieldOptions) {
            onLoadFieldOptions(config, fieldConfigs, formConfig);
          }
        };
        
        // Callback for non-data-fetching field types
        const onNonDataFetching = (config, formGroup) => {
          console.log(`[DEPENDENCIES] Non-data-fetching field ${config.field_name}, hiding waiting message`);
        };
        
        handleDependencyMet(depConfig, allFieldConfigs, onDataFetching, onNonDataFetching);
      }
    });
  }

  /**
   * Handle field state when dependency is met
   * @param {object} config - Field configuration
   * @param {Array} allFieldConfigs - All field configurations
   * @param {function} onDataFetchingField - Callback for data-fetching field types
   * @param {function} onNonDataFetchingField - Callback for non-data-fetching field types
   */
  function handleDependencyMet(config, allFieldConfigs, onDataFetchingField, onNonDataFetchingField) {
    const formGroup = document.querySelector(`[data-field-name="${config.field_name}"]`);
    if (!formGroup) return;
    
    hideWaitingMessage(formGroup, config);
    
    // Data-fetching field types (dropdown, dropdown_graphql, form_extend)
    if (config.type === 'dropdown' || config.type === 'dropdown_graphql' || config.type === 'form_extend') {
      if (onDataFetchingField) {
        onDataFetchingField(config, allFieldConfigs);
      }
    } else {
      // Non-data-fetching field types - just show field
      if (onNonDataFetchingField) {
        onNonDataFetchingField(config, formGroup);
      }
    }
  }

  
  
  /**
   * Get a specific GraphQL operation metadata
   * @param {string} operationName - Operation name
   * @returns {object|null} Operation metadata or null if not found
   */
  function getGraphQLOperation(operationName) {
    return GRAPHQL_OPERATIONS[operationName] || null;
  }

  /**
   * Initialize a custom multi-select component
   * @param {HTMLElement} container - The custom-multi-select container
   * @param {Array} options - Array of {value, label} objects
   * @param {Array} selectedValues - Initial selected values
   * @param {function} onChange - Callback when selection changes
   */
  let initializeMultiSelectCallCount = 0;
  function initializeMultiSelect(container, options, selectedValues = [], onChange = null) {
    const callId = ++initializeMultiSelectCallCount;
    if (!container) {
      console.error('[MULTI-SELECT] Container not provided');
      return;
    }

    // Check if already initialized to prevent duplicate event listeners
    // However, on re-initialization (e.g., when changing org), we need to clear old listeners
    // and attach fresh ones that capture the new closure's variables
    let alreadyInitialized = container.getAttribute('data-initialized') === 'true';
    
    if (alreadyInitialized) {
      // On re-initialization, clear the flag so listeners get re-attached
      // This ensures new listeners capture the current closure's variables (options, selected, etc.)
      console.log(`[INIT-MULTI-SELECT] [CALL #${callId}] Re-initializing: clearing old flag to reattach fresh listeners`);
      container.removeAttribute('data-initialized');
      alreadyInitialized = false; // Now listeners will be re-attached
      
      // Clear the container's HTML to remove all old event listeners
      container.innerHTML = '';
      
      // Rebuild the multi-select structure
      const tagsDiv = document.createElement('div');
      tagsDiv.className = 'multi-select-display';
      tagsDiv.innerHTML = `
        <div class="multi-select-tags"></div>
        <div class="multi-select-toggle">▼</div>
      `;
      container.appendChild(tagsDiv);
      
      const optionsDiv = document.createElement('div');
      optionsDiv.className = 'multi-select-options';
      container.appendChild(optionsDiv);
      
      const selectElem = document.createElement('select');
      selectElem.className = 'multi-select-hidden-select';
      selectElem.setAttribute('multiple', 'multiple');
      selectElem.setAttribute('data-selected-values', '[]');
      container.appendChild(selectElem);
      
      console.log(`[INIT-MULTI-SELECT] [CALL #${callId}] Rebuilt container HTML, ready for fresh listener attachment`);
    }

    const tagsContainer = container.querySelector('.multi-select-tags');
    const dropdown = container.querySelector('.multi-select-options');
    const toggleBtn = container.querySelector('.multi-select-toggle');
    const hiddenSelect = container.querySelector('select');

    console.log(`[INIT-MULTI-SELECT] [CALL #${callId}] initializeMultiSelect called. options.length=${options.length}, dropdown element=${!!dropdown}, container.id=${container.id}, container.class=${container.className}`);

    if (!dropdown || !toggleBtn) {
      console.error('[MULTI-SELECT] Missing required elements');
      return;
    }
    
    let selected = [...(selectedValues || [])].map(v => String(v));  // Normalize to strings for comparison with option.value

    // Populate hidden select with option elements
    if (hiddenSelect) {
      hiddenSelect.innerHTML = '';  // Clear any existing options first
      options.forEach(option => {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = option.label;
        if (selected && selected.includes(String(option.value))) {
          opt.selected = true;
        }
        hiddenSelect.appendChild(opt);
      });
    }

    // Update UI with current selection
    function updateTags() {
      tagsContainer.innerHTML = '';

      if (selected.length === 0) {
        const placeholder = document.createElement('span');
        placeholder.className = 'multi-select-placeholder';
        placeholder.textContent = '-- Select options --';
        tagsContainer.appendChild(placeholder);
      } else {
        selected.forEach(value => {
          const option = options.find(o => String(o.value) === value);
          if (option) {
            const tag = document.createElement('span');
            tag.className = 'multi-select-tag';
            tag.innerHTML = `
              ${escapeHtml(option.label)}
              <button type="button" class="multi-select-tag-remove" data-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(option.label)}">×</button>
            `;
            tagsContainer.appendChild(tag);
          }
        });
      }

      // Update hidden select selected state via data attribute and option elements
      if (hiddenSelect) {
        hiddenSelect.setAttribute('data-selected-values', JSON.stringify(selected));
        
        // Also sync the selected attributes on the actual option elements
        Array.from(hiddenSelect.options).forEach(opt => {
          const shouldBeSelected = selected.includes(opt.value);
          opt.selected = shouldBeSelected;
        });
      }

      if (onChange) {
        onChange(selected);
      }
    }

    // Populate dropdown options
    function populateDropdown() {
      const optionsContainer = dropdown;
      const oldChildCount = optionsContainer.children.length;
      const stackTrace = new Error().stack.split('\n').slice(1, 3).map(line => line.trim().split(' (')[0]).join(' <- ');
      console.log(`[POPULATE] [CALL #${callId}] Starting populateDropdown. Container had ${oldChildCount} children, options.length=${options.length}. Caller: ${stackTrace}`);
      optionsContainer.innerHTML = '';
      console.log(`[POPULATE] [CALL #${callId}] Cleared container, now has ${optionsContainer.children.length} children`);

      // Add SELECT ALL checkbox at the top
      const selectAllDiv = document.createElement('div');
      selectAllDiv.className = 'multi-select-option multi-select-select-all';
      const selectAllId = 'selectall_' + Math.random().toString(36).substr(2, 9);
      const allSelected = options.length > 0 && selected.length === options.length;
      selectAllDiv.innerHTML = `
        <input type="checkbox" id="${selectAllId}" ${allSelected ? 'checked' : ''}>
        <label for="${selectAllId}"><strong>Select All</strong></label>
      `;
      
      const selectAllCheckbox = selectAllDiv.querySelector('input');
      selectAllCheckbox.addEventListener('change', () => {
        if (selectAllCheckbox.checked) {
          // Select all
          selected = options.map(o => String(o.value));
        } else {
          // Deselect all
          selected = [];
        }
        updateTags();
        populateDropdown(); // Refresh to update all checkboxes
      });
      
      optionsContainer.appendChild(selectAllDiv);

      // Add separator
      const separator = document.createElement('div');
      separator.style.borderBottom = '1px solid #556870';
      optionsContainer.appendChild(separator);

      options.forEach(option => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'multi-select-option';
        const optId = 'opt_' + Math.random().toString(36).substr(2, 9);
        const isChecked = selected.includes(String(option.value));
        optionDiv.innerHTML = `
          <input type="checkbox" id="${optId}" 
                 value="${escapeHtml(String(option.value))}" ${isChecked ? 'checked' : ''}>
          <label for="${optId}">${escapeHtml(option.label)}</label>
        `;
        
        const checkbox = optionDiv.querySelector('input');
        checkbox.addEventListener('change', () => {
          const stringValue = String(option.value);
          if (checkbox.checked) {
            if (!selected.includes(stringValue)) {
              selected.push(stringValue);
            }
          } else {
            selected = selected.filter(v => v !== stringValue);
          }
          updateTags();
        });

        optionsContainer.appendChild(optionDiv);
      });
      console.log(`[POPULATE] [CALL #${callId}] Finished adding options. Container now has ${optionsContainer.children.length} children (including select-all + separator)`);
    }

    // Toggle dropdown
    function toggleDropdown() {
      if (!dropdown) {
        console.error('[MULTI-SELECT] Dropdown element not found');
        return;
      }
      
      // Close all other open multi-selects on the page
      const allOpenDropdowns = document.querySelectorAll('.multi-select-options.open');
      allOpenDropdowns.forEach(openDropdown => {
        if (openDropdown !== dropdown) {
          openDropdown.classList.remove('open');
        }
      });
      
      dropdown.classList.toggle('open');
      if (dropdown.classList.contains('open')) {
        populateDropdown();
      }
    }

    // Close dropdown
    function closeDropdown() {
      dropdown.classList.remove('open');
    }

    // Event listeners - only attach on first initialization
    if (!alreadyInitialized) {
      if (!toggleBtn) {
        console.error('[MULTI-SELECT] Toggle button not found - cannot attach click handler');
      } else {
        // Make entire display area clickable to open dropdown
        const displayArea = container.querySelector('.multi-select-display');
        if (displayArea) {
          displayArea.addEventListener('click', (e) => {
            // Don't toggle if clicking on the X button to remove a tag
            if (e.target.classList.contains('multi-select-tag-remove')) {
              return;
            }
            e.stopPropagation();
            toggleDropdown();
          });
        }
      }

      container.addEventListener('click', (e) => {
        if (e.target.classList.contains('multi-select-tag-remove')) {
          e.preventDefault();
          e.stopPropagation();
          const value = e.target.dataset.value;
          selected = selected.filter(v => v !== value);
          updateTags();
        }
      });

      // Click outside to close
      document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
          closeDropdown();
        }
      });
    }

    // Mark as initialized to prevent double-initialization
    container.setAttribute('data-initialized', 'true');

    // Initial render
    updateTags();
    
    // Always populate the dropdown options (whether open or not)
    // This ensures the visible options are fresh after re-initialization from dependency changes
    populateDropdown();
    console.log(`[INIT-MULTI-SELECT] [CALL #${callId}] Initialization complete. Dropdown container now has ${dropdown.children.length} children`);
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
      update: updateOrgVariable,
      createOrUpdate: createOrUpdateOrgVariable,
      delete: deleteOrgVariableById
    },
    // Forms
    forms: {
      evaluateCondition,
      evaluateConditionalVisibility,
      validateForm,
      submitForm,
      onDependencyFieldChanged,
      getUrlParameter,
      getFormIdFromParent,
      detectUrlFormId,
      escapeHtml,
      formatTaskName,
      renderMultiSelectContainer,
      initializeDropdownMultiSelect,
      repopulateMultiSelectField
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
      escapeHtml,
      initializeMultiSelect,
      renderMultiSelectContainer,
      initializeDropdownMultiSelect,
      repopulateMultiSelectField,
      mapResultsToOptions,
      showWaitingMessage,
      showLoadingMessage,
      hideLoadingMessage,
      hideWaitingMessage,
      initializeDependentFields,
      areDependenciesMet,
      handleDependencyMet,
      updateDependentFields,
      getDependencyValues,
      processGraphQLDropdownVariables,
      loadGraphQLDropdownOptions
    },
    // GraphQL Operations
    graphqlOperations: {
      getAll: getGraphQLOperations,
      get: getGraphQLOperation
    },
    // Version
    version: '2.1.3'
  };
})();
// Make available globally
if (typeof window !== 'undefined') {
  window.RewstLib = RewstLib;
}