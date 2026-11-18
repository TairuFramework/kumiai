import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type GoldenCase = { name: string; input: unknown; expected: unknown }

/** Store vectors only on explicit opt-in; otherwise compare each named case. */
export function checkGolden(path: string, cases: Array<GoldenCase>): void {
  const names = cases.map((entry) => entry.name)
  assert.equal(new Set(names).size, names.length, 'duplicate golden case names')
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ version: 1, cases }, null, 2)}\n`)
    return
  }

  const golden = JSON.parse(readFileSync(path, 'utf8')) as {
    version: number
    cases: Array<GoldenCase>
  }
  assert.equal(golden.version, 1, 'golden version')
  assert.equal(golden.cases.length, cases.length, 'golden case count')
  const byName = new Map(golden.cases.map((entry) => [entry.name, entry]))
  assert.equal(byName.size, golden.cases.length, 'duplicate stored golden case names')
  for (const entry of cases) {
    assert.deepStrictEqual(entry, byName.get(entry.name), `golden case: ${entry.name}`)
  }
}
