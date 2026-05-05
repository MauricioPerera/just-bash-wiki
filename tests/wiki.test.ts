import { describe, it, expect, beforeEach } from "vitest";
import { Bash, InMemoryFs } from "just-bash";
import { createWikiPlugin } from "../src/index.js";
import type { Page, Source, LogEntry, LintResult } from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────

let bash: InstanceType<typeof Bash>;

const run = async (cmd: string) => {
  const r = await bash.exec(cmd);
  return { out: r.stdout, err: r.stderr, code: r.exitCode };
};

const json = <T = unknown>(stdout: string): T => JSON.parse(stdout);

beforeEach(() => {
  bash = new Bash({
    fs: new InMemoryFs({}),
    customCommands: createWikiPlugin({ rootDir: "/wiki", embeddingDim: 4 }),
  });
});

// ── Init ──────────────────────────────────────────────────

describe("wiki init", () => {
  it("creates all collections", async () => {
    const r = await run("wiki init --dim=4");
    expect(r.code).toBe(0);
    const data = json<{ initialized: boolean; collections: string[] }>(r.out);
    expect(data.initialized).toBe(true);
    expect(data.collections).toHaveLength(5);
  });

  it("is idempotent", async () => {
    await run("wiki init --dim=4");
    const r = await run("wiki init --dim=4");
    expect(r.code).toBe(0);
    const data = json<{ collections: string[] }>(r.out);
    expect(data.collections.every((c) => c.includes("exists"))).toBe(true);
  });

  it("uses WikiOptions defaults when flags omitted", async () => {
    const custom = new Bash({
      fs: new InMemoryFs({}),
      customCommands: createWikiPlugin({ rootDir: "/wiki", embeddingDim: 128, metric: "euclidean", quantize: "int8" }),
    });
    const r = await custom.exec("wiki init");
    expect(r.exitCode).toBe(0);
    const vecR = await custom.exec("vec stats page_embeddings");
    const stats = json<{ dim: number; metric: string; quantize: string }>(vecR.stdout);
    expect(stats.dim).toBe(128);
    expect(stats.metric).toBe("euclidean");
    expect(stats.quantize).toBe("int8");
  });

  it("CLI flags override WikiOptions defaults", async () => {
    const custom = new Bash({
      fs: new InMemoryFs({}),
      customCommands: createWikiPlugin({ rootDir: "/wiki", embeddingDim: 128 }),
    });
    const r = await custom.exec("wiki init --dim=64 --metric=dot");
    expect(r.exitCode).toBe(0);
    const vecR = await custom.exec("vec stats page_embeddings");
    const stats = json<{ dim: number; metric: string }>(vecR.stdout);
    expect(stats.dim).toBe(64);
    expect(stats.metric).toBe("dot");
  });
});

// ── Sources ───────────────────────────────────────────────

describe("wiki source", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
  });

  it("add inserts and returns id", async () => {
    const r = await run(`wiki source add '{"title":"Test Article","type":"article","content":"hello"}'`);
    expect(r.code).toBe(0);
    const data = json<{ source_id: string; title: string }>(r.out);
    expect(data.title).toBe("Test Article");
    expect(data.source_id).toBeTruthy();
  });

  it("add rejects missing title", async () => {
    const r = await run(`wiki source add '{"content":"no title"}'`);
    expect(r.code).toBe(2);
  });

  it("add rejects invalid json", async () => {
    const r = await run(`wiki source add 'not json'`);
    expect(r.code).toBe(2);
  });

  it("list returns all sources", async () => {
    await run(`wiki source add '{"title":"A","type":"article"}'`);
    await run(`wiki source add '{"title":"B","type":"paper"}'`);
    const r = await run("wiki source list");
    expect(json<Source[]>(r.out)).toHaveLength(2);
  });

  it("list filters by --type", async () => {
    await run(`wiki source add '{"title":"A","type":"article"}'`);
    await run(`wiki source add '{"title":"B","type":"paper"}'`);
    const r = await run("wiki source list --type=paper");
    const sources = json<Source[]>(r.out);
    expect(sources).toHaveLength(1);
    expect(sources[0].title).toBe("B");
  });

  it("list filters by --status", async () => {
    await run(`wiki source add '{"title":"A","status":"processed"}'`);
    await run(`wiki source add '{"title":"B"}'`);
    const r = await run("wiki source list --status=raw");
    expect(json<Source[]>(r.out)).toHaveLength(1);
  });

  it("get returns a source by id", async () => {
    const add = await run(`wiki source add '{"title":"X","content":"data"}'`);
    const id = json<{ source_id: string }>(add.out).source_id;
    const r = await run(`wiki source get ${id}`);
    expect(r.code).toBe(0);
    expect(json<Source[]>(r.out)[0].title).toBe("X");
  });

  it("count returns correct number", async () => {
    await run(`wiki source add '{"title":"A"}'`);
    await run(`wiki source add '{"title":"B"}'`);
    const r = await run("wiki source count");
    expect(json<{ count: number }>(r.out).count).toBe(2);
  });

  it("update modifies a source", async () => {
    const add = await run(`wiki source add '{"title":"Old"}'`);
    const id = json<{ source_id: string }>(add.out).source_id;
    const r = await run(`wiki source update ${id} '{"$set":{"status":"processed"}}'`);
    expect(r.code).toBe(0);
    const get = await run(`wiki source get ${id}`);
    expect(json<Source[]>(get.out)[0].status).toBe("processed");
  });

  it("delete removes a source", async () => {
    const add = await run(`wiki source add '{"title":"Gone"}'`);
    const id = json<{ source_id: string }>(add.out).source_id;
    const r = await run(`wiki source delete ${id}`);
    expect(r.code).toBe(0);
    const count = await run("wiki source count");
    expect(json<{ count: number }>(count.out).count).toBe(0);
  });
});

