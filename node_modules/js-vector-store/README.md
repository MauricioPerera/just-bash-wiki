# js-vector-store

Port vanilla JS de [php-vector-store](https://github.com/MauricioPerera/php-vector-store). Zero dependencias — funciona en Node.js y browser (con adaptador de storage).

## Caracteristicas

- **VectorStore** — Float32, `dim * 4` bytes/vector
- **QuantizedStore** — Int8, `dim + 8` bytes/vector (~4x mas compacto)
- **PolarQuantizedStore** — 3-bit angles, `ceil(dim*3/16)` bytes/vector (~21x, PolarQuant-inspired)
- **BinaryQuantizedStore** — 1-bit, `ceil(dim/8)` bytes/vector (~32x mas compacto)
- **IVFIndex** — K-means clustering sobre cualquiera de los stores
- **4 metricas de distancia** — Cosine, Euclidean, DotProduct, Manhattan
- **Matryoshka search** — busqueda multi-stage con slices dimensionales progresivos
- **Cross-collection search** — con score normalization entre colecciones
- Zero dependencias, 100% vanilla JS
- Compatible con cualquier modelo de embeddings (OpenAI, Gemma, BGE, Cohere, etc.)

## Instalacion

```bash
# Copiar el archivo directamente
cp js-vector-store.js tu-proyecto/
```

```js
const {
  VectorStore,
  QuantizedStore,
  PolarQuantizedStore,
  BinaryQuantizedStore,
  IVFIndex,
  MemoryStorageAdapter,
  FileStorageAdapter,
  normalize,
  cosineSim,
  computeScore,
  manhattanDist,
} = require('./js-vector-store');
```

## Quick Start

### Basico (en memoria)

```js
const store = new VectorStore(new MemoryStorageAdapter(), 768);

// Indexar
store.set('docs', 'doc-1', embedding, { title: 'Mi documento' });
store.set('docs', 'doc-2', embedding2, { title: 'Otro documento' });
store.flush();

// Buscar
const results = store.search('docs', queryEmbedding, 5);
// [{ id: 'doc-1', score: 0.92, metadata: { title: 'Mi documento' } }, ...]
```

### Persistente (disco)

```js
const store = new VectorStore('./data/vectors', 768);

store.set('articles', 'art-1', embedding, { text: 'Contenido...' });
store.flush(); // escribe a disco

// En otra sesion, carga automaticamente desde disco:
const store2 = new VectorStore('./data/vectors', 768);
const results = store2.search('articles', query, 5);
```

### Con embeddings reales (Workers AI)

```js
// Generar embedding via Cloudflare Workers AI
async function embed(text) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/google/embeddinggemma-300m`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [text] }),
    }
  );
  const json = await res.json();
  return json.result.data[0]; // float[768]
}

const store = new VectorStore(new MemoryStorageAdapter(), 768);

// Indexar documentos
const vec = await embed('La IA esta revolucionando la medicina');
store.set('docs', 'doc-1', vec, { text: 'La IA esta revolucionando la medicina' });
store.flush();

