"use client";

import { BookText, Menu, Newspaper, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ThemeIcon, useTheme } from "@/app/theme-toggle";
import { GitHubLogo } from "@/components/logos";
import { siteRepository } from "@/lib/site";

const item =
  "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-sm px-3 text-start text-sm font-medium no-underline hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";

/*
 * Mobile-only site navigation. Below `md` the header's links and utility
 * buttons collapse behind this menu button. Docs pages are the exception:
 * there the standalone site header is hidden below `md` and navigation lives
 * in the Fumadocs sidebar drawer instead (see `docs-sidebar-nav.tsx`).
 */
export default function SiteMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { theme, label, toggle } = useTheme();

  // Navigating from one page to another inside a layout that keeps the
  // header mounted (for example blog index → post) must not leave the menu
  // open on top of the next page. Compare against the previous pathname
  // during render rather than resetting in an effect.
  const [menuPathname, setMenuPathname] = useState(pathname);
  if (menuPathname !== pathname) {
    setMenuPathname(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function closeOnOutsidePress(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !panelRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex size-11 cursor-pointer items-center justify-center hover:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground md:hidden"
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={open}
        aria-controls="site-header-menu"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <X className="size-5" aria-hidden="true" />
        ) : (
          <Menu className="size-5" aria-hidden="true" />
        )}
      </button>

      <div
        ref={panelRef}
        id="site-header-menu"
        className={`absolute inset-x-0 top-full z-50 flex-col rounded-sm border border-rule bg-background p-1.5 shadow-lg md:hidden ${
          open ? "flex" : "hidden"
        }`}
      >
        <nav className="flex flex-col" aria-label="Site">
          <Link className={item} href="/docs" onClick={() => setOpen(false)}>
            <BookText className="size-4 shrink-0" aria-hidden="true" />
            Docs
          </Link>
          <Link className={item} href="/blog" onClick={() => setOpen(false)}>
            <Newspaper className="size-4 shrink-0" aria-hidden="true" />
            Blog
          </Link>
        </nav>
        <div className="my-1.5 border-t border-rule" aria-hidden="true" />
        <nav className="flex flex-col" aria-label="Site utilities">
          <a
            className={item}
            href={siteRepository}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            <GitHubLogo className="size-4 shrink-0" aria-hidden="true" />
            GitHub
          </a>
          <button
            type="button"
            className={item}
            onClick={toggle}
            aria-label={label}
            title={label}
          >
            <ThemeIcon theme={theme} className="size-4 shrink-0" aria-hidden="true" />
            Theme
          </button>
        </nav>
      </div>
    </>
  );
}
