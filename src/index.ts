import { defineCommand, type Command } from "just-bash";
import { createDataPlugin, type PluginOptions } from "just-bash-data";
import type { ExecResult } from "just-bash";

// ── Public Types ──────────────────────────────────────────

export interface WikiOptions extends PluginOptions {
  /** Default embedding dimension for vec collections (default: 1536). Overridden by --dim flag on init. */
  embeddingDim?: number;
  /** Default vector metric (default: cosine). Overridden by --metric flag on init. */
  metric?: "cosine" | "euclidean" | "dot";
  /** Default vector quantization (default: float32). Overridden by --quantize flag on init. */
  quantize?: "float32" | "int8";
}

export interface Page {
  _id: string;
  slug: string;
  title: string;
  type: string;
  content: string;
  tags: string[];
  links_to: string[];
  linked_from: string[];
  source_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface Source {
  _id: string;
  title: string;
  type?: string;
  content?: string;
  url?: string;
  author?: string;
  date?: string;
  status: string;
  ingested_at: string;
}

export interface LogEntry {
  _id: string;
  type: string;
  summary: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface LintIssue {
  type: string;
  severity: "error" | "warning" | "info";
  message: string;
  slug?: string;
}

export interface LintResult {
  total: number;
  errors: number;
  warnings: number;
  info: number;
  issues: LintIssue[];
}

// ── Helpers ────────────────────────────────────────────────

const now = () => new Date().toISOString();

/** Escape a string for embedding inside single-quoted bash arguments. */
const esc = (s: string): string => s.replace(/'/g, "'\\''");

/** Build a safe db command with JSON.stringify'd arguments. */
const dbCmd = (coll: string, sub: string, ...jsonArgs: unknown[]): string => {
  const parts = [`db ${coll} ${sub}`];
  for (const arg of jsonArgs) {
    parts.push(`'${esc(JSON.stringify(arg))}'`);
  }
  return parts.join(" ");
};

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (code: number, msg: string): ExecResult => ({ stdout: "", stderr: `${msg}\n`, exitCode: code });

type Exec = (cmd: string) => Promise<ExecResult>;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const validateSlug = (slug: string): string | null => {
  if (!SLUG_RE.test(slug)) return `invalid slug '${slug}': must match ${SLUG_RE} (lowercase alphanumeric, hyphens, underscores)`;
  return null;
};

const safeParse = (s: string | undefined): unknown[] | null => {
  if (!s) return null;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; }
};

// ── Wiki Command ───────────────────────────────────────────
// NOTE: this plugin assumes single-writer semantics. Concurrent
// page creations with cross-links may produce inconsistent
// linked_from arrays. Use `wiki index --rebuild` to re-derive them.

interface InitDefaults { dim: number; metric: string; quantize: string }

function buildWikiCommand(defaults: InitDefaults): Command {
  return defineCommand("wiki", async (args, ctx) => {
    const exec: Exec = (cmd: string) => {
      if (!ctx.exec) return Promise.resolve({ stdout: "", stderr: "ctx.exec unavailable", exitCode: 1 } as ExecResult);
      return ctx.exec(cmd, { cwd: ctx.cwd });
    };

    const positional: string[] = [];
    const flags = new Map<string, string>();
    for (const a of args) {
      if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
        else flags.set(a.slice(2), "true");
      } else {
        positional.push(a);
      }
    }

    const sub = positional[0];
    if (!sub) return fail(2, "usage: wiki <init|source|page|search|embed|lint|log|stats|index> [...]");

    switch (sub) {
      case "init": return wikiInit(exec, flags, defaults);

      case "source": {
        const op = positional[1];
        switch (op) {
          case "add": return sourceAdd(exec, positional.slice(2).join(" "));
          case "list": return sourceList(exec, flags);
          case "get": return sourceGet(exec, positional[2]);
          case "count": return sourceCount(exec);
          case "update": return sourceUpdate(exec, positional[2], positional.slice(3).join(" "));
          case "delete": return sourceDelete(exec, positional[2]);
          default: return fail(2, "usage: wiki source <add|list|get|count|update|delete> [...]");
        }
      }

      case "page": {
        const op = positional[1];
        switch (op) {
          case "create": return pageCreate(exec, positional.slice(2).join(" "));
          case "update": return pageUpdate(exec, positional[2], positional.slice(3).join(" "));
          case "get": return pageGet(exec, positional[2]);
          case "list": return pageList(exec, flags);
          case "delete": return pageDelete(exec, positional[2]);
          case "rename": return pageRename(exec, positional[2], positional[3]);
          case "orphans": return pageOrphans(exec);
          default: return fail(2, "usage: wiki page <create|update|get|list|delete|rename|orphans> [...]");
        }
      }

      case "search": return wikiSearch(exec, positional.slice(1).join(" "), flags);
      case "embed": return wikiEmbed(exec, positional);
      case "lint": return wikiLint(exec);

      case "log": {
        if (positional[1] === "add") return logAdd(exec, positional.slice(2).join(" "));
        return logList(exec, flags);
      }

      case "stats": return wikiStats(exec);
      case "index": return wikiIndex(exec, flags);

      default: return fail(2, `unknown wiki command: ${sub}`);
    }
  });
}

// ── INIT ──────────────────────────────────────────────────

async function wikiInit(exec: Exec, flags: Map<string, string>, defaults: InitDefaults): Promise<ExecResult> {
  const dim = Number(flags.get("dim") ?? defaults.dim);
  const metric = flags.get("metric") ?? defaults.metric;
  const quantize = flags.get("quantize") ?? defaults.quantize;

  const results: string[] = [];

  const seedIfEmpty = async (coll: string, indexCmds: string[]) => {
    const check = await exec(`db ${coll} find '{}'`);
    if (check.exitCode === 3) {
      const seed = await exec(`db ${coll} insert '{"_init":true}'`);
      if (seed.exitCode === 0) {
        const id = JSON.parse(seed.stdout)._id;
        await exec(dbCmd(coll, "remove", { _id: id }));
      }
      for (const cmd of indexCmds) await exec(cmd);
      results.push(`${coll}: created`);
    } else {
      results.push(`${coll}: exists`);
    }
  };

  await seedIfEmpty("sources", [`db sources index create title --unique`]);
  await seedIfEmpty("pages", [`db pages index create slug --unique`, `db pages index create type`]);
  await seedIfEmpty("log", []);

  const vecCreate = async (coll: string) => {
    const r = await exec(`vec create ${coll} --dim ${dim} --metric ${metric} --quantize ${quantize}`);
    if (r.exitCode === 0) results.push(`vec ${coll}: created`);
    else if (r.stderr.includes("collection exists")) results.push(`vec ${coll}: exists`);
    else return fail(r.exitCode, r.stderr.trim());
  };

  await vecCreate("page_embeddings");
  await vecCreate("source_embeddings");
  await appendLog(exec, "init", "Wiki initialized");

  return ok(JSON.stringify({ initialized: true, collections: results }));
}

// ── SOURCE ────────────────────────────────────────────────

async function sourceAdd(exec: Exec, jsonArg: string): Promise<ExecResult> {
  if (!jsonArg) return fail(2, "usage: wiki source add '<json>'");
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(jsonArg); } catch { return fail(2, "invalid json"); }
  if (!doc.title) return fail(2, "source requires 'title' field");

