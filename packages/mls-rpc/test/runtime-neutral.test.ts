import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { beforeAll, describe, expect, test } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceRoots = [
  'mls-rpc',
  'mls',
  'rpc',
  'broadcast',
  'hub-client',
  'hub-protocol',
  'hub-tunnel',
  'mls-hub',
  'rpc-conformance',
].map((name) => join(root, 'packages', name, 'src'))
const optionalDeclarations = join(root, 'packages/mls-rpc/test/fixtures/runtime-optional.d.ts')
const hostGlobals = new Set([
  'WeakMap',
  'WeakSet',
  'AbortController',
  'AbortSignal',
  'queueMicrotask',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'TextEncoder',
  'TextDecoder',
  'crypto',
  'ReadableStream',
  'WritableStream',
  'CountQueuingStrategy',
])
const optionalGlobals = new Set(['Float16Array', 'SharedArrayBuffer', 'Atomics'])
const hostMembers = new Map([
  ['AbortController', new Set(['signal', 'abort'])],
  ['AbortSignal', new Set(['aborted', 'reason', 'addEventListener', 'removeEventListener'])],
  ['Crypto', new Set(['getRandomValues', 'subtle', 'randomUUID'])],
])
const forbiddenMembers = new Map([
  ['PromiseConstructor', new Set(['withResolvers'])],
  ['String', new Set(['isWellFormed', 'toWellFormed'])],
  ['StringConstructor', new Set(['isWellFormed', 'toWellFormed'])],
  ['SymbolConstructor', new Set(['dispose', 'asyncDispose'])],
])
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

function isLibraryDeclaration(node: ts.Node): boolean {
  return /[/\\]lib\.[^/\\]+\.d\.ts$/.test(node.getSourceFile().fileName)
}

function isDOMDeclaration(node: ts.Node): boolean {
  return node.getSourceFile().fileName.endsWith('/lib.dom.d.ts')
}

function isRuntimeHeritage(node: ts.Node): node is ts.ExpressionWithTypeArguments {
  return (
    ts.isExpressionWithTypeArguments(node) &&
    ts.isHeritageClause(node.parent) &&
    node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
    (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent))
  )
}

function isTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current) && !isRuntimeHeritage(current)) return true
  }
  return false
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  return !(
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
    ((ts.isLabeledStatement(parent) ||
      ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent)) &&
      parent.label === node) ||
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent)
  )
}

