import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { ArchitectureDiagram } from "@/components/docs/architecture-diagram";
import { Mermaid } from "@/components/docs/mermaid";

/**
 * Components available to every MDX document in `../docs`.
 *
 * `defaultMdxComponents` provides Fumadocs' enhanced headings, links, tables,
 * code blocks, and components such as `<Callout>`; project-specific graphics
 * are added here so content can use them without importing across the
 * content/app boundary.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ArchitectureDiagram,
    Mermaid,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
