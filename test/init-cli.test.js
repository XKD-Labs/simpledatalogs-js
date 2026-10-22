// `npx simpledatalogs init` against fixture projects: detection, minimal changes, the diff, the prompt and the test event.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectFramework, planChanges, renderDiff, runInit } from '../cli/init.js'

// The fixture projects, one folder per framework.
const fixturesDir = new URL('./fixtures/init/', import.meta.url).pathname

// The public and secret keys the tests use.
const PUBLIC_KEY = 'sdl_pub_fixture_key'
const SECRET_KEY = 'sdl_sec_fixture_key'

// A fresh copy of a fixture project in a temp folder, removed after the test.
function copyFixture(testContext, fixtureName) {
  const projectDir = mkdtempSync(join(tmpdir(), `sdl-init-${fixtureName}-`))
  cpSync(join(fixturesDir, fixtureName), projectDir, { recursive: true })
  testContext.after(() => rmSync(projectDir, { recursive: true, force: true }))

  return projectDir
}

// Runs the CLI with scripted answers and a fake fetch; returns the exit code, the output and the requests.
async function runScripted(projectDir, cliArguments, { answers = [], status = 202 } = {}) {
  const output = []
  const requests = []

  const exitCode = await runInit(cliArguments, {
    cwd: projectDir,
    env: {},
    print: (text) => output.push(text),
    ask: async () => answers.shift() ?? '',
    fetch: async (url, requestInit) => {
      requests.push({ url, ...requestInit, events: JSON.parse(requestInit.body) })
      return new Response('{}', { status })
    },
  })

  return { exitCode, output: output.join('\n'), requests }
}

// A file in the project, or null.
function readProjectFile(projectDir, filePath) {
  const absolutePath = join(projectDir, filePath)
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null
}

test('every fixture is detected as its framework', () => {
  const expectedFrameworks = {
    nextjs: 'nextjs',
    'vite-react': 'vite-react',
    'vite-vue': 'vite-vue',
    nuxt: 'nuxt',
    sveltekit: 'sveltekit',
    html: 'html',
    express: 'node',
    laravel: 'laravel',
    expo: 'expo',
    unknown: null,
  }

  for (const [fixtureName, expectedFramework] of Object.entries(expectedFrameworks)) {
    assert.equal(detectFramework(join(fixturesDir, fixtureName)), expectedFramework, fixtureName)
  }
})

test('Next.js: the key goes into .env.local beside existing lines, and init into src/instrumentation-client.ts', async (testContext) => {
  const projectDir = copyFixture(testContext, 'nextjs')
  const result = await runScripted(projectDir, ['--key', PUBLIC_KEY, '--yes'])

  assert.equal(result.exitCode, 0)
  assert.equal(readProjectFile(projectDir, '.env.local'), `OTHER=1\nNEXT_PUBLIC_SIMPLEDATALOGS_KEY=${PUBLIC_KEY}\n`)
  assert.match(readProjectFile(projectDir, 'src/instrumentation-client.ts'), /init\(\{ key: process\.env\.NEXT_PUBLIC_SIMPLEDATALOGS_KEY, autocapture: true \}\)/)
  assert.match(result.output, /npm install simpledatalogs/)
})

test('Vite React: two lines after the imports of src/main.jsx, nothing else touched, and yarn is suggested', async (testContext) => {
  const projectDir = copyFixture(testContext, 'vite-react')
  const before = readProjectFile(projectDir, 'src/main.jsx')
  const result = await runScripted(projectDir, ['--key', PUBLIC_KEY, '--yes'])

  const after = readProjectFile(projectDir, 'src/main.jsx')
  const expectedAfter = before.replace("import App from './App.jsx'\n", "import App from './App.jsx'\nimport { init } from 'simpledatalogs'\n\ninit({ key: import.meta.env.VITE_SIMPLEDATALOGS_KEY, autocapture: true })\n")
  assert.equal(after, expectedAfter)
  assert.equal(readProjectFile(projectDir, '.env.local'), `VITE_SIMPLEDATALOGS_KEY=${PUBLIC_KEY}\n`)
  assert.match(result.output, /yarn add simpledatalogs/)

  // A second run changes nothing.
  const secondRun = await runScripted(projectDir, ['--key', PUBLIC_KEY, '--yes', '--no-test'])
  assert.match(secondRun.output, /already set up/)
  assert.equal(readProjectFile(projectDir, 'src/main.jsx'), after)
})

