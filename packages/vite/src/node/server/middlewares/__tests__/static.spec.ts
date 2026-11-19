import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ViteDevServer } from '../../index'
import { createServer } from '../../index'
import { isWindows } from '../../../../shared/utils'
import {
  isFileLoadingAllowed,
  isFileServingAllowed,
  looksLikeWindowsShortNamePath,
} from '../static'

// On Windows, `/@fs/` urls are served from the root of the drive of the cwd,
// so the temp dir needs to be on the same drive as the cwd
function getTempBaseDir(): string {
  const tmpDir = os.tmpdir()
  if (
    isWindows &&
    path.parse(tmpDir).root.toLowerCase() !==
      path.parse(process.cwd()).root.toLowerCase()
  ) {
    const baseDir = path.resolve('temp')
    fs.mkdirSync(baseDir, { recursive: true })
    return baseDir
  }
  return tmpDir
}

describe('looksLikeWindowsShortNamePath', () => {
  const shortNamePaths = [
    // classic 8.3 short names
    'C:/PROGRA~1/x',
    'C:/PROGRA~1',
    'C:/LONGFI~1.TXT',
    'C:/MICROS~2/foo',
    // short-name-looking directory ancestor, not just the basename
    'C:/foo/DOCUME~1/bar.js',
  ]
  const legitimateTildePaths = [
    // real-world case from the reported issue: `~` not followed by a digit
    'C:/project/dist/0~rslib-runtime.js',
    // ancestor directory containing a tilde that isn't short-name shaped
    'C:/Users/foo~bar/project/index.js',
    // tilde-prefixed name with no short-name-style prefix/digit suffix
    'C:/Users/foo/~backup/index.js',
    // prefix longer than the 6 characters a short name can have
    'C:/project/confirmations~2/index.js',
    // no tilde at all
    'C:/Users/foo/project/index.js',
  ]

  for (const filePath of shortNamePaths) {
    test(`looksLikeWindowsShortNamePath("${filePath}") is true`, () => {
      expect(looksLikeWindowsShortNamePath(filePath)).toBe(true)
    })
  }
  for (const filePath of legitimateTildePaths) {
    test(`looksLikeWindowsShortNamePath("${filePath}") is false`, () => {
      expect(looksLikeWindowsShortNamePath(filePath)).toBe(false)
    })
  }
})

// mirrors the default `server.fs.deny` matching: the basename for `.env*`,
// any path segment for `.git`
function isDeniedByFsDenyGlob(filePath: string): boolean {
  if (filePath.split('/').includes('.git')) return true
  const basename = path.posix.basename(filePath)
  return basename === '.env' || basename === '.env.local'
}

function createStubServer(allowedDir: string): ViteDevServer {
  const server = {
    config: {
      server: {
        fs: {
          strict: true,
          allow: [allowedDir],
          deny: ['.env', '.env.*', '**/.git/**'],
        },
      },
    },
    _fsDenyGlob: isDeniedByFsDenyGlob,
    moduleGraph: {
      safeModulesPath: new Set<string>(),
    },
  }
  return server as unknown as ViteDevServer
}

describe('isFileServingAllowed', () => {
  const root = isWindows ? 'C:/allowed' : '/allowed'
  const server = createStubServer(root)
  const isAllowed = (p: string) => isFileServingAllowed(p, server)

  test('allows a file inside fs.allow', () => {
    expect(isAllowed(`${root}/src/main.js`)).toBe(true)
  })

  test('denies a file matching fs.deny', () => {
    expect(isAllowed(`${root}/.env`)).toBe(false)
    expect(isAllowed(`${root}/.git/config`)).toBe(false)
  })

  test('denies a file outside of fs.allow', () => {
    const outside = isWindows ? 'C:/other/a.txt' : '/other/a.txt'
    expect(isAllowed(outside)).toBe(false)
  })

  test('allows a file name that merely contains a tilde', () => {
    expect(isAllowed(`${root}/dist/0~rslib-runtime.js`)).toBe(true)
    expect(isAllowed(`${root}/foo~bar/index.js`)).toBe(true)
  })

  // On NTFS, `.env::$DATA` is the default data stream of `.env` and
  // resolves to the same content, while slipping past `server.fs.deny`
  test('denies a path with an NTFS ADS suffix', () => {
    expect(isAllowed(`${root}/.env::$DATA`)).toBe(false)
    expect(isAllowed(`${root}/.env:stream`)).toBe(false)
    expect(isAllowed(`${root}/.git::$INDEX_ALLOCATION/config`)).toBe(false)
  })

  test('denies a /@fs/ url with an NTFS ADS suffix', () => {
    const fsUrl = path.posix.join('/@fs/', root, '.env::$DATA')
    expect(isAllowed(fsUrl)).toBe(false)
  })

  // On Windows, the files can be accessed through the 8.3 short name if
  // the feature is enabled. For example, `.env` can be accessed as `ENV~1`
  test.runIf(isWindows)('denies a path with an 8.3 short name', () => {
    expect(isAllowed(`${root}/ENV~1`)).toBe(false)
    expect(isAllowed(`${root}/env~1`)).toBe(false)
    expect(isAllowed(`${root}/GIT~1/config`)).toBe(false)
  })

  test.runIf(isWindows)('allows a lowercase drive letter', () => {
    const lowercaseServer = createStubServer('c:/allowed')
    const filePath = 'c:/allowed/src/main.js'
    expect(isFileServingAllowed(filePath, lowercaseServer)).toBe(true)
  })
})

