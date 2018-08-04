const nodeUrl = require('url')
const LRU = require('lru-cache')

const CompositeBufferProxyHandler = require('./compositeBufferProxyHandler')
const AggregatingFetcher = require('./aggregatingFetcher')

// TODO: fire events when a remote file is detected as having been changed
/**
 * smart cache that fetches chunks of remote files.
 * caches chunks in an LRU cache, and aggregates upstream fetches
 */
class BufferCache {
  /**
   *
   * @param {object} args
   * @param {function} args.fetch async function with signature (url, start, end) => Promise(Buffer)
   * @param {number} [args.size] size in bytes of cache to keep
   * @param {number} [args.chunkSize] size in bytes of cached chunks
   * @param {number} [args.aggregationTime] time in ms over which to pool requests before dispatching them
   */
  constructor({
    fetch,
    size = 10000000,
    chunkSize = 32768,
    aggregationTime = 100,
  }) {
    if (!fetch) throw new Error('fetch function required')
    this.aggregator = new AggregatingFetcher({
      fetch,
      frequency: aggregationTime,
    })
    this.chunkSize = chunkSize
    this.chunkCache = LRU({ max: Math.floor(size / chunkSize) })
  }

  _removeFragmentFromUrl(u) {
    const parsed = nodeUrl.parse(u)
    if (!parsed) throw new Error(`invalid url "${u}"`)
    delete parsed.hash
    const formatted = nodeUrl.format(parsed)
    if (!formatted) throw new Error(`invalid url "${u}"`)
    return formatted
  }

  async get(url, position, length) {
    // remove any fragment from the URL
    const urlWithoutFragment = this._removeFragmentFromUrl(url)

    // calculate the list of chunks involved in this fetch
    const firstChunk = Math.floor(position / this.chunkSize)
    const lastChunk = Math.floor((position + length - 1) / this.chunkSize)

    // fetch them all as necessary
    const fetches = new Array(lastChunk - firstChunk + 1)
    for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
      fetches[chunk - firstChunk] = this._getChunk(
        urlWithoutFragment,
        chunk,
      ).then(data => ({
        data,
        chunkNumber: chunk,
      }))
    }

    // return a "composite buffer" that lets the array of chunks be accessed like a flat buffer
    const chunks = await Promise.all(fetches)
    const chunksOffset = position - chunks[0].chunkNumber * this.chunkSize
    return new Proxy(
      chunks,
      new CompositeBufferProxyHandler(chunksOffset, this.chunkSize, length),
    )
  }

  _getChunk(url, chunkNumber) {
    const key = `${url} chunk ${chunkNumber}`
    const cachedPromise = this.chunkCache.get(key)
    if (cachedPromise) return cachedPromise

    const freshPromise = this.aggregator.fetch(
      url,
      chunkNumber * this.chunkSize,
      (chunkNumber + 1) * this.chunkSize,
    )
    this.chunkCache.set(key, freshPromise)
    return freshPromise
  }
}

module.exports = BufferCache
