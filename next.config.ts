import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the PDF worker and native canvas paths intact on Windows/Node.
  serverExternalPackages: ['pdf-parse', '@napi-rs/canvas'],
};

export default nextConfig;
