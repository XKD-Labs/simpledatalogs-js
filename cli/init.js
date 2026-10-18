/** `npx simpledatalogs init`: detects the framework, writes the snippet and key with minimal changes after showing a diff, and sends a test event. */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** The production ingest host and app, overridable with --endpoint and --app-url (or the exact page with --dashboard-url). */
export const DEFAULT_ENDPOINT = 'https://edge.simpledatalogs.com'
export const DEFAULT_APP_URL = 'https://simpledatalogs.com'

// Each framework's display name, whether it runs in a browser (public keys only), and how the package is installed.
const FRAMEWORKS = {
  nextjs: { name: 'Next.js', isBrowser: true, install: 'npm' },
  nuxt: { name: 'Nuxt', isBrowser: true, install: 'npm' },
  sveltekit: { name: 'SvelteKit', isBrowser: true, install: 'npm' },
  'vite-react': { name: 'React (Vite)', isBrowser: true, install: 'npm' },
  'vite-vue': { name: 'Vue (Vite)', isBrowser: true, install: 'npm' },
  expo: { name: 'React Native / Expo', isBrowser: true, install: 'npm' },
  html: { name: 'Plain HTML', isBrowser: true, install: 'none' },
  node: { name: 'Node', isBrowser: false, install: 'npm' },
  laravel: { name: 'Laravel', isBrowser: false, install: 'composer' },
}

// The script tag URL, pinned to this package's version.
const SCRIPT_TAG_VERSION = '0.3.1'

/** Detects the framework of the project in `projectDir`, or null when none is recognized. */
export function detectFramework(projectDir) {
  // Laravel apps also have a package.json (for Vite), so composer.json goes first.
  const composerJson = readJson(join(projectDir, 'composer.json'))
  if (composerJson?.require?.['laravel/framework']) return 'laravel'

  const packageJson = readJson(join(projectDir, 'package.json'))

  if (packageJson) {
    const dependencyNames = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})])

    if (dependencyNames.has('next')) return 'nextjs'
    if (dependencyNames.has('nuxt')) return 'nuxt'
    if (dependencyNames.has('@sveltejs/kit')) return 'sveltekit'
    if (dependencyNames.has('expo') || dependencyNames.has('react-native')) return 'expo'
    if (dependencyNames.has('vite') && dependencyNames.has('react')) return 'vite-react'
    if (dependencyNames.has('vite') && dependencyNames.has('vue')) return 'vite-vue'

    // A package.json with none of the browser frameworks is a Node app, unless it is only a static page's tooling.
    if (!existsSync(join(projectDir, 'index.html'))) return 'node'
  }

  return existsSync(join(projectDir, 'index.html')) ? 'html' : null
}

/** The changes for a framework: files to create or edit (each with before and after text), plus steps to print. */
export function planChanges(projectDir, framework, ingestKey) {
  const planners = {
    nextjs: planNextJs,
    nuxt: planNuxt,
    sveltekit: planSvelteKit,
    'vite-react': planVite,
    'vite-vue': planVite,
    expo: planExpo,
    html: planHtml,
    node: planNode,
    laravel: planLaravel,
  }

  const plan = { changes: [], notes: [] }
  planners[framework](projectDir, ingestKey, plan)

  // Drop changes that would leave a file as it is.
  plan.changes = plan.changes.filter((change) => change.before !== change.after)
  return plan
}

// Next.js: the key in .env.local and instrumentation-client, which runs in the browser before the app (Next 15.3+).
function planNextJs(projectDir, ingestKey, plan) {
  addEnvChange(projectDir, '.env.local', 'NEXT_PUBLIC_SIMPLEDATALOGS_KEY', ingestKey, plan)

  const baseDir = existsSync(join(projectDir, 'src')) ? 'src' : '.'
  const extension = existsSync(join(projectDir, 'tsconfig.json')) ? 'ts' : 'js'
  const snippet = `import { init } from 'simpledatalogs'\n\ninit({ key: process.env.NEXT_PUBLIC_SIMPLEDATALOGS_KEY, autocapture: true })\n`

  addModuleInit(projectDir, join(baseDir, `instrumentation-client.${extension}`), snippet, `init({ key: process.env.NEXT_PUBLIC_SIMPLEDATALOGS_KEY, autocapture: true })`, plan)
  plan.notes.push('instrumentation-client needs Next.js 15.3 or later; on older versions, call init() in a client component in your root layout.')
}

