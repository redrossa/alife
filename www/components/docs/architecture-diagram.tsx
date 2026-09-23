import type { ComponentProps } from "react";

/**
 * A theme-aware SVG diagram of Alife's world / body / mind separation.
 * Server-compatible: no hooks, no SVG ids, colors come from the site tokens.
 */
export function ArchitectureDiagram(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 560 180"
      role="img"
      aria-label="World, body, and mind in Alife"
      {...props}
    >
      <title>World, body, and mind in Alife</title>
      <desc>
        The harness mediates perception and action between the world and the
        model: the world is perceived by the body, the model receives that
        experience and returns intentions, and the body acts on the world.
      </desc>

      <g
        fill="none"
        stroke="var(--rule)"
        strokeWidth="1.5"
        rx="8"
        strokeLinejoin="round"
      >
        <rect x="20" y="60" width="140" height="60" />
        <rect x="210" y="60" width="140" height="60" />
        <rect x="400" y="60" width="140" height="60" />
      </g>

      <g
        fill="var(--foreground)"
        fontSize="14"
        fontWeight="600"
        textAnchor="middle"
        fontFamily="var(--font-geist-sans)"
      >
        <text x="90" y="86">
          World
        </text>
        <text x="280" y="86">
          Body
        </text>
        <text x="470" y="86">
          Mind
        </text>
      </g>

      <g
        fill="var(--muted)"
        fontSize="12"
        textAnchor="middle"
        fontFamily="var(--font-geist-sans)"
      >
        <text x="90" y="106">
          Filesystem
        </text>
        <text x="280" y="106">
          Harness
        </text>
        <text x="470" y="106">
          Model
        </text>
      </g>

      <g
        fill="none"
        stroke="var(--muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Perceptions: world → body */}
        <path d="M160 80H210M202 75l8 5-8 5" />
        {/* Experience: body → mind */}
        <path d="M350 80H400M392 75l8 5-8 5" />
        {/* Intentions: mind → body */}
        <path d="M400 100H350M358 95l-8 5 8 5" />
        {/* Actions: body → world */}
        <path d="M210 100H160M168 95l-8 5 8 5" />
      </g>

      <g
        fill="var(--muted)"
        fontSize="11"
        textAnchor="middle"
        fontFamily="var(--font-geist-sans)"
      >
        <text x="185" y="70">
          Perceptions
        </text>
        <text x="375" y="70">
          Experience
        </text>
        <text x="375" y="118">
          Intentions
        </text>
        <text x="185" y="118">
          Actions
        </text>
      </g>
    </svg>
  );
}
