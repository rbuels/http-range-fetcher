import LRU from 'quick-lru'

import { CacheSemantics, ChunkResponse } from './cacheSemantics'
import AggregatingFetcher from './aggregatingFetcher'

import crossFetchBinaryRange from './crossFetchBinaryRange'
import { concatUint8Array } from './util'

/**
 * check if the given exception was caused by an operation being intentionally aborted
 * @param {Error} exception
 * @returns {boolean}
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

// TODO: fire events when a remote file is detected as having been changed

/**
 * smart cache that fetches chunks of remote files.
 * caches chunks in an LRU cache, and aggregates upstream fetches
 */
export default class HttpRangeFetcher {
  chunkSize: number
  aggregator: AggregatingFetcher
  chunkCache: LRU<string, Promise<ChunkResponse>>
  cacheSemantics: CacheSemantics
  stats: LRU<string, { size: number; mtime: Date }>

  constructor({
    fetch = crossFetchBinaryRange,
    size = 10000000,
    chunkSize = 32768,
    aggregationTime = 100,
    minimumTTL = 1000,
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
    minimumTTL?: number
    maxFetchSize?: number
    maxExtraFetch?: number
  }) {
    this.aggregator = new AggregatingFetcher({
      fetch,
      frequency: aggregationTime,
      maxFetchSize,
      maxExtraSize: maxExtraFetch,
    })
    this.chunkSize = chunkSize
    this.chunkCache = new LRU({ maxSize: Math.floor(size / chunkSize) || 1 })
    this.cacheSemantics = new CacheSemantics({ minimumTTL })
    this.stats = new LRU({ maxSize: 20 })
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
    chunkResponses = chunkResponses.filter(r => !!r) // filter out any undefined (out of range) responses
    if (!chunkResponses.length) {
      return {
        headers: {},
        buffer: new Uint8Array(0),
      }
    }
    const chunksOffset =
      position - chunkResponses[0]!.chunkNumber * this.chunkSize
    return {
      headers: this._makeHeaders(
        chunkResponses[0].headers,
        position,
        position + length - 1,
      ),
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

  /**
   * Fetches the first few bytes of the remote file (if necessary) and uses
   * the returned headers to populate a `fs`-like stat object.
   *
   * Currently, this attempts to set `size`, `mtime`, and `mtimeMs`, if
   * the information is available from HTTP headers.
   *
   * @param {string} key
   * @returns {Promise} for a stats object
   */
  async stat(key: string) {
    let stat = this.stats.get(key)
    if (!stat) {
      const chunk = await this._getChunk(key, 0)
      if (chunk) {
        this._recordStatsIfNecessary(key, chunk)
      }
      stat = this.stats.get(key)
      if (!stat) {
        throw new Error(`failed to retrieve file size for ${key}`)
      }
    }
    return stat
  }

  _headersToStats(chunkResponse: ChunkResponse) {
    const { headers } = chunkResponse
    const stat = {} as { mtimeMs: number; mtime: Date; size: number }
    if (headers?.['content-range']) {
      const match = /\d+-\d+\/(\d+)/.exec(headers['content-range'])
      if (match) {
        const r = parseInt(match[1]!, 10)
        if (!Number.isNaN(r)) {
          stat.size = r
        }
      }
    }
    if (headers?.['last-modified']) {
      stat.mtime = new Date(headers['last-modified'])
      if (stat.mtime.toString() === 'Invalid Date') {
        console.warn('Invalid Date')
        stat.mtime = new Date()
      }
      stat.mtimeMs = stat.mtime.getTime()
    }
    return stat
  }

  _makeHeaders(originalHeaders: Headers, newStart: number, newEnd: number) {
    const headers = { ...originalHeaders } as Record<string, unknown>
    const match = /\d+-\d+\/(\d+)/.exec(
      (headers['content-range'] as string | undefined) || '',
    )
    return {
      ...originalHeaders,
      'content-length': newEnd - newStart,
      'content-range': `${newStart}-${newEnd - 1}/${match?.[1]}`,
      'x-resource-length': match?.[1],
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
          // fetch was aborted
          chunkAborted = true
        } else {
          throw err
        }
      }
      // when the cached chunk is resolved, validate it before returning it.
      // if invalid or aborted, delete it from the cache and redispatch the request
      if (
        // todo: audit whether the chunk && is needed
        // was introduced during typescriptification
        chunk &&
        (chunkAborted || !this.cacheSemantics.cachedChunkIsValid(chunk))
      ) {
        this._uncacheIfSame(chunkKey, cachedPromise)
        return this._getChunk(key, chunkNumber, requestOptions)
      }

      // gather the stats for the file from the headers
      if (chunk) {
        this._recordStatsIfNecessary(key, chunk)
      }
      return chunk
    }

    const fetchStart = chunkNumber * this.chunkSize
    let fetchEnd = fetchStart + this.chunkSize

    // clamp the end of the fetch to the size if we have a cached size for the file
    const stat = this.stats.get(key)
    if (stat?.size) {
      if (fetchStart >= stat.size) {
        return undefined
      }
      if (fetchEnd >= stat.size) {
        fetchEnd = stat.size
      }
    }

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

    const freshChunk = await freshPromise

    // gather the stats for the file from the headers
    this._recordStatsIfNecessary(key, freshChunk)

    // remove the promise from the cache if it turns out not to be cacheable.
    // this is done after the fact because we want multiple requests for the
    // same chunk to reuse the same cached promise
    if (!this.cacheSemantics.chunkIsCacheable(freshChunk)) {
      this._uncacheIfSame(chunkKey, freshPromise)
    }

    return freshChunk
  }

  // if the stats for a resource haven't been recorded yet, record them
  _recordStatsIfNecessary(key: string, chunk: ChunkResponse) {
    if (!this.stats.has(key)) {
      this.stats.set(key, this._headersToStats(chunk))
    }
  }

  // delete a promise from the cache if it is still in there.
  // need to check if it is still the same because it might
  // have been overwritten sometime while the promise was in flight
  _uncacheIfSame(key: string, cachedPromise: Promise<ChunkResponse>) {
    if (this.chunkCache.get(key) === cachedPromise) {
      this.chunkCache.delete(key)
    }
  }

  /**
   * Throw away all cached data, resetting the cache.
   */
  reset() {
    this.stats.clear()
    this.chunkCache.clear()
  }
}
