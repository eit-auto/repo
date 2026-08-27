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

/**
 * Default filter — returns defaultValue if value is null or undefined.
 * Mirrors Jinja2's | d / | default behavior, but defaults to null when no argument given.
 * Usage: {{ CTX.foo | d }}          -> null if foo is undefined
 *        {{ CTX.foo | d('N/A') }}   -> 'N/A' if foo is undefined
 *        {{ CTX.foo | d(0) }}       -> 0 if foo is undefined
 * @param {any} value - The value to check
 * @param {any} defaultValue - Value to return if null/undefined (default: null)
 * @param {boolean} boolean - If true, also return defaultValue for falsy values
 * @returns {any} value or defaultValue
 */
function default_filter(value, defaultValue, boolean = false) {
  if (defaultValue === undefined) defaultValue = null;
  if (value === null || value === undefined) return defaultValue;
  if (boolean && !value) return defaultValue;
  return value;
}

/**
 * Null-safe override of Nunjucks' native `string` filter.
 *
 * Nunjucks' own `string` filter (filters.js: `function string(obj) { return
 * copySafeness(obj, obj); }`) is NOT null-safe -- copySafeness's fallback path
 * (runtime.js) unconditionally calls `target.toString()` with no null/undefined
 * check, so `null | string` throws "Cannot read properties of null (reading
 * 'toString')" instead of returning a usable value. Confirmed via a real stack
 * trace: Object.copySafeness (runtime.js:166) <- Context.string (filters.js:407).
 *
 * This overrides that gap the same way default_filter above already overrides
 * `d`/`default` -- registered directly (bypasses the nunjucks-core skip in the
 * registry-driven loader), so it takes precedence over the native filter for
 * every template, present and future, without needing a per-template
 * defensive `| d('', true)` guard before every `| string` call.
 *
 * Real trigger case: joining two records by an ID field that's legitimately
 * null on some records (e.g. a computer with no CWA match) --
 * `a.some_id | string == b.some_id | string` -- crashed the whole template
 * whenever either side was null, even though the `==` comparison itself would
 * have handled it fine once each side was safely stringified.
 *
 * @param {any} value - Value to convert to a string
 * @returns {string} String representation; '' for null/undefined
 */
function string(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Split a string by a delimiter
 * @param {string} value - String to split
 * @param {string} delimiter - Delimiter to split on
 * @returns {Array} Array of substrings
 */
function split(value, delimiter = '') {
  if (value === null || value === undefined) return [];
  return String(value).split(delimiter);
}

/**
 * Like | json but only serializes objects/arrays — passes strings and primitives through unchanged.
 * Used internally by Persephone for solo expression auto-serialization.
 */
function auto_json(value) {
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return value;
}

/**
 * Datetime-aware comparison filters.
 * Compare two values — if both look like ISO datetime strings, compare chronologically.
 * Otherwise fall back to standard JS comparison.
 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function _cmpVal(a, b) {
  if (ISO_RE.test(String(a)) && ISO_RE.test(String(b))) {
    return new Date(a).getTime() - new Date(b).getTime();
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function gte(value, other) { return _cmpVal(value, other) >= 0; }
function lte(value, other) { return _cmpVal(value, other) <= 0; }
function gt(value, other)  { return _cmpVal(value, other) > 0; }
function lt(value, other)  { return _cmpVal(value, other) < 0; }

/**
 * Reject items from a list where the specified attribute is empty (null, undefined, or empty array)
 * Usage: {{ items | reject_empty('entries') }}
 */
function reject_empty(arr, attr) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter(item => {
    const val = item[attr];
    if (val === null || val === undefined) return false;
    if (Array.isArray(val) && val.length === 0) return false;
    if (val === '') return false;
    return true;
  });
}

/**
 * Working replacement for Nunjucks' broken rejectattr/selectattr with equalto.
 * select_where: keep items where attr equals value
 * reject_where: remove items where attr equals value
 */
