import Link from "next/link";

import ThemeToggle from "@/app/theme-toggle";
import { GitHubLogo, LogoMark } from "@/components/logos";
import SiteMenu from "@/components/site-menu";
import { siteRepository } from "@/lib/site";

const navLink =
  "inline-flex min-h-11 items-center text-sm font-medium no-underline hover:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground";

export default function SiteHeader({ className = "" }: { className?: string }) {
  return (
    <header
      className={`relative flex min-h-20 items-center justify-between gap-4 sm:min-h-24 sm:gap-6${className ? ` ${className}` : ""}`}
    >
      <div className="flex items-center gap-4 sm:gap-5">
        <Link
          className="flex items-center gap-2 font-sans text-lg font-semibold tracking-tight no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground sm:gap-2.5 sm:text-xl"
          href="/"
          aria-label="Alife home"
        >
          <LogoMark className="size-6 sm:size-7" />
          Alife
        </Link>
        {/* Wide-screen site links; below `md` they collapse into SiteMenu. */}
        <nav className="hidden items-center gap-4 sm:gap-5 md:flex" aria-label="Site">
          <Link className={navLink} href="/docs">
            Docs
          </Link>
          <Link className={navLink} href="/blog">
            Blog
          </Link>
        </nav>
      </div>

      <nav className="hidden items-center gap-1 md:flex" aria-label="Main navigation">
        <a
          className="inline-flex size-11 items-center justify-center no-underline hover:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
          href={siteRepository}
          aria-label="GitHub repository"
        >
          <GitHubLogo className="size-5" />
        </a>
        <ThemeToggle />
      </nav>

      {/* Collapsed navigation below `md`: links, GitHub, and theme. */}
      <SiteMenu />
    </header>
  );
}
