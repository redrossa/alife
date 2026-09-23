import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { DocsProvider } from "@/components/docs/provider";
import DocsSidebarNav from "@/components/docs-sidebar-nav";
import SiteHeader from "@/components/site-header";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function DocsRootLayout({ children }: LayoutProps<"/docs">) {
  return (
    <DocsProvider>
      <div className="docs-shell">
        <header className="docs-nav sticky top-0 z-40">
          <div className="site-nav-container">
            <SiteHeader />
          </div>
        </header>
        <DocsLayout
          tree={source.getPageTree()}
          {...baseOptions()}
          sidebar={{ footer: <DocsSidebarNav /> }}
        >
          {children}
        </DocsLayout>
        <div className="docs-dither" aria-hidden="true" />
      </div>
    </DocsProvider>
  );
}
