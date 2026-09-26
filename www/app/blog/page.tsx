import type { Metadata } from "next";
import Link from "next/link";
import { DocsTitle } from "fumadocs-ui/layouts/docs/page";

import BlogContainer from "@/components/blog-container";
import { Button } from "@/components/ui/button";
import { formatDate, toDate } from "@/lib/format";
import { getBlogPosts } from "@/lib/source";

export const metadata: Metadata = {
  title: "Blog",
  description: "Notes, updates, and experiments from the Alife project.",
  alternates: { canonical: "/blog" },
};

// The preview is clamped to two lines in CSS; cutting the text server-side
// keeps long posts out of the index HTML while preserving the ellipsis.
const snippetLength = 280;

function getSnippet(contents: { content: string }[]): string {
  const text = contents
    .map((item) => item.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= snippetLength) return text;

  const cut = text.slice(0, snippetLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 200 ? lastSpace : snippetLength)}…`;
}

export default function BlogIndexPage() {
  // Newest first, so the latest published post is at the top of the list.
  const posts = getBlogPosts();

  return (
    <BlogContainer>
      <DocsTitle className="mb-4">The latest Alife news</DocsTitle>

      {posts.length === 0 ? (
        <p className="text-sm text-fd-muted-foreground">No posts yet.</p>
      ) : (
        <ul className="flex list-none flex-col gap-12 p-0">
          {posts.map((post) => (
            <li key={post.url} className="flex flex-col gap-2">
              <p className="text-sm text-fd-muted-foreground">
                <time dateTime={toDate(post.data.posted).toISOString()}>
                  {formatDate(post.data.posted, "full")}
                </time>{" • "}
                {post.data.authors.join(", ")}
              </p>
              <h2 className="text-lg font-semibold">
                <Link
                  className="no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
                  href={post.url}
                >
                  {post.data.title}
                </Link>
              </h2>
              <p className="line-clamp-2 text-sm text-fd-muted-foreground">
                {getSnippet(post.data.structuredData.contents)}
              </p>
              <Button asChild variant="link" className="self-start px-0">
                <Link href={post.url}>Read more</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </BlogContainer>
  );
}
