// API_KEY is defined in kore-lib.js
        let currentWorkflowId = null;
        let currentWorkflowName = null;
        let currentVersion = null;
        let currentMetadata = null;
        let currentDefinition = null;
        let originalData = null;
        let allVersions = [];
        let currentSteps = [];
        let currentTransitions = [];
        let currentTransitionFrames = [];

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
        function highlightInvalidSteps(unreachableSteps, unreachableNodes) {
            // Clear all invalid classes and borders first
            document.querySelectorAll('.step.invalid, .node.invalid').forEach(el => {
                el.classList.remove('invalid');
                // Remove red border from nodes
                if (el.getAttribute('data-node-id')) {
                    el.style.border = 'none';
                    el.style.borderRadius = '0px';
                }
            });
            
            // Add invalid class to unreachable steps by data-step-uuid
            unreachableSteps.forEach(step => {
                const stepElement = document.querySelector(`[data-step-uuid="${step.id}"]`);
                if (stepElement) {
                    stepElement.classList.add('invalid');
                }
            });
            
            // Add invalid class to unreachable nodes by data-node-id
            // Also add red border directly to the node div
            unreachableNodes.forEach(node => {
                const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
                if (nodeElement) {
                    nodeElement.classList.add('invalid');
                    nodeElement.style.border = '4px solid #cc3333';
                    nodeElement.style.borderRadius = '4px';
                }
            });
        }

        /**
         * Clear invalid highlighting
         */
        function clearInvalidHighlight() {
            document.querySelectorAll('.step.invalid').forEach(el => {
                el.classList.remove('invalid');
            });
        }

        /**
         * Update connectivity banner message with unreachable items
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

        function toggleToolsPanel() {
          const container = document.getElementById('toolsButtonsContainer');
          const btn = document.getElementById('toolsCollapseBtn');
          const panel = document.getElementById('toolsPanel');
          
          toolsPanelCollapsed = !toolsPanelCollapsed;
          
          if (toolsPanelCollapsed) {
            // Collapse
            container.style.display = 'none';
            btn.textContent = '▼';
            panel.style.width = '90px';
          } else {
            // Expand
            container.style.display = 'flex';
            btn.textContent = '▲';
            panel.style.width = '90px';
          }
        }

        // ============================================================================
        // NODE PLACEMENT TOOL
        // ============================================================================
        
        function generateNodeId() {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let id = 'node-';
            for (let i = 0; i < 6; i++) {
                id += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return id;
        }
        
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
        
        function placeNode(x, y) {
          const canvas = document.getElementById('workflowCanvas');
          const nodeId = generateNodeId();
          
          // Snap to 15px grid (half-grid) in pixels
          const snappedX = Math.round(x / 15) * 15;
          const snappedY = Math.round(y / 15) * 15;
          
          // Convert to grid units (30px per unit) for storage
          const gridX = snappedX / 30;
          const gridY = snappedY / 30;
          
          // Create node data object for definition
          const nodeData = {
            id: nodeId,
            position: `${gridX},${gridY}`,
            targetSteps: [],
            targetNodes: []
          };
          
          // Add to current nodes
          currentNodes.push(nodeData);
          
          // Mark unsaved changes
//          markUnsavedChanges();
          updateSaveButtonState();
          updatePreview();
          
          // Render the node
          renderNode(nodeData);
        }
        
        /**
         * Universal function to update all lines connected to a draggable element
         * @param {string} elementId - The ID of the element being dragged (step/frame/node ID)
         * @param {string} elementType - Type of element: 'step', 'frame', or 'node'
         */
        function updateConnectedLines(elementId, elementType) {
          const canvas = document.getElementById('workflowCanvas');
          
          if (elementType === 'step' || elementType === 'frame') {
            // Update case lines from conditions in this step/frame
            let conditionIds = [];
            if (elementType === 'step') {
              const step = currentSteps.find(s => s.id === elementId);
              if (step && step.transition) {
                const frame = currentTransitionFrames.find(f => f.attachedToStepId === elementId);
                if (frame) conditionIds = frame.conditions;
              }
            } else {
              const frame = currentTransitionFrames.find(f => f.id === elementId);
              if (frame) conditionIds = frame.conditions;
            }
            
            conditionIds.forEach(conditionId => {
              const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${conditionId}"]`);
              caseLines.forEach(line => {
                const toStepId = line.getAttribute('data-to-step');
                const toNodeId = line.getAttribute('data-to-node');
                const transition = currentTransitions.find(t => t.id === conditionId);
                const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                const frame = currentTransitionFrames.find(f => f.conditions.includes(conditionId));
                
                if (toStepId) {
                  drawConnectionLine(line, conditionId, 'case', toStepId, 'step', canvas, caseColor, false, frame);
                } else if (toNodeId) {
                  drawConnectionLine(line, conditionId, 'case', toNodeId, 'node', canvas, caseColor, false, frame);
                }
              });
            });
            
            // Update step→frame connection lines (if this is a step)
            if (elementType === 'step') {
              const connectionLines = canvas.querySelectorAll(`[data-connection-line][data-from-step="${elementId}"]`);
              connectionLines.forEach(line => {
                const frameUUID = line.getAttribute('data-connection-line');
                const stepElement = canvas.querySelector(`[data-step-uuid="${elementId}"]`);
                const frameElement = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                if (stepElement && frameElement) {
                  const stepColor = currentSteps.find(s => s.id === elementId)?.type 
                    ? getStepTypeTheme(currentSteps.find(s => s.id === elementId).type).color
                    : '#3a7a99';
                  drawConnectionLine(line, elementId, 'step', frameUUID, 'frame', canvas, stepColor, true);
                }
              });
              
              // Update node connection lines pointing TO this step (when step is moved)
              const inboundNodeLines = canvas.querySelectorAll(`[data-node-connection-line][data-to-step="${elementId}"]`);
              inboundNodeLines.forEach(line => {
                const fromNodeId = line.getAttribute('data-from-node');
                drawConnectionLine(line, fromNodeId, 'node', elementId, 'step', canvas, '#707070', true);
              });
            }
          } else if (elementType === 'node') {
            // Update case lines pointing to this node
            const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-to-node="${elementId}"]`);
            caseLines.forEach(line => {
              const fromTransitionId = line.getAttribute('data-from-transition');
              const frame = currentTransitionFrames.find(f => f.conditions.includes(fromTransitionId));
              const transition = currentTransitions.find(t => t.id === fromTransitionId);
              const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
              drawConnectionLine(line, fromTransitionId, 'case', elementId, 'node', canvas, caseColor, false, frame);
            });
            
            // Update node connection lines from this node (outbound)
            const outboundNodeLines = canvas.querySelectorAll(`[data-node-connection-line][data-from-node="${elementId}"]`);
            outboundNodeLines.forEach(line => {
              const toStepId = line.getAttribute('data-to-step');
              const toNodeId = line.getAttribute('data-to-node');
              const targetType = toStepId ? 'step' : 'node';
              const targetId = toStepId || toNodeId;
              drawConnectionLine(line, elementId, 'node', targetId, targetType, canvas, '#707070', true);
            });
            
            // Update node connection lines pointing TO this node (inbound)
            const inboundNodeLines = canvas.querySelectorAll(`[data-node-connection-line][data-to-node="${elementId}"]`);
            inboundNodeLines.forEach(line => {
              const fromNodeId = line.getAttribute('data-from-node');
              drawConnectionLine(line, fromNodeId, 'node', elementId, 'node', canvas, '#707070', true);
            });
          }
          
          // COMPREHENSIVE FIX: Also update ALL node-to-node and node-to-step lines whenever anything moves
          // This ensures endpoints stick to targets even in edge cases
          const allNodeLines = canvas.querySelectorAll(`[data-node-connection-line]`);
          allNodeLines.forEach(line => {
            const fromNodeId = line.getAttribute('data-from-node');
            const toNodeId = line.getAttribute('data-to-node');
            const toStepId = line.getAttribute('data-to-step');
            
            if (fromNodeId && (toNodeId || toStepId)) {
              const targetId = toNodeId || toStepId;
              const targetType = toNodeId ? 'node' : 'step';
              drawConnectionLine(line, fromNodeId, 'node', targetId, targetType, canvas, '#707070', true);
            }
          });
        }
        
        /**
         * Make any element draggable with universal drag handling
         * @param {HTMLElement} element - The element to make draggable
         * @param {string} elementId - The element's ID
         * @param {string} elementType - Type: 'step', 'frame', or 'node'
         * @param {Function} onDragMove - Callback during drag: (newX, newY, originalElement) => void
         * @param {Function} onDragEnd - Callback after drag: (newX, newY, originalElement) => void
         * @param {Object} options - Additional options: { dragHandle, threshold, snapSize, bounds }
         */
        function makeElementDraggable(element, elementId, elementType, onDragMove, onDragEnd, options = {}) {
          const canvas = document.getElementById('workflowCanvas');
          let isDragging = false;
          let dragOffsetX = 0;
          let dragOffsetY = 0;
          let dragStartX = 0;
          let dragStartY = 0;
          
          const {
            dragHandle = null,
            threshold = 0,
            snapSize = 15,
            bounds = true
          } = options;
          
          element.addEventListener('mousedown', (e) => {
            // Skip if a specific drag handle is required and not clicked
            if (dragHandle && !e.target.closest(dragHandle)) {
              return;
            }
            
            e.stopPropagation();
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            
            const rect = element.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            dragOffsetX = (e.clientX - rect.left) / zoomLevel;
            dragOffsetY = (e.clientY - rect.top) / zoomLevel;
            
            const handleMouseMove = (moveEvent) => {
              if (!isDragging) return;
              
              // Check drag threshold
              if (threshold > 0) {
                const deltaX = Math.abs(moveEvent.clientX - dragStartX);
                const deltaY = Math.abs(moveEvent.clientY - dragStartY);
                if (deltaX < threshold && deltaY < threshold) {
                  return;
                }
              }
              
              // Mark that a drag occurred
              if (elementType === 'node') {
                element.setAttribute('data-was-dragged', 'true');
              }
              
              const canvasRect = canvas.getBoundingClientRect();
              let newX = (moveEvent.clientX - canvasRect.left) / zoomLevel - dragOffsetX;
              let newY = (moveEvent.clientY - canvasRect.top) / zoomLevel - dragOffsetY;
              
              // Snap to grid
              newX = Math.round(newX / snapSize) * snapSize;
              newY = Math.round(newY / snapSize) * snapSize;
              
              // Apply bounds
              if (bounds) {
                newX = Math.max(0, newX);
                newY = Math.max(0, newY);
              }
              
              element.style.left = newX + 'px';
              element.style.top = newY + 'px';
              
              // Call custom drag move handler
              if (onDragMove) {
                onDragMove(newX, newY, element);
              }
              
              // Update lines for this element type
              updateConnectedLines(elementId, elementType);
            };
            
            const handleMouseUp = (upEvent) => {
              if (!isDragging) return;
              
              isDragging = false;
              
              const finalX = parseInt(element.style.left);
              const finalY = parseInt(element.style.top);
              
              // Call custom drag end handler
              if (onDragEnd) {
                onDragEnd(finalX, finalY, element);
              }
              
              // Remove listeners
              document.removeEventListener('mousemove', handleMouseMove);
              document.removeEventListener('mouseup', handleMouseUp);
            };
            
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
          });
        }
        
        function renderNode(nodeData) {
          const canvas = document.getElementById('workflowCanvas');
          const nodeId = nodeData.id;
          const [gridX, gridY] = nodeData.position.split(',').map(Number);
          const snappedX = gridX * 30;
          const snappedY = gridY * 30;
          
          // Create node element - just a filled diamond, 30x30px (1x1 grid)
          const nodeElement = document.createElement('div');
          nodeElement.setAttribute('data-node-id', nodeId);
          nodeElement.style.cssText = `
            position: absolute;
            left: ${snappedX}px;
            top: ${snappedY}px;
            width: 30px;
            height: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 20;
            cursor: move;
            user-select: none;
          `;
          
          // Create SVG with large circle (filled) and small circle at bottom
          const diamondSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          diamondSvg.setAttribute('width', '30');
          diamondSvg.setAttribute('height', '30');
          diamondSvg.setAttribute('viewBox', '0 0 24 24');
          diamondSvg.style.cssText = 'pointer-events: none;';
          
          // Large circle with Node Dark fill and Node Light stroke, plus small circles on all 4 sides
          diamondSvg.innerHTML = `
            <g fill="none" stroke="#707070" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="7.5" fill="#3a3a3a"></circle>
            </g>
            <g stroke="#707070" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none">
              <circle cx="12" cy="3.3" r="2.6" fill="#3a3a3a"></circle>
              <circle cx="3.3" cy="12" r="2.6" fill="#3a3a3a"></circle>
              <circle cx="20.7" cy="12" r="2.6" fill="#3a3a3a"></circle>
              <circle cx="12" cy="20.7" r="2.6" fill="#3a3a3a"></circle>
            </g>
          `;
          nodeElement.appendChild(diamondSvg);
          
          // Add click handler to show properties (but not if node was just dragged)
          nodeElement.addEventListener('click', (e) => {
              e.stopPropagation();
              // Only open properties if the node wasn't dragged
              if (!nodeElement.getAttribute('data-was-dragged')) {
                  showNodeProperties(nodeId);
              }
              nodeElement.removeAttribute('data-was-dragged');
          });
          
          // Create hitbox for all 4 small circles (invisible, for interaction)
          const circleHitbox = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          circleHitbox.setAttribute('width', '30');
          circleHitbox.setAttribute('height', '30');
          circleHitbox.setAttribute('viewBox', '0 0 24 24');
          circleHitbox.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
          `;
          circleHitbox.innerHTML = `
            <circle cx="12" cy="3.3" r="2.8" fill="transparent" pointer-events="auto" data-circle="top" style="cursor: move;"/>
            <circle cx="3.3" cy="12" r="2.8" fill="transparent" pointer-events="auto" data-circle="left" style="cursor: move;"/>
            <circle cx="20.7" cy="12" r="2.8" fill="transparent" pointer-events="auto" data-circle="right" style="cursor: move;"/>
            <circle cx="12" cy="20.7" r="2.8" fill="transparent" pointer-events="auto" data-circle="bottom" style="cursor: move;"/>
          `;
          
          // Add mousedown handler to start drawing connection line from any circle
          circleHitbox.addEventListener('mousedown', (e) => {
            const circle = e.target.closest('[data-circle]');
            if (!circle) return;
            
            e.stopPropagation();
            
            let isDrawing = false;
            let startX, startY;
            let screenStartX, screenStartY;
            
            isDrawing = true;
            const nodeId = nodeElement.getAttribute('data-node-id');
            const nodeData = currentNodes.find(n => n.id === nodeId);
            const circlePosition = circle.getAttribute('data-circle');
            
            // Map circle positions to SVG coordinates
            const circleCoords = {
              top: { cx: 12, cy: 3.3 },
              left: { cx: 3.3, cy: 12 },
              right: { cx: 20.7, cy: 12 },
              bottom: { cx: 12, cy: 20.7 }
            };
            
            const coords = circleCoords[circlePosition];
            const rect = nodeElement.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            
            // Convert SVG coordinates (0-24) to pixel coordinates (0-30)
            const pxX = (coords.cx / 24) * 30;
            const pxY = (coords.cy / 24) * 30;
            
            screenStartX = rect.left - canvasRect.left + pxX;
            screenStartY = rect.top - canvasRect.top + pxY;
            
            startX = (screenStartX / zoomLevel) + panX;
            startY = (screenStartY / zoomLevel) + panY;
            
            const handleMouseMove = (moveEvent) => {
              if (isDrawing) {
                const currentX = moveEvent.clientX - canvasRect.left;
                const currentY = moveEvent.clientY - canvasRect.top;
                
                // Create or update preview line
                let line = canvas.querySelector('[data-preview-line-node]');
                if (!line) {
                  line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                  line.setAttribute('data-preview-line-node', 'true');
                  line.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    pointer-events: none;
                    z-index: 1;
                  `;
                  canvas.appendChild(line);
                }
                
                const scaledX1 = screenStartX / zoomLevel;
                const scaledY1 = screenStartY / zoomLevel;
                const scaledX2 = currentX / zoomLevel;
                const scaledY2 = currentY / zoomLevel;
                
                line.innerHTML = `<line x1="${scaledX1}" y1="${scaledY1}" x2="${scaledX2}" y2="${scaledY2}" stroke="#707070" stroke-width="2"/>`;
              }
            };
            
            const handleMouseUp = (upEvent) => {
              if (isDrawing) {
                isDrawing = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                
                // Remove preview line
                const previewLine = canvas.querySelector('[data-preview-line-node]');
                if (previewLine) previewLine.remove();
                
                // Check if dropped on a step
                const canvasRect = canvas.getBoundingClientRect();
                const dropX = upEvent.clientX - canvasRect.left;
                const dropY = upEvent.clientY - canvasRect.top;
                
                // Get element at drop point
                const elementAtDrop = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
                const stepElement = elementAtDrop?.closest('[data-step-id]');
                const targetNodeElement = elementAtDrop?.closest('[data-node-id]');
                
                if (nodeData) {
                  if (stepElement) {
                    // Connecting to a step
                    const targetStepUUID = stepElement.getAttribute('data-step-uuid');
                    const targetStep = currentSteps.find(s => s.id === targetStepUUID);
                    
                    // Don't allow connections to BEGIN step
                    if (targetStep && targetStep.type === 'Begin') {
                      return; // Skip BEGIN steps
                    }
                    
                    // Check if step is already in targetSteps to prevent duplicate
                    if (!nodeData.targetSteps.includes(targetStepUUID)) {
                      // Add step to targetSteps
                      nodeData.targetSteps.push(targetStepUUID);
                      
                      // Update save button state (will enable save if changes detected)
                      updateSaveButtonState();
                      
                      // Create and draw permanent connection line
                      const line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                      line.setAttribute('data-node-connection-line', 'true');
                      line.setAttribute('data-from-node', nodeId);
                      line.setAttribute('data-to-step', targetStepUUID);
                      line.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                      canvas.appendChild(line);
                      drawConnectionLine(line, nodeId, 'node', targetStepUUID, 'step', canvas, '#707070', true);
                      
                    }
                  } else if (targetNodeElement && targetNodeElement !== nodeElement) {
                    // Connecting to another node
                    const targetNodeId = targetNodeElement.getAttribute('data-node-id');
                    
                    // Check if node is already in targetNodes to prevent duplicate
                    if (!nodeData.targetNodes.includes(targetNodeId)) {
                      // Add node to targetNodes
                      nodeData.targetNodes.push(targetNodeId);
                      
                      // Update save button state
                      updateSaveButtonState();
                      
                      // Create and draw permanent connection line
                      const line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                      line.setAttribute('data-node-connection-line', 'true');
                      line.setAttribute('data-from-node', nodeId);
                      line.setAttribute('data-to-node', targetNodeId);
                      line.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                      canvas.appendChild(line);
                      drawConnectionLine(line, nodeId, 'node', targetNodeId, 'node', canvas, '#707070', true);
                      
                    }
                  } else {
                    // Dropped on empty space - spawn a new node
                    // Snap drop position to 30px grid
                    const gridX = Math.round(dropX / 30);
                    const gridY = Math.round(dropY / 30);
                    
                    // Create new node
                    const newNodeId = 'node-' + Date.now();
                    const newNode = {
                      id: newNodeId,
                      position: `${gridX},${gridY}`,
                      targetSteps: [],
                      targetNodes: []
                    };
                    
                    currentNodes.push(newNode);
                    nodeData.targetNodes.push(newNodeId);
                    
                    // Render the new node
                    renderNode(newNode);
                    
                    // Create and draw connection line to the new node
                    const newNodeElement = canvas.querySelector(`[data-node-id="${newNodeId}"]`);
                    if (newNodeElement) {
                      const line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                      line.setAttribute('data-node-connection-line', 'true');
                      line.setAttribute('data-from-node', nodeId);
                      line.setAttribute('data-to-node', newNodeId);
                      line.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                      canvas.appendChild(line);
                      drawConnectionLine(line, nodeId, 'node', newNodeId, 'node', canvas, '#707070', true);
                    }
                    
                    updateSaveButtonState();
                    updatePreview();
                  }
                }
              }
            };
            
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
          });
          
          nodeElement.appendChild(circleHitbox);
          
          canvas.appendChild(nodeElement);
          
          // Add drag functionality to the node
          makeNodeDraggable(nodeElement, canvas);
        }
        
        function makeNodeDraggable(nodeElement, canvas) {
          const nodeId = nodeElement.getAttribute('data-node-id');
          
          makeElementDraggable(nodeElement, nodeId, 'node', 
            // onDragMove callback
            (newX, newY, element) => {
              const nodeData = currentNodes.find(n => n.id === nodeId);
              if (nodeData) {
                // Convert pixels to grid coordinates
                const gridX = newX / 30;
                const gridY = newY / 30;
                nodeData.position = `${gridX},${gridY}`;
              }
            },
            // onDragEnd callback
            (finalX, finalY, element) => {
              const nodeData = currentNodes.find(n => n.id === nodeId);
              if (nodeData) {
                // Convert pixels to grid coordinates
                const gridX = finalX / 30;
                const gridY = finalY / 30;
                nodeData.position = `${gridX},${gridY}`;
                updateSaveButtonState();
                updatePreview();
              }
            },
            // options
            {
              snapSize: 15,
              bounds: true
            }
          );
        }

        
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

        function updateZoomDisplay() {
            const zoomDisplay = document.getElementById('zoomDisplay');
            if (zoomDisplay) {
                zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
            }
        }

        function showPropertiesPanel() {
            const panel = document.getElementById('propertiesPanel');
            if (panel) panel.style.display = 'block';
        }

        function hidePropertiesPanel() {
            const panel = document.getElementById('propertiesPanel');
            if (panel) panel.style.display = 'none';
        }

        function renderPropertiesPanel(title, borderColor, deleteButtonConfig, contentHTML, onListenersAttach) {
            const propertiesContent = document.getElementById('propertiesContent');
            showPropertiesPanel();
            
            const deleteButtonHTML = deleteButtonConfig 
                ? `<button class="btn" data-color="red" onclick="deleteElement('${deleteButtonConfig.id}', '${deleteButtonConfig.type}')" style="padding: 6px 12px;">Delete</button>`
                : '';
            
            propertiesContent.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid ${borderColor};">
                    <div style="font-size: 0.9rem; color: #e0e0e0; font-weight: 500;">${title}</div>
                    ${deleteButtonHTML}
                </div>
                <div style="display: flex; flex-direction: column; gap: 15px;">
                    ${contentHTML}
                </div>
            `;
            
            // Call the type-specific listener setup function
            if (typeof onListenersAttach === 'function') {
                onListenersAttach(propertiesContent);
            }
        }

        function toggleStepTypesPanel() {
            const panel = document.getElementById('stepTypesPanel');
            const list = document.getElementById('stepTypesList');
            const button = document.getElementById('stepTypesToggle');
            const title = document.getElementById('stepTypesTitle');
            const header = document.getElementById('stepTypeHeader');
            
            if (panel.style.width === '20px') {
                // Expand
                panel.style.width = '150px';
                list.style.display = 'flex';
                button.textContent = '◀';
                button.style.marginBottom = '0';
                title.style.writingMode = 'horizontal-tb';
                title.style.transform = 'none';
                header.style.flexDirection = 'row';
            } else {
                // Collapse
                panel.style.width = '20px';
                list.style.display = 'none';
                button.textContent = '▶';
                button.style.marginBottom = '8px';
                title.style.writingMode = 'vertical-lr';
                title.style.transform = 'none';
                header.style.flexDirection = 'column-reverse';
            }
        }

        function zoomIn() {
            const canvas = document.getElementById('workflowCanvas');
            const container = document.getElementById('canvasContainer');
            if (!canvas || !container) return;
            
            const rect = container.getBoundingClientRect();
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            
            const newZoom = Math.min(2, zoomLevel + 0.05);
            
            // Adjust pan to zoom toward center
            panX = centerX / newZoom + (panX * zoomLevel / newZoom) - centerX / newZoom;
            panY = centerY / newZoom + (panY * zoomLevel / newZoom) - centerY / newZoom;
            
            zoomLevel = newZoom;
            
            // Clamp pan
            const containerWidth = rect.width;
            const containerHeight = rect.height;
            const GRID_SIZE_PX = 5000;
            const maxPanX = GRID_SIZE_PX - (containerWidth / zoomLevel);
            const maxPanY = GRID_SIZE_PX - (containerHeight / zoomLevel);
            panX = Math.min(panX, maxPanX);
            panY = Math.min(panY, maxPanY);
            
            canvas.style.transform = `scale(${zoomLevel}) translate(${-panX}px, ${-panY}px)`;
            updateZoomDisplay();
            updatePreview();
        }

        function zoomOut() {
            const canvas = document.getElementById('workflowCanvas');
            const container = document.getElementById('canvasContainer');
            if (!canvas || !container) return;
            
            const rect = container.getBoundingClientRect();
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            
            const newZoom = Math.max(0.55, zoomLevel - 0.05);
            
            // Adjust pan to zoom toward center
            panX = centerX / newZoom + (panX * zoomLevel / newZoom) - centerX / newZoom;
            panY = centerY / newZoom + (panY * zoomLevel / newZoom) - centerY / newZoom;
            
            zoomLevel = newZoom;
            
            // Clamp pan
            const containerWidth = rect.width;
            const containerHeight = rect.height;
            const GRID_SIZE_PX = 5000;
            const maxPanX = GRID_SIZE_PX - (containerWidth / zoomLevel);
            const maxPanY = GRID_SIZE_PX - (containerHeight / zoomLevel);
            panX = Math.min(panX, maxPanX);
            panY = Math.min(panY, maxPanY);
            
            canvas.style.transform = `scale(${zoomLevel}) translate(${-panX}px, ${-panY}px)`;
            updateZoomDisplay();
            updatePreview();
        }

        function resetZoom() {
            const canvas = document.getElementById('workflowCanvas');
            if (!canvas) return;
            
            zoomLevel = 1;
            panX = 0;
            panY = 0;
            
            canvas.style.transform = `scale(1) translate(0px, 0px)`;
            updateZoomDisplay();
            updatePreview();
        }

        function getUrlParams() {
            const params = new URLSearchParams(window.location.search);
            return {
                id: params.get('id')
            };
        }



        function renderLoadedStepsOnCanvas() {
            const canvas = document.getElementById('workflowCanvas');
            if (!canvas) return;
            
            // Clear any existing steps and frames from canvas
            document.querySelectorAll('[data-step-id]').forEach(el => el.remove());
            document.querySelectorAll('[data-transition-frame]').forEach(el => el.remove());
            document.querySelectorAll('[data-connection-line]').forEach(el => el.remove());
            document.querySelectorAll('[data-transition-connection-line]').forEach(el => el.remove());
            document.querySelectorAll('[data-node-id]').forEach(el => el.remove());
            document.querySelectorAll('[data-node-connection-line]').forEach(el => el.remove());
            
            // Render each loaded step on canvas
            currentSteps.forEach(step => {
                renderStep(step);
            });
            
            // Render each loaded node on canvas
            currentNodes.forEach(node => {
                renderNode(node);
                makeNodeDraggable(canvas.querySelector(`[data-node-id="${node.id}"]`), canvas);
            });
            
            // Create node connection lines for loaded nodes
            currentNodes.forEach(node => {
                // Create lines from this node to target steps
                if (node.targetSteps && node.targetSteps.length > 0) {
                    node.targetSteps.forEach(targetStepId => {
                        const lineUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                        const nodeLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                        nodeLine.setAttribute('data-node-connection-line', lineUUID);
                        nodeLine.setAttribute('data-from-node', node.id);
                        nodeLine.setAttribute('data-to-step', targetStepId);
                        nodeLine.style.cssText = `
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            pointer-events: none;
                            z-index: 1;
                        `;
                        canvas.appendChild(nodeLine);
                        drawConnectionLine(nodeLine, node.id, 'node', targetStepId, 'step', canvas, '#707070', true);
                    });
                }
                
                // Create lines from this node to target nodes
                if (node.targetNodes && node.targetNodes.length > 0) {
                    node.targetNodes.forEach(targetNodeId => {
                        const lineUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                        const nodeLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                        nodeLine.setAttribute('data-node-connection-line', lineUUID);
                        nodeLine.setAttribute('data-from-node', node.id);
                        nodeLine.setAttribute('data-to-node', targetNodeId);
                        nodeLine.style.cssText = `
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            pointer-events: none;
                            z-index: 1;
                        `;
                        canvas.appendChild(nodeLine);
                        drawConnectionLine(nodeLine, node.id, 'node', targetNodeId, 'node', canvas, '#707070', true);
                    });
                }
            });
            
            // Convert step.transition data into transition frames
            currentSteps.forEach(step => {
                if (step.transition && step.transition.position) {
                    // Check if frame already exists for this position
                    const existingFrame = currentTransitionFrames.find(f => f.position === step.transition.position);
                    if (!existingFrame) {
                        // Extract condition IDs and populate currentTransitions
                        const conditionIds = [];
                        if (step.transition.cases) {
                            step.transition.cases.forEach(caseData => {
                                transitionCounter++;
                                const conditionId = String(transitionCounter);
                                conditionIds.push(conditionId);
                                
                                // Add to currentTransitions
                                currentTransitions.push({
                                    id: conditionId,
                                    name: caseData.name || '',
                                    type: caseData.type || 'Success',
                                    conditions: caseData.conditions || '',
                                    targetSteps: caseData.targetSteps || [],
                                    targetNodes: caseData.targetNodes || [],
                                    order: caseData.order || 1,
                                    parentStepId: step.id  // Add source step ID
                                });
                            });
                        }
                        
                        const frameData = {
                            id: `frame-${step.id}`,
                            execution: step.transition.mode || 'First',
                            conditions: conditionIds,
                            position: step.transition.position,
                            verticalLayout: step.transition.vertical || false,
                            attachedToStepId: step.transition.attached ? step.id : null,
                            parentStepId: step.id
                        };
                        currentTransitionFrames.push(frameData);
                    }
                }
            });
            
            // Render transition frames and their connections
            currentTransitionFrames.forEach(frame => {
                renderTransitionFrame(frame.id, frame.verticalLayout);
            });
            
            // Restore frame attachments to steps immediately after rendering
            const workflowCanvas = document.getElementById('workflowCanvas');
            currentTransitionFrames.forEach(frame => {
                if (frame.attachedToStepId) {
                    const attachedStep = currentSteps.find(s => s.id === frame.attachedToStepId);
                    if (attachedStep) {
                        const stepElement = workflowCanvas.querySelector(`[data-step-uuid="${attachedStep.id}"]`);
                        const frameElement = workflowCanvas.querySelector(`[data-transition-frame="${frame.id}"]`);
                        if (stepElement && frameElement) {
                            // Position frame at same location as step
                            const stepPos = attachedStep.position.split(',').map(Number);
                            frameElement.style.left = (stepPos[0] * 30) + 'px';
                            frameElement.style.top = (stepPos[1] * 30) + 'px';
                            
                            const stepWidth = parseInt(stepElement.style.width);
                            const frameWidth = parseInt(frameElement.style.width);
                            
                            // Apply the appropriate border radius based on width comparison
                            if (stepWidth > frameWidth) {
                                stepElement.style.borderRadius = '4px 4px 4px 0px';
                            } else {
                                stepElement.style.borderRadius = '4px 4px 0px 0px';
                            }
                            
                            // Hide connection circle
                            const connectionPoint = stepElement.querySelector('[data-connection-point]');
                            if (connectionPoint) {
                                connectionPoint.style.display = 'none';
                            }
                            
                            // Hide transition connection line from this step
                            const transitionLines = workflowCanvas.querySelectorAll(`[data-connection-line][data-from-step="${attachedStep.id}"]`);
                            transitionLines.forEach(line => line.style.display = 'none');
                        }
                    }
                }
            });
            
            // Use setTimeout to ensure all DOM elements are ready before repositioning connections
            setTimeout(() => {
                requestAnimationFrame(() => {
                    // Reposition connection points and update blue lines for all frames
                currentTransitionFrames.forEach(frame => {
                    const frameElement = canvas.querySelector(`[data-transition-frame="${frame.id}"]`);
                    if (frameElement) {
                        // Find the owning step
                        const owningStep = currentSteps.find(step => step.transition && step.transition.position === frame.position);
                        if (owningStep) {
                            // Get or create the connection point on the step
                            const stepElement = canvas.querySelector(`[data-step-uuid="${owningStep.id}"]`);
                            if (stepElement) {
                                let connectionPoint = stepElement.querySelector('[data-connection-point]');
                                if (!connectionPoint) {
                                    // Create connection point if it doesn't exist
                                    connectionPoint = document.createElement('div');
                                    connectionPoint.setAttribute('data-connection-point', 'dynamic');
                                    stepElement.appendChild(connectionPoint);
                                }
                                
                            // Calculate which side of the step is closest to the frame
                            const connectionSide = getClosestSideToFrame(stepElement, frameElement, canvas);
                            
                            const positionStyles = {
                                'top': 'top: -6px; left: 50%; transform: translateX(-50%);',
                                'bottom': 'bottom: -6px; left: 50%; transform: translateX(-50%);',
                                'left': 'left: -6px; top: 50%; transform: translateY(-50%);',
                                'right': 'right: -6px; top: 50%; transform: translateY(-50%);'
                            };
                            
                            connectionPoint.setAttribute('data-connected', 'true');
                            connectionPoint.classList.add('connectionPoint');
                            connectionPoint.style.cssText = `
                                ${positionStyles[connectionSide]}
                            `;
                            
                            // Create and update the transition connection line
                            let connectionLine = canvas.querySelector(`[data-connection-line][data-from-step="${owningStep.id}"]`);
                            if (!connectionLine) {
                                connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                                connectionLine.setAttribute('data-connection-line', frame.id);  // Use frame.id directly, not 'connection-' + frame.id
                                connectionLine.setAttribute('data-from-step', owningStep.id);
                                connectionLine.style.cssText = `
                                    position: absolute;
                                    top: 0;
                                    left: 0;
                                    width: 100%;
                                    height: 100%;
                                    pointer-events: none;
                                    z-index: 5;
                                `;
                                canvas.appendChild(connectionLine);
                            }
                            
                            // Update the connection line with the correct side
                            updateTransitionLine(connectionLine, frame.id, owningStep.id, connectionSide, canvas);
                            }
                        }
                    }
                    
                    // Render case lines (connections from conditions to target steps and nodes)
                    frame.conditions.forEach(conditionId => {
                        const transition = currentTransitions.find(t => t.id === conditionId);
                        if (transition) {
                            // Create arrows for all targetSteps
                            if (transition.targetSteps && transition.targetSteps.length > 0) {
                                transition.targetSteps.forEach(targetStepId => {
                                    // Create case line element
                                    const lineUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                                    const caseLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                                    caseLine.setAttribute('data-transition-connection-line', lineUUID);
                                    caseLine.setAttribute('data-from-transition', conditionId);
                                    caseLine.setAttribute('data-to-step', targetStepId);
                                    caseLine.style.cssText = `
                                        position: absolute;
                                        top: 0;
                                        left: 0;
                                        width: 100%;
                                        height: 100%;
                                        pointer-events: none;
                                        z-index: 5;
                                    `;
                                    canvas.appendChild(caseLine);
                                    
                                    // Add mousedown listener to prevent frame drag when clicking case arrow
                                    caseLine.addEventListener('mousedown', (e) => {
                                        if (e.target.closest('[data-case-arrow-hitbox]')) {
                                            e.stopPropagation();
                                        }
                                    });
                                    
                                    // Render the case line
                                    const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                                    drawConnectionLine(caseLine, conditionId, 'case', targetStepId, 'step', canvas, caseColor, false, frame);
                                });
                            }
                            
                            // Create arrows for all targetNodes
                            if (transition.targetNodes && transition.targetNodes.length > 0) {
                                transition.targetNodes.forEach(targetNodeId => {
                                    // Create case line element
                                    const lineUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                                    const caseLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                                    caseLine.setAttribute('data-transition-connection-line', lineUUID);
                                    caseLine.setAttribute('data-from-transition', conditionId);
                                    caseLine.setAttribute('data-to-node', targetNodeId);
                                    caseLine.style.cssText = `
                                        position: absolute;
                                        top: 0;
                                        left: 0;
                                        width: 100%;
                                        height: 100%;
                                        pointer-events: none;
                                        z-index: 5;
                                    `;
                                    canvas.appendChild(caseLine);
                                    
                                    // Add mousedown listener to prevent frame drag when clicking case arrow
                                    caseLine.addEventListener('mousedown', (e) => {
                                        if (e.target.closest('[data-case-arrow-hitbox]')) {
                                            e.stopPropagation();
                                        }
                                    });
                                    
                                    // Render the case line to node
                                    const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                                    drawConnectionLine(caseLine, conditionId, 'case', targetNodeId, 'node', canvas, caseColor, false, frame);
                                });
                            }
                        }
                    });
                });
                
                // After all connections are created, hide those belonging to attached frames
                currentTransitionFrames.forEach(frame => {
                    if (frame.attachedToStepId) {
                        const owningStep = currentSteps.find(step => step.transition && step.transition.position === frame.position);
                        if (owningStep) {
                            // Hide connection point
                            const stepElement = canvas.querySelector(`[data-step-uuid="${owningStep.id}"]`);
                            if (stepElement) {
                                const connectionPoint = stepElement.querySelector('[data-connection-point]');
                                if (connectionPoint) {
                                    connectionPoint.style.display = 'none';
                                }
                            }
                            
                            // Hide transition connection line
                            const connectionLine = canvas.querySelector(`[data-connection-line][data-from-step="${owningStep.id}"]`);
                            if (connectionLine) {
                                connectionLine.style.display = 'none';
                            }
                        }
                    }
                });
                });
            }, 300);
        }

        // Universal drop target detection with 50px margin
        // Returns { droppedOnStep: id or null, droppedOnNode: id or null }
        function detectDropTarget(canvas, clientX, clientY) {
            let droppedOnStep = null;
            let droppedOnNode = null;
            
            const CATCH_AREA = 29;
            
            canvas.querySelectorAll('[data-step-uuid]').forEach(stepElement => {
                const stepId = stepElement.getAttribute('data-step-uuid');
                const step = currentSteps.find(s => s.id === stepId);
                
                // Don't allow connections to BEGIN step
                if (step && step.type === 'Begin') {
                    return;
                }
                
                const rect = stepElement.getBoundingClientRect();
                if (clientX >= rect.left - CATCH_AREA && clientX <= rect.right + CATCH_AREA &&
                    clientY >= rect.top - CATCH_AREA && clientY <= rect.bottom + CATCH_AREA) {
                    droppedOnStep = stepId;
                }
            });
            
            // Check for nodes
            canvas.querySelectorAll('[data-node-id]').forEach(nodeElement => {
                const rect = nodeElement.getBoundingClientRect();
                if (clientX >= rect.left - CATCH_AREA && clientX <= rect.right + CATCH_AREA &&
                    clientY >= rect.top - CATCH_AREA && clientY <= rect.bottom + CATCH_AREA) {
                    droppedOnNode = nodeElement.getAttribute('data-node-id');
                }
            });
            
            return { droppedOnStep, droppedOnNode };
        }


        function showJSONModal() {
            // Rebuild input and output variables from form to get current state
            rebuildInputVariablesFromForm();
            rebuildOutputVariablesFromForm();
            
            // Sort cases by order within each transition
            const stepsForExport = currentSteps.map(step => ({
                ...step,
                transition: step.transition ? {
                    ...step.transition,
                    cases: Array.isArray(step.transition.cases) ? [...step.transition.cases].sort((a, b) => (a.order || 1) - (b.order || 1)) : []
                } : undefined
            }));
            
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


        function renderTransitionFrame(frameUUID, vertical) {
            const canvas = document.getElementById('workflowCanvas');
            const frame = currentTransitionFrames.find(f => f.id === frameUUID);
            if (!frame) return;
            
            // Remove old frame element if it exists
            const oldFrame = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
            let framePosition = { left: 0, top: 0 };
            if (oldFrame) {
                framePosition = {
                    left: oldFrame.style.left,
                    top: oldFrame.style.top
                };
                oldFrame.remove();
            } else if (frame.position) {
                // If no DOM element but frame has position data, use it
                // Position is stored in 30px grid coordinates but visual position uses 30px per grid unit
                const [gridX, gridY] = frame.position.split(',').map(Number);
                framePosition = {
                    left: (gridX * 30) + 'px',
                    top: (gridY * 30) + 'px'
                };
            }
            
            // Create new frame container
            const frameRect = document.createElement('div');
            frameRect.setAttribute('data-transition-frame', frameUUID);
            
            if (vertical) {
                // Vertical layout: 60px wide, height grows with conditions
                // Each condition gets a full grid box (30px): (conditions + 2) * 30
                const frameHeight = (frame.conditions.length + 1) * 30;
                frameRect.style.cssText = `
                    position: absolute;
                    width: 60px;
                    height: ${frameHeight}px;
                    left: ${framePosition.left};
                    top: ${framePosition.top};
                    background: #d4af37;
                    border: 2px solid #d4af37;
                    border-radius: 4px;
                    pointer-events: auto;
                    cursor: move;
                    box-sizing: border-box;
                    z-index: 10;
                    display: flex;
                    flex-direction: row;
                `;
                
                // Header: left section, vertically centered
                const header = document.createElement('div');
                header.setAttribute('data-frame-header', frameUUID);
                const verticalHeaderFontSize = frame.conditions.length >= 2 ? '0.8rem' : '0.7rem';
                header.style.cssText = `
                    padding: 0;
                    background: #2a2a1a;
                    writing-mode: vertical-rl;
                    transform: rotate(180deg);
                    text-align: center;
                    color: #d4af37;
                    font-size: ${verticalHeaderFontSize};
                    font-weight: normal;
                    cursor: move;
                    user-select: none;
                    width: 28px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    pointer-events: auto;
                    white-space: nowrap;
                    flex-shrink: 0;
                    border-radius: 4px;
                `;
                header.textContent = 'Transitions';
                header.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showTransitionFrameProperties(frameUUID);
                });
                frameRect.appendChild(header);
                
                // Conditions container: right 2/3rds (60px), split vertically
                const conditionsContainer = document.createElement('div');
                conditionsContainer.setAttribute('data-frame-conditions', frameUUID);
                conditionsContainer.style.cssText = `
                    background: #d4af37;
                    border-left: 2px solid #d4af37;
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    pointer-events: auto;
                    gap: 0;
                    padding: 0;
                `;
                
                // Add condition boxes - sort by order first
                const sortedConditions = frame.conditions
                    .map(cId => currentTransitions.find(t => t.id === cId))
                    .filter(t => t)
                    .sort((a, b) => (a.order || 1) - (b.order || 1))
                    .map(t => t.id);
                
                sortedConditions.forEach(conditionId => {
                    const transition = currentTransitions.find(t => t.id === conditionId);
                    const colors = getTransitionTheme(transition ? transition.type : 'Success');
                    
                    const wrapper = document.createElement('div');
                    wrapper.style.cssText = `
                        position: relative;
                        display: flex;
                        flex-direction: row;
                        align-items: center;
                        justify-content: center;
                        flex: 1;
                    `;
                    
                    const conditionBox = document.createElement('div');
                    conditionBox.setAttribute('data-condition-id', conditionId);
                    conditionBox.setAttribute('data-transition-type', transition ? transition.type : 'Success');
                    conditionBox.setAttribute('data-frame-id', frameUUID);
                    const boxColor = colors.color;
                    conditionBox.style.cssText = `
                        width: 26px;
                        height: 26px;
                        margin: 0 0 2px 0;
                        background: ${boxColor};
                        border: none;
                        border-radius: 2px;
                        text-align: center;
                        color: #ffffff;
                        font-size: 0.7rem;
                        font-weight: bold;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        user-select: none;
                        flex-shrink: 0;
                        cursor: pointer;
                        line-height: 1;
                    `;
                    const transitionType = transition ? transition.type : 'Success';
                    let icon = getTransitionTheme(transitionType).icon;
                    if (transitionType === 'Always') {
                        icon = `<span style="display: inline-block; transform: scaleY(2);">&#9658;</span>`;  // right triangle stretched
                    }
                    conditionBox.innerHTML = icon;
                    conditionBox.addEventListener('click', (e) => {
                        e.stopPropagation();
                        showTransitionProperties(conditionId);
                    });
                    
                    // Add drag functionality for vertical layout
                    let isDraggingCondition = false;
                    let dragStartIndex = -1;
                    
                    conditionBox.addEventListener('mousedown', (e) => {
                        if (e.button !== 0) return; // Only left mouse button
                        e.stopPropagation();
                        isDraggingCondition = true;
                        dragStartIndex = sortedConditions.indexOf(conditionId);
                        conditionBox.style.opacity = '0.6';
                    });
                    
                    document.addEventListener('mousemove', (e) => {
                        if (!isDraggingCondition || dragStartIndex === -1) return;
                        
                        // Find which condition box is under the cursor
                        const conditionBoxes = conditionsContainer.querySelectorAll('[data-condition-id]');
                        let targetIndex = -1;
                        
                        conditionBoxes.forEach((box, idx) => {
                            const rect = box.getBoundingClientRect();
                            if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
                                targetIndex = idx;
                            }
                        });
                        
                        if (targetIndex !== -1 && targetIndex !== dragStartIndex) {
                            // Reorder conditions
                            const draggedCondition = currentTransitions.find(t => t.id === conditionId);
                            const targetCondition = currentTransitions.find(t => t.id === sortedConditions[targetIndex]);
                            
                            if (draggedCondition && targetCondition) {
                                const draggedOrder = draggedCondition.order;
                                const targetOrder = targetCondition.order;
                                
                                if (targetIndex > dragStartIndex) {
                                    // Moving down - decrement orders of conditions we pass
                                    for (let i = dragStartIndex + 1; i <= targetIndex; i++) {
                                        const cond = currentTransitions.find(t => t.id === sortedConditions[i]);
                                        if (cond) cond.order--;
                                    }
                                    draggedCondition.order = targetOrder;
                                } else {
                                    // Moving up - increment orders of conditions we pass
                                    for (let i = targetIndex; i < dragStartIndex; i++) {
                                        const cond = currentTransitions.find(t => t.id === sortedConditions[i]);
                                        if (cond) cond.order++;
                                    }
                                    draggedCondition.order = targetOrder;
                                }
                                
                                dragStartIndex = targetIndex;
                                renderTransitionFrame(frameUUID, true);
                                updatePreview();
                            }
                        }
                    });
                    
                    document.addEventListener('mouseup', () => {
                        isDraggingCondition = false;
                        dragStartIndex = -1;
                        conditionBox.style.opacity = '1';
                    });
                    
                    wrapper.appendChild(conditionBox);
                    
                    // Right-pointing triangle with hitbox
                    const triangle = document.createElement('div');
                    const boxCenterY = conditionBox.offsetTop + 13; // 13 is half of 26px height
                    triangle.style.cssText = `
                        position: absolute;
                        width: 0;
                        height: 0;
                        border-top: 8px solid transparent;
                        border-bottom: 8px solid transparent;
                        border-left: 10px solid #d4af37;
                        left: 28px;
                        top: ${boxCenterY}px;
                        transform: translateY(-50%);
                    `;
                    
                    // Invisible hitbox for dragging - only on the right side
                    const hitbox = document.createElement('div');
                    hitbox.setAttribute('data-transition-arrow', conditionId);
                    hitbox.style.cssText = `
                        position: absolute;
                        width: 25px;
                        height: 30px;
                        left: 32px;
                        top: ${boxCenterY}px;
                        transform: translateY(-50%);
                        cursor: move;
                        z-index: 1;
                    `;
                    wrapper.appendChild(triangle);
                    wrapper.appendChild(hitbox);
                    
                    conditionsContainer.appendChild(wrapper);
                });
                
                // Add + button
                const addButton = document.createElement('div');
                addButton.setAttribute('data-add-condition-btn', frameUUID);
                addButton.style.cssText = `
                    width: 26px;
                    height: 26px;
                    max-height: 26px;
                    padding: 0;
                    margin: 0;
                    background: #d4af37;
                    border: none;
                    border-radius: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: #3a3a2a;
                    font-size: 18px;
                    cursor: pointer;
                    user-select: none;
                    flex-shrink: 0;
                    flex-grow: 0;
                `;
                addButton.textContent = '+';
                addButton.addEventListener('click', addConditionToFrame(frameUUID, conditionsContainer));
                conditionsContainer.appendChild(addButton);
                
                frameRect.appendChild(conditionsContainer);
            } else {
                // Horizontal layout: 60px base + 30px per additional condition
                const numConditions = frame.conditions.length;
                const frameWidth = 60 + Math.max(0, (numConditions - 1) * 30);
                frameRect.style.cssText = `
                    position: absolute;
                    width: ${frameWidth}px;
                    height: 60px;
                    left: ${framePosition.left};
                    top: ${framePosition.top};
                    background: #d4af37;
                    border: 2px solid #d4af37;
                    border-radius: 4px;
                    pointer-events: auto;
                    cursor: move;
                    box-sizing: border-box;
                    z-index: 10;
                    display: flex;
                    flex-direction: column;
                `;
                
                // Header: top, full width
                const header = document.createElement('div');
                header.setAttribute('data-frame-header', frameUUID);
                const headerFontSize = frameWidth === 60 ? '0.7rem' : '0.8rem';
                header.style.cssText = `
                    padding: 0;
                    background: #2a2a1a;
                    text-align: center;
                    color: #d4af37;
                    font-size: ${headerFontSize};
                    font-weight: normal;
                    cursor: pointer;
                    user-select: none;
                    height: 28px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    pointer-events: auto;
                    border-radius: 4px;
                    flex-shrink: 0;
                `;
                header.textContent = 'Transitions';
                header.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showTransitionFrameProperties(frameUUID);
                });
                frameRect.appendChild(header);
                
                // Conditions container: bottom, full width
                const conditionsContainer = document.createElement('div');
                conditionsContainer.setAttribute('data-frame-conditions', frameUUID);
                conditionsContainer.style.cssText = `
                    background: #d4af37;
                    flex: 1;
                    display: flex;
                    align-items: flex-start;
                    pointer-events: auto;
                    margin-top: 2px;
                    height: 26px;
                    overflow: visible;
                `;
                
                // Add condition boxes - sort by order first
                const sortedConditions = frame.conditions
                    .map(cId => currentTransitions.find(t => t.id === cId))
                    .filter(t => t)
                    .sort((a, b) => (a.order || 1) - (b.order || 1))
                    .map(t => t.id);
                
                sortedConditions.forEach(conditionId => {
                    const transition = currentTransitions.find(t => t.id === conditionId);
                    const colors = getTransitionTheme(transition ? transition.type : 'Success');
                    
                    const wrapper = document.createElement('div');
                    wrapper.style.cssText = `
                        position: relative;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                    `;
                    
                    const conditionBox = document.createElement('div');
                    conditionBox.setAttribute('data-condition-id', conditionId);
                    conditionBox.setAttribute('data-transition-type', transition ? transition.type : 'Success');
                    conditionBox.setAttribute('data-frame-id', frameUUID);
                    const boxColor = colors.color;
                    conditionBox.style.cssText = `
                        width: 26px;
                        height: 26px;
                        margin-right: 4px;
                        background: ${boxColor};
                        border: none;
                        border-radius: 2px;
                        text-align: center;
                        color: #ffffff;
                        font-size: 0.7rem;
                        font-weight: bold;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        user-select: none;
                        flex-shrink: 0;
                        cursor: pointer;
                        line-height: 1;
                    `;
                    const transitionType = transition ? transition.type : 'Success';
                    let icon = getTransitionTheme(transitionType).icon;
                    if (transitionType === 'Always') {
                        icon = '&#9660;';  // down triangle
                    }
                    conditionBox.innerHTML = icon;
                    conditionBox.addEventListener('click', (e) => {
                        e.stopPropagation();
                        showTransitionProperties(conditionId);
                    });
                    
                    // Add drag functionality for horizontal layout
                    let isDraggingCondition = false;
                    let dragStartIndex = -1;
                    
                    conditionBox.addEventListener('mousedown', (e) => {
                        if (e.button !== 0) return; // Only left mouse button
                        e.stopPropagation();
                        isDraggingCondition = true;
                        dragStartIndex = sortedConditions.indexOf(conditionId);
                        conditionBox.style.opacity = '0.6';
                    });
                    
                    document.addEventListener('mousemove', (e) => {
                        if (!isDraggingCondition || dragStartIndex === -1) return;
                        
                        // Find which condition box is under the cursor
                        const conditionBoxes = conditionsContainer.querySelectorAll('[data-condition-id]');
                        let targetIndex = -1;
                        
                        conditionBoxes.forEach((box, idx) => {
                            const rect = box.getBoundingClientRect();
                            if (e.clientX >= rect.left && e.clientX <= rect.right) {
                                targetIndex = idx;
                            }
                        });
                        
                        if (targetIndex !== -1 && targetIndex !== dragStartIndex) {
                            // Reorder conditions
                            const draggedCondition = currentTransitions.find(t => t.id === conditionId);
                            const targetCondition = currentTransitions.find(t => t.id === sortedConditions[targetIndex]);
                            
                            if (draggedCondition && targetCondition) {
                                const draggedOrder = draggedCondition.order;
                                const targetOrder = targetCondition.order;
                                
                                if (targetIndex > dragStartIndex) {
                                    // Moving right - decrement orders of conditions we pass
                                    for (let i = dragStartIndex + 1; i <= targetIndex; i++) {
                                        const cond = currentTransitions.find(t => t.id === sortedConditions[i]);
                                        if (cond) cond.order--;
                                    }
                                    draggedCondition.order = targetOrder;
                                } else {
                                    // Moving left - increment orders of conditions we pass
                                    for (let i = targetIndex; i < dragStartIndex; i++) {
                                        const cond = currentTransitions.find(t => t.id === sortedConditions[i]);
                                        if (cond) cond.order++;
                                    }
                                    draggedCondition.order = targetOrder;
                                }
                                
                                dragStartIndex = targetIndex;
                                renderTransitionFrame(frameUUID, false);
                                updatePreview();
                            }
                        }
                    });
                    
                    document.addEventListener('mouseup', () => {
                        isDraggingCondition = false;
                        dragStartIndex = -1;
                        conditionBox.style.opacity = '1';
                    });
                    
                    wrapper.appendChild(conditionBox);
                    
                    // Down-pointing triangle
                    const triangle = document.createElement('div');
                    const boxCenterX = conditionBox.offsetLeft + 13; // 13 is half of 26px width
                    triangle.style.cssText = `
                        position: absolute;
                        width: 0;
                        height: 0;
                        border-left: 8px solid transparent;
                        border-right: 8px solid transparent;
                        border-top: 10px solid #d4af37;
                        top: 28px;
                        left: ${boxCenterX}px;
                        transform: translateX(-50%);
                    `;
                    
                    // Invisible hitbox for dragging - on the triangle itself
                    const hitbox = document.createElement('div');
                    hitbox.setAttribute('data-transition-arrow', conditionId);
                    hitbox.style.cssText = `
                        position: absolute;
                        width: 30px;
                        height: 25px;
                        top: 28px;
                        left: ${boxCenterX}px;
                        transform: translateX(-50%);
                        cursor: move;
                        z-index: 1;
                    `;
                    wrapper.appendChild(triangle);
                    wrapper.appendChild(hitbox);
                    
                    conditionsContainer.appendChild(wrapper);
                });
                
                // Add + button
                const addButton = document.createElement('div');
                addButton.setAttribute('data-add-condition-btn', frameUUID);
                addButton.style.cssText = `
                    flex: 1;
                    padding: 0;
                    margin: 0;
                    background: #d4af37;
                    border: none;
                    border-radius: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: #3a3a2a;
                    font-size: 18px;
                    font-weight: bold;
                    cursor: pointer;
                    user-select: none;
                    height: 26px;
                    flex-shrink: 0;
                `;
                addButton.textContent = '+';
                addButton.addEventListener('click', addConditionToFrame(frameUUID, conditionsContainer));
                conditionsContainer.appendChild(addButton);
                
                frameRect.appendChild(conditionsContainer);
                
                // Add grab indicator to add button if frame is attached
                if (frame.attachedToStepId) {
                    // Visual triangle (stays within bounds)
                    const visualIndicator = document.createElement('div');
                    visualIndicator.style.cssText = `
                        position: absolute;
                        bottom: 0px;
                        right: 0px;
                        width: 10px;
                        height: 10px;
                        background: #3a3a2a;
                        clip-path: polygon(100% 0%, 100% 100%, 0% 100%);
                        pointer-events: none;
                        z-index: 100;
                    `;
                    
                    // Invisible hitbox (extends beyond bounds for easy clicking)
                    const hitbox = document.createElement('div');
                    hitbox.setAttribute('data-grab-handle', frameUUID);
                    hitbox.style.cssText = `
                        position: absolute;
                        bottom: -4px;
                        right: -4px;
                        width: 16px;
                        height: 16px;
                        cursor: grab;
                        z-index: 101;
                    `;
                    
                    addButton.style.position = 'relative';
                    addButton.style.overflow = 'visible';
                    addButton.appendChild(visualIndicator);
                    addButton.appendChild(hitbox);
                }
            }
            
            // Drag handling
            let dragOffsetX = 0, dragOffsetY = 0;
            let isFrameDragging = false;
            let frameMouseDownX = 0, frameMouseDownY = 0;
            let wasJustDetached = false;  // Flag to prevent re-attachment after detach
            let isDraggingCaseArrow = false;  // Flag to indicate case arrow is being dragged
            const DRAG_THRESHOLD = 5; // pixels
            
            frameRect.addEventListener('mousedown', (e) => {
                // Check if clicking on a valid drag handle area
                const frameData = currentTransitionFrames.find(f => f.id === frameUUID);
                if (!frameData) return;
                
                let isDragHandle = false;
                
                if (frameData.verticalLayout) {
                    // Vertical mode: only allow drag on left panel (first 80px) or add button
                    const clickX = e.clientX - frameRect.getBoundingClientRect().left;
                    isDragHandle = clickX < 80 || e.target.closest('[data-add-condition-btn]');
                } else {
                    // Horizontal mode: only allow drag on header (top 40px) or add button
                    const clickY = e.clientY - frameRect.getBoundingClientRect().top;
                    isDragHandle = clickY < 40 || e.target.closest('[data-add-condition-btn]');
                }
                
                if (!isDragHandle) {
                    return;
                }
                
                frameMouseDownX = e.clientX;
                frameMouseDownY = e.clientY;
                wasJustDetached = false;  // Reset flag on new drag
                
                const canvasRect = canvas.getBoundingClientRect();
                
                // Get current position and snap top-left corner
                const currentX = parseInt(frameRect.style.left);
                const currentY = parseInt(frameRect.style.top);
                const snappedX = Math.round(currentX / 30) * 30;
                const snappedY = Math.round(currentY / 30) * 30;
                
                dragOffsetX = (e.clientX - canvasRect.left) / zoomLevel - snappedX + panX;
                dragOffsetY = (e.clientY - canvasRect.top) / zoomLevel - snappedY + panY;
                
                document.addEventListener('mousemove', handleFrameDrag);
                document.addEventListener('mouseup', stopFrameDrag);
            });
            
            const handleFrameDrag = (e) => {
                // Don't drag frame if we're dragging a case arrow
                if (isDraggingCaseArrow) {
                    return;
                }
                
                const frameData = currentTransitionFrames.find(f => f.id === frameUUID);
                if (!frameData) return;
                
                // Only start dragging if movement exceeds threshold
                if (!isFrameDragging) {
                    const deltaX = Math.abs(e.clientX - frameMouseDownX);
                    const deltaY = Math.abs(e.clientY - frameMouseDownY);
                    if (deltaX < DRAG_THRESHOLD && deltaY < DRAG_THRESHOLD) {
                        return; // Still within click threshold
                    }
                    isFrameDragging = true;
                }
                
                const canvasRect = canvas.getBoundingClientRect();
                const screenX = e.clientX - canvasRect.left;
                const screenY = e.clientY - canvasRect.top;
                const gridX = (screenX / zoomLevel) + panX - dragOffsetX;
                const gridY = (screenY / zoomLevel) + panY - dragOffsetY;
                
                // Snap to 15px grid (half-grid) visually, but store as 30px grid coordinates
                const snappedX = Math.round(gridX / 15) * 15;
                const snappedY = Math.round(gridY / 15) * 15;
                
                frameRect.style.left = snappedX + 'px';
                frameRect.style.top = snappedY + 'px';
                
                // Update frameData.position to track actual position (needed for detached frames)
                const detachGridX = snappedX / 30;
                const detachGridY = snappedY / 30;
                frameData.position = `${detachGridX},${detachGridY}`;
                
                // If frame is currently attached to a step, check if it's being detached
                if (frameData.attachedToStepId) {
                    const attachedStep = currentSteps.find(s => s.id === frameData.attachedToStepId);
                    if (attachedStep) {
                        const stepElement = canvas.querySelector(`[data-step-uuid="${attachedStep.id}"]`);
                        const frameElement = frameRect;
                        
                        const stepRect = stepElement.getBoundingClientRect();
                        const frameRect_check = frameElement.getBoundingClientRect();
                        
                        // Check if frame is no longer touching the step
                        if (Math.abs(frameRect_check.top - stepRect.top) >= 5 || 
                            frameRect_check.left > stepRect.right || 
                            frameRect_check.right < stepRect.left) {
                            
                            wasJustDetached = true;  // Prevent re-attachment on release
                            
                            // Keep frame at its current drag position when detached
                            const detachGridX = snappedX / 30;
                            const detachGridY = snappedY / 30;
                            frameData.position = `${detachGridX},${detachGridY}`;
                            
                            // Detach the frame
                            frameData.attachedToStepId = null;
                            frameData.attached = false;  // Mark as detached
                            
                            // Refresh step's connection lines since entry points changed
                            updateConnectedLines(attachedStep.id, 'step');
                            
                            // Restore step border radius only
                            stepElement.style.borderRadius = '4px';
                            
                            // Show connection circle
                            const connectionPoint = stepElement.querySelector('[data-connection-point]');
                            if (connectionPoint) {
                                connectionPoint.style.display = '';
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
                            
                            // Re-establish transition connection line
                            const frameElement_render = canvas.querySelector(`[data-transition-frame="${frameData.id}"]`);
                            if (frameElement_render) {
                                // Create transition connection line if it doesn't exist
                                let connectionLine = canvas.querySelector(`[data-connection-line][data-from-step="${attachedStep.id}"]`);
                                if (!connectionLine) {
                                    connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                                    connectionLine.setAttribute('data-connection-line', frameData.id);
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
                                        z-index: 5;
                                    `;
                                    canvas.appendChild(connectionLine);
                                } else {
                                }
                                
                                // Update the blue line
                                const stepEl = canvas.querySelector(`[data-step-uuid="${attachedStep.id}"]`);
                                if (stepEl) {
                                    const closestSide = getClosestSideToFrame(stepEl, frameElement_render, canvas);
                                    updateTransitionLine(connectionLine, frameData.id, attachedStep.id, closestSide, canvas);
                                    connectionLine.style.display = 'block';
                                } else {
                                }
                            } else {
                            }
                        }
                    }
                }
                
                // Update frame position in data using 30px grid coordinates
                const frameGridX = snappedX / 30;
                const frameGridY = snappedY / 30;
                if (frameData) {
                    frameData.position = `${frameGridX},${frameGridY}`;
                    
                    // Only sync to step if not attached
                    if (!frameData.attachedToStepId) {
                        currentSteps.forEach(step => {
                            if (step.transition && step.transition.cases) {
                                const hasConditionFromFrame = step.transition.cases.some(c => 
                                    frameData.conditions.includes(currentTransitions.find(t => t.order === c.order)?.id)
                                );
                                if (hasConditionFromFrame) {
                                    step.transition.position = `${frameGridX},${frameGridY}`;
                                }
                            }
                        });
                    }
                    
                    // Update case lines from ALL conditions in this frame
                    frameData.conditions.forEach(conditionId => {
                        const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${conditionId}"]`);
                        caseLines.forEach(line => {
                            const toStepId = line.getAttribute('data-to-step');
                            const toNodeId = line.getAttribute('data-to-node');
                            // Recreate the entire case line to update both start and end points
                            const transition = currentTransitions.find(t => t.id === conditionId);
                            if (transition) {
                                // Get the frame's current position (now updated)
                                const frameRect = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                                if (frameRect) {
                                    const frameX = parseInt(frameRect.style.left);
                                    const frameY = parseInt(frameRect.style.top);
                                    
                                    // Calculate case line start point from the frame's new position
                                    // Find the condition box and calculate its absolute position
                                    const conditionBox = frameRect.querySelector(`[data-condition-id="${conditionId}"]`);
                                    if (conditionBox) {
                                        // Get the wrapper element (parent of the condition box)
                                        const wrapper = conditionBox.parentElement;
                                        const wrapperOffsetX = wrapper ? wrapper.offsetLeft : 0;
                                        const wrapperOffsetY = wrapper ? wrapper.offsetTop : 0;
                                        
                                        // Get condition box position relative to its parent wrapper
                                        const conditionOffsetX = conditionBox.offsetLeft;
                                        const conditionOffsetY = conditionBox.offsetTop;
                                        
                                        // Get condition box dimensions
                                        const conditionWidth = conditionBox.offsetWidth;
                                        const conditionHeight = conditionBox.offsetHeight;
                                        
                                        // Calculate absolute position of condition box on canvas (in pixels)
                                        // Total offset includes wrapper position plus condition position within wrapper
                                        const conditionAbsX = frameX + wrapperOffsetX + conditionOffsetX;
                                        // In vertical layout, wrappers are stacked vertically so include wrapperOffsetY
                                        // In horizontal layout, wrappers have same offsetTop so wrapperOffsetY is redundant but harmless
                                        const conditionAbsY = frameData.verticalLayout 
                                            ? frameY + wrapperOffsetY + conditionOffsetY
                                            : frameY + conditionOffsetY;
                                        
                                        let startX, startY, startDirection;
                                        
                                        if (frameData.verticalLayout) {
                                            // Vertical layout: start from right edge at case box center Y
                                            startX = conditionAbsX + conditionWidth + 10;
                                            startY = conditionAbsY + 13;
                                            startDirection = 'right';
                                        } else {
                                            // Horizontal layout: start from bottom + arrow offset
                                            startX = conditionAbsX + conditionWidth / 2 + 2;
                                            startY = conditionAbsY + conditionHeight + 40;
                                            startDirection = 'bottom';
                                        }
                                        
                                        // Get the target (step or node)
                                        const targetStep = toStepId ? canvas.querySelector(`[data-step-uuid="${toStepId}"]`) : null;
                                        const targetNode = toNodeId ? canvas.querySelector(`[data-node-id="${toNodeId}"]`) : null;
                                        
                                        if (targetStep) {
                                            const stepX = parseInt(targetStep.style.left);
                                            const stepY = parseInt(targetStep.style.top);
                                            const stepWidth = parseInt(targetStep.style.width);
                                            const stepHeight = parseInt(targetStep.style.height);
                                            
                                            const stepSideCenters = [
                                                { x: stepX + stepWidth / 2, y: stepY, name: 'top' },
                                                { x: stepX + stepWidth / 2, y: stepY + stepHeight, name: 'bottom' },
                                                { x: stepX, y: stepY + stepHeight / 2, name: 'left' },
                                                { x: stepX + stepWidth, y: stepY + stepHeight / 2, name: 'right' }
                                            ];
                                            
                                            let nearestSide = stepSideCenters[0];
                                            let minDistance = Infinity;
                                            stepSideCenters.forEach(side => {
                                                const distance = Math.hypot(startX - side.x, startY - side.y);
                                                if (distance < minDistance) {
                                                    minDistance = distance;
                                                    nearestSide = side;
                                                }
                                            });
                                            
                                            const lineEnd = offsetPointFromEdge(nearestSide.x, nearestSide.y, nearestSide.name, 15);
                                            lineEnd.y -= 2;  // Move arrow up by 2px
                                            lineEnd.x += 1;  // Shift endpoint right by 1px
                                            lineEnd.y += 3;  // Shift endpoint down by 3px
                                            
                                            const path = createCurvedPath(startX, startY, startDirection, lineEnd.x, lineEnd.y, nearestSide.name);
                                            
                                            const transitionColors = getTransitionTheme(transition.type);
                                            line.innerHTML = `<defs><marker id="caseArrowhead-${conditionId}" markerWidth="10" markerHeight="10" refX="0" refY="3" orient="auto"><polygon points="0 0, 6 3, 0 6" fill="${transitionColors.color}"/></marker></defs><path d="${path}" stroke="${transitionColors.color}" stroke-width="2" fill="none" marker-end="url(#caseArrowhead-${conditionId})" style="pointer-events: none;"/><circle cx="${lineEnd.x}" cy="${lineEnd.y}" r="8" fill="transparent" data-case-arrow-hitbox="${conditionId}" style="cursor: crosshair !important; pointer-events: auto;" />`;
                                            // Ensure z-index is preserved after innerHTML update
                                            line.style.zIndex = '5';
                                            // Set cursor explicitly on the SVG element
                                            line.style.cursor = 'crosshair';
                                        } else if (targetNode) {
                                            // Handle node target - similar logic but for diamond shape
                                            const nodeX = parseInt(targetNode.style.left);
                                            const nodeY = parseInt(targetNode.style.top);
                                            const nodeWidth = 30;
                                            const nodeHeight = 30;
                                            const nodeCenterX = nodeX + nodeWidth / 2;
                                            const nodeCenterY = nodeY + nodeHeight / 2;
                                            
                                            // Node is a diamond, so calculate closest point on diamond
                                            const diamondPoints = [
                                                { x: nodeCenterX, y: nodeY, name: 'top' },           // top
                                                { x: nodeCenterX, y: nodeY + nodeHeight, name: 'bottom' }, // bottom
                                                { x: nodeX, y: nodeCenterY, name: 'left' },         // left
                                                { x: nodeX + nodeWidth, y: nodeCenterY, name: 'right' }  // right
                                            ];
                                            
                                            let nearestPoint = diamondPoints[0];
                                            let minDistance = Infinity;
                                            diamondPoints.forEach(point => {
                                                const distance = Math.hypot(startX - point.x, startY - point.y);
                                                if (distance < minDistance) {
                                                    minDistance = distance;
                                                    nearestPoint = point;
                                                }
                                            });
                                            
                                            const lineEnd = offsetPointFromEdge(nearestPoint.x, nearestPoint.y, nearestPoint.name, 10);
                                            lineEnd.y -= 2;
                                            lineEnd.x += 1;
                                            lineEnd.y += 3;
                                            
                                            const path = createCurvedPath(startX, startY, startDirection, lineEnd.x, lineEnd.y, nearestPoint.name);
                                            
                                            const transitionColors = getTransitionTheme(transition.type);
                                            line.innerHTML = `<defs><marker id="caseArrowhead-${conditionId}" markerWidth="10" markerHeight="10" refX="0" refY="3" orient="auto"><polygon points="0 0, 6 3, 0 6" fill="${transitionColors.color}"/></marker></defs><path d="${path}" stroke="${transitionColors.color}" stroke-width="2" fill="none" marker-end="url(#caseArrowhead-${conditionId})" style="pointer-events: none;"/><circle cx="${lineEnd.x}" cy="${lineEnd.y}" r="8" fill="transparent" data-case-arrow-hitbox="${conditionId}" style="cursor: crosshair !important; pointer-events: auto;" />`;
                                            line.style.zIndex = '5';
                                            line.style.cursor = 'crosshair';
                                        }
                                    }
                                }
                            }
                        });
                    });
                }
                
                // Update blue lines connected to this frame
                document.querySelectorAll(`[data-connection-line][data-from-step]`).forEach(line => {
                    const lineFrameId = line.getAttribute('data-connection-line');
                    // Only update if this line is for the frame being dragged
                    if (lineFrameId === frameUUID) {
                        const fromStepId = line.getAttribute('data-from-step');
                        const stepElement = canvas.querySelector(`[data-step-uuid="${fromStepId}"]`);
                        const frameElement = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                        if (stepElement && frameElement) {
                            const closestSide = getClosestSideToFrame(stepElement, frameElement, canvas);
                            updateTransitionLine(line, frameUUID, fromStepId, closestSide, canvas);
                            
                            // Also update the connection point circle position
                            const connectionPoint = stepElement.querySelector('[data-connection-point]');
                            if (connectionPoint) {
                                const positionStyles = {
                                    'top': 'top: -6px; left: 50%; transform: translateX(-50%);',
                                    'bottom': 'bottom: -6px; left: 50%; transform: translateX(-50%);',
                                    'left': 'left: -6px; top: 50%; transform: translateY(-50%);',
                                    'right': 'right: -6px; top: 50%; transform: translateY(-50%);'
                                };
                                
                                connectionPoint.classList.add('connectionPoint');
                                connectionPoint.style.cssText = `
                                    ${positionStyles[closestSide]}
                                `;
                            }
                        }
                    }
                });
                
                updatePreview();
            };
            
            const stopFrameDrag = () => {
                document.removeEventListener('mousemove', handleFrameDrag);
                document.removeEventListener('mouseup', stopFrameDrag);
                
                // Don't process frame drag if we're dragging a case arrow
                if (isDraggingCaseArrow) {
                    return;
                }
                
                if (isFrameDragging) {
                    frameRect._isFrameDragging = true;
                }
                const wasDragging = isFrameDragging;
                isFrameDragging = false;
                const frameData = currentTransitionFrames.find(f => f.id === frameUUID);
                if (!frameData) return;
                
                // Check if frame should attach to a step (Horizontal frames only)
                // Skip if we just detached the frame
                if (!frameData.verticalLayout && !wasJustDetached && (wasDragging || !frameData.attachedToStepId)) {
                    const frameElement = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                    const frameRect = frameElement.getBoundingClientRect();
                    const frameBottom = frameRect.bottom;
                    
                    // Check all steps to see if frame is touching or overlapping their bottom
                    let attachedToStep = null;
                    currentSteps.forEach(step => {
                        const stepElement = canvas.querySelector(`[data-step-uuid="${step.id}"]`);
                        if (stepElement) {
                            const stepRect = stepElement.getBoundingClientRect();
                            
                            // Check if frame is touching or overlapping the top of the step
                            // Frame and step tops should be close together, and frame should horizontally overlap
                            const frameTop = frameRect.top;
                            const stepTop = stepRect.top;
                            const horizontalOverlap = frameRect.left < stepRect.right && frameRect.right > stepRect.left;
                            
                            // Allow frame to be anywhere from 25px above step top to 45px below (for drag tolerance)
                            // But only if this step is the frame's parent (Stranger Danger rule)
                            if (frameTop <= (stepTop + 45) && frameTop >= (stepTop - 25) && horizontalOverlap && step.id === frameData.parentStepId) {
                                attachedToStep = step;
                            }
                        }
                    });
                    
                    if (attachedToStep) {
                        // Attach frame to step
                        frameData.attachedToStepId = attachedToStep.id;
                        frameData.attached = true;  // Mark as attached for JSON persistence
                        
                        // Refresh step's connection lines since entry points changed
                        updateConnectedLines(attachedToStep.id, 'step');
                        
                        // Get frame width
                        const stepElement = canvas.querySelector(`[data-step-uuid="${attachedToStep.id}"]`);
                        const frameElement = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                        const frameWidth = parseInt(frameElement.style.width);
                        const stepWidth = parseInt(stepElement.style.width);
                        
                        if (stepWidth > frameWidth) {
                            // Step is wider than frame: keep frame at step left edge, remove only bottom left corner radius
                            stepElement.style.borderRadius = '4px 4px 4px 0px';
                        } else {
                            // Frame is same width or wider: expand step if needed, remove all bottom corners radius
                            if (frameWidth > stepWidth) {
                                stepElement.style.width = frameWidth + 'px';
                                attachedToStep.width = frameWidth / 30;  // Store in grid units
                            }
                            
                            // Remove border radius from step bottom corners
                            stepElement.style.borderRadius = '4px 4px 0px 0px';
                        }
                        
                        // Hide connection circle
                        const connectionPoint = stepElement.querySelector('[data-connection-point]');
                        if (connectionPoint) {
                            connectionPoint.style.display = 'none';
                        }
                        
                        // Position frame at the same position as step (top of step, so name panel hides behind)
                        const stepPos = attachedToStep.position.split(',').map(Number);
                        frameData.position = `${stepPos[0]},${stepPos[1]}`;
                        frameData.attachedToStepId = attachedToStep.id;
                        frameData.attached = true;  // Mark as attached for JSON persistence
                        
                        // Refresh step's connection lines since entry points changed
                        updateConnectedLines(attachedToStep.id, 'step');
                        
                        // Remove transition connection line
                        const transitionLines = canvas.querySelectorAll(`[data-connection-line][data-from-step="${attachedToStep.id}"]`);
                        transitionLines.forEach(line => line.remove());
                        
                        // Update frame position on canvas
                        frameElement.style.left = (stepPos[0] * 30) + 'px';
                        frameElement.style.top = (stepPos[1] * 30) + 'px';
                        
                        // Re-render all case lines from this frame's conditions
                        frameData.conditions.forEach(conditionId => {
                            const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${conditionId}"]`);
                            caseLines.forEach(line => {
                                const toStepId = line.getAttribute('data-to-step');
                                const toNodeId = line.getAttribute('data-to-node');
                                const transition = currentTransitions.find(t => t.id === conditionId);
                                const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                                
                                if (toStepId) {
                                    drawConnectionLine(line, conditionId, 'case', toStepId, 'step', canvas, caseColor, false, frameData);
                                } else if (toNodeId) {
                                    drawConnectionLine(line, conditionId, 'case', toNodeId, 'node', canvas, caseColor, false, frameData);
                                }
                            });
                        });
                        
                        // Re-render frame to add grab indicator
                        renderTransitionFrame(frameUUID, false);
                        
                        // Update preview
                        updatePreview();
                    }
                }
                
                // If frame was just detached, re-render it to remove the grab indicator
                if (wasJustDetached) {
                    renderTransitionFrame(frameUUID, false);
                    wasJustDetached = false;
                    updatePreview();
                }
            };
            
            // Frame click handler
            frameRect.addEventListener('click', (e) => {
                e.stopPropagation();
                
                // Only show properties if the frame wasn't dragged
                if (!frameRect._isFrameDragging) {
                    showTransitionFrameProperties(frameUUID);
                    
                    // Deselect all steps (remove inline border colors so CSS applies)
                    document.querySelectorAll('[data-step-id]').forEach(el => {
                        el.style.borderColor = '';
                    });
                    frameRect.style.borderColor = '#ffff00';
                }
                
                // Reset the dragging flag for next interaction
                frameRect._isFrameDragging = false;
            });
            
            canvas.appendChild(frameRect);
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
            updateAllConnectionLinesForStep(stepUUID);
        }

        function updateAllConnectionLinesForStep(stepUUID) {
            const canvas = document.getElementById('workflowCanvas');
            const stepElement = canvas.querySelector(`[data-step-uuid="${stepUUID}"]`);
            if (!stepElement) return;
            
            // Update blue lines from this step
            const transitionLines = canvas.querySelectorAll(`[data-connection-line][data-from-step="${stepUUID}"]`);
            transitionLines.forEach(line => {
                const frameUUID = line.getAttribute('data-connection-line');
                const frameElement = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                if (frameElement) {
                    const closestSide = getClosestSideToFrame(stepElement, frameElement, canvas);
                    updateTransitionLine(line, frameUUID, stepUUID, closestSide, canvas);
                    
                    // Update connection point
                    const connectionPoint = stepElement.querySelector('[data-connection-point]');
                    if (connectionPoint) {
                        const positionStyles = {
                            'top': 'top: -6px; left: 50%; transform: translateX(-50%);',
                            'bottom': 'bottom: -6px; left: 50%; transform: translateX(-50%);',
                            'left': 'left: -6px; top: 50%; transform: translateY(-50%);',
                            'right': 'right: -6px; top: 50%; transform: translateY(-50%);'
                        };
                        connectionPoint.classList.add('connectionPoint');
                        connectionPoint.style.cssText = positionStyles[closestSide];
                    }
                }
            });
            
            // Update case lines pointing to this step
            const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-to-step="${stepUUID}"]`);
            caseLines.forEach(line => {
                const fromTransitionId = line.getAttribute('data-from-transition');
                const frame = currentTransitionFrames.find(f => f.conditions.includes(fromTransitionId));
                const transition = currentTransitions.find(t => t.id === fromTransitionId);
                const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                drawConnectionLine(line, fromTransitionId, 'case', stepUUID, 'step', canvas, caseColor, false, frame);
            });
        }

        function showStepProperties(stepUUID) {
            const step = currentSteps.find(s => s.id === stepUUID);
            if (!step) return;
            
            currentStepBeingEdited = step;  // Track this step for variable editing
            
            const propertiesContent = document.getElementById('propertiesContent');
            showPropertiesPanel();
            
            // Build variables HTML
            let variablesHTML = '';
            if (step.variables && step.variables.length > 0) {
                variablesHTML = step.variables.map((v, idx) => `
                    <div style="display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 8px; margin-bottom: 4px; align-items: center;">
                        <input type="text" placeholder="Name" value="${v.name || ''}" class="form-field-input" style="padding: 6px; font-size: 0.85rem; min-width: 0; box-sizing: border-box;" data-var-idx="${idx}" data-var-field="name">
                        <input type="text" placeholder="Value" value="${v.value || ''}" class="form-field-input" style="padding: 6px; font-size: 0.85rem; min-width: 0; box-sizing: border-box;" data-var-idx="${idx}" data-var-field="value">
                        <button class="btn var-edit-btn" data-size="sm" data-color="blue" data-var-idx="${idx}" title="Edit variable" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 16px;">&#9998;</button>
                        <button class="btn var-delete-btn" data-size="sm" data-color="red" data-var-idx="${idx}" title="Delete variable" style="padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 16px;">🗑</button>
                    </div>
                `).join('');
            }
            
            // Determine step type for conditional fields
            const isBeginStep = step.type === 'Begin';
            const isKoreType = step.type === 'Kore';
            const isWorkflowType = step.type === 'Workflow';
            const isRMMType = step.type === 'RMM';
            const isEndType = step.type === 'End';
            
            // Build delete button HTML (hidden for BEGIN steps)
            const deleteButtonHTML = isBeginStep ? '' : `<button class="btn" data-color="red" onclick="deleteElement('${stepUUID}', 'step')" style="padding: 6px 12px;">Delete</button>`;
            
            // Build Action field HTML based on type
            let actionFieldHTML = '';
            if (isBeginStep || isEndType) {
                // No action field for Begin and End
                actionFieldHTML = '';
            } else if (isKoreType) {
                // Dropdown for Kore
                actionFieldHTML = `
                    <div>
                        <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Action</label>
                        <select id="stepAction" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                            <option value="None" ${step.action === 'None' || !step.action ? 'selected' : ''}>None</option>
                        </select>
                    </div>
                `;
            } else if (isWorkflowType) {
                // Dropdown for Workflow
                actionFieldHTML = `
                    <div>
                        <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Workflow</label>
                        <select id="stepAction" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                            <option value="">-- Select Workflow --</option>
                        </select>
                    </div>
                `;
            } else if (isRMMType) {
                // RMM Type dropdown and Action dropdown
                actionFieldHTML = `
                    <div>
                        <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">RMM Type</label>
                        <select id="stepRMMType" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                            <option value="cwm" ${step.rmmType === 'cwm' ? 'selected' : ''}>Connectwise Automate</option>
                        </select>
                    </div>
                    <div>
                        <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Action</label>
                        <select id="stepAction" class="form-field-input" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                            <option value="">-- Select Action --</option>
                        </select>
                    </div>
                `;
            } else {
                // Text input for other standard steps (Test, etc)
                actionFieldHTML = `
                    <div>
                        <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Action</label>
                        <input type="text" id="stepAction" class="form-field-input" value="${step.action || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    </div>
                `;
            }
            
            propertiesContent.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #3a7a99;">
                    <div style="font-size: 0.9rem; color: #e0e0e0; font-weight: 500;">${step.type} Step Properties</div>
                    ${deleteButtonHTML}
                </div>
                <div style="display: flex; flex-direction: column; gap: 15px;">
                    <div>
                        <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Name</label>
                        <input type="text" id="stepName" class="form-field-input" value="${step.name || ''}" ${isBeginStep ? 'readonly' : ''} style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                    </div>
                    
                    ${actionFieldHTML}
                    
                    <div>
                        <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Variables</label>
                        <button id="addVariableBtn" class="btn btn-blue" style="width: 100%; padding: 6px; margin-bottom: 8px;">Add Variable</button>
                        <div id="variablesContainer" style="">
                            ${variablesHTML}
                        </div>
                    </div>
                    
                    <div style="border-top: 1px solid #3a7a99; padding-top: 10px; margin-top: 10px;">
                        <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; cursor: pointer;">
                            <input type="checkbox" id="overrideSizeCheckbox" ${step.overrideSize ? 'checked' : ''} style="cursor: pointer;">
                            <span style="font-size: 0.85rem; color: #b0b0b0;">Override Size</span>
                        </label>
                        
                        <div id="sizeOverrideInputs" style="display: ${step.overrideSize ? 'flex' : 'none'}; flex-direction: column; gap: 10px;">
                            <div>
                                <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Width (grid units)</label>
                                <input type="number" id="overrideWidth" class="form-field-input" value="${step.width || 4}" min="2" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                            </div>
                            <div>
                                <label style="display: block; font-size: 0.8rem; color: #b0b0b0; margin-bottom: 5px;">Height (grid units)</label>
                                <input type="number" id="overrideHeight" class="form-field-input" value="${step.height || 1}" min="1" style="width: 100%; padding: 6px; box-sizing: border-box; font-size: 0.85rem;">
                            </div>
                        </div>
                    </div>
                    
                    <div style="border-top: 1px solid #3a7a99; padding-top: 10px; margin-top: 10px;">
                        <div style="font-size: 0.75rem; color: #707070; word-break: break-all;">ID: ${step.id}</div>
                    </div>
                </div>
            `;
            
            // Add event listeners for fields
            const stepNameInput = document.getElementById('stepName');
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
            
            // RMM Type field handler
            const rmmTypeInput = document.getElementById('stepRMMType');
            if (rmmTypeInput) {
                rmmTypeInput.addEventListener('change', (e) => {
                    step.rmmType = e.target.value;
                    updatePreview();
                });
            }
            
            const stepActionInput = document.getElementById('stepAction');
            if (stepActionInput) {
                stepActionInput.addEventListener('change', (e) => {
                    step.action = e.target.value;
                    updatePreview();
                });
            }
            
            // Variable input handlers
            document.querySelectorAll('[data-var-field]').forEach(input => {
                input.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-var-idx'));
                    const field = e.target.getAttribute('data-var-field');
                    step.variables[idx][field] = e.target.value;
                    updatePreview();
                });
            });
            
            // Variable edit buttons
            document.querySelectorAll('.var-edit-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.getAttribute('data-var-idx'));
                    const currentValue = step.variables[idx].value || '';
                    const varName = step.variables[idx].name || 'Variable';
                    const modalTitle = `Edit: ${varName}`;
                    
                    openWorkflowJinjaEditorModal(modalTitle, currentValue, (value) => {
                        step.variables[idx].value = value;
                        document.querySelector(`[data-var-idx="${idx}"][data-var-field="value"]`).value = value;
                        updatePreview();
                    }, step.id);
                });
            });
            
            // Delete variable button
            document.querySelectorAll('.var-delete-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.getAttribute('data-var-idx'));
                    showDeleteConfirm('Delete this variable?', () => {
                        step.variables.splice(idx, 1);
                        showStepProperties(stepUUID); // Refresh to remove deleted variable
                        updatePreview();
                    });
                });
            });
            
            // Add variable button
            document.getElementById('addVariableBtn').addEventListener('click', () => {
                step.variables.push({ name: '', value: '' });
                showStepProperties(stepUUID); // Refresh to show new variable
                updatePreview();
            });
            
            // Add event listeners for size override
            const overrideSizeCheckbox = document.getElementById('overrideSizeCheckbox');
            const sizeOverrideInputs = document.getElementById('sizeOverrideInputs');
            const overrideWidthInput = document.getElementById('overrideWidth');
            const overrideHeightInput = document.getElementById('overrideHeight');
            
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
        }

        function showNodeProperties(nodeId) {
            const node = currentNodes.find(n => n.id === nodeId);
            if (!node) return;
            
            const contentHTML = `
                <div>
                    <!-- Settings section (empty for now) -->
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
                null // No event listeners needed for nodes
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
                const stepsForExport = currentSteps.map(step => ({
                    ...step,
                    transition: step.transition ? {
                        ...step.transition,
                        attached: step.transition.attached === true,
                        cases: [...step.transition.cases].sort((a, b) => (a.order || 1) - (b.order || 1))
                    } : undefined
                }));
                
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
                    steps: stepsForExport
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
                steps: currentSteps,
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
                            } else if (JSON.stringify(oldItem) !== JSON.stringify(newItem)) {
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
            
            // Helper function to escape HTML
            function escapeHtml(text) {
                const map = {
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#039;'
                };
                return text.replace(/[&<>"']/g, m => map[m]);
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

        function incrementVersion(version) {
            // Parse version like "1.0.0"
            const parts = version.split('.');
            if (parts.length === 3) {
                // Increment patch version
                parts[2] = String(parseInt(parts[2]) + 1);
                return parts.join('.');
            }
            // Fallback: just append .1
            return version + '.1';
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
                    currentVersion = newVersion;
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
                        steps: currentSteps,
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
            window.location.href = 'workflows.html';
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

        // Helper function to find which side of a step is closest to a frame
        function getClosestSideToFrame(stepElement, frameElement, canvas) {
            const stepRect = stepElement.getBoundingClientRect();
            const frameRect = frameElement.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            
            // Get step center
            const stepCenterX = stepRect.left - canvasRect.left + (stepRect.width / 2);
            const stepCenterY = stepRect.top - canvasRect.top + (stepRect.height / 2);
            
            // Get frame center
            const frameCenterX = frameRect.left - canvasRect.left + (frameRect.width / 2);
            const frameCenterY = frameRect.top - canvasRect.top + (frameRect.height / 2);
            
            // Calculate delta
            const deltaX = frameCenterX - stepCenterX;
            const deltaY = frameCenterY - stepCenterY;
            
            // Determine which side is closest
            const absDeltaX = Math.abs(deltaX);
            const absDeltaY = Math.abs(deltaY);
            
            if (absDeltaY > absDeltaX) {
                return deltaY > 0 ? 'bottom' : 'top';
            } else {
                return deltaX > 0 ? 'right' : 'left';
            }
        }

        function updateTransitionLine(line, frameUUID, fromStepId, fromConnectionPoint, canvasElement, lineColor) {
            // Look up step by UUID and determine color from step type if not provided
            const frameElement = canvasElement.querySelector(`[data-transition-frame="${frameUUID}"]`);
            const stepElement = canvasElement.querySelector(`[data-step-uuid="${fromStepId}"]`);
            
            // If color not provided, determine it from step type
            if (!lineColor) {
                const stepData = currentSteps.find(s => s.id === fromStepId);
                lineColor = stepData ? getStepTypeTheme(stepData.type).color : '#3a7a99';
            }
            
            if (!frameElement || !stepElement) return;
            
            // Get step position and dimensions (in screen pixels)
            const stepX = parseInt(stepElement.style.left);
            const stepY = parseInt(stepElement.style.top);
            const stepWidth = parseInt(stepElement.style.width);
            const stepHeight = parseInt(stepElement.style.height);
            
            // Calculate the connection point on the step (in screen pixels)
            let fromX = stepX + stepWidth / 2;
            let fromY = stepY + stepHeight / 2;
            
            if (fromConnectionPoint === 'top') {
                fromY = stepY;
            } else if (fromConnectionPoint === 'bottom') {
                fromY = stepY + stepHeight;
            } else if (fromConnectionPoint === 'left') {
                fromX = stepX;
            } else if (fromConnectionPoint === 'right') {
                fromX = stepX + stepWidth;
            }
            
            // Get frame position and dimensions (in screen pixels, relative to canvas)
            const frameX = parseInt(frameElement.style.left);
            const frameY = parseInt(frameElement.style.top);
            const frameWidth = parseInt(frameElement.style.width);
            const frameHeight = parseInt(frameElement.style.height);
            
            // Find nearest side of frame
            const frameSideCenters = [
                { x: frameX + frameWidth / 2, y: frameY, name: 'top' },
                { x: frameX + frameWidth / 2, y: frameY + frameHeight, name: 'bottom' },
                { x: frameX, y: frameY + frameHeight / 2, name: 'left' },
                { x: frameX + frameWidth, y: frameY + frameHeight / 2, name: 'right' }
            ];
            
            let nearestSide = frameSideCenters[0];
            let minDistance = Infinity;
            frameSideCenters.forEach(side => {
                const distance = Math.hypot(fromX - side.x, fromY - side.y);
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestSide = side;
                }
            });
            
            // Offset endpoint 10px away from edge (15 - 5 = 10)
            const offsetEnd = offsetPointFromEdge(nearestSide.x, nearestSide.y, nearestSide.name, 10);
            const path = createCurvedPath(fromX, fromY, fromConnectionPoint, offsetEnd.x, offsetEnd.y, nearestSide.name);
            line.innerHTML = `<defs><marker id="transitionArrowhead-${frameUUID}" markerWidth="10" markerHeight="10" refX="0" refY="3" orient="auto"><polygon points="0 0, 6 3, 0 6" fill="${lineColor}"/></marker></defs><path d="${path}" stroke="${lineColor}" stroke-width="2" fill="none" marker-end="url(#transitionArrowhead-${frameUUID})"/>`;
        }

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
        function drawConnectionLine(lineElement, sourceId, sourceType, targetId, targetType, canvas, lineColor, sourceFloating = true, sourceContext = null) {
            const sourceEl = sourceType === 'case' 
                ? canvas.querySelector(`[data-condition-id="${sourceId}"]`)
                : canvas.querySelector(`[data-${sourceType}-id="${sourceId}"]`) || canvas.querySelector(`[data-${sourceType}-uuid="${sourceId}"]`);
            const targetEl = targetType === 'frame'
                ? canvas.querySelector(`[data-transition-frame="${targetId}"]`)
                : (targetType === 'step'
                    ? canvas.querySelector(`[data-step-uuid="${targetId}"]`)
                    : canvas.querySelector(`[data-node-id="${targetId}"]`));
            
            if (!sourceEl || !targetEl) return;

            // Get positions
            const sourceX = parseInt(sourceEl.style.left);
            const sourceY = parseInt(sourceEl.style.top);
            const sourceWidth = parseInt(sourceEl.style.width);
            const sourceHeight = parseInt(sourceEl.style.height);
            
            const targetX = parseInt(targetEl.style.left);
            const targetY = parseInt(targetEl.style.top);
            const targetWidth = parseInt(targetEl.style.width);
            const targetHeight = parseInt(targetEl.style.height);

            // Pre-calculate centers for use in both source and target logic
            let sourceCenterX = sourceX + sourceWidth / 2;
            let sourceCenterY = sourceY + sourceHeight / 2;
            let targetCenterX = targetX + targetWidth / 2;
            let targetCenterY = targetY + targetHeight / 2;
            
            // If target is a step with attached transition frame, use bottom of step as centerY
            if (targetType === 'step') {
                const transitionFrames = Array.from(canvas.querySelectorAll('[data-transition-frame]'));
                const attachedFrame = transitionFrames.find(el => {
                    const frameY = parseInt(el.style.top);
                    // If frame is at same Y position as step, it's likely attached to this step
                    return frameY === targetY;
                });
                
                if (attachedFrame) {
                    // Use the bottom of the step as the effective centerY
                    targetCenterY = targetY + targetHeight;
                }
            }

            let startX, startY, startDir;

            // Calculate source point
            if (sourceType === 'case') {
                // Case: fixed point based on frame layout
                const frame = sourceContext;
                if (!frame) return;
                
                const frameElement = canvas.querySelector(`[data-transition-frame="${frame.id}"]`);
                if (!frameElement) return;
                
                const frameX = parseInt(frameElement.style.left);
                const frameY = parseInt(frameElement.style.top);
                
                // Get the wrapper element (parent of the condition box)
                const wrapper = sourceEl.parentElement;
                const wrapperOffsetX = wrapper ? wrapper.offsetLeft : 0;
                const wrapperOffsetY = wrapper ? wrapper.offsetTop : 0;
                
                const conditionOffsetX = sourceEl.offsetLeft;
                const conditionOffsetY = sourceEl.offsetTop;
                const conditionWidth = sourceEl.offsetWidth;
                const conditionHeight = sourceEl.offsetHeight;
                
                // Total offset includes the wrapper position plus the condition's position within the wrapper
                const conditionAbsX = frameX + wrapperOffsetX + conditionOffsetX;
                // In vertical layout, wrappers are stacked vertically so include wrapperOffsetY
                const conditionAbsY = frame.verticalLayout 
                    ? frameY + wrapperOffsetY + conditionOffsetY
                    : frameY + conditionOffsetY;

                if (frame.verticalLayout) {
                    startX = conditionAbsX + conditionWidth + 10;
                    startY = conditionAbsY + 13;
                    startDir = 'right';
                } else {
                    startX = conditionAbsX + conditionWidth / 2 + 2;
                    startY = conditionAbsY + conditionHeight + 40;
                    startDir = 'bottom';
                }
            } else {
                // Step/Node: floating - find nearest side/point to target

                if (sourceType === 'step') {
                    // Step: nearest side
                    const sides = [
                        { x: sourceCenterX, y: sourceY, name: 'top' },
                        { x: sourceCenterX, y: sourceY + sourceHeight, name: 'bottom' },
                        { x: sourceX, y: sourceCenterY, name: 'left' },
                        { x: sourceX + sourceWidth, y: sourceCenterY, name: 'right' }
                    ];
                    const nearest = sides.reduce((a, b) => 
                        Math.hypot(a.x - targetCenterX, a.y - targetCenterY) < Math.hypot(b.x - targetCenterX, b.y - targetCenterY) ? a : b
                    );
                    startX = nearest.x;
                    startY = nearest.y;
                    startDir = nearest.name;
                } else if (sourceType === 'node') {
                    // Node: nearest diamond point
                    const dx = targetCenterX - sourceCenterX;
                    const dy = targetCenterY - sourceCenterY;
                    const absX = Math.abs(dx);
                    const absY = Math.abs(dy);
                    const diamondPoint = 6; // Distance from center to diamond point

                    // Special case: node-to-step with close horizontal alignment and node above target
                    if (targetType === 'step') {
                        // Determine exit point based on target position relative to node
                        const sourceGridX = sourceCenterX / 30;
                        const targetCenterGridY = targetCenterY / 30;
                        const sourceCenterGridY = sourceCenterY / 30;
                        const targetLeftGridX = targetX / 30;  // Target left edge in grid coords
                        const targetRightGridX = (targetX + targetWidth) / 30;  // Target right edge in grid coords
                        
                        if (targetCenterGridY < sourceCenterGridY - 2) {
                            // Target is well above node: exit from TOP
                            startX = sourceCenterX;
                            startY = sourceCenterY - diamondPoint;
                            startDir = 'top';
                        } else if (targetCenterGridY > sourceCenterGridY + 2) {
                            // Target is well below node: exit from BOTTOM
                            startX = sourceCenterX;
                            startY = sourceCenterY + diamondPoint;
                            startDir = 'bottom';
                        } else if (targetLeftGridX >= sourceGridX + 1.5) {
                            // Target's left edge is well to the right: exit from RIGHT
                            startX = sourceCenterX + diamondPoint;
                            startY = sourceCenterY;
                            startDir = 'right';
                        } else if (targetRightGridX <= sourceGridX - 1.5) {
                            // Target's right edge is well to the left: exit from LEFT
                            startX = sourceCenterX - diamondPoint;
                            startY = sourceCenterY;
                            startDir = 'left';
                        } else {
                            // No strong directional preference: use closest side
                            const targetCenterGridX = (targetLeftGridX + targetRightGridX) / 2;
                            if (targetCenterGridX > sourceGridX) {
                                startX = sourceCenterX + diamondPoint;
                                startY = sourceCenterY;
                                startDir = 'right';
                            } else {
                                startX = sourceCenterX - diamondPoint;
                                startY = sourceCenterY;
                                startDir = 'left';
                            }
                        }
                    } else if (absX > absY) {
                        // Exiting from left or right point
                        startX = sourceCenterX + (dx > 0 ? diamondPoint : -diamondPoint);
                        startY = sourceCenterY;
                        startDir = dx > 0 ? 'right' : 'left';
                    } else {
                        // Exiting from top or bottom point
                        startX = sourceCenterX;
                        startY = sourceCenterY + (dy > 0 ? diamondPoint : -diamondPoint);
                        startDir = dy > 0 ? 'bottom' : 'top';
                    }
                }
            }

            // Calculate target point (handle node targets specially)
            
            let nearestTargetSide;
            if (targetType === 'node') {
                // Node target: use the 4 diamond points
                const diamondPoints = [
                    { x: targetCenterX + targetWidth / 2, y: targetCenterY, name: 'right' },    // right point
                    { x: targetCenterX - targetWidth / 2, y: targetCenterY, name: 'left' },    // left point
                    { x: targetCenterX, y: targetCenterY + targetHeight / 2, name: 'bottom' }, // bottom point
                    { x: targetCenterX, y: targetCenterY - targetHeight / 2, name: 'top' }     // top point
                ];
                
                // Check if line is nearly vertical
                const startGridX = startX / 30;
                const targetGridX = targetX / 30;
                const targetGridY = targetY / 30;
                const startGridY = startY / 30;
                const horizontalDistance = Math.abs(startGridX - targetGridX);
                
                // If nearly vertical and target is lower, attach to top
                if (horizontalDistance <= 1 && targetGridY > startGridY) {
                    nearestTargetSide = diamondPoints[3]; // top point
                } else {
                    nearestTargetSide = diamondPoints.reduce((a, b) =>
                        Math.hypot(a.x - startX, a.y - startY) < Math.hypot(b.x - startX, b.y - startY) ? a : b
                    );
                }
            } else {
                // Step or frame target: use rectangular sides
                const targetSides = [
                    { x: targetCenterX, y: targetY, name: 'top' },
                    { x: targetCenterX, y: targetY + targetHeight, name: 'bottom' },
                    { x: targetX, y: targetCenterY, name: 'left' },
                    { x: targetX + targetWidth, y: targetCenterY, name: 'right' }
                ];
                
                // If target step has attached transition frame, adjust entry points
                if (targetType === 'step') {
                    const transitionFrames = Array.from(canvas.querySelectorAll('[data-transition-frame]'));
                    const attachedFrame = transitionFrames.find(el => {
                        const frameY = parseInt(el.style.top);
                        return frameY === targetY;
                    });
                    
                    if (attachedFrame) {
                        // Adjust entry points for attached frame
                        targetSides[1].y += 30;      // BOTTOM: lowered by 1 grid unit (30px)
                        // TOP, LEFT, RIGHT remain unchanged
                    }
                }
                
                // Check if line is nearly vertical (within 1 grid unit horizontally)
                const startGridX = startX / 30;
                const targetGridX = targetX / 30;
                const targetGridY = targetY / 30;
                const startGridY = startY / 30;
                const horizontalDistance = Math.abs(startGridX - targetGridX);
                
                // Special case: node-to-step with step's right edge within 0.5 of node center
                if (sourceType === 'node' && targetType === 'step') {
                    const sourceCenterGridX = sourceCenterX / 30;  // Node center in grid coords
                    const sourceCenterGridY = sourceCenterY / 30;  // Node center Y in grid coords
                    const targetCenterGridX = targetCenterX / 30;  // Target center in grid coords
                    const targetCenterGridY = targetCenterY / 30;  // Target center Y in grid coords
                    
                    console.log('Node-to-step routing:', {
                        sourceCenterGridX: sourceCenterGridX.toFixed(2),
                        targetCenterGridX: targetCenterGridX.toFixed(2),
                        sourceCenterGridY: sourceCenterGridY.toFixed(2),
                        targetCenterGridY: targetCenterGridY.toFixed(2)
                    });
                    
                    // Entry point based on target center Y position relative to node center Y
                    if (targetCenterGridY < sourceCenterGridY - 1.5) {
                        console.log('→ Target above node, entering from BOTTOM');
                        nearestTargetSide = targetSides[1]; // bottom
                    } else if (targetCenterGridY > sourceCenterGridY + 1.5) {
                        console.log('→ Target below node, entering from TOP');
                        nearestTargetSide = targetSides[0]; // top
                    } else {
                        // Target within ±1 grid unit Y of node: enter from side (left or right, closer to node center X)
                        const distToLeft = Math.abs(sourceCenterX - targetX);
                        const distToRight = Math.abs(sourceCenterX - (targetX + targetWidth));
                        if (distToLeft <= distToRight) {
                            console.log('→ Target centered Y, entering from LEFT');
                            nearestTargetSide = targetSides[2]; // left
                        } else {
                            console.log('→ Target centered Y, entering from RIGHT');
                            nearestTargetSide = targetSides[3]; // right
                        }
                    }
                } else if (horizontalDistance <= 1 && targetGridY > startGridY) {
                    // If nearly vertical and target is lower, attach to top
                    nearestTargetSide = targetSides[0]; // top
                } else {
                    nearestTargetSide = targetSides.reduce((a, b) =>
                        Math.hypot(a.x - startX, a.y - startY) < Math.hypot(b.x - startX, b.y - startY) ? a : b
                    );
                }
            }

            // Offset endpoint to account for arrow width (~6px) plus 7px gap = ~13px from target
            const arrowOffset = 13;
            
            let endPoint;
            let offsetX = 0, offsetY = 0;
            
            // Offset perpendicular to each point of the diamond
            switch(nearestTargetSide.name) {
                case 'top': offsetY = -arrowOffset; break;
                case 'bottom': offsetY = arrowOffset; break;
                case 'left': offsetX = -arrowOffset; break;
                case 'right': offsetX = arrowOffset; break;
            }
            
            endPoint = {
                x: nearestTargetSide.x + offsetX,
                y: nearestTargetSide.y + offsetY
            };

            // Generate path and render
            let path = createCurvedPath(startX, startY, startDir, endPoint.x, endPoint.y, nearestTargetSide.name);
            
            // For node sources, add 9px straight segment before the curve
            if (sourceType === 'node') {
                const segmentLength = 9;
                let segmentX = startX, segmentY = startY;
                
                switch(startDir) {
                    case 'top': segmentY -= segmentLength; break;
                    case 'bottom': segmentY += segmentLength; break;
                    case 'left': segmentX -= segmentLength; break;
                    case 'right': segmentX += segmentLength; break;
                }
                
                // Rebuild path: straight line for 9px, then curve from there
                const curvedPart = createCurvedPath(segmentX, segmentY, startDir, endPoint.x, endPoint.y, nearestTargetSide.name);
                path = `M ${startX} ${startY} L ${segmentX} ${segmentY} ${curvedPart.substring(curvedPart.indexOf('C'))}`;
            }
            
            const markerId = `arrow-${sourceType}-${sourceId}-${targetId}`;
            
            let svg = `<defs><marker id="${markerId}" markerWidth="10" markerHeight="10" refX="0" refY="3" orient="auto"><polygon points="0 0, 6 3, 0 6" fill="${lineColor}"/></marker></defs><path d="${path}" stroke="${lineColor}" stroke-width="2" fill="none" marker-end="url(#${markerId})" style="pointer-events: none;"/>`;
            
            // Add hitboxes for all connection types (start and end)
            // Start point hitbox
            svg += `<circle cx="${startX}" cy="${startY}" r="8" fill="transparent" data-connection-hitbox="start" data-line-source-type="${sourceType}" data-line-source-id="${sourceId}" data-line-target-type="${targetType}" data-line-target-id="${targetId}" style="cursor: crosshair !important; pointer-events: auto;" />`;
            
            // End point hitbox
            svg += `<circle cx="${endPoint.x}" cy="${endPoint.y}" r="8" fill="transparent" data-connection-hitbox="end" data-line-source-type="${sourceType}" data-line-source-id="${sourceId}" data-line-target-type="${targetType}" data-line-target-id="${targetId}" style="cursor: crosshair !important; pointer-events: auto;" />`;

            lineElement.innerHTML = svg;
            lineElement.style.zIndex = sourceType === 'case' ? '5' : '1';
            lineElement.style.cursor = 'crosshair';
        }
        
        function renderCaseLineEmpty(line, conditionId, canvasElement, frame) {
            // Render a case arrow for a condition with no targets - just shows the arrow waiting to be dragged
            const frameElement = canvasElement.querySelector(`[data-transition-frame="${frame.id}"]`);
            if (!frameElement) return;
            
            const frameX = parseInt(frameElement.style.left);
            const frameY = parseInt(frameElement.style.top);
            
            // Find the condition box
            const conditionBox = frameElement.querySelector(`[data-condition-id="${conditionId}"]`);
            if (!conditionBox) return;
            
            // Get the wrapper element (parent of the condition box)
            const wrapper = conditionBox.parentElement;
            const wrapperOffsetX = wrapper ? wrapper.offsetLeft : 0;
            const wrapperOffsetY = wrapper ? wrapper.offsetTop : 0;
            
            const conditionOffsetX = conditionBox.offsetLeft;
            const conditionOffsetY = conditionBox.offsetTop;
            const conditionWidth = 26;  // Hardcoded condition box width
            const conditionHeight = 26; // Hardcoded condition box height
            
            // Calculate absolute position (including wrapper offset)
            const conditionAbsX = frameX + wrapperOffsetX + conditionOffsetX;
            // In vertical layout, wrappers are stacked vertically so include wrapperOffsetY
            const conditionAbsY = frame.verticalLayout 
                ? frameY + wrapperOffsetY + conditionOffsetY
                : frameY + conditionOffsetY;
            
            // Start from condition box edge
            let startX, startY, startDirection;
            if (frame.verticalLayout) {
                startX = conditionAbsX + conditionWidth + 10;
                startY = conditionAbsY + 13;
                startDirection = 'right';
            } else {
                startX = conditionAbsX + conditionWidth / 2;
                startY = conditionAbsY + conditionHeight + 39;
                startDirection = 'bottom';
            }
            
            // End point - just extend arrow a bit from start
            let endX, endY;
            if (frame.verticalLayout) {
                endX = startX + 60;
                endY = startY;
            } else {
                endX = startX;
                endY = startY + 60;
            }
            
            const path = createCurvedPath(startX, startY, startDirection, endX, endY, startDirection);
            
            const transition = currentTransitions.find(t => t.id === conditionId);
            const transitionColors = transition ? getTransitionTheme(transition.type) : getTransitionTheme('Success');
            
            // Draw line with arrow and hitbox at the end
            line.innerHTML = `<defs><marker id="caseArrowhead-${conditionId}" markerWidth="10" markerHeight="10" refX="0" refY="3" orient="auto"><polygon points="0 0, 6 3, 0 6" fill="${transitionColors.color}"/></marker></defs><path d="${path}" stroke="${transitionColors.color}" stroke-width="2" fill="none" marker-end="url(#caseArrowhead-${conditionId})" style="pointer-events: none;"/><circle cx="${endX}" cy="${endY}" r="8" fill="transparent" data-case-arrow-hitbox="${conditionId}" style="cursor: crosshair !important; pointer-events: auto;" />`;
            line.style.zIndex = '5';
            line.style.cursor = 'crosshair';
        }
        function offsetPointFromEdge(x, y, side, offset = 6) {
            // Offset a point AWAY from an edge for control point calculation
            switch(side) {
                case 'top': return { x: x, y: y - offset };
                case 'bottom': return { x: x, y: y + offset };
                case 'left': return { x: x - offset, y: y };
                case 'right': return { x: x + offset, y: y };
                default: return { x: x, y: y };
            }
        }

        function createCurvedPath(x1, y1, exitSide, x2, y2, enterSide) {
            // Simple organic curve system: smooth bezier curves that flow naturally
            const distance = Math.hypot(x2 - x1, y2 - y1);
            
            // Calculate control point distance based on path distance
            let controlDistance = Math.min(50, distance * 0.3);
            controlDistance = Math.max(15, controlDistance);
            
            // Calculate start control point based on exit direction
            let ctrl1_x = x1, ctrl1_y = y1;
            switch(exitSide) {
                case 'top': ctrl1_y -= controlDistance; break;
                case 'bottom': ctrl1_y += controlDistance; break;
                case 'left': ctrl1_x -= controlDistance; break;
                case 'right': ctrl1_x += controlDistance; break;
            }
            
            // Calculate end control point based on entry direction
            let ctrl2_x = x2, ctrl2_y = y2;
            switch(enterSide) {
                case 'top': ctrl2_y -= controlDistance; break;
                case 'bottom': ctrl2_y += controlDistance; break;
                case 'left': ctrl2_x -= controlDistance; break;
                case 'right': ctrl2_x += controlDistance; break;
            }
            
            // Simple cubic bezier curve
            return `M ${x1} ${y1} C ${ctrl1_x} ${ctrl1_y} ${ctrl2_x} ${ctrl2_y} ${x2} ${y2}`;
        }

        // Create a single transition condition box (2x1)
        function createTransitionConditionBox(transitionData, frameElement) {
            const conditionBox = document.createElement('div');
            const colors = getTransitionTheme(transitionData.type);
            
            conditionBox.setAttribute('data-transition-uuid', transitionData.id);
            conditionBox.style.cssText = `
                position: absolute;
                width: 58px;
                height: 28px;
                border-radius: 4px;
                background: ${colors.color};
                border: none;
                pointer-events: auto;
                cursor: move;
                box-sizing: border-box;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1;
                margin: 2px;
            `;
            
            // Add text display for transition type
            const typeText = document.createElement('div');
            typeText.className = 'transition-type-text';
            typeText.style.cssText = `
                font-size: 0.7rem;
                color: #ffffff;
                user-select: none;
                pointer-events: none;
                text-align: center;
            `;
            typeText.textContent = transitionData.type;
            conditionBox.appendChild(typeText);
            
            // Add bottom down arrow (visual only, not draggable)
            const bottomArrow = document.createElement('div');
            bottomArrow.className = 'transition-bottom-arrow';
            bottomArrow.style.cssText = `
                position: absolute;
                width: 18px;
                height: 18px;
                top: 100%;
                left: 50%;
                transform: translateX(-50%) translateY(-3px);
                pointer-events: auto;
                font-size: 14px;
                color: ${colors.color};
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                cursor: move;
            `;
            bottomArrow.innerHTML = '&#9660;';
            conditionBox.appendChild(bottomArrow);
            
            return conditionBox;
        }

        // Create a transition frame (3x2 by default, expandable)
        function createTransitionFrame(frameX, frameY, parentStepId = null) {
            const canvas = document.getElementById('workflowCanvas');
            
            // Create frame data object
            transitionFrameCounter++;
            const frameUUID = `frame-${transitionFrameCounter}`;
            
            // Convert pixels to grid coordinates
            const frameGridX = Math.round(frameX / 30);
            const frameGridY = Math.round(frameY / 30);
            
            const frameData = {
                id: frameUUID,
                execution: 'First', // 'First' or 'All'
                conditions: [], // Array of transition condition IDs
                position: `${frameGridX},${frameGridY}`,
                verticalLayout: false, // Default to horizontal layout
                parentStepId: parentStepId  // Store the step that owns this frame
            };
            
            // Create frame container (3x2 = 90px x 60px)
            const frameElement = document.createElement('div');
            frameElement.setAttribute('data-transition-frame', frameUUID);
            frameElement.style.cssText = `
                position: absolute;
                width: 90px;
                height: 60px;
                left: ${frameX}px;
                top: ${frameY}px;
                background: #3a3a2a;
                border: 3px solid #d4af37;
                border-radius: 4px;
                box-sizing: border-box;
                pointer-events: auto;
                cursor: move;
                z-index: 10;
                display: flex;
                flex-direction: column;
            `;
            
            // Create header (Transitions label, clickable for frame properties)
            const header = document.createElement('div');
            header.style.cssText = `
                padding: 4px;
                background: #2a2a1a;
                border-bottom: 2px solid #d4af37;
                text-align: center;
                color: #d4af37;
                font-size: 0.7rem;
                font-weight: bold;
                cursor: pointer;
                user-select: none;
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
            `;
            header.textContent = 'Transitions';
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                showTransitionFrameProperties(frameUUID);
            });
            frameElement.appendChild(header);
            
            // Create conditions container
            const conditionsContainer = document.createElement('div');
            conditionsContainer.setAttribute('data-frame-conditions', frameUUID);
            conditionsContainer.style.cssText = `
                padding: 2px;
                background: #1a1a0a;
                flex: 1;
                display: flex;
                gap: 2px;
                align-items: flex-start;
            `;
            frameElement.appendChild(conditionsContainer);
            
            canvas.appendChild(frameElement);
            currentTransitionFrames.push(frameData);
            
            return { frameElement, frameData, conditionsContainer };
        }

        // Zoom and Pan state (global within script scope)
        let zoomLevel = 1;
        let panX = 0;
        let panY = 0;
        const GRID_SIZE = 5000;
        const MIN_DRAG_DISTANCE = 10; // pixels required to create a transition

        // Transition type theming - centralized color and icon definitions
        function getTransitionTheme(type) {
            const themes = {
                'Success': {
                    color: '#008000',
                    icon: '&#10003;'  // checkmark
                },
                'Failure': {
                    color: '#a00000',
                    icon: '&#10005;'  // X
                },
                'Logic': {
                    color: '#1a5577',
                    icon: `<span style="font-size: 0.85rem;">&#123;&nbsp;&#125;</span>`  // { }
                },
                'Always': {
                    color: '#666666',
                    icon: null  // handled separately based on layout
                }
            };
            return themes[type] || themes['Success'];
        }
        
        // Step type theming - centralized color, display name, and icon definitions
        function getStepTypeTheme(type) {
            const themes = {
                'Begin': {
                    color: '#00aa00',
                    displayName: 'BEGIN',
                    icon: {
                        type: 'html',
                        html: '&#8599;',
                        fontSize: '28px',
                        transform: 'rotate(90deg)'
                    }
                },
                'End': {
                    color: '#ff6666',
                    displayName: 'End',
                    icon: {
                        type: 'html',
                        html: '&#10005;',
                        fontSize: '20px'
                    }
                },
                'Kore': {
                    color: '#666666',
                    displayName: 'Kore',
                    icon: {
                        type: 'svg',
                        href: '/img/icons.svg#i-kore',
                        fill: 'currentColor',
                        stroke: 'currentColor',
                        strokeWidth: '0'
                    }
                },
                'Workflow': {
                    color: '#7733bb',
                    displayName: 'Workflow',
                    icon: {
                        type: 'svg',
                        href: '/img/icons.svg#i-workflows',
                        fill: 'none',
                        stroke: 'currentColor',
                        strokeWidth: '1.75'
                    }
                },
                'RMM': {
                    color: '#3a7a99',
                    displayName: 'RMM Step',
                    icon: {
                        type: 'svg',
                        href: '/img/icons.svg#i-settings',
                        fill: 'none',
                        stroke: 'currentColor',
                        strokeWidth: '1.75'
                    }
                },
                'Standard': {
                    color: '#3a7a99',
                    displayName: 'Standard',
                    icon: {
                        type: 'html',
                        html: '&#9881;',
                        fontSize: '24px'
                    }
                }
            };
            return themes[type] || themes['Standard'];
        }
        
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
        
        function getTransitionDisplayText(type, conditions) {
            if (type === 'Conditional' && !conditions) {
                return 'Always';
            }
            return type;
        }

        // Canvas Drag-and-Drop
        function setupCanvasDragDrop() {
            const stepTypeItems = document.querySelectorAll('.step-type-item');
            const canvas = document.getElementById('workflowCanvas');
            let dragOffsetX = 0;
            let dragOffsetY = 0;

            // Setup draggable step types
            stepTypeItems.forEach(item => {
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('stepType', item.getAttribute('data-type'));
                    // Capture offset from item's top-left to mouse cursor
                    const rect = item.getBoundingClientRect();
                    dragOffsetX = e.clientX - rect.left;
                    dragOffsetY = e.clientY - rect.top;
                });
            });

            // Setup canvas to accept drops
            canvas.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            });

            canvas.addEventListener('dragleave', (e) => {
                if (e.target === canvas) {
                    // Keep canvas transparent with grid
                }
            });

            canvas.addEventListener('drop', (e) => {
                e.preventDefault();
                
                const stepType = e.dataTransfer.getData('stepType');
                const rect = canvas.getBoundingClientRect();
                // Convert screen coordinates to grid coordinates accounting for zoom and pan
                // Subtract the drag offset so top-left of item aligns with drop point
                let x = (e.clientX - rect.left - dragOffsetX) / zoomLevel + panX;
                let y = (e.clientY - rect.top - dragOffsetY) / zoomLevel + panY;
                
                // Snap to 30px grid
                x = Math.round(x / 30) * 30;
                y = Math.round(y / 30) * 30;
                
                createStepOnCanvas(stepType, x, y);
            });
            
            // Zoom and Pan functionality
            let isPanning = false;
            let panStartX = 0;
            let panStartY = 0;
            
            function clampPan() {
                const containerRect = container.getBoundingClientRect();
                const containerWidth = containerRect.width;
                const containerHeight = containerRect.height;
                
                // Calculate visible grid area at current zoom
                const visibleWidth = containerWidth / zoomLevel;
                const visibleHeight = containerHeight / zoomLevel;
                
                // Clamp pan so viewport stays within 0,0 to GRID_SIZE,GRID_SIZE
                // panX/panY represent the top-left corner of the viewport in grid space
                panX = Math.max(0, Math.min(panX, GRID_SIZE - visibleWidth));
                panY = Math.max(0, Math.min(panY, GRID_SIZE - visibleHeight));
            }
            
            function updateTransform() {
                canvas.style.transform = `scale(${zoomLevel}) translate(${-panX}px, ${-panY}px)`;
                canvas.style.transformOrigin = '0 0';
            }
            
            // Mouse wheel zoom
            canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                
                const zoomIncrement = e.deltaY > 0 ? -0.05 : 0.05;
                const newZoom = Math.max(0.55, Math.min(2, zoomLevel + zoomIncrement));
                
                // Adjust pan to zoom toward mouse cursor
                const rect = container.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                
                panX = mouseX / newZoom + (panX * zoomLevel / newZoom) - mouseX / newZoom;
                panY = mouseY / newZoom + (panY * zoomLevel / newZoom) - mouseY / newZoom;
                
                zoomLevel = newZoom;
                clampPan();
                updateTransform();
                updateZoomDisplay();
            }, { passive: false });
            
            // Pan with left mouse button (on empty canvas only)
            const container = document.getElementById('canvasContainer');
            container.addEventListener('mousedown', (e) => {
                if (e.button === 0 && (e.target === canvas || e.target.closest('[data-transition-connection-line]'))) {
                    // Don't pan if clicking on steps, frames, or hitboxes
                    if (e.target.closest('[data-step-uuid]') || 
                        e.target.closest('[data-transition-frame]') ||
                        e.target.closest('[data-case-arrow-hitbox]')) {
                        return;
                    }
                    isPanning = true;
                    panStartX = e.clientX + panX;
                    panStartY = e.clientY + panY;
                    container.style.cursor = 'grabbing';
                    e.preventDefault();
                }
            });
            
            document.addEventListener('mousemove', (e) => {
                if (isPanning && !draggedConnectionHitbox) {
                    panX = panStartX - e.clientX;
                    panY = panStartY - e.clientY;
                    clampPan();
                    updateTransform();
                }
            });
            
            document.addEventListener('mouseup', () => {
                if (isPanning) {
                    isPanning = false;
                    container.style.cursor = 'auto';
                }
            });
            
            // Drag from transition triangles to create lines to steps
            let isDrawingFromTransition = false;
            let fromTransitionId = null;
            let transitionStartX = 0;
            let transitionStartY = 0;
            
            // Drag case line end arrows to move or delete connections
            let draggedCaseConditionId = null;
            let draggedCaseTargetStepId = null;
            let draggedCaseTargetNodeId = null;
            let caseArrowStartX = 0;
            let caseArrowStartY = 0;
            
            // Track dragged connection hitbox
            let draggedConnectionHitbox = null;
            let draggedConnectionLineElement = null;
            let draggedConnectionSourceType = null;
            let draggedConnectionSourceId = null;
            let draggedConnectionTargetType = null;
            let draggedConnectionTargetId = null;
            let draggedConnectionStartPoint = { x: 0, y: 0 };
            
            document.addEventListener('mousedown', (e) => {
                // Check if clicking on a universal connection hitbox
                const hitbox = e.target.closest('[data-connection-hitbox]');
                if (hitbox) {
                    const canvas = document.getElementById('workflowCanvas');
                    if (!canvas) return;
                    
                    e.stopPropagation();
                    e.preventDefault();
                    
                    draggedConnectionHitbox = hitbox;
                    draggedConnectionSourceType = hitbox.getAttribute('data-line-source-type');
                    draggedConnectionSourceId = hitbox.getAttribute('data-line-source-id');
                    draggedConnectionTargetType = hitbox.getAttribute('data-line-target-type');
                    draggedConnectionTargetId = hitbox.getAttribute('data-line-target-id');
                    
                    // Find the line element
                    let lineElement = null;
                    if (draggedConnectionSourceType === 'case') {
                        lineElement = canvas.querySelector(`[data-transition-connection-line][data-from-transition="${draggedConnectionSourceId}"][data-to-${draggedConnectionTargetType}="${draggedConnectionTargetId}"]`);
                    } else if (draggedConnectionSourceType === 'node') {
                        lineElement = canvas.querySelector(`[data-node-connection-line][data-from-node="${draggedConnectionSourceId}"][data-to-${draggedConnectionTargetType}="${draggedConnectionTargetId}"]`);
                    } else if (draggedConnectionSourceType === 'step') {
                        lineElement = canvas.querySelector(`[data-connection-line][data-from-step="${draggedConnectionSourceId}"][data-to-frame="${draggedConnectionTargetId}"]`);
                    }
                    
                    draggedConnectionLineElement = lineElement;
                    
                    // Store the start point - we need the actual source point of the connection
                    // For case lines, start from the transition condition box
                    // For node lines, start from the source node
                    if (draggedConnectionSourceType === 'case') {
                        const transition = currentTransitions.find(t => t.id === draggedConnectionSourceId);
                        const frame = currentTransitionFrames.find(f => f.conditions.includes(draggedConnectionSourceId));
                        if (transition && frame) {
                            const frameElement = canvas.querySelector(`[data-transition-frame="${frame.id}"]`);
                            const conditionBox = frameElement.querySelector(`[data-condition-id="${draggedConnectionSourceId}"]`);
                            if (frameElement && conditionBox) {
                                const frameX = parseInt(frameElement.style.left);
                                const frameY = parseInt(frameElement.style.top);
                                const offsetX = conditionBox.offsetLeft;
                                const offsetY = conditionBox.offsetTop;
                                const width = conditionBox.offsetWidth;
                                const height = conditionBox.offsetHeight;
                                
                                if (frame.verticalLayout) {
                                    draggedConnectionStartPoint = { x: frameX + offsetX + width, y: frameY + offsetY + height / 2 + 3 };
                                } else {
                                    draggedConnectionStartPoint = { x: frameX + offsetX + width / 2 + 2, y: frameY + offsetY + height + 40 };
                                }
                            }
                        }
                    } else if (draggedConnectionSourceType === 'node') {
                        const sourceNode = currentNodes.find(n => n.id === draggedConnectionSourceId);
                        if (sourceNode) {
                            const nodeElement = canvas.querySelector(`[data-node-id="${draggedConnectionSourceId}"]`);
                            if (nodeElement) {
                                const nodeX = parseInt(nodeElement.style.left);
                                const nodeY = parseInt(nodeElement.style.top);
                                const nodeWidth = parseInt(nodeElement.style.width);
                                const nodeHeight = parseInt(nodeElement.style.height);
                                draggedConnectionStartPoint = {
                                    x: nodeX + nodeWidth / 2,
                                    y: nodeY + nodeHeight / 2
                                };
                            }
                        }
                    }
                    
                    // Hide the current line
                    if (lineElement) {
                        lineElement.style.display = 'none';
                    }
                    
                    // Will be handled by mousemove and mouseup
                }
            });
            
            // Handle connection hitbox dragging (move or delete lines)
            document.addEventListener('mousemove', (e) => {
                if (!draggedConnectionHitbox) return;
                
                const canvasRect = document.getElementById('workflowCanvas').getBoundingClientRect();
                const screenX = e.clientX - canvasRect.left;
                const screenY = e.clientY - canvasRect.top;
                const currentX = (screenX / zoomLevel) + panX;
                const currentY = (screenY / zoomLevel) + panY;
                
                // Create or update preview line
                let previewLine = document.getElementById('workflowCanvas').querySelector('[data-connection-preview-line]');
                if (!previewLine) {
                    previewLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    previewLine.setAttribute('data-connection-preview-line', 'true');
                    previewLine.style.cssText = `
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        pointer-events: none;
                        z-index: 1;
                    `;
                    document.getElementById('workflowCanvas').appendChild(previewLine);
                }
                
                const path = createCurvedPath(draggedConnectionStartPoint.x, draggedConnectionStartPoint.y, 'bottom', currentX, currentY, 'bottom');
                previewLine.innerHTML = `<path d="${path}" stroke="#707070" stroke-width="2" fill="none" stroke-dasharray="5,5"/>`;
            });
            
            document.addEventListener('mouseup', (e) => {
                if (!draggedConnectionHitbox) return;
                
                draggedConnectionHitbox = null;
                const canvas = document.getElementById('workflowCanvas');
                
                // Remove preview line
                const previewLine = canvas.querySelector('[data-connection-preview-line]');
                if (previewLine) previewLine.remove();
                
                // Check what we dropped on
                const canvasRect = canvas.getBoundingClientRect();
                const dropX = e.clientX;
                const dropY = e.clientY;
                
                const dropTarget = detectDropTarget(canvas, dropX, dropY);
                const droppedOnStep = dropTarget.droppedOnStep;
                const droppedOnNode = dropTarget.droppedOnNode;
                
                // If dropped on valid target, reattach; otherwise delete the line
                if (droppedOnStep || droppedOnNode) {
                    // Reattach to new target
                    if (draggedConnectionSourceType === 'case') {
                        const transition = currentTransitions.find(t => t.id === draggedConnectionSourceId);
                        if (transition) {
                            // Remove old target from transition
                            if (draggedConnectionTargetType === 'step') {
                                transition.targetSteps = transition.targetSteps.filter(s => s !== draggedConnectionTargetId);
                            } else if (draggedConnectionTargetType === 'node') {
                                transition.targetNodes = transition.targetNodes.filter(n => n !== draggedConnectionTargetId);
                            }
                            
                            // Add new target
                            if (droppedOnStep) {
                                if (!transition.targetSteps.includes(droppedOnStep)) {
                                    transition.targetSteps.push(droppedOnStep);
                                }
                            } else if (droppedOnNode) {
                                if (!transition.targetNodes) transition.targetNodes = [];
                                if (!transition.targetNodes.includes(droppedOnNode)) {
                                    transition.targetNodes.push(droppedOnNode);
                                }
                            }
                            
                            // Remove old line element
                            if (draggedConnectionLineElement) {
                                draggedConnectionLineElement.remove();
                            }
                            
                            // Create new line
                            const lineUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                            const newLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                            newLine.setAttribute('data-transition-connection-line', lineUUID);
                            newLine.setAttribute('data-from-transition', draggedConnectionSourceId);
                            if (droppedOnStep) {
                                newLine.setAttribute('data-to-step', droppedOnStep);
                            } else {
                                newLine.setAttribute('data-to-node', droppedOnNode);
                            }
                            newLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                            canvas.appendChild(newLine);
                            
                            const frame = currentTransitionFrames.find(f => f.conditions.includes(draggedConnectionSourceId));
                            const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                            drawConnectionLine(newLine, draggedConnectionSourceId, 'case', droppedOnStep || droppedOnNode, droppedOnStep ? 'step' : 'node', canvas, caseColor, false, frame);
                            
                            syncTransitionCasesToStep();
                            recheckFlaggedSteps();
                            updatePreview();
                        }
                    } else if (draggedConnectionSourceType === 'node') {
                        const sourceNode = currentNodes.find(n => n.id === draggedConnectionSourceId);
                        if (sourceNode) {
                            // Remove old target
                            if (draggedConnectionTargetType === 'step') {
                                sourceNode.targetSteps = sourceNode.targetSteps.filter(s => s !== draggedConnectionTargetId);
                            } else if (draggedConnectionTargetType === 'node') {
                                sourceNode.targetNodes = sourceNode.targetNodes.filter(n => n !== draggedConnectionTargetId);
                            }
                            
                            // Add new target
                            if (droppedOnStep) {
                                if (!sourceNode.targetSteps.includes(droppedOnStep)) {
                                    sourceNode.targetSteps.push(droppedOnStep);
                                }
                            } else if (droppedOnNode) {
                                if (!sourceNode.targetNodes.includes(droppedOnNode)) {
                                    sourceNode.targetNodes.push(droppedOnNode);
                                }
                            }
                            
                            // Remove old line
                            if (draggedConnectionLineElement) {
                                draggedConnectionLineElement.remove();
                            }
                            
                            // Create new line
                            const lineUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                            const newLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                            newLine.setAttribute('data-node-connection-line', lineUUID);
                            newLine.setAttribute('data-from-node', draggedConnectionSourceId);
                            if (droppedOnStep) {
                                newLine.setAttribute('data-to-step', droppedOnStep);
                            } else {
                                newLine.setAttribute('data-to-node', droppedOnNode);
                            }
                            newLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                            canvas.appendChild(newLine);
                            
                            drawConnectionLine(newLine, draggedConnectionSourceId, 'node', droppedOnStep || droppedOnNode, droppedOnStep ? 'step' : 'node', canvas, '#707070', true);
                            
                            recheckFlaggedSteps();
                            updatePreview();
                        }
                    }
                } else {
                    // Dropped in empty space - delete the line
                    if (draggedConnectionSourceType === 'case') {
                        const transition = currentTransitions.find(t => t.id === draggedConnectionSourceId);
                        if (transition) {
                            if (draggedConnectionTargetType === 'step') {
                                transition.targetSteps = transition.targetSteps.filter(s => s !== draggedConnectionTargetId);
                            } else if (draggedConnectionTargetType === 'node') {
                                transition.targetNodes = transition.targetNodes.filter(n => n !== draggedConnectionTargetId);
                            }
                            syncTransitionCasesToStep();
                            recheckFlaggedSteps();
                            updatePreview();
                        }
                    } else if (draggedConnectionSourceType === 'node') {
                        const sourceNode = currentNodes.find(n => n.id === draggedConnectionSourceId);
                        if (sourceNode) {
                            if (draggedConnectionTargetType === 'step') {
                                sourceNode.targetSteps = sourceNode.targetSteps.filter(s => s !== draggedConnectionTargetId);
                            } else if (draggedConnectionTargetType === 'node') {
                                sourceNode.targetNodes = sourceNode.targetNodes.filter(n => n !== draggedConnectionTargetId);
                            }
                            recheckFlaggedSteps();
                            updatePreview();
                        }
                    }
                    
                    // Remove the line element
                    if (draggedConnectionLineElement) {
                        draggedConnectionLineElement.remove();
                    }
                }
                
                draggedConnectionLineElement = null;
                draggedConnectionSourceType = null;
                draggedConnectionSourceId = null;
                draggedConnectionTargetType = null;
                draggedConnectionTargetId = null;
            });
            
            document.addEventListener('mousedown', (e) => {
                // Original transition arrow handler
                // Check if clicking on a triangle
                const triangle = e.target.closest('[data-transition-arrow]');
                if (!triangle) return;
                
                const canvas = document.getElementById('workflowCanvas');
                if (!canvas) return;
                
                e.stopPropagation();
                isDrawingFromTransition = true;
                fromTransitionId = triangle.getAttribute('data-transition-arrow');
                
                const triangle_element = triangle;  // This is the hitbox
                const triangleRect = triangle_element.getBoundingClientRect();
                const canvasRect = canvas.getBoundingClientRect();
                
                // Start from the triangle's point: center of the triangle visual center (not hitbox center)
                // The triangle is 16px tall (8px border top + 8px border bottom), hitbox is 30px tall
                // Both centered with transform: translateY(-50%), so triangle center is 7px above hitbox center
                const screenStartX = triangleRect.left - canvasRect.left + triangleRect.width / 2;
                const screenStartY = triangleRect.top - canvasRect.top + triangleRect.height / 2 - 10;  // 10px = 3px + 7px offset
                transitionStartX = (screenStartX / zoomLevel) + panX;
                transitionStartY = (screenStartY / zoomLevel) + panY;
                
                const handleTransitionMouseMove = (e) => {
                    if (!isDrawingFromTransition) return;
                    
                    const canvasRect = canvas.getBoundingClientRect();
                    const screenCurrentX = e.clientX - canvasRect.left;
                    const screenCurrentY = e.clientY - canvasRect.top;
                    const currentX = (screenCurrentX / zoomLevel) + panX;
                    const currentY = (screenCurrentY / zoomLevel) + panY;
                    
                    let line = canvas.querySelector('[data-transition-preview-line]');
                    if (!line) {
                        line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                        line.setAttribute('data-transition-preview-line', 'true');
                        line.style.cssText = `
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            pointer-events: none;
                            z-index: 1;
                        `;
                        canvas.appendChild(line);
                    }
                    
                    line.innerHTML = `<line x1="${transitionStartX}" y1="${transitionStartY}" x2="${currentX}" y2="${currentY}" stroke="#707070" stroke-width="2"/>`;
                };
                
                const handleTransitionMouseUp = (e) => {
                    if (!isDrawingFromTransition) return;
                    
                    const savedTransitionId = fromTransitionId; // Save before resetting
                    isDrawingFromTransition = false;
                    fromTransitionId = null;
                    document.removeEventListener('mousemove', handleTransitionMouseMove);
                    document.removeEventListener('mouseup', handleTransitionMouseUp);
                    
                    const previewLine = canvas.querySelector('[data-transition-preview-line]');
                    if (previewLine) previewLine.remove();
                    
                    const canvasRect = canvas.getBoundingClientRect();
                    const screenEndX = e.clientX - canvasRect.left;
                    const screenEndY = e.clientY - canvasRect.top;
                    const gridEndX = (screenEndX / zoomLevel) + panX;
                    const gridEndY = (screenEndY / zoomLevel) + panY;
                    
                    // Check if we dropped on a step
                    const targetStep = document.elementFromPoint(e.clientX, e.clientY);
                    let stepElement = targetStep?.closest('[data-step-id]');
                    let nodeElement = null;
                    
                    // If not found directly, use universal drop detection with 50px margin
                    if (!stepElement) {
                        const dropTarget = detectDropTarget(canvas, e.clientX, e.clientY);
                        if (dropTarget.droppedOnStep) {
                            stepElement = canvas.querySelector(`[data-step-uuid="${dropTarget.droppedOnStep}"]`);
                        }
                        if (dropTarget.droppedOnNode) {
                            nodeElement = canvas.querySelector(`[data-node-id="${dropTarget.droppedOnNode}"]`);
                        }
                    }
                    
                    // If not on a step directly, check if we're on an attached transition frame
                    if (!stepElement) {
                        const frameElement = targetStep?.closest('[data-transition-frame]');
                        if (frameElement) {
                            const frameId = frameElement.getAttribute('data-transition-frame');
                            const attachedFrame = currentTransitionFrames.find(f => f.id === frameId);
                            if (attachedFrame && attachedFrame.attachedToStepId) {
                                stepElement = canvas.querySelector(`[data-step-id][data-step-uuid="${attachedFrame.attachedToStepId}"]`);
                            }
                        }
                    }
                    
                    const transition = currentTransitions.find(t => t.id === savedTransitionId);
                    
                    if (stepElement && Math.hypot(gridEndX - transitionStartX, gridEndY - transitionStartY) >= MIN_DRAG_DISTANCE) {
                        const targetStepId = stepElement.getAttribute('data-step-uuid');
                        const targetStep = currentSteps.find(s => s.id === targetStepId);
                        
                        // Don't allow connections to BEGIN step
                        if (targetStep && targetStep.type === 'Begin') {
                            return;
                        }
                        
                        if (transition && targetStepId) {
                            // Add target step to the transition
                            if (!transition.targetSteps.includes(targetStepId)) {
                                transition.targetSteps.push(targetStepId);
                            }
                            
                            // Create green connection line
                            const lineUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                            const connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                            connectionLine.setAttribute('data-transition-connection-line', lineUUID);
                            connectionLine.setAttribute('data-from-transition', savedTransitionId);
                            connectionLine.setAttribute('data-to-step', targetStepId);
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
                            
                            // Use standard case line rendering
                            const frame = currentTransitionFrames.find(f => f.conditions.includes(savedTransitionId));
                            const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                            drawConnectionLine(connectionLine, savedTransitionId, 'case', targetStepId, 'step', canvas, caseColor, false, frame);
                            
                            syncTransitionCasesToStep();
                            recheckFlaggedSteps();
                            updatePreview();
                        }
                    } else if (nodeElement && Math.hypot(gridEndX - transitionStartX, gridEndY - transitionStartY) >= MIN_DRAG_DISTANCE) {
                        // Dropped on a node - create connection to it
                        const targetNodeId = nodeElement.getAttribute('data-node-id');
                        
                        if (transition && targetNodeId) {
                            // Add target node to the transition
                            if (!transition.targetNodes) {
                                transition.targetNodes = [];
                            }
                            if (!transition.targetNodes.includes(targetNodeId)) {
                                transition.targetNodes.push(targetNodeId);
                            }
                            
                            // Create connection line to node
                            const lineUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                            const connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                            connectionLine.setAttribute('data-transition-connection-line', lineUUID);
                            connectionLine.setAttribute('data-from-transition', savedTransitionId);
                            connectionLine.setAttribute('data-to-node', targetNodeId);
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
                            
                            // Use standard case line rendering
                            const frame = currentTransitionFrames.find(f => f.conditions.includes(savedTransitionId));
                            const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                            drawConnectionLine(connectionLine, savedTransitionId, 'case', targetNodeId, 'node', canvas, caseColor, false, frame);
                            
                            syncTransitionCasesToStep();
                            recheckFlaggedSteps();
                            updatePreview();
                        }
                    } else if (Math.hypot(gridEndX - transitionStartX, gridEndY - transitionStartY) >= MIN_DRAG_DISTANCE) {
                        // Dropped on empty space - create a new node
                        if (transition) {
                            const newNodeId = generateNodeId();
                            
                            // Snap to 15px grid
                            const snappedX = Math.round(gridEndX / 15) * 15;
                            const snappedY = Math.round(gridEndY / 15) * 15;
                            
                            // Convert to grid units (30px per unit)
                            const gridUnitX = snappedX / 30;
                            const gridUnitY = snappedY / 30;
                            
                            // Create node data
                            const newNodeData = {
                                id: newNodeId,
                                position: `${gridUnitX},${gridUnitY}`,
                                targetSteps: [],
                                targetNodes: []
                            };
                            currentNodes.push(newNodeData);
                            
                            // Verify we're adding to the correct transition by checking savedTransitionId
                            const trans1 = currentTransitions.find(t => t.id === '1');
                            const trans2 = currentTransitions.find(t => t.id === '2');
                            if (savedTransitionId !== transition.id) {
                                console.error('ERROR: Transition ID mismatch! savedTransitionId:', savedTransitionId, 'transition.id:', transition.id);
                            }
                            
                            // Add connection from transition to new node - ONLY to the specific transition being dragged from
                            if (!transition.targetNodes) transition.targetNodes = [];
                            if (!transition.targetNodes.includes(newNodeId)) {
                                transition.targetNodes.push(newNodeId);
                            }
                            syncTransitionCasesToStep();
                            updateSaveButtonState();
                            updatePreview();
                            
                            // Render the new node
                            renderNode(newNodeData);
                            
                            // Create case line to new node
                            const newLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                            newLine.setAttribute('data-transition-connection-line', 'true');
                            newLine.setAttribute('data-from-transition', savedTransitionId);
                            newLine.setAttribute('data-to-node', newNodeId);
                            newLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 5;`;
                            canvas.appendChild(newLine);
                            
                            // Add mousedown listener
                            newLine.addEventListener('mousedown', (e) => {
                                if (e.target.closest('[data-case-arrow-hitbox]')) {
                                    e.stopPropagation();
                                }
                            });
                            
                            // Render the case line to the new node
                            const frame = currentTransitionFrames.find(f => f.conditions.includes(savedTransitionId));
                            const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                            drawConnectionLine(newLine, savedTransitionId, 'case', newNodeId, 'node', canvas, caseColor, false, frame);
                            
                            updatePreview();
                        }
                    }
                };
                
                document.addEventListener('mousemove', handleTransitionMouseMove);
                document.addEventListener('mouseup', handleTransitionMouseUp);
            });
            
            // Click on empty canvas to deselect steps and transitions
            canvas.addEventListener('click', (e) => {
                if (e.target === canvas) {
                    document.querySelectorAll('[data-step-id]').forEach(el => {
                        const stepUUID = el.getAttribute('data-step-uuid');
                        const step = currentSteps.find(s => s.id === stepUUID);
                        el.classList.remove('selected');
                    });
                    document.querySelectorAll('[data-transition-uuid]').forEach(el => {
                        const transId = el.getAttribute('data-transition-uuid');
                        const transObj = currentTransitions.find(t => t.id === transId);
                        const transColors = getTransitionTheme(transObj ? transObj.type : 'Success');
                        el.style.borderColor = transColors.border;
                    });
                    document.querySelectorAll('[data-transition-frame]').forEach(el => {
                        el.style.borderColor = '#d4af37';
                    });
                    hidePropertiesPanel();
                    document.getElementById('propertiesContent').innerHTML = '<div style="color: #b0b0b0; font-size: 0.85rem;">Select a step or transition to edit properties</div>';
                }
            });
        }

        function renderStep(stepData) {
            // Universal step rendering - works for both new and loaded steps
            const canvas = document.getElementById('workflowCanvas');
            const stepElement = document.createElement('div');
            const stepId = `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            stepElement.setAttribute('data-step-id', stepId);
            stepElement.setAttribute('data-step-uuid', stepData.id);
            stepElement.setAttribute('data-step-type', stepData.type);
            stepElement.classList.add('step');
            
            // Use position from stepData, or default to 0,0 (top-left)
            let posX = 0;
            let posY = 0;
            if (stepData.position) {
                const [gridX, gridY] = stepData.position.split(',').map(Number);
                posX = gridX * 30;  // Convert 30px grid units to pixels
                posY = gridY * 30;
            }
            
            // Determine size: use override if set, otherwise auto-calculate
            let width, height;
            
            if (stepData.overrideSize) {
                // Use override values (in grid units, convert to pixels)
                width = Math.max(2, stepData.width || 3) * 30;
                height = Math.max(1, stepData.height || 1) * 30;
            } else {
                // Default values
                width = 120;  // 4 grid units
                height = 30; // 1 grid unit
            }
            
            // Only set positioning and sizing in inline styles
            stepElement.style.cssText = `
                left: ${posX}px;
                top: ${posY}px;
                width: ${width}px;
                height: ${height}px;
                z-index: 20;
            `;
            
            // Determine colors for name column based on step type
            // Dark color goes on name column only
            let darkColor = '#0a3d55';      // Default dark (dark blue)
            
            if (stepData.type === 'Begin') {
                darkColor = '#0a4d3a';      // Dark green
            } else if (stepData.type === 'End') {
                darkColor = '#5a1a1a';      // Dark red
            } else if (stepData.type === 'Kore') {
                darkColor = '#3a3a3a';      // Dark gray
            } else if (stepData.type === 'Workflow') {
                darkColor = '#4a1f77';      // Darker purple
            } else if (stepData.type === 'RMM') {
                darkColor = '#0a3d55';      // Dark blue (standard)
            }
            
            // Create the step content with left column (transparent) and name column (dark)
            // Left column (30px wide, transparent) with icon
            const leftColumn = document.createElement('div');
            leftColumn.style.cssText = `
                width: 30px;
                height: 100%;
                background: transparent;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
            `;
            
            // Add icon based on step type using centralized theme
            const stepTheme = getStepTypeTheme(stepData.type);
            const iconData = stepTheme.icon;
            
            if (iconData.type === 'html') {
                const icon = document.createElement('div');
                icon.style.cssText = `
                    font-size: ${iconData.fontSize || '24px'};
                    color: #ffffff;
                    line-height: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: bold;
                    ${iconData.transform ? `transform: ${iconData.transform};` : ''}
                `;
                icon.innerHTML = iconData.html;
                leftColumn.appendChild(icon);
            } else if (iconData.type === 'svg') {
                const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                icon.setAttribute('width', '20');
                icon.setAttribute('height', '20');
                icon.setAttribute('viewBox', '0 0 24 24');
                icon.setAttribute('fill', iconData.fill);
                icon.setAttribute('stroke', iconData.stroke);
                icon.setAttribute('stroke-width', iconData.strokeWidth);
                icon.setAttribute('stroke-linecap', 'round');
                icon.setAttribute('stroke-linejoin', 'round');
                icon.setAttribute('color', '#ffffff');
                icon.innerHTML = `<use href="${iconData.href}"></use>`;
                leftColumn.appendChild(icon);
            }
            
            stepElement.appendChild(leftColumn);
            
            // Name/content area (dark color background and border)
            const contentArea = document.createElement('div');
            contentArea.style.cssText = `
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                background: ${darkColor};
                border: 1px solid ${darkColor};
                border-radius: 4px;
            `;
            contentArea.textContent = stepData.name || getStepTypeTheme(stepData.type).displayName;
            stepElement.appendChild(contentArea);
            
            // Add to canvas temporarily to measure
            canvas.appendChild(stepElement);
            
            // Measure the content to auto-resize if needed
            // Create a temporary element to measure text width
            const tempDiv = document.createElement('div');
            tempDiv.style.cssText = `
                position: absolute;
                visibility: hidden;
                font-size: 0.9rem;
                white-space: nowrap;
            `;
            tempDiv.textContent = stepData.name || `${stepData.type} Step`;
            document.body.appendChild(tempDiv);
            const textWidth = tempDiv.offsetWidth;
            document.body.removeChild(tempDiv);
            
            // Calculate required width: need space for icon (30px) + text + margins
            // 90px available for text in default 120px step (30 icon + 90 content)
            if (!stepData.overrideSize && textWidth > 80) {
                const gridSpaces = Math.ceil((textWidth - 80) / 30);
                width = 120 + (gridSpaces * 30);
                stepElement.style.width = width + 'px';
            }
            
            // Always store the final width/height in step data (in grid units)
            stepData.width = width / 30;
            stepData.height = height / 30;
            
            // Add click handler to show properties
            stepElement.addEventListener('click', (e) => {
                e.stopPropagation();
                
                // Only show properties if the step wasn't just dragged
                if (!wasStepDragged) {
                    showStepProperties(stepData.id);
                    
                    // Deselect all other steps and transitions
                    document.querySelectorAll('[data-step-id]').forEach(el => {
                        el.classList.remove('selected');
                    });
                    document.querySelectorAll('[data-transition-uuid]').forEach(el => {
                        el.classList.remove('selected');
                    });
                    // Highlight selected step
                    stepElement.classList.add('selected');
                }
            });
            
            // Add single connection point (right side by default)
            const circle = document.createElement('div');
            circle.setAttribute('data-connection-point', 'dynamic');
            circle.classList.add('connectionPoint');
            circle.style.cssText = `
                right: -6px;
                top: 50%;
                transform: translateY(-50%);
            `;
            
            // Add drag-to-draw line functionality
            let isDrawing = false;
            let startX, startY;
            let screenStartX, screenStartY;
            let fromStepId = null;
            let fromStepUUID = null;  // Store the step UUID for updateTransitionLine
            let frameUUID = ''; // Will be generated when drag completes
            let currentConnectionPoint = 'bottom'; // Track which side the connection point is on
            
            circle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                isDrawing = true;
                fromStepId = stepElement.getAttribute('data-step-id');
                const rect = stepElement.getBoundingClientRect();
                const canvasRect = canvas.getBoundingClientRect();
                const circleRect = circle.getBoundingClientRect();
                // Store for use in handleMouseMove
                screenStartX = circleRect.left - canvasRect.left + 6;
                screenStartY = circleRect.top - canvasRect.top + 6;
                // Convert to grid coordinates
                startX = (screenStartX / zoomLevel) + panX;
                startY = (screenStartY / zoomLevel) + panY;
                
                // Store the step UUID for later use in updateTransitionLine
                fromStepUUID = stepElement.getAttribute('data-step-uuid');
                
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
            });
            
            const handleMouseMove = (e) => {
                if (isDrawing) {
                    const canvasRect = canvas.getBoundingClientRect();
                    const screenCurrentX = e.clientX - canvasRect.left;
                    const screenCurrentY = e.clientY - canvasRect.top;
                    
                    // Update or create line preview (use screen coordinates)
                    let line = canvas.querySelector('[data-preview-line]');
                    if (!line) {
                        line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                        line.setAttribute('data-preview-line', 'true');
                        line.style.cssText = `
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            pointer-events: none;
                            z-index: 1;
                        `;
                        canvas.appendChild(line);
                    }
                    
                    // Scale screen coordinates to canvas space
                    const scaledX1 = screenStartX / zoomLevel;
                    const scaledY1 = screenStartY / zoomLevel;
                    const scaledX2 = screenCurrentX / zoomLevel;
                    const scaledY2 = screenCurrentY / zoomLevel;
                    
                    line.innerHTML = `<line x1="${scaledX1}" y1="${scaledY1}" x2="${scaledX2}" y2="${scaledY2}" stroke="#707070" stroke-width="2"/>`;
                }
            };
            
            const handleMouseUp = (e) => {
                if (isDrawing) {
                        isDrawing = false;
                        document.removeEventListener('mousemove', handleMouseMove);
                        document.removeEventListener('mouseup', handleMouseUp);
                        
                        const canvasRect = canvas.getBoundingClientRect();
                        const screenEndX = e.clientX - canvasRect.left;
                        const screenEndY = e.clientY - canvasRect.top;
                        
                        // Convert to grid coordinates (no pan offset - we're measuring screen space directly)
                        const gridEndX = (screenEndX / zoomLevel);
                        const gridEndY = (screenEndY / zoomLevel);
                        
                        // Check minimum drag distance
                        const dragDistance = Math.hypot(gridEndX - startX, gridEndY - startY);
                        if (dragDistance < MIN_DRAG_DISTANCE) {
                            // Drag too short, don't create transition
                            return;
                        }
                        
                        // Generate unique frame ID
                        frameUUID = String(Date.now()) + '-' + Math.random().toString(36).substr(2, 9);
                        
                        // Frame is 90px wide x 60px tall, so center offset is 45px x 30px
                        // Calculate center point of frame in grid units
                        const frameCenterGridX = gridEndX - (45 / zoomLevel);
                        const frameCenterGridY = gridEndY - (30 / zoomLevel);
                        
                        // Snap center to nearest half-grid (15px)
                        const snappedX = Math.round(frameCenterGridX / 15) * 15;
                        const snappedY = Math.round(frameCenterGridY / 15) * 15;
                        
                        // Convert to 30px grid coordinates for storage
                        const frameGridX = snappedX / 30;
                        const frameGridY = snappedY / 30;
                        
                        // Store frame data
                        const frameData = {
                            id: frameUUID,
                            execution: 'First',
                            conditions: [],
                            position: `${frameGridX},${frameGridY}`,
                            verticalLayout: false, // Default to horizontal layout
                            parentStepId: fromStepUUID  // Store the step that owns this frame
                        };
                        currentTransitionFrames = currentTransitionFrames || [];
                        currentTransitionFrames.push(frameData);
                        
                        // Create default Success condition
                        transitionCounter++;
                        const defaultConditionId = String(transitionCounter);
                        const defaultConditionData = {
                            id: defaultConditionId,
                            name: '',
                            type: 'Success',
                            conditions: '',
                            targetSteps: [],
                            targetNodes: [],
                            order: 1
                        };
                        
                        // Add condition to frame data
                        frameData.conditions.push(defaultConditionId);
                        currentTransitions.push(defaultConditionData);
                        
                        // Render the frame with the default condition
                        renderTransitionFrame(frameUUID, false);
                        
                        // Get the rendered frame element
                        const frameRect = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                        
                        // Position the frame at the snapped coordinates (top-left corner)
                        if (frameRect) {
                            frameRect.style.left = snappedX + 'px';
                            frameRect.style.top = snappedY + 'px';
                            
                            // Reposition connection point to nearest side of the frame
                            repositionConnectionPoint(frameRect);
                        }
                        
                        // Update the preview line to be permanent, connecting to frame
                        let connectionLine = canvas.querySelector('[data-preview-line]');
                        if (connectionLine) {
                            connectionLine.removeAttribute('data-preview-line');
                            connectionLine.setAttribute('data-connection-line', frameUUID);
                            connectionLine.setAttribute('data-from-step', fromStepUUID);  // Use UUID, not step-id
                            connectionLine.setAttribute('data-from-point', currentConnectionPoint);
                            connectionLine.setAttribute('data-to-frame', frameUUID);
                            
                            // Get the source step data for type checking
                            const sourceStepElement = canvas.querySelector(`[data-step-id="${fromStepId}"]`);
                            const sourceStepUUID = sourceStepElement ? sourceStepElement.getAttribute('data-step-uuid') : null;
                            const sourceStepData = sourceStepUUID ? currentSteps.find(s => s.id === sourceStepUUID) : null;
                            
                            // Update step's transition with the frame and cases
                            if (sourceStepElement && sourceStepData) {
                                const frame = currentTransitionFrames.find(f => f.id === frameUUID);
                                if (frame && !sourceStepData.transition) {
                                    // Create the transition object with cases
                                    sourceStepData.transition = {
                                        position: frame.position,
                                        mode: frame.execution,
                                        vertical: false,
                                        cases: frame.conditions.map(conditionId => {
                                            const caseObj = currentTransitions.find(t => t.id === conditionId);
                                            return caseObj ? {
                                                type: caseObj.type,
                                                conditions: caseObj.conditions,
                                                targetSteps: caseObj.targetSteps,
                                                targetNodes: caseObj.targetNodes || [],
                                                order: caseObj.order
                                            } : null;
                                        }).filter(Boolean)
                                    };
                                    updatePreview();
                                }
                            }
                            
                            // Add defs with marker if not already present
                            if (!connectionLine.querySelector('defs')) {
                                const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                                const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
                                marker.setAttribute('id', 'transitionArrowhead');
                                marker.setAttribute('markerWidth', '10');
                                marker.setAttribute('markerHeight', '10');
                                marker.setAttribute('refX', '9');
                                marker.setAttribute('refY', '3');
                                marker.setAttribute('orient', 'auto');
                                const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                                polygon.setAttribute('points', '0 0, 10 3, 0 6');
                                // Use green for BEGIN step, blue for others
                                const markerColor = sourceStepData && sourceStepData.type === 'Begin' ? '#00cc66' : '#3a7a99';
                                polygon.setAttribute('fill', markerColor);
                                marker.appendChild(polygon);
                                defs.appendChild(marker);
                                connectionLine.appendChild(defs);
                            }
                            
                            // Update line to use curved path
                            // Frame is positioned at (snappedX - 45, snappedY - 30) and is 90px wide x 60px tall
                            const frameActualX = snappedX - 45;
                            const frameActualY = snappedY - 30;
                            const frameWidth = frameRect ? frameRect.offsetWidth : 90;
                            const frameHeight = frameRect ? frameRect.offsetHeight : 60;
                            const frameSideCenters = [
                                { x: frameActualX + frameWidth / 2, y: frameActualY, name: 'top' },
                                { x: frameActualX + frameWidth / 2, y: frameActualY + frameHeight, name: 'bottom' },
                                { x: frameActualX, y: frameActualY + frameHeight / 2, name: 'left' },
                                { x: frameActualX + frameWidth, y: frameActualY + frameHeight / 2, name: 'right' }
                            ];
                            
                            let nearestSide = frameSideCenters[0];
                            let minDistance = Infinity;
                            frameSideCenters.forEach(side => {
                                const distance = Math.hypot(startX - side.x, startY - side.y);
                                if (distance < minDistance) {
                                    minDistance = distance;
                                    nearestSide = side;
                                }
                            });
                            
                            updateTransitionLine(connectionLine, frameUUID, fromStepUUID, currentConnectionPoint, canvas);
                            
                            // Mark the connection circle as connected
                            const fromStep = canvas.querySelector(`[data-step-id="${fromStepId}"]`);
                            if (fromStep) {
                                const connectedCircle = fromStep.querySelector(`[data-connection-point="dynamic"]`);
                                if (connectedCircle) {
                                    // The circle color is now handled by the .connectionPoint class based on step type
                                    connectedCircle.setAttribute('data-connected', 'true');
                                }
                                // Update visibility of all connection points for this step
                                const stepUUID = fromStep.getAttribute('data-step-uuid');
                                updateConnectionPointVisibility(stepUUID);
                            }
                        }
                    }
                };
                
                stepElement.appendChild(circle);
            
            // Function to reposition connection point to nearest side of target frame
            function repositionConnectionPoint(targetFrameElement) {
                if (!targetFrameElement) return;
                
                const stepRect = stepElement.getBoundingClientRect();
                const frameRect = targetFrameElement.getBoundingClientRect();
                const canvasRect = canvas.getBoundingClientRect();
                
                // Get step center
                const stepCenterX = stepRect.left - canvasRect.left + (stepRect.width / 2);
                const stepCenterY = stepRect.top - canvasRect.top + (stepRect.height / 2);
                
                // Get frame center
                const frameCenterX = frameRect.left - canvasRect.left + (frameRect.width / 2);
                const frameCenterY = frameRect.top - canvasRect.top + (frameRect.height / 2);
                
                // Calculate direction from step to frame
                const deltaX = frameCenterX - stepCenterX;
                const deltaY = frameCenterY - stepCenterY;
                
                // Determine which side of the step faces the frame
                let connectionSide = 'bottom';
                const absDeltaX = Math.abs(deltaX);
                const absDeltaY = Math.abs(deltaY);
                
                if (absDeltaY > absDeltaX) {
                    // Frame is more above or below - use top/bottom
                    connectionSide = deltaY > 0 ? 'bottom' : 'top';
                } else {
                    // Frame is more left or right - use left/right
                    connectionSide = deltaX > 0 ? 'right' : 'left';
                }
                
                // Reposition circle to the side facing the frame
                const positionStyles = {
                    'top': 'top: -6px; left: 50%; transform: translateX(-50%);',
                    'bottom': 'bottom: -6px; left: 50%; transform: translateX(-50%);',
                    'left': 'top: 50%; left: -6px; transform: translateY(-50%);',
                    'right': 'top: 50%; right: -6px; transform: translateY(-50%);'
                };
                
                circle.classList.add('connectionPoint');
                circle.style.cssText = positionStyles[connectionSide];
                
                currentConnectionPoint = connectionSide;
                
                // Update any transition connection line from this step to use the new connection point
                const transitionLines = canvas.querySelectorAll(`[data-connection-line][data-from-step="${stepId}"]`);
                transitionLines.forEach(line => {
                    line.setAttribute('data-from-point', connectionSide);
                    const frameId = line.getAttribute('data-to-frame');
                    updateTransitionLine(line, frameId, stepId, connectionSide, canvas);
                });
            }
            
            // Make step draggable to reposition
            let isDragging = false;
            let dragOffsetX = 0;
            let dragOffsetY = 0;
            
            let wasStepDragged = false;
            
            stepElement.addEventListener('mousedown', (e) => {
                isDragging = true;
                wasStepDragged = false; // Reset drag flag on mousedown
                const rect = stepElement.getBoundingClientRect();
                // Convert screen offset to grid offset, accounting for zoom
                dragOffsetX = (e.clientX - rect.left) / zoomLevel;
                dragOffsetY = (e.clientY - rect.top) / zoomLevel;
            });
            
            document.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    wasStepDragged = true; // Mark that we're actually dragging
                    const canvasRect = canvas.getBoundingClientRect();
                    // Convert screen coordinates to grid coordinates
                    // canvasRect already includes the pan transform, so no need to add panX/panY
                    let newX = (e.clientX - canvasRect.left) / zoomLevel - dragOffsetX;
                    let newY = (e.clientY - canvasRect.top) / zoomLevel - dragOffsetY;
                    
                    // Snap to 15px grid (half-grid) visually, but store as 30px grid coordinates
                    newX = Math.round(newX / 15) * 15;
                    newY = Math.round(newY / 15) * 15;
                    
                    // Keep within canvas bounds
                    newX = Math.max(0, newX);
                    newY = Math.max(0, newY);
                    
                    stepElement.style.left = newX + 'px';
                    stepElement.style.top = newY + 'px';
                    
                    // Update step position in data using 30px grid coordinates
                    const gridX = newX / 30;
                    const gridY = newY / 30;
                    stepData.position = `${gridX},${gridY}`;
                    
                    // If this step has an attached frame, move it too
                    const attachedFrame = currentTransitionFrames.find(f => f.attachedToStepId === stepData.id);
                    if (attachedFrame) {
                        const frameElement = canvas.querySelector(`[data-transition-frame="${attachedFrame.id}"]`);
                        if (frameElement) {
                            // Position frame at same Y as step (so name panel hides behind step)
                            frameElement.style.top = newY + 'px';
                            frameElement.style.left = newX + 'px';
                            attachedFrame.position = `${gridX},${gridY}`;
                            
                            // Update all case lines from conditions in this frame
                            attachedFrame.conditions.forEach(conditionId => {
                                const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${conditionId}"]`);
                                caseLines.forEach(line => {
                                    const toStepId = line.getAttribute('data-to-step');
                                    const toNodeId = line.getAttribute('data-to-node');
                                    const transition = currentTransitions.find(t => t.id === conditionId);
                                    const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                                    
                                    if (toStepId) {
                                        drawConnectionLine(line, conditionId, 'case', toStepId, 'step', canvas, caseColor, false, attachedFrame);
                                    } else if (toNodeId) {
                                        drawConnectionLine(line, conditionId, 'case', toNodeId, 'node', canvas, caseColor, false, attachedFrame);
                                    }
                                });
                            });
                        }
                    }
                    
                    // Update any transition connection lines from this step
                    const transitionLines = canvas.querySelectorAll(`[data-connection-line][data-from-step="${stepData.id}"]`);
                    transitionLines.forEach(line => {
                        // Get the frame this line connects to from the data-connection-line value (which is the frameUUID)
                        const frameUUID = line.getAttribute('data-connection-line');
                        if (frameUUID) {
                            const frameElement = canvas.querySelector(`[data-transition-frame="${frameUUID}"]`);
                            if (frameElement) {
                                const closestSide = getClosestSideToFrame(stepElement, frameElement, canvas);
                                updateTransitionLine(line, frameUUID, stepData.id, closestSide, canvas);
                                
                                // Also update the connection point circle position (only if not attached)
                                if (!stepData.transition || !stepData.transition.attached) {
                                    const connectionPoint = stepElement.querySelector('[data-connection-point]');
                                    if (connectionPoint) {
                                        const positionStyles = {
                                            'top': 'top: -6px; left: 50%; transform: translateX(-50%);',
                                            'bottom': 'bottom: -6px; left: 50%; transform: translateX(-50%);',
                                            'left': 'left: -6px; top: 50%; transform: translateY(-50%);',
                                            'right': 'right: -6px; top: 50%; transform: translateY(-50%);'
                                        };
                                        
                                        connectionPoint.classList.add('connectionPoint');
                                        connectionPoint.style.cssText = `
                                            ${positionStyles[closestSide]}
                                        `;
                                    }
                                } else {
                                    // Ensure connection point stays hidden for attached frames
                                    const connectionPoint = stepElement.querySelector('[data-connection-point]');
                                    if (connectionPoint) {
                                        connectionPoint.style.display = 'none';
                                    }
                                }
                            }
                        }
                    });
                    
                    // Update any case lines to this step
                    const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-to-step="${stepData.id}"]`);
                    caseLines.forEach(line => {
                        const fromTransitionId = line.getAttribute('data-from-transition');
                        const frame = currentTransitionFrames.find(f => f.conditions.includes(fromTransitionId));
                        const transition = currentTransitions.find(t => t.id === fromTransitionId);
                        const caseColor = transition ? getTransitionTheme(transition.type).color : getTransitionTheme('Success').color;
                        drawConnectionLine(line, fromTransitionId, 'case', stepData.id, 'step', canvas, caseColor, false, frame);
                    });
                    
                    // Update any node connection lines pointing to this step
                    const inboundNodeLines = canvas.querySelectorAll(`[data-node-connection-line][data-to-step="${stepData.id}"]`);
                    inboundNodeLines.forEach(line => {
                        const fromNodeId = line.getAttribute('data-from-node');
                        drawConnectionLine(line, fromNodeId, 'node', stepData.id, 'step', canvas, '#707070', true);
                    });
                }
                
                // Note: repositionConnectionPoint is called above for each transition frame
            });
            
            document.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                    updatePreview();
                }
            });
            
            // Update connection point visibility based on whether step has transitions
            updateConnectionPointVisibility(stepData.id);
        }
        
        function updateConnectionPointVisibility(stepId) {
            // Check if this step has any connected transitions
            const step = currentSteps.find(s => s.id === stepId);
            if (!step || !step.transition || !step.transition.cases || step.transition.cases.length === 0) {
                // No transitions connected, show all circles
                const stepElement = document.querySelector(`[data-step-uuid="${stepId}"]`);
                if (stepElement) {
                    stepElement.querySelectorAll('[data-connection-point]').forEach(circle => {
                        circle.style.display = 'block';
                    });
                }
                return;
            }
            
            // Step has transitions, hide unconnected circles
            const stepElement = document.querySelector(`[data-step-uuid="${stepId}"]`);
            if (stepElement) {
                stepElement.querySelectorAll('[data-connection-point]').forEach(circle => {
                    const hasConnection = circle.getAttribute('data-connected') === 'true';
                    circle.style.display = hasConnection ? 'block' : 'none';
                });
            }
        }

        function createStepOnCanvas(stepType, x, y) {
            // x and y are already snapped grid coordinates from the drop handler (in pixels)
            // Convert to grid units (divide by 30)
            const gridX = Math.round(x / 30);
            const gridY = Math.round(y / 30);
            
            // Create step data object
            const stepData = {
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                name: stepType === 'Begin' ? 'BEGIN' : stepType === 'End' ? 'End' : stepType === 'Workflow' ? 'Workflow' : stepType === 'RMM' ? 'RMM Step' : stepType === 'Kore' ? 'Kore' : `${stepType} Step`,
                type: stepType,
                action: '',
                width: 3,
                height: 1,
                overrideSize: false,
                variables: [],
                position: `${gridX},${gridY}`,
                transition: {
                    position: `${gridX},${gridY}`,
                    mode: 'First',
                    vertical: false,
                    attached: true,
                    cases: [
                        {
                            type: 'Success',
                            conditions: '',
                            targetSteps: [],
                            targetNodes: [],
                            order: 1
                        }
                    ]
                }
            };
            
            // Store step data
            currentSteps.push(stepData);
            
            // Create and render the attached transition frame
            const frameX = x;  // Use pixel coordinates from drop
            const frameY = y;
            const frameUUID = `frame-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const frameData = {
                id: frameUUID,
                execution: 'First',
                conditions: [],
                position: `${gridX},${gridY}`,
                verticalLayout: false,
                attached: true,
                attachedToStepId: stepData.id  // Runtime variable linking frame to step
            };
            
            // Create default transition condition
            transitionCounter = (transitionCounter || 0) + 1;
            const defaultConditionId = String(transitionCounter);
            const defaultConditionData = {
                id: defaultConditionId,
                type: 'Success',
                conditions: '',
                targetSteps: [],
                targetNodes: [],
                order: 1
            };
            
            frameData.conditions.push(defaultConditionId);
            currentTransitionFrames.push(frameData);
            currentTransitions.push(defaultConditionData);
            
            // Render the step
            renderStep(stepData);
            
            // Render the frame
            renderTransitionFrame(frameUUID, false);
            
            // Mark unsaved changes
            updatePreview();
        }

        // ===== INPUT VARIABLES UI =====


        function setupEventListeners() {
            const previewToggle = document.getElementById('previewToggle');
            const previewBox = document.getElementById('preview');
            if (previewToggle && previewBox) {
                previewToggle.addEventListener('change', function() {
                    previewBox.style.display = this.checked ? 'block' : 'none';
                });
            }
            
            setupCanvasDragDrop();
        }

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
                
                // Clean up any stale references to deleted nodes/steps
                cleanupStaleReferences();
                
                // Build definition object for unsaved changes tracking
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
                    steps: currentSteps,
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


        document.addEventListener('DOMContentLoaded', setupEventListeners);
        window.addEventListener('load', () => {
          loadWorkflow();
          initializeNodeTool();
        });

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
                    
                    // Resize modal to fit content or 95% of viewport, whichever is smaller
                    setTimeout(() => {
                        const modalBody = document.querySelector('.modal-body');
                        const modalBodyContent = document.querySelector('#modal-body-content');
                        
                        console.log('=== MODAL RESIZE DEBUG ===');
                        console.log('modal found:', !!modal);
                        console.log('modalBody found:', !!modalBody);
                        console.log('modalBodyContent found:', !!modalBodyContent);
                        
                        if (modal && modalBody && modalBodyContent) {
                            // Calculate 95% of viewport height
                            const viewportHeight = window.innerHeight;
                            const maxModalHeight = viewportHeight * 0.95;
                            
                            console.log('viewportHeight:', viewportHeight);
                            console.log('maxModalHeight (95%):', maxModalHeight);
                            
                            // Get the actual content height
                            const contentHeight = modalBodyContent.scrollHeight;
                            console.log('contentHeight:', contentHeight);
                            
                            // Account for modal header, footer, and padding
                            const newHeight = Math.min(contentHeight + 80, maxModalHeight);
                            console.log('calculated newHeight:', newHeight);
                            
                            // Set modal height
                            modal.style.height = newHeight + 'px';
                            modal.style.minHeight = 'auto';
                            
                            console.log('modal.style.height set to:', newHeight + 'px');
                            console.log('modal computed height after:', window.getComputedStyle(modal).height);
                            
                            // Enable scrolling in modal-body-content if content is too tall
                            if (contentHeight + 80 > maxModalHeight) {
                                const maxContentHeight = maxModalHeight - 80;
                                modalBodyContent.style.overflowY = 'auto';
                                modalBodyContent.style.maxHeight = maxContentHeight + 'px';
                                console.log('scrolling enabled, maxHeight set to:', maxContentHeight + 'px');
                            } else {
                                console.log('content fits, no scrolling needed');
                            }
                        }
                    }, 100);
                }
            }, 150);
        }

        function closeWorkflowSettingsModal() {
            // Clear working variables - if we got here without saving, changes are discarded
            workingInputVariables = null;
            workingOutputVariables = null;
            
            // showFormModal modals have their own close mechanism, but keep this for compatibility
            const modal = document.querySelector('.modal-container');
            if (modal) {
                modal.remove();
            }
        }

        // Expose functions to global scope for onclick handlers
        window.showWorkflowSettingsModal = showWorkflowSettingsModal;
        window.closeWorkflowSettingsModal = closeWorkflowSettingsModal;
        window.showJSONModal = showJSONModal;
        window.saveWorkflow = saveWorkflow;
        window.loadWorkflow = loadWorkflow;
        window.toggleStepTypesPanel = toggleStepTypesPanel;