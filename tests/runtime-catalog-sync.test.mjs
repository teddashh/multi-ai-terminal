import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { expectedVersions, PLATFORMS } from '../scripts/sync-runtime-catalog.mjs'

const readJson = async (relativePath) => JSON.parse(
  await readFile(new URL(relativePath, import.meta.url), 'utf8'),
)

describe('committed runtime catalog', () => {
  it('matches both dependency pin locations and covers every platform', async () => {
    const [catalog, rootPackage, serverPackage] = await Promise.all([
      readJson('../runtime-catalog.json'),
      readJson('../package.json'),
      readJson('../server/package.json'),
    ])
    const expected = expectedVersions()
    const keys = PLATFORMS.map(({ key }) => key)

    expect(catalog.claude.version).toBe(expected.claude)
    expect(catalog.codex.version).toBe(expected.codex)
    expect(catalog.node.version).toBe(expected.node)

    for (const packageJson of [rootPackage, serverPackage]) {
      expect(packageJson.dependencies['@anthropic-ai/claude-agent-sdk']).toBe(`^${expected.claude}`)
      expect(packageJson.dependencies['@openai/codex']).toBe(expected.codex)
    }

    for (const key of keys) {
      expect(catalog.claude.platforms[key]).toBeDefined()
      expect(catalog.claude.platforms[key].packageName).toBe(`claude-agent-sdk-${key}`)
      expect(catalog.claude.platforms[key].integrity).toMatch(/^sha512-/)

      expect(catalog.codex.platforms[key]).toBeDefined()
      expect(catalog.codex.platforms[key].npmVersion).toBe(`${expected.codex}-${key}`)
      expect(catalog.codex.platforms[key].integrity).toMatch(/^sha512-/)

      expect(catalog.node.platforms[key]).toBeDefined()
      expect(catalog.node.platforms[key].sha256).toMatch(/^[0-9a-f]{64}$/)
    }

    expect(Object.keys(catalog.claude.platforms)).toEqual(keys)
    expect(Object.keys(catalog.codex.platforms)).toEqual(keys)
    expect(Object.keys(catalog.node.platforms)).toEqual(keys)
  })
})
