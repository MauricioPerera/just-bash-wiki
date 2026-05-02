import { Bash, InMemoryFs } from "just-bash";
import { createWikiPlugin } from "./dist/index.js";

const bash = new Bash({
  fs: new InMemoryFs({}),
  customCommands: createWikiPlugin({ rootDir: "/wiki", embeddingDim: 4 }),
});

const exec = async (label, cmd) => {
  const r = await bash.exec(cmd);
  console.log(`\n=== ${label} ===`);
  if (r.stdout) {
    try { console.log(JSON.stringify(JSON.parse(r.stdout), null, 2)); }
    catch { console.log(r.stdout); }
  }
  if (r.stderr) console.log("ERR:", r.stderr.trim());
  console.log("exit:", r.exitCode);
  return r;
};

async function run() {
  // ── INIT ──
  await exec("INIT", `wiki init --dim=4`);

  // ── SOURCES ──
  await exec("SOURCE ADD 1", `wiki source add '{"title":"AI Overview","type":"article","content":"Artificial intelligence is transforming every industry...","url":"https://example.com/ai","author":"John"}'`);
  await exec("SOURCE ADD 2", `wiki source add '{"title":"ML Fundamentals","type":"paper","content":"Machine learning is a subset of AI focused on learning from data...","author":"Jane"}'`);
  await exec("SOURCE ADD 3", `wiki source add '{"title":"Neural Networks","type":"article","content":"Deep learning uses neural networks with multiple layers...","author":"Bob"}'`);

  await exec("SOURCE LIST", `wiki source list`);
  await exec("SOURCE COUNT", `wiki source count`);

  // ── PAGES ──
  await exec("PAGE CREATE: AI", `wiki page create '{"slug":"ai","title":"Artificial Intelligence","type":"concept","content":"# Artificial Intelligence\\nAI is the simulation of human intelligence by machines.","tags":["ai","tech"],"links_to":["ml","neural-nets"],"source_ids":[]}'`);

  await exec("PAGE CREATE: ML", `wiki page create '{"slug":"ml","title":"Machine Learning","type":"concept","content":"# Machine Learning\\nML is a subset of AI that learns from data.","tags":["ai","ml"],"links_to":["ai","neural-nets"],"source_ids":[]}'`);

  await exec("PAGE CREATE: Neural Nets", `wiki page create '{"slug":"neural-nets","title":"Neural Networks","type":"entity","content":"# Neural Networks\\nDeep learning architectures with multiple layers.","tags":["ai","deep-learning"],"links_to":["ml"],"source_ids":[]}'`);

  await exec("PAGE CREATE: Overview", `wiki page create '{"slug":"overview","title":"Wiki Overview","type":"overview","content":"# AI Research Wiki\\nThis wiki covers AI, ML, and neural networks.","tags":["meta"],"links_to":["ai","ml","neural-nets"]}'`);

  await exec("PAGE LIST", `wiki page list`);
  await exec("PAGE LIST --type=concept", `wiki page list --type=concept`);
  await exec("PAGE GET", `wiki page get ai`);

  // ── UPDATE ──
  await exec("PAGE UPDATE", `wiki page update ai '{"$set":{"content":"# Artificial Intelligence\\nAI encompasses ML, neural networks, and more.","tags":["ai","tech","updated"]}}'`);
  await exec("PAGE GET after update", `wiki page get ai`);

  // ── EMBED vectors ──
  await exec("EMBED page ai", `wiki embed page ai '[1,0,0,0]' --meta '{"title":"Artificial Intelligence"}'`);
  await exec("EMBED page ml", `wiki embed page ml '[0.9,0.3,0,0]' --meta '{"title":"Machine Learning"}'`);
  await exec("EMBED page neural-nets", `wiki embed page neural-nets '[0.8,0.5,0.3,0]' --meta '{"title":"Neural Networks"}'`);
  await exec("EMBED page overview", `wiki embed page overview '[0.5,0.5,0.5,0]' --meta '{"title":"Wiki Overview"}'`);

  // ── SEARCH ──
  await exec("SEARCH (similar to AI)", `wiki search '[1,0,0,0]' --k=3`);
  await exec("SEARCH --type=all", `wiki search '[1,0,0,0]' --k=5 --type=all`);

  // ── ORPHANS ──
  await exec("ORPHANS", `wiki page orphans`);

  // ── INDEX ──
  await exec("INDEX", `wiki index`);

  // ── LINT ──
  await exec("LINT", `wiki lint`);

  // ── LOG ──
  await exec("LOG", `wiki log --last=10`);

  // ── STATS ──
  await exec("STATS", `wiki stats`);

  // ── DELETE page ──
  await exec("DELETE neural-nets", `wiki page delete neural-nets`);
  await exec("PAGE LIST after delete", `wiki page list`);

  // ── FINAL STATS ──
  await exec("FINAL STATS", `wiki stats`);
}

run().catch(console.error);
