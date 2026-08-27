import '/lib/wf-canvas.js';
import '/lib/wf-exec.js';
import '/lib/wf-render.js';
import '/lib/wf-canvas.js';
import '/lib/wf-variables.js';
import '/lib/jinja-json.js';


// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Deep equality check for objects
 */
function deepEqual(obj1, obj2) {
    if (obj1 === obj2) return true;
    if (obj1 == null || obj2 == null) return obj1 === obj2;
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object') return obj1 === obj2;
    
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    if (keys1.length !== keys2.length) return false;
    
    for (const key of keys1) {
        if (!keys2.includes(key)) return false;
        if (!deepEqual(obj1[key], obj2[key])) return false;
    }
    
    return true;
}


let currentWorkflowId = null;
let currentWorkflowName = null;
let currentVersion = null;
let currentMetadata = null;
let currentDefinition = null;
let originalData = null;
let originalJson = null;
let originalDefinition = null;
let allVersions = [];
let currentSteps = [];
let currentTransitions = [];
let currentTransitionFrames = [];
let currentInputVariables = [];
let currentOutputVariables = [];
let currentTriggers = [];

let currentNodes = [];
let currentStepBeingEdited = null;  // Track step for variable editing
let currentTransitionBeingEdited = null;  // Track transition for case variable editing
let transitionCounter = 0;
let transitionFrameCounter = 0;

// Dedicated field for the HTML that auto-pops as a modal in Execution
// Details when the workflow finishes. Deliberately NOT part of
// currentOutputVariables - it's not a data contract for callers/parent
// workflows the way a regular Output Variable is, just a presentation
// artifact for a human watching the run, so it's stored/edited separately
// and (on the backend) never exposed to a parent workflow when this one
// runs as a sub-workflow.
let currentOutputHtml = '';
let toolsPanelCollapsed = true;

// ============================================================================
// WORKFLOW CONNECTIVITY VALIDATION
// ============================================================================

/**
 * Validate workflow connectivity - all steps/nodes must have inbound connections
 * Exception: BEGIN step doesn't need an inbound connection
 * @returns {Object} { isValid: boolean, unreachableSteps: Array, unreachableNodes: Array }
 */
function validateWorkflowConnectivity() {
    const unreachableSteps = [];
    const unreachableNodes = [];
    
    // Check each step
    currentSteps.forEach(step => {
        // BEGIN step is always valid
        if (step.type === 'Begin') return;
        
        // Check if this step has any inbound connections
        let hasInbound = false;
        
        // Check from other steps
        currentSteps.forEach(sourceStep => {
            if (sourceStep.transition && sourceStep.transition.cases) {
                sourceStep.transition.cases.forEach(caseObj => {
                    if (caseObj.targetSteps && caseObj.targetSteps.includes(step.id)) {
                        hasInbound = true;
                    }
                });
            }
        });
        
        // Check from nodes
        if (!hasInbound) {
            currentNodes.forEach(sourceNode => {
                if (sourceNode.targetSteps && sourceNode.targetSteps.includes(step.id)) {
                    hasInbound = true;
                }
            });
        }
        
        if (!hasInbound) {
            unreachableSteps.push(step);
        }
    });
    
    // Check each node
    currentNodes.forEach(node => {
        // Check if this node has any inbound connections
        let hasInbound = false;
        
        // Check from steps
        currentSteps.forEach(sourceStep => {
            if (sourceStep.transition && sourceStep.transition.cases) {
                sourceStep.transition.cases.forEach(caseObj => {
                    if (caseObj.targetNodes && caseObj.targetNodes.includes(node.id)) {
                        hasInbound = true;
                    }
                });
            }
        });
        
        // Check from other nodes
        if (!hasInbound) {
            currentNodes.forEach(sourceNode => {
                if (sourceNode.targetNodes && sourceNode.targetNodes.includes(node.id)) {
                    hasInbound = true;
                }
            });
        }
        
        if (!hasInbound) {
            unreachableNodes.push(node);
        }
    });
    
    return {
        isValid: unreachableSteps.length === 0 && unreachableNodes.length === 0,
        unreachableSteps: unreachableSteps,
        unreachableNodes: unreachableNodes
    };
}

/**
 * Highlight unreachable steps and nodes with red border
 */
function updateConnectivityBanner(unreachableSteps, unreachableNodes) {
    const allUnreachable = [...unreachableSteps, ...unreachableNodes];
    if (allUnreachable.length === 0) {
        hideStatusBanner('statusMessage');
        return;
    }
    
    const itemNames = allUnreachable.map(item => item.name || item.id).join(', ');
    const message = `${itemNames} not connected to BEGIN`;
    showStatusBanner(message, 'error', 'statusMessage', 999999999);
}

/**
 * Check if currently invalid steps/nodes are now valid (only checks flagged items)
 * Called on connection changes to provide targeted feedback
 */
function recheckFlaggedSteps() {
    const flaggedElements = document.querySelectorAll('[data-step-uuid].invalid, [data-node-id].invalid');
    if (flaggedElements.length === 0) return; // No flagged items, nothing to check
    
    // Check each flagged item - if it now has an inbound connection, remove flag
    flaggedElements.forEach(el => {
        const stepUuid = el.getAttribute('data-step-uuid');
        const nodeId = el.getAttribute('data-node-id');
        let hasInbound = false;
        
        if (stepUuid) {
            // Check if this step now has inbound connections
            // From other steps (via step.transition.cases)
            currentSteps.forEach(sourceStep => {
                if (sourceStep.transition && sourceStep.transition.cases) {
                    sourceStep.transition.cases.forEach(caseObj => {
                        if (caseObj.targetSteps && caseObj.targetSteps.includes(stepUuid)) {
                            hasInbound = true;
                        }
                    });
                }
            });
            
            // From nodes (via step.transition.cases)
            if (!hasInbound) {
                currentNodes.forEach(sourceNode => {
                    if (sourceNode.targetSteps && sourceNode.targetSteps.includes(stepUuid)) {
                        hasInbound = true;
                    }
                });
            }
            
            // Also check currentTransitions for unsynced connections
            if (!hasInbound) {
                currentTransitions.forEach(transition => {
                    if (transition.targetSteps && transition.targetSteps.includes(stepUuid)) {
                        hasInbound = true;
                    }
                });
            }
        } else if (nodeId) {
            // Check if this node now has inbound connections
            // From steps (via step.transition.cases)
            currentSteps.forEach(sourceStep => {
                if (sourceStep.transition && sourceStep.transition.cases) {
                    sourceStep.transition.cases.forEach(caseObj => {
                        if (caseObj.targetNodes && caseObj.targetNodes.includes(nodeId)) {
                            hasInbound = true;
                        }
                    });
                }
            });
            
            // From other nodes
            if (!hasInbound) {
                currentNodes.forEach(sourceNode => {
                    if (sourceNode.targetNodes && sourceNode.targetNodes.includes(nodeId)) {
                        hasInbound = true;
                    }
                });
            }
            
            // Also check currentTransitions for unsynced connections
            if (!hasInbound) {
                currentTransitions.forEach(transition => {
                    if (transition.targetNodes && transition.targetNodes.includes(nodeId)) {
                        hasInbound = true;
                    }
                });
            }
        }
        
        if (hasInbound) {
            el.classList.remove('invalid');
            // Remove red border from nodes
            if (nodeId) {
                el.style.border = 'none';
                el.style.borderRadius = '0px';
            }
        }
    });
    
    // If no more flagged items, clear banner
    if (document.querySelectorAll('[data-step-uuid].invalid, [data-node-id].invalid').length === 0) {
        hideStatusBanner('statusMessage');
    } else {
        // Update banner with remaining invalid items
        const remainingInvalidSteps = currentSteps.filter(s => 
            document.querySelector(`[data-step-uuid="${s.id}"]`)?.classList.contains('invalid')
        );
        const remainingInvalidNodes = currentNodes.filter(n => 
            document.querySelector(`[data-node-id="${n.id}"]`)?.classList.contains('invalid')
        );
        updateConnectivityBanner(remainingInvalidSteps, remainingInvalidNodes);
    }
}

// ============================================================================
// TOOLS PANEL COLLAPSE/EXPAND
// ============================================================================

// ============================================================================
// NODE PLACEMENT TOOL
// ============================================================================

function generateNodeId() { return generateId('node'); }

let isNodePlacementActive = false;
let nodePreview = null;

function initializeNodeTool() {
  const toolNodeBtn = document.getElementById('toolNode');
  const canvas = document.getElementById('workflowCanvas');
  let isDraggingFromButton = false;
  let dragStartX = 0;
  let dragStartY = 0;
  const DRAG_THRESHOLD = 5; // pixels required to activate drag mode
  
  // Handle click to activate single-click placement mode
  toolNodeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Only toggle if we didn't drag
    if (!isDraggingFromButton) {
      if (isNodePlacementActive) {
        // Toggle off
        cancelNodePlacement();
      } else {
        // Toggle on - activate single-click mode
        activateNodePlacementMode();
      }
    }
    isDraggingFromButton = false;
  });
  
  // Handle mousedown for hold-drag placement
  toolNodeBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingFromButton = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    
    const handleDragMove = (moveEvent) => {
      const dx = moveEvent.clientX - dragStartX;
      const dy = moveEvent.clientY - dragStartY;
      
      // Check if drag threshold exceeded
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        isDraggingFromButton = true;
        // Activate single-click mode if not already active
        if (!isNodePlacementActive) {
          activateNodePlacementMode();
        }
      }
    };
    
    const handleDragEnd = (endEvent) => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
      
      // If we were dragging and mouse is over canvas, place node
      if (isDraggingFromButton) {
        const canvasRect = canvas.getBoundingClientRect();
        const isOverCanvas =
          endEvent.clientX >= canvasRect.left && endEvent.clientX <= canvasRect.right &&
          endEvent.clientY >= canvasRect.top && endEvent.clientY <= canvasRect.bottom;

        if (isOverCanvas) {
          const pos = clientToCanvas(endEvent.clientX, endEvent.clientY, canvas);
          placeNode(pos.x, pos.y);
          cancelNodePlacement();
        }
      }
    };
    
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
  });
}

function activateNodePlacementMode() {
  const canvas = document.getElementById('workflowCanvas');
  
  isNodePlacementActive = true;
  
  // Create preview diamond
  nodePreview = document.createElement('div');
  nodePreview.style.cssText = `
    position: fixed;
    width: 30px;
    height: 30px;
    pointer-events: none;
    z-index: 10000;
  `;
  
  // Add filled diamond SVG
//          const diamondSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
//          diamondSvg.setAttribute('width', '30');
//          diamondSvg.setAttribute('height', '30');
//          diamondSvg.setAttribute('viewBox', '0 0 24 24');
//          diamondSvg.innerHTML = `<path d="M12 2 L22 12 L12 22 L2 12 Z" fill="var(--text-primary)" style="opacity: 0.7;"/>`;
//          nodePreview.appendChild(diamondSvg);
//          document.body.appendChild(nodePreview);
const diamondSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
diamondSvg.setAttribute('width', '30');
diamondSvg.setAttribute('height', '30');
diamondSvg.setAttribute('viewBox', '0 0 24 24');

// Use the href attribute to point to the external file and symbol ID
diamondSvg.innerHTML = `<use href="/img/icons.svg#i-node" fill="var(--text-primary)" style="opacity: 0.7;"/>`;

nodePreview.appendChild(diamondSvg);
document.body.appendChild(nodePreview);
  
  // Update preview position on mouse move
  const handleMouseMove = (e) => {
    if (nodePreview && isNodePlacementActive) {
      nodePreview.style.left = (e.clientX - 15) + 'px';
      nodePreview.style.top = (e.clientY - 15) + 'px';
    }
  };
  
  // Handle canvas clicks to place node
  const handleCanvasClick = (e) => {
    if (isNodePlacementActive && nodePreview && e.target === canvas) {
      const pos = clientToCanvas(e.clientX, e.clientY, canvas);
      placeNode(pos.x, pos.y);
      cancelNodePlacement();
    }
  };
  
  // Handle ESC key to cancel
  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && isNodePlacementActive) {
      cancelNodePlacement();
    }
  };
  
  document.addEventListener('mousemove', handleMouseMove);
  canvas.addEventListener('click', handleCanvasClick);
  document.addEventListener('keydown', handleKeyDown);
  
  // Store handlers for cleanup
  const toolNodeBtn = document.getElementById('toolNode');
  toolNodeBtn._nodeToolHandlers = {
    mousemove: handleMouseMove,
    canvasClick: handleCanvasClick,
    keydown: handleKeyDown
  };
}

function cancelNodePlacement() {
  if (nodePreview && nodePreview.parentNode) {
    document.body.removeChild(nodePreview);
    nodePreview = null;
  }
  
  isNodePlacementActive = false;
  
  // Clean up event listeners
  const toolNodeBtn = document.getElementById('toolNode');
  const canvas = document.getElementById('workflowCanvas');
  
  if (toolNodeBtn._nodeToolHandlers) {
    document.removeEventListener('mousemove', toolNodeBtn._nodeToolHandlers.mousemove);
    canvas.removeEventListener('click', toolNodeBtn._nodeToolHandlers.canvasClick);
    document.removeEventListener('keydown', toolNodeBtn._nodeToolHandlers.keydown);
    toolNodeBtn._nodeToolHandlers = null;
  }
}


/**
 * Universal function to update all lines connected to a draggable element
 * @param {string} elementId - The ID of the element being dragged (step/frame/node ID)
 * @param {string} elementType - Type of element: 'step', 'frame', or 'node'
 */
// updateConnectedLines - MOVED TO wf-canvas.js

/**
 * Make any element draggable with universal drag handling
 * @param {HTMLElement} element - The element to make draggable
 * @param {string} elementId - The element's ID
 * @param {string} elementType - Type: 'step', 'frame', or 'node'
 * @param {Function} onDragMove - Callback during drag: (newX, newY, originalElement) => void
 * @param {Function} onDragEnd - Callback after drag: (newX, newY, originalElement) => void
 * @param {Object} options - Additional options: { dragHandle, threshold, snapSize, bounds }
 */
// makeElementDraggable - MOVED TO wf-canvas.js
// makeNodeDraggable - ELIMINATED (refactored into renderNode to call makeElementDraggable directly)

// ============================================================================
// VARIABLE CONTEXT SYSTEM - Type detection, graph traversal, context building
// ============================================================================

/**
 * Detect the type of a Jinja template value
 * Returns: boolean, string, integer, float, object, array, jinja
 */

// ============================================================================
// REFERENCE PANEL - Jinja Editor Enhancement
// ============================================================================

/**
 * Open Jinja Editor with Reference Panel for workflow context
 * Wrapper around openJinjaEditorModal that adds CTX reference
 */
function openWorkflowJinjaEditorModal(title, initialValue, onSaveCallback, stepId, varIndex, varType, caseId) {
  // Call the generic modal
  openJinjaEditorModal(title, initialValue, onSaveCallback);
  
  // Wait for modal to render, then inject reference panel and set width
  setTimeout(() => {
    // Use the LAST match, not the first — this modal may be opened from inside
    // an already-open modal (e.g. editing an Output Variable from within the
    // Workflow Settings modal), in which case querySelector's first match would
    // grab the older, outer modal instead of this freshly-opened one.
    const allModals = document.querySelectorAll('.modal-container');
    const modal = allModals[allModals.length - 1];
    if (modal) {
      // Set width while maintaining centering (uses transform: translate(-50%, -50%))
      modal.style.width = '800px';
      modal.style.maxWidth = '90vw';
    }
    injectReferencePanel(stepId, varIndex, varType, caseId);
  }, 100);
}

/**
 * Inject the Reference Panel into the Jinja Editor modal
 */
