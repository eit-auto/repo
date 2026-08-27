import '/lib/base.js';
import '/lib/wf-canvas.js';

// Step layout constants — derived from wf-canvas.js config (GU, HG, BORDER, I_CONT_H)
const STEP_MIN_W = GU * 4; // default step width — 120px at GU=30

function renderNode(nodeData) {
          const canvas = document.getElementById('workflowCanvas');
          const nodeId = nodeData.id;
          const [gridX, gridY] = nodeData.position.split(',').map(Number);
          const snappedX = gridX * GU;
          const snappedY = gridY * GU;
          
          // Create node element - just a filled diamond, 30x30px (1x1 grid)
          const nodeElement = document.createElement('div');
          nodeElement.setAttribute('data-node-id', nodeId);
          nodeElement.style.cssText = `
            position: absolute;
            left: ${snappedX}px;
            top: ${snappedY}px;
            width: ${GU}px;
            height: ${GU}px;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 20;
            cursor: move;
            user-select: none;
          `;
          
          // Create SVG with large circle (filled) and small circle at bottom
          const diamondSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          diamondSvg.setAttribute('width', GU);
          diamondSvg.setAttribute('height', GU);
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
                  if (e.ctrlKey || e.metaKey) {
                      addToSelection(nodeId, 'node', nodeElement);
                  } else if (selectedElements.size > 1 && selectedElements.has('node:' + nodeId)) {
                      // Plain click on already-selected node in multi-selection: do nothing
                  } else {
                      clearSelection();
                      addToSelection(nodeId, 'node', nodeElement);
                      showNodeProperties(nodeId);
                      showPropertiesPanel();
                  }
              }
              nodeElement.removeAttribute('data-was-dragged');
          });
          
          // Create hitbox for all 4 small circles (invisible, for interaction)
          const circleHitbox = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          circleHitbox.setAttribute('width', GU);
          circleHitbox.setAttribute('height', GU);
          circleHitbox.setAttribute('viewBox', '0 0 24 24');
          circleHitbox.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
          `;
          circleHitbox.innerHTML = `
            <circle cx="12" cy="3.3" r="2.8" fill="transparent" pointer-events="auto" data-circle="top" style="cursor: crosshair !important;"/>
            <circle cx="3.3" cy="12" r="2.8" fill="transparent" pointer-events="auto" data-circle="left" style="cursor: crosshair !important;"/>
            <circle cx="20.7" cy="12" r="2.8" fill="transparent" pointer-events="auto" data-circle="right" style="cursor: crosshair !important;"/>
            <circle cx="12" cy="20.7" r="2.8" fill="transparent" pointer-events="auto" data-circle="bottom" style="cursor: crosshair !important;"/>
          `;
          
          // Add mousedown handler to start drawing connection line from any circle
          circleHitbox.addEventListener('mousedown', (e) => {
            const circle = e.target.closest('[data-circle]');
            if (!circle) return;
            
            e.stopPropagation();
            
            let isDrawing = false;
            let startX, startY;
            
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

            // Convert SVG coordinates (0-24) to pixel coordinates (0-30)
            const pxX = (coords.cx / 24) * GU;
            const pxY = (coords.cy / 24) * GU;

            // Node element's CSS position plus the circle's offset within it
            const nodeLeft = parseInt(nodeElement.style.left) || 0;
            const nodeTop = parseInt(nodeElement.style.top) || 0;
            startX = nodeLeft + pxX;
            startY = nodeTop + pxY;
            
            const handleMouseMove = (moveEvent) => {
              if (isDrawing) {
                const pos = clientToCanvas(moveEvent.clientX, moveEvent.clientY, canvas);

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

                line.innerHTML = `<line x1="${startX}" y1="${startY}" x2="${pos.x}" y2="${pos.y}" stroke="#707070" stroke-width="2"/>`;
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
                const dropPos = clientToCanvas(upEvent.clientX, upEvent.clientY, canvas);
                const dropX = dropPos.x;
                const dropY = dropPos.y;
                
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
                    const gridX = Math.round((dropX - HG) / GU);
                    const gridY = Math.round((dropY - HG) / GU);

                    const newNode = createNode(gridX, gridY);
                    const newNodeId = newNode.id;
                    nodeData.targetNodes.push(newNodeId);

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
              nodeData.position = `${newX / GU},${newY / GU}`;
            },
            // onDragEnd callback
            (finalX, finalY, element) => {
              nodeData.position = `${finalX / GU},${finalY / GU}`;
              updateSaveButtonState();
              updatePreview();
            },
            // options
            { snapSize: HG, bounds: true }
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
    
    // Populate currentTransitions directly from step.transition.cases (no frames needed)
    currentTransitions.length = 0;
    currentTransitionFrames.length = 0;
    currentSteps.forEach(step => {
        if (step.transition && step.transition.cases) {
            step.transition.cases.forEach(caseData => {
                transitionCounter++;
                const conditionId = String(transitionCounter);
                currentTransitions.push({
                    id: conditionId,
                    name: caseData.name || '',
                    type: caseData.type || 'Success',
                    conditions: caseData.conditions || '',
                    targetSteps: caseData.targetSteps || [],
                    targetNodes: caseData.targetNodes || [],
                    order: caseData.order || 1,
                    parentStepId: step.id,
                    variables: caseData.variables || []
                });
                // Store conditionId back on the case so renderStep can look it up
                caseData._conditionId = conditionId;
            });
        }
    });
    
    // Render each loaded step on canvas (case strip rendered inside step)
    currentSteps.forEach(step => {
        renderStep(step);
    });
    
    // Render each loaded node on canvas
    currentNodes.forEach(node => {
        renderNode(node);
    });
    
    // Create node connection lines for loaded nodes
    currentNodes.forEach(node => {
        if (node.targetSteps && node.targetSteps.length > 0) {
            node.targetSteps.forEach(targetStepId => {
                const lineUUID = generateId();
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
        
        if (node.targetNodes && node.targetNodes.length > 0) {
            node.targetNodes.forEach(targetNodeId => {
                const lineUUID = generateId();
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

    // Render case connection lines from each step's case strip
    currentSteps.forEach(step => {
        if (!step.transition || !step.transition.cases) return;
        step.transition.cases.forEach(caseData => {
            const conditionId = caseData._conditionId;
            if (!conditionId) return;
            const transition = currentTransitions.find(t => t.id === conditionId);
            if (!transition) return;

            if (transition.targetSteps && transition.targetSteps.length > 0) {
                transition.targetSteps.forEach(targetStepId => {
                    const lineUUID = generateId();
                    const caseLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    caseLine.setAttribute('data-transition-connection-line', lineUUID);
                    caseLine.setAttribute('data-from-transition', conditionId);
                    caseLine.setAttribute('data-to-step', targetStepId);
                    caseLine.style.cssText = `
                        position: absolute;
                        top: 0; left: 0;
                        width: 100%; height: 100%;
                        pointer-events: none;
                        z-index: 5;
                    `;
                    canvas.appendChild(caseLine);
                    const caseColor = getTransitionTheme(transition.type).color;
                    drawConnectionLine(caseLine, conditionId, 'case', targetStepId, 'step', canvas, caseColor, false, step);
                });
            }

            if (transition.targetNodes && transition.targetNodes.length > 0) {
                transition.targetNodes.forEach(targetNodeId => {
                    const lineUUID = generateId();
                    const caseLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    caseLine.setAttribute('data-transition-connection-line', lineUUID);
                    caseLine.setAttribute('data-from-transition', conditionId);
                    caseLine.setAttribute('data-to-node', targetNodeId);
                    caseLine.style.cssText = `
                        position: absolute;
                        top: 0; left: 0;
                        width: 100%; height: 100%;
                        pointer-events: none;
                        z-index: 5;
                    `;
                    canvas.appendChild(caseLine);
                    const caseColor = getTransitionTheme(transition.type).color;
                    drawConnectionLine(caseLine, conditionId, 'case', targetNodeId, 'node', canvas, caseColor, false, step);
                });
            }
        });
    });
}


        // Universal drop target detection with 50px margin
        // Returns { droppedOnStep: id or null, droppedOnNode: id or null }
function renderTransitionFrame(frameUUID, vertical) {
    // DISABLED: transition frames replaced by inline case strip in step element.
    // Preserved here for potential future use (e.g. vertical/detached mode).
    // All case rendering is now handled by renderCaseStrip() inside renderStep().
}

        
/**
 * Render a case strip inside a step element.
 * Cases are drawn from step.transition.cases, matched to currentTransitions via _conditionId.
 * @param {HTMLElement} stepElement - The step DOM element
 * @param {Object} stepData - The step data object
 * @param {HTMLElement} canvas - The canvas element
 */
function renderCaseStrip(stepElement, stepData, canvas) {
    // Remove any existing case strip
    const existing = stepElement.querySelector('[data-case-strip]');
    if (existing) existing.remove();

    if (!stepData.transition || !stepData.transition.cases) return;

    const cases = stepData.transition.cases;
    const sortedCases = [...cases].sort((a, b) => (a.order || 1) - (b.order || 1));
    const total = sortedCases.length;
    const R = '3px';

    // Case strip: spans full width of content area (right of icon), sits at bottom of step
    const strip = document.createElement('div');
    strip.setAttribute('data-case-strip', stepData.id);
    strip.style.cssText = `
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: ${I_CONT_H / 2}px;
        display: flex;
        align-items: flex-end;
        gap: 0;
        padding: 0;
        box-sizing: border-box;
        overflow: visible;
        z-index: 21;
    `;

    sortedCases.forEach((caseData, index) => {
        const conditionId = caseData._conditionId;
        if (!conditionId) return;
        const transition = currentTransitions.find(t => t.id === conditionId);
        if (!transition) return;

        const colors = getTransitionTheme(transition.type);

        // Dynamic border-radius:
        // TL: rounded only if first and nothing to its left (always square — flush with content area)
        // TR: rounded if last case (add button is to the right, not flush)
        // BR: always square (bottom edge flush with step border)
        // BL: rounded if first case (left edge is open)
        const isFirst = index === 0;
        const isLast = index === total - 1;
        const tl = '0';
        const tr = isLast ? R : '0';
        const br = '0';
        const bl = isFirst ? R : '0';
        const borderRadius = `${tl} ${tr} ${br} ${bl}`;

        // Wrapper: relative, so arrow can overflow below
        const wrapper = document.createElement('div');
        wrapper.style.cssText = `
            position: relative;
            display: flex;
            flex-direction: column;
            align-items: center;
            flex-shrink: 0;
        `;

        // Case box: GU wide, HG-2 tall
        const box = document.createElement('div');
        box.setAttribute('data-condition-id', conditionId);
        box.setAttribute('data-transition-type', transition.type);
        box.setAttribute('data-parent-step-id', stepData.id);
        box.style.cssText = `
            width: ${GU}px;
            height: ${I_CONT_H / 2}px;
            background: ${colors.color};
            border-radius: ${borderRadius};
            display: flex;
            align-items: center;
            justify-content: center;
            color: #ffffff;
            font-size: ${Math.round(GU / 3)}px;
            font-weight: bold;
            user-select: none;
            cursor: pointer;
            line-height: 1;
            box-sizing: border-box;
        `;
        let icon = getTransitionTheme(transition.type).icon;
        if (transition.type === 'Always') icon = '&#9660;';
        box.innerHTML = icon;
        box.addEventListener('click', (e) => {
            e.stopPropagation();
            showTransitionProperties(conditionId);
        });

        // Reorder drag on the box itself (horizontal)
        let isDraggingCase = false;
        let dragStartIdx = -1;

        box.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            isDraggingCase = true;
            dragStartIdx = sortedCases.indexOf(caseData);
            box.style.opacity = '0.6';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDraggingCase || dragStartIdx === -1) return;

            // Check if cursor is more than 1 grid box (30px) outside step bounds — if so, stop reorder
            const stepRect = stepElement.getBoundingClientRect();
            const outsideX = Math.max(0, stepRect.left - e.clientX, e.clientX - stepRect.right);
            const outsideY = Math.max(0, stepRect.top - e.clientY, e.clientY - stepRect.bottom);
            if (outsideX > GU / zoomLevel || outsideY > GU / zoomLevel) {
                isDraggingCase = false;
                dragStartIdx = -1;
                box.style.opacity = '1';
                return;
            }

            // Find which case box is under cursor horizontally
            const allBoxes = stripEl()?.querySelectorAll('[data-condition-id]');
            if (!allBoxes) return;
            let targetIdx = -1;
            allBoxes.forEach((b, i) => {
                const r = b.getBoundingClientRect();
                if (e.clientX >= r.left && e.clientX <= r.right) targetIdx = i;
            });

            if (targetIdx !== -1 && targetIdx !== dragStartIdx) {
                const draggedTransition = currentTransitions.find(t => t.id === conditionId);
                const targetCase = sortedCases[targetIdx];
                const targetTransition = currentTransitions.find(t => t.id === targetCase._conditionId);

                if (draggedTransition && targetTransition) {
                    const targetOrder = targetTransition.order;
                    if (targetIdx > dragStartIdx) {
                        for (let i = dragStartIdx + 1; i <= targetIdx; i++) {
                            const c = currentTransitions.find(t => t.id === sortedCases[i]._conditionId);
                            if (c) c.order--;
                        }
                    } else {
                        for (let i = targetIdx; i < dragStartIdx; i++) {
                            const c = currentTransitions.find(t => t.id === sortedCases[i]._conditionId);
                            if (c) c.order++;
                        }
                    }
                    draggedTransition.order = targetOrder;
                    dragStartIdx = targetIdx;
                    renderCaseStrip(stepElement, stepData, canvas);
                    updatePreview();
                }
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDraggingCase) {
                isDraggingCase = false;
                dragStartIdx = -1;
                box.style.opacity = '1';
            }
        });

        // Down-arrow hitbox: protrudes 6px below the step border
        const hitbox = document.createElement('div');
        hitbox.setAttribute('data-transition-arrow', conditionId);
        hitbox.style.cssText = `
            position: absolute;
            bottom: -6px;
            left: 50%;
            transform: translateX(-50%);
            width: 20px;
            height: 12px;
            cursor: crosshair;
            z-index: 22;
        `;

        wrapper.appendChild(box);
        wrapper.appendChild(hitbox);
        strip.appendChild(wrapper);
    });

    // Helper to re-query the strip (needed inside closures after re-render)
    function stripEl() { return stepElement.querySelector('[data-case-strip]'); }

    // Add Case (+) button
    const addBtn = document.createElement('div');
    addBtn.setAttribute('data-add-condition-btn', stepData.id);
    addBtn.style.cssText = `
        width: ${GU - BORDER}px;
        height: ${I_CONT_H / 2}px;
        background: #d4af37;
        border-radius: ${R} 0 ${R} 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #3a3a2a;
        font-size: ${Math.round(GU / 3)}px;
        font-weight: bold;
        cursor: pointer;
        user-select: none;
        flex-shrink: 0;
        line-height: 1;
        margin-left: auto;
    `;
    addBtn.textContent = '+';
    addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addCaseToStep(stepData.id);
    });
    strip.appendChild(addBtn);

    const contentArea = stepElement.querySelector('[data-content-area]');
    if (contentArea) {
        contentArea.appendChild(strip);
    } else {
        stepElement.appendChild(strip);
    }
}

function renderStep(stepData) {
    // Universal step rendering - works for both new and loaded steps
    const canvas = document.getElementById('workflowCanvas');
    const stepElement = document.createElement('div');
    const stepId = generateId('step');
    stepElement.setAttribute('data-step-id', stepId);
    stepElement.setAttribute('data-step-uuid', stepData.id);
    stepElement.setAttribute('data-step-type', stepData.type);
    stepElement.classList.add('step');
    
    // Use position from stepData, or default to 0,0
    let posX = 0;
    let posY = 0;
    if (stepData.position) {
        const [gridX, gridY] = stepData.position.split(',').map(Number);
        posX = gridX * GU;
        posY = gridY * GU;
    }
    
    // Determine size
    let width, height;
    if (stepData.overrideSize) {
        width = Math.max(2, stepData.width || 3) * GU;
        height = Math.max(1, stepData.height || 1) * GU;
    } else {
        width = STEP_MIN_W;
        height = GU;
    }
    
    // Step type colors from theme
    const stepTheme = getStepTypeTheme(stepData.type);
    const lightColor = stepTheme.lightColor;
    const darkColor = stepTheme.darkColor;
    const iconData = stepTheme.icon;

    stepElement.style.cssText = `
        left: ${posX}px;
        top: ${posY}px;
        width: ${width}px;
        height: ${height}px;
        z-index: 20;
        position: absolute;
        display: flex;
        overflow: visible;
        background: ${lightColor};
        border: ${BORDER}px solid ${lightColor};
        border-radius: ${BORDER * 2}px;
        color: #ffffff;
    `;
    
    // Left column: icon, spans full height, GU-4 px wide
    const leftColumn = document.createElement('div');
    leftColumn.style.cssText = `
        width: ${I_CONT_H}px;
        height: 100%;
        background: transparent;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
    `;

    if (iconData.type === 'html') {
        const icon = document.createElement('div');
        icon.style.cssText = `
            font-size: 22px;
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
        icon.setAttribute("width", I_CONT_H - BORDER);
        icon.setAttribute("height", I_CONT_H - BORDER);
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
    
    // Content area: label top, case strip bottom, relative positioned
    const contentArea = document.createElement('div');
    contentArea.setAttribute('data-content-area', stepData.id);
    contentArea.style.cssText = `
        flex: 1;
        position: relative;
        background: ${darkColor};
        border: none;
        border-radius: ${BORDER * 2}px;
        overflow: visible;
        display: flex;
        flex-direction: column;
        margin-left: ${BORDER}px;
    `;

    // Label: HG-2 height (half grid unit minus 2px for step border)
    const label = document.createElement('div');
    label.style.cssText = `
        height: ${I_CONT_H / 2}px;
        line-height: ${I_CONT_H / 2 - 2}px;
        padding-top: 1px;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: ${Math.round(GU / 3)}px;
        color: #ffffff;
        padding-left: 1px;
        padding-right: 1px;
        box-sizing: border-box;
    `;
    label.textContent = stepData.name || stepTheme.displayName;
    contentArea.appendChild(label);

    stepElement.appendChild(contentArea);
    
    // Add to canvas temporarily to measure text width
    canvas.appendChild(stepElement);
    
    const tempDiv = document.createElement('div');
    tempDiv.style.cssText = `
        position: absolute;
        visibility: hidden;
        font-size: ${Math.round(GU / 3)}px;
        white-space: nowrap;
    `;
    tempDiv.textContent = stepData.name || `${stepData.type} Step`;
    document.body.appendChild(tempDiv);
    const textWidth = tempDiv.offsetWidth;
    document.body.removeChild(tempDiv);
    
    if (!stepData.overrideSize && textWidth > 84) {
        const gridSpaces = Math.ceil((textWidth - (STEP_MIN_W - GU - BORDER * 2)) / GU);
        width = STEP_MIN_W + (gridSpaces * GU);
        stepElement.style.width = width + 'px';
    }

    // Also ensure step is wide enough for existing cases + add button
    if (!stepData.overrideSize) {
        const caseCount = (stepData.transition && stepData.transition.cases) ? stepData.transition.cases.length : 0;
        if (caseCount > 0) {
            const requiredWidth = (caseCount + 2) * GU;  // cases + add-btn + icon column
            if (requiredWidth > width) {
                width = requiredWidth;
                stepElement.style.width = width + 'px';
            }
        }
    }

    stepData.width = width / GU;
    stepData.height = height / GU;
    
    // Render case strip inside content area
    renderCaseStrip(stepElement, stepData, canvas);
    
    // Click handler
    stepElement.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!wasStepDragged) {
            if (e.ctrlKey || e.metaKey) {
                addToSelection(stepData.id, 'step', stepElement);
            } else if (selectedElements.size > 1 && selectedElements.has('step:' + stepData.id)) {
                // plain click on already-selected step in multi-select: do nothing
            } else {
                clearSelection();
                addToSelection(stepData.id, 'step', stepElement);
                document.querySelectorAll('[data-transition-uuid]').forEach(el => {
                    el.classList.remove('selected');
                });
                showStepProperties(stepData.id);
                showPropertiesPanel();
            }
        }
    });
    
    // Step drag
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let multiDragStartPositions = null;
    let wasStepDragged = false;
    
    stepElement.addEventListener('mousedown', (e) => {
        // Don't start step drag when clicking on case strip controls
        if (e.target.closest('[data-case-strip]')) return;
        isDragging = true;
        wasStepDragged = false;
        const canvasPos = clientToCanvas(e.clientX, e.clientY, canvas);
        dragOffsetX = canvasPos.x - (parseInt(stepElement.style.left) || 0);
        dragOffsetY = canvasPos.y - (parseInt(stepElement.style.top) || 0);
        multiDragStartPositions = null;
        setTimeout(() => {
            const myKey = 'step:' + stepData.id;
            if (isDragging && selectedElements.size > 1 && selectedElements.has(myKey)) {
                multiDragStartPositions = {};
                selectedElements.forEach(key => {
                    const el = getElementForKey(key);
                    if (el) {
                        multiDragStartPositions[key] = {
                            x: parseInt(el.style.left) || 0,
                            y: parseInt(el.style.top) || 0
                        };
                    }
                });
            }
        }, 0);
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        wasStepDragged = true;

        if (multiDragStartPositions === null) {
            const myKey = 'step:' + stepData.id;
            if (selectedElements.size > 1 && selectedElements.has(myKey)) {
                multiDragStartPositions = {};
                selectedElements.forEach(key => {
                    const el = getElementForKey(key);
                    if (el) {
                        multiDragStartPositions[key] = {
                            x: parseInt(el.style.left) || 0,
                            y: parseInt(el.style.top) || 0
                        };
                    }
                });
            } else {
                multiDragStartPositions = false;
            }
        }

        const pos = clientToCanvas(e.clientX, e.clientY, canvas);
        let newX = pos.x - dragOffsetX;
        let newY = pos.y - dragOffsetY;
        newX = Math.max(0, Math.round(newX / HG) * HG);
        newY = Math.max(0, Math.round(newY / HG) * HG);
        if (multiDragStartPositions && multiDragStartPositions !== false) {
            const myStart = multiDragStartPositions['step:' + stepData.id];
            if (myStart) {
                const dx = newX - myStart.x;
                const dy = newY - myStart.y;
                selectedElements.forEach(key => {
                    if (key === 'step:' + stepData.id) return;
                    const el = getElementForKey(key);
                    const start = multiDragStartPositions[key];
                    if (el && start) {
                        const elX = Math.max(0, start.x + dx);
                        const elY = Math.max(0, start.y + dy);
                        el.style.left = elX + 'px';
                        el.style.top = elY + 'px';
                        const [elType, elId] = key.split(':');
                        updateConnectedLines(elId, elType);
                        updateElementPosition(elId, elType, elX, elY);

                        if (elType === 'step') {
                            const elGridX = elX / GU;
                            const elGridY = elY / GU;
                            const elStepData = currentSteps.find(s => s.id === elId);
                            if (elStepData) elStepData.position = `${elGridX},${elGridY}`;

                            // Update case lines outbound from this co-dragged step
                            const elStep = currentSteps.find(s => s.id === elId);
                            if (elStep && elStep.transition && elStep.transition.cases) {
                                elStep.transition.cases.forEach(cd => {
                                    const cid = cd._conditionId;
                                    if (!cid) return;
                                    const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${cid}"]`);
                                    caseLines.forEach(line => {
                                        const toStepId = line.getAttribute('data-to-step');
                                        const toNodeId = line.getAttribute('data-to-node');
                                        const tr = currentTransitions.find(t => t.id === cid);
                                        const caseColor = tr ? getTransitionTheme(tr.type).color : getTransitionTheme('Success').color;
                                        if (toStepId) drawConnectionLine(line, cid, 'case', toStepId, 'step', canvas, caseColor, false, elStep);
                                        else if (toNodeId) drawConnectionLine(line, cid, 'case', toNodeId, 'node', canvas, caseColor, false, elStep);
                                    });
                                });
                            }

                            // Update case lines inbound to this co-dragged step
                            const elCaseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-to-step="${elId}"]`);
                            elCaseLines.forEach(line => {
                                const fromTransId = line.getAttribute('data-from-transition');
                                const tr = currentTransitions.find(t => t.id === fromTransId);
                                const srcStep = tr ? currentSteps.find(s => s.id === tr.parentStepId) : null;
                                const caseColor = tr ? getTransitionTheme(tr.type).color : getTransitionTheme('Success').color;
                                drawConnectionLine(line, fromTransId, 'case', elId, 'step', canvas, caseColor, false, srcStep);
                            });

                            const elInboundNodeLines = canvas.querySelectorAll(`[data-node-connection-line][data-to-step="${elId}"]`);
                            elInboundNodeLines.forEach(line => {
                                const fromNodeId = line.getAttribute('data-from-node');
                                drawConnectionLine(line, fromNodeId, 'node', elId, 'step', canvas, '#707070', true);
                            });
                        }
                    }
                });
            }
        }

        stepElement.style.left = newX + 'px';
        stepElement.style.top = newY + 'px';
        
        const gridX = newX / GU;
        const gridY = newY / GU;
        stepData.position = `${gridX},${gridY}`;

        // Update case lines outbound from this step
        if (stepData.transition && stepData.transition.cases) {
            stepData.transition.cases.forEach(cd => {
                const cid = cd._conditionId;
                if (!cid) return;
                const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${cid}"]`);
                caseLines.forEach(line => {
                    const toStepId = line.getAttribute('data-to-step');
                    const toNodeId = line.getAttribute('data-to-node');
                    const tr = currentTransitions.find(t => t.id === cid);
                    const caseColor = tr ? getTransitionTheme(tr.type).color : getTransitionTheme('Success').color;
                    if (toStepId) drawConnectionLine(line, cid, 'case', toStepId, 'step', canvas, caseColor, false, stepData);
                    else if (toNodeId) drawConnectionLine(line, cid, 'case', toNodeId, 'node', canvas, caseColor, false, stepData);
                });
            });
        }

        // Update case lines inbound to this step
        const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-to-step="${stepData.id}"]`);
        caseLines.forEach(line => {
            const fromTransitionId = line.getAttribute('data-from-transition');
            const tr = currentTransitions.find(t => t.id === fromTransitionId);
            const srcStep = tr ? currentSteps.find(s => s.id === tr.parentStepId) : null;
            const caseColor = tr ? getTransitionTheme(tr.type).color : getTransitionTheme('Success').color;
            drawConnectionLine(line, fromTransitionId, 'case', stepData.id, 'step', canvas, caseColor, false, srcStep);
        });

        // Update node connection lines pointing to this step
        const inboundNodeLines = canvas.querySelectorAll(`[data-node-connection-line][data-to-step="${stepData.id}"]`);
        inboundNodeLines.forEach(line => {
            const fromNodeId = line.getAttribute('data-from-node');
            drawConnectionLine(line, fromNodeId, 'node', stepData.id, 'step', canvas, '#707070', true);
        });
    });
    
    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            multiDragStartPositions = null;
            updatePreview();
        }
    });
}

function showPropertiesPanel() {
    const panel = document.getElementById('propertiesPanel');
    if (panel) panel.style.display = 'block';
}

function hidePropertiesPanel() {
    const panel = document.getElementById('propertiesPanel');
    if (panel) panel.style.display = 'none';
}

function renderPropertiesPanel(title, borderColor, deleteButtonConfig, contentHTML, onListenersAttach, headerStyle = '') {
    const propertiesContent = document.getElementById('propertiesContent');
    showPropertiesPanel();

    const deleteButtonHTML = deleteButtonConfig
        ? `<button class="btn" data-color="red" data-size="sm" onclick="deleteElement('${deleteButtonConfig.id}', '${deleteButtonConfig.type}')" style="padding: 6px 12px;">Delete</button>`
        : '';

    // Support both legacy single-string and new { basic, advanced } content
    const basicHTML   = (typeof contentHTML === 'object' && contentHTML !== null) ? (contentHTML.basic   || '') : contentHTML;
    const advancedHTML = (typeof contentHTML === 'object' && contentHTML !== null) ? (contentHTML.advanced || '') : '';
    const hasAdvanced = advancedHTML.trim().length > 0;

    propertiesContent.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid ${borderColor}; ${headerStyle}">
            <div style="font-size: 0.9rem; color: #e0e0e0; font-weight: 500;">${title}</div>
            ${deleteButtonHTML}
        </div>
        <div style="display: flex; gap: 0; border-bottom: 1px solid var(--border-primary); margin-bottom: 14px; flex-shrink: 0;">
            <button type="button" id="propTabBasic" style="
                background: none; border: none; border-bottom: 2px solid var(--brand-light, #3a9fd1);
                padding: 6px 14px; font-size: 0.82rem; cursor: pointer;
                color: var(--text-primary); font-weight: 600;
                margin-bottom: -1px; transition: color 0.15s, border-color 0.15s;">Basic</button>
            <button type="button" id="propTabAdvanced" ${!hasAdvanced ? 'disabled' : ''} style="
                background: none; border: none; border-bottom: 2px solid transparent;
                padding: 6px 14px; font-size: 0.82rem;
                cursor: ${hasAdvanced ? 'pointer' : 'not-allowed'};
                color: ${hasAdvanced ? 'var(--text-muted)' : 'var(--text-muted)'};
                opacity: ${hasAdvanced ? '1' : '0.4'};
                font-weight: normal;
                margin-bottom: -1px; transition: color 0.15s, border-color 0.15s;">Advanced</button>
        </div>
        <div id="propPanelBasic" style="display: flex; flex-direction: column; gap: 15px;">
            ${basicHTML}
        </div>
        <div id="propPanelAdvanced" style="display: none; flex-direction: column; gap: 15px;">
            ${advancedHTML}
        </div>
    `;

    // Tab switching
    const tabBasic    = propertiesContent.querySelector('#propTabBasic');
    const tabAdvanced = propertiesContent.querySelector('#propTabAdvanced');
    const panelBasic    = propertiesContent.querySelector('#propPanelBasic');
    const panelAdvanced = propertiesContent.querySelector('#propPanelAdvanced');

    function activatePropTab(tab) {
        const isBasic = tab === 'basic';
        tabBasic.style.color             = isBasic ? 'var(--text-primary)' : 'var(--text-muted)';
        tabBasic.style.borderBottomColor = isBasic ? 'var(--brand-light, #3a9fd1)' : 'transparent';
        tabBasic.style.fontWeight        = isBasic ? '600' : 'normal';
        tabAdvanced.style.color             = !isBasic ? 'var(--text-primary)' : (hasAdvanced ? 'var(--text-muted)' : 'var(--text-muted)');
        tabAdvanced.style.borderBottomColor = !isBasic ? 'var(--brand-light, #3a9fd1)' : 'transparent';
        tabAdvanced.style.fontWeight        = !isBasic ? '600' : 'normal';
        panelBasic.style.display    = isBasic ? 'flex' : 'none';
        panelAdvanced.style.display = !isBasic ? 'flex' : 'none';
    }

    tabBasic.addEventListener('click', () => activatePropTab('basic'));
    if (hasAdvanced) {
        tabAdvanced.addEventListener('click', () => activatePropTab('advanced'));
    }

    // Call the type-specific listener setup function
    if (typeof onListenersAttach === 'function') {
        onListenersAttach(propertiesContent);
    }
}

function renderCaseLineEmpty(line, conditionId, canvasElement, stepData) {
    // Render a case arrow for a condition with no targets.
    // Now calculates position from the step element and its case strip,
    // not from a transition frame element.
    const stepElement = canvasElement.querySelector(`[data-step-uuid="${stepData.id}"]`);
    if (!stepElement) return;

    const conditionBox = stepElement.querySelector(`[data-condition-id="${conditionId}"]`);
    if (!conditionBox) return;

    const stepX = parseInt(stepElement.style.left);
    const stepY = parseInt(stepElement.style.top);
    const stepHeight = parseInt(stepElement.style.height);

    // Position of the condition box relative to canvas
    const strip = conditionBox.closest('[data-case-strip]');
    const stripOffsetLeft = strip ? strip.offsetLeft : 0;
    const boxOffsetLeft = conditionBox.offsetLeft;
    const conditionWidth = conditionBox.offsetWidth;

    const startX = stepX + stripOffsetLeft + boxOffsetLeft + conditionWidth / 2;
    const startY = stepY + stepHeight - 1;  // 1px below step border
    const startDirection = 'bottom';

    const endX = startX;
    const endY = startY + 60;

    const path = createCurvedPath(startX, startY, startDirection, endX, endY, startDirection);

    const transition = currentTransitions.find(t => t.id === conditionId);
    const transitionColors = transition ? getTransitionTheme(transition.type) : getTransitionTheme('Success');

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
        width: ${GU * 2 - BORDER * 2}px;
        height: ${GU - BORDER * 2}px;
        border-radius: ${BORDER * 2}px;
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
        font-size: 22px;
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
    const frameGridX = Math.round(frameX / GU);
    const frameGridY = Math.round(frameY / GU);
    
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
        border: ${BORDER}px solid #d4af37;
        border-radius: ${BORDER * 2}px;
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

        // Zoom and Pan state lives in wf-canvas.js (zoomLevel, panX, panY are on window)
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
            color: '#097788',
            icon: `<span style="font-size: 0.6rem;">&#123;&nbsp;&#125;</span>`  // { }
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
            lightColor: '#00aa00',
            darkColor: '#0a4d3a',
            displayName: 'BEGIN',
            icon: {
                type: 'html',
                html: '&#8599;',
                transform: 'rotate(90deg)'
            }
        },
        'Kore': {
            lightColor: '#666666',
            darkColor: '#3a3a3a',
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
            lightColor: '#7733bb',
            darkColor: '#4a1f77',
            displayName: 'Workflow',
            icon: {
                type: 'svg',
                href: '/img/icons.svg#i-workflows',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '1.75'
            }
        },
        'Plugin': {
            lightColor: '#369BB9',
            darkColor: '#1B4E66',
            displayName: 'Plugin',
            icon: {
                type: 'svg',
                href: '/img/icons.svg#i-settings',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '1.75'
            }
        },
        'RMM': {
            lightColor: '#3a7a99',
            darkColor: '#0a3d55',
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
            lightColor: '#3a7a99',
            darkColor: '#0a3d55',
            displayName: 'Standard',
            icon: {
                type: 'html',
                html: '&#9881;'
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
// ============================================================================
// EXPORTS TO WINDOW
// ============================================================================
window.clearInvalidHighlight = clearInvalidHighlight;
window.createTransitionConditionBox = createTransitionConditionBox;
window.createTransitionFrame = createTransitionFrame;
window.getStepTypeTheme = getStepTypeTheme;
window.getTransitionDisplayText = getTransitionDisplayText;
window.getTransitionTheme = getTransitionTheme;
window.hidePropertiesPanel = hidePropertiesPanel;
window.highlightInvalidSteps = highlightInvalidSteps;
window.renderCaseLineEmpty = renderCaseLineEmpty;
window.renderLoadedStepsOnCanvas = renderLoadedStepsOnCanvas;
window.renderNode = renderNode;
window.STEP_MIN_W = STEP_MIN_W;
window.renderPropertiesPanel = renderPropertiesPanel;
window.renderStep = renderStep;
window.renderCaseStrip = renderCaseStrip;
window.renderTransitionFrame = renderTransitionFrame;
window.showPropertiesPanel = showPropertiesPanel;