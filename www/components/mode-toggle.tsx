"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";

/*
 * Light/dark toggle built on next-themes' `useTheme`, following shadcn's
 * documented pattern of rendering both icons and letting CSS pick one: the
 * `.dark` class is set before paint, so nothing flashes or mismatches during
 * hydration, and the button never needs a mounted-state guard.
 *
 * Alife shows a single button rather than shadcn's dropdown with
 * light/dark/system items. Switching away from "system" pins the choice, the
 * same behavior the site had before the migration.
 */
export function ThemeIcon() {
  return (
    <>
      <Sun aria-hidden="true" className="dark:hidden" />
      <Moon aria-hidden="true" className="hidden dark:block" />
    </>
  );
}

export function ModeToggle({ className }: { className?: string } = {}) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label="Toggle theme"
    >
      <ThemeIcon />
    </Button>
  );
}
