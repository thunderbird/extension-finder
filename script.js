import * as idb from './idb-keyval.mjs';

/* global lunr */

// If we consider to use google sheets as data source, these might be useful:
// const slugMatch = /\/addon\/([^\/]+)\//;
// const sheetId = '1ZzheVRDnEpAwdQ3eHDVI6Hu5om5zhp2YtSCeB0mmLUQ';
// const url = `https://spreadsheets.google.com/feeds/list/${sheetId}/1/public/full?alt=json`;
// const U_NAME_FIELD = "u_name"; //.gsx$legacycontent.$t,
// const R_NAME_FIELD = "r_name"; //.gsx$webextensionreplacement.$t,
// const R_LINK_FIELD = "r_link"; //.gsx$url.$t

// TODO: Check for error when add-on name has ":" in its name.
// TODO: Do we have the compat information for a given version for suggestions,
//       if the user is not using ESR or Release.


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

// Define how old the latest version of an add-on may be, before it is
// considered unmaintained.
const MAINTAINED_SPAN = 365 * 24 * 60 * 60 * 1000; // 1 year in milliseconds

const YAML_URL = "https://raw.githubusercontent.com/thunderbird/extension-finder/master/data.yaml";
const REPORT_URL = "https://raw.githubusercontent.com/thunderbird/webext-reports/main/docs/all.json";
const CONTEXT = {}
const DB = new StorageWithTTL();
let MESSAGES = {};