function injectReferencePanel(stepId, varIndex, varType, caseId) {
  // Find the modal - use the LAST match (topmost/most-recently-opened), since
  // this may be opened from inside another already-open modal (e.g. editing an
  // Output Variable from within the Workflow Settings modal)
  const allModals = document.querySelectorAll('.modal-container');
  let modal = allModals[allModals.length - 1];
  if (!modal) {
    modal = document.querySelector('[role="dialog"]');
  }
  if (!modal) {
    console.warn('Could not find modal');
    return;
  }

  // Check if reference panel already exists
  if (modal.querySelector('.ctx-reference-panel')) return;

  // Get available variables
  let variables = [];


  if (currentDefinition) {

    if (varType === 'output' && typeof getAllDeclaredVariables === 'function') {
      // Output variables are evaluated against the final CTX after the whole
      // workflow completes, so they can see every variable declared anywhere
      // in the workflow — Input, Trigger, every Step's own variables, and
      // every Step Case's variables — not just ones reachable from one node.
      variables = getAllDeclaredVariables(currentDefinition);
    } else {

      // Always show input variables
      if (currentDefinition.inputVariables && Array.isArray(currentDefinition.inputVariables)) {
        currentDefinition.inputVariables.forEach(v => {
          if (v.name) {
            variables.push({
              name: v.name,
              source: 'Source: Input Variables',
              type: detectVariableType(v.type)
            });
          }
        });
      }

      // If not BEGIN step, get context variables
      if (stepId) {
        const contextVars = getVariableContextForStep(stepId, currentDefinition, currentTransitions, { varIndex, varType, caseId });
        Object.entries(contextVars).forEach(([name, data]) => {
          if (!variables.find(v => v.name === name)) {
            variables.push({
              name,
              ...data
            });
          }
        });
      }
    }
  }

  variables.sort((a, b) => a.name.localeCompare(b.name));

  // Create reference panel container
  const refPanel = document.createElement('div');
  refPanel.className = 'ctx-reference-panel';
  refPanel.style.cssText = `
    position: absolute;
    left: 0;
    top: 0;
    width: 280px;
    height: 100%;
    border-right: 1px solid var(--border-primary);
    overflow-y: auto;
    padding: 12px;
    background: var(--bg-panel3);
    box-sizing: border-box;
    z-index: 10;
  `;

  // Add header
  const header = document.createElement('div');
  header.style.cssText = 'font-size: 0.9rem; font-weight: 600; color: var(--text-primary); margin-bottom: 10px;';
  header.textContent = 'Available Variables';
  refPanel.appendChild(header);

  // Add search filter
  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.placeholder = 'Search...';
  filterInput.style.cssText = `
    width: 100%;
    padding: 6px;
    margin-bottom: 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 0.85rem;
    box-sizing: border-box;
  `;
  refPanel.appendChild(filterInput);

  // Add variables list
  const varList = document.createElement('div');
  varList.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

  if (variables.length === 0) {
    const noVars = document.createElement('div');
    noVars.style.cssText = 'color: var(--text-muted); font-size: 0.85rem; padding: 8px; text-align: center;';
    noVars.textContent = 'No variables available';
    varList.appendChild(noVars);
  } else {
    variables.forEach(v => {
      const item = document.createElement('div');
      item.className = 'ctx-ref-item';
      item.style.cssText = `
        padding: 8px;
        background: var(--bg-panel2);
        border: 1px solid var(--border-primary);
        border-radius: 4px;
        cursor: pointer;
        transition: background-color 0.2s ease;
        user-select: none;
      `;
      item.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 6px;">
          <span style="color: var(--text-primary); font-weight: 500; font-size: 0.85rem;">${v.name}</span>
          <span style="color: var(--brand-light); font-size: 0.7rem; font-weight: 500; white-space: nowrap;">${v.type}</span>
        </div>
        <div style="color: var(--text-muted); font-size: 0.75rem; margin-top: 1px;">${v.source}</div>
      `;

      // Double-click to insert
      item.addEventListener('dblclick', () => {
        insertVariableIntoEditor(v.name);
      });

      // Hover effect
      item.addEventListener('mouseenter', () => {
        item.style.backgroundColor = 'var(--bg-panel1)';
      });
      item.addEventListener('mouseleave', () => {
        item.style.backgroundColor = 'var(--bg-panel2)';
      });

      varList.appendChild(item);
    });
  }

  refPanel.appendChild(varList);

  // Inject into modal - don't change position to preserve centering
  modal.insertBefore(refPanel, modal.firstChild);

  // Adjust modal body padding to account for reference panel
  const modalBody = modal.querySelector('.modal-body');
  if (modalBody) {
    modalBody.style.marginLeft = '280px';
    modalBody.style.boxSizing = 'border-box';
  }

  // Wire up filter
  filterInput.addEventListener('input', (e) => {
    const filterText = e.target.value.toLowerCase();
    document.querySelectorAll('.ctx-ref-item').forEach(item => {
      const name = item.querySelector('div').textContent.toLowerCase();
      item.style.display = name.includes(filterText) ? 'block' : 'none';
    });
  });
}

/**
 * Insert variable into Jinja editor (CodeMirror contenteditable)
 */
function insertVariableIntoEditor(varName) {
  // Find the CodeMirror content div (contenteditable)
  const cmContent = document.querySelector('.cm-content[role="textbox"]');
  if (!cmContent) {
    console.warn('Could not find CodeMirror content div');
    return;
  }

  // Focus first
  cmContent.focus();

  // Get current cursor position in the text
  const selection = window.getSelection();
  if (!selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  
  // Get text before cursor by creating a range to the start
  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(cmContent);
  preCaretRange.setEnd(range.endContainer, range.endOffset);
  const beforeCursorText = preCaretRange.toString();

  // Get all text after cursor
  const postCaretRange = range.cloneRange();
  postCaretRange.selectNodeContents(cmContent);
  postCaretRange.setStart(range.endContainer, range.endOffset);
  const afterCursorText = postCaretRange.toString();

  // Check if already inside {{ }} or {% %}
  const insideBraces = /\{\{[^}]*$/.test(beforeCursorText) && !beforeCursorText.match(/\}\}[^{]*$/);
  const insidePercent = /\{%[^}]*$/.test(beforeCursorText) && !beforeCursorText.match(/%\}[^{]*$/);

  let insertText;
  if (insideBraces || insidePercent) {
    insertText = `CTX.${varName}`;
  } else {
    insertText = `{{ CTX.${varName} }}`;
  }

  // Use execCommand to insert text - this preserves CodeMirror's structure
  document.execCommand('insertText', false, insertText);

  // Trigger input event for CodeMirror to sync
  cmContent.dispatchEvent(new Event('input', { bubbles: true }));
}

// ============================================================================
// END VARIABLE CONTEXT SYSTEM
// ============================================================================

// Wrapper function to update save button based on base.js unsaved changes flag
function updateSaveButtonState() {
    const saveBtn = document.getElementById('saveWorkflowBtn');
    if (saveBtn) {
        saveBtn.disabled = !hasUnsavedChanges();
    }
}

function getUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return {
        id: params.get('id')
    };
}




function showJSONModal() {
    // Rebuild input and output variables from form to get current state
    rebuildInputVariablesFromForm();
    rebuildOutputVariablesFromForm();
    
    // Sort cases and strip runtime fields for display
    const stepsForExport = normalizeStepsForComparison(currentSteps);
    
    const workflowData = {
        id: currentWorkflowId,
        name: currentWorkflowName,
        version: currentVersion,
        view: {
            zoom: zoomLevel,
            pan: `${(panX / GU).toFixed(2)},${(panY / GU).toFixed(2)}`
        },
        metadata: currentMetadata,
        description: currentDefinition.description || '',
        inputVariables: currentInputVariables,
        outputVariables: currentOutputVariables,
        outputHtml: currentOutputHtml || '',
        triggers: currentTriggers,
        steps: stepsForExport,
        nodes: currentNodes
    };
    const jsonContent = JSON.stringify(workflowData, null, 2);
    
    // Open read-only JSON editor modal
    openJsonEditorModal('Workflow Configuration', jsonContent, null, true);
}

/**
 * Opens an editable JSON modal for pasting in a replacement workflow
 * definition (e.g. one generated in a conversation with Claude), separate
 * from the read-only "View JSON" above. Intended for developers/operators
 * without direct DB access to apply definition updates without going through
 * the workflows-list page's full "New Workflow" import flow.
 */
function showImportJSONModal() {
    openJsonEditorModal('Import Workflow JSON', '', handleImportJSON, false);
}

/**
 * Validates and applies a pasted workflow JSON definition, replacing the
 * CURRENTLY OPEN workflow's contents (steps/triggers/variables/nodes) in
 * place. Deliberately does NOT touch currentWorkflowId or currentVersion -
 * this replaces the existing workflow's definition, it does not create a new
 * workflow or change which one is being edited. Does not save to the
 * database itself; the normal Save button/flow still applies afterward, so
 * the imported result can be reviewed on the canvas first.
 * @param {string} jsonText - Raw pasted JSON text
 * @returns {boolean} true if applied, false if rejected (invalid JSON,
 *   failed validation, or the user cancelled the replace confirmation)
 */
function handleImportJSON(jsonText) {
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
        const steps = Array.isArray(parsed.steps) ? parsed.steps : null;
        if (!steps || steps.length === 0) {
            errors.push('Missing or empty "steps" array.');
        } else {
            const beginSteps = steps.filter(s => s.type === 'Begin');
            if (beginSteps.length === 0) {
                errors.push('No "Begin" step found (exactly one is required).');
            } else if (beginSteps.length > 1) {
                errors.push(`Found ${beginSteps.length} "Begin" steps (exactly one is required).`);
            }

            const stepIds = steps.map(s => s.id);
            const dupStepIds = [...new Set(stepIds.filter((id, i) => stepIds.indexOf(id) !== i))];
            if (dupStepIds.length > 0) {
                errors.push(`Duplicate step id(s): ${dupStepIds.join(', ')}`);
            }

            const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
            const nodeIds = nodes.map(n => n.id);
            const dupNodeIds = [...new Set(nodeIds.filter((id, i) => nodeIds.indexOf(id) !== i))];
            if (dupNodeIds.length > 0) {
                errors.push(`Duplicate node id(s): ${dupNodeIds.join(', ')}`);
            }

            // Dangling reference check - a case/node pointing at a step or node id
            // that doesn't exist anywhere in this same pasted definition would
            // otherwise fail to route silently once imported.
            const allStepIds = new Set(stepIds);
            const allNodeIds = new Set(nodeIds);
            steps.forEach(step => {
                const cases = (step.transition && step.transition.cases) || [];
                cases.forEach(c => {
                    (c.targetSteps || []).forEach(t => {
                        if (!allStepIds.has(t)) errors.push(`Step "${step.name || step.id}" case "${c.name || c.type}" references unknown targetStep "${t}".`);
                    });
                    (c.targetNodes || []).forEach(t => {
                        if (!allNodeIds.has(t)) errors.push(`Step "${step.name || step.id}" case "${c.name || c.type}" references unknown targetNode "${t}".`);
                    });
                });
            });
            nodes.forEach(node => {
                (node.targetSteps || []).forEach(t => {
                    if (!allStepIds.has(t)) errors.push(`Node "${node.name || node.id}" references unknown targetStep "${t}".`);
                });
                (node.targetNodes || []).forEach(t => {
                    if (!allNodeIds.has(t)) errors.push(`Node "${node.name || node.id}" references unknown targetNode "${t}".`);
                });
            });
        }

        if (!Array.isArray(parsed.triggers) || parsed.triggers.length === 0) {
            errors.push('Missing or empty "triggers" array (at least one trigger is required).');
        }
    }

    if (errors.length > 0) {
        const shown = errors.length > 3 ? errors.slice(0, 3).concat([`...and ${errors.length - 3} more (see console)`]) : errors;
        showStatusBanner(`Import failed: ${shown.join(' | ')}`, 'error', 'statusMessage', 999999999);
        if (errors.length > 3) console.error('[Import JSON] Full validation error list:', errors);
        return false;
    }

    // --- Confirm before replacing (this is destructive to the in-memory canvas
    // state, even though it doesn't save to the DB by itself). Uses the same
    // stacking modal system as the rest of the app (showModal/modalStack) so
    // this layers on top of the still-open Import JSON modal rather than
    // using a native browser confirm() - built with showModal directly
    // rather than the showConfirm() convenience wrapper, since Cancel and
    // Confirm need to resolve this function's return value differently (see
    // the base.js fix that makes an async onSave's return value actually
    // control whether the Import modal itself stays open or closes).
    const importedName = parsed.name || '(unnamed)';
    const nameNote = importedName !== currentWorkflowName
        ? ` Note: the pasted definition is named "${importedName}", which differs from the current workflow's name ("${currentWorkflowName}").`
        : '';

    return new Promise((resolve) => {
        showModal({
            title: 'Confirm Overwrite',
            content: `<p style="color: var(--text-primary); margin: 0;">This replaces the current workflow's steps, triggers, variables, and nodes with the pasted JSON.${nameNote} Nothing is saved to the database yet — review the result on the canvas, then click Save (or discard by reloading the page).</p>`,
            closeOnBackdrop: false,  // must resolve one way or the other, not silently dismiss
            buttons: [
                {
                    label: 'Cancel',
                    type: 'secondary',
                    onClick: () => {
                        // Import JSON modal stays open (per the false return) so
                        // the pasted text isn't lost - user can edit and retry.
                        resolve(false);
                    }
                },
                {
                    label: 'Replace',
                    type: 'danger',
                    onClick: () => {
                        // --- Apply: same fields loadWorkflow() populates from a
                        // fetched definition, but currentWorkflowId/currentVersion
                        // are deliberately left untouched - this replaces the
                        // CURRENT workflow's contents, not its identity.
                        currentSteps = parsed.steps || [];
                        currentInputVariables = parsed.inputVariables || [];
                        currentOutputVariables = parsed.outputVariables || [];
                        currentOutputHtml = parsed.outputHtml || '';
                        currentNodes = parsed.nodes || [];
                        currentTriggers = parsed.triggers || [];
                        if (parsed.metadata) currentMetadata = parsed.metadata;
                        if (currentDefinition) currentDefinition.description = parsed.description || '';

                        // renderLoadedStepsOnCanvas() fully clears any previously-
                        // rendered canvas elements and rebuilds currentTransitions
                        // from currentSteps internally - same rendering path
                        // loadWorkflow() uses after a normal fetch.
                        renderLoadedStepsOnCanvas();
                        updatePreview();
                        updateSaveButtonState();

                        showStatusBanner('Workflow JSON imported - review the canvas, then Save to persist.', 'success');
                        resolve(true);
                    }
                }
            ]
        });
    });
}


/**
 * Add a new case to a step's transition strip.
 * Replaces the old addConditionToFrame which operated on frame objects.
 * @param {string} stepId - The step's UUID
 */
function addCaseToStep(stepId) {
    const step = currentSteps.find(s => s.id === stepId);
    if (!step) return;

    if (!step.transition) {
        step.transition = { mode: 'First', cases: [] };
    }
    if (!step.transition.cases) {
        step.transition.cases = [];
    }

    transitionCounter = (transitionCounter || 0) + 1;
    const newConditionId = String(transitionCounter);
    // Use the actual max existing order + 1, not cases.length + 1 -- a
    // deleted case leaves a gap in the order sequence (delete does not
    // renumber the remaining cases), so basing the new case's order on the
    // current count can collide with a case that already holds that value.
    const order = step.transition.cases.length > 0
        ? Math.max(...step.transition.cases.map(c => c.order || 0)) + 1
        : 1;

    const newConditionData = {
        id: newConditionId,
        name: '',
        type: 'Success',
        conditions: '',
        targetSteps: [],
        targetNodes: [],
        order: order,
        parentStepId: stepId,
        variables: []
    };

    currentTransitions.push(newConditionData);

    step.transition.cases.push({
        type: 'Success',
        conditions: '',
        targetSteps: [],
        targetNodes: [],
        order: order,
        variables: [],
        _conditionId: newConditionId
    });

    // Re-render the case strip inside the step element
    const canvas = document.getElementById('workflowCanvas');
    const stepElement = canvas ? canvas.querySelector(`[data-step-uuid="${stepId}"]`) : null;
    if (stepElement) {
        // Expand step width if cases + add button slot overflow content area.
        // Step layout: 2px border + 24px icon + 2px margin + Npx content + 2px border = width
        // Content width = step width - 30px (borders + icon + margin)
        // Each case: 30px. Add button slot: 30px (14px margin + 16px button).
        const caseCount = step.transition.cases.length;
        const requiredContentWidth = caseCount * GU + GU;
        const currentWidth = parseInt(stepElement.style.width) || 120;
        const currentContentWidth = currentWidth - GU;

        if (requiredContentWidth > currentContentWidth) {
            const newWidth = currentWidth + GU;
            stepElement.style.width = newWidth + 'px';
            step.width = newWidth / GU;
        }

        renderCaseStrip(stepElement, step, canvas);
    }

    updatePreview();
}

// Preserved for compatibility — was the old frame-based add condition.
// Now a no-op since frames are replaced by the inline case strip.
function addConditionToFrame(frameUUID, conditionsContainer) {
    return () => {};
}

function applyFrameLayout(frameUUID, verticalLayout) {
    // This function is now just a wrapper that calls renderTransitionFrame
    renderTransitionFrame(frameUUID, verticalLayout);
}

function detachFrameFromStep(frameUUID) {
    const canvas = document.getElementById('workflowCanvas');
    const frame = currentTransitionFrames.find(f => f.id === frameUUID);
    if (!frame || !frame.attachedToStepId) return;
    
    const attachedStep = currentSteps.find(s => s.id === frame.attachedToStepId);
    if (!attachedStep) return;
    
    const stepElement = canvas.querySelector(`[data-step-uuid="${attachedStep.id}"]`);
    if (!stepElement) return;
    
    // Detach the frame
    frame.attachedToStepId = null;
    frame.attached = false;
    
    // Restore step border radius
    stepElement.style.borderRadius = '4px';
    
    // Show connection circle
    const connectionPoint = stepElement.querySelector('[data-connection-point]');
    if (connectionPoint) {
        connectionPoint.style.display = 'block';
    }
    
    // Recalculate step width based on text
    const tempDiv = document.createElement('div');
    tempDiv.style.cssText = `position: absolute; visibility: hidden; font-size: ${Math.round(GU / 3)}px; white-space: nowrap;`;
    tempDiv.textContent = attachedStep.name || `${attachedStep.type} Step`;
    document.body.appendChild(tempDiv);
    const textWidth = tempDiv.offsetWidth;
    document.body.removeChild(tempDiv);
    
    let width = STEP_MIN_W;
    if (textWidth > STEP_MIN_W - GU - BORDER * 2) {
        const gridSpaces = Math.ceil((textWidth - (STEP_MIN_W - GU - BORDER * 2)) / GU);
        width = STEP_MIN_W + (gridSpaces * GU);
    }
    stepElement.style.width = width + 'px';
    attachedStep.width = width / GU;
    attachedStep.overrideSize = false;
    
    // Position frame below step
    const stepPos = attachedStep.position.split(',').map(Number);
    frame.position = `${stepPos[0]},${stepPos[1] + 1}`;
    const frameElement = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
    if (frameElement) {
        frameElement.style.left = (stepPos[0] * 30) + 'px';
        frameElement.style.top = ((stepPos[1] + 1) * 30) + 'px';
    }
    
    // Re-establish transition connection line and re-render frame to remove detach tag
    
    // Create transition connection line if it doesn't exist
    let connectionLine = canvas.querySelector(`[data-connection-line][data-from-step="${attachedStep.id}"]`);
    if (!connectionLine) {
        connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        connectionLine.setAttribute('data-connection-line', frameUUID);
        connectionLine.setAttribute('data-from-step', attachedStep.id);
        connectionLine.setAttribute('width', '100%');
        connectionLine.setAttribute('height', '100%');
        connectionLine.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1;
        `;
        canvas.appendChild(connectionLine);
    }
    
    // Show transition connection line
    if (connectionLine) {
        connectionLine.style.display = 'block';
    }
    
    // Re-render frame first to remove grab indicator
    renderTransitionFrame(frameUUID, false);
    
    // Update blue line after frame is re-rendered
    setTimeout(() => {
        const stepElementForLine = canvas.querySelector(`[data-step-uuid="${attachedStep.id}"]`);
        const frameElementForLine = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
        const connLine = canvas.querySelector(`[data-connection-line][data-from-step="${attachedStep.id}"]`);
        
        if (stepElementForLine && frameElementForLine && connLine) {
            const closestSide = getClosestSideToFrame(stepElementForLine, frameElementForLine, canvas);
            updateTransitionLine(connLine, frameUUID, attachedStep.id, closestSide, canvas);
        }
    }, 0);
    updatePreview();
}

function showTransitionFrameProperties(frameUUID) {
    const frame = (currentTransitionFrames || []).find(f => f.id === frameUUID);
    if (!frame) return;
    
    // Find the step(s) connected to this frame to get vertical and mode
    let isVertical = false;
    let executionMode = 'First';
    for (const step of currentSteps) {
        if (step.transition && step.transition.cases) {
            const hasConditionFromFrame = step.transition.cases.some(c => 
                frame.conditions.includes(currentTransitions.find(t => t.order === c.order)?.id)
            );
            if (hasConditionFromFrame) {
                isVertical = step.transition.vertical || false;
                executionMode = step.transition.mode || 'First';
                frame.verticalLayout = isVertical;
                frame.execution = executionMode;
                break;
            }
        }
    }
    
    // Generate content HTML
    const contentHTML = `
        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Execution Mode</label>
            <select id="frameExecution" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                <option value="First" ${frame.execution === 'First' ? 'selected' : ''}>First</option>
                <option value="All" ${frame.execution === 'All' ? 'selected' : ''}>All</option>
            </select>
        </div>
        
        <div style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="verticalLayout" ${isVertical ? 'checked' : ''} style="cursor: pointer;">
            <label for="verticalLayout" style="font-size: 0.8rem; color: #b0b0b0; cursor: pointer; margin: 0;">Vertical Layout</label>
        </div>
    `;
    
    // Setup event listeners
    const onListenersAttach = (container) => {
        const executionSelect = container.querySelector('#frameExecution');
        if (executionSelect) {
            executionSelect.addEventListener('change', (e) => {
                frame.execution = e.target.value;
                currentSteps.forEach(step => {
                    const hasConditionFromFrame = step.transitions.some(t => 
                        frame.conditions.includes(t.id)
                    );
                    if (hasConditionFromFrame) {
                        step.trans_mode = frame.execution;
                    }
                });
                updatePreview();
            });
        }
        
        const verticalLayoutCheckbox = container.querySelector('#verticalLayout');
        if (verticalLayoutCheckbox) {
            verticalLayoutCheckbox.addEventListener('change', (e) => {
                frame.verticalLayout = e.target.checked;
                applyFrameLayout(frameUUID, frame.verticalLayout);
                
                currentSteps.forEach(step => {
                    if (step.transition && step.transition.cases) {
                        const hasConditionFromFrame = step.transition.cases.some(c => 
                            frame.conditions.includes(
                                currentTransitions.find(t => t.order === c.order)?.id
                            )
                        );
                        if (hasConditionFromFrame) {
                            step.transition.vertical = frame.verticalLayout;
                        }
                    }
                });
                
                const canvas = document.getElementById('workflowCanvas');
                frame.conditions.forEach(conditionId => {
                    const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${conditionId}"]`);
                    caseLines.forEach(line => {
                        const toStepId = line.getAttribute('data-to-step');
                        const toNodeId = line.getAttribute('data-to-node');
                        const transition = currentTransitions.find(t => t.id === conditionId);
                        const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                        
                        if (toStepId) {
                            drawConnectionLine(line, conditionId, 'case', toStepId, 'step', canvas, caseColor, false, frame);
                        } else if (toNodeId) {
                            drawConnectionLine(line, conditionId, 'case', toNodeId, 'node', canvas, caseColor, false, frame);
                        }
                    });
                });
                
                updatePreview();
            });
        }
    };
    
    renderPropertiesPanel(
        'Transition Frame Properties',
        '#d4af37',
        { id: frameUUID, type: 'frame' },
        contentHTML,
        onListenersAttach
    );
}

/**
 * Validate a name for a step or node.
 * Returns null if valid, or an error message string if invalid.
 * @param {string} name - The proposed name
 * @param {string} excludeId - The ID of the element being renamed (to exclude from duplicate check)
 */
function validateElementName(name, excludeId) {
    if (/\s/.test(name)) return 'Names cannot contain spaces.';
    const allNames = [
        ...currentSteps.map(s => ({ id: s.id, name: s.name })),
        ...currentNodes.map(n => ({ id: n.id, name: n.name }))
    ];
    const duplicate = allNames.some(e => e.id !== excludeId && (e.name || '').toLowerCase() === name.toLowerCase());
    if (duplicate) return `"${name}" is already used by another step or node.`;
    return null;
}

function showTransitionProperties(transitionUUID) {
    const transition = (currentTransitions || []).find(t => t.id === transitionUUID);
    if (!transition) return;

    // Ensure variables array exists (backward compat with cases created before this feature)
    if (!transition.variables) transition.variables = [];

    currentTransitionBeingEdited = transition;  // Track for variable editing
    
    const contentHTML = {
        basic: `
        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Name</label>
            <input type="text" id="transitionName" class="form-field-input" value="${transition.name || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
        </div>
        
        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Type</label>
            <select id="transitionType" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                <option value="Success" ${transition.type === 'Success' ? 'selected' : ''}>Success</option>
                <option value="Failure" ${transition.type === 'Failure' ? 'selected' : ''}>Failure</option>
                <option value="Logic" ${transition.type === 'Logic' ? 'selected' : ''}>Logic</option>
                <option value="Always" ${transition.type === 'Always' ? 'selected' : ''}>Always</option>
            </select>
        </div>
        
        <div id="conditionsDiv" style="display: ${transition.type === 'Logic' ? 'block' : 'none'};">
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Conditions</label>
            <div style="display: flex; gap: 8px;">
                <input type="text" id="transitionConditions" class="form-field-input" value="${transition.conditions || ''}" style="flex: 1; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                <button class="btn transition-conditions-edit-btn" data-transition-uuid="${transitionUUID}" data-color="blue" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 16px;" title="Edit Conditions">&#9998;</button>
            </div>
        </div>

        <div style="border-top: 1px solid #3a7a99; padding-top: 10px;">
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Output Variables</label>
            <button id="addCaseVariableBtn" class="btn btn-blue" data-size="sm" style="width: 100%; padding: 6px; margin-bottom: 8px;">Add Variable</button>
            <div id="caseVariablesContainer"></div>
        </div>
        `,
        advanced: `
        <div style="font-size: 0.75rem; color: #707070; word-break: break-all;">ID: ${transition.id}</div>
        `
    };
    
    const onListenersAttach = (container) => {
        container.querySelector('#transitionName')?.addEventListener('change', (e) => {
            transition.name = e.target.value;
            updatePreview();
        });

        container.querySelector('#transitionConditions')?.addEventListener('change', (e) => {
            transition.conditions = e.target.value;
            updatePreview();
        });
        
        container.querySelector('#transitionType')?.addEventListener('change', (e) => {
            transition.type = e.target.value;
            
            const conditionsDiv = container.querySelector('#conditionsDiv');
            if (conditionsDiv) {
                conditionsDiv.style.display = transition.type === 'Logic' ? 'block' : 'none';
            }
            
            const canvas = document.getElementById('workflowCanvas');
            const conditionBox = canvas.querySelector(`[data-condition-id="${transitionUUID}"]`);
            if (conditionBox) {
                conditionBox.setAttribute('data-transition-type', transition.type);
                const newColors = getTransitionTheme(transition.type);
                conditionBox.style.background = newColors.color;
                conditionBox.style.color = '#ffffff';
                
                let icon = getTransitionTheme(transition.type).icon;
                if (transition.type === 'Always') {
                    icon = '&#9660;';
                }
                conditionBox.innerHTML = icon;
            }
            
            updateTransitionLineColors(transitionUUID, transition.type);
            updatePreview();
        });

        // Render case variables
        const caseVariablesContainer = container.querySelector('#caseVariablesContainer');
        if (caseVariablesContainer) {
            renderTransitionCaseVariables(caseVariablesContainer, transition.variables, () => updatePreview());
        }

        // Add variable button
        const addCaseVariableBtn = container.querySelector('#addCaseVariableBtn');
        if (addCaseVariableBtn) {
            addCaseVariableBtn.addEventListener('click', () => {
                transition.variables.push({ name: '', value: '', order: transition.variables.length });
                showTransitionProperties(transitionUUID);  // Refresh panel
                updatePreview();
            });
        }
    };
    
    renderPropertiesPanel(
        'Transition Case Properties',
        '#3a7a99',
        { id: transitionUUID, type: 'transition' },
        contentHTML,
        onListenersAttach
    );
}

