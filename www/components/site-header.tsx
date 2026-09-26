import Link from "next/link";

import { GitHubLogo, LogoMark } from "@/components/logos";
import { ModeToggle } from "@/components/mode-toggle";
import SiteMenu from "@/components/site-menu";
import { Button } from "@/components/ui/button";
import { siteRepository } from "@/lib/site";

export default function SiteHeader({ className = "" }: { className?: string }) {
  return (
    <header
      className={`relative flex min-h-20 items-center justify-between gap-4 sm:min-h-24 sm:gap-6${className ? ` ${className}` : ""}`}
    >
      <div className="flex items-center gap-4 sm:gap-5">
        <Link
          className="flex items-center gap-2 font-sans text-lg font-semibold tracking-tight no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:gap-2.5 sm:text-xl"
          href="/"
          aria-label="Alife home"
        >
          <LogoMark className="size-6 sm:size-7" />
          Alife
        </Link>
        {/* Wide-screen site links as `link` Buttons: text-styled navigation
            with the Button's shared focus treatment rather than a hover
            surface. `h-11` keeps the header's 44px targets, and the Button's
            own padding replaces the nav's old gap. Below `md` these collapse
            into SiteMenu. */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="Site">
          <Button asChild variant="link" className="h-11">
            <Link href="/docs">Docs</Link>
          </Button>
          <Button asChild variant="link" className="h-11">
            <Link href="/blog">Blog</Link>
          </Button>
        </nav>
      </div>

      <nav className="hidden items-center gap-1 md:flex" aria-label="Main navigation">
        {/* `size-11` is call-site only: shadcn's icon buttons are 32px, and the
            site header keeps 44px targets. */}
        <Button asChild variant="ghost" size="icon" className="size-11">
          <a href={siteRepository} aria-label="GitHub repository">
            <GitHubLogo />
          </a>
        </Button>
        <ModeToggle className="size-11" />
      </nav>

      {/* Collapsed navigation below `md`: links, GitHub, and theme. */}
      <SiteMenu />
    </header>
  );
}