describe('isFileLoadingAllowed', () => {
  const root = isWindows ? 'C:/allowed' : '/allowed'
  const server = createStubServer(root)
  const isAllowed = (p: string) => isFileLoadingAllowed(server, p)

  test('allows a file inside fs.allow', () => {
    expect(isAllowed(`${root}/src/main.js`)).toBe(true)
  })

  test('denies a file matching fs.deny', () => {
    expect(isAllowed(`${root}/.env`)).toBe(false)
    expect(isAllowed(`${root}/.git/config`)).toBe(false)
  })

  test('denies a file outside of fs.allow', () => {
    const outside = isWindows ? 'C:/other/a.txt' : '/other/a.txt'
    expect(isAllowed(outside)).toBe(false)
  })

  test('denies a path with an NTFS ADS suffix', () => {
    expect(isAllowed(`${root}/.env::$DATA`)).toBe(false)
    expect(isAllowed(`${root}/.env:stream`)).toBe(false)
    expect(isAllowed(`${root}/.git::$INDEX_ALLOCATION/config`)).toBe(false)
  })

  test.runIf(isWindows)('denies a path with an 8.3 short name', () => {
    expect(isAllowed(`${root}/ENV~1`)).toBe(false)
    expect(isAllowed(`${root}/GIT~1/config`)).toBe(false)
  })
})

describe('static file serving access check', () => {
  let tmpDir: string
  let root: string
  let fsRoot: string
  let server: ViteDevServer | undefined
  let httpServer: http.Server | undefined
  let port: number

  const sendRawRequest = (requestTarget: string) => {
    return new Promise<string>((resolve, reject) => {
      const buf: Buffer[] = []
      const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
        client.write(
          [
            `GET ${encodeURI(requestTarget)} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            'Connection: Close',
            '\r\n',
          ].join('\r\n'),
        )
      })
      client.on('data', (data) => {
        buf.push(data)
      })
      client.on('end', () => {
        resolve(Buffer.concat(buf).toString())
      })
      client.on('error', (err) => {
        reject(err)
      })
    })
  }

  beforeAll(async () => {
    // use the native realpath so that Windows 8.3 short names are expanded
    tmpDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(getTempBaseDir(), 'vite-static-fs-')),
    )
    root = path.join(tmpDir, 'root')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    // inside of `server.fs.allow`
    fs.writeFileSync(path.join(root, 'src/safe.txt'), 'KEY=safe')
    // inside of `server.fs.allow`, but denied by the default `server.fs.deny`
    fs.writeFileSync(path.join(root, 'src/dummy.crt'), 'KEY=unsafe-crt')
    fs.writeFileSync(path.join(root, 'src/.env'), 'KEY=unsafe-dotenv')
    fsRoot = path.posix.join('/@fs/', root.replace(/\\/g, '/'))

    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      cacheDir: path.join(root, 'node_modules/.vite'),
      server: {
        middlewareMode: true,
        watch: null,
        ws: false,
        fs: {
          strict: true,
          allow: [path.join(root, 'src')],
        },
      },
    })
    httpServer = http.createServer(server.middlewares)
    await new Promise<void>((resolve) => {
      httpServer!.listen(0, '127.0.0.1', () => resolve())
    })
    port = (httpServer.address() as AddressInfo).port
  })

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
    }
    await server?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 })
  })

  test('should serve files inside of the allow list', async () => {
    const response = await sendRawRequest('/src/safe.txt')
    expect(response).toContain('HTTP/1.1 200 OK')
    expect(response).toContain('KEY=safe')
  })

  test('should serve files inside of the allow list with /@fs/', async () => {
    const response = await sendRawRequest(`${fsRoot}/src/safe.txt`)
    expect(response).toContain('HTTP/1.1 200 OK')
    expect(response).toContain('KEY=safe')
  })

  test('should deny files matching fs.deny', async () => {
    const response = await sendRawRequest('/src/dummy.crt')
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(response).not.toContain('KEY=unsafe-crt')
  })

  test('should deny files matching fs.deny when a request has /.', async () => {
    const response = await sendRawRequest('/src/dummy.crt/.')
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(response).not.toContain('KEY=unsafe-crt')
  })

  test('should deny files matching fs.deny with /@fs/ when a request has /.', async () => {
    const response = await sendRawRequest(`${fsRoot}/src/dummy.crt/.`)
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(response).not.toContain('KEY=unsafe-crt')
  })

  // On NTFS, `.env::$DATA` is the default data stream of `.env`
  test('should deny files matching fs.deny with an NTFS ADS suffix', async () => {
    const response = await sendRawRequest('/src/.env::$DATA')
    // It is 403 on NTFS, 404 on others
    expect(response).toMatch(/^HTTP\/1\.1 40[34] /)
    expect(response).not.toContain('KEY=unsafe-dotenv')
  })
})
