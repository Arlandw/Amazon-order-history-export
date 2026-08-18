const siteEl = document.getElementById("site");
const rangesEl = document.getElementById("ranges");
const yearsEl = document.getElementById("years");
const periodYearEl = document.getElementById("periodYear");
const quartersEl = document.getElementById("quarters");
const monthsEl = document.getElementById("months");
const customDates = document.getElementById("customDates");
const fromDate = document.getElementById("fromDate");
const toDate = document.getElementById("toDate");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const openBtn = document.getElementById("openOrders");
const viewBtn = document.getElementById("viewResults");
const progressEl = document.getElementById("progress");
const barEl = document.getElementById("bar");
const statusEl = document.getElementById("status");

const now = new Date().getFullYear();
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let rangeId = "years";
let userTouched = false;

for (const s of SITES) {
  const o = document.createElement("option");
  o.value = s.host;
  o.textContent = s.label;
  siteEl.appendChild(o);
}

for (const r of RANGES) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.range = r.id;
  b.textContent = r.label;
  if (r.id === "years") b.classList.add("on");
  b.addEventListener("click", () => { userTouched = true; setRange(r.id); });
  rangesEl.appendChild(b);
}

for (let y = now; y >= now - 7; y--) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.year = String(y);
  b.textContent = String(y);
  if (y >= now - 1) b.classList.add("on");
  b.addEventListener("click", () => b.classList.toggle("on"));
  yearsEl.appendChild(b);
}

for (let y = now; y >= now - 7; y--) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.year = String(y);
  b.textContent = String(y);
  if (y === now) b.classList.add("on");
  b.addEventListener("click", () => {
    for (const x of periodYearEl.querySelectorAll("button")) x.classList.remove("on");
    b.classList.add("on");
  });
  periodYearEl.appendChild(b);
}

for (const q of ["Q1", "Q2", "Q3", "Q4"]) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.quarter = q;
  b.textContent = q;
  b.addEventListener("click", () => b.classList.toggle("on"));
  quartersEl.appendChild(b);
}

for (let i = 0; i < 12; i++) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.month = String(i + 1);
  b.textContent = MONTH_LABELS[i];
  b.addEventListener("click", () => b.classList.toggle("on"));
  monthsEl.appendChild(b);
}

function setRange(id) {
  rangeId = id;
  for (const b of rangesEl.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.range === id);
  }
  yearsEl.style.display = id === "years" ? "grid" : "none";
  periodYearEl.style.display = id === "quarters" || id === "months" ? "grid" : "none";
  quartersEl.style.display = id === "quarters" ? "grid" : "none";
  monthsEl.style.display = id === "months" ? "grid" : "none";
  customDates.hidden = id !== "custom";
}

function selectedYears() {
  return [...yearsEl.querySelectorAll("button.on")].map((b) => Number(b.dataset.year));
}

function selectedPeriodYear() {
  const on = periodYearEl.querySelector("button.on");
  return on ? Number(on.dataset.year) : now;
}

function selectedQuarters() {
  return [...quartersEl.querySelectorAll("button.on")].map((b) => b.dataset.quarter);
}

function selectedMonths() {
  return [...monthsEl.querySelectorAll("button.on")].map((b) => Number(b.dataset.month));
}

const FORMAT_ORDER = ["orders", "items", "payments", "shipments"];
const FORMAT_LABELS = { orders: "Orders", items: "Items", payments: "Payments", shipments: "Shipments" };

function formatChoice() {
  return FORMAT_ORDER.filter((v) => {
    const el = document.querySelector(`input[name=format][value="${v}"]`);
    return el && el.checked;
  });
}

function applyFormats(list) {
  const set = new Set(list || []);
  for (const el of document.querySelectorAll("input[name=format]")) {
    el.checked = set.has(el.value);
  }
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return names[0] + " and " + names[1];
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}

function updateFormatHint() {
  const formats = formatChoice();
  const hint = document.getElementById("formatHint");
  const names = formats.map((v) => FORMAT_LABELS[v] || v);
  if (!hint) return;
  hint.classList.toggle("err", formats.length === 0);
  if (!formats.length) {
    hint.textContent = "Pick at least one report.";
    startBtn.textContent = "Build report";
    return;
  }
  if (formats.length === 1) {
    hint.textContent = "Build will generate the " + names[0] + " report.";
    startBtn.textContent = "Build report";
    return;
  }
  hint.textContent = "Build will generate " + formats.length + " reports (" + joinNames(names) + ").";
  startBtn.textContent = "Build reports";
}

function scrapeFormatOf(formats) {
  return formats.includes("shipments") ? "shipments" : formats[0];
}

function origin() {
  return "https://" + siteEl.value;
}

function setStatus(text, kind) {
  const first = !progressEl.classList.contains("show");
  progressEl.classList.add("show");
  if (first) {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => progressEl.classList.add("is-visible"));
    } else {
      progressEl.classList.add("is-visible");
    }
  } else {
    progressEl.classList.add("is-visible");
  }
  statusEl.textContent = text;
  statusEl.classList.toggle("ok", kind === "ok");
  statusEl.classList.toggle("err", kind === "err");
}

function running(on) {
  startBtn.disabled = on;
  stopBtn.classList.toggle("show", on);
}