function select_where(arr, attr, value) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter(item => {
    const val = item[attr];
    if (value === null || value === undefined) return val === null || val === undefined;
    if (Array.isArray(value)) return Array.isArray(val) && val.length === value.length;
    return val === value;
  });
}

function reject_where(arr, attr, value) {
  if (!Array.isArray(arr)) return arr;
  return select_where(arr, attr, value).length === arr.length ? [] :
    arr.filter(item => {
      const val = item[attr];
      if (value === null || value === undefined) return !(val === null || val === undefined);
      if (Array.isArray(value)) return !(Array.isArray(val) && val.length === value.length);
      return val !== value;
    });
}

/**
 * Override Nunjucks' broken rejectattr/selectattr with equalto test.
 * Supports: equalto, ne, lt, gt, le, ge, defined, undefined, none, string, number, in
 *
 * This is a hardcoded dispatch, not a lookup against Nunjucks' own test registry
 * (env.getTest()/env.addTest()) -- confirmed the hard way: registering a custom
 * Nunjucks test named 'in' (via env.addTest, in a separate filters/tests.js) made
 * `value is in([...])` work correctly everywhere, but had zero effect on
 * `selectattr(arr, attr, 'in', [...])`, because this function never consults that
 * registry at all -- it falls through to the `default: return val === value` case
 * for any test name not explicitly listed below, which compares the item's value
 * directly against the whole array argument (e.g. `item.status === ['error','warning']`),
 * always false. That was a real, confirmed production bug: a report's "Space
 * Health Warnings" section never showed anything, for any data, because of
 * exactly this. 'in' needs to be a case here, in this switch, to actually affect
 * selectattr/rejectattr -- adding it as a Nunjucks-level test only ever fixes the
 * `is`/`is not` operator form, a separate code path entirely.
 *
 * Reuses in_list's own JSON.stringify-based membership check (defined further
 * below in this same file -- function declarations are hoisted, so the forward
 * reference here is fine) rather than a plain .includes(), for consistency with
 * the existing `| in_list(...)` filter and to correctly handle object/array
 * members, not just primitives.
 */
function _attrTest(val, test, value) {
  switch (test) {
    case 'equalto':
    case '==':
      if (value === null || value === undefined) return val === null || val === undefined;
      if (Array.isArray(value)) return Array.isArray(val) && JSON.stringify(val) === JSON.stringify(value);
      return val === value;
    case 'ne':
    case '!=':   return !_attrTest(val, 'equalto', value);
    case 'lt':
    case 'lessthan':    return val < value;
    case 'gt':
    case 'greaterthan': return val > value;
    case 'le':   return val <= value;
    case 'ge':   return val >= value;
    case 'defined':     return val !== undefined;
    case 'undefined':   return val === undefined;
    case 'none':        return val === null || val === undefined;
    case 'string':      return typeof val === 'string';
    case 'number':      return typeof val === 'number';
    case 'iterable':    return val !== null && typeof val[Symbol.iterator] === 'function';
    case 'odd':         return val % 2 !== 0;
    case 'even':        return val % 2 === 0;
    case 'in':          return in_list(val, value);
    default:            return val === value;
  }
}

function selectattr(arr, attr, test, value) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter(item => _attrTest(item[attr], test, value));
}

function rejectattr(arr, attr, test, value) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter(item => !_attrTest(item[attr], test, value));
}

/**
 * Map filter - extract an attribute from each item in a list, or apply a transformation.
 * Usage: {{ items | map(attribute='id') | list }}
 *        {{ items | map(attribute='name') | list }}
 */
function map(arr, kwargs) {
  if (!Array.isArray(arr)) return arr;
  // Handle keyword arg style: map(attribute='id')
  if (kwargs && typeof kwargs === 'object' && kwargs.attribute) {
    return arr.map(item => {
      // Support nested attributes like 'user.name'
      return kwargs.attribute.split('.').reduce((obj, key) => 
        obj !== null && obj !== undefined ? obj[key] : undefined, item);
    });
  }
  return arr;
}

