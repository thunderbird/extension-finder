import * as idb from './idb-keyval.mjs';

/* global lunr */

// If we consider to use google sheets as data source, these might be useful:
// const slugMatch = /\/addon\/([^\/]+)\//;
// const sheetId = '1ZzheVRDnEpAwdQ3eHDVI6Hu5om5zhp2YtSCeB0mmLUQ';
// const url = `https://spreadsheets.google.com/feeds/list/${sheetId}/1/public/full?alt=json`;
// const U_NAME_FIELD = "u_name"; //.gsx$legacycontent.$t,
// const R_NAME_FIELD = "r_name"; //.gsx$webextensionreplacement.$t,
// const R_LINK_FIELD = "r_link"; //.gsx$url.$t

class StorageWithTTL {
  // Default to a TTL of 1 day.
  constructor(ttl = 24 * 60 * 60 * 1000) {
    this.ttl = ttl;
  }

  async set(key, value) {
    await idb.set(key, { value, timestamp: Date.now() });
  }

  async get(key) {
    const entry = await idb.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl) {
      await idb.del(key);
      return null;
    }

    return entry.value;
  }

  async del(key) {
    await idb.del(key);
  }

  async clear() {
    await idb.clear();
  }
}

// Current Thunderbird version used for compatibility checks. Set dynamically
// from product-details.mozilla.org; falls back to 128 if the fetch fails.
let USED_VERSION = "128";
let THUNDERBIRD_ESR = null;
let THUNDERBIRD_ESR_NEXT = null;
let LATEST_THUNDERBIRD_VERSION = null;


// Define how old the latest version of an add-on may be, before it is
// considered unmaintained.
const MAINTAINED_SPAN = 365 * 24 * 60 * 60 * 1000; // 1 year in milliseconds

const YAML_URL = "https://raw.githubusercontent.com/thunderbird/extension-finder/master/data.yaml";
const PRODUCT_URL = "https://product-details.mozilla.org/1.0/thunderbird_versions.json";
const REPORT_URL = "https://raw.githubusercontent.com/thunderbird/webext-reports/main/docs/all.json"
const CONTEXT = {}
const DB = new StorageWithTTL();

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
 * @property {string} [r_id] - Add-on ID of the replacement add-on. Mutually
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
 * @property {string} [id] - Add-on ID, present when replacement is an add-on.
 * @property {string} [desc] - HTML description, present when there is no
 *    replacement add-on, but some other solution.
 * @property {ReportAddon} [reportEntry] - Report entry for this add-on,
 *    populated during search.
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
 * Subset of ATN API Add-on metadata used by this script.
 *
 * @typedef {Object} AtnAddon
 *
 * @property {Object.<string, string>} name - Localized Add-on name.
 * @property {string} icon_url - URL of the Add-on icon.
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
 * A single compatibility entry from the webext-reports database.
 *
 * @typedef {Object} ReportCompat
 *
 * @property {string} appVersion - Thunderbird major version (e.g. "128").
 * @property {string} type - Release type: "release", "current-esr", or "next-esr".
 * @property {string} [extVersion] - Extension version string, if available.
 * @property {boolean} isWebExtension - True if the extension is a WebExtension.
 * @property {boolean} isExperiment - True if the extension uses experiments.
 * @property {string} [url] - Download URL for this version, if available.
 */

/**
 * A single Add-on entry from the webext-reports database.
 *
 * @typedef {Object} ReportAddon
 *
 * @property {string} id - The Add-on GUID.
 * @property {string} name - Display name of the Add-on.
 * @property {Object.<string, string>} icons - Icon URLs keyed by pixel size
 *    (e.g. "32", "64").
 * @property {ReportCompat[]} compat - Compatibility entries across Thunderbird
 *    versions, ordered from newest to oldest.
 * @property {string[]} badges - Badge identifiers assigned to this Add-on.
 */

/**
 * The built search index and Add-on lookup maps produced by buildIndex().
 *
 * @typedef {Object} AddonIndex
 *
 * @property {LunrIndex} idx - The Lunr search index.
 * @property {Object.<string, AddonRecord>} addons - Add-on records keyed by
 *    index ref.
 * @property {Map(<string>,<string>)} addonsById - Map of lowercase Add-on ID
 *    to Add-on name.
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
    let versions = await DB.get('versions');
    if (!versions) {
      versions = await requestJson(PRODUCT_URL);
      await DB.set('versions', versions);
    }
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
  const cached = await DB.get('yaml');
  if (cached) return cached;

  const response = await fetch(YAML_URL);
  const data = dataToJSON(await response.text());
  await DB.set('yaml', data);
  return data;
}

/**
 * Fetches the webext-reports database from GitHub, with IndexedDB caching.
 *
 * @returns {Promise<{addons: ReportAddon[]}>} Parsed reports JSON.
 */
