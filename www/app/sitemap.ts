import type { MetadataRoute } from "next";

import { toDate } from "@/lib/format";
import { siteUrl } from "@/lib/site";
import { getBlogPosts, source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages();
  const posts = getBlogPosts();

  // Frontmatter dates are the freshness signal for crawlers; the home page
  // inherits the most recent documentation update or blog post.
  const latestDoc = pages
    .map((page) => page.data.updated)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const latestPost = posts
    .map((post) => toDate(post.data.posted).toISOString())
    .sort()
    .at(-1);
  const latest = [latestDoc, latestPost].filter(Boolean).sort().at(-1);

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
    {
      url: `${siteUrl}/blog`,
      lastModified: latestPost ? new Date(latestPost) : undefined,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    },
    ...posts.map((post) => ({
      url: `${siteUrl}${post.url}`,
      lastModified: toDate(post.data.posted),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
