import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Prevent Next from picking an unrelated workspace root when multiple lockfiles exist.
  // This avoids missing server chunk/module issues on Windows in some setups.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;

