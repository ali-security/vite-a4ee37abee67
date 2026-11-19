import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createServer, resolveConfig } from '..'
import type { ViteDevServer } from '..'
import { normalizePath } from '../utils'

const root = normalizePath(path.dirname(fileURLToPath(import.meta.url)))

describe('resolveBuildOptions in dev', () => {
  test('build.rollupOptions should not have input in lib', async () => {
    const config = await resolveConfig(
      {
        build: {
          lib: {
            entry: './index.js',
          },
        },
      },
      'serve',
    )

    expect(config.build.rollupOptions).not.toHaveProperty('input')
  })
})

describe('the dev server', () => {
  let server: ViteDevServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  test('does not mark unresolved SSR imports as safe', async () => {
    const entry = path.posix.join(root, 'unresolved-entry.js')
    const unresolvedImport = '/safe-module-path-unresolved'

    server = await createServer({
      configFile: false,
      root,
      logLevel: 'error',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        middlewareMode: true,
        ws: false,
        preTransformRequests: false,
      },
      plugins: [
        {
          name: 'unresolved-ssr-import',
          resolveId(id) {
            if (id === '/unresolved-entry.js') return entry
          },
          load(id) {
            if (id === entry)
              return `import ${JSON.stringify(unresolvedImport)}`
          },
        },
      ],
    })

    await server.transformRequest('/unresolved-entry.js', { ssr: true })

    const safeModulesPath = [...server.moduleGraph.safeModulesPath]
    expect(safeModulesPath).not.toContain(unresolvedImport)
  })

  test('keeps root-relative module URLs separate from absolute filesystem paths', async () => {
    const entry = path.posix.join(root, 'safe-module-path-entry.js')
    // a real file outside of the root
    const target = normalizePath(
      path.resolve(root, '../plugins/importAnalysis.ts'),
    )
    // a module inside the root whose root-relative URL equals the target path
    const targetUrl = target.replace(/^[A-Z]:/i, '')
    const decoyId = path.posix.join(root, targetUrl)

    server = await createServer({
      configFile: false,
      root,
      logLevel: 'error',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        middlewareMode: true,
        ws: false,
        preTransformRequests: false,
      },
      plugins: [
        {
          name: 'safe-module-path-confusion',
          enforce: 'pre',
          resolveId(id) {
            if (id === '/safe-module-path-entry.js') return entry
            if (id === 'virtual:safe-module-path-confusion') return decoyId
          },
          load(id) {
            if (id === entry)
              return `import 'virtual:safe-module-path-confusion'`
            if (id === decoyId) return 'export {}'
          },
        },
      ],
    })

    await server.transformRequest('/safe-module-path-entry.js')

    const safeModulesPath = [...server.moduleGraph.safeModulesPath]
    expect(safeModulesPath).not.toContain(targetUrl)
    expect(safeModulesPath).not.toContain(target)
    expect(safeModulesPath).toContain(decoyId)
  })
})
