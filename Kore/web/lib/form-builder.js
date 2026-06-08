// Form Builder - Main JavaScript File
// ============================================

// Configuration
const ORG_ID = window.ORG_ID || '019176c2-059f-7391-afbc-97b201efbd93';

// ============================================
// FIELD CONFIGURATION
// ============================================
const fieldConfigs = [];

// ============================================
// ELEMENT TYPE DEFAULTS
// ============================================
// Common properties shared across multiple dropdown types
const DROPDOWN_COMMON_DEFAULTS = {
    multi_select: false,
    searchable: true,
    result_var: '',
    default_selector: 'default',
    label_field: '',
    value_field: ''
};

// Common data source/API properties
const DATA_SOURCE_DEFAULTS = {
    endpoint: '',
    method: 'GET',
    fields: '',
    conditions: '',
    childConditions: '',
    orderBy: '',
    pageAll: true,
    pageSize: 1000,
    page: 1,
    requestBody: '{}',
    timeout: 30000,
    flatten: true
};

// ============================================
// ELEMENT DEFINITIONS
// ============================================
const ELEMENT_DEFINITIONS = {
  
  // Fields that appear on ALL element types
  general: [
    { 
      name: 'field_name', 
      type: 'text', 
      info: 'Unique identifier for this field in the form configuration. Used internally for data storage and references.' 
    },
    { 
      name: 'field_displayname', 
      label: 'Display Name', 
      type: 'text', 
      info: 'The label text displayed to users for this field in the form.' 
    },
    { 
      name: 'description', 
      label: 'Description', 
      type: 'text', 
      info: 'Helper text displayed below or near the field to provide additional context to users.' 
    },
    {
      type: 'fieldGroup',
      fields: [
        { 
          name: 'hidden', 
          label: 'Hidden', 
          type: 'checkbox', 
          info: 'When checked, this field is not displayed to users but is still part of the form.' 
        },
        { 
          name: 'required', 
          label: 'Required', 
          type: 'checkbox', 
          info: 'When checked, users must provide a value for this field before submitting the form.' 
        },
      ]
    },
  ],

  // DROPDOWN PALETTE ELEMENT
  dropdown: {
    label: 'Dropdown',
    sections: [
    {
      type: 'fieldGroup',
      fields: [
        { 
          name: 'multi_select', 
          label: 'Multi Select', 
          type: 'checkbox',
          default_value: false,
          info: 'When checked, users can select multiple options instead of just one.' 
        },
        { 
          name: 'searchable', 
          label: 'Searchable', 
          type: 'checkbox',
          default_value: true,
          info: 'When checked, displays a search box to filter options as users type.' 
        },
      ]
    },
    { 
      name: 'dropdown_type', 
      label: 'Dropdown Type', 
      type: 'select',
      options: ['dropdown_static', 'dropdown_workflow', 'dropdown_sql', 'dropdown_plugin', 'dropdown_prefetch'],
      info: 'Determines the source of options: Static (manual), Workflow (from workflow output), SQL Query (from database), Plugin (from plugin output), or Pre-fetched Data (from data retrieval).'
    },
    {
      type: 'conditionalGroup',
      field: 'dropdown_type',
      conditions: {
        'dropdown_static': [{ type: 'reference', ref: 'dropdown_static', excludeFields: ['dynamicDataDropdownFields'] }],
        'dropdown_workflow': [{ type: 'reference', ref: 'dropdown_workflow', excludeFields: ['dynamicDataDropdownFields'] }],
        'dropdown_sql': [{ type: 'reference', ref: 'dropdown_sql', excludeFields: ['dynamicDataDropdownFields'] }],
        'dropdown_plugin': [{ type: 'reference', ref: 'dropdown_plugin', excludeFields: ['dynamicDataDropdownFields'] }],
        'dropdown_prefetch': [{ type: 'reference', ref: 'dropdown_prefetch', excludeFields: ['dynamicDataDropdownFields'] }],
      }
    },
    ],
  },

  // DYNAMIC DATA DROPDOWN FIELDS (reusable for workflow, sql, plugin, prefetch)
  dynamicDataDropdownFields: [
    { 
      name: 'label_field', 
      label: 'Label Field', 
      type: 'text',
      info: 'The property name in your data that contains the text displayed to users.' 
    },
    { 
      name: 'value_field', 
      label: 'Value Field', 
      type: 'text',
      info: 'The property name in your data that is stored when the option is selected.' 
    },
    { 
      name: 'default_selector', 
      label: 'Default Selector', 
      type: 'text',
      info: 'The property name in your data that indicates which record(s) should be selected by default. Should be a boolean field (true/false). In multi-select mode, multiple records can have this field set to true.' 
    },
    { 
      name: 'tree_view', 
      label: 'Tree View', 
      type: 'checkbox',
      default_value: false,
      info: 'Enable to display data as a hierarchical tree structure instead of a flat list.' 
    },
    { 
      name: 'parent_field', 
      label: 'Parent Field', 
      type: 'text',
      condition: 'tree_view',
      info: 'The property name in your data that contains the parent item\'s identifier. Used to build the tree hierarchy by linking children to parents.' 
    },
    { 
      name: 'level_field', 
      label: 'Level Field', 
      type: 'text',
      condition: 'tree_view',
      info: 'The property name in your data that contains the depth/level value. Used to determine indentation and nesting in the tree display. Example: if your data has {id: 1, name: "Item", level: 0}, then "level" is the level field.' 
    },
  ],

  // DROPDOWN TYPE: STATIC
  dropdown_static: {
    sections: [
      { 
        type: 'area', 
        renderer: 'buildDropdownStaticFields'
      },
    ],
  },

  // DROPDOWN TYPE: WORKFLOW
  dropdown_workflow: {
    sections: [
      { 
        type: 'area', 
        renderer: 'buildWorkflowSelector',
      },
      { 
        type: 'area', 
        renderer: 'buildWorkflowInputs',
      },
      { 
        type: 'area', 
        renderer: 'buildWorkflowOutputs',
      },
      { type: 'reference', ref: 'dynamicDataDropdownFields' },
    ],
  },

  // DROPDOWN TYPE: SQL
  dropdown_sql: {
    sections: [
      { 
        type: 'area', 
        renderer: 'buildSQLSelector',
      },
      { 
        type: 'area', 
        renderer: 'buildDropdownSqlFields',
      },
      { type: 'reference', ref: 'dynamicDataDropdownFields' },
    ],
  },

  // DROPDOWN TYPE: PLUGIN
  dropdown_plugin: {
    sections: [
      { 
        type: 'area', 
        renderer: 'buildPluginSelector',
      },
      { 
        type: 'area', 
        renderer: 'buildPluginTaskSection',
      },
      { type: 'reference', ref: 'dynamicDataDropdownFields' },
    ],
  },

  // DROPDOWN TYPE: PREFETCH (Pre-fetched Data)
  dropdown_prefetch: {
    sections: [
      { 
        name: 'result_var', 
        label: 'Results Variable Name', 
        type: 'text',
        info: 'Variable name for storing this dropdown\'s selected result(s).' 
      },
      { 
        type: 'area', 
        renderer: 'buildDropdownPrefetchFields',
      },
      { type: 'reference', ref: 'dynamicDataDropdownFields' },
    ],
  },

  // DATA RETRIEVAL ELEMENT
  data_retrieval: {
    label: 'Data Retrieval',
    sections: [
      { 
        name: 'data_source_type', 
        label: 'Data Source Type', 
        type: 'select',
        options: ['Workflow', 'SQL', 'Plugin'],
        info: 'Choose how data is retrieved: Workflow (workflow output), SQL Query (database query), or Plugin (plugin output).'
      },
      { 
        type: 'conditionalGroup',
        field: 'data_source_type',
        conditions: {
          'Workflow': [{ type: 'reference', ref: 'dropdown_workflow', excludeFields: ['dynamicDataDropdownFields'] }],
          'SQL': [{ type: 'reference', ref: 'dropdown_sql', excludeFields: ['dynamicDataDropdownFields'] }],
          'Plugin': [{ type: 'reference', ref: 'dropdown_plugin', excludeFields: ['dynamicDataDropdownFields'] }],
        }
      },
      { 
        type: 'info',
        text: 'Data will be stored in page variable: {field_name}'
      },
    ],
  },

  // ARRAY ELEMENT
  array: {
    label: 'Array',
    sections: [
      { 
        type: 'area', 
        renderer: 'buildArrayFields',
      },
    ],
  },

  // CHECKBOX ELEMENT
  checkbox: {
    label: 'Checkbox',
    sections: [
      { 
        name: 'default_checked', 
        label: 'Default Checked',
        type: 'checkbox',
        default_value: false,
        info: 'Whether this checkbox should be checked by default when the form loads.' 
      },
    ],
  },

  // DATE_TIME ELEMENT
  date_time: {
    label: 'Date / Time',
    sections: [
      { 
        name: 'include_time', 
        label: 'Include Time',
        type: 'checkbox',
        default_value: false,
        info: 'Enable to include time selection in addition to date selection.' 
      },
    ],
  },

  // DATATABLE ELEMENT
  datatable: {
    label: 'Datatable',
    sections: [
      { 
        name: 'data_variable', 
        label: 'Data Variable', 
        type: 'text',
        info: 'Path to the JSON array to display. Use dot notation for nested structures (e.g., "ad_users" or "data.users").' 
      },
      { 
        name: 'list_view', 
        label: 'List View', 
        type: 'checkbox',
        default_value: false,
        info: 'Enable for list format, disable for table format.' 
      },
    ],
  },

  // FORM_EXTEND ELEMENT
  form_extend: {
    label: 'Form Extend',
    sections: [
      { 
        type: 'area',
        renderer: 'buildFormExtendSelector'
      },
    ],
  },

  // HTML ELEMENT
  html: {
    label: 'HTML',
    sections: [
      { 
        type: 'area',
        renderer: 'buildHtmlContentField'
      },
    ],
  },

  // RADIO ELEMENT
  radio: {
    label: 'Radio',
    sections: [
      { 
        type: 'area',
        renderer: 'buildRadioOptions'
      },
      { 
        name: 'horiz', 
        label: 'Horizontal', 
        type: 'checkbox',
        default_value: false,
        info: 'Display radio buttons horizontally instead of vertically.' 
      },
    ],
  },

  // TEXT ELEMENT
  text: {
    label: 'Text',
    sections: [
      { 
        name: 'default_value', 
        label: 'Default Value', 
        type: 'text',
      },
    ],
  },

  // TEXTAREA ELEMENT
  textarea: {
    label: 'Textarea',
    sections: [
      { 
        name: 'default_value', 
        label: 'Default Value', 
        type: 'textarea',
      },
    ],
  },
};

const ELEMENT_TYPES = Object.keys(ELEMENT_DEFINITIONS).filter(key => ELEMENT_DEFINITIONS[key].label);

// ============================================
// NEW SETTINGS PANEL BUILDER (Not yet hooked up)
// ============================================
function buildElementSettingsPanel(fieldConfig) {
    const form = document.getElementById('settingsForm');
    if (!form) {
        console.error('[SETTINGS] settingsForm not found');
        return;
    }
    
    // Clear form
    form.innerHTML = '';
    
    // Store original for change detection
    originalElementSettings = JSON.parse(JSON.stringify(fieldConfig));
    
    // 1. Always start with general fields
    renderSections(ELEMENT_DEFINITIONS.general, fieldConfig);
    
    // 2. Add element-specific sections
    const elementDef = ELEMENT_DEFINITIONS[fieldConfig.type];
    if (elementDef?.sections) {
        renderSections(elementDef.sections, fieldConfig);
    }
    
    // 3. Add Dependencies and Conditions buttons at the end
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = 'display: flex; flex-direction: column; gap: 10px; margin-top: 20px;';
    
    const dependenciesBtn = document.createElement('button');
    dependenciesBtn.type = 'button';
    dependenciesBtn.className = 'btn';
    dependenciesBtn.setAttribute('data-color', 'blue');
    dependenciesBtn.setAttribute('data-size', 'sm');
    dependenciesBtn.style.width = '100%';
    dependenciesBtn.textContent = 'Dependent Fields';
    dependenciesBtn.id = 'dependentFieldsBtn';
    
    const conditionsBtn = document.createElement('button');
    conditionsBtn.type = 'button';
    conditionsBtn.className = 'btn';
    conditionsBtn.setAttribute('data-color', 'blue');
    conditionsBtn.setAttribute('data-size', 'sm');
    conditionsBtn.style.width = '100%';
    conditionsBtn.textContent = 'Show/Hide Conditions';
    conditionsBtn.id = 'setConditionsBtn';
    
    buttonContainer.appendChild(dependenciesBtn);
    buttonContainer.appendChild(conditionsBtn);
    form.appendChild(buttonContainer);
    
    console.log('[SETTINGS] Panel built for element type:', fieldConfig.type);
}

function renderSections(sections, fieldConfig) {
    if (!sections) return;
    
    // Handle both arrays and single section references
    const sectionArray = Array.isArray(sections) ? sections : [sections];
    
    sectionArray.forEach(section => {
        if (!section) return;
        
        // Handle area renderer
        if (section.type === 'area') {
            const rendererFn = window[section.renderer];
            if (typeof rendererFn === 'function') {
                const result = rendererFn(fieldConfig);
                // If the renderer returns an HTML string, create a container for it
                if (typeof result === 'string') {
                    const container = document.createElement('div');
                    container.innerHTML = result;
                    const form = document.getElementById('settingsForm');
                    if (form) {
                        form.appendChild(container);
                    }
                } else {
                    // Renderer is expected to handle DOM manipulation itself
                }
            } else {
                console.warn('[RENDERER] Area renderer not found:', section.renderer);
            }
        }
        // Handle reference to another section
        else if (section.type === 'reference') {
            const refDef = ELEMENT_DEFINITIONS[section.ref];
            if (refDef) {
                // Handle both definition objects (with .sections) and arrays
                const refSections = refDef.sections ? refDef.sections : refDef;
                renderSections(refSections, fieldConfig);
            } else {
                console.warn('[RENDERER] Referenced section not found:', section.ref);
            }
        }
        // Handle field group (multiple fields in one row)
        else if (section.type === 'fieldGroup') {
            const groupContainer = document.createElement('div');
            groupContainer.className = 'form-group--inline';
            
            section.fields.forEach(fieldDef => {
                const fieldValue = fieldConfig[fieldDef.name];
                
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.id = fieldDef.name;
                input.className = 'checkbox-input';
                input.checked = fieldValue || false;
                
                const label = document.createElement('label');
                label.htmlFor = fieldDef.name;
                label.innerHTML = fieldDef.label || fieldDef.name;
                
                if (fieldDef.info) {
                    label.innerHTML += infoIcon(fieldDef.info);
                    // Prevent checkbox toggle when clicking info icon, but allow document listener to handle tooltip
                    label.addEventListener('click', (e) => {
                        if (e.target.classList.contains('info-icon')) {
                            e.preventDefault();
                        }
                    });
                }
                
                // Wrap each checkbox/label pair
                const itemWrapper = document.createElement('div');
                itemWrapper.style.cssText = 'display: flex; align-items: center; gap: 4px; flex-shrink: 0;';
                
                // Set specific widths
                if (fieldDef.name === 'hidden' || fieldDef.name === 'multi_select') {
                    itemWrapper.style.width = '130px';
                } else {
                    itemWrapper.style.flex = '1';
                }
                
                itemWrapper.appendChild(input);
                itemWrapper.appendChild(label);
                
                groupContainer.appendChild(itemWrapper);
                
                input.addEventListener('change', () => {
                    fieldConfig[fieldDef.name] = input.checked;
                    showElementSettingsDirty();
                });
            });
            
            document.getElementById('settingsForm').appendChild(groupContainer);
        }
        // Handle conditional group
        else if (section.type === 'conditionalGroup') {
            const fieldValue = fieldConfig[section.field];
            const conditionSections = section.conditions[fieldValue];
            
            // Create a wrapper to mark this conditional group for later removal
            const conditionalWrapper = document.createElement('div');
            conditionalWrapper.setAttribute('data-conditional-group', section.field);
            
            // Temporarily replace form append to capture rendered content
            const form = document.getElementById('settingsForm');
            const originalAppendChild = form.appendChild;
            const wrappedElements = [];
            
            // Redirect appendChild to collect elements
            form.appendChild = function(el) {
                wrappedElements.push(el);
                return el;
            };
            
            // Render the conditional sections
            if (conditionSections) {
                renderSections(conditionSections, fieldConfig);
            }
            
            // Restore appendChild
            form.appendChild = originalAppendChild;
            
            // Add collected elements to wrapper
            wrappedElements.forEach(el => conditionalWrapper.appendChild(el));
            
            // Append the wrapper
            form.appendChild(conditionalWrapper);
        }
        // Handle info block
        else if (section.type === 'info') {
            const infoDiv = document.createElement('div');
            infoDiv.style.cssText = `
                padding: 12px;
                background: rgba(102, 126, 234, 0.1);
                border: 1px solid rgba(102, 126, 234, 0.3);
                border-radius: 4px;
                font-size: 12px;
                color: #ffffff;
                margin-bottom: 15px;
            `;
            infoDiv.textContent = section.text;
            document.getElementById('settingsForm').appendChild(infoDiv);
        }
        // Handle simple field
        else if (section.name) {
            renderField(section, fieldConfig);
        }
    });
}

function renderField(fieldDef, fieldConfig) {
    const form = document.getElementById('settingsForm');
    if (!form) return;
    
    // Check if field has a condition and if it's not met, skip rendering
    if (fieldDef.condition && !fieldConfig[fieldDef.condition]) {
        return;
    }
    
    const fieldValue = fieldConfig[fieldDef.name];
    let input;
    
    // Handle checkbox separately since it has different structure
    if (fieldDef.type === 'checkbox') {
        const container = document.createElement('div');
        container.className = 'form-group--inline';
        
        input = document.createElement('input');
        input.type = 'checkbox';
        input.id = fieldDef.name;
        input.className = 'checkbox-input';
        input.checked = fieldValue || false;
        
        const labelContainer = document.createElement('label');
        labelContainer.htmlFor = fieldDef.name;
        labelContainer.innerHTML = (fieldDef.label || fieldDef.name);
        
        // Add info icon if provided
        if (fieldDef.info) {
            labelContainer.innerHTML += infoIcon(fieldDef.info);
            // Prevent checkbox toggle when clicking info icon, but allow document listener to handle tooltip
            labelContainer.addEventListener('click', (e) => {
                if (e.target.classList.contains('info-icon')) {
                    e.preventDefault();
                }
            });
        }
        
        container.appendChild(input);
        container.appendChild(labelContainer);
        form.appendChild(container);
        
        input.addEventListener('change', () => {
            fieldConfig[fieldDef.name] = input.checked;
            showElementSettingsDirty();
            
            // Special handling for tree_view: re-render conditional fields
            if (fieldDef.name === 'tree_view') {
                const elementDef = ELEMENT_DEFINITIONS[fieldConfig.type];
                if (elementDef?.sections) {
                    elementDef.sections.forEach(section => {
                        // Find dynamicDataDropdownFields reference
                        if (section.type === 'reference' && section.ref === 'dynamicDataDropdownFields') {
                            // Get the parent_field and level_field definitions
                            const dynamicFields = ELEMENT_DEFINITIONS.dynamicDataDropdownFields;
                            if (Array.isArray(dynamicFields)) {
                                dynamicFields.forEach(fieldDef => {
                                    if ((fieldDef.name === 'parent_field' || fieldDef.name === 'level_field') && fieldDef.condition === 'tree_view') {
                                        // Remove existing field if it exists
                                        const existingField = form.querySelector(`#${fieldDef.name}`);
                                        if (existingField && existingField.parentElement) {
                                            existingField.parentElement.remove();
                                        }
                                        
                                        // Re-render the field
                                        renderField(fieldDef, fieldConfig);
                                    }
                                });
                            }
                        }
                    });
                }
            }
        });
        
        return;
    }
    
    // For non-checkbox fields, use formGroup structure
    const formGroup = document.createElement('div');
    formGroup.className = 'form-group';
    
    // Create label
    const label = document.createElement('label');
    label.style.cssText = 'display: inline-flex; align-items: center; gap: 6px;';
    label.innerHTML = (fieldDef.label || fieldDef.name);
    
    // Add info icon if provided
    if (fieldDef.info) {
        label.innerHTML += infoIcon(fieldDef.info);
    }
    
    formGroup.appendChild(label);
    
    // Create input based on type
    if (fieldDef.type === 'select') {
        input = document.createElement('select');
        input.id = fieldDef.name;
        input.className = 'settings-field';
        
        // Add empty option for dropdown_type
        if (fieldDef.name === 'dropdown_type') {
            const emptyOption = document.createElement('option');
            emptyOption.value = '';
            emptyOption.textContent = '-- Select Type --';
            emptyOption.selected = !fieldValue;  // Select if no value
            input.appendChild(emptyOption);
        }
        
        if (fieldDef.options) {
            fieldDef.options.forEach(optValue => {
                const option = document.createElement('option');
                option.value = optValue;
                option.textContent = optValue;
                option.selected = fieldValue === optValue;
                input.appendChild(option);
            });
        }
        
        formGroup.appendChild(input);
        
        // Special handling for dropdown_type field
        if (fieldDef.name === 'dropdown_type') {
            input.addEventListener('change', () => {
                console.log('[dropdown_type change] Selected:', input.value);
                fieldConfig[fieldDef.name] = input.value;
                showElementSettingsDirty();
                
                // Re-render the conditionalGroup for this field
                const elementDef = ELEMENT_DEFINITIONS[fieldConfig.type];
                console.log('[dropdown_type change] elementDef:', elementDef);
                if (elementDef?.sections) {
                    // Find and re-render the conditionalGroup section
                    elementDef.sections.forEach(section => {
                        console.log('[dropdown_type change] Checking section:', section.type, section.field);
                        if (section.type === 'conditionalGroup' && section.field === 'dropdown_type') {
                            console.log('[dropdown_type change] Found conditionalGroup');
                            const form = document.getElementById('settingsForm');
                            
                            // Remove old conditional content
                            const oldConditionalContent = form.querySelector('[data-conditional-group="dropdown_type"]');
                            console.log('[dropdown_type change] Old content to remove:', oldConditionalContent);
                            if (oldConditionalContent) {
                                oldConditionalContent.remove();
                            }
                            
                            // Re-render the conditional group
                            const fieldValue = fieldConfig[section.field];
                            console.log('[dropdown_type change] fieldValue:', fieldValue, 'conditions:', section.conditions);
                            const conditionSections = section.conditions[fieldValue];
                            console.log('[dropdown_type change] conditionSections:', conditionSections);
                            if (conditionSections) {
                                // Create a wrapper div for the new conditional content
                                const conditionalWrapper = document.createElement('div');
                                conditionalWrapper.setAttribute('data-conditional-group', 'dropdown_type');
                                
                                // Redirect appendChild to collect the new content
                                const originalAppendChild = form.appendChild;
                                const newElements = [];
                                
                                form.appendChild = function(el) {
                                    newElements.push(el);
                                    return el;
                                };
                                
                                renderSections(conditionSections, fieldConfig);
                                
                                // Restore appendChild
                                form.appendChild = originalAppendChild;
                                
                                // Add collected elements to wrapper
                                newElements.forEach(el => conditionalWrapper.appendChild(el));
                                
                                // Find the first button to insert before
                                const firstButton = form.querySelector('button[id*="Btn"]');
                                if (firstButton) {
                                    // Insert wrapper before the buttons
                                    firstButton.parentElement.insertBefore(conditionalWrapper, firstButton);
                                } else {
                                    // Fallback: just append if no buttons found
                                    form.appendChild(conditionalWrapper);
                                }
                            }
                        }
                    });
                }
            });
        }
    }
    else if (fieldDef.type === 'textarea') {
        input = document.createElement('textarea');
        input.id = fieldDef.name;
        input.className = 'settings-field';
        input.style.cssText = 'margin-top: 2px; width: 100%; height: 80px; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: monospace;';
        input.value = fieldValue || '';
        input.placeholder = fieldDef.placeholder || '';
        
        formGroup.appendChild(input);
    }
    else { // text, or default
        input = document.createElement('input');
        input.type = 'text';
        input.id = fieldDef.name;
        input.className = 'settings-field';
        input.style.cssText = 'margin-top: 2px; width: 100%;';
        input.value = fieldValue || '';
        input.placeholder = fieldDef.placeholder || '';
        
        formGroup.appendChild(input);
    }
    
    // Attach change listener
    if (input && fieldDef.name !== 'dropdown_type') {
        input.addEventListener('input', () => {
            fieldConfig[fieldDef.name] = input.value;
            showElementSettingsDirty();
        });
    }
    
    form.appendChild(formGroup);
}

