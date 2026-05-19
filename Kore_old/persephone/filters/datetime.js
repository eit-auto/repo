/**
 * DateTime Filters for Persephone
 * 
 * Provides Jinja2-compatible datetime filters using Luxon
 * 
 * Filters:
 *   - as_timezone(tzName)           - Convert datetime to timezone
 *   - convert_from_epoch(unit)      - Convert epoch to datetime
 *   - datedelta(unit, value)        - Add/subtract time from datetime
 *   - format_datetime(format)       - Format datetime with Luxon tokens
 *   - parse_datetime(format)        - Parse datetime string with format
 *   - time_delta(unit, value)       - Add duration to datetime
 */

const { DateTime, Duration } = require('luxon');

/**
 * Convert a datetime to a specified timezone
 * @param {string|DateTime} value - ISO datetime string or DateTime object
 * @param {string} tzName - Timezone name (e.g., 'America/New_York', 'UTC', 'Europe/London')
 * @returns {string} Formatted datetime in target timezone
 */
function as_timezone(value, tzName) {
  try {
    const dt = typeof value === 'string' ? DateTime.fromISO(value) : value;
    if (!dt.isValid) throw new Error('Invalid datetime');
    return dt.setZone(tzName).toISO();
  } catch (error) {
    throw new Error(`as_timezone: ${error.message}`);
  }
}

/**
 * Convert an epoch timestamp to a datetime string
 * @param {number|string} value - Epoch timestamp (seconds or milliseconds)
 * @param {string} unit - 'seconds' or 'milliseconds' (default: 'seconds')
 * @returns {string} ISO 8601 formatted datetime
 */
function convert_from_epoch(value, unit = 'seconds') {
  try {
    const timestamp = parseInt(value, 10);
    if (isNaN(timestamp)) throw new Error('Invalid epoch value');
    
    const dt = unit === 'milliseconds' 
      ? DateTime.fromMillis(timestamp)
      : DateTime.fromSeconds(timestamp);
    
    if (!dt.isValid) throw new Error('Invalid datetime from epoch');
    return dt.toISO();
  } catch (error) {
    throw new Error(`convert_from_epoch: ${error.message}`);
  }
}

/**
 * Add or subtract time from a datetime
 * @param {string|DateTime} value - ISO datetime string or DateTime object
 * @param {string} unit - Time unit ('years', 'months', 'days', 'hours', 'minutes', 'seconds')
 * @param {number} amount - Amount to add (negative to subtract)
 * @returns {string} Modified datetime as ISO string
 */
function datedelta(value, unit, amount) {
  try {
    const dt = typeof value === 'string' ? DateTime.fromISO(value) : value;
    if (!dt.isValid) throw new Error('Invalid datetime');
    
    const dur = {};
    dur[unit] = parseInt(amount, 10);
    
    const result = dt.plus(dur);
    if (!result.isValid) throw new Error('Invalid result from datedelta');
    return result.toISO();
  } catch (error) {
    throw new Error(`datedelta: ${error.message}`);
  }
}

/**
 * Format a datetime using Luxon format tokens
 * @param {string|DateTime} value - ISO datetime string or DateTime object
 * @param {string} format - Luxon format string (e.g., 'yyyy-MM-dd HH:mm:ss', 'DDD')
 * @returns {string} Formatted datetime string
 */
function format_datetime(value, format) {
  try {
    const dt = typeof value === 'string' ? DateTime.fromISO(value) : value;
    if (!dt.isValid) throw new Error('Invalid datetime');
    
    if (!format) throw new Error('Format string is required');
    return dt.toFormat(format);
  } catch (error) {
    throw new Error(`format_datetime: ${error.message}`);
  }
}

/**
 * Parse a datetime string with a specified format
 * @param {string} value - Datetime string to parse
 * @param {string} format - Luxon format string used to parse (e.g., 'yyyy-MM-dd HH:mm:ss')
 * @returns {string} Parsed datetime as ISO string
 */
function parse_datetime(value, format) {
  try {
    if (!value || !format) throw new Error('Value and format are required');
    
    const dt = DateTime.fromFormat(value, format);
    if (!dt.isValid) throw new Error(`Unable to parse "${value}" with format "${format}"`);
    return dt.toISO();
  } catch (error) {
    throw new Error(`parse_datetime: ${error.message}`);
  }
}

/**
 * Add a duration to a datetime (alias for datedelta with cleaner API)
 * @param {string|DateTime} value - ISO datetime string or DateTime object
 * @param {string} unit - Time unit ('years', 'months', 'days', 'hours', 'minutes', 'seconds')
 * @param {number} amount - Amount to add (negative to subtract)
 * @returns {string} Modified datetime as ISO string
 */
function time_delta(value, unit, amount) {
  // time_delta is essentially the same as datedelta
  return datedelta(value, unit, amount);
}

// Export all filter functions
module.exports = {
  as_timezone,
  convert_from_epoch,
  datedelta,
  format_datetime,
  parse_datetime,
  time_delta
};