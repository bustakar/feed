// Fetches trending open-source AI projects by GitHub star velocity.
//
// Pipeline (Method 2 — see project notes):
//   1. BigQuery over the public `githubarchive` dataset: count WatchEvents
//      (= stars gained) per repo over a trailing N-day window. This ranks ALL
//      of GitHub by star velocity in one ~1 GB query (well within BigQuery's
//      free tier).
//   2. Enrich the top candidates via the GitHub REST API (topics, language,
//      description, current total stars).
//   3. Keep only repos that look like AI projects (topic/keyword match).
//   4. Rank by absolute stars gained over the window (growth_rate is kept as an
//      informational field) and write a dated snapshot to
//      /data/github/<window-end>.json. The Astro build renders only the most
//      recent github snapshot (see src/lib/feed.ts).
//
// Trigger: this module exports `updateGithubTrending(opts)` so another agent can
// import and call it; running the file directly invokes it as a CLI.
//
// Requirements: gcloud authed to a billable GCP project (the script gets an
// access token via `gcloud auth print-access-token` and calls the BigQuery
// REST API directly — the `bq` CLI hangs when spawned as a child process here),
// and a GitHub token (env GITHUB_TOKEN, falls back to `gh auth token`, then to
// the token embedded in the repo's HTTPS origin URL if present).
//
// Usage:
//   node scripts/fetch-trending.mjs            # trailing 7 days, top 30 AI repos
//   WINDOW_DAYS=14 TOP_N=50 node scripts/fetch-trending.mjs
//   GCP_PROJECT=my-proj node scripts/fetch-trending.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
// GitHub snapshots live in data/github/. Each run writes one dated file; the
// site renders only the most recent (see src/lib/feed.ts).
const GITHUB_DIR = join(__dirname, "..", "data", "github");

// --- Tunables -------------------------------------------------------------
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 7); // velocity window
const TOP_N = Number(process.env.TOP_N ?? 30); // AI repos to keep
const CANDIDATE_LIMIT = Number(process.env.CANDIDATE_LIMIT ?? 200); // rows from BQ
// Noise floors: rank by growth rate, but require a repo to clear both a total-
// star floor and a minimum absolute gain so a 40→120 spike can't top the list.
const MIN_TOTAL_STARS = Number(process.env.MIN_TOTAL_STARS ?? 100);
const MIN_VELOCITY = Number(process.env.MIN_VELOCITY ?? 50);
const GCP_PROJECT = process.env.GCP_PROJECT ?? ""; // optional override
const ENRICH_CONCURRENCY = 8;

// Topics that mark a repo as AI (exact match against GitHub repo topics).
const AI_TOPICS = new Set([
  "ai", "artificial-intelligence", "agi", "llm", "llms", "large-language-models",
  "machine-learning", "ml", "deep-learning", "deeplearning", "neural-network",
  "neural-networks", "nlp", "natural-language-processing", "generative-ai",
  "genai", "gpt", "chatgpt", "openai", "anthropic", "claude", "gemini", "llama",
  "mistral", "rag", "retrieval-augmented-generation", "agent", "agents",
  "ai-agents", "agentic", "autonomous-agents", "mcp", "model-context-protocol",
  "transformers", "transformer", "diffusion", "stable-diffusion", "text-to-image",
  "text-to-speech", "speech-recognition", "computer-vision", "llmops", "mlops",
  "embeddings", "vector-database", "vector-search", "fine-tuning",
  "prompt-engineering", "prompts", "langchain", "llamaindex", "ollama", "vllm",
  "multimodal", "reinforcement-learning", "foundation-models", "ai-tools",
  "ai-agent", "chatbot", "copilot", "inference", "image-generation",
]);

// Whole-word keyword fallback for name + description (case-insensitive).
const AI_KEYWORDS =
  /\b(a\.?i|llms?|gpt[\d-]*|agentic|agents?|rag|chatbots?|chatgpt|openai|anthropic|claude|gemini|llama|mistral|deepseek|qwen|machine[ -]learning|deep[ -]learning|neural|nlp|generative|diffusion|transformers?|embeddings?|fine[ -]?tun\w*|prompt\w*|inference|multimodal|copilot|mcp|text-to-\w+|speech|vision[ -]model)\b/i;

function log(...args) {
  console.log(...args);
}

