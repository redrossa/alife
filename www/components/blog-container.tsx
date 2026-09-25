import type { ReactNode } from "react";

/*
 * Content column shared by the blog index and post pages. Mirrors the
 * Fumadocs docs page container so typography, spacing, and width match the
 * docs. Page navigation such as the back link lives in this column but
 * outside the post's <article>.
 */
export default function BlogContainer({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full max-w-[900px] min-w-0 flex-col gap-4 p-4 md:p-6 xl:p-8">
      {children}
    </div>
  );
}