// Nuxt: a client-only plugin; the public key is inlined, since Nuxt only exposes env vars declared in nuxt.config.
function planNuxt(projectDir, ingestKey, plan) {
  const pluginsDir = existsSync(join(projectDir, 'app', 'app.vue')) ? join('app', 'plugins') : 'plugins'
  const extension = existsSync(join(projectDir, 'tsconfig.json')) ? 'ts' : 'js'
  const snippet = `import { init } from 'simpledatalogs'\n\nexport default defineNuxtPlugin(() => {\n  init({ key: '${ingestKey}', autocapture: true })\n})\n`

  addNewFile(projectDir, join(pluginsDir, `simpledatalogs.client.${extension}`), snippet, plan)
}

// SvelteKit: the key as a public env var and init in hooks.client, which runs once in the browser.
function planSvelteKit(projectDir, ingestKey, plan) {
  addEnvChange(projectDir, '.env', 'PUBLIC_SIMPLEDATALOGS_KEY', ingestKey, plan)

  const extension = existsSync(join(projectDir, 'tsconfig.json')) ? 'ts' : 'js'
  const importLines = [`import { init } from 'simpledatalogs'`, `import { PUBLIC_SIMPLEDATALOGS_KEY } from '$env/static/public'`]
  const initLine = 'init({ key: PUBLIC_SIMPLEDATALOGS_KEY, autocapture: true })'

  addModuleInit(projectDir, join('src', `hooks.client.${extension}`), `${importLines.join('\n')}\n\n${initLine}\n`, initLine, plan, importLines)
}

// React or Vue on Vite: the key as a VITE_ env var and two lines in the entry file.
function planVite(projectDir, ingestKey, plan) {
  addEnvChange(projectDir, '.env.local', 'VITE_SIMPLEDATALOGS_KEY', ingestKey, plan)

  const entryPath = ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js'].find((candidate) => existsSync(join(projectDir, candidate)))
  const initLine = 'init({ key: import.meta.env.VITE_SIMPLEDATALOGS_KEY, autocapture: true })'

  if (!entryPath) {
    plan.notes.push(`No src/main.* entry found; add to your entry file:\n  import { init } from 'simpledatalogs'\n  ${initLine}`)
    return
  }

  addModuleInit(projectDir, entryPath, null, initLine, plan)
}

// React Native / Expo: an EXPO_PUBLIC_ env var and a module exporting the client; there are no page views, so no autocapture.
function planExpo(projectDir, ingestKey, plan) {
  addEnvChange(projectDir, '.env', 'EXPO_PUBLIC_SIMPLEDATALOGS_KEY', ingestKey, plan)

  const extension = existsSync(join(projectDir, 'tsconfig.json')) ? 'ts' : 'js'
  const snippet = `import { init } from 'simpledatalogs'\n\n// Import this module once at startup, then sdl.track('signup') anywhere.\nexport const sdl = init({ key: process.env.EXPO_PUBLIC_SIMPLEDATALOGS_KEY })\n`

  addNewFile(projectDir, `simpledatalogs.${extension}`, snippet, plan)
  plan.notes.push(`Import ./simpledatalogs once in your root layout or App.${extension === 'ts' ? 'tsx' : 'js'}. React Native has no page views; track screens with sdl.track('screen_view', { screen }).`)
}

// Plain HTML: one script tag in the head of index.html.
function planHtml(projectDir, ingestKey, plan) {
  const scriptTag = `<script src="https://cdn.jsdelivr.net/npm/simpledatalogs@${SCRIPT_TAG_VERSION}/dist/simpledatalogs.min.js" data-key="${ingestKey}" defer></script>`
  const pagePath = 'index.html'
  const before = readFileSync(join(projectDir, pagePath), 'utf8')

  if (before.includes('simpledatalogs')) return

  // Before </head>, or before </body> when the page has no head.
  const closingTagMatch = before.match(/^([ \t]*)<\/head>/im) ?? before.match(/^([ \t]*)<\/body>/im)
  const after = closingTagMatch
    ? `${before.slice(0, closingTagMatch.index)}${closingTagMatch[1]}  ${scriptTag}\n${before.slice(closingTagMatch.index)}`
    : `${scriptTag}\n${before}`

  plan.changes.push({ path: pagePath, before, after })
}

