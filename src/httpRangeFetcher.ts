//@ts-nocheck
import LRU from 'quick-lru'

import { CacheSemantics } from './cacheSemantics'
import AggregatingFetcher from './aggregatingFetcher'

import crossFetchBinaryRange from './crossFetchBinaryRange'

/**
 * check if the given exception was caused by an operation being intentionally aborted
 * @param {Error} exception
 * @returns {boolean}
 */
function isAbortException(exception) {
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
  /**
   * @param {object} args the arguments object
   * @param {number} [args.fetch] callback with signature `(key, start, end) => Promise({ headers, buffer })`
   * @param {number} [args.size] size in bytes of cache to keep
   * @param {number} [args.chunkSize] size in bytes of cached chunks
   * @param {number} [args.aggregationTime] time in ms over which to pool requests before dispatching them
   * @param {number} [args.minimumTTL] time in ms a non-cacheable response will be cached
   * @param {number} [args.maxFetchSize] maximum size of an aggregated request
   * @param {number} [args.maxExtraFetch] max number of additional bytes to fetch when aggregating requests
   * that don't actually overlap
   */
  constructor({
    fetch = crossFetchBinaryRange,
    size = 10000000,
    chunkSize = 32768,
    aggregationTime = 100,
    minimumTTL = 1000,
    maxFetchSize = chunkSize * 4,
    maxExtraFetch = chunkSize,
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

  /**
   * Fetch a range of a remote resource.
   * @param {string} key the resource's unique identifier, this would usually be a URL.
   * This is passed along to the fetch callback.
   * @param {number} [position] offset in the file at which to start fetching
   * @param {number} [length] number of bytes to fetch, defaults to the remainder of the file
   * @param {object} [options] request options
   * @param {AbortSignal} [options.signal] AbortSignal object that can be used to abort the fetch
   */
  async getRange(key, position = 0, requestedLength, options = {}) {
    let length = requestedLength
    if (length === undefined) {
      const stat = await this.stat(key)
      if (stat.size === undefined) {
        throw new Error(
          `length not specified, and could not determine size of the remote file`,
        )
      }
      length = stat.size - position
    }

    // calculate the list of chunks involved in this fetch
    const firstChunk = Math.floor(position / this.chunkSize)
    const lastChunk = Math.floor((position + length - 1) / this.chunkSize)

    // fetch them all as necessary
    const fetches = new Array(lastChunk - firstChunk + 1)
    for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
      fetches[chunk - firstChunk] = this._getChunk(key, chunk, options).then(
        response =>
          response && {
            headers: response.headers,
            buffer: response.buffer,
            chunkNumber: chunk,
          },
      )
    }

    // return a "composite buffer" that lets the array of chunks be accessed like a flat buffer
    let chunkResponses = await Promise.all(fetches)
    chunkResponses = chunkResponses.filter(r => !!r) // filter out any undefined (out of range) responses
    if (!chunkResponses.length) {
      return { headers: {}, buffer: Buffer.allocUnsafe(0) }
    }
    const chunksOffset =
      position - chunkResponses[0].chunkNumber * this.chunkSize
    return {
      headers: this._makeHeaders(
        chunkResponses[0].headers,
        position,
        position + length - 1,
      ),
      buffer: this._makeBuffer(chunkResponses, chunksOffset, length),
    }
  }

  _makeBuffer(chunkResponses, chunksOffset, length) {
    if (chunkResponses.length === 1) {
      return chunkResponses[0].buffer.slice(chunksOffset, chunksOffset + length)
    } else if (chunkResponses.length === 0) {
      return Buffer.allocUnsafe(0)
    }
    // 2 or more buffers
    const buffers = chunkResponses.map(r => r.buffer)
    const first = buffers.shift().slice(chunksOffset)
    let last = buffers.pop()
    let trimEnd =
      first.length +
      buffers.reduce((sum, buf) => sum + buf.length, 0) +
      last.length -
      length
    if (trimEnd < 0) {
      trimEnd = 0
    }
    last = last.slice(0, last.length - trimEnd)
    return Buffer.concat([first, ...buffers, last])
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
  async stat(key) {
    let stat = this.stats.get(key)
    if (!stat) {
      const chunk = await this._getChunk(key, 0)
      this._recordStatsIfNecessary(key, chunk)
      stat = this.stats.get(key)
      if (!stat) {
        throw new Error(`failed to retrieve file size for ${key}`)
      }
    }
    return stat
  }

  _headersToStats(chunkResponse) {
    const { headers } = chunkResponse
    const stat = {}
    if (headers['content-range']) {
      const match = headers['content-range'].match(/\d+-\d+\/(\d+)/)
      if (match) {
        stat.size = parseInt(match[1], 10)
        if (Number.isNaN(stat.size)) {
          delete stat.size
        }
      }
    }
    if (headers['last-modified']) {
      stat.mtime = new Date(headers['last-modified'])
      if (stat.mtime.toString() === 'Invalid Date') {
        delete stat.mtime
      }
      if (stat.mtime) {
        stat.mtimeMs = stat.mtime.getTime()
      }
    }
    return stat
  }

  _makeHeaders(originalHeaders, newStart, newEnd) {
    const newHeaders = Object.assign({}, originalHeaders || {})
    newHeaders['content-length'] = newEnd - newStart
    const oldContentRange = newHeaders['content-range'] || ''
    const match = oldContentRange.match(/\d+-\d+\/(\d+)/)
    if (match) {
      newHeaders['content-range'] = `${newStart}-${newEnd - 1}/${match[1]}`
      // eslint-disable-next-line prefer-destructuring
      newHeaders['x-resource-length'] = match[1]
    }
    return newHeaders
  }

  async _getChunk(key, chunkNumber, requestOptions) {
    const chunkKey = `${key}/${chunkNumber}`
    const cachedPromise = this.chunkCache.get(chunkKey)

    if (cachedPromise) {
      let chunk
      let chunkAborted
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
      if (chunkAborted || !this.cacheSemantics.cachedChunkIsValid(chunk)) {
        this._uncacheIfSame(chunkKey, cachedPromise)
        return this._getChunk(key, chunkNumber, requestOptions)
      }

      // gather the stats for the file from the headers
      this._recordStatsIfNecessary(key, chunk)
      return chunk
    }

    const fetchStart = chunkNumber * this.chunkSize
    let fetchEnd = fetchStart + this.chunkSize

    // clamp the end of the fetch to the size if we have a cached size for the file
    const stat = this.stats.get(key)
    if (stat && stat.size) {
      if (fetchStart >= stat.size) {
        return undefined
      }
      if (fetchEnd >= stat.size) {
        fetchEnd = stat.size
      }
    }

    let alreadyRejected = false
    const freshPromise = this.aggregator
      .fetch(key, fetchStart, fetchEnd, requestOptions)
      .catch(err => {
        // if the request fails, remove its promise
        // from the cache and keep the error
        alreadyRejected = true
        this._uncacheIfSame(chunkKey, freshPromise)
        throw err
      })

    if (!alreadyRejected) {
      this.chunkCache.set(chunkKey, freshPromise)
    }

    const freshChunk = await freshPromise

    // gather the stats for the file from the headers
    this._recordStatsIfNecessary(key, freshChunk)

    // remove the promise from the cache
    // if it turns out not to be cacheable. this is
    // done after the fact because we want multiple requests
    // for the same chunk to reuse the same cached promise
    if (!this.cacheSemantics.chunkIsCacheable(freshChunk)) {
      this._uncacheIfSame(chunkKey, freshPromise)
    }

    return freshChunk
  }

  // if the stats for a resource haven't been recorded yet, record them
  _recordStatsIfNecessary(key, chunk) {
    if (!this.stats.has(key)) {
      this.stats.set(key, this._headersToStats(chunk))
    }
  }

  // delete a promise from the cache if it is still in there.
  // need to check if it is still the same because it might
  // have been overwritten sometime while the promise was in flight
  _uncacheIfSame(key, cachedPromise) {
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