/**
 * Unique filter - return only unique values from a list.
 * Usage: {{ items | unique | list }}
 *        {{ items | unique(attribute='id') | list }}
 */
function unique(arr, kwargs) {
  if (!Array.isArray(arr)) return arr;
  if (kwargs && typeof kwargs === 'object' && kwargs.attribute) {
    const seen = new Set();
    return arr.filter(item => {
      const val = kwargs.attribute.split('.').reduce((obj, key) =>
        obj !== null && obj !== undefined ? obj[key] : undefined, item);
      const key = JSON.stringify(val);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const seen = new Set();
  return arr.filter(item => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * max - return the maximum value from a list, optionally by attribute
 */
function max(arr, kwargs) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (kwargs && typeof kwargs === 'object' && kwargs.attribute) {
    const attr = kwargs.attribute;
    return arr.reduce((best, item) => {
      const val = attr.split('.').reduce((o, k) => o?.[k], item);
      const bestVal = attr.split('.').reduce((o, k) => o?.[k], best);
      return val > bestVal ? item : best;
    });
  }
  return arr.reduce((a, b) => a > b ? a : b);
}

/**
 * min - return the minimum value from a list, optionally by attribute
 */
function min(arr, kwargs) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (kwargs && typeof kwargs === 'object' && kwargs.attribute) {
    const attr = kwargs.attribute;
    return arr.reduce((best, item) => {
      const val = attr.split('.').reduce((o, k) => o?.[k], item);
      const bestVal = attr.split('.').reduce((o, k) => o?.[k], best);
      return val < bestVal ? item : best;
    });
  }
  return arr.reduce((a, b) => a < b ? a : b);
}

/**
 * sum - sum values in a list, optionally by attribute
 */
function sum(arr, kwargs) {
  if (!Array.isArray(arr)) return 0;
  if (kwargs && typeof kwargs === 'object' && kwargs.attribute) {
    const attr = kwargs.attribute;
    return arr.reduce((total, item) => {
      const val = attr.split('.').reduce((o, k) => o?.[k], item);
      return total + (parseFloat(val) || 0);
    }, 0);
  }
  return arr.reduce((total, item) => total + (parseFloat(item) || 0), 0);
}

/**
 * groupby - group a list of objects by an attribute
 */
function groupby(arr, attr) {
  if (!Array.isArray(arr)) return [];
  const groups = {};
  const order = [];
  arr.forEach(item => {
    const key = attr.split('.').reduce((o, k) => o?.[k], item);
    const keyStr = String(key);
    if (!groups[keyStr]) {
      groups[keyStr] = { grouper: key, list: [] };
      order.push(keyStr);
    }
    groups[keyStr].list.push(item);
  });
  return order.map(k => groups[k]);
}

/**
 * dictsort - sort a dict/object by key or value
 */
function dictsort(obj, caseSensitive = false, by = 'key') {
  if (!obj || typeof obj !== 'object') return [];
  const entries = Object.entries(obj);
  return entries.sort((a, b) => {
    const aVal = by === 'value' ? a[1] : a[0];
    const bVal = by === 'value' ? b[1] : b[0];
    const aStr = caseSensitive ? String(aVal) : String(aVal).toLowerCase();
    const bStr = caseSensitive ? String(bVal) : String(bVal).toLowerCase();
    return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
  });
}

/**
 * batch - slice a list into batches of n items
 */
function batch(arr, n, fill = null) {
  if (!Array.isArray(arr)) return [];
  const batches = [];
  for (let i = 0; i < arr.length; i += n) {
    const batch = arr.slice(i, i + n);
    if (fill !== null) {
      while (batch.length < n) batch.push(fill);
    }
    batches.push(batch);
  }
  return batches;
}

/**
 * Sort filter - sort a list, optionally by attribute. Overrides broken nunjucks-core sort.
 * Usage: {{ items | sort }}
 *        {{ items | sort(attribute='timeStart') }}
 *        {{ items | sort(reverse=true, attribute='timeStart') }}
 */
function sort(arr, kwargs) {
  if (!Array.isArray(arr)) return arr;
  const copy = [...arr];
  const attr = kwargs && typeof kwargs === 'object' ? kwargs.attribute : null;
  const reverse = kwargs && typeof kwargs === 'object' ? kwargs.reverse : false;
  const caseSensitive = kwargs && typeof kwargs === 'object' ? kwargs.case_sensitive : false;

  copy.sort((a, b) => {
    let aVal = attr ? attr.split('.').reduce((o, k) => o?.[k], a) : a;
    let bVal = attr ? attr.split('.').reduce((o, k) => o?.[k], b) : b;

    // Case-insensitive string comparison
    if (typeof aVal === 'string' && typeof bVal === 'string' && !caseSensitive) {
      aVal = aVal.toLowerCase();
      bVal = bVal.toLowerCase();
    }

    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
    return 0;
  });

  return reverse ? copy.reverse() : copy;
}

/**
 * Count filter - alias for length
 */
function count(value) {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'object') return Object.keys(value).length;
  return 0;
}

/**
 * is_empty - returns true for "", [], {}, null, undefined
 * Intentionally does NOT treat 0 or false as empty.
 * Usage: {% if CTX.errors_html | is_empty %}
 */
function is_empty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * deep_eq - deep equality comparison using JSON.stringify
 * Used by preprocessor to rewrite == [] and == {} comparisons
 * Usage: {{ CTX.foo | deep_eq([]) }}
 */
function deep_eq(value, other) {
  try {
    return JSON.stringify(value) === JSON.stringify(other);
  } catch (e) {
    return false;
  }
}

/**
 * in_list - proper list membership check using deep equality
 * Used by preprocessor to rewrite "x in [[], ...]" comparisons
 * Usage: {{ CTX.foo | in_list([[], '', none]) }}
 */
function in_list(value, list) {
  if (!Array.isArray(list)) return false;
  const valStr = JSON.stringify(value);
  return list.some(item => JSON.stringify(item) === valStr);
}

/**
 * not_deep_eq - inverse of deep_eq, for use with != [] and != {} rewrites
 */
function not_deep_eq(value, other) {
  return !deep_eq(value, other);
}

/**
 * not_in_list - inverse of in_list, for use with "not in" rewrites
 * Usage: {{ CTX.foo | not_in_list([[], '', none]) }}
 */
function not_in_list(value, list) {
  return !in_list(value, list);
}

/**
 * Tests whether a value matches a regular expression pattern.
 *
 * Rewst-compatibility filter. Rewst's own Jinja environment ships a
 * regex_match(value, pattern) global that Kore never had an equivalent
 * for — confirmed genuinely absent under both function-call syntax
 * (`{% if regex_match(CTX.x, pattern) %}` — throws a misleading
 * "X was not found", since the error-line variable-name heuristic
 * mistakes the unrecognized function name for an undefined variable)
 * and filter syntax (`{{ CTX.x | regex_match(pattern) }}` — throws a
 * clean "Unknown filter: regex_match") during a real migration. This is
 * NOT standard Jinja2 either — vanilla Jinja2 has no built-in regex
 * filter/test/global at all; each embedding tool bolts its own on
 * (Ansible ships regex_search/regex_replace under the same idea), so
 * Kore needs its own rather than assuming one carries over from Rewst.
 *
 * Registered as a FILTER (`value | regex_match(pattern)`), consistent
 * with every other addition in this codebase except `now` (the one
 * deliberate global, added via env.addGlobal rather than env.addFilter).
 * Ported Rewst templates using the old `regex_match(value, pattern)`
 * function-call form need rewriting to filter syntax — the two are not
 * interchangeable here.
 *
 * A boolean test on a value, not a type conversion — lives alongside
 * is_empty/deep_eq/in_list above rather than in transform.js.
 *
 * Pattern is JS RegExp syntax (effectively PCRE), not Python's `re`
 * module — most simple patterns (`\d`, `\w`, `{n,m}`, character
 * classes) are identical between the two, but don't assume full parity
 * for anything more exotic (named groups, lookbehind support varies,
 * etc.) without testing the specific pattern being ported.
 *
 * @param {*} value - Value to test. null/undefined are coerced to ''
 *   (so the pattern simply fails to match) rather than thrown — a
 *   missing value is a legitimate "no match" case, not an error,
 *   matching the null-safe convention used by is_empty/in_list above.
 * @param {string} pattern - Regular expression source. Required — a
 *   missing/empty pattern throws rather than silently matching
 *   everything or nothing, since that's almost certainly a template bug.
 * @param {string} [flags=''] - Optional JS RegExp flags (e.g. 'i' for
 *   case-insensitive matching). 'g' has no effect on a boolean test.
 * @returns {boolean} true if the pattern matches anywhere in the string
 * @throws {Error} if pattern is missing or not a valid regular
 *   expression — a bad pattern is a template-author bug that should
 *   surface clearly, the same convention transform.js's
 *   from_json_string uses for invalid JSON rather than silently
 *   returning false.
 */
function regex_match(value, pattern, flags = '') {
  if (pattern === null || pattern === undefined || pattern === '') {
    throw new Error('regex_match: pattern is required');
  }
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`regex_match: invalid pattern "${pattern}": ${error.message}`);
  }
  const str = value === null || value === undefined ? '' : String(value);
  return re.test(str);
}

