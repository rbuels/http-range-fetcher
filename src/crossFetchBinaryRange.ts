export default async function crossFetchBinaryRange(
  url: string,
  start: number,
  end: number,
  options = {},
) {
  const fetchOptions = Object.assign(
    {
      method: 'GET',
      headers: { range: `bytes=${start}-${end}` },
    },
    options,
  )
  const res = await fetch(url, fetchOptions)
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(
      `HTTP ${res.status} when fetching ${url} bytes ${start}-${end}`,
    )
  }

  if (res.status === 200) {
    throw new Error(
      `HTTP ${res.status} when fetching ${url} bytes ${start}-${end}`,
    )
  }

  const buffer = new Uint8Array(await res.arrayBuffer())

  return {
    headers: res.headers,
    buffer,
  }
}
