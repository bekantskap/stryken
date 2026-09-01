import type { NextConfig } from 'next'

const config: NextConfig = {
  // Servermodulerna använder .ts-importer (Node type stripping).
  typedRoutes: true,
}

export default config
