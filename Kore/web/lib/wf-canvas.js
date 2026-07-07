/**
 * wf-canvas.js
 *
 * Canvas interaction management for workflow editor
 * - Drawing and rendering connection lines
 * - Canvas drag-drop for step creation
 * - Pan and zoom functionality
 * - Node and element dragging
 * - Connection detection and visibility
 *
 * COORDINATE SYSTEM
 * -----------------
 * All internal logic uses CSS pixel space (logical pixels, zoom-agnostic).
 * Element positions are stored and applied as CSS left/top in logical pixels.
 * Grid coordinates are stored as gridX/gridY (1 grid unit = 30 logical px).
 *
 * Two boundary functions handle all coordinate conversions:
 *
 *   clientToCanvas(clientX, clientY, canvas)
 *     Mouse event coords → CSS pixel position on the canvas.
 *     This is the ONLY place getBoundingClientRect is used for positioning.
 *     Accounts for browser zoom (via canvasRect) and canvas zoom/pan.
 *
 *   gridToPixel(gx, gy)
 *     Grid units → CSS pixels. Used at render time only.
 *
 * Nothing else in this file (or wf-render.js / wf-core.js) should call
 * getBoundingClientRect for positional math — only for the clientToCanvas
 * entry point and for UI-overlay positioning (context menus, fixed elements).
 */

import '/lib/base.js';

// ============================================================================
// CANVAS CONFIGURATION
// ============================================================================
const CANVAS_SIZE = 5000; // Total canvas dimensions in CSS pixels
const GU = 30;            // One grid unit in CSS pixels
const HG = GU / 2;       // Half grid unit in CSS pixels
const BORDER = Math.max(2, Math.round(GU / 15)); // Step border width in CSS pixels
const I_CONT_H = GU - BORDER * 2; // Inner content height (GU minus borders)
const MIN_DRAG_DISTANCE = 20; // Minimum pixels to drag before considering it a drag operation

// ============================================================================
// PAN AND ZOOM STATE
// ============================================================================
let panX = 0;
let panY = 0;
let zoomLevel = 1;

// ============================================================================
// COORDINATE CONVERSION — the only two functions that touch zoom/pan math
// ============================================================================

/**
 * Convert mouse event coordinates to CSS pixel position on the canvas.
 * This is the single entry point for all mouse input.
 * Handles both browser zoom (via getBoundingClientRect) and canvas zoom/pan.
 *
 * @param {number} clientX - e.clientX from a mouse event
 * @param {number} clientY - e.clientY from a mouse event
 * @param {HTMLElement} canvas - the workflowCanvas element
 * @returns {{ x: number, y: number }} position in CSS pixel space
 */
function clientToCanvas(clientX, clientY, canvas) {
    const rect = canvas.getBoundingClientRect();
    // rect.left/top are in physical screen pixels (includes browser zoom).
    // Subtracting gives us physical pixels relative to the canvas corner.
    // Dividing by zoomLevel converts from scaled canvas pixels to logical CSS pixels.
    // Adding pan restores the scroll offset.
    return {
        x: (clientX - rect.left) / zoomLevel + panX,
        y: (clientY - rect.top) / zoomLevel + panY
    };
}

/**
 * Convert grid coordinates to CSS pixel position.
 * 1 grid unit = 30 CSS pixels at all zoom levels.
 *
 * @param {number} gx - grid X coordinate
 * @param {number} gy - grid Y coordinate
 * @returns {{ x: number, y: number }} position in CSS pixel space
 */
function gridToPixel(gx, gy) {
    return { x: gx * GU, y: gy * GU };
}

/**
 * Convert CSS pixel position to grid coordinates.
 *
 * @param {number} px - CSS pixel X
 * @param {number} py - CSS pixel Y
 * @returns {{ gx: number, gy: number }}
 */
function pixelToGrid(px, py) {
    return { gx: px / GU, gy: py / GU };
}

/**
 * Get the CSS pixel X center of a condition box within its step element.
 * Uses offsetLeft chain — pure DOM layout, no screen coordinates.
 *
 * @param {HTMLElement} conditionBox - the [data-condition-id] element
 * @param {HTMLElement} stepElement  - the parent [data-step-uuid] element
 * @returns {number} CSS pixel X of the condition box center
 */
function conditionBoxCenterX(conditionBox, stepElement) {
    // Case boxes are exactly GU wide, laid out sequentially with no gap.
    // Strip left edge = step left border + icon column (I_CONT_H) + content margin (BORDER)
    // Case box i center = stripLeft + (i * GU) + HG
    const strip = conditionBox.closest('[data-case-strip]');
    const wrapper = conditionBox.parentElement;
    const index = wrapper && strip ? Array.from(strip.children).indexOf(wrapper) : 0;

    const STRIP_LEFT = BORDER + I_CONT_H + BORDER; // left border + icon + content margin
    const BOX_WIDTH = GU;
    return (parseInt(stepElement.style.left) || 0) + STRIP_LEFT + (index * BOX_WIDTH) + (BOX_WIDTH / 2);
}

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
 */
function createCurvedPath(x1, y1, exitSide, x2, y2, enterSide) {
    const distance = Math.hypot(x2 - x1, y2 - y1);

    let controlDistance = Math.min(50, distance * 0.3);
    controlDistance = Math.max(HG, controlDistance);

    let ctrl1_x = x1, ctrl1_y = y1;
    switch(exitSide) {
        case 'top': ctrl1_y -= controlDistance; break;
        case 'bottom': ctrl1_y += controlDistance; break;
        case 'left': ctrl1_x -= controlDistance; break;
        case 'right': ctrl1_x += controlDistance; break;
    }

    let ctrl2_x = x2, ctrl2_y = y2;
    switch(enterSide) {
        case 'top': ctrl2_y -= controlDistance; break;
        case 'bottom': ctrl2_y += controlDistance; break;
        case 'left': ctrl2_x -= controlDistance; break;
        case 'right': ctrl2_x += controlDistance; break;
    }

    return `M ${x1} ${y1} C ${ctrl1_x} ${ctrl1_y} ${ctrl2_x} ${ctrl2_y} ${x2} ${y2}`;
}

/**
 * Create an orthogonal (Manhattan-style) SVG path with rounded 90 degree corners.
 * All coordinates are in CSS pixels.
 * @param {number} sx - Source X
 * @param {number} sy - Source Y
 * @param {number} ex - End point X (offset for arrow)
 * @param {number} ey - End point Y (offset for arrow)
 * @param {string} entryDir - Entry direction into target ('top'|'bottom'|'left'|'right')
 * @param {number} surfaceX - Actual target surface X (for turn geometry)
 * @param {number} surfaceY - Actual target surface Y (for turn geometry)
 * @param {string} exitDir  - Exit direction from source (default 'bottom')
 */
