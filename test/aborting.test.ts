//@ts-nocheck
import { it, expect } from 'vitest'
import { HttpRangeFetcher } from '../src/index'

const timeout = ms => new Promise(res => setTimeout(res, ms))

it(`can abort a fetch 1`, async () => {
  expect.assertions(2)
  const ab = new AbortController()
  const calls = []
  async function fetch(url, start, end, options) {
    calls.push([url, start, end, options])
    if (options.signal.aborted) {
      throw Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' })
    }
    return {
      headers: {},
      responseDate: new Date(),
      buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    }
  }
  const cache = new HttpRangeFetcher({ fetch, aggregationTime: 100 })
  const get = cache.getRange('http://foo.com/', 0, 10, { signal: ab.signal })
  ab.abort()
  await expect(get).rejects.toThrow(/aborted/)
  expect(calls).toMatchSnapshot()
})

it(`can abort a fetch 2`, async () => {
  expect.assertions(2)
  const ab = new AbortController()
  const calls = []
  async function fetch(url, start, end, options) {
    calls.push([url, start, end, options])
    // await new Promise(res => process.nextTick(res))
    if (options.signal.aborted) {
      throw Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' })
    }
    await timeout(100)
    return {
      headers: {},
      responseDate: new Date(),
      buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    }
  }
  const cache = new HttpRangeFetcher({ fetch, aggregationTime: 100 })
  const get = cache.getRange('http://foo.com/', 0, 10, { signal: ab.signal })
  await timeout(50)
  ab.abort()
  await expect(get).rejects.toThrow(/aborted/)
  expect(calls).toMatchSnapshot()
})

it(`can abort a fetch 3`, async () => {
  expect.assertions(3)
  const ab = new AbortController()
  const calls = []
  let abortCount = 0
  async function fetch(url, start, end, options) {
    calls.push([url, start, end, options])
    await timeout(50)
    if (options.signal.aborted) {
      abortCount += 1
      throw Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' })
    }
    return {
      headers: {},
      responseDate: new Date(),
      buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    }
  }
  const cache = new HttpRangeFetcher({ fetch, aggregationTime: 1 })
  const get = cache.getRange('http://foo.com/', 0, 10, { signal: ab.signal })
  await timeout(20)
  ab.abort()
  await expect(get).rejects.toThrow(/aborted/)
  expect(calls).toMatchSnapshot()
  expect(abortCount).toBe(1)
})
