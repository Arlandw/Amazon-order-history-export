"use strict";

function createChromeStub(initial) {
  const store = Object.assign({}, initial || {});
  const messageListeners = [];
  const tabsCreated = [];
  const downloads = [];
  const sent = [];

  function resolveGet(keys) {
    if (keys == null) return Object.assign({}, store);
    if (typeof keys === "string") return { [keys]: store[keys] };
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) out[k] = store[k];
      return out;
    }
    const out = {};
    for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
    return out;
  }

  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const result = resolveGet(keys);
          if (typeof cb === "function") cb(result);
          return Promise.resolve(result);
        },
        set(obj, cb) {
          Object.assign(store, obj);
          if (typeof cb === "function") cb();
          return Promise.resolve();
        },
        remove(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k];
          if (typeof cb === "function") cb();
          return Promise.resolve();
        },
        _store: store,
      },
    },
    runtime: {
      id: "test-extension-id",
      getURL(path) {
        return "chrome-extension://test-extension-id/" + String(path).replace(/^\//, "");
      },
      sendMessage(msg, cb) {
        sent.push(msg);
        return new Promise((resolve) => {
          let settled = false;
          const sendResponse = (value) => {
            if (settled) return;
            settled = true;
            if (typeof cb === "function") cb(value);
            resolve(value);
          };
          let keep = false;
          for (const fn of messageListeners.slice()) {
            const result = fn(msg, { id: "test" }, sendResponse);
            if (result === true) keep = true;
          }
          if (!keep && !settled) {
            settled = true;
            if (typeof cb === "function") cb(undefined);
            resolve(undefined);
          }
        });
      },
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        },
        _listeners: messageListeners,
      },
    },
    tabs: {
      create(opts) {
        tabsCreated.push(opts);
        return Promise.resolve({ id: 100 + tabsCreated.length, url: opts.url });
      },
      query(opts, cb) {
        const tabs = [{ id: 1, url: "https://www.amazon.com/gp/css/order-history", active: true }];
        if (typeof cb === "function") cb(tabs);
        return Promise.resolve(tabs);
      },
    },
    downloads: {
      download(opts) {
        downloads.push(opts);
        return Promise.resolve(1);
      },
    },
    _sent: sent,
    _tabsCreated: tabsCreated,
    _downloads: downloads,
  };
  return chrome;
}

module.exports = { createChromeStub };
