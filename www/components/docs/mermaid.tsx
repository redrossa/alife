"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";

type Theme = "light" | "dark";

const clientStore = {
  subscribe: () => () => {},
  getSnapshot: () => true,
  getServerSnapshot: () => false,
};

function subscribe(callback: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener("alife-theme-change", callback);
  media.addEventListener("change", callback);
  return () => {
    window.removeEventListener("alife-theme-change", callback);
    media.removeEventListener("change", callback);
  };
}

function themeSnapshot(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

const themeVariables: Record<Theme, Record<string, string | boolean>> = {
  light: {
    darkMode: false,
    background: "transparent",
    primaryColor: "#f5f5f4",
    primaryTextColor: "#292524",
    primaryBorderColor: "#d6d3d1",
    lineColor: "#57534d",
    secondaryColor: "#e7e5e4",
    tertiaryColor: "#fafaf9",
    mainBkg: "#f5f5f4",
    nodeBorder: "#d6d3d1",
    nodeTextColor: "#292524",
    textColor: "#292524",
    titleColor: "#292524",
    clusterBkg: "#fafaf9",
    clusterBorder: "#d6d3d1",
    edgeLabelBackground: "#fafaf9",
  },
  dark: {
    darkMode: true,
    background: "transparent",
    primaryColor: "#1c1917",
    primaryTextColor: "#f5f5f4",
    primaryBorderColor: "#292524",
    lineColor: "#a6a09b",
    secondaryColor: "#292524",
    tertiaryColor: "#1c1917",
    mainBkg: "#1c1917",
    nodeBorder: "#292524",
    nodeTextColor: "#f5f5f4",
    textColor: "#f5f5f4",
    titleColor: "#f5f5f4",
    clusterBkg: "#0c0a09",
    clusterBorder: "#292524",
    edgeLabelBackground: "#000000",
  },
};

const rendered = new Map<string, Promise<string>>();

async function renderChart(chart: string, theme: Theme, id: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    fontFamily: "var(--font-geist-sans)",
    theme: "base",
    themeVariables: themeVariables[theme],
  });
  const { svg } = await mermaid.render(id, chart);
  return svg;
}

/**
 * Renders ` ```mermaid ` fenced blocks (converted by `remarkMdxMermaid`) with
 * the official Mermaid engine — the same renderer GitHub uses — lazily loaded
 * in the browser and themed through the site palette.
 */
export function Mermaid({ chart }: { chart: string }) {
  const isClient = useSyncExternalStore(
    clientStore.subscribe,
    clientStore.getSnapshot,
    clientStore.getServerSnapshot,
  );

  return (
    <figure className="docs-mermaid not-prose my-6">
      {isClient ? <MermaidDiagram chart={chart} /> : null}
    </figure>
  );
}

function MermaidDiagram({ chart }: { chart: string }) {
  const theme = useSyncExternalStore(subscribe, themeSnapshot, () => "light" as const);
  const id = `alife-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const key = `${theme}:${id}:${chart}`;
  const [state, setState] = useState<{ key: string; svg?: string; failed?: boolean }>();

  useEffect(() => {
    let cancelled = false;

    let promise = rendered.get(key);
    if (!promise) {
      promise = renderChart(chart, theme, id);
      rendered.set(key, promise);
    }

    promise.then(
      (svg) => {
        if (!cancelled) setState({ key, svg });
      },
      () => {
        if (!cancelled) setState({ key, failed: true });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [chart, theme, id, key]);

  // Never show a diagram from a previous theme or chart.
  const current = state?.key === key ? state : undefined;

  if (current?.failed) {
    return (
      <CodeBlock title="Mermaid">
        <Pre>{chart}</Pre>
      </CodeBlock>
    );
  }

  if (!current?.svg) return null;

  return <div dangerouslySetInnerHTML={{ __html: current.svg }} />;
}