// ── Pages ─────────────────────────────────────────────────

describe("wiki page", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
  });

  it("create inserts a page with defaults", async () => {
    const r = await run(`wiki page create '{"slug":"test","title":"Test Page"}'`);
    expect(r.code).toBe(0);
    const data = json<{ _id: string; slug: string }>(r.out);
    expect(data.slug).toBe("test");

    const get = await run("wiki page get test");
    const page = json<Page[]>(get.out)[0];
    expect(page.type).toBe("concept");
    expect(page.tags).toEqual([]);
    expect(page.links_to).toEqual([]);
    expect(page.linked_from).toEqual([]);
    expect(page.created_at).toBeTruthy();
  });

  it("create rejects missing slug", async () => {
    const r = await run(`wiki page create '{"title":"No Slug"}'`);
    expect(r.code).toBe(2);
  });

  it("create rejects missing title", async () => {
    const r = await run(`wiki page create '{"slug":"no-title"}'`);
    expect(r.code).toBe(2);
  });

  it("create rejects duplicate slug", async () => {
    await run(`wiki page create '{"slug":"dup","title":"First"}'`);
    const r = await run(`wiki page create '{"slug":"dup","title":"Second"}'`);
    expect(r.code).not.toBe(0);
  });

  it("bidirectional cross-references work regardless of creation order", async () => {
    // A links to B, but B is created after A
    await run(`wiki page create '{"slug":"a","title":"A","links_to":["b"]}'`);
    await run(`wiki page create '{"slug":"b","title":"B","links_to":["a"]}'`);

    const getA = json<Page[]>((await run("wiki page get a")).out)[0];
    const getB = json<Page[]>((await run("wiki page get b")).out)[0];

    expect(getA.linked_from).toContain("b");
    expect(getB.linked_from).toContain("a");
  });

  it("update modifies content and timestamp", async () => {
    await run(`wiki page create '{"slug":"up","title":"Update Me"}'`);
    const before = json<Page[]>((await run("wiki page get up")).out)[0];

    await run(`wiki page update up '{"$set":{"content":"new content","tags":["updated"]}}'`);
    const after = json<Page[]>((await run("wiki page get up")).out)[0];

    expect(after.content).toBe("new content");
    expect(after.tags).toContain("updated");
    expect(after.updated_at).not.toBe(before.created_at);
  });

  it("list filters by --type", async () => {
    await run(`wiki page create '{"slug":"c1","title":"C1","type":"concept"}'`);
    await run(`wiki page create '{"slug":"e1","title":"E1","type":"entity"}'`);
    const r = await run("wiki page list --type=entity");
    const pages = json<Page[]>(r.out);
    expect(pages).toHaveLength(1);
    expect(pages[0].slug).toBe("e1");
  });

  it("list filters by --tag", async () => {
    await run(`wiki page create '{"slug":"t1","title":"T1","tags":["ai","ml"]}'`);
    await run(`wiki page create '{"slug":"t2","title":"T2","tags":["bio"]}'`);
    const r = await run("wiki page list --tag=ai");
    expect(json<Page[]>(r.out)).toHaveLength(1);
  });

  it("delete removes page, embedding, and cleans cross-refs", async () => {
    await run(`wiki page create '{"slug":"keep","title":"Keep","links_to":["del"]}'`);
    await run(`wiki page create '{"slug":"del","title":"Delete Me"}'`);
    await run(`wiki embed page del '[1,0,0,0]'`);

    await run("wiki page delete del");

    const list = json<Page[]>((await run("wiki page list")).out);
    expect(list).toHaveLength(1);
    expect(list[0].slug).toBe("keep");

    // linked_from should be cleaned
    const keep = json<Page[]>((await run("wiki page get keep")).out)[0];
    expect(keep.linked_from ?? []).not.toContain("del");

    // Embedding should be gone
    const vec = await run("vec get page_embeddings del");
    expect(vec.code).toBe(3);
  });

  it("orphans detects pages with no inbound links", async () => {
    await run(`wiki page create '{"slug":"hub","title":"Hub","links_to":["leaf"]}'`);
    await run(`wiki page create '{"slug":"leaf","title":"Leaf"}'`);
    const r = await run("wiki page orphans");
    const orphans = json<Page[]>(r.out);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].slug).toBe("hub");
  });
});

