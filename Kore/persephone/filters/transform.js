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
 * Convert value to boolean.
 * The string literals "true"/"false" (any case, e.g. "True", "FALSE") are
 * parsed as the boolean they name — this is the case that actually matters
 * for form-submitted values, where a checkbox/select often arrives as the
 * string "false" rather than a real boolean. Generic JS truthiness would get
 * this wrong: "false" is a non-empty string, so plain truthiness treats it as
 * true, silently inverting the user's actual choice.
 * Any other string falls back to generic truthiness (non-empty = true),
 * matching this filter's original, pre-existing behavior for non-boolean-ish
 * strings.
 * Other falsy values: false, 0, 0.0, '', null, undefined, empty arrays/objects.
 * @param {*} value - Value to convert
 * @returns {boolean} Boolean value
 */
function bool(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return value.length > 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Parse a JSON-formatted string into a real array/object, so it can be
 * looped over, indexed, or reshaped within the same template.
 * This is the inverse of | json / | auto_json (which serialize objects
 * to strings) - Rewst's | from_json_string equivalent, ported for parity
 * since real migrated Jinja relies on it (e.g. parsing a PowerShell
 * ConvertTo-JSON string result, or a plugin's raw JSON-string field).
 *
 * Non-string input passes through unchanged (already-parsed values,
 * e.g. from persephone.js's own post-render JSON.parse, are left alone
 * rather than double-parsed or errored on).
 *
 * Throws on invalid JSON rather than silently returning the original
 * string, matching this file's existing throw-on-bad-input filters
 * (as_timezone, now, etc.) - a silent fallback here would produce a
 * string where a template expects an array/object, and the resulting
 * "not iterable" or "cannot read property" failure would surface far
 * from the actual root cause.
 * @param {*} value - Value to parse
 * @returns {*} Parsed array/object, or the original value if not a string
 */
function from_json_string(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`from_json_string: ${error.message}`);
  }
}

/**
 * Escapes a value for safe embedding in a raw SQL string literal.
 * The `sqlquery` plugin task executes its `query` input completely verbatim
 * (confirmed: mysql2's connection.query(queryStr) is called with no params
 * array, no placeholders - zero parameterization or escaping happens at that
 * layer). Any dynamic value going into an INSERT/UPDATE's SQL text - a JSON
 * blob, an org name, anything user- or org-controlled that might contain a
 * literal single quote - must be escaped in the template itself before it
 * ever reaches that plugin, or a stray apostrophe breaks the query (or
 * worse, becomes an injection point).
 *
 * Mirrors base.js's existing browser-side `escapeSql` exactly (backslash
 * first, then single-quote doubling) for consistency across the codebase -
 * that function is window-scoped (browser-side, not requireable from
 * persephone.js), so this is the server/template-side equivalent.
 * @param {*} value - Value to escape (null/undefined become '')
 * @returns {string} SQL-string-literal-safe text
 */
function sql_escape(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''");
}

/**
 * Escapes a value for safe embedding in a PowerShell single-quoted string
 * literal ('...'). Unlike sql_escape, this does NOT double backslashes -
 * PowerShell single-quoted strings treat backslash as a completely literal,
 * inert character (no escape sequences at all), so doubling it would corrupt
 * a genuine UNC path or Windows file path if one appeared in the value.
 * Only the single quote itself needs escaping (doubled, '' represents one
 * literal '), the same convention as SQL string literals but for a
 * completely different underlying reason.
 *
 * Confirmed real bug this prevents: a remote-execution PowerShell command
 * embedded dynamic CSV content directly into a single-quoted string with no
 * escaping at all - a single literal apostrophe anywhere in that data (e.g.
 * an org name like "O'Brien's Auto") prematurely terminates the string,
 * and everything after it gets interpreted as PowerShell code instead of
 * string content, breaking the script before it reaches the line that
 * actually writes the file.
 * @param {*} value - Value to escape (null/undefined become '')
 * @returns {string} PowerShell-single-quoted-string-literal-safe text
 */
function ps_escape(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/'/g, "''");
}

/**
 * Converts a plain-text value into safe, readable HTML: escapes HTML special
 * characters first (&, <, >, ", ') so any literal markup-like characters in
 * the source text can't be misinterpreted as real HTML, then converts line
 * breaks to <br> so multi-line plain-text content (e.g. a Jinja-built
 * `| join('\n')` summary) actually renders with line breaks in an email/HTML
 * context instead of running together as one line, which a bare \n does not
 * do inside real HTML.
 *
 * Escaping happens BEFORE the <br> conversion specifically so the literal
 * `<br>` markup this filter inserts is never itself escaped - if the order
 * were reversed, the escape step would turn `<br>` into `&lt;br&gt;`, visibly
 * breaking the very thing this filter exists to produce.
 *
 * Handles \r\n, \r, and \n line-ending styles - confirmed real script log
 * messages use \r\n (Windows-style), not bare \n.
 * @param {*} value - Value to convert (null/undefined become '')
 * @returns {string} HTML-safe text with line breaks converted to <br>
 */
function to_html(value) {
  if (value === null || value === undefined) return '';
  const escaped = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  return escaped.replace(/\r\n|\r|\n/g, '<br>\n');
}

// Export all transform filters
module.exports = {
  int,
  float,
  str,
  bool,
  from_json_string,
  sql_escape,
  ps_escape,
  to_html
};