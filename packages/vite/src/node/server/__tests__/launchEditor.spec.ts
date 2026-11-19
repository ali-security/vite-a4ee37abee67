import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { isWindows } from '../../../shared/utils'

// The `/__open-in-editor` endpoint is served by `launch-editor-middleware`,
// which passes the requested `file` to `launch-editor`. Load the very same
// CommonJS module instances the dev server uses.
const _require = createRequire(import.meta.url)
const launchEditorMiddlewarePath = _require.resolve('launch-editor-middleware')
const launchEditorPath = _require.resolve('launch-editor', {
  paths: [path.dirname(launchEditorMiddlewarePath)],
})

type OnErrorCallback = (fileName: string, errorMessage: string | null) => void

const launchEditor: (
  file: string,
  specifiedEditor?: string,
  onErrorCallback?: OnErrorCallback,
) => void = _require(launchEditorPath)
const launchEditorMiddleware: () => (
  req: { url: string },
  res: { statusCode?: number; end: (msg?: string) => void },
) => void = _require(launchEditorMiddlewarePath)

// launch-editor reads these through the shared builtin module objects
const childProcess: typeof import('node:child_process') =
  _require('node:child_process')
const fs: typeof import('node:fs') = _require('node:fs')
const nodeOs: typeof import('node:os') = _require('node:os')

const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
)!
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    ...platformDescriptor,
    value: platform,
  })
}

/**
 * Returns the cmd.exe metacharacters of `command` that are not escaped
 * with `^`, i.e. the ones cmd.exe would interpret as command separators
 * or redirections.
 */
function unescapedCmdMetaChars(command: string): string[] {
  const found: string[] = []
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '^') {
      i++
    } else if ('&|<>'.includes(command[i])) {
      found.push(command[i])
    }
  }
  return found
}

function createFakeChildProcess() {
  return Object.assign(new EventEmitter(), { kill: vi.fn() })
}

