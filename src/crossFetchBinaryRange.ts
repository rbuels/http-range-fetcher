export default async function crossFetchBinaryRange(
  url: string,
  start: number,
  end: number,
  options = {},
) {
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

  const buffer = new Uint8Array(await res.arrayBuffer())

  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })

  return {
    headers,
    requestDate,
    responseDate,
    buffer,
  }
}