  doc.ingested_at = now();
  doc.status = doc.status ?? "raw";

  const r = await exec(dbCmd("sources", "insert", doc));
  if (r.exitCode !== 0) return r;

  const id = JSON.parse(r.stdout)._id;
  await appendLog(exec, "ingest", `Source added: ${doc.title}`, { source_id: id });
  return ok(JSON.stringify({ source_id: id, title: doc.title }));
}

async function sourceList(exec: Exec, flags: Map<string, string>): Promise<ExecResult> {
  const filter: Record<string, unknown> = {};
  const type = flags.get("type");
  const status = flags.get("status");
  if (type) filter.type = type;
  if (status) filter.status = status;
  return exec(`${dbCmd("sources", "find", filter)} --project title,type,status,ingested_at`);
}

async function sourceGet(exec: Exec, id?: string): Promise<ExecResult> {
  if (!id) return fail(2, "usage: wiki source get <id>");
  return exec(dbCmd("sources", "find", { _id: id }));
}

async function sourceCount(exec: Exec): Promise<ExecResult> {
  return exec(`db sources count '{}'`);
}

async function sourceUpdate(exec: Exec, id?: string, jsonArg?: string): Promise<ExecResult> {
  if (!id || !jsonArg) return fail(2, "usage: wiki source update <id> '<update-json>'");
  let update: Record<string, unknown>;
  try { update = JSON.parse(jsonArg); } catch { return fail(2, "invalid json"); }

  const r = await exec(`${dbCmd("sources", "update", { _id: id }, update)}`);
  if (r.exitCode !== 0) return r;
  await appendLog(exec, "source-update", `Source updated: ${id}`, { source_id: id });
  return r;
}

