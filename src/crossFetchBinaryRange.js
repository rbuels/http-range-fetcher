import crossFetch from 'cross-fetch'

export default function crossFetchBinaryRange(url, start, end, options = {}) {
  const requestDate = new Date()
  const fetchOptions = Object.assign(
    {
      method: 'GET',
      headers: { range: `bytes=${start}-${end}` },
    },
    options,
  )
  return crossFetch(url, fetchOptions).then(res => {
    const responseDate = new Date()
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(
        `HTTP ${res.status} when fetching ${url} bytes ${start}-${end}`,
      )
    }

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
      headers: res.headers.map,
      requestDate,
      responseDate,
      buffer,
    }))
  })
}
