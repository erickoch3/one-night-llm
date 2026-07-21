import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    metadataBase,
    title: {
      default: "One Night",
      template: "%s · One Night",
    },
    description:
      "A local, LLM-powered social deduction game where every voice competes for the floor.",
    openGraph: {
      type: "website",
      title: "One Night — A village of voices",
      description:
        "One human. A village of AI players. Find the werewolves before dawn.",
      images: [
        {
          url: "/og.png",
          width: 1200,
          height: 630,
          alt: "One Night — A Village of Voices",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "One Night — A village of voices",
      description:
        "One human. A village of AI players. Find the werewolves before dawn.",
      images: ["/og.png"],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#080c16",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