async function sourceDelete(exec: Exec, id?: string): Promise<ExecResult> {
  if (!id) return fail(2, "usage: wiki source delete <id>");

  // Remove embedding
  await exec(`vec remove source_embeddings ${id}`);

  const r = await exec(dbCmd("sources", "remove", { _id: id }));
  if (r.exitCode !== 0) return r;
  await appendLog(exec, "source-delete", `Source deleted: ${id}`, { source_id: id });
  return r;
}

// ── PAGE ──────────────────────────────────────────────────

async function pageCreate(exec: Exec, jsonArg: string): Promise<ExecResult> {
  if (!jsonArg) return fail(2, "usage: wiki page create '<json>'");
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(jsonArg); } catch { return fail(2, "invalid json"); }
  if (!doc.slug || !doc.title) return fail(2, "page requires 'slug' and 'title' fields");

  const slug = doc.slug as string;
  const slugErr = validateSlug(slug);
  if (slugErr) return fail(2, slugErr);

  doc.links_to = doc.links_to ?? [];
  doc.linked_from = doc.linked_from ?? [];
  doc.source_ids = doc.source_ids ?? [];
  doc.tags = doc.tags ?? [];
  doc.type = doc.type ?? "concept";
  doc.created_at = now();
  doc.updated_at = doc.created_at;

  // Find existing pages that already link to this slug
  const inboundR = await exec(dbCmd("pages", "find", { links_to: { $contains: slug } }) + " --project slug");
  if (inboundR.exitCode === 0 && inboundR.stdout) {
    const inbound = JSON.parse(inboundR.stdout) as Array<Record<string, unknown>>;
    const existing = doc.linked_from as string[];
    for (const p of inbound) {
      const s = p.slug as string;
      if (!existing.includes(s)) existing.push(s);
    }
  }

  const r = await exec(dbCmd("pages", "insert", doc));
  if (r.exitCode !== 0) return r;
  const id = JSON.parse(r.stdout)._id;

  // Update linked_from on target pages
  const linksTo = doc.links_to as string[];
  for (const targetSlug of linksTo) {
    await exec(`${dbCmd("pages", "update", { slug: targetSlug }, { $push: { linked_from: slug } })}`);
  }

  await appendLog(exec, "page-create", `Page created: ${doc.title}`, { slug, type: doc.type });
  return ok(JSON.stringify({ _id: id, slug }));
}

async function pageUpdate(exec: Exec, slug?: string, jsonArg?: string): Promise<ExecResult> {
  if (!slug || !jsonArg) return fail(2, "usage: wiki page update <slug> '<update-json>'");
  let update: Record<string, unknown>;
  try { update = JSON.parse(jsonArg); } catch { return fail(2, "invalid json"); }

  // Always update timestamp
  if (update["$set"] && typeof update["$set"] === "object") {
    (update["$set"] as Record<string, unknown>).updated_at = now();
  } else if (!update["$set"]) {
    update["$set"] = { updated_at: now() };
  }

  const r = await exec(`${dbCmd("pages", "update", { slug }, update)}`);
  if (r.exitCode !== 0) return r;
  await appendLog(exec, "page-update", `Page updated: ${slug}`, { slug });
  return r;
}

