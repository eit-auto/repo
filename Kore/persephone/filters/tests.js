/**
 * Custom Nunjucks Tests
 *
 * Nunjucks tests are a separate registry from filters (env.addTest, not
 * env.addFilter) -- used by `is`/`is not` expressions and by the second
 * argument of selectattr/rejectattr/select/reject (e.g.
 * `selectattr('status', 'equalto', 'error')`, where 'equalto' names a test).
 *
 * Nunjucks ships a smaller built-in test set than Jinja2 -- confirmed no
 * custom tests were registered anywhere before this file existed, so only
 * Nunjucks' own defaults (callable, defined, divisibleby, escaped, equalto/eq,
 * even, falsy, ge, gt, le, lt, mapping, ne, null, number, odd, sameas, string,
 * truthy, undefined) were available. 'in' is a Jinja2-only test with no
 * Nunjucks equivalent -- calling selectattr(attr, 'in', [...]) against an
 * unregistered test name doesn't throw, it just evaluates falsy for every
 * item, silently filtering out everything regardless of real data. Confirmed
 * as a real production bug: a report's "Space Health Warnings" section never
 * showed anything, for any data, because of exactly this.
 *
 * This is unrelated to the `{% if x in [...] %}` / `{% if x not in [...] %}`
 * OPERATOR, which is a language-level construct handled by the parser and
 * works correctly regardless of anything in this file -- that's been used
 * successfully throughout the workflows built against this engine. Only
 * selectattr/rejectattr/select/reject's test-name argument needed this.
 *
 * Usage:
 *   const registerTests = require('./tests');
 *   const nunjucks = require('nunjucks');
 *   const env = nunjucks.configure();
 *   registerTests(env);
 */

/**
 * `in` test: mirrors Jinja2's `value is in container` semantics.
 * @param {*} value - The value to look for
 * @param {*} container - Array (membership), string (substring), or object (own key)
 * @returns {boolean}
 */
function inTest(value, container) {
    if (container == null) return false;
    if (Array.isArray(container)) return container.includes(value);
    if (typeof container === 'string') return container.includes(value);
    if (typeof container === 'object') return Object.prototype.hasOwnProperty.call(container, value);
    return false;
}

const customTests = {
    in: inTest
};

/**
 * Register all custom tests with a Nunjucks environment
 * @param {object} nunjucksEnv - Nunjucks environment instance
 * @returns {object} Summary of registered tests
 */
function registerTests(nunjucksEnv) {
    if (!nunjucksEnv) {
        throw new Error('Nunjucks environment is required');
    }

    const registered = { total: 0, failed: [] };

    Object.entries(customTests).forEach(([name, fn]) => {
        try {
            nunjucksEnv.addTest(name, fn);
            registered.total++;
        } catch (error) {
            registered.failed.push({ test: name, reason: error.message });
        }
    });

    return registered;
}

module.exports = registerTests;
module.exports.tests = customTests;
