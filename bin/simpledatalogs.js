#!/usr/bin/env node
/** The `simpledatalogs` command; `npx simpledatalogs init` sets up a project. */

import { createInterface } from 'node:readline/promises'

import { runInit } from '../cli/init.js'

// The subcommand and its flags.
const [commandName, ...commandArguments] = process.argv.slice(2)

if (commandName !== 'init') {
  console.log('Usage: npx simpledatalogs init [--key sdl_pub_…] [--framework name] [--endpoint url] [--app-url url] [--yes] [--no-test]')
  process.exit(commandName === undefined || commandName === '--help' ? 0 : 1)
}

// Questions go through one readline on the terminal.
const terminal = createInterface({ input: process.stdin, output: process.stdout })

// Asks one question; a closed input (piped, Ctrl-D) answers empty, which means no.
function askQuestion(question) {
  return new Promise((resolve) => {
    const answerEmpty = () => resolve('')

    terminal.once('close', answerEmpty)
    terminal.question(question).then((answer) => {
      terminal.off('close', answerEmpty)
      resolve(answer)
    }, answerEmpty)
  })
}

const exitCode = await runInit(commandArguments, {
  cwd: process.cwd(),
  env: process.env,
  print: (text) => console.log(text),
  ask: askQuestion,
  fetch: globalThis.fetch,
})

terminal.close()
process.exit(exitCode)
