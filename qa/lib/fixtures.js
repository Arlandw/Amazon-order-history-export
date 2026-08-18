"use strict";

const ORDER_A = "111-1234567-1234567";
const ORDER_B = "112-7654321-7654321";
const ORDER_C = "113-2468013-1357913";
const FAKE_ID = "000-0000000-0000000";

function listPage({ orders, count, extra = "" }) {
  const cards = orders.map((o) => `
    <div class="order-card" data-csa-c-slot-id="orderCard-${o.id}">
      <div class="a-row">
        <span class="order-date">${o.date}</span>
        <span class="a-color-price">${o.total}</span>
        <span>Ship to</span>
        <span class="yohtmlc-recipient">${o.to}</span>
        <a href="/gp/your-account/order-details?orderID=${o.id}">Order #${o.id}</a>
        <a href="/dp/${o.asin}">${o.title}</a>
      </div>
    </div>`).join("\n");
  return `<!DOCTYPE html><html><body>
    <div class="num-orders">${count} orders</div>
    ${cards}
    ${extra}
  </body></html>`;
}

function printInvoice(o) {
  const items = (o.items || []).map((it) => `
    <div class="item">
      <a href="/gp/product/${it.asin}">${it.item}</a>
      <i>${it.item}</i>
      Quantity: ${it.qty || 1}
      ${it.amount ? "$" + it.amount : ""}
    </div>`).join("\n");
  const pay = (o.payments || []).map((p) => `
    <div class="pmethod">${p.method} ending in ${p.last4}
      ${p.date || o.date}
      $${p.amount || o.total}
    </div>`).join("\n");
  return `<!DOCTYPE html><html><body>
    <b>Order Placed:</b> ${o.placed}
    <b>Amazon.com order number:</b> ${o.id}
    <ul><li class="displayAddressFullName">${o.to}</li></ul>
    ${items}
    <div>Shipping &amp; Handling: $${o.shipping || "0.00"}</div>
    <div>Estimated tax to be collected: $${o.tax || "0.00"}</div>
    ${o.gift ? `<div>Gift Card: $${o.gift}</div>` : ""}
    ${o.refund ? `<div>Refund Total: $${o.refund}</div>` : ""}
    ${o.shippingRefund ? `<div>Shipping refund: $${o.shippingRefund}</div>` : ""}
    <div>Grand Total: $${o.total}</div>
    <div>Payment Method:</div>
    ${pay}
  </body></html>`;
}

function orderDetails(o) {
  const items = (o.items || []).map((it) => `
    <div class="yohtmlc-item">${it.item}</div>
    <a href="/dp/${it.asin}">${it.item}</a>
  `).join("\n");
  return `<!DOCTYPE html><html><body>
    <h1>Order Details</h1>
    Order ID ${o.id}
    <li class="displayAddressFullName">${o.to || ""}</li>
    ${items}
  </body></html>`;
}

function signInPage() {
  return `<!DOCTYPE html><html><body>
    <form name="signIn" action="/ap/signin">
      <h1>Sign in</h1>
      <label>Email or mobile phone number</label>
      <input type="email" />
      <p>Sign in to your account</p>
    </form>
  </body></html>`;
}

function orderDetailsWithShipment(o) {
  const sid = o.shipmentId || "DsC3gvwsv";
  const status = o.status || "Delivered";
  const items = (o.items || []).map((it) => `
    <a href="/dp/${it.asin}">${it.item}</a>
    Quantity: ${it.qty || 1}
    ${it.amount ? "$" + it.amount : ""}
  `).join("\n");
  return `<!DOCTYPE html><html><body>
    <h1>Order Details</h1>
    Order ID ${o.id}
    <div class="a-box shipment">
      <span class="a-text-bold">${status}</span>
      <a href="/progress-tracker/package/ref=ppx_yo_dt_b_track_package?_encoding=UTF8&orderId=${o.id}&packageIndex=0&shipmentId=${sid}">Track package</a>
      ${items}
    </div>
    <li class="displayAddressFullName">${o.to || ""}</li>
  </body></html>`;
}

function trackingPage(trackingId) {
  return `<!DOCTYPE html><html><body>
    <div id="pt-delivery-card-trackingId">${trackingId}</div>
    <p>Tracking ID: ${trackingId}</p>
  </body></html>`;
}

const sampleOrders = {
  A: {
    id: ORDER_A,
    placed: "January 15, 2024",
    date: "January 15, 2024",
    total: "28.43",
    shipping: "5.99",
    tax: "2.45",
    gift: "",
    refund: "",
    shippingRefund: "",
    to: "Jane Doe",
    asin: "B0CABLE123",
    title: "USB-C Cable 6ft Braided",
    items: [{ item: "USB-C Cable 6ft Braided", asin: "B0CABLE123", qty: "2", amount: "12.99" }],
    payments: [{ method: "Visa", last4: "4242", date: "January 15, 2024", amount: "28.43" }],
  },
  B: {
    id: ORDER_B,
    placed: "March 3, 2024",
    date: "March 3, 2024",
    total: "41.10",
    shipping: "0.00",
    tax: "3.11",
    gift: "10.00",
    refund: "",
    shippingRefund: "",
    to: "John Smith",
    asin: "B0MOUSE456",
    title: "Wireless Mouse Silent Click",
    items: [{ item: "Wireless Mouse Silent Click", asin: "B0MOUSE456", qty: "1", amount: "38.00" }],
    payments: [{ method: "American Express", last4: "1009", date: "March 3, 2024", amount: "31.10" }],
  },
  C: {
    id: ORDER_C,
    placed: "July 20, 2024",
    date: "July 20, 2024",
    total: "15.00",
    shipping: "0.00",
    tax: "0.00",
    refund: "15.00",
    shippingRefund: "0.00",
    to: "Alex Roe",
    asin: "B0BOOK7890",
    title: "Notebook Hardcover Dotted",
    items: [{ item: "Notebook Hardcover Dotted", asin: "B0BOOK7890", qty: "1", amount: "15.00" }],
    payments: [{ method: "Mastercard", last4: "5555", date: "July 20, 2024", amount: "15.00" }],
  },
};

module.exports = {
  ORDER_A, ORDER_B, ORDER_C, FAKE_ID,
  listPage, printInvoice, orderDetails, signInPage, orderDetailsWithShipment, trackingPage, sampleOrders,
};