// ── Page Rename ───────────────────────────────────────────

describe("wiki page rename", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
  });

  it("renames slug and updates all cross-references", async () => {
    await run(`wiki page create '{"slug":"old","title":"Old","links_to":["target"]}'`);
    await run(`wiki page create '{"slug":"target","title":"Target","links_to":["old"]}'`);
    await run(`wiki embed page old '[1,0,0,0]'`);

    const r = await run("wiki page rename old new-name");
    expect(r.code).toBe(0);

    // Old slug gone
    const oldGet = json<Page[]>((await run("wiki page get old")).out);
    expect(oldGet).toHaveLength(0);

    // New slug exists
    const newGet = json<Page[]>((await run("wiki page get new-name")).out);
    expect(newGet).toHaveLength(1);

    // Target's links_to updated
    const target = json<Page[]>((await run("wiki page get target")).out)[0];
    expect(target.links_to).toContain("new-name");
    expect(target.links_to).not.toContain("old");

    // Target's linked_from updated
    expect(target.linked_from).toContain("new-name");
    expect(target.linked_from).not.toContain("old");

    // Embedding re-keyed
    const vecOld = await run("vec get page_embeddings old");
    expect(vecOld.code).toBe(3);
    const vecNew = await run("vec get page_embeddings new-name");
    expect(vecNew.code).toBe(0);
  });

  it("rejects rename to existing slug", async () => {
    await run(`wiki page create '{"slug":"a","title":"A"}'`);
    await run(`wiki page create '{"slug":"b","title":"B"}'`);
    const r = await run("wiki page rename a b");
    expect(r.code).toBe(5);
  });

  it("rejects rename to invalid slug", async () => {
    await run(`wiki page create '{"slug":"valid","title":"V"}'`);
    const r = await run("wiki page rename valid INVALID");
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid slug");
  });

  it("rejects rename from invalid old slug", async () => {
    const r = await run("wiki page rename BAD-OLD new-name");
    expect(r.code).toBe(2);
    expect(r.err).toContain("old slug");
  });

  it("rejects rename of non-existent slug", async () => {
    const r = await run("wiki page rename ghost new");
    expect(r.code).toBe(3);
  });
});

// ── Embed & Search ────────────────────────────────────────

