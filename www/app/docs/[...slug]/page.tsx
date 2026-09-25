import { createRelativeLink } from "fumadocs-ui/mdx";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getMDXComponents } from "@/mdx-components";
import { formatDate } from "@/lib/format";
import { siteName, siteUrl, socialImage } from "@/lib/site";
import { source } from "@/lib/source";

export default async function DocPage(props: PageProps<"/docs/[...slug]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const description = page.data.description;
  const updated = page.data.updated;

  // Per-page structured data, so search engines can treat each guide as an
  // article with a real modification date instead of a bare document.
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: page.data.title,
    description,
    url: `${siteUrl}${page.url}`,
    inLanguage: "en",
    ...(updated ? { dateModified: updated } : {}),
    isPartOf: { "@type": "WebSite", name: siteName, url: siteUrl },
    publisher: {
      "@type": "Organization",
      name: siteName,
      url: siteUrl,
      logo: `${siteUrl}/icons/icon-512.png`,
    },
  };

  return (
    <>
      <DocsPage toc={page.data.toc} full={page.data.full}>
        {updated ? (
          <p className="docs-updated">
            Updated on <time dateTime={updated}>{formatDate(updated)}</time>
          </p>
        ) : null}
        <DocsTitle>{page.data.title}</DocsTitle>
        {description ? <DocsDescription>{description}</DocsDescription> : null}
        <DocsBody>
          <MDX
            components={getMDXComponents({
              // Resolve relative file links (e.g. `./architecture.mdx`) to site routes.
              a: createRelativeLink(source, page),
            })}
          />
        </DocsBody>
      </DocsPage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
    </>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(
  props: PageProps<"/docs/[...slug]">,
): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const description = page.data.description;
  const updated = page.data.updated;

  return {
    title: page.data.title,
    description,
    alternates: { canonical: page.url },
    openGraph: {
      type: "article",
      url: page.url,
      siteName,
      title: page.data.title,
      description,
      locale: "en_US",
      ...(updated ? { modifiedTime: updated } : {}),
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title: page.data.title,
      description,
      images: [socialImage.url],
    },
  };
}