// Event listener for transition condition edit button
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('transition-conditions-edit-btn')) {
        const transitionUUID = e.target.getAttribute('data-transition-uuid');
        const transition = currentTransitions.find(t => t.id === transitionUUID);
        if (transition) {
            const step = currentSteps.find(s => s.transition && s.transition.cases && 
                s.transition.cases.some(c => c.id === transitionUUID || c === transition));
            
            openWorkflowJinjaEditorModal('Edit Conditions', transition.conditions || '', (value) => {
                const conditionsInput = document.getElementById('transitionConditions');
                if (conditionsInput) {
                    conditionsInput.value = value;
                }
                transition.conditions = value;
                updatePreview();
            }, step ? step.id : null);
        }
    }
});

function applyStepSizeOverride(stepUUID) {
    const step = currentSteps.find(s => s.id === stepUUID);
    if (!step) return;
    
    const canvas = document.getElementById('workflowCanvas');
    const stepElement = canvas.querySelector(`[data-step-uuid="${stepUUID}"]`);
    if (!stepElement) return;
    
    let newWidth, newHeight;
    
    if (step.overrideSize) {
        // Use override values
        newWidth = Math.max(2, step.width || 3) * GU;  // Convert grid units to pixels
        newHeight = Math.max(1, step.height || 1) * GU;
    } else {
        // Auto-calculate width from text, height is 1 grid unit
        const tempDiv = document.createElement('div');
        tempDiv.style.cssText = `position: absolute; visibility: hidden; font-size: ${Math.round(GU / 3)}px; white-space: nowrap;`;
        tempDiv.textContent = step.name || step.type;
        document.body.appendChild(tempDiv);
        const textWidth = tempDiv.offsetWidth;
        document.body.removeChild(tempDiv);
        let requiredWidth = STEP_MIN_W;
        if (textWidth > STEP_MIN_W - GU - BORDER * 2) {
            const gridSpaces = Math.ceil((textWidth - (STEP_MIN_W - GU - BORDER * 2)) / GU);
            requiredWidth = STEP_MIN_W + (gridSpaces * GU);
        }
        newWidth = requiredWidth;
        newHeight = GU; // 1 grid unit
    }
    
    // Update step data with final width/height values (in grid units for storage)
    step.width = newWidth / GU;
    step.height = newHeight / GU;
    
    // Apply sizing to element
    stepElement.style.width = newWidth + 'px';
    stepElement.style.height = newHeight + 'px';
    
    // Update all connection lines for this step
    updateConnectedLines(stepUUID, 'step');
}

