// End-to-end validation against Cloudflare Workers AI.
//
// Runs the full plugin surface against real bge-base-en-v1.5 embeddings,
// covering every issue closed in #12 / #13 / #14 / #15 plus the core
// ingest/search/lint flow.
//
// Auth resolution (in order):
//   1. CLOUDFLARE_API_TOKEN  + CLOUDFLARE_ACCOUNT_ID env vars (preferred for CI)
//   2. ~/.wrangler/config/default.toml oauth_token + WRANGLER_ACCOUNT_ID
//      (or the first --remote account if not pinned)
//
// If neither yields a token+account, the script exits 0 with a "skipped"
// notice — that way `npm run e2e` is safe to run in environments without
// CF credentials (CI default) without flipping the build red.
//
// Usage:
//   npm run e2e
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run e2e
//   E2E_MODEL=@cf/baai/bge-small-en-v1.5 E2E_DIM=384 npm run e2e

import { Bash, InMemoryFs } from "just-bash";
import { createWikiPlugin } from "../dist/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL = process.env.E2E_MODEL ?? "@cf/baai/bge-base-en-v1.5";
const DIM = Number(process.env.E2E_DIM ?? 768);

function resolveAuth() {
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, source: "env" };
  }
  const tomlPath = path.join(os.homedir(), ".wrangler", "config", "default.toml");
  if (!fs.existsSync(tomlPath)) return null;
  const toml = fs.readFileSync(tomlPath, "utf8");
  const token = toml.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  const account = process.env.WRANGLER_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return null;
  return { token, account, source: "wrangler-oauth" };
}

const auth = resolveAuth();
if (!auth) {
  console.log("[e2e] skipped: no Cloudflare credentials found");
  console.log("[e2e]   set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or");
  console.log("[e2e]   `wrangler login` and export WRANGLER_ACCOUNT_ID");
  process.exit(0);
}
console.log(`[e2e] auth: ${auth.source}, account=${auth.account.slice(0, 8)}…, model=${MODEL}, dim=${DIM}`);

const tally = { pass: 0, fail: 0, errors: [] };
const check = (label, cond, detail) => {
  if (cond) { tally.pass++; console.log(`  PASS  ${label}`); }
  else { tally.fail++; tally.errors.push(`${label}: ${detail ?? ""}`); console.log(`  FAIL  ${label}  -- ${detail ?? ""}`); }
};

