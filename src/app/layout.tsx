import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sentinel — Autonomous Data Incident Response Agent for DataHub",
  description:
    "Sentinel turns DataHub into the substrate for autonomous data incident response. When a freshness, schema, or quality signal trips in DataHub, Sentinel autonomously triages the incident, traverses lineage to identify the likely root cause, takes real actions (opens a GitHub issue, drafts a remediation pull request, posts to Slack), and writes a structured post-mortem plus proposed context enrichments back to DataHub — so the next incident is faster and the agent inherits the knowledge.",
  keywords: [
    "Sentinel",
    "DataHub",
    "Autonomous Agent",
    "Incident Response",
    "MCP",
    "Agent Context Kit",
    "Lineage",
    "Write-back Loop",
    "ReAct Agent",
    "Data Observability",
  ],
  authors: [{ name: "Sentinel Contributors" }],
  openGraph: {
    title: "Sentinel — Autonomous Data Incident Response Agent for DataHub",
    description:
      "An autonomous agent that reads DataHub through the MCP Server and the Agent Context Kit, triages incidents, takes real actions, and writes structured post-mortems + enrichments back to the context graph.",
    url: "https://github.com/sodiq-code/sentinel",
    siteName: "Sentinel",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sentinel — Autonomous Data Incident Response Agent for DataHub",
    description:
      "An autonomous agent that turns DataHub into the substrate for autonomous data incident response. Built for Build with DataHub: The Agent Hackathon.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
