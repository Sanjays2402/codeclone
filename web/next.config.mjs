/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  poweredByHeader: false,
  env: {
    CODECLONE_SERVE_URL: process.env.CODECLONE_SERVE_URL || "http://127.0.0.1:7461",
    CODECLONE_RUNS_DIR: process.env.CODECLONE_RUNS_DIR || "./runs",
    CODECLONE_ADAPTERS_DIR: process.env.CODECLONE_ADAPTERS_DIR || "./adapters",
    CODECLONE_DATA_DIR: process.env.CODECLONE_DATA_DIR || "./data",
  },
};

export default nextConfig;
