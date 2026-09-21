"use strict";

/* ============================================================
   Ledger — local-first revenue & receipt tracker
   All data lives in IndexedDB / localStorage on this device.
   No data is ever sent to a network.
   ============================================================ */

/* ------------------------- Helpers ------------------------- */

const $ = (sel) => document.querySelector(sel);
const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    isFinite(n) ? n : 0
  );

function todayStr() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const fmtDate = (s) => {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  if (!y || !m || !d) return s;
  return `${m}/${d}/${y}`;
};

/* Robust CSV parser (RFC 4180-ish): quotes, embedded commas and newlines. */
function parseCSV(text, delim) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function detectDelimiter(text) {
  const sample = Array.from(text.slice(0, 5000));
  const counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  for (const ch of sample) if (ch in counts) counts[ch]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
}

function stripMoney(s) {
  if (s == null) return NaN;
  return Number(String(s).replace(/[$,€£¥\s]/g, ""));
}

function looksNumeric(s) {
  return s != null && String(s).trim() !== "" && !isNaN(stripMoney(s));
}

function looksDate(s) {
  if (s == null) return false;
  const t = String(s).trim();
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(t) ||
         /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(t);
}

function normalizeDate(s) {
  if (s == null) return "";
  const t = String(s).trim();
  let m = t.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const parsed = new Date(t);
  if (!isNaN(parsed)) {
    const p = (x) => String(x).padStart(2, "0");
    return `${parsed.getFullYear()}-${p(parsed.getMonth() + 1)}-${p(parsed.getDate())}`;
  }
  return "";
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ------------------------ Categories ----------------------- */

const DEFAULT_CATEGORIES = ["Supplies", "Rent", "Utilities", "Marketing", "Labor", "Travel", "Meals", "Fees", "Other"];

function loadCategories() {
  try {
    const raw = localStorage.getItem("ledger.categories");
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) && arr.length ? arr : DEFAULT_CATEGORIES.slice();
  } catch { return DEFAULT_CATEGORIES.slice(); }
}
function saveCategories(cats) {
  localStorage.setItem("ledger.categories", JSON.stringify(cats));
}

/* ------------------------- IndexedDB ------------------------ */