describe("wiki embed & search", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
    await run(`wiki page create '{"slug":"ai","title":"AI"}'`);
    await run(`wiki page create '{"slug":"ml","title":"ML"}'`);
  });

  it("stores and retrieves embeddings", async () => {
    const r = await run("wiki embed page ai '[1,0,0,0]'");
    expect(r.code).toBe(0);
    const vec = await run("vec get page_embeddings ai");
    expect(vec.code).toBe(0);
  });

  it("re-embed overwrites previous", async () => {
    await run("wiki embed page ai '[1,0,0,0]'");
    await run("wiki embed page ai '[0,1,0,0]'");
    const vec = await run("vec get page_embeddings ai");
    const data = json<{ vector: number[] }>(vec.out);
    expect(data.vector[0]).toBeCloseTo(0);
    expect(data.vector[1]).toBeCloseTo(1);
  });

  it("search returns ranked results", async () => {
    await run("wiki embed page ai '[1,0,0,0]'");
    await run("wiki embed page ml '[0,1,0,0]'");
    const r = await run("wiki search '[1,0,0,0]' --k=2");
    expect(r.code).toBe(0);
    const hits = json<Array<{ id: string; score: number }>>(r.out);
    expect(hits).toHaveLength(2);
    expect(hits[0].id).toBe("ai");
    expect(hits[0].score).toBe(1);
  });

  it("search --type=all includes source embeddings", async () => {
    await run(`wiki source add '{"title":"Src"}'`);
    const add = json<{ source_id: string }>((await run(`wiki source add '{"title":"S2"}'`)).out);
    await run(`wiki embed source ${add.source_id} '[0,0,1,0]'`);
    await run("wiki embed page ai '[1,0,0,0]'");

    const r = await run("wiki search '[0,0,1,0]' --k=5 --type=all");
    const hits = json<Array<{ id: string; coll: string }>>(r.out);
    expect(hits.some((h) => h.coll === "source_embeddings")).toBe(true);
  });
});

// ── Lint ──────────────────────────────────────────────────

describe("wiki lint", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
  });

  it("reports orphan pages", async () => {
    await run(`wiki page create '{"slug":"lonely","title":"Lonely"}'`);
    const r = await run("wiki lint");
    const result = json<LintResult>(r.out);
    expect(result.issues.some((i) => i.type === "orphan" && i.slug === "lonely")).toBe(true);
  });

  it("reports broken links", async () => {
    await run(`wiki page create '{"slug":"bad","title":"Bad","links_to":["nonexistent"]}'`);
    const r = await run("wiki lint");
    const result = json<LintResult>(r.out);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.type === "broken-link")).toBe(true);
  });

  it("reports empty content", async () => {
    await run(`wiki page create '{"slug":"empty","title":"Empty","content":""}'`);
    const r = await run("wiki lint");
    const result = json<LintResult>(r.out);
    expect(result.issues.some((i) => i.type === "empty-content")).toBe(true);
  });

  it("reports missing embeddings", async () => {
    await run(`wiki page create '{"slug":"no-vec","title":"No Vec"}'`);
    const r = await run("wiki lint");
    const result = json<LintResult>(r.out);
    expect(result.issues.some((i) => i.type === "missing-embeddings")).toBe(true);
  });

  it("reports unreferenced sources", async () => {
    await run(`wiki source add '{"title":"Unused Source"}'`);
    await run(`wiki page create '{"slug":"p","title":"P"}'`);
    const r = await run("wiki lint");
    const result = json<LintResult>(r.out);
    expect(result.issues.some((i) => i.type === "unreferenced-source")).toBe(true);
  });
});

// ── Index ─────────────────────────────────────────────────

describe("wiki index", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
  });

  it("lists pages grouped by type", async () => {
    await run(`wiki page create '{"slug":"c","title":"C","type":"concept"}'`);
    await run(`wiki page create '{"slug":"e","title":"E","type":"entity"}'`);
    const r = await run("wiki index");
    const data = json<{ total: number; by_type: Record<string, unknown[]> }>(r.out);
    expect(data.total).toBe(2);
    expect(data.by_type.concept).toHaveLength(1);
    expect(data.by_type.entity).toHaveLength(1);
  });

  it("--rebuild re-derives linked_from", async () => {
    // Create pages, then manually break linked_from
    await run(`wiki page create '{"slug":"a","title":"A","links_to":["b"]}'`);
    await run(`wiki page create '{"slug":"b","title":"B"}'`);

    // Corrupt linked_from on b
    await run(`db pages update '{"slug":"b"}' '{"$set":{"linked_from":[]}}'`);
    const broken = json<Page[]>((await run("wiki page get b")).out)[0];
    expect(broken.linked_from).toEqual([]);

    // Rebuild
    const r = await run("wiki index --rebuild");
    expect(r.code).toBe(0);

    // Verify fixed
    const fixed = json<Page[]>((await run("wiki page get b")).out)[0];
    expect(fixed.linked_from).toContain("a");
  });
});

// ── Log ───────────────────────────────────────────────────

