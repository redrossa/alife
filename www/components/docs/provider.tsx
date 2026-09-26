"use client";

import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

export function DocsProvider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      // The root layout's next-themes provider (see `components/theme-provider.tsx`)
      // owns theming, so Fumadocs must not mount a second one.
      theme={{ enabled: false }}
    >
      {children}
    </RootProvider>
  );
}