// Node: the key in .env and a module exporting the client, with crash capture on.
function planNode(projectDir, ingestKey, plan) {
  addEnvChange(projectDir, '.env', 'SIMPLEDATALOGS_KEY', ingestKey, plan)

  // The package is ESM; a CommonJS project gets an .mjs module.
  const isModuleProject = readJson(join(projectDir, 'package.json'))?.type === 'module'
  const modulePath = isModuleProject ? 'simpledatalogs.js' : 'simpledatalogs.mjs'
  const snippet = `import { init } from 'simpledatalogs'\n\n// Also logs uncaught exceptions; call \`await sdl.shutdown()\` before the process exits.\nexport const sdl = init({ key: process.env.SIMPLEDATALOGS_KEY, autocapture: true })\n`

  addNewFile(projectDir, modulePath, snippet, plan)
  plan.notes.push(`Import ./${modulePath} at the top of your entry file, and load .env (node --env-file=.env, or dotenv).`)
}

// Laravel: the key in .env; the package itself comes from Composer.
function planLaravel(projectDir, ingestKey, plan) {
  addEnvChange(projectDir, '.env', 'SIMPLEDATALOGS_KEY', ingestKey, plan)
  plan.notes.push("Then SimpleDataLogs::track('signup') anywhere; add the TracksModelEvents trait to models, and SIMPLEDATALOGS_TRACK_AUTH=true for sign-ins.")
}

// Sets one variable in an env file: replaces its line, or appends it.
function addEnvChange(projectDir, envPath, variableName, value, plan) {
  const before = readText(join(projectDir, envPath))
  const variableLine = `${variableName}=${value}`
  const linePattern = new RegExp(`^${variableName}=.*$`, 'm')

  let after
  if (before === null) after = `${variableLine}\n`
  else if (linePattern.test(before)) after = before.replace(linePattern, variableLine)
  else after = `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}${variableLine}\n`

  plan.changes.push({ path: envPath, before, after })
}

// A new file with the snippet; an existing one is left alone, with a note.
function addNewFile(projectDir, filePath, snippet, plan) {
  const before = readText(join(projectDir, filePath))

  if (before === null) {
    plan.changes.push({ path: filePath, before: null, after: snippet })
    return
  }

  if (!before.includes('simpledatalogs')) plan.notes.push(`${filePath} already exists; add this to it:\n${indent(snippet)}`)
}

// Creates the file with the snippet, or adds the import and the init line after an existing file's imports.
function addModuleInit(projectDir, filePath, snippet, initLine, plan, importLines = [`import { init } from 'simpledatalogs'`]) {
  const before = readText(join(projectDir, filePath))

  if (before === null) {
    if (snippet !== null) plan.changes.push({ path: filePath, before: null, after: snippet })
    return
  }

  if (before.includes('simpledatalogs')) return

  // The imports go after the last import statement, and the init line after them.
  const lines = before.split('\n')
  const lastImportIndex = lines.reduce((lastIndex, line, lineIndex) => (/^import\s/.test(line) || /^\s*}\s*from\s/.test(line) ? lineIndex : lastIndex), -1)
  const insertedLines = [...importLines, '', initLine]

  lines.splice(lastImportIndex + 1, 0, ...(lastImportIndex === -1 ? [...insertedLines, ''] : insertedLines))
  plan.changes.push({ path: filePath, before, after: lines.join('\n') })
}