/** Resolve a GitHub token from env, gh CLI, or this repo's HTTPS origin URL. */
async function getGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    const { stdout } = await execFileP("gh", ["auth", "token"]);
    return stdout.trim();
  } catch {
    // The repo is sometimes cloned with a fine-grained token embedded in the
    // HTTPS origin so cron can pull/push without the gh CLI. Reuse that token
    // for GitHub REST enrichment, but never print it.
    try {
      const { stdout } = await execFileP("git", ["remote", "get-url", "origin"]);
      const url = new URL(stdout.trim());
      if (url.hostname === "github.com" && url.username === "x-access-token") {
        const token = decodeURIComponent(url.password || "").trim();
        if (token) return token;
      }
    } catch {
      // Ignore and throw the user-facing error below.
    }
    throw new Error(
      "No GitHub token. Set GITHUB_TOKEN, run `gh auth login`, or use an x-access-token HTTPS origin.",
    );
  }
}

/** Access token for the BigQuery REST API (env GCP_TOKEN or gcloud). */
async function getGcpToken() {
  if (process.env.GCP_TOKEN) return process.env.GCP_TOKEN.trim();
  try {
    const { stdout } = await execFileP("gcloud", ["auth", "print-access-token"]);
    return stdout.trim();
  } catch {
    throw new Error("No GCP token. Set GCP_TOKEN or run `gcloud auth login`.");
  }
}

/** Billing/default project id (env GCP_PROJECT or gcloud config). */
async function getGcpProject() {
  if (GCP_PROJECT) return GCP_PROJECT;
  const { stdout } = await execFileP("gcloud", ["config", "get-value", "project"]);
  const p = stdout.trim();
  if (!p || p === "(unset)") throw new Error("No GCP project. Set GCP_PROJECT.");
  return p;
}

/**
 * Run a standard-SQL query against BigQuery via the REST API and return all
 * rows as arrays of cell values. We call REST directly because the `bq` CLI
 * deadlocks when spawned as a child process in this environment, whereas
 * fetch() to bigquery.googleapis.com works fine.
 */
async function bqQuery(sql, project, token) {
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${project}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  let res = await fetch(`${base}/queries`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      timeoutMs: 60000,
      maxResults: CANDIDATE_LIMIT,
    }),
  });
  let body = await res.json();
  if (!res.ok) {
    throw new Error(`BigQuery ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
  }
  // The job may not finish within the inline timeout; poll getQueryResults.
  const jobId = body.jobReference?.jobId;
  const location = body.jobReference?.location;
  const rows = [];
  const collect = (b) => (b.rows ?? []).forEach((r) => rows.push(r.f.map((c) => c.v)));
  while (!body.jobComplete) {
    const u = new URL(`${base}/queries/${jobId}`);
    u.searchParams.set("timeoutMs", "60000");
    u.searchParams.set("maxResults", String(CANDIDATE_LIMIT));
    if (location) u.searchParams.set("location", location);
    res = await fetch(u, { headers });
    body = await res.json();
    if (!res.ok) throw new Error(`BigQuery poll ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  }
  collect(body);
  // Follow pageToken if the result set spilled across pages.
  let pageToken = body.pageToken;
  while (pageToken && rows.length < CANDIDATE_LIMIT) {
    const u = new URL(`${base}/queries/${jobId}`);
    u.searchParams.set("pageToken", pageToken);
    u.searchParams.set("maxResults", String(CANDIDATE_LIMIT));
    if (location) u.searchParams.set("location", location);
    res = await fetch(u, { headers });
    body = await res.json();
    if (!res.ok) break;
    collect(body);
    pageToken = body.pageToken;
  }
  return rows;
}

/** UTC YYYYMMDD for `daysAgo` days before now. */
function suffixDaysAgo(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return { suffix: `${y}${m}${day}`, iso: `${y}-${m}-${day}` };
}

/**
 * Query GH Archive for star velocity. The latest daily table lands a few hours
 * after the UTC day ends, so we end the window at "yesterday" (daysAgo=1).
 */
async function fetchVelocity(project, token) {
  const end = suffixDaysAgo(1); // yesterday — newest complete table
  const start = suffixDaysAgo(WINDOW_DAYS); // inclusive start
  // GH Archive day tables are named githubarchive.day.YYYYMMDD. We constrain a
  // single calendar year's wildcard with _TABLE_SUFFIX. If the window straddles
  // a year boundary, widen to a multi-year wildcard.
  const sameYear = start.suffix.slice(0, 4) === end.suffix.slice(0, 4);
  const wildcard = sameYear
    ? `\`githubarchive.day.${start.suffix.slice(0, 4)}*\``
    : "`githubarchive.day.20*`";
  const sStart = sameYear ? start.suffix.slice(4) : start.suffix;
  const sEnd = sameYear ? end.suffix.slice(4) : end.suffix;

  const sql = `
    SELECT repo.name AS repo, COUNT(*) AS stars_window
    FROM ${wildcard}
    WHERE _TABLE_SUFFIX BETWEEN '${sStart}' AND '${sEnd}'
      AND type = 'WatchEvent'
    GROUP BY repo
    ORDER BY stars_window DESC
    LIMIT ${CANDIDATE_LIMIT}`;

  log(`Querying GH Archive: ${start.iso} → ${end.iso} (${WINDOW_DAYS}d)…`);
  const rows = await bqQuery(sql, project, token);
  log(`  ${rows.length} candidate repos by velocity.`);
  return {
    windowEnd: end.iso,
    // Each row is [repo, stars_window] (cell values from the REST API).
    rows: rows.map(([repo, stars]) => ({ repo, velocity: Number(stars) })),
  };
}

