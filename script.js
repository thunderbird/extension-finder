/* global lunr */

// If we consider to use google sheets as data source, these might be useful:
// const slugMatch = /\/addon\/([^\/]+)\//;
// const sheetId = '1ZzheVRDnEpAwdQ3eHDVI6Hu5om5zhp2YtSCeB0mmLUQ';
// const url = `https://spreadsheets.google.com/feeds/list/${sheetId}/1/public/full?alt=json`;
// const U_NAME_FIELD = "u_name"; //.gsx$legacycontent.$t,
// const R_NAME_FIELD = "r_name"; //.gsx$webextensionreplacement.$t,
// const R_LINK_FIELD = "r_link"; //.gsx$url.$t

async function dataToJSON(data) {
  let entries = [];
  
  let lines = data.split(/\r\n|\n/);
  let i = 0;

  do
   {
    let entry = {};
    while (i < lines.length) {
      i++;
      let line = lines[i-1].trim();

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
    empty: $('#search-result-empty')
  }
}

function stamp(template, cb) {
  let el = document.importNode(template.content, true);
  cb(sel => el.querySelector(sel));
  return el;
}

function $(selector, parent=document) {
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
  
  data.forEach(e => { // google sheets will need in data.feed.entry
    let record = process(e);
    b.add(record);
    addons[record.idx] = record;
    addonsById[record.id.toLowerCase()] = record.name;
  });
  
  let idx = b.build();
  console.log({idx, addons})
  return { idx, addons, addonsById };  
}

function process(entry) {
  let obj = {
    idx: entry["r_name"],
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

function init({ idx, addons, addonsById }) {
  let input = $('input');
  let outEl = $('.out');
  let allAddons = Object.values(addons).sort((a, b) => (a.name.toLowerCase() > b.name.toLowerCase()) ? 1 : -1);
  
  function search(query) {
    let results, out;
    if (query) {
      results = idx.search('*' + query + '*');
      out = results.map(r => addons[r.ref]);
    } else {
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
  
  input.setAttribute('placeholder', 'name of unmaintained extension');
  input.disabled = false;
  
  let loc = new URL(window.location);
  let q = loc.searchParams.get("q");
  if (q) q = decodeURIComponent(q);
  let id = loc.searchParams.get("id");
  if (id) id = decodeURIComponent(id);

  if (id && addonsById.hasOwnProperty(id.toLowerCase())) {
    q = addonsById[id.toLowerCase()];
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
  return stamp(templates.results.empty, $=> {
    $('.query').textContent = query;
    $('.button').href = `https://addons.thunderbird.net/search/?q=${query}&appver=78.0`;
  });
}



window.addEventListener('load', function (e) {
  loadData().then(buildIndex).then(init);
});
