"use client";

import { BookText, Menu, Newspaper } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useRef, useState } from "react";

import { GitHubLogo } from "@/components/logos";
import { ThemeIcon } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { siteRepository } from "@/lib/site";

/*
 * Menu rows are Buttons: each one is an action that closes the sheet, whether
 * it navigates (Link), opens the repository, or toggles the theme. `ghost`
 * supplies the row hover surface; only layout is overridden — the row spans the
 * list and starts from the left, at the site's 44px touch target.
 */
const item = "h-11 w-full justify-start";

/*
 * Mobile-only site navigation. Below `md` the header's links and utility
 * buttons collapse behind this menu button, which opens a full-height Sheet.
 * Docs pages are the exception: there the standalone site header is hidden
 * below `md` and navigation lives in the Fumadocs sidebar drawer instead (see
 * `docs-sidebar-nav.tsx`).
 *
 * The Sheet brings the modal behavior the previous inline panel hand-rolled:
 * Escape, outside press, scroll lock, focus containment and focus return, plus
 * the enter/exit animation. `md:hidden` retires the sheet if the viewport grows
 * past `md` while it is open.
 */
export default function SiteMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const contentRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  // Navigating from one page to another inside a layout that keeps the
  // header mounted (for example blog index → post) must not leave the sheet
  // open on top of the next page. Compare against the previous pathname
  // during render rather than resetting in an effect.
  const [menuPathname, setMenuPathname] = useState(pathname);
  if (menuPathname !== pathname) {
    setMenuPathname(pathname);
    setOpen(false);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 md:hidden"
          aria-label="Open navigation menu"
        >
          <Menu aria-hidden="true" />
        </Button>
      </SheetTrigger>

      {/* The Sheet's shipped geometry, only steered to the right edge so the
          site menu and the docs drawer open from the same side. `md:hidden`
          retires it if the viewport grows past `md` while it is open. */}
      <SheetContent
        ref={contentRef}
        side="right"
        className="md:hidden"
        onOpenAutoFocus={(event) => {
          /* Open with focus on the close button rather than the Sheet's
             default target (its last focusable child, the theme row). Tab
             then walks the list from the top: Docs, Blog, GitHub, Theme. */
          event.preventDefault();
          contentRef.current
            ?.querySelector<HTMLElement>('[data-slot="sheet-close"]')
            ?.focus();
        }}
      >
        {/* The trigger already names the action; this names the dialog. */}
        <SheetHeader>
          <SheetTitle className="sr-only">Site navigation</SheetTitle>
        </SheetHeader>

        {/* One list in the normal flow, matching the docs drawer's nav: GitHub
            and the theme switch sit with the site links rather than in a
            footer pinned to the bottom. `px-4 pb-4` lines the rows up with the
            Sheet's own `p-4` header. */}
        <nav className="flex flex-col px-4 pb-4" aria-label="Site navigation">
          <Button asChild variant="ghost" className={item}>
            <Link href="/docs" onClick={close}>
              <BookText aria-hidden="true" />
              Docs
            </Link>
          </Button>
          <Button asChild variant="ghost" className={item}>
            <Link href="/blog" onClick={close}>
              <Newspaper aria-hidden="true" />
              Blog
            </Link>
          </Button>
          <Button asChild variant="ghost" className={item}>
            <a
              href={siteRepository}
              target="_blank"
              rel="noreferrer"
              onClick={close}
            >
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
      </SheetContent>
    </Sheet>
  );
}