// Buscar
const qVec = await embed('inteligencia artificial en salud');
const results = store.search('docs', qVec, 5);
```

## API

### VectorStore

```js
const store = new VectorStore(dirOrAdapter, dim = 768, maxCollections = 50);
```

| Metodo | Descripcion |
|---|---|
| `set(col, id, vector, metadata?)` | Inserta o actualiza un vector |
| `get(col, id)` | Obtiene `{ id, vector, metadata }` o `null` |
| `remove(col, id)` | Elimina un vector, retorna `boolean` |
| `has(col, id)` | Existe el ID? |
| `count(col)` | Cantidad de vectores |
| `ids(col)` | Array de IDs |
| `drop(col)` | Elimina una coleccion completa |
| `flush()` | Persiste cambios pendientes a storage |
| `search(col, query, limit?, dimSlice?, metric?)` | Busqueda brute-force (metric: 'cosine'\|'euclidean'\|'dotProduct'\|'manhattan') |
| `matryoshkaSearch(col, query, limit?, stages?, metric?)` | Busqueda multi-stage dimensional |
| `searchAcross(collections, query, limit?, metric?)` | Busqueda cross-collection con score normalization |
| `import(col, records)` | Importa `[{ id, vector, metadata }]` |
| `export(col)` | Exporta todos los registros |
| `stats()` | Estadisticas de colecciones cargadas |
| `collections()` | Lista de nombres de colecciones |

### QuantizedStore

Misma API que `VectorStore`. Cuantiza automaticamente a Int8 al insertar, dequantiza al leer.

```js
const store = new QuantizedStore(dirOrAdapter, dim = 768);
```

**Cuantizacion**: Cada vector se almacena como `[min: f32][max: f32][d0..dN: int8]` = `8 + dim` bytes.

### PolarQuantizedStore (3-bit, PolarQuant-inspired)

Inspirado en [TurboQuant de Google (ICLR 2026)](https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/). Cuantiza angulos polares a 3 bits — 21x compresion con 100% recall. El mejor tradeoff compresion/calidad.

```js
const store = new PolarQuantizedStore(dirOrAdapter, dim = 768, {
  bits: 3,    // 2-8 bits por angulo (default: 3)
  seed: 42,   // seed para rotacion determinista
});

store.set('docs', 'doc-1', embedding, { text: '...' });
store.flush();

const results = store.search('docs', queryVec, 5);
```

**Como funciona**:
1. Normaliza el vector (L2)
2. Aplica rotacion determinista (sign-flip + permute) para distribuir energia
3. Agrupa dimensiones en pares → coordenadas polares (r, theta)
4. Descarta el radio (irrelevante para coseno)
5. Cuantiza theta a 3 bits (8 niveles) en [-PI, PI]

**Search**: Calcula coseno directamente en espacio polar rotado — sin dequantizar.

**Bits configurables**:

| Bits | Bytes/vec (768d) | Compresion | Top-1 | Recall@5 |
|---|---|---|---|---|
| 2 | 96 | 32x | 100% | 85% |
| **3** | **144** | **21x** | **100%** | **100%** |
| 4 | 192 | 16x | 100% | 95% |
| 5 | 240 | 12.8x | 100% | 95% |

3 bits es el sweet spot: misma recall que Float32, 21x mas compacto.

### BinaryQuantizedStore

Cuantizacion extrema a 1-bit por dimension. 32x compresion vs Float32. Ideal para pre-filtrado rapido en datasets grandes.

```js
const store = new BinaryQuantizedStore(dirOrAdapter, dim = 768);

store.set('docs', 'doc-1', embedding, { text: '...' });
store.flush();

// Search usa Hamming distance (XOR + popcount) — ultra rapido
const results = store.search('docs', queryVec, 5);
```

**Cuantizacion**: Cada float se reduce a su bit de signo (`>= 0 → 1, < 0 → 0`). Empaquetado MSB-first.

**Similitud**: `cosine_approx = 1.0 - 2.0 * hamming_distance / dims`

### Comparacion de stores

| Store | Bytes/vec (768d) | Compresion | Top-1 | Recall@5 | Uso ideal |
|---|---|---|---|---|---|
| Float32 | 3,072 | 1x | 100% | 100% | Precision maxima |
| Int8 | 776 | 4x | 100% | 100% | Balance general |
| **Polar 3-bit** | **144** | **21x** | **100%** | **100%** | **Mejor tradeoff** |
| Binary 1-bit | 96 | 32x | 100% | 85% | Pre-filtrado / max compresion |

Memory footprint para 1M vectores (768d):

| Store | 1M vecs |
|---|---|
| Float32 | 2.93 GB |
| Int8 | 740 MB |
| Polar 3-bit | 137 MB |
| Binary | 91.6 MB |

### IVFIndex

Indice de archivos invertidos con K-means clustering. Se monta sobre un `VectorStore`, `QuantizedStore`, o `BinaryQuantizedStore`.

```js
const ivf = new IVFIndex(store, numClusters = 100, numProbes = 10);

// Construir indice (necesario antes de buscar)
ivf.build('docs');

// Buscar (solo explora numProbes clusters)
ivf.search('docs', queryVec, 5);

