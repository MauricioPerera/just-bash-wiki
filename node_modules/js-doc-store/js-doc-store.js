/**
 * js-doc-store
 * Document database en vanilla JS — zero dependencias
 * Corre en Node.js, browser, Cloudflare Workers, Deno, Bun
 *
 * Queries estilo MongoDB con indices, aggregation, y cursores.
 * Mismo patron de storage adapters que js-vector-store.
 */

// ---------------------------------------------------------------------------
// ID GENERATOR
// ---------------------------------------------------------------------------

let _idCounter = 0;
function generateId() {
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  const seq = (++_idCounter).toString(36);
  return `${ts}-${rnd}-${seq}`;
}

// ---------------------------------------------------------------------------
// MATCH FILTER (query engine)
// ---------------------------------------------------------------------------

function matchFilter(doc, filter) {
  if (!filter || typeof filter !== 'object') return true;
  if (!doc) doc = {};

  for (const key of Object.keys(filter)) {
    if (key === '$and') {
      if (!Array.isArray(filter.$and)) return false;
      for (const sub of filter.$and) { if (!matchFilter(doc, sub)) return false; }
      continue;
    }
    if (key === '$or') {
      if (!Array.isArray(filter.$or)) return false;
      let any = false;
      for (const sub of filter.$or) { if (matchFilter(doc, sub)) { any = true; break; } }
      if (!any) return false;
      continue;
    }
    if (key === '$not') {
      if (matchFilter(doc, filter.$not)) return false;
      continue;
    }

    const val  = _getNestedValue(doc, key);
    const cond = filter[key];

    if (cond === null || cond === undefined || typeof cond !== 'object' || cond instanceof RegExp) {
      if (cond instanceof RegExp) { if (!cond.test(String(val ?? ''))) return false; }
      else if (val !== cond) return false;
      continue;
    }

    for (const op of Object.keys(cond)) {
      const target = cond[op];
      switch (op) {
        case '$eq':      if (val !== target) return false; break;
        case '$ne':      if (val === target) return false; break;
        case '$gt':      if (!(val > target)) return false; break;
        case '$gte':     if (!(val >= target)) return false; break;
        case '$lt':      if (!(val < target)) return false; break;
        case '$lte':     if (!(val <= target)) return false; break;
        case '$in':      if (!Array.isArray(target) || !target.includes(val)) return false; break;
        case '$nin':     if (Array.isArray(target) && target.includes(val)) return false; break;
        case '$exists':  if ((val !== undefined) !== target) return false; break;
        case '$regex': {
          const re = typeof target === 'string' ? new RegExp(target) : target;
          if (!re.test(String(val ?? ''))) return false;
          break;
        }
        case '$contains': {
          if (!Array.isArray(val) || !val.includes(target)) return false;
          break;
        }
        case '$size': {
          if (!Array.isArray(val) || val.length !== target) return false;
          break;
        }
        case '$not': {
          // Field-level $not: negate the result of evaluating the nested operators
          // e.g. {"stock": {"$not": {"$eq": 0}}} → match docs where stock != 0
          if (typeof target === 'object' && target !== null) {
            const subFilter = { [key]: target };
            if (matchFilter(doc, subFilter)) return false;
          }
          break;
        }
        default: break;
      }
    }
  }
  return true;
}

/** Accede a valores anidados con dot notation: 'address.city' */
function _getNestedValue(obj, path) {
  if (!path.includes('.')) return obj[path];
  const parts = path.split('.');
  let current = obj;
  for (const p of parts) {
    if (current == null) return undefined;
    current = current[p];
  }
  return current;
}

function _setNestedValue(obj, path, value) {
  if (!path.includes('.')) { obj[path] = value; return; }
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function _deleteNestedValue(obj, path) {
  if (!path.includes('.')) { delete obj[path]; return; }
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) return;
    current = current[parts[i]];
  }
  delete current[parts[parts.length - 1]];
}

// ---------------------------------------------------------------------------
// UPDATE OPERATORS
// ---------------------------------------------------------------------------