async function loadReports() {
  const cached = await DB.get('reports');
  if (cached) return cached;

  const reports = await requestJson(REPORT_URL);
  await DB.set('reports', reports);
  return reports;
}

/**
 * Builds a Lunr full-text search index and lookup maps from parsed Add-on data.
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
  let addonsById = new Map;

  data.forEach(e => { // google sheets will need data.feed.entry.forEach
    let record = process(e);
    b.add(record);
    addons[record.idx] = record;
    addonsById.set(record.id.toLowerCase(), record.name);
  });

  let idx = b.build();
  return { idx, addons, addonsById };
}

/**
 * Maps a raw data entry to a structured Add-on record for indexing and display.
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
 * If the query matches a transmitted Add-on name not in the local database,
 * shows a maintained/compat result instead.
 * 
 * @param {string|null} query - The search string, or null to show all addons.
 */
async function search(query) {
  CONTEXT.replacementsListIntro.hidden = true;
  const isThunderbird = true || navigator.userAgent.split(" ").pop().startsWith("Thunderbird");
  USED_VERSION = 148;
  
  //const reportEntry = CONTEXT.report?.addons.find(
  //  a => a.name.toLowerCase() === query?.toLowerCase()
  //);
  //const hasUsedVersion = reportEntry?.compat.some(c => c.appVersion === USED_VERSION) ?? false;

  // Before showing results for the alternative search, check if the add-on is
  // actually compatible and just needs to be updated, or if it still is maintained
  // but not yet compatible. This will only work for add-on which have been passed
  // into the extension finder using an id.
  const addonId = await DB.get(`name:${query}`);
  // Do a local lookup. Under certain circumstances, we could do an extened
  // lookup based on the name.
  const addon = await DB.get(`id:${addonId}`);
  if (addon) {
    // Is it compatible and therefore this call is a caching issue?
    let compat = addon?.current_version?.compatibility?.thunderbird;
    if (
      compat &&
      (!compat.max || compat.max == "*" ||
        parseInt(compat.max.toString().split(".")[0], 10) >= USED_VERSION)
    ) {
      CONTEXT.outEl.innerHTML = '';
      CONTEXT.outEl.appendChild(maintainedResult(query, addon, true));
      return;
    }

    // Is it still maintained?
    let files = addon?.current_version?.files;
    if (files.length > 0 &&
      (new Date() - new Date(files[0].created)) < MAINTAINED_SPAN) {
      const reportEntry = CONTEXT.report?.addons.find(a => a.id === addonId);
      CONTEXT.outEl.innerHTML = '';
      CONTEXT.outEl.appendChild(maintainedResult(query, addon, false, reportEntry));
      return;
    }
  }

  let results, out;
  if (query) {
    results = CONTEXT.idx.search('*' + query + '*');
    out = results.map(r => CONTEXT.addons[r.ref]);
    if (CONTEXT.exactmatch.checked) {
      out = out.filter(f => f.name.toLowerCase() == query.toLowerCase());
    } else {
      // We do request that each of the entered words is part of the name.
      let words = query.split(" ").map(word => word.toLowerCase());
      out = out.filter(f =>
        words.every(word => f.name.toLowerCase().includes(word)));
    }
  } else {
    CONTEXT.replacementsListIntro.hidden = false;
    out = CONTEXT.allAddons;
  }

  CONTEXT.outEl.innerHTML = '';
  out.forEach(o => o.suggested.reportEntry = CONTEXT.report?.addons.find(
    a => a.id === o.suggested.id
  ));
  out = out.filter(o => !o.suggested.reportEntry || o.suggested.reportEntry.compat.filter(c => c.extVersion).length);

  if (out.length) {
    out.forEach(r => CONTEXT.outEl.appendChild(resultRow(r)));
  } else {
    CONTEXT.outEl.appendChild(emptyResult(query));
  }
}

/**
 * Populates the search input's datalist with a set of Add-on names.
 *
 * @param {Set<string>} names - Set of Add-on display names to offer as options.
 */
