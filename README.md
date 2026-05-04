# just-bash-wiki

A [just-bash](https://github.com/vercel-labs/just-bash) plugin that implements [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — a persistent, LLM-maintained knowledge base with semantic search.

Built on top of [just-bash-data](https://github.com/MauricioPerera/just-bash-data) (`db` + `vec`).

## Install

```bash
npm install just-bash-wiki
```

Peer dependency: `just-bash >= 2.14.0`

## Quick Start

```typescript
import { Bash, InMemoryFs } from "just-bash";
import { createWikiPlugin } from "just-bash-wiki";

const bash = new Bash({
  fs: new InMemoryFs({}),
  customCommands: createWikiPlugin({ rootDir: "/wiki" }),
});

// Initialize wiki (creates collections + vector indexes)
await bash.exec(`wiki init --dim=1536`);

// Add a source
await bash.exec(`wiki source add '{"title":"AI Overview","type":"article","content":"..."}'`);

// Create pages
await bash.exec(`wiki page create '{"slug":"ai","title":"Artificial Intelligence","type":"concept","content":"# AI\\n...","tags":["ai"],"links_to":["ml"]}'`);

// Store embeddings for semantic search
await bash.exec(`wiki embed page ai '[0.1, 0.2, ...]'`);

// Search by vector similarity
await bash.exec(`wiki search '[0.1, 0.2, ...]' --k=5`);

// Health check
await bash.exec(`wiki lint`);
```

## How It Works

The LLM uses `wiki` as a bash tool to maintain a structured knowledge base. The pattern has three layers:

| Layer | Storage | Description |
|-------|---------|-------------|
| **Sources** | `db sources` | Immutable raw documents (articles, papers, notes). The LLM reads them but never modifies them. |
| **Pages** | `db pages` + `vec page_embeddings` | LLM-generated wiki pages with content, cross-references, and vector embeddings. The LLM writes and maintains these. |
| **Log** | `db log` | Chronological record of all wiki operations. |

Three core operations:

- **Ingest** — add a source, extract information, create/update wiki pages, store embeddings
- **Query** — semantic search across pages, read relevant content, synthesize answers
- **Lint** — find orphan pages, broken links, missing embeddings, unreferenced sources

## API

### `createWikiPlugin(opts?)`

Returns an array of `Command` objects (includes `db`, `vec`, and `wiki` commands).

```typescript
interface WikiOptions {
  rootDir?: string;        // Data directory (default: "/wiki")
  encryptionKey?: string;  // AES-256-GCM encryption key
  authSecret?: string;     // JWT signing secret
  salt?: string;           // PBKDF2 salt prefix
  embeddingDim?: number;   // Vector dimension (default: 1536)
  metric?: "cosine" | "euclidean" | "dot";  // default: "cosine"
  quantize?: "float32" | "int8";            // default: "float32"
  logMaxEntries?: number;                   // cap on db log; auto-trims past 1.5×
}
```

### Exported types

The package exports TypeScript types for all data structures:

```typescript
import type { Page, Source, LogEntry, LintIssue, LintResult } from "just-bash-wiki";
```

## Command Reference

### Initialization

```bash
wiki init [--dim=1536] [--metric=cosine] [--quantize=float32]
```

Creates all collections and indexes. Safe to call multiple times — skips existing collections.

### Sources

```bash
# Add a source document
wiki source add '{"title":"...","type":"article","content":"...","url":"...","author":"..."}'

# List sources (optionally filter by type or status)
wiki source list [--type=article] [--status=raw]

# Get a source by ID
wiki source get <id>

# Count sources
wiki source count

# Update a source (MongoDB-style update operators)
wiki source update <id> '{"$set":{"status":"processed"}}'

# Delete a source (also removes its embedding)
wiki source delete <id>
```

**Source fields:** `_id` (auto-generated), `title` (required), `type`, `content`, `url`, `author`, `date`. Auto-added: `ingested_at`, `status` (default: `"raw"`).

### Pages

```bash
# Create a page
wiki page create '{"slug":"ai","title":"Artificial Intelligence","type":"concept","content":"# AI\n...","tags":["ai","tech"],"links_to":["ml","neural-nets"],"source_ids":["src-id-1"]}'

# Update a page (MongoDB-style update operators)
wiki page update <slug> '{"$set":{"content":"...","tags":["ai","updated"]}}'

# Get a page by slug
wiki page get <slug>

# List pages with optional filters
wiki page list [--type=concept] [--tag=ai] [--status=draft]

# Delete a page (cleans up cross-references and embeddings)
wiki page delete <slug>

# Rename a page (updates all cross-references and re-keys embedding)
wiki page rename <old-slug> <new-slug>

# Find pages with no inbound links
wiki page orphans
```

**Page fields:** `_id` (auto-generated), `slug` (required, unique), `title` (required), `type`, `content`, `tags`, `links_to`, `source_ids`. Auto-managed: `linked_from`, `created_at`, `updated_at`.

**Slug format:** must match `^[a-z0-9][a-z0-9_-]*$` — lowercase alphanumeric, hyphens, and underscores. Must start with a letter or digit.

**Page types:** `entity`, `concept`, `source-summary`, `comparison`, `synthesis`, `overview`, `index` (or any custom type).

### Embeddings

```bash
# Store/update a page embedding
wiki embed page <slug> '[0.1, 0.2, ...]'

# Store/update a source embedding
wiki embed source <id> '[0.1, 0.2, ...]'
```

Embeddings are stored in vector collections (`page_embeddings`, `source_embeddings`) for semantic search. The embedding dimension must match what was set in `wiki init --dim=N`.

### Search

```bash
# Search pages by vector similarity
wiki search '[0.1, 0.2, ...]' --k=10

# Search sources only
wiki search '[0.1, 0.2, ...]' --k=5 --type=sources

# Search across pages AND sources
wiki search '[0.1, 0.2, ...]' --k=10 --type=all
```

Returns results sorted by cosine similarity with scores and metadata.

### Lint

```bash
wiki lint
```

Runs a health check and reports issues:

| Issue | Severity | Description |
|-------|----------|-------------|
| `orphan` | warning | Page has no inbound links |
| `broken-link` | error | Page links to non-existent slug |
| `empty-content` | warning | Page has no content |
| `no-tags` | info | Page has no tags |
| `no-sources` | info | Page has no source references |
| `missing-embeddings` | warning | Some pages lack vector embeddings |
| `unreferenced-source` | info | Source not referenced by any page |

### Log

```bash
# View recent log entries
wiki log [--last=20] [--type=ingest]

# Add a custom log entry
wiki log add '{"type":"note","summary":"Started research on topic X"}'

# Trim the log to the N most recent entries (older ones are deleted)
wiki log trim --keep=1000
```

All wiki operations are automatically logged with timestamps. For long-running
agents, set `WikiOptions.logMaxEntries` to enable opportunistic auto-trim — the
plugin samples the log size after each command and trims back to the cap when
the count exceeds 1.5× the cap. `wiki log trim --keep=N` is always available
for explicit trims regardless of the option.

### Stats

```bash
wiki stats
```

Returns a comprehensive overview: page/source/log counts, pages grouped by type, vector collection stats, and recent activity.

### Index

```bash
wiki index
```

Returns all pages grouped by type with their slugs, titles, tags, and last update timestamps.

## Direct Access to db and vec

The wiki plugin includes all `just-bash-data` commands. You can use `db` and `vec` directly for advanced operations:

```bash
# Aggregation: find most-linked pages
db pages aggregate '[{"$unwind":"$linked_from"},{"$group":{"_id":"$slug","inbound":{"$sum":1}}},{"$sort":{"inbound":-1}}]'

# Complex queries
db pages find '{"$or":[{"tags":{"$contains":"ai"}},{"type":"overview"}]}'

# Cross-collection vector search
vec search-across "page_embeddings,source_embeddings" '[0.1,...]' --k=10
```

## Example: LLM Agent Workflow

A typical LLM agent session using `just-bash-wiki`:

```
1. Agent receives a new article to process
2. wiki source add '{"title":"...","content":"..."}'
3. Agent reads the source content and extracts key entities/concepts
4. wiki page create '{"slug":"entity-name",...}'  (for each entity)
5. wiki page update existing-page '{"$set":{"content":"updated..."}}'  (update related pages)
6. wiki embed page entity-name '[...]'  (store embeddings)
7. wiki lint  (check for issues)
8. wiki stats  (verify state)
```

When answering questions:

```
1. Generate embedding for the question
2. wiki search '[...]' --k=5  (find relevant pages)
3. wiki page get relevant-slug  (read full content)
4. Synthesize answer from page content
5. Optionally: wiki page create '{"slug":"analysis-topic",...}'  (save the answer as a new page)
```

## Architecture

```
┌─────────────────────────────────────────┐
│              LLM Agent                  │
│         (generates bash commands)       │
└─────────────┬───────────────────────────┘
              │ tool_use
┌─────────────▼───────────────────────────┐
│            just-bash                    │
│      (sandboxed bash interpreter)       │
├─────────────────────────────────────────┤
│          just-bash-wiki                 │
│    ┌──────────┬──────────┬────────┐     │
│    │  wiki    │   db     │  vec   │     │
│    │ command  │ command  │command │     │
│    └────┬─────┴────┬─────┴───┬────┘     │
│         │          │         │          │
│    ┌────▼──────────▼─────────▼────┐     │
│    │      just-bash-data          │     │
│    │  ┌──────────┐ ┌───────────┐  │     │
│    │  │ DocStore │ │VectorStore│  │     │
│    │  │(js-doc-  │ │(js-vector-│  │     │
│    │  │  store)  │ │  store)   │  │     │
│    │  └──────────┘ └───────────┘  │     │
│    └──────────────────────────────┘     │
├─────────────────────────────────────────┤
│         InMemoryFs / ReadWriteFs        │
│          (virtual filesystem)           │
└─────────────────────────────────────────┘
```

## Collections Created by `wiki init`

| Collection | Type | Description |
|------------|------|-------------|
| `sources` | db | Raw source documents |
| `pages` | db | Wiki pages (indexed on `slug` unique, `type`) |
| `log` | db | Operation log |
| `page_embeddings` | vec | Page vector embeddings |
| `source_embeddings` | vec | Source vector embeddings |

## License

MIT
