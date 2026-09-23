import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages();
  // Frontmatter `updated` is the freshness signal for crawlers; the home page
  // inherits the most recent documentation date.
  const latest = pages
    .map((page) => page.data.updated)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return [
    {
      url: siteUrl,
      lastModified: latest ? new Date(latest) : undefined,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...pages.map((page) => ({
      url: `${siteUrl}${page.url}`,
      lastModified: page.data.updated ? new Date(page.data.updated) : undefined,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
