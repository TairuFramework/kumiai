// Vitest worker hook: kokuin's default provider resolves to the native one, in tests only.
// Noble's verify takes about 1.8 ms, so the suite spent minutes in it on CI and hit test timeouts.
import { registerHooks } from 'node:module'

const shim = new URL('./vitest-native-crypto-shim.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context)
    // Matches the resolved URL: Vitest rewrites imports in transformed files to absolute paths.
    if (!/\/@kokuin\/crypto\/lib\/index\.js$/.test(resolved.url)) return resolved
    const parent = context.parentURL ?? ''
    // The native provider falls back through crypto-node, which needs the real default.
    const exempt = parent === shim || /@kokuin\/crypto(-napi|-node)?\//.test(parent)
    return exempt ? resolved : { url: shim, shortCircuit: true }
  },
})
