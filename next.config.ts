import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the PDF worker and native canvas paths intact on Windows/Node.
  serverExternalPackages: ['pdf-parse', '@napi-rs/canvas'],
  // Bound tracing and Tailwind discovery to this checkout. Nested verification
  // workspaces otherwise make Turbopack infer the parent repository root.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
