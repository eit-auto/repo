import '/lib/base.js';
import '/lib/forms.js';

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
      options: ['dropdown_static', 'dropdown_workflow', 'dropdown_sql', 'dropdown_plugin', 'dropdown_kore_util', 'dropdown_prefetch'],
      info: 'Determines the source of options: Static (manual), Workflow (from workflow output), SQL Query (from database), Plugin (from plugin output), Kore Util (from a Kore data utility action), or Pre-fetched Data (from data retrieval).'
    },
    {
      type: 'conditionalGroup',
      field: 'dropdown_type',
      conditions: {
        'dropdown_static': [{ type: 'reference', ref: 'dropdown_static' }],
        'dropdown_workflow': [{ type: 'reference', ref: 'dropdown_workflow' }],
        'dropdown_sql': [{ type: 'reference', ref: 'dropdown_sql' }],
        'dropdown_plugin': [{ type: 'reference', ref: 'dropdown_plugin' }],
        'dropdown_kore_util': [{ type: 'reference', ref: 'dropdown_kore_util' }],
        'dropdown_prefetch': [{ type: 'reference', ref: 'dropdown_prefetch' }],
      }
    },
    ],
  },

  // DYNAMIC DATA DROPDOWN FIELDS (reusable for workflow, sql, plugin, prefetch)
  dynamicDataDropdownFields: [
    {
      type: 'fieldGroup',
      fields: [
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
      ]
    },
    { 
      name: 'data_variable', 
      label: 'Data Variable', 
      type: 'text',
      info: 'Stores the full record for the selected option(s) under this variable name, so other fields/properties beyond the Value Field are still reachable (e.g. client_id_data.psa_client_id). Defaults to "{field_name}_data" if left blank.' 
    },
    { 
      name: 'default_selector', 
      label: 'Default Selector', 
      type: 'text',
      info: 'The property name in your data that indicates which record(s) should be selected by default. Should be a boolean field (true/false). In multi-select mode, multiple records can have this field set to true.' 
    },
    {
      type: 'fieldGroup',
      fields: [
        { 
          name: 'order_by_field', 
          label: 'Order By', 
          type: 'text',
          info: 'The property name in your data to sort options by before they\'re displayed (e.g. "name"). Leave blank to keep the data\'s original order.' 
        },
        { 
          name: 'order_by_direction', 
          label: 'Order Direction', 
          type: 'select',
          options: ['asc', 'desc'],
          info: 'Sort direction to use when Order By is set. Numeric-looking values sort numerically; everything else sorts alphabetically (case-insensitive).' 
        },
      ]
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
        renderer: 'buildWorkflowTriggerSelector',
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
      // buildPluginTaskSection is NOT listed here on purpose - unlike
      // buildWorkflowInputs (a harmless placeholder-only function safe to
      // call with any/wrong arguments), buildPluginTaskSection actually
      // fetches and renders real content, and has no guard against a
      // second copy already existing. buildPluginSelector's own setTimeout
      // already calls it directly with the correct arguments (plugin name,
      // selected task id, fieldConfig) whenever appropriate; listing it
      // here too meant the generic 'area' handler ALSO called it, but with
      // the wrong arguments (fieldConfig where a plugin name string was
      // expected) - both async calls raced, appending a second
      // description+inputs block into the same container.
      { type: 'reference', ref: 'dynamicDataDropdownFields' },
    ],
  },

  // DROPDOWN TYPE: KORE UTIL
  dropdown_kore_util: {
    sections: [
      { 
        type: 'area', 
        renderer: 'buildKoreUtilSelector',
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
        options: ['Workflow', 'SQL', 'Plugin', 'Kore Util'],
        info: 'Choose how data is retrieved: Workflow (workflow output), SQL Query (database query), Plugin (plugin output), or Kore Util (a Kore data utility action).'
      },
      { 
        type: 'conditionalGroup',
        field: 'data_source_type',
        conditions: {
          'Workflow': [{ type: 'reference', ref: 'dropdown_workflow', excludeFields: ['dynamicDataDropdownFields'] }],
          'SQL': [{ type: 'reference', ref: 'dropdown_sql', excludeFields: ['dynamicDataDropdownFields'] }],
          'Plugin': [{ type: 'reference', ref: 'dropdown_plugin', excludeFields: ['dynamicDataDropdownFields'] }],
          'Kore Util': [{ type: 'reference', ref: 'dropdown_kore_util', excludeFields: ['dynamicDataDropdownFields'] }],
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
        name: 'array_type', 
        label: 'Array Data Type', 
        type: 'radio',
        options: [
          { value: 'comma_separated', label: 'Comma-Separated' },
          { value: 'key_value_pairs', label: 'Key:Value Pairs' },
          { value: 'newline_separated', label: 'Newline-Separated' },
          { value: 'json_array', label: 'JSON Array' },
        ],
        info: 'How this array\'s submitted data should be interpreted. Handled by the form viewer, not the builder.'
      },
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
        renderer: 'buildHtmlFields'
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
    
    // Baseline dirty-tracking: catch any .settings-field element (e.g. Field Name,
    // Display Name, Description, Hidden, Required, HTML Content) that doesn't already
    // have its own explicit change listener wired up by a type-specific renderer.
    attachGenericSettingsFieldDirtyListeners();

    // Wire up behavior (button clicks, datasource/plugin dropdown population,
    // etc.) for whichever type-specific section just got rendered above -
    // each attach*Listeners() no-ops if its elements aren't present.
    attachTypeSpecificListeners();
    
    console.log('[SETTINGS] Panel built for element type:', fieldConfig.type);
}

function attachGenericSettingsFieldDirtyListeners() {
    if (!settingsForm) return;
    settingsForm.querySelectorAll('.settings-field').forEach(field => {
        field.addEventListener('change', showElementSettingsDirty);
        field.addEventListener('input', showElementSettingsDirty);
    });
}

/**
 * Wire up behavior for whichever dropdown-subtype or data_retrieval
 * section is currently rendered in the settings panel - button clicks
 * (e.g. "Edit SQL Query"), datasource/plugin/workflow dropdown population,
 * and their own change-tracking. Each attach*Listeners() call looks up its
 * own elements by id and no-ops if they're not present, so it's always
 * safe to call this unconditionally after (re-)rendering any type's
 * settings, regardless of which type is actually showing.
 */
function attachTypeSpecificListeners() {
    attachDropdownStaticListeners();
    attachDropdownSqlListeners();
    // attachDropdownPluginListeners() and attachDropdownWorkflowListeners()
    // deliberately not called here: buildPluginSelector/buildWorkflowSelector
    // already self-attach their own 'change' listeners via their own
    // setTimeout (matching buildSQLSelector's lack of self-attachment,
    // which IS why attachDropdownSqlListeners above is needed). Calling
    // these too meant plugin/workflow selection was handled twice per
    // change - once correctly (fieldConfig.plugin_name/workflow_id, real
    // arguments) and once via these functions (fieldConfig.plugin - a
    // different, mismatched property name for dropdown_plugin - with no
    // guard against the task/input section already existing) - both
    // async, racing, appending duplicate description+inputs content.
    attachDropdownPrefetchListeners();
    attachDropdownTreeListeners();
    attachDataRetrievalListeners();
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
                let refSections = refDef.sections ? refDef.sections : refDef;
                // Drop any nested references this caller doesn't want (e.g.
                // data_retrieval has no use for dynamicDataDropdownFields -
                // it just stores a raw chunk of data, not a dropdown's
                // label/value/selector/tree config).
                if (Array.isArray(section.excludeFields) && section.excludeFields.length > 0) {
                    refSections = refSections.filter(s => !(s.type === 'reference' && section.excludeFields.includes(s.ref)));
                }
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

                if (fieldDef.type !== 'checkbox') {
                    // Text/select fields side by side: each gets its own
                    // stacked label-above-input, sharing the row evenly.
                    const itemWrapper = document.createElement('div');
                    itemWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;';

                    const label = document.createElement('label');
                    label.htmlFor = fieldDef.name;
                    label.innerHTML = fieldDef.label || fieldDef.name;
                    if (fieldDef.info) {
                        label.innerHTML += infoIcon(fieldDef.info);
                    }
                    itemWrapper.appendChild(label);

                    let input;
                    if (fieldDef.type === 'select') {
                        input = document.createElement('select');
                        (fieldDef.options || []).forEach(optValue => {
                            const option = document.createElement('option');
                            option.value = optValue;
                            option.textContent = optValue;
                            option.selected = fieldValue === optValue;
                            input.appendChild(option);
                        });
                    } else {
                        input = document.createElement('input');
                        input.type = 'text';
                        input.value = fieldValue || '';
                        input.placeholder = fieldDef.placeholder || '';
                    }
                    input.id = fieldDef.name;
                    input.className = 'settings-field';
                    itemWrapper.appendChild(input);

                    groupContainer.appendChild(itemWrapper);

                    input.addEventListener('input', () => {
                        fieldConfig[fieldDef.name] = input.value;
                        showElementSettingsDirty();
                    });
                    return;
                }
                
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
    
    // Handle radio group separately too, same reason as checkbox above -
    // multiple <input> elements share one field name, so there's no single
    // "the input" for the generic tail-end listener to attach to.
    if (fieldDef.type === 'radio') {
        const formGroup = document.createElement('div');
        formGroup.className = 'form-group';

        const label = document.createElement('label');
        label.style.cssText = 'display: inline-flex; align-items: center; gap: 6px;';
        label.innerHTML = (fieldDef.label || fieldDef.name);
        if (fieldDef.info) {
            label.innerHTML += infoIcon(fieldDef.info);
        }
        formGroup.appendChild(label);

        const optionsContainer = document.createElement('div');
        optionsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-top: 6px;';

        const options = fieldDef.options || [];

        // No stored value yet (new field) -> the first option renders
        // visually checked below, so seed fieldConfig to match. Setting
        // .checked alone isn't enough - it doesn't fire 'change', so
        // fieldConfig would silently stay unset until the user actually
        // clicks a radio, same gap the label_field/value_field prefill had.
        if (!fieldValue && options.length > 0) {
            const firstValue = (typeof options[0] === 'object' && options[0] !== null) ? options[0].value : options[0];
            fieldConfig[fieldDef.name] = firstValue;
        }

        options.forEach((opt, index) => {
            const optValue = (typeof opt === 'object' && opt !== null) ? opt.value : opt;
            const optLabel = (typeof opt === 'object' && opt !== null) ? (opt.label || opt.value) : opt;

            const row = document.createElement('label');
            row.style.cssText = 'display: flex; align-items: center; gap: 6px; font-weight: 400; cursor: pointer;';

            const radioInput = document.createElement('input');
            radioInput.type = 'radio';
            radioInput.name = fieldDef.name;
            radioInput.value = optValue;
            radioInput.checked = fieldValue ? (fieldValue === optValue) : (index === 0);

            radioInput.addEventListener('change', () => {
                if (radioInput.checked) {
                    fieldConfig[fieldDef.name] = optValue;
                    showElementSettingsDirty();
                }
            });

            const span = document.createElement('span');
            span.textContent = optLabel;

            row.appendChild(radioInput);
            row.appendChild(span);
            optionsContainer.appendChild(row);
        });

        formGroup.appendChild(optionsContainer);
        form.appendChild(formGroup);
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
        
        // Special handling for any field that drives a conditionalGroup in
        // this element's definition (e.g. dropdown_type for 'dropdown',
        // data_source_type for 'data_retrieval') - the reference sections
        // for the currently-selected value only get rendered once, at
        // initial panel build, so changing the value needs to swap them
        // out live rather than waiting for the panel to be reopened.
        const elementDef = ELEMENT_DEFINITIONS[fieldConfig.type];
        const drivingSection = elementDef?.sections?.find(
            section => section.type === 'conditionalGroup' && section.field === fieldDef.name
        );

        if (drivingSection) {
            input.addEventListener('change', () => {
                fieldConfig[fieldDef.name] = input.value;
                showElementSettingsDirty();

                const form = document.getElementById('settingsForm');

                // Remove old conditional content
                const oldConditionalContent = form.querySelector(`[data-conditional-group="${fieldDef.name}"]`);
                if (oldConditionalContent) {
                    oldConditionalContent.remove();
                }

                // Re-render the conditional group for the newly-selected value
                const conditionSections = drivingSection.conditions[fieldConfig[fieldDef.name]];
                if (conditionSections) {
                    const conditionalWrapper = document.createElement('div');
                    conditionalWrapper.setAttribute('data-conditional-group', fieldDef.name);
                    
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
                        firstButton.parentElement.insertBefore(conditionalWrapper, firstButton);
                    } else {
                        form.appendChild(conditionalWrapper);
                    }

                    // The newly-inserted section (e.g. SQL Database select +
                    // Edit SQL Query button, or Workflow select) has no
                    // behavior wired up yet - this render path only builds
                    // HTML, it doesn't attach listeners.
                    attachTypeSpecificListeners();
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
        input.placeholder = fieldDef.name === 'data_variable'
            ? `Defaults to ${fieldConfig.field_name || 'field_name'}_data`
            : (fieldDef.placeholder || '');
        
        formGroup.appendChild(input);
    }
    
    // Attach change listener - skip fields that drive a conditionalGroup
    // (handled above by their own dedicated change listener, which also
    // sets fieldConfig[fieldDef.name] - a second listener here would be
    // redundant, not just for 'dropdown_type' but any such field).
    const elementDefForListener = ELEMENT_DEFINITIONS[fieldConfig.type];
    const fieldDrivesConditionalGroup = elementDefForListener?.sections?.some(
        section => section.type === 'conditionalGroup' && section.field === fieldDef.name
    );
    if (input && !fieldDrivesConditionalGroup) {
        input.addEventListener('input', () => {
            fieldConfig[fieldDef.name] = input.value;
            showElementSettingsDirty();
        });
    }
    
    form.appendChild(formGroup);
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
async function loadSqlDatasources() {
    try {
        const result = await executeSqlQuery(
            'cookie', null, 'kore_sys',
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
        const result = await executeSqlQuery(
            'cookie', null, 'kore_sys',
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
let pluginTasksCache = {}; // Cached plugin tasks, keyed by plugin name

// Kore Util actions (kore_sys.workflow_utils, category='kore-data'), surfaced
// via their own dedicated "dropdown_kore_util" dropdown type / data_retrieval
// source type - not folded into the Plugin selector.
let availableKoreUtils = []; // Cached workflow_utils rows filtered to category='kore-data'

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

    // data_retrieval's Data Source Type select has no blank placeholder
    // option - it defaults to its first option (Workflow) visually, so
    // give fieldConfig the same default rather than leaving it undefined
    // until the user explicitly touches the select.
    if (configType === 'data_retrieval') {
        defaults.data_source_type = 'Workflow';
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
        
        // Mark form as changed - covers both reordering within a column
        // and moving to a different column (handleElementMove already ran
        // during the preceding 'drop' event by this point)
        markFormChanged();
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
            openConditionsModal(fieldConfig);
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
                <option value="date" ${item.type === 'date' ? 'selected' : ''}>Date</option>
                <option value="datetime" ${item.type === 'datetime' ? 'selected' : ''}>Date/Time</option>
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

// ============================================
// SHOW/HIDE CONDITIONS MODAL
// ============================================
let currentConditionsFieldConfig = null;

function openConditionsModal(fieldConfig) {
    currentConditionsFieldConfig = fieldConfig;

    const content = document.createElement('div');
    content.innerHTML = `
        <div style="margin-bottom: 15px; padding: 12px; background: rgba(102, 126, 234, 0.1); border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 4px; font-size: 12px; color: #ffffff;">
            <div style="font-weight: 600; margin-bottom: 6px;">💡 Jinja-style condition examples:</div>
            <div><code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px;">{{ status == 'Approved' }}</code></div>
            <div style="margin-top: 4px;"><code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px;">{{ age >= 18 and country == 'US' }}</code></div>
            <div style="margin-top: 4px;"><code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px;">{{ 'admin' in user_roles }}</code></div>
            <div style="margin-top: 6px; color: #ccc;">Reference other fields on this form by their Field Name (e.g. <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px;">status</code> above matches a field named "status").</div>
        </div>

        <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
            <button id="addConditionBtn" class="btn" data-color="blue" data-size="sm" title="Add Condition" style="min-width: auto;">+ Add Condition</button>
        </div>

        <div id="conditionsModalList" class="scrollbar" style="display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; margin-bottom: 0px;"></div>
    `;

    const conditionsModalList = content.querySelector('#conditionsModalList');
    const addConditionBtn = content.querySelector('#addConditionBtn');

    const conditions = Array.isArray(fieldConfig.conditions)
        ? fieldConfig.conditions.map(c => ({ condition: c.condition || '', action: c.action || 'show' }))
        : [];

    if (conditions.length === 0) {
        renderNoConditionsMessage(conditionsModalList);
    } else {
        conditions.forEach(condition => {
            renderConditionRow(conditionsModalList, condition);
        });
    }

    addConditionBtn.addEventListener('click', (e) => {
        e.preventDefault();
        removeNoConditionsMessage(conditionsModalList);
        renderConditionRow(conditionsModalList, { condition: '', action: 'show' });
        updateConditionButtonStates();
    });

    showModal({
        title: 'Show/Hide Conditions',
        content,
        width: '70vw',
        height: 'auto',
        suppressBodyScroll: false,
        closeOnBackdrop: false,
        buttons: [
            {
                label: 'Cancel',
                type: 'secondary'
            },
            {
                label: 'Save',
                type: 'success',
                onClick: () => {
                    saveConditions();
                }
            }
        ],
        onClose: () => {
            currentConditionsFieldConfig = null;
            console.log('[CONDITIONS-MODAL] Closed Conditions Modal');
        }
    });

    updateConditionButtonStates();

    console.log('[CONDITIONS-MODAL] Opened Conditions Modal');
}

function renderConditionRow(container, conditionData) {
    const row = document.createElement('div');
    row.className = 'condition-row';
    row.style.cssText = 'display: flex; gap: 8px; align-items: center; min-width: 0;';
    row._conditionData = conditionData;

    const hasCondition = !!(conditionData.condition && conditionData.condition.trim());

    row.innerHTML = `
        <div style="display: flex; gap: 4px; flex-shrink: 0;">
            <button type="button" class="condition-move-up-btn" title="Move Up" style="min-width: auto; padding: 6px 8px; background: #5a9fb8; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 11px; font-weight: 600;">↑</button>
            <button type="button" class="condition-move-down-btn" title="Move Down" style="min-width: auto; padding: 6px 8px; background: #5a9fb8; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 11px; font-weight: 600;">↓</button>
        </div>
        <div class="condition-preview" title="Click to edit condition" style="flex: 1; min-width: 0; box-sizing: border-box; padding: 6px; background-color: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 4px; color: ${hasCondition ? 'var(--text-input)' : '#888'}; font-weight: 600; font-size: 12px; font-family: 'Courier New', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;">${hasCondition ? escapeHtml(conditionData.condition) : 'Click to set condition...'}</div>
        <select class="condition-action settings-field" style="flex-shrink: 0; width: 90px;">
            <option value="show" ${(!conditionData.action || conditionData.action === 'show') ? 'selected' : ''}>Show</option>
            <option value="hide" ${conditionData.action === 'hide' ? 'selected' : ''}>Hide</option>
        </select>
        <button type="button" class="delete-condition-btn" title="Delete Condition" style="flex-shrink: 0; padding: 6px 10px; background: #a82a2a; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-size: 14px; font-weight: 600;">×</button>
    `;

    container.appendChild(row);

    const previewEl = row.querySelector('.condition-preview');
    const upBtn = row.querySelector('.condition-move-up-btn');
    const downBtn = row.querySelector('.condition-move-down-btn');
    const deleteBtn = row.querySelector('.delete-condition-btn');

    previewEl.addEventListener('click', () => {
        if (typeof openJinjaEditorModal !== 'function') {
            console.warn('[CONDITIONS-MODAL] openJinjaEditorModal not available - is jinja-json.js loaded?');
            return;
        }
        openJinjaEditorModal('Condition', conditionData.condition || '', (newValue) => {
            conditionData.condition = newValue;
            const hasValue = !!(newValue && newValue.trim());
            previewEl.textContent = hasValue ? newValue : 'Click to set condition...';
            previewEl.style.color = hasValue ? '#ffffff' : '#888';
        });
    });

    upBtn.addEventListener('click', (e) => {
        e.preventDefault();
        moveConditionRow(row, 'up');
    });

    downBtn.addEventListener('click', (e) => {
        e.preventDefault();
        moveConditionRow(row, 'down');
    });

    deleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const parent = row.parentElement;
        row.remove();
        updateConditionButtonStates();
        if (parent && !parent.querySelector('.condition-row')) {
            renderNoConditionsMessage(parent);
        }
    });
}

function moveConditionRow(row, direction) {
    const parent = row.parentElement;
    const currentIndex = Array.from(parent.children).indexOf(row);

    if (direction === 'up' && currentIndex > 0) {
        parent.insertBefore(row, parent.children[currentIndex - 1]);
    } else if (direction === 'down' && currentIndex < parent.children.length - 1) {
        parent.insertBefore(row, parent.children[currentIndex + 2]);
    }

    updateConditionButtonStates();
}

function updateConditionButtonStates() {
    const container = document.getElementById('conditionsModalList');
    if (!container) return;

    const rows = container.querySelectorAll('.condition-row');

    rows.forEach((row, index) => {
        const upBtn = row.querySelector('.condition-move-up-btn');
        const downBtn = row.querySelector('.condition-move-down-btn');

        if (upBtn) upBtn.disabled = index === 0;
        if (downBtn) downBtn.disabled = index === rows.length - 1;
    });
}

function renderNoConditionsMessage(container) {
    if (container.querySelector('.no-conditions-message')) return;

    const msg = document.createElement('div');
    msg.className = 'no-conditions-message';
    msg.style.cssText = 'color: #999; text-align: center; padding: 12px; font-size: 13px;';
    msg.textContent = 'No conditions set.';
    container.appendChild(msg);
}

function removeNoConditionsMessage(container) {
    const msg = container.querySelector('.no-conditions-message');
    if (msg) msg.remove();
}

function closeConditionsModal() {
    currentConditionsFieldConfig = null;
    closeModal();
}

function saveConditions() {
    if (!currentConditionsFieldConfig) return;

    const conditionsModalList = document.getElementById('conditionsModalList');
    if (!conditionsModalList) return;

    const rows = conditionsModalList.querySelectorAll('.condition-row');
    const conditions = [];

    rows.forEach(row => {
        const conditionData = row._conditionData || {};
        const actionSelect = row.querySelector('.condition-action');

        const conditionText = (conditionData.condition || '').trim();
        const action = actionSelect ? actionSelect.value : 'show';

        if (conditionText) {
            conditions.push({ condition: conditionText, action });
        }
    });

    currentConditionsFieldConfig.conditions = conditions;

    console.log('[CONDITIONS-MODAL] Saved conditions:', conditions);

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

/**
 * Normalize a radio/dropdown_static field's options into an array of
 * {label, value} pairs - options is now authored as an array directly,
 * but this also accepts the old {label: value} object shape for backward
 * compatibility with forms saved before this change. MySQL's JSON type
 * doesn't preserve object key order (only array order), which is why the
 * array shape is now the standard going forward - see
 * https://dev.mysql.com/doc/refman/8.0/en/json.html#json-normalization.
 * @param {object|Array} options
 * @returns {Array<{label: string, value: string}>}
 */
function normalizeOptionsToArray(options) {
    if (Array.isArray(options)) {
        return options.filter(o => o && typeof o === 'object');
    }
    if (options && typeof options === 'object') {
        return Object.entries(options).map(([label, value]) => ({ label, value }));
    }
    return [];
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
    normalizeOptionsToArray(fieldConfig.options).forEach(({ label, value }) => {
        optionsHtml += `
            <div style="display: flex; gap: 8px; align-items: center;">
                <input type="text" class="option-label settings-field" value="${label}" placeholder="Label" style="flex: 1;">
                <input type="text" class="option-value settings-field" value="${value}" placeholder="Value" style="flex: 1;">
                <button type="button" class="btn delete-option-btn" data-color="red" data-size="sm" style="width: 40px; padding: 0;">×</button>
            </div>
        `;
    });
    
    optionsHtml += `
            </div>
            <button type="button" id="addStaticOptionBtn" class="btn" data-color="blue" data-size="sm" style="width: 100%;">+ Add Option</button>
        </div>
        
        <div class="form-group">
            <label>Default Value${infoIcon('The option that is selected when the form first loads. Leave empty for no default.')}</label>
            <select id="default_value" class="settings-field">
                <option value="">-- Select a default value --</option>
    `;
    
    normalizeOptionsToArray(fieldConfig.options).forEach(({ value }) => {
        const isSelected = fieldConfig.default_value === value ? 'selected' : '';
        optionsHtml += `<option value="${value}" ${isSelected}>${value}</option>`;
    });
    
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
        <div class="form-group">
            <label>Result Path (Optional)${infoIcon('Path to the array within the data returned by the selected task. Use dot notation: "ad_users" for {ad_users: [...]}, or "data.users" for nested. Leave empty if the result is directly an array.')}</label>
            <input type="text" id="plugin_result_path" value="${fieldConfig.result_path || ''}" placeholder="e.g., ad_users or data.users" class="settings-field">
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

        const resultPathInput = document.getElementById('plugin_result_path');
        if (resultPathInput && !resultPathInput.dataset.listenerAttached) {
            resultPathInput.dataset.listenerAttached = 'true';
            resultPathInput.addEventListener('input', () => {
                fieldConfig.result_path = resultPathInput.value;
                showElementSettingsDirty();
            });
        }
    }, 0);
    
    return html;
}

/**
 * Builds the "Kore Util" action selector for dropdown_kore_util (and, via
 * reference, data_retrieval's Kore Util source type). Kore Util actions
 * (kore_sys.workflow_utils, category='kore-data') are a single flat list -
 * unlike Plugin's two-level Plugin -> Task structure, there's just one
 * "provider", so this selects the action directly rather than needing a
 * separate task-selector step.
 */
function buildKoreUtilSelector(fieldConfig) {
    let utilOptions = '';
    if (Array.isArray(availableKoreUtils) && availableKoreUtils.length > 0) {
        utilOptions = availableKoreUtils.map(u => `<option value="${escapeHtml(u.action_name)}" ${fieldConfig.action_name === u.action_name ? 'selected' : ''}>${escapeHtml(u.display_name || u.action_name)}</option>`).join('');
    }

    const html = `
        <div id="kore_util_selector_group" class="form-group">
            <label>Kore Util${infoIcon('Select the Kore data utility action that will provide the dropdown options.')}</label>
            <select id="kore_util_action" class="settings-field">
                <option value="">-- Select action --</option>
                ${utilOptions}
            </select>
        </div>
    `;

    // Return HTML and attach listener after rendering - same self-attaching
    // pattern as buildPluginSelector/buildWorkflowSelector, so this works
    // consistently whether rendered directly (dropdown_kore_util) or via
    // reference (data_retrieval's Kore Util source type).
    setTimeout(() => {
        const utilSelect = document.getElementById('kore_util_action');
        if (utilSelect && !utilSelect.dataset.listenerAttached) {
            utilSelect.dataset.listenerAttached = 'true';
            utilSelect.addEventListener('change', () => {
                const selectedAction = utilSelect.value;
                fieldConfig.action_name = selectedAction;
                fieldConfig.inputs_map = {};
                buildKoreUtilTaskSection(selectedAction, fieldConfig);
                showElementSettingsDirty();
            });

            // If an action is already selected, render its input fields
            if (fieldConfig.action_name) {
                buildKoreUtilTaskSection(fieldConfig.action_name, fieldConfig);
            }
        }
    }, 0);

    return html;
}

/**
 * Renders the selected Kore Util action's input fields. Unlike
 * buildPluginTaskSection, there's no separate resolution round-trip needed -
 * action_config.inputs is already a fully resolved, static input definition
 * (no @config.* / @task.* references to expand server-side) - so this reuses
 * whatever's already cached in availableKoreUtils directly.
 */
function buildKoreUtilTaskSection(actionName, fieldConfig) {
    // Remove existing section if present
    document.getElementById('kore_util_task_section')?.remove();

    if (!actionName) return;

    const selectorGroup = document.getElementById('kore_util_selector_group');
    if (!selectorGroup) return;

    const util = availableKoreUtils.find(u => u.action_name === actionName);
    if (!util) return;

    const section = document.createElement('div');
    section.id = 'kore_util_task_section';
    section.style.paddingBottom = '15px';
    section.style.borderBottom = '1px solid var(--border-primary)';
    section.style.marginBottom = '15px';

    selectorGroup.after(section);

    const task = {
        description: util.description,
        inputs: (util.action_config && Array.isArray(util.action_config.inputs)) ? util.action_config.inputs : []
        // No label_field/value_field - workflow_utils doesn't define per-action
        // defaults for these, so the user sets them via Label/Value Field as usual.
    };

    renderAndWireTaskFields(section, task, fieldConfig);
}

function buildWorkflowTriggerSelector(fieldConfig) {
    // Create a container for the trigger select (area renderer) - populated
    // by populateWorkflowTriggers once a workflow is selected, same pattern
    // as buildWorkflowOutputs/populateWorkflowOutputs.
    return `
        <div id="workflow_trigger_group" class="form-group" style="border-left: 2px solid #444; padding-left: 12px;">
        </div>
    `;
}

/**
 * Populate the Trigger select for a dropdown_workflow field's currently-
 * selected workflow. Same filtering/selection logic as the Submit
 * Workflow's own trigger picker in showFormSettingsModal - only enabled
 * triggers, pre-selects fieldConfig.trigger_id if set, hides itself
 * entirely when the workflow has no triggers.
 * @param {object|null} workflow
 * @param {object} fieldConfig
 */
function populateWorkflowTriggers(workflow, fieldConfig) {
    const container = document.getElementById('workflow_trigger_group');
    if (!container) return;

    if (!workflow) {
        container.innerHTML = '';
        return;
    }

    const triggers = Array.isArray(workflow.definition?.triggers)
        ? workflow.definition.triggers.filter(t => t.enabled !== false)
        : [];

    if (triggers.length === 0) {
        container.innerHTML = '';
        return;
    }

    const triggerOptions = triggers
        .map(t => `<option value="${t.id}" ${fieldConfig.trigger_id === t.id ? 'selected' : ''}>${t.name || t.id}</option>`)
        .join('');

    container.innerHTML = `
        <label>Trigger${infoIcon('Which of the workflow\'s triggers to execute against, if it has more than one.')}</label>
        <select id="workflow_trigger_id" class="settings-field">
            <option value="">-- Select trigger --</option>
            ${triggerOptions}
        </select>
    `;

    container.querySelector('#workflow_trigger_id').addEventListener('change', (e) => {
        fieldConfig.trigger_id = e.target.value;
        showElementSettingsDirty();
    });
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
                fieldConfig.trigger_id = '';
                renderWorkflowInputFields(workflow || null, fieldConfig);
                populateWorkflowOutputs(workflow || null, fieldConfig);
                populateWorkflowTriggers(workflow || null, fieldConfig);
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
                    populateWorkflowTriggers(workflow, fieldConfig);
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
                    updateDefaultValueOptions();
                    showElementSettingsDirty();
                });
                input.addEventListener('input', () => {
                    showElementSettingsDirty();
                });
            });
            
            // Attach delete listener
            optionDiv.querySelector('.delete-option-btn').addEventListener('click', () => {
                optionDiv.remove();
                updateDefaultValueOptions();
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
            updateDefaultValueOptions();
            showElementSettingsDirty();
        });
    });
}

function attachDropdownSqlListeners() {
    const sqlQueryBtn = document.getElementById('sql_query_btn');
    const sqlQueryDisplay = document.getElementById('sql_query_display');
    const sqlDatabaseSelect = document.getElementById('sql_database');
    if (!sqlQueryBtn || !sqlQueryDisplay || !sqlDatabaseSelect) return;

    // buildSQLSelector() already rendered this select's options - including
    // the correct one pre-selected, from fieldConfig.database - so this only
    // needs to attach behavior, not rebuild its contents. (Rebuilding here
    // using sqlDatabaseSelect.dataset.current was the bug: that attribute is
    // never set on this element, so the rebuild always lost the selection.)
    sqlDatabaseSelect.disabled = sqlDatasources.length === 0;

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
        const result = await executeSqlQuery(
            'cookie', null, 'kore_sys',
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

/**
 * Normalize a resolved task input's options to a uniform {value, label}
 * shape - the server's resolution (GET /kore/tasks/:id) can return either
 * plain values (from @config.* / static lists) or {value, label} objects
 * (from @task.* sub-task output rows), and this smooths over that so
 * rendering doesn't need to care which.
 * @param {Array} rawOptions
 * @returns {Array<{value: *, label: string}>}
 */
function normalizeTaskInputOptions(rawOptions) {
    if (!Array.isArray(rawOptions)) return [];
    return rawOptions.map(opt => {
        if (opt && typeof opt === 'object') {
            return { value: opt.value, label: opt.label !== undefined ? opt.label : String(opt.value) };
        }
        return { value: opt, label: String(opt) };
    });
}

/**
 * Fetch a single task's full details with select-type inputs' options
 * fully resolved - @config.* and @task.* reference strings expanded into real
 * values server-side (including executing referenced sub-tasks), via
 * GET /kore/tasks/:taskId. The cached list from fetchPluginTasks() has
 * these as raw, unresolved reference strings, which is why this is a
 * separate call made specifically when a task gets selected/reopened.
 * @param {number} taskId
 * @returns {Promise<object|null>}
 */
async function fetchResolvedTaskDetails(taskId) {
    try {
        const response = await fetch(`https://app.equinoxits.com:1139/kore/tasks/${taskId}`, {
            credentials: 'include'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data.task || null;
    } catch (err) {
        console.error('[Plugin Task Details] Failed to fetch resolved task details:', taskId, err);
        return null;
    }
}

/**
 * Build HTML for a plugin task's declared input fields, type-aware:
 * checkbox/boolean, radio, select (single, or multi via our own
 * multi-select widget when input.multiple is set), textarea, number,
 * datetime, and plain text as the fallback for anything else.
 *
 * Deliberately ignores target/format/ifChecked/ifUnchecked entirely -
 * combining those into whatever the task sends server-side is the
 * Plugins engine's own job; the form system only needs to collect
 * {input.name: value} pairs (per the current system owner - not
 * something we replicate client-side).
 *
 * Doesn't resolve @config.* and @task.* references itself - task.inputs is
 * expected to already have real option values (see
 * fetchResolvedTaskDetails).
 * @param {Array<object>} inputs
 * @param {object} existingValues - Currently-saved inputs_map, to
 *   pre-populate each field's value on reopen
 * @returns {{html: string, multiSelectFields: Array<{name: string, inputId: string, options: Array, existingValue: Array}>}}
 *   multiSelectFields lists any multi-selects that still need
 *   initializeMultiSelect() called on them once this HTML is in the DOM.
 */
function renderTaskInputsHtml(inputs, existingValues) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
        return { html: '', multiSelectFields: [] };
    }

    const values = existingValues || {};
    const multiSelectFields = [];
    let html = '';

    inputs.forEach(input => {
        const inputId = `task_input_${input.name}`;
        const savedVal = values[input.name];
        const hasSaved = savedVal !== undefined;
        const requiredMarker = input.required ? ' <span style="color: #b8242f; font-size: 11px;">* Required</span>' : '';
        const labelText = escapeHtml(input.label || input.name);

        if (input.type === 'boolean' || input.type === 'checkbox') {
            const checked = hasSaved ? !!savedVal : !!input.default;
            html += `
                <div class="form-group--inline">
                    <input type="checkbox" id="${inputId}" class="plugin-task-input-field" data-input-name="${escapeHtml(input.name)}" data-input-type="checkbox" ${checked ? 'checked' : ''}>
                    <label for="${inputId}">${labelText}${requiredMarker}</label>
                </div>
            `;
        } else if (input.type === 'radio') {
            const options = normalizeTaskInputOptions(input.options);
            html += `<div class="form-group"><label>${labelText}${requiredMarker}</label>`;
            options.forEach((opt, idx) => {
                const radioId = `${inputId}_${idx}`;
                const isChecked = hasSaved && String(savedVal) === String(opt.value);
                html += `
                    <div class="form-group--inline">
                        <input type="radio" id="${radioId}" name="${inputId}" value="${escapeHtml(String(opt.value))}" class="plugin-task-input-field" data-input-name="${escapeHtml(input.name)}" data-input-type="radio" ${isChecked ? 'checked' : ''}>
                        <label for="${radioId}">${escapeHtml(opt.label)}</label>
                    </div>
                `;
            });
            html += `</div>`;
        } else if (input.type === 'select' && input.multiple) {
            const options = normalizeTaskInputOptions(input.options);
            const existingArray = Array.isArray(savedVal) ? savedVal.map(String) : [];
            html += `
                <div class="form-group">
                    <label>${labelText}${requiredMarker}</label>
                    ${renderMultiSelectContainer(inputId, input.name)}
                </div>
            `;
            multiSelectFields.push({ name: input.name, inputId, options, existingValue: existingArray });
        } else if (input.type === 'select') {
            const options = normalizeTaskInputOptions(input.options);
            const isJinjaValue = hasSaved && /\{\{[\s\S]*\}\}/.test(String(savedVal));
            const staticControlHtml = `
                <select class="jinja-static-input">
                    <option value="">-- Select --</option>
                    ${options.map(opt => `<option value="${escapeHtml(String(opt.value))}" ${!isJinjaValue && hasSaved && String(savedVal) === String(opt.value) ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
                </select>
            `;
            html += renderJinjaToggleFieldHtml(input, inputId, labelText, requiredMarker, hasSaved ? String(savedVal) : '', isJinjaValue, staticControlHtml);
        } else if (input.type === 'textarea') {
            const currentValue = hasSaved ? String(savedVal) : (input.default || '');
            const isJinjaValue = /\{\{[\s\S]*\}\}/.test(currentValue);
            const staticControlHtml = `<textarea class="jinja-static-input" placeholder="">${escapeHtml(currentValue)}</textarea>`;
            html += renderJinjaToggleFieldHtml(input, inputId, labelText, requiredMarker, currentValue, isJinjaValue, staticControlHtml);
        } else if (input.type === 'number') {
            const currentValue = hasSaved ? String(savedVal) : (input.default !== undefined ? String(input.default) : '');
            const isJinjaValue = /\{\{[\s\S]*\}\}/.test(currentValue);
            const staticControlHtml = `<input type="number" class="jinja-static-input" value="${escapeHtml(isJinjaValue ? '' : currentValue)}">`;
            html += renderJinjaToggleFieldHtml(input, inputId, labelText, requiredMarker, currentValue, isJinjaValue, staticControlHtml);
        } else if (input.type === 'datetime') {
            const currentValue = hasSaved ? String(savedVal) : '';
            const isJinjaValue = /\{\{[\s\S]*\}\}/.test(currentValue);
            const staticControlHtml = `<input type="datetime-local" class="jinja-static-input" value="${escapeHtml(isJinjaValue ? '' : currentValue)}">`;
            html += renderJinjaToggleFieldHtml(input, inputId, labelText, requiredMarker, currentValue, isJinjaValue, staticControlHtml);
        } else {
            // 'text' and any unrecognized type falls back to plain text -
            // still supports [[field_name]] references, same as workflow
            // inputs, since that's resolved the same way regardless of
            // which map (workflow_input vs inputs_map) it ends up in.
            const currentValue = hasSaved ? String(savedVal) : (input.default || '');
            const isJinjaValue = /\{\{[\s\S]*\}\}/.test(currentValue);
            const staticControlHtml = `<input type="text" class="jinja-static-input" value="${escapeHtml(isJinjaValue ? '' : currentValue)}" placeholder="e.g. [[field_name]] or static value">`;
            html += renderJinjaToggleFieldHtml(input, inputId, labelText, requiredMarker, currentValue, isJinjaValue, staticControlHtml);
        }
    });

    return { html, multiSelectFields };
}

/**
 * Wraps a single input control (text/select/textarea/number/etc.) with a "{ }" toggle
 * button that switches between the normal static control and a clickable preview that
 * opens the real Jinja editor (openJinjaEditorModal from jinja-json.js). Regardless of
 * mode, the value that actually gets saved is read from a single hidden <input> - the
 * only element carrying hiddenInputClass/data-input-name - so callers' existing
 * class-based extraction (live self-save or save-time DOM query) needs no changes,
 * as long as the static control uses a different class (e.g. "jinja-static-input").
 */
function renderJinjaToggleFieldHtml(input, inputId, labelText, requiredMarker, currentValue, isJinjaValue, staticControlHtml, hiddenInputClass = 'plugin-task-input-field') {
    return `
        <div class="form-group jinja-toggle-field" data-jinja-field-name="${escapeHtml(input.name)}">
            <label style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <span>${labelText}${requiredMarker}</span>
                <button type="button" class="btn jinja-toggle-btn" data-color="blue" data-size="sm" title="${isJinjaValue ? 'Switch back to list' : 'Use a Jinja expression'}" style="min-width: auto; padding: 2px 8px; font-family: 'Courier New', monospace; font-weight: 700;">${isJinjaValue ? '☰' : '{ }'}</button>
            </label>
            <input type="hidden" id="${inputId}" class="${hiddenInputClass}" data-input-name="${escapeHtml(input.name)}" data-input-type="text" value="${escapeHtml(currentValue)}">
            <div class="jinja-static-control" style="display: ${isJinjaValue ? 'none' : 'block'};">
                ${staticControlHtml}
            </div>
            <div class="jinja-preview-control" title="Click to edit Jinja expression" style="display: ${isJinjaValue ? 'block' : 'none'}; box-sizing: border-box; padding: 6px; background-color: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 4px; color: ${isJinjaValue ? 'var(--text-input)' : '#888'}; font-weight: 600; font-size: 12px; font-family: 'Courier New', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;">${isJinjaValue ? escapeHtml(currentValue) : 'Click to set Jinja expression...'}</div>
        </div>
    `;
}

/**
 * Wires up the "{ }" Jinja toggle behavior for all .jinja-toggle-field wrappers
 * within a container. Must be called after the container's own
 * .plugin-task-input-field listeners are attached, since toggling/editing
 * dispatches a synthetic 'input' event on the hidden input (useful for callers
 * like the plugin task inputs that key their own re-capture logic off that
 * event), and also calls showElementSettingsDirty() directly so dirty-tracking
 * works even for callers (like data_retrieval's workflow inputs) that only
 * read values from the DOM at save time rather than self-saving on every
 * change.
 *
 * onValueChange(inputName, value), if provided, fires on every value change
 * (static edit, jinja save, or mode toggle) - needed for callers like
 * dropdown_workflow's renderWorkflowInputFields, where fieldConfig.type is
 * always the generic 'dropdown' and the type-specific save-time DOM query for
 * workflow_input never actually runs, so self-saving live is the only way
 * the value gets persisted at all.
 */
function wireJinjaToggleFields(container, onValueChange) {
    if (!container) return;

    container.querySelectorAll('.jinja-toggle-field').forEach(wrapper => {
        const hiddenInput = wrapper.querySelector('input[type="hidden"]');
        const staticControlWrap = wrapper.querySelector('.jinja-static-control');
        const staticInput = wrapper.querySelector('.jinja-static-input');
        const previewEl = wrapper.querySelector('.jinja-preview-control');
        const toggleBtn = wrapper.querySelector('.jinja-toggle-btn');

        if (!hiddenInput || !staticControlWrap || !staticInput || !previewEl || !toggleBtn) return;

        const inputName = wrapper.dataset.jinjaFieldName;

        const notifyValueChange = () => {
            if (typeof onValueChange === 'function') {
                onValueChange(inputName, hiddenInput.value);
            }
        };

        const dispatchHiddenInput = () => {
            hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
        };

        const syncFromStatic = () => {
            hiddenInput.value = staticInput.value;
            dispatchHiddenInput();
            notifyValueChange();
            showElementSettingsDirty();
        };
        staticInput.addEventListener('input', syncFromStatic);
        staticInput.addEventListener('change', syncFromStatic);

        const isJinjaMode = () => staticControlWrap.style.display === 'none';

        const enterJinjaMode = (value) => {
            hiddenInput.value = value;
            const hasValue = !!(value && value.trim());
            previewEl.textContent = hasValue ? value : 'Click to set Jinja expression...';
            previewEl.style.color = hasValue ? 'var(--text-input)' : '#888';
            staticControlWrap.style.display = 'none';
            previewEl.style.display = 'block';
            toggleBtn.textContent = '☰';
            toggleBtn.title = 'Switch back to list';
            dispatchHiddenInput();
            notifyValueChange();
            showElementSettingsDirty();
        };

        const enterStaticMode = () => {
            staticControlWrap.style.display = 'block';
            previewEl.style.display = 'none';
            toggleBtn.textContent = '{ }';
            toggleBtn.title = 'Use a Jinja expression';
            hiddenInput.value = staticInput.value;
            dispatchHiddenInput();
            notifyValueChange();
            showElementSettingsDirty();
        };

        // Seed the caller's self-save target with the initial rendered value
        // (e.g. a value restored from a saved form) in case it hasn't been
        // captured any other way yet.
        notifyValueChange();

        const openEditor = () => {
            if (typeof openJinjaEditorModal !== 'function') {
                console.warn('[PLUGIN-TASK-INPUTS] openJinjaEditorModal not available - is jinja-json.js loaded?');
                return;
            }
            openJinjaEditorModal('Jinja Expression', hiddenInput.value || '', (newValue) => {
                enterJinjaMode(newValue);
            });
        };

        previewEl.addEventListener('click', openEditor);

        toggleBtn.addEventListener('click', () => {
            if (isJinjaMode()) {
                enterStaticMode();
            } else {
                openEditor();
            }
        });
    });
}

/**
 * Render a resolved task's description + input fields into a fresh
 * #plugin_task_fields div appended to the given section, and wire up
 * type-aware self-saving - each input writes its value into
 * fieldConfig.inputs_map live (mirroring renderWorkflowInputFields's
 * pattern for workflow_input), rather than deferring to a separate
 * "extract on save click" step.
 * @param {HTMLElement} section - #plugin_task_section
 * @param {object} task - Resolved task details (see fetchResolvedTaskDetails)
 * @param {object} fieldConfig
 */
function renderAndWireTaskFields(section, task, fieldConfig) {
    document.getElementById('plugin_task_fields')?.remove();
    if (!fieldConfig.inputs_map) fieldConfig.inputs_map = {};

    const fieldsDiv = document.createElement('div');
    fieldsDiv.id = 'plugin_task_fields';

    const panel = document.createElement('div');
    panel.className = 'panel-level-3';

    if (task.description) {
        const desc = document.createElement('div');
        desc.style.cssText = 'color: #999; font-size: 12px; margin-bottom: 12px;';
        desc.textContent = task.description;
        panel.appendChild(desc);
    }

    const { html, multiSelectFields } = renderTaskInputsHtml(task.inputs, fieldConfig.inputs_map);
    panel.innerHTML += html;

    fieldsDiv.appendChild(panel);
    section.appendChild(fieldsDiv);

    // Pre-populate universal label/value fields from task defaults if not already set.
    // Setting .value alone isn't enough - the actual persistence for these fields
    // happens via their own 'input' listener (self-save into fieldConfig, see the
    // fieldGroup renderer), which only fires on user interaction. Since this prefill
    // is programmatic, fieldConfig must be updated directly here too, or the visibly
    // correct-looking default silently never gets saved.
    const labelFieldInput = document.getElementById('label_field');
    const valueFieldInput = document.getElementById('value_field');
    if (labelFieldInput && !fieldConfig.label_field && task.label_field) {
        labelFieldInput.value = task.label_field;
        fieldConfig.label_field = task.label_field;
    }
    if (valueFieldInput && !fieldConfig.value_field && task.value_field) {
        valueFieldInput.value = task.value_field;
        fieldConfig.value_field = task.value_field;
    }

    // Multi-selects need real DOM elements to initialize against, so this
    // has to happen after the HTML above is actually in the document.
    multiSelectFields.forEach(msf => {
        const hiddenSelect = document.getElementById(msf.inputId);
        const container = hiddenSelect ? hiddenSelect.closest('.multi-select-container') : null;
        if (!container) return;
        initializeMultiSelect(container, msf.options, msf.existingValue, {
            onChange: (selected) => {
                fieldConfig.inputs_map[msf.name] = selected;
                showElementSettingsDirty();
            }
        });
    });

    // Type-aware capture, used both to seed inputs_map immediately below
    // (so untouched inputs - using their rendered default/pre-filled
    // state - still end up in inputs_map, not just ones the user actually
    // interacts with) and by each input's own change listener afterward.
    function captureInputValue(inputName) {
        const el = fieldsDiv.querySelector(`[data-input-name="${inputName}"]`);
        if (!el) return;
        const inputType = el.dataset.inputType;
        if (inputType === 'checkbox') {
            fieldConfig.inputs_map[inputName] = el.checked;
        } else if (inputType === 'radio') {
            const checkedEl = fieldsDiv.querySelector(`input[data-input-name="${inputName}"]:checked`);
            fieldConfig.inputs_map[inputName] = checkedEl ? checkedEl.value : null;
        } else {
            fieldConfig.inputs_map[inputName] = el.value;
        }
    }

    const uniqueInputNames = new Set();
    fieldsDiv.querySelectorAll('.plugin-task-input-field').forEach(el => uniqueInputNames.add(el.dataset.inputName));
    uniqueInputNames.forEach(name => captureInputValue(name));

    // Ongoing changes - reuses the same capture logic above.
    fieldsDiv.querySelectorAll('.plugin-task-input-field').forEach(el => {
        const inputType = el.dataset.inputType;
        const eventName = (inputType === 'checkbox' || inputType === 'radio' || inputType === 'select') ? 'change' : 'input';
        el.addEventListener(eventName, () => {
            captureInputValue(el.dataset.inputName);
            showElementSettingsDirty();
        });
    });

    wireJinjaToggleFields(fieldsDiv);
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
    section.style.paddingBottom = '15px';
    section.style.borderBottom = '1px solid var(--border-primary)';
    section.style.marginBottom = '15px';

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

    // Fetch tasks (cached after first load) - note these have raw,
    // unresolved option references; only used here to populate the task
    // dropdown itself.
    const tasks = await fetchPluginTasks(pluginName);
    const taskSelect = document.getElementById('plugin_task');
    taskSelect.innerHTML = '<option value="">-- Select task --</option>';
    tasks.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.task_id;
        opt.textContent = t.display_name;
        // String comparison guards against task_id coming back as a numeric
        // string from the driver instead of a JS number.
        if (String(t.task_id) === String(selectedTaskId)) opt.selected = true;
        taskSelect.appendChild(opt);
    });
    taskSelect.disabled = tasks.length === 0;
    if (tasks.length === 0) {
        taskSelect.innerHTML = '<option value="">No tasks available</option>';
    }

    // If a task is already selected, fetch its fully-resolved details
    // (real option values, not raw @config.* / @task.* strings) and render
    // its fields immediately.
    if (selectedTaskId) {
        const resolvedTask = await fetchResolvedTaskDetails(selectedTaskId);
        const currentSection = document.getElementById('plugin_task_section');
        if (resolvedTask && currentSection) {
            renderAndWireTaskFields(currentSection, resolvedTask, fieldConfig);
        }
    }

    taskSelect.addEventListener('change', async () => {
        const task = tasks.find(t => String(t.task_id) === taskSelect.value);
        fieldConfig.task_id = task?.task_id || null;
        fieldConfig.inputs_map = {};

        document.getElementById('plugin_task_fields')?.remove();
        showElementSettingsDirty();

        if (task) {
            const resolvedTask = await fetchResolvedTaskDetails(task.task_id);
            const currentSection = document.getElementById('plugin_task_section');
            if (resolvedTask && currentSection) {
                renderAndWireTaskFields(currentSection, resolvedTask, fieldConfig);
            }
        }
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
            const inputId = `wf_input_${input.name}`;
            const savedVal = fieldConfig.workflow_input?.[input.name] || '';
            const isJinjaValue = /\{\{[\s\S]*\}\}/.test(String(savedVal));
            const staticControlHtml = `<input type="text" class="jinja-static-input" value="${escapeHtml(isJinjaValue ? '' : String(savedVal))}" placeholder="e.g. [[field_name]] or static value">`;
            const group = document.createElement('div');
            group.innerHTML = renderJinjaToggleFieldHtml({ name: input.name }, inputId, escapeHtml(input.name), '', String(savedVal), isJinjaValue, staticControlHtml, 'workflow-input-field');
            container.appendChild(group.firstElementChild);
        });
    }

    wireJinjaToggleFields(container, (inputName, value) => {
        if (!inputName) return;
        if (!fieldConfig.workflow_input) fieldConfig.workflow_input = {};
        fieldConfig.workflow_input[inputName] = value;
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
                    delete fieldConfig.trigger_id;
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
            const inputId = `dr_wf_input_${input.name}`;
            const savedVal = fieldConfig.workflow_input?.[input.name] || '';
            const isJinjaValue = /\{\{[\s\S]*\}\}/.test(String(savedVal));
            const staticControlHtml = `<input type="text" class="jinja-static-input" value="${escapeHtml(isJinjaValue ? '' : String(savedVal))}" placeholder="Enter value or [[variable]]">`;
            const group = document.createElement('div');
            group.innerHTML = renderJinjaToggleFieldHtml({ name: input.name }, inputId, escapeHtml(input.name), '', String(savedVal), isJinjaValue, staticControlHtml, 'workflow-input-field');
            inputSection.appendChild(group.firstElementChild);
        });
        
        anchor.appendChild(inputSection);

        wireJinjaToggleFields(inputSection, (inputName, value) => {
            if (!inputName) return;
            if (!fieldConfig.workflow_input) fieldConfig.workflow_input = {};
            fieldConfig.workflow_input[inputName] = value;
        });
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
            'dropdown_workflow': ['workflow_id', 'workflow_input', 'workflow_output', 'label_field', 'value_field', 'data_variable', 'default_selector', 'multi_select', 'searchable', 'result_var', 'tree_view', 'parent_field', 'level_field'],
            'dropdown_sql': ['database', 'query', 'label_field', 'value_field', 'data_variable', 'default_selector', 'multi_select', 'searchable', 'result_var', 'tree_view', 'parent_field', 'level_field'],
            'dropdown_plugin': ['plugin', 'task_id', 'label_field', 'value_field', 'data_variable', 'result_path', 'inputs_map', 'multi_select', 'searchable', 'result_var', 'tree_view', 'parent_field', 'level_field'],
            'dropdown_kore_util': ['action_name', 'label_field', 'value_field', 'data_variable', 'inputs_map', 'multi_select', 'searchable', 'result_var', 'tree_view', 'parent_field', 'level_field'],
            'dropdown_prefetch': ['source_element_name', 'result_path', 'label_field', 'value_field', 'data_variable', 'default_selector', 'multi_select', 'searchable', 'result_var']
        };
        
        // Helper: Save common dropdown-style fields
        const saveDropdownCommonFields = (idPrefix = '') => {
            fieldConfig.default_selector = document.getElementById(`${idPrefix}default_selector`)?.value || 'default';
            fieldConfig.multi_select = document.getElementById('multi_select')?.checked || false;
            fieldConfig.searchable = document.getElementById('searchable')?.checked !== false;
            fieldConfig.result_var = document.getElementById('result_var')?.value || '';
            fieldConfig.label_field = document.getElementById('label_field')?.value || '';
            fieldConfig.value_field = document.getElementById('value_field')?.value || '';
            fieldConfig.data_variable = document.getElementById('data_variable')?.value || '';
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
            const allDropdownFields = ['options', 'default_value', 'workflow_id', 'workflow_input', 'workflow_output', 'label_field', 'value_field', 'data_variable',
                'default_selector', 'query', 'database', 'plugin', 'task_id', 'action_name', 'inputs_map',
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
    if (config.submit_trigger_id !== undefined) window._formSettings.submit_trigger_id = config.submit_trigger_id;
    if (config.active !== undefined) window._formSettings.active = config.active;
    
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
        markFormChanged();
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
// (Column count changes are tracked via handleColumnChange in
// initializeFormLayout, which covers both the hidden select and the
// visible One/Two/Three radio buttons.)
['form_name', 'show_name', 'show_vert_sep'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', markFormChanged);
        el.addEventListener('change', markFormChanged);
    }
});

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
    const currentTriggerId = fs.submit_trigger_id || '';

    // Build workflow options from already-loaded availableWorkflows
    const workflowOptions = (availableWorkflows || [])
        .map(w => `<option value="${w.id}" ${currentWorkflowId === w.id ? 'selected' : ''}>${w.name}</option>`)
        .join('');

    // Get the (enabled) triggers for a given workflow id from its cached definition
    const getTriggersForWorkflow = (workflowId) => {
        const workflow = (availableWorkflows || []).find(w => w.id === workflowId);
        const triggers = Array.isArray(workflow?.definition?.triggers) ? workflow.definition.triggers : [];
        return triggers.filter(t => t.enabled !== false);
    };

    const initialTriggers = getTriggersForWorkflow(currentWorkflowId);
    const triggerOptions = initialTriggers
        .map(t => `<option value="${t.id}" ${currentTriggerId === t.id ? 'selected' : ''}>${t.name || t.id}</option>`)
        .join('');

    const content = document.createElement('div');
    content.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
    content.innerHTML = `
        <div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="fs_show_name" ${(config.show_name ?? true) ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;">
                <label for="fs_show_name" style="color: var(--text-muted); font-size: 11px; cursor: pointer; margin: 0; font-weight: 600;">Show Form Name</label>
            </div>
        </div>
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
        <div id="fs_trigger_row" style="display: none;">
            <label style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px; font-weight: 600;">Trigger</label>
            <select id="fs_trigger_id" style="width: 100%;">
                <option value="">-- Select trigger --</option>
                ${triggerOptions}
            </select>
        </div>
    `;

    const submitTypeSelect = content.querySelector('#fs_submit_type');
    const workflowRow = content.querySelector('#fs_workflow_row');
    const workflowSelect = content.querySelector('#fs_workflow_id');
    const triggerRow = content.querySelector('#fs_trigger_row');
    const triggerSelect = content.querySelector('#fs_trigger_id');

    // Repopulate the trigger dropdown for whichever workflow is currently selected
    const populateTriggerOptions = (workflowId, selectedTriggerId = '') => {
        const triggers = getTriggersForWorkflow(workflowId);
        triggerSelect.innerHTML = '<option value="">-- Select trigger --</option>' +
            triggers.map(t => `<option value="${t.id}" ${selectedTriggerId === t.id ? 'selected' : ''}>${t.name || t.id}</option>`).join('');
        return triggers;
    };

    const syncTriggerRowVisibility = () => {
        const hasWorkflow = !!workflowSelect.value;
        const triggerCount = triggerSelect.options.length - 1; // minus the placeholder option
        triggerRow.style.display = (submitTypeSelect.value === 'Workflow' && hasWorkflow && triggerCount > 0) ? 'block' : 'none';
    };

    const syncWorkflowRowVisibility = () => {
        workflowRow.style.display = submitTypeSelect.value === 'Workflow' ? 'block' : 'none';
        syncTriggerRowVisibility();
    };

    // Sync immediately in case the select's actual rendered value (e.g. browser
    // defaulting to the first option when no stored value matched) differs from
    // the value used to compute the row's initial inline style above.
    syncWorkflowRowVisibility();

    submitTypeSelect.addEventListener('change', syncWorkflowRowVisibility);

    workflowSelect.addEventListener('change', (e) => {
        populateTriggerOptions(e.target.value);
        syncTriggerRowVisibility();
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
                    window._formSettings.submit_trigger_id = content.querySelector('#fs_trigger_id').value;

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
// JSON IMPORT (update the currently-open form in place)
// ============================================
const importFormJsonBtn = document.getElementById('importFormJsonBtn');

if (importFormJsonBtn) {
    importFormJsonBtn.addEventListener('click', () => {
        menuDropdown.style.display = 'none';
        showImportFormJSONModal();
    });
}

/**
 * Opens an editable JSON modal for pasting in a replacement form definition
 * (e.g. one converted/generated outside the builder), separate from the
 * read-only "View JSON" below. Intended for developers/operators without
 * direct DB access to apply definition updates without going through the
 * forms-list page's full "New Form" import flow.
 *
 * Mirrors wf-core.js's showImportJSONModal/handleImportJSON pattern for
 * workflows - same openJsonEditorModal helper, same "validate, confirm,
 * replace in-memory state, let the normal Save flow persist it" shape.
 */
function showImportFormJSONModal() {
    openJsonEditorModal('Import Form JSON', '', handleImportFormJSON, false);
}

/**
 * Validates and applies a pasted form JSON definition, replacing the
 * CURRENTLY OPEN form's fields/settings in place. Deliberately does not
 * touch the form's id/URL - this replaces the existing form's contents, it
 * does not create a new form or navigate away. Does not save to the
 * database itself; the normal Save button/flow still applies afterward, so
 * the imported result can be reviewed in the builder first.
 * @param {string} jsonText - Raw pasted JSON text
 * @returns {boolean|Promise<boolean>} true if applied, false if rejected
 *   (invalid JSON, failed validation, or the user cancelled the replace
 *   confirmation)
 */
function handleImportFormJSON(jsonText) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        showStatusBanner(`Import failed: invalid JSON (${err.message})`, 'error');
        return false;
    }

    // --- Structural validation - catch problems before touching any live state ---
    const errors = [];
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push('Root must be a JSON object.');
    } else {
        const fieldConfigsArray = getConfigValue(parsed, 'fieldConfigs', 'field_configs');
        if (!Array.isArray(fieldConfigsArray) || fieldConfigsArray.length === 0) {
            errors.push('Missing or empty "field_configs" array.');
        } else {
            const missingNameIdx = fieldConfigsArray.findIndex(f => !f || !f.field_name);
            if (missingNameIdx !== -1) {
                errors.push(`Field at index ${missingNameIdx} is missing "field_name".`);
            }

            const fieldNames = fieldConfigsArray.map(f => f && f.field_name).filter(Boolean);
            const dupNames = [...new Set(fieldNames.filter((n, i) => fieldNames.indexOf(n) !== i))];
            if (dupNames.length > 0) {
                errors.push(`Duplicate field_name(s): ${dupNames.join(', ')}`);
            }

            // Dangling dependant_fields reference check - a field pointing at a
            // field_name that doesn't exist anywhere in this same pasted
            // definition would otherwise silently block forever (see
            // getFieldDependencyStatus in forms.js: an unresolved dependant
            // simply never appears, so no error surfaces at all downstream).
            const allFieldNames = new Set(fieldNames);
            fieldConfigsArray.forEach(f => {
                if (f && f.dependant_fields && typeof f.dependant_fields === 'object') {
                    Object.keys(f.dependant_fields).forEach(depName => {
                        if (!allFieldNames.has(depName)) {
                            errors.push(`Field "${f.field_name}" depends on unknown field "${depName}".`);
                        }
                    });
                }
            });
        }
    }

    if (errors.length > 0) {
        const shown = errors.length > 3 ? errors.slice(0, 3).concat([`...and ${errors.length - 3} more (see console)`]) : errors;
        showStatusBanner(`Import failed: ${shown.join(' | ')}`, 'error', 'statusMessage', 999999999);
        if (errors.length > 3) console.error('[Import Form JSON] Full validation error list:', errors);
        return false;
    }

    // --- Confirm before replacing (this is destructive to the in-memory
    // builder state, even though it doesn't save to the DB by itself). Uses
    // the same stacking modal system as the rest of the app (showModal/
    // modalStack) so this layers on top of the still-open Import modal
    // rather than a native browser confirm() - built with showModal
    // directly rather than a showConfirm() convenience wrapper, since
    // Cancel and Confirm need to resolve this function's return value
    // differently (same reasoning as wf-core.js's handleImportJSON).
    const importedName = getConfigValue(parsed, 'name', 'formName', 'form_name') || '(unnamed)';
    const currentName = formNameInput?.value?.trim() || '(unnamed)';
    const nameNote = importedName !== currentName
        ? ` Note: the pasted definition is named "${importedName}", which differs from the current form's name ("${currentName}").`
        : '';

    return new Promise((resolve) => {
        showModal({
            title: 'Confirm Overwrite',
            content: `<p style="color: var(--text-primary); margin: 0;">This replaces the current form's fields and settings with the pasted JSON.${nameNote} Nothing is saved to the database yet — review the result in the builder, then click Save (or discard by reloading the page).</p>`,
            closeOnBackdrop: false,  // must resolve one way or the other, not silently dismiss
            buttons: [
                {
                    label: 'Cancel',
                    type: 'secondary',
                    onClick: () => {
                        // Import modal stays open (per the false return) so the
                        // pasted text isn't lost - user can edit and retry.
                        resolve(false);
                    }
                },
                {
                    label: 'Replace',
                    type: 'danger',
                    onClick: () => {
                        // Close out any open element settings panel first - it may
                        // be pointing at a uid that won't exist after the replace.
                        closeElementSettings();

                        // loadFormConfiguration already does exactly what's needed
                        // here: clears fieldConfigs/the DOM columns, resets element
                        // counters, restores name/show_name/version/submit
                        // settings, and re-renders every field from field_configs -
                        // the same path performFormLoad() uses after a normal
                        // fetch. Re-invoking it mid-session is safe/idempotent.
                        loadFormConfiguration(parsed);
                        markFormChanged();
                        updateSaveButtonState();

                        showStatusBanner('Form JSON imported - review the fields, then Save to persist.', 'success');
                        resolve(true);
                    }
                }
            ]
        });
    });
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
            // Collect radio options - selectors must match buildRadioOptions'
            // actual rendered markup (.radio-option-row / .radio-option-label /
            // .radio-option-value), not the data-option-field attributes used
            // by the older/unused buildRadioFields renderer.
            const optionRows = settingsForm ? settingsForm.querySelectorAll('.radio-option-row') : [];
            const options = [];
            optionRows.forEach(row => {
                const labelInput = row.querySelector('.radio-option-label');
                const valueInput = row.querySelector('.radio-option-value');
                if (labelInput && labelInput.value) {
                    options.push({ label: labelInput.value, value: valueInput?.value || labelInput.value });
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
            
        } else if (fieldConfig.type === 'data_retrieval') {
            // Workflow and Plugin sources self-save live: their selectors
            // (buildWorkflowSelector / buildPluginSelector) attach their own
            // change listeners that write straight to fieldConfig, same as
            // for dropdown_workflow/dropdown_plugin fields. SQL doesn't -
            // buildSQLSelector/buildDropdownSqlFields only build HTML, same
            // gap dropdown_sql had - so it needs the same explicit handling.
            if (fieldConfig.data_source_type === 'SQL') {
                const sqlDatabaseSelect = document.getElementById('sql_database');
                if (sqlDatabaseSelect) fieldConfig.database = sqlDatabaseSelect.value || '';

                const sqlQueryDisplay = document.getElementById('sql_query_display');
                if (sqlQueryDisplay) fieldConfig.query = sqlQueryDisplay.dataset.query || '';
            }
            
        } else if (fieldConfig.type === 'dropdown') {
            const resultVarInput = document.getElementById('result_var');
            if (resultVarInput) fieldConfig.result_var = resultVarInput.value;
            
            // Handle dropdown_static specifically
            if (fieldConfig.dropdown_type === 'dropdown_static') {
                const options = [];
                const optionLabels = settingsForm ? settingsForm.querySelectorAll('.option-label') : [];
                const optionValues = settingsForm ? settingsForm.querySelectorAll('.option-value') : [];
                
                optionLabels.forEach((labelInput, index) => {
                    const label = labelInput.value;
                    const value = optionValues[index]?.value || label;
                    if (label) {
                        options.push({ label, value });
                    }
                });
                
                fieldConfig.options = options;
                
                const defaultValueSelect = document.getElementById('default_value');
                if (defaultValueSelect) fieldConfig.default_value = defaultValueSelect.value;
            } else if (fieldConfig.dropdown_type === 'dropdown_sql') {
                const sqlDatabaseSelect = document.getElementById('sql_database');
                if (sqlDatabaseSelect) fieldConfig.database = sqlDatabaseSelect.value || '';

                const sqlQueryDisplay = document.getElementById('sql_query_display');
                if (sqlQueryDisplay) fieldConfig.query = sqlQueryDisplay.dataset.query || '';
            } else if (fieldConfig.dropdown_type === 'dropdown_prefetch') {
                const prefetchSourceSelect = document.getElementById('prefetch_source_element_name');
                if (prefetchSourceSelect) fieldConfig.source_element_name = prefetchSourceSelect.value || '';

                const prefetchResultPathInput = document.getElementById('prefetch_result_path');
                if (prefetchResultPathInput) fieldConfig.result_path = prefetchResultPathInput.value || '';

                const prefetchDefaultSelectorInput = document.getElementById('prefetch_default_selector');
                if (prefetchDefaultSelectorInput) fieldConfig.default_selector = prefetchDefaultSelectorInput.value || 'default';
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
        
        // Update the draggable element's label in the canvas to reflect the saved Display Name
        const canvasElement = document.querySelector(`[data-uid="${fieldConfig.uid}"]`);
        if (canvasElement) {
            const labelSpan = canvasElement.querySelector('span');
            if (labelSpan) {
                labelSpan.textContent = fieldConfig.field_displayname?.trim() || fieldConfig.field_name;
            }
        }
        
        // Mark form as modified
        markFormChanged();
        
        // Close settings panel
        closeElementSettings(true);
    });
}

// ============================================
// URL PARAMETER INITIALIZATION
// ============================================
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
        active: fs.active !== undefined ? fs.active : true,
        column_count: columnCount,
        show_vert_sep: showVertSep,
        show_name: showTitle,
        version: formVersion,
        submit_type: fs.submit_type || 'Workflow',
        submit_workflow_id: fs.submit_workflow_id || '',
        submit_trigger_id: fs.submit_trigger_id || '',
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

        // The definition saved here must be byte-for-byte what "View JSON"
        // shows - both come from buildFormConfig(). No key renaming/
        // reconstruction, so the two never drift out of sync again.
        const definition = { ...config };
        const payload = {
            name: config.form_name,
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

    // Pre-fetch Kore Util actions (workflow_utils, category='kore-data') for
    // the dropdown_kore_util settings panel. getUtilStepsByCategory (from
    // wf-utilsteps.js, merged into plugins-front.js) never rejects -
    // fetchUtilSteps() catches its own errors and resolves to [].
    getUtilStepsByCategory('kore-data').then(utils => {
        availableKoreUtils = utils || [];
        console.log('[Kore Util] Loaded:', availableKoreUtils.map(u => u.action_name));
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
    const settingsForm = document.getElementById('settingsForm');
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
        fieldConfig.options = [{ label: 'option1', value: 'value1' }, { label: 'option2', value: 'value2' }];
    }
    const normalizedOptions = normalizeOptionsToArray(fieldConfig.options);
    
    let optionsHTML = `
        <div style="margin-bottom: 15px; min-width: 0;">
            <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 8px; min-width: 0;">
                <div style="flex: 1; min-width: 0;">
                    <label style="color: #ffffff; font-weight: 600; font-size: 14px; margin: 0 0 8px 0; display: block;">Options</label>
                    <div style="display: flex; gap: 8px; margin-bottom: 8px; min-width: 0;">
                        <div style="flex: 1; min-width: 0; color: #999; font-size: 12px; font-weight: 600;">Label</div>
                        <div style="flex: 1; min-width: 0; color: #999; font-size: 12px; font-weight: 600;">Value</div>
                    </div>
                </div>
                <button id="addRadioOptionBtn" style="flex-shrink: 0; padding: 8px 12px; background: #2a7da8; border: none; border-radius: 4px; color: #ffffff; cursor: pointer; font-weight: 600;">+</button>
            </div>
            <div id="radioOptionsList" style="display: flex; flex-direction: column; gap: 8px; min-width: 0;">
    `;
    
    // Add existing options
    normalizedOptions.forEach(({ label, value }) => {
        optionsHTML += `
            <div class="radio-option-row" data-key="${label}" style="display: flex; gap: 8px; align-items: center; min-width: 0;">
                <input type="text" class="radio-option-label" value="${label}" placeholder="Label" style="flex: 1; min-width: 0; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; box-sizing: border-box;">
                <input type="text" class="radio-option-value" value="${value}" placeholder="Value" style="flex: 1; min-width: 0; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; box-sizing: border-box;">
                <button class="delete-radio-option-btn" style="flex-shrink: 0; padding: 6px 10px; background: #a82a2a; border: none; border-radius: 4px; color: #ffffff; cursor: pointer;">⊘</button>
            </div>
        `;
    });
    
    optionsHTML += `
            </div>
        </div>
        <div style="margin-bottom: 15px;">
            <label style="color: #ffffff; font-weight: 600; font-size: 14px; margin: 0 0 8px 0; display: block;">Default Select</label>
            <select id="default_select" style="width: 100%;">
                <option value="">-- None --</option>
    `;
    
    normalizedOptions.forEach(({ label }) => {
        const isSelected = fieldConfig.default_select === label ? 'selected' : '';
        optionsHTML += `<option value="${label}" ${isSelected}>${label}</option>`;
    });
    
    optionsHTML += `
            </select>
        </div>
    `;
    
    div.innerHTML = optionsHTML;
    
    // Insert into settings form
    const settingsForm = document.getElementById('settingsForm');
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
            
            fieldConfig.options.push({ label: newKey, value: '' });
            
            const newRow = document.createElement('div');
            newRow.className = 'radio-option-row';
            newRow.style.cssText = 'display: flex; gap: 8px; align-items: center; min-width: 0;';
            newRow.innerHTML = `
                <input type="text" class="radio-option-label" value="${newKey}" placeholder="Label" style="flex: 1; min-width: 0; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; box-sizing: border-box;">
                <input type="text" class="radio-option-value" value="" placeholder="Value" style="flex: 1; min-width: 0; padding: 8px; background: #1a3540; border: 1px solid #555; border-radius: 4px; color: #ffffff; font-size: 13px; box-sizing: border-box;">
                <button class="delete-radio-option-btn" style="flex-shrink: 0; padding: 6px 10px; background: #a82a2a; border: none; border-radius: 4px; color: #ffffff; cursor: pointer;">⊘</button>
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

/**
 * Wire up one radio option row's inline editing - each edit mutates
 * fieldConfig.options directly (in addition to the full rebuild
 * saveSettingsBtn does at actual save time), matching the live-editing
 * behavior this already had before options became an array.
 *
 * Tracks which entry a row corresponds to by its live position among its
 * sibling rows (getRowIndex), recomputed fresh on every interaction -
 * rather than a label/key the row had when listeners were first attached.
 * This is simpler and more robust than key-based tracking: a row's DOM
 * position doesn't change on rename, and correctly reflects an earlier
 * row's deletion shifting later rows' indices, with no separate rename-
 * tracking state needed.
 * @param {HTMLElement} row
 * @param {object} fieldConfig
 * @param {HTMLElement} defaultSelect
 */
function attachRadioOptionListeners(row, fieldConfig, defaultSelect) {
    const labelInput = row.querySelector('.radio-option-label');
    const valueInput = row.querySelector('.radio-option-value');
    const deleteBtn = row.querySelector('.delete-radio-option-btn');

    function getRowIndex() {
        return Array.from(row.parentElement.children).indexOf(row);
    }
    
    if (labelInput) {
        labelInput.addEventListener('input', () => {
            const entry = fieldConfig.options[getRowIndex()];
            if (entry) {
                entry.label = labelInput.value;
                updateRadioDefaultSelect(fieldConfig, defaultSelect);
            }
            showElementSettingsDirty();
        });
    }
    
    if (valueInput) {
        valueInput.addEventListener('input', () => {
            const entry = fieldConfig.options[getRowIndex()];
            if (entry) entry.value = valueInput.value;
            showElementSettingsDirty();
        });
    }
    
    if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            fieldConfig.options.splice(getRowIndex(), 1);
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
    
    normalizeOptionsToArray(fieldConfig.options).forEach(({ label }) => {
        const isSelected = currentValue === label ? 'selected' : '';
        defaultSelect.appendChild(new Option(label, label, false, isSelected === 'selected'));
    });
}

// Initialize on page load
console.log('Form Builder initialized');
// ============================================================================
// EXPORTS TO WINDOW
// ============================================================================
window.attachDataRetrievalListeners = attachDataRetrievalListeners;
window.attachDeleteArrayItemModalListener = attachDeleteArrayItemModalListener;
window.attachDropdownPluginListeners = attachDropdownPluginListeners;
window.attachDropdownPrefetchListeners = attachDropdownPrefetchListeners;
window.attachDropdownSqlListeners = attachDropdownSqlListeners;
window.attachDropdownStaticListeners = attachDropdownStaticListeners;
window.attachDropdownTreeListeners = attachDropdownTreeListeners;
window.attachDropdownWorkflowListeners = attachDropdownWorkflowListeners;
window.attachElementEventListeners = attachElementEventListeners;
window.attachRadioOptionListeners = attachRadioOptionListeners;
window.attachSettingsFieldListeners = attachSettingsFieldListeners;
window.buildArrayFields = buildArrayFields;
window.buildCheckboxFields = buildCheckboxFields;
window.buildCommonFields = buildCommonFields;
window.buildConditionsFields = buildConditionsFields;
window.buildDataRetrievalFields = buildDataRetrievalFields;
window.buildDateTimeFields = buildDateTimeFields;
window.buildDependentFieldsButton = buildDependentFieldsButton;
window.buildDropdownBasicFields = buildDropdownBasicFields;
window.buildDropdownPrefetchFields = buildDropdownPrefetchFields;
window.buildDropdownSqlFields = buildDropdownSqlFields;
window.buildDropdownStaticFields = buildDropdownStaticFields;
window.buildDropdownTypeSelector = buildDropdownTypeSelector;
window.buildEditArrayButton = buildEditArrayButton;
window.buildElementSettingsPanel = buildElementSettingsPanel;
window.buildFormConfig = buildFormConfig;
window.buildFormExtendFields = buildFormExtendFields;
window.buildFormExtendSelector = buildFormExtendSelector;
window.buildHorizontalLineFields = buildHorizontalLineFields;
window.buildHtmlContentField = buildHtmlContentField;
window.buildHtmlFields = buildHtmlFields;
window.buildKoreUtilSelector = buildKoreUtilSelector;
window.buildKoreUtilTaskSection = buildKoreUtilTaskSection;
window.buildPluginSelector = buildPluginSelector;
window.buildPluginTaskSection = buildPluginTaskSection;
window.buildRadioFields = buildRadioFields;
window.buildRadioOptions = buildRadioOptions;
window.buildSQLSelector = buildSQLSelector;
window.buildTextFields = buildTextFields;
window.buildTextareaFields = buildTextareaFields;
window.buildWorkflowInputs = buildWorkflowInputs;
window.buildWorkflowOutputs = buildWorkflowOutputs;
window.buildWorkflowTriggerSelector = buildWorkflowTriggerSelector;
window.buildWorkflowSelector = buildWorkflowSelector;
window.closeArrayItemsModal = closeArrayItemsModal;
window.closeDependentFieldsModal = closeDependentFieldsModal;
window.closeElementSettings = closeElementSettings;
window.createFieldConfig = createFieldConfig;
window.createFormElementVisual = createFormElementVisual;
window.fetchExistingFormsList = fetchExistingFormsList;
window.fetchPluginTasks = fetchPluginTasks;
window.fetchResolvedTaskDetails = fetchResolvedTaskDetails;
window.generateElementUid = generateElementUid;
window.getConfigValue = getConfigValue;
window.getOrCreateHiddenField = getOrCreateHiddenField;
window.handleElementMove = handleElementMove;
window.handleImportFormJSON = handleImportFormJSON;
window.handleNewElementDrop = handleNewElementDrop;
window.initializeArrayItemsModal = initializeArrayItemsModal;
window.initializeDependentFieldsModal = initializeDependentFieldsModal;
window.initializeDragAndDrop = initializeDragAndDrop;
window.initializeElementPalette = initializeElementPalette;
window.initializeFormLayout = initializeFormLayout;
window.loadAvailableWorkflows = loadAvailableWorkflows;
window.loadFormConfiguration = loadFormConfiguration;
window.loadSqlDatasources = loadSqlDatasources;
window.markFormChanged = markFormChanged;
window.moveArrayItem = moveArrayItem;
window.moveElementsToColumn = moveElementsToColumn;
window.normalizeTaskInputOptions = normalizeTaskInputOptions;
window.openArrayItemsModal = openArrayItemsModal;
window.openDependentFieldsModal = openDependentFieldsModal;
window.openEditArrayModal = openEditArrayModal;
window.performFormLoad = performFormLoad;
window.populateWorkflowOutputs = populateWorkflowOutputs;
window.populateWorkflowTriggers = populateWorkflowTriggers;
window.renderAndWireTaskFields = renderAndWireTaskFields;
window.renderArrayItemConfig = renderArrayItemConfig;
window.renderArrayItemRow = renderArrayItemRow;
window.renderArrayItemValueField = renderArrayItemValueField;
window.renderArrayItemWorkflowInputs = renderArrayItemWorkflowInputs;
window.renderDataRetrievalWorkflowFields = renderDataRetrievalWorkflowFields;
window.renderField = renderField;
window.renderNestedArrayItemRow = renderNestedArrayItemRow;
window.renderSections = renderSections;
window.renderTaskInputsHtml = renderTaskInputsHtml;
window.renderWorkflowInputFields = renderWorkflowInputFields;
window.saveArrayItems = saveArrayItems;
window.saveDependentFields = saveDependentFields;
window.saveFormToDatabase = saveFormToDatabase;
window.saveTypeSpecificFields = saveTypeSpecificFields;
window.setSpanningZonesVisible = setSpanningZonesVisible;
window.setupDropZoneHandlers = setupDropZoneHandlers;
window.setupPaletteDragHandlers = setupPaletteDragHandlers;
window.showImportFormJSONModal = showImportFormJSONModal;
window.showElementSettings = showElementSettings;
window.showElementSettingsDirty = showElementSettingsDirty;
window.showFormSettingsModal = showFormSettingsModal;
window.updateArrayItemButtonStates = updateArrayItemButtonStates;
window.updateColumnDisplay = updateColumnDisplay;
window.updateDefaultValueOptions = updateDefaultValueOptions;
window.updateElementSequences = updateElementSequences;
window.updateRadioDefaultSelect = updateRadioDefaultSelect;
window.updateSaveButtonState = updateSaveButtonState;
window.updateVertSepCheckboxState = updateVertSepCheckboxState;