/**
 * regex_extract_all - returns every full match of a pattern within a string, as an
 * array. Unlike regex_match (which only returns true/false), this actually pulls the
 * matched text out - the missing piece needed to parse a string containing repeated,
 * structurally-identical chunks (e.g. every <ScriptSteps>...</ScriptSteps> block in an
 * XML document) without a dedicated XML parser.
 *
 * The 'g' flag is added automatically if the caller's flags don't already include it -
 * without it, String.prototype.match only returns the first match, which is almost
 * never what "extract all" implies.
 *
 * Usage: {{ CTX.xml_text | regex_extract_all('<ScriptSteps>[\\s\\S]*?<\\/ScriptSteps>') }}
 *   -> ['<ScriptSteps>...</ScriptSteps>', '<ScriptSteps>...</ScriptSteps>', ...]
 *
 * @param {*} value - Value to search. null/undefined are coerced to '' (so the
 *   pattern simply finds nothing) rather than thrown.
 * @param {string} pattern - Regular expression source. Required - a missing/empty
 *   pattern throws, matching regex_match's convention.
 * @param {string} [flags=''] - Optional JS RegExp flags. 'g' is added automatically
 *   if not already present.
 * @returns {string[]} Array of every matched substring, in order. Empty array if
 *   nothing matches (not an error - no match is a legitimate outcome).
 * @throws {Error} if pattern is missing or not a valid regular expression.
 */
