"use client";

import { useSyncExternalStore } from "react";
import type { SVGProps } from "react";

type Theme = "system" | "light" | "dark";
const key = "alife-theme";
const eventName = "alife-theme-change";
function subscribe(callback: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  function sync() {
    let preference: Theme = "system";
    try {
      const stored = localStorage.getItem(key);
      if (stored === "light" || stored === "dark") preference = stored;
    } catch { /* System mode remains usable when storage is unavailable. */ }
    apply(preference);
    callback();
  }
  window.addEventListener(eventName, callback);
  window.addEventListener("storage", sync);
  media.addEventListener("change", sync);
  return () => {
    window.removeEventListener(eventName, callback);
    window.removeEventListener("storage", sync);
    media.removeEventListener("change", sync);
  };
}
function apply(theme: Theme) {
  const root = document.documentElement;
  const resolved = theme === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  root.dataset.themePreference = theme;
  root.dataset.theme = resolved;
  // Fumadocs UI keys its dark styles off the `.dark` class.
  root.classList.toggle("dark", resolved === "dark");
  window.dispatchEvent(new Event(eventName));
}
function snapshot(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/*
 * Shared theme state, so custom controls (e.g. the docs sidebar row) can
 * toggle the theme and render the current icon without duplicating the
 * storage/event plumbing above.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, snapshot, () => "light" as const);
  const next: Theme = theme === "light" ? "dark" : "light";
  const label = `Theme: ${theme}. Switch to ${next} theme`;
  function toggle() {
    try { localStorage.setItem(key, next); } catch { /* Still apply in this tab. */ }
    apply(next);
  }
  return { theme, next, toggle, label };
}

export function ThemeIcon({ theme, ...props }: SVGProps<SVGSVGElement> & { theme: "light" | "dark" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {theme === "light" ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></> : <path d="M20.7 13.2A9 9 0 0 1 10.8 3.3a9 9 0 1 0 9.9 9.9Z"/>}
    </svg>
  );
}

export default function ThemeToggle({ className }: { className?: string } = {}) {
  const { theme, label, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle} aria-label={label} title={label}
      className={`inline-flex size-11 cursor-pointer items-center justify-center hover:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground${className ? ` ${className}` : ""}`}>
      <ThemeIcon theme={theme} className="size-5" />
    </button>
  );
}