/** A readable diff of one change: every line of a new file, or the changed lines of an edit with two lines of context. */
export function renderDiff(change) {
  const header = change.before === null ? `+++ ${change.path} (new file)` : `--- ${change.path}\n+++ ${change.path}`
  const diffLines = diffByLines(change.before === null ? [] : change.before.split('\n'), change.after.split('\n'))

  // Keep the changed lines and two lines around each.
  const keptIndexes = new Set()
  diffLines.forEach((diffLine, lineIndex) => {
    if (diffLine.kind === ' ') return
    for (let nearIndex = lineIndex - 2; nearIndex <= lineIndex + 2; nearIndex++) keptIndexes.add(nearIndex)
  })

  const bodyLines = []
  diffLines.forEach((diffLine, lineIndex) => {
    if (!keptIndexes.has(lineIndex)) return
    if (bodyLines.length > 0 && !keptIndexes.has(lineIndex - 1)) bodyLines.push('@@')
    bodyLines.push(`${diffLine.kind}${diffLine.text}`)
  })

  return `${header}\n${bodyLines.join('\n')}`
}

// A line diff by longest common subsequence; the files here are small.
function diffByLines(beforeLines, afterLines) {
  const commonLengths = Array.from({ length: beforeLines.length + 1 }, () => new Array(afterLines.length + 1).fill(0))

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex--) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex--) {
      commonLengths[beforeIndex][afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? commonLengths[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(commonLengths[beforeIndex + 1][afterIndex], commonLengths[beforeIndex][afterIndex + 1])
    }
  }

  // Walk the table: equal lines are context, the rest removals and additions.
  const diffLines = []
  let beforeIndex = 0
  let afterIndex = 0

  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (beforeIndex < beforeLines.length && afterIndex < afterLines.length && beforeLines[beforeIndex] === afterLines[afterIndex]) {
      diffLines.push({ kind: ' ', text: beforeLines[beforeIndex] })
      beforeIndex++
      afterIndex++
    } else if (afterIndex < afterLines.length && (beforeIndex >= beforeLines.length || commonLengths[beforeIndex][afterIndex + 1] >= commonLengths[beforeIndex + 1][afterIndex])) {
      diffLines.push({ kind: '+', text: afterLines[afterIndex] })
      afterIndex++
    } else {
      diffLines.push({ kind: '-', text: beforeLines[beforeIndex] })
      beforeIndex++
    }
  }

  return diffLines
}

/** Writes every change, creating folders as needed. */
export function applyChanges(projectDir, changes) {
  for (const change of changes) {
    const absolutePath = join(projectDir, change.path)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, change.after)
  }
}

/** Sends one `setup_test` event; returns the HTTP status, or null when the request failed. */
export async function sendTestEvent({ endpoint, ingestKey, framework, fetchFunction = globalThis.fetch }) {
  const testEvent = { event: 'setup_test', event_id: randomUUID(), ts: new Date().toISOString(), props: { framework, source: 'simpledatalogs init' } }

  try {
    const response = await fetchFunction(`${endpoint.replace(/\/+$/, '')}/v1/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ingestKey}`, 'Content-Type': 'application/json', 'User-Agent': 'simpledatalogs-cli/0.3.1' },
      body: JSON.stringify([testEvent]),
      signal: AbortSignal.timeout(10_000),
    })

    return response.status
  } catch {
    return null
  }
}

