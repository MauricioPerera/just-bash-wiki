/**
 * js-vector-store
 * Port vanilla JS de php-vector-store (MauricioPerera)
 * Zero dependencias — funciona en Node.js y browser (con adaptador de storage)
 *
 * Backends:
 *   VectorStore          → Float32, dim×4 bytes/vector
 *   QuantizedStore       → Int8, dim+8 bytes/vector (~4x más compacto)
 *   BinaryQuantizedStore → 1-bit, ceil(dim/8) bytes/vector (~32x más compacto)
 *   IVFIndex             → K-means clustering encima de cualquiera de los tres
 *
 * API idéntica a la versión PHP.
 */

// ---------------------------------------------------------------------------
// MIN-HEAP (top-K por score, tamaño acotado)
// ---------------------------------------------------------------------------

class TopKHeap {
  constructor(k) {
    this.k    = k;
    this.data = [];
  }

  push(item) {
    if (this.data.length < this.k) {
      this.data.push(item);
      this._bubbleUp(this.data.length - 1);
    } else if (item.score > this.data[0].score) {
      this.data[0] = item;
      this._sinkDown(0);
    }
  }

  sorted() {
    const out = this.data.slice();
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].score < this.data[parent].score) {
        const tmp = this.data[i]; this.data[i] = this.data[parent]; this.data[parent] = tmp;
        i = parent;
      } else break;
    }
  }

  _sinkDown(i) {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.data[l].score < this.data[smallest].score) smallest = l;
      if (r < n && this.data[r].score < this.data[smallest].score) smallest = r;
      if (smallest !== i) {
        const tmp = this.data[i]; this.data[i] = this.data[smallest]; this.data[smallest] = tmp;
        i = smallest;
      } else break;
    }
  }
}

// ---------------------------------------------------------------------------
// POPCOUNT LOOKUP TABLE (para BinaryQuantizedStore)
// ---------------------------------------------------------------------------

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let n = i, c = 0;
  while (n) { c++; n &= n - 1; }
  POPCOUNT[i] = c;
}

// ---------------------------------------------------------------------------
// MATH UTILS
// ---------------------------------------------------------------------------

/**
 * Normaliza un vector a longitud 1 (L2).
 * @param {number[]|Float32Array} v
 * @returns {number[]}
 */
