/**
 * DateTime Filters for Persephone
 * 
 * Provides Jinja2-compatible datetime filters using Luxon
 * 
 * Key principle: No implicit timezone conversion. All filters preserve the
 * timezone of the input. Only as_timezone() explicitly converts timezones.
 * When no timezone info is present in the input, UTC is assumed.
 * 
 * Filters:
 *   - as_timezone(tzName)           - Convert datetime to timezone (explicit only)
 *   - convert_from_epoch(unit)      - Convert epoch to UTC datetime
 *   - datedelta(unit, value)        - Add/subtract time, preserving input timezone
 *   - date_part()                   - Extract yyyy-MM-dd without timezone conversion
 *   - days_between(end)             - Whole days between two dates
 *   - format_datetime(format)       - Format datetime, preserving input timezone
 *   - parse_datetime(format)        - Parse datetime string, preserving timezone if present, else UTC
 *   - time_delta(unit, value)       - Alias for datedelta
 *   - now(tz, format)               - Current datetime in specified timezone
 */

const { DateTime, Duration } = require('luxon');

/**
 * Parse a string to a Luxon DateTime, preserving timezone if present, else UTC.
 * Internal helper used by all filters.
 */
function _parse(value) {
  if (value instanceof DateTime) return value;
  const str = String(value);
  const dt = DateTime.fromISO(str, { setZone: true });
  if (dt.isValid) return dt;
  return null;
}

/**
 * Convert a datetime to a specified timezone (explicit conversion only)
 */
function as_timezone(value, tzName) {
  try {
    const dt = _parse(value);
    if (!dt || !dt.isValid) throw new Error('Invalid datetime');
    return dt.setZone(tzName).toISO();
  } catch (error) {
    throw new Error(`as_timezone: ${error.message}`);
  }
}

/**
 * Convert an epoch timestamp to a UTC datetime string
 */
function convert_from_epoch(value, unit = 'seconds') {
  try {
    const timestamp = parseInt(value, 10);
    if (isNaN(timestamp)) throw new Error('Invalid epoch value');
    const dt = unit === 'milliseconds'
      ? DateTime.fromMillis(timestamp, { zone: 'UTC' })
      : DateTime.fromSeconds(timestamp, { zone: 'UTC' });
    if (!dt.isValid) throw new Error('Invalid datetime from epoch');
    return dt.toISO();
  } catch (error) {
    throw new Error(`convert_from_epoch: ${error.message}`);
  }
}

/**
 * Add or subtract time from a datetime, preserving input timezone
 */
function datedelta(value, unit, amount) {
  try {
    const dt = _parse(value);
    if (!dt || !dt.isValid) throw new Error('Invalid datetime');

    let dur = {};

    // Support keyword-style args: datedelta(days=6) or datedelta(hours=utc_offset)
    // Nunjucks passes keyword args as a plain object in the second positional argument
    if (unit !== null && typeof unit === 'object') {
      // datedelta(value, {days: 6}) or datedelta(value, {hours: utc_offset})
      const kwargs = unit;
      for (const [k, v] of Object.entries(kwargs)) {
        if (k !== '__keywords') {
          const parsed = parseFloat(v);
          if (!isNaN(parsed)) dur[k] = parsed;
        }
      }
    } else if (typeof unit === 'string' && amount !== undefined) {
      // Standard positional: datedelta(value, 'days', 6)
      dur[unit] = parseFloat(amount);
    } else {
      throw new Error('Invalid arguments: provide (unit, amount) or keyword args like days=6');
    }

    const result = dt.plus(dur);
    if (!result.isValid) throw new Error('Invalid result from datedelta');
    // Preserve the original zone — re-apply it after addition
    return result.setZone(dt.zone).toISO();
  } catch (error) {
    throw new Error(`datedelta: ${error.message}`);
  }
}

/**
 * Format a datetime using Luxon format tokens, preserving input timezone
 */
// strftime to Luxon token mapping
const STRFTIME_MAP = {
  '%Y': 'yyyy', '%y': 'yy',
  '%m': 'MM',   '%d': 'dd',
  '%H': 'HH',   '%I': 'hh',
  '%-H': 'H',   '%-I': 'h',   // no leading zero variants
  '%-m': 'M',   '%-d': 'd',   // no leading zero variants
  '%M': 'mm',   '%S': 'ss',
  '%-M': 'm',   '%-S': 's',   // no leading zero variants
  '%f': 'SSS',  '%p': 'a',    // %p = AM/PM uppercase
  '%P': 'a',                   // %P = am/pm (Luxon 'a' outputs lowercase by locale)
  '%A': 'cccc', '%a': 'ccc',
  '%B': 'MMMM', '%b': 'MMM',
  '%j': 'ooo',  '%Z': 'z',
  '%z': 'ZZ',   '%X': 'HH:mm:ss',
  '%x': 'MM/dd/yyyy', '%c': 'ccc MMM d HH:mm:ss yyyy',
  '%%': '%',
};