function createOrthogonalPath(sx, sy, ex, ey, entryDir, surfaceX, surfaceY, exitDir = 'bottom') {
    const R = 6;
    const HALF = HG;
    const tx = surfaceX !== undefined ? surfaceX : ex;
    const ty = surfaceY !== undefined ? surfaceY : ey;

    function snap(v) {
        return Math.round(v / HALF) * HALF;
    }

    function corner(cx, cy, from, to) {
        const approaches = {
            'top':    { x: cx,     y: cy + R },
            'bottom': { x: cx,     y: cy - R },
            'left':   { x: cx + R, y: cy     },
            'right':  { x: cx - R, y: cy     }
        };
        const departures = {
            'top':    { x: cx,     y: cy - R },
            'bottom': { x: cx,     y: cy + R },
            'left':   { x: cx - R, y: cy     },
            'right':  { x: cx + R, y: cy     }
        };
        const a = approaches[from];
        const d = departures[to];
        return `L ${a.x} ${a.y} Q ${cx} ${cy} ${d.x} ${d.y}`;
    }

    // Vertical exits (top/bottom): turn axis is horizontal
    if (exitDir === 'bottom' || exitDir === 'top') {
        const toRight = ex > sx;
        const horizDir = toRight ? 'right' : 'left';
        // For top exit, source moves upward first — flip the R offset direction
        const exitSign = exitDir === 'bottom' ? 1 : -1;

        if (entryDir === 'bottom') {
            // For top exit into bottom entry: if nearly vertical, straight line up
            if (exitDir === 'top' && Math.abs(tx - sx) < R) {
                return `M ${sx} ${sy} L ${ex} ${ey}`;
            }
            // U-shape: exit vertically, turn horizontal, turn back to enter bottom
            const rawTurnY = exitDir === 'bottom'
                ? Math.max(sy + R, ty + R)
                : Math.min(sy - R, ty + R);
            const turnY = exitDir === 'bottom'
                ? Math.ceil(rawTurnY / HALF) * HALF
                : Math.floor(rawTurnY / HALF) * HALF;
            const c1 = corner(sx, turnY, exitDir, horizDir);
            const c2 = corner(tx, turnY, horizDir, 'top');
            return `M ${sx} ${sy} ${c1} L ${tx - (toRight ? R : -R)} ${turnY} ${c2} L ${ex} ${ey}`;

        } else if (entryDir === 'top') {
            const rawTurnY = exitDir === 'bottom'
                ? Math.max(sy + R, ty - HG)
                : Math.min(sy - R, ty - HG);
            const turnY = snap(rawTurnY);
            if (Math.abs(tx - sx) < R) {
                return `M ${sx} ${sy} L ${ex} ${ey}`;
            }
            const c1 = corner(sx, turnY, exitDir, horizDir);
            const c2 = corner(tx, turnY, horizDir, 'bottom');
            return `M ${sx} ${sy} ${c1} L ${tx - (toRight ? R : -R)} ${turnY} ${c2} L ${ex} ${ey}`;

        } else {
            // Side entry (left or right)
            const turnY = snap(ty);
            const minTurnY = exitDir === 'bottom' ? sy + R * 2 : sy - R * 2;
            if ((exitDir === 'bottom' && turnY < minTurnY) || (exitDir === 'top' && turnY > minTurnY)) {
                const dropY = snap(minTurnY);
                const c1 = corner(sx, dropY, exitDir, horizDir);
                return `M ${sx} ${sy} ${c1} L ${ex} ${ey}`;
            }
            const c1 = corner(sx, turnY, exitDir, horizDir);
            return `M ${sx} ${sy} ${c1} L ${ex} ${ey}`;
        }

    // Horizontal exits (left/right): always a straight line or simple L-shape into a side entry
    } else {
        const toDown = ey > sy;
        const vertDir = toDown ? 'bottom' : 'top';

        // If target is at same Y level, straight line
        if (Math.abs(ey - sy) < R) {
            return `M ${sx} ${sy} L ${ex} ${ey}`;
        }

        // Simple L-shape: go horizontal to target's X level, then turn vertical to side entry
        const c1 = corner(ex, sy, exitDir, vertDir);
        return `M ${sx} ${sy} ${c1} L ${ex} ${ey}`;
    }
}

/**
 * Get the closest side of a step element to a frame element.
 * Uses style.left/top — no getBoundingClientRect.
 */
function getClosestSideToFrame(stepElement, frameElement, canvas) {
    const stepX = parseInt(stepElement.style.left);
    const stepY = parseInt(stepElement.style.top);
    const stepW = parseInt(stepElement.style.width);
    const stepH = parseInt(stepElement.style.height);

    const frameX = parseInt(frameElement.style.left);
    const frameY = parseInt(frameElement.style.top);
    const frameW = parseInt(frameElement.style.width);
    const frameH = parseInt(frameElement.style.height);

    const stepCenterX = stepX + stepW / 2;
    const stepCenterY = stepY + stepH / 2;
    const frameCenterX = frameX + frameW / 2;
    const frameCenterY = frameY + frameH / 2;

    const deltaX = frameCenterX - stepCenterX;
    const deltaY = frameCenterY - stepCenterY;

    if (Math.abs(deltaY) > Math.abs(deltaX)) {
        return deltaY > 0 ? 'bottom' : 'top';
    } else {
        return deltaX > 0 ? 'right' : 'left';
    }
}

// ============================================================================
// PHASE 2: DETECTION & VISIBILITY FUNCTIONS
// ============================================================================

/**
 * Detect which step or node a mouse position is over, with a catch area margin.
 * Takes raw clientX/Y — this is one of the two legitimate uses of screen coords,
 * because getBoundingClientRect and clientX/Y are in the same physical space so
 * the comparison is internally consistent.
 */
function detectDropTarget(canvas, clientX, clientY) {
    let droppedOnStep = null;
    let droppedOnNode = null;

    // Scale catch area by zoomLevel so it represents the same logical distance
    // regardless of canvas zoom, while staying in screen space for the comparison.
    const CATCH_AREA = 29 * zoomLevel;

    canvas.querySelectorAll('[data-step-uuid]').forEach(stepElement => {
        const stepId = stepElement.getAttribute('data-step-uuid');
        const step = currentSteps.find(s => s.id === stepId);
        if (step && step.type === 'Begin') return;

        const rect = stepElement.getBoundingClientRect();
        if (clientX >= rect.left - CATCH_AREA && clientX <= rect.right + CATCH_AREA &&
            clientY >= rect.top - CATCH_AREA && clientY <= rect.bottom + CATCH_AREA) {
            droppedOnStep = stepId;
        }
    });

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
 */
function updateConnectionPointVisibility(stepId) {
    const step = currentSteps.find(s => s.id === stepId);
    if (!step || !step.transition || !step.transition.cases || step.transition.cases.length === 0) {
        const stepElement = document.querySelector(`[data-step-uuid="${stepId}"]`);
        if (stepElement) {
            stepElement.querySelectorAll('[data-connection-point]').forEach(circle => {
                circle.style.display = 'block';
            });
        }
        return;
    }

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
 * Draw a connection line from a step to a transition frame.
 * All positions read from style.left/top — no getBoundingClientRect.
 */
function updateTransitionLine(line, frameUUID, fromStepId, fromConnectionPoint, canvasElement, lineColor) {
    const frameElement = canvasElement.querySelector(`[data-transition-frame="${frameUUID}"]`);
    const stepElement = canvasElement.querySelector(`[data-step-uuid="${fromStepId}"]`);

    if (!lineColor) {
        const stepData = currentSteps.find(s => s.id === fromStepId);
        lineColor = stepData ? getStepTypeTheme(stepData.type).color : '#3a7a99';
    }

    if (!frameElement || !stepElement) return;

    const stepX = parseInt(stepElement.style.left);
    const stepY = parseInt(stepElement.style.top);
    const stepWidth = parseInt(stepElement.style.width);
    const stepHeight = parseInt(stepElement.style.height);

    let fromX = stepX + stepWidth / 2;
    let fromY = stepY + stepHeight / 2;

    if (fromConnectionPoint === 'top') { fromY = stepY; }
    else if (fromConnectionPoint === 'bottom') { fromY = stepY + stepHeight; }
    else if (fromConnectionPoint === 'left') { fromX = stepX; }
    else if (fromConnectionPoint === 'right') { fromX = stepX + stepWidth; }

    const frameX = parseInt(frameElement.style.left);
    const frameY = parseInt(frameElement.style.top);
    const frameWidth = parseInt(frameElement.style.width);
    const frameHeight = parseInt(frameElement.style.height);

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
        if (distance < minDistance) { minDistance = distance; nearestSide = side; }
    });

    const offsetEnd = offsetPointFromEdge(nearestSide.x, nearestSide.y, nearestSide.name, 10);
    const path = createCurvedPath(fromX, fromY, fromConnectionPoint, offsetEnd.x, offsetEnd.y, nearestSide.name);
    line.innerHTML = `<defs><marker id="transitionArrowhead-${frameUUID}" markerWidth="10" markerHeight="10" refX="0" refY="3" orient="auto"><polygon points="0 0, 6 3, 0 6" fill="${lineColor}"/></marker></defs><path d="${path}" stroke="${lineColor}" stroke-width="2" fill="none" marker-end="url(#transitionArrowhead-${frameUUID})"/>`;
}