function showStepProperties(stepUUID) {
    const step = currentSteps.find(s => s.id === stepUUID);
    if (!step) return;
    
    currentStepBeingEdited = step;  // Track this step for variable editing
    
    // Determine step type for conditional fields
    const isBeginStep = step.type === 'Begin';
    const isKoreType = step.type === 'Kore';
    const isWorkflowType = step.type === 'Workflow';
    const isPluginType = step.type === 'Plugin';
    const isEndType = step.type === 'End';

    // Only show the Case Variables section at all if at least one case actually has variables.
    const stepCasesWithVars = ((step.transition && step.transition.cases) || []).filter(c => c.variables && c.variables.length > 0);
    const hasCaseVariables = stepCasesWithVars.length > 0;
    
    // Variables rendered via renderStepOutputVariables in onListenersAttach
    
    // Build Action field HTML based on type
    let actionFieldHTML = '';
    if (isBeginStep || isEndType) {
        // No action field for Begin and End
        actionFieldHTML = '';
    } else if (isKoreType) {
        // Dropdown for Kore
        actionFieldHTML = `
            <div>
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Action</label>
                <select id="stepAction" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    <option value="None" ${step.action === 'None' || !step.action ? 'selected' : ''}>None</option>
                </select>
            </div>
            <div id="koreActionInputsContainer" style="padding-top: 10px; border-top: 1px solid #3a7a99; display: none;">
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Action Inputs</label>
                <div id="koreActionInputsContent"></div>
            </div>
        `;
    } else if (isWorkflowType) {
        // Dropdown for Workflow + input mapping (Basic); loop config goes to Advanced
        actionFieldHTML = `
            <div>
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Workflow</label>
                <select id="stepAction" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    <option value="">-- Select Workflow --</option>
                </select>
            </div>
            <div id="stepTriggerContainer" style="display: none;">
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Trigger</label>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <select id="stepTrigger" class="form-field-input" style="flex: 1; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                        <option value="">-- Default --</option>
                    </select>
                    <button id="stepTriggerEditBtn" class="btn" data-size="sm" data-color="blue" title="Edit as Jinja" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">{ }</button>
                </div>
            </div>
            <div id="workflowInputsContainer" style="padding-top: 10px; border-top: 1px solid #3a7a99; display: none;">
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Input Mapping</label>
                <div id="workflowInputsContent"></div>
            </div>
        `;
    } else if (isPluginType) {
        // Plugin Type dropdown and Action dropdown
        actionFieldHTML = `
            <div>
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Plugin Type</label>
                <select id="stepPluginType" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    <option value="">Loading plugins...</option>
                </select>
            </div>
            <div>
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Action</label>
                <select id="stepAction" class="form-field-input" disabled style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    <option value="">-- Select Plugin First --</option>
                </select>
            </div>
            <div id="taskInputsContainer" style="padding-top: 10px; border-top: 1px solid #3a7a99;">
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Task Inputs</label>
                <div id="taskInputsContent"></div>
            </div>
        `;
    } else {
        // Text input for other standard steps (Test, etc)
        actionFieldHTML = `
            <div>
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Action</label>
                <input type="text" id="stepAction" class="form-field-input" value="${step.action || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
            </div>
        `;
    }
    
    // Build content HTML split into Basic and Advanced tabs
    const basicHTML = `
        ${!isBeginStep ? `
        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Name</label>
            <input type="text" id="stepName" class="form-field-input" value="${step.name || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
            <div id="stepNameError" style="display: none; margin-top: 4px; padding: 4px 8px; background: rgba(184, 36, 47, 0.15); border-left: 3px solid var(--status-red, #b8242f); border-radius: 2px; font-size: 0.75rem; color: #ff6b6b;"></div>
        </div>
        ` : ''}
        
        ${actionFieldHTML}
        
        <div style="${!isBeginStep ? 'border-top: 1px solid #3a7a99; padding-top: 10px;' : ''}">
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Output Variables</label>
            <button id="addVariableBtn" class="btn btn-blue" data-size="sm" style="width: 100%; padding: 6px; margin-bottom: 8px;">Add Variable</button>
            <div id="variablesContainer"></div>
        </div>

        ${hasCaseVariables ? `
        <div style="border-top: 1px solid #3a7a99; padding-top: 10px;">
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Case Variables <span style="color: #707070; font-weight: normal;">(read-only — edit on the case itself)</span></label>
            <div id="caseVariablesSummaryContainer"></div>
        </div>
        ` : ''}
    `;

    const advancedHTML = `
        ${(isWorkflowType || isPluginType) ? `
        <div>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" id="loopModeCheckbox" ${step.loopMode ? 'checked' : ''} style="cursor: pointer;">
                <span style="font-size: 0.85rem; color: #b0b0b0;">Loop Mode</span>
            </label>
        </div>
        <div id="loopConfigContainer" class="panel-level-3" style="display: ${step.loopMode ? 'flex' : 'none'}; flex-direction: column; gap: 10px;">
            <div>
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Source Array</label>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <input type="text" id="loopSourceArray" class="form-field-input" value="${step.loopConfig?.sourceArray || ''}" placeholder="e.g. CTX.time_entries_sep" style="flex: 1; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    <button id="loopSourceArrayEditBtn" class="btn" data-size="sm" data-color="blue" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">{ }</button>
                </div>
            </div>
            <div>
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Execution Mode</label>
                <select id="loopExecutionMode" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    <option value="concurrent" ${(step.loopConfig?.executionMode || 'concurrent') === 'concurrent' ? 'selected' : ''}>Concurrent</option>
                    <option value="sequential" ${step.loopConfig?.executionMode === 'sequential' ? 'selected' : ''}>Sequential</option>
                </select>
            </div>
            <div id="maxConcurrentContainer" style="display: ${step.loopConfig?.executionMode === 'sequential' ? 'none' : 'block'};">
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Max Concurrent</label>
                <input type="number" id="loopMaxConcurrent" class="form-field-input" value="${step.loopConfig?.maxConcurrent ?? 1}" min="1" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
            </div>
            <div>
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">On Item Failure</label>
                <select id="loopOnItemFailure" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    <option value="continue" ${(step.loopConfig?.onItemFailure || 'continue') === 'continue' ? 'selected' : ''}>Continue Remaining</option>
                    <option value="stop" ${step.loopConfig?.onItemFailure === 'stop' ? 'selected' : ''}>Stop Immediately</option>
                </select>
            </div>
        </div>
        <div style="border-top: 1px solid #3a7a99;"></div>
        ` : ''}

        ${!isBeginStep ? `
        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Min Inbound Connections</label>
            <div style="display: flex; gap: 8px; align-items: center;">
                <input type="${(typeof step.min_connections === 'string' && (step.min_connections.includes('{{') || step.min_connections.includes('{%'))) ? 'text' : 'number'}" id="stepMinConnections" class="form-field-input" value="${step.min_connections ?? 0}" min="0" style="flex: 1; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                <button id="stepMinConnectionsEditBtn" class="btn" data-size="sm" data-color="blue" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">{ }</button>
            </div>
            <div style="font-size: 0.75rem; color: #707070; margin-top: 4px;">0 = all inbound connections must fire. Use { } for a dynamic Jinja expression (e.g. computed from how many of several optional branches are actually active this run) instead of a fixed number.</div>
        </div>
        ` : ''}

        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Transition Mode</label>
            <select id="transitionModeSelect" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                <option value="First" ${(step.transition && step.transition.mode || 'First') === 'First' ? 'selected' : ''}>First</option>
                <option value="All" ${step.transition && step.transition.mode === 'All' ? 'selected' : ''}>All</option>
            </select>
        </div>

        <div>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" id="showCaseNameCheckbox" ${step.showCaseName ? 'checked' : ''} style="cursor: pointer;">
                <span style="font-size: 0.85rem; color: #b0b0b0;">Show Case Name in Execution Details</span>
            </label>
            <div style="font-size: 0.75rem; color: #707070; margin-top: 4px;">ex: "CaseName (Step: StepName)" instead of "StepName". Only shown when exactly one case matched and it has a name</div>
        </div>

        <div>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" id="overrideSizeCheckbox" ${step.overrideSize ? 'checked' : ''} style="cursor: pointer;">
                <span style="font-size: 0.85rem; color: #b0b0b0;">Override Size</span>
            </label>
            <div id="sizeOverrideInputs" style="display: ${step.overrideSize ? 'flex' : 'none'}; flex-direction: column; gap: 10px; margin-top: 8px;">
                <div>
                    <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Width (grid units)</label>
                    <input type="number" id="overrideWidth" class="form-field-input" value="${step.width || 4}" min="2" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                </div>
                <div>
                    <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Height (grid units)</label>
                    <input type="number" id="overrideHeight" class="form-field-input" value="${step.height || 1}" min="1" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                </div>
            </div>
        </div>

        <div style="font-size: 0.75rem; color: #707070; word-break: break-all;">ID: ${step.id}</div>
    `;

    const contentHTML = { basic: basicHTML, advanced: advancedHTML };
    
    // Build event listeners attachment function
    const onListenersAttach = (container) => {
        // Step name handler
        const stepNameInput = container.querySelector('#stepName');
        const stepNameError = container.querySelector('#stepNameError');
        if (stepNameInput && !isBeginStep) {
            const showStepNameError = (msg) => {
                stepNameInput.style.borderColor = 'var(--status-red, #b8242f)';
                if (stepNameError) { stepNameError.textContent = msg; stepNameError.style.display = 'block'; }
            };
            const clearStepNameError = () => {
                stepNameInput.style.borderColor = '';
                if (stepNameError) { stepNameError.textContent = ''; stepNameError.style.display = 'none'; }
            };

            stepNameInput.addEventListener('change', (e) => {
                const raw = e.target.value;
                const error = validateElementName(raw, stepUUID);
                if (error) {
                    e.target.value = step.name;
                    showStepNameError(error);
                    return;
                }

                clearStepNameError();
                step.name = raw;

                // Update display text on canvas
                const stepElement = document.querySelector(`[data-step-uuid="${stepUUID}"]`);
                if (stepElement) {
                    const contentArea = stepElement.querySelector('[data-content-area]');
                    const label = contentArea ? contentArea.firstElementChild : null;
                    if (label) label.textContent = step.name;

                    // Measure text width with a temporary element at the correct font size
                    let requiredWidth = STEP_MIN_W;
                    const tempDiv = document.createElement('div');
                    tempDiv.style.cssText = `position: absolute; visibility: hidden; font-size: ${Math.round(GU / 3)}px; white-space: nowrap;`;
                    tempDiv.textContent = step.name;
                    document.body.appendChild(tempDiv);
                    const textWidth = tempDiv.offsetWidth;
                    document.body.removeChild(tempDiv);

                    if (textWidth > STEP_MIN_W - GU - BORDER * 2) {
                        const gridSpaces = Math.ceil((textWidth - (STEP_MIN_W - GU - BORDER * 2)) / GU);
                        requiredWidth = STEP_MIN_W + (gridSpaces * GU);
                    }

                    if (requiredWidth !== parseInt(stepElement.style.width)) {
                        stepElement.style.width = requiredWidth + 'px';
                        step.width = requiredWidth / GU;
                        updateConnectedLines(stepUUID, 'step');
                    }
                }
                updatePreview();
            });
        }
        
        // Get form elements that will be used
        const pluginTypeInput = container.querySelector('#stepPluginType');
        const stepActionInput = container.querySelector('#stepAction');
        
        // Kore step action dropdown handler - populate from util steps
        if (isKoreType && stepActionInput) {
            (async () => {
                try {
                    // Get cached util steps
                    const utils = await fetchUtilSteps();
                    
                    // Clear existing options and add None
                    stepActionInput.innerHTML = '<option value="None">None</option>';
                    
                    // Add each util step as an option
                    utils.forEach(util => {
                        const option = document.createElement('option');
                        option.value = util.action_name;
                        option.textContent = util.display_name || util.action_name;
                        if (step.action === util.action_name) {
                            option.selected = true;
                        }
                        stepActionInput.appendChild(option);
                    });
                    
                    console.log('[Kore Actions] Populated dropdown with', utils.length, 'actions');
                } catch (error) {
                    console.error('[Kore Actions] Error loading util steps:', error);
                    stepActionInput.innerHTML = '<option value="None">None</option>';
                }
                
                // If an action was already selected, load its inputs
                if (step.action && step.action !== 'None') {
                    setTimeout(async () => {
                        await loadKoreActionInputs(step.action, container);
                    }, 100);
                }
            })();
            
            // Save action selection when changed
            stepActionInput.addEventListener('change', async (e) => {
                step.action = e.target.value === 'None' ? null : e.target.value;
                step.actionInputs = [];
                await loadKoreActionInputs(step.action, container);
                updatePreview();
            });
        }
        
        // Plugin Type field handler - load plugins and populate Actions on change
        
        if (pluginTypeInput) {
            // Load plugins when panel loads
            (async () => {
                try {
                    if (typeof listPlugins === 'function') {
                        // Ensure sessionToken is set from cookie
                        window.sessionToken = getSessionTokenFromCookie();
                        
                        const plugins = await listPlugins();
                        pluginTypeInput.innerHTML = '<option value="">-- Select Plugin --</option>';
                        
                        plugins.forEach(plugin => {
                            const option = document.createElement('option');
                            option.value = plugin.name;
                            option.textContent = plugin.display_name || plugin.name;
                            if (step.pluginType === plugin.name) {
                                option.selected = true;
                            }
                            pluginTypeInput.appendChild(option);
                        });
                        
                        // If a plugin was already selected, load its tasks
                        if (step.pluginType) {
                            await loadPluginTasks(step.pluginType);
                            
                            // Set the action dropdown value if one was selected
                            if (step.action && stepActionInput) {
                                stepActionInput.value = step.action;
                                stepActionInput.disabled = false;
                            }
                            
                            // If an action was also selected, load its inputs
                            if (step.action) {
                                const taskInputsContainer = container.querySelector('#taskInputsContainer');
                                if (taskInputsContainer) {
                                    setTimeout(() => {
                                        loadTaskInputs(step.action, taskInputsContainer);
                                        taskInputsContainer.style.display = 'block';
                                    }, 100); // Small delay to ensure DOM is ready
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error loading plugins:', error);
                    pluginTypeInput.innerHTML = '<option value="">Error loading plugins</option>';
                }
            })();
            
            // When plugin is selected, load its tasks
            pluginTypeInput.addEventListener('change', async (e) => {
                step.pluginType = e.target.value;
                step.taskInputs = []; // Clear saved task inputs
                
                // Clear task inputs when plugin changes
                const taskInputsContainer = container.querySelector('#taskInputsContainer');
                if (taskInputsContainer) {
                    const taskInputsContent = taskInputsContainer.querySelector('#taskInputsContent');
                    if (taskInputsContent) {
                        taskInputsContent.innerHTML = '';
                    }
                    taskInputsContainer.style.display = 'none';
                }
                
                if (step.pluginType) {
                    stepActionInput.disabled = false;
                    stepActionInput.innerHTML = '<option value="">Loading actions...</option>';
                    await loadPluginTasks(step.pluginType);
                } else {
                    // Disable and clear action dropdown if no plugin selected
                    stepActionInput.disabled = true;
                    stepActionInput.innerHTML = '<option value="">-- Select Plugin First --</option>';
                }
                updatePreview();
            });
        }
        
        // Helper function to load tasks for a plugin
        async function loadPluginTasks(pluginName) {
            try {
                if (typeof getPluginTasks === 'function' && stepActionInput) {
                    // Ensure sessionToken is set from cookie
                    window.sessionToken = getSessionTokenFromCookie();
                    
                    console.log('[loadPluginTasks] Loading tasks for plugin:', pluginName);
                    const tasks = await getPluginTasks(pluginName);
                    console.log('[loadPluginTasks] Tasks received:', tasks);
                    
                    stepActionInput.innerHTML = '<option value="">-- Select Action --</option>';
                    
                    if (!tasks || tasks.length === 0) {
                        console.warn('[loadPluginTasks] No tasks found for plugin:', pluginName);
                        stepActionInput.innerHTML = '<option value="">No actions available</option>';
                        return;
                    }
                    
                    tasks.forEach(task => {
                        const option = document.createElement('option');
                        option.value = task.task_id;
                        option.textContent = task.display_name;
                        if (step.action === task.task_id) {
                            option.selected = true;
                        }
                        stepActionInput.appendChild(option);
                    });
                } else {
                    console.error('[loadPluginTasks] getPluginTasks not available or stepActionInput not found');
                }
            } catch (error) {
                console.error('[loadPluginTasks] Error:', error);
                if (stepActionInput) {
                    stepActionInput.innerHTML = '<option value="">Error loading actions</option>';
                }
            }
        }
        
        if (stepActionInput) {
            stepActionInput.addEventListener('change', async (e) => {
                step.action = e.target.value;
                step.taskInputs = []; // Clear saved task inputs
                const taskInputsContainer = container.querySelector('#taskInputsContainer');
                
                if (step.action && taskInputsContainer) {
                    // Load and render task inputs
                    await loadTaskInputs(step.action, taskInputsContainer);
                    taskInputsContainer.style.display = 'block';
                } else if (taskInputsContainer) {
                    taskInputsContainer.style.display = 'none';
                    const taskInputsContent = taskInputsContainer.querySelector('#taskInputsContent');
                    if (taskInputsContent) {
                        taskInputsContent.innerHTML = '';
                    }
                }
                
                updatePreview();
            });
        }
        
        // ---------------------------------------------------------------
        // WORKFLOW STEP: helper functions
        // ---------------------------------------------------------------

        /**
         * Render input mapping fields from a workflow's inputVariables array
         */
        /**
         * Render Kore action input fields HTML — mirrors renderWorkflowInputsHtml
         */
        function renderKoreInputsHtml(inputs) {
            if (!inputs || inputs.length === 0) return '';
            let html = '<div id="koreInputs" class="panel-level-3">';
            inputs.forEach(input => {
                const name = input.name;
                const required = input.required ? ' <span style="color:#ff6666;">*</span>' : '';
                if (input.type === 'boolean') {
                    html += `<div class="form-group--inline"><input type="checkbox" id="${name}"><label for="${name}">${escapeHtml(input.label || name)}${required}</label></div>`;
                } else if (input.type === 'number') {
                    html += `<div class="form-group"><label for="${name}">${escapeHtml(input.label || name)}${required}</label><input type="number" id="${name}" placeholder="${escapeHtml(input.label || name)}"></div>`;
                } else {
                    html += `<div class="form-group"><label for="${name}">${escapeHtml(input.label || name)}${required}</label><input type="text" id="${name}" placeholder="${escapeHtml(input.label || name)}"></div>`;
                }
            });
            html += '</div>';
            return html;
        }

        /**
         * Load Kore action input fields — mirrors loadWorkflowInputs pattern
         */
        async function loadKoreActionInputs(actionName, container) {
            const inputsContainer = container.querySelector('#koreActionInputsContainer');
            const inputsContent = container.querySelector('#koreActionInputsContent');
            if (!inputsContainer || !inputsContent) return;

            if (!actionName || actionName === 'None') {
                inputsContainer.style.display = 'none';
                inputsContent.innerHTML = '';
                return;
            }

            const actionConfig = await getUtilStep(actionName);
            const inputs = actionConfig?.action_config?.inputs || [];

            if (inputs.length === 0) {
                inputsContainer.style.display = 'none';
                inputsContent.innerHTML = '';
                return;
            }

            // Normalize actionInputs to array (backward compat with old object format)
            if (!step.actionInputs || !Array.isArray(step.actionInputs)) {
                const oldObj = step.actionInputs || {};
                step.actionInputs = inputs.map(i => ({ name: i.name, value: oldObj[i.name] || '' }));
            }
            // Ensure all inputs have an entry
            inputs.forEach(i => {
                if (!step.actionInputs.find(e => e.name === i.name)) {
                    step.actionInputs.push({ name: i.name, value: '' });
                }
            });

            // Render using form-group pattern
            inputsContent.innerHTML = renderKoreInputsHtml(inputs);

            // Restore saved values and attach change listeners BEFORE injecting buttons
            // (injectStepInputEditButtons needs values in fields to detect jinja logic)
            inputs.forEach(i => {
                const field = inputsContent.querySelector('#' + i.name);
                if (!field) return;
                const entry = step.actionInputs.find(e => e.name === i.name);
                if (entry && entry.value !== undefined) {
                    if (i.type === 'boolean') field.checked = !!entry.value;
                    else field.value = entry.value;
                }
                field.addEventListener('change', (e) => {
                    const ent = step.actionInputs.find(en => en.name === i.name);
                    if (ent) ent.value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                    updatePreview();
                });
            });

            const inputDefs = inputs.map(i => ({ name: i.name, label: i.label || i.name, type: i.type || 'text' }));
            injectStepInputEditButtons(inputsContent, inputDefs, step.id, 'actionInputs');
            attachStepInputEditButtonListeners(inputsContent, inputDefs, step.id, 'actionInputs');

            inputsContainer.style.display = 'block';
        }

        function renderWorkflowInputsHtml(inputVariables) {
            if (!inputVariables || inputVariables.length === 0) {
                return '<div class="panel-level-3" style="font-size: 0.8rem; color: #707070; padding: 4px 0;">No input variables defined on this workflow.</div>';
            }
            let html = '<div id="workflowInputs" class="panel-level-3">';
            inputVariables.forEach(v => {
                const name = v.name;
                html += '<div class="form-group">';
                html += '<label for="' + name + '">' + escapeHtml(name) + '</label>';
                html += '<input type="text" id="' + name + '" placeholder="' + escapeHtml(v.value || '') + '">';
                html += '</div>';
            });
            html += '</div>';
            return html;
        }

        /**
         * Load workflow input mapping fields into the container
         */
        async function loadWorkflowInputs(workflowId, container) {
            try {
                const contentDiv = container.querySelector('#workflowInputsContent');
                if (!contentDiv) return;

                // Find workflow from already-fetched list (avoid re-fetch)
                const select = document.querySelector('#stepAction');
                const selectedOption = select ? select.querySelector('option[value="' + workflowId + '"]') : null;
                let inputVariables = [];

                if (selectedOption && selectedOption._definition) {
                    inputVariables = selectedOption._definition.inputVariables || [];
                } else {
                    // Fallback: fetch individually
                    const sessionToken = window.sessionToken || getSessionTokenFromCookie();
                    const response = await fetch('/kore/workflows/' + workflowId, {
                        headers: { 'Content-Type': 'application/json', ...(sessionToken && { 'X-Session-Token': sessionToken }) }
                    });
                    if (response.ok) {
                        const data = await response.json();
                        inputVariables = data.definition?.inputVariables || [];
                    }
                }

                // Render fields
                contentDiv.innerHTML = renderWorkflowInputsHtml(inputVariables);

                // Build inputs array in same shape as taskInputs for reuse of helpers
                const inputDefs = inputVariables.map(v => ({ name: v.name, label: v.name, type: 'text' }));

                // Initialize workflowInputs with defaults if not set
                if (!step.workflowInputs) step.workflowInputs = [];
                inputVariables.forEach(v => {
                    if (!step.workflowInputs.find(i => i.name === v.name)) {
                        step.workflowInputs.push({ name: v.name, value: v.value || '' });
                    }
                });

                // Restore saved values
                inputVariables.forEach(v => {
                    const input = contentDiv.querySelector('#' + v.name);
                    if (!input) return;
                    const entry = step.workflowInputs.find(i => i.name === v.name);
                    if (entry && entry.value) input.value = entry.value;
                });

                // Inject edit buttons, attach listeners — using workflowInputs storage key
                injectStepInputEditButtons(contentDiv, inputDefs, step.id, 'workflowInputs');
                attachStepInputListeners(contentDiv, inputDefs, 'workflowInputs');
                attachStepInputEditButtonListeners(contentDiv, inputDefs, step.id, 'workflowInputs');

                container.style.display = 'block';
            } catch (error) {
                console.error('[loadWorkflowInputs] Error:', error);
                const contentDiv = container.querySelector('#workflowInputsContent');
                if (contentDiv) contentDiv.innerHTML = '<div style="color: #ff6b6b; font-size: 0.85rem;">Error loading workflow inputs</div>';
            }
        }

        // Trigger selection for Workflow-type steps. Persephone's execution API
        // (/engine/execute) already accepts a flat `triggerId` — this stores the
        // same shape directly on the step (step.triggerId, a plain string), NOT
        // wrapped in an array-of-{name,value} the way taskInputs/workflowInputs
        // are, since it's a single value rather than multiple named fields.
        // Supports both a dropdown pick (a real trigger id) and a Jinja template
        // (e.g. deciding the trigger dynamically based on CTX), matching the same
        // dropdown-or-{ }-button pattern used for taskInputs/workflowInputs.
        function loadWorkflowTriggers(workflowId, container) {
            const triggerContainer = container.querySelector('#stepTriggerContainer');
            const triggerSelect = container.querySelector('#stepTrigger');
            if (!triggerContainer || !triggerSelect) return;

            const select = document.querySelector('#stepAction');
            const selectedOption = select ? select.querySelector('option[value="' + workflowId + '"]') : null;
            const triggers = (selectedOption && selectedOption._definition && selectedOption._definition.triggers) || [];

            const currentValue = step.triggerId || '';
            const isJinja = currentValue && (currentValue.includes('{{') || currentValue.includes('{%'));
            const matchesRealTrigger = !isJinja && triggers.some(t => t.id === currentValue);

            triggerSelect.innerHTML = '<option value="">-- Default --</option>';
            triggers.forEach(t => {
                const option = document.createElement('option');
                option.value = t.id;
                option.textContent = t.name || t.id;
                triggerSelect.appendChild(option);
            });

            if (isJinja) {
                // Jinja-templated trigger selection: show the raw value as a single
                // fixed option, same convention injectStepInputEditButtons uses for
                // select-type task/workflow inputs carrying a Jinja value.
                triggerSelect.innerHTML = '';
                const jinjaOption = document.createElement('option');
                jinjaOption.value = currentValue;
                jinjaOption.textContent = currentValue;
                triggerSelect.appendChild(jinjaOption);
                triggerSelect.value = currentValue;
            } else if (matchesRealTrigger) {
                triggerSelect.value = currentValue;
            }

            triggerContainer.style.display = triggers.length > 0 ? 'block' : 'none';
        }

        // Workflow step: populate workflow dropdown and wire all controls
        if (isWorkflowType && stepActionInput) {
            (async () => {
                try {
                    const sessionToken = window.sessionToken || getSessionTokenFromCookie();
                    const response = await fetch('/kore/workflows', {
                        headers: { 'Content-Type': 'application/json', ...(sessionToken && { 'X-Session-Token': sessionToken }) }
                    });
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    const data = await response.json();
                    const workflows = data.workflows || [];

                    stepActionInput.innerHTML = '<option value="">-- Select Workflow --</option>';
                    workflows.forEach(wf => {
                        const option = document.createElement('option');
                        option.value = wf.id;
                        option.textContent = wf.name;
                        option._definition = wf.definition; // stash for input loading
                        if (step.action === wf.id) option.selected = true;
                        stepActionInput.appendChild(option);
                    });

                    // If workflow already selected, load its inputs
                    if (step.action) {
                        const workflowInputsContainer = container.querySelector('#workflowInputsContainer');
                        if (workflowInputsContainer) {
                            await loadWorkflowInputs(step.action, workflowInputsContainer);
                        }
                        loadWorkflowTriggers(step.action, container);
                    }
                } catch (error) {
                    console.error('[Workflow step] Error loading workflows:', error);
                    stepActionInput.innerHTML = '<option value="">Error loading workflows</option>';
                }
            })();

            // Workflow selection change
            stepActionInput.addEventListener('change', async (e) => {
                step.action = e.target.value;
                step.workflowInputs = [];
                step.triggerId = '';
                const workflowInputsContainer = container.querySelector('#workflowInputsContainer');
                if (step.action && workflowInputsContainer) {
                    await loadWorkflowInputs(step.action, workflowInputsContainer);
                } else if (workflowInputsContainer) {
                    workflowInputsContainer.style.display = 'none';
                    const contentDiv = workflowInputsContainer.querySelector('#workflowInputsContent');
                    if (contentDiv) contentDiv.innerHTML = '';
                }
                if (step.action) {
                    loadWorkflowTriggers(step.action, container);
                } else {
                    const triggerContainer = container.querySelector('#stepTriggerContainer');
                    if (triggerContainer) triggerContainer.style.display = 'none';
                }
                updatePreview();
            });

            // Trigger selection change
            const stepTriggerSelect = container.querySelector('#stepTrigger');
            if (stepTriggerSelect) {
                stepTriggerSelect.addEventListener('change', (e) => {
                    step.triggerId = e.target.value;
                    updatePreview();
                });
            }

            // Trigger { } edit button — switch to a Jinja-templated trigger selection
            const stepTriggerEditBtn = container.querySelector('#stepTriggerEditBtn');
            if (stepTriggerEditBtn) {
                stepTriggerEditBtn.addEventListener('click', () => {
                    const currentValue = step.triggerId || '';
                    openWorkflowJinjaEditorModal('Edit Trigger', currentValue, (value) => {
                        step.triggerId = value;
                        if (step.action) {
                            loadWorkflowTriggers(step.action, container);
                        }
                        updatePreview();
                    }, step.id, undefined, 'input');
                });
            }
        }

        // Loop Mode listeners — shared by Workflow and Plugin steps
        if (isWorkflowType || isPluginType) {
            // Loop Mode checkbox
            const loopModeCheckbox = container.querySelector('#loopModeCheckbox');
            const loopConfigContainer = container.querySelector('#loopConfigContainer');
            if (loopModeCheckbox) {
                loopModeCheckbox.addEventListener('change', (e) => {
                    step.loopMode = e.target.checked;
                    if (e.target.checked && !step.loopConfig) {
                        step.loopConfig = {
                            sourceArray: '',
                            executionMode: 'concurrent',
                            maxConcurrent: 1,
                            onItemFailure: 'continue'
                        };
                    }
                    if (loopConfigContainer) loopConfigContainer.style.display = e.target.checked ? 'flex' : 'none';
                    updatePreview();
                });
            }

            // Source Array field
            const loopSourceArray = container.querySelector('#loopSourceArray');
            if (loopSourceArray) {
                loopSourceArray.addEventListener('change', (e) => {
                    if (!step.loopConfig) step.loopConfig = {};
                    step.loopConfig.sourceArray = e.target.value;
                    updatePreview();
                });
            }

            // Source Array { } edit button
            const loopSourceArrayEditBtn = container.querySelector('#loopSourceArrayEditBtn');
            if (loopSourceArrayEditBtn) {
                loopSourceArrayEditBtn.addEventListener('click', () => {
                    const currentValue = step.loopConfig?.sourceArray || '';
                    openWorkflowJinjaEditorModal('Edit Source Array', currentValue, (value) => {
                        if (!step.loopConfig) step.loopConfig = {};
                        step.loopConfig.sourceArray = value;
                        if (loopSourceArray) {
                            loopSourceArray.value = value || '';
                        }
                        updatePreview();
                    }, step.id);
                });
            }

            // Execution Mode
            const loopExecutionMode = container.querySelector('#loopExecutionMode');
            const maxConcurrentContainer = container.querySelector('#maxConcurrentContainer');
            if (loopExecutionMode) {
                loopExecutionMode.addEventListener('change', (e) => {
                    if (!step.loopConfig) step.loopConfig = {};
                    step.loopConfig.executionMode = e.target.value;
                    if (maxConcurrentContainer) {
                        maxConcurrentContainer.style.display = e.target.value === 'sequential' ? 'none' : 'block';
                    }
                    updatePreview();
                });
            }

            // Max Concurrent
            const loopMaxConcurrent = container.querySelector('#loopMaxConcurrent');
            if (loopMaxConcurrent) {
                loopMaxConcurrent.addEventListener('change', (e) => {
                    if (!step.loopConfig) step.loopConfig = {};
                    step.loopConfig.maxConcurrent = Math.max(1, parseInt(e.target.value) || 1);
                    e.target.value = step.loopConfig.maxConcurrent;
                    updatePreview();
                });
            }

            // On Item Failure
            const loopOnItemFailure = container.querySelector('#loopOnItemFailure');
            if (loopOnItemFailure) {
                loopOnItemFailure.addEventListener('change', (e) => {
                    if (!step.loopConfig) step.loopConfig = {};
                    step.loopConfig.onItemFailure = e.target.value;
                    updatePreview();
                });
            }
        }

        // Helper function to load task details and render inputs
        async function loadTaskInputs(taskId, container) {
            try {
                console.log('[loadTaskInputs] Container:', container);
                console.log('[loadTaskInputs] Looking for #taskInputsContent in container');
                if (typeof getTaskDetails === 'function') {
                    // Ensure sessionToken is set from cookie
                    window.sessionToken = getSessionTokenFromCookie();
                    
                    console.log('[loadTaskInputs] Fetching task details for task_id:', taskId);
                    const task = await getTaskDetails(taskId);
                    console.log('[loadTaskInputs] Task received:', task);
                    
                    if (typeof renderTaskInputsHtml === 'function') {
                        const inputsHtml = renderTaskInputsHtml(task.inputs, task, null);
                        console.log('[loadTaskInputs] Task inputs:', task.inputs);
                        console.log('[loadTaskInputs] Task object:', task);
                        console.log('[loadTaskInputs] Generated HTML length:', inputsHtml.length);
                        console.log('[loadTaskInputs] Generated HTML:', inputsHtml);
                        const contentDiv = container.querySelector('#taskInputsContent');
                        console.log('[loadTaskInputs] contentDiv result:', contentDiv);
                        if (contentDiv) {
                            console.log('[loadTaskInputs] contentDiv found, setting innerHTML');
                            contentDiv.innerHTML = inputsHtml;
                            console.log('[loadTaskInputs] contentDiv innerHTML set');
                            
                            // Initialize step.taskInputs with all inputs using their defaults
                            if (!step.taskInputs) {
                                step.taskInputs = [];
                            }
                            
                            task.inputs.forEach(input => {
                                // Check if entry already exists
                                let entry = step.taskInputs.find(t => t.name === input.name);
                                if (!entry) {
                                    // Create new entry with default value
                                    entry = {
                                        name: input.name,
                                        value: input.default !== undefined ? input.default : ''
                                    };
                                    step.taskInputs.push(entry);
                                }
                            });
                            
                            console.log('[loadTaskInputs] Initialized taskInputs:', step.taskInputs);
                            
                            // Restore previously saved values FIRST (before injecting buttons)
                            if (step.taskInputs && Array.isArray(step.taskInputs)) {
                                contentDiv.querySelectorAll('input, select, textarea').forEach((input, idx) => {
                                    // Find the corresponding task input definition
                                    const inputDef = task.inputs[idx];
                                    if (!inputDef) return;
                                    
                                    // Find saved value in array
                                    const entry = step.taskInputs.find(t => t.name === inputDef.name);
                                    if (entry) {
                                        if (input.type === 'checkbox') {
                                            input.checked = entry.value;
                                        } else if (input.type === 'radio') {
                                            input.checked = input.value === entry.value;
                                        } else {
                                            input.value = entry.value;
                                        }
                                    }
                                });
                            }
                            
                            // NOW inject Variable Edit buttons (so they can detect jinja logic)
                            injectStepInputEditButtons(contentDiv, task.inputs, step.id);
                            
                            // Attach event listeners to step inputs
                            attachStepInputListeners(contentDiv, task.inputs);
                            
                            // Attach event listeners to Variable Edit buttons
                            attachStepInputEditButtonListeners(contentDiv, task.inputs, step.id);
                        } else {
                            console.log('[loadTaskInputs] ERROR: contentDiv not found!');
                        }
                    }
                }
            } catch (error) {
                console.error('[loadTaskInputs] Error:', error);
                container.innerHTML = '<p style="color: #ff6b6b; font-size: 0.85rem;">Error loading task inputs</p>';
            }
        }
        
        // Helper function to inject Variable Edit buttons into step inputs
        function injectStepInputEditButtons(container, inputs, stepId, storageKey = 'taskInputs') {
            inputs.forEach((input, inputIndex) => {
                const inputId = input.name;
                
                // Check if this input has a jinja logic value
                let hasJinjaLogic = false;
                if (step[storageKey] && Array.isArray(step[storageKey])) {
                    const entry = step[storageKey].find(t => t.name === inputId);
                    if (entry && entry.value && (typeof entry.value === 'string' && (entry.value.includes('{{') || entry.value.includes('{%')))) {
                        hasJinjaLogic = true;
                    }
                }
                
                // Create edit button
                const editBtn = document.createElement('button');
                editBtn.className = 'btn var-edit-btn';
                editBtn.setAttribute('data-size', 'sm');
                editBtn.setAttribute('data-color', 'blue');
                editBtn.setAttribute('data-var-idx', inputIndex);
                editBtn.setAttribute('title', 'Edit variable');
                editBtn.textContent = '{ }';
                editBtn.style.cssText = 'padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;';
                
                const controlElement = container.querySelector(`#${inputId}`);
                
                if (input.type === 'checkbox' || input.type === 'boolean') {
                    // For checkbox: find the form-group--inline and add button to it
                    const inlineGroup = container.querySelector(`#${inputId}`).closest('.form-group--inline');
                    if (inlineGroup) {
                        inlineGroup.appendChild(editBtn);
                    }
                    // A checkbox's native checked/unchecked state has no way to represent
                    // an arbitrary Jinja template string -- unlike the select/text branches
                    // below, this previously had no hasJinjaLogic handling at all, so a
                    // templated value (e.g. "{{ CTX.show_inactive | d(false) }}") just
                    // silently rendered as an ordinary checked/unchecked toggle with zero
                    // indication anything was templated. Toggling it in that state
                    // overwrites the template with a plain boolean, with no visible warning.
                    // Disable the checkbox and show the raw template text instead, same
                    // spirit as the select branch replacing its dropdown with a single
                    // option showing the raw value.
                    if (hasJinjaLogic) {
                        const entry = step[storageKey].find(t => t.name === inputId);
                        const displayVal = entry?.value || '';
                        if (controlElement) {
                            controlElement.disabled = true;
                            controlElement.checked = false;
                        }
                        if (inlineGroup && !inlineGroup.querySelector('.jinja-value-label')) {
                            const jinjaLabel = document.createElement('span');
                            jinjaLabel.className = 'jinja-value-label';
                            jinjaLabel.textContent = displayVal;
                            jinjaLabel.style.cssText = 'font-family: monospace; font-size: 0.75rem; color: #b0b0b0; margin-left: 8px;';
                            jinjaLabel.title = 'This value is a Jinja template, not a plain checkbox -- use the { } button to edit it.';
                            inlineGroup.insertBefore(jinjaLabel, editBtn);
                        }
                    }
                } else if (input.type === 'radio') {
                    // For radio: find the fieldset and add button after it
                    const fieldset = container.querySelector(`input[name="${inputId}"]`).closest('fieldset');
                    if (fieldset) {
                        const wrapper = document.createElement('div');
                        wrapper.style.marginTop = '8px';
                        wrapper.appendChild(editBtn);
                        fieldset.parentNode.insertBefore(wrapper, fieldset.nextSibling);
                    }
                } else {
                    // For text, textarea, number, select: find the form-group and process
                    if (controlElement) {
                        const formGroup = controlElement.closest('.form-group');
                        
                        if (input.type === 'select') {
                            // For select: replace options if jinja logic exists
                            const select = controlElement;
                            if (hasJinjaLogic) {
                                const entry = step[storageKey].find(t => t.name === inputId);
                                const displayVal = entry?.value || '';
                                select.innerHTML = '';
                                const selectOption = document.createElement('option');
                                selectOption.value = displayVal;
                                selectOption.textContent = displayVal;
                                select.appendChild(selectOption);
                                select.value = displayVal;
                            }
                            
                            // Wrap select with button in flex container
                            const wrapper = document.createElement('div');
                            wrapper.style.cssText = 'display: flex; gap: 8px; align-items: center;';
                            select.parentNode.insertBefore(wrapper, select);
                            wrapper.appendChild(select);
                            wrapper.appendChild(editBtn);
                            select.style.flex = '1';
                        } else {
                            // For text, textarea, number: wrap with button in flex container
                            const wrapper = document.createElement('div');
                            wrapper.style.cssText = 'display: flex; gap: 8px; align-items: center;';
                            
                            if (input.type === 'textarea') {
                                wrapper.style.alignItems = 'flex-start';
                            }
                            
                            controlElement.parentNode.insertBefore(wrapper, controlElement);
                            wrapper.appendChild(controlElement);
                            wrapper.appendChild(editBtn);
                            controlElement.style.flex = '1';
                            
                            // If jinja logic exists, switch number fields to text and show value
                            if (hasJinjaLogic) {
                                if (controlElement.type === 'number') controlElement.type = 'text';
                                const entry = step[storageKey].find(t => t.name === inputId);
                                controlElement.value = entry?.value || '';
                            }
                        }
                    }
                }
            });
        }
        function attachStepInputListeners(container, taskInputs, storageKey = 'taskInputs') {
            container.querySelectorAll('input, select, textarea').forEach((input, idx) => {
                input.addEventListener('change', (e) => {
                    if (!step[storageKey]) {
                        step[storageKey] = [];
                    }
                    
                    const inputDef = taskInputs[idx];
                    if (!inputDef) return;
                    
                    let entry = step[storageKey].find(t => t.name === inputDef.name);
                    if (!entry) {
                        entry = { name: inputDef.name, value: '' };
                        step[storageKey].push(entry);
                    }
                    
                    if (e.target.type === 'checkbox') {
                        entry.value = e.target.checked;
                    } else {
                        entry.value = e.target.value;
                    }
                    
                    updatePreview();
                });
            });
        }
        
        // Helper function to attach event listeners to Variable Edit buttons for step inputs
        function attachStepInputEditButtonListeners(container, inputs, stepId, storageKey = 'taskInputs') {
            container.querySelectorAll('.var-edit-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const inputIndex = parseInt(btn.getAttribute('data-var-idx'));
                    const inputDef = inputs[inputIndex];
                    if (!inputDef) return;
                    
                    const inputId = inputDef.name;
                    
                    let currentValue = '';
                    if (step[storageKey] && Array.isArray(step[storageKey])) {
                        const entry = step[storageKey].find(t => t.name === inputId);
                        if (entry) currentValue = entry.value;
                    }
                    
                    openWorkflowJinjaEditorModal(
                        `Edit Input: ${inputDef.label || inputDef.name}`,
                        currentValue,
                        (value) => {
                            if (!step[storageKey]) step[storageKey] = [];
                            
                            let entry = step[storageKey].find(t => t.name === inputId);
                            if (!entry) {
                                entry = { name: inputId, value: '' };
                                step[storageKey].push(entry);
                            }
                            entry.value = value;
                            
                            const inputField = container.querySelector(`#${inputId}`);
                            if (inputField) {
                                if (inputDef.type === 'select') {
                                    if (value) {
                                        inputField.innerHTML = '';
                                        const selectOption = document.createElement('option');
                                        selectOption.value = value;
                                        selectOption.textContent = value;
                                        inputField.appendChild(selectOption);
                                        inputField.value = value;
                                    }
                                } else {
                                    if (inputDef.type !== 'checkbox' && inputDef.type !== 'boolean') {
                                        if (inputField.type === 'number' && value && (value.includes('{{') || value.includes('{%'))) {
                                            inputField.type = 'text';
                                        }
                                        inputField.value = value || '';
                                    }
                                }
                            }
                            
                            updatePreview();
                        },
                        stepId,
                        undefined,
                        'input'
                    );
                });
            });
        }
        
        // Variable input handlers
        container.querySelectorAll('[data-var-field]').forEach(input => {
            input.addEventListener('change', (e) => {
                const idx = parseInt(e.target.getAttribute('data-var-idx'));
                const field = e.target.getAttribute('data-var-field');
                step.variables[idx][field] = e.target.value;
                updatePreview();
            });
        });
        
        // Variable edit buttons
        container.querySelectorAll('.var-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.getAttribute('data-var-idx'));
                const currentValue = step.variables[idx].value || '';
                const varName = step.variables[idx].name || 'Variable';
                const modalTitle = `Edit: ${varName}`;
                
                openWorkflowJinjaEditorModal(modalTitle, currentValue, (value) => {
                    step.variables[idx].value = value;
                    container.querySelector(`[data-var-idx="${idx}"][data-var-field="value"]`).value = value;
                    updatePreview();
                }, step.id);
            });
        });
        
        // Delete variable button
        container.querySelectorAll('.var-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.getAttribute('data-var-idx'));
                showDeleteConfirm('Delete this variable?', () => {
                    step.variables.splice(idx, 1);
                    showStepProperties(stepUUID); // Refresh to remove deleted variable
                    updatePreview();
                });
            });
        });
        
        // Render output variables using shared renderStepOutputVariables
        const variablesContainer = container.querySelector('#variablesContainer');
        if (variablesContainer) {
            renderStepOutputVariables(variablesContainer, step.variables || [], () => updatePreview());
        }

        // Render read-only summary of this step's own transition cases' variables.
        // The whole section is omitted from the HTML entirely when there are none
        // (see hasCaseVariables above), so this container only exists when there's
        // something to show.
        const caseVariablesSummaryContainer = container.querySelector('#caseVariablesSummaryContainer');
        if (caseVariablesSummaryContainer) {
            caseVariablesSummaryContainer.innerHTML = stepCasesWithVars.map(c => {
                const label = c.name || c.type || 'Case';
                const rows = c.variables.map(v => `
                    <div style="display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; font-size: 0.75rem; color: #b0b0b0;">
                        <span style="color: #8fbfdd; white-space: nowrap;">${escapeHtml(v.name || '')}</span>
                        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;">${escapeHtml(v.value || '')}</span>
                    </div>
                `).join('');
                return `
                    <div class="panel-level-3" style="margin-bottom: 8px; padding: 6px 8px; cursor: ${c._conditionId ? 'pointer' : 'default'};" ${c._conditionId ? `data-jump-case-id="${c._conditionId}"` : ''}>
                        <div style="font-size: 0.75rem; font-weight: 600; color: #d0d0d0;">${escapeHtml(label)} <span style="font-weight: normal; color: #707070;">(${c.type})</span></div>
                        ${rows}
                    </div>
                `;
            }).join('');

            // Clicking a case jumps to that case's own properties panel for editing.
            caseVariablesSummaryContainer.querySelectorAll('[data-jump-case-id]').forEach(el => {
                el.addEventListener('click', () => {
                    showTransitionProperties(el.getAttribute('data-jump-case-id'));
                });
            });
        }

        // Add variable button
        const addVariableBtn = container.querySelector('#addVariableBtn');
        if (addVariableBtn) {
            addVariableBtn.addEventListener('click', () => {
                step.variables.push({ name: '', value: '', order: step.variables.length });
                showStepProperties(stepUUID); // Refresh to show new variable
                updatePreview();
            });
        }
        
        // Add event listeners for size override
        const minConnectionsInput = container.querySelector('#stepMinConnections');
        if (minConnectionsInput) {
            minConnectionsInput.addEventListener('change', (e) => {
                const rawValue = e.target.value;
                // A Jinja value typed/pasted directly into this field (now
                // type="text" once the { } editor set one) must be stored as-is,
                // not force-coerced through parseInt -- parseInt("{{ ... }}") is
                // NaN, which previously silently reset min_connections to 0,
                // destroying the dynamic expression.
                if (typeof rawValue === 'string' && (rawValue.includes('{{') || rawValue.includes('{%'))) {
                    step.min_connections = rawValue;
                } else {
                    const val = parseInt(rawValue);
                    step.min_connections = isNaN(val) || val < 0 ? 0 : val;
                    e.target.value = step.min_connections;
                }
                updatePreview();
            });
        }
        
        const stepMinConnectionsEditBtn = container.querySelector('#stepMinConnectionsEditBtn');
        if (stepMinConnectionsEditBtn) {
            stepMinConnectionsEditBtn.addEventListener('click', () => {
                const currentValue = (step.min_connections !== undefined && step.min_connections !== null) ? String(step.min_connections) : '';
                openWorkflowJinjaEditorModal('Edit Min Inbound Connections', currentValue, (value) => {
                    // Store as a plain number when the saved value is purely
                    // numeric (matching how this field is stored everywhere
                    // else when static), otherwise keep it as the Jinja string.
                    const trimmed = (value || '').trim();
                    const isJinja = trimmed.includes('{{') || trimmed.includes('{%');
                    if (!isJinja && trimmed !== '' && !isNaN(Number(trimmed))) {
                        step.min_connections = Math.max(0, parseInt(trimmed, 10));
                    } else {
                        step.min_connections = trimmed;
                    }
                    if (minConnectionsInput) {
                        minConnectionsInput.type = isJinja ? 'text' : 'number';
                        minConnectionsInput.value = step.min_connections ?? 0;
                    }
                    updatePreview();
                }, step.id);
            });
        }
        
        const transitionModeSelect = container.querySelector('#transitionModeSelect');
        if (transitionModeSelect) {
            transitionModeSelect.addEventListener('change', (e) => {
                if (!step.transition) step.transition = { mode: 'First', cases: [] };
                step.transition.mode = e.target.value;
                updatePreview();
            });
        }

        const showCaseNameCheckbox = container.querySelector('#showCaseNameCheckbox');
        if (showCaseNameCheckbox) {
            showCaseNameCheckbox.addEventListener('change', (e) => {
                step.showCaseName = e.target.checked;
                updatePreview();
            });
        }
        
        const overrideSizeCheckbox = container.querySelector('#overrideSizeCheckbox');
        const sizeOverrideInputs = container.querySelector('#sizeOverrideInputs');
        const overrideWidthInput = container.querySelector('#overrideWidth');
        const overrideHeightInput = container.querySelector('#overrideHeight');
        
        if (overrideSizeCheckbox) {
            overrideSizeCheckbox.addEventListener('change', (e) => {
                step.overrideSize = e.target.checked;
                sizeOverrideInputs.style.display = e.target.checked ? 'flex' : 'none';
                applyStepSizeOverride(stepUUID);
                updatePreview();
            });
        }
        
        if (overrideWidthInput) {
            overrideWidthInput.addEventListener('change', (e) => {
                const width = Math.max(2, parseInt(e.target.value) || 3);
                e.target.value = width;
                step.width = width;
                applyStepSizeOverride(stepUUID);
                updatePreview();
            });
        }
        
        if (overrideHeightInput) {
            overrideHeightInput.addEventListener('change', (e) => {
                const height = Math.max(1, parseInt(e.target.value) || 1);
                e.target.value = height;
                step.height = height;
                applyStepSizeOverride(stepUUID);
                updatePreview();
            });
        }
    };
    
    // Call renderPropertiesPanel with the unified pattern
    renderPropertiesPanel(
        `${step.type} Step Properties`,
        '#3a7a99',
        isBeginStep ? null : { id: stepUUID, type: 'step' },
        contentHTML,
        onListenersAttach
    );
}