// IVF + Matryoshka
ivf.matryoshkaSearch('docs', queryVec, 5, [128, 384, 768]);
```

| Metodo | Descripcion |
|---|---|
| `build(col, sampleDims?)` | Construye el indice K-means |
| `search(col, query, limit?)` | Busqueda IVF |
| `matryoshkaSearch(col, query, limit?, stages?)` | IVF + Matryoshka combinado |
| `hasIndex(col)` | Tiene indice construido? |
| `dropIndex(col)` | Elimina el indice |
| `indexStats(col)` | `{ numClusters, numProbes }` |

### Storage Adapters

```js
// Node.js (disco)
const store = new VectorStore('./data/vectors', 768);
// equivalente a:
const store = new VectorStore(new FileStorageAdapter('./data/vectors'), 768);

// Memoria (tests, browser)
const store = new VectorStore(new MemoryStorageAdapter(), 768);

// Cloudflare Workers KV
const adapter = new CloudflareKVAdapter(env.MY_KV, 'vectors/');
await adapter.preload(['docs.bin', 'docs.json']); // cargar al inicio del request
const store = new VectorStore(adapter, 768);
const results = store.search('docs', queryVec, 5);
store.flush();
await adapter.persist(); // escribir cambios a KV

// Custom adapter (implementar esta interfaz):
class MyAdapter {
  readBin(filename)         { /* → ArrayBuffer | null */ }
  writeBin(filename, buffer) { /* ArrayBuffer → void  */ }
  readJson(filename)         { /* → object | null      */ }
  writeJson(filename, data)  { /* object → void        */ }
  delete(filename)           { /* void                 */ }
}
```

### Math Utils

```js
const { normalize, cosineSim, euclideanDist, dotProduct, manhattanDist, computeScore } = require('./js-vector-store');

