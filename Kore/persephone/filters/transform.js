/**
 * Transform Filters for Persephone
 * 
 * Provides type conversion and transformation filters compatible with Rewst Jinja
 * 
 * Filters:
 *   - int(value)           - Convert value to integer (non-numeric becomes 0)
 *   - float(value)         - Convert value to float (non-numeric becomes 0.0)
 *   - str(value)           - Convert value to string
 *   - bool(value)          - Convert value to boolean
 */

/**
 * Convert value to integer
 * Non-numeric strings return 0 (Rewst behavior)
 * @param {*} value - Value to convert
 * @returns {number} Integer value
 */
function int(value) {
  if (value === null || value === undefined) return 0;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Convert value to float
 * Non-numeric strings return 0.0 (Rewst behavior)
 * @param {*} value - Value to convert
 * @returns {number} Float value
 */
function float(value) {
  if (value === null || value === undefined) return 0.0;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? 0.0 : parsed;
}

/**
 * Convert value to string
 * @param {*} value - Value to convert
 * @returns {string} String representation
 */
function str(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Convert value to boolean
 * Falsy values: false, 0, 0.0, '', null, undefined, empty arrays/objects
 * @param {*} value - Value to convert
 * @returns {boolean} Boolean value
 */
function bool(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

// Export all transform filters
module.exports = {
  int,
  float,
  str,
  bool
};