/** Runs the whole flow; `io` carries the prompt, the output and fetch, so tests can drive it. Returns the exit code. */
export async function runInit(cliArguments, io) {
  const options = parseArguments(cliArguments)
  const projectDir = options.dir ?? io.cwd
  const print = io.print

  // 1. Detect the framework.
  const framework = options.framework ?? detectFramework(projectDir)

  if (framework === null || !FRAMEWORKS[framework]) {
    print('Could not tell which framework this is. Run it in your project folder, or pass --framework (nextjs, nuxt, sveltekit, vite-react, vite-vue, expo, html, node, laravel).')
    return 1
  }

  const frameworkInfo = FRAMEWORKS[framework]
  print(`Detected ${frameworkInfo.name}.`)

  // 2. Read or ask for the key; browser code may only ship a public key.
  const ingestKey = (options.key ?? io.env.SIMPLEDATALOGS_KEY ?? (await io.ask(frameworkInfo.isBrowser ? 'Public ingest key (sdl_pub_…): ' : 'Ingest key (sdl_sec_… for servers): '))).trim()

  if (!/^sdl_(pub|sec)_\S+$/.test(ingestKey)) {
    print('That does not look like an ingest key (sdl_pub_… or sdl_sec_…). Copy one from your environment\'s Keys page.')
    return 1
  }

  if (frameworkInfo.isBrowser && ingestKey.startsWith('sdl_sec_')) {
    print('A secret key would ship to every visitor. Use a public key (sdl_pub_…) here.')
    return 1
  }

  // 3. Plan, show the diff, and ask before writing.
  const plan = planChanges(projectDir, framework, ingestKey)

  if (plan.changes.length === 0) {
    print('Nothing to change: simpledatalogs is already set up here.')
  } else {
    print('')
    plan.changes.forEach((change) => print(`${renderDiff(change)}\n`))

    const shouldWrite = options.yes || /^y(es)?$/i.test((await io.ask('Write these changes? [y/N] ')).trim())

    if (!shouldWrite) {
      print('Nothing was written.')
      return 1
    }

    applyChanges(projectDir, plan.changes)
    print(`Wrote ${plan.changes.map((change) => change.path).join(', ')}.`)
  }

  // 4. What is left to do by hand.
  if (frameworkInfo.install === 'npm') print(`\nInstall the package: ${installCommand(projectDir)}`)
  if (frameworkInfo.install === 'composer') print('\nInstall the package: composer require simpledatalogs/laravel')
  plan.notes.forEach((note) => print(`- ${note}`))

  // 5. A test event, so the dashboard shows something now.
  if (!options.noTest) {
    const status = await sendTestEvent({ endpoint: options.endpoint ?? DEFAULT_ENDPOINT, ingestKey, framework, fetchFunction: io.fetch })

    if (status === 202) print('\nTest event sent: look for "setup_test" in your environment.')
    else if (status === 401) print('\nThe key was refused (401). A brand-new key can take a few seconds to work; check it and run again.')
    else print(`\nThe test event did not go through (${status ?? 'network error'}); your setup is written, try again later.`)
  }

  // The exact environment page when the app filled it in, else the app's home.
  print(`Dashboard: ${dashboardLink(options)}`)
  return 0
}

// Reads --key, --endpoint, --app-url, --dashboard-url, --framework, --dir, --yes and --no-test.
function parseArguments(cliArguments) {
  const options = {}

  for (let argumentIndex = 0; argumentIndex < cliArguments.length; argumentIndex++) {
    const argumentText = cliArguments[argumentIndex]
    const [flagName, inlineValue] = argumentText.split(/=(.*)/s)
    const takeValue = () => inlineValue ?? cliArguments[++argumentIndex]

    if (flagName === '--key') options.key = takeValue()
    else if (flagName === '--endpoint') options.endpoint = takeValue()
    else if (flagName === '--app-url') options.appUrl = takeValue()
    else if (flagName === '--dashboard-url') options.dashboardUrl = takeValue()
    else if (flagName === '--framework') options.framework = takeValue()
    else if (flagName === '--dir') options.dir = takeValue()
    else if (flagName === '--yes' || flagName === '-y') options.yes = true
    else if (flagName === '--no-test') options.noTest = true
  }

  return options
}

// The link printed at the end: an http(s) --dashboard-url as given, else --app-url, else the production app.
export function dashboardLink(options) {
  if (typeof options.dashboardUrl === 'string' && /^https?:\/\/\S+$/.test(options.dashboardUrl)) return options.dashboardUrl

  return options.appUrl ?? DEFAULT_APP_URL
}

// The install command for the project's package manager, from its lock file.
function installCommand(projectDir) {
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm add simpledatalogs'
  if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn add simpledatalogs'
  if (existsSync(join(projectDir, 'bun.lockb')) || existsSync(join(projectDir, 'bun.lock'))) return 'bun add simpledatalogs'

  return 'npm install simpledatalogs'
}

// A file's text, or null when it doesn't exist.
function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null
}

// A JSON file's value, or null when it is missing or unreadable.
function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

// Text indented by two spaces, for notes.
function indent(text) {
  return text.trimEnd().split('\n').map((line) => `  ${line}`).join('\n')
}

