import type { NextConfig } from "next"

const isDev = process.env.NODE_ENV === "development"

// Defense-in-depth for served pages: no code/styles from other origins, no
// framing (clickjacking), no referrer leakage, no form posts elsewhere.
// 'unsafe-inline' style-src is required (Tailwind's preflight + shadcn
// chart themes render inline <style>); script-src keeps 'self' with inline
// scripts allowed by Next's runtime-generated bootstrap (nonce-free config
// path, per the bundled CSP guide). Dev needs 'unsafe-eval' (React dev
// stack reconstruction).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

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
  async headers() {
    return [
      {
        // all app routes (Next internals + static assets are served with
        // their own well-cached responses; they carry no app data)
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
      {
        // API + auth responses are per-user or contain flow secrets — never
        // cache anywhere (browser, intermediary, service worker). The regex
        // alternation is the path-to-regexp form documented for headers().
        source: "/:path(api|auth)/:subpath*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ]
  },
}

export default nextConfig
