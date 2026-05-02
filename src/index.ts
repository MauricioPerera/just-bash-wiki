import { defineCommand, type Command } from "just-bash";
import { createDataPlugin, type PluginOptions } from "just-bash-data";
import type { ExecResult } from "just-bash";

export interface WikiOptions extends PluginOptions {
  /** Embedding dimension for vector collections (default: 1536 for OpenAI) */
  embeddingDim?: number;
  /** Vector metric (default: cosine) */
  metric?: "cosine" | "euclidean" | "dot";
  /** Vector quantization (default: float32) */
  quantize?: "float32" | "int8";
}

// ── Helpers ────────────────────────────────────────────────

const now = () => new Date().toISOString();

const esc = (s: string): string => s.replace(/'/g, "'\\''");

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (code: number, msg: string): ExecResult => ({ stdout: "", stderr: `${msg}\n`, exitCode: code });

// ── Wiki Command ───────────────────────────────────────────

const FLAG_SPEC = {
  bool: ["verbose", "force"] as const,
  string: ["type", "k", "tag", "last", "status"] as const,
};

function buildWikiCommand(): Command {
  return defineCommand("wiki", async (args, ctx) => {
    const exec = (cmd: string) => {
      if (!ctx.exec) return Promise.resolve({ stdout: "", stderr: "ctx.exec unavailable", exitCode: 1 } as ExecResult);
      return ctx.exec(cmd, { cwd: ctx.cwd });
    };

    // Simple arg parsing
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
    if (!sub) {
      return fail(2, "usage: wiki <init|source|page|search|lint|log|stats> [...]");
    }

    switch (sub) {
      // ── INIT ──────────────────────────────────────────
      case "init": return wikiInit(exec, flags);

      // ── SOURCE ────────────────────────────────────────
      case "source": {
        const op = positional[1];
        switch (op) {
          case "add": return sourceAdd(exec, positional.slice(2).join(" "));
          case "list": return sourceList(exec, flags);
          case "get": return sourceGet(exec, positional[2]);
          case "count": return sourceCount(exec);
          default: return fail(2, "usage: wiki source <add|list|get|count> [...]");
        }
      }

      // ── PAGE ──────────────────────────────────────────
      case "page": {
        const op = positional[1];
        switch (op) {
          case "create": return pageCreate(exec, positional.slice(2).join(" "));
          case "update": return pageUpdate(exec, positional[2], positional.slice(3).join(" "));
          case "get": return pageGet(exec, positional[2]);
          case "list": return pageList(exec, flags);
          case "delete": return pageDelete(exec, positional[2]);
          case "orphans": return pageOrphans(exec);
          default: return fail(2, "usage: wiki page <create|update|get|list|delete|orphans> [...]");
        }
      }

      // ── SEARCH ────────────────────────────────────────
      case "search": return wikiSearch(exec, positional.slice(1).join(" "), flags);

      // ── EMBED ─────────────────────────────────────────
      case "embed": return wikiEmbed(exec, positional[1], positional.slice(2).join(" "));

      // ── LINT ──────────────────────────────────────────
      case "lint": return wikiLint(exec);

      // ── LOG ───────────────────────────────────────────
      case "log": {
        if (positional[1] === "add") return logAdd(exec, positional.slice(2).join(" "));
        return logList(exec, flags);
      }

      // ── STATS ─────────────────────────────────────────
      case "stats": return wikiStats(exec);

      // ── INDEX (rebuild) ───────────────────────────────
      case "index": return wikiIndex(exec);

      default: return fail(2, `unknown wiki command: ${sub}`);
    }
  });
}

// ── INIT ──────────────────────────────────────────────────

async function wikiInit(
  exec: (cmd: string) => Promise<ExecResult>,
  flags: Map<string, string>,
): Promise<ExecResult> {
  const dim = Number(flags.get("dim") ?? "1536");
  const metric = flags.get("metric") ?? "cosine";
  const quantize = flags.get("quantize") ?? "float32";

  const results: string[] = [];

  // Create db collections with indexes
  const seedIfEmpty = async (coll: string, indexCmds: string[]) => {
    const check = await exec(`db ${coll} find '{}'`);
    if (check.exitCode === 3) {
      // Collection doesn't exist — insert a seed doc then remove it to create it
      const seed = await exec(`db ${coll} insert '{"_init":true}'`);
      if (seed.exitCode === 0) {
        const id = JSON.parse(seed.stdout)._id;
        await exec(`db ${coll} remove '{"_id":"${id}"}'`);
      }
      for (const cmd of indexCmds) {
        await exec(cmd);
      }
      results.push(`${coll}: created`);
    } else {
      results.push(`${coll}: exists`);
    }
  };

  await seedIfEmpty("sources", [
    `db sources index create title --unique`,
  ]);
  await seedIfEmpty("pages", [
    `db pages index create slug --unique`,
    `db pages index create type`,
  ]);
  await seedIfEmpty("log", []);

  // Create vec collections
  const vecCreate = async (coll: string) => {
    const r = await exec(`vec create ${coll} --dim ${dim} --metric ${metric} --quantize ${quantize}`);
    if (r.exitCode === 0) results.push(`vec ${coll}: created`);
    else if (r.stderr.includes("collection exists")) results.push(`vec ${coll}: exists`);
    else return fail(r.exitCode, r.stderr.trim());
  };

  await vecCreate("page_embeddings");
  await vecCreate("source_embeddings");

  // Log init
  await appendLog(exec, "init", "Wiki initialized");

  return ok(JSON.stringify({ initialized: true, collections: results }));
}

// ── SOURCE ────────────────────────────────────────────────

async function sourceAdd(exec: (cmd: string) => Promise<ExecResult>, jsonArg: string): Promise<ExecResult> {
  if (!jsonArg) return fail(2, "usage: wiki source add '<json>'");

  let doc: Record<string, unknown>;
  try { doc = JSON.parse(jsonArg); } catch { return fail(2, "invalid json"); }

  if (!doc.title) return fail(2, "source requires 'title' field");

  doc.ingested_at = now();
  doc.status = doc.status ?? "raw";

  const r = await exec(`db sources insert '${esc(JSON.stringify(doc))}'`);
  if (r.exitCode !== 0) return r;

  const id = JSON.parse(r.stdout)._id;
  await appendLog(exec, "ingest", `Source added: ${doc.title}`, { source_id: id });

  return ok(JSON.stringify({ source_id: id, title: doc.title }));
}

async function sourceList(exec: (cmd: string) => Promise<ExecResult>, flags: Map<string, string>): Promise<ExecResult> {
  const type = flags.get("type");
  const filter = type ? `{"type":"${esc(type)}"}` : "{}";
  return exec(`db sources find '${filter}' --project title,type,status,ingested_at`);
}

async function sourceGet(exec: (cmd: string) => Promise<ExecResult>, id?: string): Promise<ExecResult> {
  if (!id) return fail(2, "usage: wiki source get <id>");
  return exec(`db sources find '{"_id":"${esc(id)}"}'`);
}

async function sourceCount(exec: (cmd: string) => Promise<ExecResult>): Promise<ExecResult> {
  return exec(`db sources count '{}'`);
}

// ── PAGE ──────────────────────────────────────────────────

async function pageCreate(exec: (cmd: string) => Promise<ExecResult>, jsonArg: string): Promise<ExecResult> {
  if (!jsonArg) return fail(2, "usage: wiki page create '<json>'");

  let doc: Record<string, unknown>;
  try { doc = JSON.parse(jsonArg); } catch { return fail(2, "invalid json"); }

  if (!doc.slug || !doc.title) return fail(2, "page requires 'slug' and 'title' fields");

  doc.links_to = doc.links_to ?? [];
  doc.linked_from = doc.linked_from ?? [];
  doc.source_ids = doc.source_ids ?? [];
  doc.tags = doc.tags ?? [];
  doc.type = doc.type ?? "concept";
  doc.created_at = now();
  doc.updated_at = doc.created_at;

  // Before inserting, find existing pages that already link to this slug
  const slug = doc.slug as string;
  const inboundR = await exec(`db pages find '{"links_to":{"$contains":"${esc(slug)}"}}'  --project slug`);
  if (inboundR.exitCode === 0 && inboundR.stdout) {
    const inbound = JSON.parse(inboundR.stdout) as Array<Record<string, unknown>>;
    const existing = doc.linked_from as string[];
    for (const p of inbound) {
      const s = p.slug as string;
      if (!existing.includes(s)) existing.push(s);
    }
  }

  const r = await exec(`db pages insert '${esc(JSON.stringify(doc))}'`);
  if (r.exitCode !== 0) return r;

  const id = JSON.parse(r.stdout)._id;

  // Update inbound links on target pages that already exist
  const linksTo = doc.links_to as string[];
  for (const targetSlug of linksTo) {
    await exec(`db pages update '{"slug":"${esc(targetSlug)}"}' '{"$push":{"linked_from":"${esc(slug)}"}}'`);
  }

  await appendLog(exec, "page-create", `Page created: ${doc.title}`, { slug: doc.slug, type: doc.type });

  return ok(JSON.stringify({ _id: id, slug: doc.slug }));
}

async function pageUpdate(exec: (cmd: string) => Promise<ExecResult>, slug?: string, jsonArg?: string): Promise<ExecResult> {
  if (!slug || !jsonArg) return fail(2, "usage: wiki page update <slug> '<update-json>'");

  let update: Record<string, unknown>;
  try { update = JSON.parse(jsonArg); } catch { return fail(2, "invalid json"); }

  // Always update the timestamp
  if (update["$set"] && typeof update["$set"] === "object") {
    (update["$set"] as Record<string, unknown>).updated_at = now();
  } else if (!update["$set"]) {
    update["$set"] = { updated_at: now() };
  }

  const r = await exec(`db pages update '{"slug":"${esc(slug)}"}' '${esc(JSON.stringify(update))}'`);
  if (r.exitCode !== 0) return r;

  await appendLog(exec, "page-update", `Page updated: ${slug}`, { slug });

  return r;
}

async function pageGet(exec: (cmd: string) => Promise<ExecResult>, slug?: string): Promise<ExecResult> {
  if (!slug) return fail(2, "usage: wiki page get <slug>");
  return exec(`db pages find '{"slug":"${esc(slug)}"}'`);
}

async function pageList(exec: (cmd: string) => Promise<ExecResult>, flags: Map<string, string>): Promise<ExecResult> {
  const type = flags.get("type");
  const tag = flags.get("tag");
  const parts: string[] = [];
  if (type) parts.push(`"type":"${esc(type)}"`);
  if (tag) parts.push(`"tags":{"$contains":"${esc(tag)}"}`);
  const filter = parts.length > 0 ? `{${parts.join(",")}}` : "{}";
  return exec(`db pages find '${filter}' --project slug,title,type,tags,updated_at`);
}

async function pageDelete(exec: (cmd: string) => Promise<ExecResult>, slug?: string): Promise<ExecResult> {
  if (!slug) return fail(2, "usage: wiki page delete <slug>");

  // Remove inbound links from other pages
  await exec(`db pages update '{"linked_from":{"$contains":"${esc(slug)}"}}' '{"$pull":{"linked_from":"${esc(slug)}"}}' --many`);

  // Remove vector embedding
  const vecR = await exec(`vec remove page_embeddings ${slug}`);
  // Ignore if not found

  const r = await exec(`db pages remove '{"slug":"${esc(slug)}"}'`);
  if (r.exitCode !== 0) return r;

  await appendLog(exec, "page-delete", `Page deleted: ${slug}`, { slug });
  return r;
}

async function pageOrphans(exec: (cmd: string) => Promise<ExecResult>): Promise<ExecResult> {
  // Find pages with no inbound links (linked_from is empty or missing)
  const allPages = await exec(`db pages find '{}' --project slug,title,type,linked_from,links_to`);
  if (allPages.exitCode !== 0) return allPages;

  const pages = JSON.parse(allPages.stdout) as Array<Record<string, unknown>>;
  const orphans = pages.filter((p) => {
    const linkedFrom = p.linked_from as string[] | undefined;
    return !linkedFrom || linkedFrom.length === 0;
  });

  return ok(JSON.stringify(orphans));
}

// ── SEARCH ────────────────────────────────────────────────

async function wikiSearch(exec: (cmd: string) => Promise<ExecResult>, vectorArg: string, flags: Map<string, string>): Promise<ExecResult> {
  if (!vectorArg) return fail(2, "usage: wiki search '<vector-json>' [--k=N]");

  const k = flags.get("k") ?? "10";
  const searchType = flags.get("type");

  if (searchType === "sources") {
    return exec(`vec search source_embeddings '${esc(vectorArg)}' --k ${k}`);
  }
  if (searchType === "all") {
    return exec(`vec search-across "page_embeddings,source_embeddings" '${esc(vectorArg)}' --k ${k}`);
  }
  // Default: search pages
  return exec(`vec search page_embeddings '${esc(vectorArg)}' --k ${k}`);
}

// ── EMBED ─────────────────────────────────────────────────

async function wikiEmbed(exec: (cmd: string) => Promise<ExecResult>, target?: string, rest?: string): Promise<ExecResult> {
  if (!target) return fail(2, "usage: wiki embed <page|source> <id> '<vector-json>' [--meta '<json>']");

  // Parse: wiki embed page <slug> '<vector>'
  // or:    wiki embed source <id> '<vector>'
  const parts = rest?.split(" ") ?? [];
  const id = parts[0];
  // Find the vector JSON (starts with '[')
  const vectorStart = rest?.indexOf("[") ?? -1;
  if (!id || vectorStart < 0) return fail(2, "usage: wiki embed <page|source> <id> '<vector-json>'");

  // Extract vector — find matching ]
  const vectorStr = rest!.slice(vectorStart);
  const bracketEnd = findMatchingBracket(vectorStr);
  const vector = vectorStr.slice(0, bracketEnd + 1);

  // Extract optional --meta
  const metaMatch = rest!.match(/--meta\s+'([^']+)'/);
  const metaFlag = metaMatch ? ` --meta '${metaMatch[1]}'` : "";

  const coll = target === "source" ? "source_embeddings" : "page_embeddings";

  // Check if exists, remove first to allow re-embed
  const existing = await exec(`vec get ${coll} ${id}`);
  if (existing.exitCode === 0) {
    await exec(`vec remove ${coll} ${id}`);
  }

  return exec(`vec store ${coll} ${id} '${esc(vector)}'${metaFlag}`);
}