async function pageGet(exec: Exec, slug?: string): Promise<ExecResult> {
  if (!slug) return fail(2, "usage: wiki page get <slug>");
  return exec(dbCmd("pages", "find", { slug }));
}

async function pageList(exec: Exec, flags: Map<string, string>): Promise<ExecResult> {
  const filter: Record<string, unknown> = {};
  const type = flags.get("type");
  const tag = flags.get("tag");
  const status = flags.get("status");
  if (type) filter.type = type;
  if (tag) filter.tags = { $contains: tag };
  if (status) filter.status = status;
  return exec(`${dbCmd("pages", "find", filter)} --project slug,title,type,tags,updated_at`);
}

async function pageDelete(exec: Exec, slug?: string): Promise<ExecResult> {
  if (!slug) return fail(2, "usage: wiki page delete <slug>");

  // Clean linked_from on pages that reference this slug
  await exec(`${dbCmd("pages", "update", { linked_from: { $contains: slug } }, { $pull: { linked_from: slug } })} --many`);

  // Remove embedding
  await exec(`vec remove page_embeddings ${slug}`);

  const r = await exec(dbCmd("pages", "remove", { slug }));
  if (r.exitCode !== 0) return r;
  await appendLog(exec, "page-delete", `Page deleted: ${slug}`, { slug });
  return r;
}

async function pageRename(exec: Exec, oldSlug?: string, newSlug?: string): Promise<ExecResult> {
  if (!oldSlug || !newSlug) return fail(2, "usage: wiki page rename <old-slug> <new-slug>");

  const slugErr = validateSlug(newSlug);
  if (slugErr) return fail(2, slugErr);

  // Check old exists
  const oldR = await exec(dbCmd("pages", "find", { slug: oldSlug }));
  if (oldR.exitCode !== 0) return oldR;
  const oldPages = safeParse(oldR.stdout);
  if (!oldPages || oldPages.length === 0) return fail(3, `not found: ${oldSlug}`);

  // Check new doesn't exist
  const newR = await exec(dbCmd("pages", "find", { slug: newSlug }));
  const newPages = safeParse(newR.stdout);
  if (newPages && newPages.length > 0) return fail(5, `slug already exists: ${newSlug}`);

  // Collect affected pages BEFORE mutating so we know exactly who to update.
  // This avoids the read-after-write problem of pull-then-push.
  const linkersR = safeParse((await exec(dbCmd("pages", "find", { links_to: { $contains: oldSlug } }) + " --project slug")).stdout) as Array<Record<string, unknown>> | null;
  const linkerSlugs = (linkersR ?? []).map((p) => p.slug as string);

  const targetsR = safeParse((await exec(dbCmd("pages", "find", { linked_from: { $contains: oldSlug } }) + " --project slug")).stdout) as Array<Record<string, unknown>> | null;
  const targetSlugs = (targetsR ?? []).map((p) => p.slug as string);

  // 1. Rename the page's own slug
  const renameR = await exec(`${dbCmd("pages", "update", { slug: oldSlug }, { $set: { slug: newSlug, updated_at: now() } })}`);
  if (renameR.exitCode !== 0) return renameR;

  // 2. Update links_to: batch pull old slug, then push new slug on affected pages
  if (linkerSlugs.length > 0) {
    await exec(`${dbCmd("pages", "update", { links_to: { $contains: oldSlug } }, { $pull: { links_to: oldSlug } })} --many`);
    for (const s of linkerSlugs) {
      await exec(`${dbCmd("pages", "update", { slug: s }, { $push: { links_to: newSlug } })}`);
    }
  }

  // 3. Update linked_from: batch pull old slug, then push new slug on affected pages
  if (targetSlugs.length > 0) {
    await exec(`${dbCmd("pages", "update", { linked_from: { $contains: oldSlug } }, { $pull: { linked_from: oldSlug } })} --many`);
    for (const s of targetSlugs) {
      await exec(`${dbCmd("pages", "update", { slug: s }, { $push: { linked_from: newSlug } })}`);
    }
  }

  // 4. Re-key vector embedding
  const vecGet = await exec(`vec get page_embeddings ${oldSlug}`);
  if (vecGet.exitCode === 0) {
    const vecData = JSON.parse(vecGet.stdout);
    await exec(`vec remove page_embeddings ${oldSlug}`);
    const meta = vecData.metadata ?? {};
    await exec(`vec store page_embeddings ${newSlug} '${esc(JSON.stringify(vecData.vector))}' --meta '${esc(JSON.stringify(meta))}'`);
  }

  await appendLog(exec, "page-rename", `Page renamed: ${oldSlug} → ${newSlug}`, { old_slug: oldSlug, new_slug: newSlug });
  return ok(JSON.stringify({ old_slug: oldSlug, new_slug: newSlug }));
}

