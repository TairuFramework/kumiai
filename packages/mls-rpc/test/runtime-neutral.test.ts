import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, test } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceRoots = [join(root, 'packages/mls-rpc/src'), join(root, 'packages/rpc-conformance/src')]
const forbiddenIdentifiers = new Set([
  'AsyncLocalStorage',
  'structuredClone',
  'setImmediate',
  'process',
  'Buffer',
])
function sourceFiles(directory: string): Array<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && entry.name.endsWith('.ts')
        ? [path]
        : []
  })
}

function moduleName(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined
}

function isTypeofGuard(expression: ts.Expression, name: string): boolean {
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    ts.isTypeOfExpression(expression.left) &&
    ts.isIdentifier(expression.left.expression) &&
    expression.left.expression.text === name &&
    ts.isStringLiteral(expression.right) &&
    expression.right.text === 'undefined'
  )
}

function isTypeofGuarded(node: ts.Identifier): boolean {
  const name = node.text
  const contains = (parent: ts.Node, child: ts.Node): boolean => {
    if (parent === child) return true
    let found = false
    ts.forEachChild(parent, (descendant) => {
      if (contains(descendant, child)) found = true
    })
    return found
  }
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      contains(parent.right, node) &&
      isTypeofGuard(parent.left, name)
    )
      return true
  }
  return false
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  if (
    ts.isTypeOfExpression(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isExportSpecifier(parent) && parent.name === node)
  )
    return false
  return true
}

function sourceViolations(path: string, text: string): Array<string> {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: Array<string> = []
  const report = (node: ts.Node, message: string) => {
    const location = file.getLineAndCharacterOfPosition(node.getStart(file))
    found.push(`${path}:${location.line + 1}: ${message}`)
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && moduleName(node.moduleSpecifier)?.startsWith('node:'))
      report(node, `forbidden import ${moduleName(node.moduleSpecifier)}`)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      moduleName(node.arguments[0])?.startsWith('node:')
    )
      report(node, `forbidden module call ${moduleName(node.arguments[0])}`)
    if (ts.isPropertyAccessExpression(node)) {
      const owner = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'globalThis'
          ? node.expression.name.text
          : undefined
      if (
        (owner === 'Promise' && node.name.text === 'withResolvers') ||
        ((owner === 'AbortSignal' || owner === 'globalThis.AbortSignal') &&
          (node.name.text === 'any' || node.name.text === 'timeout'))
      )
        report(node, `forbidden global property ${owner}.${node.name.text}`)
    }
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text) && isReferenceIdentifier(node))
      report(node, `forbidden global reference ${node.text}`)
    if (
      ts.isIdentifier(node) &&
      (node.text === 'SharedArrayBuffer' || node.text === 'Atomics') &&
      isReferenceIdentifier(node) &&
      !isTypeofGuarded(node)
    )
      report(node, `${node.text} reference lacks a typeof guard`)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      forbiddenIdentifiers.has(node.name.text)
    )
      report(node, `forbidden global reference globalThis.${node.name.text}`)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function violations(path: string): Array<string> {
  return sourceViolations(path, readFileSync(path, 'utf8'))
}

describe('runtime-neutral source baseline', () => {
  test('ignores comments, strings and identifiers named node', () => {
    expect(
      sourceViolations(
        'snippet.ts',
        "const node = 'node:fs structuredClone process'; // Buffer\n/* setImmediate */",
      ),
    ).toEqual([])
  })

  test('matches static, dynamic and require node module imports', () => {
    expect(
      sourceViolations(
        'snippet.ts',
        "import value from 'node:fs'; import('node:fs'); require('node:fs')",
      ),
    ).toHaveLength(3)
  })

  test('has no Node imports or forbidden global references', () => {
    const failures = sourceRoots.flatMap((directory) => sourceFiles(directory).flatMap(violations))
    expect(failures).toEqual([])
  })
})
