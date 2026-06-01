/**
 * wf-variables.js
 * 
 * Variable detection, context building, and variable UI management
 * - Type inference from values (JSON, Jinja, primitives)
 * - Graph traversal for reachable steps
 * - Variable context aggregation
 * - Variable list rendering and editing
 */

        // ============================================================================
        // Workflow variable state (shared with workflow-edit.js)
        // ============================================================================
        let currentInputVariables = [];
        let currentOutputVariables = [];
        
        // Working copies used by modals (set when modal opens, cleared when closed)
        let workingInputVariables = null;
        let workingOutputVariables = null;

        function detectVariableType(value) {
          if (!value || typeof value !== 'string') {
            return 'jinja';
          }

          const trimmed = value.trim();

          // Check for empty
          if (trimmed === '') {
            return 'string';
          }

          // ============================================================================
          // 1. Try JSON detection first (hardcoded JSON)
          // ============================================================================
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              return 'array';
            } else if (typeof parsed === 'object' && parsed !== null) {
              return 'object';
            } else if (typeof parsed === 'boolean') {
              return 'boolean';
            } else if (typeof parsed === 'number') {
              return Number.isInteger(parsed) ? 'integer' : 'float';
            } else if (typeof parsed === 'string') {
              return 'string';
            }
          } catch (e) {
            // Not JSON, continue
          }

          // ============================================================================
          // 2. Try detecting single values (raw or Jinja-wrapped)
          // ============================================================================
          const singleValueType = detectSingleValueType(trimmed);
          if (singleValueType) {
            return singleValueType;
          }

          // ============================================================================
          // 3. Try Jinja object/array detection
          // ============================================================================
          const jinjaObjectType = detectJinjaObjectOrArray(trimmed);
          if (jinjaObjectType) {
            return jinjaObjectType;
          }

          // ============================================================================
          // 4. Check if it contains Jinja syntax
          // ============================================================================
          if (trimmed.includes('{{') || trimmed.includes('{%')) {
            return 'jinja';
          }

          // ============================================================================
          // 5. Default to string for any other raw value
          // ============================================================================
          return 'string';
        }

        /**
         * Detect single value types (raw or Jinja-wrapped)
         * Returns the type if detected, null otherwise
         */
        function detectSingleValueType(value) {
          const trimmed = value.trim();

          // ====== Raw values (no braces) ======

          // Boolean literals
          if (trimmed === 'true' || trimmed === 'false') {
            return 'boolean';
          }

          // Quoted strings
          if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
              (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            return 'string';
          }

          // Numeric values
          if (!isNaN(trimmed) && trimmed !== '') {
            return Number.isInteger(parseFloat(trimmed)) ? 'integer' : 'float';
          }

          // ====== Jinja-wrapped values {{ ... }} ======
          const jinjaMatch = trimmed.match(/^\{\{-?\s*(.*?)\s*-?\}\}$/);
          if (jinjaMatch) {
            const innerContent = jinjaMatch[1].trim();
            return detectSingleValueType(innerContent);  // Recursive
          }

          // ====== If/else conditionals ======
          const ifElseType = detectIfElseType(trimmed);
          if (ifElseType) {
            return ifElseType;
          }

          return null;
        }

        /**
         * Detect type from if/else conditionals
         */
        function detectIfElseType(value) {
          // Simple pattern: {% if ... %} content1 {% else %} content2 {% endif %}
          const ifElsePattern = /^\{%-?\s*if\s+.*?-?%\}([\s\S]*?)\{%-?\s*else\s*-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}$/;
          const match = value.match(ifElsePattern);

          if (match) {
            const ifBranch = match[1].trim();
            const elseBranch = match[2].trim();

            const ifType = detectSingleValueType(ifBranch);
            const elseType = detectSingleValueType(elseBranch);

            // Both branches resolve to same type
            if (ifType && elseType && ifType === elseType) {
              return ifType;
            }
          }

          // Multi-branch: {% if ... %} {% elif ... %} {% else %} {% endif %}
          const multiIfPattern = /^\{%-?\s*if\s+.*?-?%\}([\s\S]*?)(?:\{%-?\s*elif\s+.*?-?%\}([\s\S]*?))*\{%-?\s*else\s*-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}$/;
          const multiMatch = value.match(multiIfPattern);

          if (multiMatch) {
            const branches = [];
            for (let i = 1; i < multiMatch.length; i++) {
              if (multiMatch[i]) {
                branches.push(multiMatch[i].trim());
              }
            }

            const types = branches.map(b => detectSingleValueType(b)).filter(t => t !== null);
            
            // All branches resolve to same type
            if (types.length === branches.length && types.every(t => t === types[0])) {
              return types[0];
            }
          }

          return null;
        }

        /**
         * Detect Jinja object or array literals
         * Returns 'object', 'array', or null
         */
        function detectJinjaObjectOrArray(value) {
          const trimmed = value.trim();

          // Extract from {{ ... }}
          let contentToCheck = trimmed;
          const jinjaMatch = trimmed.match(/^\{\{-?\s*(.*?)\s*-?\}\}$/);
          if (jinjaMatch) {
            contentToCheck = jinjaMatch[1].trim();
          }

          // Check if it's a JSON-like object literal
          if (contentToCheck.startsWith('{') && contentToCheck.endsWith('}')) {
            try {
              // Try to validate it's JSON-like
              JSON.parse(contentToCheck);
              return 'object';
            } catch (e) {
              // Might be a Jinja dict with variable references, still treat as object
              if (contentToCheck.includes(':') && contentToCheck.includes(',')) {
                return 'object';
              }
            }
          }

          // Check if it's a JSON-like array literal
          if (contentToCheck.startsWith('[') && contentToCheck.endsWith(']')) {
            try {
              JSON.parse(contentToCheck);
              return 'array';
            } catch (e) {
              // Might be a Jinja list with variable references, still treat as array
              if (contentToCheck.includes(',') || contentToCheck.includes('[')) {
                return 'array';
              }
            }
          }

          return null;
        }

        // ============================================================================
        // END UPDATED VARIABLE TYPE DETECTION
        // ============================================================================

        /**
         * Find all steps that can reach a target step (reverse graph traversal)
         */
        function getReachableSteps(targetStepId, steps, transitions) {
          
          const reachable = new Set();
          const visited = new Set();

          function findPredecessors(stepId) {
            if (visited.has(stepId)) {
              return;
            }
            visited.add(stepId);

            // Find transitions where this step is in targetSteps
            transitions.forEach(transition => {
              if (transition.targetSteps && transition.targetSteps.includes(stepId)) {
                const sourceStepId = transition.parentStepId;
                if (sourceStepId && !reachable.has(sourceStepId)) {
                  reachable.add(sourceStepId);
                  findPredecessors(sourceStepId);
                }
              }
            });
          }

          findPredecessors(targetStepId);
          return Array.from(reachable);
        }

        /**
         * Find the BEGIN step
         */
        function findBeginStep(steps) {
          return steps.find(s => s.type === 'Begin') || null;
        }

        /**
         * Build variable context for a specific step (all accessible variables)
         */
        function getVariableContextForStep(stepId, definition, transitions) {
          
          const variables = {};

          if (!definition || !definition.steps || !transitions) {
            return variables;
          }

          
          // 1. Add Input Variables
          if (definition.inputVariables && Array.isArray(definition.inputVariables)) {
            definition.inputVariables.forEach(v => {
              if (v.name) {
                variables[v.name] = {
                  value: v.type || '',
                  source: 'Input Variable',
                  type: detectVariableType(v.type)
                };
              }
            });
          }

          // 2. Add BEGIN step outputs
          const beginStep = findBeginStep(definition.steps);
          if (beginStep) {
            if (beginStep.variables && Array.isArray(beginStep.variables)) {
              beginStep.variables.forEach(v => {
                if (v.name) {
                  variables[v.name] = {
                    value: v.value || '',
                    source: 'Step BEGIN',
                    type: detectVariableType(v.value)
                  };
                }
              });
            }
          }

          // 3. Add reachable steps' outputs
          const reachableStepIds = getReachableSteps(stepId, definition.steps, transitions);
          
          reachableStepIds.forEach(reachableId => {
            const step = definition.steps.find(s => s.id === reachableId);
            if (step && step.variables && Array.isArray(step.variables)) {
              step.variables.forEach(v => {
                if (v.name) {
                  variables[v.name] = {
                    value: v.value || '',
                    source: `Step ${step.label || step.id}`,
                    type: detectVariableType(v.value)
                  };
                }
              });
            }
          });

          return variables;
        }

        /**
         * Get flattened, sorted list of available variables for Reference Panel
         */
        function getAvailableVariables(stepId, definition, transitions) {
          const context = getVariableContextForStep(stepId, definition, transitions);
          
          return Object.entries(context)
            .map(([name, data]) => ({
              name,
              ...data
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        }

        function rebuildInputVariablesFromForm() {
            // Placeholder - rebuilds input variables from form if needed
            // Currently a no-op as variables are managed by the application
        }

        function rebuildOutputVariablesFromForm() {
            // Placeholder - rebuilds output variables from form if needed
            // Currently a no-op as variables are managed by the application
        }


        /**
         * Universal variable list renderer for input, output, step, and case variables
         * @param {string} containerId - ID of container element to render into
         * @param {array} dataArray - Reference to the variable array (currentInputVariables, currentOutputVariables, etc)
         * @param {string} variableType - Type: 'input', 'output', 'step', or 'case'
         * @param {function} onUpdateCallback - Called after changes (e.g., updatePreview)
         * @param {object} options - Optional: {compactMode: bool, editFieldName: 'value'}
         */

        /**
         * Universal variable editor (opens Jinja modal)
         * @param {number} index - Index in the variable array
         * @param {string} variableType - Type: 'input', 'output', 'step', or 'case'
         * @param {string} fieldName - Field to edit: 'value' or other
         */
        function editVariable(index, variableType, fieldName = 'value') {
            const arrayMap = {
                'input': currentInputVariables,
                'output': currentOutputVariables,
                'step': currentStepBeingEdited?.variables || [],
                'case': currentTransitionBeingEdited?.conditions || []
            };
            
            const dataArray = arrayMap[variableType];
            if (!dataArray || !dataArray[index]) return;
            
            const variable = dataArray[index];
            const typeLabel = variableType.charAt(0).toUpperCase() + variableType.slice(1);
            
            openJinjaEditorModal(
                `Edit ${typeLabel} Variable: ${variable.name || 'Variable'}`,
                variable[fieldName] || '',
                (value) => {
                    dataArray[index][fieldName] = value;
                    
                    // Re-render the appropriate list
                    if (variableType === 'input') {
                        renderVariablesList('inputVariablesList', currentInputVariables, 'input', updatePreview);
                    } else if (variableType === 'output') {
                        renderVariablesList('outputVariablesList', currentOutputVariables, 'output', updatePreview);
                    } else if (variableType === 'step') {
                        showStepProperties(currentStepBeingEdited?.id);
                    } else if (variableType === 'case') {
                        // TODO: Re-render case variables when case editor is built
                    }
                    updatePreview();
                }
            );
        }

        /**
         * Universal variable adder
         * @param {string} variableType - Type: 'input', 'output', 'step', or 'case'
         * @param {string} containerId - ID of container element to re-render
         */
        function addVariable(variableType, containerId) {
            // Use working variables if in a modal, otherwise use current variables
            const arrayMap = {
                'input': workingInputVariables !== null ? workingInputVariables : currentInputVariables,
                'output': workingOutputVariables !== null ? workingOutputVariables : currentOutputVariables,
                'step': currentStepBeingEdited?.variables || [],
                'case': currentTransitionBeingEdited?.conditions || []
            };
            
            const dataArray = arrayMap[variableType];
            if (!dataArray) {
                return;
            }
            
            dataArray.push({ name: '', value: '' });
            
            // Find the container element and use renderVariablesInContainer
            const containerElement = document.getElementById(containerId);
            if (containerElement) {
                renderVariablesInContainer(containerElement, dataArray, variableType, updatePreview);
            }
        }

        /**
         * Handle variable field changes (name/value)
         * Used by onchange handlers in rendered variable lists
         */
        function handleVariableFieldChange(variableType, index, fieldName, newValue, containerId) {
            const arrayMap = {
                'input': currentInputVariables,
                'output': currentOutputVariables,
                'step': currentStepBeingEdited?.variables || [],
                'case': currentTransitionBeingEdited?.conditions || []
            };
            
            const dataArray = arrayMap[variableType];
            if (dataArray && dataArray[index]) {
                dataArray[index][fieldName] = newValue;
                updatePreview();
            }
        }

        /**
         * Render Input/Output Variables sections in Workflow Settings modal
         * Handles section creation, rendering, and button event listeners
         * @param {HTMLElement} modal - The modal container
         * @param {Array} inputVariables - The input variables array
         * @param {Array} outputVariables - The output variables array
         * @param {Function} onUpdate - Callback when variables change
         */
        function renderWorkflowVariablesSection(modal, inputVariables, outputVariables, onUpdate) {
            if (!modal) return;

            // Remove any existing empty containers created by the form system
            const existingContainers = document.querySelectorAll('#inputVariablesList, #outputVariablesList');
            existingContainers.forEach(container => {
                if (container.children.length === 0) {
                    console.log('Removing empty container:', container.id);
                    container.remove();
                }
            });

            // Create list containers as direct element references (not via innerHTML)
            const inputListContainer = document.createElement('div');
            inputListContainer.id = 'inputVariablesList';
            inputListContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px;';

            const outputListContainer = document.createElement('div');
            outputListContainer.id = 'outputVariablesList';
            outputListContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px;';

            // Create Input Variables section (separators handled by caller)
            const inputSection = document.createElement('div');
            inputSection.style.cssText = '';
            
            const inputHeader = document.createElement('div');
            inputHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
            
            const inputLabel = document.createElement('label');
            inputLabel.textContent = 'Input Variables';
            inputLabel.style.cssText = 'color: var(--text-muted); font-size: 0.85rem; font-weight: 600; margin: 0;';
            
            const inputButton = document.createElement('button');
            inputButton.id = 'addInputVarBtn';
            inputButton.type = 'button';
            inputButton.className = 'btn';
            inputButton.setAttribute('data-color', 'green');
            inputButton.setAttribute('data-size', 'sm');
            inputButton.textContent = '+ Add Input Variable';
            
            inputHeader.appendChild(inputLabel);
            inputHeader.appendChild(inputButton);
            
            inputSection.appendChild(inputHeader);
            inputSection.appendChild(inputListContainer);

            // Create Output Variables section (separators handled by caller)
            const outputSection = document.createElement('div');
            outputSection.style.cssText = '';
            
            const outputHeader = document.createElement('div');
            outputHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
            
            const outputLabel = document.createElement('label');
            outputLabel.textContent = 'Output Variables';
            outputLabel.style.cssText = 'color: var(--text-muted); font-size: 0.85rem; font-weight: 600; margin: 0;';
            
            const outputButton = document.createElement('button');
            outputButton.id = 'addOutputVarBtn';
            outputButton.type = 'button';
            outputButton.className = 'btn';
            outputButton.setAttribute('data-color', 'green');
            outputButton.setAttribute('data-size', 'sm');
            outputButton.textContent = '+ Add Output Variable';
            
            outputHeader.appendChild(outputLabel);
            outputHeader.appendChild(outputButton);
            
            outputSection.appendChild(outputHeader);
            outputSection.appendChild(outputListContainer);

            // Inject into modal-body-content, after the Description field
            const bodyContent = modal.querySelector('#modal-body-content');
            if (bodyContent) {
                const flexContainer = bodyContent.querySelector('div[style*="display: flex"]');
                if (flexContainer) {
                    const descriptionWrapper = flexContainer.querySelector('#field_wrapper_workflowDescription');
                    if (descriptionWrapper) {
                        // Create separators
                        const inputSeparator = document.createElement('div');
                        inputSeparator.style.cssText = 'border-top: 1px solid var(--border-primary); margin: 20px 0 16px 0;';
                        
                        const outputSeparator = document.createElement('div');
                        outputSeparator.style.cssText = 'border-top: 1px solid var(--border-primary); margin: 20px 0 16px 0;';
                        
                        // Insert separators and sections
                        descriptionWrapper.parentNode.insertBefore(inputSeparator, descriptionWrapper.nextSibling);
                        descriptionWrapper.parentNode.insertBefore(inputSection, inputSeparator.nextSibling);
                        descriptionWrapper.parentNode.insertBefore(outputSeparator, inputSection.nextSibling);
                        descriptionWrapper.parentNode.insertBefore(outputSection, outputSeparator.nextSibling);
                    } else {
                        flexContainer.appendChild(inputSection);
                        flexContainer.appendChild(outputSection);
                    }
                } else {
                    bodyContent.appendChild(inputSection);
                    bodyContent.appendChild(outputSection);
                }
            }

            // Set working variables so addVariable uses the modal copies
            workingInputVariables = inputVariables;
            workingOutputVariables = outputVariables;
            
            // Render variable lists using the direct element references
            console.log('About to render variable lists');
            console.log('inputListContainer:', inputListContainer);
            console.log('outputListContainer:', outputListContainer);
            
            renderVariablesInContainer(inputListContainer, inputVariables, 'input', onUpdate);
            renderVariablesInContainer(outputListContainer, outputVariables, 'output', onUpdate);

            // Attach event listeners to Add buttons
            const attachButtonListeners = () => {
                const addInputBtn = document.getElementById('addInputVarBtn');
                const addOutputBtn = document.getElementById('addOutputVarBtn');

                if (addInputBtn) {
                    addInputBtn.onclick = (e) => {
                        e.preventDefault();
                        addVariable('input', 'inputVariablesList');
                    };
                }

                if (addOutputBtn) {
                    addOutputBtn.onclick = (e) => {
                        e.preventDefault();
                        addVariable('output', 'outputVariablesList');
                    };
                }
            };

            attachButtonListeners();
            setTimeout(attachButtonListeners, 50);
        }

        /**
         * Render variables directly into a provided container element
         */
        function renderVariablesInContainer(containerElement, dataArray, variableType, onUpdateCallback, options = {}) {
            if (!containerElement) {
                return;
            }
            
            containerElement.innerHTML = '';
            const { compactMode = false, editFieldName = 'value' } = options;
            const gapSize = compactMode ? '6px' : '8px';
            const paddingSize = compactMode ? '4px' : '6px';
            const marginSize = compactMode ? '2px' : '4px';
            
            dataArray.forEach((variable, index) => {
                const item = document.createElement('div');
                item.style.cssText = `display: grid; grid-template-columns: 1fr 1fr auto auto; gap: ${gapSize}; margin-bottom: ${marginSize}; align-items: center;`;
                item.innerHTML = `
                    <input type="text" value="${variable.name || ''}" placeholder="Name" 
                        class="form-field-input" style="padding: ${paddingSize}; font-size: 0.85rem; min-width: 0; box-sizing: border-box; height: 32px; min-height: 32px;"
                        data-var-type="${variableType}" data-var-idx="${index}" data-var-field="name"
                        onchange="handleVariableFieldChange('${variableType}', ${index}, 'name', this.value, '${containerElement.id}');">
                    <input type="text" value="${variable.value || ''}" placeholder="Value"
                        class="form-field-input" style="padding: ${paddingSize}; font-size: 0.85rem; min-width: 0; box-sizing: border-box; height: 32px; min-height: 32px;"
                        data-var-type="${variableType}" data-var-idx="${index}" data-var-field="value"
                        onchange="handleVariableFieldChange('${variableType}', ${index}, 'value', this.value, '${containerElement.id}');">
                    <button class="btn var-edit-btn" data-var-type="${variableType}" data-size="sm" data-color="blue" data-var-idx="${index}" title="Edit variable" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 16px;">&#9998;</button>
                    <button class="btn var-delete-btn" data-var-type="${variableType}" data-size="sm" data-color="red" data-var-idx="${index}" title="Delete variable" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 16px;">🗑</button>
                `;
                containerElement.appendChild(item);
            });
            
            // Attach event listeners for edit buttons
            containerElement.querySelectorAll(`.var-edit-btn[data-var-type="${variableType}"]`).forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.getAttribute('data-var-idx'));
                    editVariable(idx, variableType, editFieldName);
                });
            });

            // Attach event listeners for delete buttons
            containerElement.querySelectorAll(`.var-delete-btn[data-var-type="${variableType}"]`).forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.getAttribute('data-var-idx'));
                    showDeleteConfirm('Delete this variable?', () => {
                        dataArray.splice(idx, 1);
                        renderVariablesInContainer(containerElement, dataArray, variableType, onUpdateCallback, options);
                        if (onUpdateCallback) onUpdateCallback();
                    });
                });
            });
        }