const TEMPLATES = {
  results: {
    addon: $('#search-result-addon'),
    general: $('#search-result-general'),
    empty: $('#search-result-empty'),
    compat: $('#search-result-compat'),
    notfullycompat: $('#search-result-notfullycompat'),
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
 * @property {string} current_version.compatibility.thunderbird.min - Minimum
 *    required Thunderbird version.
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
 * @property {string} id - The add-on ID.
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
 * Returns the localized message string for the given key, substituting any
 * WebExtension-style placeholders defined in the message entry. Substitutions
 * are provided as an array of strings mapped to $1, $2, … in each
 * placeholder's content field. Returns the key itself if the key is not
 * present in the loaded messages.
 *
 * @param {string} key - The message identifier.
 * @param {string[]} [substitutions=[]] - Positional substitution values.
 *
 * @returns {string} The localized string, or the key if not found.
 */
function getMessage(key, substitutions = []) {
  const entry = MESSAGES[key];
  if (!entry) return key;

  let msg = entry.message;
  if (entry.placeholders) {
    for (const [name, ph] of Object.entries(entry.placeholders)) {
      const content = ph.content.replace(/\$(\d+)/g, (_, n) =>
        substitutions[parseInt(n, 10) - 1] ?? ''
      );
      msg = msg.replace(new RegExp(`\\$${name}\\$`, 'gi'), content);
    }
  }
  return msg;
}

/**
 * Fetches and returns the locale messages for the given language code, falling
 * back to "en" if the requested locale file is not found.
 *
 * @param {string} [lang="en"] - BCP 47 language subtag (e.g. "de", "fr").
 *
 * @returns {Promise<Object.<string, {message: string}>>} Parsed messages object.
 */
async function loadLocale(lang = 'en') {
  try {
    const response = await fetch(`_locales/${lang}/messages.json`);
    if (!response.ok) throw new Error(`Locale not found: ${lang}`);
    return response.json();
  } catch {
    if (lang !== 'en') return loadLocale('en');
    return {};
  }
}

/**
 * Localizes all elements within root that carry data-i18n-content or
 * data-i18n-placeholder attributes. Also recurses into <template> element
 * content, which is not traversed by querySelectorAll on the document.
 *
 * @param {Document|DocumentFragment|Element} [root=document] - The root to
 *    localize within.
 */
function localizeDocument(root = document) {
  root.querySelectorAll('[data-i18n-content]').forEach(el => {
    el.textContent = getMessage(el.dataset.i18nContent);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = getMessage(el.dataset.i18nPlaceholder);
  });
  // <template> content is not visited by querySelectorAll on the document.
  root.querySelectorAll('template').forEach(tmpl => localizeDocument(tmpl.content));
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

  data.forEach(e => { // google sheets will need data.feed.entry.forEach
    let record = process(e);
    b.add(record);
    addons[record.idx] = record;
  });

  let idx = b.build();
  return { idx, addons };
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
 * If a reportEntry is provided, shows a compat/maintained card first and
 * filters YAML alternatives by its add-on ID. Otherwise performs a fuzzy
 * search on the query string, or shows all add-ons if both are absent.
 *
 * @param {Object} [searchParams={}] - Search parameters.
 * @param {ReportAddon} [searchParams.reportEntry] - Report entry for the
 *    add-on the user selected; triggers an exact-match flow.
 * @param {string} [searchParams.query] - Free-text search string. Ignored
 *    when reportEntry is provided.
 */
async function search(searchParams = {}) {
  const { reportEntry, query } = searchParams;

  CONTEXT.outEl.innerHTML = '';

  // If the user has entered the name of an existing, specific add-on, check if
  // it is compatible and simply needs to be updated, or if it is still
  // maintained but not yet compatible.
  if (reportEntry) {
    const addon = await getAddonData(reportEntry.id);
    if (addon) {
      // Is it compatible? Show info and help to resolve a caching issue?
      let compat = addon?.current_version?.compatibility?.thunderbird;
      if (
        compat &&
        (!compat.max || compat.max == "*" ||
          parseInt(compat.max.toString().split(".")[0], 10) >= CONTEXT.usedVersionInt) &&
        (!compat.min ||
          parseInt(compat.min.toString().split(".")[0], 10) <= CONTEXT.usedVersionInt)
      ) {
        CONTEXT.outEl.appendChild(maintainedResult(addon, true, reportEntry));
      } else {
        // Is it still maintained?
        let files = addon?.current_version?.files;
        if (files?.length > 0 &&
          (new Date() - new Date(files[0].created)) < MAINTAINED_SPAN) {
          CONTEXT.outEl.appendChild(maintainedResult(addon, false, reportEntry));
        }
      }
    }
  }

  // Show alternatives.
  let alternatives = [];
  if (reportEntry) {
    updateQueryInUrl("id", reportEntry.id);
    // If we have a reportEntry, we have an exact match and do not use LUNR.
    alternatives.push(
      ...Object.values(CONTEXT.addons).filter(a => a.id == reportEntry.id)
    );
  } else if (query) {
    updateQueryInUrl("q", query);
    // We do request that each of the entered words is part of the name.
    let words = query.split(" ").map(word => word.toLowerCase());
    const results = CONTEXT.idx.search('*' + query + '*')
      .map(r => CONTEXT.addons[r.ref])
      .filter(f => words.every(word => f.name.toLowerCase().includes(word)));
    alternatives.push(...results);
  } else {
    updateQueryInUrl();
    // Show all addons if search did not specify a query or a reportEntry.
    alternatives.push(...CONTEXT.allAddons);
  }

  // Supress alternatives, which are no longer compatible.
  alternatives.forEach(o => o.suggested.reportEntry = CONTEXT.report?.addons.find(
    a => a.id === o.suggested.id
  ));
  alternatives = alternatives.filter(o => !o.suggested.reportEntry || o.suggested.reportEntry.compat.filter(c => c.extVersion).length);

  // Append found alternatives, or the empty result card.
  if (alternatives.length) {
    alternatives.forEach(r => CONTEXT.outEl.appendChild(resultRow(r)));
  } else {
    CONTEXT.outEl.appendChild(emptyResult());
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
 * Updates the browser URL bar to reflect the current search state without
 * triggering a navigation. Clears all query parameters if no key/value is
 * provided.
 *
 * @param {string} [key] - Query parameter name to set (e.g. "q" or "id").
 * @param {string} [value] - Query parameter value.
 */
function updateQueryInUrl(key, value) {
  const url = new URL(window.location.origin + window.location.pathname);
  if (key && value && value.trim() !== "") {
    url.searchParams.set(key, value);
  }
  history.replaceState(null, "", url.href);
}

/**
 * Initialises the UI: resolves URL parameters, fetches ATN data if needed, and
 * wires up search event listeners.
 */
async function init() {
  const lang = navigator.language.split('-')[0];
  MESSAGES = await loadLocale(lang);
  localizeDocument();

  const [yamlData, report] = await Promise.all([
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

  const { idx, addons } = buildIndex(yamlData);

  let input = $('#extensionFinderSearchInput');
  input.placeholder = getMessage('inputPlaceholder');

  let outEl = $('.out');
  let allAddons = Object.values(addons).sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  let loc = new URL(window.location);
  let queryName = loc.searchParams.get("q");

  // Assign global CONTEXT
  CONTEXT.idx = idx;
  CONTEXT.addons = addons;
  CONTEXT.allAddons = allAddons;
  CONTEXT.outEl = outEl;
  CONTEXT.report = report;

  // All report entries share the same set of tracked TB versions and types;
  // use the first entry as the authoritative version list.
  const referenceCompatEntry = CONTEXT.report.addons[0]?.compat ?? [];

  // Use the last known ESR as the default for the used version.
  CONTEXT.usedVersion = 
    referenceCompatEntry.find(c => c.type === 'current-esr')?.appVersion ?? "128";

  // Determine the actual used version from the UA when running inside Thunderbird.
  const lastUAToken = navigator.userAgent.split(" ").pop();
  CONTEXT.isThunderbird = lastUAToken.startsWith("Thunderbird");
  if (CONTEXT.isThunderbird) {
    CONTEXT.usedVersion = lastUAToken.split("/").pop().split(".")[0];
  }
  CONTEXT.usedVersionInt = parseInt(CONTEXT.usedVersion, 10);

  // Update the subtitle to show the current ESR and release versions, and
  // highlight which one is installed when running inside Thunderbird.
  if (CONTEXT.isThunderbird) {
    CONTEXT.usedVersionType =
      referenceCompatEntry.find(c => c.appVersion === CONTEXT.usedVersion)?.type ?? null;
  }

  const esrVersion = referenceCompatEntry.find(c => c.type === 'current-esr')?.appVersion ?? "";
  const releaseVersion = referenceCompatEntry.find(c => c.type === 'release')?.appVersion ?? "";
  const nextESRVersion = referenceCompatEntry.find(c => c.type === 'next-esr')?.appVersion ?? "";
  const isCurrentESR = CONTEXT.usedVersionType === 'current-esr';
  const isNextESR = CONTEXT.usedVersionType === 'next-esr';
  const isRelease = CONTEXT.usedVersionType === 'release';
  const installedLabel = CONTEXT.isThunderbird ? ` (${getMessage('versionInstalled')})` : '';
  if (nextESRVersion) {
    $('#versionInfoMain').textContent = getMessage('pageTitleVersionInfoWithNextESR', [
      esrVersion, nextESRVersion, releaseVersion,
      isCurrentESR ? installedLabel : '',
      isNextESR ? installedLabel : '',
      isRelease ? installedLabel : '',
    ]);
  } else {
    $('#versionInfoMain').textContent = getMessage('pageTitleVersionInfo', [
      esrVersion, releaseVersion,
      isCurrentESR ? installedLabel : '',
      isRelease ? installedLabel : '',
    ]);
  }
  $('#pageTitleVersionInfo').hidden = false;

  const installedInfoEl = $('#versionInstalledInfo');
  installedInfoEl.hidden = !CONTEXT.isThunderbird || isCurrentESR || isNextESR || isRelease;
  if (!installedInfoEl.hidden) {
    installedInfoEl.textContent = getMessage('versionInstalledInfo', [CONTEXT.usedVersion]);
  }

  // Populate datalist with YAML unmaintained names and all report Add-on names.
  setDatalist(new Set([
    ...Object.values(addons).map(a => a.name),
    ...report.addons.map(a => a.name),
  ]));

  input.disabled = false;
  input.focus();

  // The extension finder can be called with an id, which performs an exact search.
  let queryId = loc.searchParams.get("id")?.toLowerCase();
  if (queryId) {
    const reportEntry = CONTEXT.report?.addons.find(
      a => a.id.toLowerCase() === queryId?.toLowerCase()
    );
    if (reportEntry) {
      input.value = reportEntry.name;
      search({ reportEntry });
    } else {
      input.value = "";
      search();
    }
  } else if (queryName) {
    input.value = queryName;
    const reportEntry = CONTEXT.report?.addons.find(
      a => a.name.toLowerCase() === queryName?.toLowerCase()
    );
    if (reportEntry) {
      search({ reportEntry });
    } else {
      search({ query: queryName });
    }
  } else {
    input.value = "";
    search();
  }

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

    // If the currently entered name is empty or matches an add-on listed in the
    // report DB (probably selected via auto complete), update page history.
    if (!val) {
      search();
    } else {
      const reportEntry = CONTEXT.report?.addons.find(
        a => a.name.toLowerCase() === val?.toLowerCase()
      );
      if (reportEntry) {
        search({ reportEntry });
      } else {
        search({ query: val });
      }
    }
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
 *
 * @returns {string|undefined} The resolved display name.
 */
function resolveAddonName(addon) {
  return addon?.name?.["en-US"] ?? Object.values(addon?.name ?? {})[0];
}

/**
 * Resolves the display summary for an ATN Add-on, falling back to the first
 * available locale if "en-US" is not present.
 *
 * @param {AtnAddon} addon - The ATN Add-on object.
 *
 * @returns {string|undefined} The resolved summary string, or undefined.
 */
function resolveAddonSummary(addon) {
  return addon?.summary?.["en-US"] ?? Object.values(addon?.summary ?? {})[0];
}

/**
 * Renders compatibility info into a .compat-info element. Entries are shown
 * in ascending version order.
 *
 * @param {Element|null} compatEl - The element to render into.
 * @param {ReportAddon} [reportEntry] - The report entry to render.
 */
function renderCompatInfo(compatEl, reportEntry) {
  if (!compatEl || !reportEntry) return;

  const entriesByVersion = new Map(reportEntry.compat.map(c => [c.appVersion, c]));
  const entries = [...entriesByVersion.values()]
    .sort((a, b) => parseInt(a.appVersion, 10) - parseInt(b.appVersion, 10));

  if (entries.length) {
    const parts = entries.map(c => {
      const isESR = c.type === 'current-esr' || c.type === 'next-esr';
      const label = `Thunderbird ${c.appVersion}${isESR ? ' ESR' : ''}`;
      const compatible = c.extVersion != null;
      return `<span class="compat-entry">${label} ${compatible ? '<span style="color:#267a00">✓</span>' : '<span style="color:#c00">✗</span>'}</span>`;
    });
    compatEl.innerHTML = parts.join(' ');
  }
}

/**
 * Fetches Add-on metadata from the ATN API, with IndexedDB caching.
 *
 * @param {string} id - The Add-on ID.
 *
 * @returns {Promise<AtnAddon>} Resolved ATN Add-on metadata.
 */
async function getAddonData(id) {
  const cached = await DB.get(`addon:${id}`);
  if (cached) {
    return cached;
  }

  const addon = await requestJson(
    `https://addons.thunderbird.net/api/v4/addons/addon/${id}/`
  );
  await DB.set(`addon:${id}`, addon);
  return addon;
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
    .then(addon => {
      authorEl.textContent = addon.authors.map(a => a.name).join(', ');
      iconEl.src = addon.icon_url;
      const summary = resolveAddonSummary(addon);
      if (summary) {
        descEl.insertAdjacentHTML('afterbegin', summary);
      }

      renderCompatInfo(compatEl, result.suggested.reportEntry);
    }).catch(console.error);

  const reportEntry = result.suggested.reportEntry;
  const isExperiment = reportEntry?.compat.some(c => c.isExperiment) ?? false;
  const compatWithESR = reportEntry?.compat.some(c =>
    (c.type === 'current-esr' || c.type === 'next-esr') && c.extVersion != null
  ) ?? false;
  $('.experiment-info', el).hidden = !(isExperiment && compatWithESR);

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
 * Renders a "no results" card.
 *
 * @returns {DocumentFragment} The rendered empty-result card.
 */
function emptyResult() {
  let el = cloneTemplate(TEMPLATES.results.empty);
  return el;
}

/**
 * Renders a card indicating the Add-on is still active, either compatible with
 * the current version or not yet updated.
 *
 * @param {AtnAddon} addon - ATN Add-on metadata.
 * @param {boolean} isCompatibleWithUsedVersion - True if the Add-on is compatible with
 *    the user's Thunderbird version.
 * @param {ReportAddon} [reportEntry] - Report entry for this add-on; used to
 *    populate compat info.
 *
 * @returns {DocumentFragment} The rendered maintained-result card.
 */
function maintainedResult(addon, isCompatibleWithUsedVersion, reportEntry) {
  // Include the user's own version.
  if (!reportEntry.compat.some(c => c.appVersion === CONTEXT.usedVersion)) {
    reportEntry.compat.push({
      appVersion: CONTEXT.usedVersion,
      type: "installed",
      extVersion: isCompatibleWithUsedVersion 
        ? addon.current_version.version
        : undefined,
    });
  }

  const compatEntries = (reportEntry?.compat ?? [])
    .filter(c => !!c.extVersion)
    .map(c => {
      const isESR = c.type === 'current-esr' || c.type === 'next-esr';
      return {
        versionInt: parseInt(c.appVersion, 10),
        label: `Thunderbird\u00A0${c.appVersion}${isESR ? '\u00A0ESR' : ''}`,
      };
    });
  compatEntries.sort((a, b) => a.versionInt - b.versionInt);

  // If CONTEXT.usedVersion is compatible, mention only that in the header.
  const usedEntry = compatEntries.find(c => c.versionInt === CONTEXT.usedVersionInt);
  const labels = usedEntry ? [usedEntry.label] : compatEntries.map(e => e.label);

  let template;
  if (isCompatibleWithUsedVersion) {
    template = TEMPLATES.results.compat;
  } else if (labels.length) {
    template = TEMPLATES.results.notfullycompat;
  } else {
    template = TEMPLATES.results.notyetcompat;
  }
  let el = cloneTemplate(template);

  const compatVersionEl = $('.compatVersion', el);
  if (compatVersionEl) {
    const conjunction = isCompatibleWithUsedVersion ? "and" : "or";
    const displayVersion = labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} ${conjunction} ${labels.at(-1)}`;
    compatVersionEl.textContent = displayVersion;
  }
  $('.button', el).href = addon.current_version.url;

  const iconEl = $('.icon', el);
  if (iconEl) iconEl.src = addon.icon_url;
  const nameEl = $('.alt-name', el);
  if (nameEl) nameEl.textContent = resolveAddonName(addon);
  const descEl = $('.alt-desc', el);
  const summary = resolveAddonSummary(addon);
  if (descEl && summary) descEl.insertAdjacentHTML('afterbegin', summary);
  const authorEl = $('.alt-author', el);
  if (authorEl) authorEl.textContent = addon.authors.map(a => a.name).join(', ');

  renderCompatInfo($('.compat-info', el), reportEntry);

  const helpEl = $('.help', el);
  if (helpEl) helpEl.hidden = !CONTEXT.isThunderbird;

  const isExperiment = reportEntry.compat.some(c => c.isExperiment);
  const compatWithESR = reportEntry.compat.some(c =>
    (c.type === 'current-esr' || c.type === 'next-esr') && c.extVersion != null
  );
  const experimentEl = $('.experiment-info', el);
  if (experimentEl) {
    experimentEl.hidden = !(isExperiment && compatWithESR);
  }

  return el;
}

window.addEventListener('load', function (e) {
  init();
});