function showNodeProperties(nodeId) {
    const node = currentNodes.find(n => n.id === nodeId);
    if (!node) return;

    const contentHTML = {
        basic: `
        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Name</label>
            <input type="text" id="nodeName" class="form-field-input" value="${node.name || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
            <div id="nodeNameError" style="display: none; margin-top: 4px; padding: 4px 8px; background: rgba(184, 36, 47, 0.15); border-left: 3px solid var(--status-red, #b8242f); border-radius: 2px; font-size: 0.75rem; color: #ff6b6b;"></div>
        </div>
        `,
        advanced: `
        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Min Inbound Connections</label>
            <input type="number" id="nodeMinConnections" class="form-field-input" value="${node.min_connections ?? 0}" min="0" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
            <div style="font-size: 0.75rem; color: #707070; margin-top: 4px;">0 = all inbound connections must fire</div>
        </div>
        <div style="font-size: 0.75rem; color: #707070; word-break: break-all;">ID: ${nodeId}</div>
        `
    };

    renderPropertiesPanel(
        'Node Properties',
        '#3a7a99',
        { id: nodeId, type: 'node' },
        contentHTML,
        (container) => {
            const nameInput = container.querySelector('#nodeName');
            const nameError = container.querySelector('#nodeNameError');
            if (nameInput) {
                const showError = (msg) => {
                    nameInput.style.borderColor = 'var(--status-red, #b8242f)';
                    if (nameError) { nameError.textContent = msg; nameError.style.display = 'block'; }
                };
                const clearError = () => {
                    nameInput.style.borderColor = '';
                    if (nameError) { nameError.textContent = ''; nameError.style.display = 'none'; }
                };

                nameInput.addEventListener('change', (e) => {
                    const raw = e.target.value;
                    const error = validateElementName(raw, nodeId);
                    if (error) {
                        e.target.value = node.name;
                        showError(error);
                        return;
                    }

                    clearError();
                    node.name = raw;
                    const canvas = document.getElementById('workflowCanvas');
                    const label = canvas?.querySelector(`[data-node-label="${nodeId}"]`);
                    if (label) label.textContent = node.name;
                    updatePreview();
                });
            }

            const minConnectionsInput = container.querySelector('#nodeMinConnections');
            if (minConnectionsInput) {
                minConnectionsInput.addEventListener('change', (e) => {
                    const val = parseInt(e.target.value);
                    node.min_connections = isNaN(val) || val < 0 ? 0 : val;
                    e.target.value = node.min_connections;
                    updatePreview();
                });
            }
        }
    );
}

function rebuildTransitionsFromUI() {
    // Sync type from DOM condition boxes back to currentTransitions
    document.querySelectorAll('[data-condition-id]').forEach(element => {
        const conditionId = element.getAttribute('data-condition-id');
        const transition = currentTransitions.find(t => t.id === conditionId);
        if (transition) {
            const typeAttr = element.getAttribute('data-transition-type');
            if (typeAttr) transition.type = typeAttr;
        }
    });
}

function syncTransitionCasesToStep() {
    // Cases now live directly on step.transition.cases.
    // Sync currentTransitions data (type, conditions, targets) back into the case objects.
    rebuildTransitionsFromUI();

    currentSteps.forEach(step => {
        if (!step.transition || !step.transition.cases) return;
        step.transition.cases.forEach(caseData => {
            const conditionId = caseData._conditionId;
            if (!conditionId) return;
            const tr = currentTransitions.find(t => t.id === conditionId);
            if (!tr) return;
            caseData.name = tr.name || '';
            caseData.type = tr.type;
            caseData.conditions = tr.conditions;
            caseData.targetSteps = tr.targetSteps ? [...tr.targetSteps] : [];
            caseData.targetNodes = tr.targetNodes ? [...tr.targetNodes] : [];
            caseData.order = tr.order;
            caseData.variables = tr.variables ? [...tr.variables] : [];
        });
    });
}

/**
 * Normalize steps for comparison/export: sorts transition cases and strips
 * type-irrelevant fields. Used by both updatePreview and loadWorkflow so that
 * the baseline and the current state are always structurally identical.
 * Also strips the runtime _conditionId field before comparison/save.
 *
 * Reassigns a clean, sequential order (1, 2, 3, ...) based on the sorted
 * position, rather than just passing the existing order values straight
 * through. Various in-editor operations (adding/deleting/reordering cases)
 * have produced duplicate, negative, or gapped order values in the past --
 * doing the renumbering here, at the one choke point both save and preview
 * both go through, means every export is guaranteed clean regardless of
 * what state the live in-memory cases happen to be in, and self-heals
 * already-corrupted data the next time it's loaded and saved.
 */
function normalizeStepsForComparison(steps) {
    return steps.map(step => {
        const exported = {
            ...step,
            transition: step.transition ? {
                ...step.transition,
                cases: [...(step.transition.cases || [])]
                    .sort((a, b) => (a.order || 1) - (b.order || 1))
                    .map((c, idx) => {
                        const { _conditionId, ...rest } = c;
                        return { ...rest, order: idx + 1 };
                    })
            } : undefined
        };
        if (exported.type !== 'Plugin') delete exported.taskInputs;
        if (exported.type !== 'Workflow') delete exported.triggerId;
        if (exported.type !== 'Workflow' && exported.type !== 'Plugin') {
            delete exported.workflowInputs;
            delete exported.loopMode;
            delete exported.loopConfig;
        }
        if (exported.type === 'Plugin') delete exported.workflowInputs;
        return exported;
    });
}

function updatePreview() {
    
    try {
        // Sync transition cases to step before creating preview
        syncTransitionCasesToStep();
    } catch (syncError) {
        console.error('Error in syncTransitionCasesToStep:', syncError);
    }
    
    const previewElement = document.getElementById('preview');
    
    try {
        const stepsForExport = normalizeStepsForComparison(currentSteps);
        
        const payload = { 
            id: currentWorkflowId,
            name: currentWorkflowName,
            version: currentVersion,
            view: {
                zoom: zoomLevel,
                pan: `${(panX / GU).toFixed(2)},${(panY / GU).toFixed(2)}`
            },
            metadata: currentMetadata,
            description: document.getElementById('workflowDescription')?.value || currentDefinition?.description || '',
            inputVariables: currentInputVariables,
            outputVariables: currentOutputVariables,
            outputHtml: currentOutputHtml || '',
            triggers: currentTriggers,
            steps: stepsForExport,
            nodes: currentNodes
        };
        
        // Update currentDefinition and check for changes
        currentDefinition = payload;
        const hasChanges = checkUnsavedChanges(currentDefinition);
        updateSaveButtonState();
        
        // Only update preview display if preview element exists and there are actual changes
        if (previewElement && hasChanges) {
            previewElement.textContent = JSON.stringify(payload, null, 2);
        }
    } catch (e) {
        console.error('Error in updatePreview:', e);
        if (previewElement) {
            previewElement.textContent = 'Error: ' + e.message;
        }
    }
}

let pendingConfirmCallback = null;


function cleanupStaleReferences() {
    // Remove references to deleted nodes and steps
    const nodeIds = new Set(currentNodes.map(n => n.id));
    const stepIds = new Set(currentSteps.map(s => s.id));
    
    currentTransitions.forEach(transition => {
        if (transition.targetNodes) {
            transition.targetNodes = transition.targetNodes.filter(id => nodeIds.has(id));
        }
        if (transition.targetSteps) {
            transition.targetSteps = transition.targetSteps.filter(id => stepIds.has(id));
        }
    });
    
    // Clean up step transitions too
    currentSteps.forEach(step => {
        if (step.transition && step.transition.cases) {
            step.transition.cases.forEach(caseObj => {
                if (caseObj.targetNodes) {
                    caseObj.targetNodes = caseObj.targetNodes.filter(id => nodeIds.has(id));
                }
                if (caseObj.targetSteps) {
                    caseObj.targetSteps = caseObj.targetSteps.filter(id => stepIds.has(id));
                }
            });
        }
    });

    // Clean up nodes' own outbound targets (a node can point at other nodes/steps directly)
    currentNodes.forEach(node => {
        if (node.targetNodes) {
            node.targetNodes = node.targetNodes.filter(id => nodeIds.has(id));
        }
        if (node.targetSteps) {
            node.targetSteps = node.targetSteps.filter(id => stepIds.has(id));
        }
    });
}

/**
 * Unified delete function for all element types (step, transition, node, frame)
 * @param {string} elementId - The unique ID of the element to delete
 * @param {string} elementType - Type of element: 'step', 'transition', 'node', or 'frame'
 * @param {object} options - Additional options: {skipConfirm: bool, skipRender: bool}
 */
