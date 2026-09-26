"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/*
 * shadcn/ui's theme provider, as documented at
 * https://ui.shadcn.com/docs/dark-mode/next — installed unedited apart from
 * the root layout's props. It owns the `.dark` class that `globals.css` and
 * every `dark:` utility key off.
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