// ============================================
// HELPER: Info Icon with Tooltip
// ============================================
function infoIcon(explanation) {
    // Escape any quotes in the explanation for the data attribute
    const escaped = (explanation || '').replace(/"/g, '&quot;');
    return `<span class="info-icon" data-explanation="${escaped}" style="display: inline-block; width: 12px; height: 12px; margin-left: 6px; background: white; border-radius: 50%; border: 1px solid #667eea; color: #667eea; font-size: 12px; font-weight: bold; line-height: 12px; text-align: center; cursor: pointer; flex-shrink: 0;">?</span>`;
}

// ============================================
// ORG VARIABLE OPERATIONS
// ============================================
async function fetchExistingFormsList() {
    // TODO: Replace this logic with new implementation
    console.log('[FETCH FORMS] Disabled - awaiting replacement logic');
    return [];
}

// ============================================
// FETCH FORM CONFIG FROM DATABASE
// ============================================
async function getFormConfigFromDatabase(formId) {
    try {
        if (!formId) {
            console.error('[FETCH CONFIG] No form ID provided');
            return null;
        }

        const response = await fetch(`https://app.equinoxits.com:1139/kore/forms/${formId}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const definition = data.definition;

        if (!definition) {
            console.error('[FETCH CONFIG] No definition found in response');
            return null;
        }

        console.log('[FETCH CONFIG] Successfully retrieved form definition');
        return definition;
    } catch (error) {
        console.error('[FETCH CONFIG] Error fetching form:', error);
        return null;
    }
}

async function loadSqlDatasources() {
    try {
        const user = getUser();
        if (!user) return;
        const result = await executeSqlQuery(
            'cookie', user, 'kore_sys',
            `SELECT config FROM kore_sys.plugins WHERE name = 'sqlquery'`
        );
        const row = result?.result?.[0];
        const raw = row?.config;
        const config = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : null;
        sqlDatasources = config?.databases ? Object.keys(config.databases) : [];
        console.log('[SQL Datasources] Loaded:', sqlDatasources);
    } catch (err) {
        console.error('[SQL Datasources] Failed to load:', err);
        sqlDatasources = [];
    }
}


async function loadAvailableWorkflows() {
    try {
        const user = getUser();
        if (!user) return;
        const result = await executeSqlQuery(
            'cookie', user, 'kore_sys',
            `SELECT id, name, definition FROM kore_sys.workflows ORDER BY name`
        );
        availableWorkflows = (result?.result || []).map(w => ({
            ...w,
            definition: typeof w.definition === 'object' ? w.definition : JSON.parse(w.definition || '{}')
        }));
        console.log('[Workflows] Loaded:', availableWorkflows.map(w => w.name));
    } catch (err) {
        console.error('[Workflows] Failed to load:', err);
        availableWorkflows = [];
    }
}

// ============================================
// STATE VARIABLES
// ============================================
// Workflows and Forms
let availableWorkflows = []; // Cached workflows [{id, name, definition}]
let availableWorkflowsOG = [];
let loadedFormId = null;
let sqlDatasources = []; // Cached SQL datasource names from plugin config
let availablePlugins = []; // Cached plugins [{id, name, display_name}] for dropdown_plugin

// UI Elements
let columnsSelect = null;
let formColumnsSelect = null;
let formNameInput = null;
let settingsPanel = null;
let emptySettings = null;
let settingsForm = null;

// Form Configuration State
let droppedElementCount = {};
let selectedElementUid = null;
let originalElementSettings = null;
let elementUidCounter = 0;

// Temporary/Modal State
let currentElementQueryType = null;
let currentArrayFieldConfig = null;
let currentArrayItemForQuery = null;
let currentDependentFieldConfig = null;

// ============================================
// HELPER FUNCTIONS
// ============================================
// Generate a unique 5-character ID for form elements
function generateElementUid() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let uid = '';
    for (let i = 0; i < 5; i++) {
        uid += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return uid;
}

// ============================================
// Create a new field config with default values based on element type
function createFieldConfig(elementType, elementId, sequenceNumber, columnPosition, elementUid, baseName) {
    baseName = baseName || elementType;
    // Dropdown elements start with no subtype selected
    let configType = elementType === 'dropdown_workflow' ? '' : elementType;
    const defaults = {};
    
    // Initialize dropdown_type for dropdown elements
    if (configType === 'dropdown') {
        defaults.dropdown_type = '';
        defaults.multi_select = false;
        defaults.searchable = true;
    }
    
    const config = {
        uid: elementUid,
        field_name: elementId,
        field_displayname: `${baseName.charAt(0).toUpperCase() + baseName.slice(1).replace(/_/g, ' ')} ${droppedElementCount[baseName]}`,
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

// ============================================
// ATTACH EVENT LISTENERS TO FORM ELEMENTS
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
            
            // Check if there are unsaved changes in the element's settings
            const saveSettingsBtn = document.getElementById('saveSettings');
            if (selectedElementUid && saveSettingsBtn && saveSettingsBtn.style.display === 'flex') {
                console.log('Unsaved element settings detected, prompting user');
                // Get the field display name from originalElementSettings
                const fieldDisplayName = originalElementSettings ? originalElementSettings.field_displayname : 'Unknown';
                
                showUnsaved(
                    () => {
                        // onSave: Save current element settings then show new element
                        console.log('[ELEMENT-CLICK] User chose to save before switching elements');
                        const saveBtn = document.getElementById('saveSettings');
                        if (saveBtn && !saveBtn.disabled) {
                            saveBtn.click();
                        }
                        showElementSettings(element.dataset.uid);
                    },
                    () => {
                        // onDiscard: Just show new element without saving
                        console.log('User confirmed switch, discarding changes');
                        showElementSettings(element.dataset.uid);
                    }
                );
            } else {
                showElementSettings(element.dataset.uid);
            }
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
            
            // Use base.js showDeleteConfirm()
            showDeleteConfirm('This field will be permanently removed from the form.', () => {
                fieldConfigs.splice(fieldConfigs.findIndex(f => f.uid === currentUid), 1);
                element.remove();
                
                // Update sequences after deletion
                updateElementSequences();
                
                // Mark form as changed
                markFormChanged();
                
                if (selectedElementUid === currentUid) {
                    closeElementSettings();
                }
            });
        });
    }
}

// ============================================
// FORM CHANGE HELPER
// ============================================
function markFormChanged() {
    checkUnsavedChanges(buildFormConfig());
    updateSaveButtonState();
}

// ============================================
// UPDATE SAVE BUTTON STATE
// ============================================
function updateSaveButtonState() {
    const saveFormBtn = document.getElementById('saveFormBtn');
    
    // Guard: only run if the save button exists and critical objects are initialized
    if (!saveFormBtn || typeof fieldConfigs === 'undefined') return;
    
    // Get form name
    const formName = formNameInput ? formNameInput.value.trim() : '';
    const hasElements = fieldConfigs.length > 0;
    
    // Simple validation: form needs a name, at least one element, and unsaved changes
    const canSave = formName !== '' && hasElements && hasUnsavedChanges();
    
    saveFormBtn.disabled = !canSave;
}

// ============================================
// INITIALIZE ELEMENT PALETTE
// ============================================
/**
 * Creates draggable element cards from palette configuration
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
        
        // Create draggable element for each type in ELEMENT_DEFINITIONS with a label, sorted alphabetically
        const paletteEntries = Object.entries(ELEMENT_DEFINITIONS)
            .filter(([key, def]) => def.label)  // Only elements with a label (palette items)
            .map(([key, def]) => [key, def.label])
            .sort((a, b) => a[1].localeCompare(b[1]));  // Sort by display name (a[1], b[1])
        
        console.log('[INIT] Creating palette with', paletteEntries.length, 'elements');
        
        paletteEntries.forEach(([type, displayName]) => {
            const element = document.createElement('div');
            element.className = 'btn';
            element.setAttribute('draggable', 'true');
            element.setAttribute('data-type', type);
            element.setAttribute('data-size', 'sm');
            element.textContent = displayName;
            
            container.appendChild(element);
        });
        
        console.log('[INIT] Element palette populated with', paletteEntries.length, 'elements (sorted alphabetically)');
    } catch (error) {
        console.error('[INIT] Error initializing element palette:', error);
    }
}

// ============================================
// DRAG AND DROP SYSTEM
// ============================================
function initializeDragAndDrop() {
    if (!leftFormColumn) {
        console.error('[DND] Column elements not found in DOM');
        return;
    }
    
    const dropZones = [
        leftFormColumn,
        rightFormColumn,
        thirdFormColumn,
        document.getElementById('topSpanningZone'),
        document.getElementById('bottomSpanningZone')
    ].filter(zone => zone !== null);
    
    console.log('[DND] Initializing drag and drop for', dropZones.length, 'zones');
    
    // Setup palette element drag
    setupPaletteDragHandlers();
    
    // Setup drop zones
    dropZones.forEach(zone => {
        setupDropZoneHandlers(zone);
    });
}

function setupPaletteDragHandlers() {
    const container = document.getElementById('elementPaletteContainer');
    if (!container) return;
    
    // Delegation: single listener handles all palette elements
    container.addEventListener('dragstart', (e) => {
        if (!e.target.hasAttribute('data-type')) return;
        
        const elementType = e.target.getAttribute('data-type');
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', elementType);
        e.dataTransfer.setData('application/x-element-type', elementType);
        e.target.style.opacity = '0.6';
        
        console.log('[DND] Dragging palette element:', elementType);
    });
    
    container.addEventListener('dragend', (e) => {
        if (e.target.hasAttribute('data-type')) {
            e.target.style.opacity = '1';
        }
    });
}

function setupDropZoneHandlers(zone) {
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Set drop effect based on what's being dragged
        const types = Array.from(e.dataTransfer.types);
        e.dataTransfer.dropEffect = types.includes('elementuid') ? 'move' : 'copy';
        
        // Visual feedback
        zone.style.background = 'rgba(102, 126, 234, 0.15)';
        zone.style.borderColor = '#667eea';
        
        // Move existing element to show where it will land
        if (types.includes('elementuid')) {
            const draggingElement = document.querySelector('[data-uid][style*="opacity"]');
            if (draggingElement && draggingElement.style.opacity === '0.5') {
                zone.appendChild(draggingElement);
            }
        }
    });
    
    zone.addEventListener('dragleave', (e) => {
        // Only reset if actually leaving the zone (not entering child)
        const rect = zone.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right ||
            e.clientY < rect.top || e.clientY > rect.bottom) {
            zone.style.background = 'transparent';
            zone.style.borderColor = '#666';
        }
    });
    
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Reset styling
        zone.style.background = 'transparent';
        zone.style.borderColor = '#666';
        
        // Handle element move (existing field)
        const elementuid = e.dataTransfer.getData('elementuid');
        if (elementuid) {
            handleElementMove(elementuid, zone);
            return;
        }
        
        // Handle new element drop (from palette)
        let elementType = e.dataTransfer.getData('text/plain') ||
                         e.dataTransfer.getData('application/x-element-type');
        
        if (!elementType) {
            console.error('[DND] No element type in drop data');
            return;
        }
        
        handleNewElementDrop(elementType, zone);
    });
}

function handleNewElementDrop(elementType, zone) {
    // Dropdown subtypes all share the 'dropdown' counter and naming
    const baseName = elementType === 'dropdown_workflow' ? 'dropdown' : elementType;

    // Track element count
    if (!droppedElementCount[baseName]) {
        droppedElementCount[baseName] = 0;
    }
    droppedElementCount[baseName]++;
    
    // Determine column position based on zone
    let columnPosition = 1; // default to left column
    if (zone === rightFormColumn) {
        columnPosition = 2;
    } else if (zone === thirdFormColumn) {
        columnPosition = 3;
    } else if (zone.id === 'topSpanningZone') {
        columnPosition = 0;
    } else if (zone.id === 'bottomSpanningZone') {
        columnPosition = 99;
    }
    
    // Create field config
    const elementId = `${baseName}_${droppedElementCount[baseName]}`;
    const elementUid = generateElementUid();
    const elementsInColumn = fieldConfigs.filter(f => f.column === columnPosition).length;
    const sequenceNumber = elementsInColumn + 1;
    
    const fieldConfig = createFieldConfig(elementType, elementId, sequenceNumber, columnPosition, elementUid, baseName);
    fieldConfigs.push(fieldConfig);
    
    // Create and add visual element
    const visualElement = createFormElementVisual(fieldConfig);
    zone.appendChild(visualElement);
    
    // Attach listeners
    attachElementEventListeners(visualElement);
    
    // Update state and mark as changed
    markFormChanged();
    
    console.log('[DND] Added element:', elementType, 'uid:', elementUid, 'column:', columnPosition);
}

function handleElementMove(elementuid, targetZone) {
    const fieldConfig = fieldConfigs.find(f => f.uid === elementuid);
    if (!fieldConfig) return;
    
    // Determine new column position based on target zone
    let columnPosition = 1; // default to left column
    if (targetZone === rightFormColumn) {
        columnPosition = 2;
    } else if (targetZone === thirdFormColumn) {
        columnPosition = 3;
    } else if (targetZone.id === 'topSpanningZone') {
        columnPosition = 0;
    } else if (targetZone.id === 'bottomSpanningZone') {
        columnPosition = 99;
    }
    
    // Update if column changed
    if (fieldConfig.column !== columnPosition) {
        console.log('[DND] Moved element to column', columnPosition);
        fieldConfig.column = columnPosition;
    }
}

function createFormElementVisual(fieldConfig) {
    const element = document.createElement('div');
    element.className = 'btn';
    element.setAttribute('data-size', 'sm');
    element.draggable = true;
    element.dataset.uid = fieldConfig.uid;
    element.dataset.fieldName = fieldConfig.field_name;
    element.style.cursor = 'move';
    element.style.margin = '6px 0';
    
    const displayLabel = fieldConfig.field_displayname?.trim() || fieldConfig.field_name;
    element.innerHTML = `
        <span style="flex: 1; text-align: center;">${displayLabel}</span>
        <button style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0; margin-left: 10px;">×</button>
    `;
    
    return element;
}

// ============================================
// UPDATE ELEMENT SEQUENCES
// ============================================
function updateElementSequences() {
    console.log('[DND] Updating element sequences based on DOM order...');
    
    const topSpanningZone = document.getElementById('topSpanningZone');
    const bottomSpanningZone = document.getElementById('bottomSpanningZone');
    
    const columns = [
        { element: topSpanningZone, number: 0 },
        { element: leftFormColumn, number: 1 },
        { element: rightFormColumn, number: 2 },
        { element: thirdFormColumn, number: 3 },
        { element: bottomSpanningZone, number: 99 }
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
                    console.log(`[DND] Updated ${fieldConfig.field_name} to column ${newColumn} seq ${newSequence}`);
                    fieldConfig.column = newColumn;
                    fieldConfig.sequence = newSequence;
                }
            }
        });
    });
}

// ============================================
// ELEMENT SETTINGS PANEL
// ============================================
function showElementSettings(elementUid) {
    selectedElementUid = elementUid;
    
    const fieldConfig = fieldConfigs.find(f => f.uid === elementUid);
    if (!fieldConfig) return;
    
    // Show settings panel
    settingsPanel.style.display = 'block';
    emptySettings.style.display = 'none';
    document.getElementById('closeSettings').style.display = 'block';
    document.getElementById('saveSettings').style.display = 'none';
    
    // Build new settings panel
    buildElementSettingsPanel(fieldConfig);
    
    // Attach button listeners
    const dependenciesBtn = document.getElementById('dependentFieldsBtn');
    const conditionsBtn = document.getElementById('setConditionsBtn');
    
    if (dependenciesBtn) {
        dependenciesBtn.addEventListener('click', saveDependentFields);
    }
    
    if (conditionsBtn) {
        conditionsBtn.addEventListener('click', () => {
            console.log('[TODO] Show/Hide Conditions modal');
            // TODO: Implement conditions modal
        });
    }
}

function buildCommonFields(fieldConfig) {
    return `
        <div class="form-group">
            <label>Field Name${infoIcon('Unique identifier for this field in the form configuration. Used internally for data storage and references.')}</label>
            <input type="text" id="field_name" value="${fieldConfig.field_name}" class="settings-field">
        </div>
        
        ${fieldConfig.type !== 'form_extend' && fieldConfig.type !== 'horizontal_line' ? `
        <div class="form-group">
            <label>Display Name${infoIcon('The label text displayed to users for this field in the form.')}</label>
            <input type="text" id="field_displayname" value="${fieldConfig.field_displayname || ''}" class="settings-field">
        </div>
        
        <div class="form-group">
            <label>Description${infoIcon('Helper text displayed below or near the field to provide additional context to users.')}</label>
            <input type="text" id="description" value="${fieldConfig.description || ''}" class="settings-field">
        </div>
        ` : ''}
        
        ${fieldConfig.type !== 'form_extend' && fieldConfig.type !== 'horizontal_line' && fieldConfig.type !== 'html' && fieldConfig.type !== 'date_time' ? `
        <div class="form-group--inline">
            <input type="checkbox" id="hidden" ${fieldConfig.hidden ? 'checked' : ''} class="settings-field">
            <label for="hidden">Hidden${infoIcon('When checked, this field is not displayed to users but is still part of the form.')}</label>
        </div>
        
        <div class="form-group--inline">
            <input type="checkbox" id="required" ${fieldConfig.required ? 'checked' : ''} class="settings-field">
            <label for="required">Required${infoIcon('When checked, users must provide a value for this field before submitting the form.')}</label>
        </div>
        ` : ''}
    `;
}

function buildRadioFields(fieldConfig) {
    const options = fieldConfig.options || {};
    let optionsHtml = `
        <div class="form-group">
            <label>Options${infoIcon('List of radio button options. Each option has a label (displayed to users) and a value (stored in data).')}</label>
            <div id="radioOptionsList" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;">
    `;
    
    Object.entries(options).forEach(([key, value], idx) => {
        optionsHtml += `
            <div style="display: flex; gap: 8px; align-items: center;">
                <input type="text" placeholder="Label" value="${key}" class="settings-field" style="flex: 1;" data-option-type="radio" data-option-idx="${idx}" data-option-field="label">
                <input type="text" placeholder="Value" value="${value}" class="settings-field" style="flex: 1;" data-option-type="radio" data-option-idx="${idx}" data-option-field="value">
                <button type="button" class="btn" data-color="red" data-size="sm" style="padding: 6px 12px;" onclick="this.parentElement.remove();">Remove</button>
            </div>
        `;
    });
    
    optionsHtml += `
            </div>
            <button type="button" id="addRadioOptionBtn" class="btn" data-color="blue" data-size="sm">Add Option</button>
        </div>
        
        <div class="form-group">
            <label>Default Select${infoIcon('The option that should be selected by default when the form loads. Leave empty for no default selection.')}</label>
            <select id="default_select" class="settings-field">
                <option value="">-- None --</option>
    `;
    
    Object.keys(options).forEach(key => {
        const selected = fieldConfig.default_select === key ? 'selected' : '';
        optionsHtml += `<option value="${key}" ${selected}>${key}</option>`;
    });
    
    optionsHtml += `
            </select>
        </div>
        
        <div class="form-group--inline">
            <input type="checkbox" id="radio_horiz" ${fieldConfig.horiz ? 'checked' : ''} class="settings-field">
            <label for="radio_horiz">Horizontal Layout${infoIcon('When checked, radio buttons are displayed horizontally. When unchecked, they stack vertically.')}</label>
        </div>
    `;
    
    return optionsHtml;
}

function buildCheckboxFields(fieldConfig) {
    return `
        <div class="form-group--inline">
            <input type="checkbox" id="default_checked" ${fieldConfig.default_checked ? 'checked' : ''} class="settings-field">
            <label for="default_checked">Default Checked${infoIcon('When checked, this checkbox is marked by default when the form loads.')}</label>
        </div>
    `;
}

function buildDependentFieldsButton(fieldConfig) {
    const currentDependantFieldsObj = fieldConfig.dependant_fields || {};
    const currentDependantFields = Object.keys(currentDependantFieldsObj);
    const buttonText = currentDependantFields.length > 0 ? 
        currentDependantFields.length + ' field(s) selected' : 
        'Select dependent fields...';
    
    return `
        <button type="button" id="editDependentFieldsBtn" class="btn" data-color="blue" data-size="sm" style="width: 100%;">
            ${buttonText}
        </button>
    `;
}

function buildConditionsFields(fieldConfig) {
    return `
        <div id="conditions_container">
            <div class="form-group">
                <label style="display: inline-flex; align-items: center;">Condition 1${infoIcon('Condition expression to evaluate. Example: field_name=value or field_name>10')}</label>
                <input type="text" id="condition_1" value="${fieldConfig.condition_1 || ''}" class="settings-field" placeholder="e.g., field_name=value">
            </div>
            
            <div class="form-group">
                <label style="display: inline-flex; align-items: center;">Condition 1 Action${infoIcon('What to do when Condition 1 is true: Show (display field) or Hide (conceal field).')}</label>
                <select id="condition_1_action" class="settings-field">
                    <option value="">-- None --</option>
                    <option value="show" ${fieldConfig.condition_1_action === 'show' ? 'selected' : ''}>Show</option>
                    <option value="hide" ${fieldConfig.condition_1_action === 'hide' ? 'selected' : ''}>Hide</option>
                </select>
            </div>
            
            <div class="form-group">
                <label style="display: inline-flex; align-items: center;">Condition 2${infoIcon('Optional second condition. Evaluated alongside Condition 1.')}</label>
                <input type="text" id="condition_2" value="${fieldConfig.condition_2 || ''}" class="settings-field" placeholder="e.g., field_name=value">
            </div>
            
            <div class="form-group">
                <label style="display: inline-flex; align-items: center;">Condition 2 Action${infoIcon('What to do when Condition 2 is true: Show (display field) or Hide (conceal field).')}</label>
                <select id="condition_2_action" class="settings-field">
                    <option value="">-- None --</option>
                    <option value="show" ${fieldConfig.condition_2_action === 'show' ? 'selected' : ''}>Show</option>
                    <option value="hide" ${fieldConfig.condition_2_action === 'hide' ? 'selected' : ''}>Hide</option>
                </select>
            </div>
        </div>
    `;
}

function buildTextFields(fieldConfig) {
    return `
        <div class="form-group">
            <label>Default Value${infoIcon('The text that appears in this field when the form first loads. Users can modify it.')}</label>
            <input type="text" id="default_value" value="${fieldConfig.default_value || ''}" class="settings-field">
        </div>
    `;
}

function buildTextareaFields(fieldConfig) {
    return `
        <div class="form-group">
            <label>Default Value${infoIcon('The text that appears in this multi-line field when the form first loads. Users can modify it.')}</label>
            <textarea id="default_value" class="settings-field" style="min-height: 100px;">${fieldConfig.default_value || ''}</textarea>
        </div>
    `;
}

function buildHtmlFields(fieldConfig) {
    return `
        <div style="margin-bottom: 15px; padding: 12px; background: rgba(102, 126, 234, 0.1); border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 4px; font-size: 12px; color: #ffffff;">
            <div style="font-weight: 600; margin-bottom: 6px;">💡 Reference other fields:</div>
            <div>Use <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px;"">[[field_name]]</code> to reference field values</div>
            <div style="margin-top: 6px;">Example: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px;">&lt;p&gt;Selected: [[date_1]]&lt;/p&gt;</code></div>
        </div>
        
        <div class="form-group">
            <label>HTML Content${infoIcon('Raw HTML code that will be rendered on the form. You can use [[field_name]] to dynamically insert values from other fields.')}</label>
            <textarea id="content" class="settings-field" style="min-height: 120px; font-family: monospace;">${fieldConfig.content || ''}</textarea>
        </div>
    `;
}

function buildHorizontalLineFields(fieldConfig) {
    return `
        <div style="padding: 12px; background: rgba(102, 126, 234, 0.1); border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 4px; font-size: 12px; color: #ffffff;">
            <div style="font-weight: 600;">📏 Horizontal Line Separator</div>
            <div style="color: #ccc; margin-top: 6px;">This element displays a visual horizontal line. No configuration needed.</div>
        </div>
    `;
}

function buildDateTimeFields(fieldConfig) {
    return `
        <div class="form-group--inline">
            <input type="checkbox" id="include_time" ${fieldConfig.include_time ? 'checked' : ''} class="settings-field">
            <label for="include_time" style="margin: 0; color: #ffffff; font-weight: 600; font-size: 14px; cursor: pointer;">Include Time${infoIcon('Enable to include time selection in addition to date selection.')}</label>
        </div>
    `;
}

function buildArrayFields(fieldConfig) {
    setTimeout(() => {
        const checkbox = document.getElementById('repeating_input_mode');
        if (checkbox) {
            checkbox.addEventListener('change', (e) => {
                const itemsSection = document.getElementById('items_section');
                const sourceSection = document.getElementById('source_section');
                if (itemsSection) itemsSection.style.display = e.target.checked ? 'none' : 'block';
                if (sourceSection) sourceSection.style.display = e.target.checked ? 'block' : 'none';
                showElementSettingsDirty();
            });
        }

        const editBtn = document.getElementById('editArrayItemsBtn');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.preventDefault();
                openArrayItemsModal(fieldConfig);
            });
        }
    }, 0);
    return `
        <div class="form-group--inline">
            <input type="checkbox" id="repeating_input_mode" ${fieldConfig.repeating_input_mode ? 'checked' : ''} class="settings-field">
            <label for="repeating_input_mode">Repeating Input Mode${infoIcon('Enable to dynamically populate array items from a data source. Disable to manually define static array items.')}</label>
        </div>
        
        <div id="items_section" style="display: ${fieldConfig.repeating_input_mode ? 'none' : 'block'};">
            <div class="form-group">
                <label style="display: inline-flex; align-items: center;">Array Items${infoIcon('Define the structure and properties of items in this array. Click to configure the schema.')}</label>
                <button type="button" id="editArrayItemsBtn" class="btn" data-color="blue" data-size="sm" style="width: 100%;">Edit Array Configuration</button>
            </div>
        </div>
        
        <div id="source_section" style="display: ${fieldConfig.repeating_input_mode ? 'block' : 'none'};">
            <div class="form-group">
                <label style="display: inline-flex; align-items: center;">Source${infoIcon('Path to an array in your data. Generates input fields dynamically from the array. Each item becomes a parameter. Example: script_data.detail2.parameters')}</label>
                <input type="text" id="repeating_input_source" placeholder="e.g., script_data.detail2.parameters" value="${fieldConfig.source || ''}" class="settings-field">
            </div>
        </div>
    `;
}

// ***********************************************
// ***********************************************
// ============================================
// ARRAY ITEMS MODAL
// ============================================
// let currentArrayFieldConfig = null;

function initializeArrayItemsModal() {
    // No-op now.
    // Array Items uses the standard showModal()/closeModal() system.
}

function openArrayItemsModal(fieldConfig) {
    currentArrayFieldConfig = fieldConfig;

    const content = document.createElement('div');
    content.innerHTML = `
        <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
            <button id="addArrayItemModalBtn" class="btn" data-color="blue" data-size="sm" title="Add Item" style="min-width: auto;">+</button>
        </div>

        <div id="arrayItemsModalList" class="scrollbar" style="display: flex; flex-direction: column; gap: 4px; max-height: 400px; overflow-y: auto; margin-bottom: 0px;"></div>
    `;

    const arrayItemsModalList = content.querySelector('#arrayItemsModalList');
    const addArrayItemModalBtn = content.querySelector('#addArrayItemModalBtn');

    let items = [];

    if (fieldConfig.items) {
        if (Array.isArray(fieldConfig.items)) {
            items = fieldConfig.items;
        } else if (typeof fieldConfig.items === 'object') {
            items = Object.entries(fieldConfig.items).map(([key, value]) => ({
                name: key,
                display_name: key,
                type: 'text',
                value: value
            }));

            console.log('[ARRAY-MODAL] Converted old format to new format:', items);
        }
    }

    items.forEach((item, index) => {
        renderArrayItemRow(arrayItemsModalList, item, index);
    });

    addArrayItemModalBtn.addEventListener('click', (e) => {
        e.preventDefault();

        const newItem = {
            name: '',
            display_name: '',
            type: 'text',
            value: ''
        };

        renderArrayItemRow(arrayItemsModalList, newItem, arrayItemsModalList.children.length);
    });

    showModal({
        title: 'Array Items',
        content,
        width: 'auto',
        height: 'auto',
        suppressBodyScroll: false,
        closeOnBackdrop: false,
        buttons: [
            {
                label: 'Cancel',
                type: 'secondary'
            },
            {
                label: 'Confirm',
                type: 'success',
                onClick: () => {
                    saveArrayItems();
                }
            }
        ],
        onClose: () => {
            currentArrayFieldConfig = null;
            console.log('[ARRAY-MODAL] Closed Array Items Modal');
        }
    });

    console.log('[ARRAY-MODAL] Opened Array Items Modal');
}

function renderArrayItemRow(container, item, index) {
    const rowContainer = document.createElement('div');
    rowContainer.className = 'panel-level-2';
    rowContainer.dataset.index = index;
    rowContainer._itemData = item;
    rowContainer.style.cssText = 'padding: 6px;';
//    rowContainer.style.cssText = 'background: #1a3540; padding: 12px; border-radius: 4px; border: 1px solid #404040;';

    const mainRow = document.createElement('div');
    mainRow.style.cssText = 'display: flex; gap: 8px; align-items: flex-end; padding-bottom: 5px; border-bottom: 1px solid #404040;';

    mainRow.innerHTML = `
        <div style="display: flex; gap: 8px; flex-shrink: 0;">
            <button class="array-item-move-up-btn" title="Move Up" style="min-width: auto; padding: 6px 8px; background: #5a9fb8; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px; font-weight: 600;">↑</button>
            <button class="array-item-move-down-btn" title="Move Down" style="min-width: auto; padding: 6px 8px; background: #5a9fb8; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px; font-weight: 600;">↓</button>
        </div>
        
        <div style="flex: 1; display: grid; grid-template-columns: 1fr 1fr auto 1fr; column-gap: 8px; row-gap: 0; align-items: start;">
            <label>Name</label>
            <label>Display Name</label>
            <label>Type</label>
            <label>Value</label>
            
            <input type="text" class="array-item-name" value="${escapeHtml(item.name || '')}" placeholder="Field Name">
            <input type="text" class="array-item-display-name" value="${escapeHtml(item.display_name || '')}" placeholder="Display Name">
            <select class="array-item-type">
                <option value="text" ${item.type === 'text' ? 'selected' : ''}>Text</option>
                <option value="array" ${item.type === 'array' ? 'selected' : ''}>Array</option>
                <option value="dropdown_static" ${item.type === 'dropdown_static' ? 'selected' : ''}>Static Dropdown</option>
                <option value="dropdown_workflow" ${item.type === 'dropdown_workflow' ? 'selected' : ''}>Workflow Dropdown</option>
                <option value="dropdown_sql" ${item.type === 'dropdown_sql' ? 'selected' : ''}>SQL Dropdown</option>
            </select>
            <div class="array-item-config-container" style="width: 100%; height: 100%"></div>
        </div>
        
        <button class="delete-array-item-modal-btn" title="Delete Item" style="min-width: auto; padding: 6px 10px; background: #b8242f; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 14px; font-weight: 600; flex-shrink: 0;">×</button>
    `;

    rowContainer.appendChild(mainRow);

    const valueFieldContainer = mainRow.querySelector('.array-item-config-container');
    renderArrayItemValueField(valueFieldContainer, item);

    const configSection = document.createElement('div');
    configSection.className = 'array-item-config';
    configSection.style.cssText = 'padding-top: 4px;';
    renderArrayItemConfig(configSection, item);
    rowContainer.appendChild(configSection);

    container.appendChild(rowContainer);

    const nameInput = mainRow.querySelector('.array-item-name');
    const displayNameInput = mainRow.querySelector('.array-item-display-name');
    const typeSelect = mainRow.querySelector('.array-item-type');
    const workflowSelect = mainRow.querySelector('.array-item-workflow-id');

    nameInput.addEventListener('input', (e) => {
        item.name = e.target.value;
    });

    displayNameInput.addEventListener('input', (e) => {
        item.display_name = e.target.value;
    });

    typeSelect.addEventListener('change', (e) => {
        item.type = e.target.value;

        valueFieldContainer.innerHTML = '';
        renderArrayItemValueField(valueFieldContainer, item);

        configSection.innerHTML = '';
        renderArrayItemConfig(configSection, item);

        console.log('[ARRAY-MODAL] Changed item type to:', e.target.value);
    });

    // Re-attach workflow select listener after valueFieldContainer is rendered
    const workflowSelectElement = valueFieldContainer.querySelector('.array-item-workflow-id');
    if (workflowSelectElement) {
        workflowSelectElement.addEventListener('change', (e) => {
            item.workflow_id = e.target.value;
            item.workflow_input = {};
            
            // Re-render the config section to show new workflow inputs
            configSection.innerHTML = '';
            renderArrayItemConfig(configSection, item);
        });
    }

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

    attachDeleteArrayItemModalListener(
        mainRow.querySelector('.delete-array-item-modal-btn'),
        rowContainer
    );

    updateArrayItemButtonStates();
}

function renderArrayItemValueField(container, item) {
    if (item.type === 'text') {
        container.innerHTML = `
            <input type="text" class="array-item-text-value" value="${escapeHtml(item.value || '')}" placeholder="Default Value">
        `;

        const valueInput = container.querySelector('.array-item-text-value');
        valueInput.addEventListener('input', (e) => {
            item.value = e.target.value;
        });

        return;
    }

    if (item.type === 'dropdown_workflow') {
        let workflowOptions = '<option value="">-- Select Workflow --</option>';

        if (availableWorkflows) {
            availableWorkflows.forEach(w => {
                const selected = item.workflow_id === w.id ? 'selected' : '';
                workflowOptions += `<option value="${escapeHtml(w.id)}" ${selected}>${escapeHtml(w.name)}</option>`;
            });
        }

        container.innerHTML = `
            <select class="array-item-workflow-id">
                ${workflowOptions}
            </select>
        `;

        return;
    }

    const noValue = 'color: #999; font-size: 11px; padding: 0px; text-align: center; white-space: nowrap; display: flex; align-items: center; height: 100%;';
    if (item.type === 'dropdown_static') {
        container.innerHTML = `<div style="${noValue}">Configure below</div>`;
        return;
    }
    if (item.type === 'dropdown_sql') {
        container.innerHTML = `<div style="${noValue}">Configure Below</div>`;
        return;
    }
    if (item.type === 'array') {
        container.innerHTML = `<div style="${noValue}">Nested Array</div>`;
        return;
    }
    container.innerHTML = `<div style="${noValue}">Select type</div>`;
}

function renderArrayItemConfig(container, item) {
    if (item.type === 'dropdown_static') {
        let optionsHtml = '';
        let optionIndex = 0;

        if (item.options && typeof item.options === 'object') {
            Object.entries(item.options).forEach(([label, value]) => {
                optionsHtml += `
                    <div class="static-option-row" style="display: flex; gap: 6px; align-items: center; margin-bottom: 6px;">
                        <div style="color: #ccc; font-size: 12px; font-weight: 600; min-width: 20px; text-align: center;">${optionIndex + 1}</div>
                        <input type="text" class="static-option-label" value="${escapeHtml(label)}" placeholder="Label" style="flex: 1;">
                        <input type="text" class="static-option-value" value="${escapeHtml(value)}" placeholder="Value" style="flex: 1;">
                        <button class="delete-static-option-btn" style="padding: 4px 8px; background: #b8242f; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px; font-weight: 600;">×</button>
                    </div>
                `;
                optionIndex++;
            });
        }

        container.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <label style="color: #ffffff; font-weight: 600; font-size: 12px; margin: 0;">Static Options</label>
                <button class="add-static-option-btn btn" data-color="blue" data-size="sm" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;">+</button>
            </div>

            <div class="static-options-container" style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px;">
                ${optionsHtml}
            </div>

            <label style="display: flex; align-items: center; gap: 6px; color: #999; font-size: 11px;">
                <input type="checkbox" class="array-item-multi-select" ${item.multi_select ? 'checked' : ''}>
                Multi-Select
            </label>
        `;

        const optionsContainer = container.querySelector('.static-options-container');
        const addBtn = container.querySelector('.add-static-option-btn');
        const multiSelect = container.querySelector('.array-item-multi-select');

        const syncStaticOptions = () => {
            const options = {};

            optionsContainer.querySelectorAll('.static-option-row').forEach(row => {
                const labelInput = row.querySelector('.static-option-label');
                const valueInput = row.querySelector('.static-option-value');

                const label = labelInput ? labelInput.value.trim() : '';
                const value = valueInput ? valueInput.value.trim() : '';

                if (label && value) {
                    options[label] = value;
                }
            });

            item.options = options;
            item.multi_select = multiSelect ? multiSelect.checked : false;
        };

        const attachStaticOptionListeners = (row) => {
            const labelInput = row.querySelector('.static-option-label');
            const valueInput = row.querySelector('.static-option-value');
            const deleteBtn = row.querySelector('.delete-static-option-btn');

            if (labelInput) labelInput.addEventListener('input', syncStaticOptions);
            if (valueInput) valueInput.addEventListener('input', syncStaticOptions);
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    row.remove();
                    syncStaticOptions();
                });
            }
        };

        optionsContainer.querySelectorAll('.static-option-row').forEach(attachStaticOptionListeners);

        addBtn.addEventListener('click', (e) => {
            e.preventDefault();

            const rowCount = optionsContainer.querySelectorAll('.static-option-row').length;
            const newRow = document.createElement('div');
            newRow.className = 'static-option-row';
            newRow.style.cssText = 'display: flex; gap: 6px; align-items: center; margin-bottom: 6px;';
            newRow.innerHTML = `
                <div style="color: #ccc; font-size: 12px; font-weight: 600; min-width: 20px; text-align: center;">${rowCount + 1}</div>
                <input type="text" class="static-option-label" placeholder="Label" style="flex: 1;">
                <input type="text" class="static-option-value" placeholder="Value" style="flex: 1;">
                <button class="delete-static-option-btn" style="padding: 4px 8px; background: #b8242f; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px; font-weight: 600;">×</button>
            `;

            attachStaticOptionListeners(newRow);
            optionsContainer.appendChild(newRow);
            syncStaticOptions();
        });

        if (multiSelect) {
            multiSelect.addEventListener('change', syncStaticOptions);
        }

        syncStaticOptions();
        return;
    }

    if (item.type === 'dropdown_workflow') {
        container.innerHTML = `
            <div style="color: #999; font-size: 11px; margin-bottom: 6px; font-weight: 600;">Workflow Configuration</div>

            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                <div>
                    <label style="color: #999; font-size: 11px; display: block; margin-bottom: 4px;">Label Field</label>
                    <input type="text" class="array-item-label-field" value="${escapeHtml(item.label_field || '')}" placeholder="e.g., name">
                </div>

                <div>
                    <label style="color: #999; font-size: 11px; display: block; margin-bottom: 4px;">Value Field</label>
                    <input type="text" class="array-item-value-field" value="${escapeHtml(item.value_field || '')}" placeholder="e.g., id">
                </div>

                <div>
                    <label style="color: #999; font-size: 11px; display: block; margin-bottom: 4px;">Output Variable</label>
                    <select class="array-item-workflow-output">
                        <option value="">-- Select output --</option>
                    </select>
                </div>
            </div>

            <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px;">
                <label style="display: flex; align-items: center; gap: 6px; color: #999; font-size: 11px; margin: 0;">
                    <input type="checkbox" class="array-item-multi-select" ${item.multi_select ? 'checked' : ''}>
                    Multi-Select
                </label>
                <label style="display: flex; align-items: center; gap: 6px; color: #999; font-size: 11px; margin: 0;">
                    <input type="checkbox" class="array-item-searchable" ${item.searchable ? 'checked' : ''}>
                    Searchable
                </label>
                <label style="display: flex; align-items: center; gap: 6px; color: #999; font-size: 11px; margin: 0;">
                    <input type="checkbox" class="array-item-tree-view" ${item.tree_view ? 'checked' : ''}>
                    Tree View
                </label>
            </div>

            <div class="array-item-tree-fields" style="display: ${item.tree_view ? 'grid' : 'none'}; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                <div>
                    <label style="color: #999; font-size: 11px; display: block; margin-bottom: 4px;">Parent Field${infoIcon('For tree view: field name that identifies parents')}</label>
                    <input type="text" class="array-item-parent-field" value="${escapeHtml(item.parent_field || '')}" placeholder="e.g., parentId">
                </div>

                <div>
                    <label style="color: #999; font-size: 11px; display: block; margin-bottom: 4px;">Level Field${infoIcon('For tree view: field name for depth/level')}</label>
                    <input type="text" class="array-item-level-field" value="${escapeHtml(item.level_field || '')}" placeholder="e.g., level">
                </div>
            </div>

            <div class="array-item-workflow-inputs-section" style="border-left: 2px solid #444; padding-left: 12px; margin-top: 8px;"></div>
        `;

        const labelInput = container.querySelector('.array-item-label-field');
        const valueInput = container.querySelector('.array-item-value-field');
        const workflowOutputSelect = container.querySelector('.array-item-workflow-output');
        const parentFieldInput = container.querySelector('.array-item-parent-field');
        const levelFieldInput = container.querySelector('.array-item-level-field');
        const multiSelect = container.querySelector('.array-item-multi-select');
        const searchable = container.querySelector('.array-item-searchable');
        const treeView = container.querySelector('.array-item-tree-view');
        const treeFieldsDiv = container.querySelector('.array-item-tree-fields');

        if (labelInput) {
            labelInput.addEventListener('input', (e) => {
                item.label_field = e.target.value;
            });
        }

        if (valueInput) {
            valueInput.addEventListener('input', (e) => {
                item.value_field = e.target.value;
            });
        }

        if (workflowOutputSelect) {
            workflowOutputSelect.addEventListener('change', (e) => {
                item.workflow_output = e.target.value;
            });
        }

        if (parentFieldInput) {
            parentFieldInput.addEventListener('input', (e) => {
                item.parent_field = e.target.value;
            });
        }

        if (levelFieldInput) {
            levelFieldInput.addEventListener('input', (e) => {
                item.level_field = e.target.value;
            });
        }

        if (multiSelect) {
            multiSelect.addEventListener('change', (e) => {
                item.multi_select = e.target.checked;
            });
        }

        if (searchable) {
            searchable.addEventListener('change', (e) => {
                item.searchable = e.target.checked;
            });
        }

        if (treeView) {
            treeView.addEventListener('change', (e) => {
                item.tree_view = e.target.checked;
                if (treeFieldsDiv) {
                    treeFieldsDiv.style.display = e.target.checked ? 'grid' : 'none';
                }
            });
        }

        // Populate workflow inputs if workflow is selected
        if (item.workflow_id) {
            const workflow = availableWorkflows?.find(w => w.id === item.workflow_id);
            if (workflow) {
                renderArrayItemWorkflowInputs(container, item, workflow);
            }
        }

        return;
    }

    if (item.type === 'dropdown_sql') {
        container.innerHTML = `
            <div style="color: #999; font-size: 11px; margin-bottom: 6px; font-weight: 600;">SQL Configuration</div>

            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                <div>
                    <label style="color: #999; font-size: 11px; display: block; margin-bottom: 4px;">Datasource${infoIcon('Select the database connection to query.')}</label>
                    <select class="array-item-sql-database settings-field" data-current="${item.database || ''}">
                        <option value="">-- Select datasource --</option>
                    </select>
                </div>
                <div>
                    <label>SQL Query${infoIcon('The SQL query that retrieves the data. Use [[field_name]] to reference other fields.')}</label>
                    <button type="button" class="array-item-sql-query-btn btn" data-color="blue" data-size="sm" style="width: 100%;">
                        ${item.query && item.query.trim().length > 0 ? '✓ Edit SQL Query' : 'Edit SQL Query'}
                    </button>
                    <div class="array-item-sql-query-display" data-query="${(item.query || '').replace(/"/g, '&quot;')}" style="display: none;"></div>
                </div>
                <div>
                    <label style="color: #999; font-size: 11px; display: block; margin-bottom: 4px;">Label Field</label>
                    <input type="text" class="array-item-label-field" value="${escapeHtml(item.label_field || '')}" placeholder="e.g., name" style="flex: 1;">
                </div>
                <div>
                    <label style="color: #999; font-size: 11px; display: block; margin-bottom: 4px;">Value Field</label>
                    <input type="text" class="array-item-value-field" value="${escapeHtml(item.value_field || '')}" placeholder="e.g., id" style="flex: 1;">
                </div>
            </div>

            <label style="display: flex; align-items: center; gap: 6px; color: #999; font-size: 11px;">
                <input type="checkbox" class="array-item-multi-select" ${item.multi_select ? 'checked' : ''}>
                Multi-Select
            </label>
        `;

        const sqlDatabaseSelect = container.querySelector('.array-item-sql-database');
        const sqlQueryBtn = container.querySelector('.array-item-sql-query-btn');
        const sqlQueryDisplay = container.querySelector('.array-item-sql-query-display');
        const labelFieldInput = container.querySelector('.array-item-label-field');
        const valueFieldInput = container.querySelector('.array-item-value-field');
        const multiSelect = container.querySelector('.array-item-multi-select');

        // Populate SQL datasource dropdown
        const currentDb = sqlDatabaseSelect.dataset.current || '';
        sqlDatabaseSelect.innerHTML = '<option value="">-- Select datasource --</option>';
        sqlDatasources.forEach(dbName => {
            const opt = document.createElement('option');
            opt.value = dbName;
            opt.textContent = dbName;
            if (dbName === currentDb) opt.selected = true;
            sqlDatabaseSelect.appendChild(opt);
        });
        sqlDatabaseSelect.disabled = sqlDatasources.length === 0;
        if (sqlDatasources.length === 0) {
            sqlDatabaseSelect.innerHTML = '<option value="">No datasources available</option>';
        }

        sqlDatabaseSelect.addEventListener('change', (e) => {
            item.database = e.target.value;
        });

        sqlQueryBtn.addEventListener('click', () => {
            const currentQuery = sqlQueryDisplay.dataset.query || '';
            
            const queryContainer = document.createElement('div');
            
            const hint = document.createElement('p');
            hint.style.cssText = 'margin: 0 0 10px 0; color: #999; font-size: 12px;';
            hint.innerHTML = 'Use <code style="background: var(--bg-input); padding: 1px 5px; border-radius: 3px; font-size: 12px;">[[field_name]]</code> to reference form fields';
            
            const textarea = document.createElement('textarea');
            textarea.value = currentQuery;
            textarea.style.cssText = 'width: 100%; height: 300px; font-family: monospace; font-size: 13px; resize: vertical; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px; padding: 10px; box-sizing: border-box;';
            textarea.placeholder = 'SELECT id, name FROM table WHERE ...';
            
            queryContainer.appendChild(hint);
            queryContainer.appendChild(textarea);

            showModal({
                title: 'SQL Query',
                content: queryContainer,
                closeOnBackdrop: false,
                buttons: [
                    {
                        label: 'Save',
                        type: 'primary',
                        onClick: () => {
                            sqlQueryDisplay.dataset.query = textarea.value;
                            item.query = textarea.value;
                            sqlQueryBtn.textContent = textarea.value.trim().length > 0 ? '✓ Edit SQL Query' : 'Edit SQL Query';
                            closeModal();
                            return false;
                        }
                    },
                    { label: 'Cancel', type: 'secondary', onClick: () => { closeModal(); return false; } }
                ]
            });
        });

        labelFieldInput.addEventListener('input', (e) => {
            item.label_field = e.target.value;
        });

        if (valueFieldInput) {
            valueFieldInput.addEventListener('input', (e) => {
                item.value_field = e.target.value;
            });
        }

        multiSelect.addEventListener('change', (e) => {
            item.multi_select = e.target.checked;
        });

        return;
    }

    if (item.type === 'array') {
        // Nested array config: Repeating Input Mode, Source (if checked), or nested items (if unchecked)
        container.style.display = 'block';
        
        // Initialize nested items if not present
        if (!item.items) item.items = [];
        if (item.repeating_input_mode === undefined) item.repeating_input_mode = false;
        if (!item.source) item.source = '';
        
        const repeatingInputMode = item.repeating_input_mode || false;
        
        container.innerHTML = `
            <div id="nestedArraySourceContainer" style="display: ${repeatingInputMode ? 'flex' : 'none'}; flex-direction: column; gap: 6px; margin-bottom: 12px;">
                <label style="color: #ccc; font-size: 12px; font-weight: 600;">Source Page Variable</label>
                <input type="text" class="array-item-source" value="${escapeHtml(item.source || '')}" placeholder="e.g., [[variable_name]]" style="padding: 6px; background: var(--bg-input); border: 1px solid var(--border-input); border-radius: 4px; color: var(--text-primary); font-size: 12px; width: 100%;">
            </div>
            
            <div id="nestedArrayItemsContainer" style="display: ${repeatingInputMode ? 'none' : 'flex'}; flex-direction: column; gap: 8px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <label style="color: #ffffff; font-weight: 600; font-size: 12px; margin: 0;">Items</label>
                    <button class="add-nested-array-item-btn btn" data-color="blue" data-size="sm" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;">+</button>
                </div>
                <div id="nestedArrayItemsList" style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px;"></div>
            </div>
            
            <div style="display: flex; gap: 12px; align-items: center;">
                <label style="display: flex; align-items: center; gap: 6px; color: #999; font-size: 11px; margin: 0;">
                    <input type="checkbox" class="array-item-repeating-mode" ${repeatingInputMode ? 'checked' : ''}>
                    Repeating Input Mode
                </label>
                
                <label style="display: flex; align-items: center; gap: 6px; color: #999; font-size: 11px; margin: 0;">
                    <input type="checkbox" class="nested-array-item-multi-select" ${item.multi_select ? 'checked' : ''}>
                    Multi-Select
                </label>
            </div>
        `;
        
        // Handle repeating input mode toggle
        const repeatingModeCheckbox = container.querySelector('.array-item-repeating-mode');
        const sourceContainer = container.querySelector('#nestedArraySourceContainer');
        const itemsContainer = container.querySelector('#nestedArrayItemsContainer');
        const sourceInput = container.querySelector('.array-item-source');
        const multiSelectCheckbox = container.querySelector('.nested-array-item-multi-select');
        
        repeatingModeCheckbox.addEventListener('change', (e) => {
            item.repeating_input_mode = e.target.checked;
            sourceContainer.style.display = e.target.checked ? 'flex' : 'none';
            itemsContainer.style.display = e.target.checked ? 'none' : 'flex';
            console.log('[ARRAY-MODAL] Toggled repeating input mode to:', e.target.checked);
        });
        
        sourceInput.addEventListener('input', (e) => {
            item.source = e.target.value;
        });
        
        if (multiSelectCheckbox) {
            multiSelectCheckbox.addEventListener('change', (e) => {
                item.multi_select = e.target.checked;
            });
        }
        
        // Render nested array items
        const nestedItemsList = container.querySelector('#nestedArrayItemsList');
        if (item.items && item.items.length > 0) {
            item.items.forEach((nestedItem, idx) => {
                renderNestedArrayItemRow(nestedItemsList, nestedItem, idx, item.items);
            });
        }
        
        // Handle add nested item button
        container.querySelector('.add-nested-array-item-btn').addEventListener('click', (e) => {
            e.preventDefault();
            const newNestedItem = {
                name: '',
                display_name: '',
                type: 'text',
                value: ''
            };
            item.items.push(newNestedItem);
            nestedItemsList.innerHTML = '';
            item.items.forEach((nestedItem, idx) => {
                renderNestedArrayItemRow(nestedItemsList, nestedItem, idx, item.items);
            });
        });
    }
}


