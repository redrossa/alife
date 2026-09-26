"use client";

import { BookText, House, Newspaper } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";

import { GitHubLogo } from "@/components/logos";
import { ThemeIcon } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { siteRepository } from "@/lib/site";

/*
 * Mobile-only navigation for the docs sidebar drawer. On desktop the shared
 * site header above the docs layout carries the brand, GitHub, and theme
 * controls; below `md` that header is hidden and these items live here.
 *
 * These are the site menu's rows in a different drawer, so they use the same
 * `ghost` Buttons and the same 44px rows. The surrounding docs tree is
 * Fumadocs' own markup, so only the row layout matches the site menu; colours,
 * hover, radius, and focus come from the shared Button and its tokens.
 */
const item = "h-11 w-full justify-start";

export default function DocsSidebarNav() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <nav className="flex flex-col md:hidden" aria-label="Site navigation">
      <Button asChild variant="ghost" className={item}>
        <Link href="/">
          <House aria-hidden="true" />
          Home
        </Link>
      </Button>
      <Button asChild variant="ghost" className={item}>
        <Link href="/docs">
          <BookText aria-hidden="true" />
          Docs
        </Link>
      </Button>
      <Button asChild variant="ghost" className={item}>
        <Link href="/blog">
          <Newspaper aria-hidden="true" />
          Blog
        </Link>
      </Button>
      <Button asChild variant="ghost" className={item}>
        <a href={siteRepository} target="_blank" rel="noreferrer">
          <GitHubLogo aria-hidden="true" />
          GitHub
        </a>
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={item}
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      >
        <ThemeIcon />
        Theme
      </Button>
    </nav>
  );
}
