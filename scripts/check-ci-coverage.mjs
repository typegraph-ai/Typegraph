import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const packagesDir = join(root, 'packages')
const requiredScripts = ['build', 'typecheck', 'test']

function findPackageJsonFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') {
      return []
    }

    const path = join(dir, entry.name)
    if (entry.isDirectory()) return findPackageJsonFiles(path)
    return entry.isFile() && entry.name === 'package.json' ? [path] : []
  })
}

const failures = []

for (const packageJsonPath of findPackageJsonFiles(packagesDir)) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (pkg.private === true || typeof pkg.name !== 'string') continue

  const missing = requiredScripts.filter(script => typeof pkg.scripts?.[script] !== 'string')
  if (missing.length > 0) {
    failures.push(`${relative(root, packageJsonPath)} (${pkg.name}) missing: ${missing.join(', ')}`)
  }
}

if (failures.length > 0) {
  console.error('Publishable workspace packages must define build, typecheck, and test scripts.')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

