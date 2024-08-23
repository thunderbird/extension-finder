/* global lunr */

// If we consider to use google sheets as data source, these might be useful:
// const slugMatch = /\/addon\/([^\/]+)\//;
// const sheetId = '1ZzheVRDnEpAwdQ3eHDVI6Hu5om5zhp2YtSCeB0mmLUQ';
// const url = `https://spreadsheets.google.com/feeds/list/${sheetId}/1/public/full?alt=json`;
// const U_NAME_FIELD = "u_name"; //.gsx$legacycontent.$t,
// const R_NAME_FIELD = "r_name"; //.gsx$webextensionreplacement.$t,
// const R_LINK_FIELD = "r_link"; //.gsx$url.$t

// Assume current ESR as current version, if it could not be extracted from user agent.
var gUsedVersion = 128;

// Define how old the latest version of an add-on may be, before it is considered unmaintained.
const maintainedSpan = 365*24*60*60*1000; // Year

async function dataToJSON(data) {
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

const templates = {
  results: {
    addon: $('#search-result-addon'),
    general: $('#search-result-general'),
    empty: $('#search-result-empty'),
    compat: $('#search-result-compat'),
    notyetcompat: $('#search-result-notyetcompat')
  }
}

function stamp(template, cb) {
  let el = document.importNode(template.content, true);
  cb(sel => el.querySelector(sel));
  return el;
}

function $(selector, parent = document) {
  return parent.querySelector(selector);
}

async function loadData() {
  let url = "https://raw.githubusercontent.com/thundernest/extension-finder/master/data.yaml"
  return fetch(url).then(r => r.text()).then(dataToJSON);
}

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

function process(entry) {
  let obj = {
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
  return obj;
}

async function init({ idx, addons, addonsById }) {
  let input = $('#searchInput');
  input.setAttribute('placeholder', 'name of unmaintained extension');

  let outEl = $('.out');
  let exactmatch = $('#exactMatch');
  let replacementsListIntro = $('#replacementsListIntro');

  let allAddons = Object.values(addons).sort((a, b) => (a.name.toLowerCase() > b.name.toLowerCase()) ? 1 : -1);

  function search(query) {
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
        (!compat.max || compat.max == "*" || parseInt(compat.max.toString().split(".")[0], 10) >= gUsedVersion)
      ) {
        outEl.innerHTML = '';
        outEl.appendChild(maintainedResult(query, addon, true));
        return;
      }

      // Is it still maintained?
      let files = addon?.current_version?.files;
      if (files.length > 0 && (new Date() - new Date(files[0].created)) < maintainedSpan) {
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
        out = out.filter(f => words.every(word => f.name.toLowerCase().includes(word)));
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

  let loc = new URL(window.location);
  let query = loc.searchParams.get("q");
  if (query) query = decodeURIComponent(query);

  let addon = null;
  let transmitted_addon_name = null;

  // Extract used version from user agent.
  let userAgent = navigator.userAgent.split(" ").pop();
  if (userAgent.startsWith("Thunderbird")) {
      gUsedVersion = userAgent.split("/").pop().split(".")[0];

      let id = loc.searchParams.get("id");
      if (id) {
        id = decodeURIComponent(id);
        exactmatch.checked = true;
    
        if (addonsById.hasOwnProperty(id.toLowerCase())) {
          // Alter the entered name to match the stored add-on name associated with that ID.
          query = addonsById[id.toLowerCase()];
        } else {
          // Not in our database, try to flip to a name provided by ATN.
          addon = await getAddonData(id);
          if (addon && addon.name) {
            query = addon.name["en-US"] ? addon.name["en-US"] : Object.values(addon.name)[0];
          }
          // Store the used name, so search can fallback to the advanced information
          // available for the linked addon.
          transmitted_addon_name = query;
        }
      }      
  }
  
  


  input.addEventListener('input', function (e) {
    search(input.value.trim());
  }, { passive: true });

  exactmatch.addEventListener('input', function (e) {
    search(input.value.trim());
  }, { passive: true });

  input.disabled = false;

  if (query) {
    input.value = query;
    search(query);
  } else {
    search();
  }

  input.focus();
}

function resultRow(result) {
  if (result.suggested.id) {
    return addonResult(result);
  }
  return generalResult(result);
}

let cachedAddons = {};

function getAddonData(id) {
  return new Promise((resolve, reject) => {
    if (id in cachedAddons) {
      resolve(cachedAddons[id]);
    } else {
      let p = fetch(`https://addons.thunderbird.net/api/v4/addons/addon/${id}/`).then(r => r.json())
      p.then(data => cachedAddons[id] = p);
      resolve(p);
    }
  });
}

function addonResult(result) {
  return stamp(templates.results.addon, $ => {
    $('.legacy-name').textContent = result.name;
    $('.alt-name').textContent = result.suggested.name;
    $('.cta .button').setAttribute('href', result.suggested.url);

    let authorEl = $('.alt-author');
    let iconEl = $('.icon');
    let descEl = $('.alt-desc');

    getAddonData(result.suggested.id)
      .then(data => {
        authorEl.textContent = data.authors.map(a => a.name).join(', ');
        iconEl.src = data.icon_url;
        if (data.summary["en-US"]) {
          descEl.insertAdjacentHTML('afterbegin', data.summary["en-US"]);
        }
      }).catch(console.error);
  });
}

function generalResult(result) {
  return stamp(templates.results.general, $ => {
    $('.legacy-name').textContent = result.name;
    $('.alt-name').textContent = result.suggested.name;
    $('.cta .button').setAttribute('href', result.suggested.url);

    if (result.suggested.desc) {
      $('.alt-desc').insertAdjacentHTML('afterbegin', result.suggested.desc);
    }
  });
}

function emptyResult(query) {
  return stamp(templates.results.empty, $ => {
    $('.query').textContent = query;
    $('.button').href = `https://addons.thunderbird.net/search/?q=${query}&appver=${gUsedVersion}.0`;
  });
}

function maintainedResult(query, addon, isCompatible) {
  if (isCompatible) {
    return stamp(templates.results.compat, $ => {
      $('.query').textContent = query;
      $('.usedVersion').textContent = gUsedVersion;
      $('.button').href = addon.current_version.url;
    });
  }

  return stamp(templates.results.notyetcompat, $ => {
    $('.query').textContent = query;
    $('.usedVersion').textContent = gUsedVersion;
    $('.button').href = addon.current_version.url;
  });
}


window.addEventListener('load', function (e) {
  loadData().then(buildIndex).then(init);
});