function renderArrayItemWorkflowInputs(configContainer, item, workflow) {
    const inputsSection = configContainer.querySelector('.array-item-workflow-inputs-section');
    const outputSelect = configContainer.querySelector('.array-item-workflow-output');
    
    if (!inputsSection) return;

    if (!workflow) {
        inputsSection.innerHTML = '';
        if (outputSelect) {
            outputSelect.innerHTML = '<option value="">-- Select output --</option>';
        }
        return;
    }

    const inputVars = workflow.definition?.inputVariables || [];
    const outputVars = workflow.definition?.outputVariables || [];
    
    inputsSection.innerHTML = '';

    // Render input variables
    if (inputVars.length > 0) {
        const header = document.createElement('div');
        header.style.cssText = 'color: #999; font-size: 11px; font-weight: 600; margin-bottom: 8px;';
        header.textContent = 'Workflow Inputs';
        inputsSection.appendChild(header);

        inputVars.forEach(input => {
            const group = document.createElement('div');
            group.style.cssText = 'margin-bottom: 8px;';
            const savedVal = item.workflow_input?.[input.name] || '';
            group.innerHTML = `
                <label style="color: #999; font-size: 11px; display: block; margin-bottom: 4px;">${input.name}</label>
                <input type="text" class="array-item-workflow-input-field" data-input-name="${input.name}"
                    value="${escapeHtml(savedVal)}" placeholder="e.g. [[field_name]] or static value">
            `;
            inputsSection.appendChild(group);
        });

        inputsSection.querySelectorAll('.array-item-workflow-input-field').forEach(el => {
            el.addEventListener('input', () => {
                const inputName = el.dataset.inputName;
                if (inputName) {
                    if (!item.workflow_input) item.workflow_input = {};
                    item.workflow_input[inputName] = el.value;
                }
            });
        });
    }

    // Populate output select
    if (outputSelect) {
        outputSelect.innerHTML = '<option value="">-- Select output --</option>';
        if (outputVars.length > 0) {
            outputVars.forEach(output => {
                const option = document.createElement('option');
                option.value = output.name;
                option.textContent = output.name;
                if (item.workflow_output === output.name) {
                    option.selected = true;
                }
                outputSelect.appendChild(option);
            });
        }
    }
}

