/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