describe("wiki log", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
  });

  it("auto-logs init", async () => {
    const r = await run("wiki log --last=1");
    const entries = json<LogEntry[]>(r.out);
    expect(entries[0].type).toBe("init");
  });

  it("auto-logs page operations", async () => {
    await run(`wiki page create '{"slug":"p","title":"P"}'`);
    await run(`wiki page update p '{"$set":{"content":"x"}}'`);
    await run("wiki page delete p");

    const r = await run("wiki log --type=page-create");
    expect(json<LogEntry[]>(r.out)).toHaveLength(1);

    const r2 = await run("wiki log --type=page-update");
    expect(json<LogEntry[]>(r2.out)).toHaveLength(1);

    const r3 = await run("wiki log --type=page-delete");
    expect(json<LogEntry[]>(r3.out)).toHaveLength(1);
  });

  it("log add creates custom entry", async () => {
    const r = await run(`wiki log add '{"type":"custom","summary":"test note"}'`);
    expect(r.code).toBe(0);
    const entries = json<LogEntry[]>((await run("wiki log --type=custom")).out);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe("test note");
  });
});

// ── Log trim ──────────────────────────────────────────────

describe("wiki log trim", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
  });

  it("rejects missing --keep", async () => {
    const r = await run("wiki log trim");
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage");
  });

  it("rejects negative --keep", async () => {
    const r = await run("wiki log trim --keep=-1");
    expect(r.code).toBe(2);
  });

  it("is a no-op when count <= keep", async () => {
    // After init there's one entry; keeping 5 should remove nothing.
    const r = await run("wiki log trim --keep=5");
    expect(r.code).toBe(0);
    const data = json<{ removed: number }>(r.out);
    expect(data.removed).toBe(0);
  });

  it("removes oldest entries beyond the keep window", async () => {
    // Add 10 custom entries in deterministic order. Together with the init
    // entry that's 11 total.
    for (let i = 0; i < 10; i++) {
      await run(`wiki log add '{"type":"custom","summary":"note ${i}"}'`);
    }
    const before = json<{ count: number }>((await run("db log count '{}'")).out);
    expect(before.count).toBe(11);

    const trim = await run("wiki log trim --keep=3");
    expect(trim.code).toBe(0);
    const data = json<{ kept: number; removed: number }>(trim.out);
    expect(data.kept).toBe(3);
    expect(data.removed).toBe(8);

    const after = json<{ count: number }>((await run("db log count '{}'")).out);
    expect(after.count).toBe(3);

    // The 3 most-recent entries should remain (notes 7, 8, 9).
    const remaining = json<LogEntry[]>(
      (await run(`db log find '{}' --sort timestamp:-1`)).out
    );
    const summaries = remaining.map((e) => e.summary);
    expect(summaries).toContain("note 9");
    expect(summaries).toContain("note 8");
    expect(summaries).toContain("note 7");
  });

  it("--keep=0 removes everything", async () => {
    for (let i = 0; i < 5; i++) {
      await run(`wiki log add '{"type":"x","summary":"${i}"}'`);
    }
    const r = await run("wiki log trim --keep=0");
    expect(r.code).toBe(0);
    const after = json<{ count: number }>((await run("db log count '{}'")).out);
    expect(after.count).toBe(0);
  });
});

describe("WikiOptions.logMaxEntries auto-trim", () => {
  it("does not run when not configured", async () => {
    // Default plugin instance has no logMaxEntries.
    await run("wiki init --dim=4");
    for (let i = 0; i < 30; i++) {
      await run(`wiki log add '{"type":"x","summary":"${i}"}'`);
    }
    const after = json<{ count: number }>((await run("db log count '{}'")).out);
    // 1 (init) + 30 = 31, no trim.
    expect(after.count).toBe(31);
  });

  it("trims opportunistically when cap is exceeded by ≥50%", async () => {
    const capped = new Bash({
      fs: new InMemoryFs({}),
      customCommands: createWikiPlugin({ rootDir: "/wiki", embeddingDim: 4, logMaxEntries: 4 }),
    });
    await capped.exec("wiki init --dim=4");

    // Need both: enough writes for the 16-call sample to fire, and enough
    // entries to exceed cap × 1.5 = 6 at the moment the sample fires.
    for (let i = 0; i < 40; i++) {
      await capped.exec(`wiki log add '{"type":"x","summary":"${i}"}'`);
    }

    const countR = await capped.exec("db log count '{}'");
    const total = JSON.parse(countR.stdout).count as number;
    // At least one trim must have brought the count back down to the cap.
    // Some growth between trims is expected; assert it never settles unbounded.
    expect(total).toBeLessThanOrEqual(4 + 16);  // cap + one full sample window
  });

  it("does not affect writes when below cap × 1.5", async () => {
    const capped = new Bash({
      fs: new InMemoryFs({}),
      customCommands: createWikiPlugin({ rootDir: "/wiki", embeddingDim: 4, logMaxEntries: 50 }),
    });
    await capped.exec("wiki init --dim=4");
    for (let i = 0; i < 20; i++) {
      await capped.exec(`wiki log add '{"type":"x","summary":"${i}"}'`);
    }
    const total = JSON.parse((await capped.exec("db log count '{}'")).stdout).count as number;
    // 1 init + 20 = 21, well below cap × 1.5 = 75.
    expect(total).toBe(21);
  });
});