normalize([1, 2, 3]);              // vector unitario L2
cosineSim(a, b);                   // similitud coseno [-1, 1]
cosineSim(a, b, 128);              // solo primeras 128 dims
euclideanDist(a, b);               // distancia euclidiana
dotProduct(a, b);                  // producto punto
manhattanDist(a, b);               // distancia Manhattan (L1)
computeScore(a, b, 768, 'cosine'); // dispatcher: cosine|euclidean|dotProduct|manhattan
```

## Metricas de distancia

Todos los stores soportan 4 metricas via el parametro `metric`:

```js
store.search('docs', query, 5, 0, 'cosine');     // default — similitud coseno
store.search('docs', query, 5, 0, 'euclidean');   // 1/(1+dist) — mayor = mas cercano
store.search('docs', query, 5, 0, 'dotProduct');  // producto punto directo
store.search('docs', query, 5, 0, 'manhattan');   // 1/(1+L1) — mayor = mas cercano
```

`BinaryQuantizedStore` con `metric='cosine'` usa **Hamming distance** nativo (XOR + popcount), que es ordenes de magnitud mas rapido que dequantizar. Para otras metricas, dequantiza a +1/-1 y calcula normalmente.

## Cross-collection search con score normalization

`searchAcross` normaliza scores por coleccion a [0,1] antes de mergear, lo que permite comparar resultados de colecciones con distribuciones de score distintas:

```js
store.searchAcross(['articles', 'products', 'users'], query, 10);
```

## Busqueda Matryoshka

Para modelos que soportan [Matryoshka embeddings](https://arxiv.org/abs/2205.13147), la busqueda multi-stage filtra progresivamente con slices dimensionales crecientes:

```js
// Stage 1: evalua todos con 128 dims (rapido, filtro grueso)
// Stage 2: top candidatos con 384 dims (mas preciso)
// Stage 3: finalistas con 768 dims (precision completa)
store.matryoshkaSearch('docs', query, 5, [128, 384, 768]);
```

## Guia de configuracion IVF

| Dataset | Clusters (K) | Probes (P) | Notas |
|---|---|---|---|
| < 1,000 | No usar IVF | — | Brute-force es suficiente |
| 1,000 - 10,000 | 25-50 | 3-10 | Buen balance speed/recall |
| 10,000 - 100,000 | 50-200 | 5-20 | Ajustar P segun recall requerido |
| > 100,000 | 100-500 | 10-50 | Mas clusters, mas probes |

**Regla general**: `K ≈ sqrt(N)`, `P ≈ K * 0.1` a `K * 0.2`

## Benchmark

Resultados con **EmbeddingGemma 300M** (768 dims) via Cloudflare Workers AI:

### Search (brute-force, Float32)

| Vectores | Latencia | Ops/sec |
|---|---|---|
| 100 | 0.9ms | 1,070 |
| 1,000 | 8.4ms | 119 |
| 5,000 | 49.8ms | 20 |
| 10,000 | 114ms | 8.8 |

### Insert (escritura diferida)

| Vectores | Latencia/vec |
|---|---|
| 1,000 | 0.50ms |
| 5,000 | 0.34ms |
| 10,000 | 0.41ms |

### IVF Speedup (N=5,000)

| Config | Search | Speedup |
|---|---|---|
| K=100 P=10 | 7.1ms | **27.4x** |
| K=50 P=10 | 13.6ms | **14.3x** |
| K=50 P=5 | 26.6ms | **7.3x** |

### Float32 vs Int8 (QuantizedStore)

| Metrica | Valor |
|---|---|
| Recall@5 | **100%** (orden identico) |
| Storage savings | **75%** (776 bytes vs 3,072 bytes/vec) |
| Score difference | < 0.001 |

### Memory footprint

| Format | 1K vecs | 10K vecs | 100K vecs | 1M vecs |
|---|---|---|---|---|
| Float32 768d | 2.93 MB | 29.3 MB | 293 MB | 2.93 GB |
| Int8 768d | 758 KB | 7.4 MB | 74 MB | 740 MB |
| Polar 3-bit 768d | 141 KB | 1.37 MB | 13.7 MB | 137 MB |
| Binary 768d | 93.8 KB | 938 KB | 9.2 MB | 91.6 MB |

## Arquitectura interna

```
Coleccion "articles"
├── articles.bin          Float32 buffer contiguo (dim * 4 bytes/vec)
├── articles.json         Manifest: { ids[], meta[], dim }
├── articles.q8.bin       Int8 buffer: [min:f32][max:f32][int8 x dim] por vec
├── articles.q8.json      Manifest cuantizado
├── articles.p3.bin       Polar 3-bit: ceil(dim*3/16) bytes/vec, angle-quantized
├── articles.p3.json      Manifest polar: { ids, meta, dim, bits, seed }
├── articles.b1.bin       Binary 1-bit: ceil(dim/8) bytes/vec, sign-bit MSB-first
├── articles.b1.json      Manifest binario
└── articles.ivf.json     Indice IVF: { centroids, assignments, sampleDims }
```

**Optimizaciones clave**:
- Buffer binario cacheado en memoria — `_readVec` retorna views zero-copy (Float32Array subarray)
- Escritura diferida — `set()` acumula en pending, `flush()` escribe una vez
- Map de IDs — lookup O(1) en vez de O(n)
- Min-heap para top-K — O(n log k) en vez de O(n log n)
- K-means sobre flat Float64Array contiguos — sin allocations por iteracion

## Ecosistema

Este repo contiene tres modulos independientes que comparten storage adapters:

| Modulo | Archivo | Que hace |
|---|---|---|
| **js-vector-store** | `js-vector-store.js` | Busqueda semantica: embeddings, similarity, IVF, Matryoshka, reranking |
| **[js-doc-store](https://github.com/MauricioPerera/js-doc-store)** | Repo separado | Document database: CRUD, queries, indices, joins, aggregation, auth, encriptacion |
| **js-vector-server** | `server/` | REST API sobre Cloudflare Workers + KV |

Cada uno es un solo archivo JS, zero dependencias, corre en Node/browser/Workers/Deno.

- [Documentacion js-vector-store](README.md) (este archivo)
- [Documentacion js-doc-store](https://github.com/MauricioPerera/js-doc-store)
- [Documentacion server](server/README.md)

## Creditos

Creado por [Mauricio Perera](https://www.linkedin.com/in/mauricioperera/)

## Licencia

MIT
