import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  redirects: () => [
    { source: "/auth/:path*", destination: "/download", permanent: false },
    { source: "/dashboard/:path*", destination: "/download", permanent: false },
  ],
};

export default nextConfig;