function findMatchingBracket(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "[") depth++;
    else if (s[i] === "]") { depth--; if (depth === 0) return i; }
  }
  return s.length - 1;
}

// ── LINT ──────────────────────────────────────────────────

async function wikiLint(exec: (cmd: string) => Promise<ExecResult>): Promise<ExecResult> {
  const issues: Array<{ type: string; severity: string; message: string; slug?: string }> = [];

  // 1. Find orphan pages (no inbound links)
  const allPagesR = await exec(`db pages find '{}' --project slug,title,type,links_to,linked_from,source_ids,tags,content`);
  if (allPagesR.exitCode !== 0) return allPagesR;
  const pages = JSON.parse(allPagesR.stdout) as Array<Record<string, unknown>>;
  const slugSet = new Set(pages.map((p) => p.slug as string));

  for (const page of pages) {
    const slug = page.slug as string;
    const linkedFrom = page.linked_from as string[] | undefined;
    const linksTo = page.links_to as string[] | undefined;

    // Orphan check
    if (!linkedFrom || linkedFrom.length === 0) {
      issues.push({ type: "orphan", severity: "warning", message: `No inbound links`, slug });
    }

    // Broken links
    if (linksTo) {
      for (const target of linksTo) {
        if (!slugSet.has(target)) {
          issues.push({ type: "broken-link", severity: "error", message: `Links to non-existent page: ${target}`, slug });
        }
      }
    }

    // Missing content
    if (!page.content || (page.content as string).trim().length === 0) {
      issues.push({ type: "empty-content", severity: "warning", message: `Page has no content`, slug });
    }

    // No tags
    const tags = page.tags as string[] | undefined;
    if (!tags || tags.length === 0) {
      issues.push({ type: "no-tags", severity: "info", message: `Page has no tags`, slug });
    }

    // No source references (for non-overview pages)
    const sourceIds = page.source_ids as string[] | undefined;
    if ((!sourceIds || sourceIds.length === 0) && page.type !== "overview" && page.type !== "index") {
      issues.push({ type: "no-sources", severity: "info", message: `Page has no source references`, slug });
    }
  }

  // 2. Check for pages without embeddings
  const vecStatsR = await exec(`vec stats page_embeddings`);
  if (vecStatsR.exitCode === 0) {
    const vecStats = JSON.parse(vecStatsR.stdout);
    if (vecStats.count < pages.length) {
      issues.push({
        type: "missing-embeddings",
        severity: "warning",
        message: `${pages.length - vecStats.count} pages missing vector embeddings`,
      });
    }
  }

  // 3. Sources without pages
  const sourcesR = await exec(`db sources find '{}' --project _id,title`);
  if (sourcesR.exitCode === 0) {
    const sources = JSON.parse(sourcesR.stdout) as Array<Record<string, unknown>>;
    const referencedIds = new Set(pages.flatMap((p) => (p.source_ids as string[]) ?? []));
    for (const src of sources) {
      if (!referencedIds.has(src._id as string)) {
        issues.push({
          type: "unreferenced-source",
          severity: "info",
          message: `Source not referenced by any page: ${src.title}`,
        });
      }
    }
  }

  await appendLog(exec, "lint", `Lint completed: ${issues.length} issues found`);

  return ok(JSON.stringify({
    total: issues.length,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
    issues,
  }));
}

