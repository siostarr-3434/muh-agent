import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { handleApplicationRoute } from './server/api.mjs'
import { loadRuntimeConfig } from './server/config.mjs'
import { decodePath, securityHeaders, writeJson } from './server/http.mjs'

const root = resolve(import.meta.dirname, '..', 'dist')
const config = loadRuntimeConfig()
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (request, response) => {
  const rawPath = decodePath(request.url)
  if (rawPath === null) {
    writeJson(response, 400, { error: 'invalid_path' })
    return
  }

  if (rawPath === '/health') {
    writeJson(response, 200, { status: 'ok', service: 'muh-agent', version: '0.1.0' })
    return
  }

  if (await handleApplicationRoute(request, response, config, rawPath)) return

  if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
    response.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' })
    response.end()
    return
  }

  const relativePath = rawPath.replace(/^[\\/]+/, '') || 'index.html'
  let file = resolve(root, relativePath)
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    writeJson(response, 400, { error: 'invalid_path' })
    return
  }

  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    if (extname(relativePath)) {
      writeJson(response, 404, { error: 'not_found' })
      return
    }
    file = resolve(root, 'index.html')
  }

  response.writeHead(200, {
    ...securityHeaders,
    'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=0, must-revalidate',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(file).pipe(response)
})

server.listen(config.port, config.host, () => {
  console.log(`Muh Agent: http://${config.host}:${config.port} (${config.live ? 'live backend configured' : 'demo mode'})`)
})
