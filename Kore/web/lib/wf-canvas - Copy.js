/**
 * wf-canvas.js
 * 
 * Canvas interaction management for workflow editor
 * - Drawing and rendering connection lines
 * - Canvas drag-drop for step creation
 * - Pan and zoom functionality
 * - Node and element dragging
 * - Connection detection and visibility
 */

import '/lib/base.js';

// ============================================================================
// GLOBAL PAN AND ZOOM STATE
// ============================================================================
let panX = 0;
let panY = 0;
let zoomLevel = 1;
const GRID_SIZE = 5000; // Must match HTML canvas dimensions
const MIN_DRAG_DISTANCE = 20; // Minimum pixels to drag before considering it a drag operation

// ============================================================================
// MULTI-SELECT STATE
// ============================================================================
// Each entry is a string key: 'step:id', 'node:id', 'frame:id'
const selectedElements = new Set();

/**
 * Add or toggle an element in the multi-selection.
 * Applies 'selected' class and hides the properties panel.
 */
function addToSelection(id, type, element) {
    const key = type + ':' + id;
    if (selectedElements.has(key)) {
        selectedElements.delete(key);
        if (element) element.classList.remove('selected');
    } else {
        selectedElements.add(key);
        if (element) element.classList.add('selected');
    }
    if (selectedElements.size > 0) {
        hidePropertiesPanel();
    }
}

/**
 * Clear all multi-selections and remove 'selected' class.
 * Does not touch the properties panel.
 */
function clearSelection() {
    selectedElements.clear();
    document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
}

/**
 * Get the canvas element for a given selection key
 */
function getElementForKey(key) {
    const canvas = document.getElementById('workflowCanvas');
    const [type, id] = key.split(':');
    if (type === 'step') return canvas.querySelector(`[data-step-uuid="${id}"]`);
    if (type === 'node') return canvas.querySelector(`[data-node-id="${id}"]`);
    if (type === 'frame') return canvas.querySelector(`[data-transition-frame="${id}"]`);
    return null;
}

// ============================================================================
// PHASE 1: PURE UTILITY FUNCTIONS - No dependencies
// ============================================================================

/**
 * Offset a point AWAY from an edge for control point calculation
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {string} side - 'top'|'bottom'|'left'|'right'
 * @param {number} offset - Distance to offset (default 6)
 * @returns {object} - {x, y} offset point
 */
function offsetPointFromEdge(x, y, side, offset = 6) {
    switch(side) {
        case 'top': return { x: x, y: y - offset };
        case 'bottom': return { x: x, y: y + offset };
        case 'left': return { x: x - offset, y: y };
        case 'right': return { x: x + offset, y: y };
        default: return { x: x, y: y };
    }
}

/**
 * Create a curved SVG path using cubic bezier curves
 * @param {number} x1 - Start X
 * @param {number} y1 - Start Y
 * @param {string} exitSide - Exit direction ('top'|'bottom'|'left'|'right')
 * @param {number} x2 - End X
 * @param {number} y2 - End Y
 * @param {string} enterSide - Entry direction
 * @returns {string} - SVG path data (M ... C ...)
 */
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

/**
 * Find which side of a step is closest to a frame
 * @param {HTMLElement} stepElement - Step DOM element
 * @param {HTMLElement} frameElement - Transition frame DOM element
 * @param {HTMLElement} canvas - Canvas DOM element
 * @returns {string} - 'top'|'bottom'|'left'|'right'
 */
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

// ============================================================================
// PHASE 2: DETECTION & VISIBILITY FUNCTIONS
// ============================================================================

/**
 * Detect which step or node the mouse is over, with a catch area margin
 * @param {HTMLElement} canvas - Canvas DOM element
 * @param {number} clientX - Mouse X coordinate (screen space)
 * @param {number} clientY - Mouse Y coordinate (screen space)
 * @returns {object} - {droppedOnStep: stepId|null, droppedOnNode: nodeId|null}
 */
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

/**
 * Update visibility of connection point circles on a step
 * Shows all circles if no transitions, hides unconnected ones if transitions exist
 * @param {string} stepId - Step UUID
 */
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

