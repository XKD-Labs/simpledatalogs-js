// The SDK stays light and out of the app's way: small, no dependencies, cheap calls, and one reused connection.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

import { createClient } from '../src/index.js'

// The size budget for every source file together, comments included, gzipped as a CDN would serve it.
const MAX_GZIP_BYTES = 24_000

test('the module is small, with no dependencies', async () => {
  const sourceDirectory = new URL('../src/', import.meta.url)
  const sourceNames = (await readdir(sourceDirectory)).filter((fileName) => fileName.endsWith('.js'))
  const source = Buffer.concat(await Promise.all(sourceNames.map((fileName) => readFile(new URL(fileName, sourceDirectory)))))
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  assert.ok(gzipSync(source).length < MAX_GZIP_BYTES, `gzipped size ${gzipSync(source).length} bytes`)
  assert.equal(packageJson.dependencies, undefined)
  assert.doesNotMatch(source.toString(), /^import .* from ['"](?!\.)/m)
})

test('track() only queues: 10,000 calls send nothing until a flush and take well under a millisecond each', () => {
  let fetchCount = 0
  const client = createClient({
    ingestKey: 'sdl_pub_test_key_0001',
    endpoint: 'http://ingest.test',
    fetch: async () => {
      fetchCount += 1
      return new Response(null, { status: 202 })
    },
    storage: null,
    pageTargets: null,
    logger: null,
    flushIntervalMs: 3_600_000,
    maxBatchEvents: 1_000_000,
    maxOutboxEvents: 20_000,
    maxOutboxBytes: 50_000_000,
  })

  const startedAt = performance.now()
  for (let eventNumber = 0; eventNumber < 10_000; eventNumber += 1) client.track('tap', { eventNumber })
  const elapsedMs = performance.now() - startedAt

  assert.equal(fetchCount, 0)
  assert.equal(client.pendingCount, 10_000)
  assert.ok(elapsedMs < 1_000, `10,000 track() calls took ${elapsedMs.toFixed(1)} ms`)
})

test('in Node, consecutive flushes reuse one keep-alive connection, and one request is in flight at a time', async () => {
  const sockets = new Set()
  let inFlightCount = 0
  let mostInFlight = 0
  let requestCount = 0

  // A real HTTP server that answers 202 after a short delay, counting sockets and overlap.
  const server = createServer((request, response) => {
    sockets.add(request.socket)
    requestCount += 1
    inFlightCount += 1
    mostInFlight = Math.max(mostInFlight, inFlightCount)
    request.resume()
    request.on('end', () => {
      setTimeout(() => {
        inFlightCount -= 1
        response.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":"x"}')
      }, 20)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const client = createClient({
      ingestKey: 'sdl_pub_test_key_0001',
      endpoint: `http://127.0.0.1:${port}`,
      storage: null,
      pageTargets: null,
      logger: null,
      maxBatchEvents: 10,
    })

    // 50 events become 5 batches, sent one after another on the same socket.
    for (let eventNumber = 0; eventNumber < 50; eventNumber += 1) client.track('tap', { eventNumber })
    await client.flush()
    await client.shutdown()

    assert.equal(requestCount, 5)
    assert.equal(sockets.size, 1)
    assert.equal(mostInFlight, 1)
    assert.equal(client.pendingCount, 0)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
