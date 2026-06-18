import '/lib/wf-exec.js';
import '/lib/wf-render.js';
import '/lib/wf-canvas.js';
import '/lib/wf-variables.js';
import '/lib/wf-utilsteps.js';
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

let currentNodes = [];
let currentStepBeingEdited = null;  // Track step for variable editing
let currentTransitionBeingEdited = null;  // Track transition for case variable editing
let transitionCounter = 0;
let transitionFrameCounter = 0;
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
          const x = (endEvent.clientX - canvasRect.left) / zoomLevel + panX;
          const y = (endEvent.clientY - canvasRect.top) / zoomLevel + panY;
          placeNode(x, y);
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
      // Place the node
      const canvasRect = canvas.getBoundingClientRect();
      const x = (e.clientX - canvasRect.left) / zoomLevel + panX;
      const y = (e.clientY - canvasRect.top) / zoomLevel + panY;
      placeNode(x, y);
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
function openWorkflowJinjaEditorModal(title, initialValue, onSaveCallback, stepId) {
  // Call the generic modal
  openJinjaEditorModal(title, initialValue, onSaveCallback);
  
  // Wait for modal to render, then inject reference panel and set width
  setTimeout(() => {
    const modal = document.querySelector('.modal-container');
    if (modal) {
      // Set width while maintaining centering (uses transform: translate(-50%, -50%))
      modal.style.width = '800px';
      modal.style.maxWidth = '90vw';
    }
    injectReferencePanel(stepId);
  }, 100);
}

/**
 * Inject the Reference Panel into the Jinja Editor modal
 */
