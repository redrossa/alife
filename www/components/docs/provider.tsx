"use client";

import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

export function DocsProvider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      // The site's own theme controller (`alife-theme` + `data-theme`) owns
      // theming; Fumadocs' `next-themes` provider must not compete with it.
      theme={{ enabled: false }}
    >
      {children}
    </RootProvider>
  );
}
