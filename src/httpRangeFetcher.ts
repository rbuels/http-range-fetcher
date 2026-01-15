import LRU from '@jbrowse/quick-lru'

import AggregatingFetcher from './aggregatingFetcher.ts'
import crossFetchBinaryRange from './crossFetchBinaryRange.ts'
import { concatUint8Array } from './util.ts'

interface ChunkResponse {
  buffer: Uint8Array
  headers: Headers
}

/**
 * check if the given exception was caused by an operation being intentionally aborted
 */
function isAbortException(exception: any) {
  return (
    // DOMException
    exception.name === 'AbortError' ||
    // standard-ish non-DOM abort exception
    // @ts-ignore
    exception.code === 'ERR_ABORTED' ||
    // message contains aborted for bubbling through RPC
    // things we have seen that we want to catch here
    // Error: aborted
    // AbortError: aborted
    // AbortError: The user aborted a request.
    !!exception.message.match(/\b(aborted|AbortError)\b/i)
  )
}

/**
 * Caching fetch coalescer for HTTP byte-range requests.
 * Caches chunks in an LRU cache and aggregates upstream fetches.
 */
export default class HttpRangeFetcher {
  chunkSize: number
  aggregator: AggregatingFetcher
  chunkCache: LRU<string, Promise<ChunkResponse>>

  constructor({
    fetch = crossFetchBinaryRange,
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
    // calculate the list of chunks involved in this fetch
    const firstChunk = Math.floor(position / this.chunkSize)
    const lastChunk = Math.floor((position + length - 1) / this.chunkSize)

    // fetch them all as necessary
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

    // return a "composite buffer" that lets the array of chunks be accessed like a flat buffer
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
    } else if (chunkResponses.length === 0) {
      return new Uint8Array(0)
    } else {
      // 2 or more buffers
      const buffers = chunkResponses.map(r => r.buffer)
      const first = buffers.shift()!.slice(chunksOffset)
      let last = buffers.pop()!
      let trimEnd =
        first.length +
        buffers.reduce((sum, buf) => sum + buf.length, 0) +
        last.length -
        length
      if (trimEnd < 0) {
        trimEnd = 0
      }
      last = last.slice(0, last.length - trimEnd)
      return concatUint8Array([first, ...buffers, last])
    }
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
      // if the cached chunk was aborted, delete it from the cache and redispatch
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
