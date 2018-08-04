/**
 * takes fetch requests and aggregates them at a certain time frequency
 */
class AggregatingFetcher {
  /**
   *
   * @param {object} params
   * @param {number} [params.frequency] number of milliseconds to wait for requests to aggregate
   */
  constructor({
    frequency = 100,
    fetch,
    maxExtraSize = 32000,
    maxFetchSize = 1000000,
  }) {
    this.requestQueues = {} // url => array of requests
    this.fetchCallback = fetch
    this.frequency = frequency
    this.maxExtraSize = maxExtraSize
    this.maxFetchSize = maxFetchSize
  }

  _canAggregate(requestGroup, request) {
    return (
      // the fetches overlap, or come close
      request.start <= requestGroup.end + this.maxExtraSize &&
      // aggregating would not result in a fetch that is too big
      request.end - request.start + requestGroup.end - requestGroup.start <
        this.maxFetchSize
    )
  }

  // dispatch a request group as a single request
  // and then slice the result back up to satisfy
  // the individual requests
  _dispatch({ url, start, end, requests }) {
    this.fetchCallback(url, start, end).then(
      data => {
        requests.forEach(({ start: reqStart, end: reqEnd, resolve }) => {
          // remember Buffer.slice does not copy, it creates
          // an offset child buffer pointing to the same data
          resolve(data.slice(reqStart - start, reqEnd - start))
        })
      },
      err => requests.forEach(({ reject }) => reject(err)),
    )
  }

  _aggregateAndDispatch() {
    Object.entries(this.requestQueues).forEach(([url, requests]) => {
      if (!requests || !requests.length) return
      // console.log(url, requests)
      // aggregate the requests in this url's queue
      const sortedRequests = requests.sort((a, b) => a[0] - b[0])
      let currentRequestGroup
      do {
        const next = sortedRequests.shift()
        if (
          currentRequestGroup &&
          this._canAggregate(currentRequestGroup, next)
        ) {
          // aggregate it
          currentRequestGroup.requests.push(next)
          currentRequestGroup.end = next.end
        } else {
          // out of range, dispatch the current request group
          if (currentRequestGroup) this._dispatch(currentRequestGroup)
          currentRequestGroup = {
            requests: [next],
            url,
            start: next.start,
            end: next.end,
          }
        }
      } while (sortedRequests.length)

      if (currentRequestGroup) this._dispatch(currentRequestGroup)
    })
  }

  _enQueue(url, request) {
    if (!this.requestQueues[url]) this.requestQueues[url] = []
    this.requestQueues[url].push(request)
  }

  /**
   *
   * @param {string} url
   * @param {number} start 0-based half-open
   * @param {number} end 0-based half-open
   */
  fetch(url, start, end) {
    return new Promise((resolve, reject) => {
      this._enQueue(url, { start, end, resolve, reject })
      if (!this.timeout) {
        this.timeout = setTimeout(() => {
          this.timeout = undefined
          this._aggregateAndDispatch()
        }, this.frequency)
      }
    })
  }
}

module.exports = AggregatingFetcher