/**
 * Unified line drawing for all connection types.
 * All positions read from style.left/top (CSS pixels) — no getBoundingClientRect.
 * Case startX uses conditionBoxCenterX() which walks offsetLeft — zoom-agnostic.
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

    const sourceX = parseInt(sourceEl.style.left);
    const sourceY = parseInt(sourceEl.style.top);
    const sourceWidth = parseInt(sourceEl.style.width);
    const sourceHeight = parseInt(sourceEl.style.height);

    const targetX = parseInt(targetEl.style.left);
    const targetY = parseInt(targetEl.style.top);
    const targetWidth = parseInt(targetEl.style.width);
    const targetHeight = parseInt(targetEl.style.height);

    let sourceCenterX = sourceX + sourceWidth / 2;
    let sourceCenterY = sourceY + sourceHeight / 2;
    let targetCenterX = targetX + targetWidth / 2;
    let targetCenterY = targetY + targetHeight / 2;

    let startX, startY, startDir;

    if (sourceType === 'case') {
        const stepData = sourceContext;
        if (!stepData) return;

        const stepElement = canvas.querySelector(`[data-step-uuid="${stepData.id}"]`);
        if (!stepElement) return;

        const stepY = parseInt(stepElement.style.top);
        const stepHeight = parseInt(stepElement.style.height);

        // Use offsetLeft chain — pure DOM layout, no screen coordinates
        startX = conditionBoxCenterX(sourceEl, stepElement);
        startY = stepY + stepHeight - 1;
        startDir = 'bottom';
    } else if (sourceType === 'node') {
        const dx = targetCenterX - sourceCenterX;
        const dy = targetCenterY - sourceCenterY;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        const diamondPoint = 6;

            // Target is above source — apply span-based exit direction rules
            if (targetCenterY < sourceCenterY) {
                if (sourceCenterX === targetCenterX) {
                    // Exactly aligned — straight up, bottom entry
                    startX = sourceCenterX; startY = sourceCenterY - diamondPoint; startDir = 'top';
                } else if (sourceCenterX === targetCenterX - HG || sourceCenterX === targetCenterX + HG) {
                    // Exactly half grid off-center — side exit, bottom entry
                    const exitRight = sourceCenterX < targetCenterX;
                    startX = sourceCenterX + (exitRight ? diamondPoint : -diamondPoint); startY = sourceCenterY; startDir = exitRight ? 'right' : 'left';
                } else if (sourceCenterX >= targetX && sourceCenterX < targetCenterX) {
                    // Within span, left of center — exit right, upward turn, bottom entry
                    startX = sourceCenterX + diamondPoint; startY = sourceCenterY; startDir = 'right';
                } else if (sourceCenterX <= targetX + targetWidth && sourceCenterX > targetCenterX) {
                    // Within span, right of center — exit left, upward turn, bottom entry
                    startX = sourceCenterX - diamondPoint; startY = sourceCenterY; startDir = 'left';
                } else if (sourceCenterX < targetX) {
                    // Left of target — exit top, right turn, left-side entry
                    startX = sourceCenterX; startY = sourceCenterY - diamondPoint; startDir = 'top';
                } else {
                    // Right of target — exit top, left turn, right-side entry
                    startX = sourceCenterX; startY = sourceCenterY - diamondPoint; startDir = 'top';
                }
            } else if (Math.abs(dy) < 6) {
                // Target is at essentially the same Y — horizontal exit to side entry
                startX = sourceCenterX + (dx > 0 ? diamondPoint : -diamondPoint);
                startY = sourceCenterY;
                startDir = dx > 0 ? 'right' : 'left';
            } else if (sourceCenterX === targetCenterX - HG || sourceCenterX === targetCenterX + HG) {
                // Exactly half grid off-center, target below — side exit, top entry
                const exitRight = sourceCenterX < targetCenterX;
                startX = sourceCenterX + (exitRight ? diamondPoint : -diamondPoint); startY = sourceCenterY; startDir = exitRight ? 'right' : 'left';
            } else {
                // Target is below (or below and to the side) — always exit bottom
                startX = sourceCenterX;
                startY = sourceCenterY + diamondPoint;
                startDir = 'bottom';
            }
            // Safety fallback — should never be needed but prevents detachment
            if (startX === undefined) { startX = sourceCenterX; startY = sourceCenterY + diamondPoint; startDir = 'bottom'; }
    }

    let nearestTargetSide;
    if (targetType === 'node') {
        const diamondPoints = [
            { x: targetCenterX + targetWidth / 2,  y: targetCenterY,                name: 'right' },
            { x: targetCenterX - targetWidth / 2,  y: targetCenterY,                name: 'left' },
            { x: targetCenterX,                    y: targetCenterY + targetHeight / 2, name: 'bottom' },
            { x: targetCenterX,                    y: targetCenterY - targetHeight / 2, name: 'top' }
        ];

        const startGridX = startX / GU;
        const targetGridX = targetX / GU;
        const targetGridY = targetY / GU;
        const startGridY = startY / GU;
        const horizontalDistance = Math.abs(startGridX - targetGridX);

        const sourceTopY = sourceType === 'case'
            ? (sourceContext ? parseInt(canvas.querySelector(`[data-step-uuid="${sourceContext.id}"]`)?.style.top || 0) : 0)
            : sourceY;

        if (targetY <= sourceTopY + HG && sourceType !== 'node') {
            nearestTargetSide = diamondPoints[2]; // bottom — target is above or level with source step
        } else if (sourceType === 'case') {
            // Entry point based on where case startX falls relative to node's horizontal span
            if (startX < targetX) {
                nearestTargetSide = diamondPoints[1]; // left diamond point
            } else if (startX > targetX + targetWidth) {
                nearestTargetSide = diamondPoints[0]; // right diamond point
            } else {
                nearestTargetSide = diamondPoints[3]; // top diamond point — startX within node span
            }
        } else if (sourceType === 'node') {
            if (sourceCenterX < targetX) {
                nearestTargetSide = diamondPoints[1]; // left
            } else if (sourceCenterX > targetX + targetWidth) {
                nearestTargetSide = diamondPoints[0]; // right
            } else if (targetCenterY < sourceCenterY) {
                nearestTargetSide = diamondPoints[2]; // bottom — target above, within span
            } else {
                nearestTargetSide = diamondPoints[3]; // top — target below or same, within span
            }
        } else if (horizontalDistance <= 1 && targetGridY > startGridY) {
            nearestTargetSide = diamondPoints[3];
        } else {
            nearestTargetSide = diamondPoints.reduce((a, b) =>
                Math.hypot(a.x - startX, a.y - startY) < Math.hypot(b.x - startX, b.y - startY) ? a : b
            );
        }
    } else {
        const targetSides = [
            { x: targetCenterX, y: targetY,                name: 'top' },
            { x: targetCenterX, y: targetY + targetHeight,  name: 'bottom' },
            { x: targetX,       y: targetCenterY,           name: 'left' },
            { x: targetX + targetWidth, y: targetCenterY,   name: 'right' }
        ];

        const startGridX = startX / GU;
        const targetGridX = targetX / GU;
        const targetGridY = targetY / GU;
        const startGridY = startY / GU;
        const horizontalDistance = Math.abs(startGridX - targetGridX);

        const sourceTopY = sourceType === 'case'
            ? (sourceContext ? parseInt(canvas.querySelector(`[data-step-uuid="${sourceContext.id}"]`)?.style.top || 0) : 0)
            : sourceY;

        if (targetY <= sourceTopY + HG && sourceType !== 'node') {
            nearestTargetSide = targetSides[1]; // bottom — target is above or level with source step
        } else if (sourceType === 'node' && targetType === 'step') {
            if (sourceCenterX < targetX) {
                nearestTargetSide = targetSides[2]; // left
            } else if (sourceCenterX > targetX + targetWidth) {
                nearestTargetSide = targetSides[3]; // right
            } else if (targetCenterY < sourceCenterY) {
                nearestTargetSide = targetSides[1]; // bottom — target above, within span
            } else {
                nearestTargetSide = targetSides[0]; // top — target below or same, within span
            }
        } else if (sourceType === 'case') {
            // Entry side based on where the case start X falls relative to target's horizontal span
            if (startX < targetX) {
                nearestTargetSide = targetSides[2]; // left
            } else if (startX > targetX + targetWidth) {
                nearestTargetSide = targetSides[3]; // right
            } else {
                nearestTargetSide = targetSides[0]; // top — startX is within target span
            }
        } else if (horizontalDistance <= 1 && targetGridY > startGridY) {
            nearestTargetSide = targetSides[0];
        } else {
            nearestTargetSide = targetSides.reduce((a, b) =>
                Math.hypot(a.x - startX, a.y - startY) < Math.hypot(b.x - startX, b.y - startY) ? a : b
            );
        }
    }

    const arrowOffset = 8;
    let offsetX = 0, offsetY = 0;

    switch(nearestTargetSide.name) {
        case 'top':    offsetY = -arrowOffset; break;
        case 'bottom': offsetY =  arrowOffset; break;
        case 'left':   offsetX = -arrowOffset; break;
        case 'right':  offsetX =  arrowOffset; break;
    }

    const endPoint = {
        x: nearestTargetSide.x + offsetX,
        y: nearestTargetSide.y + offsetY
    };

    let path;

    if (sourceType === 'case') {
        path = createOrthogonalPath(startX, startY, endPoint.x, endPoint.y, nearestTargetSide.name, nearestTargetSide.x, nearestTargetSide.y);
    } else if (sourceType === 'node') {
        path = createOrthogonalPath(startX, startY, endPoint.x, endPoint.y, nearestTargetSide.name, nearestTargetSide.x, nearestTargetSide.y, startDir);
    } else {
        path = createCurvedPath(startX, startY, startDir, endPoint.x, endPoint.y, nearestTargetSide.name);
    }

    const markerId = `arrow-${sourceType}-${sourceId}-${targetId}`;

    let svg = `<defs><marker id="${markerId}" markerWidth="8" markerHeight="6" refX="0" refY="2" orient="auto"><polygon points="0 0, 4 2, 0 4" fill="${lineColor}"/></marker></defs><path d="${path}" stroke="${lineColor}" stroke-width="2" fill="none" marker-end="url(#${markerId})" style="pointer-events: none;"/>`;

    svg += `<circle cx="${startX}" cy="${startY}" r="8" fill="transparent" data-connection-hitbox="start" data-line-source-type="${sourceType}" data-line-source-id="${sourceId}" data-line-target-type="${targetType}" data-line-target-id="${targetId}" style="cursor: crosshair !important; pointer-events: auto;" />`;
    svg += `<circle cx="${endPoint.x}" cy="${endPoint.y}" r="8" fill="transparent" data-connection-hitbox="end" data-line-source-type="${sourceType}" data-line-source-id="${sourceId}" data-line-target-type="${targetType}" data-line-target-id="${targetId}" style="cursor: crosshair !important; pointer-events: auto;" />`;

    lineElement.innerHTML = svg;
    lineElement.style.zIndex = sourceType === 'case' ? '5' : '1';
    lineElement.style.cursor = 'crosshair';
}

// ============================================================================
// PHASE 4: PLACEMENT FUNCTIONS - Node and step creation
// ============================================================================

/**
 * Place a node on the canvas at the specified CSS pixel coordinates.
 */
