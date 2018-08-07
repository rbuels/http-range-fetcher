const LRU = require('lru-cache')

const { CacheSemantics } = require('./cacheSemantics')
const AggregatingFetcher = require('./aggregatingFetcher')

const crossFetchBinaryRange = require('./crossFetchBinaryRange')

// TODO: fire events when a remote file is detected as having been changed

/**
 * smart cache that fetches chunks of remote files.
 * caches chunks in an LRU cache, and aggregates upstream fetches
 */
class HttpRangeFetcher {
  /**
   * @param {object} args the arguments object
   * @param {number} [args.fetch] callback with signature `(key, start, end) => Promise({ headers, buffer })`
   * @param {number} [args.size] size in bytes of cache to keep
   * @param {number} [args.chunkSize] size in bytes of cached chunks
   * @param {number} [args.aggregationTime] time in ms over which to pool requests before dispatching them
   * @param {number} [args.minimumTTL] time in ms a non-cacheable response will be cached
   */
  constructor({
    fetch = crossFetchBinaryRange,
    size = 10000000,
    chunkSize = 32768,
    aggregationTime = 100,
    minimumTTL = 1000,
  }) {
    this.aggregator = new AggregatingFetcher({
      fetch,
      frequency: aggregationTime,
    })
    this.chunkSize = chunkSize
    this.chunkCache = LRU({ max: Math.floor(size / chunkSize) })
    this.cacheSemantics = new CacheSemantics({ minimumTTL })
    this.stats = LRU({ max: 20 })
  }

  /**
   * Fetch a range of a remote resource.
   * @param {string} key the resource's unique identifier, this would usually be a URL.
   * This is passed along to the fetch callback.
   * @param {number} [position] offset in the file at which to start fetching
   * @param {number} [length] number of bytes to fetch, defaults to the remainder of the file
   */
  async getRange(key, position = 0, length) {
    if (length === undefined) {
      const stat = await this.stat(key)
      if (stat.size === undefined)
        throw new Error(
          `length not specified, and could not determine size of the remote file`,
        )
      length = stat.size - position
    }

    // calculate the list of chunks involved in this fetch
    const firstChunk = Math.floor(position / this.chunkSize)
    const lastChunk = Math.floor((position + length - 1) / this.chunkSize)

    // fetch them all as necessary
    const fetches = new Array(lastChunk - firstChunk + 1)
    for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
      fetches[chunk - firstChunk] = this._getChunk(key, chunk).then(
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
      await this._getChunk(key, 0)
      stat = this.stats.get(key)
      if (!stat) throw new Error(`failed to retrieve file size for ${key}`)
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
        if (Number.isNaN(stat.size)) delete stat.size
      }
    }
    if (headers['last-modified']) {
      stat.mtime = new Date(headers['last-modified'])
      if (stat.mtime.toString() === 'Invalid Date') delete stat.mtime
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
      newHeaders['x-resource-length'] = match[1]
    }
    return newHeaders
  }

  async _getChunk(key, chunkNumber) {
    const chunkKey = `${key}/${chunkNumber}`
    const cachedPromise = this.chunkCache.get(chunkKey)

    if (cachedPromise) {
      const chunk = await cachedPromise
      // when the cached chunk is resolved, validate it before returning it.
      // if invalid, delete it from the cache and redispatch the request
      if (!this.cacheSemantics.cachedChunkIsValid(chunk)) {
        this._uncacheIfSame(chunkKey, cachedPromise)
        return this._getChunk(key, chunkNumber)
      }
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
      if (fetchEnd >= stat.size) fetchEnd = stat.size
    }

    const freshPromise = this.aggregator.fetch(key, fetchStart, fetchEnd)
    // if the request fails, remove its promise
    // from the cache and keep the error
    freshPromise.catch(err => {
      this._uncacheIfSame(chunkKey, freshPromise)
      throw err
    })

    this.chunkCache.set(chunkKey, freshPromise)

    const freshChunk = await freshPromise

    // gather the stats for the file from the headers
    this.stats.set(key, this._headersToStats(freshChunk))

    // remove the promise from the cache
    // if it turns out not to be cacheable. this is
    // done after the fact because we want multiple requests
    // for the same chunk to reuse the same cached promise
    if (!this.cacheSemantics.chunkIsCacheable(freshChunk)) {
      this._uncacheIfSame(key, freshPromise)
    }

    return freshChunk
  }

  // delete a promise from the cache if it is still in there.
  // need to check if it is still the same because it might
  // have been overwritten sometime while the promise was in flight
  _uncacheIfSame(key, cachedPromise) {
    if (this.chunkCache.get(key) === cachedPromise) {
      this.chunkCache.del(key)
    }
  }

  /**
   * Throw away all cached data, resetting the cache.
   */
  reset() {
    this.stats.reset()
    this.chunkCache.reset()
  }
}

module.exports = HttpRangeFetcher