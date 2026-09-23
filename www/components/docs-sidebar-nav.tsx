"use client";

import { BookText, House } from "lucide-react";
import Link from "next/link";

import { ThemeIcon, useTheme } from "@/app/theme-toggle";
import { GitHubLogo } from "@/components/site-header";
import { siteRepository } from "@/lib/site";

/*
 * Mobile-only navigation for the docs sidebar drawer. On desktop the shared
 * site header above the docs layout carries the brand, GitHub, and theme
 * controls; below `md` that header is hidden and these items live here.
 */
export default function DocsSidebarNav() {
  const { theme, label, toggle } = useTheme();
  // Mirrors Fumadocs' sidebar item styling so the links read as part of the tree.
  const item =
    "flex w-full cursor-pointer items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 focus-visible:outline-2 focus-visible:outline-fd-ring [&_svg]:size-4 [&_svg]:shrink-0";

  return (
    <nav className="flex flex-col gap-1 pb-1 md:hidden" aria-label="Site navigation">
      <Link className={item} href="/">
        <House aria-hidden="true" />
        Home
      </Link>
      <Link className={item} href="/docs">
        <BookText aria-hidden="true" />
        Docs
      </Link>
      <a className={item} href={siteRepository} target="_blank" rel="noreferrer">
        <GitHubLogo aria-hidden="true" />
        GitHub
      </a>
      <button type="button" className={item} onClick={toggle} aria-label={label} title={label}>
        <ThemeIcon theme={theme} />
        Theme
      </button>
    </nav>
  );
}