function placeNode(x, y) {
    const canvas = document.getElementById('workflowCanvas');
    const nodeId = generateNodeId();

    // Offset by half node size (15px) so the center snaps to the nearest half-grid,
    // not the top-left corner
    const snappedX = Math.round((x - HG) / HG) * HG;
    const snappedY = Math.round((y - HG) / HG) * HG;

    const { gx: gridX, gy: gridY } = pixelToGrid(snappedX, snappedY);

    const nodeData = {
        id: nodeId,
        position: `${gridX},${gridY}`,
        targetSteps: [],
        targetNodes: []
    };

    currentNodes.push(nodeData);
    updateSaveButtonState();
    updatePreview();
    renderNode(nodeData);
}

/**
 * Create a step on the canvas.
 * @param {string} stepType - Type of step
 * @param {number} x - X in CSS pixels (snapped)
 * @param {number} y - Y in CSS pixels (snapped)
 */
function createStepOnCanvas(stepType, x, y) {
    const { gx: gridX, gy: gridY } = pixelToGrid(Math.round(x / GU) * GU, Math.round(y / GU) * GU);

    transitionCounter = (transitionCounter || 0) + 1;
    const defaultConditionId = String(transitionCounter);

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
            mode: 'First',
            cases: [
                {
                    type: 'Success',
                    conditions: '',
                    targetSteps: [],
                    targetNodes: [],
                    order: 1,
                    _conditionId: defaultConditionId
                }
            ]
        }
    };

    currentTransitions.push({
        id: defaultConditionId,
        name: '',
        type: 'Success',
        conditions: '',
        targetSteps: [],
        targetNodes: [],
        order: 1,
        parentStepId: stepData.id
    });

    currentSteps.push(stepData);
    renderStep(stepData);
    updatePreview();
}