/** Decide whether an enriched repo belongs to the AI space. */
function isAiRepo(meta) {
  if (Array.isArray(meta.topics)) {
    for (const t of meta.topics) if (AI_TOPICS.has(t)) return true;
  }
  const haystack = `${meta.full_name} ${meta.description ?? ""}`;
  return AI_KEYWORDS.test(haystack);
}

/** Fetch repo metadata from the GitHub REST API. Returns null on 404/errors. */
async function fetchRepoMeta(fullName, token) {
  const res = await fetch(`https://api.github.com/repos/${fullName}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "feed-trending-fetcher",
    },
  });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(
      `GitHub rate limited (reset ${reset ? new Date(reset * 1000).toISOString() : "?"}).`,
    );
  }
  if (!res.ok) {
    log(`  warn: ${fullName} → HTTP ${res.status}`);
    return null;
  }
  return res.json();
}

/** Enrich candidates in small concurrent batches, preserving velocity order. */
async function enrich(candidates, token) {
  const out = [];
  for (let i = 0; i < candidates.length; i += ENRICH_CONCURRENCY) {
    const batch = candidates.slice(i, i + ENRICH_CONCURRENCY);
    const metas = await Promise.all(
      batch.map((c) => fetchRepoMeta(c.repo, token).catch((e) => {
        if (/rate limited/.test(e.message)) throw e;
        return null;
      })),
    );
    metas.forEach((meta, j) => {
      if (meta) out.push({ ...batch[j], meta });
    });
  }
  return out;
}

/** Compact a number: 1234 → "1.2k". */
function compact(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

/**
 * Run the full pipeline and write data/github/<window-end>.json.
 * Exported so another agent can trigger an update programmatically.
 * @returns the snapshot object that was written.
 */
export async function updateGithubTrending() {
  const token = await getGithubToken();
  const [gcpToken, gcpProject] = await Promise.all([getGcpToken(), getGcpProject()]);
  const { windowEnd, rows } = await fetchVelocity(gcpProject, gcpToken);

  log(`Enriching ${rows.length} candidates via GitHub API…`);
  const enriched = await enrich(rows, token);

  const ranked = enriched
    .filter((e) => isAiRepo(e.meta))
    .filter((e) => (e.meta.stargazers_count ?? 0) >= MIN_TOTAL_STARS)
    .filter((e) => e.velocity >= MIN_VELOCITY)
    .map((e) => {
      const stars = e.meta.stargazers_count ?? 0;
      // Stars at the window's start; growth is gain relative to that base.
      const base = Math.max(stars - e.velocity, 1);
      return {
        repo: e.meta.full_name,
        url: e.meta.html_url,
        description: (e.meta.description ?? "").trim() || null,
        language: e.meta.language ?? null,
        stars,
        stars_gained: e.velocity,
        growth_rate: Number((e.velocity / base).toFixed(4)),
        topics: Array.isArray(e.meta.topics) ? e.meta.topics.slice(0, 8) : [],
      };
    })
    .sort((a, b) => b.stars_gained - a.stars_gained)
    .slice(0, TOP_N);

  log(`  ${ranked.length} AI repos after filtering (of ${enriched.length}).`);

  const snapshot = {
    date: windowEnd,
    window_days: WINDOW_DAYS,
    generated_at: new Date().toISOString(),
    repos: ranked,
  };

  await mkdir(GITHUB_DIR, { recursive: true });
  const file = join(GITHUB_DIR, `${windowEnd}.json`);
  await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n");
  log(`Wrote ${ranked.length} repos → data/github/${windowEnd}.json`);

  // Console preview (gain, total, growth %).
  ranked.slice(0, 15).forEach((r, i) => {
    const pct = `${(r.growth_rate * 100).toFixed(0)}%`;
    log(
      `  ${String(i + 1).padStart(2)}. +${String(r.stars_gained).padStart(5)}  ${r.repo}  (${compact(r.stars)}, ${pct})`,
    );
  });

  return snapshot;
}

// CLI entrypoint: only run when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  updateGithubTrending().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
