const fs = require("fs");
const vm = require("vm");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8");
const sandbox = {
  chrome: {
    runtime: { sendMessage: async () => {}, onMessage: { addListener() {} }, getURL: (p) => p },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: { create: async () => {} },
  },
  console,
  setTimeout,
  URL,
};
vm.createContext(sandbox);
vm.runInContext(
  code +
    `;this.__qa={parseListPage,parseInvoice,parseCard,extractPayments,extractTitles,toISO,moneyPlain,isRealOrderId,cacheKey,inRange,toRows,itemsCell,mergeItems,cacheReady,parseShipments,parseTrackingId,deliveredFlag,rangeWindow,lastMonthsWindow,quarterWindow,monthWindow,dateMatchesQuarters,dateMatchesMonths,normalizeFormats,readyReportText};`,
  sandbox
);
const q = sandbox.__qa;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || "eq") + ` expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}

test("isRealOrderId accepts normal ids", () => {
  assert(q.isRealOrderId("112-1234567-1234567"));
  assert(!q.isRealOrderId("000-1234567-1234567"));
  assert(!q.isRealOrderId("112-0000000-1234567"));
  assert(!q.isRealOrderId("not-an-id"));
});

test("toISO parses Month D, YYYY", () => {
  eq(q.toISO("August 17, 2026"), "2026-08-17");
  eq(q.toISO("2026-01-05"), "2026-01-05");
});

test("moneyPlain strips currency", () => {
  eq(q.moneyPlain("$1,234.56"), "1,234.56");
  eq(q.moneyPlain("£12.00"), "12.00");
  eq(q.moneyPlain(""), "");
});

test("cacheKey strips protocol", () => {
  eq(q.cacheKey("https://www.amazon.com"), "orderCache:www.amazon.com");
  eq(q.cacheKey("https://www.amazon.co.uk"), "orderCache:www.amazon.co.uk");
});

test("inRange inclusive ISO dates; missing date passes", () => {
  assert(q.inRange("2026-03-01", "2026-01-01", "2026-06-01"));
  assert(!q.inRange("2025-12-31", "2026-01-01", "2026-06-01"));
  assert(q.inRange("", "2026-01-01", "2026-06-01"));
  assert(q.inRange("March 1, 2026", "2026-01-01", "2026-06-01"));
});

test("parseListPage finds ids from slot, href, and bare text", () => {
  const html = `
    <div data-csa-c-slot-id="order-card-112-1111111-1111111"></div>
    <a href="/gp/css/summary/print.html?orderID=113-2222222-2222222">invoice</a>
    <span>Order #114-3333333-3333333</span>
    <div data-csa-c-slot-id="order-card-000-9999999-9999999"></div>
    <span>3 orders</span>
  `;
  const p = q.parseListPage(html);
  eq(p.orders.length, 3, "order count");
  eq(p.orders[0].orderId, "112-1111111-1111111");
  eq(p.count, 3);
  assert(!p.signin);
});

test("parseListPage signin when no orders", () => {
  const p = q.parseListPage('<form name="signIn">ap/signin sign in to your account</form>');
  assert(p.signin);
  eq(p.orders.length, 0);
});

test("extractTitles from dp links and skips chrome text", () => {
  const html = `
    <a href="/dp/B0TESTASIN">Onefinity Elite Foreman CNC</a>
    <a href="/gp/product/B00OTHER01">View</a>
    <a href="/dp/B00OTHER02">Buy again</a>
    <i>Woodpeckers Ultra-Shear bit</i>
  `;
  const items = q.extractTitles(html);
  assert(items.some((i) => i.item.includes("Onefinity")));
  assert(items.some((i) => i.asin === "B0TESTASIN"));
  assert(!items.some((i) => /^view$/i.test(i.item)));
  assert(items.some((i) => i.item.includes("Woodpeckers")));
});

test("parseInvoice pulls totals, tax, ship-to, payments", () => {
  const html = `
    <b>Order Placed:</b> January 15, 2025
    <li class="displayAddressFullName">Arland Whitfield</li>
    Grand Total $142.10
    Shipping &amp; Handling $5.99
    Estimated tax to be collected $11.20
    Gift Card $0.00
    Refund Total $0.00
    <a href="/dp/B0ABCDEF12">JessEm Rout-R-Lift</a>
    Visa ending in 4242 $142.10 January 15, 2025
  `;
  const inv = q.parseInvoice(html);
  eq(inv.date, "2025-01-15");
  eq(inv.total, "142.10");
  eq(inv.shipping, "5.99");
  eq(inv.tax, "11.20");
  eq(inv.to, "Arland Whitfield");
  assert(inv.items.some((i) => i.item.includes("JessEm")));
  assert(inv.paymentsList.length >= 1);
  eq(inv.paymentsList[0].last4, "4242");
  assert(/Visa/i.test(inv.paymentsList[0].method));
});

test("extractPayments Apple Card and fallback", () => {
  const html = `Paid with Apple Card ending in 1300 $88.00 August 1, 2026`;
  const list = q.extractPayments(html, "2026-08-01", "88.00");
  eq(list[0].last4, "1300");
  assert(/Apple Card/i.test(list[0].method));
  const empty = q.extractPayments("<p>no card</p>", "2026-08-01", "10.00");
  eq(empty.length, 1);
  eq(empty[0].amount, "10.00");
});

test("toRows orders / items / payments shapes", () => {
  sandbox.currentOrigin = "https://www.amazon.com";
  const all = [
    {
      orderId: "112-1111111-1111111",
      date: "2026-01-02",
      total: "20.00",
      to: "Arland",
      shipping: "0",
      shippingRefund: "",
      gift: "",
      tax: "1.50",
      refund: "",
      payments: "Visa ending in 4242: 2026-01-02: 20.00; ",
      paymentsList: [{ method: "Visa", last4: "4242", date: "2026-01-02", amount: "20.00" }],
      items: [{ item: "Bit A", qty: "2", asin: "B0AAAAAAAA", amount: "10.00" }],
    },
  ];
  const orders = q.toRows(all, "orders");
  assert(orders.headers.includes("order id") && orders.headers.includes("items"));
  eq(orders.rows.length, 1);
  assert(orders.rows[0].items.includes("Bit A"));
  const items = q.toRows(all, "items");
  eq(items.rows.length, 1);
  eq(items.rows[0].asin, "B0AAAAAAAA");
  eq(items.rows[0].quantity, "2");
  eq(items.rows[0].price, "10.00");
  eq(items.headers.includes("price"), true);
  const pays = q.toRows(all, "payments");
  eq(pays.rows[0].last4, "4242");
  eq(pays.rows[0].amount, "20.00");
});

test("mergeItems fills missing asin/qty", () => {
  const m = q.mergeItems(
    [{ item: "Bit A", amount: "10.00", asin: "", qty: "" }],
    [{ item: "Bit A", amount: "", asin: "B0AAAAAAAA", qty: "2" }]
  );
  eq(m.length, 1);
  eq(m[0].asin, "B0AAAAAAAA");
  eq(m[0].qty, "2");
});

test("cacheReady requires invoice-quality fields", () => {
  assert(!q.cacheReady({ orderId: "112-1111111-1111111" }));
  assert(!q.cacheReady({ orderId: "112-1111111-1111111", items: [{ item: "x" }], total: "1.00" }));
  assert(q.cacheReady({ orderId: "112-1111111-1111111", items: [{ item: "x" }], invoiced: true }));
  assert(!q.cacheReady({ orderId: "112-1111111-1111111", items: [{ item: "x" }], invoiced: true }, "shipments"));
  assert(q.cacheReady({ orderId: "112-1111111-1111111", items: [{ item: "x" }], invoiced: true, shipmentsChecked: true }, "shipments"));
});

test("popup cache key matches background", () => {
  const site = "www.amazon.com";
  const origin = "https://" + site;
  eq("orderCache:" + site, q.cacheKey(origin));
});


test("parseShipments fixture HTML", () => {
  const html = `
    <div class="a-box shipment">
      <span class="a-text-bold">Delivered</span>
      <a href="/progress-tracker/package?orderId=112-1111111-1111111&shipmentId=DsC3gvwsv">Track package</a>
      <a href="/dp/B0TESTASIN">Onefinity Elite Foreman CNC</a>
    </div>
  `;
  const ships = q.parseShipments(html);
  if (ships.length !== 1) throw new Error("expected 1 shipment");
  eq(ships[0].shipmentId, "DsC3gvwsv");
  eq(ships[0].status, "Delivered");
  eq(ships[0].delivered, "YES");
});

test("toRows shipments shape", () => {
  sandbox.currentOrigin = "https://www.amazon.com";
  const all = [{
    orderId: "112-1111111-1111111",
    date: "2026-01-02",
    total: "20.00",
    to: "Arland",
    items: [{ item: "Bit A" }],
    shipments: [{ shipmentId: "S1", status: "Shipped", delivered: "NO", trackingId: "", trackingLink: "https://www.amazon.com/progress-tracker/x", items: [{ item: "Bit A" }] }],
  }];
  const built = q.toRows(all, "shipments");
  eq(built.headers.join(","), "date, order id, shipment id, delivered, status, tracking id, tracking link, items, to, url".replace(/, /g, ","));
  eq(built.rows.length, 1);
  eq(built.rows[0]["shipment id"], "S1");
});

test("toRows items then shipments on the same all", () => {
  sandbox.currentOrigin = "https://www.amazon.com";
  const all = [{
    orderId: "112-1111111-1111111",
    date: "2026-01-02",
    total: "20.00",
    to: "Arland",
    shipping: "0",
    tax: "1.50",
    items: [{ item: "Bit A", qty: "2", asin: "B0AAAAAAAA", amount: "10.00" }],
    shipments: [{
      shipmentId: "S1",
      status: "Shipped",
      delivered: "NO",
      trackingId: "TBA1",
      trackingLink: "https://www.amazon.com/progress-tracker/x",
      items: [{ item: "Bit A" }],
    }],
  }];
  const items = q.toRows(all, "items");
  const ships = q.toRows(all, "shipments");
  eq(items.rows.length, 1);
  eq(items.rows[0].asin, "B0AAAAAAAA");
  eq(ships.rows.length, 1);
  eq(ships.rows[0]["shipment id"], "S1");
  assert(items.headers.includes("asin"));
  assert(ships.headers.includes("tracking id"));
  assert(!items.headers.includes("tracking id"));
  assert(all[0].items.length === 1 && all[0].shipments.length === 1, "source all unchanged");
});

test("normalizeFormats dedupes and keeps canonical order", () => {
  eq(q.normalizeFormats({ format: "items" }).join(","), "items");
  eq(q.normalizeFormats({ formats: ["shipments", "items", "items", "nope"] }).join(","), "items,shipments");
  eq(q.normalizeFormats({ formats: [] }).join(","), "");
  eq(q.normalizeFormats({}).join(","), "orders");
});

test("readyReportText names separate reports", () => {
  const text = q.readyReportText([
    { format: "items", rows: [1, 2] },
    { format: "shipments", rows: [1, 2, 3] },
  ]);
  eq(text, "Ready. 2 reports (2 item rows, 3 shipment rows).");
  eq(q.readyReportText([{ format: "orders", rows: [1] }]), "Ready. 1 rows.");
});

test("last-1-month and quarter windows", () => {
  const w = q.rangeWindow("last1", { now: new Date(2026, 7, 17) });
  eq(w.fromDate, "2026-07-17");
  eq(w.toDate, "2026-08-17");
  const q1 = q.quarterWindow(2026, ["Q1"]);
  eq(q1.fromDate, "2026-01-01");
  eq(q1.toDate, "2026-03-31");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : " — " + r.err}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
