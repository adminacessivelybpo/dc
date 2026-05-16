const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(process.cwd(), "data", "store.json");

function loadStore() {
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  return JSON.parse(raw);
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function withStore(mutator) {
  const store = loadStore();
  const result = mutator(store);
  saveStore(store);
  return result;
}

function getMeta(key, fallback = null) {
  return withStore((store) => {
    const meta = store.meta || {};
    return Object.prototype.hasOwnProperty.call(meta, key) ? meta[key] : fallback;
  });
}

function setMeta(key, value) {
  return withStore((store) => {
    if (!store.meta || typeof store.meta !== "object") {
      store.meta = {};
    }

    if (typeof value === "undefined") {
      delete store.meta[key];
      return null;
    }

    store.meta[key] = value;
    return value;
  });
}

module.exports = {
  loadStore,
  withStore,
  getMeta,
  setMeta
};