function updateConnectedLines(elementId, elementType) {
    const canvas = document.getElementById('workflowCanvas');

    if (elementType === 'step') {
        const step = currentSteps.find(s => s.id === elementId);
        if (step && step.transition && step.transition.cases) {
            step.transition.cases.forEach(caseData => {
                const conditionId = caseData._conditionId;
                if (!conditionId) return;
                const transition = currentTransitions.find(t => t.id === conditionId);
                if (!transition) return;
                const caseColor = getTransitionTheme(transition.type).color;
                const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-from-transition="${conditionId}"]`);
                caseLines.forEach(line => {
                    const toStepId = line.getAttribute('data-to-step');
                    const toNodeId = line.getAttribute('data-to-node');
                    if (toStepId) drawConnectionLine(line, conditionId, 'case', toStepId, 'step', canvas, caseColor, false, step);
                    else if (toNodeId) drawConnectionLine(line, conditionId, 'case', toNodeId, 'node', canvas, caseColor, false, step);
                });
            });
        }

        const inboundNodeLines = canvas.querySelectorAll(`[data-node-connection-line][data-to-step="${elementId}"]`);
        inboundNodeLines.forEach(line => {
            const fromNodeId = line.getAttribute('data-from-node');
            drawConnectionLine(line, fromNodeId, 'node', elementId, 'step', canvas, '#707070', true);
        });

        const inboundCaseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-to-step="${elementId}"]`);
        inboundCaseLines.forEach(line => {
            const fromTransitionId = line.getAttribute('data-from-transition');
            const tr = currentTransitions.find(t => t.id === fromTransitionId);
            const srcStep = tr ? currentSteps.find(s => s.id === tr.parentStepId) : null;
            const caseColor = tr ? getTransitionTheme(tr.type).color : getTransitionTheme('Success').color;
            drawConnectionLine(line, fromTransitionId, 'case', elementId, 'step', canvas, caseColor, false, srcStep);
        });

    } else if (elementType === 'node') {
        const caseLines = canvas.querySelectorAll(`[data-transition-connection-line][data-to-node="${elementId}"]`);
        caseLines.forEach(line => {
            const fromTransitionId = line.getAttribute('data-from-transition');
            const tr = currentTransitions.find(t => t.id === fromTransitionId);
            const srcStep = tr ? currentSteps.find(s => s.id === tr.parentStepId) : null;
            const caseColor = tr ? getTransitionTheme(tr.type).color : getTransitionTheme('Success').color;
            drawConnectionLine(line, fromTransitionId, 'case', elementId, 'node', canvas, caseColor, false, srcStep);
        });

        const outboundNodeLines = canvas.querySelectorAll(`[data-node-connection-line][data-from-node="${elementId}"]`);
        outboundNodeLines.forEach(line => {
            const toStepId = line.getAttribute('data-to-step');
            const toNodeId = line.getAttribute('data-to-node');
            const targetType = toStepId ? 'step' : 'node';
            const targetId = toStepId || toNodeId;
            drawConnectionLine(line, elementId, 'node', targetId, targetType, canvas, '#707070', true);
        });

        const inboundNodeLines = canvas.querySelectorAll(`[data-node-connection-line][data-to-node="${elementId}"]`);
        inboundNodeLines.forEach(line => {
            const fromNodeId = line.getAttribute('data-from-node');
            drawConnectionLine(line, fromNodeId, 'node', elementId, 'node', canvas, '#707070', true);
        });
    }

    const allNodeLines = canvas.querySelectorAll('[data-node-connection-line]');
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
 * Make an element draggable within the canvas.
 * All position math is in CSS pixel space.
 * dragOffsetX/Y computed once at mousedown via clientToCanvas, then used as a fixed offset.
 */
function makeElementDraggable(element, elementId, elementType, onDragMove, onDragEnd, options = {}) {
    const canvas = document.getElementById('workflowCanvas');
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let dragStartClientX = 0;
    let dragStartClientY = 0;
    let multiDragStartPositions = null;

    const {
        dragHandle = null,
        threshold = 0,
        snapSize = HG,
        bounds = true
    } = options;

    element.addEventListener('mousedown', (e) => {
        if (dragHandle && !e.target.closest(dragHandle)) return;

        e.stopPropagation();
        isDragging = true;
        dragStartClientX = e.clientX;
        dragStartClientY = e.clientY;

        // Convert mouse position to canvas CSS pixels, then compute offset
        const canvasPos = clientToCanvas(e.clientX, e.clientY, canvas);
        dragOffsetX = canvasPos.x - (parseInt(element.style.left) || 0);
        dragOffsetY = canvasPos.y - (parseInt(element.style.top) || 0);

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

            // Threshold check: delta in screen space, browser zoom cancels out
            if (threshold > 0) {
                const deltaX = Math.abs(moveEvent.clientX - dragStartClientX);
                const deltaY = Math.abs(moveEvent.clientY - dragStartClientY);
                if (deltaX < threshold && deltaY < threshold) return;
            }

            if (elementType === 'node') {
                element.setAttribute('data-was-dragged', 'true');
            }

            const pos = clientToCanvas(moveEvent.clientX, moveEvent.clientY, canvas);
            let newX = pos.x - dragOffsetX;
            let newY = pos.y - dragOffsetY;

            newX = Math.round(newX / snapSize) * snapSize;
            newY = Math.round(newY / snapSize) * snapSize;

            if (bounds) {
                newX = Math.max(0, newX);
                newY = Math.max(0, newY);
            }

            if (multiDragStartPositions) {
                const myStart = multiDragStartPositions[elementType + ':' + elementId];
                if (myStart) {
                    const dx = newX - myStart.x;
                    const dy = newY - myStart.y;
                    selectedElements.forEach(key => {
                        if (key === elementType + ':' + elementId) return;
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
                        }
                    });
                }
            }

            element.style.left = newX + 'px';
            element.style.top = newY + 'px';

            if (onDragMove) onDragMove(newX, newY, element);
            updateConnectedLines(elementId, elementType);
        };

        const handleMouseUp = (upEvent) => {
            if (!isDragging) return;
            isDragging = false;
            multiDragStartPositions = null;

            const finalX = parseInt(element.style.left);
            const finalY = parseInt(element.style.top);

            if (onDragEnd) onDragEnd(finalX, finalY, element);

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

function setupCanvasDragDrop() {
    const stepTypeItems = document.querySelectorAll('.step-type-item');
    const canvas = document.getElementById('workflowCanvas');
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    stepTypeItems.forEach(item => {
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('stepType', item.getAttribute('data-type'));
            // Offset stays in screen space — used as screen-space delta before clientToCanvas
            const rect = item.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
        });
    });

    canvas.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    canvas.addEventListener('dragleave', (e) => {
        if (e.target === canvas) { /* keep canvas transparent */ }
    });

    canvas.addEventListener('drop', (e) => {
        e.preventDefault();

        const stepType = e.dataTransfer.getData('stepType');
        // Adjust clientX/Y by drag offset (both screen space), then convert to canvas CSS pixels
        const pos = clientToCanvas(e.clientX - dragOffsetX, e.clientY - dragOffsetY, canvas);

        const x = Math.round(pos.x / GU) * GU;
        const y = Math.round(pos.y / GU) * GU;

        createStepOnCanvas(stepType, x, y);
    });

    // ── Pan and Zoom ─────────────────────────────────────────────────────────
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;

    const container = document.getElementById('canvasContainer');

    function clampPan() {
        // getBoundingClientRect used only for container viewport sizing, not element positioning
        const containerRect = container.getBoundingClientRect();
        const visibleWidth = containerRect.width / zoomLevel;
        const visibleHeight = containerRect.height / zoomLevel;
        panX = Math.max(0, Math.min(panX, CANVAS_SIZE - visibleWidth));
        panY = Math.max(0, Math.min(panY, CANVAS_SIZE - visibleHeight));
    }

    function updateTransform() {
        canvas.style.transform = `scale(${zoomLevel}) translate(${-panX}px, ${-panY}px)`;
        canvas.style.transformOrigin = '0 0';
    }

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();

        const zoomIncrement = e.deltaY > 0 ? -0.05 : 0.05;
        const newZoom = Math.max(0.55, Math.min(2, zoomLevel + zoomIncrement));

        // mouseX/Y relative to container for zoom centering — not element positioning
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

    // ── Marquee and Pan ───────────────────────────────────────────────────────
    let isMarqueeSelecting = false;
    let marqueeStartX = 0;
    let marqueeStartY = 0;
    let marqueeEl = null;

    container.addEventListener('mousedown', (e) => {
        if (e.button === 0 && (e.target === canvas || e.target.closest('[data-transition-connection-line]'))) {
            if (e.target.closest('[data-step-uuid]') ||
                e.target.closest('[data-transition-frame]') ||
                e.target.closest('[data-case-arrow-hitbox]')) {
                return;
            }

            if (e.ctrlKey || e.metaKey) {
                isMarqueeSelecting = true;
                // Marquee is a UI overlay on the container; container-relative screen coords correct here
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
                // Pan uses raw clientX/Y deltas — browser zoom cancels out in the subtraction
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

            // Marquee hit-testing: both sides in screen space, internally consistent
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

            const suppressClick = (e) => { e.stopPropagation(); canvas.removeEventListener('click', suppressClick, true); };
            canvas.addEventListener('click', suppressClick, true);
        }
    });

    // ── Connection hitbox dragging ────────────────────────────────────────────
    let draggedConnectionHitbox = null;
    let draggedConnectionLineElement = null;
    let draggedConnectionSourceType = null;
    let draggedConnectionSourceId = null;
    let draggedConnectionTargetType = null;
    let draggedConnectionTargetId = null;
    let draggedConnectionStartPoint = { x: 0, y: 0 };

    document.addEventListener('mousedown', (e) => {
        const hitbox = e.target.closest('[data-connection-hitbox]');
        if (!hitbox) return;

        const canvas = document.getElementById('workflowCanvas');
        if (!canvas) return;

        e.stopPropagation();
        e.preventDefault();

        draggedConnectionHitbox = hitbox;
        draggedConnectionSourceType = hitbox.getAttribute('data-line-source-type');
        draggedConnectionSourceId = hitbox.getAttribute('data-line-source-id');
        draggedConnectionTargetType = hitbox.getAttribute('data-line-target-type');
        draggedConnectionTargetId = hitbox.getAttribute('data-line-target-id');

        let lineElement = null;
        if (draggedConnectionSourceType === 'case') {
            lineElement = canvas.querySelector(`[data-transition-connection-line][data-from-transition="${draggedConnectionSourceId}"][data-to-${draggedConnectionTargetType}="${draggedConnectionTargetId}"]`);
        } else if (draggedConnectionSourceType === 'node') {
            lineElement = canvas.querySelector(`[data-node-connection-line][data-from-node="${draggedConnectionSourceId}"][data-to-${draggedConnectionTargetType}="${draggedConnectionTargetId}"]`);
        } else if (draggedConnectionSourceType === 'step') {
            lineElement = canvas.querySelector(`[data-connection-line][data-from-step="${draggedConnectionSourceId}"][data-to-frame="${draggedConnectionTargetId}"]`);
        }
        draggedConnectionLineElement = lineElement;

        // Calculate start point from style.left/top — no getBoundingClientRect
        if (draggedConnectionSourceType === 'case') {
            const transition = currentTransitions.find(t => t.id === draggedConnectionSourceId);
            if (transition) {
                const stepElement = canvas.querySelector(`[data-step-uuid="${transition.parentStepId}"]`);
                const conditionBox = stepElement ? stepElement.querySelector(`[data-condition-id="${draggedConnectionSourceId}"]`) : null;
                if (stepElement && conditionBox) {
                    const stepY = parseInt(stepElement.style.top);
                    const stepHeight = parseInt(stepElement.style.height);
                    draggedConnectionStartPoint = {
                        x: conditionBoxCenterX(conditionBox, stepElement),
                        y: stepY + stepHeight - 1
                    };
                }
            }
        } else if (draggedConnectionSourceType === 'node') {
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

        if (lineElement) lineElement.style.display = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!draggedConnectionHitbox) return;

        const canvas = document.getElementById('workflowCanvas');
        const pos = clientToCanvas(e.clientX, e.clientY, canvas);

        let previewLine = canvas.querySelector('[data-connection-preview-line]');
        if (!previewLine) {
            previewLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            previewLine.setAttribute('data-connection-preview-line', 'true');
            previewLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
            canvas.appendChild(previewLine);
        }

        const path = createCurvedPath(draggedConnectionStartPoint.x, draggedConnectionStartPoint.y, 'bottom', pos.x, pos.y, 'bottom');
        previewLine.innerHTML = `<path d="${path}" stroke="#707070" stroke-width="2" fill="none" stroke-dasharray="5,5"/>`;
    });

    document.addEventListener('mouseup', (e) => {
        if (!draggedConnectionHitbox) return;

        draggedConnectionHitbox = null;
        const canvas = document.getElementById('workflowCanvas');

        const previewLine = canvas.querySelector('[data-connection-preview-line]');
        if (previewLine) previewLine.remove();

        const dropTarget = detectDropTarget(canvas, e.clientX, e.clientY);
        const droppedOnStep = dropTarget.droppedOnStep;
        const droppedOnNode = dropTarget.droppedOnNode;

        if (droppedOnStep || droppedOnNode) {
            if (draggedConnectionSourceType === 'case') {
                const transition = currentTransitions.find(t => t.id === draggedConnectionSourceId);
                if (transition) {
                    if (draggedConnectionTargetType === 'step') {
                        transition.targetSteps = transition.targetSteps.filter(s => s !== draggedConnectionTargetId);
                    } else if (draggedConnectionTargetType === 'node') {
                        transition.targetNodes = transition.targetNodes.filter(n => n !== draggedConnectionTargetId);
                    }

                    if (droppedOnStep) {
                        if (!transition.targetSteps.includes(droppedOnStep)) transition.targetSteps.push(droppedOnStep);
                    } else if (droppedOnNode) {
                        if (!transition.targetNodes) transition.targetNodes = [];
                        if (!transition.targetNodes.includes(droppedOnNode)) transition.targetNodes.push(droppedOnNode);
                    }

                    if (draggedConnectionLineElement) draggedConnectionLineElement.remove();

                    const lineUUID = generateId();
                    const newLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    newLine.setAttribute('data-transition-connection-line', lineUUID);
                    newLine.setAttribute('data-from-transition', draggedConnectionSourceId);
                    if (droppedOnStep) newLine.setAttribute('data-to-step', droppedOnStep);
                    else newLine.setAttribute('data-to-node', droppedOnNode);
                    newLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                    canvas.appendChild(newLine);

                    const srcStep = currentSteps.find(s => s.id === transition.parentStepId);
                    const caseColor = getTransitionTheme(transition.type).color;
                    drawConnectionLine(newLine, draggedConnectionSourceId, 'case', droppedOnStep || droppedOnNode, droppedOnStep ? 'step' : 'node', canvas, caseColor, false, srcStep);

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

                    if (droppedOnStep) {
                        if (!sourceNode.targetSteps.includes(droppedOnStep)) sourceNode.targetSteps.push(droppedOnStep);
                    } else if (droppedOnNode) {
                        if (!sourceNode.targetNodes.includes(droppedOnNode)) sourceNode.targetNodes.push(droppedOnNode);
                    }

                    if (draggedConnectionLineElement) draggedConnectionLineElement.remove();

                    const lineUUID = generateId();
                    const newLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    newLine.setAttribute('data-node-connection-line', lineUUID);
                    newLine.setAttribute('data-from-node', draggedConnectionSourceId);
                    if (droppedOnStep) newLine.setAttribute('data-to-step', droppedOnStep);
                    else newLine.setAttribute('data-to-node', droppedOnNode);
                    newLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                    canvas.appendChild(newLine);

                    drawConnectionLine(newLine, draggedConnectionSourceId, 'node', droppedOnStep || droppedOnNode, droppedOnStep ? 'step' : 'node', canvas, '#707070', true);

                    recheckFlaggedSteps();
                    updatePreview();
                }
            }
        } else {
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
            if (draggedConnectionLineElement) draggedConnectionLineElement.remove();
        }

        draggedConnectionLineElement = null;
        draggedConnectionSourceType = null;
        draggedConnectionSourceId = null;
        draggedConnectionTargetType = null;
        draggedConnectionTargetId = null;
    });

    // ── Transition arrow drag (draw new case lines) ───────────────────────────
    let isDrawingFromTransition = false;
    let fromTransitionId = null;
    let transitionStartX = 0;
    let transitionStartY = 0;

    document.addEventListener('mousedown', (e) => {
        const triangle = e.target.closest('[data-transition-arrow]');
        if (!triangle) return;

        const canvas = document.getElementById('workflowCanvas');
        if (!canvas) return;

        e.stopPropagation();
        isDrawingFromTransition = true;
        fromTransitionId = triangle.getAttribute('data-transition-arrow');

        const conditionId = fromTransitionId;
        const conditionBox = canvas.querySelector(`[data-condition-id="${conditionId}"]`);
        if (!conditionBox) return;

        const stepElement = conditionBox.closest('[data-step-uuid]');
        if (!stepElement) return;

        const stepY = parseInt(stepElement.style.top);
        const stepHeight = parseInt(stepElement.style.height);

        // Start point via offsetLeft chain — no getBoundingClientRect
        transitionStartX = conditionBoxCenterX(conditionBox, stepElement);
        transitionStartY = stepY + stepHeight - 1;

        const handleTransitionMouseMove = (e) => {
            if (!isDrawingFromTransition) return;

            const pos = clientToCanvas(e.clientX, e.clientY, canvas);

            let line = canvas.querySelector('[data-transition-preview-line]');
            if (!line) {
                line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                line.setAttribute('data-transition-preview-line', 'true');
                line.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                canvas.appendChild(line);
            }

            line.innerHTML = `<line x1="${transitionStartX}" y1="${transitionStartY}" x2="${pos.x}" y2="${pos.y}" stroke="#707070" stroke-width="2"/>`;
        };

        const handleTransitionMouseUp = (e) => {
            if (!isDrawingFromTransition) return;

            const savedTransitionId = fromTransitionId;
            isDrawingFromTransition = false;
            fromTransitionId = null;
            document.removeEventListener('mousemove', handleTransitionMouseMove);
            document.removeEventListener('mouseup', handleTransitionMouseUp);

            const previewLine = canvas.querySelector('[data-transition-preview-line]');
            if (previewLine) previewLine.remove();

            // Convert drop position to canvas CSS pixels for distance check
            const endPos = clientToCanvas(e.clientX, e.clientY, canvas);
            const dragDistance = Math.hypot(endPos.x - transitionStartX, endPos.y - transitionStartY);

            let stepElement = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-step-id]');
            let nodeElement = null;

            if (!stepElement) {
                const dropTarget = detectDropTarget(canvas, e.clientX, e.clientY);
                if (dropTarget.droppedOnStep) {
                    stepElement = canvas.querySelector(`[data-step-uuid="${dropTarget.droppedOnStep}"]`);
                }
                if (dropTarget.droppedOnNode) {
                    nodeElement = canvas.querySelector(`[data-node-id="${dropTarget.droppedOnNode}"]`);
                }
            }

            const transition = currentTransitions.find(t => t.id === savedTransitionId);

            if (stepElement && dragDistance >= MIN_DRAG_DISTANCE) {
                const targetStepId = stepElement.getAttribute('data-step-uuid');
                const targetStep = currentSteps.find(s => s.id === targetStepId);
                if (targetStep && targetStep.type === 'Begin') return;

                if (transition && targetStepId) {
                    if (!transition.targetSteps.includes(targetStepId)) {
                        transition.targetSteps.push(targetStepId);
                    }

                    const lineUUID = generateId();
                    const connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    connectionLine.setAttribute('data-transition-connection-line', lineUUID);
                    connectionLine.setAttribute('data-from-transition', savedTransitionId);
                    connectionLine.setAttribute('data-to-step', targetStepId);
                    connectionLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                    canvas.appendChild(connectionLine);

                    const srcStep = currentSteps.find(s => s.id === transition.parentStepId);
                    const caseColor = getTransitionTheme(transition.type).color;
                    drawConnectionLine(connectionLine, savedTransitionId, 'case', targetStepId, 'step', canvas, caseColor, false, srcStep);

                    syncTransitionCasesToStep();
                    recheckFlaggedSteps();
                    updatePreview();
                }
            } else if (nodeElement && dragDistance >= MIN_DRAG_DISTANCE) {
                const targetNodeId = nodeElement.getAttribute('data-node-id');

                if (transition && targetNodeId) {
                    if (!transition.targetNodes) transition.targetNodes = [];
                    if (!transition.targetNodes.includes(targetNodeId)) {
                        transition.targetNodes.push(targetNodeId);
                    }

                    const lineUUID = generateId();
                    const connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    connectionLine.setAttribute('data-transition-connection-line', lineUUID);
                    connectionLine.setAttribute('data-from-transition', savedTransitionId);
                    connectionLine.setAttribute('data-to-node', targetNodeId);
                    connectionLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`;
                    canvas.appendChild(connectionLine);

                    const srcStep = currentSteps.find(s => s.id === transition.parentStepId);
                    const caseColor = getTransitionTheme(transition.type).color;
                    drawConnectionLine(connectionLine, savedTransitionId, 'case', targetNodeId, 'node', canvas, caseColor, false, srcStep);

                    syncTransitionCasesToStep();
                    recheckFlaggedSteps();
                    updatePreview();
                }
            } else if (dragDistance >= MIN_DRAG_DISTANCE) {
                // Dropped on empty space — create a new node at drop position
                if (transition) {
                    const newNodeId = generateNodeId();

                    const snappedX = Math.round((endPos.x - HG) / HG) * HG;
                    const snappedY = Math.round((endPos.y - HG) / HG) * HG;
                    const { gx: gridUnitX, gy: gridUnitY } = pixelToGrid(snappedX, snappedY);

                    const newNodeData = {
                        id: newNodeId,
                        position: `${gridUnitX},${gridUnitY}`,
                        targetSteps: [],
                        targetNodes: []
                    };
                    currentNodes.push(newNodeData);

                    if (!transition.targetNodes) transition.targetNodes = [];
                    if (!transition.targetNodes.includes(newNodeId)) {
                        transition.targetNodes.push(newNodeId);
                    }
                    updateSaveButtonState();
                    updatePreview();

                    renderNode(newNodeData);

                    const newLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    newLine.setAttribute('data-transition-connection-line', 'true');
                    newLine.setAttribute('data-from-transition', savedTransitionId);
                    newLine.setAttribute('data-to-node', newNodeId);
                    newLine.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 5;`;
                    canvas.appendChild(newLine);

                    newLine.addEventListener('mousedown', (e) => {
                        if (e.target.closest('[data-case-arrow-hitbox]')) e.stopPropagation();
                    });

                    const srcStep = currentSteps.find(s => s.id === transition.parentStepId);
                    const caseColor = getTransitionTheme(transition.type).color;
                    drawConnectionLine(newLine, savedTransitionId, 'case', newNodeId, 'node', canvas, caseColor, false, srcStep);

                    updatePreview();
                }
            }
        };

        document.addEventListener('mousemove', handleTransitionMouseMove);
        document.addEventListener('mouseup', handleTransitionMouseUp);
    });

    // ── Canvas click (deselect) ───────────────────────────────────────────────
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

    // ── Context menu ──────────────────────────────────────────────────────────
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
        const rect = ctxMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) ctxMenu.style.left = (x - rect.width) + 'px';
        if (rect.bottom > window.innerHeight) ctxMenu.style.top = (y - rect.height) + 'px';
    }

    document.addEventListener('click', hideCtxMenu);
    document.addEventListener('contextmenu', hideCtxMenu);

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Convert to canvas CSS pixels for placing elements
        const pos = clientToCanvas(e.clientX, e.clientY, canvas);

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
            items.push(ctxItem('Add Node', () => placeNode(pos.x, pos.y)));
            items.push(ctxItem('Paste', () => pasteClipboard(pos.x, pos.y)));
        }

        showCtxMenu(e.clientX, e.clientY, items);
    });
}

