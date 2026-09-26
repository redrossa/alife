import SiteHeader from "@/components/site-header";

export default function BlogRootLayout({ children }: LayoutProps<"/blog">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-5 focus:z-10 focus:bg-foreground focus:px-4 focus:py-2 focus:text-background focus:outline-2 focus:outline-offset-4 focus:outline-foreground"
        href="#main"
      >
        Skip to content
      </a>

      <div className="site-nav-container">
        <SiteHeader />
      </div>

      <main id="main" tabIndex={-1} className="grid flex-1 justify-items-center">
        {children}
      </main>

      <footer className="site-nav-container flex justify-center py-7 text-sm text-muted-foreground sm:justify-end">
        <p>Alife © 2026</p>
      </footer>

      <div className="site-dither" aria-hidden="true" />
    </div>
  );
}
