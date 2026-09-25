import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";

export const docs = defineDocs({
  dir: "../docs",
  docs: {
    // The default page schema strips unknown frontmatter keys, so `updated`
    // (an ISO `YYYY-MM-DD` date shown as "Updated on ..." on each page) has to
    // be part of the schema.
    schema: pageSchema.extend({
      updated: z.string().optional(),
    }),
    // Unpublished stubs stay in the repository but out of the site: excluded
    // files are missing from the sidebar, next/previous links, search, the
    // sitemap, and their routes return 404. Remove a file from this list when
    // its page is ready to publish.
    files: ["**/*.{md,mdx}", "!**/configuration.mdx", "!**/experiments.mdx"],
  },
});

export const blogPosts = defineCollections({
  type: "doc",
  // Posts live in the repository-root `blog/` directory, alongside `docs/`.
  dir: "../blog",
  // The frontmatter contract for every post. `title` and `description` come
  // from the page schema (`description` is made required here); `posted` is
  // the optional published date the blog index sorts by, and `authors` lists
  // the names the post page credits. A post without `posted` stays in the
  // repository but is hidden from the site.
  schema: pageSchema.extend({
    description: z.string(),
    posted: z.iso.date().optional(),
    authors: z.array(z.string()).min(1),
  }),
});

export default defineConfig({
  mdxOptions: {
    // Convert ```mermaid code fences into <Mermaid chart="..." /> elements,
    // rendered to inline SVG by the component map in `mdx-components.tsx`.
    remarkPlugins: [remarkMdxMermaid],
  },
});
