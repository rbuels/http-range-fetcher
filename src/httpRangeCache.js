const LRU = require('lru-cache')
const crossFetch = require('cross-fetch')

const { CacheSemantics } = require('./cacheSemantics')
const CompositeBufferProxyHandler = require('./compositeBufferProxyHandler')
const AggregatingFetcher = require('./aggregatingFetcher')

function crossFetchBinaryRange(url, start, end) {
  const requestDate = new Date()
  return crossFetch({
    method: 'GET',
    url,
    headers: { range: `${start}-${end}` },
  }).then(res => {
    const responseDate = new Date()
    if (res.status !== 206 && res.status !== 200)
      throw new Error(
        `HTTP ${res.status} when fetching ${url} bytes ${start}-${end}`,
      )

    if (res.status === 200) {
      // TODO: check that the response satisfies the byte range,
      // and is not too big (check maximum size),
      // because we actually ended up getting served the whole file
      throw new Error(
        `HTTP ${res.status} when fetching ${url} bytes ${start}-${end}`,
      )
    }

    const bufPromise = res.buffer
      ? res.buffer()
      : res.arrayBuffer().then(arrayBuffer => Buffer.from(arrayBuffer))
    // return the response headers, and the data buffer
    return bufPromise.then(buffer => ({
      headers: res.headers,
      requestDate,
      responseDate,
      buffer,
    }))
  })
}

// TODO: fire events when a remote file is detected as having been changed

/**
 * smart cache that fetches chunks of remote files.
 * caches chunks in an LRU cache, and aggregates upstream fetches
 */
class HttpRangeCache {
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
  }

  /**
   * Fetch a range of a remote resource.
   * @param {string} key the resource's unique identifier, this would usually be a URL.
   * This is passed along to the fetch callback.
   * @param {number} position offset in the file at which to start fetching
   * @param {number} length number of bytes to fetch
   */
  async get(key, position, length) {
    // calculate the list of chunks involved in this fetch
    const firstChunk = Math.floor(position / this.chunkSize)
    const lastChunk = Math.floor((position + length - 1) / this.chunkSize)

    // fetch them all as necessary
    const fetches = new Array(lastChunk - firstChunk + 1)
    for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
      fetches[chunk - firstChunk] = this._getChunk(key, chunk).then(
        response => ({
          headers: response.headers,
          buffer: response.buffer,
          chunkNumber: chunk,
        }),
      )
    }

    // return a "composite buffer" that lets the array of chunks be accessed like a flat buffer
    const chunkResponses = await Promise.all(fetches)
    const chunksOffset =
      position - chunkResponses[0].chunkNumber * this.chunkSize
    return {
      headers: this._makeHeaders(
        chunkResponses[0].headers,
        position,
        position + length - 1,
      ),
      buffer: new Proxy(
        chunkResponses.map(res => res.buffer),
        new CompositeBufferProxyHandler(chunksOffset, this.chunkSize, length),
      ),
    }
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

    const freshPromise = this.aggregator.fetch(
      key,
      chunkNumber * this.chunkSize,
      (chunkNumber + 1) * this.chunkSize,
    )
    // if the request fails, remove its promise
    // from the cache and keep the error
    freshPromise.catch(err => {
      this._uncacheIfSame(chunkKey, freshPromise)
      throw err
    })

    this.chunkCache.set(chunkKey, freshPromise)

    const freshChunk = await freshPromise

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
}

module.exports = HttpRangeCache
