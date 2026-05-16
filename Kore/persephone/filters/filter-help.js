/**
 * Jinja Filter Help Library
 * 
 * Utility functions for accessing filter definitions from the JSON library
 * and generating help text for web applications.
 * 
 * Usage:
 *   const filterHelp = require('./jinja-filters');
 *   
 *   // Get all filters
 *   const all = filterHelp.getAllFilters();
 *   
 *   // Get a specific filter
 *   const abs = filterHelp.getFilter('abs');
 *   
 *   // Get filters by category
 *   const stringFilters = filterHelp.getFiltersByCategory('string');
 *   
 *   // Generate HTML help text
 *   const html = filterHelp.generateHelpHTML('capitalize');
 */

const fs = require('fs');
const path = require('path');

// Load the filter definitions from JSON
let filterDefinitions = null;

function loadFilters() {
  if (!filterDefinitions) {
    const jsonPath = path.join(__dirname, 'jinja-filters.json');
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    filterDefinitions = JSON.parse(rawData);
  }
  return filterDefinitions;
}

/**
 * Get all filter definitions
 * @returns {Array} Array of all filter definitions
 */
function getAllFilters() {
  const data = loadFilters();
  return data.filters;
}

/**
 * Get a specific filter by name
 * @param {string} name - The filter name
 * @returns {Object|null} The filter definition or null if not found
 */
function getFilter(name) {
  const filters = getAllFilters();
  return filters.find(f => f.name === name) || null;
}

/**
 * Get all filters in a category
 * @param {string} category - The category name (e.g., 'string', 'array', 'math')
 * @returns {Array} Array of filters in that category
 */
function getFiltersByCategory(category) {
  const filters = getAllFilters();
  return filters.filter(f => f.category === category);
}

/**
 * Get all available categories
 * @returns {Array} Array of unique category names
 */
function getCategories() {
  const filters = getAllFilters();
  const categories = new Set(filters.map(f => f.category));
  return Array.from(categories).sort();
}

/**
 * Get a list of filter names (for autocomplete, etc)
 * @returns {Array} Array of filter names
 */
function getFilterNames() {
  const filters = getAllFilters();
  return filters.map(f => f.name).sort();
}

/**
 * Generate plain text help for a filter
 * @param {string} filterName - The filter name
 * @returns {string} Plain text help or error message
 */
function generatePlainTextHelp(filterName) {
  const filter = getFilter(filterName);
  if (!filter) {
    return `Filter '${filterName}' not found.`;
  }

  let help = `${filter.name} - ${filter.category.toUpperCase()}\n`;
  help += '='.repeat(50) + '\n\n';
  help += `Description:\n${filter.description}\n\n`;

  if (filter.parameters && filter.parameters.length > 0) {
    help += 'Parameters:\n';
    filter.parameters.forEach(param => {
      help += `  - ${param.name} (${param.type}): ${param.description}\n`;
    });
    help += '\n';
  }

  if (filter.examples && filter.examples.length > 0) {
    help += 'Examples:\n';
    filter.examples.forEach((example, idx) => {
      help += `  ${idx + 1}. Template: ${example.template}\n`;
      help += `     Output: ${example.output}\n\n`;
    });
  }

  return help;
}

/**
 * Generate HTML help for a filter (for web display)
 * @param {string} filterName - The filter name
 * @returns {string} HTML formatted help
 */
function generateHelpHTML(filterName) {
  const filter = getFilter(filterName);
  if (!filter) {
    return `<p>Filter '<strong>${filterName}</strong>' not found.</p>`;
  }

  let html = `<div class="filter-help filter-${filter.name}">`;
  html += `<h3><code>{{ value | ${filter.name} }}</code></h3>`;
  html += `<p class="category"><strong>Category:</strong> ${filter.category}</p>`;
  html += `<p class="description">${filter.description}</p>`;

  if (filter.parameters && filter.parameters.length > 0) {
    html += '<div class="parameters"><h4>Parameters:</h4><ul>';
    filter.parameters.forEach(param => {
      html += `<li><code>${param.name}</code> <em>(${param.type})</em>: ${param.description}</li>`;
    });
    html += '</ul></div>';
  }

  if (filter.examples && filter.examples.length > 0) {
    html += '<div class="examples"><h4>Examples:</h4><ul>';
    filter.examples.forEach(example => {
      html += `<li><code>${escapeHtml(example.template)}</code> → <samp>${escapeHtml(example.output)}</samp></li>`;
    });
    html += '</ul></div>';
  }

  html += '</div>';
  return html;
}

/**
 * Generate a reference table of all filters
 * @returns {string} HTML table of filter names and descriptions
 */
function generateFilterTable() {
  const filters = getAllFilters();
  let html = '<table class="filters-table"><thead><tr><th>Filter</th><th>Category</th><th>Description</th></tr></thead><tbody>';
  
  filters.forEach(filter => {
    html += `<tr>`;
    html += `<td><code>${filter.name}</code></td>`;
    html += `<td><span class="category-badge">${filter.category}</span></td>`;
    html += `<td>${filter.description}</td>`;
    html += `</tr>`;
  });
  
  html += '</tbody></table>';
  return html;
}

/**
 * Generate a category-organized index
 * @returns {string} HTML organized by category
 */
function generateCategoryIndex() {
  const categories = getCategories();
  let html = '<div class="category-index">';
  
  categories.forEach(category => {
    const filters = getFiltersByCategory(category);
    html += `<div class="category-section">`;
    html += `<h3>${category.charAt(0).toUpperCase() + category.slice(1)}</h3>`;
    html += `<ul>`;
    filters.forEach(filter => {
      html += `<li><code>${filter.name}</code> - ${filter.description}</li>`;
    });
    html += `</ul></div>`;
  });
  
  html += '</div>';
  return html;
}

/**
 * Escape HTML special characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Search for filters by keyword
 * @param {string} keyword - Search term
 * @returns {Array} Matching filters
 */
function searchFilters(keyword) {
  const filters = getAllFilters();
  const lower = keyword.toLowerCase();
  
  return filters.filter(filter => 
    filter.name.toLowerCase().includes(lower) ||
    filter.description.toLowerCase().includes(lower)
  );
}

/**
 * Export filter data as JSON (for client-side use)
 * @returns {Object} The complete filter definitions object
 */
function exportJSON() {
  return loadFilters();
}

// Export all functions
module.exports = {
  getAllFilters,
  getFilter,
  getFiltersByCategory,
  getCategories,
  getFilterNames,
  generatePlainTextHelp,
  generateHelpHTML,
  generateFilterTable,
  generateCategoryIndex,
  searchFilters,
  exportJSON
};