function normalize(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from(v);
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Similitud coseno entre a y b, usando solo los primeros `dims` elementos.
 * Funciona con number[], Float32Array, Float64Array, o cualquier indexable.
 */
function cosineSim(a, b, dims) {
  const n = dims ?? Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i], bi = b[i];
    dot += ai * bi;
    na  += ai * ai;
    nb  += bi * bi;
  }
  const denom = Math.sqrt(na * nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Distancia euclidiana entre a y b.
 */
function euclideanDist(a, b, dims) {
  const n = dims ?? Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

/**
 * Distancia euclidiana al cuadrado (evita sqrt para comparaciones).
 */
function euclideanDistSq(a, aOff, b, bOff, dims) {
  let sum = 0;
  for (let i = 0; i < dims; i++) { const d = a[aOff + i] - b[bOff + i]; sum += d * d; }
  return sum;
}

/**
 * Producto punto entre a y b.
 */
function dotProduct(a, b, dims) {
  const n = dims ?? Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Distancia Manhattan (L1) entre a y b.
 */
function manhattanDist(a, b, dims) {
  const n = dims ?? Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

/**
 * Calcula score entre dos vectores usando la métrica indicada.
 * Retorna un valor donde mayor = más similar.
 * @param {number[]|Float32Array} a
 * @param {number[]|Float32Array} b
 * @param {number} dims
 * @param {'cosine'|'euclidean'|'dotProduct'|'manhattan'} metric
 * @returns {number}
 */
function computeScore(a, b, dims, metric) {
  switch (metric) {
    case 'cosine':     return cosineSim(a, b, dims);
    case 'dotProduct': return dotProduct(a, b, dims);
    case 'euclidean':  return 1 / (1 + euclideanDist(a, b, dims));
    case 'manhattan':  return 1 / (1 + manhattanDist(a, b, dims));
    default:           return cosineSim(a, b, dims);
  }
}

// ---------------------------------------------------------------------------
// METADATA FILTER
// ---------------------------------------------------------------------------
// Soporta: igualdad, comparadores, $in, $nin, $exists, $and, $or, $not, $regex
//
// Ejemplos:
//   { category: 'tech' }                         → igualdad simple
//   { price: { $gt: 100 } }                      → mayor que
//   { tags: { $in: ['ai', 'ml'] } }              → contenido en array
//   { $and: [{ price: { $gte: 10 } }, { price: { $lte: 100 } }] }
//   { $or: [{ category: 'tech' }, { category: 'science' }] }
//   { name: { $regex: '^AI' } }                   → regex match

function matchFilter(metadata, filter) {
  if (!filter || typeof filter !== 'object') return true;
  if (!metadata) metadata = {};

  for (const key of Object.keys(filter)) {
    // Logical operators
    if (key === '$and') {
      if (!Array.isArray(filter.$and)) return false;
      for (const sub of filter.$and) {
        if (!matchFilter(metadata, sub)) return false;
      }
      continue;
    }
    if (key === '$or') {
      if (!Array.isArray(filter.$or)) return false;
      let any = false;
      for (const sub of filter.$or) {
        if (matchFilter(metadata, sub)) { any = true; break; }
      }
      if (!any) return false;
      continue;
    }
    if (key === '$not') {
      if (matchFilter(metadata, filter.$not)) return false;
      continue;
    }

    const val   = metadata[key];
    const cond  = filter[key];

    // Simple equality
    if (cond === null || typeof cond !== 'object') {
      if (val !== cond) return false;
      continue;
    }

    // Operator object
    for (const op of Object.keys(cond)) {
      const target = cond[op];
      switch (op) {
        case '$eq':     if (val !== target) return false; break;
        case '$ne':     if (val === target) return false; break;
        case '$gt':     if (!(val > target)) return false; break;
        case '$gte':    if (!(val >= target)) return false; break;
        case '$lt':     if (!(val < target)) return false; break;
        case '$lte':    if (!(val <= target)) return false; break;
        case '$in':     if (!Array.isArray(target) || !target.includes(val)) return false; break;
        case '$nin':    if (Array.isArray(target) && target.includes(val)) return false; break;
        case '$exists': if ((val !== undefined) !== target) return false; break;
        case '$regex': {
          const re = typeof target === 'string' ? new RegExp(target) : target;
          if (!re.test(String(val ?? ''))) return false;
          break;
        }
        default: break;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// SEARCH ACROSS WITH SCORE NORMALIZATION
// ---------------------------------------------------------------------------

/**
 * Normaliza scores por colección a [0,1] y mergea con heap.
 * Usado por searchAcross en todos los stores.
 */
function _normalizedSearchAcross(store, collections, query, limit, metric) {
  if (collections.length <= 1) {
    // Sin normalización para colección única
    const col = collections[0];
    return store.search(col, query, limit, 0, metric);
  }

  const perCol = [];
  for (const col of collections) {
    const results = store.search(col, query, limit, 0, metric);
    if (results.length > 0) perCol.push(results);
  }

  const heap = new TopKHeap(limit);
  for (const results of perCol) {
    let min = Infinity, max = -Infinity;
    for (const r of results) {
      if (r.score < min) min = r.score;
      if (r.score > max) max = r.score;
    }
    const range = max - min;
    for (const r of results) {
      const normalized = range > 0 ? (r.score - min) / range : 1.0;
      heap.push({ ...r, score: normalized });
    }
  }
  return heap.sorted();
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
      throw new Error('VectorStore: entorno sin fs — usá un StorageAdapter personalizado');
    }
  }
  return { fs: _fs, path: _path };
}

class FileStorageAdapter {
  constructor(dir) {
    const { fs, path } = _getFs();
    this.dir  = dir;
    this.fs   = fs;
    this.path = path;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  readBin(filename) {
    const file = this.path.join(this.dir, filename);
    if (!this.fs.existsSync(file)) return null;
    const buf = this.fs.readFileSync(file);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  writeBin(filename, buffer) {
    const file = this.path.join(this.dir, filename);
    this.fs.writeFileSync(file, Buffer.from(buffer));
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
  constructor() {
    this._bins  = new Map();
    this._jsons = new Map();
  }
  readBin(k)       { return this._bins.get(k) ?? null; }
  writeBin(k, v)   { this._bins.set(k, v); }
  readJson(k)      { return this._jsons.get(k) ?? null; }
  writeJson(k, v)  { this._jsons.set(k, v); }
  delete(k)        { this._bins.delete(k); this._jsons.delete(k); }
}

// ---------------------------------------------------------------------------
// VECTOR STORE (Float32) — OPTIMIZED
// ---------------------------------------------------------------------------

class VectorStore {
  /**
   * @param {string|object} dirOrAdapter
   * @param {number} dim
   * @param {number} maxCollections
   * @param {object} [opts]
   * @param {string} [opts.model]  Modelo de embeddings (se guarda en el manifest)
   */
  constructor(dirOrAdapter, dim = 768, maxCollections = 50, opts = {}) {
    this.dim           = dim;
    this.maxCollections = maxCollections;
    this.defaultModel  = opts.model || null;
    this._adapter      = typeof dirOrAdapter === 'string'
      ? new FileStorageAdapter(dirOrAdapter)
      : dirOrAdapter;
    this._collections = new Map();
    this._stride = dim * 4;
  }

  _binFile(col)  { return `${col}.bin`; }
  _jsonFile(col) { return `${col}.json`; }

  _load(col) {
    if (this._collections.has(col)) return this._collections.get(col);
    const manifest = this._adapter.readJson(this._jsonFile(col));
    const ids  = manifest ? manifest.ids  : [];
    const meta = manifest ? manifest.meta : [];
    const model = manifest?.model || this.defaultModel || null;
    const idMap = new Map();
    for (let i = 0; i < ids.length; i++) idMap.set(ids[i], i);
    const bin = this._adapter.readBin(this._binFile(col));
    const entry = { ids, meta, idMap, bin, model, pending: [], dirty: false };
    this._collections.set(col, entry);
    return entry;
  }

  /** Retorna el modelo de embeddings de una coleccion, o null. */
  getModel(col) { return this._load(col).model; }

  /** Setea el modelo de embeddings para una coleccion. */
  setModel(col, model) { const e = this._load(col); e.model = model; e.dirty = true; }

  _readVec(col, idx) {
    const entry = this._collections.get(col) || this._load(col);
    const committed = entry.idMap.size - entry.pending.length;
    if (idx < committed) {
      if (!entry.bin) return null;
      return new Float32Array(entry.bin, idx * this._stride, this.dim);
    }
    return entry.pending[idx - committed].vector;
  }

  _rebuildBin(entry) {
    const committed = entry.ids.length - entry.pending.length;
    const totalVecs = entry.ids.length;
    const buf = new ArrayBuffer(totalVecs * this._stride);
    const f32 = new Float32Array(buf);
    if (entry.bin && committed > 0) {
      f32.set(new Float32Array(entry.bin, 0, committed * this.dim));
    }
    for (let p = 0; p < entry.pending.length; p++) {
      const vec = entry.pending[p].vector;
      const offset = (committed + p) * this.dim;
      for (let d = 0; d < this.dim; d++) f32[offset + d] = vec[d] ?? 0;
    }
    return buf;
  }

  set(col, id, vector, metadata = {}) {
    const entry    = this._load(col);
    const existing = entry.idMap.get(id);
    if (existing !== undefined) {
      const committed = entry.ids.length - entry.pending.length;
      if (existing < committed) {
        if (entry.bin) {
          const f32 = new Float32Array(entry.bin, existing * this._stride, this.dim);
          for (let d = 0; d < this.dim; d++) f32[d] = vector[d] ?? 0;
        }
      } else {
        entry.pending[existing - committed].vector = vector;
      }
      entry.meta[existing] = metadata;
    } else {
      const idx = entry.ids.length;
      entry.ids.push(id);
      entry.meta.push(metadata);
      entry.idMap.set(id, idx);
      entry.pending.push({ id, vector, metadata });
    }
    entry.dirty = true;
  }

  remove(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return false;
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const totalVecs = entry.ids.length;
    const newBuf = new ArrayBuffer((totalVecs - 1) * this._stride);
    const dst = new Float32Array(newBuf);
    let writeIdx = 0;
    for (let i = 0; i < totalVecs; i++) {
      if (i === idx) continue;
      dst.set(new Float32Array(entry.bin, i * this._stride, this.dim), writeIdx * this.dim);
      writeIdx++;
    }
    entry.ids.splice(idx, 1);
    entry.meta.splice(idx, 1);
    entry.idMap.clear();
    for (let i = 0; i < entry.ids.length; i++) entry.idMap.set(entry.ids[i], i);
    entry.bin = newBuf;
    this._adapter.writeBin(this._binFile(col), newBuf);
    entry.dirty = true;
    return true;
  }

  drop(col) {
    this._adapter.delete(this._binFile(col));
    this._adapter.delete(this._jsonFile(col));
    this._collections.delete(col);
  }

  _flushCol(col, entry) {
    if (entry.pending.length > 0) {
      entry.bin = this._rebuildBin(entry);
      entry.pending = [];
    }
    if (entry.bin) this._adapter.writeBin(this._binFile(col), entry.bin);
    const manifest = { ids: entry.ids, meta: entry.meta, dim: this.dim };
    if (entry.model) manifest.model = entry.model;
    this._adapter.writeJson(this._jsonFile(col), manifest);
    entry.dirty = false;
  }

  flush() {
    for (const [col, entry] of this._collections) {
      if (entry.dirty) this._flushCol(col, entry);
    }
  }

  get(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return null;
    return { id, vector: Array.from(this._readVec(col, idx)), metadata: entry.meta[idx] };
  }

  has(col, id)       { return this._load(col).idMap.has(id); }
  count(col)         { return this._load(col).ids.length; }
  ids(col)           { return this._load(col).ids.slice(); }
  collections()      { return Array.from(this._collections.keys()); }

  stats() {
    const result = {};
    for (const col of this._collections.keys()) {
      result[col] = { count: this.count(col), dim: this.dim };
    }
    return result;
  }

  import(col, records) {
    for (const r of records) this.set(col, r.id, r.vector, r.metadata ?? {});
    return records.length;
  }

  export(col) {
    const entry = this._load(col);
    return entry.ids.map((id, i) => ({
      id, vector: Array.from(this._readVec(col, i)), metadata: entry.meta[i],
    }));
  }

  search(col, query, limit = 5, dimSlice = 0, metric = 'cosine', filter = null) {
    const entry = this._load(col);
    const dims  = dimSlice > 0 ? dimSlice : this.dim;
    const n     = entry.ids.length;
    const heap  = new TopKHeap(limit);
    for (let i = 0; i < n; i++) {
      if (filter && !matchFilter(entry.meta[i], filter)) continue;
      const vec   = this._readVec(col, i);
      const score = computeScore(query, vec, dims, metric);
      heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
    }
    return heap.sorted();
  }

  matryoshkaSearch(col, query, limit = 5, stages = [128, 384, 768], metric = 'cosine') {
    const entry = this._load(col);
    if (entry.ids.length === 0) return [];
    const factor = 4;
    let candidates = entry.ids.map((id, i) => ({ id, idx: i, metadata: entry.meta[i] }));
    for (let s = 0; s < stages.length; s++) {
      const dims  = Math.min(stages[s], this.dim);
      const keepN = s < stages.length - 1
        ? Math.max(limit * factor * (stages.length - s), limit) : limit;
      const heap = new TopKHeap(keepN);
      for (const c of candidates) {
        const vec   = this._readVec(col, c.idx);
        const score = computeScore(query, vec, dims, metric);
        heap.push({ ...c, score });
      }
      candidates = heap.sorted();
    }
    return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
  }

  searchAcross(collections, query, limit = 5, metric = 'cosine') {
    return _normalizedSearchAcross(this, collections, query, limit, metric);
  }

  static normalize      = normalize;
  static cosineSim      = cosineSim;
  static euclideanDist  = euclideanDist;
  static dotProduct     = dotProduct;
  static manhattanDist  = manhattanDist;
  static computeScore   = computeScore;
}

// ---------------------------------------------------------------------------
// QUANTIZED STORE (Int8) — OPTIMIZED
// ---------------------------------------------------------------------------

class QuantizedStore {
  constructor(dirOrAdapter, dim = 768, opts = {}) {
    this.dim          = dim;
    this.defaultModel = opts.model || null;
    this._adapter = typeof dirOrAdapter === 'string'
      ? new FileStorageAdapter(dirOrAdapter)
      : dirOrAdapter;
    this._collections = new Map();
  }

  _binFile(col)  { return `${col}.q8.bin`; }
  _jsonFile(col) { return `${col}.q8.json`; }
  get _stride() { return 8 + this.dim; }

  _load(col) {
    if (this._collections.has(col)) return this._collections.get(col);
    const manifest = this._adapter.readJson(this._jsonFile(col));
    const ids  = manifest ? manifest.ids  : [];
    const meta = manifest ? manifest.meta : [];
    const model = manifest?.model || this.defaultModel || null;
    const idMap = new Map();
    for (let i = 0; i < ids.length; i++) idMap.set(ids[i], i);
    const bin = this._adapter.readBin(this._binFile(col));
    const entry = { ids, meta, idMap, bin, model, pending: [], dirty: false };
    this._collections.set(col, entry);
    return entry;
  }

  getModel(col) { return this._load(col).model; }
  setModel(col, model) { const e = this._load(col); e.model = model; e.dirty = true; }

  _quantize(vector) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < vector.length; i++) {
      const x = vector[i];
      if (x < min) min = x;
      if (x > max) max = x;
    }
    const range = max - min || 1;
    const int8  = new Int8Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      int8[i] = Math.round(((vector[i] - min) / range) * 255) - 128;
    }
    return { int8, min, max };
  }

  _dequantize(int8, min, max) {
    const range  = max - min || 1;
    const result = new Float64Array(int8.length);
    for (let i = 0; i < int8.length; i++) {
      result[i] = ((int8[i] + 128) / 255) * range + min;
    }
    return result;
  }

  _readVec(col, idx) {
    const entry = this._collections.get(col) || this._load(col);
    const committed = entry.ids.length - entry.pending.length;
    if (idx < committed) {
      if (!entry.bin) return null;
      const offset = idx * this._stride;
      const view   = new DataView(entry.bin);
      const min    = view.getFloat32(offset, true);
      const max    = view.getFloat32(offset + 4, true);
      const int8   = new Int8Array(entry.bin, offset + 8, this.dim);
      return this._dequantize(int8, min, max);
    }
    const p = entry.pending[idx - committed];
    const view = new DataView(p.packed);
    const min  = view.getFloat32(0, true);
    const max  = view.getFloat32(4, true);
    const int8 = new Int8Array(p.packed, 8, this.dim);
    return this._dequantize(int8, min, max);
  }

  _packVec(vector) {
    const { int8, min, max } = this._quantize(vector);
    const buf  = new ArrayBuffer(this._stride);
    const view = new DataView(buf);
    view.setFloat32(0, min, true);
    view.setFloat32(4, max, true);
    new Int8Array(buf, 8).set(int8);
    return buf;
  }

  set(col, id, vector, metadata = {}) {
    const entry    = this._load(col);
    const existing = entry.idMap.get(id);
    const packed   = this._packVec(vector);
    if (existing !== undefined) {
      const committed = entry.ids.length - entry.pending.length;
      if (existing < committed) {
        if (entry.bin) new Uint8Array(entry.bin).set(new Uint8Array(packed), existing * this._stride);
      } else {
        entry.pending[existing - committed].packed = packed;
      }
      entry.meta[existing] = metadata;
    } else {
      const idx = entry.ids.length;
      entry.ids.push(id);
      entry.meta.push(metadata);
      entry.idMap.set(id, idx);
      entry.pending.push({ id, packed, metadata });
    }
    entry.dirty = true;
  }

  remove(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return false;
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const totalVecs = entry.ids.length;
    const stride = this._stride;
    const newBuf = new ArrayBuffer((totalVecs - 1) * stride);
    const dst = new Uint8Array(newBuf);
    const src = new Uint8Array(entry.bin);
    let writeIdx = 0;
    for (let i = 0; i < totalVecs; i++) {
      if (i === idx) continue;
      dst.set(src.subarray(i * stride, (i + 1) * stride), writeIdx * stride);
      writeIdx++;
    }
    entry.ids.splice(idx, 1);
    entry.meta.splice(idx, 1);
    entry.idMap.clear();
    for (let i = 0; i < entry.ids.length; i++) entry.idMap.set(entry.ids[i], i);
    entry.bin = newBuf;
    this._adapter.writeBin(this._binFile(col), newBuf);
    entry.dirty = true;
    return true;
  }

  drop(col) {
    this._adapter.delete(this._binFile(col));
    this._adapter.delete(this._jsonFile(col));
    this._collections.delete(col);
  }

  _flushCol(col, entry) {
    if (entry.pending.length > 0) {
      const committed = entry.ids.length - entry.pending.length;
      const total = entry.ids.length;
      const stride = this._stride;
      const newBuf = new ArrayBuffer(total * stride);
      const dst = new Uint8Array(newBuf);
      if (entry.bin && committed > 0) dst.set(new Uint8Array(entry.bin, 0, committed * stride));
      for (let p = 0; p < entry.pending.length; p++) {
        dst.set(new Uint8Array(entry.pending[p].packed), (committed + p) * stride);
      }
      entry.bin = newBuf;
      entry.pending = [];
    }
    if (entry.bin) this._adapter.writeBin(this._binFile(col), entry.bin);
    const manifest = { ids: entry.ids, meta: entry.meta, dim: this.dim };
    if (entry.model) manifest.model = entry.model;
    this._adapter.writeJson(this._jsonFile(col), manifest);
    entry.dirty = false;
  }

  flush() {
    for (const [col, entry] of this._collections) {
      if (entry.dirty) this._flushCol(col, entry);
    }
  }

  get(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return null;
    return { id, vector: Array.from(this._readVec(col, idx)), metadata: entry.meta[idx] };
  }

  has(col, id)  { return this._load(col).idMap.has(id); }
  count(col)    { return this._load(col).ids.length; }
  ids(col)      { return this._load(col).ids.slice(); }

  search(col, query, limit = 5, dimSlice = 0, metric = 'cosine', filter = null) {
    const entry = this._load(col);
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const dims = dimSlice > 0 ? dimSlice : this.dim;
    const n    = entry.ids.length;
    const heap = new TopKHeap(limit);
    for (let i = 0; i < n; i++) {
      if (filter && !matchFilter(entry.meta[i], filter)) continue;
      const vec   = this._readVec(col, i);
      const score = computeScore(query, vec, dims, metric);
      heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
    }
    return heap.sorted();
  }

  matryoshkaSearch(col, query, limit = 5, stages = [128, 256, 384], metric = 'cosine') {
    const entry = this._load(col);
    if (entry.ids.length === 0) return [];
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const factor = 4;
    let candidates = entry.ids.map((id, i) => ({ id, idx: i, metadata: entry.meta[i] }));
    for (let s = 0; s < stages.length; s++) {
      const dims  = Math.min(stages[s], this.dim);
      const keepN = s < stages.length - 1
        ? Math.max(limit * factor * (stages.length - s), limit) : limit;
      const heap = new TopKHeap(keepN);
      for (const c of candidates) {
        const vec   = this._readVec(col, c.idx);
        const score = computeScore(query, vec, dims, metric);
        heap.push({ ...c, score });
      }
      candidates = heap.sorted();
    }
    return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
  }

  searchAcross(collections, query, limit = 5, metric = 'cosine') {
    return _normalizedSearchAcross(this, collections, query, limit, metric);
  }

  import(col, records) {
    for (const r of records) this.set(col, r.id, r.vector, r.metadata ?? {});
    return records.length;
  }

  export(col) {
    const entry = this._load(col);
    return entry.ids.map((id, i) => ({
      id, vector: Array.from(this._readVec(col, i)), metadata: entry.meta[i],
    }));
  }
}

// ---------------------------------------------------------------------------
// BINARY QUANTIZED STORE (1-bit) — 32x compression
// ---------------------------------------------------------------------------
// Cada float se reduce a su bit de signo: >= 0 → 1, < 0 → 0
// Empaquetado MSB-first: dim 0 es el bit alto del byte 0
// Similitud via Hamming: cosine_approx = 1.0 - 2.0 * hamming / dims

class BinaryQuantizedStore {
  constructor(dirOrAdapter, dim = 768, opts = {}) {
    this.dim          = dim;
    this.defaultModel = opts.model || null;
    this._bpv     = Math.ceil(dim / 8); // bytes per vector
    this._adapter = typeof dirOrAdapter === 'string'
      ? new FileStorageAdapter(dirOrAdapter)
      : dirOrAdapter;
    this._collections = new Map();
  }

  _binFile(col)  { return `${col}.b1.bin`; }
  _jsonFile(col) { return `${col}.b1.json`; }

  _load(col) {
    if (this._collections.has(col)) return this._collections.get(col);
    const manifest = this._adapter.readJson(this._jsonFile(col));
    const ids  = manifest ? manifest.ids  : [];
    const meta = manifest ? manifest.meta : [];
    const model = manifest?.model || this.defaultModel || null;
    const idMap = new Map();
    for (let i = 0; i < ids.length; i++) idMap.set(ids[i], i);
    const bin = this._adapter.readBin(this._binFile(col));
    const entry = { ids, meta, idMap, bin, model, pending: [], dirty: false };
    this._collections.set(col, entry);
    return entry;
  }

  getModel(col) { return this._load(col).model; }
  setModel(col, model) { const e = this._load(col); e.model = model; e.dirty = true; }

  /**
   * Cuantiza float[] a binario (1-bit por dimensión).
   * Normaliza primero, luego sign-bit MSB-first.
   * @returns {Uint8Array}
   */
  static quantize(vector, dim) {
    const norm = normalize(vector);
    const bytes = new Uint8Array(Math.ceil(dim / 8));
    const d = Math.min(norm.length, dim);
    for (let i = 0; i < d; i++) {
      if (norm[i] >= 0) {
        bytes[i >> 3] |= (1 << (7 - (i & 7)));
      }
    }
    return bytes;
  }

  /**
   * Dequantiza binario a float[]: bit 1 → +1.0, bit 0 → -1.0
   */
  static dequantize(buf, offset, dim) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const floats = new Array(dim);
    for (let i = 0; i < dim; i++) {
      const bit = (u8[offset + (i >> 3)] >> (7 - (i & 7))) & 1;
      floats[i] = bit ? 1.0 : -1.0;
    }
    return floats;
  }

  /**
   * Coseno aproximado via Hamming: 1.0 - 2.0 * hamming / dims
   */
  static binaryCosineSim(a, aOff, b, bOff, dims) {
    const bytesToCmp = Math.ceil(dims / 8);
    let hamming = 0;
    for (let i = 0; i < bytesToCmp; i++) {
      hamming += POPCOUNT[a[aOff + i] ^ b[bOff + i]];
    }
    // Correccion si dims no es multiplo de 8
    const remainder = dims & 7;
    if (remainder > 0) {
      const last = bytesToCmp - 1;
      const xor  = a[aOff + last] ^ b[bOff + last];
      const mask = (0xFF << (8 - remainder)) & 0xFF;
      hamming = hamming - POPCOUNT[xor] + POPCOUNT[xor & mask];
    }
    return 1.0 - (2.0 * hamming / dims);
  }

  /** Lee el binario de un vector desde buffer cacheado o pending. */
  _readBin(col, idx) {
    const entry = this._collections.get(col) || this._load(col);
    const committed = entry.ids.length - entry.pending.length;
    if (idx < committed) {
      if (!entry.bin) return null;
      return new Uint8Array(entry.bin, idx * this._bpv, this._bpv);
    }
    return entry.pending[idx - committed].packed;
  }

  /** Lee el vector dequantizado (+1/-1). */
  _readVec(col, idx) {
    const entry = this._collections.get(col) || this._load(col);
    const committed = entry.ids.length - entry.pending.length;
    if (idx < committed) {
      if (!entry.bin) return null;
      return BinaryQuantizedStore.dequantize(entry.bin, idx * this._bpv, this.dim);
    }
    const packed = entry.pending[idx - committed].packed;
    return BinaryQuantizedStore.dequantize(packed, 0, this.dim);
  }

  set(col, id, vector, metadata = {}) {
    const entry    = this._load(col);
    const existing = entry.idMap.get(id);
    const packed   = BinaryQuantizedStore.quantize(vector, this.dim);

    if (existing !== undefined) {
      const committed = entry.ids.length - entry.pending.length;
      if (existing < committed) {
        if (entry.bin) {
          new Uint8Array(entry.bin).set(packed, existing * this._bpv);
        }
      } else {
        entry.pending[existing - committed].packed = packed;
      }
      entry.meta[existing] = metadata;
    } else {
      const idx = entry.ids.length;
      entry.ids.push(id);
      entry.meta.push(metadata);
      entry.idMap.set(id, idx);
      entry.pending.push({ id, packed, metadata });
    }
    entry.dirty = true;
  }

  /** Swap-with-last delete (como PHP). */
  remove(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return false;
    if (entry.pending.length > 0) this._flushCol(col, entry);

    const lastIdx = entry.ids.length - 1;
    const bpv = this._bpv;
    const u8 = new Uint8Array(entry.bin);

    if (idx !== lastIdx) {
      // Swap last into position of deleted
      const lastId = entry.ids[lastIdx];
      u8.copyWithin(idx * bpv, lastIdx * bpv, (lastIdx + 1) * bpv);
      entry.ids[idx]  = lastId;
      entry.meta[idx] = entry.meta[lastIdx];
      entry.idMap.set(lastId, idx);
    }

    entry.ids.pop();
    entry.meta.pop();
    entry.idMap.delete(id);

    // Truncate buffer
    entry.bin = entry.bin.slice(0, entry.ids.length * bpv);
    this._adapter.writeBin(this._binFile(col), entry.bin);
    entry.dirty = true;
    return true;
  }

  drop(col) {
    this._adapter.delete(this._binFile(col));
    this._adapter.delete(this._jsonFile(col));
    this._collections.delete(col);
  }

  _flushCol(col, entry) {
    if (entry.pending.length > 0) {
      const committed = entry.ids.length - entry.pending.length;
      const total = entry.ids.length;
      const bpv = this._bpv;
      const newBuf = new ArrayBuffer(total * bpv);
      const dst = new Uint8Array(newBuf);
      if (entry.bin && committed > 0) {
        dst.set(new Uint8Array(entry.bin, 0, committed * bpv));
      }
      for (let p = 0; p < entry.pending.length; p++) {
        dst.set(entry.pending[p].packed, (committed + p) * bpv);
      }
      entry.bin = newBuf;
      entry.pending = [];
    }
    if (entry.bin) this._adapter.writeBin(this._binFile(col), entry.bin);
    const manifest = { ids: entry.ids, meta: entry.meta, dim: this.dim };
    if (entry.model) manifest.model = entry.model;
    this._adapter.writeJson(this._jsonFile(col), manifest);
    entry.dirty = false;
  }

  flush() {
    for (const [col, entry] of this._collections) {
      if (entry.dirty) this._flushCol(col, entry);
    }
  }

  get(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return null;
    return { id, vector: this._readVec(col, idx), metadata: entry.meta[idx] };
  }

  has(col, id)  { return this._load(col).idMap.has(id); }
  count(col)    { return this._load(col).ids.length; }
  ids(col)      { return this._load(col).ids.slice(); }

  bytesPerVector() { return this._bpv; }

  /**
   * Search: cosine usa Hamming directo (ultra-rapido), otros dequantizan.
   */
  search(col, query, limit = 5, dimSlice = 0, metric = 'cosine', filter = null) {
    const entry = this._load(col);
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const dims = dimSlice > 0 ? Math.min(dimSlice, this.dim) : this.dim;
    const n    = entry.ids.length;
    const heap = new TopKHeap(limit);

    if (metric === 'cosine' && entry.bin) {
      const qBin = BinaryQuantizedStore.quantize(query, this.dim);
      const u8   = new Uint8Array(entry.bin);
      const bpv  = this._bpv;
      for (let i = 0; i < n; i++) {
        if (filter && !matchFilter(entry.meta[i], filter)) continue;
        const score = BinaryQuantizedStore.binaryCosineSim(qBin, 0, u8, i * bpv, dims);
        heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
      }
    } else {
      const qNorm = normalize(query);
      for (let i = 0; i < n; i++) {
        if (filter && !matchFilter(entry.meta[i], filter)) continue;
        const vec   = this._readVec(col, i);
        const score = computeScore(qNorm, vec, dims, metric);
        heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
      }
    }

    return heap.sorted();
  }

  matryoshkaSearch(col, query, limit = 5, stages = [128, 384, 768], metric = 'cosine') {
    const entry = this._load(col);
    if (entry.ids.length === 0) return [];
    if (entry.pending.length > 0) this._flushCol(col, entry);

    const factor = 4;
    const useBinary = metric === 'cosine' && entry.bin;
    const qBin  = useBinary ? BinaryQuantizedStore.quantize(query, this.dim) : null;
    const qNorm = useBinary ? null : normalize(query);
    const u8    = useBinary ? new Uint8Array(entry.bin) : null;
    const bpv   = this._bpv;

    let candidates = entry.ids.map((id, i) => ({ id, idx: i, metadata: entry.meta[i] }));

    for (let s = 0; s < stages.length; s++) {
      const dims  = Math.min(stages[s], this.dim);
      const keepN = s < stages.length - 1
        ? Math.max(limit * factor * (stages.length - s), limit) : limit;
      const heap = new TopKHeap(keepN);

      for (const c of candidates) {
        let score;
        if (useBinary) {
          score = BinaryQuantizedStore.binaryCosineSim(qBin, 0, u8, c.idx * bpv, dims);
        } else {
          const vec = this._readVec(col, c.idx);
          score = computeScore(qNorm, vec, dims, metric);
        }
        heap.push({ ...c, score });
      }
      candidates = heap.sorted();
    }

    return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
  }

  searchAcross(collections, query, limit = 5, metric = 'cosine') {
    return _normalizedSearchAcross(this, collections, query, limit, metric);
  }

  import(col, records) {
    for (const r of records) this.set(col, r.id, r.vector, r.metadata ?? {});
    return records.length;
  }

  export(col) {
    const entry = this._load(col);
    return entry.ids.map((id, i) => ({
      id, vector: this._readVec(col, i), metadata: entry.meta[i],
    }));
  }
}

// ---------------------------------------------------------------------------
// POLAR QUANTIZED STORE (3-bit, PolarQuant-inspired)
// ---------------------------------------------------------------------------
// Cada par de dimensiones se convierte a coordenadas polares (r, theta).
// Para cosine similarity solo importa la direccion (theta), no la magnitud (r).
// Theta se cuantiza a 3 bits (8 niveles) en [-PI, PI].
// Resultado: ceil(dim/2) * 3 bits = ceil(dim*3/16) bytes por vector → ~21x compresion.
//
// Antes de cuantizar, aplica una rotacion aleatoria determinista (Haar-like)
// para distribuir la energia uniformemente y mejorar la cuantizacion uniforme.
//
// Similitud: reconstruye vectores unitarios desde angulos cuantizados y calcula
// coseno directo. Mas preciso que Binary (1-bit) con compresion similar.

class PolarQuantizedStore {
  /**
   * @param {string|object} dirOrAdapter
   * @param {number} dim  Debe ser par
   * @param {object} [opts]
   * @param {number} [opts.bits=3]     Bits por angulo (2-8)
   * @param {number} [opts.seed=42]    Seed para la rotacion determinista
   * @param {string} [opts.model]      Modelo de embeddings
   */
  constructor(dirOrAdapter, dim = 768, opts = {}) {
    if (dim % 2 !== 0) throw new Error('PolarQuantizedStore: dim must be even');
    this.dim          = dim;
    this.bits         = opts.bits || 3;
    this.seed         = opts.seed ?? 42;
    this.defaultModel = opts.model || null;
    this._levels      = 1 << this.bits; // 2^bits = 8 para 3 bits
    this._pairs       = dim / 2;
    this._bitsPerVec  = this._pairs * this.bits;
    this._bytesPerVec = Math.ceil(this._bitsPerVec / 8);
    this._adapter     = typeof dirOrAdapter === 'string'
      ? new FileStorageAdapter(dirOrAdapter)
      : dirOrAdapter;
    this._collections = new Map();

    // Precomputar tabla de cos/sin para los niveles de cuantizacion
    this._cosTable = new Float64Array(this._levels);
    this._sinTable = new Float64Array(this._levels);
    for (let i = 0; i < this._levels; i++) {
      const theta = -Math.PI + (i + 0.5) * (2 * Math.PI / this._levels);
      this._cosTable[i] = Math.cos(theta);
      this._sinTable[i] = Math.sin(theta);
    }

    // Generar rotacion determinista (simplified Haar-like via seeded PRNG)
    this._rotation = this._generateRotation(dim, this.seed);
  }

  _binFile(col)  { return `${col}.p3.bin`; }
  _jsonFile(col) { return `${col}.p3.json`; }

  /** PRNG determinista (xorshift32) */
  _xorshift(state) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state >>> 0;
  }

  /** Genera una rotacion pseudo-aleatoria determinista.
   *  Usa vectores aleatorios + Gram-Schmidt simplificado en pares.
   *  No es una rotacion ortogonal completa (O(n^2)), pero distribuye energia
   *  suficientemente para mejorar cuantizacion uniforme. */
  _generateRotation(dim, seed) {
    // Generamos dim vectores de signos aleatorios para fast rotation
    // (Hadamard-like: multiplicar por signos aleatorios + shuffle)
    const signs = new Float64Array(dim);
    let state = seed || 42;
    for (let i = 0; i < dim; i++) {
      state = this._xorshift(state);
      signs[i] = (state & 1) ? 1 : -1;
    }
    // Permutacion determinista
    const perm = new Uint32Array(dim);
    for (let i = 0; i < dim; i++) perm[i] = i;
    state = seed * 7 + 13;
    for (let i = dim - 1; i > 0; i--) {
      state = this._xorshift(state);
      const j = state % (i + 1);
      const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    return { signs, perm };
  }

  /** Aplica rotacion: sign-flip + permute */
  _rotate(vec) {
    const { signs, perm } = this._rotation;
    const out = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      out[i] = vec[perm[i]] * signs[perm[i]];
    }
    return out;
  }

  /** Cuantiza un vector a angulos de 3 bits */
  _quantize(vector) {
    const norm = normalize(vector);
    const rotated = this._rotate(norm);
    const indices = new Uint8Array(this._pairs);

    for (let p = 0; p < this._pairs; p++) {
      const a = rotated[p * 2];
      const b = rotated[p * 2 + 1];
      const theta = Math.atan2(b, a); // [-PI, PI]
      // Cuantizar a nivel: floor((theta + PI) / (2*PI) * levels)
      let level = Math.floor((theta + Math.PI) / (2 * Math.PI) * this._levels);
      if (level >= this._levels) level = this._levels - 1;
      indices[p] = level;
    }

    return this._packBits(indices);
  }

  /** Empaqueta array de indices (0..levels-1) a bytes */
  _packBits(indices) {
    const buf = new Uint8Array(this._bytesPerVec);
    let bitPos = 0;
    for (let p = 0; p < this._pairs; p++) {
      const val = indices[p];
      for (let b = this.bits - 1; b >= 0; b--) {
        if (val & (1 << b)) {
          buf[bitPos >> 3] |= (1 << (7 - (bitPos & 7)));
        }
        bitPos++;
      }
    }
    return buf;
  }

  /** Desempaqueta bytes a array de indices */
  _unpackBits(packed, offset) {
    const indices = new Uint8Array(this._pairs);
    let bitPos = 0;
    for (let p = 0; p < this._pairs; p++) {
      let val = 0;
      for (let b = this.bits - 1; b >= 0; b--) {
        const byteIdx = offset + (bitPos >> 3);
        const bitIdx  = 7 - (bitPos & 7);
        if (packed[byteIdx] & (1 << bitIdx)) val |= (1 << b);
        bitPos++;
      }
      indices[p] = val;
    }
    return indices;
  }

  /** Reconstruye vector unitario desde angulos cuantizados (en espacio rotado) */
  _dequantize(packed, offset) {
    const indices = this._unpackBits(packed, offset);
    const rotated = new Float64Array(this.dim);
    for (let p = 0; p < this._pairs; p++) {
      rotated[p * 2]     = this._cosTable[indices[p]];
      rotated[p * 2 + 1] = this._sinTable[indices[p]];
    }
    // Rotacion inversa: unpermute + unsign
    const { signs, perm } = this._rotation;
    const out = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      out[perm[i]] = rotated[i] * signs[perm[i]];
    }
    return out;
  }

  /** Coseno aproximado directo entre query (float) y stored (packed bits) */
  _cosinePolar(query, packed, offset) {
    const indices = this._unpackBits(packed, offset);
    const queryRot = this._rotate(query);
    // Dot product en espacio rotado: sum( q[2p]*cos(theta_p) + q[2p+1]*sin(theta_p) )
    let dot = 0, nq = 0;
    for (let p = 0; p < this._pairs; p++) {
      const qa = queryRot[p * 2];
      const qb = queryRot[p * 2 + 1];
      dot += qa * this._cosTable[indices[p]] + qb * this._sinTable[indices[p]];
      nq += qa * qa + qb * qb;
    }
    // El vector reconstruido es unitario por construccion (cos^2+sin^2=1 por par)
    const denomQ = Math.sqrt(nq);
    return denomQ === 0 ? 0 : dot / denomQ;
  }

  // ── Collection management (same pattern as other stores) ─────

  _load(col) {
    if (this._collections.has(col)) return this._collections.get(col);
    const manifest = this._adapter.readJson(this._jsonFile(col));
    const ids   = manifest ? manifest.ids  : [];
    const meta  = manifest ? manifest.meta : [];
    const model = manifest?.model || this.defaultModel || null;
    const idMap = new Map();
    for (let i = 0; i < ids.length; i++) idMap.set(ids[i], i);
    const bin = this._adapter.readBin(this._binFile(col));
    const entry = { ids, meta, idMap, bin, model, pending: [], dirty: false };
    this._collections.set(col, entry);
    return entry;
  }

  getModel(col) { return this._load(col).model; }
  setModel(col, model) { const e = this._load(col); e.model = model; e.dirty = true; }

  set(col, id, vector, metadata = {}) {
    const entry    = this._load(col);
    const existing = entry.idMap.get(id);
    const packed   = this._quantize(vector);

    if (existing !== undefined) {
      const committed = entry.ids.length - entry.pending.length;
      if (existing < committed && entry.bin) {
        new Uint8Array(entry.bin).set(packed, existing * this._bytesPerVec);
      } else if (existing >= committed) {
        entry.pending[existing - committed].packed = packed;
      }
      entry.meta[existing] = metadata;
    } else {
      const idx = entry.ids.length;
      entry.ids.push(id);
      entry.meta.push(metadata);
      entry.idMap.set(id, idx);
      entry.pending.push({ id, packed, metadata });
    }
    entry.dirty = true;
  }

  remove(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return false;
    if (entry.pending.length > 0) this._flushCol(col, entry);

    // Swap with last
    const lastIdx = entry.ids.length - 1;
    const bpv = this._bytesPerVec;
    const u8 = new Uint8Array(entry.bin);
    if (idx !== lastIdx) {
      const lastId = entry.ids[lastIdx];
      u8.copyWithin(idx * bpv, lastIdx * bpv, (lastIdx + 1) * bpv);
      entry.ids[idx]  = lastId;
      entry.meta[idx] = entry.meta[lastIdx];
      entry.idMap.set(lastId, idx);
    }
    entry.ids.pop();
    entry.meta.pop();
    entry.idMap.delete(id);
    entry.bin = entry.bin.slice(0, entry.ids.length * bpv);
    this._adapter.writeBin(this._binFile(col), entry.bin);
    entry.dirty = true;
    return true;
  }

  drop(col) {
    this._adapter.delete(this._binFile(col));
    this._adapter.delete(this._jsonFile(col));
    this._collections.delete(col);
  }

  _flushCol(col, entry) {
    if (entry.pending.length > 0) {
      const committed = entry.ids.length - entry.pending.length;
      const total = entry.ids.length;
      const bpv = this._bytesPerVec;
      const newBuf = new ArrayBuffer(total * bpv);
      const dst = new Uint8Array(newBuf);
      if (entry.bin && committed > 0) dst.set(new Uint8Array(entry.bin, 0, committed * bpv));
      for (let p = 0; p < entry.pending.length; p++) {
        dst.set(entry.pending[p].packed, (committed + p) * bpv);
      }
      entry.bin = newBuf;
      entry.pending = [];
    }
    if (entry.bin) this._adapter.writeBin(this._binFile(col), entry.bin);
    const manifest = { ids: entry.ids, meta: entry.meta, dim: this.dim, bits: this.bits, seed: this.seed };
    if (entry.model) manifest.model = entry.model;
    this._adapter.writeJson(this._jsonFile(col), manifest);
    entry.dirty = false;
  }

  flush() {
    for (const [col, entry] of this._collections) {
      if (entry.dirty) this._flushCol(col, entry);
    }
  }

  get(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return null;
    return { id, vector: Array.from(this._readVec(col, idx)), metadata: entry.meta[idx] };
  }

  _readVec(col, idx) {
    const entry = this._collections.get(col) || this._load(col);
    const committed = entry.ids.length - entry.pending.length;
    if (idx < committed) {
      if (!entry.bin) return null;
      return this._dequantize(new Uint8Array(entry.bin), idx * this._bytesPerVec);
    }
    return this._dequantize(entry.pending[idx - committed].packed, 0);
  }

  has(col, id)  { return this._load(col).idMap.has(id); }
  count(col)    { return this._load(col).ids.length; }
  ids(col)      { return this._load(col).ids.slice(); }
  bytesPerVector() { return this._bytesPerVec; }

  search(col, query, limit = 5, dimSlice = 0, metric = 'cosine', filter = null) {
    const entry = this._load(col);
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const n    = entry.ids.length;
    const heap = new TopKHeap(limit);

    if (metric === 'cosine' && entry.bin) {
      // Fast path: coseno directo en espacio polar
      const qNorm = normalize(query);
      const u8 = new Uint8Array(entry.bin);
      const bpv = this._bytesPerVec;
      for (let i = 0; i < n; i++) {
        if (filter && !matchFilter(entry.meta[i], filter)) continue;
        const score = this._cosinePolar(qNorm, u8, i * bpv);
        heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
      }
    } else {
      const qNorm = normalize(query);
      for (let i = 0; i < n; i++) {
        if (filter && !matchFilter(entry.meta[i], filter)) continue;
        const vec   = this._readVec(col, i);
        const score = computeScore(qNorm, vec, this.dim, metric);
        heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
      }
    }
    return heap.sorted();
  }

  matryoshkaSearch(col, query, limit = 5, stages = [128, 384, 768], metric = 'cosine') {
    const entry = this._load(col);
    if (entry.ids.length === 0) return [];
    if (entry.pending.length > 0) this._flushCol(col, entry);

    // Matryoshka no aplica bien con rotacion polar — fallback a dequantize + cosine
    const factor = 4;
    let candidates = entry.ids.map((id, i) => ({ id, idx: i, metadata: entry.meta[i] }));

    for (let s = 0; s < stages.length; s++) {
      const dims  = Math.min(stages[s], this.dim);
      const keepN = s < stages.length - 1
        ? Math.max(limit * factor * (stages.length - s), limit) : limit;
      const heap = new TopKHeap(keepN);
      for (const c of candidates) {
        const vec   = this._readVec(col, c.idx);
        const score = cosineSim(query, vec, dims);
        heap.push({ ...c, score });
      }
      candidates = heap.sorted();
    }
    return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
  }

  searchAcross(collections, query, limit = 5, metric = 'cosine') {
    return _normalizedSearchAcross(this, collections, query, limit, metric);
  }

  import(col, records) {
    for (const r of records) this.set(col, r.id, r.vector, r.metadata ?? {});
    return records.length;
  }

  export(col) {
    const entry = this._load(col);
    return entry.ids.map((id, i) => ({
      id, vector: Array.from(this._readVec(col, i)), metadata: entry.meta[i],
    }));
  }
}

// ---------------------------------------------------------------------------
// IVF INDEX — OPTIMIZED (K-means sobre flat buffer)
// ---------------------------------------------------------------------------

class IVFIndex {
  constructor(store, numClusters = 100, numProbes = 10) {
    this.store       = store;
    this.numClusters = numClusters;
    this.numProbes   = numProbes;
    this._indexes    = new Map();
  }

  _indexFile(col) { return `${col}.ivf.json`; }

  _kmeansInit(flat, n, dim, k) {
    const centroids = new Float64Array(k * dim);
    const first = Math.floor(Math.random() * n);
    for (let d = 0; d < dim; d++) centroids[d] = flat[first * dim + d];
    const dists = new Float64Array(n);
    for (let c = 1; c < k; c++) {
      let total = 0;
      for (let i = 0; i < n; i++) {
        let minD = Infinity;
        for (let cc = 0; cc < c; cc++) {
          const distSq = euclideanDistSq(flat, i * dim, centroids, cc * dim, dim);
          if (distSq < minD) minD = distSq;
        }
        dists[i] = minD;
        total += minD;
      }
      let r = Math.random() * total;
      let chosen = 0;
      for (let i = 0; i < n; i++) {
        r -= dists[i];
        if (r <= 0) { chosen = i; break; }
      }
      for (let d = 0; d < dim; d++) centroids[c * dim + d] = flat[chosen * dim + d];
    }
    return centroids;
  }

  _kmeans(flat, n, dim, k, maxIter = 20) {
    const actualK    = Math.min(k, n);
    let centroids    = this._kmeansInit(flat, n, dim, actualK);
    const assignments = new Int32Array(n);
    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let bestC = 0, bestD = Infinity;
        for (let c = 0; c < actualK; c++) {
          const d = euclideanDistSq(flat, i * dim, centroids, c * dim, dim);
          if (d < bestD) { bestD = d; bestC = c; }
        }
        if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
      }
      if (!changed) break;
      const sums   = new Float64Array(actualK * dim);
      const counts = new Int32Array(actualK);
      for (let i = 0; i < n; i++) {
        const c = assignments[i];
        counts[c]++;
        const iOff = i * dim, cOff = c * dim;
        for (let d = 0; d < dim; d++) sums[cOff + d] += flat[iOff + d];
      }
      for (let c = 0; c < actualK; c++) {
        if (counts[c] > 0) {
          const cOff = c * dim;
          for (let d = 0; d < dim; d++) centroids[cOff + d] = sums[cOff + d] / counts[c];
        }
      }
    }
    const centroidArrays = [];
    for (let c = 0; c < actualK; c++) {
      centroidArrays.push(Array.from(centroids.subarray(c * dim, (c + 1) * dim)));
    }
    return { centroids: centroidArrays, assignments: Array.from(assignments) };
  }

  build(col, sampleDims = 128) {
    const entry = this.store._load(col);
    const n     = entry.ids.length;
    if (n === 0) throw new Error(`Colección vacía: ${col}`);
    if (entry.pending && entry.pending.length > 0) this.store._flushCol(col, entry);

    const dim = this.store.dim;
    let flat;

    if (this.store instanceof PolarQuantizedStore || this.store instanceof BinaryQuantizedStore) {
      // Dequantizar a flat Float64Array (generico para cualquier quantized store)
      flat = new Float64Array(n * dim);
      for (let i = 0; i < n; i++) {
        const vec = this.store._readVec(col, i);
        const iOff = i * dim;
        for (let d = 0; d < dim; d++) flat[iOff + d] = vec[d];
      }
    } else if (this.store instanceof QuantizedStore) {
      flat = new Float64Array(n * dim);
      const stride = this.store._stride;
      for (let i = 0; i < n; i++) {
        const offset = i * stride;
        const view   = new DataView(entry.bin);
        const min    = view.getFloat32(offset, true);
        const max    = view.getFloat32(offset + 4, true);
        const int8   = new Int8Array(entry.bin, offset + 8, dim);
        const range  = max - min || 1;
        const iOff   = i * dim;
        for (let d = 0; d < dim; d++) {
          flat[iOff + d] = ((int8[d] + 128) / 255) * range + min;
        }
      }
    } else {
      flat = new Float64Array(n * dim);
      const f32 = new Float32Array(entry.bin);
      for (let i = 0; i < n * dim; i++) flat[i] = f32[i];
    }

    const { centroids, assignments } = this._kmeans(flat, n, dim, this.numClusters);
    const index = { centroids, assignments, sampleDims };
    this._indexes.set(col, index);
    this.store._adapter.writeJson(this._indexFile(col), {
      centroids, assignments, sampleDims,
      numClusters: centroids.length,
      numProbes:   this.numProbes,
    });
    return { numClusters: centroids.length, numVectors: n };
  }

  _loadIndex(col) {
    if (this._indexes.has(col)) return this._indexes.get(col);
    const data = this.store._adapter.readJson(this._indexFile(col));
    if (!data) return null;
    this._indexes.set(col, data);
    return data;
  }

  hasIndex(col)   { return !!this._loadIndex(col); }
  dropIndex(col)  { this._indexes.delete(col); this.store._adapter.delete(this._indexFile(col)); }

  indexStats(col) {
    const idx = this._loadIndex(col);
    if (!idx) return null;
    return { numClusters: idx.centroids.length, numProbes: this.numProbes };
  }

  _getCandidates(col, query) {
    const idx  = this._loadIndex(col);
    if (!idx) throw new Error(`No hay índice IVF para: ${col}. Llamá a .build() primero.`);
    const { centroids, assignments } = idx;
    const dims = idx.sampleDims ?? query.length;
    const centDists = centroids.map((c, i) => ({ i, d: euclideanDist(query, c, dims) }));
    centDists.sort((a, b) => a.d - b.d);
    const probeClusters = new Set(centDists.slice(0, this.numProbes).map(x => x.i));
    const entry = this.store._load(col);
    const candidateIdxs = [];
    for (let i = 0; i < assignments.length; i++) {
      if (probeClusters.has(assignments[i])) candidateIdxs.push(i);
    }
    return { entry, candidateIdxs };
  }

  search(col, query, limit = 5) {
    const { entry, candidateIdxs } = this._getCandidates(col, query);
    const heap = new TopKHeap(limit);
    for (const idx of candidateIdxs) {
      const vec   = this.store._readVec(col, idx);
      const score = cosineSim(query, vec);
      heap.push({ id: entry.ids[idx], score, metadata: entry.meta[idx] });
    }
    return heap.sorted();
  }

  matryoshkaSearch(col, query, limit = 5, stages = [128, 256, 384]) {
    const { entry, candidateIdxs } = this._getCandidates(col, query);
    if (candidateIdxs.length === 0) return [];
    const factor = 4;
    let candidates = candidateIdxs.map(idx => ({
      id: entry.ids[idx], idx, metadata: entry.meta[idx],
    }));
    for (let s = 0; s < stages.length; s++) {
      const dims  = Math.min(stages[s], this.store.dim);
      const keepN = s < stages.length - 1
        ? Math.max(limit * factor * (stages.length - s), limit) : limit;
      const heap = new TopKHeap(keepN);
      for (const c of candidates) {
        const vec   = this.store._readVec(col, c.idx);
        const score = cosineSim(query, vec, dims);
        heap.push({ ...c, score });
      }
      candidates = heap.sorted();
    }
    return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
  }
}

// ---------------------------------------------------------------------------
// CLOUDFLARE KV ADAPTER (para Workers)
// ---------------------------------------------------------------------------
// Requiere un binding KV de Cloudflare Workers.
// Uso: new VectorStore(new CloudflareKVAdapter(env.MY_KV, 'prefix/'), 768)
//
// Todas las operaciones son async en KV, pero los stores operan sync internamente.
// Este adapter carga todo en memoria al primer acceso y escribe a KV en flush().
// Para uso en Workers: llamar await adapter.preload(collections) al inicio del request.

class CloudflareKVAdapter {
  /**
   * @param {KVNamespace} kv  Binding de Cloudflare KV
   * @param {string} [prefix]  Prefijo para las keys (ej: 'vectors/')
   */
  constructor(kv, prefix = '') {
    this.kv     = kv;
    this.prefix = prefix;
    this._cache = new Map(); // key → { type: 'bin'|'json', data }
  }

  _key(filename) { return this.prefix + filename; }

  /**
   * Precarga colecciones desde KV a memoria.
   * Llamar al inicio del request con los nombres de archivos esperados.
   * @param {string[]} filenames  Ej: ['docs.bin', 'docs.json']
   */
  async preload(filenames) {
    const promises = filenames.map(async (f) => {
      const key = this._key(f);
      if (f.endsWith('.json')) {
        const val = await this.kv.get(key, 'json');
        if (val) this._cache.set(f, { type: 'json', data: val });
      } else {
        const val = await this.kv.get(key, 'arrayBuffer');
        if (val) this._cache.set(f, { type: 'bin', data: val });
      }
    });
    await Promise.all(promises);
  }

  readBin(filename) {
    const cached = this._cache.get(filename);
    return cached && cached.type === 'bin' ? cached.data : null;
  }

  writeBin(filename, buffer) {
    this._cache.set(filename, { type: 'bin', data: buffer });
  }

  readJson(filename) {
    const cached = this._cache.get(filename);
    return cached && cached.type === 'json' ? cached.data : null;
  }

  writeJson(filename, data) {
    this._cache.set(filename, { type: 'json', data });
  }

  delete(filename) {
    this._cache.delete(filename);
  }

  /**
   * Persiste todos los cambios en cache a Cloudflare KV.
   * Llamar despues de store.flush().
   */
  async persist() {
    const promises = [];
    for (const [filename, entry] of this._cache) {
      const key = this._key(filename);
      if (entry.type === 'json') {
        promises.push(this.kv.put(key, JSON.stringify(entry.data)));
      } else {
        promises.push(this.kv.put(key, entry.data));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Elimina una key de KV.
   */
  async deleteFromKV(filename) {
    this._cache.delete(filename);
    await this.kv.delete(this._key(filename));
  }
}

// ---------------------------------------------------------------------------
// BM25 INDEX (Okapi BM25 full-text search)
// ---------------------------------------------------------------------------
// Port de php-vector-store BM25\Index + SimpleTokenizer
// Inverted index con IDF + term frequency normalization

/**
 * Tokenizer simple: lowercase, split en non-alphanumeric, filtrar stop words.
 */
class SimpleTokenizer {
  constructor(stopWords = null, minLength = 2) {
    this.minLength = minLength;
    const words = stopWords || SimpleTokenizer.DEFAULT_STOP_WORDS;
    this.stopWords = new Set(words);
  }

  tokenize(text) {
    return text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length >= this.minLength && !this.stopWords.has(t));
  }
}

SimpleTokenizer.DEFAULT_STOP_WORDS = [
  'a','about','above','after','again','against','all','am','an','and','any','are',
  'aren\'t','as','at','be','because','been','before','being','below','between','both',
  'but','by','can\'t','cannot','could','couldn\'t','did','didn\'t','do','does','doesn\'t',
  'doing','don\'t','down','during','each','few','for','from','further','get','got','had',
  'hadn\'t','has','hasn\'t','have','haven\'t','having','he','her','here','hers','herself',
  'him','himself','his','how','i','if','in','into','is','isn\'t','it','its','itself',
  'let\'s','me','more','most','mustn\'t','my','myself','no','nor','not','of','off','on',
  'once','only','or','other','ought','our','ours','ourselves','out','over','own','same',
  'shan\'t','she','should','shouldn\'t','so','some','such','than','that','the','their',
  'theirs','them','themselves','then','there','these','they','this','those','through','to',
  'too','under','until','up','very','was','wasn\'t','we','were','weren\'t','what','when',
  'where','which','while','who','whom','why','will','with','won\'t','would','wouldn\'t',
  'you','your','yours','yourself','yourselves',
  // Spanish
  'el','la','los','las','un','una','unos','unas','de','del','al','en','con','por','para',
  'es','son','fue','ser','como','pero','su','sus','se','le','les','lo','que','y','o','no',
  'si','mi','tu','nos','mas','este','esta','estos','estas','ese','esa','esos','esas',
];

/**
 * BM25 Index: inverted index con Okapi BM25 scoring.
 */
class BM25Index {
  /**
   * @param {object} [opts]
   * @param {number} [opts.k1=1.5]  Term frequency saturation
   * @param {number} [opts.b=0.75]  Length normalization (0-1)
   * @param {SimpleTokenizer|object} [opts.tokenizer]  Debe tener .tokenize(text)
   */
  constructor(opts = {}) {
    this.k1 = opts.k1 ?? 1.5;
    this.b  = opts.b  ?? 0.75;
    this.tokenizer = opts.tokenizer || new SimpleTokenizer();

    // Per-collection data:
    // invertedIndex[col][term][docId] = tf
    // docLengths[col][docId] = tokenCount
    // totalTokens[col] = int
    // docCount[col] = int
    this._data = new Map();
  }

  _getCol(col) {
    if (!this._data.has(col)) {
      this._data.set(col, {
        invertedIndex: new Map(),
        docLengths: new Map(),
        totalTokens: 0,
        docCount: 0,
      });
    }
    return this._data.get(col);
  }

  /**
   * Agrega un documento al indice BM25.
   */
  addDocument(col, id, text) {
    const d = this._getCol(col);
    // Si ya existe, remover primero
    if (d.docLengths.has(id)) this.removeDocument(col, id);

    const tokens = this.tokenizer.tokenize(text);
    d.docLengths.set(id, tokens.length);
    d.totalTokens += tokens.length;
    d.docCount++;

    // Contar term frequencies
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

    for (const [term, freq] of tf) {
      if (!d.invertedIndex.has(term)) d.invertedIndex.set(term, new Map());
      d.invertedIndex.get(term).set(id, freq);
    }
  }

  removeDocument(col, id) {
    const d = this._data.get(col);
    if (!d || !d.docLengths.has(id)) return;

    const dl = d.docLengths.get(id);
    d.totalTokens -= dl;
    d.docCount--;
    d.docLengths.delete(id);

    for (const [term, postings] of d.invertedIndex) {
      postings.delete(id);
      if (postings.size === 0) d.invertedIndex.delete(term);
    }
  }

  count(col) { return this._data.has(col) ? this._data.get(col).docCount : 0; }

  vocabularySize(col) {
    return this._data.has(col) ? this._data.get(col).invertedIndex.size : 0;
  }

  /**
   * Calcula BM25 scores para todos los docs contra un query.
   * @returns {Map<string, number>} docId → score
   */
  scoreAll(col, query) {
    const d = this._data.get(col);
    if (!d || d.docCount === 0) return new Map();

    const queryTokens = this.tokenizer.tokenize(query);
    const N    = d.docCount;
    const avgDl = d.totalTokens / N;
    const scores = new Map();

    for (const term of queryTokens) {
      const postings = d.invertedIndex.get(term);
      if (!postings) continue;

      const df  = postings.size;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0);

      for (const [docId, tf] of postings) {
        const dl     = d.docLengths.get(docId);
        const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * dl / avgDl));
        const score  = idf * tfNorm;
        scores.set(docId, (scores.get(docId) || 0) + score);
      }
    }

    return scores;
  }

  /**
   * Busca los top-K documentos por BM25.
   * @returns {{ id: string, score: number }[]}
   */
  search(col, query, limit = 10) {
    const scores = this.scoreAll(col, query);
    const heap = new TopKHeap(limit);
    for (const [id, score] of scores) {
      heap.push({ id, score });
    }
    return heap.sorted();
  }

  /** Exporta el estado para persistencia. */
  exportState(col) {
    const d = this._data.get(col);
    if (!d) return null;
    return {
      totalTokens: d.totalTokens,
      docCount:    d.docCount,
      docLengths:  Object.fromEntries(d.docLengths),
      invertedIndex: Object.fromEntries(
        Array.from(d.invertedIndex).map(([term, postings]) =>
          [term, Object.fromEntries(postings)]
        )
      ),
    };
  }

  /** Importa estado desde persistencia. */
  importState(col, state) {
    const d = this._getCol(col);
    d.totalTokens = state.totalTokens;
    d.docCount    = state.docCount;
    d.docLengths  = new Map(Object.entries(state.docLengths).map(([k, v]) => [k, v]));
    d.invertedIndex = new Map(
      Object.entries(state.invertedIndex).map(([term, postings]) =>
        [term, new Map(Object.entries(postings).map(([k, v]) => [k, v]))]
      )
    );
  }

  /** Guarda a un adapter (compatible con el patron de los stores). */
  save(adapter, col) {
    const state = this.exportState(col);
    if (state) adapter.writeJson(`${col}.bm25.json`, state);
  }

  /** Carga desde un adapter. */
  load(adapter, col) {
    const state = adapter.readJson(`${col}.bm25.json`);
    if (state) this.importState(col, state);
  }
}