/**
 * Render a single nested array item row (for array within array)
 * @param {HTMLElement} container - Container to append row to
 * @param {object} nestedItem - Item object with name, display_name, type, etc.
 * @param {number} index - Index of item
 * @param {Array} parentItems - Reference to parent items array for deletion
 */
function renderNestedArrayItemRow(container, nestedItem, index, parentItems) {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'nested-array-item-row';
    rowDiv.style.cssText = 'display: flex; gap: 6px; align-items: center;';
    rowDiv.innerHTML = `
        <div style="color: #ccc; font-size: 12px; font-weight: 600; min-width: 20px; text-align: center;">${index + 1}</div>
        <input type="text" class="nested-array-item-name" value="${escapeHtml(nestedItem.name || '')}" placeholder="Field Name" style="flex: 1;">
        <input type="text" class="nested-array-item-display-name" value="${escapeHtml(nestedItem.display_name || '')}" placeholder="Display Name" style="flex: 1;">
        <button class="delete-nested-array-item-btn" style="padding: 4px 8px; background: #b8242f; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 12px; font-weight: 600;">×</button>
    `;
    
    const nameInput = rowDiv.querySelector('.nested-array-item-name');
    const displayNameInput = rowDiv.querySelector('.nested-array-item-display-name');
    const deleteBtn = rowDiv.querySelector('.delete-nested-array-item-btn');
    
    nameInput.addEventListener('input', (e) => { nestedItem.name = e.target.value; });
    displayNameInput.addEventListener('input', (e) => { nestedItem.display_name = e.target.value; });
    deleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        parentItems.splice(index, 1);
        rowDiv.remove();
    });
    
    container.appendChild(rowDiv);
}

function moveArrayItem(rowContainer, direction) {
    const parent = rowContainer.parentElement;
    const currentIndex = Array.from(parent.children).indexOf(rowContainer);

    if (direction === 'up' && currentIndex > 0) {
        parent.insertBefore(rowContainer, parent.children[currentIndex - 1]);
    } else if (direction === 'down' && currentIndex < parent.children.length - 1) {
        parent.insertBefore(rowContainer, parent.children[currentIndex + 2]);
    }

    updateArrayItemButtonStates();
}

function updateArrayItemButtonStates() {
    const container = document.getElementById('arrayItemsModalList');
    if (!container) return;

    const rows = container.querySelectorAll('.panel-level-2');

    rows.forEach((row, index) => {
        const upBtn = row.querySelector('.array-item-move-up-btn');
        const downBtn = row.querySelector('.array-item-move-down-btn');

        if (upBtn) upBtn.disabled = index === 0;
        if (downBtn) downBtn.disabled = index === rows.length - 1;
    });
}

function attachDeleteArrayItemModalListener(btn, rowContainer) {
    if (!btn || !rowContainer) return;

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        rowContainer.remove();
        updateArrayItemButtonStates();
    });
}

function closeArrayItemsModal() {
    currentArrayFieldConfig = null;
    closeModal();
}

function saveArrayItems() {
    if (!currentArrayFieldConfig) return;

    const arrayItemsModalList = document.getElementById('arrayItemsModalList');
    if (!arrayItemsModalList) return;

    const arrayItemRowContainers = arrayItemsModalList.querySelectorAll('.panel-level-2');
    const items = [];

    arrayItemRowContainers.forEach(container => {
        const nameInput = container.querySelector('.array-item-name');
        const displayNameInput = container.querySelector('.array-item-display-name');
        const typeSelect = container.querySelector('.array-item-type');

        if (!nameInput || !displayNameInput || !typeSelect) return;

        const name = nameInput.value.trim();
        const display_name = displayNameInput.value.trim();
        const type = typeSelect.value;

        if (!name) return;

        const item = container._itemData || {};
        const itemData = { name, display_name, type };

        if (type === 'text') {
            const valueInput = container.querySelector('.array-item-text-value');
            itemData.value = valueInput ? valueInput.value : item.value || '';
        } else if (type === 'dropdown_workflow') {
            const workflowInput = container.querySelector('.array-item-workflow-id');
            const labelInput = container.querySelector('.array-item-label-field');
            const valueInput = container.querySelector('.array-item-value-field');
            const workflowOutputSelect = container.querySelector('.array-item-workflow-output');
            const parentFieldInput = container.querySelector('.array-item-parent-field');
            const levelFieldInput = container.querySelector('.array-item-level-field');
            const multiSelect = container.querySelector('.array-item-multi-select');
            const searchable = container.querySelector('.array-item-searchable');
            const treeView = container.querySelector('.array-item-tree-view');

            itemData.workflow_id = workflowInput ? workflowInput.value : item.workflow_id || '';
            itemData.label_field = labelInput ? labelInput.value : item.label_field || '';
            itemData.value_field = valueInput ? valueInput.value : item.value_field || '';
            itemData.workflow_output = workflowOutputSelect ? workflowOutputSelect.value : item.workflow_output || '';
            itemData.parent_field = parentFieldInput ? parentFieldInput.value : item.parent_field || '';
            itemData.level_field = levelFieldInput ? levelFieldInput.value : item.level_field || '';
            itemData.multi_select = multiSelect ? multiSelect.checked : !!item.multi_select;
            itemData.searchable = searchable ? searchable.checked : !!item.searchable;
            itemData.tree_view = treeView ? treeView.checked : !!item.tree_view;
            itemData.workflow_input = item.workflow_input || {};
        } else if (type === 'dropdown_static') {
            const options = {};
            const optionsContainer = container.querySelector('.static-options-container');
            const multiSelect = container.querySelector('.array-item-multi-select');

            if (optionsContainer) {
                optionsContainer.querySelectorAll('.static-option-row').forEach(row => {
                    const labelInput = row.querySelector('.static-option-label');
                    const valueInput = row.querySelector('.static-option-value');

                    const label = labelInput ? labelInput.value.trim() : '';
                    const value = valueInput ? valueInput.value.trim() : '';

                    if (label && value) {
                        options[label] = value;
                    }
                });
            }

            itemData.options = options;
            itemData.multi_select = multiSelect ? multiSelect.checked : !!item.multi_select;
        } else if (type === 'dropdown_sql') {
            const sqlDatabaseSelect = container.querySelector('.array-item-sql-database');
            const sqlQueryDisplay = container.querySelector('.array-item-sql-query-display');
            const labelFieldInput = container.querySelector('.array-item-label-field');
            const valueFieldInput = container.querySelector('.array-item-value-field');
            const multiSelect = container.querySelector('.array-item-multi-select');

            itemData.database = sqlDatabaseSelect ? sqlDatabaseSelect.value : item.database || '';
            itemData.query = sqlQueryDisplay ? sqlQueryDisplay.dataset.query : item.query || '';
            itemData.label_field = labelFieldInput ? labelFieldInput.value : item.label_field || '';
            itemData.value_field = valueFieldInput ? valueFieldInput.value : item.value_field || '';
            itemData.multi_select = multiSelect ? multiSelect.checked : !!item.multi_select;
        } else if (type === 'array') {
            const repeatingModeCheckbox = container.querySelector('.array-item-repeating-mode');
            const sourceInput = container.querySelector('.array-item-source');
            const multiSelectCheckbox = container.querySelector('.nested-array-item-multi-select');

            itemData.repeating_input_mode = repeatingModeCheckbox ? repeatingModeCheckbox.checked : !!item.repeating_input_mode;
            itemData.source = sourceInput ? sourceInput.value : item.source || '';
            itemData.multi_select = multiSelectCheckbox ? multiSelectCheckbox.checked : !!item.multi_select;
            
            // Use the item.items array that was built during renderArrayItemConfig
            if (!itemData.repeating_input_mode && item.items && item.items.length > 0) {
                // Collect from DOM first for any updated values
                const updatedNestedItems = [];
                container.querySelectorAll('.nested-array-item-row').forEach(nestedRow => {
                    const nameInput = nestedRow.querySelector('.nested-array-item-name');
                    const displayNameInput = nestedRow.querySelector('.nested-array-item-display-name');
                    
                    if (nameInput && displayNameInput) {
                        const nestedName = nameInput.value.trim();
                        const nestedDisplayName = displayNameInput.value.trim();
                        
                        if (nestedName) {
                            updatedNestedItems.push({
                                name: nestedName,
                                display_name: nestedDisplayName,
                                type: 'text',
                                value: ''
                            });
                        }
                    }
                });
                // Use DOM-collected items if any were found, otherwise fall back to item.items
                itemData.items = updatedNestedItems.length > 0 ? updatedNestedItems : item.items;
            } else {
                itemData.items = [];
            }
        }

        items.push(itemData);
    });

    currentArrayFieldConfig.items = items;

    console.log('[ARRAY-MODAL] Saved array items:', items);

    showElementSettingsDirty();
}

// ***********************************************
// ***********************************************

function buildFormExtendFields(fieldConfig) {
    return `
        <div class="form-group">
            <label style="display: inline-flex; align-items: center;">Extend Variable${infoIcon('Select a variable to extend and merge with this form\'s data.')}</label>
            <select id="extend_var" class="settings-field">
                <option value="">Select an extend variable...</option>
            </select>
        </div>
    `;
}

function buildDataRetrievalFields(fieldConfig) {
    return `
        <div class="form-group">
            <label>Data Source Type${infoIcon('Choose how data is retrieved: Workflow (workflow output), SQL Query (database query), or Plugin (plugin output).')}</label>
            <select id="data_source_type" class="settings-field">
                <option value="Workflow" ${fieldConfig.data_source_type === 'Workflow' ? 'selected' : ''}>Workflow</option>
                <option value="SQL" ${fieldConfig.data_source_type === 'SQL' ? 'selected' : ''}>SQL Query</option>
                <option value="Plugin" ${fieldConfig.data_source_type === 'Plugin' ? 'selected' : ''}>Plugin</option>
            </select>
            <div style="color: #999; font-size: 12px; margin-top: 6px;">Data will be stored in page variable: <strong>${fieldConfig.field_name || '[field_name]'}</strong></div>
        </div>
        
        ${fieldConfig.data_source_type === 'SQL' ? `
        <div class="form-group" id="sql_datasource_group">
            <label>SQL Datasource${infoIcon('Select the database connection to query.')}</label>
            <select id="sql_database" class="settings-field" data-current="${fieldConfig.database || ''}">
                <option value="">-- Select datasource --</option>
            </select>
        </div>
        ` : ''}
        
        ${fieldConfig.data_source_type === 'Plugin' ? `
        <div class="form-group" id="plugin_selector_group">
            <label>Plugin${infoIcon('Select the plugin that will retrieve the data.')}</label>
            <select id="plugin_name" class="settings-field" data-current="${fieldConfig.plugin || ''}">
                <option value="">-- Select plugin --</option>
            </select>
        </div>
        ` : ''}

        ${fieldConfig.data_source_type === 'Workflow' ? `
        <div class="form-group" id="workflow_selector_group">
            <label>Workflow${infoIcon('Select the workflow whose output will be stored in this data retrieval element.')}</label>
            <select id="workflow_id" class="settings-field" data-current="${fieldConfig.workflow_id || ''}" style="width: 100%; padding: 8px;">
                <option value="">-- Select workflow --</option>
            </select>
        </div>
        ` : ''}
        
        <div id="type_specific_fields">
            ${fieldConfig.data_source_type === 'SQL' ? `
                <div class="form-group">
                    <label>SQL Query${infoIcon('The SQL query that retrieves the data. Use [[field_name]] to reference other fields.')}</label>
                    <button type="button" id="sql_query_btn" class="btn" data-color="blue" data-size="sm" style="width: 100%;">
                        ${fieldConfig.query && fieldConfig.query.trim().length > 0 ? '✓ Edit SQL Query' : 'Edit SQL Query'}
                    </button>
                    <div id="sql_query_display" data-query="${(fieldConfig.query || '').replace(/"/g, '&quot;')}" style="display: none;"></div>
                </div>
            ` : ''}
        </div>
    `;
}

function buildDropdownTypeSelector(fieldConfig) {
    return `
        <div class="form-group">
            <label>Dropdown Type${infoIcon('Determines the source of options: Static (manual), Workflow (from workflow output), SQL Query (from database), Plugin (from plugin output), or Pre-fetched Data (from data retrieval). Use the Tree View checkbox for hierarchical data.')}</label>
            <select id="dropdown_type" class="settings-field">
                <option value="" ${!fieldConfig.type || fieldConfig.type === '' ? 'selected' : ''}>-- Select type --</option>
                <option value="dropdown_static" ${fieldConfig.type === 'dropdown_static' ? 'selected' : ''}>Static</option>
                <option value="dropdown_workflow" ${fieldConfig.type === 'dropdown_workflow' ? 'selected' : ''}>Workflow</option>
                <option value="dropdown_sql" ${fieldConfig.type === 'dropdown_sql' ? 'selected' : ''}>SQL Query</option>
                <option value="dropdown_prefetch" ${fieldConfig.type === 'dropdown_prefetch' ? 'selected' : ''}>Pre-fetched Data</option>
                <option value="dropdown_plugin" ${fieldConfig.type === 'dropdown_plugin' ? 'selected' : ''}>Plugin</option>
            </select>
        </div>
    `;
}

function buildDropdownStaticFields(fieldConfig) {
    let optionsHtml = `
        <div class="form-group">
            <label>Options${infoIcon('Define the choices shown in the dropdown. Label is displayed to users, Value is stored in data.')}</label>
            <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Label</div>
                <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Value</div>
                <div style="width: 40px;"></div>
            </div>
            <div id="staticOptionsList" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px;">
    `;
    
    // Add existing options
    if (fieldConfig.options && typeof fieldConfig.options === 'object') {
        Object.entries(fieldConfig.options).forEach(([key, value]) => {
            optionsHtml += `
                <div style="display: flex; gap: 8px; align-items: center;">
                    <input type="text" class="option-label settings-field" value="${key}" placeholder="Label" style="flex: 1;">
                    <input type="text" class="option-value settings-field" value="${value}" placeholder="Value" style="flex: 1;">
                    <button type="button" class="btn delete-option-btn" data-color="red" data-size="sm" style="width: 40px; padding: 0;">×</button>
                </div>
            `;
        });
    }
    
    optionsHtml += `
            </div>
            <button type="button" id="addStaticOptionBtn" class="btn" data-color="blue" data-size="sm" style="width: 100%;">+ Add Option</button>
        </div>
        
        <div class="form-group">
            <label>Default Value${infoIcon('The option that is selected when the form first loads. Leave empty for no default.')}</label>
            <select id="default_value" class="settings-field">
                <option value="">-- Select a default value --</option>
    `;
    
    if (fieldConfig.options && typeof fieldConfig.options === 'object') {
        Object.entries(fieldConfig.options).forEach(([key, value]) => {
            const isSelected = fieldConfig.default_value === value ? 'selected' : '';
            optionsHtml += `<option value="${value}" ${isSelected}>${value}</option>`;
        });
    }
    
    optionsHtml += `
            </select>
        </div>
    `;
    
    return optionsHtml;
}

function buildDropdownSqlFields(fieldConfig) {
    const querySet = fieldConfig.query && fieldConfig.query.trim().length > 0;
    return `
        <div class="form-group">
            <label>SQL Query${infoIcon('The SQL query that retrieves options. Use [[field_name]] to reference other fields in the query.')}</label>
            <button type="button" id="sql_query_btn" class="btn" data-color="blue" data-size="sm" style="width: 100%;">
                ${querySet ? '✓ Edit SQL Query' : 'Edit SQL Query'}
            </button>
            <div id="sql_query_display" data-query="${(fieldConfig.query || '').replace(/"/g, '&quot;')}" style="display: none;"></div>
        </div>
        <div class="form-group">
            <label>Default Selector Field Name${infoIcon('Name to use for storing the default selected value.')}</label>
            <input type="text" id="sql_default_selector" value="${fieldConfig.default_selector || 'default'}" placeholder="default" class="settings-field">
        </div>
    `;
}

function buildDropdownPrefetchFields(fieldConfig) {
    return `
        <div class="form-group">
            <label>Data Source${infoIcon('Select a Data Retrieval element. Data will be fetched from formData.page_variables.{field_name}')}</label>
            <select id="prefetch_source_element_name" class="settings-field">
                <option value="">-- Select Data Source --</option>
            </select>
        </div>
        <div class="form-group">
            <label>Result Path (Optional)${infoIcon('Path to the array within the returned data. Use dot notation: "ad_users" for {ad_users: [...]}, or "data.users" for nested. Leave empty if data is directly an array.')}</label>
            <input type="text" id="prefetch_result_path" value="${fieldConfig.result_path || ''}" placeholder="e.g., ad_users or data.users" class="settings-field">
        </div>
        <div class="form-group">
            <label>Default Selector Field Name${infoIcon('Name to use for storing the default selected value.')}</label>
            <input type="text" id="prefetch_default_selector" value="${fieldConfig.default_selector || 'default'}" placeholder="default" class="settings-field">
        </div>
    `;
}

// Stub renderers for SQL, Plugin, and Workflow
function buildSQLSelector(fieldConfig) {
    let sqlOptions = '';
    if (Array.isArray(sqlDatasources) && sqlDatasources.length > 0) {
        sqlOptions = sqlDatasources.map(ds => `<option value="${ds}" ${fieldConfig.database === ds ? 'selected' : ''}>${ds}</option>`).join('');
    }
    
    return `
        <div class="form-group">
            <label>SQL Database${infoIcon('Select the database connection to use for this query.')}</label>
            <select id="sql_database" class="settings-field">
                <option value="">-- Select database --</option>
                ${sqlOptions}
            </select>
        </div>
    `;
}

function buildPluginSelector(fieldConfig) {
    let pluginOptions = '';
    if (Array.isArray(availablePlugins) && availablePlugins.length > 0) {
        pluginOptions = availablePlugins.map(p => `<option value="${p.name}" ${fieldConfig.plugin_name === p.name ? 'selected' : ''}>${p.display_name || p.name}</option>`).join('');
    }
    
    const html = `
        <div id="plugin_selector_group" class="form-group">
            <label>Plugin${infoIcon('Select the plugin that will provide the dropdown options.')}</label>
            <select id="plugin_name" class="settings-field">
                <option value="">-- Select plugin --</option>
                ${pluginOptions}
            </select>
        </div>
    `;
    
    // Return HTML and attach listener after rendering
    setTimeout(() => {
        const pluginSelect = document.getElementById('plugin_name');
        if (pluginSelect && !pluginSelect.dataset.listenerAttached) {
            pluginSelect.dataset.listenerAttached = 'true';
            pluginSelect.addEventListener('change', () => {
                const selectedPlugin = pluginSelect.value;
                fieldConfig.plugin_name = selectedPlugin;
                fieldConfig.task_id = null;
                fieldConfig.inputs_map = {};
                buildPluginTaskSection(selectedPlugin, null, fieldConfig);
                showElementSettingsDirty();
            });
            
            // If a plugin is already selected, render its task section
            if (fieldConfig.plugin_name) {
                buildPluginTaskSection(fieldConfig.plugin_name, fieldConfig.task_id || null, fieldConfig);
            }
        }
    }, 0);
    
    return html;
}

function buildWorkflowSelector(fieldConfig) {
    let workflowOptions = '';
    if (Array.isArray(availableWorkflows) && availableWorkflows.length > 0) {
        workflowOptions = availableWorkflows.map(w => `<option value="${w.id}" ${fieldConfig.workflow_id === w.id ? 'selected' : ''}>${w.name}</option>`).join('');
    }
    
    const html = `
        <div id="workflow_selector_group" class="form-group">
            <label>Workflow${infoIcon('Select the workflow whose output will populate this dropdown.')}</label>
            <select id="workflow_id" class="settings-field">
                <option value="">-- Select workflow --</option>
                ${workflowOptions}
            </select>
        </div>
    `;
    
    // Return HTML and attach listener after rendering
    setTimeout(() => {
        const workflowSelect = document.getElementById('workflow_id');
        if (workflowSelect && !workflowSelect.dataset.listenerAttached) {
            console.log('[buildWorkflowSelector] Attaching listener to workflow_id');
            workflowSelect.dataset.listenerAttached = 'true';
            workflowSelect.addEventListener('change', () => {
                console.log('[workflow change] Selected workflow ID:', workflowSelect.value);
                const workflow = availableWorkflows.find(w => w.id === workflowSelect.value);
                console.log('[workflow change] Found workflow:', workflow);
                fieldConfig.workflow_id = workflowSelect.value;
                fieldConfig.workflow_input = {};
                fieldConfig.workflow_output = '';
                renderWorkflowInputFields(workflow || null, fieldConfig);
                populateWorkflowOutputs(workflow || null, fieldConfig);
                showElementSettingsDirty();
            });
            
            // If a workflow is already selected, render its input/output fields
            if (fieldConfig.workflow_id) {
                console.log('[buildWorkflowSelector] Workflow already selected:', fieldConfig.workflow_id);
                const workflow = availableWorkflows.find(w => w.id === fieldConfig.workflow_id);
                if (workflow) {
                    console.log('[buildWorkflowSelector] Rendering workflow fields');
                    renderWorkflowInputFields(workflow, fieldConfig);
                    populateWorkflowOutputs(workflow, fieldConfig);
                }
            }
        }
    }, 50);
    
    return html;
}

function buildWorkflowInputs(fieldConfig) {
    // Create a container for workflow input fields
    return `
        <div id="workflow_inputs_section" class="form-group" style="border-left: 2px solid #444; padding-left: 12px;">
        </div>
    `;
}

function buildWorkflowOutputs(fieldConfig) {
    // Create a container for workflow output field
    return `
        <div id="workflow_output_group" class="form-group" style="border-left: 2px solid #444; padding-left: 12px;">
        </div>
    `;
}


