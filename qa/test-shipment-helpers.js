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
    `;this.__qa={parseTrackingId,extractShipmentStatus,deliveredFlag,chooseShipmentStatus,attachShipments,parseShipments};`,
  sandbox
);
const q = sandbox.__qa;

const results = [];
function test(name, fn) {
  const done = (ok, err) => {
    results.push({ name, ok, err });
  };
  try {
    const ret = fn();
    if (ret && typeof ret.then === "function") {
      return ret.then(
        () => done(true),
        (e) => done(false, e.message)
      );
    }
    done(true);
    return Promise.resolve();
  } catch (e) {
    done(false, e.message);
    return Promise.resolve();
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

(async () => {
test("parseTrackingId TBA from pt-delivery-card-trackingId", () => {
  const id = q.parseTrackingId('<div class="pt-delivery-card-trackingId">Tracking ID: TBA333810777143</div>');
  assert(id === "TBA333810777143", "expected TBA333810777143 got " + JSON.stringify(id));
});

test("parseTrackingId bare 1Z UPS id", () => {
  const id = q.parseTrackingId("Tracking ID: 1Z999AA10123456784");
  assert(id === "1Z999AA10123456784", "expected bare 1Z id got " + JSON.stringify(id));
  assert(/^1Z[A-Z0-9]{16}$/i.test(id), "not a bare 1Z id: " + JSON.stringify(id));
});

test("extractShipmentStatus prefers Delivered over Cancelled", () => {
  const win = '<span>Cancelled</span> Delivered August 10';
  const status = q.extractShipmentStatus(win);
  assert(String(status).startsWith("Delivered"), "expected status starting with Delivered, got " + JSON.stringify(status));
  assert(!/^cancel/i.test(status), "should not return Cancelled, got " + JSON.stringify(status));
});

test("extractShipmentStatus Out for delivery", () => {
  const status = q.extractShipmentStatus("Out for delivery");
  assert(status === "Out for delivery", "expected Out for delivery got " + JSON.stringify(status));
});

test("deliveredFlag Delivered August 10 is YES", () => {
  const flag = q.deliveredFlag("Delivered August 10");
  assert(flag === "YES", "expected YES got " + JSON.stringify(flag));
});

test("deliveredFlag Cancelled is NO", () => {
  const flag = q.deliveredFlag("Cancelled");
  assert(flag === "NO", "expected NO got " + JSON.stringify(flag));
});

test("tracking page Delivered August 10 + TBA is Delivered/YES/bare id", () => {
  const html = `
    <div class="pt-delivery-card">
      <div class="pt-status">Delivered August 10</div>
      <div class="pt-delivery-card-trackingId">TBA333810777143</div>
    </div>
  `;
  const status = q.extractShipmentStatus(html);
  assert(String(status).startsWith("Delivered"), "expected status starting with Delivered, got " + JSON.stringify(status));
  assert(q.deliveredFlag(status) === "YES", "expected YES got " + JSON.stringify(q.deliveredFlag(status)));
  const id = q.parseTrackingId(html);
  assert(id === "TBA333810777143", "expected bare TBA id got " + JSON.stringify(id));
  assert(!/^tracking/i.test(id), "tracking id should be bare, got " + JSON.stringify(id));
});

await test("Cancel items leftover loses to tracking-page Delivered", async () => {
  const orderHtml = `
    <div class="a-box shipment">
      <button>Cancel items</button>
      <span>Cancelled</span>
      <a href="/progress-tracker/package?orderId=112-1111111-1111111&shipmentId=DsC3gvwsv">Track package</a>
    </div>
  `;
  const trackHtml = `
    <div class="pt-delivery-card">
      <div class="pt-status">Delivered August 10</div>
      <div class="pt-delivery-card-trackingId">TBA333810777143</div>
    </div>
  `;
  const fromOrder = q.extractShipmentStatus(orderHtml);
  const fromTrack = q.extractShipmentStatus(trackHtml);
  const merged = q.chooseShipmentStatus(fromOrder, fromTrack);
  assert(String(merged).startsWith("Delivered"), "expected merged Delivered, got " + JSON.stringify(merged) + " fromOrder=" + JSON.stringify(fromOrder));
  assert(!/cancel/i.test(merged), "should not return Cancelled, got " + JSON.stringify(merged));

  const prev = sandbox.amazonGet;
  sandbox.amazonGet = async () => trackHtml;
  try {
    const o = { items: [] };
    await q.attachShipments(o, orderHtml);
    const sh = (o.shipments || [])[0];
    assert(sh, "expected a shipment from order-details HTML");
    assert(String(sh.status).startsWith("Delivered"), "attachShipments status should be Delivered, got " + JSON.stringify(sh.status));
    assert(!/cancel/i.test(sh.status), "attachShipments should not keep Cancelled, got " + JSON.stringify(sh.status));
    assert(sh.delivered === "YES", "expected delivered YES got " + JSON.stringify(sh.delivered));
  } finally {
    sandbox.amazonGet = prev;
  }
});

test("Out for delivery on tracking page is that status and NO", () => {
  const html = '<div class="pt-status">Out for delivery</div><div class="pt-promise">Arriving today</div>';
  const status = q.extractShipmentStatus(html);
  assert(status === "Out for delivery", "expected Out for delivery got " + JSON.stringify(status));
  assert(q.deliveredFlag(status) === "NO", "expected NO got " + JSON.stringify(q.deliveredFlag(status)));
});

const orderDetailsHtml = fs.readFileSync(path.join(__dirname, "fixtures/order-details-111-7680357.html"), "utf8");
const trackingHtml = fs.readFileSync(path.join(__dirname, "fixtures/tracking-111-7680357.html"), "utf8");

test("live order-details fixture status is Arriving today", () => {
  const status = q.extractShipmentStatus(orderDetailsHtml);
  assert(String(status).startsWith("Arriving today"), "expected Arriving today, got " + JSON.stringify(status));
  assert(!/cancel/i.test(status), "should not be Cancelled, got " + JSON.stringify(status));
  assert(!/^delivered/i.test(status), "should not be Delivered, got " + JSON.stringify(status));
});

test("live tracking fixture status is current, not milestone Delivered", () => {
  const status = q.extractShipmentStatus(trackingHtml);
  assert(/^(Shipped|Arriving today|In transit)$/i.test(status), "expected Shipped / Arriving today / In transit, got " + JSON.stringify(status));
  assert(!/^Delivered/i.test(status), "must not pick milestone Delivered, got " + JSON.stringify(status));
  assert(!/Out for delivery/i.test(status), "must not pick milestone Out for delivery, got " + JSON.stringify(status));
});

test("live tracking fixture parseTrackingId is bare TBA", () => {
  const id = q.parseTrackingId(trackingHtml);
  assert(id === "TBA333810777143", "expected TBA333810777143 got " + JSON.stringify(id));
});

test("live tracking fixture deliveredFlag is NO", () => {
  const status = q.extractShipmentStatus(trackingHtml);
  assert(q.deliveredFlag(status) === "NO", "expected NO for " + JSON.stringify(status));
});

test("synthetic tracking h1 Delivered plus milestones is Delivered/YES", () => {
  const html = `
    <h1 class="pt-status-main-status">Delivered</h1>
    <div role="list" class="pt-status-milestones">
      <div class="pt-status-milestone-label">Ordered</div>
      <div class="pt-status-milestone-label">Shipped</div>
      <div class="pt-status-milestone-label">Out for delivery</div>
      <div class="pt-status-milestone-label">Delivered</div>
    </div>
  `;
  const status = q.extractShipmentStatus(html);
  assert(status === "Delivered", "expected Delivered got " + JSON.stringify(status));
  assert(q.deliveredFlag(status) === "YES", "expected YES got " + JSON.stringify(q.deliveredFlag(status)));
});

test("cancelled attribute leftover loses to od-status-message Arriving today", () => {
  const html = `
    <div data-component="cancelled"></div>
    <h4 class="od-status-message"><span class="a-text-bold">Arriving today</span></h4>
  `;
  const status = q.extractShipmentStatus(html);
  assert(String(status).startsWith("Arriving today"), "expected Arriving today, got " + JSON.stringify(status));
  assert(!/cancel/i.test(status), "should not be Cancelled, got " + JSON.stringify(status));
});

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : " — " + r.err}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
