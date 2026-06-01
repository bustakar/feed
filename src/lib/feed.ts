// Loads every per-day JSON file in /data at build time, validates lightly,
// and exposes sorted days for the pages to render. One file = one day.

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

// Eagerly import all day files. Path is relative to this file (src/lib).
const modules = import.meta.glob<{ default: Day }>("../../data/*.json", {
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

// All days, newest first. Empty days are dropped.
export const days: Day[] = Object.values(modules)
  .map((m) => m.default)
  .filter(isValidDay)
  .filter((d) => d.items.length > 0)
  .sort((a, b) => (a.date < b.date ? 1 : -1));

export const totalItems = days.reduce((n, d) => n + d.items.length, 0);

export const latestDate = days[0]?.date;

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