function regex_extract_all(value, pattern, flags = '') {
  if (pattern === null || pattern === undefined || pattern === '') {
    throw new Error('regex_extract_all: pattern is required');
  }
  let re;
  try {
    const normalizedFlags = flags.includes('g') ? flags : flags + 'g';
    re = new RegExp(pattern, normalizedFlags);
  } catch (error) {
    throw new Error(`regex_extract_all: invalid pattern "${pattern}": ${error.message}`);
  }
  const str = value === null || value === undefined ? '' : String(value);
  return str.match(re) || [];
}

/**
 * regex_groups - matches a pattern against a string ONCE and returns its capture
 * groups as an array, in order. Pairs naturally with regex_extract_all: extract every
 * repeated chunk first, then loop over them calling regex_groups on each one to pull
 * out several named fields from a single chunk in one pass, instead of one
 * regex_match call per field.
 *
 * A capture group that matched but captured nothing (e.g. an alternation branch that
 * didn't participate, common when a pattern accounts for a self-closing tag like
 * <Param2 /> alongside <Param2>value</Param2>) comes back as '' rather than
 * JavaScript's native undefined, so a template can safely use the result directly
 * without an extra | d('') on every field.
 *
 * Usage: {% set groups = block | regex_groups('<Action>([\\s\\S]*?)<\\/Action><FunctionId>([\\s\\S]*?)<\\/FunctionId>') %}
 *   {{ groups[0] }} -> Action value, {{ groups[1] }} -> FunctionId value
 *
 * @param {*} value - Value to match against. null/undefined coerced to ''.
 * @param {string} pattern - Regular expression source with one or more capture
 *   groups. Required.
 * @param {string} [flags=''] - Optional JS RegExp flags. Unlike regex_extract_all,
 *   'g' is NOT added - only the first match is used, since this filter is meant to
 *   run per-chunk on already-isolated text, not to scan for repeats.
 * @returns {string[]|null} Array of captured group values (index order, one entry
 *   per capture group), or null if the pattern didn't match at all.
 * @throws {Error} if pattern is missing or not a valid regular expression.
 */
