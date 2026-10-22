// The hand-written index.d.ts: package.json points at it, and it declares every export and every public client member.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import * as sdk from '../src/index.js'

// The declarations as shipped.
const declarations = await readFile(new URL('../index.d.ts', import.meta.url), 'utf8')

test('package.json points types at index.d.ts and ships it', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  assert.equal(packageJson.types, './index.d.ts')
  assert.equal(packageJson.exports['.'].types, './index.d.ts')
  assert.equal(packageJson.exports['.'].default, './src/index.js')
  assert.ok(packageJson.files.includes('index.d.ts'))
})

test('index.d.ts declares every export of the module', () => {
  for (const exportName of Object.keys(sdk)) {
    assert.match(declarations, new RegExp(`export declare (?:const|function|class) ${exportName}\\b`), `${exportName} is not declared`)
  }
})

test('index.d.ts declares every public method and getter of the client', () => {
  const memberNames = Object.getOwnPropertyNames(sdk.SimpleDataLogsClient.prototype).filter((memberName) => memberName !== 'constructor')

  for (const memberName of memberNames) {
    assert.match(declarations, new RegExp(`^  (?:readonly )?${memberName}[(:]`, 'm'), `${memberName} is not declared`)
  }
})