chrome.storage.local.get(["site", "range", "years", "format", "formats", "fromDate", "toDate", "lastExport", "useCache", "quarters", "months", "periodYear"], (saved) => {
  if (userTouched) { viewBtn.disabled = !saved.lastExport; refreshCacheHint(); return; }
  if (saved.site && SITES.some((s) => s.host === saved.site)) siteEl.value = saved.site;
  if (saved.range) setRange(saved.range);
  if (Array.isArray(saved.years) && saved.years.length) {
    for (const b of yearsEl.querySelectorAll("button")) {
      b.classList.toggle("on", saved.years.includes(Number(b.dataset.year)));
    }
  }
  if (saved.periodYear) {
    for (const b of periodYearEl.querySelectorAll("button")) {
      b.classList.toggle("on", Number(b.dataset.year) === Number(saved.periodYear));
    }
  }
  if (Array.isArray(saved.quarters) && saved.quarters.length) {
    for (const b of quartersEl.querySelectorAll("button")) {
      b.classList.toggle("on", saved.quarters.includes(b.dataset.quarter));
    }
  }
  if (Array.isArray(saved.months) && saved.months.length) {
    for (const b of monthsEl.querySelectorAll("button")) {
      b.classList.toggle("on", saved.months.includes(Number(b.dataset.month)));
    }
  }
  if (Array.isArray(saved.formats) && saved.formats.length) {
    applyFormats(saved.formats);
  } else if (saved.format) {
    applyFormats([saved.format]);
  }
  updateFormatHint();
  if (saved.fromDate) fromDate.value = saved.fromDate;
  if (saved.toDate) toDate.value = saved.toDate;
  if (saved.useCache === false) document.getElementById("useCache").checked = false;
  viewBtn.disabled = !saved.lastExport;
  refreshCacheHint();
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = tabs[0] && tabs[0].url;
  if (!url) return;
  try {
    const host = new URL(url).hostname;
    const match = SITES.find((s) => host.endsWith(s.host.replace("www.", "")) || host === s.host);
    if (match) siteEl.value = match.host;
  } catch (_) {}
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "progress") return;
  setStatus(msg.text);
  if (msg.total) barEl.style.width = `${Math.max(4, Math.round((100 * (msg.current || 0)) / msg.total))}%`;
});

startBtn.addEventListener("click", async () => {
  const formats = formatChoice();
  const format = scrapeFormatOf(formats);
  const years = selectedYears();
  const periodYear = selectedPeriodYear();
  const quarters = selectedQuarters();
  const months = selectedMonths();
  if (!formats.length) {
    updateFormatHint();
    setStatus("Pick at least one report.", "err");
    return;
  }
  if (rangeId === "years" && !years.length) {
    setStatus("Pick at least one year.", "err");
    return;
  }
  if (rangeId === "quarters" && !quarters.length) {
    setStatus("Pick at least one quarter.", "err");
    return;
  }
  if (rangeId === "months" && !months.length) {
    setStatus("Pick at least one month.", "err");
    return;
  }
  if (rangeId === "custom" && (!fromDate.value || !toDate.value)) {
    setStatus("Pick a start and end date.", "err");
    return;
  }
  chrome.storage.local.set({
    site: siteEl.value,
    range: rangeId,
    years,
    periodYear,
    quarters,
    months,
    format,
    formats,
    fromDate: fromDate.value,
    toDate: toDate.value,
    useCache: document.getElementById("useCache").checked,
  });
  running(true);
  barEl.style.width = "6%";
  setStatus("Starting. Stay signed in on this Amazon site.");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "scrape",
      origin: origin(),
      range: rangeId,
      years,
      periodYear,
      quarters,
      months,
      fromDate: fromDate.value,
      toDate: toDate.value,
      format,
      formats,
      useCache: document.getElementById("useCache").checked,
    });
    if (res && res.error) {
      barEl.style.width = "100%";
      setStatus(res.error, "err");
    } else if (res && res.ok) {
      barEl.style.width = "100%";
      const n = Array.isArray(res.formats) ? res.formats.length : 1;
      setStatus(n > 1 ? `Ready. ${n} reports.` : `Ready. ${res.rows} rows.`, "ok");
      viewBtn.disabled = false;
      refreshCacheHint();
    }
  } catch (e) {
    setStatus(String(e), "err");
  } finally {
    running(false);
  }
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "cancel" });
  setStatus("Stopping…");
});

openBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: origin() + "/gp/css/order-history?disableCsd=no-js" });
});

viewBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
});

function refreshCacheHint() {
  const key = "orderCache:" + siteEl.value;
  chrome.storage.local.get(key, (data) => {
    const n = data[key] && data[key].orders ? Object.keys(data[key].orders).length : 0;
    document.getElementById("cacheHint").textContent = n
      ? `${n} invoices saved for this site.`
      : "No saved invoices for this site yet.";
  });
}
siteEl.addEventListener("change", refreshCacheHint);
document.getElementById("clearCache").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearCache", origin: origin() });
  refreshCacheHint();
  setStatus("Cleared saved invoices for this site.");
});

for (const el of document.querySelectorAll("input[name=format]")) {
  el.addEventListener("change", () => {
    updateFormatHint();
    const formats = formatChoice();
    chrome.storage.local.set({
      formats,
      format: formats.length ? scrapeFormatOf(formats) : "orders",
    });
  });
}
updateFormatHint();

if (typeof requestAnimationFrame === "function") {
  requestAnimationFrame(() => document.body.classList.add("is-ready"));
} else {
  document.body.classList.add("is-ready");
}