// ── LOG ───────────────────────────────────────────────────

async function appendLog(
  exec: (cmd: string) => Promise<ExecResult>,
  type: string,
  summary: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const entry: Record<string, unknown> = {
    type,
    summary,
    timestamp: now(),
  };
  if (details) entry.details = details;
  await exec(`db log insert '${esc(JSON.stringify(entry))}'`);
}

async function logAdd(exec: (cmd: string) => Promise<ExecResult>, jsonArg: string): Promise<ExecResult> {
  if (!jsonArg) return fail(2, "usage: wiki log add '<json>'");
  let entry: Record<string, unknown>;
  try { entry = JSON.parse(jsonArg); } catch { return fail(2, "invalid json"); }
  entry.timestamp = now();
  return exec(`db log insert '${esc(JSON.stringify(entry))}'`);
}

async function logList(exec: (cmd: string) => Promise<ExecResult>, flags: Map<string, string>): Promise<ExecResult> {
  const last = flags.get("last") ?? "20";
  const type = flags.get("type");
  const filter = type ? `{"type":"${esc(type)}"}` : "{}";
  return exec(`db log find '${filter}' --sort timestamp:-1 --limit ${last}`);
}

// ── STATS ─────────────────────────────────────────────────

async function wikiStats(exec: (cmd: string) => Promise<ExecResult>): Promise<ExecResult> {
  const stats: Record<string, unknown> = {};

  const pagesCount = await exec(`db pages count '{}'`);
  stats.pages = pagesCount.exitCode === 0 ? JSON.parse(pagesCount.stdout).count : 0;

  const sourcesCount = await exec(`db sources count '{}'`);
  stats.sources = sourcesCount.exitCode === 0 ? JSON.parse(sourcesCount.stdout).count : 0;

  const logCount = await exec(`db log count '{}'`);
  stats.log_entries = logCount.exitCode === 0 ? JSON.parse(logCount.stdout).count : 0;

  // Pages by type
  const byType = await exec(`db pages aggregate '[{"$group":{"_id":"$type","count":{"$sum":1}}}]'`);
  if (byType.exitCode === 0) {
    stats.pages_by_type = JSON.parse(byType.stdout);
  }

  // Vector stats
  const pageVec = await exec(`vec stats page_embeddings`);
  if (pageVec.exitCode === 0) stats.page_embeddings = JSON.parse(pageVec.stdout);

  const srcVec = await exec(`vec stats source_embeddings`);
  if (srcVec.exitCode === 0) stats.source_embeddings = JSON.parse(srcVec.stdout);

  // Recent activity
  const recent = await exec(`db log find '{}' --sort timestamp:-1 --limit 5 --project type,summary,timestamp`);
  if (recent.exitCode === 0) stats.recent_activity = JSON.parse(recent.stdout);

  return ok(JSON.stringify(stats));
}

// ── INDEX ─────────────────────────────────────────────────

async function wikiIndex(exec: (cmd: string) => Promise<ExecResult>): Promise<ExecResult> {
  const pagesR = await exec(`db pages find '{}' --project slug,title,type,tags,updated_at --sort type:1`);
  if (pagesR.exitCode !== 0) return pagesR;

  const pages = JSON.parse(pagesR.stdout) as Array<Record<string, unknown>>;

  // Group by type
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
  const dataPlugin = createDataPlugin({
    rootDir: opts.rootDir ?? "/wiki",
    encryptionKey: opts.encryptionKey,
    authSecret: opts.authSecret,
    salt: opts.salt,
  });

  const wikiCmd = buildWikiCommand();

  return [...dataPlugin, wikiCmd] as Command[];
}
