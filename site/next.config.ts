import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // /explore was the legacy top-level route for the public-debate
      // feed. It moved under Journal as /journal/debates so the IA
      // reflects that browsing public debates is a Journal-Lab activity.
      // Permanent redirect so any externally-shared /explore link still
      // lands on the right page.
      { source: "/explore", destination: "/journal/debates", permanent: true },
    ];
  },
};

export default nextConfig;
