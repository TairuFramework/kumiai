import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, test } from 'vitest'

const root = new URL('../../../', import.meta.url)
async function files(dir: URL): Promise<Array<URL>> {
  const entries = await readdir(dir, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(new URL(`${entry.name}/`, dir))
          : Promise.resolve(entry.name.endsWith('.ts') ? [new URL(entry.name, dir)] : []),
      ),
    )
  ).flat()
}
function calls(source: ts.SourceFile): Array<ts.CallExpression | ts.NewExpression> {
  const found: Array<ts.CallExpression | ts.NewExpression> = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
function wrapped(node: ts.Node): boolean {
  let parent = node.parent
  while (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent))
    parent = parent.parent
  return ts.isCallExpression(parent) && parent.expression.getText() === 'restrictCommitAuthoring'
}

test('the control builder is the only production permit holder and private commits use the gate', async () => {
  const permits: Array<string> = []
  const gates: Array<string> = []
  for (const pkg of [
    'mls',
    'mls-rpc',
    'rpc',
    'mls-hub',
    'hub-client',
    'hub-server',
    'hub-tunnel',
    'hub-wake',
  ]) {
    for (const path of await files(new URL(`packages/${pkg}/src/`, root))) {
      const source = ts.createSourceFile(
        path.pathname,
        await readFile(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      for (const call of calls(source)) {
        if (call.expression.getText() === 'withCommitPermit')
          permits.push(fileURLToPath(path).slice(fileURLToPath(root).length))
        if (call.expression.getText() === 'authorPrivateCommit')
          gates.push(fileURLToPath(path).slice(fileURLToPath(root).length))
      }
    }
  }
  expect(permits).toEqual(['packages/mls-rpc/src/control-build.ts'])
  expect(gates).toEqual(['packages/mls/src/group-commit.ts'])
})

test('every access creation site restricts its handle before issuance', async () => {
  const paths = [
    ...(await files(new URL('packages/mls-rpc/src/', root))),
    ...[
      'transactional-access',
      'sealed-control-access',
      'sealed-memory-mls',
      'storage-persistence',
    ].map((name) => new URL(`packages/mls-rpc/test/fixtures/${name}.ts`, root)),
  ]
  const missed: Array<string> = []
  let checked = 0
  for (const path of paths) {
    const source = ts.createSourceFile(
      path.pathname,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    for (const call of calls(source)) {
      const name = call.expression.getText()
      if (
        ![
          'restoreGroup',
          'restoreValidated',
          'params.restoreCandidate',
          'environment.restore',
          'GroupHandle',
          'joinGroupExternal',
          'restore',
        ].includes(name)
      )
        continue
      // restoreValidated owns restriction. The control builder's source restore owns the permit.
      if (
        name === 'restoreValidated' ||
        (path.pathname.endsWith('/control-build.ts') && name === 'restoreGroup')
      )
        continue
      // This getter-only projection never escapes its getter.
      if (
        name === 'GroupHandle' &&
        path.pathname.endsWith('/sealed-memory-mls.ts') &&
        (() => {
          let node: ts.Node = call
          while (!ts.isMethodDeclaration(node) && node.parent !== undefined) node = node.parent
          return ts.isMethodDeclaration(node) && node.name.getText() === '#projection'
        })()
      )
        continue
      if (name === 'restore' && !path.pathname.endsWith('/sealed-control-access.ts')) continue
      checked++
      if (name === 'joinGroupExternal') {
        const parent = call.parent.parent.parent
        if (!/group:\s*restrictCommitAuthoring\(result\.group\)/.test(parent.getText()))
          missed.push(
            `${path.pathname}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1}`,
          )
      } else if (!wrapped(call))
        missed.push(
          `${path.pathname}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1}`,
        )
    }
  }
  expect(checked).toBeGreaterThan(15)
  expect(missed).toEqual([])
})