function strftimeToLuxon(fmt) {
  // Handle %-X (no leading zero) variants first, then standard tokens
  return fmt.replace(/%-[HIMSmd]|%[YymdHIMSfpPAaBbjZzXxc%]/g, token => STRFTIME_MAP[token] || token);
}

function format_datetime(value, format) {
  try {
    // Try _parse first (fast path for ISO strings), fall back to full parse_datetime logic
    let dt = _parse(value);
    if (!dt || !dt.isValid) {
      const parsed = parse_datetime(String(value));
      dt = DateTime.fromISO(parsed, { setZone: true });
    }
    if (!dt || !dt.isValid) throw new Error('Invalid datetime');
    if (!format) throw new Error('Format string is required');
    // Auto-convert strftime format strings to Luxon tokens
    const luxonFormat = format.includes('%') ? strftimeToLuxon(format) : format;
    return dt.toFormat(luxonFormat);
  } catch (error) {
    throw new Error(`format_datetime: ${error.message}`);
  }
}

/**
 * Parse a datetime string. Preserves timezone if present in input, assumes UTC if not.
 */
function parse_datetime(value, format = null) {
  try {
    if (!value) throw new Error('Value is required');
    const str = String(value);

    if (!format) {
      // Try fromISO first — preserves timezone if present (Z = UTC, offset = offset, no info = UTC)
      const isodt = DateTime.fromISO(str, { setZone: true });
      if (isodt.isValid) return isodt.toISO();

      const rfc = DateTime.fromRFC2822(str, { setZone: true });
      if (rfc.isValid) return rfc.toISO();

      const http = DateTime.fromHTTP(str, { setZone: true });
      if (http.isValid) return http.toISO();

      // Normalize single-digit month/day: "6/6/26" -> "06/06/26"
      const normalized = str.replace(
        /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(.*)/,
        (_, m, d, y, rest) => `${m.padStart(2,'0')}/${d.padStart(2,'0')}/${y}${rest}`
      );
      const normStr = normalized !== str ? normalized : str;

      // Format list — no timezone in these formats, so assume UTC
      const dateTimeFormats = [
        'yyyy-MM-dd HH:mm:ss.SSS',
        'yyyy-MM-dd HH:mm:ss',
        'yyyy/MM/dd HH:mm:ss',
        'MM/dd/yyyy HH:mm:ss',
        'MM/dd/yy HH:mm:ss',
        'dd/MM/yyyy HH:mm:ss',
        'dd/MM/yy HH:mm:ss',
        'MM-dd-yyyy HH:mm:ss',
        'MM-dd-yy HH:mm:ss',
        'MMMM d, yyyy h:mm a',
        'MMMM d, yyyy h:mma',
        'MMM d yyyy h:mm a',
        'MMM d yyyy h:mma',
      ];
      const dateOnlyFormats = [
        'yyyy-MM-dd',
        'yyyy/MM/dd',
        'MM/dd/yyyy',
        'MM/dd/yy',
        'dd/MM/yyyy',
        'dd/MM/yy',
        'MM-dd-yyyy',
        'MM-dd-yy',
        'dd-MM-yyyy',
        'dd-MM-yy',
        'MMMM d, yyyy',
        'MMM d, yyyy',
        'MMM d yyyy',
        'd MMM yyyy',
      ];

      // Time-only formats — added last to avoid conflicting with date formats
      // Date will default to today in UTC, which is acceptable for time-only values
      const timeOnlyFormats = [
        'h:mm a',    // 3:48 PM
        'h:mma',     // 3:48PM
        'hh:mm a',   // 03:48 PM
        'hh:mma',    // 03:48PM
        'HH:mm:ss',  // 15:48:00
        'H:mm:ss',   // 3:48:00
        'HH:mm',     // 15:48
        'H:mm',      // 3:48
      ];

      for (const fmt of [...dateTimeFormats, ...dateOnlyFormats, ...timeOnlyFormats]) {
        // Assume UTC for format-parsed dates (no timezone info in format)
        const dt = DateTime.fromFormat(normStr, fmt, { zone: 'UTC' });
        if (dt.isValid) return dt.toISO();
        if (normStr !== str) {
          const dt2 = DateTime.fromFormat(str, fmt, { zone: 'UTC' });
          if (dt2.isValid) return dt2.toISO();
        }
      }

      throw new Error(`Unable to parse "${value}" - try providing an explicit format string`);
    }

    // Explicit format — assume UTC if no timezone in format
    const dt = DateTime.fromFormat(str, format, { zone: 'UTC' });
    if (dt.isValid) return dt.toISO();

    // Fallback to ISO
    const isoFallback = DateTime.fromISO(str, { setZone: true });
    if (isoFallback.isValid) return isoFallback.toISO();

    throw new Error(`Unable to parse "${value}" with format "${format}"`);
  } catch (error) {
    throw new Error(`parse_datetime: ${error.message}`);
  }
}