// ---------------------------------------------------------------------------
// HYBRID SEARCH (Vector + BM25 fusion)
// ---------------------------------------------------------------------------
// Dos modos de fusion:
//   'rrf'      → Reciprocal Rank Fusion: score = sum(1/(k+rank)) por cada sistema
//   'weighted' → Min-max normalize + weighted sum

class HybridSearch {
  /**
   * @param {VectorStore|QuantizedStore|BinaryQuantizedStore} store
   * @param {BM25Index} bm25
   * @param {'rrf'|'weighted'} mode
   */
  constructor(store, bm25, mode = 'rrf') {
    this.store = store;
    this.bm25  = bm25;
    this.mode  = mode;
  }

  /**
   * Búsqueda híbrida: combina vector similarity + BM25 text relevance.
   *
   * @param {string} col         Colección
   * @param {number[]} vector    Query vector (embedding)
   * @param {string} text        Query text (para BM25)
   * @param {number} [limit=5]
   * @param {object} [opts]
   * @param {number} [opts.vectorWeight=0.5]  Peso para vector (modo weighted)
   * @param {number} [opts.textWeight=0.5]    Peso para BM25 (modo weighted)
   * @param {number} [opts.rrfK=60]           K para RRF
   * @param {number} [opts.fetchK]            Candidatos del vector search (default: max(limit*3,50))
   * @param {string} [opts.metric='cosine']
   */
  search(col, vector, text, limit = 5, opts = {}) {
    const vectorWeight = opts.vectorWeight ?? 0.5;
    const textWeight   = opts.textWeight   ?? 0.5;
    const rrfK         = opts.rrfK         ?? 60;
    const fetchK       = opts.fetchK       ?? Math.max(limit * 3, 50);
    const metric       = opts.metric       ?? 'cosine';

    // 1. Vector search
    const vecResults = this.store.search(col, vector, fetchK, 0, metric);

    // 2. BM25 search
    const bm25Scores = this.bm25.scoreAll(col, text);

    // 3. Fusion
    if (this.mode === 'rrf') {
      return this._fuseRRF(vecResults, bm25Scores, limit, rrfK);
    } else {
      return this._fuseWeighted(vecResults, bm25Scores, limit, vectorWeight, textWeight);
    }
  }

