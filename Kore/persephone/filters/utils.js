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
 * Supports: equalto, ne, lt, gt, le, ge, defined, undefined, none, string, number
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

// Export filter functions
module.exports = {
  is_empty,
  deep_eq,
  not_deep_eq,
  in_list,
  not_in_list,
  json,
  auto_json,
  default: default_filter,
  d: default_filter,
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
  batch
};