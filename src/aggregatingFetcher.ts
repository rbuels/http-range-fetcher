interface Result {
  headers: Headers
  buffer: Uint8Array
}

interface Req {
  start: number
  end: number
  reject: (arg: unknown) => void
  resolve: (arg: Result) => void
  requestOptions: { signal?: AbortSignal }
}

interface ReqGroup {
  requests: Req[]
  url: string
  start: number
  end: number
}

/**
 * takes fetch requests and aggregates them at a certain time frequency
 */
export default class AggregatingFetcher {
  timeout: unknown
  requestQueues = new Map<string, Req[]>()
  fetchCallback: (
    url: string,
    start: number,
    end: number,
    arg: { signal?: AbortSignal },
  ) => Promise<Result>
  frequency: number
  maxExtraSize: number
  maxFetchSize: number
  /**
   *
   * @param params
   * @param [params.frequency] number of milliseconds to wait for requests to aggregate
   */
  constructor({
    fetch,
    frequency = 100,
    maxExtraSize = 32000,
    maxFetchSize = 1000000,
  }: {
    fetch: (url: string, start: number, end: number) => Promise<Result>
    frequency: number
    maxExtraSize: number
    maxFetchSize: number
  }) {
    this.fetchCallback = fetch
    this.frequency = frequency
    this.maxExtraSize = maxExtraSize
    this.maxFetchSize = maxFetchSize
  }

  _canAggregate(requestGroup: ReqGroup, request: Req) {
    return (
      // the fetches overlap, or come close
      request.start <= requestGroup.end + this.maxExtraSize &&
      // aggregating would not result in a fetch that is too big
      request.end - request.start + requestGroup.end - requestGroup.start <
        this.maxFetchSize
    )
  }

  // returns a promise that only resolves when all of the signals in the given
  // array have fired their abort signal
  _allSignalsFired(signals: AbortSignal[]) {
    return new Promise<void>(resolve => {
      let signalsLeft = signals.filter(s => !s.aborted).length
      if (signalsLeft === 0) {
        resolve()
        return
      }
      for (const signal of signals) {
        signal.addEventListener('abort', () => {
          signalsLeft -= 1
          if (!signalsLeft) {
            resolve()
          }
        })
      }
    }).catch((e: unknown) => {
      console.error(e)
    })
  }

  // dispatch a request group as a single request and then slice the result
  // back up to satisfy the individual requests
  _dispatch({ url, start, end, requests }: ReqGroup) {
    // if any of the requests have an AbortSignal `signal` in their
    // requestOptions, make our aggregating abortcontroller track it, aborting
    // the request if all of the abort signals that are aggregated here have
    // fired

    const abortWholeRequest = new AbortController()
    const signals: AbortSignal[] = []
    for (const { requestOptions } of requests) {
      if (requestOptions.signal) {
        signals.push(requestOptions.signal)
      }
    }
    if (signals.length === requests.length) {
      // may need review
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this._allSignalsFired(signals).then(() => {
        abortWholeRequest.abort()
      })
    }

    this.fetchCallback(url, start, end - 1, {
      signal: abortWholeRequest.signal,
    })
      .then(response => {
        const data = response.buffer
        for (const { start: reqStart, end: reqEnd, resolve } of requests) {
          resolve({
            headers: response.headers,
            buffer: data.subarray(reqStart - start, reqEnd - start),
          })
        }
      })
      .catch((err: unknown) => {
        for (const { reject } of requests) {
          reject(err)
        }
      })
  }

  _aggregateAndDispatch() {
    for (const [url, requests] of this.requestQueues) {
      if (!requests.length) {
        continue
      }

      // we are now going to aggregate the requests in this url's queue into
      // groups of requests that can be dispatched as one
      const requestsToDispatch = [] as Req[]

      // look to see if any of the requests are aborted, and if they are, just
      // reject them now and forget about them
      for (const request of requests) {
        const { requestOptions, reject } = request
        if (requestOptions.signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' }))
        } else {
          requestsToDispatch.push(request)
        }
      }

      requestsToDispatch.sort((a, b) => a.start - b.start)

      requests.length = 0
      if (!requestsToDispatch.length) {
        continue
      }

      let currentRequestGroup: ReqGroup | undefined
      for (const next of requestsToDispatch) {
        if (
          currentRequestGroup &&
          this._canAggregate(currentRequestGroup, next)
        ) {
          // aggregate it into the current group
          currentRequestGroup.requests.push(next)
          currentRequestGroup.end = next.end
        } else {
          // out of range, dispatch the current request group
          if (currentRequestGroup) {
            this._dispatch(currentRequestGroup)
          }
          // and start on a new one
          currentRequestGroup = {
            requests: [next],
            url,
            start: next.start,
            end: next.end,
          }
        }
      }
      if (currentRequestGroup) {
        this._dispatch(currentRequestGroup)
      }
    }
  }

  _enQueue(url: string, request: Req) {
    let queue = this.requestQueues.get(url)
    if (!queue) {
      queue = []
      this.requestQueues.set(url, queue)
    }
    queue.push(request)
  }

  /**
   *
   * @param url
   * @param start 0-based half-open
   * @param end 0-based half-open
   * @param [requestOptions] options passed to the underlying fetch call
   */
  fetch(url: string, start: number, end: number, requestOptions = {}) {
    return new Promise((resolve, reject) => {
      this._enQueue(url, { start, end, resolve, reject, requestOptions })
      if (!this.timeout) {
        this.timeout = setTimeout(() => {
          this.timeout = undefined
          this._aggregateAndDispatch()
        }, this.frequency || 1)
      }
    })
  }
}