  /**
   * Reciprocal Rank Fusion.
   * score(d) = sum(1 / (k + rank_i)) para cada sistema donde d aparece
   */
  _fuseRRF(vecResults, bm25Scores, limit, rrfK) {
    const fused = new Map(); // id → { score, metadata }

    // Vector ranking
    for (let r = 0; r < vecResults.length; r++) {
      const v = vecResults[r];
      const rrfScore = 1 / (rrfK + r + 1);
      const entry = fused.get(v.id) || { score: 0, metadata: v.metadata };
      entry.score += rrfScore;
      fused.set(v.id, entry);
    }

    // BM25 ranking (ordenar por score para obtener rank)
    const bm25Sorted = Array.from(bm25Scores.entries())
      .sort((a, b) => b[1] - a[1]);

    for (let r = 0; r < bm25Sorted.length; r++) {
      const [id, _score] = bm25Sorted[r];
      const rrfScore = 1 / (rrfK + r + 1);
      const entry = fused.get(id) || { score: 0, metadata: {} };
      entry.score += rrfScore;
      fused.set(id, entry);
    }

    const heap = new TopKHeap(limit);
    for (const [id, entry] of fused) {
      heap.push({ id, score: Math.round(entry.score * 1e6) / 1e6, metadata: entry.metadata });
    }
    return heap.sorted();
  }