function buildDropdownBasicFields(fieldConfig) {
    const html = `
        ${buildDropdownTypeSelector(fieldConfig)}
        
        ${fieldConfig.type === 'dropdown_sql' ? `
        <div class="form-group" id="sql_datasource_group">
            <label style="display: inline-flex; align-items: center;">SQL Datasource${infoIcon('Select the database connection to use for this dropdown query.')}</label>
            <select id="sql_database" class="settings-field" data-current="${fieldConfig.database || ''}">
                <option value="">-- Select datasource --</option>
            </select>
        </div>
        ` : ''}
        
        ${fieldConfig.type === 'dropdown_plugin' ? `
        <div class="form-group" id="plugin_selector_group">
            <label style="display: inline-flex; align-items: center;">Plugin${infoIcon('Select the plugin that will provide the dropdown options.')}</label>
            <select id="plugin_name" class="settings-field" data-current="${fieldConfig.plugin || ''}">
                <option value="">-- Select plugin --</option>
            </select>
        </div>
        ` : ''}

        ${(fieldConfig.type === '' || fieldConfig.type === 'dropdown_workflow') ? `
        <div class="form-group" id="workflow_selector_group">
            <label style="display: inline-flex; align-items: center;">Workflow${infoIcon('Select the workflow whose output will populate this dropdown options.')}</label>
            <select id="workflow_id" class="settings-field" data-current="${fieldConfig.workflow_id || ''}" style="width: 100%; padding: 8px;">
                <option value="">-- Select workflow --</option>
            </select>
        </div>
        ` : ''}
        
        ${['dropdown_workflow', 'dropdown_sql', 'dropdown_plugin'].includes(fieldConfig.type) ? `
        <div class="form-group--inline">
            <input type="checkbox" id="tree_view" ${fieldConfig.tree_view ? 'checked' : ''} class="settings-field">
            <label for="tree_view">Tree View${infoIcon('Enable to display data as a hierarchical tree structure instead of a flat list.')}</label>
        </div>
        ` : ''}
        
        ${fieldConfig.tree_view && ['dropdown_workflow', 'dropdown_sql', 'dropdown_plugin'].includes(fieldConfig.type) ? `
        <div class="form-group">
            <label style="display: inline-flex; align-items: center;">Parent Field${infoIcon('The field name that identifies the parent item. Used to build the tree hierarchy by linking children to parents.')}</label>
            <input type="text" id="tree_parent_field" value="${fieldConfig.parent_field || ''}" placeholder="e.g., ParentID" class="settings-field">
        </div>
        <div class="form-group">
            <label style="display: inline-flex; align-items: center;">Level Field${infoIcon('The field name indicating the depth/level in the tree hierarchy. Helps determine indentation and tree structure.')}</label>
            <input type="text" id="tree_level_field" value="${fieldConfig.level_field || ''}" placeholder="e.g., level" class="settings-field">
        </div>
        ` : ''}
        
        <div id="type_specific_fields">
            ${fieldConfig.type === 'dropdown_static' ? buildDropdownStaticFields(fieldConfig) :
              fieldConfig.type === 'dropdown_sql' ? buildDropdownSqlFields(fieldConfig) :
              fieldConfig.type === 'dropdown_prefetch' ? buildDropdownPrefetchFields(fieldConfig) :
              fieldConfig.type === 'dropdown_plugin' ? '' :
              fieldConfig.type === 'dropdown_workflow' ? '' :
              fieldConfig.type === '' ? '' : `
                <div style="padding: 15px; background: #0f1419; border-radius: 4px; color: #90ee90; border: 1px solid #333;">
                    <strong>${fieldConfig.type}</strong> configuration - to be implemented
                </div>
            `}
        </div>
    `;
    
    return html;
}

// Show the element settings Save button (element-level dirty, not form-level)
function showElementSettingsDirty() {
    document.getElementById('saveSettings').style.display = 'flex';
}

function attachSettingsFieldListeners() {
    // Get all inputs in the settings form
    const inputs = settingsForm.querySelectorAll('.settings-field');
    
    inputs.forEach(input => {
        input.addEventListener('change', showElementSettingsDirty);
        input.addEventListener('input', showElementSettingsDirty);
    });
    
    // Dropdown type selector
    const dropdownTypeSelect = document.getElementById('dropdown_type');
    if (dropdownTypeSelect) {
        dropdownTypeSelect.addEventListener('change', (e) => {
            const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid);
            if (!fieldConfig) return;
            
            const newType = e.target.value;
            const oldType = fieldConfig.type;
            
            // Only rebuild if type actually changed
            if (newType !== oldType) {
                fieldConfig.type = newType;
                
                // Clean up type-specific fields from old type
                const typeSpecificKeys = {
                    'dropdown_static': ['options', 'default_value'],
                    'dropdown_workflow': ['workflow_id', 'workflow_input', 'workflow_output', 'tree_view', 'parent_field', 'level_field'],
                    'dropdown_sql': ['database', 'query', 'tree_view', 'parent_field', 'level_field'],
                    'dropdown_plugin': ['plugin', 'task_id', 'inputs_map', 'tree_view', 'parent_field', 'level_field'],
                    'dropdown_prefetch': ['source_element_name', 'result_path'],
                };
                if (typeSpecificKeys[oldType]) {
                    typeSpecificKeys[oldType].forEach(key => delete fieldConfig[key]);
                }

                // Remove any dynamically injected plugin/workflow sections
                document.getElementById('plugin_task_section')?.remove();
                document.getElementById('workflow_inputs_section')?.remove();
                
                // Show/hide the SQL datasource selector
                const sqlDatasourceGroup = document.getElementById('sql_datasource_group');
                if (newType === 'dropdown_sql') {
                    if (!sqlDatasourceGroup) {
                        const anchor = document.getElementById('type_specific_fields');
                        if (anchor) {
                            const div = document.createElement('div');
                            div.className = 'form-group';
                            div.id = 'sql_datasource_group';
                            div.innerHTML = `
                                <label style="display: inline-flex; align-items: center;">SQL Datasource${infoIcon('Select the database connection to use for this dropdown query.')}</label>
                                <select id="sql_database" class="settings-field" data-current="${fieldConfig.database || ''}">
                                    <option value="">-- Select datasource --</option>
                                </select>
                            `;
                            anchor.before(div);
                        }
                    }
                } else if (sqlDatasourceGroup) {
                    sqlDatasourceGroup.remove();
                }
                
                // Show/hide the Plugin selector
                const pluginSelectorGroup = document.getElementById('plugin_selector_group');
                if (newType === 'dropdown_plugin') {
                    if (!pluginSelectorGroup) {
                        const anchor = document.getElementById('type_specific_fields');
                        if (anchor) {
                            const div = document.createElement('div');
                            div.className = 'form-group';
                            div.id = 'plugin_selector_group';
                            div.innerHTML = `
                                <label style="display: inline-flex; align-items: center;">Plugin${infoIcon('Select the plugin that will provide the dropdown options.')}</label>
                                <select id="plugin_name" class="settings-field" data-current="${fieldConfig.plugin || ''}">
                                    <option value="">-- Select plugin --</option>
                                </select>
                            `;
                            anchor.before(div);
                        }
                    }
                } else if (pluginSelectorGroup) {
                    pluginSelectorGroup.remove();
                }

                // Show/hide the Workflow selector
                const workflowSelectorGroup = document.getElementById('workflow_selector_group');
                if (newType === 'dropdown_workflow') {
                    if (!workflowSelectorGroup) {
                        const anchor = document.getElementById('type_specific_fields');
                        if (anchor) {
                            const div = document.createElement('div');
                            div.className = 'form-group';
                            div.id = 'workflow_selector_group';
                            div.innerHTML = `
                                <label style="display: inline-flex; align-items: center;">Workflow${infoIcon('Select the workflow whose output will populate this dropdown options.')}</label>
                                <select id="workflow_id" class="settings-field" data-current="${fieldConfig.workflow_id || ''}">
                                    <option value="">-- Select workflow --</option>
                                </select>
                            `;
                            anchor.before(div);
                        }
                    }
                } else if (workflowSelectorGroup) {
                    workflowSelectorGroup.remove();
                    document.getElementById('workflow_output_group')?.remove();
                }
                
                // Rebuild the type-specific fields section
                const typeSpecificContainer = document.getElementById('type_specific_fields');
                if (typeSpecificContainer) {
                    if (newType === 'dropdown_static') {
                        typeSpecificContainer.innerHTML = buildDropdownStaticFields(fieldConfig);
                        attachDropdownStaticListeners();
                    } else if (newType === 'dropdown_sql') {
                        typeSpecificContainer.innerHTML = buildDropdownSqlFields(fieldConfig);
                        attachDropdownSqlListeners();
                    } else if (newType === 'dropdown_prefetch') {
                        typeSpecificContainer.innerHTML = buildDropdownPrefetchFields(fieldConfig);
                        attachDropdownPrefetchListeners();
                    } else if (newType === 'dropdown_plugin') {
                        typeSpecificContainer.innerHTML = '';
                        attachDropdownPluginListeners();
                    } else if (newType === 'dropdown_workflow') {
                        typeSpecificContainer.innerHTML = '';
                        attachDropdownWorkflowListeners();
                    } else {
                        typeSpecificContainer.innerHTML = `
                            <div style="padding: 15px; background: #0f1419; border-radius: 4px; color: #90ee90; border: 1px solid #333;">
                                <strong>${newType}</strong> configuration - to be implemented
                            </div>
                        `;
                    }
                }
                
                showElementSettingsDirty();
            }
        });
    }
    
    // Attach dropdown static listeners if applicable
    attachDropdownStaticListeners();
    
    // Attach dropdown sql listeners if applicable
    attachDropdownSqlListeners();
    
    // Attach dropdown plugin listeners if applicable
    attachDropdownPluginListeners();

    // Attach dropdown workflow listeners if applicable
    attachDropdownWorkflowListeners();
    
    // Attach dropdown prefetch listeners if applicable
    attachDropdownPrefetchListeners();
    
    // Attach dropdown tree listeners if applicable
    attachDropdownTreeListeners();
    
    // Attach data_retrieval listeners if applicable
    attachDataRetrievalListeners();
    
    // Dependent Fields button
    const editDependentFieldsBtn = document.getElementById('editDependentFieldsBtn');
    if (editDependentFieldsBtn) {
        editDependentFieldsBtn.addEventListener('click', () => {
            const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid);
            if (!fieldConfig) return;
            openDependentFieldsModal(fieldConfig);
        });
    }
    
    // Set Conditions button handler
    const setConditionsBtn = document.getElementById('setConditionsBtn');
    if (setConditionsBtn) {
        setConditionsBtn.addEventListener('click', () => {
            const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid);
            if (!fieldConfig) return;
            
            const container = document.createElement('div');
            container.innerHTML = buildConditionsFields(fieldConfig);
            
            showModal({
                title: 'Show/Hide Conditions',
                content: container,
                buttons: [
                    {
                        label: 'Save',
                        type: 'primary',
                        onClick: () => {
                            fieldConfig.condition_1 = container.querySelector('#condition_1')?.value || null;
                            fieldConfig.condition_1_action = container.querySelector('#condition_1_action')?.value || null;
                            fieldConfig.condition_2 = container.querySelector('#condition_2')?.value || null;
                            fieldConfig.condition_2_action = container.querySelector('#condition_2_action')?.value || null;
                            showElementSettingsDirty();
                            updateSaveButtonState();
                            closeModal();
                        }
                    },
                    {
                        label: 'Cancel',
                        type: 'secondary'
                    }
                ]
            });
        });
    }
    
    // Radio button add option
    const addRadioOptionBtn = document.getElementById('addRadioOptionBtn');
    if (addRadioOptionBtn) {
        addRadioOptionBtn.addEventListener('click', () => {
            const container = document.getElementById('radioOptionsList');
            const optionDiv = document.createElement('div');
            optionDiv.style.cssText = 'display: flex; gap: 8px; align-items: center;';
            optionDiv.innerHTML = `
                <input type="text" placeholder="Label" class="form-input settings-field" style="flex: 1;" data-option-type="radio" data-option-field="label">
                <input type="text" placeholder="Value" class="form-input settings-field" style="flex: 1;" data-option-type="radio" data-option-field="value">
                <button type="button" class="btn" data-color="red" data-size="sm" style="padding: 6px 12px;" onclick="this.parentElement.remove();">Remove</button>
            `;
            container.appendChild(optionDiv);
            
            // Attach listeners to new inputs
            optionDiv.querySelectorAll('.settings-field').forEach(field => {
                field.addEventListener('change', () => {
                    showElementSettingsDirty();
                });
                field.addEventListener('input', () => {
                    showElementSettingsDirty();
                });
            });
            
            showElementSettingsDirty();
        });
    }
    
    // Array repeating input mode toggle
    const repeatingInputModeCheckbox = document.getElementById('repeating_input_mode');
    if (repeatingInputModeCheckbox) {
        repeatingInputModeCheckbox.addEventListener('change', (e) => {
            const itemsSection = document.getElementById('items_section');
            const sourceSection = document.getElementById('source_section');
            if (itemsSection) itemsSection.style.display = e.target.checked ? 'none' : 'block';
            if (sourceSection) sourceSection.style.display = e.target.checked ? 'block' : 'none';
            showElementSettingsDirty();
        });
    }
}

function attachDropdownStaticListeners() {
    // Add option button
    const addStaticOptionBtn = document.getElementById('addStaticOptionBtn');
    if (addStaticOptionBtn) {
        addStaticOptionBtn.addEventListener('click', () => {
            const container = document.getElementById('staticOptionsList');
            const optionDiv = document.createElement('div');
            optionDiv.style.cssText = 'display: flex; gap: 8px; align-items: center;';
            optionDiv.innerHTML = `
                <input type="text" placeholder="Label" class="option-label settings-field" style="flex: 1;">
                <input type="text" placeholder="Value" class="option-value settings-field" style="flex: 1;">
                <button type="button" class="btn delete-option-btn" data-color="red" data-size="sm" style="width: 40px; padding: 0;">×</button>
            `;
            container.appendChild(optionDiv);
            
            // Attach listeners to new inputs
            optionDiv.querySelectorAll('input').forEach(input => {
                input.addEventListener('change', () => {
                    updateDefaultValueDropdown();
                    showElementSettingsDirty();
                });
                input.addEventListener('input', () => {
                    showElementSettingsDirty();
                });
            });
            
            // Attach delete listener
            optionDiv.querySelector('.delete-option-btn').addEventListener('click', () => {
                optionDiv.remove();
                updateDefaultValueDropdown();
                showElementSettingsDirty();
            });
            
            showElementSettingsDirty();
        });
    }
    
    // Delete option buttons
    const deleteOptionBtns = document.querySelectorAll('.delete-option-btn');
    deleteOptionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            btn.closest('div[style*="display: flex"]').remove();
            updateDefaultValueDropdown();
            showElementSettingsDirty();
        });
    });
}

function attachDropdownSqlListeners() {
    const sqlQueryBtn = document.getElementById('sql_query_btn');
    const sqlQueryDisplay = document.getElementById('sql_query_display');
    const sqlDatabaseSelect = document.getElementById('sql_database');
    if (!sqlQueryBtn || !sqlQueryDisplay || !sqlDatabaseSelect) return;

    // Populate SQL datasource dropdown from cache
    const currentVal = sqlDatabaseSelect.dataset.current || '';
    sqlDatabaseSelect.innerHTML = '<option value="">-- Select datasource --</option>';
    sqlDatasources.forEach(dbName => {
        const opt = document.createElement('option');
        opt.value = dbName;
        opt.textContent = dbName;
        if (dbName === currentVal) opt.selected = true;
        sqlDatabaseSelect.appendChild(opt);
    });
    sqlDatabaseSelect.disabled = sqlDatasources.length === 0;
    if (sqlDatasources.length === 0) {
        sqlDatabaseSelect.innerHTML = '<option value="">No datasources available</option>';
    }

    sqlDatabaseSelect.addEventListener('change', () => {
        showElementSettingsDirty();
    });

    // SQL Query button
    sqlQueryBtn.addEventListener('click', () => {
        const currentQuery = sqlQueryDisplay.dataset.query || '';
        
        const container = document.createElement('div');
        
        const hint = document.createElement('p');
        hint.style.cssText = 'margin: 0 0 10px 0; color: #999; font-size: 12px;';
        hint.innerHTML = 'Use <code style="background: var(--bg-input); padding: 1px 5px; border-radius: 3px; font-size: 12px;">[[field_name]]</code> to reference form fields';
        
        const textarea = document.createElement('textarea');
        textarea.value = currentQuery;
        textarea.style.cssText = 'width: 100%; height: 300px; font-family: monospace; font-size: 13px; resize: vertical; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px; padding: 10px; box-sizing: border-box;';
        textarea.placeholder = 'SELECT id, name FROM table WHERE ...';
        
        container.appendChild(hint);
        container.appendChild(textarea);

        showModal({
            title: 'SQL Query',
            content: container,
            buttons: [
                {
                    label: 'Save',
                    type: 'primary',
                    onClick: () => {
                        sqlQueryDisplay.dataset.query = textarea.value;
                        sqlQueryBtn.textContent = textarea.value.trim().length > 0 ? '✓ Edit SQL Query' : 'Edit SQL Query';
                        showElementSettingsDirty();
                        closeModal();
                    }
                },
                { label: 'Cancel', type: 'secondary', onClick: closeModal }
            ]
        });
    });
}

function attachDropdownPluginListeners() {
    const pluginSelect = document.getElementById('plugin_name');
    if (!pluginSelect) return;

    const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid) || {};

    // Populate plugin dropdown from cache
    const currentPlugin = pluginSelect.dataset.current || fieldConfig.plugin || '';
    pluginSelect.innerHTML = '<option value="">-- Select plugin --</option>';
    availablePlugins.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.display_name || p.name;
        if (p.name === currentPlugin) opt.selected = true;
        pluginSelect.appendChild(opt);
    });
    pluginSelect.disabled = availablePlugins.length === 0;
    if (availablePlugins.length === 0) {
        pluginSelect.innerHTML = '<option value="">No plugins available</option>';
    }

    // If a plugin is already selected, render its task section immediately
    if (currentPlugin) {
        buildPluginTaskSection(currentPlugin, fieldConfig.task_id || null, fieldConfig);
    }

    pluginSelect.addEventListener('change', () => {
        const selectedPlugin = pluginSelect.value;
        fieldConfig.plugin = selectedPlugin;
        fieldConfig.task_id = null;
        fieldConfig.inputs_map = {};
        buildPluginTaskSection(selectedPlugin, null, fieldConfig);
        showElementSettingsDirty();
    });
}

async function fetchPluginTasks(pluginName) {
    // Return from cache if already loaded
    if (pluginTasksCache[pluginName]) return pluginTasksCache[pluginName];

    try {
        const plugin = availablePlugins.find(p => p.name === pluginName);
        if (!plugin) return [];
        const user = getUser();
        const result = await executeSqlQuery(
            'cookie', user, 'kore_sys',
            `SELECT task_id, display_name, description, inputs, outputs, label_field, value_field
             FROM kore_sys.plugin_tasks
             WHERE plugin_id = ${plugin.id} AND active = TRUE
             ORDER BY display_name`
        );
        const tasks = (result?.result || []).map(t => ({
            ...t,
            inputs: typeof t.inputs === 'object' ? t.inputs : JSON.parse(t.inputs || '[]'),
            outputs: typeof t.outputs === 'object' ? t.outputs : JSON.parse(t.outputs || '[]')
        }));
        pluginTasksCache[pluginName] = tasks;
        return tasks;
    } catch (err) {
        console.error('[Plugin Tasks] Failed to load for plugin:', pluginName, err);
        return [];
    }
}

async function buildPluginTaskSection(pluginName, selectedTaskId, fieldConfig) {
    // Remove existing task section if present
    document.getElementById('plugin_task_section')?.remove();

    if (!pluginName) return;

    // Insert task section after plugin_selector_group
    const pluginGroup = document.getElementById('plugin_selector_group');
    if (!pluginGroup) return;

    // Show loading state
    const section = document.createElement('div');
    section.id = 'plugin_task_section';

    const taskGroup = document.createElement('div');
    taskGroup.className = 'form-group';
    taskGroup.innerHTML = `
        <label style="display: inline-flex; align-items: center;">Task${infoIcon('The specific plugin task to execute and retrieve data from.')}</label>
        <select id="plugin_task" class="settings-field">
            <option value="">Loading tasks...</option>
        </select>
    `;
    section.appendChild(taskGroup);
    pluginGroup.after(section);

    // Fetch tasks (cached after first load)
    const tasks = await fetchPluginTasks(pluginName);
    const taskSelect = document.getElementById('plugin_task');
    taskSelect.innerHTML = '<option value="">-- Select task --</option>';
    tasks.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.task_id;
        opt.textContent = t.display_name;
        if (t.task_id === selectedTaskId) opt.selected = true;
        taskSelect.appendChild(opt);
    });
    taskSelect.disabled = tasks.length === 0;
    if (tasks.length === 0) {
        taskSelect.innerHTML = '<option value="">No tasks available</option>';
    }

    // If task already selected, render its fields immediately
    if (selectedTaskId) {
        const task = tasks.find(t => t.task_id === selectedTaskId);
        if (task) {
            const section = document.getElementById('plugin_task_section');
            if (section) {
                const fieldsDiv = document.createElement('div');
                fieldsDiv.id = 'plugin_task_fields';
                
                // Description
                if (task.description) {
                    const desc = document.createElement('div');
                    desc.style.cssText = 'color: #999; font-size: 12px; margin-bottom: 12px;';
                    desc.textContent = task.description;
                    fieldsDiv.appendChild(desc);
                }
                
                // Render task inputs
                const taskInputsHtml = renderTaskInputsHtml(task.inputs, task, null);
                fieldsDiv.innerHTML += taskInputsHtml;
                
                section.appendChild(fieldsDiv);
                
                // Pre-populate universal label/value fields from task defaults if not already set
                const labelFieldInput = document.getElementById('label_field');
                const valueFieldInput = document.getElementById('value_field');
                if (labelFieldInput && !fieldConfig.label_field && task.label_field) {
                    labelFieldInput.value = task.label_field;
                }
                if (valueFieldInput && !fieldConfig.value_field && task.value_field) {
                    valueFieldInput.value = task.value_field;
                }
                
                // Attach change listeners
                fieldsDiv.querySelectorAll('.settings-field, input, select, textarea').forEach(el => {
                    el.addEventListener('input', showElementSettingsDirty);
                });
            }
        }
    }

    taskSelect.addEventListener('change', () => {
        const task = tasks.find(t => t.task_id === parseInt(taskSelect.value));
        fieldConfig.task_id = task?.task_id || null;
        fieldConfig.inputs_map = {};
        
        // Remove existing task fields
        document.getElementById('plugin_task_fields')?.remove();
        
        if (task) {
            const fieldsDiv = document.createElement('div');
            fieldsDiv.id = 'plugin_task_fields';
            
            // Description
            if (task.description) {
                const desc = document.createElement('div');
                desc.style.cssText = 'color: #999; font-size: 12px; margin-bottom: 12px;';
                desc.textContent = task.description;
                fieldsDiv.appendChild(desc);
            }
            
            // Render task inputs
            const taskInputsHtml = renderTaskInputsHtml(task.inputs, task, null);
            fieldsDiv.innerHTML += taskInputsHtml;
            
            const section = document.getElementById('plugin_task_section');
            if (section) {
                section.appendChild(fieldsDiv);
                
                // Pre-populate universal label/value fields from task defaults if not already set
                const labelFieldInput = document.getElementById('label_field');
                const valueFieldInput = document.getElementById('value_field');
                if (labelFieldInput && !fieldConfig.label_field && task.label_field) {
                    labelFieldInput.value = task.label_field;
                }
                if (valueFieldInput && !fieldConfig.value_field && task.value_field) {
                    valueFieldInput.value = task.value_field;
                }
                
                // Attach change listeners to new fields
                fieldsDiv.querySelectorAll('.settings-field, input, select, textarea').forEach(el => {
                    el.addEventListener('input', showElementSettingsDirty);
                });
            }
        }
        
        showElementSettingsDirty();
    });
}


function attachDropdownWorkflowListeners() {
    const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid) || {};
    const workflowSelect = document.getElementById('workflow_id');
    
    // Only proceed if workflow_id element exists (means we're dealing with a workflow dropdown)
    if (!workflowSelect) {
        return;
    }

    const currentVal = workflowSelect.dataset.current || fieldConfig.workflow_id || '';

    workflowSelect.innerHTML = '<option value="">-- Select workflow --</option>';
    availableWorkflows.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.id;
        opt.textContent = w.name;
        if (w.id === currentVal) opt.selected = true;
        workflowSelect.appendChild(opt);
    });
    workflowSelect.disabled = availableWorkflows.length === 0;
    if (availableWorkflows.length === 0) {
        workflowSelect.innerHTML = '<option value="">No workflows available</option>';
    }

    // If already selected, render inputs and outputs immediately
    if (currentVal) {
        const workflow = availableWorkflows.find(w => w.id === currentVal);
        if (workflow) {
            renderWorkflowInputFields(workflow, fieldConfig);
            buildWorkflowOutputs(workflow, fieldConfig);
        }
    }

    workflowSelect.addEventListener('change', () => {
        const workflow = availableWorkflows.find(w => w.id === workflowSelect.value);
        fieldConfig.workflow_id = workflowSelect.value;
        fieldConfig.workflow_input = {};
        fieldConfig.workflow_output = '';
        renderWorkflowInputFields(workflow || null, fieldConfig);
        buildWorkflowOutputs(workflow || null, fieldConfig);
        showElementSettingsDirty();
    });
}

