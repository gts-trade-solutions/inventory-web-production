/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `next dev` and `next build` both write to .next and overwrite each other's
  // chunks. Running a production build while a dev server is up leaves that dev
  // server serving chunks that no longer exist, which surfaces as
  // "Cannot read properties of undefined (reading 'call')" in layout-router.
  // Set NEXT_DIST_DIR for throwaway verification builds so they cannot collide.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // The device services open raw TCP sockets (ZPL/9100) and MQTT subscriptions, and SSE needs a
  // long-lived process. Keep these out of the client bundle and out of any edge runtime.
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  eslint: {
    dirs: ['app', 'components', 'lib', 'prisma'],
  },
  logging: {
    fetches: { fullUrl: false },
  },
}

export default nextConfig
