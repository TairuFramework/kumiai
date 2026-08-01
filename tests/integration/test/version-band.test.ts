import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

const script = fileURLToPath(new URL('../../../scripts/check-versions.mjs', import.meta.url))

const created: Array<string> = []

function fixture(manifests: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'version-band-'))
  created.push(dir)
  for (const manifest of manifests) {
    const packageDir = join(dir, String(manifest.name).replace(/^@[^/]+\//, ''))
    mkdirSync(packageDir)
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest))
  }
  return dir
}

function run(dir: string) {
  return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('version band check', () => {
  test('passes when every publishable package shares a pre-1.0 minor', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '0.4.0' },
      { name: '@kumiai/two', version: '0.4.3' },
      { name: '@kumiai/three', version: '0.4.11' },
    ])
    const result = run(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0.4')
  })

  test('fails when one package is off the band, naming it', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '0.4.0' },
      { name: '@kumiai/stray', version: '0.1.0' },
      { name: '@kumiai/two', version: '0.4.3' },
    ])
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@kumiai/stray')
    expect(result.stderr).toContain('0.1.0')
  })

  test('ignores private packages', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '0.4.0' },
      { name: '@kumiai/tests', version: '9.9.9', private: true },
    ])
    expect(run(dir).status).toBe(0)
  })

  test('bands on the major from 1.0, so minors may diverge', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '1.2.0' },
      { name: '@kumiai/two', version: '1.5.3' },
    ])
    expect(run(dir).status).toBe(0)
  })

  test('fails when majors diverge from 1.0', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '1.5.3' },
      { name: '@kumiai/two', version: '2.0.0' },
    ])
    expect(run(dir).status).toBe(1)
  })

  test('fails when no publishable package is found', () => {
    const dir = fixture([{ name: '@kumiai/tests', version: '0.0.0', private: true }])
    expect(run(dir).status).toBe(1)
  })

  test('fails loudly on a malformed manifest instead of skipping it', () => {
    const dir = fixture([{ name: '@kumiai/one', version: '0.4.0' }])
    const packageDir = join(dir, 'broken')
    mkdirSync(packageDir)
    writeFileSync(join(packageDir, 'package.json'), '{ not valid json')
    const result = run(dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('broken')
  })
})
