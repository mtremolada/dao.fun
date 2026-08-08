/** @type {import('next').NextConfig} */

// Two deploy targets:
//  - Vercel (the public devnet app): SSR, so headers() applies and the app can
//    talk to the backend API + our RPC proxy. STATIC_EXPORT is unset.
//  - GitHub Pages (legacy, being retired): STATIC_EXPORT=1 emits a static SPA;
//    headers() is not supported there and is omitted.
const isExport = process.env.STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

// Clickjacking protection is the #1 wallet-dapp attack (an invisible iframe
// over the confirm button), so frame-ancestors/XFO are enforced from day one.
// The CSP connect-src must include the RPC + API hosts the app calls.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'",
      // Next.js needs inline/eval in dev; wallet extensions inject regardless of CSP.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self' https: wss:",
    ].join("; "),
  },
];

const nextConfig = {
  transpilePackages: ["@daofun/sdk"],
  images: { unoptimized: true },
  ...(isExport ? { output: "export", trailingSlash: true } : {}),
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  ...(isExport
    ? {}
    : {
        async headers() {
          return [{ source: "/:path*", headers: securityHeaders }];
        },
      }),
};

export default nextConfig;
