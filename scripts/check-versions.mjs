#!/usr/bin/env node
// Every publishable package shares one version band: the minor while pre-1.0 (0.X), the major
// after (X). Trailing segments diverge freely — a single package's patch release churns nobody.
// Usage: node scripts/check-versions.mjs [packagesDir]
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function bandOf(version) {
  const [major, minor] = version.split('.')
  return major === '0' ? `0.${minor}` : major
}

function readPackages(packagesDir) {
  const packages = []
  for (const entry of readdirSync(packagesDir)) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(packagesDir, entry, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (manifest.private || !manifest.version) {
      continue
    }
    packages.push({
      name: manifest.name,
      version: manifest.version,
      band: bandOf(manifest.version),
    })
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name))
}

const packagesDir =
  process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'packages')
const packages = readPackages(packagesDir)

if (packages.length === 0) {
  console.error(`No publishable package found in ${packagesDir}`)
  process.exit(1)
}

const bands = [...new Set(packages.map((entry) => entry.band))]
if (bands.length > 1) {
  console.error(`Version band split across ${bands.length} bands: ${bands.join(', ')}`)
  for (const entry of packages) {
    console.error(`  ${entry.name} ${entry.version} (band ${entry.band})`)
  }
  process.exit(1)
}

console.log(`All ${packages.length} publishable packages on band ${bands[0]}.`)
