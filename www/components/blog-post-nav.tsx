import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

interface BlogPostLink {
  title: string;
  description: string;
  url: string;
}

/*
 * Adjacent-post navigation for a blog post, mirroring the docs page footer's
 * previous/next placement: the later (newer) post on the left with a left
 * chevron, the earlier (older) post on the right with a right chevron.
 * Navigation is not article content, so the post page renders this outside
 * the post's <article>.
 */
export default function BlogPostNav({
  earlier,
  later,
}: {
  earlier?: BlogPostLink;
  later?: BlogPostLink;
}) {
  if (!earlier && !later) return null;

  return (
    <nav
      className={`grid gap-4 ${earlier && later ? "sm:grid-cols-2" : "grid-cols-1"}`}
      aria-label="Blog post navigation"
    >
      {later ? <NavCard item={later} direction="previous" /> : null}
      {earlier ? <NavCard item={earlier} direction="next" /> : null}
    </nav>
  );
}

function NavCard({
  item,
  direction,
}: {
  item: BlogPostLink;
  direction: "previous" | "next";
}) {
  const isNext = direction === "next";
  const Icon = isNext ? ChevronRight : ChevronLeft;

  return (
    <Link
      className={`flex flex-col gap-2 rounded-lg border p-4 text-sm transition-colors hover:bg-fd-accent/80 hover:text-fd-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring ${isNext ? "text-end" : ""}`}
      href={item.url}
    >
      <div
        className={`inline-flex items-center gap-1.5 font-medium ${isNext ? "flex-row-reverse" : ""}`}
      >
        <Icon className="-mx-1 size-4 shrink-0" aria-hidden="true" />
        <p>{item.title}</p>
      </div>
      <p className="truncate text-fd-muted-foreground">{item.description}</p>
    </Link>
  );
}
