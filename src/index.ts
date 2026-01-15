import LRU from '@jbrowse/quick-lru'

import AggregatingFetcher from './aggregatingFetcher.ts'
import { concatUint8Array } from './util.ts'

interface ChunkResponse {
  buffer: Uint8Array
  headers: Headers
}

async function defaultFetch(
  url: string,
  start: number,
  end: number,
  options = {},
) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { range: `bytes=${start}-${end}` },
    ...options,
  })
  if (res.status !== 206) {
    throw new Error(
      `HTTP ${res.status} when fetching ${url} bytes ${start}-${end}`,
    )
  }
  return {
    headers: res.headers,
    buffer: await res.bytes(),
  }
}

/**
 * check if the given exception was caused by an operation being intentionally aborted
 */
function isAbortException(exception: any) {
  return (
    exception.name === 'AbortError' ||
    exception.code === 'ERR_ABORTED' ||
    !!exception.message?.match(/\b(aborted|AbortError)\b/i)
  )
}

/**
 * Caching fetch coalescer for HTTP byte-range requests.
 * Caches chunks in an LRU cache and aggregates upstream fetches.
 */
export class HttpRangeFetcher {
  chunkSize: number
  aggregator: AggregatingFetcher
  chunkCache: LRU<string, Promise<ChunkResponse>>

  constructor({
    fetch = defaultFetch,
    size = 10000000,
    chunkSize = 32768,
    aggregationTime = 100,
    maxFetchSize = chunkSize * 4,
    maxExtraFetch = chunkSize,
  }: {
    fetch?: (
      key: string,
      start: number,
      end: number,
    ) => Promise<{ headers: Headers; buffer: Uint8Array }>
    size?: number
    chunkSize?: number
    aggregationTime?: number
    maxFetchSize?: number
    maxExtraFetch?: number
  } = {}) {
    this.aggregator = new AggregatingFetcher({
      fetch,
      frequency: aggregationTime,
      maxFetchSize,
      maxExtraSize: maxExtraFetch,
    })
    this.chunkSize = chunkSize
    this.chunkCache = new LRU({ maxSize: Math.floor(size / chunkSize) || 1 })
  }

  async getRange(key: string, position: number, length: number, options = {}) {
    const firstChunk = Math.floor(position / this.chunkSize)
    const lastChunk = Math.floor((position + length - 1) / this.chunkSize)

    const fetches = new Array(lastChunk - firstChunk + 1)
    for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
      fetches[chunk - firstChunk] = this._getChunk(key, chunk, options).then(
        res =>
          res && {
            headers: res.headers,
            buffer: res.buffer,
            chunkNumber: chunk,
          },
      )
    }

    let chunkResponses = await Promise.all(fetches)
    chunkResponses = chunkResponses.filter(r => !!r)
    if (!chunkResponses.length) {
      return {
        headers: {},
        buffer: new Uint8Array(0),
      }
    }
    const chunksOffset =
      position - chunkResponses[0]!.chunkNumber * this.chunkSize
    return {
      headers: chunkResponses[0].headers,
      buffer: this._makeBuffer(chunkResponses, chunksOffset, length),
    }
  }

  _makeBuffer(
    chunkResponses: { buffer: Uint8Array }[],
    chunksOffset: number,
    length: number,
  ) {
    if (chunkResponses.length === 1) {
      return chunkResponses[0]!.buffer.slice(
        chunksOffset,
        chunksOffset + length,
      )
    }
    const buffers = chunkResponses.map(r => r.buffer)
    buffers[0] = buffers[0]!.slice(chunksOffset)
    const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0)
    const trimEnd = Math.max(0, totalLength - length)
    const lastIdx = buffers.length - 1
    buffers[lastIdx] = buffers[lastIdx]!.slice(
      0,
      buffers[lastIdx]!.length - trimEnd,
    )
    return concatUint8Array(buffers)
  }

  async _getChunk(
    key: string,
    chunkNumber: number,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<ChunkResponse | undefined> {
    const chunkKey = `${key}/${chunkNumber}`
    const cachedPromise = this.chunkCache.get(chunkKey)

    if (cachedPromise) {
      let chunk: ChunkResponse | undefined
      let chunkAborted = false
      try {
        chunk = await cachedPromise
      } catch (err) {
        if (isAbortException(err)) {
          chunkAborted = true
        } else {
          throw err
        }
      }
      if (chunkAborted) {
        this._uncacheIfSame(chunkKey, cachedPromise)
        return this._getChunk(key, chunkNumber, requestOptions)
      }
      return chunk
    }

    const fetchStart = chunkNumber * this.chunkSize
    const fetchEnd = fetchStart + this.chunkSize

    const freshPromise = (
      this.aggregator.fetch(
        key,
        fetchStart,
        fetchEnd,
        requestOptions,
      ) as Promise<ChunkResponse>
    ).catch((err: unknown) => {
      this._uncacheIfSame(chunkKey, freshPromise)
      throw err
    })

    this.chunkCache.set(chunkKey, freshPromise)

    return freshPromise
  }

  _uncacheIfSame(key: string, cachedPromise: Promise<ChunkResponse>) {
    if (this.chunkCache.get(key) === cachedPromise) {
      this.chunkCache.delete(key)
    }
  }

  /**
   * Throw away all cached data, resetting the cache.
   */
  reset() {
    this.chunkCache.clear()
  }
}
