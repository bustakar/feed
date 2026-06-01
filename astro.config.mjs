import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Change this to your production domain (used for sitemap, RSS, canonical URLs).
const SITE = process.env.SITE_URL || "https://feed.example.com";

export default defineConfig({
  site: SITE,
  output: "static",
  integrations: [sitemap()],
});
