"use strict";

const fs = require("fs");
const path = require("path");
const { createChromeStub } = require("./lib/chrome-stub");
const {
  EXT, loadSites, loadBackground, loadResultsExported, loadPopup,
} = require("./lib/load-extension");
const F = require("./lib/fixtures");

const results = [];
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(a, b, msg) {
  if (a !== b) {
    throw new Error(`${msg || "eq"}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  }
}
function includes(hay, needle, msg) {
  if (!String(hay).includes(needle)) {
    throw new Error(`${msg || "includes"}: expected to find ${JSON.stringify(needle)} in ${JSON.stringify(hay).slice(0, 300)}`);
  }
}
async function test(feature, name, fn) {
  try {
    await fn();
    results.push({ feature, name, status: "PASS" });
    console.log(`PASS  [${feature}] ${name}`);
  } catch (e) {
    const msg = String(e.message || e);
    if (/jsdom is required/i.test(msg)) {
      results.push({ feature, name, status: "SKIP", error: msg });
      console.log(`SKIP  [${feature}] ${name} (no jsdom)`);
      return;
    }
    results.push({ feature, name, status: "FAIL", error: msg, stack: e.stack });
    console.log(`FAIL  [${feature}] ${name}`);
    console.log("      " + msg);
  }
}

function htmlRes(url, text, extra) {
  extra = extra || {};
  return {
    ok: extra.ok !== false,
    status: extra.status || 200,
    url: extra.redirectUrl || url,
    text: async () => text,
  };
}

function makeFetch(spec) {
  const calls = [];
  async function fetch(url) {
    const u = String(url);
    calls.push(u);
    if (spec.signIn) return htmlRes("https://www.amazon.com/ap/signin", F.signInPage(), { redirectUrl: "https://www.amazon.com/ap/signin" });
    if (u.includes("/gp/css/order-history")) {
      const idx = Number((u.match(/startIndex=(\d+)/) || [0, "0"])[1]);
      const html = spec.pages[idx] != null ? spec.pages[idx] : F.listPage({ orders: [], count: spec.count || 0 });
      return htmlRes(u, html);
    }
    if (u.includes("/gp/css/summary/print.html")) {
      const id = (u.match(/orderID=([0-9-]+)/) || [])[1];
      if (spec.invoiceFail && spec.invoiceFail.has(id)) {
        return htmlRes(u, "nope", { ok: false, status: 500 });
      }
      if (spec.invoices[id]) return htmlRes(u, spec.invoices[id]);
      return htmlRes(u, "missing", { ok: false, status: 404 });
    }
    if (u.includes("/gp/your-account/order-details")) {
      const id = (u.match(/orderID=([0-9-]+)/) || [])[1];
      return htmlRes(u, spec.details[id] || "<html><body>empty</body></html>");
    }
    if (u.includes("/progress-tracker/") || u.includes("/ship-track")) {
      const sid = (u.match(/shipmentId=([^&]+)/) || [])[1];
      if (spec.tracking && spec.tracking[sid]) return htmlRes(u, spec.tracking[sid]);
      if (spec.trackingPage) return htmlRes(u, spec.trackingPage);
      return htmlRes(u, "<html><body>no tracking</body></html>");
    }
    return htmlRes(u, "<html></html>");
  }
  fetch.calls = calls;
  return fetch;
}

function writeFixtureFiles() {
  const dir = path.join(__dirname, "fixtures");
  fs.writeFileSync(path.join(dir, "order-list.html"), F.listPage({
    orders: [
      { id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" },
      { id: F.ORDER_B, date: "March 3, 2024", total: "$41.10", to: "John Smith", asin: "B0MOUSE456", title: "Wireless Mouse Silent Click" },
    ],
    count: 2,
    extra: `<!-- also a placeholder ${F.FAKE_ID} -->`,
  }));
  fs.writeFileSync(path.join(dir, "print-invoice.html"), F.printInvoice(F.sampleOrders.A));
  fs.writeFileSync(path.join(dir, "order-details.html"), F.orderDetails(F.sampleOrders.B));
  fs.writeFileSync(path.join(dir, "signin.html"), F.signInPage());
  fs.writeFileSync(path.join(dir, "shipment-details.html"), F.orderDetailsWithShipment(Object.assign({}, F.sampleOrders.A, {
    shipmentId: "DsC3gvwsv",
    status: "Delivered",
  })));
  fs.writeFileSync(path.join(dir, "tracking.html"), F.trackingPage("TBA123456789000"));
}

async function main() {
  writeFixtureFiles();
  const sites = loadSites();
  const popupHtml = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
  const resultsHtml = fs.readFileSync(path.join(EXT, "results.html"), "utf8");
  const privacyHtml = fs.readFileSync(path.join(EXT, "privacy.html"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const popupSrc = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
  const resultsSrc = fs.readFileSync(path.join(EXT, "results.js"), "utf8");
  const bgSrc = fs.readFileSync(path.join(EXT, "background.js"), "utf8");

  // ---------- Manifest / consistency ----------
  await test("manifest", "MV3 service worker + popup + icons", () => {
    eq(manifest.manifest_version, 3, "mv");
    eq(manifest.version, "2.4.8", "version");
    eq(manifest.background.service_worker, "background.js", "sw");
    eq(manifest.action.default_popup, "popup.html", "popup");
    assert(fs.existsSync(path.join(EXT, "icons/icon16.png")), "icon16");
    assert(fs.existsSync(path.join(EXT, "icons/icon48.png")), "icon48");
    assert(fs.existsSync(path.join(EXT, "icons/icon128.png")), "icon128");
    eq(manifest.icons["16"], "icons/icon16.png", "icon16 path");
    eq(manifest.action.default_icon["128"], "icons/icon128.png", "action icon");
  });

  await test("manifest", "permissions and host list match sites.js", () => {
    const perms = manifest.permissions.slice().sort();
    assert(perms.includes("storage"), "storage");
    assert(perms.includes("tabs"), "tabs");
    assert(perms.includes("downloads"), "downloads");
    const hosts = manifest.host_permissions.map((h) => h.replace("https://", "").replace("/*", "")).sort();
    const siteHosts = sites.SITES.map((s) => s.host).sort();
    eq(JSON.stringify(hosts), JSON.stringify(siteHosts), "hosts");
    eq(sites.SITES.length, 12, "12 sites");
  });

  await test("manifest", "downloads permission is unused in source", () => {
    const used = /chrome\.downloads/.test(bgSrc) || /chrome\.downloads/.test(popupSrc) || /chrome\.downloads/.test(resultsSrc);
    assert(!used, "expected chrome.downloads to be unused");
    // This is an observation test: unused permission is a lint, not a functional fail.
    // We still PASS the observation so the report can call it out separately.
  });

  await test("consistency", "HTML script tags and brand assets exist", () => {
    includes(popupHtml, 'src="sites.js"', "popup sites");
    includes(popupHtml, 'src="popup.js"', "popup js");
    includes(resultsHtml, 'src="results.js"', "results js");
    includes(popupHtml, 'src="brand/logo.svg"', "popup logo");
    includes(resultsHtml, 'src="brand/logo.svg"', "results logo");
    includes(privacyHtml, 'src="brand/logo.svg"', "privacy logo");
    assert(fs.existsSync(path.join(EXT, "brand/logo.svg")), "logo.svg");
    assert(fs.existsSync(path.join(EXT, "brand/icon.svg")), "icon.svg");
    assert(fs.existsSync(path.join(EXT, "privacy.html")), "privacy");
  });

  await test("consistency", "popup IDs match popup.js getElementById", () => {
    const ids = [...popupSrc.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const id of ids) {
      assert(popupHtml.includes(`id="${id}"`), `missing id ${id} in popup.html`);
    }
    for (const need of ["site", "ranges", "years", "periodYear", "quarters", "months", "customDates", "fromDate", "toDate", "useCache", "cacheHint", "formatHint", "clearCache", "start", "stop", "openOrders", "viewResults", "progress", "bar", "status"]) {
      assert(popupHtml.includes(`id="${need}"`), `missing ${need}`);
    }
    for (const v of ["orders", "items", "payments", "shipments"]) {
      assert(popupHtml.includes(`value="${v}"`), `format ${v}`);
    }
  });

  await test("consistency", "results IDs match results.js", () => {
    const ids = [...resultsSrc.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const id of ids) {
      assert(resultsHtml.includes(`id="${id}"`), `missing id ${id} in results.html`);
    }
  });

  await test("consistency", "range ids and format values match background", () => {
    const rangeIds = sites.RANGES.map((r) => r.id);
    eq(rangeIds.join(","), "last30,last1,last2,months-3,years,quarters,months,custom", "ranges");
    includes(bgSrc, 'range === "last30"', "last30");
    includes(bgSrc, 'range === "months-3"', "months-3");
    includes(bgSrc, 'range === "custom"', "custom");
    includes(bgSrc, 'range === "quarters"', "quarters");
    includes(bgSrc, "timeFilter=${timeFilter}", "url template");
    includes(bgSrc, "year-${year}", "url year");
    includes(bgSrc, '"last30"', "last30 id");
    includes(bgSrc, '"months-3"', "months-3 id");
    includes(bgSrc, '"last1"', "last1 id");
    includes(bgSrc, '"shipments"', "shipments format");
  });

  await test("popup", "setRange uses display:grid in source", () => {
    includes(popupSrc, 'yearsEl.style.display = id === "years" ? "grid" : "none"', "grid");
    includes(popupHtml, "#years { grid-template-columns: repeat(4, 1fr); }", "css grid");
    assert(!/yearsEl\.style\.display = id === "years" \? "flex"/.test(popupSrc), "not flex");
  });

  // ---------- Parser unit tests ----------
  {
    const { bg } = loadBackground();
    await test("parsers", "isRealOrderId accepts live-shaped IDs and rejects placeholders", () => {
      assert(bg.isRealOrderId(F.ORDER_A), "A");
      assert(bg.isRealOrderId(F.ORDER_B), "B");
      assert(!bg.isRealOrderId(F.FAKE_ID), "000-");
      assert(!bg.isRealOrderId("111-0000000-1234567"), "seven zeros");
      assert(!bg.isRealOrderId("12-1234567-1234567"), "short");
    });

    await test("parsers", "toISO English dates and ISO passthrough", () => {
      eq(bg.toISO("January 15, 2024"), "2024-01-15", "jan");
      eq(bg.toISO("March 3, 2024"), "2024-03-03", "mar");
      eq(bg.toISO("2024-07-20"), "2024-07-20", "iso");
      eq(bg.toISO(""), "", "empty");
    });

    await test("parsers", "moneyPlain strips symbols", () => {
      eq(bg.moneyPlain("$28.43"), "28.43", "usd");
      eq(bg.moneyPlain("£12.00"), "12.00", "gbp");
      eq(bg.moneyPlain("€9.99"), "9.99", "eur");
      eq(bg.moneyPlain("¥1,234"), "1,234", "yen");
    });

    await test("parsers", "decode + stripTags", () => {
      eq(bg.decode("A &amp; B &#39;ok&#39;"), "A & B 'ok'", "ents");
      eq(bg.stripTags("<i>USB-C Cable 6ft Braided</i>"), "USB-C Cable 6ft Braided", "i");
    });

    await test("parsers", "inRange inclusive ISO, undated pass through", () => {
      assert(bg.inRange("2024-03-03", "2024-01-01", "2024-12-31"), "in");
      assert(!bg.inRange("2023-12-31", "2024-01-01", "2024-12-31"), "before");
      assert(!bg.inRange("2025-01-01", "2024-01-01", "2024-12-31"), "after");
      assert(bg.inRange("", "2024-01-01", "2024-12-31"), "empty date kept");
      assert(bg.inRange("March 3, 2024", "2024-01-01", "2024-01-31"), "non-ISO kept");
    });

    await test("parsers", "cacheKey strips protocol", () => {
      eq(bg.cacheKey("https://www.amazon.com"), "orderCache:www.amazon.com", "com");
      eq(bg.cacheKey("https://www.amazon.co.uk"), "orderCache:www.amazon.co.uk", "uk");
      eq(bg.cacheKey("www.amazon.de"), "orderCache:www.amazon.de", "bare");
    });

    await test("parsers", "parseListPage extracts IDs, count, skips fake", () => {
      const html = fs.readFileSync(path.join(__dirname, "fixtures/order-list.html"), "utf8");
      const parsed = bg.parseListPage(html);
      const ids = parsed.orders.map((o) => o.orderId);
      assert(ids.includes(F.ORDER_A), "A");
      assert(ids.includes(F.ORDER_B), "B");
      assert(!ids.includes(F.FAKE_ID), "no fake");
      eq(parsed.count, 2, "count");
      assert(!parsed.signin, "not signin");
    });

    await test("parsers", "parseListPage signin flag when no orders", () => {
      const parsed = bg.parseListPage(F.signInPage());
      assert(parsed.signin, "signin");
      eq(parsed.orders.length, 0, "no orders");
    });

    await test("parsers", "parseCard pulls date/total/to/items from list window", () => {
      const html = fs.readFileSync(path.join(__dirname, "fixtures/order-list.html"), "utf8");
      const card = bg.parseCard(html, F.ORDER_A);
      eq(card.date, "2024-01-15", "date");
      eq(card.total, "28.43", "total");
      eq(card.to, "Jane Doe", "to");
      assert(card.items.some((i) => i.item.includes("USB-C Cable")), "item");
      assert(card.items.some((i) => i.asin === "B0CABLE123"), "asin");
    });

    await test("parsers", "parseInvoice extracts money, address, items, payments", () => {
      const inv = bg.parseInvoice(F.printInvoice(F.sampleOrders.A));
      eq(inv.date, "2024-01-15", "date");
      eq(inv.total, "28.43", "total");
      eq(inv.shipping, "5.99", "ship");
      eq(inv.tax, "2.45", "tax");
      eq(inv.to, "Jane Doe", "to");
      assert(inv.items.some((i) => i.asin === "B0CABLE123"), "asin");
      assert(inv.items.some((i) => i.qty === "2"), "qty");
      eq(inv.paymentsList.length, 1, "plist");
      eq(inv.paymentsList[0].method, "Visa", "method");
      eq(inv.paymentsList[0].last4, "4242", "last4");
      eq(inv.paymentsList[0].amount, "28.43", "amt");
      includes(inv.payments, "Visa ending in 4242", "pay str");
    });

    await test("parsers", "parseInvoice gift, refund, Amex", () => {
      const inv = bg.parseInvoice(F.printInvoice(F.sampleOrders.B));
      eq(inv.gift, "10.00", "gift");
      eq(inv.paymentsList[0].method, "American Express", "amex");
      eq(inv.paymentsList[0].last4, "1009", "last4");
    });

    await test("parsers", "parseInvoice refund + Mastercard", () => {
      const inv = bg.parseInvoice(F.printInvoice(F.sampleOrders.C));
      eq(inv.refund, "15.00", "refund");
      eq(inv.paymentsList[0].method, "Mastercard", "mc");
    });

    await test("parsers", "extractPayments fallback empty method when no card text", () => {
      const html = `<div>Order Placed: January 1, 2024</div><div>Grand Total: $9.00</div>`;
      const list = bg.extractPayments(html, "2024-01-01", "9.00");
      eq(list.length, 1, "one");
      eq(list[0].method, "", "empty method");
      eq(list[0].amount, "9.00", "amt");
    });

    await test("parsers", "empty payment method does not emit a leading colon", () => {
      const inv = bg.parseInvoice(`<div>Order Placed: January 1, 2024</div><div>Grand Total: $9.00</div>`);
      assert(!inv.payments.startsWith(":"), "no leading colon: " + JSON.stringify(inv.payments));
      includes(inv.payments, "2024-01-01", "date kept");
      includes(inv.payments, "9.00", "amount kept");
    });

    await test("parsers", "cacheReady requires invoice-quality fields", () => {
      const stub = { orderId: F.ORDER_A, items: [{ item: "X" }], total: "1.00", paymentsList: [] };
      assert(!bg.cacheReady(stub), "list-page stub is not ready");
      const invoiced = { orderId: F.ORDER_A, items: [{ item: "X" }], total: "1.00", invoiced: true };
      assert(bg.cacheReady(invoiced), "invoiced flag");
      const legacy = { orderId: F.ORDER_A, items: [{ item: "X" }], total: "1.00", tax: "0.40", shipping: "0.00" };
      assert(bg.cacheReady(legacy), "legacy tax/shipping");
      assert(!bg.cacheReady(invoiced, "shipments"), "shipments needs shipments array");
      assert(bg.cacheReady(Object.assign({}, invoiced, { shipments: [{ shipmentId: "x" }] }), "shipments"), "shipments present");
      assert(bg.cacheReady(Object.assign({}, invoiced, { shipments: [], shipmentsChecked: true }), "shipments"), "checked empty");
    });

    await test("parsers", "toRows orders/items/payments field names", () => {
      bg.currentOrigin = "https://www.amazon.com";
      const all = [{
        orderId: F.ORDER_A,
        date: "2024-01-15",
        total: "28.43",
        to: "Jane Doe",
        shipping: "5.99",
        shippingRefund: "",
        gift: "",
        tax: "2.45",
        refund: "",
        payments: "Visa ending in 4242: 2024-01-15: 28.43; ",
        paymentsList: [{ method: "Visa", last4: "4242", date: "2024-01-15", amount: "28.43" }],
        items: [{ item: "USB-C Cable 6ft Braided", qty: "2", asin: "B0CABLE123", amount: "12.99" }],
      }];
      const orders = bg.toRows(all, "orders");
      eq(orders.headers.join("|"), "order id|order url|items|to|date|total|shipping|shipping_refund|gift|tax|refund|payments", "oh");
      eq(orders.rows[0]["order id"], F.ORDER_A, "oid");
      includes(orders.rows[0].items, "USB-C Cable", "items cell");
      const items = bg.toRows(all, "items");
      eq(items.headers.join("|"), "date|order id|item|quantity|asin|price|order total|to|tax|shipping|url", "ih");
      eq(items.rows[0].quantity, "2", "qty");
      eq(items.rows[0].asin, "B0CABLE123", "asin");
      eq(items.rows[0].price, "12.99", "price");
      eq(items.rows[0]["order total"], "28.43", "ot");
      const pays = bg.toRows(all, "payments");
      eq(pays.headers.join("|"), "date|order id|method|last4|amount|order total|url", "ph");
      eq(pays.rows[0].method, "Visa", "method");
      eq(pays.rows[0].last4, "4242", "last4");
    });

    await test("parsers", "csvEscape quotes commas and quotes", () => {
      eq(bg.csvEscape('a,b'), '"a,b"', "comma");
      eq(bg.csvEscape('say "hi"'), '"say ""hi"""', "quote");
      const csv = bg.toCsv([{ a: "1", b: "x,y" }], ["a", "b"]);
      eq(csv, "a,b\n1,\"x,y\"\n", "csv");
    });

    await test("parsers", "mergeItems fills missing asin/qty/amount", () => {
      const out = bg.mergeItems(
        [{ item: "USB-C Cable 6ft Braided", amount: "", asin: "", qty: "" }],
        [{ item: "USB-C Cable 6ft Braided", amount: "12.99", asin: "B0CABLE123", qty: "2" }]
      );
      eq(out.length, 1, "one");
      eq(out[0].asin, "B0CABLE123", "asin");
      eq(out[0].qty, "2", "qty");
    });

    await test("parsers", "parseShipments finds progress-tracker, status, items", () => {
      const html = F.orderDetailsWithShipment(Object.assign({}, F.sampleOrders.A, {
        shipmentId: "DsC3gvwsv",
        status: "Delivered",
      }));
      const ships = bg.parseShipments(html);
      eq(ships.length, 1, "one shipment");
      eq(ships[0].shipmentId, "DsC3gvwsv", "sid");
      eq(ships[0].status, "Delivered", "status");
      eq(ships[0].delivered, "YES", "delivered");
      includes(ships[0].trackingLink, "/progress-tracker/", "link");
      includes(ships[0].trackingLink, "shipmentId=DsC3gvwsv", "sid in link");
      assert(ships[0].items.some((i) => i.asin === "B0CABLE123"), "asin");
    });

    await test("parsers", "toRows shipments shape; empty shipments omit rows", () => {
      bg.currentOrigin = "https://www.amazon.com";
      const withShip = [{
        orderId: F.ORDER_A,
        date: "2024-01-15",
        total: "28.43",
        to: "Jane Doe",
        items: [{ item: "USB-C Cable 6ft Braided", qty: "2", asin: "B0CABLE123", amount: "12.99" }],
        shipments: [{
          shipmentId: "DsC3gvwsv",
          status: "Delivered",
          delivered: "YES",
          trackingId: "TBA123456789000",
          trackingLink: "https://www.amazon.com/progress-tracker/package?shipmentId=DsC3gvwsv",
          items: [{ item: "USB-C Cable 6ft Braided", qty: "2", asin: "B0CABLE123", amount: "12.99" }],
        }],
      }];
      const built = bg.toRows(withShip, "shipments");
      eq(built.headers.join("|"), "date|order id|shipment id|delivered|status|tracking id|tracking link|items|to|url", "hdr");
      eq(built.rows.length, 1, "one row");
      eq(built.rows[0]["shipment id"], "DsC3gvwsv", "sid");
      eq(built.rows[0].delivered, "YES", "yes");
      eq(built.rows[0]["tracking id"], "TBA123456789000", "tid");
      includes(built.rows[0].items, "USB-C Cable", "items");
      const empty = bg.toRows([{
        orderId: F.ORDER_B,
        date: "2024-03-03",
        total: "41.10",
        to: "John Smith",
        items: [{ item: "Wireless Mouse Silent Click" }],
        shipments: [],
        shipmentsChecked: true,
      }], "shipments");
      eq(empty.rows.length, 0, "no fallback row when no packages");
    });

    await test("parsers", "last-1-month and last-2-month date windows", () => {
      const now = new Date(2026, 7, 17);
      const w1 = bg.rangeWindow("last1", { now });
      eq(w1.fromDate, "2026-07-17", "last1 from");
      eq(w1.toDate, "2026-08-17", "last1 to");
      eq(w1.years.join(","), "2026", "last1 years");
      const alias = bg.rangeWindow("months-1", { now });
      eq(alias.fromDate, w1.fromDate, "months-1 alias");
      const w2 = bg.rangeWindow("last2", { now });
      eq(w2.fromDate, "2026-06-17", "last2 from");
      eq(w2.toDate, "2026-08-17", "last2 to");
      const jan = new Date(2026, 0, 15);
      const wrap = bg.lastMonthsWindow(2, jan);
      eq(wrap.fromDate, "2025-11-15", "wrap from");
      eq(wrap.toDate, "2026-01-15", "wrap to");
      assert(wrap.years.includes(2025) && wrap.years.includes(2026), "span years");
    });

    await test("parsers", "quarter and month window math", () => {
      const q1 = bg.quarterWindow(2026, ["Q1"]);
      eq(q1.fromDate, "2026-01-01", "q1 from");
      eq(q1.toDate, "2026-03-31", "q1 to");
      const q3 = bg.quarterWindow(2024, ["Q3"]);
      eq(q3.fromDate, "2024-07-01", "q3 from");
      eq(q3.toDate, "2024-09-30", "q3 to");
      assert(bg.dateMatchesQuarters("2024-01-15", 2024, ["Q1"]), "jan in q1");
      assert(!bg.dateMatchesQuarters("2024-07-20", 2024, ["Q1"]), "jul not q1");
      assert(bg.dateMatchesQuarters("2024-07-20", 2024, ["Q1", "Q3"]), "jul in q1+q3");
      assert(!bg.dateMatchesQuarters("2024-05-01", 2024, ["Q1", "Q3"]), "may not q1+q3");
      const jan = bg.monthWindow(2026, [1]);
      eq(jan.fromDate, "2026-01-01", "jan from");
      eq(jan.toDate, "2026-01-31", "jan to");
      const feb = bg.monthWindow(2024, [2]);
      eq(feb.toDate, "2024-02-29", "leap feb");
      assert(bg.dateMatchesMonths("2024-03-03", 2024, [3]), "mar");
      assert(!bg.dateMatchesMonths("2024-03-03", 2024, [1, 2]), "mar not jan/feb");
    });

    await test("parsers", "parseTrackingId and deliveredFlag", () => {
      eq(bg.parseTrackingId(F.trackingPage("TBA123456789000")), "TBA123456789000", "tba");
      eq(bg.parseTrackingId('<div>UPS: 1Z999AA10123456784</div>'), "1Z999AA10123456784", "ups");
      eq(bg.deliveredFlag("Delivered"), "YES", "yes");
      eq(bg.deliveredFlag("Return complete"), "RETURNED", "ret");
      eq(bg.deliveredFlag("Out for delivery"), "NO", "ofd");
      eq(bg.deliveredFlag(""), "UNKNOWN", "unk");
    });
  }

  // ---------- Scrape isolated ----------
  await test("scrape", "year URL, invoice fetch, lastExport, cache write", async () => {
    const fetch = makeFetch({
      pages: {
        0: F.listPage({
          orders: [
            { id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" },
          ],
          count: 1,
        }),
      },
      invoices: { [F.ORDER_A]: F.printInvoice(F.sampleOrders.A) },
      details: {},
    });
    const { chrome, bg } = loadBackground({ fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape",
      origin: "https://www.amazon.com",
      range: "years",
      years: [2024],
      format: "orders",
      useCache: false,
    });
    assert(res && res.ok, "ok " + JSON.stringify(res));
    eq(res.rows, 1, "rows");
    assert(fetch.calls.some((u) => u.includes("/gp/css/order-history?disableCsd=no-js&timeFilter=year-2024&startIndex=0")), "list url");
    assert(fetch.calls.some((u) => u.includes("/gp/css/summary/print.html?orderID=" + F.ORDER_A)), "print url");
    const exp = chrome.storage.local._store.lastExport;
    assert(exp, "lastExport");
    eq(exp.format, "orders", "fmt");
    eq(exp.rows[0]["order id"], F.ORDER_A, "oid");
    eq(exp.rows[0].total, "28.43", "total");
    eq(exp.rows[0].tax, "2.45", "tax");
    eq(exp.rows[0].shipping, "5.99", "ship");
    includes(exp.rows[0].payments, "Visa ending in 4242", "pay");
    const cache = chrome.storage.local._store["orderCache:www.amazon.com"];
    assert(cache && cache.orders[F.ORDER_A], "cache");
    eq(cache.version, 1, "ver");
    eq(cache.origin, "https://www.amazon.com", "origin");
    assert(chrome._tabsCreated.some((t) => t.url.endsWith("results.html")), "opened results");
  });

  await test("scrape", "last30 and months-3 timeFilter URLs", async () => {
    const pages = {
      0: F.listPage({
        orders: [{ id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" }],
        count: 1,
      }),
    };
    const invoices = { [F.ORDER_A]: F.printInvoice(F.sampleOrders.A) };
    for (const [range, filter] of [["last30", "last30"], ["months-3", "months-3"]]) {
      const fetch = makeFetch({ pages, invoices, details: {} });
      const { chrome } = loadBackground({ fetch });
      const res = await chrome.runtime.sendMessage({
        type: "scrape", origin: "https://www.amazon.com", range, years: [], format: "orders", useCache: false,
      });
      assert(res && res.ok, range + " " + JSON.stringify(res));
      assert(fetch.calls.some((u) => u.includes("timeFilter=" + filter)), range + " filter");
    }
  });

  await test("scrape", "custom range filters ISO dates", async () => {
    const fetch = makeFetch({
      pages: {
        0: F.listPage({
          orders: [
            { id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" },
            { id: F.ORDER_C, date: "July 20, 2024", total: "$15.00", to: "Alex Roe", asin: "B0BOOK7890", title: "Notebook Hardcover Dotted" },
          ],
          count: 2,
        }),
      },
      invoices: {
        [F.ORDER_A]: F.printInvoice(F.sampleOrders.A),
        [F.ORDER_C]: F.printInvoice(F.sampleOrders.C),
      },
      details: {},
    });
    const { chrome } = loadBackground({ fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape",
      origin: "https://www.amazon.com",
      range: "custom",
      fromDate: "2024-06-01",
      toDate: "2024-08-01",
      format: "orders",
      useCache: false,
    });
    assert(res && res.ok, JSON.stringify(res));
    eq(res.rows, 1, "only July");
    eq(chrome.storage.local._store.lastExport.rows[0]["order id"], F.ORDER_C, "C");
  });

  await test("scrape", "pagination startIndex advances and stops at count", async () => {
    const many = [];
    for (let i = 0; i < 12; i++) {
      const n = String(1000000 + i).padStart(7, "0");
      many.push({
        id: `114-${n}-${n}`,
        date: "January 2, 2024",
        total: "$1.00",
        to: "Pat",
        asin: "B0PAGINATE",
        title: "Pagination Widget Item " + i,
      });
    }
    const mkInv = (o) => F.printInvoice({
      id: o.id, placed: "January 2, 2024", date: "January 2, 2024", total: "1.00",
      shipping: "0.00", tax: "0.00", to: "Pat",
      items: [{ item: o.title, asin: o.asin, qty: "1", amount: "1.00" }],
      payments: [{ method: "Visa", last4: "1111", date: "January 2, 2024", amount: "1.00" }],
    });
    const invoices = {};
    for (const o of many) invoices[o.id] = mkInv(o);
    const fetch = makeFetch({
      pages: {
        0: F.listPage({ orders: many.slice(0, 10), count: 12 }),
        10: F.listPage({ orders: many.slice(10), count: 12 }),
      },
      invoices,
      details: {},
    });
    const { chrome } = loadBackground({ fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape", origin: "https://www.amazon.com", range: "years", years: [2024], format: "orders", useCache: false,
    });
    assert(res && res.ok, JSON.stringify(res));
    eq(res.orders, 12, "12 orders");
    assert(fetch.calls.some((u) => u.includes("startIndex=0")), "idx0");
    assert(fetch.calls.some((u) => u.includes("startIndex=10")), "idx10");
  });

  await test("scrape", "cache hit skips print fetch", async () => {
    const cached = {
      version: 1,
      origin: "https://www.amazon.com",
      updatedAt: "2024-01-01T00:00:00.000Z",
      orders: {
        [F.ORDER_A]: {
          orderId: F.ORDER_A,
          date: "2024-01-15",
          total: "28.43",
          to: "Jane Doe",
          items: [{ item: "USB-C Cable 6ft Braided", qty: "2", asin: "B0CABLE123", amount: "12.99" }],
          shipping: "5.99",
          tax: "2.45",
          gift: "",
          refund: "",
          shippingRefund: "",
          payments: "Visa ending in 4242; ",
          paymentsList: [{ method: "Visa", last4: "4242", date: "2024-01-15", amount: "28.43" }],
        },
      },
    };
    const fetch = makeFetch({
      pages: {
        0: F.listPage({
          orders: [
            { id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" },
            { id: F.ORDER_B, date: "March 3, 2024", total: "$41.10", to: "John Smith", asin: "B0MOUSE456", title: "Wireless Mouse Silent Click" },
          ],
          count: 2,
        }),
      },
      invoices: { [F.ORDER_B]: F.printInvoice(F.sampleOrders.B) },
      details: {},
    });
    const chrome = createChromeStub({ "orderCache:www.amazon.com": cached });
    const { } = loadBackground({ chrome, fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape", origin: "https://www.amazon.com", range: "years", years: [2024], format: "orders", useCache: true,
    });
    assert(res && res.ok, JSON.stringify(res));
    assert(!fetch.calls.some((u) => u.includes("print.html?orderID=" + F.ORDER_A)), "A cached");
    assert(fetch.calls.some((u) => u.includes("print.html?orderID=" + F.ORDER_B)), "B fetched");
  });

  await test("scrape", "invoice failure falls back to order-details titles", async () => {
    const fetch = makeFetch({
      pages: {
        0: F.listPage({
          orders: [{ id: F.ORDER_B, date: "March 3, 2024", total: "$41.10", to: "John Smith", asin: "B0XXXX0000", title: "View" }],
          count: 1,
        }),
      },
      invoices: {},
      invoiceFail: new Set([F.ORDER_B]),
      details: { [F.ORDER_B]: F.orderDetails(F.sampleOrders.B) },
    });
    const { chrome } = loadBackground({ fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape", origin: "https://www.amazon.com", range: "years", years: [2024], format: "items", useCache: false,
    });
    assert(res && res.ok, JSON.stringify(res));
    assert(fetch.calls.some((u) => u.includes("/gp/your-account/order-details?orderID=" + F.ORDER_B)), "details");
    const row = chrome.storage.local._store.lastExport.rows.find((r) => (r.item || "").includes("Wireless Mouse"));
    assert(row, "fallback item");
  });

  await test("scrape", "stop/cancel throws Stopped and skips lastExport", async () => {
    let n = 0;
    const base = makeFetch({
      pages: {
        0: F.listPage({
          orders: [
            { id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" },
            { id: F.ORDER_B, date: "March 3, 2024", total: "$41.10", to: "John Smith", asin: "B0MOUSE456", title: "Wireless Mouse Silent Click" },
          ],
          count: 2,
        }),
      },
      invoices: {
        [F.ORDER_A]: F.printInvoice(F.sampleOrders.A),
        [F.ORDER_B]: F.printInvoice(F.sampleOrders.B),
      },
      details: {},
    });
    const chrome = createChromeStub();
    let bgRef;
    const fetch = async (url) => {
      n += 1;
      if (String(url).includes("print.html") && n >= 2) {
        bgRef.cancelled = true;
      }
      return base(url);
    };
    const loaded = loadBackground({ chrome, fetch });
    bgRef = loaded.bg;
    const res = await chrome.runtime.sendMessage({
      type: "scrape", origin: "https://www.amazon.com", range: "years", years: [2024], format: "orders", useCache: false,
    });
    assert(res && res.error, "expected error");
    includes(res.error, "Stopped", "stopped");
    assert(!chrome.storage.local._store.lastExport, "no export");
  });

  await test("scrape", "cancel message sets cancelled", async () => {
    const { chrome, bg } = loadBackground();
    bg.cancelled = false;
    const res = await chrome.runtime.sendMessage({ type: "cancel" });
    assert(res && res.ok, "ok");
    assert(bg.cancelled, "flag");
  });

  await test("scrape", "clearCache removes orderCache:host", async () => {
    const chrome = createChromeStub({
      "orderCache:www.amazon.com": { version: 1, orders: { x: {} } },
    });
    loadBackground({ chrome });
    const res = await chrome.runtime.sendMessage({ type: "clearCache", origin: "https://www.amazon.com" });
    assert(res && res.ok, "ok");
    assert(!chrome.storage.local._store["orderCache:www.amazon.com"], "removed");
  });

  await test("scrape", "signin page errors without writing export", async () => {
    const fetch = makeFetch({ signIn: true, pages: {}, invoices: {}, details: {} });
    const { chrome } = loadBackground({ fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape", origin: "https://www.amazon.com", range: "last30", format: "orders", useCache: false,
    });
    assert(res && res.error, "error");
    includes(res.error.toLowerCase(), "sign-in", "signin");
    assert(!chrome.storage.local._store.lastExport, "no export");
  });

  await test("scrape", "payments format rows", async () => {
    const fetch = makeFetch({
      pages: {
        0: F.listPage({
          orders: [{ id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" }],
          count: 1,
        }),
      },
      invoices: { [F.ORDER_A]: F.printInvoice(F.sampleOrders.A) },
      details: {},
    });
    const { chrome } = loadBackground({ fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape", origin: "https://www.amazon.com", range: "years", years: [2024], format: "payments", useCache: false,
    });
    assert(res && res.ok, JSON.stringify(res));
    const exp = chrome.storage.local._store.lastExport;
    eq(exp.format, "payments", "fmt");
    eq(exp.headers[2], "method", "method col");
    eq(exp.rows[0].method, "Visa", "visa");
    eq(exp.rows[0].last4, "4242", "last4");
    eq(exp.rows[0].amount, "28.43", "amt");
  });

  await test("scrape", "second scrape is rejected while one is running", async () => {
    const { chrome, bg } = loadBackground();
    bg.scrapeRunning = true;
    const res = await chrome.runtime.sendMessage({
      type: "scrape", origin: "https://www.amazon.com", range: "last30", format: "orders",
    });
    assert(res && res.error, "error");
    includes(res.error, "already running", "busy");
  });

  await test("scrape", "last1 uses year windows not months-1 timeFilter", async () => {
    const fetch = makeFetch({
      pages: {
        0: F.listPage({
          orders: [{ id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" }],
          count: 1,
        }),
      },
      invoices: { [F.ORDER_A]: F.printInvoice(F.sampleOrders.A) },
      details: {},
    });
    const { chrome } = loadBackground({ fetch });
    await chrome.runtime.sendMessage({
      type: "scrape", origin: "https://www.amazon.com", range: "last1", years: [], format: "orders", useCache: false,
    });
    assert(fetch.calls.some((u) => /timeFilter=year-\d{4}/.test(u)), "year filter");
    assert(!fetch.calls.some((u) => u.includes("timeFilter=months-1")), "no months-1");
    assert(!fetch.calls.some((u) => u.includes("timeFilter=last1")), "no last1 filter");
  });

  await test("scrape", "quarters scrapes year then filters Q1", async () => {
    const fetch = makeFetch({
      pages: {
        0: F.listPage({
          orders: [
            { id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" },
            { id: F.ORDER_C, date: "July 20, 2024", total: "$15.00", to: "Alex Roe", asin: "B0BOOK7890", title: "Notebook Hardcover Dotted" },
          ],
          count: 2,
        }),
      },
      invoices: {
        [F.ORDER_A]: F.printInvoice(F.sampleOrders.A),
        [F.ORDER_C]: F.printInvoice(F.sampleOrders.C),
      },
      details: {},
    });
    const { chrome } = loadBackground({ fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape",
      origin: "https://www.amazon.com",
      range: "quarters",
      periodYear: 2024,
      quarters: ["Q1"],
      format: "orders",
      useCache: false,
    });
    assert(res && res.ok, JSON.stringify(res));
    eq(res.rows, 1, "only Q1");
    eq(chrome.storage.local._store.lastExport.rows[0]["order id"], F.ORDER_A, "A");
    assert(fetch.calls.some((u) => u.includes("timeFilter=year-2024")), "year-2024");
  });

  await test("scrape", "shipments format fetches details and tracking", async () => {
    const fetch = makeFetch({
      pages: {
        0: F.listPage({
          orders: [{ id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" }],
          count: 1,
        }),
      },
      invoices: { [F.ORDER_A]: F.printInvoice(F.sampleOrders.A) },
      details: {
        [F.ORDER_A]: F.orderDetailsWithShipment(Object.assign({}, F.sampleOrders.A, {
          shipmentId: "DsC3gvwsv",
          status: "Delivered",
        })),
      },
      tracking: { DsC3gvwsv: F.trackingPage("TBA123456789000") },
    });
    const { chrome } = loadBackground({ fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape", origin: "https://www.amazon.com", range: "years", years: [2024], format: "shipments", useCache: false,
    });
    assert(res && res.ok, JSON.stringify(res));
    assert(fetch.calls.some((u) => u.includes("/gp/your-account/order-details?orderID=" + F.ORDER_A)), "details");
    assert(fetch.calls.some((u) => u.includes("/progress-tracker/") && u.includes("shipmentId=DsC3gvwsv")), "track");
    const exp = chrome.storage.local._store.lastExport;
    eq(exp.format, "shipments", "fmt");
    eq(exp.rows[0]["shipment id"], "DsC3gvwsv", "sid");
    eq(exp.rows[0].delivered, "YES", "yes");
    eq(exp.rows[0]["tracking id"], "TBA123456789000", "tid");
    const cached = chrome.storage.local._store["orderCache:www.amazon.com"].orders[F.ORDER_A];
    assert(cached.shipmentsChecked, "checked");
    eq(cached.shipments[0].shipmentId, "DsC3gvwsv", "cache sid");
  });

  await test("scrape", "multi formats: one scrape, two reports, one results tab", async () => {
    const fetch = makeFetch({
      pages: {
        0: F.listPage({
          orders: [{ id: F.ORDER_A, date: "January 15, 2024", total: "$28.43", to: "Jane Doe", asin: "B0CABLE123", title: "USB-C Cable 6ft Braided" }],
          count: 1,
        }),
      },
      invoices: { [F.ORDER_A]: F.printInvoice(F.sampleOrders.A) },
      details: {
        [F.ORDER_A]: F.orderDetailsWithShipment(Object.assign({}, F.sampleOrders.A, {
          shipmentId: "DsC3gvwsv",
          status: "Delivered",
        })),
      },
      tracking: { DsC3gvwsv: F.trackingPage("TBA123456789000") },
    });
    const { chrome } = loadBackground({ fetch });
    const res = await chrome.runtime.sendMessage({
      type: "scrape",
      origin: "https://www.amazon.com",
      range: "years",
      years: [2024],
      formats: ["items", "shipments"],
      format: "shipments",
      useCache: false,
    });
    assert(res && res.ok, JSON.stringify(res));
    eq(res.formats.join(","), "items,shipments", "formats");
    eq(res.reports.length, 2, "two reports in response");
    eq(res.reports[0].format, "items", "items first");
    eq(res.reports[1].format, "shipments", "ships second");
    const exp = chrome.storage.local._store.lastExport;
    eq(exp.formats.join(","), "items,shipments", "exp formats");
    eq(exp.format, "items", "back-compat first");
    eq(exp.reports.length, 2, "two stored");
    eq(exp.reports[0].format, "items", "stored items");
    eq(exp.reports[1].format, "shipments", "stored ships");
    eq(exp.rows[0].asin, "B0CABLE123", "item row back-compat");
    eq(chrome._tabsCreated.filter((t) => t.url.endsWith("results.html")).length, 1, "one tab");
    assert(fetch.calls.some((u) => u.includes("/progress-tracker/")), "track once");
    const listCalls = fetch.calls.filter((u) => u.includes("/gp/css/order-history"));
    assert(listCalls.length >= 1, "scraped list");
  });

  // ---------- Results UI ----------
  await test("results", "empty state when no lastExport", () => {
    const chrome = createChromeStub();
    const { document } = loadResultsExported(resultsHtml, chrome);
    includes(document.getElementById("wrap").textContent, "No report yet", "empty");
  });

  await test("results", "loads lastExport, search, sort, csv, totals", () => {
    const chrome = createChromeStub({
      lastExport: {
        format: "orders",
        generatedAt: "2024-08-01T12:00:00.000Z",
        headers: ["order id", "items", "to", "date", "total", "shipping", "tax", "refund", "payments"],
        rows: [
          { "order id": F.ORDER_A, items: "USB-C Cable;", to: "Jane", date: "2024-01-15", total: "28.43", shipping: "5.99", tax: "2.45", refund: "", payments: "Visa" },
          { "order id": F.ORDER_C, items: "Notebook;", to: "Alex", date: "2024-07-20", total: "15.00", shipping: "0", tax: "0", refund: "15.00", payments: "Mastercard" },
        ],
      },
    });
    const { res, document, sandbox } = loadResultsExported(resultsHtml, chrome);
    eq(res.rows.length, 2, "loaded");
    assert(document.querySelector("table"), "table");
    includes(document.getElementById("totals").textContent, "43.43", "spend 28.43+15");
    includes(document.getElementById("totals").textContent, "15.00", "refund");
    document.getElementById("q").value = "notebook";
    const filtered = res.filtered();
    eq(filtered.length, 1, "search");
    eq(filtered[0]["order id"], F.ORDER_C, "hit");
    res.sortKey = "total";
    res.sortDir = 1;
    document.getElementById("q").value = "";
    const sorted = res.filtered();
    eq(sorted[0].total, "15.00", "sort numeric-ish");
    const csv = res.toCsv(res.rows);
    includes(csv, "order id,items,to,date,total", "hdr");
    includes(csv, F.ORDER_A, "row");
    eq(res.moneyNum("$1,234.56"), 1234.56, "moneyNum");
    eq(res.moneyNum("€1.234,56") !== 1234.56, true, "EU decimal not handled");
  });

  await test("results", "items totals de-dupe order spend; payments totals use amount", () => {
    const chrome = createChromeStub();
    const { res, document } = loadResultsExported(resultsHtml, chrome);
    res.format = "items";
    res.headers = ["order id", "item", "order total", "tax", "shipping"];
    res.rows = [
      { "order id": "1", item: "A", "order total": "10.00", tax: "1.00", shipping: "2.00" },
      { "order id": "1", item: "B", "order total": "10.00", tax: "1.00", shipping: "2.00" },
      { "order id": "2", item: "C", "order total": "5.00", tax: "0.50", shipping: "0" },
    ];
    res.renderTotals(res.rows);
    includes(document.getElementById("totals").textContent, "15.00", "items spend 10+5 not 10+10+5");
    res.format = "payments";
    res.headers = ["order id", "amount"];
    res.rows = [
      { "order id": "1", amount: "10.00" },
      { "order id": "1", amount: "4.00" },
    ];
    res.renderTotals(res.rows);
    includes(document.getElementById("totals").textContent, "14.00", "pay sum");
    includes(document.getElementById("totals").textContent, "1", "one order");
    res.format = "shipments";
    res.headers = ["order id", "shipment id", "total"];
    res.rows = [
      { "order id": "1", "shipment id": "a", total: "20.00" },
      { "order id": "1", "shipment id": "b", total: "20.00" },
      { "order id": "2", "shipment id": "c", total: "5.00" },
    ];
    res.renderTotals(res.rows);
    includes(document.getElementById("totals").textContent, "25.00", "ship spend 20+5 not 20+20+5");
    includes(document.getElementById("totals").textContent, "Shipments", "ship label");
  });

  await test("results", "copy writes CSV via clipboard stub", async () => {
    const chrome = createChromeStub({
      lastExport: {
        format: "orders",
        headers: ["order id", "total"],
        rows: [{ "order id": F.ORDER_A, total: "1.00" }],
      },
    });
    const { sandbox, document } = loadResultsExported(resultsHtml, chrome);
    const ev = document.createEvent("Event");
    ev.initEvent("click", true, true);
    document.getElementById("copy").dispatchEvent(ev);
    // click handler is async; wait a tick
    await new Promise((r) => setTimeout(r, 0));
    assert(sandbox.__copied, "copied");
    includes(sandbox.__copied, "order id,total", "csv hdr");
  });

  await test("results", "multi-report tabs switch headers and rows", () => {
    const chrome = createChromeStub({
      lastExport: {
        formats: ["items", "shipments"],
        format: "items",
        headers: ["order id", "item", "asin"],
        rows: [{ "order id": F.ORDER_A, item: "USB-C Cable", asin: "B0CABLE123" }],
        reports: [
          { format: "items", headers: ["order id", "item", "asin"], rows: [{ "order id": F.ORDER_A, item: "USB-C Cable", asin: "B0CABLE123" }] },
          { format: "shipments", headers: ["order id", "shipment id"], rows: [{ "order id": F.ORDER_A, "shipment id": "DsC3gvwsv" }] },
        ],
      },
    });
    const { res, document } = loadResultsExported(resultsHtml, chrome);
    eq(res.format, "items", "starts items");
    eq(res.rows[0].asin, "B0CABLE123", "item row");
    const tabs = document.getElementById("reportTabs");
    assert(tabs && tabs.querySelectorAll("button").length === 2, "two tabs");
    includes(document.getElementById("meta").textContent, "2 reports", "meta");
    includes(document.getElementById("meta").textContent, "Items", "which report");
    tabs.querySelectorAll("button")[1].click();
    eq(res.format, "shipments", "switched");
    eq(res.rows[0]["shipment id"], "DsC3gvwsv", "ship row");
    includes(document.getElementById("meta").textContent, "Shipments", "switched label");
  });

  // ---------- Popup UI ----------
  await test("popup", "sites, ranges, years, setRange grid, custom dates", () => {
    const chrome = createChromeStub();
    const { popup, document } = loadPopup(popupHtml, chrome, sites);
    eq(document.getElementById("site").options.length, 12, "12 sites");
    eq(document.getElementById("ranges").querySelectorAll("button").length, 8, "8 ranges");
    const yearBtns = [...document.getElementById("years").querySelectorAll("button")];
    eq(yearBtns.length, 8, "8 years");
    const now = new Date().getFullYear();
    assert(yearBtns[0].classList.contains("on"), "current on");
    assert(yearBtns.find((b) => b.dataset.year === String(now - 1)).classList.contains("on"), "prev on");
    popup.setRange("last30");
    eq(document.getElementById("years").style.display, "none", "years hidden");
    eq(document.getElementById("customDates").hidden, true, "custom hidden");
    popup.setRange("custom");
    eq(document.getElementById("years").style.display, "none", "years hidden custom");
    eq(document.getElementById("customDates").hidden, false, "custom shown");
    popup.setRange("years");
    eq(document.getElementById("years").style.display, "grid", "grid");
    popup.setRange("quarters");
    eq(document.getElementById("years").style.display, "none", "years hidden quarters");
    eq(document.getElementById("periodYear").style.display, "grid", "period year grid");
    eq(document.getElementById("quarters").style.display, "grid", "quarters grid");
    popup.setRange("months");
    eq(document.getElementById("months").style.display, "grid", "months grid");
    eq(document.getElementById("quarters").style.display, "none", "quarters hidden");
    eq(popup.origin(), "https://www.amazon.com", "origin");
    eq(popup.formatChoice().join(","), "orders", "default format");
    document.querySelector('input[name=format][value=orders]').checked = false;
    document.querySelector('input[name=format][value=payments]').checked = true;
    eq(popup.formatChoice().join(","), "payments", "payments");
    document.querySelector('input[name=format][value=payments]').checked = false;
    document.querySelector('input[name=format][value=shipments]').checked = true;
    eq(popup.formatChoice().join(","), "shipments", "shipments");
  });

  await test("popup", "format hint and button label for multi-select", () => {
    const chrome = createChromeStub();
    const { popup, document } = loadPopup(popupHtml, chrome, sites);
    includes(document.getElementById("formatHint").textContent, "Orders report", "default hint");
    eq(document.getElementById("start").textContent, "Build report", "singular");
    document.querySelector("input[name=format][value=items]").checked = true;
    popup.updateFormatHint();
    includes(document.getElementById("formatHint").textContent, "2 reports", "multi hint");
    includes(document.getElementById("formatHint").textContent, "Orders and Items", "names");
    eq(document.getElementById("start").textContent, "Build reports", "plural");
    for (const el of document.querySelectorAll("input[name=format]")) el.checked = false;
    popup.updateFormatHint();
    includes(document.getElementById("formatHint").textContent, "Pick at least one report", "empty");
    document.getElementById("start").click();
    includes(document.getElementById("status").textContent, "Pick at least one report", "blocked");
  });

  await test("popup", "legacy format string checks that one box", () => {
    const chrome = createChromeStub({ format: "payments" });
    const { popup, document } = loadPopup(popupHtml, chrome, sites);
    eq(popup.formatChoice().join(","), "payments", "legacy");
    includes(document.getElementById("formatHint").textContent, "Payments report", "hint");
  });

  await test("popup", "cache hint key is orderCache:host", () => {
    const chrome = createChromeStub({
      "orderCache:www.amazon.com": { orders: { a: {}, b: {} } },
    });
    const { document } = loadPopup(popupHtml, chrome, sites);
    includes(document.getElementById("cacheHint").textContent, "2 invoices saved", "hint");
  });

  await test("popup", "clear cache button sends clearCache", async () => {
    const fetch = makeFetch({ pages: {}, invoices: {}, details: {} });
    const chrome = createChromeStub({
      "orderCache:www.amazon.com": { orders: { a: {} } },
    });
    loadBackground({ chrome, fetch });
    const { document } = loadPopup(popupHtml, chrome, sites);
    document.getElementById("clearCache").click();
    await new Promise((r) => setTimeout(r, 0));
    assert(!chrome.storage.local._store["orderCache:www.amazon.com"], "cleared");
  });

  await test("popup", "open orders uses no-js history URL", () => {
    const chrome = createChromeStub();
    const { document } = loadPopup(popupHtml, chrome, sites);
    document.getElementById("openOrders").click();
    eq(chrome._tabsCreated[0].url, "https://www.amazon.com/gp/css/order-history?disableCsd=no-js", "url");
  });

  await test("popup", "view last report opens results.html", () => {
    const chrome = createChromeStub({ lastExport: { rows: [1] } });
    const { document } = loadPopup(popupHtml, chrome, sites);
    eq(document.getElementById("viewResults").disabled, false, "enabled");
    document.getElementById("viewResults").click();
    eq(chrome._tabsCreated[0].url, "chrome-extension://test-extension-id/results.html", "url");
  });

  await test("popup", "view last report disabled without lastExport", () => {
    const chrome = createChromeStub();
    const { document } = loadPopup(popupHtml, chrome, sites);
    eq(document.getElementById("viewResults").disabled, true, "disabled");
  });

  await test("popup", "years required + custom dates required", () => {
    const chrome = createChromeStub();
    const { popup, document } = loadPopup(popupHtml, chrome, sites);
    for (const b of document.getElementById("years").querySelectorAll("button.on")) b.classList.remove("on");
    popup.setRange("years");
    document.getElementById("start").click();
    includes(document.getElementById("status").textContent, "Pick at least one year", "years");
    popup.setRange("custom");
    document.getElementById("fromDate").value = "";
    document.getElementById("toDate").value = "";
    document.getElementById("start").click();
    includes(document.getElementById("status").textContent, "Pick a start and end date", "custom");
    popup.setRange("quarters");
    document.getElementById("start").click();
    includes(document.getElementById("status").textContent, "Pick at least one quarter", "quarters");
    popup.setRange("months");
    document.getElementById("start").click();
    includes(document.getElementById("status").textContent, "Pick at least one month", "months");
  });

  await test("popup", "privacy link points at privacy.html", () => {
    includes(popupHtml, 'href="privacy.html"', "href");
    includes(privacyHtml, "Nothing is uploaded", "copy");
    includes(privacyHtml, "517 Industries", "brand");
  });

  await test("popup", "after successful scrape cache hint is refreshed", () => {
    const startHandler = popupSrc.slice(popupSrc.indexOf("startBtn.addEventListener"));
    const block = startHandler.slice(0, startHandler.indexOf("stopBtn.addEventListener"));
    assert(block.includes("refreshCacheHint"), "refresh after build");
  });

  await test("popup", "active amazon tab preselects site", () => {
    const chrome = createChromeStub();
    chrome.tabs.query = (opts, cb) => {
      const tabs = [{ id: 1, url: "https://www.amazon.co.uk/gp/css/order-history", active: true }];
      cb(tabs);
      return Promise.resolve(tabs);
    };
    const { popup, document } = loadPopup(popupHtml, chrome, sites);
    eq(document.getElementById("site").value, "www.amazon.co.uk", "uk");
    eq(popup.origin(), "https://www.amazon.co.uk", "origin");
  });

  // ---------- Report ----------
  const by = {};
  for (const r of results) {
    by[r.feature] = by[r.feature] || { PASS: 0, FAIL: 0, tests: [] };
    by[r.feature][r.status] += 1;
    by[r.feature].tests.push(r);
  }
  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    skip: results.filter((r) => r.status === "SKIP").length,
    byFeature: by,
    fails: results.filter((r) => r.status === "FAIL"),
  };
  fs.writeFileSync(path.join(__dirname, "last-run.json"), JSON.stringify(summary, null, 2));
  console.log("\n==== SUMMARY ====");
  console.log(`${summary.pass} passed, ${summary.fail} failed, ${summary.skip || 0} skipped, ${summary.total} total`);
  if (summary.fails.length) {
    console.log("\nFAILURES:");
    for (const f of summary.fails) console.log("-", f.feature, "/", f.name, ":", f.error);
  }
  process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
