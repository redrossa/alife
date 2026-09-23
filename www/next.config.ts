import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

// `next.config.ts` may be loaded as either CommonJS or ESM depending on how
// Node.js resolves TypeScript, so derive the config directory from whichever
// form is available.
const configDir =
  typeof __dirname === "string"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    // Content lives in the repository-root `docs/` directory, one level above
    // this app. Turbopack only resolves and watches files inside its root, so
    // widen it to the repository while keeping `www/` as the Next.js project.
    root: path.resolve(configDir, ".."),
  },
};

export default createMDX()(nextConfig);
