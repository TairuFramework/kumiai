import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, test } from 'vitest'

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

function isTypePosition(node: ts.Node): boolean {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isTypeNode(parent)) return true
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
          (ts.isFunctionDeclaration(declaration) && ts.isSourceFile(declaration.parent)))
      )
    })
  }
  function unwrap(expression: ts.Expression): ts.Expression {
    return ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression
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
      symbolAt(unwrap(typeOf.expression)) !== symbol
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
      if (ts.isTypeOfExpression(parent) && parent.expression === child) return true
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
  function propertyName(node: ts.Node): string | undefined {
    if (ts.isComputedPropertyName(node)) return propertyName(node.expression)
    if (
      ts.isStringLiteralLike(node) ||
      (ts.isIdentifier(node) &&
        !ts.isElementAccessExpression(node.parent) &&
        !ts.isComputedPropertyName(node.parent))
    )
      return node.text
    const type = checker.getTypeAtLocation(node)
    return type.isStringLiteral() ? type.value : undefined
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
      const allowed = hostMembers.get(ownerName)
      if (allowed !== undefined && !allowed.has(name))
        report(node, `forbidden host member ${ownerName}.${name}`)
    }
    for (const declaration of symbol?.declarations ?? []) {
      if (!isDOMDeclaration(declaration)) continue
      let parent = declaration.parent
      while (parent !== undefined && !ts.isSourceFile(parent)) {
        if (ts.isInterfaceDeclaration(parent) || ts.isVariableDeclaration(parent)) {
          const ownerName = ts.isIdentifier(parent.name) ? parent.name.text : undefined
          const allowed = ownerName === undefined ? undefined : hostMembers.get(ownerName)
          if (allowed !== undefined && !allowed.has(name))
            report(node, `forbidden host member ${ownerName}.${name}`)
          break
        }
        parent = parent.parent
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
    if (ts.isPropertyAccessExpression(node))
      member(
        node,
        checker.getNonNullableType(checker.getTypeAtLocation(node.expression)),
        node.name.text,
        symbolAt(node.name),
      )
    if (ts.isElementAccessExpression(node)) {
      const name = propertyName(node.argumentExpression)
      if (name !== undefined) {
        const type = checker.getNonNullableType(checker.getTypeAtLocation(node.expression))
        member(node, type, name, type.getProperty(name))
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = propertyName(node.propertyName ?? node.name)
      if (name !== undefined) {
        const type = checker.getTypeAtLocation(node.parent)
        member(node, type, name, type.getProperty(name))
      }
    }
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
  const program = baselineProgram(join(root, 'packages/mls-rpc/src'), snippets)
  function check(name: string) {
    const path = join(root, 'packages/mls-rpc/test/fixtures', `${name.replaceAll(' ', '-')}.ts`)
    const file = program.getSourceFile(path)
    if (file === undefined) throw new Error(`Missing fixture ${name}`)
    return { name: nameViolations(program, file), type: typeViolations(program, file) }
  }
  test.each(negativeFixtures)('rejects %s', (name, _source, layer, message) => {
    expect(check(name)[layer].join('\n')).toContain(message)
  })
  test.each(positiveFixtures)('allows %s', (name) => {
    expect(check(name)).toEqual({ name: [], type: [] })
  })
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
  test.each(sourceRoots)('type-checks %s against ES2022 and whitelisted hosts', (directory) => {
    const program = programFor(directory)
    const failures = sourceFiles(directory).flatMap((path) => {
      const file = program.getSourceFile(path)
      if (file === undefined) throw new Error(`Missing source ${path}`)
      return typeViolations(program, file)
    })
    expect(failures).toEqual([])
  })

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
    const failures = sourceRoots.flatMap((directory) => {
      const program = programFor(directory)
      return sourceFiles(directory).flatMap((path) => {
        const file = program.getSourceFile(path)
        if (file === undefined) throw new Error(`Missing source ${path}`)
        return nameViolations(program, file)
      })
    })
    expect(failures).toEqual([])
  }, 30_000)
})