function regex_groups(value, pattern, flags = '') {
  if (pattern === null || pattern === undefined || pattern === '') {
    throw new Error('regex_groups: pattern is required');
  }
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`regex_groups: invalid pattern "${pattern}": ${error.message}`);
  }
  const str = value === null || value === undefined ? '' : String(value);
  const match = str.match(re);
  if (!match) return null;
  return match.slice(1).map((g) => (g === undefined ? '' : g));
}

/**
 * xml_unescape - decodes the five predefined XML/HTML entities (&lt; &gt; &amp;
 * &quot; &apos;) back to their literal characters. The inverse of the standard
 * `escape`/`e` filter. Generic text-processing utility - useful anywhere
 * XML- or HTML-escaped content needs to be read back as plain text, not tied to
 * any one data source.
 *
 * Order matters: &amp; is decoded LAST, so an entity like &amp;lt; (a literal
 * "&lt;" that was itself escaped) correctly becomes &lt; rather than being
 * double-unescaped into <.
 *
 * @param {*} value - Value to unescape. null/undefined become ''.
 * @returns {string} Text with XML entities decoded to literal characters.
 */
function xml_unescape(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * merge_dict - returns a NEW object combining base and updates (updates win on conflict).
 * This is the object-side equivalent of Array.prototype.concat used for the .append()
 * rewrite: since plain JS objects have no native in-place .update() the way Python
 * dicts do, this filter + the paired preprocessor rewrite (see persephone.js
 * preprocessTemplate) let {% do obj.update({...}) %} work the same way
 * {% do list.append(x) %} already does - by reassigning via {% set %} to a
 * freshly-merged object rather than actually mutating in place.
 * Usage: {{ obj | merge_dict({'key': 'value'}) }}
 */
function merge_dict(obj, updates) {
  if (obj === null || typeof obj !== 'object') obj = {};
  if (updates === null || typeof updates !== 'object') updates = {};
  return Object.assign({}, obj, updates);
}

// Export filter functions
module.exports = {
  is_empty,
  deep_eq,
  not_deep_eq,
  in_list,
  not_in_list,
  regex_match,
  regex_extract_all,
  regex_groups,
  xml_unescape,
  json,
  auto_json,
  default: default_filter,
  d: default_filter,
  string,
  split,
  gte, lte, gt, lt,
  reject_empty,
  select_where,
  reject_where,
  selectattr,
  rejectattr,
  map,
  unique,
  sort,
  count,
  max,
  min,
  sum,
  groupby,
  dictsort,
  batch,
  merge_dict
};