// ── Stats ─────────────────────────────────────────────────

describe("wiki stats", () => {
  it("returns complete statistics", async () => {
    await run("wiki init --dim=4");
    await run(`wiki source add '{"title":"S1"}'`);
    await run(`wiki page create '{"slug":"p1","title":"P1"}'`);
    await run(`wiki page create '{"slug":"p2","title":"P2","type":"entity"}'`);

    const r = await run("wiki stats");
    expect(r.code).toBe(0);
    const stats = json<Record<string, unknown>>(r.out);
    expect(stats.pages).toBe(2);
    expect(stats.sources).toBe(1);
    expect(stats.log_entries).toBeGreaterThan(0);
    expect(stats.pages_by_type).toBeTruthy();
    expect(stats.page_embeddings).toBeTruthy();
    expect(stats.recent_activity).toBeTruthy();
  });
});

// ── JSON injection safety ─────────────────────────────────

describe("JSON injection safety", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
  });

  it("handles slugs with special characters", async () => {
    const r = await run(`wiki page create '{"slug":"foo-bar_123","title":"Special"}'`);
    expect(r.code).toBe(0);
    const get = await run("wiki page get foo-bar_123");
    expect(json<Page[]>(get.out)).toHaveLength(1);
  });

  it("handles titles with quotes", async () => {
    const r = await run(`wiki page create '{"slug":"quoted","title":"It\\u0027s a \\"test\\""}'`);
    expect(r.code).toBe(0);
  });

  it("handles content with newlines and special chars", async () => {
    const r = await run(`wiki page create '{"slug":"special","title":"S","content":"line1\\nline2\\ttab"}'`);
    expect(r.code).toBe(0);
    const get = json<Page[]>((await run("wiki page get special")).out)[0];
    expect(get.content).toContain("line1\nline2");
  });
});

// ── Slug validation ───────────────────────────────────────

describe("slug validation", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
  });

  it("accepts valid slugs", async () => {
    for (const slug of ["hello", "hello-world", "page_1", "a123"]) {
      const r = await run(`wiki page create '{"slug":"${slug}","title":"T"}'`);
      expect(r.code).toBe(0);
    }
  });

  it("rejects uppercase slugs", async () => {
    const r = await run(`wiki page create '{"slug":"UpperCase","title":"T"}'`);
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid slug");
  });

  it("rejects slugs with spaces", async () => {
    const r = await run(`wiki page create '{"slug":"has space","title":"T"}'`);
    expect(r.code).toBe(2);
  });

  it("rejects slugs starting with hyphen", async () => {
    const r = await run(`wiki page create '{"slug":"-bad","title":"T"}'`);
    expect(r.code).toBe(2);
  });

  it("rejects slugs with special chars", async () => {
    const r = await run(`wiki page create '{"slug":"bad;rm","title":"T"}'`);
    expect(r.code).toBe(2);
  });
});

// ── Multi-instance isolation ──────────────────────────────

describe("multi-instance isolation", () => {
  it("two createWikiPlugin instances don't share defaults", async () => {
    const bash1 = new Bash({
      fs: new InMemoryFs({}),
      customCommands: createWikiPlugin({ rootDir: "/w1", embeddingDim: 128 }),
    });
    const bash2 = new Bash({
      fs: new InMemoryFs({}),
      customCommands: createWikiPlugin({ rootDir: "/w2", embeddingDim: 256 }),
    });

    await bash1.exec("wiki init");
    await bash2.exec("wiki init");

    const s1 = JSON.parse((await bash1.exec("vec stats page_embeddings")).stdout);
    const s2 = JSON.parse((await bash2.exec("vec stats page_embeddings")).stdout);
    expect(s1.dim).toBe(128);
    expect(s2.dim).toBe(256);
  });
});

// ── Edge cases ────────────────────────────────────────────

