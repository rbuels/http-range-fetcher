//@ts-nocheck
import global from 'window-or-global'

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args))

export default async function crossFetchBinaryRange(
  url,
  start,
  end,
  options = {},
) {
  if (!global.fetch) {
    global.fetch = fetch
  }
  const requestDate = new Date()
  const fetchOptions = Object.assign(
    {
      method: 'GET',
      headers: { range: `bytes=${start}-${end}` },
    },
    options,
  )
  const res = await fetch(url, fetchOptions)
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

  const buffer = await res
    .arrayBuffer()
    .then(arrayBuffer => Buffer.from(arrayBuffer))

  // return the response headers, and the data buffer
  return {
    headers: res.headers.map,
    requestDate,
    responseDate,
    buffer,
  }
}