async function pageOrphans(exec: Exec): Promise<ExecResult> {
  const r = await exec(`db pages find '{}' --project slug,title,type,linked_from,links_to`);
  if (r.exitCode !== 0) return r;
  const pages = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
  const orphans = pages.filter((p) => {
    const lf = p.linked_from as string[] | undefined;
    return !lf || lf.length === 0;
  });
  return ok(JSON.stringify(orphans));
}

// ── SEARCH ────────────────────────────────────────────────

async function wikiSearch(exec: Exec, vectorArg: string, flags: Map<string, string>): Promise<ExecResult> {
  if (!vectorArg) return fail(2, "usage: wiki search '<vector-json>' [--k=N] [--type=pages|sources|all]");
  const k = flags.get("k") ?? "10";
  const searchType = flags.get("type");

  if (searchType === "sources") {
    return exec(`vec search source_embeddings '${esc(vectorArg)}' --k ${k}`);
  }
  if (searchType === "all") {
    return exec(`vec search-across "page_embeddings,source_embeddings" '${esc(vectorArg)}' --k ${k}`);
  }
  return exec(`vec search page_embeddings '${esc(vectorArg)}' --k ${k}`);
}

// ── EMBED ─────────────────────────────────────────────────

async function wikiEmbed(exec: Exec, positional: string[]): Promise<ExecResult> {
  // wiki embed <page|source> <id> <vector-json> [--meta=<json>]
  const target = positional[1]; // "page" or "source"
  const id = positional[2];
  const vectorArg = positional[3];

  if (!target || !id || !vectorArg) {
    return fail(2, "usage: wiki embed <page|source> <id> '<vector-json>' [--meta='<json>']");
  }

  let vector: number[];
  try { vector = JSON.parse(vectorArg); } catch { return fail(2, "invalid vector json"); }
  if (!Array.isArray(vector)) return fail(2, "vector must be a JSON array");

  const coll = target === "source" ? "source_embeddings" : "page_embeddings";

  // Remove existing to allow re-embed
  const existing = await exec(`vec get ${coll} ${id}`);
  if (existing.exitCode === 0) {
    await exec(`vec remove ${coll} ${id}`);
  }

  // Find --meta flag in remaining positional args
  let metaFlag = "";
  for (let i = 4; i < positional.length; i++) {
    const a = positional[i];
    if (a.startsWith("--meta=")) {
      metaFlag = ` --meta '${esc(a.slice(7))}'`;
    }
  }

  return exec(`vec store ${coll} ${id} '${esc(JSON.stringify(vector))}'${metaFlag}`);
}

// ── LINT ──────────────────────────────────────────────────

