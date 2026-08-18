let currentOrigin = "https://www.amazon.com";
let cancelled = false;
let scrapeRunning = false;
const ORDER_ID_RE = /\b(\d{3}-\d{7}-\d{7})\b/g;
const MONTHS = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};
const SKIP_TITLES = /^(view|order|invoice|return|buy again|write a product|product support|ask about|share|track|hide|your account|details|invoice 1|print|leave seller|get help|get product support|ask a question|write a review|return or replace|view your item|shop this|subscribe|add to cart)$/i;
const QUARTER_BOUNDS = {
  Q1: { from: "01-01", to: "03-31", months: [1, 2, 3] },
  Q2: { from: "04-01", to: "06-30", months: [4, 5, 6] },
  Q3: { from: "07-01", to: "09-30", months: [7, 8, 9] },
  Q4: { from: "10-01", to: "12-31", months: [10, 11, 12] },
};
const SHIP_STATUS_PHRASES = [
  "Return complete",
  "Out for delivery",
  "Not yet shipped",
  "Preparing for shipment",
  "Delivery complete",
  "Package delivered",
  "Was delivered",
  "Delivered on",
  "Delivered",
  "Arriving today",
  "Arriving tomorrow",
  "Arriving",
  "In transit",
  "Shipped",
  "Delayed",
  "Cancelled",
  "Canceled",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function progress(text, extra) {
  chrome.runtime.sendMessage(Object.assign({ type: "progress", text }, extra || {})).catch(() => {});
}

function checkCancel() {
  if (cancelled) throw new Error("Stopped.");
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  return lines.join("\n") + "\n";
}

function decode(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html) {
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function isRealOrderId(id) {
  return /^\d{3}-\d{7}-\d{7}$/.test(id) && !id.startsWith("000-") && !/0{7}/.test(id);
}

function toISO(s) {
  if (!s) return "";
  const iso = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const m = String(s).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i);
  if (!m) return String(s).trim();
  return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${String(m[2]).padStart(2, "0")}`;
}

function moneyPlain(s) {
  if (s == null || s === "") return "";
  const m = String(s).match(/(?:[$£€₹¥]|R\$)?\s*([\d,]+(?:\.\d{2})?)/);
  return m ? m[1] : "";
}

function moneyToken(html) {
  return html.match(/(?:[$£€₹¥]|R\$)\s*[\d,]+(?:\.\d{2})?/g) || [];
}

function labeledMoney(html, labels) {
  for (const lab of labels) {
    const re = new RegExp(lab + "[\\s\\S]{0,80}?((?:[$£€₹¥]|R\\$)\\s*[\\d,]+(?:\\.\\d{2})?)", "i");
    const m = html.match(re);
    if (m) return moneyPlain(m[1]);
  }
  return "";
}

async function amazonGet(path) {
  const url = path.startsWith("http") ? path : currentOrigin + path;
  const res = await fetch(url, {
    credentials: "include",
    redirect: "follow",
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  const text = await res.text();
  const lower = text.toLowerCase();
  const signedOut =
    res.url.includes("/ap/signin") ||
    (lower.includes("email or mobile") && lower.includes("sign in")) ||
    lower.includes('name="signIn"');
  if (res.status === 401 || (signedOut && !/order-card|num-orders|order id|items ordered/i.test(text))) {
    throw new Error("Amazon wants a sign-in. Open your orders page, sign in, then run this again.");
  }
  if (!res.ok) throw new Error(`Amazon returned ${res.status}`);
  return text;
}

function extractTitles(html) {
  const items = [];
  const seen = new Set();
  function add(title, extra) {
    const item = stripTags(title);
    if (!item || item.length < 4 || item.length > 400) return;
    if (SKIP_TITLES.test(item)) return;
    if (/^(order|ship|deliver|total|quantity|sold by|condition)/i.test(item)) return;
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      item,
      amount: extra && extra.amount ? extra.amount : "",
      asin: extra && extra.asin ? extra.asin : "",
      qty: extra && extra.qty ? extra.qty : "",
    });
  }
  let m;
  const linkRe = /<a[^>]+href="([^"]*(?:\/dp\/|\/gp\/product\/)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = linkRe.exec(html))) {
    const asinM = m[1].match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    add(m[2], { asin: asinM ? asinM[1] : "" });
  }
  const yoRe = /yohtmlc-(?:item|product-title)[^>]*>([\s\S]*?)<\/(?:div|span|a|h\d)>/gi;
  while ((m = yoRe.exec(html))) add(m[1]);
  const compRe = /data-component="itemTitle"[^>]*>([\s\S]*?)<\/(?:div|span|a|h\d)>/gi;
  while ((m = compRe.exec(html))) add(m[1]);
  const iRe = /<i>\s*([^<]{4,400})\s*<\/i>/gi;
  while ((m = iRe.exec(html))) add(m[1]);
  return items;
}

function enrichItems(html, items) {
  for (const it of items) {
    const loc = html.toLowerCase().indexOf(it.item.slice(0, 40).toLowerCase());
    if (loc === -1) continue;
    const slice = html.slice(loc, loc + 1000);
    if (!it.amount) {
      const prices = moneyToken(slice);
      if (prices[0]) it.amount = moneyPlain(prices[0]);
    }
    if (!it.qty) {
      const q = slice.match(/Quantity[:\s]*(\d+)/i) || slice.match(/Qty[:\s]*(\d+)/i);
      if (q) it.qty = q[1];
    }
    if (!it.asin) {
      const a = slice.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      if (a) it.asin = a[1];
    }
  }
  return items;
}

function parseListPage(html) {
  const orders = [];
  const seen = new Set();
  const slotRe = /data-csa-c-slot-id="([^"]+)"/g;
  let m;
  while ((m = slotRe.exec(html))) {
    const idm = m[1].match(/(\d{3}-\d{7}-\d{7})/);
    if (idm && isRealOrderId(idm[1]) && !seen.has(idm[1])) {
      seen.add(idm[1]);
      orders.push({ orderId: idm[1] });
    }
  }
  const hrefRe = /orderID=(\d{3}-\d{7}-\d{7})/g;
  while ((m = hrefRe.exec(html))) {
    if (isRealOrderId(m[1]) && !seen.has(m[1])) {
      seen.add(m[1]);
      orders.push({ orderId: m[1] });
    }
  }
  for (const id of html.match(ORDER_ID_RE) || []) {
    if (isRealOrderId(id) && !seen.has(id)) {
      seen.add(id);
      orders.push({ orderId: id });
    }
  }
  let count = 0;
  const countM = html.match(/([\d,]+)\s+orders?/i);
  if (countM) count = Number(countM[1].replace(/,/g, "")) || 0;
  const signin = /ap\/signin|sign in to your account/i.test(html) && orders.length === 0;
  return { orders, count, signin };
}

function parseCard(html, orderId) {
  const idx = html.indexOf(orderId);
  const win = idx === -1 ? "" : html.slice(Math.max(0, idx - 3500), idx + 9000);
  const dateM = win.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/);
  const totals = moneyToken(win);
  const toM =
    win.match(/Ship to\s*<\/[^>]+>\s*<[^>]+>([^<]+)/i) ||
    win.match(/Deliver(?:ed)? to\s*<\/[^>]+>\s*<[^>]+>([^<]+)/i) ||
    win.match(/yohtmlc-recipient[^>]*>([^<]+)/i);
  return {
    date: dateM ? toISO(dateM[0]) : "",
    total: moneyPlain(totals[0] || ""),
    to: toM ? stripTags(toM[1]) : "",
    items: enrichItems(win, extractTitles(win)),
  };
}

function parseInvoice(html) {
  const dateM =
    html.match(/Order\s+(?:Placed|Date)[:\s]+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i) ||
    html.match(/\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})\b/);
  const total =
    labeledMoney(html, ["Grand Total", "Order Total", "Total for this Order"]) ||
    moneyPlain((html.match(/Grand Total[\s\S]{0,60}((?:[$£€₹¥]|R\$)[\d,\s.]+)/i) || [])[1]);
  const shipping = labeledMoney(html, ["Shipping [&amp;&] Handling", "Shipping &amp; Handling", "Shipping and Handling", "Free Shipping", "Shipping"]);
  const tax = labeledMoney(html, ["Estimated tax to be collected", "Sales Tax", "Tax collected", "Estimated tax"]);
  const gift = labeledMoney(html, ["Gift Card", "Gift Certificate"]);
  const refund = labeledMoney(html, ["Refund Total", "Refunded", "Total refund"]);
  const shippingRefund = labeledMoney(html, ["Shipping refund", "Refunded shipping"]);
  let to = "";
  const toM =
    html.match(/<li class="displayAddressFullName">([^<]+)/i) ||
    html.match(/Ship(?:ping)? to[:\s]+<\/[^>]+>\s*<[^>]+>([^<]+)/i) ||
    html.match(/Deliver(?:ed|y)? to[:\s]+([^<\n]+)/i);
  if (toM) to = stripTags(toM[1]);
  const dateIso = dateM ? toISO(dateM[1] || dateM[0]) : "";
  const paymentsList = extractPayments(html, dateIso, total);
  const payments = paymentsList.map((p) => {
    const bits = [];
    let method = p.method || "";
    if (p.last4) method = method ? `${method} ending in ${p.last4}` : `ending in ${p.last4}`;
    if (method) bits.push(method);
    if (p.date) bits.push(p.date);
    if (p.amount) bits.push(p.amount);
    return bits.length ? bits.join(": ") + "; " : "";
  }).join("");
  const items = enrichItems(html, extractTitles(html));
  return { date: dateIso, total, shipping, tax, gift, refund, shippingRefund, to, payments, paymentsList, items };
}

function extractPayments(html, dateIso, fallbackAmount) {
  const out = [];
  const seen = new Set();
  const re = /((?:American Express|Amex|Visa|Mastercard|MasterCard|Discover|Amazon Store Card|Amazon Visa|Chase|Capital One|Apple Card|Debit Card|Gift Card|Checking)[^<]{0,48}?)(?:ending in|…|\.\.\.)\s*(\d{3,4})/gi;
  let m;
  while ((m = re.exec(html))) {
    const method = stripTags(m[1]).replace(/ending in$/i, "").trim();
    const last4 = m[2];
    const key = `${method}|${last4}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const slice = html.slice(Math.max(0, m.index - 80), m.index + 280);
    const amt = moneyPlain((moneyToken(slice)[0] || fallbackAmount || ""));
    const d = toISO((slice.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/) || [dateIso])[0]) || dateIso;
    out.push({ method, last4, date: d, amount: amt || fallbackAmount || "" });
  }
  if (!out.length && fallbackAmount) {
    out.push({ method: "", last4: "", date: dateIso, amount: fallbackAmount });
  }
  return out;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addCalendarMonths(d, delta) {
  const first = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last));
}