const DB_NAME = "ledger-db";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("entries")) {
        const store = db.createObjectStore("entries", { keyPath: "id" });
        store.createIndex("date", "date");
      }
      if (!db.objectStoreNames.contains("csv")) {
        db.createObjectStore("csv", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
const getDB = () => (dbPromise = dbPromise || openDB());

async function getAllEntries() {
  const db = await getDB();
  return reqToPromise(db.transaction("entries").objectStore("entries").getAll());
}
async function putEntry(entry) {
  const db = await getDB();
  return reqToPromise(db.transaction("entries", "readwrite").objectStore("entries").put(entry));
}
async function deleteEntry(id) {
  const db = await getDB();
  return reqToPromise(db.transaction("entries", "readwrite").objectStore("entries").delete(id));
}
async function putCsv(rec) {
  const db = await getDB();
  return reqToPromise(db.transaction("csv", "readwrite").objectStore("csv").put(rec));
}
async function getAllCsv() {
  const db = await getDB();
  return reqToPromise(db.transaction("csv").objectStore("csv").getAll());
}
async function deleteCsv(id) {
  const db = await getDB();
  return reqToPromise(db.transaction("csv", "readwrite").objectStore("csv").delete(id));
}

/* --------------------------- State -------------------------- */

let entries = [];
let csvFiles = [];
let categories = loadCategories();
let filter = { type: "all", category: "all", search: "", tags: [] };
const thumbUrls = {}; // entryId -> object URL

function keepThumb(entry) {
  if (entry.image && !thumbUrls[entry.id]) {
    thumbUrls[entry.id] = URL.createObjectURL(entry.image);
  }
}
function releaseThumb(id) {
  if (thumbUrls[id]) { URL.revokeObjectURL(thumbUrls[id]); delete thumbUrls[id]; }
}
function releaseAllThumbs() {
  Object.values(thumbUrls).forEach((u) => URL.revokeObjectURL(u));
  for (const k in thumbUrls) delete thumbUrls[k];
}

function getFilteredEntries() {
  const q = filter.search.trim().toLowerCase();
  return entries
    .filter((e) => filter.type === "all" || e.type === filter.type)
    .filter((e) => filter.category === "all" || e.category === filter.category)
    .filter((e) => !filter.tags.length || (e.label && filter.tags.includes(e.label)))
    .filter((e) =>
      !q || (e.description || "").toLowerCase().includes(q) || (e.label || "").toLowerCase().includes(q)
    )
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.createdAt - a.createdAt);
}

/* ------------------------- Rendering ------------------------ */

async function renderAll() {
  renderSummary();
  renderCategories();
  renderTags();
  renderTable();
  renderCsvList();
}

function tagsFromEntries() {
  return [...new Set(entries.map((e) => e.label).filter((l) => l && String(l).trim() !== ""))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function renderTags() {
  const wrap = $("#tag-selector");
  if (!wrap) return;
  const tags = tagsFromEntries();
  filter.tags = filter.tags.filter((t) => tags.includes(t));
  if (!tags.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  wrap.innerHTML =
    (filter.tags.length ? `<button type="button" class="tag-clear" data-clear-tags>Clear tags</button>` : "") +
    tags
      .map((tag) => {
        const on = filter.tags.includes(tag);
        return `<button type="button" class="tag-btn${on ? " active" : ""}" data-tag="${escapeHTML(tag)}">${escapeHTML(tag)}</button>`;
      })
      .join("");
}

function renderSummary() {
  const rev = entries.filter((e) => e.type === "revenue").reduce((s, e) => s + e.amount, 0);
  const exp = entries.filter((e) => e.type === "expense").reduce((s, e) => s + e.amount, 0);
  $("#total-revenue").textContent = money(rev);
  $("#total-expenses").textContent = money(exp);
  $("#total-net").textContent = money(rev - exp);
  $("#total-net").classList.toggle("card", true);
  $("#total-count").textContent = entries.length;

  const filtered = getFilteredEntries();
  const filteredRev = filtered.filter((e) => e.type === "revenue").reduce((s, e) => s + e.amount, 0);
  $("#filtered-revenue").textContent = money(filteredRev);
  const filterOn =
    filter.type !== "all" || filter.category !== "all" || (filter.search || "").trim() !== "" || filter.tags.length > 0;
  $("#filtered-meta").textContent = filterOn
    ? `Filtering ${filtered.length} of ${entries.length} entries`
    : "All entries shown";
}

function renderCategories() {
  const sel = $("#expense-category");
  const current = sel.value;
  sel.innerHTML = categories.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
  if (categories.includes(current)) sel.value = current;

  const filterSel = $("#filter-category");
  const fc = filterSel.value;
  filterSel.innerHTML =
    `<option value="all">All categories</option>` +
    categories.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
  if (categories.includes(fc)) filterSel.value = fc;
}

function renderTable() {
  const rows = getFilteredEntries();
  const body = $("#ledger-body");
  $("#empty-state").classList.toggle("hidden", rows.length > 0);

  body.innerHTML = rows
    .map((e) => {
      keepThumb(e);
      const negative = e.type === "expense" || e.amount < 0;
      const amount = negative ? `-${money(Math.abs(e.amount))}` : money(e.amount);
      const thumb = e.image
        ? `<img class="thumb" src="${thumbUrls[e.id]}" title="View receipt" data-img="${e.id}" alt="Receipt">`
        : e.type === "expense"
        ? `<span class="badge exp">—</span>`
        : `<span class="badge rev">csv</span>`;
      const srcBadge = e.source === "csv"
        ? `<span class="badge rev">CSV</span>`
        : `<span class="badge exp">Manual</span>`;
      return `<tr>
        <td>${escapeHTML(fmtDate(e.date))}</td>
        <td class="desc-cell" title="${escapeHTML(e.description)}">${escapeHTML(e.description)}</td>
        <td><span class="cat-label">${escapeHTML(e.category || "—")}</span></td>
        <td>${e.label ? `<span class="label-tag">${escapeHTML(e.label)}</span>` : "—"}</td>
        <td>${srcBadge}</td>
        <td class="amount ${negative ? "expense" : "revenue"}">${amount}</td>
        <td>${thumb}</td>
        <td><button class="row-del" data-del="${e.id}" title="Delete entry">&times;</button></td>
      </tr>`;
    })
    .join("");
}

function renderCsvList() {
  const list = $("#csv-list");
  const items = [...csvFiles].sort((a, b) => b.createdAt - a.createdAt);
  list.innerHTML = items
    .map(
      (c) => `<li>
        <span class="csv-name">${escapeHTML(c.name)}</span>
        <span class="csv-meta">${c.rows} rows · ${fmtDate(c.date)} · ${money(c.total)}</span>
        <button class="row-del" data-csv-del="${c.id}" title="Delete uploaded file & its rows">&times;</button>
      </li>`
    )
    .join("");
}

/* ------------------ CSV upload & mapping -------------------- */

async function handleFileTransfer(file) {
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) {
    alert("That file is over 50 MB. Refusing to parse it locally.");
    return;
  }
  const text = await file.text();
  const delim = detectDelimiter(text);
  const rows = parseCSV(text, delim);
  if (rows.length < 2) {
    alert("The CSV appears empty or has only one row.");
    return;
  }
  openMapper(rows, file.name);
}

const $drop = $("#drop-zone");
$drop.addEventListener("click", () => $("#csv-input").click());
$drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#csv-input").click(); }
});
$("#csv-input").addEventListener("change", (e) => {
  handleFileTransfer(e.target.files[0]);
  e.target.value = "";
});
["dragenter", "dragover"].forEach((ev) =>
  $drop.addEventListener(ev, (e) => { e.preventDefault(); $drop.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  $drop.addEventListener(ev, (e) => { e.preventDefault(); $drop.classList.remove("dragover"); })
);
$drop.addEventListener("drop", (e) => {
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (file) handleFileTransfer(file);
});

/* Column guesser: keyword-aware, so e.g. "Total"/"Description"/"Date of sale"
   win over "Item price", "Size" or time-of-day text columns. */
function guessColumns(rows) {
  const headers = (rows[0] || []).map((h) => String(h ?? "").trim());
  const nCols = headers.length;
  const stats = [];
  for (let c = 0; c < nCols; c++) {
    let dates = 0, nums = 0, txts = 0, textSum = 0, absSum = 0;
    for (let r = 1; r < Math.min(rows.length, 80); r++) {
      const v = rows[r][c];
      if (v == null || String(v).trim() === "") continue;
      const s = String(v).trim();
      if (looksDate(s)) dates++;
      else if (looksNumeric(s)) { nums++; absSum += Math.abs(stripMoney(s)); }
      else { txts++; textSum += s.length; }
    }
    const total = dates + nums + txts;
    stats.push({
      c, header: headers[c], dates, nums, txts, total,
      dateRatio: total ? dates / total : 0,
      numRatio: total ? nums / total : 0,
      textRatio: total ? txts / total : 0,
      avgTextLen: txts ? textSum / txts : 0,
      absSum,
    });
  }
  const head = (i) => stats[i] ? stats[i].header : "";
  const m = (i, re) => re.test(head(i));

  /* date */
  let dateIdx = -1, bestDate = 0;
  for (const s of stats) if (s.dateRatio > 0.6 && s.dateRatio > bestDate) { bestDate = s.dateRatio; dateIdx = s.c; }
  for (const s of stats) if (/date|sold|purchased/i.test(s.header) && s.dateRatio > 0.4) { dateIdx = s.c; break; }

  /* amount: prefer gross-price keywords first, then plain "price", then largest sums */
  const strongKw = /total|amount|revenue|gross|net|sales|subtotal/i;
  const weakKw = /price|paid|grand/i;
  let amountIdx = -1;
  for (const s of stats)
    if (s.c !== dateIdx && s.numRatio > 0.7 && s.absSum > 0 && strongKw.test(s.header)) { amountIdx = s.c; break; }
  if (amountIdx === -1)
    for (const s of stats)
      if (s.c !== dateIdx && s.numRatio > 0.7 && s.absSum > 0 && weakKw.test(s.header)) { amountIdx = s.c; break; }
  if (amountIdx === -1) {
    let best = -1;
    for (const s of stats)
      if (s.c !== dateIdx && s.numRatio > 0.7 && s.absSum > best) { best = s.absSum; amountIdx = s.c; }
  }

  /* description: strong "description/title" keywords first, then longest-running text column */
  const descKwStrong = /desc|title|product|notes?|summary/i;
  let descIdx = -1;
  for (const s of stats)
    if (s.c !== dateIdx && s.c !== amountIdx && s.textRatio > 0.5 && descKwStrong.test(s.header)) { descIdx = s.c; break; }
  if (descIdx === -1) {
    let bestLen = -1;
    for (const s of stats)
      if (s.c !== dateIdx && s.c !== amountIdx && s.txts > 0 && s.textRatio >= 0.4 && s.avgTextLen > bestLen) {
        bestLen = s.avgTextLen; descIdx = s.c;
      }
  }

  /* category: optional, prefer an obvious "category" column, then type/group */
  let categoryIdx = -1;
  const catTiers = [/categor/i, /type|group|class/i];
  for (const tier of catTiers) {
    if (categoryIdx >= 0) break;
    for (const s of stats)
      if (s.c !== dateIdx && s.c !== amountIdx && s.c !== descIdx && tier.test(s.header) && s.textRatio > 0.6) {
        categoryIdx = s.c; break;
      }
  }

  return { dateIdx, amountIdx, descIdx, categoryIdx };
}

let mapperState = null;

function openMapper(rows, fileName) {
  const headers = rows[0];
  const nCols = headers.length;
  const guess = guessColumns(rows);

  const opts = (sel) =>
    headers.map((h, i) => `<option value="${i}">${escapeHTML(h || `Column ${i + 1}`)}</option>`).join("");

  $("#map-date").innerHTML = `<option value="-1">None</option>` + opts();
  $("#map-desc").innerHTML = `<option value="-1">None</option>` + opts();
  $("#map-amount").innerHTML = `<option value="-1">None</option>` + opts();
  $("#map-category").innerHTML = `<option value="-1">None</option>` + opts();
  if (nCols > 0) {
    // keep guessed indices valid
    const clamp = (i) => (i >= 0 && i < nCols ? i : -1);
    $("#map-date").value = clamp(guess.dateIdx);
    $("#map-desc").value = clamp(guess.descIdx);
    $("#map-amount").value = clamp(guess.amountIdx);
    $("#map-category").value = clamp(guess.categoryIdx);
  }

  $("#mapper-title").textContent = "Import " + fileName;
  $("#mapper-file").textContent = `${rows.length - 1} data rows · ${nCols} columns`;
  renderMapperPreview(rows);
  mapperState = { rows, fileName };
  $("#mapper-modal").showModal();
}

function renderMapperPreview(rows) {
  const [dateIdx, descIdx, amountIdx, categoryIdx] = [
    $("#map-date").value * 1, $("#map-desc").value * 1, $("#map-amount").value * 1, $("#map-category").value * 1,
  ];
  const nCols = rows[0].length;
  const bodyRows = rows.slice(0, 8);
  const head = `<tr>${rows[0]
    .map((h, i) => `<th>${escapeHTML(h || `Col ${i + 1}`)}</th>`)
    .join("")}</tr>`;
  const body = bodyRows
    .map((r) => {
      let cells = "";
      for (let i = 0; i < nCols; i++) {
        let cls = "";
        if (i === dateIdx) cls = "mapped-date";
        else if (i === amountIdx) cls = "mapped-amount";
        else if (i === descIdx) cls = "mapped-desc";
        else if (i === categoryIdx) cls = "mapped-cat";
        cells += `<td class="${cls}">${escapeHTML(r[i] ?? "")}</td>`;
      }
      return `<tr>${cells}</tr>`;
    })
    .join("");
  $("#mapper-preview").innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

["#map-date", "#map-desc", "#map-amount", "#map-category"].forEach((s) =>
  $(s).addEventListener("change", () => mapperState && renderMapperPreview(mapperState.rows))
);

function closeMapper() { $("#mapper-modal").close(); mapperState = null; }
$("#mapper-close").addEventListener("click", closeMapper);
$("#mapper-cancel").addEventListener("click", closeMapper);

$("#mapper-confirm").addEventListener("click", async () => {
  if (!mapperState) return;
  const { rows, fileName } = mapperState;
  const dateIdx = $("#map-date").value * 1;
  const descIdx = $("#map-desc").value * 1;
  const amountIdx = $("#map-amount").value * 1;
  const categoryIdx = $("#map-category").value * 1;

  if (amountIdx < 0) {
    alert("Pick an amount column so rows can be imported.");
    return;
  }

  let added = 0, skipped = 0, total = 0;
  const newEntries = [];
  const newCats = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const amount = stripMoney(row[amountIdx]);
    if (!isFinite(amount) || amount === 0) { skipped++; continue; }
    const date = dateIdx >= 0 ? normalizeDate(row[dateIdx]) : todayStr();
    const description =
      descIdx >= 0 && row[descIdx] != null && String(row[descIdx]).trim() !== ""
        ? String(row[descIdx]).trim()
        : "CSV row " + (r + 1);
    let category = "CSV Import";
    if (categoryIdx >= 0 && row[categoryIdx] != null && String(row[categoryIdx]).trim() !== "") {
      category = String(row[categoryIdx]).trim();
      if (!categories.includes(category) && !newCats.includes(category)) newCats.push(category);
    }
    const e = {
      id: uid(),
      type: "revenue",
      source: "csv",
      date,
      description,
      category,
      label: fileName,
      amount,
      image: null,
      imageName: null,
      createdAt: Date.now(),
    };
    newEntries.push(e);
    total += e.amount;
    added++;
  }

  for (const e of newEntries) await putEntry(e);
  if (newCats.length) {
    categories = categories.concat(newCats);
    saveCategories(categories);
  }
  if (added > 0) {
    const rec = {
      id: uid(),
      name: fileName,
      rows: added,
      date: todayStr(),
      total,
      createdAt: Date.now(),
      text: null,
    };
    await putCsv(rec);
  }
  entries = await getAllEntries();
  csvFiles = await getAllCsv();
  closeMapper();
  renderAll();
  alert(`Imported ${added} revenue row${added === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}.`);
});

/* ---------------------- Expense form ------------------------ */

$("#expense-date").value = todayStr();

$("#expense-image").addEventListener("change", (e) => {
  const f = e.target.files[0];
  $("#image-file-name").textContent = f ? `${f.name} (${(f.size / 1024).toFixed(0)} KB)` : "";
});

async function promptForNewCategory() {
  const existing = $("#expense-category").value;
  const text = prompt("Add a new expense category:", existing ? `New ${existing}` : "New category");
  if (!text || !text.trim()) return;
  const name = text.trim();
  if (!categories.includes(name)) {
    categories.push(name);
    saveCategories(categories);
    renderCategories();
  }
  $("#expense-category").value = name;
}

$("#expense-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const date = $("#expense-date").value || todayStr();
  const amount = parseFloat($("#expense-amount").value);
  const description = $("#expense-desc").value.trim();
  const category = $("#expense-category").value;
  const label = $("#expense-label").value.trim();
  const file = $("#expense-image").files[0];

  if (!isFinite(amount) || amount <= 0) { alert("Enter a valid expense amount."); return; }
  if (!description) { alert("Enter a description."); return; }

  let image = null, imageName = null, imageLoaded = false;
  if (file) {
    if (file.size > 15 * 1024 * 1024) { alert("Image is larger than 15 MB."); return; }
    image = file;
    imageName = file.name;
    imageLoaded = true;
  }

  const entry = {
    id: uid(),
    type: "expense",
    source: "manual",
    date,
    description,
    category,
    label,
    amount,
    image,
    imageName,
    imageLoaded,
    createdAt: Date.now(),
  };
  await putEntry(entry);
  entries = await getAllEntries();
  renderAll();
  e.target.reset();
  $("#expense-date").value = todayStr();
  $("#image-file-name").textContent = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});

/* --------------- Inline "new category" quick-add ------------ */
const catWrap = $("#expense-category").closest("label");
const addCatBtn = document.createElement("button");
addCatBtn.type = "button";
addCatBtn.className = "badge clickable";
addCatBtn.style.marginTop = "6px";
addCatBtn.textContent = "+ new category";
addCatBtn.addEventListener("click", promptForNewCategory);
catWrap.appendChild(addCatBtn);

/* ---------------------- Filtering --------------------------- */

$("#filter-type").addEventListener("change", (e) => { filter.type = e.target.value; renderSummary(); renderTable(); });
$("#filter-category").addEventListener("change", (e) => { filter.category = e.target.value; renderSummary(); renderTable(); });
$("#filter-search").addEventListener("input", (e) => { filter.search = e.target.value; renderSummary(); renderTable(); });

$("#tag-selector").addEventListener("click", (e) => {
  if (e.target.closest("[data-clear-tags]")) {
    filter.tags = [];
    renderTags();
    renderSummary();
    renderTable();
    return;
  }
  const btn = e.target.closest("[data-tag]");
  if (!btn) return;
  const tag = btn.dataset.tag;
  filter.tags = filter.tags.includes(tag)
    ? filter.tags.filter((t) => t !== tag)
    : [...filter.tags, tag];
  renderTags();
  renderSummary();
  renderTable();
});

/* ------------------ Deletions & lightbox -------------------- */

function confirmDelete(message, onConfirm) {
  $("#confirm-text").textContent = message;
  const modal = $("#confirm-modal");
  const ok = $("#confirm-ok");
  const cancel = $("#confirm-cancel");
  ok.onclick = async () => { modal.close(); await onConfirm(); };
  cancel.onclick = () => modal.close();
  modal.showModal();
}

$("#ledger-body").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    const id = del.dataset.del;
    const entry = entries.find((x) => x.id === id);
    const label = `${entry.description || entry.id} (${money(entry.amount)})`;
    confirmDelete(`Delete "${label}"? This cannot be undone.`, async () => {
      await deleteEntry(id);
      releaseThumb(id);
      entries = await getAllEntries();
      renderAll();
    });
    return;
  }
  const img = e.target.closest("[data-img]");
  if (img) showLightbox(img.dataset.img);
});

