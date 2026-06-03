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
