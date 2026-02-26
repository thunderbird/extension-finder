/* global lunr */

// If we consider to use google sheets as data source, these might be useful:
// const slugMatch = /\/addon\/([^\/]+)\//;
// const sheetId = '1ZzheVRDnEpAwdQ3eHDVI6Hu5om5zhp2YtSCeB0mmLUQ';
// const url = `https://spreadsheets.google.com/feeds/list/${sheetId}/1/public/full?alt=json`;
// const U_NAME_FIELD = "u_name"; //.gsx$legacycontent.$t,
// const R_NAME_FIELD = "r_name"; //.gsx$webextensionreplacement.$t,
// const R_LINK_FIELD = "r_link"; //.gsx$url.$t

// Current Thunderbird version used for compatibility checks. Set dynamically
// from product-details.mozilla.org; falls back to 128 if the fetch fails.
let USED_VERSION = "128";
let THUNDERBIRD_ESR = null;
let THUNDERBIRD_ESR_NEXT = null;
let LATEST_THUNDERBIRD_VERSION = null;


// Define how old the latest version of an add-on may be, before it is
// considered unmaintained.
const MAINTAINED_SPAN = 365 * 24 * 60 * 60 * 1000; // Year
const YAML_URL = "https://raw.githubusercontent.com/thunderbird/extension-finder/master/data.yaml";
const PRODUCT_URL = "https://product-details.mozilla.org/1.0/thunderbird_versions.json";
const CACHED_ADDONS = {};

const TEMPLATES = {
  results: {
    addon: $('#search-result-addon'),
    general: $('#search-result-general'),
    empty: $('#search-result-empty'),
    compat: $('#search-result-compat'),
    notyetcompat: $('#search-result-notyetcompat')
  }
}

/**
 * A single result entry returned by a Lunr search query.
 *
 * @typedef {Object} LunrSearchResult
 *
 * @property {string} ref - The index reference of the matching record.
 */

/**
 * Executes a Lunr search query.
 *
 * @callback LunrSearchFn
 *
 * @param {string} query - The search query string.
 *
 * @returns {LunrSearchResult[]} Array of matching results.
 */

/**
 * A built Lunr search index.
 *
 * @typedef {Object} LunrIndex
 *
 * @property {LunrSearchFn} search - Executes a search query and returns
 *    matching results.
 */

/**
 * Raw entry object parsed from data.yaml.
 *
 * @typedef {Object} YamlEntry
 *
 * @property {string} u_name - Name of the unmaintained add-on.
 * @property {string} u_id - ID of the unmaintained add-on.
 * @property {string} r_name - Name of the replacement add-on.
 * @property {string} r_link - URL for the "Learn more" button (SUMO article
 *    or ATN add-on page).
 * @property {string} [r_id] - ATN ID of the replacement add-on. Mutually
 *    exclusive with r_desc.
 * @property {string} [r_desc] - HTML description of a built-in replacement.
 *    Mutually exclusive with r_id.
 */

/**
 * The recommended replacement for an unmaintained add-on.
 *
 * @typedef {Object} SuggestedAddon
 *
 * @property {string} name - Display name of the replacement.
 * @property {string} url - URL of the replacement page.
 * @property {string} [id] - ATN ID; present when the replacement is an ATN
 *    add-on.
 * @property {string} [desc] - HTML description; present when there is no ATN
 *    replacement add-on.
 */

/**
 * Structured record for an unmaintained add-on and its suggested replacement.
 *
 * @typedef {Object} AddonRecord
 *
 * @property {string} idx - Unique index key (`u_id:r_name`).
 * @property {string} id - ID of the unmaintained add-on.
 * @property {string} name - Name of the unmaintained add-on.
 * @property {SuggestedAddon} suggested - The recommended replacement.
 */

/**
 * Subset of ATN API addon metadata used by this script.
 *
 * @typedef {Object} AtnAddon
 *
 * @property {Object.<string, string>} name - Localized addon name.
 * @property {string} icon_url - URL of the addon icon.
 * @property {Object.<string, string>} summary - Localized short description.
 * @property {Array<{name: string}>} authors - List of authors.
 * @property {Object} current_version - Current version metadata.
 * @property {string} current_version.url - URL to the current version page.
 * @property {Array<{created: string}>} current_version.files - Released files
 *    for the current version; created is an ISO date string.
 * @property {Object} current_version.compatibility - Compatibility info.
 * @property {Object} current_version.compatibility.thunderbird - Thunderbird
 *    compatibility range.
 * @property {string} current_version.compatibility.thunderbird.max - Maximum
 *    compatible Thunderbird version, or "*" for all versions.
 */