/**
 * Alias for datedelta
 */
function time_delta(value, unit, amount) {
  return datedelta(value, unit, amount);
}

/**
 * Get the current datetime in a specified timezone
 */
function now(tz = 'UTC', format = null) {
  try {
    const dt = DateTime.now().setZone(tz);
    if (!dt.isValid) throw new Error('Invalid timezone');
    if (format) return dt.toFormat(format);
    return dt.toISO();
  } catch (error) {
    throw new Error(`now: ${error.message}`);
  }
}

/**
 * Get the number of whole days between two datetime strings (end - start)
 */
function days_between(start, end) {
  try {
    const dtStart = _parse(start);
    const dtEnd = _parse(end);
    if (!dtStart || !dtStart.isValid) throw new Error('Invalid start datetime');
    if (!dtEnd || !dtEnd.isValid) throw new Error('Invalid end datetime');
    // Normalize both to UTC before comparing dates to avoid cross-timezone day boundary issues
    return Math.round(dtEnd.toUTC().startOf('day').diff(dtStart.toUTC().startOf('day'), 'days').days);
  } catch (error) {
    throw new Error(`days_between: ${error.message}`);
  }
}

/**
 * Signed difference in hours between two datetime values (end - start), as
 * a float. The one duration primitive this engine has never had: subtracting
 * two parse_datetime results directly (`t1 - t2`) always produces NaN,
 * because parse_datetime returns a plain ISO string (`.toISO()`), not a
 * Luxon DateTime object -- so `-` coerces both to Number(), which has no
 * meaningful value for a date string. days_between is the closest existing
 * filter, but it only returns whole, start-of-day-rounded days, with no
 * hour-level precision -- useless for an "X hours ago" message. Confirmed
 * real bug this fixes: every "Last <job> N hours ago" message across the
 * daily backup report (data_spx/data_repl/data_ver/data_ret/data_cons) was
 * silently showing "0 hours ago" regardless of actual elapsed time, because
 * the ported Jinja assumed Python's timedelta string-subtraction behavior,
 * which has no equivalent here.
 * @param {*} start - Start datetime (string or DateTime)
 * @param {*} end - End datetime (string or DateTime)
 * @returns {number} end - start, in hours (negative if end is before start)
 */
function diff_hours(start, end) {
  try {
    const dtStart = _parse(start);
    const dtEnd = _parse(end);
    if (!dtStart || !dtStart.isValid) throw new Error('Invalid start datetime');
    if (!dtEnd || !dtEnd.isValid) throw new Error('Invalid end datetime');
    return dtEnd.diff(dtStart, 'hours').hours;
  } catch (error) {
    throw new Error(`diff_hours: ${error.message}`);
  }
}

/**
 * Extract just the date portion (yyyy-MM-dd) without timezone conversion.
 * If input has timezone info, uses that. If not, treats as UTC.
 */
function date_part(value) {
  try {
    if (!value) throw new Error('Value is required');
    const str = String(value);
    // Fast path: already starts with yyyy-MM-dd
    const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];
    // Parse preserving timezone, then format date only
    const dt = _parse(str);
    if (dt && dt.isValid) return dt.toFormat('yyyy-MM-dd');
    // Try full parse_datetime as fallback
    const parsed = parse_datetime(str);
    return parsed.substring(0, 10);
  } catch (error) {
    throw new Error(`date_part: ${error.message}`);
  }
}

module.exports = {
  as_timezone,
  convert_from_epoch,
  datedelta,
  date_part,
  days_between,
  diff_hours,
  format_datetime,
  parse_datetime,
  time_delta,
  now
};