function injectReferencePanel(stepId) {
  // Find the modal - try multiple selectors
  let modal = document.querySelector('.modal-container');
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
    
    // Always show input variables
    if (currentDefinition.inputVariables && Array.isArray(currentDefinition.inputVariables)) {
      currentDefinition.inputVariables.forEach(v => {
        if (v.name) {
          variables.push({
            name: v.name,
            source: 'Input Variable',
            type: detectVariableType(v.type)
          });
        }
      });
    }
    
    // If not BEGIN step, get context variables
    if (stepId) {
      const contextVars = getVariableContextForStep(stepId, currentDefinition, currentTransitions);
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
        <div style="color: var(--text-primary); font-weight: 500; font-size: 0.85rem;">${v.name}</div>
        <div style="color: var(--text-muted); font-size: 0.75rem; margin-top: 2px;">${v.source}</div>
        <div style="color: var(--brand-light); font-size: 0.7rem; font-weight: 500;">${v.type}</div>
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
    
    // Sort cases by order within each transition
    const stepsForExport = currentSteps.map(step => {
        const exported = {
            ...step,
            transition: step.transition ? {
                ...step.transition,
                cases: Array.isArray(step.transition.cases) ? [...step.transition.cases].sort((a, b) => (a.order || 1) - (b.order || 1)) : []
            } : undefined
        };
        // Strip taskInputs from non-Plugin steps
        if (exported.type !== 'Plugin') delete exported.taskInputs;
        // Strip workflowInputs/loopMode/loopConfig from non-Workflow steps
        if (exported.type !== 'Workflow') {
            delete exported.workflowInputs;
            delete exported.loopMode;
            delete exported.loopConfig;
        }
        return exported;
    });
    
    const workflowData = {
        id: currentWorkflowId,
        name: currentWorkflowName,
        version: currentVersion,
        view: {
            zoom: zoomLevel,
            pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
        },
        metadata: currentMetadata,
        description: currentDefinition.description || '',
        inputVariables: currentInputVariables,
        outputVariables: currentOutputVariables,
        steps: stepsForExport,
        nodes: currentNodes
    };
    const jsonContent = JSON.stringify(workflowData, null, 2);
    
    // Open read-only JSON editor modal
    openJsonEditorModal('Workflow Configuration', jsonContent, null, true);
}


function addConditionToFrame(frameUUID, conditionsContainer) {
    return (e) => {
        e.stopPropagation();
        
        // Don't add if we just dragged the frame
        const frameElement = document.querySelector(`[data-transition-frame="${frameUUID}"]`);
        if (frameElement && frameElement._isFrameDragging) {
            frameElement._isFrameDragging = false;
            return;
        }
        
        const frame = currentTransitionFrames.find(f => f.id === frameUUID);
        if (!frame) return;
        
        // Create new condition
        transitionCounter++;
        const newConditionId = String(transitionCounter);
        // Calculate order based on how many conditions are already in this frame
        const order = frame.conditions.length + 1;
        const newConditionData = {
            id: newConditionId,
            name: '',
            type: 'Success',
            conditions: '',
            targetSteps: [],
            targetNodes: [],
            order: order
        };
        
        // Add to frame and global list
        frame.conditions.push(newConditionId);
        currentTransitions.push(newConditionData);
        
        // Add the case to the step that owns this transition frame
        if (frame.attachedToStepId) {
            const ownerStep = currentSteps.find(s => s.id === frame.attachedToStepId);
            if (ownerStep && ownerStep.transition) {
                if (!ownerStep.transition.cases) {
                    ownerStep.transition.cases = [];
                }
                // Add the new case ONLY to the step that owns this frame
                ownerStep.transition.cases.push({
                    type: newConditionData.type,
                    conditions: newConditionData.conditions,
                    targetSteps: newConditionData.targetSteps,
                    targetNodes: newConditionData.targetNodes || [],
                    order: newConditionData.order
                });
            }
        }
        
        // Re-render the frame to include the new condition
        const vertical = currentSteps.some(step => 
            step.transition && step.transition.vertical
        );
        renderTransitionFrame(frameUUID, vertical);
        
        // If frame is attached to a step, check if step needs to expand
        const attachedStep = currentSteps.find(s => s.id === frame.attachedToStepId);
        if (attachedStep) {
            setTimeout(() => {
                const canvas = document.getElementById('workflowCanvas');
                const stepElement = canvas.querySelector(`[data-step-uuid="${attachedStep.id}"]`);
                const frameElement = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                
                if (stepElement && frameElement) {
                    const stepWidth = parseInt(stepElement.style.width);
                    const frameWidth = parseInt(frameElement.style.width);
                    
                    // If frame is now wider than step, expand step
                    if (frameWidth > stepWidth) {
                        stepElement.style.width = frameWidth + 'px';
                        stepElement.style.borderRadius = '4px 4px 0px 0px';
                    }
                }
            }, 0);
        }
        
        updatePreview();
    };
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
    tempDiv.style.cssText = `
        position: absolute;
        visibility: hidden;
        font-size: 0.9rem;
        white-space: nowrap;
    `;
    tempDiv.textContent = attachedStep.name || `${attachedStep.type} Step`;
    document.body.appendChild(tempDiv);
    const textWidth = tempDiv.offsetWidth;
    document.body.removeChild(tempDiv);
    
    let width = 120;  // Default 4 grid units
    if (textWidth > 80) {
        const gridSpaces = Math.ceil((textWidth - 80) / 30);
        width = 120 + (gridSpaces * 30);
    }
    stepElement.style.width = width + 'px';
    attachedStep.width = width / 30;
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

function showTransitionProperties(transitionUUID) {
    const transition = (currentTransitions || []).find(t => t.id === transitionUUID);
    if (!transition) return;
    
    const contentHTML = `
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
        
        <div id="conditionsDiv" style="display: ${transition.type === 'Logic' ? 'block' : 'none'}; margin-top: 10px;">
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Conditions</label>
            <div style="display: flex; gap: 8px;">
                <input type="text" id="transitionConditions" class="form-field-input" value="${transition.conditions || ''}" style="flex: 1; padding: 6px; box-sizing: border-box; font-size: 0.85rem;" onchange="transition.conditions = this.value; updatePreview();">
                <button class="btn transition-conditions-edit-btn" data-transition-uuid="${transitionUUID}" data-color="blue" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 16px;" title="Edit Conditions">&#9998;</button>
            </div>
        </div>
        
        <div style="border-top: 1px solid #3a7a99; padding-top: 10px; margin-top: 10px;">
            <div style="font-size: 0.75rem; color: #707070; word-break: break-all;">ID: ${transition.id}</div>
        </div>
    `;
    
    const onListenersAttach = (container) => {
        container.querySelector('#transitionName')?.addEventListener('change', (e) => {
            transition.name = e.target.value;
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
        newWidth = Math.max(2, step.width || 3) * 30;  // Convert grid units to pixels
        newHeight = Math.max(1, step.height || 1) * 30;
    } else {
        // Auto-calculate width from text, height is 1 grid unit
        const textDiv = stepElement.querySelector('div');
        if (textDiv) {
            const textWidth = textDiv.offsetWidth;
            let requiredWidth = 90; // Start with minimum (3 grid units)
            if (textWidth > 82) {
                const gridSpaces = Math.ceil((textWidth - 82) / 30);
                requiredWidth = 90 + (gridSpaces * 30);
            }
            newWidth = requiredWidth;
        } else {
            newWidth = 90;
        }
        newHeight = 30; // 1 grid unit
    }
    
    // Update step data with final width/height values (in grid units for storage)
    step.width = newWidth / 30;
    step.height = newHeight / 30;
    
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
            <div style="border-top: 1px solid #3a7a99;"></div>
        `;
    } else if (isWorkflowType) {
        // Dropdown for Workflow + input mapping + loop config
        actionFieldHTML = `
            <div>
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Workflow</label>
                <select id="stepAction" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    <option value="">-- Select Workflow --</option>
                </select>
            </div>
            <div id="workflowInputsContainer" style="padding-top: 10px; border-top: 1px solid #3a7a99; display: none;">
                <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Input Mapping</label>
                <div id="workflowInputsContent"></div>
            </div>
            <div style="padding-top: 10px; border-top: 1px solid #3a7a99;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                    <input type="checkbox" id="loopModeCheckbox" ${step.loopMode ? 'checked' : ''} style="cursor: pointer;">
                    <span style="font-size: 0.85rem; color: #b0b0b0;">Loop Mode</span>
                </label>
            </div>
            <div id="loopConfigContainer" class="panel-level-3" style="display: ${step.loopMode ? 'flex' : 'none'}; flex-direction: column; gap: 10px; padding-top: 10px; border-top: 1px solid #3a7a99;">
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
            <div style="border-top: 1px solid #3a7a99;"></div>
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
    
    // Build content HTML (without header or delete button - renderPropertiesPanel handles those)
    const contentHTML = `
        ${!isBeginStep ? `
        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Name</label>
            <input type="text" id="stepName" class="form-field-input" value="${step.name || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
        </div>
        ` : ''}
        
        ${actionFieldHTML}
        
        ${!isBeginStep ? `
        <div style="padding-top: 10px;">
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Min Inbound Connections</label>
            <input type="number" id="stepMinConnections" class="form-field-input" value="${step.min_connections ?? 0}" min="0" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
            <div style="font-size: 0.75rem; color: #707070; margin-top: 4px;">0 = all inbound connections must fire</div>
        </div>
        ` : ''}
        
        <div style="border-top: 1px solid #3a7a99; padding-top: 10px;">
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Output Variables</label>
            <button id="addVariableBtn" class="btn btn-blue" data-size="sm" style="width: 100%; padding: 6px; margin-bottom: 8px;">Add Variable</button>
            <div id="variablesContainer"></div>
        </div>
        
        <div style="border-top: 1px solid #3a7a99; padding-top: 10px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" id="overrideSizeCheckbox" ${step.overrideSize ? 'checked' : ''} style="cursor: pointer;">
                <span style="font-size: 0.85rem; color: #b0b0b0;">Override Size</span>
            </label>
            
            <div id="sizeOverrideInputs" style="display: ${step.overrideSize ? 'flex' : 'none'}; flex-direction: column; gap: 10px;">
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
        
        <div style="border-top: 1px solid #3a7a99; padding-top: 10px;">
            <div style="font-size: 0.75rem; color: #707070; word-break: break-all;">ID: ${step.id}</div>
        </div>
    `;
    
    // Build event listeners attachment function
    const onListenersAttach = (container) => {
        // Step name handler
        const stepNameInput = container.querySelector('#stepName');
        if (stepNameInput && !isBeginStep) {
            stepNameInput.addEventListener('change', (e) => {
                step.name = e.target.value;
                // Update display text on canvas
                const stepElement = document.querySelector(`[data-step-uuid="${stepUUID}"]`);
                if (stepElement) {
                    // Get the content area - it's the div with flex: 1 and background color (not transparent)
                    const contentArea = Array.from(stepElement.children).find(child => 
                        child.tagName === 'DIV' && 
                        child.style.background !== 'transparent' && 
                        child.style.flex === '1 1 0%'
                    );
                    let requiredWidth = 120; // Declare outside if block so it's available later
                    if (contentArea) {
                        contentArea.textContent = step.name;
                        
                        // Measure text width with a temporary element
                        const tempDiv = document.createElement('div');
                        tempDiv.style.cssText = `
                            position: absolute;
                            visibility: hidden;
                            font-size: 0.9rem;
                            white-space: nowrap;
                        `;
                        tempDiv.textContent = step.name;
                        document.body.appendChild(tempDiv);
                        const textWidth = tempDiv.offsetWidth;
                        document.body.removeChild(tempDiv);
                        
                        // Calculate required width
                        if (textWidth > 80) {
                            const gridSpaces = Math.ceil((textWidth - 80) / 30);
                            requiredWidth = 120 + (gridSpaces * 30);
                        } else {
                            requiredWidth = 120; // Minimum size
                        }
                    }
                    
                    const currentWidth = stepElement.offsetWidth;
                    
                    // Update width if needed (both expanding and shrinking)
                    if (requiredWidth !== currentWidth) {
                        stepElement.style.width = requiredWidth + 'px';
                        
                        // Get canvas reference
                        const canvas = document.getElementById('workflowCanvas');
                        const stepId = stepElement.getAttribute('data-step-id');
                        
                        // Recalculate all connection lines for this step
                        const stepRect = stepElement.getBoundingClientRect();
                        const stepCanvasX = stepRect.left - canvas.getBoundingClientRect().left;
                        const stepCanvasY = stepRect.top - canvas.getBoundingClientRect().top;
                        
                        // Update blue lines from this step
                        const transitionLines = canvas.querySelectorAll(`[data-connection-line][data-from-step="${stepId}"]`);
                        transitionLines.forEach(line => {
                            const fromPoint = line.getAttribute('data-from-point');
                            const toTransitionId = line.getAttribute('data-to-transition');
                            const toTransition = canvas.querySelector(`[data-transition-uuid="${toTransitionId}"]`);
                            
                            if (toTransition) {
                                const stepWidth = stepElement.offsetWidth;
                                const stepCenterX = stepCanvasX + (stepWidth / 2);
                                
                                let lineStartX = stepCenterX;
                                let lineStartY = stepCanvasY + 15;
                                
                                if (fromPoint === 'top') {
                                    lineStartX = stepCenterX;
                                    lineStartY = stepCanvasY;
                                } else if (fromPoint === 'bottom') {
                                    lineStartX = stepCenterX;
                                    lineStartY = stepCanvasY + 30;
                                } else if (fromPoint === 'left') {
                                    lineStartX = stepCanvasX;
                                    lineStartY = stepCanvasY + 15;
                                } else if (fromPoint === 'right') {
                                    lineStartX = stepCanvasX + stepWidth;
                                    lineStartY = stepCanvasY + 15;
                                }
                                
                                const transitionRect = toTransition.getBoundingClientRect();
                                const transitionActualX = transitionRect.left - canvas.getBoundingClientRect().left;
                                const transitionActualY = transitionRect.top - canvas.getBoundingClientRect().top;
                                
                                const sideCenters = [
                                    { x: transitionActualX + 30, y: transitionActualY, name: 'top' },
                                    { x: transitionActualX + 30, y: transitionActualY + 30, name: 'bottom' },
                                    { x: transitionActualX, y: transitionActualY + 15, name: 'left' },
                                    { x: transitionActualX + 60, y: transitionActualY + 15, name: 'right' }
                                ];
                                
                                let nearestSide = sideCenters[0];
                                let minDistance = Infinity;
                                sideCenters.forEach(side => {
                                    const distance = Math.hypot(lineStartX - side.x, lineStartY - side.y);
                                    if (distance < minDistance) {
                                        minDistance = distance;
                                        nearestSide = side;
                                    }
                                });
                                
                                // Offset endpoint 15px away from edge
                                const offsetEnd = offsetPointFromEdge(nearestSide.x, nearestSide.y, nearestSide.name, 15);
                                const transitionCurvePath = createCurvedPath(lineStartX, lineStartY, fromPoint, offsetEnd.x, offsetEnd.y, nearestSide.name);
                                line.innerHTML = `<path d="${transitionCurvePath}" stroke="#3a7a99" stroke-width="2" fill="none"/>`;
                            }
                        });
                        
                        // Update green lines pointing to this step
                        const greenLines = canvas.querySelectorAll(`[data-to-step="${stepId}"]`);
                        greenLines.forEach(line => {
                            const fromTransitionId = line.getAttribute('data-from-transition');
                            const fromTransition = canvas.querySelector(`[data-transition-uuid="${fromTransitionId}"]`);
                            
                            if (fromTransition) {
                                const transitionRect = fromTransition.getBoundingClientRect();
                                const transitionCanvasX = transitionRect.left - canvas.getBoundingClientRect().left;
                                const transitionCanvasY = transitionRect.top - canvas.getBoundingClientRect().top;
                                const x1 = transitionCanvasX + 30;
                                const y1 = transitionCanvasY + 30;
                                
                                const stepWidth = stepElement.offsetWidth;
                                const stepCenterX = stepCanvasX + (stepWidth / 2);
                                const sideCenters = [
                                    { x: stepCenterX, y: stepCanvasY, name: 'top' },
                                    { x: stepCenterX, y: stepCanvasY + 30, name: 'bottom' },
                                    { x: stepCanvasX, y: stepCanvasY + 15, name: 'left' },
                                    { x: stepCanvasX + stepWidth, y: stepCanvasY + 15, name: 'right' }
                                ];
                                
                                let nearestSide = sideCenters[0];
                                let minDistance = Infinity;
                                sideCenters.forEach(side => {
                                    const distance = Math.hypot(x1 - side.x, y1 - side.y);
                                    if (distance < minDistance) {
                                        minDistance = distance;
                                        nearestSide = side;
                                    }
                                });
                            
                                const greenCurvePath = createCurvedPath(x1, y1, 'bottom', nearestSide.x, nearestSide.y, nearestSide.name);
                                const transitionData = currentTransitions.find(t => t.id === fromTransitionId);
                                const transitionColors = getTransitionTheme(transitionData ? transitionData.type : 'Success');
                                line.innerHTML = `<defs><marker id="greenArrowhead" markerWidth="10" markerHeight="10" refX="0" refY="3" orient="auto"><polygon points="0 0, 6 3, 0 6" fill="${transitionColors.color}"/></marker></defs><path d="${greenCurvePath}" stroke="${transitionColors.color}" stroke-width="2" fill="none" marker-end="url(#greenArrowhead)"/>`;
                            }
                        });
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
                        const actionConfig = await getUtilStep(step.action);
                        if (actionConfig && actionConfig.action_config.inputs && actionConfig.action_config.inputs.length > 0) {
                            const inputsContainer = container.querySelector('#koreActionInputsContainer');
                            const inputsContent = container.querySelector('#koreActionInputsContent');
                            
                            // Render input fields
                            inputsContent.innerHTML = actionConfig.action_config.inputs.map((input, idx) => {
                                const currentValue = step.actionInputs?.[input.name] || '';
                                const requiredMark = input.required ? '<span style="color: #ff6666;">*</span>' : '';
                                
                                let inputFieldHTML = '';
                                
                                if (input.type === 'number') {
                                    inputFieldHTML = `
                                        <input 
                                            type="number" 
                                            data-input-name="${input.name}"
                                            placeholder="${input.label || input.name}"
                                            value="${currentValue}"
                                            style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem; margin-bottom: 8px;"
                                        >
                                    `;
                                } else if (input.type === 'boolean') {
                                    inputFieldHTML = `
                                        <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; cursor: pointer;">
                                            <input 
                                                type="checkbox"
                                                data-input-name="${input.name}"
                                                ${currentValue ? 'checked' : ''}
                                                style="cursor: pointer;"
                                            >
                                            <span style="font-size: 0.85rem; color: #b0b0b0;">${input.label || input.name}</span>
                                        </label>
                                    `;
                                } else {
                                    // Default to text
                                    inputFieldHTML = `
                                        <input 
                                            type="text"
                                            data-input-name="${input.name}"
                                            placeholder="${input.label || input.name}"
                                            value="${currentValue}"
                                            style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem; margin-bottom: 8px;"
                                        >
                                    `;
                                }
                                
                                return `
                                    <div style="margin-bottom: 12px;">
                                        <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 4px;">
                                            ${input.label || input.name} ${requiredMark}
                                        </label>
                                        ${inputFieldHTML}
                                    </div>
                                `;
                            }).join('');
                            
                            inputsContainer.style.display = 'block';
                            
                            // Attach change listeners
                            inputsContent.querySelectorAll('[data-input-name]').forEach(inputEl => {
                                inputEl.addEventListener('change', (e) => {
                                    if (!step.actionInputs) {
                                        step.actionInputs = {};
                                    }
                                    const inputName = e.target.getAttribute('data-input-name');
                                    step.actionInputs[inputName] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                                    updatePreview();
                                });
                            });
                        }
                    }, 100);
                }
            })();
            
            // Save action selection when changed
            stepActionInput.addEventListener('change', async (e) => {
                step.action = e.target.value === 'None' ? null : e.target.value;
                
                const inputsContainer = container.querySelector('#koreActionInputsContainer');
                const inputsContent = container.querySelector('#koreActionInputsContent');
                
                if (step.action && step.action !== 'None') {
                    // Load the action config
                    const actionConfig = await getUtilStep(step.action);
                    
                    if (actionConfig && actionConfig.action_config.inputs && actionConfig.action_config.inputs.length > 0) {
                        // Show the inputs container
                        inputsContainer.style.display = 'block';
                        
                        // Render input fields
                        inputsContent.innerHTML = actionConfig.action_config.inputs.map((input, idx) => {
                            const currentValue = step.actionInputs?.[input.name] || '';
                            const requiredMark = input.required ? '<span style="color: #ff6666;">*</span>' : '';
                            
                            let inputFieldHTML = '';
                            
                            if (input.type === 'number') {
                                inputFieldHTML = `
                                    <input 
                                        type="number" 
                                        data-input-name="${input.name}"
                                        placeholder="${input.label || input.name}"
                                        value="${currentValue}"
                                        style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem; margin-bottom: 8px;"
                                    >
                                `;
                            } else if (input.type === 'boolean') {
                                inputFieldHTML = `
                                    <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; cursor: pointer;">
                                        <input 
                                            type="checkbox"
                                            data-input-name="${input.name}"
                                            ${currentValue ? 'checked' : ''}
                                            style="cursor: pointer;"
                                        >
                                        <span style="font-size: 0.85rem; color: #b0b0b0;">${input.label || input.name}</span>
                                    </label>
                                `;
                            } else {
                                // Default to text
                                inputFieldHTML = `
                                    <input 
                                        type="text"
                                        data-input-name="${input.name}"
                                        placeholder="${input.label || input.name}"
                                        value="${currentValue}"
                                        style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem; margin-bottom: 8px;"
                                    >
                                `;
                            }
                            
                            return `
                                <div style="margin-bottom: 12px;">
                                    <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 4px;">
                                        ${input.label || input.name} ${requiredMark}
                                    </label>
                                    ${inputFieldHTML}
                                </div>
                            `;
                        }).join('');
                        
                        // Attach change listeners to input fields
                        inputsContent.querySelectorAll('[data-input-name]').forEach(inputEl => {
                            inputEl.addEventListener('change', (e) => {
                                if (!step.actionInputs) {
                                    step.actionInputs = {};
                                }
                                const inputName = e.target.getAttribute('data-input-name');
                                step.actionInputs[inputName] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                                updatePreview();
                            });
                        });
                    } else {
                        // No inputs for this action
                        inputsContainer.style.display = 'none';
                        inputsContent.innerHTML = '';
                    }
                } else {
                    // No action selected, hide inputs
                    inputsContainer.style.display = 'none';
                    inputsContent.innerHTML = '';
                    step.actionInputs = {};
                }
                
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
                const workflowInputsContainer = container.querySelector('#workflowInputsContainer');
                if (step.action && workflowInputsContainer) {
                    await loadWorkflowInputs(step.action, workflowInputsContainer);
                } else if (workflowInputsContainer) {
                    workflowInputsContainer.style.display = 'none';
                    const contentDiv = workflowInputsContainer.querySelector('#workflowInputsContent');
                    if (contentDiv) contentDiv.innerHTML = '';
                }
                updatePreview();
            });

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
                            loopSourceArray.value = value ? 'Logic → { }' : '';
                            loopSourceArray.disabled = !!value;
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
                                select.innerHTML = '';
                                const selectOption = document.createElement('option');
                                selectOption.value = '';
                                selectOption.textContent = 'Logic → { }';
                                select.appendChild(selectOption);
                                select.value = '';
                                select.disabled = true;
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
                            
                            // If jinja logic exists, disable and show indicator
                            if (hasJinjaLogic) {
                                controlElement.disabled = true;
                                controlElement.value = 'Logic → { }';
                                controlElement.placeholder = 'Logic → { }';
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
                                        selectOption.value = '';
                                        selectOption.textContent = 'Logic → { }';
                                        inputField.appendChild(selectOption);
                                        inputField.value = '';
                                        inputField.disabled = true;
                                    }
                                } else {
                                    inputField.disabled = !!value;
                                    if (value) {
                                        if (inputDef.type !== 'checkbox' && inputDef.type !== 'boolean') {
                                            inputField.value = 'Logic → { }';
                                            inputField.placeholder = 'Logic → { }';
                                        }
                                    }
                                }
                            }
                            
                            updatePreview();
                        },
                        stepId
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
                const val = parseInt(e.target.value);
                step.min_connections = isNaN(val) || val < 0 ? 0 : val;
                e.target.value = step.min_connections;
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
        onListenersAttach,
        isBeginStep ? 'border-bottom: none; margin-bottom: 0; padding-bottom: 0;' : ''
    );
}

function showNodeProperties(nodeId) {
    const node = currentNodes.find(n => n.id === nodeId);
    if (!node) return;
    
    const contentHTML = `
        <div>
            <label style="display: block; font-size: 0.8rem; color: #b0b0b0;">Min Inbound Connections</label>
            <input type="number" id="nodeMinConnections" class="form-field-input" value="${node.min_connections ?? 0}" min="0" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
            <div style="font-size: 0.75rem; color: #707070; margin-top: 4px;">0 = all inbound connections must fire</div>
        </div>
        
        <div style="border-top: 1px solid #3a7a99; padding-top: 10px; margin-top: 10px;">
            <div style="font-size: 0.75rem; color: #707070; word-break: break-all;">ID: ${nodeId}</div>
        </div>
    `;
    
    renderPropertiesPanel(
        'Node Properties',
        '#3a7a99',
        { id: nodeId, type: 'node' },
        contentHTML,
        (container) => {
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
    // Update currentTransitions from the condition boxes in the UI
    document.querySelectorAll('[data-condition-id]').forEach(element => {
        const conditionId = element.getAttribute('data-condition-id');
        const transition = currentTransitions.find(t => t.id === conditionId);
        
        if (transition) {
            // Get the type from the element's data attribute
            const typeAttr = element.getAttribute('data-transition-type');
            if (typeAttr) {
                transition.type = typeAttr;
            }
        }
    });
}

function syncTransitionCasesToStep() {
    // Rebuild transitions from UI first
    rebuildTransitionsFromUI();
    
    // Sync all transition frames and their cases back to the step data
    currentSteps.forEach(step => {
        if (step.transition) {
            // Find the frame for this step using parentStepId
            let frame = currentTransitionFrames.find(f => f.parentStepId === step.id);
            if (frame) {
                // Set attached flag based on whether frame has attachedToStepId
                step.transition.attached = frame.attachedToStepId !== null && frame.attachedToStepId !== undefined;
                
                // Sync frame position and layout
                step.transition.position = frame.position;
                step.transition.vertical = frame.verticalLayout || false;
                
                // Rebuild cases from the current conditions in the frame
                step.transition.cases = frame.conditions.map(conditionId => {
                    const caseObj = currentTransitions.find(t => t.id === conditionId);
                    return caseObj ? {
                        type: caseObj.type,
                        conditions: caseObj.conditions,
                        targetSteps: caseObj.targetSteps ? [...caseObj.targetSteps] : [],
                        targetNodes: caseObj.targetNodes ? [...caseObj.targetNodes] : [],
                        order: caseObj.order
                    } : null;
                }).filter(Boolean);
            }
        }
    });
}

/**
 * Normalize steps for comparison/export: sorts transition cases and strips
 * type-irrelevant fields. Used by both updatePreview and loadWorkflow so that
 * the baseline and the current state are always structurally identical.
 * @param {Array} steps - Raw steps array
 * @returns {Array} Normalized steps array
 */
function normalizeStepsForComparison(steps) {
    return steps.map(step => {
        const exported = {
            ...step,
            transition: step.transition ? {
                ...step.transition,
                attached: step.transition.attached === true,
                cases: [...step.transition.cases].sort((a, b) => (a.order || 1) - (b.order || 1))
            } : undefined
        };
        if (exported.type !== 'Plugin') delete exported.taskInputs;
        if (exported.type !== 'Workflow') {
            delete exported.workflowInputs;
            delete exported.loopMode;
            delete exported.loopConfig;
        }
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
        // Sort cases by order within each transition
        const stepsForExport = normalizeStepsForComparison(currentSteps);
        
        // Log what's being exported for BEGIN step
        const beginStepExport = stepsForExport.find(s => s.type === 'Begin');
        if (beginStepExport && beginStepExport.transition) {
        }
        
        const payload = { 
            id: currentWorkflowId,
            name: currentWorkflowName,
            version: currentVersion,
            view: {
                zoom: zoomLevel,
                pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
            },
            metadata: currentMetadata,
            description: document.getElementById('workflowDescription')?.value || currentDefinition?.description || '',
            inputVariables: currentInputVariables,
            outputVariables: currentOutputVariables,
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
                
                // Delete all transitions of this step
                if (step.transitions) {
                    step.transitions.forEach(transition => {
                        const transitionUUID = transition.id;
                        document.querySelectorAll(`[data-transition-uuid="${transitionUUID}"]`).forEach(el => el.remove());
                        document.querySelectorAll(`[data-from-transition="${transitionUUID}"]`).forEach(el => el.remove());
                        document.querySelectorAll(`[data-to-transition="${transitionUUID}"]`).forEach(el => el.remove());
                        currentTransitions = currentTransitions.filter(t => t.id !== transitionUUID);
                    });
                }
                
                // Remove transition frame(s) for this step
                const framesToRemove = currentTransitionFrames.filter(f => f.parentStepId === elementId);
                framesToRemove.forEach(frame => {
                    // Remove all case lines from this frame's conditions
                    frame.conditions.forEach(conditionId => {
                        document.querySelectorAll(`[data-from-transition="${conditionId}"]`).forEach(el => el.remove());
                    });
                    const frameElement = canvas.querySelector(`[data-transition-frame="${frame.id}"]`);
                    if (frameElement) frameElement.remove();
                });
                currentTransitionFrames = currentTransitionFrames.filter(f => f.parentStepId !== elementId);
                
                // Remove from currentSteps
                currentSteps = currentSteps.filter(s => s.id !== elementId);
                
                // Remove references from all transitions
                currentTransitions.forEach(t => {
                    if (t.targetSteps) {
                        t.targetSteps = t.targetSteps.filter(id => id !== elementId);
                    }
                });
                
                // Remove step DOM element
                const stepElement = canvas.querySelector(`[data-step-uuid="${elementId}"]`);
                if (stepElement) stepElement.remove();
                
                // Remove connection lines
                document.querySelectorAll(`[data-from-step="${elementId}"], [data-to-step="${elementId}"]`).forEach(el => el.remove());
            }
            
            // --- TRANSITION DELETION ---
            else if (elementType === 'transition') {
                // Check if only condition in frame
                const frame = currentTransitionFrames.find(f => f.conditions.includes(elementId));
                if (frame && frame.conditions.length === 1) {
                    alert('A transition frame must have at least one condition. Delete the frame instead.');
                    return;
                }
                
                // Remove from frame's conditions
                if (frame) {
                    frame.conditions = frame.conditions.filter(c => c !== elementId);
                }
                
                // Remove from steps' transitions arrays
                currentSteps.forEach(step => {
                    if (step.transitions) {
                        step.transitions = step.transitions.filter(t => t.id !== elementId);
                    }
                });
                
                // Remove from currentTransitions
                currentTransitions = currentTransitions.filter(t => t.id !== elementId);
                
                // Remove transition DOM element
                const transitionElement = document.querySelector(`[data-condition-id="${elementId}"]`);
                if (transitionElement) {
                    transitionElement.parentElement.remove();
                }
                
                // Remove connection lines
                document.querySelectorAll(`[data-from-transition="${elementId}"]`).forEach(el => el.remove());
                
                // Re-render frame if it exists
                if (frame) {
                    renderTransitionFrame(frame.id, frame.verticalLayout);
                    
                    // Handle step width adjustment after frame re-renders
                    setTimeout(() => {
                        const attachedStep = currentSteps.find(s => s.id === frame.attachedToStepId);
                        if (attachedStep) {
                            const stepElement = canvas.querySelector(`[data-step-uuid="${attachedStep.id}"]`);
                            const frameElement = canvas.querySelector(`[data-transition-frame="${frame.id}"]`);
                            if (stepElement && frameElement) {
                                const currentStepWidth = parseInt(stepElement.style.width);
                                const frameWidth = parseInt(frameElement.style.width);
                                
                                // Calculate original step width
                                const tempDiv = document.createElement('div');
                                tempDiv.style.cssText = `position: absolute; visibility: hidden; font-size: 0.9rem; white-space: nowrap;`;
                                tempDiv.textContent = attachedStep.name || `${attachedStep.type} Step`;
                                document.body.appendChild(tempDiv);
                                const textWidth = tempDiv.offsetWidth;
                                document.body.removeChild(tempDiv);
                                
                                let originalWidth = 120;
                                if (textWidth > 80) {
                                    const gridSpaces = Math.ceil((textWidth - 80) / 30);
                                    originalWidth = 120 + (gridSpaces * 30);
                                }
                                
                                if (currentStepWidth > frameWidth) {
                                    const newWidth = Math.max(originalWidth, currentStepWidth - 30);
                                    stepElement.style.width = newWidth + 'px';
                                    attachedStep.width = newWidth / 30;
                                    
                                    if (newWidth > frameWidth) {
                                        stepElement.style.borderRadius = '4px 4px 4px 0px';
                                    } else {
                                        stepElement.style.borderRadius = '4px 4px 0px 0px';
                                    }
                                }
                            }
                        }
                    }, 50);
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
            
            // --- FRAME DELETION ---
            else if (elementType === 'frame') {
                const frame = currentTransitionFrames.find(f => f.id === elementId);
                if (!frame) return;
                
                // Remove all conditions in the frame
                frame.conditions.forEach(conditionId => {
                    currentTransitions = currentTransitions.filter(t => t.id !== conditionId);
                });
                
                // Remove transition from steps that reference this frame
                currentSteps.forEach(step => {
                    if (step.transition && step.transition.position === frame.position) {
                        delete step.transition;
                    }
                });
                
                // Remove from currentTransitionFrames
                currentTransitionFrames = currentTransitionFrames.filter(f => f.id !== elementId);
                
                // Remove frame DOM element
                const frameElement = canvas.querySelector(`[data-transition-frame="${elementId}"]`);
                if (frameElement) frameElement.remove();
                
                // Remove connection lines
                document.querySelectorAll(`[data-to-frame="${elementId}"]`).forEach(el => el.remove());
                document.querySelectorAll(`[data-connection-line="${elementId}"]`).forEach(el => el.remove());
                
                // Remove orphaned case lines
                document.querySelectorAll('[data-transition-connection-line]').forEach(line => {
                    const conditionId = line.getAttribute('data-from-transition');
                    const targetStepId = line.getAttribute('data-to-step');
                    const conditionExists = currentTransitions.some(t => t.id === conditionId);
                    const stepExists = currentSteps.some(s => s.id === targetStepId);
                    if (!conditionExists || !stepExists) {
                        line.remove();
                    }
                });
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

    // Sync frame.conditions back to step.transition.cases before testing
    currentTransitionFrames.forEach(frame => {
        const step = currentSteps.find(s => s.id === frame.parentStepId);
        if (step && step.transition) {
            step.transition.cases = frame.conditions.map(conditionId => {
                const transition = currentTransitions.find(t => t.id === conditionId);
                return {
                    type: transition?.type || 'Success',
                    conditions: transition?.conditions || '',
                    targetSteps: transition?.targetSteps || [],
                    targetNodes: transition?.targetNodes || [],
                    order: transition?.order || 1
                };
            });
        }
    });

    // Update currentDefinition from current state
    currentDefinition = {
        id: currentWorkflowId,
        name: document.getElementById('workflowName').value.trim(),
        version: currentVersion,
        view: {
            zoom: zoomLevel,
            pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
        },
        metadata: currentMetadata,
        description: document.getElementById('workflowDescription')?.value || '',
        inputVariables: currentInputVariables,
        outputVariables: currentOutputVariables,
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

    // Sync frame.conditions back to step.transition.cases before saving
    currentTransitionFrames.forEach(frame => {
        const step = currentSteps.find(s => s.id === frame.parentStepId);
        if (step && step.transition) {
            step.transition.cases = frame.conditions.map(conditionId => {
                const transition = currentTransitions.find(t => t.id === conditionId);
                return {
                    type: transition?.type || 'Success',
                    conditions: transition?.conditions || '',
                    targetSteps: transition?.targetSteps || [],
                    targetNodes: transition?.targetNodes || [],
                    order: transition?.order || 1
                };
            });
        }
    });

    // Update currentDefinition from current state
    currentDefinition = {
        id: currentWorkflowId,
        name: document.getElementById('workflowName').value.trim(),
        version: currentVersion,
        view: {
            zoom: zoomLevel,
            pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
        },
        metadata: currentMetadata,
        description: document.getElementById('workflowDescription')?.value || '',
        inputVariables: currentInputVariables,
        outputVariables: currentOutputVariables,
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
    // Create modal
    const modalId = 'saveConfirmationModal_' + Date.now();
    const modal = document.createElement('div');
    modal.id = modalId;
    modal.style.cssText = 'display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.7); z-index: 1000; align-items: center; justify-content: center;';
    
    // Build expandable changed fields with visual diff highlighting
    let changesDetailsHTML = '';
    if (changedFields && changedFields.length > 0) {
        const changeDetails = changedFields.map((field) => {
            const oldValue = originalData?.[field];
            const newValue = currentDefinition?.[field];
            
            // For arrays, find specific items that changed
            if (Array.isArray(oldValue) && Array.isArray(newValue)) {
                const arrayChanges = [];
                
                // Compare arrays item by item
                const oldMap = new Map((oldValue || []).map((item, i) => [item.id || item.name || i, item]));
                const newMap = new Map((newValue || []).map((item, i) => [item.id || item.name || i, item]));
                
                // Find added, removed, or modified items
                for (const [key, newItem] of newMap) {
                    const oldItem = oldMap.get(key);
                    const itemLabel = newItem.name || newItem.id || key;
                    
                    if (!oldItem) {
                        // New item - show full object
                        arrayChanges.push({
                            label: `${field.slice(0, -1)} "${itemLabel}" (NEW)`,
                            oldDisplay: '(none)',
                            newDisplay: JSON.stringify(newItem, null, 2),
                            isNew: true
                        });
                    } else if (!deepEqual(oldItem, newItem)) {
                        // Modified item - show full objects with highlighting
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
                // Non-array fields
                const oldDisplay = typeof oldValue === 'object' ? JSON.stringify(oldValue, null, 2) : String(oldValue || '(empty)');
                const newDisplay = typeof newValue === 'object' ? JSON.stringify(newValue, null, 2) : String(newValue || '(empty)');
                
                return [{
                    label: field,
                    oldDisplay: oldDisplay,
                    newDisplay: newDisplay
                }];
            }
        }).flat();
        
        changesDetailsHTML = `
            <div style="margin-bottom: 16px;">
                <div style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 12px; font-weight: 600;">Changed Fields:</div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${changeDetails.map((detail, idx) => {
                        const toggleId = modalId + '_toggle_detail_' + idx;
                        
                        // Build highlighted JSON for modified objects
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
                                <div onclick="document.getElementById('${toggleId}').style.display = document.getElementById('${toggleId}').style.display === 'none' ? 'block' : 'none';" style="padding: 10px; background: var(--bg-input); cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
                                    <span style="color: var(--text-primary); font-size: 0.9rem; font-weight: 500;">${detail.label}</span>
                                    <span style="color: var(--text-muted); font-size: 0.8rem;">▼</span>
                                </div>
                                <div id="${toggleId}" style="display: none; padding: 12px; background: var(--bg-panel3); border-top: 1px solid var(--border-primary);">
                                    <div style="margin-bottom: 8px;">
                                        <div style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 4px;">Old Value:</div>
                                        <div style="padding: 6px 8px; background: var(--bg-input); border-radius: 3px; color: #ffffff; font-size: 0.75rem; font-family: monospace; max-height: 200px; overflow-y: auto; word-break: break-all; white-space: pre-wrap;">${oldDisplayHTML}</div>
                                    </div>
                                    <div>
                                        <div style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 4px;">New Value:</div>
                                        <div style="padding: 6px 8px; background: var(--bg-input); border-radius: 3px; color: #ffffff; font-size: 0.75rem; font-family: monospace; max-height: 200px; overflow-y: auto; word-break: break-all; white-space: pre-wrap;">${newDisplayHTML}</div>
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
                        if (isAdded) lineColor = '#51cf66'; // green
                        else if (isChanged) lineColor = '#ffd43b'; // gold
                    } else {
                        if (isAdded) lineColor = '#ff6b6b'; // red
                        else if (isChanged) lineColor = '#ffd43b'; // gold
                    }
                    
                    const comma = idx < sortedKeys.length - 1 ? ',' : '';
                    
                    // If value is object and changed, recursively show nested diff
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
                        // Primitive value
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
    
    modal.innerHTML = `
        <div style="background: var(--bg-panel2); border: 1px solid var(--border-primary); border-radius: 6px; padding: 24px; max-width: 750px; width: 90%; max-height: 80vh; overflow-y: auto;">
            <h2 style="font-size: 1.2rem; font-weight: 600; margin-bottom: 16px; margin-top: 0; color: var(--text-primary);">Save Workflow</h2>
            
            ${changesDetailsHTML}
            
            <div style="margin-bottom: 16px; padding: 10px; background: var(--bg-input); border-radius: 4px; color: var(--text-primary); font-size: 0.9rem;">
                New Version: <strong>${newVersion}</strong>
            </div>
            
            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button class="btn" data-color="grey" onclick="document.getElementById('${modalId}').remove()">Cancel</button>
                <button class="btn" data-color="green" onclick="document.getElementById('${modalId}').remove(); performSave('${newVersion}')">Save</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
}

function showTestWorkflowModal(changedFields, newVersion) {
    // Create modal
    const modalId = 'testWorkflowModal_' + Date.now();
    const modal = document.createElement('div');
    modal.id = modalId;
    modal.style.cssText = 'display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.7); z-index: 1000; align-items: center; justify-content: center;';
    
    // Build expandable changed fields with visual diff highlighting
    let changesDetailsHTML = '';
    if (changedFields && changedFields.length > 0) {
        const changeDetails = changedFields.map((field) => {
            const oldValue = originalData?.[field];
            const newValue = currentDefinition?.[field];
            
            // For arrays, find specific items that changed
            if (Array.isArray(oldValue) && Array.isArray(newValue)) {
                const arrayChanges = [];
                
                // Compare arrays item by item
                const oldMap = new Map((oldValue || []).map((item, i) => [item.id || item.name || i, item]));
                const newMap = new Map((newValue || []).map((item, i) => [item.id || item.name || i, item]));
                
                // Find added, removed, or modified items
                for (const [key, newItem] of newMap) {
                    const oldItem = oldMap.get(key);
                    const itemLabel = newItem.name || newItem.id || key;
                    
                    if (!oldItem) {
                        // New item - show full object
                        arrayChanges.push({
                            label: `${field.slice(0, -1)} "${itemLabel}" (NEW)`,
                            oldDisplay: '(none)',
                            newDisplay: JSON.stringify(newItem, null, 2),
                            isNew: true
                        });
                    } else if (!deepEqual(oldItem, newItem)) {
                        // Modified item - show full objects with highlighting
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
                // Non-array fields
                const oldDisplay = typeof oldValue === 'object' ? JSON.stringify(oldValue, null, 2) : String(oldValue || '(empty)');
                const newDisplay = typeof newValue === 'object' ? JSON.stringify(newValue, null, 2) : String(newValue || '(empty)');
                
                return [{
                    label: field,
                    oldDisplay: oldDisplay,
                    newDisplay: newDisplay
                }];
            }
        }).flat();
        
        changesDetailsHTML = `
            <div style="margin-bottom: 16px;">
                <div style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 12px; font-weight: 600;">Changed Fields:</div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${changeDetails.map((detail, idx) => {
                        const toggleId = modalId + '_toggle_detail_' + idx;
                        return `
                            <div style="background: var(--bg-input); border-radius: 4px; overflow: hidden;">
                                <div style="padding: 8px 12px; cursor: pointer; font-weight: 500; user-select: none;" onclick="document.getElementById('${toggleId}').style.display = document.getElementById('${toggleId}').style.display === 'none' ? 'block' : 'none'">
                                    ${escapeHtml(detail.label)}
                                </div>
                                <div id="${toggleId}" style="display: none; padding: 8px 12px; background: var(--bg-secondary); border-top: 1px solid var(--border-color); font-size: 0.85rem;">
                                    <div style="margin-bottom: 8px;">
                                        <span style="color: var(--text-muted);">Before:</span>
                                        <pre style="margin: 4px 0; padding: 4px; background: var(--bg-input); border-left: 3px solid var(--text-muted);">${escapeHtml(detail.oldDisplay)}</pre>
                                    </div>
                                    <div>
                                        <span style="color: var(--text-muted);">After:</span>
                                        <pre style="margin: 4px 0; padding: 4px; background: var(--bg-input); border-left: 3px solid var(--accent-color);">${escapeHtml(detail.newDisplay)}</pre>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }
    
    
    modal.innerHTML = `
        <div style="background: var(--bg-primary); border-radius: 8px; padding: 24px; max-width: 600px; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3);">
            <div style="font-size: 1.3rem; font-weight: 600; margin-bottom: 16px; color: var(--text-primary);">Test Workflow</div>
            
            <div style="color: var(--text-secondary); margin-bottom: 20px; font-size: 0.95rem;">
                Review the changes below and click "Save & Test" to save and execute the workflow test.
            </div>
            
            ${changesDetailsHTML}
            
            <div style="margin-bottom: 16px; padding: 10px; background: var(--bg-input); border-radius: 4px; color: var(--text-primary); font-size: 0.9rem;">
                New Version: <strong>${newVersion}</strong>
            </div>
            
            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button class="btn" data-color="grey" onclick="document.getElementById('${modalId}').remove()">Cancel</button>
                <button class="btn" data-color="blue" onclick="(async () => { document.getElementById('${modalId}').remove(); await performSave('${newVersion}'); await new Promise(resolve => setTimeout(resolve, 500)); testWorkflow(); })()">Save & Test</button>
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
                pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
            },
            metadata: currentMetadata,
            description: document.getElementById('workflowDescription')?.value || '',
            inputVariables: currentInputVariables,
            outputVariables: currentOutputVariables,
            steps: currentSteps
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
                    pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
                },
                metadata: currentMetadata,
                description: document.getElementById('workflowDescription')?.value || '',
                inputVariables: currentInputVariables,
                outputVariables: currentOutputVariables,
                steps: currentSteps,
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
                    pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
                },
                metadata: currentMetadata,
                inputVariables: currentInputVariables,
                outputVariables: currentOutputVariables,
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
                    pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
                },
                metadata: currentMetadata,
                inputVariables: currentInputVariables,
                outputVariables: currentOutputVariables,
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
        currentNodes = definition.nodes || [];
        
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
        
        // Build definition object for unsaved changes tracking.
        // Steps must be normalized the same way updatePreview does it so that
        // deepEqual comparisons are valid (same key set, same sort order).
        const workflowDefinition = {
            id: currentWorkflowId,
            name: currentWorkflowName,
            version: currentVersion,
            view: {
                zoom: zoomLevel,
                pan: `${(panX / 30).toFixed(2)},${(panY / 30).toFixed(2)}`
            },
            metadata: currentMetadata,
            description: definition.description || '',
            inputVariables: currentInputVariables,
            outputVariables: currentOutputVariables,
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
        document.getElementById('versionDisplay').textContent = `v${currentVersion}`;
        document.getElementById('uuidDisplay').textContent = currentWorkflowId;
        
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

    // Collect input variable values from form if available
    const parameters = {};
    if (currentInputVariables && currentInputVariables.length > 0) {
        const fields = currentInputVariables.map(v => ({
            type: 'text',
            name: v.name,
            label: v.name,
            value: v.value || '',
            placeholder: `Enter value for ${v.name}`
        }));

        // Show form to collect parameters
        return new Promise((resolve) => {
            showFormModal(
                'Test Workflow Execution',
                fields,
                async (formData) => {
                    // Clean up previous execution state
                    if (window.cleanupPreviousExecution) window.cleanupPreviousExecution();
                    
                    // User submitted the form
                    Object.assign(parameters, formData);
                    await executeWorkflow(parameters);
                    // Auto-open execution details after a brief delay
                    setTimeout(() => {
                        showExecutionResults();
                    }, 100);
                    resolve();
                },
                false,  // readOnly - set to false to show Save button
                false,  // resizable
                false,  // suppressBodyScroll
                'Start Test'  // submitButtonLabel
            );
        });
    } else {
        // No input variables, execute directly
        // Clean up previous execution state
        if (window.cleanupPreviousExecution) window.cleanupPreviousExecution();
        
        await executeWorkflow(parameters);
        // Auto-open execution details after a brief delay
        setTimeout(() => {
            showExecutionResults();
        }, 100);
    }
}

        // Expose initWorkflowEditor to global scope for DOMContentLoaded
        window.initWorkflowEditor = initWorkflowEditor;

function showWorkflowSettingsModal() {
    // Variables to store the working copies from the modal
    let modalInputVariables = [];
    let modalOutputVariables = [];

    const fields = [
        {
            type: 'text',
            name: 'workflowName',
            label: 'Workflow Name',
            value: currentWorkflowName,
            placeholder: 'Enter workflow name',
            required: true
        },
        {
            type: 'textarea',
            name: 'workflowDescription',
            label: 'Description',
            value: currentDefinition.description || '',
            placeholder: 'Enter workflow description',
            rows: 4
        }
    ];

    showFormModal(
        'Workflow Settings',
        fields,
        (formData) => {
            // Commit variable changes from the modal
            currentInputVariables = modalInputVariables;
            currentOutputVariables = modalOutputVariables;
            
            currentWorkflowName = formData.workflowName.trim();
            currentDefinition.name = formData.workflowName.trim();
            document.getElementById('workflowNameDisplay').textContent = formData.workflowName.trim();
            currentDefinition.description = formData.workflowDescription;
            closeWorkflowSettingsModal();
            showStatusBanner('Workflow settings saved', 'success');
            updatePreview();
        },
        false,
        false,
        true
    );

    // Wait for modal to render, then inject variable sections
    setTimeout(() => {
        const modal = document.querySelector('.modal-container');
        if (modal) {
            // Use COPIES of the variables so changes only commit on Save
            modalInputVariables = JSON.parse(JSON.stringify(currentInputVariables));
            modalOutputVariables = JSON.parse(JSON.stringify(currentOutputVariables));
            
            renderWorkflowVariablesSection(modal, modalInputVariables, modalOutputVariables, updatePreview);
        }
    }, 150);
}

function closeWorkflowSettingsModal() {
    // showFormModal modals have their own close mechanism, but keep this for compatibility
    const modal = document.querySelector('.modal-container');
    if (modal) {
        modal.remove();
    }
}

// Expose functions to global scope
window.activateNodePlacementMode = activateNodePlacementMode;
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