function setDatalist(names) {
  $('#addon-suggestions').replaceChildren(
    ...[...names].map(name => {
      const opt = document.createElement('option');
      opt.value = name;
      return opt;
    })
  );
}

/**
 * Initialises the UI: resolves URL parameters, fetches ATN data if needed, and
 * wires up search event listeners.
 */
async function init() {
  const [, yamlData, report] = await Promise.all([
    loadVersions(),
    loadData(),
    loadReports(),
  ]);

  // Replace r_name with the authoritative name from the report, matched by r_id.
  const reportById = new Map(report.addons.map(a => [a.id, a]));
  for (const entry of yamlData) {
    if (entry.r_id) {
      const reportAddon = reportById.get(entry.r_id);
      if (reportAddon) entry.r_name = reportAddon.name;
    }
  }

  const { idx, addons, addonsById } = buildIndex(yamlData);

  let input = $('#searchInput');
  input.setAttribute('placeholder', 'name of unmaintained extension');

  let outEl = $('.out');
  let exactmatch = $('#exactMatch');
  let replacementsListIntro = $('#replacementsListIntro');

  let allAddons = Object.values(addons).sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  let loc = new URL(window.location);
  let queryName = loc.searchParams.get("q");
  if (queryName) queryName = decodeURIComponent(queryName);

  // Assign global CONTEXT
  CONTEXT.idx = idx;
  CONTEXT.addons = addons;
  CONTEXT.allAddons = allAddons;
  CONTEXT.exactmatch = exactmatch;
  CONTEXT.outEl = outEl;
  CONTEXT.replacementsListIntro = replacementsListIntro;
  CONTEXT.report = report;

  input.disabled = false;

  // The extension finder can be called with an id, which triggers an exact match,
  // and a compatibility check on the given add-on. We also enforce the query to
  // use an official name.
  let queryId = loc.searchParams.get("id")?.toLowerCase();
  if (queryId) {
    queryId = decodeURIComponent(queryId);
    exactmatch.checked = true;

    // Get the add-on info from ATN, but enforce the name used alongside with
    // it to match the name associated with the id as stored in our YAML database.
    let { name } = await getAddonData(queryId, addonsById.get(queryId));

    input.value = name;
    search(name);
  } else if (queryName) {
    input.value = queryName;
    search(queryName);
  } else {
    search(null);
  }

  // Populate datalist with YAML unmaintained names and all report Add-on names.
  setDatalist(new Set([
    ...Object.values(addons).map(a => a.name),
    ...report.addons.map(a => a.name),
  ]));

  input.focus();

  input.addEventListener('input', function () {
    // Update datalist visibility. Hide the datalist dropdown when the input
    // already exactly matches the only remaining suggestion.
    const val = input.value.trim();
    const opts = [...$('#addon-suggestions').options];
    const matches = opts.filter(o => o.value.toLowerCase().includes(val.toLowerCase()));
    if (matches.length === 1 && matches[0].value.toLowerCase() === val.toLowerCase()) {
      input.removeAttribute('list');
    } else {
      input.setAttribute('list', 'addon-suggestions');
    }
    search(val);
  }, { passive: true });

  exactmatch.addEventListener('input', function () {
    search(input.value.trim());
  }, { passive: true });
}

/**
 * Dispatches to addonResult or generalResult depending on whether the
 * replacement is an Add-on.
 * 
 * @param {AddonRecord} result - The Add-on record to render.
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
 * Resolves the display name for an ATN Add-on.
 *
 * @param {AtnAddon} addon - The ATN Add-on object.
 * @param {string} [forcedName] - Override name; takes priority if provided.
 *
 * @returns {string} The resolved display name.
 */
function resolveAddonName(addon, forcedName) {
  return forcedName ?? addon?.name?.["en-US"] ?? Object.values(addon?.name ?? {})[0];
}

/**
 * Fetches Add-on metadata from the ATN API, with IndexedDB caching.
 *
 * @param {string} id - The Add-on ID.
 * @param {string} [forcedName] - Name to use instead of the ATN Add-on name;
 *    typically the canonical name from the YAML database.
 *
 * @returns {Promise<{addon: AtnAddon, name: string}>} Resolved ATN Add-on
 *    metadata and the display name to use.
 */