async function wikiLint(exec: Exec): Promise<ExecResult> {
  const issues: LintIssue[] = [];

  const allPagesR = await exec(`db pages find '{}' --project slug,title,type,links_to,linked_from,source_ids,tags,content`);
  if (allPagesR.exitCode !== 0) return allPagesR;
  const pages = JSON.parse(allPagesR.stdout) as Array<Record<string, unknown>>;
  const slugSet = new Set(pages.map((p) => p.slug as string));

  for (const page of pages) {
    const slug = page.slug as string;
    const linkedFrom = page.linked_from as string[] | undefined;
    const linksTo = page.links_to as string[] | undefined;

    if (!linkedFrom || linkedFrom.length === 0) {
      issues.push({ type: "orphan", severity: "warning", message: "No inbound links", slug });
    }

    if (linksTo) {
      for (const t of linksTo) {
        if (!slugSet.has(t)) {
          issues.push({ type: "broken-link", severity: "error", message: `Links to non-existent page: ${t}`, slug });
        }
      }
    }

    if (!page.content || (page.content as string).trim().length === 0) {
      issues.push({ type: "empty-content", severity: "warning", message: "Page has no content", slug });
    }

    const tags = page.tags as string[] | undefined;
    if (!tags || tags.length === 0) {
      issues.push({ type: "no-tags", severity: "info", message: "Page has no tags", slug });
    }

    const sourceIds = page.source_ids as string[] | undefined;
    if ((!sourceIds || sourceIds.length === 0) && page.type !== "overview" && page.type !== "index") {
      issues.push({ type: "no-sources", severity: "info", message: "Page has no source references", slug });
    }
  }

  // Missing embeddings
  const vecStatsR = await exec(`vec stats page_embeddings`);
  if (vecStatsR.exitCode === 0) {
    const vc = JSON.parse(vecStatsR.stdout);
    if (vc.count < pages.length) {
      issues.push({ type: "missing-embeddings", severity: "warning", message: `${pages.length - vc.count} pages missing vector embeddings` });
    }
  }

  // Unreferenced sources
  const sourcesR = await exec(`db sources find '{}' --project _id,title`);
  if (sourcesR.exitCode === 0) {
    const sources = JSON.parse(sourcesR.stdout) as Array<Record<string, unknown>>;
    const refIds = new Set(pages.flatMap((p) => (p.source_ids as string[]) ?? []));
    for (const src of sources) {
      if (!refIds.has(src._id as string)) {
        issues.push({ type: "unreferenced-source", severity: "info", message: `Source not referenced by any page: ${src.title}` });
      }
    }
  }

  await appendLog(exec, "lint", `Lint completed: ${issues.length} issues found`);

  const result: LintResult = {
    total: issues.length,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
    issues,
  };
  return ok(JSON.stringify(result));
}

// ── LOG ───────────────────────────────────────────────────

async function appendLog(exec: Exec, type: string, summary: string, details?: Record<string, unknown>): Promise<void> {
  const entry: Record<string, unknown> = { type, summary, timestamp: now() };
  if (details) entry.details = details;
  await exec(dbCmd("log", "insert", entry));
}

async function logAdd(exec: Exec, jsonArg: string): Promise<ExecResult> {
  if (!jsonArg) return fail(2, "usage: wiki log add '<json>'");
  let entry: Record<string, unknown>;
  try { entry = JSON.parse(jsonArg); } catch { return fail(2, "invalid json"); }
  entry.timestamp = now();
  return exec(dbCmd("log", "insert", entry));
}

async function logList(exec: Exec, flags: Map<string, string>): Promise<ExecResult> {
  const last = flags.get("last") ?? "20";
  const type = flags.get("type");
  const filter: Record<string, unknown> = {};
  if (type) filter.type = type;
  return exec(`${dbCmd("log", "find", filter)} --sort timestamp:-1 --limit ${last}`);
}

// ── STATS ─────────────────────────────────────────────────