describe("edge cases", () => {
  it("commands fail gracefully before init", async () => {
    const r = await run("wiki page list");
    expect(r.code).not.toBe(0);
  });

  it("unknown subcommand returns usage", async () => {
    const r = await run("wiki unknown");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown wiki command");
  });

  it("no args returns usage", async () => {
    const r = await run("wiki");
    expect(r.code).toBe(2);
  });

  it("embed rejects invalid vector", async () => {
    await run("wiki init --dim=4");
    const r = await run("wiki embed page test 'not-json'");
    expect(r.code).toBe(2);
  });
});

// ── Bug-fix regressions ───────────────────────────────────

describe("pageUpdate not-found rejection (#2)", () => {
  beforeEach(async () => { await run("wiki init --dim=4"); });

  it("returns exit 3 when slug doesn't exist", async () => {
    const r = await run(`wiki page update ghost '{"$set":{"content":"x"}}'`);
    expect(r.code).toBe(3);
    expect(r.err).toContain("not found");
  });

  it("does not log a misleading entry on no-op update", async () => {
    await run(`wiki page update ghost '{"$set":{"content":"x"}}'`);
    const log = json<LogEntry[]>((await run("wiki log --last=20")).out);
    expect(log.some((e) => e.summary?.includes?.("Page updated: ghost"))).toBe(false);
  });

  it("succeeds when slug exists", async () => {
    await run(`wiki page create '{"slug":"real","title":"Real"}'`);
    const r = await run(`wiki page update real '{"$set":{"content":"new"}}'`);
    expect(r.code).toBe(0);
  });
});

describe("sourceUpdate not-found rejection (#2)", () => {
  beforeEach(async () => { await run("wiki init --dim=4"); });

  it("returns exit 3 when id doesn't exist", async () => {
    const r = await run(`wiki source update fake-id '{"$set":{"status":"processed"}}'`);
    expect(r.code).toBe(3);
  });
});

describe("wikiSearch validation (#3, #6)", () => {
  beforeEach(async () => { await run("wiki init --dim=4"); });

  it("rejects malformed vector json", async () => {
    const r = await run(`wiki search 'not-an-array'`);
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid vector json");
  });

  it("rejects vectors that are not arrays", async () => {
    const r = await run(`wiki search '{"x":1}'`);
    expect(r.code).toBe(2);
    expect(r.err).toContain("must be a JSON array");
  });

  it("rejects unknown --type values", async () => {
    const r = await run(`wiki search '[1,2,3,4]' --type=bogus`);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown --type");
  });

  it("accepts valid --type values", async () => {
    for (const t of ["pages", "sources", "all"]) {
      const r = await run(`wiki search '[1,0,0,0]' --k=1 --type=${t}`);
      expect(r.code).toBe(0);
    }
  });
});

describe("wikiEmbed --meta position (#5)", () => {
  beforeEach(async () => { await run("wiki init --dim=4"); });

  it("accepts --meta before the vector", async () => {
    await run(`wiki page create '{"slug":"x","title":"X"}'`);
    const r = await run(`wiki embed --meta='{"k":"v"}' page x '[1,0,0,0]'`);
    expect(r.code).toBe(0);
    const got = json<{ metadata?: Record<string, string> }>((await run("vec get page_embeddings x")).out);
    expect(got.metadata?.k).toBe("v");
  });

  it("accepts --meta after the vector (legacy position)", async () => {
    await run(`wiki page create '{"slug":"y","title":"Y"}'`);
    const r = await run(`wiki embed page y '[1,0,0,0]' --meta='{"k":"v2"}'`);
    expect(r.code).toBe(0);
    const got = json<{ metadata?: Record<string, string> }>((await run("vec get page_embeddings y")).out);
    expect(got.metadata?.k).toBe("v2");
  });

  it("rejects unknown embed target", async () => {
    const r = await run(`wiki embed bogus xx '[1,0,0,0]'`);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown embed target");
  });
});

describe("wiki index --rebuild repair (#10)", () => {
  beforeEach(async () => { await run("wiki init --dim=4"); });

  it("rebuilds linked_from to match the inverse of links_to", async () => {
    await run(`wiki page create '{"slug":"a","title":"A","links_to":["b"]}'`);
    await run(`wiki page create '{"slug":"b","title":"B"}'`);
    await run(`wiki page create '{"slug":"c","title":"C","links_to":["b"]}'`);

    // Corrupt linked_from on b (extra ghost), and on a (false inbound).
    await run(`db pages update '{"slug":"b"}' '{"$set":{"linked_from":["ghost","a"]}}'`);
    await run(`db pages update '{"slug":"a"}' '{"$set":{"linked_from":["b"]}}'`);

    const r = await run("wiki index --rebuild");
    expect(r.code).toBe(0);

    const a = json<Page[]>((await run("wiki page get a")).out)[0];
    const b = json<Page[]>((await run("wiki page get b")).out)[0];
    const c = json<Page[]>((await run("wiki page get c")).out)[0];

    expect(a.linked_from).toEqual([]);
    expect((b.linked_from ?? []).slice().sort()).toEqual(["a", "c"]);
    expect(c.linked_from).toEqual([]);
  });
});