function nameViolations(program: ts.Program, file: ts.SourceFile): Array<string> {
  const checker = program.getTypeChecker()
  const found: Array<string> = []
  const report = (node: ts.Node, message: string) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    found.push(`${file.fileName}:${line}: ${message}`)
  }
  const symbolAt = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node)
    return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol
  }
  const isGlobal = (symbol: ts.Symbol): boolean => {
    return (symbol.declarations ?? []).some((declaration) => {
      return (
        (isLibraryDeclaration(declaration) ||
          declaration.getSourceFile().fileName === optionalDeclarations) &&
        ((ts.isVariableDeclaration(declaration) &&
          ts.isSourceFile(declaration.parent.parent.parent)) ||
          ((ts.isFunctionDeclaration(declaration) || ts.isModuleDeclaration(declaration)) &&
            ts.isSourceFile(declaration.parent)))
      )
    })
  }
  function unwrap(expression: ts.Expression): ts.Expression {
    return ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
      ? unwrap(expression.expression)
      : expression
  }
  function receiverType(expression: ts.Expression): ts.Type {
    return checker.getNonNullableType(checker.getTypeAtLocation(unwrap(expression)))
  }
  function expressionSymbol(expression: ts.Expression): ts.Symbol | undefined {
    const inner = unwrap(expression)
    if (ts.isPropertyAccessExpression(inner))
      return receiverType(inner.expression).getProperty(inner.name.text)
    if (ts.isElementAccessExpression(inner)) {
      const names = propertyNames(inner.argumentExpression)
      const name = names[0]
      return names.length === 1 && name !== undefined
        ? receiverType(inner.expression).getProperty(name)
        : undefined
    }
    return symbolAt(inner)
  }
  function guard(condition: ts.Expression, symbol: ts.Symbol): boolean | undefined {
    const expression = unwrap(condition)
    if (!ts.isBinaryExpression(expression)) return undefined
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return guard(expression.left, symbol) === true || guard(expression.right, symbol) === true
        ? true
        : undefined
    if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      return guard(expression.left, symbol) === false || guard(expression.right, symbol) === false
        ? false
        : undefined
    const left = unwrap(expression.left)
    const right = unwrap(expression.right)
    const comparison = ts.isTypeOfExpression(left) ? [left, right] : [right, left]
    const typeOf = comparison[0]
    const value = comparison[1]
    if (
      typeOf === undefined ||
      value === undefined ||
      !ts.isTypeOfExpression(typeOf) ||
      !ts.isStringLiteral(value) ||
      value.text !== 'undefined' ||
      expressionSymbol(typeOf.expression) !== symbol
    )
      return undefined
    if (expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return true
    if (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return false
    return undefined
  }
  function guarded(node: ts.Node, symbol: ts.Symbol): boolean {
    for (
      let child = node, parent = node.parent;
      parent !== undefined;
      child = parent, parent = parent.parent
    ) {
      if (ts.isTypeOfExpression(parent) && unwrap(parent.expression) === node) return true
      if (ts.isBinaryExpression(parent) && parent.right === child) {
        const present = guard(parent.left, symbol)
        if (
          (present === true &&
            parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) ||
          (present === false && parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        )
          return true
      }
      if (ts.isIfStatement(parent)) {
        const present = guard(parent.expression, symbol)
        if (
          (present === true && parent.thenStatement === child) ||
          (present === false && parent.elseStatement === child)
        )
          return true
      }
      if (ts.isConditionalExpression(parent)) {
        const present = guard(parent.condition, symbol)
        if (
          (present === true && parent.whenTrue === child) ||
          (present === false && parent.whenFalse === child)
        )
          return true
      }
    }
    return false
  }
  function globalReference(node: ts.Node, symbol: ts.Symbol | undefined, name: string): void {
    if (symbol !== undefined && !isGlobal(symbol)) return
    if (forbiddenIdentifiers.has(name)) report(node, `forbidden global reference ${name}`)
    else if (symbol !== undefined && optionalGlobals.has(name)) {
      if (!guarded(node, symbol)) report(node, `${name} reference lacks a typeof guard`)
    } else if (symbol?.declarations?.some(isDOMDeclaration) && !hostGlobals.has(name))
      report(node, `forbidden host global ${name}`)
  }
  function propertyNames(node: ts.Node): Array<string> {
    if (ts.isComputedPropertyName(node)) return propertyNames(node.expression)
    if (
      ts.isStringLiteralLike(node) ||
      (ts.isIdentifier(node) &&
        !ts.isElementAccessExpression(node.parent) &&
        !ts.isComputedPropertyName(node.parent))
    )
      return [node.text]
    const type = checker.getTypeAtLocation(node)
    return (type.isUnion() ? type.types : [type]).flatMap((part) => {
      return part.isStringLiteral() ? [part.value] : []
    })
  }
  function bindingType(pattern: ts.ObjectBindingPattern): ts.Type {
    const binding = pattern.parent
    return ts.isVariableDeclaration(binding) && binding.initializer !== undefined
      ? receiverType(binding.initializer)
      : checker.getTypeAtLocation(pattern)
  }
  function collectHostOwners(type: ts.Type, owners: Set<string>, seen: Set<ts.Type>): void {
    if (seen.has(type)) return
    seen.add(type)
    const owner = type.getSymbol()
    if (owner !== undefined && (owner.declarations ?? []).some(isLibraryDeclaration)) {
      if (hostMembers.has(owner.getName())) owners.add(owner.getName())
    }
    if (type.isUnionOrIntersection()) {
      for (const part of type.types) collectHostOwners(part, owners, seen)
    }
    for (const base of type.getBaseTypes() ?? []) collectHostOwners(base, owners, seen)
    for (const declaration of owner?.declarations ?? []) {
      if (
        ts.isBindingElement(declaration) &&
        declaration.dotDotDotToken !== undefined &&
        ts.isObjectBindingPattern(declaration.parent)
      )
        collectHostOwners(bindingType(declaration.parent), owners, seen)
    }
  }
  function member(node: ts.Node, type: ts.Type, name: string, symbol?: ts.Symbol): void {
    const owner = type.getSymbol()
    if (owner?.getName() === 'globalThis' && (owner.declarations?.length ?? 0) === 0) {
      globalReference(node, symbol, name)
      return
    }
    const builtin = (owner?.declarations ?? []).some(isLibraryDeclaration)
    const stringLike = (type.flags & ts.TypeFlags.StringLike) !== 0
    const ownerName = stringLike ? 'String' : owner?.getName()
    if (ownerName !== undefined && (builtin || stringLike)) {
      if (forbiddenMembers.get(ownerName)?.has(name))
        report(node, `forbidden global property ${ownerName}.${name}`)
    }
    const hostOwners = new Set<string>()
    if (symbol === undefined || (symbol.declarations ?? []).some(isLibraryDeclaration))
      collectHostOwners(type, hostOwners, new Set())
    for (const declaration of symbol?.declarations ?? []) {
      if (!isDOMDeclaration(declaration)) continue
      let parent = declaration.parent
      while (parent !== undefined && !ts.isSourceFile(parent)) {
        if (ts.isInterfaceDeclaration(parent) || ts.isVariableDeclaration(parent)) {
          const ownerName = ts.isIdentifier(parent.name) ? parent.name.text : undefined
          if (ownerName !== undefined && hostMembers.has(ownerName)) hostOwners.add(ownerName)
          break
        }
        parent = parent.parent
      }
    }
    for (const ownerName of hostOwners) {
      if (!hostMembers.get(ownerName)?.has(name))
        report(node, `forbidden host member ${ownerName}.${name}`)
    }
  }
  function assignmentMembers(expression: ts.Expression, type: ts.Type): void {
    const pattern = unwrap(expression)
    if (
      ts.isBinaryExpression(pattern) &&
      pattern.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      assignmentMembers(pattern.left, type)
      return
    }
    if (!ts.isObjectLiteralExpression(pattern)) return
    for (const property of pattern.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
        continue
      for (const name of propertyNames(property.name)) {
        const symbol = type.getProperty(name)
        member(property, type, name, symbol)
        if (ts.isPropertyAssignment(property) && symbol !== undefined)
          assignmentMembers(
            property.initializer,
            checker.getTypeOfSymbolAtLocation(symbol, property),
          )
      }
    }
  }
  function visit(node: ts.Node): void {
    if (isTypePosition(node)) return
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      moduleName(node.moduleSpecifier)?.startsWith('node:')
    )
      report(node, `forbidden import ${moduleName(node.moduleSpecifier)}`)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          symbolAt(node.expression) === undefined)) &&
      moduleName(node.arguments[0])?.startsWith('node:')
    )
      report(node, `forbidden module call ${moduleName(node.arguments[0])}`)
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0)
      report(node, 'forbidden using declaration')
    if (ts.isIdentifier(node) && isReferenceIdentifier(node))
      globalReference(node, symbolAt(node), node.text)
    if (isRuntimeHeritage(node)) {
      const type = receiverType(node.expression)
      const prototype = type.getProperty('prototype')
      if (prototype !== undefined) {
        const instance = checker.getTypeOfSymbolAtLocation(prototype, node.expression)
        if (instance.getSymbol()?.getName() === 'AbortSignal')
          member(node.expression, instance, 'constructor')
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const type = receiverType(node.expression)
      member(node, type, node.name.text, type.getProperty(node.name.text))
    }
    if (ts.isElementAccessExpression(node)) {
      const type = receiverType(node.expression)
      for (const name of propertyNames(node.argumentExpression)) {
        member(node, type, name, type.getProperty(name))
      }
    }
    if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      node.dotDotDotToken === undefined
    ) {
      const type = bindingType(node.parent)
      for (const name of propertyNames(node.propertyName ?? node.name)) {
        member(node, type, name, type.getProperty(name))
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      assignmentMembers(node.left, receiverType(node.right))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function sourceViolations(path: string, text: string): Array<string> {
  const program = baselineProgram(
    join(root, 'packages/mls-rpc/src'),
    new Map([[resolve(path), text]]),
  )
  const file = program.getSourceFile(resolve(path))
  if (file === undefined) throw new Error(`Missing source ${path}`)
  return nameViolations(program, file)
}

function baselineProgram(directory: string, snippets = new Map<string, string>()): ts.Program {
  const configPath = join(dirname(directory), 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  const options = {
    ...parsed.options,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    skipLibCheck: true,
    noEmit: true,
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const snippet = snippets.get(path)
    return snippet === undefined
      ? getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(path, snippet, languageVersion, true)
  }
  return ts.createProgram(
    [...(snippets.size === 0 ? sourceFiles(directory) : snippets.keys()), optionalDeclarations],
    options,
    host,
  )
}

function typeViolations(program: ts.Program, file: ts.SourceFile): Array<string> {
  return program.getSemanticDiagnostics(file).map((diagnostic) => {
    const line = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1
    return `${file.fileName}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
  })
}

const negativeFixtures = [
  ['typeof optional call', 'typeof Atomics.load(new Int32Array(1), 0)', 'name', 'typeof guard'],
  ['typeof optional member', 'typeof Atomics.load', 'name', 'typeof guard'],
  ['typeof optional construction', 'typeof new Float16Array(1)', 'name', 'typeof guard'],
  ['typeof computed optional member', "typeof globalThis['Atomics'].load", 'name', 'typeof guard'],
  ['class DOM heritage', 'class HostError extends DOMException {}', 'name', 'DOMException'],
  [
    'class expression DOM heritage',
    'const HostError = class extends DOMException {}',
    'name',
    'DOMException',
  ],
  [
    'class stream controller heritage',
    'class Controller extends ReadableStreamDefaultController {}',
    'name',
    'ReadableStreamDefaultController',
  ],
  ['class signal heritage', 'class Signal extends AbortSignal {}', 'name', 'AbortSignal'],
  [
    'class expression signal heritage',
    'const Signal = class extends AbortSignal {}',
    'name',
    'AbortSignal',
  ],
  [
    'class computed DOM heritage',
    "class HostError extends globalThis['DOMException'] {}",
    'name',
    'DOMException',
  ],
  [
    'union signal keys',
    "const key: 'onabort' | 'dispatchEvent' = Math.random() > 0.5 ? 'onabort' : 'dispatchEvent'; new AbortController().signal[key]",
    'name',
    'onabort',
  ],
  [
    'mixed union signal keys',
    "const key: 'aborted' | 'onabort' = Math.random() > 0.5 ? 'aborted' : 'onabort'; new AbortController().signal[key]",
    'name',
    'onabort',
  ],
  [
    'union global keys',
    "const key: 'structuredClone' | 'queueMicrotask' = Math.random() > 0.5 ? 'structuredClone' : 'queueMicrotask'; globalThis[key]",
    'name',
    'structuredClone',
  ],
  [
    'assignment signal alias',
    'let x; ({ onabort: x } = new AbortController().signal)',
    'name',
    'onabort',
  ],
  [
    'assignment signal shorthand',
    'let onabort; ({ onabort } = new AbortController().signal)',
    'name',
    'onabort',
  ],
  [
    'assignment computed signal key',
    "const key = 'onabort'; let x; ({ [key]: x } = new AbortController().signal)",
    'name',
    'onabort',
  ],
  [
    'assignment union signal keys',
    "const key: 'aborted' | 'onabort' = Math.random() > 0.5 ? 'aborted' : 'onabort'; let x; ({ [key]: x } = new AbortController().signal)",
    'name',
    'onabort',
  ],
  [
    'assignment Promise static',
    'let resolve; ({ withResolvers: resolve } = Promise)',
    'name',
    'withResolvers',
  ],
  [
    'assignment global alias',
    'let clone; ({ structuredClone: clone } = globalThis)',
    'name',
    'structuredClone',
  ],
  [
    'assignment nested signal member',
    'let x; ({ signal: { onabort: x } } = new AbortController())',
    'name',
    'onabort',
  ],
  [
    'rest binding later forbidden access',
    'const { ...rest } = new AbortController().signal; rest.onabort',
    'name',
    'AbortSignal.onabort',
  ],
  ['cast global clone', '(globalThis as any).structuredClone({})', 'name', 'structuredClone'],
  ['cast global process', '(globalThis as any).process', 'name', 'process'],
  ['cast Promise static', '(Promise as any).withResolvers()', 'name', 'withResolvers'],
  [
    'cast optional signal call',
    'const signal = new AbortController().signal; (signal as any).throwIfAborted?.()',
    'name',
    'throwIfAborted',
  ],
  [
    'type assertion global clone',
    '(<any>globalThis).structuredClone({})',
    'name',
    'structuredClone',
  ],
  ['type assertion Promise static', '(<any>Promise).withResolvers()', 'name', 'withResolvers'],
  [
    'parenthesised cast Promise static',
    '(((Promise as any))).withResolvers()',
    'name',
    'withResolvers',
  ],
  [
    'non-null cast signal member',
    'const signal = new AbortController().signal; (signal as any)!.throwIfAborted()',
    'name',
    'throwIfAborted',
  ],
  [
    'satisfies cast Promise static',
    '(Promise as any satisfies object).withResolvers()',
    'name',
    'withResolvers',
  ],
  [
    'cast computed global clone',
    "(globalThis as any)['structuredClone']({})",
    'name',
    'structuredClone',
  ],
  [
    'cast destructured Promise static',
    'const { withResolvers: resolve } = Promise as any',
    'name',
    'withResolvers',
  ],
  [
    'cast assignment signal member',
    'const signal = new AbortController().signal; let x; ({ onabort: x } = signal as any)',
    'name',
    'onabort',
  ],
  ['DOM WebAssembly namespace', 'WebAssembly.validate(new Uint8Array())', 'name', 'WebAssembly'],
  ['DOM CSS namespace', "CSS.supports('display', 'grid')", 'name', 'CSS'],
  ['computed DOM namespace', "globalThis['CSS'].supports('display', 'grid')", 'name', 'CSS'],
  [
    'destructured DOM namespace',
    'const { WebAssembly: wasm } = globalThis; wasm.validate(new Uint8Array())',
    'name',
    'WebAssembly',
  ],
  [
    'inherited signal member',
    "const signal = new AbortController().signal; signal.dispatchEvent(new Event('abort'))",
    'name',
    'AbortSignal.dispatchEvent',
  ],
  [
    'inherited signal union member',
    "const key: 'dispatchEvent' | 'aborted' = Math.random() > 0.5 ? 'dispatchEvent' : 'aborted'; new AbortController().signal[key]",
    'name',
    'AbortSignal.dispatchEvent',
  ],
  [
    'cast inherited signal member',
    'const signal = new AbortController().signal; (signal as any).dispatchEvent',
    'name',
    'AbortSignal.dispatchEvent',
  ],
  [
    'inherited signal method receiver',
    'const signal = new AbortController().signal; signal.addEventListener("abort", function () { this.dispatchEvent })',
    'name',
    'AbortSignal.dispatchEvent',
  ],
  [
    'rest inherited signal member',
    'const { ...rest } = new AbortController().signal; rest.dispatchEvent',
    'name',
    'AbortSignal.dispatchEvent',
  ],
  [
    'interface inherited signal member',
    'interface Signal extends AbortSignal {}; declare const signal: Signal; signal.dispatchEvent',
    'name',
    'AbortSignal.dispatchEvent',
  ],
  [
    'intersection inherited signal member',
    'declare const signal: AbortSignal & { extra: number }; signal.dispatchEvent',
    'name',
    'AbortSignal.dispatchEvent',
  ],
  [
    'union inherited signal member',
    'declare const signal: AbortSignal | EventTarget; signal.dispatchEvent',
    'name',
    'AbortSignal.dispatchEvent',
  ],
  ['structuredClone', 'structuredClone({})', 'name', 'forbidden'],
  ['AsyncLocalStorage', 'new AsyncLocalStorage()', 'name', 'forbidden'],
  ['setImmediate', 'setImmediate(() => {})', 'name', 'forbidden'],
  ['process', 'process.cwd()', 'name', 'forbidden'],
  ['Buffer', 'Buffer.from([])', 'name', 'forbidden'],
  ['static node import', "import value from 'node:fs'", 'name', 'forbidden import'],
  ['node re-export', "export { readFile } from 'node:fs'", 'name', 'forbidden'],
  ['dynamic node import', "import('node:fs')", 'name', 'forbidden module'],
  ['node require', "require('node:fs')", 'name', 'forbidden module'],
  ['Promise.withResolvers', 'Promise.withResolvers()', 'name', 'withResolvers'],
  ['computed Promise static', "Promise['withResolvers']()", 'name', 'withResolvers'],
  ['aliased Promise static', 'const P = Promise; P.withResolvers()', 'name', 'withResolvers'],
  [
    'constant computed static',
    "const key = 'withResolvers'; Promise[key]()",
    'name',
    'withResolvers',
  ],
  [
    'computed destructured static',
    "const { ['withResolvers']: resolve } = Promise",
    'name',
    'withResolvers',
  ],
  [
    'destructured Promise static',
    'const { withResolvers: resolve } = Promise',
    'name',
    'withResolvers',
  ],
  ['computed global', "globalThis['structuredClone']({})", 'name', 'structuredClone'],
  ['global property', 'globalThis.structuredClone({})', 'name', 'structuredClone'],
  [
    'destructured global',
    'const { structuredClone: clone } = globalThis',
    'name',
    'structuredClone',
  ],
  ['AbortSignal.any', 'AbortSignal.any([])', 'name', 'any'],
  ['AbortSignal.timeout', 'AbortSignal.timeout(1)', 'name', 'timeout'],
  ['computed AbortSignal static', "AbortSignal['any']([])", 'name', 'any'],
  ['destructured AbortSignal static', 'const { timeout } = AbortSignal', 'name', 'timeout'],
  ['AbortSignal prototype', 'AbortSignal.prototype.throwIfAborted', 'name', 'throwIfAborted'],
  ['signal method', 'new AbortController().signal.throwIfAborted()', 'name', 'throwIfAborted'],
  [
    'signal onabort',
    'const signal = new AbortController().signal; signal.onabort = () => {}',
    'name',
    'onabort',
  ],
  [
    'computed signal member',
    "new AbortController().signal['onabort'] = () => {}",
    'name',
    'onabort',
  ],
  [
    'destructured signal member',
    'const { onabort } = new AbortController().signal',
    'name',
    'onabort',
  ],
  ['Crypto member', 'crypto.getRandomValues; crypto.constructor', 'name', 'constructor'],
  ['String.isWellFormed', 'String.prototype.isWellFormed', 'name', 'isWellFormed'],
  ['String.toWellFormed', 'String.prototype.toWellFormed', 'name', 'toWellFormed'],
  ['string method', "'x'.isWellFormed()", 'name', 'isWellFormed'],
  ['computed string method', "'x'['toWellFormed']()", 'name', 'toWellFormed'],
  ['destructured string method', "const { isWellFormed } = 'x'", 'name', 'isWellFormed'],
  ['Symbol.dispose', 'Symbol.dispose', 'name', 'dispose'],
  ['Symbol.asyncDispose', 'Symbol.asyncDispose', 'name', 'asyncDispose'],
  ['computed Symbol member', "Symbol['dispose']", 'name', 'dispose'],
  ['using', 'using resource = null', 'name', 'using'],
  ['await using', 'await using resource = null', 'name', 'using'],
  [
    'DOM constructor',
    'new ReadableStreamDefaultController()',
    'name',
    'ReadableStreamDefaultController',
  ],
  ['DOM function', "fetch('https://example.com')", 'name', 'fetch'],
  ['computed DOM global', "globalThis['fetch']('https://example.com')", 'name', 'fetch'],
  ['Float16Array', 'new Float16Array(1)', 'name', 'typeof guard'],
  ['SharedArrayBuffer', 'new SharedArrayBuffer(1)', 'name', 'typeof guard'],
  ['Atomics', 'Atomics.load(new Int32Array(1), 0)', 'name', 'typeof guard'],
  [
    'unsafe optional branch',
    "typeof Float16Array === 'undefined' && new Float16Array(1)",
    'name',
    'typeof guard',
  ],
  [
    'unsafe optional ternary',
    "typeof SharedArrayBuffer !== 'undefined' ? [] : new SharedArrayBuffer(1)",
    'name',
    'typeof guard',
  ],
  ['toSorted', '[1, 2].toSorted()', 'type', 'toSorted'],
  ['findLast', '[1, 2].findLast((value: number) => value === 2)', 'type', 'findLast'],
] as const

const positiveFixtures = [
  ['object rest binding', 'const { ...rest } = new AbortController().signal; void rest'],
  ['object rest assignment', 'let rest; ({ ...rest } = new AbortController().signal)'],
  ['process label', 'process: for (;;) { break process }'],
  ['process continue label', 'process: for (;;) { continue process }'],
  [
    'permitted union signal keys',
    "const key: 'aborted' | 'reason' = Math.random() > 0.5 ? 'aborted' : 'reason'; new AbortController().signal[key]",
  ],
  [
    'permitted assignment union keys',
    "const key: 'aborted' | 'reason' = Math.random() > 0.5 ? 'aborted' : 'reason'; let x; ({ [key]: x } = new AbortController().signal)",
  ],
  ['DOM interface heritage', 'interface Controller extends ReadableStreamDefaultController {}'],
  [
    'DOM class implements',
    'class Controller implements ReadableStreamDefaultController { desiredSize = null; close() {}; enqueue() {}; error() {} }',
  ],
  [
    'DOM heritage type arguments',
    'class Base<T> {}; class Controller extends Base<ReadableStreamDefaultController> {}',
  ],
  [
    'parenthesised optional inspection',
    "typeof ((Float16Array)) !== 'undefined' && new Float16Array(1)",
  ],
  [
    'computed optional inspection',
    "typeof globalThis['Float16Array'] !== 'undefined' && new globalThis['Float16Array'](1)",
  ],
  ['shadowed DOM namespace', 'const CSS = { supports: () => true }; CSS.supports()'],
  ['erased DOM namespace', 'type Wasm = typeof WebAssembly; type CSSNamespace = typeof CSS'],
  [
    'cast local forbidden member',
    'const signal = { throwIfAborted: () => {} }; (signal as any).throwIfAborted()',
  ],
  [
    'cast permitted signal member',
    'const signal = new AbortController().signal; (signal as any).aborted',
  ],
  [
    'local inherited event member',
    'class Target { dispatchEvent() {} }; class Signal extends Target {}; new Signal().dispatchEvent()',
  ],
  [
    'local controller subclass member',
    'class Controller extends AbortController { dispose() {} }; new Controller().dispose()',
  ],
  [
    'local inherited controller subclass member',
    'class Controller extends AbortController { dispatchEvent() {} }; class Client extends Controller {}; new Client().dispatchEvent()',
  ],
  [
    'whitelisted hosts',
    'new WeakMap(); new WeakSet(); queueMicrotask(() => {}); clearTimeout(setTimeout(() => {}, 0)); clearInterval(setInterval(() => {}, 0)); new TextEncoder(); new TextDecoder(); crypto.getRandomValues(new Uint8Array(1)); crypto.subtle.digest("SHA-256", new Uint8Array(1)); crypto.randomUUID(); new ReadableStream(); new WritableStream(); new CountQueuingStrategy({ highWaterMark: 1 })',
  ],
  [
    'abort listener',
    "const f = () => {}; new AbortController().signal.addEventListener('abort', f)",
  ],
  [
    'abort members',
    "const controller = new AbortController(); controller.abort(); const signal = controller.signal; signal.aborted; signal.reason; signal.removeEventListener('abort', () => {})",
  ],
  [
    'DOM type annotation',
    'const controller: ReadableStreamDefaultController | undefined = undefined',
  ],
  ['erased forbidden types', 'type Clone = typeof structuredClone; type Signal = AbortSignal'],
  ['optional presence conjunction', "typeof Float16Array !== 'undefined' && new Float16Array(1)"],
  [
    'optional global presence',
    "typeof globalThis.Float16Array !== 'undefined' && new globalThis.Float16Array(1)",
  ],
  [
    'optional compound if',
    "if (typeof Float16Array !== 'undefined' && Math.random() > 0) { new Float16Array(1) }",
  ],
  [
    'optional compound absence',
    "typeof SharedArrayBuffer === 'undefined' || Math.random() > 0 ? [] : new SharedArrayBuffer(1)",
  ],
  [
    'optional shadowed condition',
    "typeof globalThis.Float16Array !== 'undefined' && (() => { const Float16Array = class {}; return new Float16Array() })()",
  ],
  [
    'optional presence if',
    "if (typeof SharedArrayBuffer !== 'undefined') { new SharedArrayBuffer(1) }",
  ],
  [
    'optional presence ternary',
    "typeof Atomics !== 'undefined' ? Atomics.load(new Int32Array(1), 0) : 0",
  ],
  [
    'optional absence ternary',
    "const constructors = [...(typeof Float16Array === 'undefined' ? [] : [Float16Array])]",
  ],
  [
    'optional absence disjunction',
    "typeof SharedArrayBuffer === 'undefined' || new SharedArrayBuffer(1)",
  ],
  [
    'optional absence else',
    "if (typeof Atomics === 'undefined') {} else { Atomics.load(new Int32Array(1), 0) }",
  ],
  [
    'shadowed structuredClone',
    'const structuredClone = (value: number) => value; structuredClone(1)',
  ],
  [
    'shadowed globals',
    'const process = { cwd: () => "." }; process.cwd(); const Buffer = { from: () => [] }; Buffer.from(); const fetch = () => {}; fetch()',
  ],
  [
    'shadowed statics',
    'const Promise = { withResolvers: () => 1 }; Promise.withResolvers(); const AbortSignal = { any: () => 1 }; AbortSignal.any()',
  ],
  [
    'local members',
    'const value = { isWellFormed: () => true, throwIfAborted: () => {}, onabort: null }; value.isWellFormed(); value.throwIfAborted(); value.onabort',
  ],
  ['ES2022 at', '[1, 2].at(-1)'],
  [
    'shadowed String class',
    'class String { isWellFormed() { return true } }; new String().isWellFormed()',
  ],
  ['shadowed require', "const require = (_name: string) => 1; require('node:fs')"],
] as const

describe('guard fixtures', () => {
  const snippets = new Map(
    [...negativeFixtures, ...positiveFixtures].map(([name, source]) => [
      join(root, 'packages/mls-rpc/test/fixtures', `${name.replaceAll(' ', '-')}.ts`),
      `${source}; export {}`,
    ]),
  )
  let program: ts.Program
  beforeAll(() => {
    program = baselineProgram(join(root, 'packages/mls-rpc/src'), snippets)
  }, 60_000)
  function check(name: string) {
    const path = join(root, 'packages/mls-rpc/test/fixtures', `${name.replaceAll(' ', '-')}.ts`)
    const file = program.getSourceFile(path)
    if (file === undefined) throw new Error(`Missing fixture ${name}`)
    return { name: nameViolations(program, file), type: typeViolations(program, file) }
  }
  test.each(negativeFixtures)(
    'rejects %s',
    (name, _source, layer, message) => {
      expect(check(name)[layer].join('\n')).toContain(message)
    },
    60_000,
  )
  test.each(positiveFixtures)(
    'allows %s',
    (name) => {
      expect(check(name)).toEqual({ name: [], type: [] })
    },
    60_000,
  )
})

describe('runtime-neutral source baseline', () => {
  const programs = new Map<string, ts.Program>()
  function programFor(directory: string): ts.Program {
    let program = programs.get(directory)
    if (program === undefined) {
      program = baselineProgram(directory)
      programs.set(directory, program)
    }
    return program
  }
  test.each(sourceRoots)(
    'type-checks %s against ES2022 and whitelisted hosts',
    (directory) => {
      const program = programFor(directory)
      const failures = sourceFiles(directory).flatMap((path) => {
        const file = program.getSourceFile(path)
        if (file === undefined) throw new Error(`Missing source ${path}`)
        return typeViolations(program, file)
      })
      expect(failures).toEqual([])
    },
    60_000,
  )

  test('ignores comments, strings and identifiers named node', () => {
    expect(
      sourceViolations(
        'snippet.ts',
        "const node = 'node:fs structuredClone process'; // Buffer\n/* setImmediate */",
      ),
    ).toEqual([])
  }, 60_000)

  test('matches static, dynamic and require node module imports', () => {
    expect(
      sourceViolations(
        'snippet.ts',
        "import value from 'node:fs'; import('node:fs'); require('node:fs')",
      ),
    ).toHaveLength(3)
  }, 60_000)

  test('has no Node imports or forbidden global references', () => {
    const failures = sourceRoots.flatMap((directory) => {
      const program = programFor(directory)
      return sourceFiles(directory).flatMap((path) => {
        const file = program.getSourceFile(path)
        if (file === undefined) throw new Error(`Missing source ${path}`)
        return nameViolations(program, file)
      })
    })
    expect(failures).toEqual([])
  }, 60_000)
})
