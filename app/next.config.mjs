/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace package (CJS dist) consumed by client components.
  transpilePackages: ["@daofun/sdk"],
  // Same-origin /api/* proxies to the backend HTTP API (packages/backend),
  // so the browser never needs CORS and the API base is an env concern.
  // NOTE: rewrites need a Node host; for a fully static/IPFS export the app
  // uses NEXT_PUBLIC_RPC_URL and never calls /api (see deploy docs).
  async rewrites() {
    const api = process.env.API_URL ?? "http://127.0.0.1:4404";
    return [{ source: "/api/:path*", destination: `${api}/:path*` }];
  },
  // The decentralized client builds + signs + verifies on chain, so the SDK
  // (and web3.js/spl/anchor) run in the BROWSER. Provide the Buffer global and
  // stub Node-core modules they reference but never need at runtime in the
  // browser — the SDK's own hashing is the dependency-free ./sha256 (no
  // node:crypto), so this is just for transitive deps.
  webpack: (config, { webpack, isServer }) => {
    if (!isServer) {
      config.plugins.push(
        new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
      );
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        stream: false,
        fs: false,
        path: false,
        os: false,
      };
    }
    return config;
  },
};

export default nextConfig;