function applyUpdate(doc, update) {
  const result = JSON.parse(JSON.stringify(doc)); // deep clone

  for (const op of Object.keys(update)) {
    const fields = update[op];

    switch (op) {
      case '$set':
        for (const [k, v] of Object.entries(fields)) _setNestedValue(result, k, v);
        break;

      case '$unset':
        for (const k of Object.keys(fields)) _deleteNestedValue(result, k);
        break;

      case '$inc':
        for (const [k, v] of Object.entries(fields)) {
          const cur = _getNestedValue(result, k) || 0;
          _setNestedValue(result, k, cur + v);
        }
        break;

      case '$push':
        for (const [k, v] of Object.entries(fields)) {
          const arr = _getNestedValue(result, k);
          if (Array.isArray(arr)) arr.push(v);
          else _setNestedValue(result, k, [v]);
        }
        break;

      case '$pull':
        for (const [k, v] of Object.entries(fields)) {
          const arr = _getNestedValue(result, k);
          if (Array.isArray(arr)) {
            const idx = arr.indexOf(v);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }
        break;

      case '$rename':
        for (const [oldKey, newKey] of Object.entries(fields)) {
          const val = _getNestedValue(result, oldKey);
          if (val !== undefined) {
            _setNestedValue(result, newKey, val);
            _deleteNestedValue(result, oldKey);
          }
        }
        break;

      default:
        // Si no tiene operador, tratar como reemplazo completo (excepto _id)
        if (!op.startsWith('$')) {
          const id = result._id;
          Object.assign(result, update);
          result._id = id;
          return result;
        }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// STORAGE ADAPTERS
// ---------------------------------------------------------------------------

let _fs = null;
let _path = null;

function _getFs() {
  if (!_fs) {
    try {
      _fs   = require('fs');
      _path = require('path');
    } catch {
      throw new Error('DocStore: entorno sin fs — usa un StorageAdapter personalizado');
    }
  }
  return { fs: _fs, path: _path };
}

class FileStorageAdapter {
  constructor(dir) {
    const { fs, path } = _getFs();
    this.dir = dir; this.fs = fs; this.path = path;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  readJson(filename) {
    const file = this.path.join(this.dir, filename);
    if (!this.fs.existsSync(file)) return null;
    return JSON.parse(this.fs.readFileSync(file, 'utf8'));
  }
  writeJson(filename, data) {
    const file = this.path.join(this.dir, filename);
    this.fs.writeFileSync(file, JSON.stringify(data));
  }
  delete(filename) {
    const file = this.path.join(this.dir, filename);
    if (this.fs.existsSync(file)) this.fs.unlinkSync(file);
  }
}

class MemoryStorageAdapter {
  constructor() { this._data = new Map(); }
  readJson(k)      { return this._data.get(k) ?? null; }
  writeJson(k, v)  { this._data.set(k, v); }
  delete(k)        { this._data.delete(k); }
}

class CloudflareKVAdapter {
  constructor(kv, prefix = '') {
    this.kv = kv; this.prefix = prefix; this._cache = new Map();
  }
  _key(f) { return this.prefix + f; }
  async preload(filenames) {
    const promises = filenames.map(async (f) => {
      const val = await this.kv.get(this._key(f), 'json');
      if (val) this._cache.set(f, val);
    });
    await Promise.all(promises);
  }
  readJson(f)     { return this._cache.get(f) ?? null; }
  writeJson(f, v) { this._cache.set(f, v); }
  delete(f)       { this._cache.delete(f); }
  async persist() {
    const promises = [];
    for (const [f, v] of this._cache) {
      promises.push(this.kv.put(this._key(f), JSON.stringify(v)));
    }
    await Promise.all(promises);
  }
  async deleteFromKV(f) {
    this._cache.delete(f);
    await this.kv.delete(this._key(f));
  }
}

// ---------------------------------------------------------------------------
// HASH INDEX
// ---------------------------------------------------------------------------

class HashIndex {
  constructor(field, opts = {}) {
    this.field  = field;
    this.unique = !!opts.unique;
    this._map   = new Map(); // value → Set<_id>
  }

  add(doc) {
    const val = _getNestedValue(doc, this.field);
    if (val === undefined) return;
    const key = String(val);

    if (this.unique && this._map.has(key)) {
      const existing = this._map.get(key);
      if (existing.size > 0 && !existing.has(doc._id)) {
        throw new Error(`Unique constraint violated: ${this.field} = "${val}"`);
      }
    }

    if (!this._map.has(key)) this._map.set(key, new Set());
    this._map.get(key).add(doc._id);
  }

  remove(doc) {
    const val = _getNestedValue(doc, this.field);
    if (val === undefined) return;
    const key = String(val);
    const set = this._map.get(key);
    if (set) {
      set.delete(doc._id);
      if (set.size === 0) this._map.delete(key);
    }
  }

  lookup(value) {
    const set = this._map.get(String(value));
    return set ? Array.from(set) : [];
  }

  has(value) {
    const set = this._map.get(String(value));
    return set ? set.size > 0 : false;
  }

  clear() { this._map.clear(); }

  rebuild(docs) {
    this._map.clear();
    for (const doc of docs) this.add(doc);
  }

  exportState() {
    const obj = {};
    for (const [k, v] of this._map) obj[k] = Array.from(v);
    return { field: this.field, unique: this.unique, data: obj };
  }

  importState(state) {
    this._map.clear();
    for (const [k, ids] of Object.entries(state.data)) {
      this._map.set(k, new Set(ids));
    }
  }
}

// ---------------------------------------------------------------------------
// SORTED INDEX
// ---------------------------------------------------------------------------

class SortedIndex {
  constructor(field) {
    this.field   = field;
    this._entries = []; // sorted array of { value, _id }
  }

  add(doc) {
    const val = _getNestedValue(doc, this.field);
    if (val === undefined) return;
    const entry = { value: val, _id: doc._id };
    // Binary search insert
    let lo = 0, hi = this._entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._entries[mid].value < val) lo = mid + 1;
      else hi = mid;
    }
    this._entries.splice(lo, 0, entry);
  }

  remove(doc) {
    const val = _getNestedValue(doc, this.field);
    if (val === undefined) return;
    // Find and remove
    for (let i = 0; i < this._entries.length; i++) {
      if (this._entries[i]._id === doc._id && this._entries[i].value === val) {
        this._entries.splice(i, 1);
        return;
      }
    }
  }

  /** Range query: retorna _ids donde value esta en [min, max]. */
  range(min, max, opts = {}) {
    const excludeMin = !!opts.excludeMin;
    const excludeMax = !!opts.excludeMax;

    // Binary search for start
    let lo = 0, hi = this._entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (excludeMin ? this._entries[mid].value <= min : this._entries[mid].value < min) lo = mid + 1;
      else hi = mid;
    }

    const ids = [];
    for (let i = lo; i < this._entries.length; i++) {
      const v = this._entries[i].value;
      if (excludeMax ? v >= max : v > max) break;
      ids.push(this._entries[i]._id);
    }
    return ids;
  }

  /** Retorna todos los _ids ordenados. asc=true ascendente. */
  all(asc = true) {
    if (asc) return this._entries.map(e => e._id);
    return this._entries.slice().reverse().map(e => e._id);
  }

  clear() { this._entries = []; }

  rebuild(docs) {
    this._entries = [];
    for (const doc of docs) this.add(doc);
  }

  exportState() {
    return { field: this.field, entries: this._entries };
  }

  importState(state) {
    this._entries = state.entries || [];
  }
}

// ---------------------------------------------------------------------------
// CURSOR (lazy query builder)
// ---------------------------------------------------------------------------

/** Fast clone — structuredClone if available, fallback to JSON round-trip. */
const _clone = typeof structuredClone === 'function'
  ? (obj) => structuredClone(obj)
  : (obj) => JSON.parse(JSON.stringify(obj));

class Cursor {
  constructor(collection, filter) {
    this._col    = collection;
    this._filter = filter;
    this._sort   = null;
    this._skip   = 0;
    this._limit  = 0;
    this._proj   = null;
  }

  sort(spec)    { this._sort  = spec; return this; }
  skip(n)       { this._skip  = n;    return this; }
  limit(n)      { this._limit = n;    return this; }
  project(spec) { this._proj  = spec; return this; }

  toArray() {
    // OPT: Try SortedIndex-driven scan when sorting on a single indexed field
    let docs;
    if (this._sort && !this._proj) {
      const sortFields = Object.entries(this._sort);
      if (sortFields.length === 1) {
        const [sortField, sortDir] = sortFields[0];
        const index = this._col._indexes.get(sortField);
        if (index instanceof SortedIndex) {
          // Use index order — avoids in-memory sort entirely
          const orderedIds = index.all(sortDir > 0);
          docs = [];
          for (const id of orderedIds) {
            const doc = this._col._docs.get(id);
            if (doc && matchFilter(doc, this._filter)) docs.push(doc);
          }
          // Skip + Limit (before clone for perf)
          if (this._skip > 0) docs = docs.slice(this._skip);
          if (this._limit > 0) docs = docs.slice(0, this._limit);
          return docs.map(_clone);
        }
      }
    }

    // Standard path: find + sort in memory (raw refs, no clone yet)
    docs = this._col._findRaw(this._filter);

    if (this._sort) {
      const fields = Object.entries(this._sort);
      docs.sort((a, b) => {
        for (const [field, dir] of fields) {
          const va = _getNestedValue(a, field);
          const vb = _getNestedValue(b, field);
          if (va < vb) return -dir;
          if (va > vb) return dir;
        }
        return 0;
      });
    }

    // OPT: skip + limit BEFORE clone — only clone what we return
    if (this._skip > 0) docs = docs.slice(this._skip);
    if (this._limit > 0) docs = docs.slice(0, this._limit);

    // Project (clone inside)
    if (this._proj) {
      const includeMode = Object.values(this._proj).some(v => v === 1);
      return docs.map(doc => {
        if (includeMode) {
          const result = { _id: doc._id };
          for (const [k, v] of Object.entries(this._proj)) {
            if (v === 1) {
              const val = _getNestedValue(doc, k);
              result[k] = typeof val === 'object' && val !== null ? _clone(val) : val;
            }
          }
          return result;
        } else {
          const cloned = _clone(doc);
          for (const [k, v] of Object.entries(this._proj)) {
            if (v === 0) delete cloned[k];
          }
          return cloned;
        }
      });
    }

    // Clone only the final slice
    return docs.map(_clone);
  }

  first() {
    // OPT: early exit — don't find all, stop at first match
    const doc = this._col._findOneRaw(this._filter);
    return doc ? _clone(doc) : null;
  }

  count() {
    return this._col._countMatching(this._filter);
  }

  forEach(fn) {
    this.toArray().forEach(fn);
  }

  map(fn) {
    return this.toArray().map(fn);
  }
}

// ---------------------------------------------------------------------------
// AGGREGATION PIPELINE
// ---------------------------------------------------------------------------

class AggregationPipeline {
  constructor(collection) {
    this._col    = collection;
    this._stages = [];
  }

  match(filter) {
    this._stages.push({ type: 'match', filter });
    return this;
  }

  group(field, accumulators) {
    this._stages.push({ type: 'group', field, accumulators });
    return this;
  }

  sort(spec) {
    this._stages.push({ type: 'sort', spec });
    return this;
  }

  limit(n) {
    this._stages.push({ type: 'limit', n });
    return this;
  }

  skip(n) {
    this._stages.push({ type: 'skip', n });
    return this;
  }

  project(spec) {
    this._stages.push({ type: 'project', spec });
    return this;
  }

  unwind(field) {
    this._stages.push({ type: 'unwind', field });
    return this;
  }

  /**
   * Lookup: join con otra coleccion (equivalente a SQL LEFT JOIN / MongoDB $lookup).
   *
   * @param {object} opts
   * @param {string} opts.from         Nombre de la coleccion a unir
   * @param {string} opts.localField   Campo en los docs actuales
   * @param {string} opts.foreignField Campo en la coleccion foreign
   * @param {string} opts.as           Nombre del campo donde poner los resultados
   * @param {object} [opts.filter]     Filtro adicional sobre los docs foreign
   * @param {boolean} [opts.single]    Si true, pone un objeto en vez de array (como INNER JOIN first match)
   *
   * Ejemplo:
   *   orders.aggregate()
   *     .lookup({ from: 'users', localField: 'userId', foreignField: '_id', as: 'user', single: true })
   *     .toArray();
   *   // Cada order tendra order.user = { _id, name, email, ... }
   */
  lookup(opts) {
    this._stages.push({ type: 'lookup', ...opts });
    return this;
  }

  toArray() {
    let docs = this._col._findDocs({});

    for (const stage of this._stages) {
      switch (stage.type) {
        case 'match':
          docs = docs.filter(d => matchFilter(d, stage.filter));
          break;

        case 'group': {
          const groups = new Map();
          for (const doc of docs) {
            const key = stage.field ? String(_getNestedValue(doc, stage.field) ?? '_null') : '_all';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(doc);
          }

          docs = [];
          for (const [key, groupDocs] of groups) {
            const result = { _id: key };
            for (const [accName, accDef] of Object.entries(stage.accumulators)) {
              if (accDef.$count) {
                result[accName] = groupDocs.length;
              } else if (accDef.$sum) {
                result[accName] = groupDocs.reduce((s, d) => s + (Number(_getNestedValue(d, accDef.$sum)) || 0), 0);
              } else if (accDef.$avg) {
                const vals = groupDocs.map(d => Number(_getNestedValue(d, accDef.$avg)) || 0);
                result[accName] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
              } else if (accDef.$min) {
                result[accName] = Math.min(...groupDocs.map(d => Number(_getNestedValue(d, accDef.$min)) || Infinity));
              } else if (accDef.$max) {
                result[accName] = Math.max(...groupDocs.map(d => Number(_getNestedValue(d, accDef.$max)) || -Infinity));
              } else if (accDef.$push) {
                result[accName] = groupDocs.map(d => _getNestedValue(d, accDef.$push));
              } else if (accDef.$first) {
                result[accName] = _getNestedValue(groupDocs[0], accDef.$first);
              } else if (accDef.$last) {
                result[accName] = _getNestedValue(groupDocs[groupDocs.length - 1], accDef.$last);
              }
            }
            docs.push(result);
          }
          break;
        }

        case 'sort': {
          const fields = Object.entries(stage.spec);
          docs.sort((a, b) => {
            for (const [field, dir] of fields) {
              const va = _getNestedValue(a, field);
              const vb = _getNestedValue(b, field);
              if (va < vb) return -dir;
              if (va > vb) return dir;
            }
            return 0;
          });
          break;
        }

        case 'limit':
          docs = docs.slice(0, stage.n);
          break;

        case 'skip':
          docs = docs.slice(stage.n);
          break;

        case 'project': {
          const includeMode = Object.values(stage.spec).some(v => v === 1);
          docs = docs.map(doc => {
            const result = { _id: doc._id };
            if (includeMode) {
              for (const [k, v] of Object.entries(stage.spec)) {
                if (v === 1) result[k] = _getNestedValue(doc, k);
              }
            } else {
              Object.assign(result, JSON.parse(JSON.stringify(doc)));
              for (const [k, v] of Object.entries(stage.spec)) {
                if (v === 0) delete result[k];
              }
            }
            return result;
          });
          break;
        }

        case 'unwind': {
          const newDocs = [];
          for (const doc of docs) {
            const arr = _getNestedValue(doc, stage.field);
            if (Array.isArray(arr)) {
              for (const item of arr) {
                const copy = JSON.parse(JSON.stringify(doc));
                _setNestedValue(copy, stage.field, item);
                newDocs.push(copy);
              }
            } else {
              newDocs.push(doc);
            }
          }
          docs = newDocs;
          break;
        }

        case 'lookup': {
          const store = this._col._store;
          if (!store) throw new Error('lookup requires DocStore reference (use db.collection())');
          const foreignCol = store.collection(stage.from);
          foreignCol._ensureLoaded();

          // Pre-build index de foreign docs por foreignField para O(1) lookup
          const foreignIdx = new Map(); // value → [doc, ...]
          for (const fDoc of foreignCol._docs.values()) {
            const fVal = _getNestedValue(fDoc, stage.foreignField);
            if (fVal === undefined) continue;
            const key = String(fVal);
            if (!foreignIdx.has(key)) foreignIdx.set(key, []);
            foreignIdx.get(key).push(fDoc);
          }

          for (const doc of docs) {
            const localVal = _getNestedValue(doc, stage.localField);
            if (localVal === undefined) { doc[stage.as] = stage.single ? null : []; continue; }

            let matches = foreignIdx.get(String(localVal)) || [];

            // Filtro adicional
            if (stage.filter) {
              matches = matches.filter(m => matchFilter(m, stage.filter));
            }

            // Deep copy
            const copied = matches.map(m => JSON.parse(JSON.stringify(m)));

            doc[stage.as] = stage.single ? (copied[0] || null) : copied;
          }
          break;
        }
      }
    }

    return docs;
  }
}

// ---------------------------------------------------------------------------
// COLLECTION
// ---------------------------------------------------------------------------

class Collection {
  constructor(name, adapter, store = null) {
    this.name     = name;
    this._adapter = adapter;
    this._store   = store;  // referencia al DocStore padre (para lookups)
    this._docs    = null;   // Map<_id, doc>
    this._indexes = new Map(); // fieldName → HashIndex | SortedIndex
    this._indexDefs = [];   // [{ field, type, unique }]
    this._dirty   = false;
    this._dirtyIds = new Set(); // OPT-3: track modified doc IDs
    this._loaded  = false;
  }

  _dataFile()  { return `${this.name}.docs.json`; }
  _metaFile()  { return `${this.name}.meta.json`; }
  _indexFile(field, type) { return `${this.name}.${field}.${type === 'sorted' ? 'sidx' : 'idx'}.json`; }

  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;

    // Load documents
    const data = this._adapter.readJson(this._dataFile());
    this._docs = new Map();
    if (Array.isArray(data)) {
      for (const doc of data) {
        if (doc && doc._id) this._docs.set(doc._id, doc);
      }
    }

    // Load metadata (index definitions)
    const meta = this._adapter.readJson(this._metaFile());
    if (meta && Array.isArray(meta.indexes)) {
      this._indexDefs = meta.indexes;
      for (const def of meta.indexes) {
        this._createIndexInternal(def.field, def.type || 'hash', !!def.unique, false);
      }
    }
  }

  // ── Index management ─────────────────────────────────────

  createIndex(field, opts = {}) {
    this._ensureLoaded();
    const type   = opts.type || 'hash';
    const unique = !!opts.unique;

    if (this._indexes.has(field)) {
      throw new Error(`Index already exists on field: ${field}`);
    }

    this._createIndexInternal(field, type, unique, true);

    // Save def
    this._indexDefs.push({ field, type, unique });
    this._dirty = true;
  }

  _createIndexInternal(field, type, unique, rebuild) {
    let index;
    if (type === 'sorted') {
      index = new SortedIndex(field);
    } else {
      index = new HashIndex(field, { unique });
    }

    // Try load from persisted state
    const state = this._adapter.readJson(this._indexFile(field, type));
    if (state && !rebuild) {
      index.importState(state);
    } else if (this._docs && this._docs.size > 0) {
      index.rebuild(Array.from(this._docs.values()));
    }

    this._indexes.set(field, index);
  }

  dropIndex(field) {
    this._ensureLoaded();
    const index = this._indexes.get(field);
    if (!index) return;
    this._indexes.delete(field);
    this._indexDefs = this._indexDefs.filter(d => d.field !== field);
    const type = index instanceof SortedIndex ? 'sorted' : 'hash';
    this._adapter.delete(this._indexFile(field, type));
    this._dirty = true;
  }

  getIndexes() {
    this._ensureLoaded();
    return this._indexDefs.slice();
  }

  // ── CRUD ─────────────────────────────────────────────────

  insert(doc) {
    this._ensureLoaded();
    const newDoc = _clone(doc);
    if (!newDoc._id) newDoc._id = generateId();
    if (this._docs.has(newDoc._id)) {
      throw new Error(`Duplicate _id: ${newDoc._id}`);
    }

    // Check unique indexes before inserting
    for (const [, index] of this._indexes) {
      if (index instanceof HashIndex && index.unique) {
        const val = _getNestedValue(newDoc, index.field);
        if (val !== undefined && index.has(val)) {
          throw new Error(`Unique constraint violated: ${index.field} = "${val}"`);
        }
      }
    }

    this._docs.set(newDoc._id, newDoc);
    for (const [, index] of this._indexes) index.add(newDoc);
    this._dirty = true;
    this._dirtyIds.add(newDoc._id);
    return _clone(newDoc);
  }

  insertMany(docs) {
    const results = [];
    for (const doc of docs) results.push(this.insert(doc));
    return results;
  }

  findById(id) {
    this._ensureLoaded();
    const doc = this._docs.get(id);
    return doc ? _clone(doc) : null;
  }

  findOne(filter) {
    this._ensureLoaded();
    const doc = this._findOneRaw(filter);
    return doc ? _clone(doc) : null;
  }

  find(filter = {}) {
    this._ensureLoaded();
    return new Cursor(this, filter);
  }

  /** Internal: retorna primer doc raw (sin clone) que matchea. */
  _findOneRaw(filter) {
    const indexResult = this._tryIndexLookup(filter);
    if (indexResult !== null) {
      for (const id of indexResult) {
        const doc = this._docs.get(id);
        if (doc && matchFilter(doc, filter)) return doc;
      }
      return null;
    }
    for (const doc of this._docs.values()) {
      if (matchFilter(doc, filter)) return doc;
    }
    return null;
  }

  /** Internal: retorna docs raw (sin clone) que matchean. Usado por Cursor. */
  _findRaw(filter) {
    this._ensureLoaded();
    const indexResult = this._tryIndexLookup(filter);
    if (indexResult !== null) {
      const docs = [];
      for (const id of indexResult) {
        const doc = this._docs.get(id);
        if (doc && matchFilter(doc, filter)) docs.push(doc);
      }
      return docs;
    }
    const docs = [];
    for (const doc of this._docs.values()) {
      if (matchFilter(doc, filter)) docs.push(doc);
    }
    return docs;
  }

  /** Internal: cuenta docs sin allocar array. */
  _countMatching(filter) {
    this._ensureLoaded();
    if (!filter || Object.keys(filter).length === 0) return this._docs.size;
    const indexResult = this._tryIndexLookup(filter);
    if (indexResult !== null) {
      let count = 0;
      for (const id of indexResult) {
        const doc = this._docs.get(id);
        if (doc && matchFilter(doc, filter)) count++;
      }
      return count;
    }
    let count = 0;
    for (const doc of this._docs.values()) {
      if (matchFilter(doc, filter)) count++;
    }
    return count;
  }

  /** Backward compat: cloned version of _findRaw. */
  _findDocs(filter) {
    return this._findRaw(filter).map(_clone);
  }

  /** Intenta usar un indice para acelerar el filtro. Retorna null si no puede. */
  _tryIndexLookup(filter) {
    if (!filter || typeof filter !== 'object') return null;

    for (const [field, cond] of Object.entries(filter)) {
      if (field.startsWith('$')) continue;
      const index = this._indexes.get(field);
      if (!index) continue;

      // Hash index: igualdad directa
      if (index instanceof HashIndex) {
        if (cond === null || typeof cond !== 'object') {
          return index.lookup(cond);
        }
        if (cond.$eq !== undefined) return index.lookup(cond.$eq);
        if (cond.$in && Array.isArray(cond.$in)) {
          const ids = [];
          for (const v of cond.$in) ids.push(...index.lookup(v));
          return ids;
        }
      }

      // Sorted index: range queries
      if (index instanceof SortedIndex) {
        let min = -Infinity, max = Infinity;
        let excludeMin = false, excludeMax = false;

        if (typeof cond === 'object' && cond !== null) {
          if (cond.$gte !== undefined) { min = cond.$gte; excludeMin = false; }
          if (cond.$gt  !== undefined) { min = cond.$gt;  excludeMin = true; }
          if (cond.$lte !== undefined) { max = cond.$lte; excludeMax = false; }
          if (cond.$lt  !== undefined) { max = cond.$lt;  excludeMax = true; }

          if (min !== -Infinity || max !== Infinity) {
            return index.range(min, max, { excludeMin, excludeMax });
          }
        }

        // Equality on sorted index
        if (cond === null || typeof cond !== 'object') {
          return index.range(cond, cond);
        }
        if (cond.$eq !== undefined) return index.range(cond.$eq, cond.$eq);
      }
    }

    return null;
  }

  update(filter, update) {
    this._ensureLoaded();
    const doc = this._findOneRaw(filter);
    if (!doc) return 0;
    return this._updateDoc(doc._id, update);
  }

  updateMany(filter, update) {
    this._ensureLoaded();
    const docs = this._findRaw(filter);
    let count = 0;
    for (const doc of docs) {
      count += this._updateDoc(doc._id, update);
    }
    return count;
  }

  _updateDoc(id, update) {
    const oldDoc = this._docs.get(id);
    if (!oldDoc) return 0;

    const newDoc = applyUpdate(oldDoc, update);
    newDoc._id = id;

    for (const [, index] of this._indexes) index.remove(oldDoc);

    for (const [, index] of this._indexes) {
      if (index instanceof HashIndex && index.unique) {
        const val = _getNestedValue(newDoc, index.field);
        if (val !== undefined && index.has(val)) {
          for (const [, idx] of this._indexes) idx.add(oldDoc);
          throw new Error(`Unique constraint violated: ${index.field} = "${val}"`);
        }
      }
    }

    this._docs.set(id, newDoc);
    for (const [, index] of this._indexes) index.add(newDoc);
    this._dirty = true;
    this._dirtyIds.add(id);
    return 1;
  }

  remove(filter) {
    this._ensureLoaded();
    const doc = this._findOneRaw(filter);
    if (!doc) return 0;
    return this._removeDoc(doc._id);
  }

  removeMany(filter) {
    this._ensureLoaded();
    const docs = this._findRaw(filter);
    let count = 0;
    for (const doc of docs) count += this._removeDoc(doc._id);
    return count;
  }

  removeById(id) {
    this._ensureLoaded();
    return this._removeDoc(id);
  }

  _removeDoc(id) {
    const doc = this._docs.get(id);
    if (!doc) return 0;
    for (const [, index] of this._indexes) index.remove(doc);
    this._docs.delete(id);
    this._dirty = true;
    this._dirtyIds.add(id); // track deletion
    return 1;
  }

  count(filter) {
    this._ensureLoaded();
    return this._countMatching(filter || {});
  }

  // ── Aggregation ──────────────────────────────────────────

  aggregate() {
    this._ensureLoaded();
    return new AggregationPipeline(this);
  }

  // ── Persistence ──────────────────────────────────────────

  flush() {
    if (!this._dirty || !this._loaded) return;

    // Save documents
    const docs = Array.from(this._docs.values());
    this._adapter.writeJson(this._dataFile(), docs);

    // Save metadata
    this._adapter.writeJson(this._metaFile(), { indexes: this._indexDefs });

    // Save indexes (only if docs changed)
    if (this._dirtyIds.size > 0) {
      for (const [field, index] of this._indexes) {
        const type = index instanceof SortedIndex ? 'sorted' : 'hash';
        this._adapter.writeJson(this._indexFile(field, type), index.exportState());
      }
    }

    this._dirty = false;
    this._dirtyIds.clear();
  }

  clear() {
    this._ensureLoaded();
    this._docs.clear();
    for (const [, index] of this._indexes) index.clear();
    this._dirty = true;
    this._dirtyIds.clear();
  }

  /** Exporta todos los documentos como array. */
  export() {
    this._ensureLoaded();
    return Array.from(this._docs.values()).map(_clone);
  }

  /** Importa documentos (merge). */
  import(docs) {
    let count = 0;
    for (const doc of docs) {
      try {
        this.insert(doc);
        count++;
      } catch {
        // Skip duplicates
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// DOC STORE (main entry point)
// ---------------------------------------------------------------------------

class DocStore {
  constructor(dirOrAdapter) {
    this._adapter = typeof dirOrAdapter === 'string'
      ? new FileStorageAdapter(dirOrAdapter)
      : dirOrAdapter;
    this._collections = new Map();
  }

  collection(name) {
    if (!this._collections.has(name)) {
      this._collections.set(name, new Collection(name, this._adapter, this));
    }
    return this._collections.get(name);
  }

  drop(name) {
    const col = this._collections.get(name);
    if (col) {
      col._ensureLoaded();
      // Delete all files
      this._adapter.delete(col._dataFile());
      this._adapter.delete(col._metaFile());
      for (const [field, index] of col._indexes) {
        const type = index instanceof SortedIndex ? 'sorted' : 'hash';
        this._adapter.delete(col._indexFile(field, type));
      }
    }
    this._collections.delete(name);
  }

  collections() {
    return Array.from(this._collections.keys());
  }

  flush() {
    for (const [, col] of this._collections) col.flush();
  }
}

// ---------------------------------------------------------------------------
// SCHEMA (column types + validation + templates)
// ---------------------------------------------------------------------------
// Define colecciones con columnas tipadas, validacion, defaults, y opciones.
// Uso:
//   const table = new Table(db, 'contacts', {
//     columns: [
//       { name: 'Name', type: 'text', required: true },
//       { name: 'Email', type: 'email', unique: true },
//       { name: 'Status', type: 'select', options: ['Lead', 'Active'] },
//     ]
//   });

const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const _URL_RE   = /^https?:\/\/.+/;
const _PHONE_RE = /^[\d\s\+\-\(\)\.]+$/;

const COLUMN_VALIDATORS = {
  text:        (v) => typeof v === 'string',
  number:      (v) => typeof v === 'number' && !isNaN(v),
  checkbox:    (v) => typeof v === 'boolean',
  date:        (v) => typeof v === 'string' || typeof v === 'number' || v instanceof Date,
  email:       (v) => typeof v === 'string' && _EMAIL_RE.test(v),
  url:         (v) => typeof v === 'string' && _URL_RE.test(v),
  phone:       (v) => typeof v === 'string' && _PHONE_RE.test(v),
  select:      (v, col) => col.options ? col.options.includes(v) : typeof v === 'string',
  multiselect: (v, col) => Array.isArray(v) && (!col.options || v.every(x => col.options.includes(x))),
  relation:    (v) => typeof v === 'string', // _id de otro doc
  json:        (_v) => true, // cualquier cosa
  attachment:  (v) => typeof v === 'string' || (typeof v === 'object' && v !== null), // URL o metadata
  formula:     (_v) => true, // computed, no se valida en insert
  autonumber:  (_v) => true, // auto-generated
};

class Table {
  /**
   * @param {DocStore} db
   * @param {string} name
   * @param {object} schema
   * @param {Array<{name, type, required?, unique?, options?, default?, collection?}>} schema.columns
   */
  constructor(db, name, schema = {}) {
    this.db       = db;
    this.name     = name;
    this.columns  = schema.columns || [];
    this._col     = db.collection(name);
    this._views   = new Map();
    this._autoNum = 0;

    // Build column map for fast lookup
    this._colMap = new Map();
    for (const col of this.columns) {
      this._colMap.set(col.name, col);
    }

    // Create indexes for unique columns
    const existingIndexes = new Set(this._col.getIndexes().map(i => i.field));
    for (const col of this.columns) {
      if (col.unique && !existingIndexes.has(col.name)) {
        this._col.createIndex(col.name, { unique: true });
      }
    }

    // Load saved views
    this._loadViews();

    // Load autonumber counter
    this._loadAutoNum();
  }

  // ── Validation ──────────────────────────────────────────

  _validate(doc, isUpdate = false) {
    const errors = [];

    for (const col of this.columns) {
      const val = doc[col.name];

      // Required check (skip on update if field not present)
      if (col.required && !isUpdate && (val === undefined || val === null || val === '')) {
        errors.push(`${col.name} is required`);
        continue;
      }

      // Skip if not present (optional field)
      if (val === undefined || val === null) continue;

      // Skip auto-generated
      if (col.type === 'autonumber' || col.type === 'formula') continue;

      // Type validation
      const validator = COLUMN_VALIDATORS[col.type];
      if (validator && !validator(val, col)) {
        errors.push(`${col.name}: invalid ${col.type} value`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join('; ')}`);
    }
  }

  _applyDefaults(doc) {
    const result = { ...doc };

    for (const col of this.columns) {
      if (result[col.name] !== undefined) continue;

      if (col.type === 'autonumber') {
        this._autoNum++;
        result[col.name] = this._autoNum;
        continue;
      }

      if (col.default !== undefined) {
        result[col.name] = typeof col.default === 'function' ? col.default() : col.default;
      }
    }

    return result;
  }

  // ── CRUD (validated) ────────────────────────────────────

  insert(doc) {
    const withDefaults = this._applyDefaults(doc);
    this._validate(withDefaults);
    return this._col.insert(withDefaults);
  }

  insertMany(docs) {
    return docs.map(d => this.insert(d));
  }

  update(filter, update) {
    // Validate $set values if present
    if (update.$set) {
      this._validate(update.$set, true);
    }
    return this._col.update(filter, update);
  }

  updateMany(filter, update) {
    if (update.$set) {
      this._validate(update.$set, true);
    }
    return this._col.updateMany(filter, update);
  }

  // Delegate read ops directly
  find(filter)     { return this._col.find(filter); }
  findOne(filter)  { return this._col.findOne(filter); }
  findById(id)     { return this._col.findById(id); }
  remove(filter)   { return this._col.remove(filter); }
  removeMany(f)    { return this._col.removeMany(f); }
  count(filter)    { return this._col.count(filter); }
  aggregate()      { return this._col.aggregate(); }
  export()         { return this._col.export(); }

  // ── Views (saved queries) ──────────────────────────────

  /**
   * Crea una vista con nombre (query guardada).
   * @param {string} viewName
   * @param {object} opts
   * @param {object} opts.filter    Filtro
   * @param {object} [opts.sort]    Sort spec
   * @param {number} [opts.limit]   Limit
   * @param {object} [opts.project] Projection
   */
  createView(viewName, opts) {
    this._views.set(viewName, opts);
    this._saveViews();
  }

  dropView(viewName) {
    this._views.delete(viewName);
    this._saveViews();
  }

  listViews() {
    return Array.from(this._views.keys());
  }

  getView(viewName) {
    return this._views.get(viewName) || null;
  }

  /**
   * Ejecuta una vista.
   * @returns {Array} Resultados
   */
  view(viewName) {
    const v = this._views.get(viewName);
    if (!v) throw new Error(`View not found: ${viewName}`);

    let cursor = this._col.find(v.filter || {});
    if (v.sort) cursor = cursor.sort(v.sort);
    if (v.skip) cursor = cursor.skip(v.skip);
    if (v.limit) cursor = cursor.limit(v.limit);
    if (v.project) cursor = cursor.project(v.project);
    return cursor.toArray();
  }

  // ── Schema info ────────────────────────────────────────

  getSchema() {
    return {
      name: this.name,
      columns: this.columns.map(c => ({ ...c })),
    };
  }

  addColumn(colDef) {
    if (this._colMap.has(colDef.name)) throw new Error(`Column exists: ${colDef.name}`);
    this.columns.push(colDef);
    this._colMap.set(colDef.name, colDef);
    if (colDef.unique) {
      try { this._col.createIndex(colDef.name, { unique: true }); } catch {}
    }
    this._saveMeta();
  }

  removeColumn(name) {
    this.columns = this.columns.filter(c => c.name !== name);
    this._colMap.delete(name);
    try { this._col.dropIndex(name); } catch {}
    this._saveMeta();
  }

  renameColumn(oldName, newName) {
    const col = this._colMap.get(oldName);
    if (!col) throw new Error(`Column not found: ${oldName}`);
    col.name = newName;
    this._colMap.delete(oldName);
    this._colMap.set(newName, col);
    // Rename field in all docs
    this._col.updateMany({}, { $rename: { [oldName]: newName } });
    this._saveMeta();
  }

  // ── Relation helpers ───────────────────────────────────

  /**
   * Expande relaciones: reemplaza IDs con docs de la coleccion relacionada.
   */
  expandRelations(doc) {
    if (!doc) return doc;
    const result = { ...doc };
    for (const col of this.columns) {
      if (col.type === 'relation' && col.collection && result[col.name]) {
        const relCol = this.db.collection(col.collection);
        result[col.name] = relCol.findById(result[col.name]);
      }
    }
    return result;
  }

  // ── Persistence helpers ─────────────────────────────────

  _saveMeta() {
    this.db._adapter.writeJson(`${this.name}.schema.json`, {
      columns: this.columns,
      autoNum: this._autoNum,
    });
  }

  _loadAutoNum() {
    const meta = this.db._adapter.readJson(`${this.name}.schema.json`);
    if (meta && meta.autoNum) this._autoNum = meta.autoNum;
  }

  _saveViews() {
    const views = {};
    for (const [name, opts] of this._views) views[name] = opts;
    this.db._adapter.writeJson(`${this.name}.views.json`, views);
  }

  _loadViews() {
    const views = this.db._adapter.readJson(`${this.name}.views.json`);
    if (views) {
      for (const [name, opts] of Object.entries(views)) {
        this._views.set(name, opts);
      }
    }
  }

  flush() {
    this._col.flush();
    this._saveMeta();
    this._saveViews();
  }
}

// ── Templates (pre-built schemas) ────────────────────────

const TEMPLATES = {
  crm: {
    columns: [
      { name: 'Name',     type: 'text',     required: true },
      { name: 'Email',    type: 'email',    unique: true },
      { name: 'Phone',    type: 'phone' },
      { name: 'Company',  type: 'text' },
      { name: 'Status',   type: 'select',   options: ['Lead', 'Qualified', 'Active', 'Churned'], default: 'Lead' },
      { name: 'Revenue',  type: 'number',   default: 0 },
      { name: 'Notes',    type: 'text' },
      { name: 'Tags',     type: 'multiselect', options: ['VIP', 'Enterprise', 'SMB', 'Partner'] },
      { name: 'CreatedAt',type: 'date',     default: () => new Date().toISOString() },
    ],
  },
  tasks: {
    columns: [
      { name: 'Title',    type: 'text',     required: true },
      { name: 'Description', type: 'text' },
      { name: 'Status',   type: 'select',   options: ['Todo', 'In Progress', 'Done', 'Blocked'], default: 'Todo' },
      { name: 'Priority', type: 'select',   options: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
      { name: 'Assignee', type: 'text' },
      { name: 'DueDate',  type: 'date' },
      { name: 'Tags',     type: 'multiselect', options: ['Bug', 'Feature', 'Docs', 'Infra'] },
      { name: 'Number',   type: 'autonumber' },
      { name: 'CreatedAt',type: 'date',     default: () => new Date().toISOString() },
    ],
  },
  inventory: {
    columns: [
      { name: 'SKU',      type: 'text',     required: true, unique: true },
      { name: 'Name',     type: 'text',     required: true },
      { name: 'Category', type: 'select',   options: ['Electronics', 'Clothing', 'Food', 'Tools', 'Other'] },
      { name: 'Price',    type: 'number',   required: true },
      { name: 'Stock',    type: 'number',   default: 0 },
      { name: 'Active',   type: 'checkbox', default: true },
      { name: 'ImageURL', type: 'url' },
      { name: 'Number',   type: 'autonumber' },
    ],
  },
  content: {
    columns: [
      { name: 'Title',    type: 'text',     required: true },
      { name: 'Body',     type: 'text' },
      { name: 'Author',   type: 'text' },
      { name: 'Status',   type: 'select',   options: ['Draft', 'Review', 'Published', 'Archived'], default: 'Draft' },
      { name: 'Category', type: 'select',   options: ['Blog', 'Tutorial', 'News', 'Docs'] },
      { name: 'Tags',     type: 'multiselect' },
      { name: 'PublishedAt', type: 'date' },
      { name: 'URL',      type: 'url' },
      { name: 'Number',   type: 'autonumber' },
      { name: 'CreatedAt',type: 'date',     default: () => new Date().toISOString() },
    ],
  },
};

/**
 * Crea una Table desde un template predefinido.
 * @param {DocStore} db
 * @param {string} name      Nombre de la coleccion
 * @param {string} template  'crm' | 'tasks' | 'inventory' | 'content'
 * @returns {Table}
 */
function createFromTemplate(db, name, template) {
  const schema = TEMPLATES[template];
  if (!schema) throw new Error(`Unknown template: ${template}. Available: ${Object.keys(TEMPLATES).join(', ')}`);
  return new Table(db, name, schema);
}

// ---------------------------------------------------------------------------
// ENCRYPTED ADAPTER (AES-256-GCM, zero deps — usa Web Crypto API)
// ---------------------------------------------------------------------------
// Wrapper sobre cualquier adapter. Encripta JSON antes de escribir,
// desencripta al leer. Compatible con Node 16+, browser, Workers, Deno.
//
// Uso:
//   const adapter = await EncryptedAdapter.create(innerAdapter, 'mi-password');
//   const db = new DocStore(adapter);

class EncryptedAdapter {
  /**
   * @param {object} inner   Adapter interno (FileStorage, Memory, KV, etc.)
   * @param {CryptoKey} key  AES-256-GCM key derivada del password
   */
  constructor(inner, key) {
    this.inner = inner;
    this._key  = key;
  }

  /**
   * Crea un EncryptedAdapter derivando una key AES-256 del password.
   * @param {object} inner    Adapter interno
   * @param {string} password Password para derivar la key
   * @param {string} [salt]   Salt (default: 'js-doc-store-v1')
   * @returns {Promise<EncryptedAdapter>}
   */
  static async create(inner, password, salt = 'js-doc-store-v1') {
    const crypto = EncryptedAdapter._getCrypto();
    const enc = new TextEncoder();

    // Derivar key con PBKDF2
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );

    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    return new EncryptedAdapter(inner, key);
  }

  static _getCrypto() {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
      return globalThis.crypto;
    }
    // Node.js < 19
    try {
      const { webcrypto } = require('crypto');
      return webcrypto;
    } catch {
      throw new Error('EncryptedAdapter: Web Crypto API not available');
    }
  }

  async _encrypt(data) {
    const crypto = EncryptedAdapter._getCrypto();
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(data));

    // Random IV (12 bytes para AES-GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this._key,
      plaintext
    );

    // Formato: [iv (12 bytes)][ciphertext]
    const result = new Uint8Array(12 + ciphertext.byteLength);
    result.set(iv);
    result.set(new Uint8Array(ciphertext), 12);

    // Encodear a base64 para almacenar como string en JSON adapters
    return _uint8ToBase64(result);
  }

  async _decrypt(encoded) {
    const crypto = EncryptedAdapter._getCrypto();
    const combined = _base64ToUint8(encoded);

    const iv         = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this._key,
      ciphertext
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plaintext));
  }

  // ── Sync interface (con cache para operaciones sync) ─────

  /**
   * Precarga y desencripta archivos a un cache interno.
   * Llamar antes de operaciones sync.
   * @param {string[]} filenames
   */
  async preload(filenames) {
    if (!this._cache) this._cache = new Map();
    for (const f of filenames) {
      const encrypted = this.inner.readJson(f);
      if (encrypted && encrypted.__enc) {
        try {
          const decrypted = await this._decrypt(encrypted.__enc);
          this._cache.set(f, decrypted);
        } catch (err) {
          // Key incorrecta o datos corruptos — mark as decrypt failure
          // so readJson can distinguish "no data" from "can't decrypt"
          this._cache.set(f, { __decryptFailed: true, file: f, error: err?.message ?? String(err) });
        }
      }
    }
  }

  readJson(filename) {
    // Si hay cache (preloaded), usar
    if (this._cache && this._cache.has(filename)) {
      const cached = this._cache.get(filename);
      if (cached && cached.__decryptFailed) {
        throw new Error(`Decryption failed for ${cached.file}: wrong key or corrupted data`);
      }
      return cached;
    }
    // Sync read: intenta leer y desencriptar (solo funciona si ya esta en cache)
    const encrypted = this.inner.readJson(filename);
    if (!encrypted) return null;
    if (!encrypted.__enc) return encrypted; // no encriptado, leer directo
    // Encrypted data but no cache — cannot decrypt synchronously
    throw new Error(`Encrypted data found in ${filename} but no decryption cache available (call preload first or check encryption key)`);
  }

  writeJson(filename, data) {
    // Marcar para encriptar en persist()
    if (!this._pending) this._pending = new Map();
    this._pending.set(filename, data);
    // Tambien actualizar cache
    if (!this._cache) this._cache = new Map();
    this._cache.set(filename, data);
  }

  delete(filename) {
    if (this._cache) this._cache.delete(filename);
    if (this._pending) this._pending.delete(filename);
    this.inner.delete(filename);
  }

  /**
   * Encripta y persiste todos los datos pendientes.
   * Llamar despues de db.flush().
   */
  async persist() {
    if (!this._pending) return;
    for (const [filename, data] of this._pending) {
      const encrypted = await this._encrypt(data);
      this.inner.writeJson(filename, { __enc: encrypted });
    }
    this._pending.clear();
  }
}

// Base64 helpers (compatible con browser + Node sin Buffer)
function _uint8ToBase64(uint8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(uint8).toString('base64');
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary);
}

function _base64ToUint8(base64) {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const uint8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);
  return uint8;
}

// ---------------------------------------------------------------------------
// FIELD-LEVEL ENCRYPTION HELPERS
// ---------------------------------------------------------------------------
// Para encriptar campos individuales dentro de un documento sin encriptar
// toda la base de datos.
//
// Uso:
//   const fieldCrypto = await FieldCrypto.create('my-password');
//   users.insert({
//     name: 'Alice',
//     ssn: await fieldCrypto.encrypt('123-45-6789'),
//     email: await fieldCrypto.encrypt('alice@secret.com'),
//   });
//   const doc = users.findById(id);
//   const ssn = await fieldCrypto.decrypt(doc.ssn); // '123-45-6789'

class FieldCrypto {
  constructor(key) { this._key = key; }

  static async create(password, salt = 'js-doc-field-v1') {
    const crypto = EncryptedAdapter._getCrypto();
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return new FieldCrypto(key);
  }

  async encrypt(value) {
    const crypto = EncryptedAdapter._getCrypto();
    const enc = new TextEncoder();
    const plaintext = enc.encode(typeof value === 'string' ? value : JSON.stringify(value));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._key, plaintext);
    const result = new Uint8Array(12 + ciphertext.byteLength);
    result.set(iv);
    result.set(new Uint8Array(ciphertext), 12);
    return '$enc$' + _uint8ToBase64(result);
  }

  async decrypt(encoded) {
    if (typeof encoded !== 'string' || !encoded.startsWith('$enc$')) return encoded;
    const crypto = EncryptedAdapter._getCrypto();
    const combined = _base64ToUint8(encoded.slice(5));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this._key, ciphertext);
    const text = new TextDecoder().decode(plaintext);
    try { return JSON.parse(text); } catch { return text; }
  }

  isEncrypted(value) {
    return typeof value === 'string' && value.startsWith('$enc$');
  }
}

// ---------------------------------------------------------------------------
// AUTH MODULE (password hashing + JWT + sessions + RBAC)
// ---------------------------------------------------------------------------
// Zero deps — usa Web Crypto API (PBKDF2 para passwords, HMAC-SHA256 para JWT)
//
// Uso:
//   const auth = new Auth(db, { secret: 'jwt-secret' });
//   await auth.init();
//   const user = await auth.register('alice@test.com', 'password123', { name: 'Alice' });
//   const { token, user } = await auth.login('alice@test.com', 'password123');
//   const verified = await auth.verify(token);
//   await auth.assignRole(user._id, 'admin');

class Auth {
  /**
   * @param {DocStore} db
   * @param {object} opts
   * @param {string} opts.secret              JWT signing secret
   * @param {string} [opts.usersCollection]   Default: '_users'
   * @param {string} [opts.sessionsCollection] Default: '_sessions'
   * @param {number} [opts.tokenExpiry]       JWT expiry in seconds (default: 86400 = 24h)
   * @param {number} [opts.hashIterations]    PBKDF2 iterations (default: 100000)
   * @param {string[]} [opts.defaultRoles]    Roles for new users (default: ['user'])
   */
  constructor(db, opts = {}) {
    this.db              = db;
    this.secret          = opts.secret;
    this.usersCol        = opts.usersCollection || '_users';
    this.sessionsCol     = opts.sessionsCollection || '_sessions';
    this.tokenExpiry     = opts.tokenExpiry || 86400;
    this.hashIterations  = opts.hashIterations || 100000;
    this.defaultRoles    = opts.defaultRoles || ['user'];

    if (!this.secret) throw new Error('Auth: secret is required');

    this._users    = null;
    this._sessions = null;
  }

  /** Inicializa colecciones e indices. Llamar una vez al inicio. */
  async init() {
    this._users = this.db.collection(this.usersCol);
    this._sessions = this.db.collection(this.sessionsCol);

    // Indices
    try { this._users.createIndex('email', { unique: true }); } catch {}
    try { this._sessions.createIndex('token'); } catch {}
    try { this._sessions.createIndex('userId'); } catch {}
  }

  // ── Password hashing (PBKDF2-SHA256) ─────────────────────

  async _hashPassword(password) {
    const crypto = Auth._getCrypto();
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));

    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );

    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: this.hashIterations, hash: 'SHA-256' },
      keyMaterial,
      256
    );

    const saltB64 = _uint8ToBase64(salt);
    const hashB64 = _uint8ToBase64(new Uint8Array(hash));
    return `pbkdf2:${this.hashIterations}:${saltB64}:${hashB64}`;
  }

  async _verifyPassword(password, stored) {
    const parts = stored.split(':');
    if (parts[0] !== 'pbkdf2') return false;

    const iterations = parseInt(parts[1], 10);
    const salt = _base64ToUint8(parts[2]);
    const expectedHash = parts[3];

    const crypto = Auth._getCrypto();
    const enc = new TextEncoder();

    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );

    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial,
      256
    );

    return _uint8ToBase64(new Uint8Array(hash)) === expectedHash;
  }

  // ── JWT (HMAC-SHA256) ────────────────────────────────────

  async _signJWT(payload) {
    const crypto = Auth._getCrypto();
    const enc = new TextEncoder();

    const header  = _b64url({ alg: 'HS256', typ: 'JWT' });
    const body    = _b64url(payload);
    const message = `${header}.${body}`;

    const key = await crypto.subtle.importKey(
      'raw', enc.encode(this.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign']
    );

    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    const sigB64 = _uint8ToBase64url(new Uint8Array(sig));

    return `${message}.${sigB64}`;
  }

  async _verifyJWT(token) {
    const crypto = Auth._getCrypto();
    const enc = new TextEncoder();

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const message = `${parts[0]}.${parts[1]}`;

    const key = await crypto.subtle.importKey(
      'raw', enc.encode(this.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['verify']
    );

    const sig = _base64urlToUint8(parts[2]);
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(message));

    if (!valid) return null;

    const payload = JSON.parse(_fromB64url(parts[1]));

    // Check expiry
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;

    return payload;
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Registra un usuario nuevo.
   * @param {string} email
   * @param {string} password
   * @param {object} [profile]  Campos adicionales (name, etc.)
   * @returns {Promise<object>}  El usuario creado (sin passwordHash)
   */
  async register(email, password, profile = {}) {
    if (!email || !password) throw new Error('Email and password required');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');

    const passwordHash = await this._hashPassword(password);

    const user = this._users.insert({
      email: email.toLowerCase().trim(),
      passwordHash,
      roles: this.defaultRoles.slice(),
      active: true,
      createdAt: Date.now(),
      ...profile,
    });

    // Retornar sin hash
    const { passwordHash: _, ...safe } = user;
    return safe;
  }

  /**
   * Login: verifica credenciales y retorna JWT.
   * @returns {Promise<{ token: string, user: object }>}
   */
  async login(email, password) {
    const user = this._users.findOne({ email: email.toLowerCase().trim() });
    if (!user) throw new Error('Invalid credentials');
    if (!user.active) throw new Error('Account disabled');

    const valid = await this._verifyPassword(password, user.passwordHash);
    if (!valid) throw new Error('Invalid credentials');

    // Generar JWT
    const payload = {
      sub: user._id,
      email: user.email,
      roles: user.roles,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + this.tokenExpiry,
    };

    const token = await this._signJWT(payload);

    // Guardar sesion
    this._sessions.insert({
      userId: user._id,
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.tokenExpiry * 1000,
    });

    // Update lastLogin
    this._users.update({ _id: user._id }, { $set: { lastLogin: Date.now() } });

    const { passwordHash: _, ...safe } = user;
    return { token, user: safe };
  }

  /**
   * Verifica un JWT y retorna el payload.
   * @returns {Promise<object|null>}  Payload o null si invalido/expirado
   */
  async verify(token) {
    const payload = await this._verifyJWT(token);
    if (!payload) return null;

    // Verificar que la sesion existe
    const session = this._sessions.findOne({ token });
    if (!session) return null;

    return payload;
  }

  /**
   * Logout: invalida una sesion.
   */
  logout(token) {
    return this._sessions.remove({ token });
  }

  /**
   * Invalida todas las sesiones de un usuario.
   */
  logoutAll(userId) {
    return this._sessions.removeMany({ userId });
  }

  /**
   * Cambia el password de un usuario.
   */
  async changePassword(userId, oldPassword, newPassword) {
    const user = this._users.findById(userId);
    if (!user) throw new Error('User not found');

    const valid = await this._verifyPassword(oldPassword, user.passwordHash);
    if (!valid) throw new Error('Invalid current password');

    if (newPassword.length < 6) throw new Error('Password must be at least 6 characters');

    const hash = await this._hashPassword(newPassword);
    this._users.update({ _id: userId }, { $set: { passwordHash: hash } });

    // Invalidar sesiones existentes
    this._sessions.removeMany({ userId });
    return true;
  }

  /**
   * Reset de password (admin/recovery — sin verificar password viejo).
   */
  async resetPassword(userId, newPassword) {
    if (newPassword.length < 6) throw new Error('Password must be at least 6 characters');
    const hash = await this._hashPassword(newPassword);
    this._users.update({ _id: userId }, { $set: { passwordHash: hash } });
    this._sessions.removeMany({ userId });
    return true;
  }

  // ── Roles / RBAC ────────────────────────────────────────

  assignRole(userId, role) {
    const user = this._users.findById(userId);
    if (!user) throw new Error('User not found');
    if (user.roles.includes(role)) return;
    this._users.update({ _id: userId }, { $push: { roles: role } });
  }

  removeRole(userId, role) {
    const user = this._users.findById(userId);
    if (!user) throw new Error('User not found');
    this._users.update({ _id: userId }, { $pull: { roles: role } });
  }

  hasRole(userId, role) {
    const user = this._users.findById(userId);
    return user ? user.roles.includes(role) : false;
  }

  /**
   * Middleware-style: verifica token Y rol.
   * @returns {Promise<object|null>}  Payload si autorizado, null si no
   */
  async authorize(token, requiredRole) {
    const payload = await this.verify(token);
    if (!payload) return null;
    if (requiredRole && !payload.roles.includes(requiredRole)) return null;
    return payload;
  }

  // ── User management ──────────────────────────────────────

  getUser(userId) {
    const user = this._users.findById(userId);
    if (!user) return null;
    const { passwordHash: _, ...safe } = user;
    return safe;
  }

  getUserByEmail(email) {
    const user = this._users.findOne({ email: email.toLowerCase().trim() });
    if (!user) return null;
    const { passwordHash: _, ...safe } = user;
    return safe;
  }

  listUsers(filter = {}, opts = {}) {
    let cursor = this._users.find(filter);
    if (opts.sort) cursor = cursor.sort(opts.sort);
    if (opts.skip) cursor = cursor.skip(opts.skip);
    if (opts.limit) cursor = cursor.limit(opts.limit);
    return cursor.toArray().map(u => {
      const { passwordHash: _, ...safe } = u;
      return safe;
    });
  }

  disableUser(userId) {
    this._users.update({ _id: userId }, { $set: { active: false } });
    this._sessions.removeMany({ userId });
  }

  enableUser(userId) {
    this._users.update({ _id: userId }, { $set: { active: true } });
  }

  deleteUser(userId) {
    this._users.removeById(userId);
    this._sessions.removeMany({ userId });
  }

  /**
   * Limpia sesiones expiradas.
   */
  cleanExpiredSessions() {
    return this._sessions.removeMany({
      expiresAt: { $lt: Date.now() },
    });
  }

  static _getCrypto() {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
      return globalThis.crypto;
    }
    try {
      const { webcrypto } = require('crypto');
      return webcrypto;
    } catch {
      throw new Error('Auth: Web Crypto API not available');
    }
  }
}

// JWT base64url helpers
function _b64url(obj) {
  const json = JSON.stringify(obj);
  const b64 = _uint8ToBase64(new TextEncoder().encode(json));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _fromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  const bytes = _base64ToUint8(padded);
  return new TextDecoder().decode(bytes);
}

function _uint8ToBase64url(uint8) {
  return _uint8ToBase64(uint8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _base64urlToUint8(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  return _base64ToUint8(padded);
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  DocStore,
  Collection,
  Cursor,
  AggregationPipeline,
  HashIndex,
  SortedIndex,
  Table,
  TEMPLATES,
  createFromTemplate,
  FileStorageAdapter,
  MemoryStorageAdapter,
  CloudflareKVAdapter,
  EncryptedAdapter,
  FieldCrypto,
  Auth,
  // Utils
  matchFilter,
  applyUpdate,
  generateId,
};