async function embed(text) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${auth.account}/ai/run/${MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`CF AI ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (!j.success) throw new Error(`CF AI not ok: ${JSON.stringify(j.errors)}`);
  return j.result.data[0];
}

const bash = new Bash({
  fs: new InMemoryFs({}),
  customCommands: createWikiPlugin({ rootDir: "/wiki", embeddingDim: DIM, logMaxEntries: 100 }),
});
const exec = (cmd) => bash.exec(cmd);
const json = (s) => JSON.parse(s);

console.log(`\n== Setup ==`);
{
  const r = await exec(`wiki init --dim=${DIM}`);
  check("wiki init succeeds", r.exitCode === 0, r.stderr);
  const data = json(r.stdout);
  check("init reports 5 collections", data.collections.length === 5);
  check("init.collections includes page_embeddings", data.collections.some((c) => c.includes("page_embeddings")));
}

console.log(`\n== Sources (#7 pagination) ==`);
const sourceIds = [];
{
  const sources = [
    { title: "Transformers paper", type: "paper", content: "Attention is all you need. Multi-head self-attention layers replace recurrence in sequence modeling." },
    { title: "GPT lineage overview", type: "article", content: "Generative pretrained transformers scale autoregressive language modeling on next-token prediction." },
    { title: "Cloudflare Workers AI launch", type: "article", content: "Run open-source AI models on the edge with Cloudflare Workers AI, including embeddings, LLMs, and image generation." },
    { title: "RAG primer", type: "note", content: "Retrieval-augmented generation grounds LLM answers in retrieved documents to reduce hallucination." },
  ];
  for (const s of sources) {
    const r = await exec(`wiki source add '${JSON.stringify(s).replace(/'/g, "'\\''")}'`);
    check(`source add: ${s.title}`, r.exitCode === 0, r.stderr);
    if (r.exitCode === 0) sourceIds.push(json(r.stdout).source_id);
  }

  const list = json((await exec(`wiki source list --limit=2`)).stdout);
  check("source list --limit=2 returns 2", list.length === 2);

  const page2 = json((await exec(`wiki source list --limit=2 --offset=2`)).stdout);
  check("source list --offset=2 returns the next slice", page2.length === 2);
  check("--limit=abc tolerated", (await exec(`wiki source list --limit=abc`)).exitCode === 0);
}

console.log(`\n== Pages + cross-refs ==`);
{
  const pages = [
    { slug: "transformers", title: "Transformers", type: "concept", content: "Self-attention based seq2seq architecture introduced in 2017.", tags: ["nn", "seq2seq"], links_to: ["attention", "gpt"], source_ids: [sourceIds[0]] },
    { slug: "attention", title: "Attention Mechanism", type: "concept", content: "Weighted sum over a learned similarity between query and key vectors.", tags: ["nn"], links_to: ["transformers"], source_ids: [sourceIds[0]] },
    { slug: "gpt", title: "GPT Family", type: "concept", content: "Decoder-only autoregressive transformer trained on next-token prediction.", tags: ["llm"], links_to: ["transformers"], source_ids: [sourceIds[1]] },
    { slug: "rag", title: "Retrieval-Augmented Generation", type: "concept", content: "Combine retrieval with generation to ground LLM answers in source documents.", tags: ["llm", "ir"], links_to: ["gpt"], source_ids: [sourceIds[3]] },
    { slug: "cf-workers-ai", title: "Cloudflare Workers AI", type: "entity", content: "Cloudflare's edge inference platform for open-source AI models.", tags: ["infra"], links_to: [], source_ids: [sourceIds[2]] },
    { slug: "empty-page", title: "Empty test", type: "concept", content: "" },
    { slug: "ghost-link", title: "Broken link test", type: "concept", content: "Refers nowhere.", links_to: ["does-not-exist"] },
  ];
  for (const p of pages) {
    const r = await exec(`wiki page create '${JSON.stringify(p).replace(/'/g, "'\\''")}'`);
    check(`page create: ${p.slug}`, r.exitCode === 0, r.stderr);
  }

  const transformers = json((await exec(`wiki page get transformers`)).stdout)[0];
  check("transformers.linked_from contains attention", transformers.linked_from.includes("attention"));
  check("transformers.linked_from contains gpt", transformers.linked_from.includes("gpt"));

  const orphans = json((await exec(`wiki page orphans`)).stdout);
  const orphanSlugs = orphans.map((o) => o.slug);
  check("orphans includes cf-workers-ai (no inbound)", orphanSlugs.includes("cf-workers-ai"));
  check("orphans includes empty-page", orphanSlugs.includes("empty-page"));
  check("orphans does NOT include transformers (has inbound)", !orphanSlugs.includes("transformers"));
}

console.log(`\n== Real embeddings via Cloudflare Workers AI ==`);
const queryVec = await embed("How does retrieval grounding reduce LLM hallucination?");
{
  const slugs = ["transformers", "attention", "gpt", "rag", "cf-workers-ai"];
  for (const slug of slugs) {
    const page = json((await exec(`wiki page get ${slug}`)).stdout)[0];
    const vec = await embed(`${page.title}\n${page.content}`);
    check(`embed: ${slug} dim=${vec.length}`, vec.length === DIM);
    const r = await exec(`wiki embed page ${slug} '${JSON.stringify(vec)}' --meta='${JSON.stringify({ title: page.title }).replace(/'/g, "'\\''")}'`);
    check(`wiki embed page ${slug}`, r.exitCode === 0, r.stderr);
  }

  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    const src = json((await exec(`wiki source get ${id}`)).stdout)[0];
    const vec = await embed(`${src.title}\n${src.content ?? ""}`);
    const r = await exec(`wiki embed source ${id} '${JSON.stringify(vec)}'`);
    check(`wiki embed source #${i + 1}`, r.exitCode === 0, r.stderr);
  }
}

console.log(`\n== Semantic search ==`);
{
  const r = await exec(`wiki search '${JSON.stringify(queryVec)}' --k=3`);
  check("wiki search exit 0", r.exitCode === 0, r.stderr);
  const results = json(r.stdout);
  check("wiki search returns 3 results", Array.isArray(results) && results.length === 3);
  console.log(`     top-3 by similarity: ${results.map((x) => `${x.id ?? x.key}(${(x.score ?? 0).toFixed(3)})`).join(", ")}`);
  check("top result is rag (best match for the question)", results[0]?.id === "rag" || results[0]?.key === "rag");

  const all = json((await exec(`wiki search '${JSON.stringify(queryVec)}' --k=5 --type=all`)).stdout);
  check("--type=all returns ≥5 hits across collections", Array.isArray(all) && all.length >= 5);

  const bad = await exec(`wiki search '${JSON.stringify(queryVec)}' --type=bogus`);
  check("#6: unknown --type rejected", bad.exitCode === 2);

  const malformed = await exec(`wiki search 'not-an-array'`);
  check("#3: malformed vector rejected", malformed.exitCode === 2);
}

console.log(`\n== Bug-fix regressions ==`);
{
  const noop = await exec(`wiki page update never-was '{"$set":{"content":"x"}}'`);
  check("#2: pageUpdate on missing slug → exit 3", noop.exitCode === 3);

  await exec(`wiki page create '{"slug":"meta-test","title":"Meta"}'`);
  const v = await embed("meta test");
  const embedR = await exec(`wiki embed --meta='${JSON.stringify({ tag: "early" })}' page meta-test '${JSON.stringify(v)}'`);
  check("#5: --meta before vector accepted", embedR.exitCode === 0, embedR.stderr);
  const got = json((await exec(`vec get page_embeddings meta-test`)).stdout);
  check("#5: --meta payload reached vec store", got.metadata?.tag === "early");

  await exec(`wiki page update transformers '{"$set":{"status":"published"}}'`);
  const filtered = json((await exec(`wiki page list --status=published`)).stdout);
  check("#11: --status filter returns 1 published page", filtered.length === 1);
}

console.log(`\n== Lint (#8 perf) ==`);
{
  const lintR = await exec(`wiki lint`);
  check("wiki lint exit 0", lintR.exitCode === 0, lintR.stderr);
  const lint = json(lintR.stdout);
  console.log(`     issues: total=${lint.total} errors=${lint.errors} warnings=${lint.warnings} info=${lint.info}`);
  const types = new Set(lint.issues.map((i) => i.type));
  check("lint detects empty-content (empty-page)", lint.issues.some((i) => i.type === "empty-content" && i.slug === "empty-page"));
  check("lint detects broken-link (ghost-link)", lint.issues.some((i) => i.type === "broken-link" && i.slug === "ghost-link"));
  check("lint detects orphan(s)", types.has("orphan"));
  const stdoutHasBody = lintR.stdout.includes("Self-attention based") || lintR.stdout.includes("Decoder-only");
  check("#8: lint stdout does not include full page content", !stdoutHasBody);
}

console.log(`\n== Index --rebuild (#10) ==`);
{
  await exec(`db pages update '{"slug":"transformers"}' '{"$set":{"linked_from":["ghost1","ghost2"]}}'`);
  const rebuild = await exec(`wiki index --rebuild`);
  check("#10: rebuild exit 0", rebuild.exitCode === 0, rebuild.stderr);
  const after = json((await exec(`wiki page get transformers`)).stdout)[0];
  check("#10: linked_from restored without ghosts", !after.linked_from.includes("ghost1") && !after.linked_from.includes("ghost2"));
  check("#10: linked_from contains real linkers", after.linked_from.includes("attention") && after.linked_from.includes("gpt"));
}

console.log(`\n== Log trim (#9) ==`);
{
  const before = json((await exec(`db log count '{}'`)).stdout).count;
  console.log(`     log entries before trim: ${before}`);
  const trim = await exec(`wiki log trim --keep=10`);
  check("#9: wiki log trim exit 0", trim.exitCode === 0, trim.stderr);
  const data = json(trim.stdout);
  check("#9: trim kept=10", data.kept === 10);
  check("#9: trim removed >0", data.removed > 0);
  const after = json((await exec(`db log count '{}'`)).stdout).count;
  check("#9: count is exactly 10 after trim", after === 10);

  const initial = json((await exec(`db log count '{}'`)).stdout).count;
  for (let i = 0; i < 200; i++) {
    await exec(`wiki log add '{"type":"flood","summary":"flood ${i}"}'`);
  }
  const post = json((await exec(`db log count '{}'`)).stdout).count;
  console.log(`     after 200 floods: ${post} (cap=100, started at ${initial})`);
  // Auto-trim oscillates between cap (post-trim) and 1.5×cap + sample window
  // (just before next trim). Upper bound is therefore cap × 1.5 + 16 = 166.
  check("#9: auto-trim kept count below unbounded growth", post < initial + 200);
  check("#9: auto-trim ceiling within 1.5×cap + sample window", post <= Math.floor(100 * 1.5) + 16);
}

console.log(`\n== Stats ==`);
{
  const r = await exec(`wiki stats`);
  check("wiki stats exit 0", r.exitCode === 0, r.stderr);
  const stats = json(r.stdout);
  console.log(`     pages=${stats.pages} sources=${stats.sources} log=${stats.log_entries} page_emb=${stats.page_embeddings?.count} src_emb=${stats.source_embeddings?.count}`);
  check("stats.pages > 0", stats.pages > 0);
  check("stats.page_embeddings.count > 0", stats.page_embeddings?.count > 0);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  ${tally.pass} passed, ${tally.fail} failed`);
if (tally.fail > 0) {
  console.log(`\nFailures:`);
  for (const e of tally.errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log(`${"=".repeat(50)}\n`);