function yearsSpanning(fromIso, toIso) {
  const y0 = Number(String(fromIso).slice(0, 4));
  const y1 = Number(String(toIso).slice(0, 4));
  const years = [];
  for (let y = Math.max(y0, y1); y >= Math.min(y0, y1); y--) years.push(y);
  return years.filter((y) => Number.isFinite(y));
}

function lastMonthsWindow(n, now) {
  now = now || new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = addCalendarMonths(to, -Number(n) || 0);
  const fromDate = isoFromDate(from);
  const toDate = isoFromDate(to);
  return { fromDate, toDate, years: yearsSpanning(fromDate, toDate) };
}

function normalizeQuarter(q) {
  const s = String(q || "").toUpperCase().replace(/^Q/, "");
  return "Q" + s;
}

function quarterWindow(year, quarters) {
  const qs = (quarters || []).map(normalizeQuarter).filter((q) => QUARTER_BOUNDS[q]);
  let fromDate = "";
  let toDate = "";
  const months = [];
  for (const q of ["Q1", "Q2", "Q3", "Q4"]) {
    if (!qs.includes(q)) continue;
    const b = QUARTER_BOUNDS[q];
    const f = `${year}-${b.from}`;
    const t = `${year}-${b.to}`;
    if (!fromDate || f < fromDate) fromDate = f;
    if (!toDate || t > toDate) toDate = t;
    months.push(...b.months);
  }
  return { fromDate, toDate, years: [Number(year)], months, quarters: qs };
}