async function wikiStats(exec: Exec): Promise<ExecResult> {
  const stats: Record<string, unknown> = {};

  const pc = await exec(`db pages count '{}'`);
  stats.pages = pc.exitCode === 0 ? JSON.parse(pc.stdout).count : 0;

  const sc = await exec(`db sources count '{}'`);
  stats.sources = sc.exitCode === 0 ? JSON.parse(sc.stdout).count : 0;

  const lc = await exec(`db log count '{}'`);
  stats.log_entries = lc.exitCode === 0 ? JSON.parse(lc.stdout).count : 0;

  const bt = await exec(`db pages aggregate '[{"$group":{"_id":"$type","count":{"$sum":1}}}]'`);
  if (bt.exitCode === 0) stats.pages_by_type = JSON.parse(bt.stdout);

  const pv = await exec(`vec stats page_embeddings`);
  if (pv.exitCode === 0) stats.page_embeddings = JSON.parse(pv.stdout);

  const sv = await exec(`vec stats source_embeddings`);
  if (sv.exitCode === 0) stats.source_embeddings = JSON.parse(sv.stdout);

  const ra = await exec(`db log find '{}' --sort timestamp:-1 --limit 5 --project type,summary,timestamp`);
  if (ra.exitCode === 0) stats.recent_activity = JSON.parse(ra.stdout);

  return ok(JSON.stringify(stats));
}

// ── INDEX ─────────────────────────────────────────────────

async function wikiIndex(exec: Exec, flags: Map<string, string>): Promise<ExecResult> {
  const rebuild = flags.get("rebuild") === "true";

  if (rebuild) {
    // Re-derive all linked_from from links_to across all pages
    const allR = await exec(`db pages find '{}' --project slug,links_to`);
    if (allR.exitCode !== 0) return allR;
    const pages = JSON.parse(allR.stdout) as Array<Record<string, unknown>>;

    // Build the reverse map
    const inbound: Record<string, string[]> = {};
    for (const p of pages) {
      const slug = p.slug as string;
      inbound[slug] = inbound[slug] ?? [];
      for (const t of (p.links_to as string[]) ?? []) {
        inbound[t] = inbound[t] ?? [];
        if (!inbound[t].includes(slug)) inbound[t].push(slug);
      }
    }

    // Update each page's linked_from
    for (const p of pages) {
      const slug = p.slug as string;
      const correct = inbound[slug] ?? [];
      await exec(`${dbCmd("pages", "update", { slug }, { $set: { linked_from: correct } })}`);
    }

    await appendLog(exec, "index-rebuild", `Rebuilt linked_from for ${pages.length} pages`);
    return ok(JSON.stringify({ rebuilt: true, pages: pages.length }));
  }

  // Default: list pages grouped by type
  const pagesR = await exec(`db pages find '{}' --project slug,title,type,tags,updated_at --sort type:1`);
  if (pagesR.exitCode !== 0) return pagesR;
  const pages = JSON.parse(pagesR.stdout) as Array<Record<string, unknown>>;

  const byType: Record<string, Array<{ slug: string; title: string; tags: string[]; updated_at: string }>> = {};
  for (const p of pages) {
    const type = (p.type as string) ?? "other";
    if (!byType[type]) byType[type] = [];
    byType[type].push({
      slug: p.slug as string,
      title: p.title as string,
      tags: (p.tags as string[]) ?? [],
      updated_at: p.updated_at as string,
    });
  }
  return ok(JSON.stringify({ total: pages.length, by_type: byType }));
}

// ── Plugin Factory ────────────────────────────────────────

export function createWikiPlugin(opts: WikiOptions = {}): Command[] {
  const defaults: InitDefaults = {
    dim: opts.embeddingDim ?? 1536,
    metric: opts.metric ?? "cosine",
    quantize: opts.quantize ?? "float32",
  };

  const dataPlugin = createDataPlugin({
    rootDir: opts.rootDir ?? "/wiki",
    encryptionKey: opts.encryptionKey,
    authSecret: opts.authSecret,
    salt: opts.salt,
  });

  return [...dataPlugin, buildWikiCommand(defaults)] as Command[];
}
