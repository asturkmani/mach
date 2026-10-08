import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mach",
  description: "Run your company with people and AI agents.",
  applicationName: "Mach",
  // Added to an iPhone's home screen, Mach opens full screen under a see-through status bar.
  appleWebApp: { capable: true, title: "Mach", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

// Fills the screen on phones with a notch; the app pads for the safe areas
// itself. The browser's bars take the page's background, light or dark.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f0ec" },
    { media: "(prefers-color-scheme: dark)", color: "#171615" },
  ],
};

// Applies a saved light/dark choice before the first paint, so pages don't flash.
const themeScript = `try{var t=localStorage.getItem("mach-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
