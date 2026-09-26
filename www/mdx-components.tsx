import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { Mermaid } from "@/components/docs/mermaid";

/**
 * Components available to every MDX document in `../docs`.
 *
 * `defaultMdxComponents` provides Fumadocs' enhanced headings, links, tables,
 * code blocks, and components such as `<Callout>`. `Mermaid` renders the
 * `mermaid` fences the docs use for diagrams; it is registered here because
 * content cannot import across the content/app boundary.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Mermaid,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