  /**
   * Weighted fusion con min-max normalization.
   */
  _fuseWeighted(vecResults, bm25Scores, limit, vectorWeight, textWeight) {
    // Normalizar vector scores a [0,1]
    let vecMin = Infinity, vecMax = -Infinity;
    for (const r of vecResults) {
      if (r.score < vecMin) vecMin = r.score;
      if (r.score > vecMax) vecMax = r.score;
    }
    const vecRange = vecMax - vecMin;

    // Normalizar BM25 scores a [0,1]
    let bm25Min = Infinity, bm25Max = -Infinity;
    for (const [, s] of bm25Scores) {
      if (s < bm25Min) bm25Min = s;
      if (s > bm25Max) bm25Max = s;
    }
    const bm25Range = bm25Max - bm25Min;

    // Fusionar
    const fused = new Map();

    for (const r of vecResults) {
      const normVec = vecRange > 0 ? (r.score - vecMin) / vecRange : 1.0;
      const normBm25 = bm25Scores.has(r.id)
        ? (bm25Range > 0 ? (bm25Scores.get(r.id) - bm25Min) / bm25Range : 1.0)
        : 0;
      fused.set(r.id, {
        score: vectorWeight * normVec + textWeight * normBm25,
        metadata: r.metadata,
      });
    }

    // Docs que estan en BM25 pero no en vector results
    for (const [id, bm25Score] of bm25Scores) {
      if (!fused.has(id)) {
        const normBm25 = bm25Range > 0 ? (bm25Score - bm25Min) / bm25Range : 1.0;
        fused.set(id, { score: textWeight * normBm25, metadata: {} });
      }
    }

    const heap = new TopKHeap(limit);
    for (const [id, entry] of fused) {
      heap.push({ id, score: Math.round(entry.score * 1e6) / 1e6, metadata: entry.metadata });
    }
    return heap.sorted();
  }