function deleteElement(elementId, elementType, options = {}) {
    const { skipConfirm = false, skipRender = false } = options;
    const canvas = document.getElementById('workflowCanvas');
    
    // Confirmation messages
    const messages = {
        'step': 'This step and all its connections will be removed. This action cannot be undone.',
        'transition': 'This transition and all its connections will be removed. This action cannot be undone.',
        'node': 'Delete this node? All connections will be removed.',
        'frame': 'This frame and all its conditions and connections will be removed. This action cannot be undone.'
    };
    
    const confirmFn = () => {
        try {
            // --- STEP DELETION ---
            if (elementType === 'step') {
                const step = currentSteps.find(s => s.id === elementId);
                if (!step) return;
                
                // Remove all case transitions belonging to this step
                if (step.transition && step.transition.cases) {
                    step.transition.cases.forEach(caseData => {
                        const conditionId = caseData._conditionId;
                        if (conditionId) {
                            document.querySelectorAll(`[data-from-transition="${conditionId}"]`).forEach(el => el.remove());
                            currentTransitions = currentTransitions.filter(t => t.id !== conditionId);
                        }
                    });
                }
                
                // Remove from currentSteps
                currentSteps = currentSteps.filter(s => s.id !== elementId);
                
                // Remove this step as a target from all other transitions
                currentTransitions.forEach(t => {
                    if (t.targetSteps) t.targetSteps = t.targetSteps.filter(id => id !== elementId);
                });

                // Remove this step as a target from all nodes' own targetSteps
                currentNodes.forEach(n => {
                    if (n.targetSteps) n.targetSteps = n.targetSteps.filter(id => id !== elementId);
                });
                
                // Remove step DOM element (case strip is inside it, removed automatically)
                const stepElement = canvas.querySelector(`[data-step-uuid="${elementId}"]`);
                if (stepElement) stepElement.remove();
                
                // Remove connection lines to/from this step
                document.querySelectorAll(`[data-from-step="${elementId}"], [data-to-step="${elementId}"]`).forEach(el => el.remove());
            }
            
            // --- TRANSITION DELETION ---
            else if (elementType === 'transition') {
                // Find the owning step
                const ownerStep = currentSteps.find(s =>
                    s.transition && s.transition.cases &&
                    s.transition.cases.some(c => c._conditionId === elementId)
                );

                // Must have at least one case — prevent deleting the last one
                if (ownerStep && ownerStep.transition.cases.length === 1) {
                    alert('A step must have at least one transition case.');
                    return;
                }

                // Remove from step's cases
                if (ownerStep) {
                    ownerStep.transition.cases = ownerStep.transition.cases.filter(c => c._conditionId !== elementId);

                    // Renumber remaining cases to a contiguous sequence (1, 2, 3, ...),
                    // preserving their relative order, so a later addCaseToStep call
                    // can't collide with a gap left by this deletion. Keep
                    // currentTransitions in sync too, since syncTransitionCasesToStep
                    // copies order FROM there back onto the case objects.
                    const sortedRemaining = [...ownerStep.transition.cases].sort((a, b) => (a.order || 1) - (b.order || 1));
                    sortedRemaining.forEach((caseData, idx) => {
                        const newOrder = idx + 1;
                        caseData.order = newOrder;
                        const tr = currentTransitions.find(t => t.id === caseData._conditionId);
                        if (tr) tr.order = newOrder;
                    });
                }

                // Remove from currentTransitions
                currentTransitions = currentTransitions.filter(t => t.id !== elementId);

                // Remove connection lines from this transition
                document.querySelectorAll(`[data-from-transition="${elementId}"]`).forEach(el => el.remove());

                // Re-render the case strip for the owning step, shrinking width if needed
                if (ownerStep) {
                    const canvas = document.getElementById('workflowCanvas');
                    const stepElement = canvas ? canvas.querySelector(`[data-step-uuid="${ownerStep.id}"]`) : null;
                    if (stepElement) {
                        // Recalculate minimum required width: text-based vs case-based
                        const caseCount = ownerStep.transition.cases.length;
                        const caseRequiredWidth = (caseCount + 2) * GU;  // cases + add-btn + icon column
                        // Text-based minimum (replicate renderStep logic)
                        const tempDiv = document.createElement('div');
                        tempDiv.style.cssText = `position:absolute;visibility:hidden;font-size:${Math.round(GU/3)}px;white-space:nowrap;`;
                        tempDiv.textContent = ownerStep.name || `${ownerStep.type} Step`;
                        document.body.appendChild(tempDiv);
                        const textWidth = tempDiv.offsetWidth;
                        document.body.removeChild(tempDiv);
                        let textRequiredWidth = STEP_MIN_W;
                        if (textWidth > 84) {
                            const gridSpaces = Math.ceil((textWidth - (STEP_MIN_W - GU - BORDER * 2)) / GU);
                            textRequiredWidth = STEP_MIN_W + gridSpaces * GU;
                        }
                        const minWidth = Math.max(caseRequiredWidth, textRequiredWidth);
                        const currentWidth = parseInt(stepElement.style.width) || STEP_MIN_W;
                        if (currentWidth > minWidth) {
                            stepElement.style.width = minWidth + 'px';
                            ownerStep.width = minWidth / GU;
                        }
                        renderCaseStrip(stepElement, ownerStep, canvas);
                    }
                }
            }
            
            // --- NODE DELETION ---
            else if (elementType === 'node') {
                // Remove from currentNodes
                currentNodes = currentNodes.filter(n => n.id !== elementId);
                
                // Remove references from transitions' targetNodes
                currentTransitions.forEach(t => {
                    if (t.targetNodes) {
                        t.targetNodes = t.targetNodes.filter(id => id !== elementId);
                    }
                });

                // Remove references from other nodes' own targetNodes
                currentNodes.forEach(n => {
                    if (n.targetNodes) {
                        n.targetNodes = n.targetNodes.filter(id => id !== elementId);
                    }
                });
                
                // Remove references from step transitions' cases
                currentSteps.forEach(step => {
                    if (step.transition && step.transition.cases) {
                        step.transition.cases.forEach(caseObj => {
                            if (caseObj.targetNodes) {
                                caseObj.targetNodes = caseObj.targetNodes.filter(id => id !== elementId);
                            }
                        });
                    }
                });
                
                // Remove node DOM element
                const nodeElement = canvas.querySelector(`[data-node-id="${elementId}"]`);
                if (nodeElement) nodeElement.remove();
                
                // Remove connection lines
                document.querySelectorAll(`[data-from-node="${elementId}"]`).forEach(el => el.remove());
                document.querySelectorAll(`[data-to-node="${elementId}"]`).forEach(el => el.remove());
            }
            
            // --- FRAME DELETION --- (DISABLED: frames replaced by inline case strip)
            else if (elementType === 'frame') {
                // Frames no longer exist as separate elements.
                // This branch is preserved for compatibility but does nothing.
            }
            
            // Common cleanup
            hidePropertiesPanel();
            document.getElementById('propertiesContent').innerHTML = '<div style="color: #b0b0b0; font-size: 0.85rem;">Select a step or transition to edit properties</div>';
            
            // Trigger relevant updates
            if (!skipRender) {
                if (elementType === 'step' || elementType === 'frame') {
                    recheckFlaggedSteps();
                }
                updatePreview();
            }
            
        } catch (err) {
            console.error(`Error deleting ${elementType}:`, err);
            alert(`Failed to delete ${elementType}. Check console for details.`);
        }
    };
    
    // Show confirmation or execute directly
    if (skipConfirm) {
        confirmFn();
    } else {
        showDeleteConfirm(messages[elementType] || 'Delete this element?', confirmFn);
    }
}

async function handleTestWorkflow() {
    if (!currentWorkflowId) {
        alert('Not ready to test');
        return;
    }

    // Update currentDefinition from current state
    currentDefinition = {
        id: currentWorkflowId,
        name: document.getElementById('workflowName').value.trim(),
        version: currentVersion,
        view: {
            zoom: zoomLevel,
            pan: `${(panX / GU).toFixed(2)},${(panY / GU).toFixed(2)}`
        },
        metadata: currentMetadata,
        description: document.getElementById('workflowDescription')?.value || currentDefinition?.description || '',
        inputVariables: currentInputVariables,
        outputVariables: currentOutputVariables,
        triggers: currentTriggers,
        steps: normalizeStepsForComparison(currentSteps),
        nodes: currentNodes
    };

    // Validate workflow connectivity before testing
    const validation = validateWorkflowConnectivity();
    if (!validation.isValid) {
        highlightInvalidSteps(validation.unreachableSteps, validation.unreachableNodes);
        updateConnectivityBanner(validation.unreachableSteps, validation.unreachableNodes);
        return; // Don't proceed with test
    }

    // Check for unsaved changes
    if (!checkUnsavedChanges(currentDefinition)) {
        // No unsaved changes - go straight to test
        testWorkflow();
        return;
    }

    // Changes detected - show test workflow modal with confirmation
    const changedFields = getChangedFields(currentDefinition);
    const newVersion = incrementVersion(currentVersion);
    showTestWorkflowModal(changedFields, newVersion);
}

async function saveWorkflow() {
    if (!currentWorkflowId) {
        alert('Not ready to save');
        return;
    }

    // Update currentDefinition from current state
    currentDefinition = {
        id: currentWorkflowId,
        name: document.getElementById('workflowName').value.trim(),
        version: currentVersion,
        view: {
            zoom: zoomLevel,
            pan: `${(panX / GU).toFixed(2)},${(panY / GU).toFixed(2)}`
        },
        metadata: currentMetadata,
        description: document.getElementById('workflowDescription')?.value || currentDefinition?.description || '',
        inputVariables: currentInputVariables,
        outputVariables: currentOutputVariables,
        triggers: currentTriggers,
        steps: normalizeStepsForComparison(currentSteps),
        nodes: currentNodes
    };

    // Validate workflow connectivity before saving
    const validation = validateWorkflowConnectivity();
    if (!validation.isValid) {
        highlightInvalidSteps(validation.unreachableSteps, validation.unreachableNodes);
        updateConnectivityBanner(validation.unreachableSteps, validation.unreachableNodes);
        return; // Don't proceed with save
    }

    // Check for unsaved changes using base.js function
    if (!checkUnsavedChanges(currentDefinition)) {
        showStatusBanner('No changes to save.', 'info');
        return;
    }

    // Get changed fields
    const changedFields = getChangedFields(currentDefinition);
    
    // Changes detected - show confirmation modal
    const newVersion = incrementVersion(currentVersion);
    showSaveConfirmationModal(changedFields, newVersion);
}

function showSaveConfirmationModal(changedFields, newVersion) {
    showUnsavedChangesModal(changedFields, newVersion, 'save');
}

function showTestWorkflowModal(changedFields, newVersion) {
    showUnsavedChangesModal(changedFields, newVersion, 'test');
}