// ── Pagination on list commands (#7) ─────────────────────

describe("list pagination", () => {
  beforeEach(async () => {
    await run("wiki init --dim=4");
    for (let i = 0; i < 12; i++) {
      await run(`wiki source add '{"title":"src ${i}","type":"article"}'`);
      await run(`wiki page create '{"slug":"p${i}","title":"P${i}","type":"concept"}'`);
    }
  });

  it("source list respects --limit", async () => {
    const r = await run("wiki source list --limit=5");
    expect(json<Source[]>(r.out)).toHaveLength(5);
  });

  it("source list respects --offset", async () => {
    const all = json<Source[]>((await run("wiki source list")).out);
    const page2 = json<Source[]>((await run("wiki source list --limit=5 --offset=5")).out);
    expect(page2).toHaveLength(5);
    expect(page2[0].title).toBe(all[5].title);
  });

  it("page list respects --limit and --offset", async () => {
    const all = json<Page[]>((await run("wiki page list")).out);
    expect(all.length).toBeGreaterThanOrEqual(12);
    const slice = json<Page[]>((await run("wiki page list --limit=4 --offset=2")).out);
    expect(slice).toHaveLength(4);
    expect(slice[0].slug).toBe(all[2].slug);
  });

  it("wiki index respects --limit", async () => {
    const full = json<{ total: number }>((await run("wiki index")).out);
    expect(full.total).toBeGreaterThanOrEqual(12);
    const limited = json<{ total: number }>((await run("wiki index --limit=3")).out);
    expect(limited.total).toBe(3);
  });

  it("non-integer pagination flags are silently ignored", async () => {
    // Garbage input should not break the call; we just lose the flag.
    const r = await run("wiki page list --limit=abc --offset=-1");
    expect(r.code).toBe(0);
  });
});

describe("page orphans uses db query (#7)", () => {
  beforeEach(async () => { await run("wiki init --dim=4"); });

  it("returns only pages with empty linked_from", async () => {
    await run(`wiki page create '{"slug":"hub","title":"Hub","links_to":["leaf"]}'`);
    await run(`wiki page create '{"slug":"leaf","title":"Leaf"}'`);
    await run(`wiki page create '{"slug":"island","title":"Island"}'`);

    const orphans = json<Page[]>((await run("wiki page orphans")).out);
    const slugs = orphans.map((p) => p.slug).sort();
    // hub has no inbound, leaf is referenced by hub, island has none.
    expect(slugs).toEqual(["hub", "island"]);
  });

  it("respects --limit", async () => {
    for (let i = 0; i < 8; i++) {
      await run(`wiki page create '{"slug":"o${i}","title":"O${i}"}'`);
    }
    const slice = json<Page[]>((await run("wiki page orphans --limit=3")).out);
    expect(slice).toHaveLength(3);
  });
});

describe("wiki lint perf (#8)", () => {
  beforeEach(async () => { await run("wiki init --dim=4"); });

  it("flags pages with empty content as before", async () => {
    await run(`wiki page create '{"slug":"empty","title":"Empty","content":""}'`);
    await run(`wiki page create '{"slug":"full","title":"Full","content":"# Full\\nbody"}'`);
    const r = json<LintResult>((await run("wiki lint")).out);
    const empties = r.issues.filter((i) => i.type === "empty-content").map((i) => i.slug);
    expect(empties).toContain("empty");
    expect(empties).not.toContain("full");
  });

  it("flags pages with no content field as empty", async () => {
    // pageCreate now defaults content to "", so the field is always present
    // but matches the empty check.
    await run(`wiki page create '{"slug":"missing","title":"Missing"}'`);
    const r = json<LintResult>((await run("wiki lint")).out);
    const empties = r.issues.filter((i) => i.type === "empty-content").map((i) => i.slug);
    expect(empties).toContain("missing");
  });
});
