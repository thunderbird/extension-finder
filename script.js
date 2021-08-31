/* global lunr */

// If we consider to use google sheets as data source, these might be useful:
// const slugMatch = /\/addon\/([^\/]+)\//;
// const sheetId = '1ZzheVRDnEpAwdQ3eHDVI6Hu5om5zhp2YtSCeB0mmLUQ';
// const url = `https://spreadsheets.google.com/feeds/list/${sheetId}/1/public/full?alt=json`;
// const U_NAME_FIELD = "u_name"; //.gsx$legacycontent.$t,
// const R_NAME_FIELD = "r_name"; //.gsx$webextensionreplacement.$t,
// const R_LINK_FIELD = "r_link"; //.gsx$url.$t

// Assume current ESR as current version, if it could not be extracted from user agent.
var gUsedVersion = 91;

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
    compat: $('#search-result-compat')
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
  let outEl = $('.out');
  let exactmatch = $('#exactMatch');
  let replacementsListIntro = $('#replacementsListIntro');

  // Extract used version from user agent.
  let userAgent = navigator.userAgent.split(" ").pop();
  if (userAgent.startsWith("Thunderbird")) {
    gUsedVersion = userAgent.split("/").pop().split(".")[0];
  }

  let allAddons = Object.values(addons).sort((a, b) => (a.name.toLowerCase() > b.name.toLowerCase()) ? 1 : -1);

  function search(query) {
    replacementsListIntro.hidden = true;
    // Show help about updating add-ons instead of searching for results.
    if (query && transmitted_id_name && query == transmitted_id_name) {
      outEl.innerHTML = '';
      outEl.appendChild(compatResult(query, addon));
      return;
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

  input.addEventListener('input', function (e) {
    let query = input.value.trim();
    search(query);
  }, { passive: true });

  exactmatch.addEventListener('input', function (e) {
    let query = input.value.trim();
    search(query);
  }, { passive: true });

  input.setAttribute('placeholder', 'name of unmaintained extension');
  input.disabled = false;

  let loc = new URL(window.location);
  let q = loc.searchParams.get("q");
  if (q) q = decodeURIComponent(q);

  let id = loc.searchParams.get("id");
  let addon = null;
  let transmitted_id_name = null;

  if (id) {
    id = decodeURIComponent(id);
    exactmatch.checked = true;


    if (addonsById.hasOwnProperty(id.toLowerCase())) {
      // Alter the entered name to match the add-on name associated with that ID.
      q = addonsById[id.toLowerCase()];
    } else {
      // Not in our database, try to flip to en-US and do compat check.
      addon = await getAddonData(id);
      if (addon && addon.name && addon.name["en-US"]) {
        q = addon.name["en-US"];
      }
      // If the add-on seems to be compatible with the used version, store the
      // transmitted name, which will cause search() to display a help text instead
      // of doing a search, when the transmitted name is used as query.
      let compat = addon?.current_version?.compatibility?.thunderbird;
      if (
        compat &&
        (!compat.max || compat.max == "*" || parseInt(compat.max.toString().split(".")[0], 10) >= gUsedVersion)
      ) {
        transmitted_id_name = q;
      }
    }
  }

  let query = q || input.value;

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

function compatResult(query, addon) {
  return stamp(templates.results.compat, $ => {
    $('.query').textContent = query;
    $('.usedVersion').textContent = gUsedVersion;
    $('.button').href = addon.current_version.url;
  });
}


window.addEventListener('load', function (e) {
  loadData().then(buildIndex).then(init);
});
