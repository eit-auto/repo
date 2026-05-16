/**
 * Filter Registration Module
 * 
 * Dynamically loads and registers all custom filters with Nunjucks
 * based on filter definitions in jinja-filters.json
 * 
 * Usage:
 *   const registerFilters = require('./filters');
 *   const nunjucks = require('nunjucks');
 *   const env = nunjucks.configure();
 *   registerFilters(env);
 */

const fs = require('fs');
const path = require('path');

/**
 * Register all custom filters with a Nunjucks environment
 * @param {object} nunjucksEnv - Nunjucks environment instance
 * @returns {object} Summary of registered filters
 */
function registerFilters(nunjucksEnv) {
  if (!nunjucksEnv) {
    throw new Error('Nunjucks environment is required');
  }

  const filterDefs = loadFilterDefinitions();
  const registered = {
    total: 0,
    custom: 0,
    nunjucksCore: 0,
    failed: []
  };

  filterDefs.filters.forEach(filterDef => {
    // Skip nunjucks-core filters (they're already available)
    if (filterDef.source === 'nunjucks-core') {
      registered.nunjucksCore++;
      return;
    }

    // Load and register custom filters
    try {
      const filterImpl = loadFilterImplementation(filterDef.source);
      
      if (filterImpl && typeof filterImpl[filterDef.name] === 'function') {
        nunjucksEnv.addFilter(filterDef.name, filterImpl[filterDef.name]);
        registered.custom++;
        registered.total++;
      } else {
        registered.failed.push({
          filter: filterDef.name,
          reason: `Implementation not found or not a function in ${filterDef.source}`
        });
      }
    } catch (error) {
      registered.failed.push({
        filter: filterDef.name,
        reason: error.message
      });
    }
  });

  registered.total = registered.custom + registered.nunjucksCore;

  return registered;
}

/**
 * Load filter definitions from jinja-filters.json
 * @returns {object} Filter definitions object
 */
function loadFilterDefinitions() {
  try {
    const jsonPath = path.join(__dirname, 'jinja-filters.json');
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(rawData);
  } catch (error) {
    throw new Error(`Failed to load filter definitions: ${error.message}`);
  }
}

/**
 * Load a filter implementation module
 * @param {string} source - Source path (e.g., 'datetime.js', not 'filters/datetime.js')
 * @returns {object} Exported filter functions
 */
function loadFilterImplementation(source) {
  try {
    // Resolve path relative to this file's directory
    // source is already relative to filters/ (e.g., 'datetime.js')
    const fullPath = path.join(__dirname, source);
    
    // Clear require cache to get fresh module
    delete require.cache[require.resolve(fullPath)];
    
    return require(fullPath);
  } catch (error) {
    throw new Error(`Failed to load filter implementation from ${source}: ${error.message}`);
  }
}

/**
 * Get a list of all registered custom filter names
 * @returns {array} Filter names
 */
function getCustomFilterNames() {
  const filterDefs = loadFilterDefinitions();
  return filterDefs.filters
    .filter(f => f.source !== 'nunjucks-core')
    .map(f => f.name)
    .sort();
}

/**
 * Get filter definition by name
 * @param {string} name - Filter name
 * @returns {object|null} Filter definition or null if not found
 */
function getFilterDefinition(name) {
  const filterDefs = loadFilterDefinitions();
  return filterDefs.filters.find(f => f.name === name) || null;
}

// Export functions
module.exports = registerFilters;
module.exports.getCustomFilterNames = getCustomFilterNames;
module.exports.getFilterDefinition = getFilterDefinition;