  /**
   * Búsqueda híbrida en múltiples colecciones.
   */
  searchAcross(collections, vector, text, limit = 5, opts = {}) {
    const heap = new TopKHeap(limit);
    for (const col of collections) {
      const results = this.search(col, vector, text, limit, opts);
      for (const r of results) {
        heap.push({ ...r, collection: col });
      }
    }
    return heap.sorted();
  }
}

// ---------------------------------------------------------------------------
// RERANKER (cross-encoder para búsqueda cross-model)
// ---------------------------------------------------------------------------
// Toma candidatos de múltiples stores/modelos, reranquea con un cross-encoder
// que evalúa (query_text, doc_text) directamente — independiente del embedding.

class Reranker {
  /**
   * @param {object} opts
   * @param {string} opts.apiUrl   URL del reranker API
   * @param {string} opts.apiToken Bearer token
   * @param {string} [opts.model]  Modelo (default: @cf/baai/bge-reranker-base)
   */
  constructor({ apiUrl, apiToken, model } = {}) {
    this.apiUrl   = apiUrl;
    this.apiToken = apiToken;
    this.model    = model || '@cf/baai/bge-reranker-base';
  }

  /**
   * Crea un Reranker configurado para Cloudflare Workers AI.
   * @param {string} accountId
   * @param {string} apiToken
   * @param {string} [model]
   */
  static cloudflare(accountId, apiToken, model) {
    return new Reranker({
      apiUrl:   `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model || '@cf/baai/bge-reranker-base'}`,
      apiToken,
      model:    model || '@cf/baai/bge-reranker-base',
    });
  }