function monthWindow(year, months) {
  const ms = (months || []).map(Number).filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
  let fromDate = "";
  let toDate = "";
  if (ms.length) {
    const first = ms[0];
    const last = ms[ms.length - 1];
    const lastDay = new Date(Number(year), last, 0).getDate();
    fromDate = `${year}-${pad2(first)}-01`;
    toDate = `${year}-${pad2(last)}-${pad2(lastDay)}`;
  }
  return { fromDate, toDate, years: [Number(year)], months: ms };
}

function rangeWindow(range, opts) {
  opts = opts || {};
  const now = opts.now || new Date();
  if (range === "last1" || range === "months-1") return lastMonthsWindow(1, now);
  if (range === "last2" || range === "months-2") return lastMonthsWindow(2, now);
  if (range === "quarters") return quarterWindow(opts.year || now.getFullYear(), opts.quarters || []);
  if (range === "months") return monthWindow(opts.year || now.getFullYear(), opts.months || []);
  return { fromDate: opts.fromDate || "", toDate: opts.toDate || "", years: [] };
}

function dateMatchesMonths(date, year, months) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  if (Number(date.slice(0, 4)) !== Number(year)) return false;
  const m = Number(date.slice(5, 7));
  return (months || []).map(Number).includes(m);
}

function dateMatchesQuarters(date, year, quarters) {
  return dateMatchesMonths(date, year, quarterWindow(year, quarters).months);
}

function deliveredFlag(status) {
  const s = String(status || "").toLowerCase();
  if (!s) return "UNKNOWN";
  if (/return complete|returned/.test(s)) return "RETURNED";
  if (/delivered|delivery complete/.test(s)) return "YES";
  if (/arriv|ship|out for delivery|in transit|prepar|not yet|pending|delayed|cancel/.test(s)) return "NO";
  return "UNKNOWN";
}

function shipmentStatusRank(s) {
  const x = String(s || "").toLowerCase();
  if (!x) return 10;
  if (/delivered|delivery complete/.test(x)) return 0;
  if (/out for delivery/.test(x)) return 1;
  if (/arriv/.test(x)) return 2;
  if (/in transit/.test(x)) return 3;
  if (/shipped/.test(x)) return 4;
  if (/prepar|not yet/.test(x)) return 5;
  if (/return complete/.test(x)) return 6;
  if (/delayed/.test(x)) return 7;
  if (/cancel/.test(x)) return 9;
  return 8;
}