/**
 * Context object passed to search() containing the index, lookup maps, and
 * relevant DOM elements.
 *
 * @typedef {Object} SearchContext
 *
 * @property {LunrIndex} idx - The Lunr search index.
 * @property {Object.<string, AddonRecord>} addons - Addon records keyed by
 *    index ref.
 * @property {AddonRecord[]} allAddons - All addon records sorted
 *    alphabetically.
 * @property {HTMLInputElement} exactmatch - The exact-match checkbox element.
 * @property {HTMLElement} outEl - The container element for rendered results.
 * @property {HTMLElement} replacementsListIntro - Intro element shown when no
 *    query is active.
 * @property {string|null} transmitted_addon_name - Addon name passed via URL
 *    when not in local DB.
 * @property {AtnAddon|null} addon - ATN addon data for the transmitted addon,
 *    if fetched.
 */

/**
 * The built search index and addon lookup maps produced by buildIndex().
 *
 * @typedef {Object} AddonIndex
 *
 * @property {LunrIndex} idx - The Lunr search index.
 * @property {Object.<string, AddonRecord>} addons - Addon records keyed by
 *    index ref.
 * @property {Object.<string, string>} addonsById - Map of lowercase addon ID
 *    to addon name.
 */

/**
 * Parses a YAML-like flat text format into an array of key/value objects.
 * Blocks are separated by lines starting with "---"; lines starting with "#"
 * are ignored.
 *
 * @param {string} data - Raw text content to parse.
 *
 * @returns {YamlEntry[]} Array of parsed entry objects.
 */
function dataToJSON(data) {
  let entries = [];

  let lines = data.split(/\r\n|\n/);
  let i = 0;

  do {
    let entry = {};
    while (i < lines.length) {
      i++;
      let line = lines[i - 1].trim();

      // End of Block
      if (line.startsWith("---")) {
        break;
      }
      // Skip comments.
      if (line.startsWith("#")) {
        continue;
      }
      let parts = line.split(":");
      let key = parts.shift().trim();
      if (key) {
        let value = parts.join(":").trim();
        entry[key] = value;
      }
    }

    // Add found entry.
    if (Object.keys(entry).length > 0) {
      entries.push(entry);
    }
  } while (i < lines.length);

  return entries;
}

/**
 * Clones a <template> element's content into a DocumentFragment.
 *
 * @param {HTMLTemplateElement} template - The template element to clone.
 *
 * @returns {DocumentFragment} The cloned document fragment.
 */
function cloneTemplate(template) {
  return document.importNode(template.content, true);
}

/**
 * Shorthand for querySelector.
 * 
 * @param {string} selector - CSS selector.
 * @param {Document|Element} [parent=document] - Element to query within.
 * 
 * @returns {Element|null}
 */
function $(selector, parent = document) {
  return parent.querySelector(selector);
}

/**
 * Fetches a URL and parses the response as JSON.
 *
 * @param {string} url - URL to fetch.
 *
 * @returns {Promise<any>} Parsed JSON response.
 */
async function requestJson(url) {
  const response = await fetch(url);
  return response.json();
}

/**
 * Fetches current Thunderbird version info from product-details.mozilla.org
 * and updates the global version variables. Falls back to the default
 * USED_VERSION value if the fetch fails.
 */
async function loadVersions() {
  try {
    const versions = await requestJson(PRODUCT_URL);
    THUNDERBIRD_ESR = versions.THUNDERBIRD_ESR;
    THUNDERBIRD_ESR_NEXT = versions.THUNDERBIRD_ESR_NEXT;
    LATEST_THUNDERBIRD_VERSION = versions.LATEST_THUNDERBIRD_VERSION;
    USED_VERSION = THUNDERBIRD_ESR.split(".")[0];
  } catch (e) {
    console.error("Failed to fetch Thunderbird versions:", e);
  }
}

/**
 * Fetches the extension replacement database from GitHub and parses it.
 *
 * @returns {Promise<YamlEntry[]>} Array of parsed entry objects.
 */
async function loadData() {
  const response = await fetch(YAML_URL);
  return dataToJSON(await response.text());
}

/**
 * Builds a Lunr full-text search index and lookup maps from parsed addon data.
 * 
 * @param {YamlEntry[]} data - Array of parsed entry objects.
 *
 * @returns {AddonIndex}
 */
function buildIndex(data) {
  let b = new lunr.Builder();

  b.field('name'); //search field
  b.ref('idx'); // unique index reference

  let addons = {};
  let addonsById = {};

  data.forEach(e => { // google sheets will need data.feed.entry.forEach
    let record = process(e);
    b.add(record);
    addons[record.idx] = record;
    addonsById[record.id.toLowerCase()] = record.name;
  });

  let idx = b.build();
  return { idx, addons, addonsById };
}

