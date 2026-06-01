# AI Novinky — denní AI news feed

Statický web (Astro) s denním přehledem novinek o umělé inteligenci. Každá
položka je jedna odrážka s odkazem na původní zdroj. Obsah je v češtině,
předrenderovaný do HTML (dobré SEO), nasazený na Vercel.

## Jak to do sebe zapadá

```
ranní agent (zatím TODO) ──► vytvoří data/YYYY-MM-DD.json ──► git commit/push
                                                                  │
                                              Vercel rebuild ◄─────┘
                                                  │
                                  statické HTML stránky (index, /den/…)
```

Hotová je zatím **zobrazovací část**. Stahování novinek (agent) a plánování
(cron) jsou samostatný krok.

## Proč Astro

- Generuje statické HTML při buildu → obsah je v HTML, ne v JS. **Nejlepší SEO.**
- Nulový JS na klientovi → rychlé načítání, žádná stránkovací zátěž.
- Jeden JSON soubor na den se mapuje na jednu statickou stránku — výkon není problém.
- Zabudovaný sitemap, RSS, stránkování.

## Datový kontrakt — `data/YYYY-MM-DD.json`

Jeden soubor = jeden den. Agent **vytvoří nový soubor** pro každý den a uvnitř
deduplikuje položky podle `id`, aby se stejná zpráva neobjevila dvakrát.

```json
{
  "date": "2026-06-01",
  "items": [
    {
      "id": "https://zdroj.cz/permalink",
      "title": "Titulek zobrazený jako odrážka",
      "url": "https://zdroj.cz/permalink",
      "source": "Název zdroje (např. OpenAI Blog)"
    }
  ]
}
```

| pole     | povinné | poznámka                                                       |
|----------|---------|----------------------------------------------------------------|
| `date`   | ano     | `YYYY-MM-DD`, musí odpovídat názvu souboru.                    |
| `id`     | ano     | Stabilní unikátní klíč pro deduplikaci. Hodí se kanonická URL. |
| `title`  | ano     | Text odrážky.                                                  |
| `url`    | ano     | Odkaz na původní zdroj (otevírá se v nové záložce).            |
| `source` | ne      | Krátký štítek za titulkem.                                     |

Dny jsou automaticky řazené od nejnovějšího. Stránky se generují při buildu.

## Vývoj

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # statický výstup do dist/
npm run preview  # náhled buildu
```

## Stránky

- `/` — přehled, nejnovější dny první, stránkováno (`/2`, `/3`, …; viz `daysPerPage` v `src/lib/site.ts`)
- `/den/YYYY-MM-DD/` — samostatná stránka jednoho dne (indexovatelná, sdílitelná)
- `/rss.xml` — RSS kanál
- `/sitemap-index.xml` — sitemap (generuje `@astrojs/sitemap`)

## Nasazení na Vercel

1. Připoj repo k Vercelu — framework **Astro** se detekuje automaticky
   (build `astro build`, output `dist`).
2. Nastav proměnnou prostředí **`SITE_URL`** na produkční doménu
   (např. `https://novinky.tvojedomena.cz`). Používá se pro kanonické URL,
   sitemap a RSS.
3. Každý `git push` s novým `data/*.json` spustí build a aktualizuje web.

## Konfigurace

- `src/lib/site.ts` — název, popis, jazyk, počet dnů na stránku.
- `astro.config.mjs` — `site` (přes `SITE_URL`), integrace.
