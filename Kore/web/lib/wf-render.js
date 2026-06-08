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
                    // Note: pan is handled by canvas transform, not by adjusting coordinates
                    const gridX = Math.round((dropX / zoomLevel) / 30);
                    const gridY = Math.round((dropY / zoomLevel) / 30);
                    
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
          makeElementDraggable(nodeElement, nodeData.id, 'node',
            // onDragMove callback
            (newX, newY, element) => {
              nodeData.position = `${newX / 30},${newY / 30}`;
            },
            // onDragEnd callback
            (finalX, finalY, element) => {
              nodeData.position = `${finalX / 30},${finalY / 30}`;
              updateSaveButtonState();
              updatePreview();
            },
            // options
            { snapSize: 15, bounds: true }
          );
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
                // renderNode already sets up dragging via makeElementDraggable
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
                // Don't interfere if clicking on a triangle arrow
                if (e.target.closest('[data-transition-arrow]')) {
                    return;
                }
                
                // Check if clicking on a valid drag handle area
                const frameData = currentTransitionFrames.find(f => f.id === frameUUID);
                if (!frameData) return;
                
                let isDragHandle = false;
                
                if (frameData.verticalLayout) {
                    // Vertical mode: only allow drag on actual frame visual width or add button
                    const frameRect = e.currentTarget.getBoundingClientRect();
                    const clickX = e.clientX - frameRect.left;
                    isDragHandle = clickX < frameRect.width || e.target.closest('[data-add-condition-btn]');
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
        
        function getTransitionDisplayText(type, conditions) {
            if (type === 'Conditional' && !conditions) {
                return 'Always';
            }
            return type;
        }

        // Canvas Drag-and-Drop