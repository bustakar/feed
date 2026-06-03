// Loads the two content types at build time and exposes them to the pages:
//   - News: one JSON file per day in /data/news (newest first, paginated).
//   - GitHub: dated trending snapshots in /data/github; only the most recent
//     one is rendered. Snapshots are written by scripts/fetch-trending.mjs.

// --- News -----------------------------------------------------------------

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  source?: string;
  // Optional explicit group override. When omitted the group is inferred from
  // source/title by groupForItem(). Accepts a group id ("anthropic") or label.
  group?: string;
}

export interface Day {
  date: string; // YYYY-MM-DD
  items: FeedItem[];
}

// News lives in data/news/ (one file per day). The news agent writes here.
const newsModules = import.meta.glob<{ default: Day }>("../../data/news/*.json", {
  eager: true,
});

function isValidDay(d: unknown): d is Day {
  if (!d || typeof d !== "object") return false;
  const day = d as Day;
  return (
    typeof day.date === "string" &&
    Array.isArray(day.items) &&
    day.items.every(
      (it) => it && typeof it.title === "string" && typeof it.url === "string",
    )
  );
}

// All news days, newest first. Empty days are dropped.
export const days: Day[] = Object.values(newsModules)
  .map((m) => m.default)
  .filter(isValidDay)
  .filter((d) => d.items.length > 0)
  .sort((a, b) => (a.date < b.date ? 1 : -1));

export const totalItems = days.reduce((n, d) => n + d.items.length, 0);

export const latestDate = days[0]?.date;

// --- News groups ----------------------------------------------------------

// Items in a day are clustered under a topical group (e.g. all Anthropic news
// together). A group can be set explicitly via item.group; otherwise it is
// inferred from the source + title by the first matching keyword rule below.
// Anything that matches nothing falls into "Ostatní".
export interface NewsGroup {
  id: string;
  label: string;
  keywords: string[];
}

// Order here is the display order within a day (Ostatní is always appended last).
export const newsGroups: NewsGroup[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    keywords: ["anthropic", "claude", "opus", "sonnet", "haiku"],
  },
  {
    id: "openai",
    label: "OpenAI",
    keywords: ["openai", "codex", "chatgpt", "gpt-", "gpt ", "sora"],
  },
  {
    id: "google",
    label: "Google",
    keywords: ["gemini", "deepmind", "google"],
  },
  {
    id: "meta",
    label: "Meta",
    keywords: ["llama", "meta ai"],
  },
];

export const otherGroup = { id: "other", label: "Ostatní" };

export interface ResolvedGroup {
  id: string;
  label: string;
}

// Resolve a single item to its group: explicit override first, then keywords.
export function groupForItem(item: FeedItem): ResolvedGroup {
  if (item.group) {
    const key = item.group.toLowerCase();
    if (key === otherGroup.id || key === otherGroup.label.toLowerCase()) {
      return otherGroup;
    }
    const known = newsGroups.find(
      (g) => g.id === key || g.label.toLowerCase() === key,
    );
    if (known) return { id: known.id, label: known.label };
    return { id: key, label: item.group };
  }
  const haystack = `${item.source ?? ""} ${item.title}`.toLowerCase();
  for (const g of newsGroups) {
    if (g.keywords.some((k) => haystack.includes(k))) {
      return { id: g.id, label: g.label };
    }
  }
  return otherGroup;
}

export interface GroupedItems extends ResolvedGroup {
  items: FeedItem[];
}

// Cluster a day's items into ordered groups, preserving item order within each
// group. Returns only non-empty groups, sorted by newsGroups order (Ostatní last).
export function groupDayItems(items: FeedItem[]): GroupedItems[] {
  const order = [...newsGroups.map((g) => g.id), otherGroup.id];
  const byId = new Map<string, GroupedItems>();
  for (const item of items) {
    const g = groupForItem(item);
    let bucket = byId.get(g.id);
    if (!bucket) {
      bucket = { ...g, items: [] };
      byId.set(g.id, bucket);
    }
    bucket.items.push(item);
  }
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };
  return [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

// --- GitHub trending ------------------------------------------------------

export interface TrendingRepo {
  repo: string; // owner/name
  url: string;
  description: string | null;
  language: string | null;
  stars: number; // current total
  stars_gained: number; // gained over the window
  growth_rate: number; // stars_gained / stars-at-window-start
  topics: string[];
}

export interface GithubSnapshot {
  date: string; // YYYY-MM-DD (window end)
  window_days: number;
  generated_at: string;
  repos: TrendingRepo[];
}

const githubModules = import.meta.glob<{ default: GithubSnapshot }>(
  "../../data/github/*.json",
  { eager: true },
);

function isValidSnapshot(s: unknown): s is GithubSnapshot {
  if (!s || typeof s !== "object") return false;
  const snap = s as GithubSnapshot;
  return typeof snap.date === "string" && Array.isArray(snap.repos);
}

// Only the most recent github snapshot is rendered.
export const githubTrending: GithubSnapshot | undefined = Object.values(
  githubModules,
)
  .map((m) => m.default)
  .filter(isValidSnapshot)
  .filter((s) => s.repos.length > 0)
  .sort((a, b) => (a.date < b.date ? 1 : -1))[0];

// --- Date formatting ------------------------------------------------------

// Czech long date, e.g. "1. června 2026".
export function formatDateCs(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

// Czech weekday + date, e.g. "pondělí 1. června 2026".
export function formatDateLongCs(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("cs-CZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}