describe('launch-editor command injection on Windows', () => {
  let execSpy: MockInstance
  let spawnSpy: MockInstance

  beforeEach(() => {
    execSpy = vi
      .spyOn(childProcess, 'exec')
      .mockImplementation((() => createFakeChildProcess()) as any)
    spawnSpy = vi
      .spyOn(childProcess, 'spawn')
      .mockImplementation((() => createFakeChildProcess()) as any)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    execSpy.mockRestore()
    spawnSpy.mockRestore()
  })

  // pretend that the (attacker-placed) file exists
  function launch(file: string, onErrorCallback?: OnErrorCallback) {
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      launchEditor(file, 'code', onErrorCallback)
    } finally {
      existsSyncSpy.mockRestore()
      logSpy.mockRestore()
    }
  }

  const injectionCases: [file: string, command: string][] = [
    [
      'C:\\Users\\me\\Downloads\\a& calc.exe &.js',
      'code ^"C:\\Users\\me\\Downloads\\a^& calc.exe ^&.js^"',
    ],
    [
      'C:\\Users\\me\\Downloads\\a&calc.exe.js:12:3',
      'code -r -g ^"C:\\Users\\me\\Downloads\\a^&calc.exe.js:12:3^"',
    ],
    [
      'C:\\project\\x|whoami>out.txt.js',
      'code ^"C:\\project\\x^|whoami^>out.txt.js^"',
    ],
    ['C:\\project\\x<in.txt.js', 'code ^"C:\\project\\x^<in.txt.js^"'],
    ['C:\\project\\a^b.js', 'code ^"C:\\project\\a^^b.js^"'],
    ['C:\\project\\a,b;c=d.js', 'code ^"C:\\project\\a^,b^;c^=d.js^"'],
  ]

  test.each(injectionCases)(
    'escapes cmd.exe metacharacters in %s',
    (file, command) => {
      setPlatform('win32')
      launch(file)
      expect(spawnSpy).not.toHaveBeenCalled()
      expect(execSpy).toHaveBeenCalledTimes(1)
      const launchCommand = execSpy.mock.calls[0][0]
      expect(launchCommand).toBe(command)
      expect(unescapedCmdMetaChars(launchCommand)).toEqual([])
    },
  )

  const safeCases: [file: string, command: string][] = [
    ['C:\\project\\src\\main.ts', 'code C:\\project\\src\\main.ts'],
    ['C:\\My Project\\src\\main.ts', 'code "C:\\My Project\\src\\main.ts"'],
    [
      'C:\\app\\routes\\(group)\\[slug]\\+page@$id.svelte',
      'code C:\\app\\routes\\(group)\\[slug]\\+page@$id.svelte',
    ],
  ]

  test.each(safeCases)('opens %s on Windows', (file, command) => {
    setPlatform('win32')
    launch(file)
    expect(spawnSpy).not.toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(execSpy.mock.calls[0][0]).toBe(command)
  })

  const rejectedFiles = [
    'C:\\Users\\me\\Downloads\\%COMSPEC%.js',
    'C:\\Users\\me\\Downloads\\%PATH:~0,1%.js',
    'C:\\Users\\me\\Downloads\\a.js\r\ncalc.exe',
    'C:\\Users\\me\\Downloads\\a.js\ncalc.exe',
    'C:\\Users\\me\\Downloads\\a.js\rcalc.exe',
  ]

  test.each(rejectedFiles)('rejects %j on Windows', (file) => {
    setPlatform('win32')
    const onError = vi.fn()
    launch(file, onError)
    expect(execSpy).not.toHaveBeenCalled()
    expect(spawnSpy).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(
      file,
      expect.stringContaining('not supported on Windows'),
    )
  })

  test('does not change how the editor is spawned on other platforms', () => {
    setPlatform('linux')
    launch('/home/me/project/a&b%PATH%.js')
    expect(execSpy).not.toHaveBeenCalled()
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(spawnSpy).toHaveBeenCalledWith(
      'code',
      ['/home/me/project/a&b%PATH%.js'],
      { stdio: 'inherit' },
    )
  })

  describe('/__open-in-editor middleware', () => {
    let tmpDir: string
    let maliciousFile: string

    beforeEach(() => {
      tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'vite-launch-editor-')),
      )
      // a file name an attacker could get downloaded to a predictable path
      maliciousFile = path.join(tmpDir, 'poc&calc.exe&.js')
      fs.writeFileSync(maliciousFile, '')
      vi.stubEnv('LAUNCH_EDITOR', 'code')
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 })
    })

    function request(file: string) {
      const end = vi.fn()
      const res: { statusCode?: number; end: typeof end } = { end }
      launchEditorMiddleware()(
        { url: `/?file=${encodeURIComponent(file)}` },
        res,
      )
      expect(res.statusCode).toBeUndefined()
      expect(end).toHaveBeenCalledTimes(1)
    }

    test.each(['', ':10:5'])(
      'does not let the file name inject commands (suffix: %j)',
      (suffix) => {
        setPlatform('win32')
        request(maliciousFile + suffix)
        expect(spawnSpy).not.toHaveBeenCalled()
        expect(execSpy).toHaveBeenCalledTimes(1)
        const launchCommand: string = execSpy.mock.calls[0][0]
        expect(launchCommand.startsWith('code ')).toBe(true)
        expect(launchCommand).toContain(`poc^&calc.exe^&.js${suffix}^"`)
        expect(unescapedCmdMetaChars(launchCommand)).toEqual([])
      },
    )
  })
})

