/** @type {import('next').NextConfig} */

// GitHub Pages is static-only. The Pages CI build sets STATIC_EXPORT=1 (and
// NEXT_PUBLIC_BASE_PATH to the repo subpath, e.g. /dao.fun) so we emit a
// fully static SPA. Local dev / `next dev` leaves these unset and runs
// normally. There is no backend: the app reads chain state over the user's
// RPC and sends transactions through the connected wallet.
const isExport = process.env.STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig = {
  transpilePackages: ["@daofun/sdk"],
  // Static export needs the default (no-loader) image behaviour.
  images: { unoptimized: true },
  ...(isExport ? { output: "export", trailingSlash: true } : {}),
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
