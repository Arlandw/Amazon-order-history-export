const fs = require("fs");
const vm = require("vm");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "../extension/results.js"), "utf8");
const totalsEl = { innerHTML: "" };
const metaEl = { textContent: "" };
const wrapEl = { replaceChildren() {} };
const qEl = { value: "", addEventListener() {} };
const btn = { addEventListener() {}, textContent: "" };
const tabsEl = {
  classList: { add() {}, remove() {}, toggle() {} },
  replaceChildren() {},
  appendChild() {},
  querySelectorAll() { return []; },
  addEventListener() {},
  textContent: "",
};
const sandbox = {
  chrome: { storage: { local: { get(_k, cb) { cb({}); } } } },
  document: {
    getElementById(id) {
      if (id === "totals") return totalsEl;
      if (id === "meta") return metaEl;
      if (id === "wrap") return wrapEl;
      if (id === "q") return qEl;
      if (id === "csv" || id === "json" || id === "copy") return btn;
      if (id === "reportTabs") return tabsEl;
      return { addEventListener() {}, textContent: "", classList: { add() {}, remove() {}, toggle() {} }, replaceChildren() {} };
    },
    createElement() {
      return {
        appendChild() {},
        addEventListener() {},
        classList: { add() {}, remove() {}, toggle() {} },
        textContent: "",
        href: "",
        target: "",
        rel: "",
        download: "",
        click() {},
      };
    },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  URL: { createObjectURL() { return "blob:x"; }, revokeObjectURL() {} },
  Blob: function () {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(code + `;this.__qa={
  csvEscape,toCsv,moneyNum,moneyFmt,filtered,renderTotals,
  get rows(){return rows}, set rows(v){rows=v},
  get headers(){return headers}, set headers(v){headers=v},
  get format(){return format}, set format(v){format=v},
  get sortKey(){return sortKey}, set sortKey(v){sortKey=v},
  get reports(){return reports}, set reports(v){reports=v},
  showReport, updateTabs,
};`, sandbox);
const q = sandbox.__qa;

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || "eq") + ` expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}
function assert(c, m) { if (!c) throw new Error(m || "assert"); }

test("csvEscape quotes commas and doubles quotes", () => {
  eq(q.csvEscape("a,b"), '"a,b"');
  eq(q.csvEscape('say "hi"'), '"say ""hi"""');
  eq(q.csvEscape("plain"), "plain");
});

test("toCsv uses headers and escaped cells", () => {
  q.headers = ["order id", "items"];
  const csv = q.toCsv([{ "order id": "112-1", items: "bit, extra" }]);
  assert(csv.startsWith("order id,items\n"));
  assert(csv.includes('"bit, extra"'));
});

test("moneyNum handles $1,234.56", () => {
  eq(q.moneyNum("$1,234.56"), 1234.56);
  eq(q.moneyNum(""), 0);
  eq(q.moneyNum("12.00"), 12);
});

test("search filter is case-insensitive across columns", () => {
  q.rows = [
    { "order id": "112-AAA", items: "Onefinity CNC" },
    { "order id": "112-BBB", items: "Apple Card fee" },
  ];
  q.headers = ["order id", "items"];
  q.sortKey = "";
  qEl.value = "onefinity";
  const list = q.filtered();
  eq(list.length, 1);
  eq(list[0]["order id"], "112-AAA");
});

test("orders totals sum spend/tax/shipping/refund", () => {
  q.format = "orders";
  q.renderTotals([
    { "order id": "1", total: "10.00", tax: "1.00", shipping: "2.00", refund: "0" },
    { "order id": "2", total: "5.50", tax: "0.50", shipping: "0", refund: "5.50" },
  ]);
  assert(totalsEl.innerHTML.includes("15.50"), totalsEl.innerHTML);
  assert(totalsEl.innerHTML.includes("1.50"));
  assert(totalsEl.innerHTML.includes("5.50"));
});

test("items totals do not double-count order totals", () => {
  q.format = "items";
  q.renderTotals([
    { "order id": "1", "order total": "20.00", tax: "2.00", shipping: "1.00" },
    { "order id": "1", "order total": "20.00", tax: "2.00", shipping: "1.00" },
  ]);
  assert(totalsEl.innerHTML.includes(">20.00<"), totalsEl.innerHTML);
  assert(totalsEl.innerHTML.includes("Items") && totalsEl.innerHTML.includes(">2<"));
});

test("shipments totals unique orders and no double spend", () => {
  q.format = "shipments";
  q.renderTotals([
    { "order id": "1", total: "20.00" },
    { "order id": "1", total: "20.00" },
  ]);
  assert(totalsEl.innerHTML.includes("Shipments"), totalsEl.innerHTML);
  assert(totalsEl.innerHTML.includes(">20.00<"), totalsEl.innerHTML);
  assert(totalsEl.innerHTML.includes(">2<"), totalsEl.innerHTML);
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : " — " + r.err}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
