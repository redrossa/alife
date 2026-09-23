import { permanentRedirect } from "next/navigation";

export default function DocsEntryPage() {
  permanentRedirect("/docs/welcome");
}
