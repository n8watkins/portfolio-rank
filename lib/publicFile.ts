import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * The bytes of a file in public/ (`path` starts with "/").
 *
 * On Workers the server has no disk: public/ is uploaded as static assets, so
 * the file comes from the ASSETS binding (no network hop). During `next build`
 * and under `next start` it is read from public/ on disk.
 */
export async function readPublicFile(path: string): Promise<ArrayBuffer> {
  let assets: { fetch(url: URL): Promise<Response> } | undefined
  try {
    assets = getCloudflareContext().env.ASSETS
  } catch {
    // Not on Workers.
  }

  if (assets) {
    const response = await assets.fetch(new URL(path, 'https://assets.local'))
    if (response.ok) return response.arrayBuffer()
    // `next dev` gets an ASSETS binding from wrangler but no built assets, so
    // it answers 404 for everything: read public/ from disk there instead.
    if (process.env.NODE_ENV !== 'development') throw new Error(`${path}: static asset answered ${response.status}`)
  }

  const [{ readFile }, { join }] = await Promise.all([import('node:fs/promises'), import('node:path')])
  const file = await readFile(join(process.cwd(), 'public', path))
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
}
