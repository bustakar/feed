import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { days } from "../lib/feed";
import { site } from "../lib/site";

export function GET(context: APIContext) {
  const items = days.flatMap((day) =>
    day.items.map((it) => ({
      title: it.title,
      link: it.url,
      pubDate: new Date(day.date + "T08:00:00"),
      description: it.source ? `Zdroj: ${it.source}` : undefined,
    })),
  );

  return rss({
    title: site.title,
    description: site.description,
    site: context.site!,
    items,
    customData: `<language>cs-cz</language>`,
  });
}