function renderWorkflowInputFields(workflow, fieldConfig) {
    // Find the workflow_inputs_section container
    const container = document.getElementById('workflow_inputs_section');
    if (!container) return;
    
    if (!workflow) {
        container.innerHTML = '';
        return;
    }
    
    const inputVars = workflow.definition?.inputVariables || [];
    container.innerHTML = ''; // Clear existing content

    if (workflow.definition?.description) {
        const desc = document.createElement('div');
        desc.style.cssText = 'color: #999; font-size: 12px; margin-bottom: 12px;';
        desc.textContent = workflow.definition.description;
        container.appendChild(desc);
    }

    if (inputVars.length > 0) {
        inputVars.forEach(input => {
            const group = document.createElement('div');
            group.className = 'form-group';
            const savedVal = fieldConfig.workflow_input?.[input.name] || '';
            group.innerHTML = `
                <label>${input.name}</label>
                <input type="text" class="settings-field workflow-input-field"
                    data-input-name="${input.name}"
                    value="${savedVal}"
                    placeholder="e.g. [[field_name]] or static value">
            `;
            container.appendChild(group);
        });
    }

    container.querySelectorAll('.settings-field').forEach(el => {
        el.addEventListener('input', () => {
            const inputName = el.dataset.inputName;
            if (inputName) {
                if (!fieldConfig.workflow_input) fieldConfig.workflow_input = {};
                fieldConfig.workflow_input[inputName] = el.value;
            }
            showElementSettingsDirty();
        });
    });
}

function buildWorkflowOutputs(fieldConfig) {
    // Create a container for workflow output field (area renderer)
    console.log('[buildWorkflowOutputs area renderer] Creating container');
    return `
        <div id="workflow_output_group" class="form-group" style="border-left: 2px solid #444; padding-left: 12px;">
        </div>
    `;
}

function populateWorkflowOutputs(workflow, fieldConfig) {
    console.log('[populateWorkflowOutputs] Called with workflow:', workflow);
    const container = document.getElementById('workflow_output_group');
    console.log('[populateWorkflowOutputs] Container found:', container);
    
    if (!container) {
        console.warn('[populateWorkflowOutputs] workflow_output_group container not found!');
        return;
    }
    
    if (!workflow) {
        console.log('[populateWorkflowOutputs] No workflow, clearing container');
        container.innerHTML = '';
        return;
    }

    const outputVars = workflow.definition?.outputVariables || [];
    console.log('[populateWorkflowOutputs] Output variables:', outputVars);
    
    if (outputVars.length > 0) {
        container.innerHTML = `
            <label style="display: inline-flex; align-items: center;">Output Variable${infoIcon('Select which output from the workflow should populate this dropdown.')}</label>
            <select id="workflow_output" class="settings-field" style="width: 100%; padding: 8px;">
                <option value="">-- Select output variable --</option>
                ${outputVars.map(output => `
                    <option value="${output.name}" ${output.name === (fieldConfig.workflow_output || '') ? 'selected' : ''}>
                        ${output.name}
                    </option>
                `).join('')}
            </select>
        `;
    } else {
        console.log('[populateWorkflowOutputs] No output variables available');
        container.innerHTML = `
            <label style="display: inline-flex; align-items: center;">Output Variable${infoIcon('Select which output from the workflow should populate this dropdown.')}</label>
            <select id="workflow_output" class="settings-field" disabled style="width: 100%; padding: 8px;">
                <option value="">No output variables available</option>
            </select>
        `;
    }
    
    // Add change listener
    const outputSelect = document.getElementById('workflow_output');
    if (outputSelect) {
        outputSelect.addEventListener('change', () => {
            console.log('[workflow_output change] Selected:', outputSelect.value);
            fieldConfig.workflow_output = outputSelect.value;
            showElementSettingsDirty();
        });
    }
}

function attachDataRetrievalListeners() {
    const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid);
    if (!fieldConfig || fieldConfig.type !== 'data_retrieval') {
        return;
    }

    // Data source type selector
    const dataSourceTypeSelect = document.getElementById('data_source_type');
    if (dataSourceTypeSelect) {
        dataSourceTypeSelect.addEventListener('change', (e) => {
            const oldType = fieldConfig.data_source_type;
            const newType = e.target.value;
            
            if (newType !== oldType) {
                fieldConfig.data_source_type = newType;
                
                // Clear old type's fields
                if (oldType === 'Workflow') {
                    delete fieldConfig.workflow_id;
                    delete fieldConfig.workflow_input;
                    delete fieldConfig.workflow_output;
                } else if (oldType === 'SQL') {
                    delete fieldConfig.database;
                    delete fieldConfig.query;
                } else if (oldType === 'Plugin') {
                    delete fieldConfig.plugin;
                    delete fieldConfig.task_id;
                    delete fieldConfig.inputs_map;
                }
                
                // Rebuild form
                showElementSettings(selectedElementUid);
                showElementSettingsDirty();
            }
        });
    }
    
    // SQL Database selector
    const sqlDatabaseSelect = document.getElementById('sql_database');
    if (sqlDatabaseSelect) {
        sqlDatabaseSelect.innerHTML = '<option value="">-- Select datasource --</option>';
        sqlDatasources.forEach(ds => {
            const opt = document.createElement('option');
            opt.value = ds;
            opt.textContent = ds;
            if (ds === fieldConfig.database) opt.selected = true;
            sqlDatabaseSelect.appendChild(opt);
        });
        sqlDatabaseSelect.addEventListener('change', () => {
            fieldConfig.database = sqlDatabaseSelect.value;
            showElementSettingsDirty();
        });
    }
    
    // SQL Query button
    const sqlQueryBtn = document.getElementById('sql_query_btn');
    const sqlQueryDisplay = document.getElementById('sql_query_display');
    if (sqlQueryBtn && sqlQueryDisplay) {
        sqlQueryBtn.addEventListener('click', () => {
            const currentQuery = sqlQueryDisplay.dataset.query || '';
            
            const container = document.createElement('div');
            
            const hint = document.createElement('p');
            hint.style.cssText = 'margin: 0 0 10px 0; color: #999; font-size: 12px;';
            hint.innerHTML = 'Use <code style="background: var(--bg-input); padding: 1px 5px; border-radius: 3px; font-size: 12px;">[[field_name]]</code> to reference form fields';
            
            const textarea = document.createElement('textarea');
            textarea.value = currentQuery;
            textarea.style.cssText = 'width: 100%; height: 300px; font-family: monospace; font-size: 13px; resize: vertical; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-primary); border-radius: 4px; padding: 10px; box-sizing: border-box;';
            textarea.placeholder = 'SELECT id, name FROM table WHERE ...';
            
            container.appendChild(hint);
            container.appendChild(textarea);

            showModal({
                title: 'SQL Query',
                content: container,
                buttons: [
                    {
                        label: 'Save',
                        type: 'primary',
                        onClick: () => {
                            sqlQueryDisplay.dataset.query = textarea.value;
                            sqlQueryBtn.textContent = textarea.value.trim().length > 0 ? '✓ Edit SQL Query' : 'Edit SQL Query';
                            fieldConfig.query = textarea.value;
                            showElementSettingsDirty();
                            closeModal();
                        }
                    },
                    { label: 'Cancel', type: 'secondary', onClick: closeModal }
                ]
            });
        });
    }
    
    // Plugin selector
    const pluginSelect = document.getElementById('plugin_name');
    if (pluginSelect) {
        pluginSelect.innerHTML = '<option value="">-- Select plugin --</option>';
        availablePlugins.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.display_name || p.name;
            if (p.name === fieldConfig.plugin) opt.selected = true;
            pluginSelect.appendChild(opt);
        });
        pluginSelect.addEventListener('change', () => {
            fieldConfig.plugin = pluginSelect.value;
            showElementSettings(selectedElementUid);
            showElementSettingsDirty();
        });
    }
    
    // Workflow selector
    const workflowSelect = document.getElementById('workflow_id');
    if (workflowSelect) {
        const currentVal = workflowSelect.dataset.current || fieldConfig.workflow_id || '';
        workflowSelect.innerHTML = '<option value="">-- Select workflow --</option>';
        availableWorkflows.forEach(w => {
            const opt = document.createElement('option');
            opt.value = w.id;
            opt.textContent = w.name;
            if (w.id === currentVal) opt.selected = true;
            workflowSelect.appendChild(opt);
        });
        workflowSelect.disabled = availableWorkflows.length === 0;
        if (availableWorkflows.length === 0) {
            workflowSelect.innerHTML = '<option value="">No workflows available</option>';
        }
        
        // Render inputs/outputs if workflow already selected
        if (currentVal) {
            const workflow = availableWorkflows.find(w => w.id === currentVal);
            if (workflow) {
                renderDataRetrievalWorkflowFields(workflow, fieldConfig);
            }
        }
        
        workflowSelect.addEventListener('change', () => {
            const workflow = availableWorkflows.find(w => w.id === workflowSelect.value);
            fieldConfig.workflow_id = workflowSelect.value;
            fieldConfig.workflow_input = {};
            fieldConfig.workflow_output = '';
            renderDataRetrievalWorkflowFields(workflow || null, fieldConfig);
            showElementSettingsDirty();
        });
    }
}

function renderDataRetrievalWorkflowFields(workflow, fieldConfig) {
    document.getElementById('dr_workflow_inputs_section')?.remove();
    document.getElementById('dr_workflow_outputs_section')?.remove();
    
    if (!workflow) return;
    
    const anchor = document.getElementById('dr_type_specific_fields');
    if (!anchor) return;
    
    const inputVars = workflow.definition?.inputVariables || [];
    const outputVars = workflow.definition?.outputVariables || [];
    
    // Render input variables
    if (inputVars.length > 0) {
        const inputSection = document.createElement('div');
        inputSection.id = 'dr_workflow_inputs_section';
        
        inputVars.forEach(input => {
            const group = document.createElement('div');
            group.className = 'form-group';
            const savedVal = fieldConfig.workflow_input?.[input.name] || '';
            group.innerHTML = `
                <label>${input.name}</label>
                <input type="text" class="settings-field workflow-input-field"
                    data-input-name="${input.name}"
                    value="${savedVal}"
                    placeholder="Enter value or [[variable]]">
            `;
            inputSection.appendChild(group);
            
            group.querySelector('input').addEventListener('input', () => {
                showElementSettingsDirty();
            });
        });
        
        anchor.appendChild(inputSection);
    }
    
    // Render output variable selector
    if (outputVars.length > 0) {
        const outputSection = document.createElement('div');
        outputSection.id = 'dr_workflow_outputs_section';
        outputSection.className = 'form-group';
        outputSection.innerHTML = `
            <label style="display: inline-flex; align-items: center;">Output Variable${infoIcon('Select which output from the workflow should be stored in this data retrieval element.')}</label>
            <select id="workflow_output" class="settings-field">
                <option value="">-- Select output variable --</option>
                ${outputVars.map(v => `<option value="${v}" ${fieldConfig.workflow_output === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
        `;
        anchor.appendChild(outputSection);
        
        document.getElementById('dr_workflow_output').addEventListener('change', () => {
            fieldConfig.workflow_output = document.getElementById('dr_workflow_output').value;
            showElementSettingsDirty();
        });
    }
}

function attachDropdownPrefetchListeners() {
    const sourceSelect = document.getElementById('prefetch_source_element_name');
    if (!sourceSelect) return;
    
    const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid) || {};
    
    // Populate data retrieval elements
    sourceSelect.innerHTML = '<option value="">-- Select Data Source --</option>';
    const dataRetrievalElements = fieldConfigs.filter(f => f.type === 'data_retrieval');
    dataRetrievalElements.forEach(el => {
        const opt = document.createElement('option');
        opt.value = el.field_name;
        opt.textContent = el.field_name;
        if (el.field_name === fieldConfig.source_element_name) opt.selected = true;
        sourceSelect.appendChild(opt);
    });
    
    // Add input listeners
    [sourceSelect, document.getElementById('prefetch_result_path'),
     document.getElementById('prefetch_default_selector')].forEach(input => {
        if (input) {
            input.addEventListener('change', showElementSettingsDirty);
            input.addEventListener('input', showElementSettingsDirty);
        }
    });
}

function attachDropdownTreeListeners() {
    const sourceSelect = document.getElementById('tree_source_element_name');
    if (!sourceSelect) return;
    
    const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid) || {};
    
    // Populate data retrieval elements
    sourceSelect.innerHTML = '<option value="">-- Select Data Source --</option>';
    const dataRetrievalElements = fieldConfigs.filter(f => f.type === 'data_retrieval');
    dataRetrievalElements.forEach(el => {
        const opt = document.createElement('option');
        opt.value = el.field_name;
        opt.textContent = el.field_name;
        if (el.field_name === fieldConfig.source_element_name) opt.selected = true;
        sourceSelect.appendChild(opt);
    });
    
    // Add input listeners
    [sourceSelect, document.getElementById('tree_parent_field'),
     document.getElementById('tree_level_field'),
     document.getElementById('tree_default_selector')].forEach(input => {
        if (input) {
            input.addEventListener('change', showElementSettingsDirty);
            input.addEventListener('input', showElementSettingsDirty);
        }
    });
}

function updateDefaultValueOptions() {
    const optionLabels = document.querySelectorAll('.option-label');
    const optionValues = document.querySelectorAll('.option-value');
    const defaultValueSelect = document.getElementById('default_value');
    
    if (!defaultValueSelect) return;
    
    const currentValue = defaultValueSelect.value;
    defaultValueSelect.innerHTML = '<option value="">-- Select a default value --</option>';
    
    optionValues.forEach((valueInput, index) => {
        if (valueInput.value) {
            const option = document.createElement('option');
            option.value = valueInput.value;
            option.textContent = valueInput.value;
            if (valueInput.value === currentValue) {
                option.selected = true;
            }
            defaultValueSelect.appendChild(option);
        }
    });
}

// ============================================
/**
 * Save type-specific field values from the form
 */
function saveTypeSpecificFields(fieldConfig) {
    const elementType = fieldConfig.type;
    
    try {
        // Define fields to keep for each dropdown type (all others will be deleted)
        const dropdownFieldMap = {
            'dropdown_static': ['options', 'default_value', 'multi_select', 'searchable', 'result_var'],
            'dropdown_workflow': ['workflow_id', 'workflow_input', 'workflow_output', 'label_field', 'value_field', 'default_selector', 'multi_select', 'searchable', 'result_var', 'tree_view', 'parent_field', 'level_field'],
            'dropdown_sql': ['database', 'query', 'label_field', 'value_field', 'default_selector', 'multi_select', 'searchable', 'result_var', 'tree_view', 'parent_field', 'level_field'],
            'dropdown_plugin': ['plugin', 'task_id', 'label_field', 'value_field', 'inputs_map', 'multi_select', 'searchable', 'result_var', 'tree_view', 'parent_field', 'level_field'],
            'dropdown_prefetch': ['source_element_name', 'result_path', 'label_field', 'value_field', 'default_selector', 'multi_select', 'searchable', 'result_var']
        };
        
        // Helper: Save common dropdown-style fields
        const saveDropdownCommonFields = (idPrefix = '') => {
            fieldConfig.default_selector = document.getElementById(`${idPrefix}default_selector`)?.value || 'default';
            fieldConfig.multi_select = document.getElementById('multi_select')?.checked || false;
            fieldConfig.searchable = document.getElementById('searchable')?.checked !== false;
            fieldConfig.result_var = document.getElementById('result_var')?.value || '';
            fieldConfig.label_field = document.getElementById('label_field')?.value || '';
            fieldConfig.value_field = document.getElementById('value_field')?.value || '';
        };
        
        // Helper: Save PSA API fields
        const savePSAFields = (idPrefix = '') => {
            fieldConfig.endpoint = document.getElementById(`${idPrefix}endpoint`)?.value || '';
            fieldConfig.method = document.getElementById(`${idPrefix}method`)?.value || 'GET';
            fieldConfig.fields = document.getElementById(`${idPrefix}fields`)?.value || '';
            fieldConfig.conditions = document.getElementById(`${idPrefix}conditions`)?.value || '';
            fieldConfig.childConditions = document.getElementById(`${idPrefix}child_conditions`)?.value || '';
            fieldConfig.orderBy = document.getElementById(`${idPrefix}order_by`)?.value || '';
            fieldConfig.pageAll = document.getElementById(`${idPrefix}page_all`)?.checked || true;
            fieldConfig.pageSize = parseInt(document.getElementById(`${idPrefix}page_size`)?.value || 1000);
            fieldConfig.page = parseInt(document.getElementById(`${idPrefix}page`)?.value || 1);
            fieldConfig.timeout = parseInt(document.getElementById(`${idPrefix}timeout`)?.value || 30000);
            fieldConfig.flatten = document.getElementById(`${idPrefix}flatten`)?.checked !== false;
        };
        
        // Clean up dropdown fields based on type
        if (dropdownFieldMap[elementType]) {
            const fieldsToKeep = dropdownFieldMap[elementType];
            const allDropdownFields = ['options', 'default_value', 'workflow_id', 'workflow_input', 'workflow_output', 'label_field', 'value_field',
                'default_selector', 'query', 'database', 'plugin', 'task_id', 'inputs_map',
                'source_element_name', 'result_path', 'parent_field', 'level_field', 'tree_view',
                'multi_select', 'searchable', 'result_var'];
            
            allDropdownFields.forEach(field => {
                if (!fieldsToKeep.includes(field)) {
                    delete fieldConfig[field];
                }
            });
        }
        
        // Type-specific field handling
        if (elementType === 'checkbox' && document.getElementById('default_checked')) {
            fieldConfig.default_checked = document.getElementById('default_checked').checked;
        } else if (elementType === 'radio') {
            fieldConfig.default_select = document.getElementById('default_select')?.value || null;
            fieldConfig.horiz = document.getElementById('radio_horiz')?.checked || false;
            const radioOptionRows = document.querySelectorAll('.radio-option-row');
            const options = {};
            radioOptionRows.forEach(row => {
                const labelInput = row.querySelector('.radio-option-label');
                const valueInput = row.querySelector('.radio-option-value');
                if (labelInput && valueInput) {
                    const label = labelInput.value.trim();
                    const value = valueInput.value.trim();
                    if (label && value) options[label] = value;
                }
            });
            fieldConfig.options = options;
        } else if (['text', 'textarea'].includes(elementType) && document.getElementById('default_value')) {
            fieldConfig.default_value = document.getElementById('default_value').value || null;
        } else if (elementType === 'html' && document.getElementById('content')) {
            fieldConfig.content = document.getElementById('content').value || '';
        } else if (elementType === 'dropdown_static') {
            fieldConfig.default_value = document.getElementById('default_value')?.value || null;
            fieldConfig.multi_select = document.getElementById('multi_select')?.checked || false;
            fieldConfig.searchable = document.getElementById('searchable')?.checked !== false;
            fieldConfig.result_var = document.getElementById('result_var')?.value || '';
            const optionRows = document.querySelectorAll('.option-row');
            const options = {};
            optionRows.forEach(row => {
                const labelInput = row.querySelector('.option-label');
                const valueInput = row.querySelector('.option-value');
                if (labelInput && valueInput) {
                    const label = labelInput.value.trim();
                    const value = valueInput.value.trim();
                    if (label && value) options[label] = value;
                }
            });
            fieldConfig.options = options;
        } else if (elementType === 'dropdown_workflow') {
            fieldConfig.workflow_id = document.getElementById('workflow_id')?.value || null;
            const workflowInput = {};
            document.querySelectorAll('.workflow-input-field').forEach(el => {
                if (el.dataset.inputName) {
                    let value = el.value.trim();
                    try {
                        if (value.startsWith('{') || value.startsWith('[') || value === 'true' || value === 'false' || (!isNaN(value) && value !== '')) {
                            value = JSON.parse(value);
                        }
                    } catch (e) {}
                    workflowInput[el.dataset.inputName] = value;
                }
            });
            fieldConfig.workflow_input = workflowInput;
            fieldConfig.workflow_output = document.getElementById('workflow_output')?.value || null;
            fieldConfig.tree_view = document.getElementById('tree_view')?.checked || false;
            fieldConfig.parent_field = fieldConfig.tree_view ? (document.getElementById('tree_parent_field')?.value || '') : '';
            fieldConfig.level_field = fieldConfig.tree_view ? (document.getElementById('tree_level_field')?.value || '') : '';
            saveDropdownCommonFields();
        } else if (elementType === 'dropdown_sql') {
            fieldConfig.database = document.getElementById('sql_database')?.value || '';
            fieldConfig.query = document.getElementById('sql_query_display')?.dataset.query || fieldConfig.query || '';
            fieldConfig.default_selector = document.getElementById('sql_default_selector')?.value || 'default';
            fieldConfig.tree_view = document.getElementById('tree_view')?.checked || false;
            fieldConfig.parent_field = fieldConfig.tree_view ? (document.getElementById('tree_parent_field')?.value || '') : '';
            fieldConfig.level_field = fieldConfig.tree_view ? (document.getElementById('tree_level_field')?.value || '') : '';
            saveDropdownCommonFields();
        } else if (elementType === 'dropdown_plugin') {
            fieldConfig.plugin = document.getElementById('plugin_name')?.value || '';
            fieldConfig.task_id = parseInt(document.getElementById('plugin_task')?.value) || null;
            fieldConfig.inputs_map = extractTaskInputs();
            fieldConfig.tree_view = document.getElementById('tree_view')?.checked || false;
            fieldConfig.parent_field = fieldConfig.tree_view ? (document.getElementById('tree_parent_field')?.value || '') : '';
            fieldConfig.level_field = fieldConfig.tree_view ? (document.getElementById('tree_level_field')?.value || '') : '';
            saveDropdownCommonFields();
        } else if (elementType === 'data_retrieval') {
            fieldConfig.data_source_type = document.getElementById('data_source_type')?.value || 'workflow';
            
            if (fieldConfig.data_source_type === 'Workflow') {
                fieldConfig.workflow_id = document.getElementById('workflow_id')?.value || null;
                const workflowInput = {};
                document.querySelectorAll('.workflow-input-field').forEach(el => {
                    if (el.dataset.inputName) {
                        let value = el.value.trim();
                        try {
                            if (value.startsWith('{') || value.startsWith('[') || value === 'true' || value === 'false' || (!isNaN(value) && value !== '')) {
                                value = JSON.parse(value);
                            }
                        } catch (e) {}
                        workflowInput[el.dataset.inputName] = value;
                    }
                });
                fieldConfig.workflow_input = workflowInput;
                fieldConfig.workflow_output = document.getElementById('dr_workflow_output')?.value || null;
            } else if (fieldConfig.data_source_type === 'SQL') {
                fieldConfig.database = document.getElementById('sql_database')?.value || '';
                fieldConfig.query = document.getElementById('sql_query_display')?.dataset.query || fieldConfig.query || '';
            } else if (fieldConfig.data_source_type === 'Plugin') {
                fieldConfig.plugin = document.getElementById('plugin_name')?.value || '';
                fieldConfig.task_id = parseInt(document.getElementById('plugin_task')?.value) || null;
                fieldConfig.inputs_map = extractTaskInputs();
            }
            
            // Clear all non-relevant fields
            const dataRetrievalFields = ['workflow_id', 'workflow_input', 'workflow_output', 'label_name', 'value_name',
                'database', 'query', 'plugin', 'task_id', 'inputs_map'];
            const allConfigKeys = Object.keys(fieldConfig);
            allConfigKeys.forEach(key => {
                if (dataRetrievalFields.includes(key) && !fieldConfig.hasOwnProperty(key) || 
                    (fieldConfig.data_source_type === 'Workflow' && ['database', 'query', 'plugin', 'task_id', 'inputs_map'].includes(key)) ||
                    (fieldConfig.data_source_type === 'SQL' && ['workflow_id', 'workflow_input', 'workflow_output', 'plugin', 'task_id', 'inputs_map'].includes(key)) ||
                    (fieldConfig.data_source_type === 'Plugin' && ['workflow_id', 'workflow_input', 'workflow_output', 'database', 'query'].includes(key))) {
                    delete fieldConfig[key];
                }
            });
        } else if (elementType === 'dropdown_prefetch') {
            fieldConfig.source_element_name = document.getElementById('prefetch_source_element_name')?.value || '';
            fieldConfig.result_path = document.getElementById('prefetch_result_path')?.value || '';
            fieldConfig.default_selector = document.getElementById('prefetch_default_selector')?.value || 'default';
            saveDropdownCommonFields();
        } else if (elementType === 'datatable') {
            fieldConfig.data_variable = document.getElementById('datatable_data_variable')?.value || '';
            fieldConfig.list_view = document.getElementById('datatable_list_view')?.checked || false;
        } else if (elementType === 'form_extend') {
            fieldConfig.extend_var = document.getElementById('extend_var')?.value || null;
            fieldConfig.extend_var_variables = {};
            const extendVarInputsContainer = document.getElementById('extend_var_inputs_container');
            if (extendVarInputsContainer && fieldConfig.extend_var) {
                const operation = RewstLib.graphqlOperations.get(fieldConfig.extend_var);
                if (operation && operation.inputs) {
                    operation.inputs.forEach(input => {
                        const inputElement = document.getElementById(`extend_var_input_${input.name}`);
                        if (inputElement) {
                            fieldConfig.extend_var_variables[input.name] = inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value;
                        }
                    });
                }
            }
        } else if (elementType === 'array') {
            fieldConfig.repeating_input_mode = document.getElementById('repeating_input_mode')?.checked || false;
            fieldConfig.source = document.getElementById('repeating_input_source')?.value || '';
            console.log('[SAVE] Array items already saved via modal:', fieldConfig.items);
            console.log('[SAVE] Repeating input mode:', fieldConfig.repeating_input_mode, 'Source:', fieldConfig.source);
        }
    } catch (error) {
        console.error('Error saving type-specific fields:', error);
    }
}

// ============================================
// HELPER: Get config value with backward compatibility
// ============================================
function getConfigValue(config, ...keys) {
    for (const key of keys) {
        if (config[key] !== undefined) return config[key];
    }
    return undefined;
}

// ============================================
// HELPER: Get or create hidden input field
// ============================================
function getOrCreateHiddenField(fieldId) {
    let field = document.getElementById(fieldId);
    if (!field) {
        field = document.createElement('input');
        field.type = 'hidden';
        field.id = fieldId;
        document.body.appendChild(field);
    }
    return field;
}

// ============================================
// FORM LOADING
// ============================================
function loadFormConfiguration(config) {
    console.log('Loading form configuration:', config);
    
    // Clear existing form
    fieldConfigs.length = 0;
    const topSpanningZone = document.getElementById('topSpanningZone');
    const bottomSpanningZone = document.getElementById('bottomSpanningZone');
    const spanningZones = [topSpanningZone, bottomSpanningZone].filter(Boolean);
    const spanContent = '<div style="color: #999; text-align: center;">Span All Columns</div>';
    spanningZones.forEach(zone => zone.innerHTML = spanContent);
    
    [leftFormColumn, rightFormColumn, thirdFormColumn].filter(Boolean).forEach(col => col.innerHTML = '');
    
    // Reset element counters
    ELEMENT_TYPES.forEach(type => {
        droppedElementCount[type] = 0;
    });
    
    // Set form name
    const formNameValue = getConfigValue(config, 'name', 'extend_title', 'formName', 'form_name');
    if (formNameValue) {
        const extendTitleInput = document.getElementById('extend_title');
        if (extendTitleInput) extendTitleInput.value = formNameValue;
        if (formNameInput) formNameInput.value = formNameValue;
    }
    
    // Set show name
    const showNameValue = getConfigValue(config, 'show_name', 'show_title', 'showName', 'show_form');
    if (showNameValue !== undefined && hiddenShowName) {
        hiddenShowName.checked = showNameValue;
    }

    // Set formVersion
    const formVersion = getConfigValue(config, 'version');
    if (formVersion !== undefined && hiddenFormVersion) {
        hiddenFormVersion.value = formVersion;
    }

    // Restore form-level settings
    window._formSettings = window._formSettings || {};
    if (config.submit_type !== undefined) window._formSettings.submit_type = config.submit_type;
    if (config.submit_workflow_id !== undefined) window._formSettings.submit_workflow_id = config.submit_workflow_id;
    
    // Set show vertical separator
    const showVertSepValue = getConfigValue(config, 'show_vert_sep', 'showVertSep');
    const showVertSepCheckbox = document.getElementById('show_vert_sep');
    if (showVertSepCheckbox && showVertSepValue !== undefined) {
        showVertSepCheckbox.checked = showVertSepValue;
    }
    
    // Set columns
    const columnCountValue = getConfigValue(config, 'columnCount', 'column_count');
    if (hiddenFormColumns && columnCountValue) {
        hiddenFormColumns.value = columnCountValue.toString();
        updateColumnDisplay();
    }
    
    // Load field configs
    const fieldConfigsArray = getConfigValue(config, 'fieldConfigs', 'field_configs');
    if (fieldConfigsArray && Array.isArray(fieldConfigsArray)) {
        fieldConfigsArray.forEach(fieldConfig => {
            if (fieldConfig.sequence === undefined) {
                const elementsInColumn = fieldConfigs.filter(f => f.column === (fieldConfig.column || 1)).length;
                fieldConfig.sequence = elementsInColumn + 1;
            }
            fieldConfigs.push(fieldConfig);
            
            // Update element counter
            const typeMatch = fieldConfig.field_name.match(/^(\w+)_(\d+)$/);
            if (typeMatch) {
                const type = typeMatch[1];
                const num = parseInt(typeMatch[2]);
                if (droppedElementCount[type] === undefined || num > droppedElementCount[type]) {
                    droppedElementCount[type] = num;
                }
            }
        });
        
        // Sort by column, then sequence
        const sortedConfigs = [...fieldConfigs].sort((a, b) => {
            const colA = a.column !== undefined ? a.column : 1;
            const colB = b.column !== undefined ? b.column : 1;
            if (colA !== colB) return colA - colB;
            return (a.sequence || 0) - (b.sequence || 0);
        });
        
        // Render elements
        sortedConfigs.forEach(fieldConfig => {
            const newElement = document.createElement('div');
            newElement.className = 'btn';
            newElement.setAttribute('data-size', 'sm');
            newElement.draggable = true;
            newElement.dataset.uid = fieldConfig.uid;
            newElement.dataset.fieldName = fieldConfig.field_name;
            newElement.style.cursor = 'move';
            newElement.style.margin = '6px 0';
            
            const displayLabel = fieldConfig.field_displayname?.trim() || fieldConfig.field_name;
            newElement.innerHTML = `<span style="flex: 1; text-align: center;">${displayLabel}</span><button style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0; margin-left: 10px;">×</button>`;
            
            attachElementEventListeners(newElement);
            
            // Add to appropriate zone/column
            const columnNum = fieldConfig.column !== undefined ? fieldConfig.column : 1;
            if (columnNum === 0 && topSpanningZone) {
                topSpanningZone.appendChild(newElement);
            } else if (columnNum === 99 && bottomSpanningZone) {
                bottomSpanningZone.appendChild(newElement);
            } else if (columnNum === 1 && leftFormColumn) {
                leftFormColumn.appendChild(newElement);
            } else if (columnNum === 2 && rightFormColumn) {
                rightFormColumn.appendChild(newElement);
            } else if (columnNum === 3 && thirdFormColumn) {
                thirdFormColumn.appendChild(newElement);
            }
        });
    }
    
    // Update displays
    updateSaveButtonState();
    
    // Sync radio buttons with column count
    const columnValue = hiddenFormColumns.value;
    document.querySelectorAll('input[name="formColumns"]').forEach(radio => {
        radio.checked = radio.value === columnValue;
    });
    
    // Update vertical separator checkbox
    if (showVertSepCheckbox) {
        const columnCount = parseInt(columnValue);
        showVertSepCheckbox.disabled = columnCount === 1;
    }
    
    // Load output variable
    const hiddenOutputVar = getOrCreateHiddenField('hidden_output_var');
    hiddenOutputVar.value = getConfigValue(config, 'output_var', 'outputVar') || '';
    
    // Load form permissions
    const permissionsSelect = document.getElementById('permissionsSelect');
    if (permissionsSelect) {
        const permissionsValue = config.permissions || [];
        permissionsSelect.setAttribute('data-selected-values', JSON.stringify(permissionsValue));
        console.log('[LOAD] Loaded form permissions:', permissionsSelect.getAttribute('data-selected-values'));
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

// ============================================
// HIDDEN FIELDS FOR STATE PERSISTENCE
// ============================================
const hiddenShowName = document.createElement('input');
hiddenShowName.type = 'checkbox';
hiddenShowName.id = 'show_name';
hiddenShowName.checked = true;
hiddenShowName.style.display = 'none';
document.body.appendChild(hiddenShowName);

const hiddenFormVersion = document.createElement('input');
hiddenFormVersion.type = 'text';
hiddenFormVersion.id = 'version';
hiddenFormVersion.value = null;
hiddenFormVersion.style.display = 'none';
document.body.appendChild(hiddenFormVersion);

const hiddenFormColumns = document.createElement('select');
hiddenFormColumns.id = 'form_columns';
hiddenFormColumns.style.display = 'none';
hiddenFormColumns.innerHTML = '<option value="1" selected>1</option><option value="2">2</option><option value="3">3</option>';
document.body.appendChild(hiddenFormColumns);

// ============================================
// DOM ELEMENT REFERENCES
// ============================================
columnsSelect = hiddenFormColumns;
formColumnsSelect = hiddenFormColumns;
formNameInput = document.getElementById('form_name');
settingsPanel = document.getElementById('settingsPanel');
emptySettings = document.getElementById('emptySettings');
settingsForm = document.getElementById('settingsForm');

// ============================================
// LOAD AND DELETE BUTTON HANDLERS
// ============================================

// Helper: Move elements between columns
function moveElementsToColumn(sourceElements, targetColumn) {
    sourceElements.forEach(element => {
        if (element.dataset.uid) {
            const fieldConfig = fieldConfigs.find(f => f.uid === element.dataset.uid);
            if (fieldConfig) fieldConfig.column = targetColumn;
            [leftFormColumn, rightFormColumn, thirdFormColumn][targetColumn - 1]?.appendChild(element);
        }
    });
}

// Helper: Set spanning zone visibility
function setSpanningZonesVisible(visible) {
    const topSpanningZone = document.getElementById('topSpanningZone');
    const bottomSpanningZone = document.getElementById('bottomSpanningZone');
    const display = visible ? 'block' : 'none';
    if (topSpanningZone) topSpanningZone.style.display = display;
    if (bottomSpanningZone) bottomSpanningZone.style.display = display;
}

// Helper: Update vertical separator checkbox state
function updateVertSepCheckboxState(columnCount) {
    const showVertSepCheckbox = document.getElementById('show_vert_sep');
    if (showVertSepCheckbox) {
        showVertSepCheckbox.disabled = columnCount === 1;
        if (columnCount === 1 && showVertSepCheckbox.checked) {
            showVertSepCheckbox.checked = false;
            if (columnDivider1) columnDivider1.style.display = 'none';
            if (columnDivider2) columnDivider2.style.display = 'none';
        }
    }
}

// Perform actual form loading
async function performFormLoad(formConfig) {
    if (!formConfig) {
        console.error('No form configuration provided');
        return;
    }
    
    // Parse if it's a string
    if (typeof formConfig === 'string') {
        try {
            formConfig = JSON.parse(formConfig);
        } catch (e) {
            console.error('Error parsing form_config:', e);
            return;
        }
    }
    
    loadFormConfiguration(formConfig);
    // Snapshot loaded state as baseline for unsaved changes tracking
    initializeUnsavedTracking(buildFormConfig());
    updateSaveButtonState();
}

// ============================================
// COLUMN MANAGEMENT
// ============================================
function updateColumnDisplay() {
    if (!formColumnsSelect || !leftFormColumn || !rightFormColumn || !thirdFormColumn) {
        console.error('Column elements not found');
        return;
    }
    
    const numColumns = parseInt(formColumnsSelect.value);
    
    if (numColumns === 1) {
        setSpanningZonesVisible(false);
        moveElementsToColumn(Array.from(rightFormColumn.children), 1);
        moveElementsToColumn(Array.from(thirdFormColumn.children), 1);
        rightFormColumn.style.display = 'none';
        columnDivider1.style.display = 'none';
        thirdFormColumn.style.display = 'none';
        columnDivider2.style.display = 'none';
    } else if (numColumns === 2) {
        setSpanningZonesVisible(true);
        moveElementsToColumn(Array.from(thirdFormColumn.children), 1);
        rightFormColumn.style.display = 'block';
        columnDivider1.style.display = 'block';
        thirdFormColumn.style.display = 'none';
        columnDivider2.style.display = 'none';
    } else if (numColumns === 3) {
        setSpanningZonesVisible(true);
        rightFormColumn.style.display = 'block';
        columnDivider1.style.display = 'block';
        thirdFormColumn.style.display = 'block';
        columnDivider2.style.display = 'block';
    }
}

// Initialize column display and permissions
function initializeFormLayout() {
    updateColumnDisplay();
    const permissionsSelect = document.getElementById('permissionsSelect');
    if (permissionsSelect) {
        permissionsSelect.setAttribute('data-selected-values', JSON.stringify(['role-admin']));
    }
    updateVertSepCheckboxState(parseInt(formColumnsSelect.value));
}

// Set up column change handlers
if (formColumnsSelect) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeFormLayout);
    } else {
        initializeFormLayout();
    }
    
    // Combined handler for all column change events
    const handleColumnChange = (value) => {
        formColumnsSelect.value = value;
        updateColumnDisplay();
        updateVertSepCheckboxState(parseInt(value));
    };
    
    formColumnsSelect.addEventListener('change', (e) => handleColumnChange(e.target.value));
    
    document.querySelectorAll('input[name="formColumns"]').forEach(radio => {
        radio.addEventListener('change', (e) => handleColumnChange(e.target.value));
    });
    
    const showVertSepCheckbox = document.getElementById('show_vert_sep');
    if (showVertSepCheckbox) {
        showVertSepCheckbox.addEventListener('change', (e) => {
            if (columnDivider1) columnDivider1.style.display = e.target.checked ? 'block' : 'none';
            if (columnDivider2) columnDivider2.style.display = e.target.checked ? 'block' : 'none';
        });
    }
}

