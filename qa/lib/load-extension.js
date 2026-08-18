"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createChromeStub } = require("./chrome-stub");

const EXT = path.resolve(__dirname, "../../extension");

function loadSites() {
  const code = fs.readFileSync(path.join(EXT, "sites.js"), "utf8");
  const sandbox = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(code + "\nthis.SITES = SITES; this.RANGES = RANGES;", sandbox, { filename: "sites.js" });
  return { SITES: sandbox.SITES, RANGES: sandbox.RANGES };
}

function loadBackground(opts) {
  const chrome = (opts && opts.chrome) || createChromeStub();
  const fetchImpl = opts && opts.fetch ? opts.fetch : async () => {
    throw new Error("fetch not stubbed");
  };
  let src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  src = src.replace(
    "function sleep(ms) {\n  return new Promise((r) => setTimeout(r, ms));\n}",
    "function sleep(ms) { return Promise.resolve(); }"
  );
  const sandbox = {
    chrome,
    console,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Promise,
    JSON,
    Error,
    RegExp,
    Math,
    URL,
  };
  sandbox.globalThis = sandbox;
  const exportTail = `
    globalThis.__bg = {
      parseListPage, parseInvoice, parseCard, extractPayments, extractTitles,
      enrichItems, cacheKey, cacheReady, mergeItems, itemsCell, inRange,
      toISO, moneyPlain, labeledMoney, isRealOrderId, decode, stripTags,
      toRows, toCsv, csvEscape, loadCache, saveCache, scrapeWindow,
      amazonGet, extractTitles, checkCancel, progress,
      parseShipments, parseTrackingId, deliveredFlag, extractShipmentStatus,
      rangeWindow, lastMonthsWindow, quarterWindow, monthWindow,
      dateMatchesQuarters, dateMatchesMonths, absAmazonUrl, attachShipments,
      normalizeFormats, readyReportText,
      get currentOrigin() { return currentOrigin; },
      set currentOrigin(v) { currentOrigin = v; },
      get cancelled() { return cancelled; },
      set cancelled(v) { cancelled = v; },
      get scrapeRunning() { return scrapeRunning; },
      set scrapeRunning(v) { scrapeRunning = v; },
    };
  `;
  vm.runInNewContext(src + exportTail, sandbox, { filename: "background.js" });
  return { chrome, bg: sandbox.__bg, sandbox };
}

function makeDocument(html) {
  // Minimal document enough for results.js + targeted popup checks.
  const { JSDOM } = tryJsdom();
  if (JSDOM) {
    const dom = new JSDOM(html, { url: "https://example.test/popup.html", runScripts: "outside-only" });
    return { window: dom.window, document: dom.window.document, dom, usingJsdom: true };
  }
  return null;
}

function tryJsdom() {
  try {
    return require("jsdom");
  } catch (_) {
    return {};
  }
}

function loadResults(html, chrome) {
  const env = makeDocument(html);
  if (!env) throw new Error("jsdom is required for results tests");
  const src = fs.readFileSync(path.join(EXT, "results.js"), "utf8");
  env.window.chrome = chrome;
  env.window.navigator.clipboard = {
    writeText: async (t) => { env.window.__copied = t; },
  };
  const downloads = [];
  env.window.__downloads = downloads;
  const origCreate = env.window.URL.createObjectURL;
  env.window.URL.createObjectURL = (blob) => {
    downloads.push(blob);
    return "blob:test-1";
  };
  env.window.URL.revokeObjectURL = () => {};
  env.window.eval(src);
  // Re-eval does not export. Pull functions from the script by wrapping.
  return env;
}

function loadResultsExported(html, chrome) {
  const env = makeDocument(html);
  if (!env) throw new Error("jsdom is required for results tests");
  const src = fs.readFileSync(path.join(EXT, "results.js"), "utf8");
  const sandbox = {
    chrome,
    console,
    document: env.document,
    window: env.window,
    navigator: {
      clipboard: {
        writeText: async (t) => { sandbox.__copied = t; },
      },
    },
    URL: {
      createObjectURL(blob) {
        sandbox.__blobs = sandbox.__blobs || [];
        sandbox.__blobs.push(blob);
        return "blob:test-1";
      },
      revokeObjectURL() {},
    },
    setTimeout,
    clearTimeout,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Promise,
    JSON,
    Error,
    RegExp,
    Math,
    Event: env.window.Event,
    MouseEvent: env.window.MouseEvent,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const tail = `
    globalThis.__res = {
      get rows() { return rows; }, set rows(v) { rows = v; },
      get headers() { return headers; }, set headers(v) { headers = v; },
      get format() { return format; }, set format(v) { format = v; },
      get sortKey() { return sortKey; }, set sortKey(v) { sortKey = v; },
      get sortDir() { return sortDir; }, set sortDir(v) { sortDir = v; },
      csvEscape, toCsv, filtered, moneyNum, moneyFmt, renderTotals, render, download, showReport, updateTabs,
      get reports() { return reports; }, set reports(v) { reports = v; },
      get activeIndex() { return activeIndex; }, set activeIndex(v) { activeIndex = v; },
    };
  `;
  vm.runInNewContext(src + tail, sandbox, { filename: "results.js" });
  return { chrome, res: sandbox.__res, sandbox, document: env.document, window: env.window };
}

function loadPopup(html, chrome, sites) {
  const env = makeDocument(html);
  if (!env) throw new Error("jsdom is required for popup tests");
  const src = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
  const sandbox = {
    chrome,
    console,
    document: env.document,
    window: env.window,
    SITES: sites.SITES,
    RANGES: sites.RANGES,
    setTimeout,
    clearTimeout,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Promise,
    JSON,
    Error,
    RegExp,
    Math,
    URL: env.window.URL,
  };
  sandbox.window = env.window;
  sandbox.globalThis = sandbox;
  const tail = `
    globalThis.__popup = {
      get rangeId() { return rangeId; }, set rangeId(v) { rangeId = v; },
      setRange, selectedYears, selectedPeriodYear, selectedQuarters, selectedMonths,
      formatChoice, origin, setStatus, running, refreshCacheHint, updateFormatHint, applyFormats, scrapeFormatOf,
      siteEl, yearsEl, periodYearEl, quartersEl, monthsEl, rangesEl, customDates, fromDate, toDate, startBtn, stopBtn, viewBtn,
    };
  `;
  vm.runInNewContext(src + tail, sandbox, { filename: "popup.js" });
  return { chrome, popup: sandbox.__popup, sandbox, document: env.document, window: env.window };
}

module.exports = {
  EXT, loadSites, loadBackground, loadResultsExported, loadPopup,
};