/**
 * Maps a raw data entry to a structured addon record for indexing and display.
 * 
 * @param {YamlEntry} entry - Raw entry object from the parsed data file.
 *
 * @returns {AddonRecord}
 */
function process(entry) {
  return {
    idx: `${entry["u_id"]}:${entry["r_name"]}`,
    id: entry["u_id"],
    name: entry["u_name"],
    suggested: {
      name: entry["r_name"],
      url: entry["r_link"],
      id: entry["r_id"],
      desc: entry["r_desc"],
    }
  };
}

/**
 * Runs a search and renders results into the output element.
 * If the query matches a transmitted addon name not in the local database,
 * shows a maintained/compat result instead.
 * 
 * @param {string|null} query - The search string, or null to show all addons.
 * @param {SearchContext} context - Search context built by init().
 */
function search(query, {
  idx,
  addons, allAddons,
  exactmatch, outEl, replacementsListIntro,
  transmitted_addon_name, addon
}) {
  replacementsListIntro.hidden = true;

  // Show help about updating add-ons instead of searching for results.
  if (query && transmitted_addon_name && query == transmitted_addon_name) {
    // transmitted_addon_name is set,
    // - if this has been called from Thunderbird,
    // - if we do not have a database entry for the requested add-on

    // Is it compatible and therefore this call a caching issue?
    let compat = addon?.current_version?.compatibility?.thunderbird;
    if (
      compat &&
      (!compat.max || compat.max == "*" ||
        parseInt(compat.max.toString().split(".")[0], 10) >= USED_VERSION)
    ) {
      outEl.innerHTML = '';
      outEl.appendChild(maintainedResult(query, addon, true));
      return;
    }

    // Is it still maintained?
    let files = addon?.current_version?.files;
    if (files.length > 0 &&
        (new Date() - new Date(files[0].created)) < MAINTAINED_SPAN) {
      outEl.innerHTML = '';
      outEl.appendChild(maintainedResult(query, addon, false));
      return;
    }
  }

  let results, out;
  if (query) {
    results = idx.search('*' + query + '*');
    out = results.map(r => addons[r.ref]);
    if (exactmatch.checked) {
      out = out.filter(f => f.name.toLowerCase() == query.toLowerCase());
    } else {
      // We do request that each of the entered words is part of the name.
      let words = query.split(" ").map(word => word.toLowerCase());
      out = out.filter(f =>
        words.every(word => f.name.toLowerCase().includes(word)));
    }
  } else {
    replacementsListIntro.hidden = false;
    out = allAddons;
  }

  outEl.innerHTML = '';

  if (out.length) {
    out.forEach(r => outEl.appendChild(resultRow(r)));
  } else {
    outEl.appendChild(emptyResult(query));
  }
}

/**
 * Initialises the UI: resolves URL parameters, fetches ATN data if needed, and
 * wires up search event listeners.
 */
async function init() {
  await loadVersions();
  const yamlData = await loadData();
  const { idx, addons, addonsById } = buildIndex(yamlData);

  let input = $('#searchInput');
  input.setAttribute('placeholder', 'name of unmaintained extension');

  let outEl = $('.out');
  let exactmatch = $('#exactMatch');
  let replacementsListIntro = $('#replacementsListIntro');

  let allAddons = Object.values(addons).sort((a, b) =>
    (a.name.toLowerCase() > b.name.toLowerCase()) ? 1 : -1);

  let loc = new URL(window.location);
  let query = loc.searchParams.get("q");
  if (query) query = decodeURIComponent(query);

  let addon = null;
  let transmitted_addon_name = null;

  // Extract used version from user agent.
  let userAgent = navigator.userAgent.split(" ").pop();
  if (userAgent.startsWith("Thunderbird")) {
    USED_VERSION = userAgent.split("/").pop().split(".")[0];
    
    let id = loc.searchParams.get("id");
    if (id) {
      id = decodeURIComponent(id);
      exactmatch.checked = true;

      if (addonsById.hasOwnProperty(id.toLowerCase())) {
        // Alter the entered name to match the stored add-on name
        // associated with that ID.
        query = addonsById[id.toLowerCase()];
      } else {
        // Not in our database, try to flip to a name provided by ATN.
        addon = await getAddonData(id);
        if (addon && addon.name) {
          query = addon.name["en-US"]
            ? addon.name["en-US"]
            : Object.values(addon.name)[0];
        }
        // Store the used name, so search can fallback to the advanced information
        // available for the linked addon.
        transmitted_addon_name = query;
      }
    }
  }

  let searchContext = {
    idx, addons, allAddons,
    exactmatch, outEl, replacementsListIntro,
    transmitted_addon_name, addon
  };

  input.addEventListener('input', function () {
    search(input.value.trim(), searchContext);
  }, { passive: true });

  exactmatch.addEventListener('input', function () {
    search(input.value.trim(), searchContext);
  }, { passive: true });

  input.disabled = false;

  if (query) {
    input.value = query;
    search(query, searchContext);
  } else {
    search(null, searchContext);
  }

  input.focus();
}