/**
 * Initialize canvas DOM properties from configuration constants.
 * Called once on page load from initWorkflowEditor().
 * Ensures all grid-derived sizes come from GU/CANVAS_SIZE, not hardcoded HTML.
 */
function initCanvas() {
    const container = document.getElementById('canvasContainer');
    if (!container) return;

    // Create the canvas element programmatically
    const canvas = document.createElement('div');
    canvas.id = 'workflowCanvas';
    canvas.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: ${CANVAS_SIZE}px;
        height: ${CANVAS_SIZE}px;
        transform-origin: 0 0;
        background: transparent;
        background-image: linear-gradient(rgba(128, 128, 128, 0.15) 1px, transparent 1px),
                          linear-gradient(90deg, rgba(128, 128, 128, 0.15) 1px, transparent 1px);
        background-size: ${GU}px ${GU}px;
    `;

    // Placeholder text shown before any steps are added
    const placeholder = document.createElement('div');
    placeholder.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: var(--text-muted);
        text-align: center;
        font-size: 0.9rem;
        white-space: nowrap;
        user-select: none;
        pointer-events: none;
    `;
    placeholder.textContent = 'Drag step types here to create steps';
    canvas.appendChild(placeholder);

    container.appendChild(canvas);

    // Tools panel — positioned absolute over canvas, top-right
    const toolsPanel = document.createElement('div');
    toolsPanel.id = 'toolsPanel';
    toolsPanel.style.cssText = `
        position: absolute;
        top: 6px;
        right: 6px;
        width: 90px;
        background: var(--bg-panel2);
        border: 1px solid var(--border-primary);
        border-radius: 4px;
        padding: 0;
        display: flex;
        flex-direction: column;
        z-index: 15;
    `;

    const toolsHeader = document.createElement('div');
    toolsHeader.setAttribute('onclick', 'toggleToolsPanel()');
    toolsHeader.style.cssText = `
        height: 15px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: var(--bg-panel1);
        border-bottom: 1px solid var(--border-primary);
        padding: 0 4px;
        box-sizing: border-box;
        cursor: pointer;
    `;
    toolsHeader.innerHTML = `
        <span style="font-size: 0.65rem; font-weight: 600; color: var(--text-primary); flex: 1;">TOOLS</span>
        <button id="toolsCollapseBtn" style="background: transparent; border: none; color: var(--text-primary); cursor: pointer; font-size: 10px; padding: 0; width: 12px; height: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; pointer-events: none;">▼</button>
    `;
    toolsPanel.appendChild(toolsHeader);

    const toolsButtonsContainer = document.createElement('div');
    toolsButtonsContainer.id = 'toolsButtonsContainer';
    toolsButtonsContainer.style.cssText = `display: none; padding: 0;`;
    toolsButtonsContainer.innerHTML = `
        <button id="toolShape" style="flex: 1; background: transparent; border: 1px solid var(--border-primary); border-right: 1px solid var(--border-primary); padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-primary); font-size: 18px; transition: background 0.2s;" title="Draw Shape">
            <svg width="20" height="20" viewBox="0 0 24 24" style="stroke: currentColor; fill: none;"><use xlink:href="/img/icons.svg#i-shape"></use></svg>
        </button>
        <button id="toolNode" style="flex: 1; background: transparent; border: 1px solid var(--border-primary); border-right: 1px solid var(--border-primary); padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-primary); font-size: 18px; transition: background 0.2s;" title="Click and drag to place node">
            <svg width="20" height="20" viewBox="0 0 24 24" style="stroke: currentColor; fill: none;"><use xlink:href="/img/icons.svg#i-node"></use></svg>
        </button>
        <button id="toolNote" style="flex: 1; background: transparent; border: 1px solid var(--border-primary); padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-primary); font-size: 18px; transition: background 0.2s;" title="Add Note">
            <svg width="20" height="20" viewBox="0 0 24 24" style="stroke: currentColor; fill: none;"><use xlink:href="/img/icons.svg#i-note"></use></svg>
        </button>
    `;
    toolsPanel.appendChild(toolsButtonsContainer);
    container.appendChild(toolsPanel);

    // Zoom control — positioned absolute over canvas, bottom-right
    const zoomControl = document.createElement('div');
    zoomControl.style.cssText = `
        position: absolute;
        bottom: 6px;
        right: 6px;
        background: var(--bg-panel1);
        border: 1px solid var(--border-primary);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        z-index: 100;
    `;
    zoomControl.innerHTML = `
        <button onclick="zoomOut()" style="background: transparent; border: none; color: var(--text-primary); cursor: pointer; font-size: 1.2rem; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;">-</button>
        <span id="zoomDisplay" style="color: var(--text-primary); background: var(--bg-input); border: 1px solid var(--border-primary); border-radius: 6px; font-size: 0.9rem; width: 41px; text-align: center;">100%</span>
        <button onclick="zoomIn()" style="background: transparent; border: none; color: var(--text-primary); cursor: pointer; font-size: 1.2rem; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;">+</button>
        <button onclick="resetZoom()" style="background: transparent; border: none; color: var(--text-primary); cursor: pointer; font-size: 1rem; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;">&#8635;</button>
    `;
    container.appendChild(zoomControl);
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
        container.style.display = 'none';
        btn.textContent = '▼';
        panel.style.width = '90px';
    } else {
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
        panel.style.width = '150px';
        list.style.display = 'flex';
        button.textContent = '◀';
        button.style.marginBottom = '0';
        title.style.writingMode = 'horizontal-tb';
        title.style.transform = 'none';
        header.style.flexDirection = 'row';
    } else {
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

    // getBoundingClientRect used only for container dimensions (viewport sizing)
    const rect = container.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const newZoom = Math.min(2, zoomLevel + 0.05);
    panX = centerX / newZoom + (panX * zoomLevel / newZoom) - centerX / newZoom;
    panY = centerY / newZoom + (panY * zoomLevel / newZoom) - centerY / newZoom;
    zoomLevel = newZoom;

    const maxPanX = CANVAS_SIZE - (rect.width / zoomLevel);
    const maxPanY = CANVAS_SIZE - (rect.height / zoomLevel);
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
    panX = centerX / newZoom + (panX * zoomLevel / newZoom) - centerX / newZoom;
    panY = centerY / newZoom + (panY * zoomLevel / newZoom) - centerY / newZoom;
    zoomLevel = newZoom;

    const maxPanX = CANVAS_SIZE - (rect.width / zoomLevel);
    const maxPanY = CANVAS_SIZE - (rect.height / zoomLevel);
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
                const transitions = (step.transition && step.transition.cases || [])
                    .map(c => currentTransitions.find(t => t.id === c._conditionId))
                    .filter(Boolean);
                steps.push({
                    step: JSON.parse(JSON.stringify(step)),
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
    const allPositions = [
        ...steps.map(s => s.step.position),
        ...nodes.map(n => n.position)
    ].map(p => { const [x, y] = p.split(',').map(Number); return { x, y }; });

    const anchor = allPositions.reduce((a, b) =>
        (b.y < a.y || (b.y === a.y && b.x < a.x)) ? b : a
    );

    // canvasX/Y are in CSS pixels; convert to grid for offset math
    const { gx: pasteGridX, gy: pasteGridY } = pixelToGrid(canvasX, canvasY);
    const dx = pasteGridX - anchor.x;
    const dy = pasteGridY - anchor.y;

    const idMap = {};
    steps.forEach(({ step }) => { idMap[step.id] = generateId(); });
    nodes.forEach(node => { idMap[node.id] = generateNodeId(); });

    const newSteps = [];
    steps.forEach(({ step, transitions }) => {
        const newStep = JSON.parse(JSON.stringify(step));
        newStep.id = idMap[step.id];

        const [sx, sy] = step.position.split(',').map(Number);
        newStep.position = `${Math.round(sx + dx)},${Math.round(sy + dy)}`;

        if (newStep.transition && newStep.transition.cases) {
            const condIdMap = {};
            (transitions || []).forEach(t => {
                transitionCounter = (transitionCounter || 0) + 1;
                condIdMap[t.id] = String(transitionCounter);
            });

            newStep.transition.cases.forEach((c, i) => {
                const oldCondId = c._conditionId;
                const newCondId = condIdMap[oldCondId] || (() => {
                    transitionCounter = (transitionCounter || 0) + 1;
                    return String(transitionCounter);
                })();
                c._conditionId = newCondId;
                if (c.targetSteps) c.targetSteps = c.targetSteps.filter(id => idMap[id]).map(id => idMap[id]);
                if (c.targetNodes) c.targetNodes = c.targetNodes.filter(id => idMap[id]).map(id => idMap[id]);

                const origT = (transitions || []).find(t => t.id === oldCondId);
                const newT = origT ? JSON.parse(JSON.stringify(origT)) : { type: 'Success', conditions: '', order: i + 1 };
                newT.id = newCondId;
                newT.parentStepId = newStep.id;
                if (newT.targetSteps) newT.targetSteps = newT.targetSteps.filter(id => idMap[id]).map(id => idMap[id]);
                if (newT.targetNodes) newT.targetNodes = newT.targetNodes.filter(id => idMap[id]).map(id => idMap[id]);
                currentTransitions.push(newT);
            });

            if (newStep.transition.position) {
                const [tx, ty] = newStep.transition.position.split(',').map(Number);
                newStep.transition.position = `${Math.round(tx + dx)},${Math.round(ty + dy)}`;
            }
        }

        currentSteps.push(newStep);
        newSteps.push(newStep);
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

    updateSaveButtonState();
    updatePreview();

    setTimeout(() => {
        requestAnimationFrame(() => {
            const canvas = document.getElementById('workflowCanvas');
            newSteps.forEach(newStep => {
                if (!newStep.transition || !newStep.transition.cases) return;
                newStep.transition.cases.forEach(caseData => {
                    const conditionId = caseData._conditionId;
                    if (!conditionId) return;
                    const transition = currentTransitions.find(t => t.id === conditionId);
                    if (!transition) return;

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
                            drawConnectionLine(caseLine, conditionId, 'case', targetStepId, 'step', canvas, caseColor, false, newStep);
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
                            drawConnectionLine(caseLine, conditionId, 'case', targetNodeId, 'node', canvas, caseColor, false, newStep);
                        });
                    }
                });
            });
        });
    }, 300);
}

function updateElementPosition(id, type, px, py) {
    const { gx: gridX, gy: gridY } = pixelToGrid(px, py);
    if (type === 'node') {
        const node = currentNodes.find(n => n.id === id);
        if (node) node.position = `${gridX},${gridY}`;
    } else if (type === 'frame') {
        const frame = currentTransitionFrames.find(f => f.id === id);
        if (frame) {
            frame.position = `${gridX},${gridY}`;
            const owningStep = currentSteps.find(s => s.transition && currentTransitionFrames.find(f2 => f2.id === id && f2.parentStepId === s.id));
            if (owningStep && owningStep.transition) {
                owningStep.transition.position = `${gridX},${gridY}`;
            }
        }
    }
}

// ============================================================================
// WINDOW EXPORTS
// ============================================================================
window.CANVAS_SIZE = CANVAS_SIZE;
window.GU = GU;
window.HG = HG;
window.BORDER = BORDER;
window.I_CONT_H = I_CONT_H;
window.initCanvas = initCanvas;
window.clientToCanvas = clientToCanvas;
window.gridToPixel = gridToPixel;
window.pixelToGrid = pixelToGrid;
window.conditionBoxCenterX = conditionBoxCenterX;
window.createCurvedPath = createCurvedPath;
window.createOrthogonalPath = createOrthogonalPath;
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