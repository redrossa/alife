import { DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import BlogContainer from "@/components/blog-container";
import BlogPostNav from "@/components/blog-post-nav";
import { formatDate, toDate } from "@/lib/format";
import { siteName, siteUrl, socialImage } from "@/lib/site";
import { blog, getBlogPosts } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

export default async function BlogPostPage(props: PageProps<"/blog/[slug]">) {
  const params = await props.params;
  const page = blog.getPage([params.slug]);
  const posted = page?.data.posted;
  if (!page || !posted) notFound();

  const MDX = page.data.body;
  const published = toDate(posted);
  const authors = page.data.authors;

  // Newest first: the entry after this one is the earlier post, the entry
  // before it is the later post. Either may be missing at the ends.
  const posts = getBlogPosts();
  const index = posts.findIndex((post) => post.url === page.url);
  const earlier = index >= 0 ? posts[index + 1] : undefined;
  const later = index > 0 ? posts[index - 1] : undefined;

  // Per-post structured data, so search engines can treat each post as an
  // article with a publication date and real authors.
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: page.data.title,
    description: page.data.description,
    url: `${siteUrl}${page.url}`,
    datePublished: published.toISOString(),
    author: authors.map((name) => ({ "@type": "Person", name })),
    isPartOf: {
      "@type": "Blog",
      name: `${siteName} Blog`,
      url: `${siteUrl}/blog`,
    },
    publisher: {
      "@type": "Organization",
      name: siteName,
      url: siteUrl,
      logo: `${siteUrl}/icons/icon-512.png`,
    },
  };

  return (
    <>
      <BlogContainer>
        <Link
          className="mb-8 inline-flex items-center gap-1.5 self-start text-sm text-fd-muted-foreground no-underline hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
          href="/blog"
        >
          <ChevronLeft className="-mx-1 size-4 shrink-0" aria-hidden="true" />
          All posts
        </Link>
        <article className="flex flex-col gap-4">
          <p className="docs-updated">
            <time dateTime={published.toISOString()}>
              {formatDate(posted, "full")}
            </time>{" • "}{authors.join(", ")}
          </p>
          <DocsTitle>{page.data.title}</DocsTitle>
          <DocsDescription>{page.data.description}</DocsDescription>
          <DocsBody>
            <MDX components={getMDXComponents()} />
          </DocsBody>
        </article>
        <BlogPostNav
          earlier={
            earlier
              ? {
                  title: earlier.data.title,
                  description: earlier.data.description,
                  url: earlier.url,
                }
              : undefined
          }
          later={
            later
              ? {
                  title: later.data.title,
                  description: later.data.description,
                  url: later.url,
                }
              : undefined
          }
        />
      </BlogContainer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
    </>
  );
}

export function generateStaticParams() {
  return getBlogPosts().map((page) => ({ slug: page.slugs[0] }));
}

export async function generateMetadata(
  props: PageProps<"/blog/[slug]">,
): Promise<Metadata> {
  const params = await props.params;
  const page = blog.getPage([params.slug]);
  const posted = page?.data.posted;
  if (!page || !posted) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: {
      type: "article",
      url: page.url,
      siteName,
      title: page.data.title,
      description: page.data.description,
      locale: "en_US",
      publishedTime: toDate(posted).toISOString(),
      authors: page.data.authors,
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title: page.data.title,
      description: page.data.description,
      images: [socialImage.url],
    },
  };
}