describe('launch-editor argument injection', () => {
  let execSpy: MockInstance
  let spawnSpy: MockInstance

  beforeEach(() => {
    execSpy = vi
      .spyOn(childProcess, 'exec')
      .mockImplementation((() => createFakeChildProcess()) as any)
    spawnSpy = vi
      .spyOn(childProcess, 'spawn')
      .mockImplementation((() => createFakeChildProcess()) as any)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    execSpy.mockRestore()
    spawnSpy.mockRestore()
  })

  // pretend that the (attacker-placed) file exists
  function withExistingFile(fn: () => void) {
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      fn()
    } finally {
      existsSyncSpy.mockRestore()
      logSpy.mockRestore()
    }
  }

  function launch(file: string, editor: string) {
    withExistingFile(() => launchEditor(file, editor))
  }

  function spawnedArgs(editor: string): unknown[] {
    expect(execSpy).not.toHaveBeenCalled()
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(spawnSpy.mock.calls[0][0]).toBe(editor)
    return spawnSpy.mock.calls[0][1]
  }

  test('resolves a relative file name to an absolute path', () => {
    setPlatform('linux')
    launch('file.js', 'vim')
    expect(spawnedArgs('vim')).toEqual([path.posix.resolve('file.js')])
  })

  test('resolves a relative file name with a position', () => {
    setPlatform('linux')
    launch('file.js:10:5', 'code')
    expect(spawnedArgs('code')).toEqual([
      '-r',
      '-g',
      `${path.posix.resolve('file.js')}:10:5`,
    ])
  })

  const optionLikeCases: [editor: string, file: string][] = [
    ['vim', '+call writefile(["marker"], "LAUNCH_EDITOR_MARKER")|qa!'],
    ['mvim', '-ccall writefile(["marker"], "LAUNCH_EDITOR_MARKER")|qa!'],
    ['gvim', '+call writefile(["marker"], "LAUNCH_EDITOR_MARKER")|qa!'],
    ['emacs', '--eval=(write-region "marker" nil "LAUNCH_EDITOR_MARKER")'],
    ['emacsclient', '-eatouch LAUNCH_EDITOR_MARKER'],
    ['notepad++', '-pluginMessage=LAUNCH_EDITOR_MARKER'],
  ]

  describe.each(['', ':10:5'])('with position %j', (position) => {
    test.each(optionLikeCases)(
      '%s does not parse %j as an option',
      (editor, file) => {
        setPlatform('linux')
        launch(file + position, editor)
        const args = spawnedArgs(editor)
        const fileArg = String(args[args.length - 1])
        expect(fileArg).toBe(path.posix.resolve(file))
        expect(fileArg).not.toMatch(/^[-+]/)
        expect(args).not.toContain(file)
      },
    )
  })

  test.each(['', ':10:5'])('notepad++ on Windows %j', (position) => {
    setPlatform('win32')
    const file = '-pluginMessage=LAUNCH_EDITOR_MARKER'
    launch(file + position, 'notepad++')
    expect(spawnSpy).not.toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalledTimes(1)
    const escapedFile = path.win32.resolve(file).replace(/[&|<>,;=^]/g, '^$&')
    expect(execSpy.mock.calls[0][0]).toBe(
      position
        ? `notepad++ -n10 -c5 ^"${escapedFile}^"`
        : `notepad++ ^"${escapedFile}^"`,
    )
  })

  // path.relative() is win32-flavored on a Windows host
  describe.skipIf(isWindows)('on WSL', () => {
    let releaseSpy: MockInstance
    let cwdSpy: MockInstance

    beforeEach(() => {
      setPlatform('linux')
      releaseSpy = vi
        .spyOn(nodeOs, 'release')
        .mockReturnValue('4.4.0-43-Microsoft')
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/mnt/c/project')
    })

    afterEach(() => {
      releaseSpy.mockRestore()
      cwdSpy.mockRestore()
    })

    test('uses a ./-prefixed path for files on a Windows drive', () => {
      cwdSpy.mockReturnValue('/home/user/project')
      launch('/mnt/c/project/file.js', 'vim')
      expect(spawnedArgs('vim')).toEqual(['./../../../mnt/c/project/file.js'])
    })

    test('resolves a relative path before converting it', () => {
      launch('file.js', 'vim')
      expect(spawnedArgs('vim')).toEqual(['./file.js'])
    })

    test.each(['', ':10:5'])(
      'prefixes an option-like file name %j',
      (position) => {
        const file = '+call system("touch LAUNCH_EDITOR_MARKER")'
        launch(file + position, 'vim')
        const args = spawnedArgs('vim')
        expect(args[args.length - 1]).toBe(`./${file}`)
        expect(args).not.toContain(file)
      },
    )

    test('middleware does not pass an option-like file name', () => {
      const file = '+call system("touch LAUNCH_EDITOR_MARKER")'
      const end = vi.fn()
      vi.stubEnv('LAUNCH_EDITOR', 'vim')
      try {
        withExistingFile(() => {
          launchEditorMiddleware()(
            { url: `/?file=${encodeURIComponent(file)}` },
            { end },
          )
        })
      } finally {
        vi.unstubAllEnvs()
      }
      expect(end).toHaveBeenCalledTimes(1)
      expect(spawnedArgs('vim')).toEqual([`./${file}`])
    })
  })
})