// ============================================
// FORM MODIFICATION TRACKING
// ============================================
// Watch form-level fields for changes
['form_name', 'show_name', 'show_vert_sep'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', () => checkUnsavedChanges(buildFormConfig()));
        el.addEventListener('change', () => checkUnsavedChanges(buildFormConfig()));
    }
});

if (formColumnsSelect) {
    formColumnsSelect.addEventListener('change', () => checkUnsavedChanges(buildFormConfig()));
}

// ============================================
// MENU BUTTON
// ============================================
const menuBtn = document.getElementById('menuBtn');
const menuDropdown = document.getElementById('menuDropdown');

if (menuBtn && menuDropdown) {
    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = menuDropdown.style.display === 'block';
        menuDropdown.style.display = isVisible ? 'none' : 'block';
    });
    
    // Close menu when clicking outside
    document.addEventListener('click', () => {
        menuDropdown.style.display = 'none';
    });
}

const generalSettingsBtn = document.getElementById('generalSettingsBtn');
if (generalSettingsBtn) {
    generalSettingsBtn.addEventListener('click', () => {
        menuDropdown.style.display = 'none';
        showFormSettingsModal();
    });
}

function showFormSettingsModal() {
    const config = buildFormConfig();
    const fs = window._formSettings || {};
    const currentSubmitType = fs.submit_type || 'Workflow';
    const currentWorkflowId = fs.submit_workflow_id || '';

    // Build workflow options from already-loaded availableWorkflows
    const workflowOptions = (availableWorkflows || [])
        .map(w => `<option value="${w.id}" ${currentWorkflowId === w.id ? 'selected' : ''}>${w.name}</option>`)
        .join('');

    const content = document.createElement('div');
    content.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
    content.innerHTML = `
        <div>
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Submit Type</label>
            <select id="fs_submit_type" style="width: 100%;">
                <option value="Workflow" ${currentSubmitType === 'Workflow' ? 'selected' : ''}>Workflow</option>
                <option value="SQL" ${currentSubmitType === 'SQL' ? 'selected' : ''}>SQL</option>
            </select>
        </div>
        <div id="fs_workflow_row" style="display: ${currentSubmitType === 'Workflow' ? 'block' : 'none'};">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Workflow</label>
            <select id="fs_workflow_id" style="width: 100%;">
                <option value="">-- Select workflow --</option>
                ${workflowOptions}
            </select>
        </div>
        <div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="fs_show_name" ${(config.show_name ?? true) ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;">
                <label for="fs_show_name" style="color: var(--text-muted); font-size: 11px; cursor: pointer; margin: 0; font-weight: 600;">Show Form Name</label>
            </div>
        </div>
    `;

    // Wire up Submit Type → show/hide workflow row
    content.querySelector('#fs_submit_type').addEventListener('change', (e) => {
        content.querySelector('#fs_workflow_row').style.display =
            e.target.value === 'Workflow' ? 'block' : 'none';
    });

    showModal({
        title: 'Form Settings',
        content,
        closeOnBackdrop: false,
        buttons: [
            { label: 'Cancel', type: 'secondary', onClick: () => {} },
            {
                label: 'Save',
                type: 'success',
                onClick: () => {
                    if (hiddenShowName) hiddenShowName.checked = content.querySelector('#fs_show_name').checked;

                    window._formSettings = window._formSettings || {};
                    window._formSettings.submit_type = content.querySelector('#fs_submit_type').value;
                    window._formSettings.submit_workflow_id = content.querySelector('#fs_workflow_id').value;

                    checkUnsavedChanges(buildFormConfig());
                    closeModal();
                }
            }
        ]
    });
}

