let rows = [];
let headers = [];
let sortKey = "";
let sortDir = 1;
let format = "orders";
let reports = [];
let activeIndex = 0;
const FORMAT_LABELS = { orders: "Orders", items: "Items", payments: "Payments", shipments: "Shipments" };

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(list) {
  const lines = [headers.join(",")];
  for (const row of list) lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  return lines.join("\n") + "\n";
}

function filtered() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  let list = rows;
  if (q) {
    list = rows.filter((r) => headers.some((h) => String(r[h] || "").toLowerCase().includes(q)));
  }
  if (sortKey) {
    list = [...list].sort((a, b) => {
      const av = String(a[sortKey] || "");
      const bv = String(b[sortKey] || "");
      return av.localeCompare(bv, undefined, { numeric: true }) * sortDir;
    });
  }
  return list;
}

function moneyNum(v) {
  const n = Number(String(v || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function moneyFmt(n) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTotals(list) {
  const el = document.getElementById("totals");
  const orderIds = new Set();
  let spend = 0, tax = 0, shipping = 0, refund = 0, pay = 0;
  if (format === "payments") {
    for (const r of list) {
      pay += moneyNum(r.amount);
      orderIds.add(r["order id"]);
    }
    el.innerHTML = `<span>Orders</span> <b>${orderIds.size}</b><span>Payments</span> <b>${moneyFmt(pay)}</b><span>Rows</span> <b>${list.length}</b>`;
    return;
  }
  if (format === "items") {
    const seen = new Set();
    for (const r of list) {
      const id = r["order id"];
      if (id && !seen.has(id)) {
        seen.add(id);
        spend += moneyNum(r["order total"]);
        tax += moneyNum(r.tax);
        shipping += moneyNum(r.shipping);
      }
    }
    el.innerHTML = `<span>Orders</span> <b>${seen.size}</b><span>Items</span> <b>${list.length}</b><span>Spend</span> <b>${moneyFmt(spend)}</b><span>Tax</span> <b>${moneyFmt(tax)}</b><span>Shipping</span> <b>${moneyFmt(shipping)}</b>`;
    return;
  }
  if (format === "shipments") {
    const seen = new Set();
    for (const r of list) {
      const id = r["order id"];
      if (id && !seen.has(id)) {
        seen.add(id);
        spend += moneyNum(r.total || r["order total"]);
      }
    }
    const spendBit = spend ? `<span>Spend</span> <b>${moneyFmt(spend)}</b>` : "";
    el.innerHTML = `<span>Orders</span> <b>${seen.size}</b><span>Shipments</span> <b>${list.length}</b>${spendBit}`;
    return;
  }
  for (const r of list) {
    orderIds.add(r["order id"]);
    spend += moneyNum(r.total);
    tax += moneyNum(r.tax);
    shipping += moneyNum(r.shipping);
    refund += moneyNum(r.refund);
  }
  el.innerHTML = `<span>Orders</span> <b>${orderIds.size || list.length}</b><span>Spend</span> <b>${moneyFmt(spend)}</b><span>Tax</span> <b>${moneyFmt(tax)}</b><span>Shipping</span> <b>${moneyFmt(shipping)}</b><span>Refunds</span> <b>${moneyFmt(refund)}</b>`;
}

function updateTabs() {
  const el = document.getElementById("reportTabs");
  if (!el) return;
  const show = reports.length > 1;
  if (el.classList && el.classList.toggle) el.classList.toggle("show", show);
  if (typeof el.replaceChildren !== "function") return;
  el.replaceChildren();
  if (!show) return;
  reports.forEach((r, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = FORMAT_LABELS[r.format] || r.format;
    if (i === activeIndex) b.classList.add("on");
    b.addEventListener("click", () => showReport(i));
    el.appendChild(b);
  });
}

function fadeWrap() {
  const wrap = document.getElementById("wrap");
  if (!wrap) return;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  wrap.classList.add("is-fading");
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => wrap.classList.remove("is-fading"));
  } else {
    wrap.classList.remove("is-fading");
  }
}

function showReport(i) {
  if (!reports[i]) return;
  activeIndex = i;
  const r = reports[i];
  format = r.format || "orders";
  headers = r.headers || [];
  rows = r.rows || [];
  sortKey = "";
  sortDir = 1;
  updateTabs();
  render();
  fadeWrap();
}

function render() {
  const list = filtered();
  const label = FORMAT_LABELS[format] || format;
  if (reports.length > 1) {
    document.getElementById("meta").textContent = `${label} · ${reports.length} reports · ${list.length} of ${rows.length} rows`;
  } else {
    document.getElementById("meta").textContent = `${list.length} of ${rows.length} rows`;
  }
  renderTotals(list);
  if (!rows.length) return;
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h + (sortKey === h ? (sortDir > 0 ? " ↑" : " ↓") : "");
    th.addEventListener("click", () => {
      if (sortKey === h) sortDir *= -1;
      else { sortKey = h; sortDir = 1; }
      render();
    });
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  table.appendChild(thead);
  const tb = document.createElement("tbody");
  for (const row of list) {
    const r = document.createElement("tr");
    for (const h of headers) {
      const td = document.createElement("td");
      const val = row[h] == null ? "" : String(row[h]);
      if (/^https?:\/\//.test(val)) {
        const a = document.createElement("a");
        a.href = val;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = "Open";
        td.appendChild(a);
      } else td.textContent = val;
      r.appendChild(td);
    }
    tb.appendChild(r);
  }
  table.appendChild(tb);
  const wrap = document.getElementById("wrap");
  wrap.replaceChildren(table);
}

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

chrome.storage.local.get("lastExport", (data) => {
  const exp = data.lastExport;
  if (!exp) return;
  if (Array.isArray(exp.reports) && exp.reports.length) {
    reports = exp.reports.filter((r) => r && Array.isArray(r.headers) && Array.isArray(r.rows));
  } else if (Array.isArray(exp.rows) && exp.headers) {
    reports = [{ format: exp.format || "orders", headers: exp.headers, rows: exp.rows }];
  }
  if (!reports.length || !reports.some((r) => r.rows && r.rows.length)) return;
  const idx = reports.findIndex((r) => r.rows && r.rows.length);
  showReport(idx >= 0 ? idx : 0);
});

document.getElementById("q").addEventListener("input", render);
document.getElementById("csv").addEventListener("click", () => {
  const stamp = new Date().toISOString().slice(0, 10);
  download(`amazon_${format}_${stamp}.csv`, toCsv(filtered()), "text/csv");
});
document.getElementById("json").addEventListener("click", () => {
  const stamp = new Date().toISOString().slice(0, 10);
  download(`amazon_${format}_${stamp}.json`, JSON.stringify(filtered(), null, 2), "application/json");
});
document.getElementById("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(toCsv(filtered()));
  document.getElementById("copy").textContent = "Copied";
  setTimeout(() => (document.getElementById("copy").textContent = "Copy"), 1200);
});
