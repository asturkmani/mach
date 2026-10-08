import type { MetadataRoute } from "next";

// Mach as an app: installed from the browser, it opens full screen with its
// own icon. Shortcuts on the icon start a task or open the Chief of Staff,
// and sharing text or a link to Mach from another app drafts a message to the
// Chief of Staff (see components/shell/url-actions.tsx).

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Mach",
    short_name: "Mach",
    description: "Run your company with people and AI agents.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#1c1b19",
    theme_color: "#1c1b19",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "New task", url: "/?do=new-task", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Chief of Staff", url: "/?do=cos", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
    share_target: {
      action: "/",
      method: "GET",
      params: { title: "share_title", text: "share_text", url: "share_url" },
    },
  };
}
