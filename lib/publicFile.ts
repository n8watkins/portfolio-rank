import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * The bytes of a file in public/ (`path` starts with "/").
 *
 * On Workers the server has no disk: public/ is uploaded as static assets, so
 * the file comes from the ASSETS binding (no network hop). During `next build`
 * and under `next start` it is read from public/ on disk (`next start` has a
 * simulated ASSETS binding without the files).
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
    // Under `next start` the context is a local simulation whose ASSETS has
    // no files: public/ on disk has them. On Workers there is no disk, and
    // the asset's own answer is the error.
    const fromDisk = await readFromDisk(path).catch(() => null)
    if (fromDisk) return fromDisk
    throw new Error(`${path}: static asset answered ${response.status}`)
  }

  return readFromDisk(path)
}

async function readFromDisk(path: string): Promise<ArrayBuffer> {
  const [{ readFile }, { join }] = await Promise.all([import('node:fs/promises'), import('node:path')])
  const file = await readFile(join(process.cwd(), 'public', path))
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
}