function chooseShipmentStatus(fromOrder, fromTracking) {
  // Prefer a more specific current status: Arriving today > Shipped > cancel leftover.
  // Node-based extract should not feed milestone "Delivered" in here.
  const a = String(fromOrder || "").trim();
  const b = String(fromTracking || "").trim();
  if (!b) return a;
  if (!a) return b;
  return shipmentStatusRank(b) < shipmentStatusRank(a) ? b : a;
}

const STATUS_PHRASE_RE = /\b(Return complete|Out for delivery|Not yet shipped|Preparing for shipment|Delivery complete|Package delivered|Was delivered|Delivered(?:\s+on)?(?:\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s+\d{4})?)?|Arriving(?: today| tomorrow)?|In transit|Shipped|Delayed|Cancelled|Canceled)\b/gi;
const SHORT_STATUS_MAP = {
  IN_TRANSIT: "In transit",
  DELIVERED: "Delivered",
  OUT_FOR_DELIVERY: "Out for delivery",
  SHIPPED: "Shipped",
  NOT_YET_SHIPPED: "Not yet shipped",
  PREPARING: "Preparing for shipment",
  PREPARING_FOR_SHIPMENT: "Preparing for shipment",
  DELAYED: "Delayed",
  CANCELLED: "Cancelled",
  CANCELED: "Cancelled",
  RETURN_COMPLETE: "Return complete",
  DELIVERY_COMPLETE: "Delivery complete",
  ARRIVING: "Arriving",
  ARRIVING_TODAY: "Arriving today",
  ARRIVING_TOMORROW: "Arriving tomorrow",
};

function collectStatusPhrases(text) {
  const found = [];
  if (!text) return found;
  STATUS_PHRASE_RE.lastIndex = 0;
  let m;
  while ((m = STATUS_PHRASE_RE.exec(text))) found.push(m[1].replace(/\s+/g, " ").trim());
  return found;
}

function bestStatusPhrase(found) {
  if (!found || !found.length) return "";
  return found.slice().sort((a, b) => shipmentStatusRank(a) - shipmentStatusRank(b))[0];
}

function findCloseTag(html, tag, from) {
  const t = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openRe = new RegExp("<" + t + "\\b[^>]*>", "gi");
  const closeRe = new RegExp("</" + t + "\\s*>", "gi");
  let depth = 1;
  let i = from;
  while (i < html.length && depth > 0) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const o = openRe.exec(html);
    const c = closeRe.exec(html);
    if (!c) return html.length;
    if (o && o.index < c.index) {
      if (/\/\s*>$/.test(o[0])) {
        i = o.index + o[0].length;
        continue;
      }
      depth += 1;
      i = o.index + o[0].length;
    } else {
      depth -= 1;
      i = c.index + c[0].length;
    }
  }
  return i;
}

