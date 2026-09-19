import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  // proxy.ts is present, so every non-GET body is buffered through the proxy
  // with a 10 MB default cap that truncates silently — keep it above the
  // imports route's MAX_UPLOAD_BYTES (25 MB) or large CSVs lose rows
  experimental: { proxyClientMaxBodySize: "26mb" },
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingIncludes: {
    // Tracing can't follow lib/binding.js's dynamic require of the platform
    // prebuild, so include it explicitly (linux-x64 only; glibc image).
    "/*": [
      "./node_modules/better-sqlite3/lib/**/*",
      "./node_modules/better-sqlite3/prebuilds/linux-x64.node",
    ],
  },
}

export default nextConfig
