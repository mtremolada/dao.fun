/**
 * Fully static, server-less build (D-033): `output: "export"` emits a plain
 * directory of HTML/JS/CSS with NO Node server and NO custody path on the
 * host — deployable to IPFS or any static host. Every page reads the chain
 * and builds/submits transactions client-side against a user-chosen RPC.
 *
 * - trailingSlash keeps clean directory URLs (/proposal/ -> index.html), which
 *   IPFS path gateways serve correctly.
 * - basePath/assetPrefix are env-driven so the same export works at a domain
 *   root, under an IPFS subdomain gateway (CID at root), or a subpath host
 *   (set NEXT_PUBLIC_BASE_PATH=/sub for GitHub-Pages-style subpaths).
 * - The browser bundle gets a Buffer global (the SDK + web3.js assume it) and
 *   node-core modules are stubbed out — the SDK is isomorphic (vendored
 *   SHA-256, D-033), so nothing reaches for `node:` schemes at runtime.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@daofun/sdk"],
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  webpack: (config, { webpack }) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      crypto: false,
      stream: false,
      http: false,
      https: false,
      zlib: false,
      url: false,
      fs: false,
      net: false,
      tls: false,
      os: false,
      path: false,
    };
    config.plugins.push(
      new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
    );
    return config;
  },
};

export default nextConfig;