function innersMatching(html, openRe) {
  const out = [];
  const re = new RegExp(openRe.source, openRe.flags.includes("g") ? openRe.flags : openRe.flags + "g");
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1] || "div";
    const start = m.index + m[0].length;
    const end = findCloseTag(html, tag, start);
    const chunk = html.slice(start, end);
    out.push(chunk.replace(new RegExp("</" + tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*>$", "i"), ""));
  }
  return out;
}

function firstPhraseFromNodes(html, openRe) {
  for (const inner of innersMatching(html, openRe)) {
    const phrases = collectStatusPhrases(stripTags(inner));
    if (phrases.length) return phrases[0];
  }
  return "";
}

function removeMatchedElements(html, openRe) {
  let s = String(html || "");
  const src = openRe.source;
  const flags = openRe.flags.replace("g", "");
  while (true) {
    const re = new RegExp(src, flags);
    const m = re.exec(s);
    if (!m) break;
    const tag = m[1] || "div";
    const end = findCloseTag(s, tag, m.index + m[0].length);
    s = s.slice(0, m.index) + " " + s.slice(end);
  }
  return s;
}

function stripStatusNoise(html) {
  let s = String(html || "");
  s = removeMatchedElements(s, /<([a-z0-9]+)[^>]*\bpt-status-milestones\b[^>]*>/i);
  s = removeMatchedElements(s, /<([a-z0-9]+)[^>]*\bpt-status-milestone(?:-label)?\b[^>]*>/i);
  s = removeMatchedElements(s, /<([a-z0-9]+)[^>]*data-component\s*=\s*["']cancelled["'][^>]*>/i);
  return s;
}

function extractJsonShipmentStatus(html) {
  const raw = decode(html);
  const pm = raw.match(/"promise"\s*:\s*\{[^}]*?"promiseMessage"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (pm) {
    const msg = decode(pm[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\"/g, '"')).replace(/\s+/g, " ").trim();
    const phrases = collectStatusPhrases(msg);
    if (phrases.length) return phrases[0];
    if (msg && msg.length < 80 && /arriv|ship|deliver|transit|delay|cancel/i.test(msg)) return msg;
  }
  const sm = raw.match(/"shortStatus"\s*:\s*"([A-Z_]+)"/);
  if (sm && SHORT_STATUS_MAP[sm[1]]) return SHORT_STATUS_MAP[sm[1]];
  return "";
}

function extractShipmentStatus(html) {
  if (!html) return "";

  // 1. Order-details dedicated nodes (never whole-page / attribute scan)
  const fromOd =
    firstPhraseFromNodes(html, /<(h[1-6])[^>]*\bod-status-message\b[^>]*>/gi) ||
    firstPhraseFromNodes(html, /<(div|span|p)[^>]*\bod-status-message\b[^>]*>/gi) ||
    firstPhraseFromNodes(html, /<([a-z0-9]+)[^>]*data-component\s*=\s*["']shipmentStatus["'][^>]*>/gi);
  if (fromOd) return fromOd;

  // 2. Tracking page current status — not milestone labels
  const mainNodes = innersMatching(html, /<(h[1-6])[^>]*\bpt-status-main-status\b[^>]*>/gi);
  for (const inner of mainNodes) {
    const text = stripTags(inner);
    const phrases = collectStatusPhrases(text);
    if (phrases.length) return phrases[0];
    if (text && text.length < 80) return text;
  }

  // 3. Embedded tracking JSON
  const fromJson = extractJsonShipmentStatus(html);
  if (fromJson) return fromJson;

  // 4. Fallback: visible text only, after dropping milestones / cancelled shells / attributes
  const cleaned = stripStatusNoise(html);
  return bestStatusPhrase(collectStatusPhrases(stripTags(cleaned)));
}

function absAmazonUrl(href) {
  if (!href) return "";
  let h = decode(href).trim();
  if (h.startsWith("//")) h = "https:" + h;
  if (/^https?:\/\//i.test(h)) return h;
  if (!h.startsWith("/")) h = "/" + h;
  return currentOrigin + h;
}

function cleanTrackingId(raw) {
  let s = stripTags(raw || "").replace(/^tracking\s*id\s*[:\-]?\s*/i, "").trim();
  const tba = s.match(/\b(TBA\d{10,})\b/);
  if (tba) return tba[1];
  const ups = s.match(/\b(1Z[A-Z0-9]{16})\b/i);
  if (ups) return ups[1];
  const usps = s.match(/\b(9\d{21})\b/) || s.match(/\b([A-Z]{2}\d{9}US)\b/);
  if (usps) return usps[1];
  return s.replace(/[^A-Z0-9]/gi, "") ? s : "";
}

function parseTrackingId(html) {
  if (!html) return "";
  const card =
    html.match(/pt-delivery-card-trackingId[^>]*>([^<]+)/i) ||
    html.match(/id=["']pt-delivery-card-trackingId["'][^>]*>([^<]+)/i);
  if (card) {
    const cleaned = cleanTrackingId(card[1]);
    if (cleaned) return cleaned;
  }
  const labeled = html.match(/Tracking\s*ID[:\s]+([A-Z0-9]{6,})/i);
  if (labeled) return cleanTrackingId(labeled[1]);
  return cleanTrackingId(
    (html.match(/\b(1Z[A-Z0-9]{16})\b/i) ||
      html.match(/\b(TBA\d{10,})\b/) ||
      html.match(/\b(9\d{21})\b/) ||
      html.match(/\b([A-Z]{2}\d{9}US)\b/) ||
      [])[0] || ""
  );
}

function parseShipments(html, orderItems) {
  const shipments = [];
  const seen = new Set();
  function pushShipment(shipmentId, trackingLink, win) {
    const key = shipmentId || trackingLink;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const items = enrichItems(win, extractTitles(win));
    const status = extractShipmentStatus(win);
    shipments.push({
      shipmentId: shipmentId || "",
      status,
      delivered: deliveredFlag(status),
      trackingLink: trackingLink ? absAmazonUrl(trackingLink) : "",
      trackingId: "",
      items: items.length ? items : [],
    });
  }
  const linkRe = /<a[^>]+href=["']([^"']*(?:\/progress-tracker\/|\/ship-track)[^"']*)["'][^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const href = decode(m[1]);
    const sidM = href.match(/[?&]shipmentId=([^&"'#]+)/i);
    const shipmentId = sidM ? decodeURIComponent(sidM[1]) : "";
    const win = html.slice(Math.max(0, m.index - 4000), Math.min(html.length, m.index + 4000));
    pushShipment(shipmentId, href, win);
  }
  const sidRe = /[?&]shipmentId=([A-Za-z0-9_-]+)/gi;
  while ((m = sidRe.exec(html))) {
    if (seen.has(m[1])) continue;
    const win = html.slice(Math.max(0, m.index - 4000), Math.min(html.length, m.index + 4000));
    pushShipment(m[1], "", win);
  }
  return shipments;
}

function cacheKey(origin) {
  return "orderCache:" + origin.replace(/^https?:\/\//, "");
}

async function loadCache(origin) {
  const key = cacheKey(origin);
  const data = await chrome.storage.local.get(key);
  const block = data[key];
  return block && block.orders ? block.orders : {};
}

async function saveCache(origin, ordersById) {
  const key = cacheKey(origin);
  await chrome.storage.local.set({
    [key]: { version: 1, origin, updatedAt: new Date().toISOString(), orders: ordersById },
  });
}

function cacheReady(o, format) {
  if (!o || !o.orderId || !(o.items || []).length) return false;
  const invoiceReady = !!(o.invoiced || o.tax || o.shipping || o.payments || (o.paymentsList && o.paymentsList.length));
  if (!invoiceReady) return false;
  if (format === "shipments") {
    return (Array.isArray(o.shipments) && o.shipments.length > 0) || o.shipmentsChecked === true;
  }
  return true;
}

function mergeItems(a, b) {
  const out = [];
  const seen = new Set();
  for (const it of [...(a || []), ...(b || [])]) {
    const key = (it.item || "").toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      const prev = out.find((x) => x.item.toLowerCase() === key);
      if (prev) {
        if (!prev.amount && it.amount) prev.amount = it.amount;
        if (!prev.asin && it.asin) prev.asin = it.asin;
        if (!prev.qty && it.qty) prev.qty = it.qty;
      }
      continue;
    }
    seen.add(key);
    out.push({ item: it.item, amount: it.amount || "", asin: it.asin || "", qty: it.qty || "" });
  }
  return out;
}

function itemsCell(items) {
  if (!items || !items.length) return "";
  return items.map((i) => i.item).filter(Boolean).join("; ") + "; ";
}

function inRange(date, fromDate, toDate) {
  if (!fromDate && !toDate) return true;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  if (fromDate && date < fromDate) return false;
  if (toDate && date > toDate) return false;
  return true;
}

async function attachShipments(o, html) {
  o.shipments = parseShipments(html, o.items);
  o.shipmentsChecked = true;
  for (const sh of o.shipments) {
    if (!sh.items.length && o.items && o.items.length) sh.items = o.items.slice();
    if (!sh.trackingLink) continue;
    try {
      const tr = await amazonGet(sh.trackingLink);
      sh.trackingId = parseTrackingId(tr) || sh.trackingId;
      const st = extractShipmentStatus(tr);
      if (st) {
        sh.status = chooseShipmentStatus(sh.status, st);
        sh.delivered = deliveredFlag(sh.status);
      }
      await sleep(150);
    } catch (_) {}
  }
}

async function scrapeWindow(label, timeFilter, cache, useCache, format) {
  const collected = [];
  const seen = new Set();
  let startIndex = 0;
  let expected = null;
  let emptyStreak = 0;
  let cacheHits = 0;
  for (let page = 0; page < 80; page++) {
    checkCancel();
    const path = `/gp/css/order-history?disableCsd=no-js&timeFilter=${timeFilter}&startIndex=${startIndex}`;
    progress(`${label}: listing page ${page + 1}…`);
    const html = await amazonGet(path);
    const parsed = parseListPage(html);
    if (parsed.signin) throw new Error("Amazon wants a sign-in. Open your orders page, sign in, then run this again.");
    if (expected == null && parsed.count) expected = parsed.count;
    let newOnPage = 0;
    for (const o of parsed.orders) {
      if (seen.has(o.orderId)) continue;
      seen.add(o.orderId);
      newOnPage += 1;
      if (useCache && cacheReady(cache[o.orderId], format)) {
        collected.push(Object.assign({}, cache[o.orderId], { fromCache: true }));
        cacheHits += 1;
        continue;
      }
      if (useCache && cacheReady(cache[o.orderId])) {
        collected.push(Object.assign({}, cache[o.orderId], { fromCache: false, invoiceCached: true }));
        continue;
      }
      const card = parseCard(html, o.orderId);
      collected.push({
        orderId: o.orderId,
        date: card.date,
        total: card.total,
        to: card.to,
        items: card.items,
        shipping: "",
        shippingRefund: "",
        gift: "",
        tax: "",
        refund: "",
        payments: "",
        paymentsList: [],
        shipments: [],
        shipmentsChecked: false,
        fromCache: false,
      });
    }
    if (newOnPage === 0) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
    } else emptyStreak = 0;
    if (expected && seen.size >= expected) break;
    startIndex += Math.max(newOnPage, 10);
    await sleep(350);
  }
  for (let i = 0; i < collected.length; i++) {
    checkCancel();
    const o = collected[i];
    progress(`${label}: ${o.fromCache ? "cached" : "invoice"} ${i + 1}/${collected.length}`, { current: i + 1, total: collected.length });
    if (o.fromCache) continue;
    if (!o.invoiceCached) {
      try {
        const inv = parseInvoice(await amazonGet(`/gp/css/summary/print.html?orderID=${o.orderId}`));
        if (inv.date) o.date = inv.date;
        if (inv.total) o.total = inv.total;
        if (inv.to) o.to = inv.to;
        if (inv.shipping) o.shipping = inv.shipping;
        if (inv.tax) o.tax = inv.tax;
        if (inv.gift) o.gift = inv.gift;
        if (inv.refund) o.refund = inv.refund;
        if (inv.shippingRefund) o.shippingRefund = inv.shippingRefund;
        if (inv.payments) o.payments = inv.payments;
        if (inv.paymentsList) o.paymentsList = inv.paymentsList;
        o.items = mergeItems(inv.items, o.items);
        o.invoiced = true;
      } catch (_) {}
    }
    const needDetails = !(o.items && o.items.length) || format === "shipments";
    if (needDetails) {
      try {
        const det = await amazonGet(`/gp/your-account/order-details?orderID=${o.orderId}&disableCsd=no-js`);
        o.items = mergeItems(o.items, extractTitles(det));
        if (!o.to) {
          const toM = det.match(/displayAddressFullName">([^<]+)/i);
          if (toM) o.to = stripTags(toM[1]);
        }
        await attachShipments(o, det);
      } catch (_) {
        o.shipments = Array.isArray(o.shipments) ? o.shipments : [];
        o.shipmentsChecked = true;
      }
    }
    await sleep(220);
  }
  if (cacheHits) progress(`${label}: reused ${cacheHits} saved invoices`);
  return collected;
}

function toRows(all, format) {
  if (format === "items") {
    const headers = ["date", "order id", "item", "quantity", "asin", "price", "order total", "to", "tax", "shipping", "url"];
    const rows = [];
    for (const o of all) {
      const url = `${currentOrigin}/your-orders/order-details?orderID=${o.orderId}`;
      if (o.items && o.items.length) {
        for (const it of o.items) {
          rows.push({
            date: o.date,
            "order id": o.orderId,
            item: it.item,
            quantity: it.qty || "",
            asin: it.asin || "",
            price: it.amount,
            "order total": o.total,
            to: o.to,
            tax: o.tax,
            shipping: o.shipping,
            url,
          });
        }
      } else {
        rows.push({
          date: o.date, "order id": o.orderId, item: "", quantity: "", asin: "",
          price: "", "order total": o.total, to: o.to, tax: o.tax, shipping: o.shipping, url,
        });
      }
    }
    return { headers, rows };
  }
  if (format === "payments") {
    const headers = ["date", "order id", "method", "last4", "amount", "order total", "url"];
    const rows = [];
    for (const o of all) {
      const url = `${currentOrigin}/your-orders/order-details?orderID=${o.orderId}`;
      const list = (o.paymentsList && o.paymentsList.length) ? o.paymentsList : [{ method: "", last4: "", date: o.date, amount: o.total }];
      for (const p of list) {
        rows.push({
          date: p.date || o.date,
          "order id": o.orderId,
          method: p.method || "",
          last4: p.last4 || "",
          amount: p.amount || o.total || "",
          "order total": o.total,
          url,
        });
      }
    }
    return { headers, rows };
  }
  if (format === "shipments") {
    const headers = ["date", "order id", "shipment id", "delivered", "status", "tracking id", "tracking link", "items", "to", "url"];
    const rows = [];
    for (const o of all) {
      const url = `${currentOrigin}/your-orders/order-details?orderID=${o.orderId}`;
      const list = (o.shipments && o.shipments.length) ? o.shipments : [];
      for (const sh of list) {
        if (!sh.shipmentId && !sh.trackingLink && !sh.trackingId) continue;
        const shipItems = sh.items && sh.items.length ? sh.items : (o.items || []);
        rows.push({
          date: o.date,
          "order id": o.orderId,
          "shipment id": sh.shipmentId || "",
          delivered: sh.delivered || "",
          status: sh.status || "",
          "tracking id": sh.trackingId || "",
          "tracking link": sh.trackingLink || "",
          items: itemsCell(shipItems),
          to: o.to,
          url,
          total: o.total,
        });
      }
    }
    return { headers, rows };
  }
  const headers = ["order id", "order url", "items", "to", "date", "total", "shipping", "shipping_refund", "gift", "tax", "refund", "payments"];
  const rows = all.map((o) => ({
    "order id": o.orderId,
    "order url": `${currentOrigin}/your-orders/order-details?orderID=${o.orderId}&ref=ppx_yo2ov_dt_b_fed_order_details`,
    items: itemsCell(o.items),
    to: o.to,
    date: o.date,
    total: o.total,
    shipping: o.shipping || "0",
    shipping_refund: o.shippingRefund,
    gift: o.gift,
    tax: o.tax,
    refund: o.refund,
    payments: o.payments,
  }));
  return { headers, rows };
}

async function collectOrders(msg, cache, useCache, format) {
  const range = msg.range || "years";
  const all = [];
  if (range === "last30") {
    all.push(...(await scrapeWindow("Last 30 days", "last30", cache, useCache, format)));
    return all;
  }
  if (range === "months-3") {
    all.push(...(await scrapeWindow("Last 3 months", "months-3", cache, useCache, format)));
    return all;
  }
  if (range === "last1" || range === "months-1" || range === "last2" || range === "months-2") {
    const win = rangeWindow(range);
    for (const y of win.years) all.push(...(await scrapeWindow(String(y), `year-${y}`, cache, useCache, format)));
    return all.filter((o) => inRange(o.date, win.fromDate, win.toDate));
  }
  if (range === "quarters") {
    const year = Number(msg.periodYear) || (Array.isArray(msg.years) && msg.years[0]) || new Date().getFullYear();
    const quarters = Array.isArray(msg.quarters) ? msg.quarters : [];
    all.push(...(await scrapeWindow(String(year), `year-${year}`, cache, useCache, format)));
    return all.filter((o) => dateMatchesQuarters(o.date, year, quarters));
  }
  if (range === "months") {
    const year = Number(msg.periodYear) || (Array.isArray(msg.years) && msg.years[0]) || new Date().getFullYear();
    const monthsSel = Array.isArray(msg.months) ? msg.months : [];
    all.push(...(await scrapeWindow(String(year), `year-${year}`, cache, useCache, format)));
    return all.filter((o) => dateMatchesMonths(o.date, year, monthsSel));
  }
  if (range === "custom") {
    const from = msg.fromDate || "";
    const to = msg.toDate || "";
    const y0 = Number((from || "2006").slice(0, 4));
    const y1 = Number((to || String(new Date().getFullYear())).slice(0, 4));
    for (let y = y1; y >= y0; y--) all.push(...(await scrapeWindow(String(y), `year-${y}`, cache, useCache, format)));
    return all.filter((o) => inRange(o.date, from, to));
  }
  const years = Array.isArray(msg.years) && msg.years.length ? msg.years : [new Date().getFullYear()];
  for (const year of years) all.push(...(await scrapeWindow(String(year), `year-${year}`, cache, useCache, format)));
  return all;
}


const ALLOWED_FORMATS = ["orders", "items", "payments", "shipments"];
const FORMAT_ROW_NOUN = { orders: "order", items: "item", payments: "payment", shipments: "shipment" };

function normalizeFormats(msg) {
  const raw = Array.isArray(msg && msg.formats) ? msg.formats : [msg && msg.format ? msg.format : "orders"];
  const seen = new Set();
  const out = [];
  for (const f of ALLOWED_FORMATS) {
    if (raw.includes(f) && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

function readyReportText(reports) {
  if (reports.length === 1) return "Ready. " + reports[0].rows.length + " rows.";
  const bits = reports.map((r) => {
    const n = r.rows.length;
    const noun = FORMAT_ROW_NOUN[r.format] || r.format;
    return n + " " + noun + " row" + (n === 1 ? "" : "s");
  });
  return "Ready. " + reports.length + " reports (" + bits.join(", ") + ").";
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "cancel") {
    cancelled = true;
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "clearCache") {
    const origin = (msg.origin || "").replace(/\/$/, "");
    chrome.storage.local.remove(cacheKey(origin || "https://www.amazon.com")).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type !== "scrape") return;
  if (scrapeRunning) {
    sendResponse({ error: "A report is already running. Stop it first or wait." });
    return;
  }
  (async () => {
    cancelled = false;
    scrapeRunning = true;
    try {
      currentOrigin = (msg.origin || "https://www.amazon.com").replace(/\/$/, "");
      const formats = normalizeFormats(msg);
      if (!formats.length) {
        sendResponse({ error: "Pick at least one report." });
        return;
      }
      const format = formats.includes("shipments") ? "shipments" : formats[0];
      const useCache = msg.useCache !== false;
      const cache = await loadCache(currentOrigin);
      const all = await collectOrders(msg, cache, useCache, format);
      if (!all.length) {
        sendResponse({ error: "No orders found. Sign in on that Amazon site in this Chrome profile, then try again." });
        return;
      }
      const nextCache = Object.assign({}, cache);
      for (const o of all) {
        const copy = Object.assign({}, o);
        delete copy.fromCache;
        delete copy.invoiceCached;
        nextCache[o.orderId] = copy;
      }
      await saveCache(currentOrigin, nextCache);
      const reports = formats.map((f) => {
        const built = toRows(all, f);
        return { format: f, headers: built.headers, rows: built.rows };
      });
      const first = reports[0];
      await chrome.storage.local.set({
        lastExport: {
          formats,
          format: formats[0],
          origin: currentOrigin,
          generatedAt: new Date().toISOString(),
          reports,
          headers: first.headers,
          rows: first.rows,
        },
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
      progress(readyReportText(reports), { current: 1, total: 1 });
      sendResponse({
        ok: true,
        rows: first.rows.length,
        orders: all.length,
        format: formats[0],
        formats,
        reports: reports.map((r) => ({ format: r.format, rows: r.rows.length })),
      });
    } catch (e) {
      progress(String(e.message || e));
      sendResponse({ error: String(e.message || e) });
    } finally {
      scrapeRunning = false;
    }
  })();
  return true;
});