// ============================================
// DEPENDENT FIELDS MODAL
// ============================================
function initializeDependentFieldsModal() {
    if (!document.getElementById('dependentFieldsModalBackdrop')) {
        const backdrop = document.createElement('div');
        backdrop.id = 'dependentFieldsModalBackdrop';
        backdrop.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.7); z-index: 9998; display: none;';
        
        const modal = document.createElement('div');
        modal.id = 'dependentFieldsModal';
        modal.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--bg-panel1); border: 1px solid var(--border-primary); border-radius: 6px; padding: 20px; z-index: 9999; min-width: 500px; max-height: 80vh; overflow-y: auto; box-shadow: 0 4px 12px rgba(0,0,0,0.3); display: none;';
        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h3 style="margin: 0; color: var(--text-primary); font-size: 18px;">Dependent Fields</h3>
                <button onclick="closeDependentFieldsModal()" style="background: none; border: none; color: var(--text-primary); font-size: 24px; cursor: pointer; padding: 0; width: 30px; height: 30px;">×</button>
            </div>
            <div id="dependentFieldsModalList" class="panel-level-2" style="max-height: 400px; overflow: hidden; margin-bottom: 20px;">
                <div style="max-height: 400px; overflow-y: auto; height: 100%; margin: -10px -10px -10px 0;" id="dependentFieldsModalScroller">
                    <div style="display: flex; flex-direction: column; gap: 0; padding: 10px 10px 10px 0;" id="dependentFieldsModalContent"></div>
                </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 10px;">
                <button onclick="closeDependentFieldsModal()" class="btn" data-color="grey">Cancel</button>
                <button onclick="saveDependentFields()" class="btn" data-color="green">Save</button>
            </div>
        `;
        
        document.body.appendChild(backdrop);
        document.body.appendChild(modal);
    }
}

function openDependentFieldsModal(fieldConfig) {
    currentDependentFieldConfig = fieldConfig;
    initializeDependentFieldsModal();
    
    const modal = document.getElementById('dependentFieldsModal');
    const backdrop = document.getElementById('dependentFieldsModalBackdrop');
    const fieldsList = document.getElementById('dependentFieldsModalContent');
    
    if (!modal || !backdrop || !fieldsList) return;
    
    fieldsList.innerHTML = '';
    
    // Get current selections
    let currentSelections = fieldConfig.dependant_fields || {};
    
    // Get other fields
    const otherFields = fieldConfigs.filter(config => config.field_name !== fieldConfig.field_name);
    
    if (otherFields.length === 0) {
        fieldsList.innerHTML = '<div style="padding: 20px; color: #999; text-align: center;">No other fields available</div>';
    } else {
        otherFields.forEach(field => {
            const isSelected = field.field_name in currentSelections;
            const isBlocking = currentSelections[field.field_name]?.blocking !== false;
            const blockHidden = currentSelections[field.field_name]?.block_hidden !== false;
            const inclHidden = currentSelections[field.field_name]?.incl_hidden !== false;
            
            const fieldRow = document.createElement('div');
            fieldRow.style.cssText = 'display: flex; align-items: center; gap: 20px; padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px solid var(--border-primary);';
            
            // Main row with checkbox and field info (left side)
            const mainRow = document.createElement('div');
            mainRow.style.cssText = 'display: flex; align-items: center; gap: 12px; flex: 1;';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'dependent-field-checkbox';
            checkbox.setAttribute('data-field-name', field.field_name);
            checkbox.checked = isSelected;
            checkbox.style.cssText = 'width: 18px; height: 18px; cursor: pointer; flex-shrink: 0;';
            
            const fieldInfo = document.createElement('div');
            fieldInfo.style.cssText = 'flex: 1;';
            fieldInfo.innerHTML = `
                <div style="color: var(--text-primary); font-weight: 600; font-size: 14px;">${field.field_displayname}</div>
                <div style="color: #999; font-size: 12px;">${field.field_name}</div>
            `;
            
            mainRow.appendChild(checkbox);
            mainRow.appendChild(fieldInfo);
            
            // Options row (right side)
            const optionsRow = document.createElement('div');
            optionsRow.style.cssText = 'display: none; flex-wrap: wrap; gap: 16px; flex-shrink: 0;';
            optionsRow.className = 'dependent-field-options';
            optionsRow.setAttribute('data-field-name', field.field_name);
            
            if (isSelected) {
                console.log('[DEPENDENT-FIELDS] Field', field.field_name, 'is selected, showing options');
                optionsRow.style.display = 'flex';
            }
            
            // Block option
            const blockLabel = document.createElement('label');
            blockLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer; margin: 0;';
            const blockCheckbox = document.createElement('input');
            blockCheckbox.type = 'checkbox';
            blockCheckbox.className = 'blocking-checkbox';
            blockCheckbox.setAttribute('data-field-name', field.field_name);
            blockCheckbox.checked = isBlocking;
            blockCheckbox.style.cssText = 'width: 16px; height: 16px; cursor: pointer;';
            const blockText = document.createElement('span');
            blockText.textContent = 'Block';
            blockText.style.cssText = 'color: var(--text-primary); font-size: 13px;';
            blockLabel.appendChild(blockCheckbox);
            blockLabel.appendChild(blockText);
            
            // Block if Hidden option
            const blockHiddenLabel = document.createElement('label');
            blockHiddenLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer; margin: 0;';
            const blockHiddenCheckbox = document.createElement('input');
            blockHiddenCheckbox.type = 'checkbox';
            blockHiddenCheckbox.className = 'block-hidden-checkbox';
            blockHiddenCheckbox.setAttribute('data-field-name', field.field_name);
            blockHiddenCheckbox.checked = blockHidden;
            blockHiddenCheckbox.style.cssText = 'width: 16px; height: 16px; cursor: pointer;';
            const blockHiddenText = document.createElement('span');
            blockHiddenText.textContent = 'Block if Hidden';
            blockHiddenText.style.cssText = 'color: var(--text-primary); font-size: 13px;';
            blockHiddenLabel.appendChild(blockHiddenCheckbox);
            blockHiddenLabel.appendChild(blockHiddenText);
            
            // Incl. Hidden option
            const inclHiddenLabel = document.createElement('label');
            inclHiddenLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer; margin: 0;';
            const inclHiddenCheckbox = document.createElement('input');
            inclHiddenCheckbox.type = 'checkbox';
            inclHiddenCheckbox.className = 'incl-hidden-checkbox';
            inclHiddenCheckbox.setAttribute('data-field-name', field.field_name);
            inclHiddenCheckbox.checked = inclHidden;
            inclHiddenCheckbox.style.cssText = 'width: 16px; height: 16px; cursor: pointer;';
            const inclHiddenText = document.createElement('span');
            inclHiddenText.textContent = 'Incl. Hidden';
            inclHiddenText.style.cssText = 'color: var(--text-primary); font-size: 13px;';
            inclHiddenLabel.appendChild(inclHiddenCheckbox);
            inclHiddenLabel.appendChild(inclHiddenText);
            
            optionsRow.appendChild(blockLabel);
            optionsRow.appendChild(blockHiddenLabel);
            optionsRow.appendChild(inclHiddenLabel);
            
            // Toggle options visibility when checkbox changes
            checkbox.addEventListener('change', () => {
                console.log('[DEPENDENT-FIELDS] Toggle for', field.field_name, 'checked:', checkbox.checked);
                optionsRow.style.display = checkbox.checked ? 'flex' : 'none';
            });
            
            fieldRow.appendChild(mainRow);
            fieldRow.appendChild(optionsRow);
            fieldsList.appendChild(fieldRow);
            
            console.log('[DEPENDENT-FIELDS] Created field row for', field.field_name, 'with', [blockLabel, blockHiddenLabel, inclHiddenLabel].length, 'option labels');
        });
    }
    
    modal.style.display = 'block';
    backdrop.style.display = 'block';
}

function closeDependentFieldsModal() {
    const modal = document.getElementById('dependentFieldsModal');
    const backdrop = document.getElementById('dependentFieldsModalBackdrop');
    if (modal) modal.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
}

function saveDependentFields() {
    if (!currentDependentFieldConfig) return;
    
    const checkboxes = document.querySelectorAll('.dependent-field-checkbox');
    const dependentFieldsObj = {};
    
    checkboxes.forEach(checkbox => {
        if (checkbox.checked) {
            const fieldName = checkbox.getAttribute('data-field-name');
            const blockingCheckbox = document.querySelector(`.blocking-checkbox[data-field-name="${fieldName}"]`);
            const blockHiddenCheckbox = document.querySelector(`.block-hidden-checkbox[data-field-name="${fieldName}"]`);
            const inclHiddenCheckbox = document.querySelector(`.incl-hidden-checkbox[data-field-name="${fieldName}"]`);
            
            dependentFieldsObj[fieldName] = {
                blocking: blockingCheckbox?.checked !== false,
                block_hidden: blockHiddenCheckbox?.checked !== false,
                incl_hidden: inclHiddenCheckbox?.checked !== false
            };
        }
    });
    
    currentDependentFieldConfig.dependant_fields = dependentFieldsObj;
    
    // Update button text
    const btn = document.getElementById('editDependentFieldsBtn');
    if (btn) {
        const count = Object.keys(dependentFieldsObj).length;
        btn.textContent = count > 0 ? count + ' field(s) selected' : 'Select dependent fields...';
    }
    
    markFormChanged();
    closeDependentFieldsModal();
}

// ============================================
// JSON VIEWER
// ============================================
const viewJsonBtn = document.getElementById('viewJsonBtn');

if (viewJsonBtn) {
    viewJsonBtn.addEventListener('click', () => {
        menuDropdown.style.display = 'none';
        
        // Build the current form configuration object (same as what gets saved)
        const formConfig = buildFormConfig();
        
        // Format as JSON
        const jsonText = JSON.stringify(formConfig, null, 2);
        
        // Create a container for the JSON with copy button
        const container = document.createElement('div');
        container.style.cssText = 'display: flex; flex-direction: column; gap: 12px; max-height: 70vh;';
        
        const preElement = document.createElement('pre');
        preElement.style.cssText = `
            margin: 0;
            color: #90ee90;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            white-space: pre-wrap;
            word-wrap: break-word;
            background: #0f1419;
            padding: 15px;
            border-radius: 4px;
            border: 1px solid #333;
            overflow-y: auto;
            flex: 1;
        `;
        preElement.textContent = jsonText;
        container.appendChild(preElement);
        
        // Show modal with copy button
        showModal({
            title: 'Form Configuration (JSON)',
            content: container,
            buttons: [
                {
                    label: 'Copy to Clipboard',
                    type: 'primary',
                    onClick: () => {
                        navigator.clipboard.writeText(jsonText).then(() => {
                            console.log('JSON copied to clipboard');
                        }).catch(err => {
                            console.error('Failed to copy:', err);
                        });
                    }
                },
                {
                    label: 'Close',
                    type: 'secondary'
                }
            ]
        });
    });
}

// ============================================
// CLOSE SETTINGS HELPER
// ============================================
function closeElementSettings(discardChanges = false) {
    settingsPanel.style.display = 'none';
    emptySettings.style.display = 'block';
    document.getElementById('saveSettings').style.display = 'none';
    document.getElementById('closeSettings').style.display = 'none';
    selectedElementUid = null;
}

// ============================================
// SETTINGS PANEL HANDLERS
// ============================================
const closeSettingsBtn = document.getElementById('closeSettings');
const saveSettingsBtn = document.getElementById('saveSettings');

if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
        const saveDisplay = document.getElementById('saveSettings').style.display;
        if (saveDisplay === 'flex' || saveDisplay === 'block') {
            showUnsaved(
                () => {
                    document.getElementById('saveSettings').click();
                    closeElementSettings(true);
                },
                () => closeElementSettings(true)
            );
        } else {
            closeElementSettings(true);
        }
    });
}

if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', () => {
        if (!selectedElementUid) return;
        
        const fieldConfig = fieldConfigs.find(f => f.uid === selectedElementUid);
        if (!fieldConfig) return;
        
        // Common fields for all types
        const fieldNameInput = document.getElementById('field_name');
        const fieldDisplayNameInput = document.getElementById('field_displayname');
        const descriptionInput = document.getElementById('description');
        const hiddenCheckbox = document.getElementById('hidden');
        const requiredCheckbox = document.getElementById('required');
        
        if (fieldNameInput) fieldConfig.field_name = fieldNameInput.value;
        if (fieldDisplayNameInput) fieldConfig.field_displayname = fieldDisplayNameInput.value;
        if (descriptionInput) fieldConfig.description = descriptionInput.value;
        if (hiddenCheckbox) fieldConfig.hidden = hiddenCheckbox.checked;
        if (requiredCheckbox) fieldConfig.required = requiredCheckbox.checked;
        
        // Type-specific fields
        if (fieldConfig.type === 'radio') {
            // Collect radio options
            const optionDivs = document.querySelectorAll('#radioOptionsList > div');
            const options = {};
            optionDivs.forEach(div => {
                const labelInput = div.querySelector('[data-option-field="label"]');
                const valueInput = div.querySelector('[data-option-field="value"]');
                if (labelInput && labelInput.value) {
                    options[labelInput.value] = valueInput?.value || labelInput.value;
                }
            });
            fieldConfig.options = options;
            
            const defaultSelectInput = document.getElementById('default_select');
            if (defaultSelectInput) fieldConfig.default_select = defaultSelectInput.value;
            
            const horizCheckbox = document.getElementById('radio_horiz');
            if (horizCheckbox) fieldConfig.horiz = horizCheckbox.checked;
            
        } else if (fieldConfig.type === 'checkbox') {
            const defaultCheckedCheckbox = document.getElementById('default_checked');
            if (defaultCheckedCheckbox) fieldConfig.default_checked = defaultCheckedCheckbox.checked;
            
        } else if (fieldConfig.type === 'text') {
            const defaultValueInput = document.getElementById('default_value');
            if (defaultValueInput) fieldConfig.default_value = defaultValueInput.value;
            
        } else if (fieldConfig.type === 'textarea') {
            const defaultValueInput = document.getElementById('default_value');
            if (defaultValueInput) fieldConfig.default_value = defaultValueInput.value;
            
        } else if (fieldConfig.type === 'html') {
            const contentInput = document.getElementById('content');
            if (contentInput) fieldConfig.content = contentInput.value;
            
        } else if (fieldConfig.type === 'date_time') {
            const includeTimeCheckbox = document.getElementById('include_time');
            if (includeTimeCheckbox) fieldConfig.include_time = includeTimeCheckbox.checked;
            
        } else if (fieldConfig.type === 'array') {
            const repeatingModeCheckbox = document.getElementById('repeating_input_mode');
            if (repeatingModeCheckbox) fieldConfig.repeating_input_mode = repeatingModeCheckbox.checked;
            
            const sourceInput = document.getElementById('repeating_input_source');
            if (sourceInput) fieldConfig.source = sourceInput.value;
            
        } else if (['', 'dropdown_workflow', 'dropdown_static', 'dropdown_sql', 'dropdown_prefetch', 'dropdown_plugin'].includes(fieldConfig.type)) {
            const resultVarInput = document.getElementById('result_var');
            if (resultVarInput) fieldConfig.result_var = resultVarInput.value;
            
            // Handle dropdown_static specifically
            if (fieldConfig.type === 'dropdown_static') {
                const options = {};
                const optionLabels = document.querySelectorAll('.option-label');
                const optionValues = document.querySelectorAll('.option-value');
                
                optionLabels.forEach((labelInput, index) => {
                    const label = labelInput.value;
                    const value = optionValues[index]?.value || label;
                    if (label) {
                        options[label] = value;
                    }
                });
                
                fieldConfig.options = options;
                
                const defaultValueSelect = document.getElementById('default_value');
                if (defaultValueSelect) fieldConfig.default_value = defaultValueSelect.value;
            }
        }
        
        // Save show/hide conditions
        const condition1Input = document.getElementById('condition_1');
        const condition1ActionSelect = document.getElementById('condition_1_action');
        const condition2Input = document.getElementById('condition_2');
        const condition2ActionSelect = document.getElementById('condition_2_action');
        
        if (condition1Input) fieldConfig.condition_1 = condition1Input.value || null;
        if (condition1ActionSelect) fieldConfig.condition_1_action = condition1ActionSelect.value || null;
        if (condition2Input) fieldConfig.condition_2 = condition2Input.value || null;
        if (condition2ActionSelect) fieldConfig.condition_2_action = condition2ActionSelect.value || null;
        
        // Mark form as modified
        markFormChanged();
        
        // Close settings panel
        closeElementSettings(true);
    });
}

// ============================================
// URL PARAMETER INITIALIZATION
// ============================================
function getFormIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const formId = params.get('form_id');
    return formId;
}

// ============================================
// SAVE FORM
// ============================================
function buildFormConfig() {
    const formName = formNameInput?.value.trim() || '';
    const columnCount = parseInt(hiddenFormColumns?.value || '1');
    const showVertSep = document.getElementById('show_vert_sep')?.checked || false;
    const showTitle = hiddenShowName?.checked || false;
    const formVersion = hiddenFormVersion?.value;

    const fs = window._formSettings || {};

    return {
        form_name: formName,
        column_count: columnCount,
        show_vert_sep: showVertSep,
        show_name: showTitle,
        version: formVersion,
        submit_type: fs.submit_type || 'Workflow',
        submit_workflow_id: fs.submit_workflow_id || '',
        field_configs: fieldConfigs.map(fc => ({ ...fc }))
    };
}

async function saveFormToDatabase() {
    const saveBtn = document.getElementById('saveFormBtn');

    // Bail out if nothing actually changed
    const config = buildFormConfig();
    if (!checkUnsavedChanges(config)) {
        showStatusBanner('No changes to save.', 'info');
        return;
    }

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        // Build the definition object (translate form_name → name, exclude internal keys)
        const definition = {
            name:               config.form_name,
            active:             true,
            show_name:          config.show_name,
            column_count:       config.column_count,
            show_vert_sep:      config.show_vert_sep,
            submit_type:        config.submit_type,
            submit_workflow_id: config.submit_workflow_id,
            field_configs:      config.field_configs
        };
        const payload = {
            name: definition.name,
            version: null,
            definition,
            folder_id: null
        };
        const urlFormId = getFormIdFromUrl();
        const response = await fetch(`https://app.equinoxits.com:1139/kore/forms/${urlFormId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        // Reset baseline to newly saved state
        initializeUnsavedTracking(buildFormConfig());
        clearUnsavedChanges();
        updateSaveButtonState();

        showStatusBanner(`Form "${config.form_name}" saved successfully.`, 'success');

    } catch (err) {
        console.error('[SAVE FORM] Error:', err);
        showStatusBanner(`Save failed: ${err.message}`, 'error');
    } finally {
        saveBtn.textContent = 'Save';
        saveBtn.disabled = false;
        updateSaveButtonState();
    }
}

// Save form button click handler
const saveFormBtn = document.getElementById('saveFormBtn');
if (saveFormBtn) {
    saveFormBtn.addEventListener('click', saveFormToDatabase);
}

// Get form ID from URL parameter and load if present
(async () => {
    const urlFormId = getFormIdFromUrl();
    console.log('[INIT] Form ID from URL:', urlFormId);
    
    if (urlFormId) {
        console.log('[INIT] Loading form configuration for ID:', urlFormId);
        const formConfig = await getFormConfigFromDatabase(urlFormId);
        
        if (formConfig) {
            console.log('[INIT] Form config retrieved, loading form...');
            await performFormLoad(formConfig);
            loadedFormId = urlFormId;
        } else {
            console.error('[INIT] Failed to load form configuration');
        }
    } else {
        console.log('[INIT] No form_id URL parameter provided');
        // New form — initialize tracking with empty baseline
        initializeUnsavedTracking(buildFormConfig());
        updateSaveButtonState();
    }
    
    // Initialize the element palette and drag-and-drop
    initializeElementPalette();
    initializeDragAndDrop();
    
    // Pre-fetch SQL datasources for dropdown_sql settings panel
    loadSqlDatasources();
    
    // Pre-fetch plugins for dropdown_plugin settings panel
    listPlugins().then(plugins => {
        availablePlugins = plugins;
        console.log('[Plugins] Loaded:', availablePlugins.map(p => p.name));
    }).catch(err => {
        console.error('[Plugins] Failed to load:', err);
        availablePlugins = [];
    });

    // Pre-fetch workflows for dropdown_workflow settings panel
    loadAvailableWorkflows();

    // Set up beforeunload protection
    setupPageUnsavedChangesProtection(saveFormToDatabase, resetUnsavedChangesTracking);
    
    // Set up in-page navigation protection (clicking links/navigation elements)
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]');
        
        // Check for unsaved changes at both form and element level
        const saveSettingsBtn = document.getElementById('saveSettings');
        const hasElementChanges = saveSettingsBtn && saveSettingsBtn.style.display === 'flex';
        const hasFormChanges = hasUnsavedChanges();
        
        if (link && (hasElementChanges || hasFormChanges)) {
            e.preventDefault();
            e.stopPropagation();
            
            const href = link.href;
            
            // Show unsaved changes modal for in-page navigation
            window.showUnsaved(
                async () => {
                    // If element settings are unsaved, save them first
                    if (hasElementChanges) {
                        const saveBtn = document.getElementById('saveSettings');
                        if (saveBtn && !saveBtn.disabled) {
                            saveBtn.click();
                        }
                    }
                    // Save form changes
                    if (hasFormChanges) {
                        await saveFormToDatabase();
                    }
                    // Navigate after saving
                    window.location.href = href;
                },
                () => {
                    // Discard changes and navigate
                    if (hasElementChanges) {
                        closeElementSettings();
                    }
                    if (hasFormChanges) {
                        resetUnsavedChangesTracking();
                    }
                    window.location.href = href;
                }
            );
        }
    }, true); // Use capture phase to catch clicks before they propagate
})();

// Info Icon Click Handler
(() => {
    let activeTooltip = null;
    
    // Handle info icon clicks
    document.addEventListener('click', (e) => {
        const infoIcon = e.target.closest('.info-icon');
        
        if (infoIcon) {
            e.preventDefault();
            e.stopPropagation();
            
            // Close existing tooltip if clicking a different icon
            if (activeTooltip && activeTooltip !== infoIcon) {
                activeTooltip.tooltip?.remove();
                activeTooltip.tooltip = null;
                activeTooltip = null;
            }
            
            // Toggle tooltip
            if (infoIcon.tooltip) {
                infoIcon.tooltip.remove();
                infoIcon.tooltip = null;
                activeTooltip = null;
            } else {
                // Create and show tooltip
                const tooltip = document.createElement('div');
                tooltip.className = 'info-tooltip';
                tooltip.textContent = infoIcon.dataset.explanation;
                document.body.appendChild(tooltip);
                
                // Position tooltip above the icon
                const rect = infoIcon.getBoundingClientRect();
                const tooltipRect = tooltip.getBoundingClientRect();
                tooltip.style.left = (rect.left + rect.width / 2 - tooltipRect.width / 2) + 'px';
                tooltip.style.top = (rect.top - tooltipRect.height - 10) + 'px';
                
                infoIcon.tooltip = tooltip;
                activeTooltip = infoIcon;
            }
        } else {
            // Close tooltip when clicking anywhere else
            if (activeTooltip) {
                activeTooltip.tooltip?.remove();
                activeTooltip.tooltip = null;
                activeTooltip = null;
            }
        }
    });
})();

// ========================================
// ARRAY ELEMENT FUNCTIONS
// ========================================
function buildEditArrayButton(fieldConfig) {
    const container = document.getElementById('array_edit_button_container');
    if (container) container.remove();
    
    const div = document.createElement('div');
    div.id = 'array_edit_button_container';
    div.style.marginBottom = '15px';
    
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-blue';
    btn.style.width = '100%';
    btn.textContent = 'Edit Array Items';
    btn.addEventListener('click', () => openEditArrayModal(fieldConfig));
    
    div.appendChild(btn);
    
    // Insert after the repeating_input_mode checkbox
    const lastSection = document.querySelector('[id*="form-group"]:last-of-type');
    if (lastSection) {
        lastSection.after(div);
    } else {
        document.body.appendChild(div);
    }
}

function openEditArrayModal(fieldConfig) {
    // TODO: Flesh out array item editor modal
    console.log('[ARRAY EDITOR] Opening modal for field:', fieldConfig.field_name);
    
    const modal = document.createElement('div');
    modal.id = 'editArrayModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;
    
    const content = document.createElement('div');
    content.style.cssText = `
        background: #0f1e2e;
        border: 1px solid #2a5a7a;
        border-radius: 8px;
        padding: 30px;
        width: 600px;
        max-height: 80vh;
        overflow-y: auto;
        color: #ffffff;
    `;
    
    content.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <h2 style="margin: 0; font-size: 20px;">Edit Array Items</h2>
            <button id="closeEditArrayModal" style="background: none; border: none; color: #ffffff; cursor: pointer; font-size: 24px;">×</button>
        </div>
        <div style="min-height: 300px; border: 1px dashed #555; border-radius: 4px; padding: 20px; text-align: center; color: #999;">
            Array editor interface coming soon...
        </div>
    `;
    
    modal.appendChild(content);
    document.body.appendChild(modal);
    
    document.getElementById('closeEditArrayModal').addEventListener('click', () => {
        modal.remove();
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}

// ========================================
// FORM EXTEND ELEMENT FUNCTIONS
// ========================================
function buildFormExtendSelector(fieldConfig) {
    const container = document.getElementById('form_extend_selector_container');
    if (container) container.remove();
    
    const div = document.createElement('div');
    div.id = 'form_extend_selector_container';
    
    // Get form_extend operations from library metadata
    const allOps = RewstLib.graphqlOperations.getAll();
    let extendVarOptions = '<option value="">Select an extend variable...</option>';
    for (const [opKey, opConfig] of Object.entries(allOps)) {
        if (opConfig.type === 'form_extend') {
            extendVarOptions += `<option value="${opKey}" ${fieldConfig.extend_var === opKey ? 'selected' : ''}>${opConfig.name}</option>`;
        }
    }
    
    const formGroup = document.createElement('div');
    formGroup.className = 'form-group';
    formGroup.innerHTML = `
        <label>Extend Variable${infoIcon('Select a form extend operation to add to this form.')}</label>
        <select id="extend_var" class="settings-field">
            ${extendVarOptions}
        </select>
        <div id="extend_var_inputs_container" style="margin-top: 15px;"></div>
    `;
    
    div.appendChild(formGroup);
    
    // Insert after the common fields section
    const settingsForm = document.getElementById('element_settings_form');
    if (settingsForm) {
        settingsForm.appendChild(div);
    }
    
    // Setup change handler
    const selectInput = div.querySelector('#extend_var');
    if (selectInput) {
        selectInput.addEventListener('change', () => {
            fieldConfig.extend_var = selectInput.value;
            showElementSettingsDirty();
        });
    }
}

// ========================================
// HTML ELEMENT FUNCTIONS
// ========================================
function buildHtmlContentField(fieldConfig) {
    const container = document.getElementById('html_content_container');
    if (container) container.remove();
    
    const div = document.createElement('div');
    div.id = 'html_content_container';
    
    const formGroup = document.createElement('div');
    formGroup.className = 'form-group';
    formGroup.innerHTML = `
        <label>Content${infoIcon('HTML content to display. Use [[field_name]] to reference values from other form elements.')}</label>
        <div style="margin-bottom: 8px; padding: 10px; background: rgba(102, 126, 234, 0.1); border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 4px; font-size: 12px; color: #ffffff;">
            <div style="font-weight: 600; margin-bottom: 4px;">💡 Reference other fields:</div>
            <div style="color: #ccc;">Use <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace;">[[field_name]]</code> to reference values from other form elements.</div>
            <div style="margin-top: 6px; color: #ccc;">Example: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace;">&lt;p&gt;Selected date: [[date_1]]&lt;/p&gt;</code></div>
        </div>
        <textarea id="html_content" style="width: 100%; height: 120px; padding: 10px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; box-sizing: border-box; font-family: 'Courier New', monospace;">${fieldConfig.content || ''}</textarea>
    `;
    
    div.appendChild(formGroup);
    
    // Insert into settings form
    const settingsForm = document.getElementById('element_settings_form');
    if (settingsForm) {
        settingsForm.appendChild(div);
    }
    
    // Setup change handler
    const textarea = div.querySelector('#html_content');
    if (textarea) {
        textarea.addEventListener('input', () => {
            fieldConfig.content = textarea.value;
            showElementSettingsDirty();
        });
    }
}

// ========================================
// RADIO ELEMENT FUNCTIONS
// ========================================
function buildRadioOptions(fieldConfig) {
    const container = document.getElementById('radio_options_container');
    if (container) container.remove();
    
    const div = document.createElement('div');
    div.id = 'radio_options_container';
    
    // Initialize options if not present
    if (!fieldConfig.options) {
        fieldConfig.options = { option1: 'value1', option2: 'value2' };
    }
    
    let optionsHTML = `
        <div style="margin-bottom: 15px;">
            <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 8px;">
                <div style="flex: 1;">
                    <label style="color: #ffffff; font-weight: 600; font-size: 14px; margin: 0 0 8px 0; display: block;">Options</label>
                    <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                        <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Label</div>
                        <div style="flex: 1; color: #999; font-size: 12px; font-weight: 600;">Value</div>
                    </div>
                </div>
                <button id="addRadioOptionBtn" style="padding: 8px 12px; background: #2a7da8; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-weight: 600;">+</button>
            </div>
            <div id="radioOptionsList" style="display: flex; flex-direction: column; gap: 8px;">
    `;
    
    // Add existing options
    Object.entries(fieldConfig.options).forEach(([key, value], index) => {
        optionsHTML += `
            <div class="radio-option-row" data-key="${key}" style="display: flex; gap: 8px; align-items: center;">
                <input type="text" class="radio-option-label" value="${key}" placeholder="Label" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px;">
                <input type="text" class="radio-option-value" value="${value}" placeholder="Value" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px;">
                <button class="delete-radio-option-btn" style="padding: 6px 10px; background: #a82a2a; border: none; border-radius: 4px; color: #ffffff; cursor: pointer;">⊘</button>
            </div>
        `;
    });
    
    optionsHTML += `
            </div>
        </div>
        <div style="margin-bottom: 15px;">
            <label style="color: #ffffff; font-weight: 600; font-size: 14px; margin: 0 0 8px 0; display: block;">Default Select</label>
            <select id="default_select" style="width: 100%; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff;">
                <option value="">-- None --</option>
    `;
    
    Object.keys(fieldConfig.options).forEach(key => {
        const isSelected = fieldConfig.default_select === key ? 'selected' : '';
        optionsHTML += `<option value="${key}" ${isSelected}>${key}</option>`;
    });
    
    optionsHTML += `
            </select>
        </div>
    `;
    
    div.innerHTML = optionsHTML;
    
    // Insert into settings form
    const settingsForm = document.getElementById('element_settings_form');
    if (settingsForm) {
        settingsForm.appendChild(div);
    }
    
    // Setup event listeners
    const addBtn = div.querySelector('#addRadioOptionBtn');
    const optionsList = div.querySelector('#radioOptionsList');
    const defaultSelect = div.querySelector('#default_select');
    
    if (addBtn) {
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const newIndex = optionsList.children.length;
            const newKey = `option${newIndex + 1}`;
            
            fieldConfig.options[newKey] = '';
            
            const newRow = document.createElement('div');
            newRow.className = 'radio-option-row';
            newRow.setAttribute('data-key', newKey);
            newRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';
            newRow.innerHTML = `
                <input type="text" class="radio-option-label" value="${newKey}" placeholder="Label" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px;">
                <input type="text" class="radio-option-value" value="" placeholder="Value" style="flex: 1; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px;">
                <button class="delete-radio-option-btn" style="padding: 6px 10px; background: #a82a2a; border: none; border-radius: 4px; color: #ffffff; cursor: pointer;">⊘</button>
            `;
            
            optionsList.appendChild(newRow);
            attachRadioOptionListeners(newRow, fieldConfig, defaultSelect);
            showElementSettingsDirty();
        });
    }
    
    // Attach listeners to existing rows
    div.querySelectorAll('.radio-option-row').forEach(row => {
        attachRadioOptionListeners(row, fieldConfig, defaultSelect);
    });
    
    // Setup default select handler
    if (defaultSelect) {
        defaultSelect.addEventListener('change', () => {
            fieldConfig.default_select = defaultSelect.value;
            showElementSettingsDirty();
        });
    }
}

function attachRadioOptionListeners(row, fieldConfig, defaultSelect) {
    const labelInput = row.querySelector('.radio-option-label');
    const valueInput = row.querySelector('.radio-option-value');
    const deleteBtn = row.querySelector('.delete-radio-option-btn');
    const currentKey = row.getAttribute('data-key');
    
    if (labelInput) {
        labelInput.addEventListener('input', () => {
            const newKey = labelInput.value;
            if (newKey !== currentKey && newKey) {
                fieldConfig.options[newKey] = fieldConfig.options[currentKey];
                delete fieldConfig.options[currentKey];
                row.setAttribute('data-key', newKey);
                updateRadioDefaultSelect(fieldConfig, defaultSelect);
            }
            showElementSettingsDirty();
        });
    }
    
    if (valueInput) {
        valueInput.addEventListener('input', () => {
            fieldConfig.options[currentKey] = valueInput.value;
            showElementSettingsDirty();
        });
    }
    
    if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            delete fieldConfig.options[currentKey];
            row.remove();
            updateRadioDefaultSelect(fieldConfig, defaultSelect);
            showElementSettingsDirty();
        });
    }
}

function updateRadioDefaultSelect(fieldConfig, defaultSelect) {
    if (!defaultSelect) return;
    
    const currentValue = defaultSelect.value;
    defaultSelect.innerHTML = '<option value="">-- None --</option>';
    
    Object.keys(fieldConfig.options).forEach(key => {
        const isSelected = currentValue === key ? 'selected' : '';
        defaultSelect.appendChild(new Option(key, key, false, isSelected === 'selected'));
    });
}

// Initialize on page load
console.log('Form Builder initialized');