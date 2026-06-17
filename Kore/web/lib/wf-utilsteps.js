/**
 * wf-utilsteps.js
 * 
 * Manages workflow utility steps (Kore actions) configuration and caching
 * - Fetches utility step definitions from /kore/workflow-utils endpoint
 * - Caches results to minimize API calls
 * - Provides lookup functions for step properties and validation
 */

import '/lib/base.js';

// ============================================================================
// UTILITY STEPS STATE
// ============================================================================

let utilStepsCache = null;  // Cached array of all utility steps


// ============================================================================
// FETCH AND CACHE UTILITY STEPS
// ============================================================================

/**
 * Fetch all workflow utility steps from backend
 * Uses cache on subsequent calls
 * @returns {Promise<Array>} Array of utility step definitions
 */
async function fetchUtilSteps() {
    console.log('[fetchUtilSteps] Called');

    // Return from cache if already loaded
    if (utilStepsCache !== null) {
        console.log('[fetchUtilSteps] Returning cached util steps:', utilStepsCache.length, 'items');
        return utilStepsCache;
    }

    try {
        const sessionToken = window.sessionToken || getSessionTokenFromCookie();
        
        const response = await fetch('/kore/workflow-utils', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(sessionToken && { 'X-Session-Token': sessionToken })
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('[fetchUtilSteps] API error:', response.status, errorData.error);
            utilStepsCache = [];
            return [];
        }

        const data = await response.json();
        const utils = data.utils || [];

        console.log('[fetchUtilSteps] Loaded', utils.length, 'utility steps');

        // Cache the results
        utilStepsCache = utils;
        return utils;
    } catch (error) {
        console.error('[fetchUtilSteps] Error:', error.message);
        utilStepsCache = [];
        return [];
    }
}


// ============================================================================
// LOOKUP FUNCTIONS
// ============================================================================

/**
 * Get a specific utility step by action name
 * @param {string} actionName - The action_name to look up
 * @returns {Promise<Object|null>} The utility step definition or null if not found
 */
async function getUtilStep(actionName) {
    const utils = await fetchUtilSteps();
    return utils.find(u => u.action_name === actionName) || null;
}

/**
 * Get all utility steps in a specific category
 * @param {string} category - The category to filter by
 * @returns {Promise<Array>} Array of utility steps in that category
 */
async function getUtilStepsByCategory(category) {
    const utils = await fetchUtilSteps();
    return utils.filter(u => u.category === category);
}

/**
 * Get all available categories
 * @returns {Promise<Array>} Array of unique category names
 */
async function getUtilCategories() {
    const utils = await fetchUtilSteps();
    const categories = new Set(utils.map(u => u.category).filter(Boolean));
    return Array.from(categories).sort();
}

/**
 * Clear the cache (useful for refreshing after backend updates)
 */
function clearUtilStepsCache() {
    utilStepsCache = null;
    console.log('[clearUtilStepsCache] Cache cleared');
}


// ============================================================================
// WINDOW EXPORTS
// ============================================================================

window.fetchUtilSteps = fetchUtilSteps;
window.getUtilStep = getUtilStep;
window.getUtilStepsByCategory = getUtilStepsByCategory;
window.getUtilCategories = getUtilCategories;
window.clearUtilStepsCache = clearUtilStepsCache;

// Export cache for debugging
Object.defineProperty(window, 'utilStepsCache', {
    get: () => utilStepsCache,
    set: (val) => { utilStepsCache = val; }
});