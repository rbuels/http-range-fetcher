//@ts-nocheck
import { describe, it, expect } from 'vitest'
import { parseCacheControl, CacheSemantics } from '../src/cacheSemantics'

describe('cache control parsing', () => {
  ;[
    [undefined, {}],
    ['NO-CACHE', { 'no-cache': true }],
    ['no-cache', { 'no-cache': true }],
    [
      'no-cache, no-store, must-revalidate',
      { 'no-cache': true, 'no-store': true, 'must-revalidate': true },
    ],
    ['no-cache, max-stale=20', { 'no-cache': true, 'max-stale': 20 }],
    ['max-stale=20, no-cache', { 'no-cache': true, 'max-stale': 20 }],
    [
      'must-revalidate, max-stale=20, no-cache',
      { 'no-cache': true, 'max-stale': 20, 'must-revalidate': true },
    ],
  ].forEach(([input, output]) => {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    it(`parses "${input}"`, () => {
      expect(parseCacheControl(input)).toEqual(output)
    })
  })
})

describe('cache semantics manager', () => {
  it('reports a no-cache chunk with no minimumTTL as invalid immediately', () => {
    const sem = new CacheSemantics({ minimumTTL: 0 })
    const fakeChunk = {
      headers: { 'cache-control': 'no-cache' },
      responseDate: new Date(Date.now() - 1),
    }
    expect(sem.chunkIsCacheable(fakeChunk)).toBe(true)
    expect(sem.cachedChunkIsValid(fakeChunk)).toBe(false)
  })
})