test('Vue, Nuxt, SvelteKit and Expo get their own entry points', async (testContext) => {
  const vueDir = copyFixture(testContext, 'vite-vue')
  await runScripted(vueDir, ['--key', PUBLIC_KEY, '--yes'])
  assert.match(readProjectFile(vueDir, 'src/main.ts'), /^import App from '\.\/App\.vue'\nimport \{ init \} from 'simpledatalogs'\n\ninit\(/m)

  const nuxtDir = copyFixture(testContext, 'nuxt')
  await runScripted(nuxtDir, ['--key', PUBLIC_KEY, '--yes'])
  assert.match(readProjectFile(nuxtDir, 'app/plugins/simpledatalogs.client.js'), new RegExp(`defineNuxtPlugin[\\s\\S]*key: '${PUBLIC_KEY}', autocapture: true`))

  const kitDir = copyFixture(testContext, 'sveltekit')
  await runScripted(kitDir, ['--key', PUBLIC_KEY, '--yes'])
  assert.match(readProjectFile(kitDir, 'src/hooks.client.js'), /\$env\/static\/public[\s\S]*init\(\{ key: PUBLIC_SIMPLEDATALOGS_KEY, autocapture: true \}\)/)
  assert.equal(readProjectFile(kitDir, '.env'), `PUBLIC_SIMPLEDATALOGS_KEY=${PUBLIC_KEY}\n`)

  const expoDir = copyFixture(testContext, 'expo')
  await runScripted(expoDir, ['--key', PUBLIC_KEY, '--yes'])
  assert.match(readProjectFile(expoDir, 'simpledatalogs.ts'), /import \{ AppState \} from 'react-native'[\s\S]*init\(\{ key: process\.env\.EXPO_PUBLIC_SIMPLEDATALOGS_KEY, appState: AppState, autocapture: true \}\)/)
})

test('plain HTML: one script tag before </head>, with the key and autocapture by the tag', async (testContext) => {
  const projectDir = copyFixture(testContext, 'html')
  await runScripted(projectDir, ['--key', PUBLIC_KEY, '--yes'])

  assert.match(readProjectFile(projectDir, 'index.html'), new RegExp(`<title>Shop</title>\\n    <script src="https://cdn\\.jsdelivr\\.net/npm/simpledatalogs@[\\d.]+/dist/simpledatalogs\\.min\\.js" data-key="${PUBLIC_KEY}" defer></script>\\n  </head>`))
})

test('Node and Laravel take a secret key in .env; an existing key line is replaced, not duplicated', async (testContext) => {
  const nodeDir = copyFixture(testContext, 'express')
  const nodeRun = await runScripted(nodeDir, ['--key', SECRET_KEY, '--yes'])
  assert.equal(readProjectFile(nodeDir, '.env'), `PORT=3000\nSIMPLEDATALOGS_KEY=${SECRET_KEY}\n`)
  assert.match(readProjectFile(nodeDir, 'simpledatalogs.mjs'), /autocapture: true/)
  assert.match(nodeRun.output, /--env-file/)

  const laravelDir = copyFixture(testContext, 'laravel')
  const laravelRun = await runScripted(laravelDir, ['--key', SECRET_KEY, '--yes'])
  assert.equal(readProjectFile(laravelDir, '.env'), `APP_NAME=Shop\nSIMPLEDATALOGS_KEY=${SECRET_KEY}\n`)
  assert.match(laravelRun.output, /composer require simpledatalogs\/laravel/)
})

test('the diff is shown and nothing is written without a yes', async (testContext) => {
  const projectDir = copyFixture(testContext, 'vite-react')
  const before = readProjectFile(projectDir, 'src/main.jsx')
  const result = await runScripted(projectDir, [], { answers: [PUBLIC_KEY, 'n'] })

  assert.equal(result.exitCode, 1)
  assert.match(result.output, /\+import \{ init \} from 'simpledatalogs'/)
  assert.match(result.output, /\+\+\+ \.env\.local \(new file\)/)
  assert.match(result.output, /Nothing was written/)
  assert.equal(readProjectFile(projectDir, 'src/main.jsx'), before)
  assert.equal(result.requests.length, 0)
})

test('a test event goes to the endpoint with the key, and the dashboard link is printed', async (testContext) => {
  const projectDir = copyFixture(testContext, 'html')
  const result = await runScripted(projectDir, ['--key', PUBLIC_KEY, '--yes', '--endpoint', 'http://localhost:4001/', '--app-url', 'http://localhost:4000'])

  const [request] = result.requests
  assert.equal(request.url, 'http://localhost:4001/v1/ingest')
  assert.equal(request.headers.Authorization, `Bearer ${PUBLIC_KEY}`)
  assert.equal(request.events[0].event, 'setup_test')
  assert.ok(request.events[0].event_id && request.events[0].ts)
  assert.match(result.output, /Test event sent/)
  assert.match(result.output, /Dashboard: http:\/\/localhost:4000/)

  // A refused key says so.
  const refused = await runScripted(copyFixture(testContext, 'html'), ['--key', PUBLIC_KEY, '--yes'], { status: 401 })
  assert.match(refused.output, /refused \(401\)/)
})

test('--dashboard-url prints the exact environment page; anything but http(s) falls back', async (testContext) => {
  const dashboardUrl = 'https://simpledatalogs.com/environments/01a145f7-a46d-7000-bf35-d1c078cd3a2a'
  const result = await runScripted(copyFixture(testContext, 'html'), ['--key', PUBLIC_KEY, '--yes', '--no-test', '--dashboard-url', dashboardUrl])

  assert.match(result.output, new RegExp(`Dashboard: ${dashboardUrl}$`, 'm'))

  const unsafe = await runScripted(copyFixture(testContext, 'html'), ['--key', PUBLIC_KEY, '--yes', '--no-test', '--dashboard-url=javascript:alert(1)'])
  assert.match(unsafe.output, /Dashboard: https:\/\/simpledatalogs\.com$/m)
})

test('a secret key in browser code, a malformed key and an unknown project are refused', async (testContext) => {
  const browserRun = await runScripted(copyFixture(testContext, 'nextjs'), ['--key', SECRET_KEY, '--yes'])
  assert.equal(browserRun.exitCode, 1)
  assert.match(browserRun.output, /public key/)

  const malformedRun = await runScripted(copyFixture(testContext, 'express'), ['--key', 'hello', '--yes'])
  assert.equal(malformedRun.exitCode, 1)

  const unknownRun = await runScripted(copyFixture(testContext, 'unknown'), ['--key', PUBLIC_KEY, '--yes'])
  assert.equal(unknownRun.exitCode, 1)
  assert.match(unknownRun.output, /--framework/)
})

test('renderDiff keeps context around an edit', () => {
  const plan = planChanges(join(fixturesDir, 'vite-vue'), 'vite-vue', PUBLIC_KEY)
  const entryChange = plan.changes.find((change) => change.path === 'src/main.ts')

  assert.match(renderDiff(entryChange), /^--- src\/main\.ts\n\+\+\+ src\/main\.ts\n import \{ createApp \} from 'vue'\n import App from '\.\/App\.vue'\n\+import/)
})