// ============================================================================
// PHASE 3: DRAWING FUNCTIONS - Line rendering for all connection types
// ============================================================================

/**
 * Draw a connection line from a step to a transition frame
 * @param {SVGElement} line - SVG element to render into
 * @param {string} frameUUID - Transition frame UUID
 * @param {string} fromStepId - Source step UUID
 * @param {string} fromConnectionPoint - 'top'|'bottom'|'left'|'right'
 * @param {HTMLElement} canvasElement - Canvas DOM element
 * @param {string} lineColor - Hex color code (optional, derives from step type if omitted)
 */
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
 * Unified line drawing for all connection types (step→frame, step→step, node→step, case→step, case→node)
 * Handles floating endpoints, curved bezier paths, and interactive hitboxes
 * @param {SVGElement} lineElement - SVG to draw into
 * @param {string} sourceId - step/node/case UUID
 * @param {string} sourceType - 'step'|'node'|'case'
 * @param {string} targetId - step/node/frame UUID
 * @param {string} targetType - 'step'|'node'|'frame'
 * @param {HTMLElement} canvas - canvas element
 * @param {string} lineColor - hex color code
 * @param {boolean} sourceFloating - does source endpoint float? (default true)
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
            
            // Entry point based on target center Y position relative to node center Y
            if (targetCenterGridY < sourceCenterGridY - 1.5) {
                nearestTargetSide = targetSides[1]; // bottom
            } else if (targetCenterGridY > sourceCenterGridY + 1.5) {
                nearestTargetSide = targetSides[0]; // top
            } else {
                // Target within ±1 grid unit Y of node: enter from side (left or right, closer to node center X)
                const distToLeft = Math.abs(sourceCenterX - targetX);
                const distToRight = Math.abs(sourceCenterX - (targetX + targetWidth));
                if (distToLeft <= distToRight) {
                    nearestTargetSide = targetSides[2]; // left
                } else {
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

// ============================================================================
// PHASE 4: PLACEMENT FUNCTIONS - Node and step creation
// ============================================================================

/**
 * Place a node on the canvas at the specified coordinates
 * Creates node data, adds to state, and renders visually
 * @param {number} x - X coordinate in pixels
 * @param {number} y - Y coordinate in pixels
 */
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
    updateSaveButtonState();
    updatePreview();
    
    // Render the node
    renderNode(nodeData);
}

/**
 * Create a step on the canvas with attached transition frame
 * @param {string} stepType - Type of step (Begin, End, Workflow, RMM, Kore, etc.)
 * @param {number} x - X coordinate in pixels (snapped grid)
 * @param {number} y - Y coordinate in pixels (snapped grid)
 */
function createStepOnCanvas(stepType, x, y) {
    // x and y are already snapped grid coordinates from the drop handler (in pixels)
    // Convert to grid units (divide by 30)
    const gridX = Math.round(x / 30);
    const gridY = Math.round(y / 30);
    
    // Create step data object
    const stepData = {
        id: generateId(),
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
    const frameUUID = generateId("frame");
    const frameData = {
        id: frameUUID,
        execution: 'First',
        conditions: [],
        position: `${gridX},${gridY}`,
        verticalLayout: false,
        attached: true,
        parentStepId: stepData.id,
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

// ============================================================================
// PHASE 5: LINE UPDATE FUNCTION - Refresh connections when elements move
// ============================================================================

/**
 * Universal function to update all lines connected to a draggable element
 * Called whenever a step, frame, or node moves to refresh visual connections
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

// ============================================================================
// PHASE 6: DRAG HANDLER - Universal element dragging with callbacks
// ============================================================================

/**
 * Make any element draggable with universal drag handling
 * Handles steps, frames, and nodes with optional callbacks and grid snapping
 * @param {HTMLElement} element - The element to make draggable
 * @param {string} elementId - The element's ID (step/frame/node UUID)
 * @param {string} elementType - Type of element: 'step', 'frame', or 'node'
 * @param {Function} onDragMove - Optional callback during drag: (newX, newY, element) => void
 * @param {Function} onDragEnd - Optional callback after drag ends: (finalX, finalY, element) => void
 * @param {Object} options - Configuration options:
 *   - dragHandle: CSS selector for drag handle element (default: null = drag anywhere)
 *   - threshold: pixels to move before drag starts (default: 0)
 *   - snapSize: grid snap size in pixels (default: 15)
 *   - bounds: enforce non-negative coordinates (default: true)
 */
function makeElementDraggable(element, elementId, elementType, onDragMove, onDragEnd, options = {}) {
    const canvas = document.getElementById('workflowCanvas');
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let multiDragStartPositions = null; // {key: {x, y}} for all selected elements at drag start
    
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

        // If this element is in a multi-selection, snapshot all selected positions
        const myKey = elementType + ':' + elementId;
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
            multiDragStartPositions = null;
        }
        
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

            if (multiDragStartPositions) {
                // Multi-select drag: compute delta from primary element's start pos and apply to all
                const myStart = multiDragStartPositions[elementType + ':' + elementId];
                if (myStart) {
                    const dx = newX - myStart.x;
                    const dy = newY - myStart.y;
                    selectedElements.forEach(key => {
                        if (key === elementType + ':' + elementId) return; // handled below
                        const el = getElementForKey(key);
                        const start = multiDragStartPositions[key];
                        if (el && start) {
                            const elX = Math.max(0, start.x + dx);
                            const elY = Math.max(0, start.y + dy);
                            el.style.left = elX + 'px';
                            el.style.top = elY + 'px';
                            // Update data and lines for each co-dragged element
                            const [elType, elId] = key.split(':');
                            updateConnectedLines(elId, elType);
                            // Update data position
                            updateElementPosition(elId, elType, elX, elY);
                        }
                    });
                }
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
            multiDragStartPositions = null;
            
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


// ============================================================================
// PHASE 7A: CANVAS EVENT ORCHESTRATION - Drag-drop, pan, zoom, line manipulation
// ============================================================================
// WARNING: This is a complex, high-risk function with many nested event listeners.
// It manages step dragging, canvas pan/zoom, and connection line manipulation.
// Changes here can affect multiple user interactions simultaneously.
// ============================================================================

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
        // Convert screen coordinates to grid coordinates accounting for zoom
        // Note: pan is handled by canvas transform, not by adjusting coordinates
        let x = (e.clientX - rect.left - dragOffsetX) / zoomLevel;
        let y = (e.clientY - rect.top - dragOffsetY) / zoomLevel;
        
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
    let isMarqueeSelecting = false;
    let marqueeStartX = 0;
    let marqueeStartY = 0;
    let marqueeEl = null;

    container.addEventListener('mousedown', (e) => {
        if (e.button === 0 && (e.target === canvas || e.target.closest('[data-transition-connection-line]'))) {
            // Don't pan/marquee if clicking on steps, frames, or hitboxes
            if (e.target.closest('[data-step-uuid]') || 
                e.target.closest('[data-transition-frame]') ||
                e.target.closest('[data-case-arrow-hitbox]')) {
                return;
            }

            if (e.ctrlKey || e.metaKey) {
                // Ctrl+drag: start marquee selection
                isMarqueeSelecting = true;
                const containerRect = container.getBoundingClientRect();
                marqueeStartX = e.clientX - containerRect.left;
                marqueeStartY = e.clientY - containerRect.top;

                marqueeEl = document.createElement('div');
                marqueeEl.style.cssText = `
                    position: absolute;
                    border: 1px dashed #ffffff;
                    background: rgba(255,255,255,0.05);
                    pointer-events: none;
                    z-index: 1000;
                    left: ${marqueeStartX}px;
                    top: ${marqueeStartY}px;
                    width: 0;
                    height: 0;
                `;
                container.appendChild(marqueeEl);
                e.preventDefault();
            } else {
                isPanning = true;
                panStartX = e.clientX + panX;
                panStartY = e.clientY + panY;
                container.style.cursor = 'grabbing';
                e.preventDefault();
            }
        }
    });
    
    document.addEventListener('mousemove', (e) => {
        if (isPanning && !draggedConnectionHitbox) {
            panX = panStartX - e.clientX;
            panY = panStartY - e.clientY;
            clampPan();
            updateTransform();
        }

        if (isMarqueeSelecting && marqueeEl) {
            const containerRect = container.getBoundingClientRect();
            const curX = e.clientX - containerRect.left;
            const curY = e.clientY - containerRect.top;
            const x = Math.min(curX, marqueeStartX);
            const y = Math.min(curY, marqueeStartY);
            const w = Math.abs(curX - marqueeStartX);
            const h = Math.abs(curY - marqueeStartY);
            marqueeEl.style.left = x + 'px';
            marqueeEl.style.top = y + 'px';
            marqueeEl.style.width = w + 'px';
            marqueeEl.style.height = h + 'px';
        }
    });
    
    document.addEventListener('mouseup', (e) => {
        if (isPanning) {
            isPanning = false;
            container.style.cursor = 'auto';
        }

        if (isMarqueeSelecting && marqueeEl) {
            isMarqueeSelecting = false;

            // Marquee bounds in screen space
            const containerRect = container.getBoundingClientRect();
            const mx1 = containerRect.left + parseFloat(marqueeEl.style.left);
            const my1 = containerRect.top + parseFloat(marqueeEl.style.top);
            const mx2 = mx1 + parseFloat(marqueeEl.style.width);
            const my2 = my1 + parseFloat(marqueeEl.style.height);

            const intersects = (el) => {
                const r = el.getBoundingClientRect();
                return r.left < mx2 && r.right > mx1 && r.top < my2 && r.bottom > my1;
            };

            canvas.querySelectorAll('[data-step-uuid]').forEach(el => {
                if (intersects(el)) addToSelection(el.getAttribute('data-step-uuid'), 'step', el);
            });
            canvas.querySelectorAll('[data-node-id]').forEach(el => {
                if (intersects(el)) addToSelection(el.getAttribute('data-node-id'), 'node', el);
            });
            canvas.querySelectorAll('[data-transition-frame]').forEach(el => {
                if (intersects(el)) addToSelection(el.getAttribute('data-transition-frame'), 'frame', el);
            });

            marqueeEl.remove();
            marqueeEl = null;

            // Suppress the canvas click that fires after mouseup
            const suppressClick = (e) => { e.stopPropagation(); canvas.removeEventListener('click', suppressClick, true); };
            canvas.addEventListener('click', suppressClick, true);
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
                    const lineUUID = generateId();
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
                    const lineUUID = generateId();
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
        if (!canvas) {
            return;
        }
        
        e.stopPropagation();
        isDrawingFromTransition = true;
        fromTransitionId = triangle.getAttribute('data-transition-arrow');
        
        const canvasRect = canvas.getBoundingClientRect();
        
        // Get the condition box element to calculate start point consistently with finished line
        const conditionId = triangle.getAttribute('data-transition-arrow');
        const conditionBox = canvas.querySelector(`[data-condition-id="${conditionId}"]`);
        if (!conditionBox) return;
        
        // Find the frame and wrapper to calculate absolute position
        const wrapper = conditionBox.parentElement;
        const frame = wrapper?.closest('[data-transition-frame]');
        if (!frame) return;
        
        const frameX = parseInt(frame.style.left);
        const frameY = parseInt(frame.style.top);
        const wrapperOffsetX = wrapper ? wrapper.offsetLeft : 0;
        const wrapperOffsetY = wrapper ? wrapper.offsetTop : 0;
        const conditionOffsetX = conditionBox.offsetLeft;
        const conditionOffsetY = conditionBox.offsetTop;
        const conditionWidth = conditionBox.offsetWidth;
        const conditionHeight = conditionBox.offsetHeight;
        
        // Calculate start point using same logic as finished line
        const frameData = currentTransitionFrames.find(f => f.id === frame.getAttribute('data-transition-frame'));
        let screenStartX, screenStartY;
        
        // Use same calculation for both layouts: always include wrapperOffsetX
        const conditionAbsX = frameX + wrapperOffsetX + conditionOffsetX;
        
        if (frameData && frameData.verticalLayout) {
            const conditionAbsY = frameY + wrapperOffsetY + conditionOffsetY;
            screenStartX = conditionAbsX + conditionWidth + 10;
            screenStartY = conditionAbsY + 13;
        } else {
            const conditionAbsY = frameY + conditionOffsetY;
            screenStartX = conditionAbsX + conditionWidth / 2 + 2;
            screenStartY = conditionAbsY + conditionHeight + 40;
        }
        
        // Use canvas space coordinates directly (same as finished line), no zoom/pan conversion
        transitionStartX = screenStartX;
        transitionStartY = screenStartY;
        
        const handleTransitionMouseMove = (e) => {
            if (!isDrawingFromTransition) return;
            
            const canvasRect = canvas.getBoundingClientRect();
            const screenCurrentX = e.clientX - canvasRect.left;
            const screenCurrentY = e.clientY - canvasRect.top;
            // Convert to canvas space by dividing by zoom (SVG is scaled by zoomLevel)
            const currentX = screenCurrentX / zoomLevel;
            const currentY = screenCurrentY / zoomLevel;
            
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
            // Use canvas space coordinates (same as start point) for distance check
            const canvasEndX = screenEndX;
            const canvasEndY = screenEndY;
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
            
            const dragDistance = Math.hypot(canvasEndX - transitionStartX, canvasEndY - transitionStartY);
            
            if (stepElement && dragDistance >= MIN_DRAG_DISTANCE) {
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
                    const lineUUID = generateId();
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
            } else if (nodeElement && Math.hypot(canvasEndX - transitionStartX, canvasEndY - transitionStartY) >= MIN_DRAG_DISTANCE) {
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
                    const lineUUID = generateId();
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
            } else if (Math.hypot(canvasEndX - transitionStartX, canvasEndY - transitionStartY) >= MIN_DRAG_DISTANCE) {
                // Dropped on empty space - create a new node
                if (transition) {
                    const newNodeId = generateNodeId();
                    
                    // Snap to 15px grid in canvas space
                    const snappedX = Math.round((canvasEndX / zoomLevel) / 15) * 15;
                    const snappedY = Math.round((canvasEndY / zoomLevel) / 15) * 15;
                    
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
            clearSelection();
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

    // ── CONTEXT MENU ─────────────────────────────────────────────────────────
    const ctxMenu = document.createElement('div');
    ctxMenu.id = 'canvasContextMenu';
    ctxMenu.style.cssText = `
        display: none;
        position: fixed;
        z-index: 9999;
        background: var(--bg-panel2);
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        padding: 4px 0;
        min-width: 150px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        font-size: 13px;
    `;
    document.body.appendChild(ctxMenu);

    function ctxItem(label, onClick, danger = false) {
        const item = document.createElement('div');
        item.textContent = label;
        item.style.cssText = `
            padding: 7px 16px;
            cursor: pointer;
            color: ${danger ? '#ff6b6b' : 'var(--text-primary)'};
            user-select: none;
        `;
        item.addEventListener('mouseenter', () => item.style.background = 'var(--bg-panel3)');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => { hideCtxMenu(); onClick(); });
        return item;
    }

    function hideCtxMenu() {
        ctxMenu.style.display = 'none';
        ctxMenu.innerHTML = '';
    }

    function showCtxMenu(x, y, items) {
        ctxMenu.innerHTML = '';
        items.forEach(item => ctxMenu.appendChild(item));
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';
        ctxMenu.style.display = 'block';
        // Nudge back into viewport if needed
        const rect = ctxMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) ctxMenu.style.left = (x - rect.width) + 'px';
        if (rect.bottom > window.innerHeight) ctxMenu.style.top = (y - rect.height) + 'px';
    }

    document.addEventListener('click', hideCtxMenu);
    document.addEventListener('contextmenu', hideCtxMenu);

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const canvasRect = canvas.getBoundingClientRect();
        const canvasX = (e.clientX - canvasRect.left) / zoomLevel;
        const canvasY = (e.clientY - canvasRect.top) / zoomLevel;
        const gridX = Math.round(canvasX / 30);
        const gridY = Math.round(canvasY / 30);

        const stepEl = e.target.closest('[data-step-uuid]');
        const nodeEl = e.target.closest('[data-node-id]');
        const frameEl = e.target.closest('[data-transition-frame]');

        const items = [];

        if (stepEl) {
            const stepId = stepEl.getAttribute('data-step-uuid');
            if (!selectedElements.has('step:' + stepId)) { clearSelection(); addToSelection(stepId, 'step', stepEl); }
            items.push(ctxItem('Copy', () => copySelection()));
            if (selectedElements.size > 1) {
                items.push(ctxItem('Delete Selected', () => deleteSelection(), true));
            } else {
                items.push(ctxItem('Delete', () => deleteElement(stepId, 'step'), true));
            }
        } else if (nodeEl) {
            const nodeId = nodeEl.getAttribute('data-node-id');
            if (!selectedElements.has('node:' + nodeId)) { clearSelection(); addToSelection(nodeId, 'node', nodeEl); }
            items.push(ctxItem('Copy', () => copySelection()));
            if (selectedElements.size > 1) {
                items.push(ctxItem('Delete Selected', () => deleteSelection(), true));
            } else {
                items.push(ctxItem('Delete', () => deleteElement(nodeId, 'node'), true));
            }
        } else if (frameEl) {
            const frameId = frameEl.getAttribute('data-transition-frame');
            if (!selectedElements.has('frame:' + frameId)) { clearSelection(); addToSelection(frameId, 'frame', frameEl); }
            items.push(ctxItem('Copy', () => copySelection()));
        } else {
            items.push(ctxItem('Add Node', () => placeNode(canvasX, canvasY)));
            items.push(ctxItem('Paste', () => pasteClipboard(canvasX, canvasY)));
        }

        showCtxMenu(e.clientX, e.clientY, items);
    });
}

        // ============================================================================
        // CANVAS UI CONTROLS - Zoom, Panel Toggle
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

function updateZoomDisplay() {
    const zoomDisplay = document.getElementById('zoomDisplay');
    if (zoomDisplay) {
        zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
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
function deleteSelection() {
    const toDelete = [...selectedElements].filter(key => {
        const [type] = key.split(':');
        return type === 'step' || type === 'node';
    });
    if (toDelete.length === 0) return;

    const msg = `Delete ${toDelete.length} selected item${toDelete.length > 1 ? 's' : ''}? All connections will be removed. This cannot be undone.`;
    showDeleteConfirm(msg, () => {
        toDelete.forEach(key => {
            const [type, id] = key.split(':');
            deleteElement(id, type, { skipConfirm: true });
        });
        clearSelection();
    });
}

function copySelection() {
    const steps = [];
    const nodes = [];

    selectedElements.forEach(key => {
        const [type, id] = key.split(':');
        if (type === 'step') {
            const step = currentSteps.find(s => s.id === id);
            if (step) {
                const frame = currentTransitionFrames.find(f => f.parentStepId === id);
                const transitions = frame
                    ? frame.conditions.map(cid => currentTransitions.find(t => t.id === cid)).filter(Boolean)
                    : [];
                steps.push({
                    step: JSON.parse(JSON.stringify(step)),
                    frame: frame ? JSON.parse(JSON.stringify(frame)) : null,
                    transitions: JSON.parse(JSON.stringify(transitions))
                });
            }
        } else if (type === 'node') {
            const node = currentNodes.find(n => n.id === id);
            if (node) nodes.push(JSON.parse(JSON.stringify(node)));
        }
    });

    if (steps.length === 0 && nodes.length === 0) return;

    const clipboard = { steps, nodes, copiedAt: Date.now() };
    const json = JSON.stringify(clipboard, null, 2);
    localStorage.setItem('kore-clipboard', json);
    try { navigator.clipboard.writeText(json); } catch(e) {}
}

function pasteClipboard(canvasX, canvasY) {
    const raw = localStorage.getItem('kore-clipboard');
    if (!raw) return;
    let clipboard;
    try { clipboard = JSON.parse(raw); } catch(e) { return; }

    const { steps = [], nodes = [] } = clipboard;
    if (steps.length === 0 && nodes.length === 0) return;

    const pastedBegin = steps.find(s => s.step.type === 'Begin');
    const existingBegin = pastedBegin ? currentSteps.find(s => s.type === 'Begin') : null;

    if (pastedBegin && existingBegin) {
        showConfirm(
            'Paste BEGIN Step',
            'This workflow already has a BEGIN step. Pasting will overwrite it. Continue?',
            () => {
                deleteElement(existingBegin.id, 'step', { skipConfirm: true });
                executePaste(steps, nodes, canvasX, canvasY);
            },
            'OK'
        );
    } else {
        executePaste(steps, nodes, canvasX, canvasY);
    }
}

function executePaste(steps, nodes, canvasX, canvasY) {
    // Find anchor: lowest Y, then lowest X
    const allPositions = [
        ...steps.map(s => s.step.position),
        ...nodes.map(n => n.position)
    ].map(p => { const [x, y] = p.split(',').map(Number); return { x, y }; });

    const anchor = allPositions.reduce((a, b) =>
        (b.y < a.y || (b.y === a.y && b.x < a.x)) ? b : a
    );

    const pasteGridX = canvasX / 30;
    const pasteGridY = canvasY / 30;
    const dx = pasteGridX - anchor.x;
    const dy = pasteGridY - anchor.y;

    // Build ID remap: old -> new for steps and nodes
    const idMap = {};
    steps.forEach(({ step }) => { idMap[step.id] = generateId(); });
    nodes.forEach(node => { idMap[node.id] = generateNodeId(); });

    const pastedFrameIds = [];
    steps.forEach(({ step, frame, transitions }) => {
        const newStep = JSON.parse(JSON.stringify(step));
        newStep.id = idMap[step.id];

        const [sx, sy] = step.position.split(',').map(Number);
        newStep.position = `${Math.round(sx + dx)},${Math.round(sy + dy)}`;

        // Remap transition.cases targets within copied group
        if (newStep.transition && newStep.transition.cases) {
            newStep.transition.cases.forEach(c => {
                if (c.targetSteps) c.targetSteps = c.targetSteps.filter(id => idMap[id]).map(id => idMap[id]);
                if (c.targetNodes) c.targetNodes = c.targetNodes.filter(id => idMap[id]).map(id => idMap[id]);
            });
            const [tx, ty] = (newStep.transition.position || step.position).split(',').map(Number);
            newStep.transition.position = `${Math.round(tx + dx)},${Math.round(ty + dy)}`;
        }

        currentSteps.push(newStep);

        if (frame) {
            const newFrame = JSON.parse(JSON.stringify(frame));
            newFrame.id = generateId('frame');
            newFrame.parentStepId = newStep.id;
            newFrame.attachedToStepId = newStep.id;
            const [fx, fy] = frame.position.split(',').map(Number);
            newFrame.position = `${Math.round(fx + dx)},${Math.round(fy + dy)}`;

            // Remap condition IDs and push transition entries
            const condIdMap = {};
            newFrame.conditions = frame.conditions.map(cid => {
                const newCid = generateId();
                condIdMap[cid] = newCid;
                return newCid;
            });

            // Push remapped transition entries
            transitions.forEach(t => {
                const newT = JSON.parse(JSON.stringify(t));
                newT.id = condIdMap[t.id] || generateId();
                if (newT.targetSteps) newT.targetSteps = newT.targetSteps.filter(id => idMap[id]).map(id => idMap[id]);
                if (newT.targetNodes) newT.targetNodes = newT.targetNodes.filter(id => idMap[id]).map(id => idMap[id]);
                currentTransitions.push(newT);
            });

            currentTransitionFrames.push(newFrame);
            pastedFrameIds.push({ id: newFrame.id, vertical: newFrame.verticalLayout });
        }

        renderStep(newStep);
    });

    nodes.forEach(node => {
        const newNode = JSON.parse(JSON.stringify(node));
        newNode.id = idMap[node.id];
        const [nx, ny] = node.position.split(',').map(Number);
        newNode.position = `${Math.round(nx + dx)},${Math.round(ny + dy)}`;
        newNode.targetSteps = (newNode.targetSteps || []).filter(id => idMap[id]).map(id => idMap[id]);
        newNode.targetNodes = (newNode.targetNodes || []).filter(id => idMap[id]).map(id => idMap[id]);
        currentNodes.push(newNode);
        renderNode(newNode);
    });

    // Render all frames after all steps and nodes are in the DOM
    // so drawConnectionLine can find their target elements
    pastedFrameIds.forEach(({ id, vertical }) => renderTransitionFrame(id, vertical));

    updateSaveButtonState();
    updatePreview();

    // Defer connection line rendering until DOM is ready
    const pastedFrames = pastedFrameIds.map(({ id }) => currentTransitionFrames.find(f => f.id === id)).filter(Boolean);
    setTimeout(() => {
        requestAnimationFrame(() => {
            const canvas = document.getElementById('workflowCanvas');
            pastedFrames.forEach(frame => {
                frame.conditions.forEach(conditionId => {
                    const transition = currentTransitions.find(t => t.id === conditionId);
                    if (transition) {
                        if (transition.targetSteps) {
                            transition.targetSteps.forEach(targetStepId => {
                                const lineUUID = generateId();
                                const caseLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                                caseLine.setAttribute('data-transition-connection-line', lineUUID);
                                caseLine.setAttribute('data-from-transition', conditionId);
                                caseLine.setAttribute('data-to-step', targetStepId);
                                caseLine.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
                                canvas.appendChild(caseLine);
                                const caseColor = getTransitionTheme(transition.type).color;
                                drawConnectionLine(caseLine, conditionId, 'case', targetStepId, 'step', canvas, caseColor, false, frame);
                            });
                        }
                        if (transition.targetNodes) {
                            transition.targetNodes.forEach(targetNodeId => {
                                const lineUUID = generateId();
                                const caseLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                                caseLine.setAttribute('data-transition-connection-line', lineUUID);
                                caseLine.setAttribute('data-from-transition', conditionId);
                                caseLine.setAttribute('data-to-node', targetNodeId);
                                caseLine.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
                                canvas.appendChild(caseLine);
                                const caseColor = getTransitionTheme(transition.type).color;
                                drawConnectionLine(caseLine, conditionId, 'case', targetNodeId, 'node', canvas, caseColor, false, frame);
                            });
                        }
                    }
                });
            });
        });
    }, 300);
}

/**
 * Update the data model position for an element during multi-select drag.
 * Steps handle their own position in wf-render.js mousemove.
 * This handles nodes and frames.
 */
function updateElementPosition(id, type, px, py) {
    const gridX = px / 30;
    const gridY = py / 30;
    if (type === 'node') {
        const node = currentNodes.find(n => n.id === id);
        if (node) node.position = `${gridX},${gridY}`;
    } else if (type === 'frame') {
        const frame = currentTransitionFrames.find(f => f.id === id);
        if (frame) {
            frame.position = `${gridX},${gridY}`;
            // Sync to owning step's transition position if detached
            const owningStep = currentSteps.find(s => s.transition && currentTransitionFrames.find(f2 => f2.id === id && f2.parentStepId === s.id));
            if (owningStep && owningStep.transition) {
                owningStep.transition.position = `${gridX},${gridY}`;
            }
        }
    }
}
window.createCurvedPath = createCurvedPath;
window.createStepOnCanvas = createStepOnCanvas;
window.detectDropTarget = detectDropTarget;
window.drawConnectionLine = drawConnectionLine;
window.getClosestSideToFrame = getClosestSideToFrame;
window.makeElementDraggable = makeElementDraggable;
window.offsetPointFromEdge = offsetPointFromEdge;
window.panX = panX;
window.panY = panY;
window.placeNode = placeNode;
window.resetZoom = resetZoom;
window.setupCanvasDragDrop = setupCanvasDragDrop;
window.toggleStepTypesPanel = toggleStepTypesPanel;
window.toggleToolsPanel = toggleToolsPanel;
window.updateConnectedLines = updateConnectedLines;
window.updateConnectionPointVisibility = updateConnectionPointVisibility;
window.updateTransitionLine = updateTransitionLine;
window.updateZoomDisplay = updateZoomDisplay;
window.zoomIn = zoomIn;
window.zoomLevel = zoomLevel;
window.zoomOut = zoomOut;
window.selectedElements = selectedElements;
window.addToSelection = addToSelection;
window.clearSelection = clearSelection;
window.getElementForKey = getElementForKey;
window.updateElementPosition = updateElementPosition;
window.copySelection = copySelection;
window.pasteClipboard = pasteClipboard;
window.deleteSelection = deleteSelection;