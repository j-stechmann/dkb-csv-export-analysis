import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
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
