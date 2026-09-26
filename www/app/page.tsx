import Link from "next/link";
import SiteHeader from "@/components/site-header";
import { Button } from "@/components/ui/button";
import TerrainBackground from "./terrain-background";

import { siteRepository } from "@/lib/site";

export default function Home() {
  return (
    <div className="terrain-home">
      <TerrainBackground />
      <div className="terrain-layout relative flex flex-col">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-5 focus:z-10 focus:bg-foreground focus:px-4 focus:py-2 focus:text-background focus:outline-2 focus:outline-offset-4 focus:outline-foreground"
        href="#main"
      >
        Skip to content
      </a>

      <div className="site-nav-container">
        <SiteHeader />
      </div>

      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-6xl flex-1 px-5 sm:px-8 lg:px-16">
        <section
          className="flex flex-1 flex-col justify-center py-12 sm:py-16 lg:py-24"
          aria-labelledby="hero-title"
        >
          <p className="text-xs tracking-widest text-muted-foreground uppercase">
            Coming soon
          </p>
          <h1
            id="hero-title"
            className="mt-6 text-balance font-serif text-3xl leading-tight font-normal tracking-tight sm:mt-8 sm:text-4xl lg:text-5xl"
          >
            What happens when an agent is given the world{" "}
            <br className="hidden sm:inline" />
            <em>and the freedom to become curious?</em>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:mt-8 sm:text-lg">
            A digital terrarium for <em>autotelic agents:</em> AI systems capable of
            developing and pursuing their own goals in an open-ended environment.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:mt-9 sm:flex-row sm:flex-wrap sm:items-center">
            {/* The height/padding keep Alife's 44px call to action; shadcn's
                default size is a denser 32px control. */}
            <Button asChild className="h-11 w-full px-4 sm:w-auto">
              <Link href="/docs">Learn more</Link>
            </Button>
            <Button asChild variant="secondary" className="h-11 w-full px-4 sm:w-auto">
              <a href={siteRepository}>View on GitHub</a>
            </Button>
          </div>
        </section>
      </main>

      <footer className="site-nav-container flex justify-center py-7 text-sm text-muted-foreground sm:justify-end">
        <p>Alife © 2026</p>
      </footer>
      </div>
    </div>
  );
}
