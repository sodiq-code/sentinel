import type { NextConfig } from "next";

// `output: "standalone"` is sandbox-only — it produces a self-contained
// server.js the sandbox runs via `bun .next/standalone/server.js`. On Vercel
// the standalone output interferes with serverless function routing, so we
// disable it there (Vercel sets VERCEL=1 at build time) + let Vercel build a
// standard serverless Next.js deployment.
const isVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true";

const nextConfig: NextConfig = {
  output: isVercel ? undefined : "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
