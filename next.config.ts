import type { NextConfig } from "next";

// `output: "standalone"` is for local dev only — it produces a self-contained
// server.js that runs via `bun .next/standalone/server.js`. On Vercel
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
