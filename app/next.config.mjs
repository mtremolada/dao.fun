/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace package (CJS dist) consumed by client components.
  transpilePackages: ["@daofun/sdk"],
  // Same-origin /api/* proxies to the backend HTTP API (packages/backend),
  // so the browser never needs CORS and the API base is an env concern.
  async rewrites() {
    const api = process.env.API_URL ?? "http://127.0.0.1:4404";
    return [{ source: "/api/:path*", destination: `${api}/:path*` }];
  },
};

export default nextConfig;