/**
 * Dispatches to addonResult or generalResult depending on whether the
 * replacement is an ATN addon.
 * 
 * @param {AddonRecord} result - The addon record to render.
 *
 * @returns {DocumentFragment} The rendered result card.
 */
function resultRow(result) {
  if (result.suggested.id) {
    return addonResult(result);
  }
  return generalResult(result);
}


/**
 * Fetches addon metadata from the ATN API, with in-memory caching.
 * 
 * @param {string} id - The ATN addon ID or slug.
 * 
 * @returns {Promise<AtnAddon>} Resolved ATN addon metadata object.
 */
async function getAddonData(id) {
  if (!(id in CACHED_ADDONS)) {
    CACHED_ADDONS[id] = await requestJson(
      `https://addons.thunderbird.net/api/v4/addons/addon/${id}/`
    );
  }
  return CACHED_ADDONS[id];
}

/**
 * Renders a result card for a replacement that is an ATN addon, fetching its
 * icon, author, and summary live.
 * 
 * @param {AddonRecord} result - Addon record whose suggested replacement has
 *    an ATN addon ID.
 * 
 * @returns {DocumentFragment} The rendered result card.
 */
function addonResult(result) {
  let el = cloneTemplate(TEMPLATES.results.addon);
  $('.legacy-name', el).textContent = result.name;
  $('.alt-name', el).textContent = result.suggested.name;
  $('.cta .button', el).setAttribute('href', result.suggested.url);

  let authorEl = $('.alt-author', el);
  let iconEl = $('.icon', el);
  let descEl = $('.alt-desc', el);

  // Fetch ATN metadata asynchronously and fill in the live nodes once
  // available. The fragment is returned immediately with the static data.
  getAddonData(result.suggested.id)
    .then(data => {
      authorEl.textContent = data.authors.map(a => a.name).join(', ');
      iconEl.src = data.icon_url;
      if (data.summary["en-US"]) {
        descEl.insertAdjacentHTML('afterbegin', data.summary["en-US"]);
      }
    }).catch(console.error);

  return el;
}

/**
 * Renders a result card for a replacement that is not an ATN addon (e.g. a
 * built-in feature or external tool).
 * 
 * @param {AddonRecord} result - Addon record whose suggested replacement has
 *    a static description instead of an ATN ID.
 * 
 * @returns {DocumentFragment} The rendered result card.
 */
function generalResult(result) {
  let el = cloneTemplate(TEMPLATES.results.general);
  $('.legacy-name', el).textContent = result.name;
  $('.alt-name', el).textContent = result.suggested.name;
  $('.cta .button', el).setAttribute('href', result.suggested.url);

  if (result.suggested.desc) {
    $('.alt-desc', el).insertAdjacentHTML('afterbegin', result.suggested.desc);
  }

  return el;
}

/**
 * Renders a "no results" card with a link to search ATN directly. Only major
 * versions are considered (e.g. XXX.0).
 * 
 * @param {string} query - The search string that yielded no results.
 * 
 * @returns {DocumentFragment} The rendered empty-result card.
 */
function emptyResult(query) {
  let el = cloneTemplate(TEMPLATES.results.empty);
  $('.query', el).textContent = query;
  $('.button', el).href =
    `https://addons.thunderbird.net/search/?q=${query}&appver=${USED_VERSION}.0`;
  return el;
}

/**
 * Renders a card indicating the addon is still active, either compatible with
 * the current version or not yet updated.
 * 
 * @param {string} query - The addon name.
 * @param {AtnAddon} addon - ATN addon metadata.
 * @param {boolean} isCompatible - True if the addon is compatible with
 *    the user's Thunderbird version.
 * 
 * @returns {DocumentFragment} The rendered maintained-result card.
 */
function maintainedResult(query, addon, isCompatible) {
  let el = cloneTemplate(
    isCompatible ? TEMPLATES.results.compat : TEMPLATES.results.notyetcompat
  );
  $('.query', el).textContent = query;
  $('.usedVersion', el).textContent = USED_VERSION;
  $('.button', el).href = addon.current_version.url;
  return el;
}


window.addEventListener('load', function (e) {
  init();
});
