import type { SVGProps } from "react";
import Link from "next/link";

import ThemeToggle from "@/app/theme-toggle";
import { siteRepository } from "@/lib/site";

export function LogoMark({ idPrefix = "header-orb", ...props }: SVGProps<SVGSVGElement> & { idPrefix?: string }) {
  const gradientId = `${idPrefix}-color`;
  const maskId = `${idPrefix}-mask`;
  return (
    <svg viewBox="32 32 176 176" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="65" y1="28" x2="175" y2="218">
          <stop offset="0" stopColor="#a995d6" />
          <stop offset="0.48" stopColor="#8777cb" />
          <stop offset="1" stopColor="#829df0" />
        </linearGradient>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="240" style={{ maskType: "alpha" }}>
          <image href="/logos/logo-twisted-orb-small.svg" width="240" height="240" />
        </mask>
      </defs>
      <rect width="240" height="240" fill={`url(#${gradientId})`} mask={`url(#${maskId})`} />
    </svg>
  );
}

export function GitHubLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export default function SiteHeader({ className = "" }: { className?: string }) {
  return (
    <header
      className={`flex min-h-20 items-center justify-between gap-4 sm:min-h-24 sm:gap-6${className ? ` ${className}` : ""}`}
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
        <Link
          className="inline-flex min-h-11 items-center text-sm font-medium no-underline hover:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
          href="/docs"
        >
          Docs
        </Link>
      </div>
      <nav className="flex items-center gap-1" aria-label="Main navigation">
        <a
          className="inline-flex size-11 items-center justify-center no-underline hover:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
          href={siteRepository}
          aria-label="GitHub repository"
        >
          <GitHubLogo className="size-5" />
        </a>
        <ThemeToggle />
      </nav>
    </header>
  );
}