$("#csv-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-csv-del]");
  if (!del) return;
  const id = del.dataset.csvDel;
  const rec = csvFiles.find((c) => c.id === id);
  confirmDelete(
    `Delete uploaded file "${rec?.name}" and EVERY row imported from it?`,
    async () => {
      await deleteCsv(id);
      const doomed = entries.filter((x) => x.source === "csv" && x.label === rec.name);
      for (const d of doomed) { await deleteEntry(d.id); releaseThumb(d.id); }
      entries = await getAllEntries();
      csvFiles = await getAllCsv();
      renderAll();
    }
  );
});

function showLightbox(id) {
  const thumbUrl = thumbUrls[id];
  if (!thumbUrl) return;
  const entry = entries.find((x) => x.id === id);
  $("#lightbox-title").textContent = entry ? entry.description : "Receipt";
  $("#lightbox-img").src = thumbUrl;
  $("#lightbox").showModal();
}
$("#lightbox-close").addEventListener("click", () => $("#lightbox").close());
$("#lightbox").addEventListener("click", (e) => {
  if (e.target === $("#lightbox")) $("#lightbox").close();
});

/* --------------------- Backup / restore --------------------- */

async function buildBackup() {
  const allImagesBase64 = new Map();
  const cleanEntries = [];
  for (const e of entries) {
    const { image, ...rest } = e;
    let img = null;
    if (image) {
      img = await blobToBase64(image);
    }
    cleanEntries.push({ ...rest, imageBase64: img, imageName: e.imageName || null });
  }
  // preserve image names for entries without blob (defensive)
  return {
    app: "ledger",
    version: 1,
    exportedAt: new Date().toISOString(),
    categories,
    entries: cleanEntries,
    csvFiles,
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataURLToBlob(dataUrl) {
  const [head, data] = dataUrl.split(",");
  const mime = (head.match(/^data:(.*?);base64$/) || [])[1] || "application/octet-stream";
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function download(filename, content) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$("#btn-export-backup").addEventListener("click", async () => {
  const backup = await buildBackup();
  const stamp = todayStr().replace(/-/g, "");
  download(`ledger-backup-${stamp}.json`, JSON.stringify(backup, null, 2));
});

$("#btn-import-backup").addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== "ledger" || !Array.isArray(data.entries)) throw new Error("bad file");
      confirmDelete(
        "Restore this backup? This REPLACES all current data on this device.",
        async () => {
          const db = await getDB();
          const tx = db.transaction(["entries", "csv"], "readwrite");
          reqToPromise(tx.objectStore("entries").clear());
          reqToPromise(tx.objectStore("csv").clear());
          await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
          for (const e of data.entries) {
            await putEntry({
              ...e,
              image: e.imageBase64 ? dataURLToBlob(e.imageBase64) : null,
            });
          }
          for (const c of data.csvFiles || []) {
            await putCsv({ ...c, text: null });
          }
          if (Array.isArray(data.categories) && data.categories.length) {
            categories = data.categories;
            saveCategories(categories);
          }
          await refreshFromDB();
          releaseAllThumbs();
          renderAll();
          alert("Backup restored.");
        }
      );
    } catch {
      alert("That file doesn't look like a Ledger backup.");
    }
  };
  input.click();
});

/* ------------------------ Bubbly theme toggle ------------------------ */

(function initBubbly() {
  const root = document.documentElement;
  const btn = document.getElementById("btn-bubbly");
  const isOn = () => root.getAttribute("data-bubbly") === "true";
  const apply = () => {
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(isOn()));
    const tag = btn.querySelector(".bubble-tag");
    if (tag) tag.textContent = isOn() ? "Bubbly on" : "Bubbly";
  };
  apply();
  if (btn) {
    btn.addEventListener("click", () => {
      const next = !isOn();
      if (next) root.setAttribute("data-bubbly", "true");
      else root.removeAttribute("data-bubbly");
      try {
        localStorage.setItem("ledger-bubbly", next ? "1" : "0");
      } catch {}
      apply();
    });
  }
})();

/* --------------------------- Init --------------------------- */

async function refreshFromDB() {
  entries = await getAllEntries();
  csvFiles = await getAllCsv();
}

(async function init() {
  await refreshFromDB();
  renderAll();
})();