import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { LogoMark } from "@/components/site-header";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // Compact top bar below `md`: brand, search, and the sidebar trigger.
      // The desktop sidebar hides this title; the site header owns the brand
      // there. `idPrefix` keeps the SVG defs unique across both instances.
      title: (
        <>
          <LogoMark idPrefix="docs-orb" className="size-6" />
          Alife
        </>
      ),
      // The brand and utility actions live in the shared site header above the
      // docs layout; this spacer keeps the actions trailing.
      children: <div className="flex-1" aria-hidden="true" />,
    },
    // The site header owns GitHub and theming; don't render Fumadocs' own
    // next-themes-based switch (the next-themes provider is disabled).
    themeSwitch: { enabled: false },
  };
}
