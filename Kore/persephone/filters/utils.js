/**
 * Utility Filters for Persephone
 * 
 * Miscellaneous utility filters for templating
 * 
 * Filters:
 *   - json()  - Convert value to formatted JSON string
 */

/**
 * Convert a value to a formatted JSON string
 * @param {any} value - Value to serialize (objects, arrays, primitives)
 * @returns {string} Formatted JSON string with 2-space indentation
 */
function json(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    throw new Error(`json: ${error.message}`);
  }
}

// Export filter functions
module.exports = {
  json
};