function showUnsavedChangesModal(changedFields, newVersion, mode) {
    const modalId = (mode === 'test' ? 'testWorkflowModal_' : 'saveConfirmationModal_') + Date.now();
    const modal = document.createElement('div');
    modal.id = modalId;
    modal.style.cssText = 'display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.7); z-index: 1000; align-items: center; justify-content: center;';

    // Build expandable changed fields with visual diff highlighting
    let changesDetailsHTML = '';
    if (changedFields && changedFields.length > 0) {
        const changeDetails = changedFields.map((field) => {
            const oldValue = originalData?.[field];
            const newValue = currentDefinition?.[field];

            if (Array.isArray(oldValue) && Array.isArray(newValue)) {
                const arrayChanges = [];
                const oldMap = new Map((oldValue || []).map((item, i) => [item.id || item.name || i, item]));
                const newMap = new Map((newValue || []).map((item, i) => [item.id || item.name || i, item]));

                for (const [key, newItem] of newMap) {
                    const oldItem = oldMap.get(key);
                    const itemLabel = newItem.name || newItem.id || key;

                    if (!oldItem) {
                        arrayChanges.push({
                            label: `${field.slice(0, -1)} "${itemLabel}" (NEW)`,
                            oldDisplay: '(none)',
                            newDisplay: JSON.stringify(newItem, null, 2),
                            isNew: true
                        });
                    } else if (!deepEqual(oldItem, newItem)) {
                        arrayChanges.push({
                            label: `${field.slice(0, -1)} "${itemLabel}"`,
                            oldDisplay: JSON.stringify(oldItem, null, 2),
                            newDisplay: JSON.stringify(newItem, null, 2),
                            oldObj: oldItem,
                            newObj: newItem,
                            isModified: true
                        });
                    }
                }
                return arrayChanges;
            } else {
                const oldDisplay = typeof oldValue === 'object' ? JSON.stringify(oldValue, null, 2) : String(oldValue || '(empty)');
                const newDisplay = typeof newValue === 'object' ? JSON.stringify(newValue, null, 2) : String(newValue || '(empty)');
                return [{ label: field, oldDisplay, newDisplay }];
            }
        }).flat();

        changesDetailsHTML = `
            <div style="margin-bottom: 16px;">
                <div style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 12px; font-weight: 600;">Changed Fields:</div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${changeDetails.map((detail, idx) => {
                        const toggleId = modalId + '_toggle_detail_' + idx;

                        let oldDisplayHTML = `<pre style="margin: 0;">${escapeHtml(detail.oldDisplay)}</pre>`;
                        let newDisplayHTML = `<pre style="margin: 0;">${escapeHtml(detail.newDisplay)}</pre>`;

                        if (detail.isModified && detail.oldObj && detail.newObj) {
                            oldDisplayHTML = buildHighlightedJSON(detail.oldObj, detail.newObj, false);
                            newDisplayHTML = buildHighlightedJSON(detail.newObj, detail.oldObj, true);
                        } else if (detail.isNew) {
                            newDisplayHTML = buildHighlightedJSON(detail.newObj || {}, {}, true);
                        }

                        return `
                            <div style="border: 1px solid var(--border-primary); border-radius: 4px; overflow: hidden;">
                                <div onclick="document.getElementById('${toggleId}').style.display = document.getElementById('${toggleId}').style.display === 'none' ? 'block' : 'none';" style="padding: 10px; background: var(--bg-panel3); cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
                                    <span style="color: var(--text-primary); font-size: 0.9rem; font-weight: 500;">${detail.label}</span>
                                    <span style="color: var(--text-muted); font-size: 0.8rem;">▼</span>
                                </div>
                                <div id="${toggleId}" style="display: none; padding: 12px; background: var(--bg-panel3); border-top: 1px solid var(--border-primary);">
                                    <div style="margin-bottom: 8px;">
                                        <div style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 4px;">Old Value:</div>
                                        <div class="custom-scrollbar" style="padding: 6px 8px; background: var(--bg-canvas); border-radius: 3px; color: #ffffff; font-size: 0.75rem; font-family: monospace; max-height: 200px; overflow-y: auto; word-break: break-all; white-space: pre-wrap;">${oldDisplayHTML}</div>
                                    </div>
                                    <div>
                                        <div style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 4px;">New Value:</div>
                                        <div class="custom-scrollbar" style="padding: 6px 8px; background: var(--bg-canvas); border-radius: 3px; color: #ffffff; font-size: 0.75rem; font-family: monospace; max-height: 200px; overflow-y: auto; word-break: break-all; white-space: pre-wrap;">${newDisplayHTML}</div>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    // Helper function to build highlighted JSON with line-level diff
    function buildHighlightedJSON(current, other, isNewValue) {
        const lines = [];

        function buildObjectLines(obj, otherObj, indent = '') {
            const keys = new Set([...Object.keys(obj), ...Object.keys(otherObj)]);
            const sortedKeys = Array.from(keys).sort();
            const result = [];

            sortedKeys.forEach((key, idx) => {
                if (key in obj) {
                    const currentVal = obj[key];
                    const otherVal = otherObj[key];
                    const keyExistsInOther = key in otherObj;
                    const isAdded = !keyExistsInOther;
                    const isChanged = keyExistsInOther && JSON.stringify(currentVal) !== JSON.stringify(otherVal);

                    let lineColor = 'inherit';
                    if (isNewValue) {
                        if (isAdded) lineColor = '#51cf66';
                        else if (isChanged) lineColor = '#ffd43b';
                    } else {
                        if (isAdded) lineColor = '#ff6b6b';
                        else if (isChanged) lineColor = '#ffd43b';
                    }

                    const comma = idx < sortedKeys.length - 1 ? ',' : '';

                    if (typeof currentVal === 'object' && currentVal !== null && isChanged) {
                        result.push(`${indent}  "${key}": {`);
                        const nestedLines = buildObjectLines(
                            currentVal,
                            typeof otherVal === 'object' && otherVal !== null ? otherVal : {},
                            indent + '    '
                        );
                        result.push(...nestedLines);
                        result.push(`${indent}  }${comma}`);
                    } else {
                        const valStr = JSON.stringify(currentVal);
                        const line = `${indent}  "${key}": ${valStr}${comma}`;
                        if (lineColor !== 'inherit') {
                            result.push(`<span style="color: ${lineColor};">${escapeHtml(line)}</span>`);
                        } else {
                            result.push(escapeHtml(line));
                        }
                    }
                }
            });

            return result;
        }

        lines.push('{');
        lines.push(...buildObjectLines(current, other));
        lines.push('}');
        return lines.join('\n');
    }

    const title = mode === 'test' ? 'Test Workflow' : 'Save Workflow';
    const confirmBtn = mode === 'test'
        ? `<button class="btn" data-color="blue" onclick="(async () => { document.getElementById('${modalId}').remove(); await performSave('${newVersion}'); await new Promise(resolve => setTimeout(resolve, 500)); testWorkflow(); })()">Save & Test</button>`
        : `<button class="btn" data-color="green" onclick="document.getElementById('${modalId}').remove(); performSave('${newVersion}')">Save</button>`;

    modal.innerHTML = `
        <div class="custom-scrollbar" style="background: var(--bg-panel2); border: 1px solid var(--border-primary); border-radius: 6px; padding: 24px; max-width: 750px; width: 90%; max-height: 80vh; overflow-y: auto;">
            <h2 style="font-size: 1.2rem; font-weight: 600; margin-bottom: 16px; margin-top: 0; color: var(--text-primary);">${title}</h2>

            ${changesDetailsHTML}

            <div style="margin-bottom: 16px; padding: 10px; background: var(--bg-panel3); border-radius: 4px; color: var(--text-primary); font-size: 0.9rem;">
                New Version: <strong>${newVersion}</strong>
            </div>

            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button class="btn" data-color="grey" onclick="document.getElementById('${modalId}').remove()">Cancel</button>
                ${confirmBtn}
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

function incrementVersion(version) {
    // Parse version like "1.48" (major.minor format)
    const parts = version.split('.');
    if (parts.length >= 2) {
        // Increment minor version
        parts[1] = String(parseInt(parts[1]) + 1);
        // Return only major.minor
        return parts.slice(0, 2).join('.');
    }
    // Fallback: just increment as if it's a single number
    return String(parseInt(version) + 1);
}

async function performSave(newVersion) {
    const workflowName = document.getElementById('workflowName').value.trim();
    
    // Sync transition case data (including variables) into step.transition.cases before saving
    syncTransitionCasesToStep();

    // Rebuild input and output variables from form before saving
    rebuildInputVariablesFromForm();
    rebuildOutputVariablesFromForm();
    
    try {
        // Final check: do one more comparison to ensure unsavedChanges flag is accurate
        const finalDefinition = {
            id: currentWorkflowId,
            name: workflowName,
            version: newVersion,
            view: {
                zoom: zoomLevel,
                pan: `${(panX / GU).toFixed(2)},${(panY / GU).toFixed(2)}`
            },
            metadata: currentMetadata,
            description: document.getElementById('workflowDescription')?.value || currentDefinition?.description || '',
            inputVariables: currentInputVariables,
            outputVariables: currentOutputVariables,
            outputHtml: currentOutputHtml || '',
            triggers: currentTriggers,
            steps: normalizeStepsForComparison(currentSteps)
        };
        
        // Proceed with save - changes already verified in saveWorkflow
        const payload = {
            name: workflowName,
            version: newVersion,
            definition: {
                id: currentWorkflowId,
                name: workflowName,
                version: newVersion,
                view: {
                    zoom: zoomLevel,
                    pan: `${(panX / GU).toFixed(2)},${(panY / GU).toFixed(2)}`
                },
                metadata: currentMetadata,
                description: document.getElementById('workflowDescription')?.value || currentDefinition?.description || '',
                inputVariables: currentInputVariables,
                outputVariables: currentOutputVariables,
                outputHtml: currentOutputHtml || '',
                triggers: currentTriggers,
                steps: normalizeStepsForComparison(currentSteps),
                nodes: currentNodes
            }
        };

        const headers = {
            'Content-Type': 'application/json'
        };
        if (typeof sessionToken !== 'undefined' && sessionToken) {
            headers['X-Session-Token'] = sessionToken;
        }

        const response = await fetch(`/kore/workflows/${currentWorkflowId}`, {
            method: 'PUT',
            headers: headers,
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok) {
            // Use the version from the backend response, not what we sent
            currentVersion = data.version || newVersion;
            currentWorkflowName = workflowName;
            document.getElementById('workflowNameDisplay').textContent = workflowName;
            // Update metadata timestamps on successful save
            const now = new Date().toISOString();
            currentMetadata = {
                ...(currentMetadata || {}),
                updated_at: now,
                updated_by: 'user'
            };
            originalJson = JSON.stringify({
                id: currentWorkflowId,
                name: workflowName,
                version: newVersion,
                view: {
                    zoom: zoomLevel,
                    pan: `${(panX / GU).toFixed(2)},${(panY / GU).toFixed(2)}`
                },
                metadata: currentMetadata,
                description: currentDefinition?.description || '',
                inputVariables: currentInputVariables,
                outputVariables: currentOutputVariables,
                outputHtml: currentOutputHtml || '',
                triggers: currentTriggers,
                steps: currentSteps,
                nodes: currentNodes
            }, null, 2);
            
            // Reset definition tracking after successful save
            originalDefinition = {
                id: currentWorkflowId,
                name: workflowName,
                version: newVersion,
                view: {
                    zoom: zoomLevel,
                    pan: `${(panX / GU).toFixed(2)},${(panY / GU).toFixed(2)}`
                },
                metadata: currentMetadata,
                description: currentDefinition?.description || '',
                inputVariables: currentInputVariables,
                outputVariables: currentOutputVariables,
                outputHtml: currentOutputHtml || '',
                triggers: currentTriggers,
                steps: normalizeStepsForComparison(currentSteps),
                nodes: currentNodes
            };
            
            // Update originalData to the newly saved definition (deep copy)
            originalData = JSON.parse(JSON.stringify(originalDefinition));
            
            // Update unsaved tracking with new baseline after successful save
            initializeUnsavedTracking(originalDefinition);
            
            // Clear unsaved changes flag using base.js function
            clearUnsavedChanges();
            updateSaveButtonState();
            
            // Refresh version selector if it exists
            const versionSelect = document.getElementById('versionSelector');
            if (versionSelect) {
                allVersions.unshift(newVersion);
                const option = document.createElement('option');
                option.value = newVersion;
                option.textContent = `v${newVersion}`;
                versionSelect.insertBefore(option, versionSelect.firstChild);
                versionSelect.value = newVersion;
            }

            showStatusBanner('Workflow saved successfully!', 'success');
        } else {
            showStatusBanner(`Error saving workflow: ${data.error || 'Unknown error'}`, 'error');
        }
    } catch (err) {
        showStatusBanner(`Error: ${err.message}`, 'error');
    }
}

function goBack() {
    if (hasUnsavedChanges()) {
        showUnsaved(
            () => saveWorkflow().then(() => { window.location.href = 'workflows.html'; }),
            () => { window.location.href = 'workflows.html'; }
        );
    } else {
        window.location.href = 'workflows.html';
    }
}

function toggleMoreMenu() {
    const menu = document.getElementById('moreMenu');
    if (menu) {
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }
}

// Close more menu when clicking outside
document.addEventListener('click', function(event) {
    const moreMenu = document.getElementById('moreMenu');
    const moreBtn = event.target.closest('button[onclick*="toggleMoreMenu"]');
    if (moreMenu && !moreBtn && !moreMenu.contains(event.target)) {
        moreMenu.style.display = 'none';
    }
});

// Text Editor Modal - Generic for any multiline text field


/**
 * Unified line drawing for all connection types
 * @param {SVGElement} lineElement - SVG to draw into
 * @param {string} sourceId - step/node/case UUID
 * @param {string} sourceType - 'step'|'node'|'case'
 * @param {string} targetId - step/node/frame UUID
 * @param {string} targetType - 'step'|'node'|'frame'
 * @param {HTMLElement} canvas - canvas element
 * @param {string} lineColor - hex color code
 * @param {boolean} sourceFloating - does source endpoint float? (step/node/case=true for floating, case=false for fixed)
 * @param {object} sourceContext - additional context (frame for case, element for step/node)
 */
// drawConnectionLine - MOVED TO wf-canvas.js

// Create a single transition condition box (2x1)
function updateTransitionLineColors(transitionId, type) {
    const colors = getTransitionTheme(type);
    const canvas = document.getElementById('workflowCanvas');
    // Update all lines FROM this transition (transition to step lines)
    const lines = canvas.querySelectorAll(`[data-from-transition="${transitionId}"]`);
    
    lines.forEach(line => {
        // Get current innerHTML and replace all color references
        let innerHTML = line.innerHTML;
        
        // Replace any hex color (#xxxxxx) with the new color
        innerHTML = innerHTML.replace(/#[0-9a-fA-F]{6}/g, colors.color);
        
        // Also replace arrowhead ID
        innerHTML = innerHTML.replace(/arrowhead-[^"]+/g, `arrowhead-${transitionId}`);
        
        // Update the innerHTML to apply the new colors
        line.innerHTML = innerHTML;
    });
}

// setupCanvasDragDrop - MOVED TO wf-canvas.js (high-risk function with complex event handling)

// ===== INPUT VARIABLES UI =====

async function loadWorkflow() {
    const params = getUrlParams();
    if (!params.id) {
        showStatusBanner('No workflow ID provided', 'error');
        return;
    }

    try {
        currentWorkflowId = params.id;
        const response = await fetch(`/kore/workflows/${currentWorkflowId}`);
        
        if (!response.ok) {
            throw new Error(`Failed to load workflow: ${response.statusText}`);
        }

        const data = await response.json();
        
        // Store the original definition from the API response for later comparison (deep copy)
        originalData = JSON.parse(JSON.stringify(data.definition));
        
        // Set workflow metadata
        currentWorkflowName = data.name || 'Untitled Workflow';
        document.getElementById('workflowNameDisplay').textContent = currentWorkflowName;
        currentVersion = data.version || 1;
        currentMetadata = data.metadata || {};
        
        // Parse workflow definition
        const definition = data.definition || {};
        currentSteps = definition.steps || [];
        currentTransitions = definition.transitions || [];
        currentTransitionFrames = definition.transitionFrames || [];
        currentInputVariables = definition.inputVariables || [];
        currentOutputVariables = definition.outputVariables || [];
        currentOutputHtml = definition.outputHtml || '';
        currentNodes = definition.nodes || [];
        currentTriggers = definition.triggers || [];
        if (currentTriggers.length === 0) {
            currentTriggers.push({ id: generateId('trigger'), name: 'Default', enabled: true, type: 'Always', variables: [] });
        }
        
        // Debug: log what was loaded
        console.log('Loaded workflow:', {
            steps: currentSteps,
            nodes: currentNodes,
            transitions: currentTransitions,
            stepCount: currentSteps.length,
            nodeCount: currentNodes.length
        });
        
        // Clean up any stale references to deleted nodes/steps
        cleanupStaleReferences();
        
        // Build definition object for unsaved changes tracking
        const workflowDefinition = {
            id: currentWorkflowId,
            name: currentWorkflowName,
            version: currentVersion,
            view: {
                zoom: zoomLevel,
                pan: `${(panX / GU).toFixed(2)},${(panY / GU).toFixed(2)}`
            },
            metadata: currentMetadata,
            description: definition.description || '',
            inputVariables: currentInputVariables,
            outputVariables: currentOutputVariables,
            outputHtml: currentOutputHtml,
            triggers: currentTriggers,
            steps: normalizeStepsForComparison(currentSteps),
            nodes: currentNodes
        };
        
        // Initialize unsaved changes tracking with base.js function
        initializeUnsavedTracking(workflowDefinition);
        clearUnsavedChanges();
        
        // Store the loaded definition as current baseline
        currentDefinition = workflowDefinition;
        
        // Update button state to reflect no changes initially
        updateSaveButtonState();
        
        // Update UI
        document.getElementById('workflowName').value = currentWorkflowName;
        
        // Render on canvas
        renderLoadedStepsOnCanvas();
        
        // Draw all connection lines (node-to-node, case lines, etc.)
        updatePreview();
        
        // Apply initial zoom
        const canvas = document.getElementById('workflowCanvas');
        if (canvas) {
            canvas.style.transform = `scale(${zoomLevel}) translate(${-panX}px, ${-panY}px)`;
            updateZoomDisplay();
        }
    } catch (error) {
        console.error('Error loading workflow:', error);
        showStatusBanner(`Error: ${error.message}`, 'error');
    }
}


function initWorkflowEditor() {
    // Initialize canvas dimensions and grid from configuration constants
    initCanvas();

    // Size step type sidebar items to match one grid unit
    document.querySelectorAll('.step-type-item').forEach(item => {
        item.style.height = GU + 'px';
    });

    // Set up preview toggle UI
    const previewToggle = document.getElementById('previewToggle');
    const previewBox = document.getElementById('preview');
    if (previewToggle && previewBox) {
        previewToggle.addEventListener('change', function() {
            previewBox.style.display = this.checked ? 'block' : 'none';
        });
    }
    
    // Set up canvas drag-drop and event listeners
    setupCanvasDragDrop();
    
    initializeNodeTool();
    
    // Load utility step configurations for Kore actions
    fetchUtilSteps().catch(error => {
        console.error('[initWorkflowEditor] Failed to load utility steps:', error);
    });

    // Set up browser beforeunload warning for unsaved changes
    setupPageUnsavedChangesProtection();

    // Expose functions to global scope for onclick handlers
    window.showWorkflowSettingsModal = showWorkflowSettingsModal;
    window.closeWorkflowSettingsModal = closeWorkflowSettingsModal;
    window.showJSONModal = showJSONModal;
    window.showImportJSONModal = showImportJSONModal;
    window.saveWorkflow = saveWorkflow;
    window.loadWorkflow = loadWorkflow;
    window.testWorkflow = testWorkflow;
    window.toggleStepTypesPanel = toggleStepTypesPanel;
}

/**
 * Execute the current workflow for testing
 */
async function testWorkflow() {
    if (!currentWorkflowId) {
        showStatusBanner('No workflow loaded. Load or create a workflow first.', 'error');
        return;
    }

    // Debug: log state before test
    console.log('[DEBUG] testWorkflow state:', {
        currentWorkflowId,
        currentVersion,
        currentStepsLength: currentSteps?.length,
        currentNodesLength: currentNodes?.length,
        currentInputVariablesLength: currentInputVariables?.length,
        currentDefinition: currentDefinition
    });

    // Build trigger select field — options are trigger names, we map back to ID on submit
    const triggers = currentTriggers || [];

    const triggerField = triggers.length > 0 ? {
        name: '_triggerName',
        label: 'Trigger',
        type: 'select',
        options: triggers.map(t => t.name || t.id),
        value: triggers.length > 0 ? (triggers[0].name || triggers[0].id) : ''
    } : null;

    // Collect input variable fields
    const parameters = {};
    const inputFields = (currentInputVariables || []).map(v => {
        const varType = v.type || 'string';
        const baseField = { name: v.name, label: v.name };
        if (varType === 'boolean') {
            const val = v.value === 'true' ? 'true' : 'false';
            return { ...baseField, type: 'select', options: ['false', 'true'], value: val };
        } else if (varType === 'multi-line' || varType === 'array' || varType === 'object') {
            return { ...baseField, type: 'textarea', value: v.value || '', placeholder: `Enter value for ${v.name}` };
        } else if (varType === 'integer' || varType === 'float') {
            return { ...baseField, type: 'number', value: v.value || '', placeholder: `Enter value for ${v.name}` };
        } else {
            return { ...baseField, type: 'text', value: v.value || '', placeholder: `Enter value for ${v.name}` };
        }
    });

    // Always show modal if we have triggers or input variables
    const fields = [
        ...(triggerField ? [triggerField] : []),
        ...(inputFields.length > 0 && triggerField ? [{ type: 'section', label: 'Input Variables' }] : []),
        ...inputFields
    ];

    if (fields.length > 0) {
        return new Promise((resolve) => {
            showFormModal(
                'Test Workflow Execution',
                fields,
                async (formData) => {
                    // Clean up previous execution state
                    if (window.cleanupPreviousExecution) window.cleanupPreviousExecution();

                    // Extract triggerId by matching selected trigger name
                    const selectedTriggerName = formData['_triggerName'] || null;
                    const selectedTrigger = selectedTriggerName
                        ? triggers.find(t => (t.name || t.id) === selectedTriggerName)
                        : null;
                    const selectedTriggerId = selectedTrigger ? selectedTrigger.id : null;

                    // Coerce form string values to proper JS types based on variable type
                    (currentInputVariables || []).forEach(v => {
                        const varType = v.type || 'string';
                        const raw = formData[v.name];
                        if (varType === 'boolean') {
                            parameters[v.name] = raw === 'true';
                        } else if (varType === 'integer') {
                            const n = parseInt(raw, 10);
                            parameters[v.name] = isNaN(n) ? raw : n;
                        } else if (varType === 'float') {
                            const n = parseFloat(raw);
                            parameters[v.name] = isNaN(n) ? raw : n;
                        } else if (varType === 'array' || varType === 'object') {
                            try {
                                parameters[v.name] = JSON.parse(raw);
                            } catch (e) {
                                parameters[v.name] = raw;
                            }
                        } else {
                            parameters[v.name] = raw;
                        }
                    });

                    await executeWorkflow(parameters, selectedTriggerId);
                    setTimeout(() => { showExecutionResults(); }, 100);
                    resolve();
                },
                false,  // readOnly
                false,  // resizable
                false,  // suppressBodyScroll
                'Start Test'  // submitButtonLabel
            );
        });
    } else {
        // No triggers or input variables — execute directly
        if (window.cleanupPreviousExecution) window.cleanupPreviousExecution();
        await executeWorkflow(parameters, null);
        setTimeout(() => { showExecutionResults(); }, 100);
    }
}

        // Expose initWorkflowEditor to global scope for DOMContentLoaded
        window.initWorkflowEditor = initWorkflowEditor;

function showWorkflowSettingsModal() {
    // Working copies — only committed on Save
    const modalInputVariables  = JSON.parse(JSON.stringify(currentInputVariables));
    const modalOutputVariables = JSON.parse(JSON.stringify(currentOutputVariables));
    let modalOutputHtml = currentOutputHtml || '';

    // Set working variable references so addVariable / renderVariablesInContainer use these copies
    setWorkingVariables(modalInputVariables, modalOutputVariables);

    // ── TAB DEFINITIONS ──────────────────────────────────────────────────────
    const TABS = ['General', 'Inputs', 'Outputs', 'Triggers', 'Info'];

    // ── BUILD CONTENT ELEMENT ─────────────────────────────────────────────────
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display: flex; flex-direction: column; height: 100%; min-height: 0;';

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display: flex; gap: 0; border-bottom: 1px solid var(--border-primary); margin-bottom: 16px; flex-shrink: 0;';

    // Tab panels container
    const panelsContainer = document.createElement('div');
    panelsContainer.style.cssText = 'flex: 1; min-height: 0; overflow-y: auto;';

    // Create tabs and panels
    const tabEls = {};
    const panelEls = {};

    TABS.forEach((name, i) => {
        // Tab button
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.textContent = name;
        tab.dataset.tab = name;
        tab.style.cssText = `
            background: none; border: none; border-bottom: 2px solid transparent;
            padding: 8px 16px; font-size: 0.85rem; cursor: pointer;
            color: var(--text-muted); transition: color 0.15s, border-color 0.15s;
            margin-bottom: -1px;
        `;
        tabEls[name] = tab;
        tabBar.appendChild(tab);

        // Panel
        const panel = document.createElement('div');
        panel.dataset.panel = name;
        panel.style.cssText = 'display: none;';
        panelEls[name] = panel;
        panelsContainer.appendChild(panel);
    });

    // ── TAB ACTIVATION ────────────────────────────────────────────────────────
    function activateTab(name) {
        TABS.forEach(t => {
            const isActive = t === name;
            tabEls[t].style.color = isActive ? 'var(--text-primary)' : 'var(--text-muted)';
            tabEls[t].style.borderBottomColor = isActive ? 'var(--brand-light, #3a9fd1)' : 'transparent';
            tabEls[t].style.fontWeight = isActive ? '600' : 'normal';
            panelEls[t].style.display = isActive ? 'block' : 'none';
        });
    }

    TABS.forEach(name => {
        tabEls[name].addEventListener('click', () => activateTab(name));
    });

    // ── GENERAL TAB ───────────────────────────────────────────────────────────
    panelEls['General'].innerHTML = `
        <div style="margin-bottom: 14px;">
            <label style="display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 5px; font-weight: 600;">Workflow Name</label>
            <input type="text" id="wfSettingsName" class="form-field-input"
                value="${(currentWorkflowName || '').replace(/"/g, '&quot;')}"
                placeholder="Enter workflow name"
                style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
        </div>
        <div>
            <label style="display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 5px; font-weight: 600;">Description</label>
            <textarea id="wfSettingsDescription" class="form-field-input"
                placeholder="Enter workflow description"
                style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem; min-height: 100px; resize: vertical;">${(currentDefinition.description || '').replace(/</g, '&lt;')}</textarea>
        </div>
    `;

    // ── INPUTS TAB ────────────────────────────────────────────────────────────
    const inputsPanel = panelEls['Inputs'];

    const inputHeader = document.createElement('div');
    inputHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
    inputHeader.innerHTML = `
        <label style="color: var(--text-muted); font-size: 0.85rem; font-weight: 600; margin: 0;">Input Variables</label>
    `;
    const addInputBtn = document.createElement('button');
    addInputBtn.type = 'button';
    addInputBtn.className = 'btn';
    addInputBtn.setAttribute('data-color', 'green');
    addInputBtn.setAttribute('data-size', 'sm');
    addInputBtn.textContent = '+ Add Input Variable';
    inputHeader.appendChild(addInputBtn);

    const inputListContainer = document.createElement('div');
    inputListContainer.id = 'inputVariablesList';
    inputListContainer.style.cssText = 'display: flex; flex-direction: column; gap: 0;';

    inputsPanel.appendChild(inputHeader);
    inputsPanel.appendChild(inputListContainer);

    addInputBtn.addEventListener('click', (e) => {
        e.preventDefault();
        modalInputVariables.push({ name: '', value: '', type: 'string', order: modalInputVariables.length });
        renderVariablesInContainer(inputListContainer, modalInputVariables, 'input', updatePreview);
    });

    // ── OUTPUTS TAB ───────────────────────────────────────────────────────────
    const outputsPanel = panelEls['Outputs'];

    const outputHeader = document.createElement('div');
    outputHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
    outputHeader.innerHTML = `
        <label style="color: var(--text-muted); font-size: 0.85rem; font-weight: 600; margin: 0;">Output Variables</label>
    `;
    const addOutputBtn = document.createElement('button');
    addOutputBtn.type = 'button';
    addOutputBtn.className = 'btn';
    addOutputBtn.setAttribute('data-color', 'green');
    addOutputBtn.setAttribute('data-size', 'sm');
    addOutputBtn.textContent = '+ Add Output Variable';
    outputHeader.appendChild(addOutputBtn);

    const outputListContainer = document.createElement('div');
    outputListContainer.id = 'outputVariablesList';
    outputListContainer.style.cssText = 'display: flex; flex-direction: column; gap: 0;';

    outputsPanel.appendChild(outputHeader);
    outputsPanel.appendChild(outputListContainer);

    addOutputBtn.addEventListener('click', (e) => {
        e.preventDefault();
        modalOutputVariables.push({ name: '', value: '', order: modalOutputVariables.length });
        renderVariablesInContainer(outputListContainer, modalOutputVariables, 'output', updatePreview);
    });

    // Output HTML - deliberately separate from the Output Variables list above
    // (not deletable, not part of that array at all) - see currentOutputHtml's
    // declaration for why.
    const outputHtmlSection = document.createElement('div');
    outputHtmlSection.style.cssText = 'margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--border-primary);';
    outputHtmlSection.innerHTML = `
        <label style="display: block; font-size: 0.85rem; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Output HTML</label>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 8px;">Optional. If set, its rendered HTML automatically pops up as a modal in Execution Details when the workflow finishes (any outcome - success, warning, or failure). Never sent to a parent workflow if this one runs as a sub-workflow.</div>
        <div style="display: flex; gap: 8px;">
            <input type="text" id="outputHtmlPreview" readonly style="flex: 1; padding: 6px; box-sizing: border-box; font-size: 0.85rem; background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 4px; color: var(--text-muted); cursor: default;">
            <button type="button" class="btn" data-color="blue" id="editOutputHtmlBtn" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 16px;" title="Edit Output HTML">&#9998;</button>
        </div>
    `;
    outputsPanel.appendChild(outputHtmlSection);

    function refreshOutputHtmlPreview() {
        const previewEl = outputHtmlSection.querySelector('#outputHtmlPreview');
        if (!previewEl) return;
        const trimmed = (modalOutputHtml || '').trim();
        previewEl.value = trimmed ? (trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed) : '';
        previewEl.placeholder = '(not set)';
    }
    refreshOutputHtmlPreview();

    const editOutputHtmlBtn = outputHtmlSection.querySelector('#editOutputHtmlBtn');
    if (editOutputHtmlBtn) {
        editOutputHtmlBtn.addEventListener('click', () => {
            openWorkflowJinjaEditorModal('Edit Output HTML', modalOutputHtml, (value) => {
                modalOutputHtml = value;
                refreshOutputHtmlPreview();
            }, null, undefined, 'output');
        });
    }

    // ── TRIGGERS TAB ─────────────────────────────────────────────────────────
    const triggersPanel = panelEls['Triggers'];
    const modalTriggers = JSON.parse(JSON.stringify(currentTriggers));

    const triggerHeader = document.createElement('div');
    triggerHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;';
    triggerHeader.innerHTML = `<label style="color: var(--text-muted); font-size: 0.85rem; font-weight: 600; margin: 0;">Triggers</label>`;
    const addTriggerBtn = document.createElement('button');
    addTriggerBtn.type = 'button';
    addTriggerBtn.className = 'btn';
    addTriggerBtn.setAttribute('data-color', 'green');
    addTriggerBtn.setAttribute('data-size', 'sm');
    addTriggerBtn.textContent = '+ Add Trigger';
    triggerHeader.appendChild(addTriggerBtn);

    const triggerListContainer = document.createElement('div');
    triggerListContainer.id = 'triggersList';
    triggerListContainer.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';

    triggersPanel.appendChild(triggerHeader);
    triggersPanel.appendChild(triggerListContainer);

    function renderTriggerRow(trigger, index) {
        const row = document.createElement('div');
        row.setAttribute('data-trigger-row', trigger.id);
        row.style.cssText = `
            border: 1px solid var(--border-primary);
            border-radius: 4px;
            overflow: hidden;
            background: var(--bg-panel3, var(--bg-panel2));
        `;

        // ── Collapsed header ──────────────────────────────────────────────────
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            cursor: pointer;
            user-select: none;
        `;

        const arrow = document.createElement('span');
        arrow.style.cssText = 'font-size: 0.65rem; color: var(--text-muted); transition: transform 0.15s; flex-shrink: 0;';
        arrow.textContent = '▶';

        const nameDisplay = document.createElement('span');
        nameDisplay.style.cssText = 'flex: 1; font-size: 0.85rem; color: var(--text-primary); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        nameDisplay.textContent = trigger.name || '(Unnamed Trigger)';

        const typeBadge = document.createElement('span');
        typeBadge.style.cssText = 'font-size: 0.7rem; color: var(--text-muted); flex-shrink: 0;';
        typeBadge.textContent = trigger.type || 'Always';

        const enabledToggle = document.createElement('label');
        enabledToggle.style.cssText = 'display: flex; align-items: center; gap: 4px; font-size: 0.75rem; color: var(--text-muted); cursor: pointer; flex-shrink: 0;';
        enabledToggle.innerHTML = `<input type="checkbox" ${trigger.enabled ? 'checked' : ''} style="cursor:pointer;"> Enabled`;
        enabledToggle.querySelector('input').addEventListener('change', (e) => {
            e.stopPropagation();
            trigger.enabled = e.target.checked;
        });
        enabledToggle.addEventListener('click', e => e.stopPropagation());

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.style.cssText = 'background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 0.8rem; padding: 0 2px; flex-shrink: 0; line-height: 1;';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Delete trigger';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (modalTriggers.length <= 1) {
                showAlert('Cannot Delete', 'A workflow must have at least one trigger.');
                return;
            }
            const idx = modalTriggers.indexOf(trigger);
            if (idx > -1) modalTriggers.splice(idx, 1);
            row.remove();
        });

        header.appendChild(arrow);
        header.appendChild(nameDisplay);
        header.appendChild(typeBadge);
        header.appendChild(enabledToggle);
        header.appendChild(deleteBtn);

        // ── Expanded body ─────────────────────────────────────────────────────
        const body = document.createElement('div');
        body.style.cssText = `
            display: none;
            padding: 10px 12px 12px;
            border-top: 1px solid var(--border-primary);
            display: none;
            flex-direction: column;
            gap: 10px;
        `;

        // Name field
        const nameRow = document.createElement('div');
        nameRow.innerHTML = `<label style="display:block; font-size:0.78rem; color:var(--text-muted); font-weight:600; margin-bottom:4px;">Trigger Name</label>`;
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'form-field-input';
        nameInput.value = trigger.name || '';
        nameInput.placeholder = 'Enter trigger name';
        nameInput.style.cssText = 'width:100%; padding:5px; font-size:0.85rem; box-sizing:border-box;';
        nameInput.addEventListener('input', () => {
            trigger.name = nameInput.value;
            nameDisplay.textContent = nameInput.value || '(Unnamed Trigger)';
        });
        nameRow.appendChild(nameInput);

        // Type field
        const typeRow = document.createElement('div');
        typeRow.innerHTML = `<label style="display:block; font-size:0.78rem; color:var(--text-muted); font-weight:600; margin-bottom:4px;">Trigger Type</label>`;
        const typeSelect = document.createElement('select');
        typeSelect.className = 'form-field-input';
        typeSelect.style.cssText = 'width:100%; padding:5px; font-size:0.85rem; box-sizing:border-box;';
        [['Always', 'Always (Generic)'], ['Schedule', 'Schedule']].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            if (trigger.type === val) opt.selected = true;
            typeSelect.appendChild(opt);
        });
        typeSelect.addEventListener('change', () => {
            trigger.type = typeSelect.value;
            typeBadge.textContent = typeSelect.value;
            renderTypeSettings();
        });
        typeRow.appendChild(typeSelect);

        // Type-specific settings
        const typeSettings = document.createElement('div');
        typeSettings.setAttribute('data-trigger-type-settings', trigger.id);

        function buildCronFromSchedule(s) {
            switch (s.scheduleType) {
                case 'everyNMinutes':
                    return `*/${s.interval || 15} * * * *`;
                case 'hourly':
                    return `${s.minute || 0} * * * *`;
                case 'daily': {
                    const [h, m] = to24Hour(s.hour || 12, s.minute || 0, s.ampm || 'AM');
                    return `${m} ${h} * * *`;
                }
                case 'weekly': {
                    const [h, m] = to24Hour(s.hour || 12, s.minute || 0, s.ampm || 'AM');
                    return `${m} ${h} * * ${s.dayOfWeek ?? 1}`;
                }
                case 'monthly': {
                    const [h, m] = to24Hour(s.hour || 12, s.minute || 0, s.ampm || 'AM');
                    return `${m} ${h} ${s.dayOfMonth || 1} * *`;
                }
                default: return '0 9 * * *';
            }
        }

        function to24Hour(hour, minute, ampm) {
            let h = parseInt(hour, 10);
            if (ampm === 'AM' && h === 12) h = 0;
            if (ampm === 'PM' && h !== 12) h += 12;
            return [h, parseInt(minute, 10)];
        }

        function from24Hour(h, m) {
            h = parseInt(h, 10); m = parseInt(m, 10);
            const ampm = h < 12 ? 'AM' : 'PM';
            let hour = h % 12;
            if (hour === 0) hour = 12;
            return { hour, minute: m, ampm };
        }

        function describeCron(s) {
            switch (s.scheduleType) {
                case 'everyNMinutes': return `Every ${s.interval || 15} minutes`;
                case 'hourly': return `Every hour at :${String(s.minute || 0).padStart(2, '0')}`;
                case 'daily': return `Daily at ${s.hour || 12}:${String(s.minute || 0).padStart(2, '0')} ${s.ampm || 'AM'}`;
                case 'weekly': {
                    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                    return `Every ${days[s.dayOfWeek ?? 1]} at ${s.hour || 12}:${String(s.minute || 0).padStart(2, '0')} ${s.ampm || 'AM'}`;
                }
                case 'monthly': return `Monthly on day ${s.dayOfMonth || 1} at ${s.hour || 12}:${String(s.minute || 0).padStart(2, '0')} ${s.ampm || 'AM'}`;
                default: return '';
            }
        }

        function renderTypeSettings() {
            typeSettings.innerHTML = '';
            if (trigger.type !== 'Schedule') return;

            // Initialize schedule object from existing cron or defaults
            if (!trigger.schedule) trigger.schedule = { scheduleType: 'daily', hour: 9, minute: 0, ampm: 'AM' };
            const s = trigger.schedule;

            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:10px; background:var(--bg-input); border:1px solid var(--border-primary); border-radius:4px;';

            // Schedule type selector
            const typeLabel = document.createElement('label');
            typeLabel.style.cssText = 'font-size:0.78rem; color:var(--text-muted); font-weight:600;';
            typeLabel.textContent = 'Schedule Type';
            const typeSelectEl = document.createElement('select');
            typeSelectEl.className = 'form-field-input';
            typeSelectEl.style.cssText = 'width:100%; padding:5px; font-size:0.85rem; box-sizing:border-box;';
            [
                ['everyNMinutes', 'Every N Minutes'],
                ['hourly',        'Hourly'],
                ['daily',         'Daily'],
                ['weekly',        'Weekly'],
                ['monthly',       'Monthly']
            ].forEach(([val, label]) => {
                const opt = document.createElement('option');
                opt.value = val; opt.textContent = label;
                if (s.scheduleType === val) opt.selected = true;
                typeSelectEl.appendChild(opt);
            });

            // Options container — re-rendered when schedule type changes
            const optionsWrap = document.createElement('div');
            optionsWrap.style.cssText = 'display:flex; flex-direction:column; gap:8px;';

            // Description line
            const descLine = document.createElement('div');
            descLine.style.cssText = 'font-size:0.78rem; color:var(--text-accent); font-style:italic; min-height:1.2em;';

            function labelEl(text) {
                const l = document.createElement('label');
                l.style.cssText = 'font-size:0.78rem; color:var(--text-muted); font-weight:600; margin-bottom:2px; display:block;';
                l.textContent = text;
                return l;
            }

            function inputGroup(labelText, inputEl) {
                const g = document.createElement('div');
                g.appendChild(labelEl(labelText));
                g.appendChild(inputEl);
                return g;
            }

            function minuteSelect(currentVal) {
                const sel = document.createElement('select');
                sel.className = 'form-field-input';
                sel.style.cssText = 'width:100%; padding:5px; font-size:0.85rem; box-sizing:border-box;';
                for (let m = 0; m < 60; m++) {
                    const opt = document.createElement('option');
                    opt.value = m; opt.textContent = String(m).padStart(2, '0');
                    if (m === (currentVal ?? 0)) opt.selected = true;
                    sel.appendChild(opt);
                }
                return sel;
            }

            function hourSelect(currentVal) {
                const sel = document.createElement('select');
                sel.className = 'form-field-input';
                sel.style.cssText = 'width:100%; padding:5px; font-size:0.85rem; box-sizing:border-box;';
                for (let h = 1; h <= 12; h++) {
                    const opt = document.createElement('option');
                    opt.value = h; opt.textContent = h;
                    if (h === (currentVal ?? 12)) opt.selected = true;
                    sel.appendChild(opt);
                }
                return sel;
            }

            function ampmSelect(currentVal) {
                const sel = document.createElement('select');
                sel.className = 'form-field-input';
                sel.style.cssText = 'width:100%; padding:5px; font-size:0.85rem; box-sizing:border-box;';
                ['AM','PM'].forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v; opt.textContent = v;
                    if (v === (currentVal || 'AM')) opt.selected = true;
                    sel.appendChild(opt);
                });
                return sel;
            }

            function timeRow(s, onChange) {
                const row = document.createElement('div');
                row.style.cssText = 'display:grid; grid-template-columns:1fr 1fr 80px; gap:6px;';
                const hSel = hourSelect(s.hour);
                const mSel = minuteSelect(s.minute);
                const aSel = ampmSelect(s.ampm);
                [hSel, mSel, aSel].forEach(el => el.addEventListener('change', () => {
                    s.hour   = parseInt(hSel.value, 10);
                    s.minute = parseInt(mSel.value, 10);
                    s.ampm   = aSel.value;
                    onChange();
                }));
                const hGroup = document.createElement('div');
                hGroup.appendChild(labelEl('Hour')); hGroup.appendChild(hSel);
                const mGroup = document.createElement('div');
                mGroup.appendChild(labelEl('Minute')); mGroup.appendChild(mSel);
                const aGroup = document.createElement('div');
                aGroup.appendChild(labelEl('AM/PM')); aGroup.appendChild(aSel);
                row.appendChild(hGroup); row.appendChild(mGroup); row.appendChild(aGroup);
                return row;
            }

            function updateCronAndDesc() {
                trigger.schedule.cron = buildCronFromSchedule(s);
                descLine.textContent = describeCron(s);
            }

            function renderOptions() {
                optionsWrap.innerHTML = '';
                const type = s.scheduleType;

                if (type === 'everyNMinutes') {
                    const sel = document.createElement('select');
                    sel.className = 'form-field-input';
                    sel.style.cssText = 'width:100%; padding:5px; font-size:0.85rem; box-sizing:border-box;';
                    [5,10,15,20,30].forEach(n => {
                        const opt = document.createElement('option');
                        opt.value = n; opt.textContent = `Every ${n} minutes`;
                        if (n === (s.interval || 15)) opt.selected = true;
                        sel.appendChild(opt);
                    });
                    sel.addEventListener('change', () => { s.interval = parseInt(sel.value, 10); updateCronAndDesc(); });
                    optionsWrap.appendChild(inputGroup('Interval', sel));

                } else if (type === 'hourly') {
                    const mSel = minuteSelect(s.minute);
                    mSel.addEventListener('change', () => { s.minute = parseInt(mSel.value, 10); updateCronAndDesc(); });
                    optionsWrap.appendChild(inputGroup('At Minute', mSel));

                } else if (type === 'daily') {
                    optionsWrap.appendChild(timeRow(s, updateCronAndDesc));

                } else if (type === 'weekly') {
                    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                    const dSel = document.createElement('select');
                    dSel.className = 'form-field-input';
                    dSel.style.cssText = 'width:100%; padding:5px; font-size:0.85rem; box-sizing:border-box;';
                    days.forEach((day, i) => {
                        const opt = document.createElement('option');
                        opt.value = i; opt.textContent = day;
                        if (i === (s.dayOfWeek ?? 1)) opt.selected = true;
                        dSel.appendChild(opt);
                    });
                    dSel.addEventListener('change', () => { s.dayOfWeek = parseInt(dSel.value, 10); updateCronAndDesc(); });
                    optionsWrap.appendChild(inputGroup('Day of Week', dSel));
                    optionsWrap.appendChild(timeRow(s, updateCronAndDesc));

                } else if (type === 'monthly') {
                    const dSel = document.createElement('select');
                    dSel.className = 'form-field-input';
                    dSel.style.cssText = 'width:100%; padding:5px; font-size:0.85rem; box-sizing:border-box;';
                    for (let d = 1; d <= 28; d++) {
                        const opt = document.createElement('option');
                        opt.value = d; opt.textContent = d;
                        if (d === (s.dayOfMonth || 1)) opt.selected = true;
                        dSel.appendChild(opt);
                    }
                    dSel.addEventListener('change', () => { s.dayOfMonth = parseInt(dSel.value, 10); updateCronAndDesc(); });
                    optionsWrap.appendChild(inputGroup('Day of Month', dSel));
                    optionsWrap.appendChild(timeRow(s, updateCronAndDesc));
                }

                updateCronAndDesc();
            }

            typeSelectEl.addEventListener('change', () => {
                s.scheduleType = typeSelectEl.value;
                renderOptions();
            });

            // Cron string display (read-only)
            const cronDisplay = document.createElement('div');
            cronDisplay.style.cssText = 'font-size:0.75rem; color:var(--text-muted); font-family:monospace; margin-top:2px;';

            const origUpdateCronAndDesc = updateCronAndDesc;
            // Override to also update cronDisplay
            function updateCronAndDesc() {
                trigger.schedule.cron = buildCronFromSchedule(s);
                descLine.textContent = describeCron(s);
                cronDisplay.textContent = `cron: ${trigger.schedule.cron}`;
            }

            wrap.appendChild(typeLabel);
            wrap.appendChild(typeSelectEl);
            wrap.appendChild(optionsWrap);
            wrap.appendChild(descLine);
            wrap.appendChild(cronDisplay);
            typeSettings.appendChild(wrap);

            renderOptions();
        }
        renderTypeSettings();

        body.appendChild(nameRow);
        body.appendChild(typeRow);
        body.appendChild(typeSettings);

        // ── Trigger Variables ─────────────────────────────────────────────────
        const varSeparator = document.createElement('div');
        varSeparator.style.cssText = 'border-top: 1px solid var(--border-primary); margin: 4px 0;';

        const varHeader = document.createElement('div');
        varHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
        varHeader.innerHTML = `<label style="font-size:0.78rem; color:var(--text-muted); font-weight:600; margin:0;">Trigger Variables</label>`;

        const addVarBtn = document.createElement('button');
        addVarBtn.type = 'button';
        addVarBtn.className = 'btn';
        addVarBtn.setAttribute('data-color', 'green');
        addVarBtn.setAttribute('data-size', 'sm');
        addVarBtn.textContent = '+ Add Variable';
        varHeader.appendChild(addVarBtn);

        const varContainerId = `triggerVars_${trigger.id}`;
        const varContainer = document.createElement('div');
        varContainer.id = varContainerId;
        varContainer.setAttribute('data-trigger-vars', trigger.id);
        varContainer.style.cssText = 'display: flex; flex-direction: column; gap: 0; margin-top: 6px;';

        if (!trigger.variables) trigger.variables = [];

        addVarBtn.addEventListener('click', () => {
            setWorkingTriggerVariables(trigger.variables);
            addVariable('trigger', varContainerId);
        });

        body.appendChild(varSeparator);
        body.appendChild(varHeader);
        body.appendChild(varContainer);

        // ── Toggle expand/collapse ────────────────────────────────────────────
        let expanded = false;
        header.addEventListener('click', () => {
            expanded = !expanded;
            body.style.display = expanded ? 'flex' : 'none';
            arrow.style.transform = expanded ? 'rotate(90deg)' : 'rotate(0deg)';
            if (expanded) {
                setWorkingTriggerVariables(trigger.variables);
                renderVariablesInContainer(varContainer, trigger.variables, 'trigger', updatePreview);
            } else {
                setWorkingTriggerVariables(null);
            }
        });

        row.appendChild(header);
        row.appendChild(body);
        return row;
    }

    function renderAllTriggers() {
        triggerListContainer.innerHTML = '';
        modalTriggers.forEach((trigger, i) => {
            triggerListContainer.appendChild(renderTriggerRow(trigger, i));
        });
    }

    addTriggerBtn.addEventListener('click', () => {
        const newTrigger = {
            id: generateId('trigger'),
            name: '',
            enabled: true,
            type: 'Always'
        };
        modalTriggers.push(newTrigger);
        const row = renderTriggerRow(newTrigger, modalTriggers.length - 1);
        triggerListContainer.appendChild(row);
        // Auto-expand new trigger (click fires expand logic including var render)
        row.querySelector('div').click();
    });

    renderAllTriggers();

    // ── INFO TAB ─────────────────────────────────────────────────────────────
    const meta = currentMetadata || {};
    const formatDate = (iso) => iso ? new Date(iso).toLocaleString() : '—';
    panelEls['Info'].innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 10px; font-size: 0.85rem;">
            <div>
                <span style="color: var(--text-muted); font-weight: 600;">Workflow ID</span>
                <div style="color: var(--text-primary); margin-top: 2px; word-break: break-all;">${currentWorkflowId || '—'}</div>
            </div>
            <div style="border-top: 1px solid var(--border-primary); padding-top: 10px;">
                <span style="color: var(--text-muted); font-weight: 600;">Version</span>
                <div style="color: var(--text-primary); margin-top: 2px;">${currentVersion || '—'}</div>
            </div>
            <div style="border-top: 1px solid var(--border-primary); padding-top: 10px;">
                <span style="color: var(--text-muted); font-weight: 600;">Created</span>
                <div style="color: var(--text-primary); margin-top: 2px;">${formatDate(meta.created_at)}</div>
            </div>
            <div style="border-top: 1px solid var(--border-primary); padding-top: 10px;">
                <span style="color: var(--text-muted); font-weight: 600;">Created By</span>
                <div style="color: var(--text-primary); margin-top: 2px;">${meta.created_by || '—'}</div>
            </div>
            <div style="border-top: 1px solid var(--border-primary); padding-top: 10px;">
                <span style="color: var(--text-muted); font-weight: 600;">Last Updated</span>
                <div style="color: var(--text-primary); margin-top: 2px;">${formatDate(meta.updated_at)}</div>
            </div>
            <div style="border-top: 1px solid var(--border-primary); padding-top: 10px;">
                <span style="color: var(--text-muted); font-weight: 600;">Updated By</span>
                <div style="color: var(--text-primary); margin-top: 2px;">${meta.updated_by || '—'}</div>
            </div>
        </div>
    `;

    // ── ASSEMBLE ─────────────────────────────────────────────────────────────
    wrapper.appendChild(tabBar);
    wrapper.appendChild(panelsContainer);

    // ── SHOW MODAL ────────────────────────────────────────────────────────────
    showModal({
        title: 'Workflow Settings',
        content: wrapper,
        width: '600px',
        height: '600px',
        onClose: () => { setWorkingVariables(null, null); },
        buttons: [
            {
                label: 'Cancel',
                type: 'secondary',
                onClick: () => {}   // closeModal is called automatically
            },
            {
                label: 'Save',
                type: 'success',
                onClick: () => {
                    const nameInput = wrapper.querySelector('#wfSettingsName');
                    const descInput = wrapper.querySelector('#wfSettingsDescription');
                    const newName = (nameInput?.value || '').trim();
                    if (!newName) {
                        showStatusBanner('Workflow name is required', 'error');
                        activateTab('General');
                        return false;   // Prevent modal close
                    }

                    currentInputVariables  = modalInputVariables;
                    currentOutputVariables = modalOutputVariables;
                    currentOutputHtml = modalOutputHtml;
                    currentTriggers = modalTriggers;

                    currentWorkflowName = newName;
                    currentDefinition.name = newName;
                    document.getElementById('workflowNameDisplay').textContent = newName;
                    const legacyNameInput = document.getElementById('workflowName');
                    if (legacyNameInput) legacyNameInput.value = newName;
                    currentDefinition.description = descInput?.value || '';
                    currentDefinition.triggers = currentTriggers;

                    showStatusBanner('Workflow settings saved', 'success');
                    updatePreview();
                }
            }
        ]
    });

    // Render variable lists after modal is in the DOM
    renderVariablesInContainer(inputListContainer,  modalInputVariables,  'input',  updatePreview);
    renderVariablesInContainer(outputListContainer, modalOutputVariables, 'output', updatePreview);

    // modal-body starts at height:0px — fix it to fill the modal
    const modalBody = document.querySelector('.modal-container .modal-body');
    if (modalBody) modalBody.style.height = '100%';

    // Activate first tab
    activateTab('General');
}

function closeWorkflowSettingsModal() {
    closeModal();
}

// Expose functions to global scope
window.activateNodePlacementMode = activateNodePlacementMode;
window.addCaseToStep = addCaseToStep;
window.addConditionToFrame = addConditionToFrame;
window.applyFrameLayout = applyFrameLayout;
window.applyStepSizeOverride = applyStepSizeOverride;
window.cancelNodePlacement = cancelNodePlacement;
window.cleanupStaleReferences = cleanupStaleReferences;
window.closeWorkflowSettingsModal = closeWorkflowSettingsModal;
window.deleteElement = deleteElement;
window.detachFrameFromStep = detachFrameFromStep;
window.generateNodeId = generateNodeId;
window.getUrlParams = getUrlParams;
window.goBack = goBack;
window.handleTestWorkflow = handleTestWorkflow;
window.incrementVersion = incrementVersion;
window.initWorkflowEditor = initWorkflowEditor;
window.initializeNodeTool = initializeNodeTool;
window.injectReferencePanel = injectReferencePanel;
window.insertVariableIntoEditor = insertVariableIntoEditor;
window.loadWorkflow = loadWorkflow;
window.openWorkflowJinjaEditorModal = openWorkflowJinjaEditorModal;
window.performSave = performSave;
window.rebuildTransitionsFromUI = rebuildTransitionsFromUI;
window.recheckFlaggedSteps = recheckFlaggedSteps;
window.saveWorkflow = saveWorkflow;
window.showJSONModal = showJSONModal;
window.showImportJSONModal = showImportJSONModal;
window.handleImportJSON = handleImportJSON;
window.showNodeProperties = showNodeProperties;
window.showSaveConfirmationModal = showSaveConfirmationModal;
window.showStepProperties = showStepProperties;
window.showTestWorkflowModal = showTestWorkflowModal;
window.showWorkflowSettingsModal = showWorkflowSettingsModal;
window.showTransitionFrameProperties = showTransitionFrameProperties;
window.showTransitionProperties = showTransitionProperties;
window.syncTransitionCasesToStep = syncTransitionCasesToStep;
window.testWorkflow = testWorkflow;
window.toggleMoreMenu = toggleMoreMenu;
window.updateConnectivityBanner = updateConnectivityBanner;
window.updatePreview = updatePreview;
window.updateSaveButtonState = updateSaveButtonState;
window.updateTransitionLineColors = updateTransitionLineColors;
window.validateWorkflowConnectivity = validateWorkflowConnectivity;

// Expose state variables to global scope using getters/setters for live references
Object.defineProperties(window, {
    currentWorkflowId: { 
        get: () => currentWorkflowId,
        set: (val) => { currentWorkflowId = val; }
    },
    currentWorkflowName: { 
        get: () => currentWorkflowName,
        set: (val) => { currentWorkflowName = val; }
    },
    currentVersion: { 
        get: () => currentVersion,
        set: (val) => { currentVersion = val; }
    },
    currentMetadata: { 
        get: () => currentMetadata,
        set: (val) => { currentMetadata = val; }
    },
    currentDefinition: { 
        get: () => currentDefinition,
        set: (val) => { currentDefinition = val; }
    },
    originalData: { 
        get: () => originalData,
        set: (val) => { originalData = val; }
    },
    originalJson: { 
        get: () => originalJson,
        set: (val) => { originalJson = val; }
    },
    originalDefinition: { 
        get: () => originalDefinition,
        set: (val) => { originalDefinition = val; }
    },
    allVersions: { 
        get: () => allVersions,
        set: (val) => { allVersions = val; }
    },
    currentSteps: { 
        get: () => currentSteps,
        set: (val) => { currentSteps = val; }
    },
    currentTransitions: { 
        get: () => currentTransitions,
        set: (val) => { currentTransitions = val; }
    },
    currentTransitionFrames: { 
        get: () => currentTransitionFrames,
        set: (val) => { currentTransitionFrames = val; }
    },
    currentInputVariables: { 
        get: () => currentInputVariables,
        set: (val) => { currentInputVariables = val; }
    },
    currentOutputVariables: { 
        get: () => currentOutputVariables,
        set: (val) => { currentOutputVariables = val; }
    },
    currentTriggers: { 
        get: () => currentTriggers,
        set: (val) => { currentTriggers = val; }
    },
    currentNodes: { 
        get: () => currentNodes,
        set: (val) => { currentNodes = val; }
    },
    currentStepBeingEdited: { 
        get: () => currentStepBeingEdited,
        set: (val) => { currentStepBeingEdited = val; }
    },
    currentTransitionBeingEdited: { 
        get: () => currentTransitionBeingEdited,
        set: (val) => { currentTransitionBeingEdited = val; }
    },
    transitionCounter: { 
        get: () => transitionCounter,
        set: (val) => { transitionCounter = val; }
    },
    transitionFrameCounter: { 
        get: () => transitionFrameCounter,
        set: (val) => { transitionFrameCounter = val; }
    },
    toolsPanelCollapsed: { 
        get: () => toolsPanelCollapsed,
        set: (val) => { toolsPanelCollapsed = val; }
    }
});