async function getAddonData(id, forcedName) {
  const cached = await DB.get(`id:${id}`);
  if (cached) {
    return { addon: cached, name: resolveAddonName(cached, forcedName) };
  }

  const addon = await requestJson(
    `https://addons.thunderbird.net/api/v4/addons/addon/${id}/`
  );
  const name = resolveAddonName(addon, forcedName);

  await Promise.all([
    DB.set(`id:${id}`, addon),
    DB.set(`name:${name}`, id),
  ]);
  return { addon, name };
}

/**
 * Renders a result card for a replacement that is an Add-on, fetching its icon,
 *    author, and summary live.
 * 
 * @param {AddonRecord} result - Add-on record whose suggested replacement has
 *    an Add-on ID.
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
  let compatEl = $('.compat-info', el);

  // Fetch ATN metadata asynchronously and fill in the live nodes once
  // available. The fragment is returned immediately with the static data.
  getAddonData(result.suggested.id)
    .then(({ addon }) => {
      authorEl.textContent = addon.authors.map(a => a.name).join(', ');
      iconEl.src = addon.icon_url;
      if (addon.summary["en-US"]) {
        descEl.insertAdjacentHTML('afterbegin', addon.summary["en-US"]);
      }

      const reportEntry = result.suggested.reportEntry;
      if (reportEntry) {
        const typeOrder = ['current-esr', 'next-esr', 'release'];
        const entries = typeOrder
          .map(type => reportEntry.compat.find(c => c.type === type))
          .filter(Boolean);
        if (entries.length) {
          const parts = entries.map(c => {
            const isESR = c.type !== 'release';
            const label = `Thunderbird ${c.appVersion}${isESR ? ' ESR' : ''}`;
            const compatible = c.extVersion != null;
            return `<span class="compat-entry">${label} ${compatible ? '<span style="color:#267a00">✓</span>' : '<span style="color:#c00">✗</span>'}</span>`;
          });
          compatEl.innerHTML = parts.join(' ');
        }
      }
    }).catch(console.error);

  return el;
}

/**
 * Renders a result card for a replacement that is not an Add-on (e.g. a built-in
 *    feature or external tool).
 * 
 * @param {AddonRecord} result - Add-on record whose suggested replacement has
 *    a static description instead of an Add-on ID.
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
 * Renders a card indicating the Add-on is still active, either compatible with
 * the current version or not yet updated.
 *
 * @param {string} query - The Add-on name.
 * @param {AtnAddon} addon - ATN Add-on metadata.
 * @param {boolean} isCompatible - True if the Add-on is compatible with
 *    the user's Thunderbird version.
 * @param {ReportAddon} [reportEntry] - Report entry for this add-on; used to
 *    populate compat info in the notyetcompat card.
 *
 * @returns {DocumentFragment} The rendered maintained-result card.
 */
function maintainedResult(query, addon, isCompatible, reportEntry) {
  let el = cloneTemplate(
    isCompatible ? TEMPLATES.results.compat : TEMPLATES.results.notyetcompat
  );
  const queryEl = $('.query', el);
  if (queryEl) queryEl.textContent = query;
  $('.usedVersion', el).textContent = USED_VERSION;
  $('.button', el).href = addon.current_version.url;

  const iconEl = $('.icon', el);
  if (iconEl) iconEl.src = addon.icon_url;
  const nameEl = $('.alt-name', el);
  if (nameEl) nameEl.textContent = query;
  const descEl = $('.alt-desc', el);
  if (descEl && addon.summary?.["en-US"]) descEl.insertAdjacentHTML('afterbegin', addon.summary["en-US"]);
  const authorEl = $('.alt-author', el);
  if (authorEl) authorEl.textContent = addon.authors.map(a => a.name).join(', ');

  const compatEl = $('.compat-info', el);
  if (compatEl && reportEntry) {
    const typeOrder = ['current-esr', 'next-esr', 'release'];
    const entries = typeOrder
      .map(type => reportEntry.compat.find(c => c.type === type))
      .filter(Boolean);
    if (entries.length) {
      const parts = entries.map(c => {
        const isESR = c.type !== 'release';
        const label = `Thunderbird ${c.appVersion}${isESR ? ' ESR' : ''}`;
        const compatible = c.extVersion != null;
        return `<span class="compat-entry">${label} ${compatible ? '<span style="color:#267a00">✓</span>' : '<span style="color:#c00">✗</span>'}</span>`;
      });
      compatEl.innerHTML = parts.join(' ');
    }
  }

  return el;
}


window.addEventListener('load', function (e) {
  init();
});
