import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";
import { blogPosts, docs } from "collections/server";

import { toDate } from "@/lib/format";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export const blog = loader({
  baseUrl: "/blog",
  source: toFumadocsSource(blogPosts, []),
});

type BlogPage = ReturnType<typeof blog.getPages>[number];

/**
 * Published blog posts, newest first. `posted` is optional frontmatter:
 * without it a post stays in the repository but out of the site — the index,
 * its route, the sitemap, and adjacent-post links.
 */
export function getBlogPosts() {
  return blog
    .getPages()
    .filter(
      (page): page is BlogPage & { data: { posted: string } } =>
        page.data.posted !== undefined,
    )
    .sort(
      (a, b) =>
        toDate(b.data.posted).getTime() - toDate(a.data.posted).getTime(),
    );
}
