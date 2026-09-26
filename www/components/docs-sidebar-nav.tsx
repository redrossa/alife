"use client";

import { BookText, House, Newspaper } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";

import { GitHubLogo } from "@/components/logos";
import { ThemeIcon } from "@/components/mode-toggle";
import { siteRepository } from "@/lib/site";

/*
 * Mobile-only navigation for the docs sidebar drawer. On desktop the shared
 * site header above the docs layout carries the brand, GitHub, and theme
 * controls; below `md` that header is hidden and these items live here.
 */
export default function DocsSidebarNav() {
  const { resolvedTheme, setTheme } = useTheme();
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
      <Link className={item} href="/blog">
        <Newspaper aria-hidden="true" />
        Blog
      </Link>
      <a className={item} href={siteRepository} target="_blank" rel="noreferrer">
        <GitHubLogo aria-hidden="true" />
        GitHub
      </a>
      <button
        type="button"
        className={item}
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        aria-label="Toggle theme"
      >
        <ThemeIcon />
        Theme
      </button>
    </nav>
  );
}