  /**
   * Reranquea documentos contra un query usando el cross-encoder.
   * @param {string} query         Texto del query
   * @param {string[]} documents   Textos de los documentos candidatos
   * @returns {Promise<{index: number, score: number}[]>} Ordenados por score desc
   */
  async rank(query, documents) {
    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        query,
        contexts: documents.map(d => typeof d === 'string' ? { text: d } : d),
      }),
    });

    if (!res.ok) {
      throw new Error(`Reranker error ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    // Workers AI retorna: { result: { response: [{ id, score }] } }
    const data = json.result?.response || json.result?.data || json.result;
    if (!Array.isArray(data)) {
      throw new Error('Reranker: unexpected response format');
    }

    // Normalizar: Workers AI usa 'id' como indice, mapeamos a 'index'
    const normalized = data.map(r => ({
      index: r.id ?? r.index,
      score: r.score,
    }));

    return normalized.sort((a, b) => b.score - a.score);
  }

  /**
   * Búsqueda cross-model: busca en múltiples stores (pueden usar modelos distintos),
   * recolecta candidatos, y reranquea con el cross-encoder.
   *
   * @param {string} queryText                El texto del query (no el vector)
   * @param {Array<{store, collection, queryVector}>} sources
   *   Cada source tiene: store (VectorStore/QuantizedStore/BinaryQuantizedStore),
   *   collection (string), queryVector (el embedding del query para ese modelo)
   * @param {object} [opts]
   * @param {number} [opts.candidatesPerSource=10]  Cuántos candidatos por source
   * @param {number} [opts.limit=5]                 Resultados finales
   * @param {string} [opts.textField='text']        Campo de metadata con el texto
   * @returns {Promise<Array<{id, score, metadata, source}>>}
   */
  async crossModelSearch(queryText, sources, opts = {}) {
    const candidatesPerSource = opts.candidatesPerSource || 10;
    const limit    = opts.limit || 5;
    const textField = opts.textField || 'text';

    // 1. Buscar candidatos en cada source
    const allCandidates = [];
    for (let si = 0; si < sources.length; si++) {
      const { store, collection, queryVector } = sources[si];
      const results = store.search(collection, queryVector, candidatesPerSource);
      for (const r of results) {
        const text = r.metadata?.[textField];
        if (text) {
          allCandidates.push({
            id:         r.id,
            text,
            metadata:   r.metadata,
            sourceIdx:  si,
            collection,
            origScore:  r.score,
          });
        }
      }
    }

    if (allCandidates.length === 0) return [];

    // 2. Reranquear todos los candidatos con el cross-encoder
    const documents = allCandidates.map(c => c.text);
    const ranked = await this.rank(queryText, documents);

    // 3. Mapear resultados
    const results = [];
    for (const r of ranked) {
      if (results.length >= limit) break;
      const candidate = allCandidates[r.index];
      results.push({
        id:         candidate.id,
        score:      r.score,
        metadata:   candidate.metadata,
        collection: candidate.collection,
        origScore:  candidate.origScore,
      });
    }

    return results;
  }

  /**
   * Búsqueda automática cross-model: lee el modelo de cada colección del manifest,
   * genera embeddings automáticamente, busca, y reranquea.
   *
   * @param {string} queryText          Texto del query
   * @param {object} store              Store (VectorStore/QuantizedStore/BinaryQuantizedStore)
   * @param {string[]} collections      Nombres de colecciones a buscar
   * @param {function} embedFn          async (text, model) => float[] — genera embedding
   * @param {object} [opts]
   * @param {number} [opts.candidatesPerSource=10]
   * @param {number} [opts.limit=5]
   * @param {string} [opts.textField='text']
   * @returns {Promise<Array<{id, score, metadata, collection}>>}
   */
  async autoSearch(queryText, store, collections, embedFn, opts = {}) {
    const candidatesPerSource = opts.candidatesPerSource || 10;
    const limit     = opts.limit || 5;
    const textField = opts.textField || 'text';

    // 1. Agrupar colecciones por modelo
    const byModel = new Map(); // model → [collection, ...]
    for (const col of collections) {
      const model = store.getModel(col);
      if (!model) throw new Error(`Collection "${col}" has no model set. Use store.setModel('${col}', 'model-name') or pass model in constructor.`);
      if (!byModel.has(model)) byModel.set(model, []);
      byModel.get(model).push(col);
    }

    // 2. Generar un embedding por modelo (una sola llamada por modelo)
    const embeddings = new Map(); // model → vector
    const embedPromises = [];
    for (const model of byModel.keys()) {
      embedPromises.push(
        embedFn(queryText, model).then(vec => embeddings.set(model, vec))
      );
    }
    await Promise.all(embedPromises);

    // 3. Buscar en cada coleccion con el embedding de su modelo
    const sources = collections.map(col => ({
      store,
      collection: col,
      queryVector: embeddings.get(store.getModel(col)),
    }));

    // 4. Recolectar candidatos y reranquear
    return this.crossModelSearch(queryText, sources, {
      candidatesPerSource, limit, textField,
    });
  }
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  VectorStore,
  QuantizedStore,
  BinaryQuantizedStore,
  PolarQuantizedStore,
  IVFIndex,
  BM25Index,
  SimpleTokenizer,
  HybridSearch,
  Reranker,
  FileStorageAdapter,
  MemoryStorageAdapter,
  CloudflareKVAdapter,
  TopKHeap,
  // Math utils
  normalize,
  cosineSim,
  euclideanDist,
  dotProduct,
  manhattanDist,
  computeScore,
  matchFilter,
};
