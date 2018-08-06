const promisify = require('util.promisify')
const _ = require('lodash')
const { HttpRangeCache } = require('../src/index')

describe('super duper cache', () => {
  jest.setTimeout(500)
  it(`can fetch a single chunk`, async () => {
    const fetch = async () => ({
      headers: {},
      responseDate: new Date(),
      buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    })
    const cache = new HttpRangeCache({ fetch, aggregationTime: 0 })
    const got = await cache.getRange('http://foo.com/', 0, 10)
    expect(got.buffer[0]).toEqual(0)
    expect(got.buffer[9]).toEqual(9)
    expect(got.buffer.length).toEqual(10)
  })

  it('can fetch a bunch of things in a single aggregated call', async () => {
    const calls = []
    const fetch = async (url, start, end) => {
      calls.push([url, start, end])
      const add = url === 'bar' ? 1000 : 0
      return {
        headers: { 'content-range': `${start}-${end}/501` },
        responseDate: new Date(),
        buffer: _.range(0, 500)
          .slice(start, end)
          .map(n => add + n),
      }
    }
    const cache = new HttpRangeCache({ fetch, chunkSize: 10 })
    const results = await Promise.all([
      cache.getRange('foo', 4, 10),
      cache.getRange('foo', 0, 1),
      cache.getRange('bar', 0, 5),
      cache.getRange('foo', 80, 10),
    ])
    await promisify(setTimeout)(150)
    const got2 = await cache.getRange('foo', 0, 3)
    const got3 = await cache.getRange('foo', 400, 10)
    expect(JSON.parse(JSON.stringify(results.map(r => r.buffer)))).toEqual([
      [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      [0],
      [1000, 1001, 1002, 1003, 1004],
      [80, 81, 82, 83, 84, 85, 86, 87, 88, 89],
    ])
    expect(got2.headers).toEqual({
      'content-length': 2,
      'content-range': '0-1/501',
      'x-resource-length': '501',
    })
    expect(got2.buffer).toEqual([0, 1, 2])
    expect(got3.buffer).toEqual([
      400,
      401,
      402,
      403,
      404,
      405,
      406,
      407,
      408,
      409,
    ])
    expect(await cache.stat('foo')).toEqual({ size: 501 })
    expect(calls).toEqual([['foo', 0, 90], ['bar', 0, 10], ['foo', 400, 410]])
    expect(await cache.stat('donk')).toEqual({ size: 501 })
    expect(calls).toEqual([
      ['foo', 0, 90],
      ['bar', 0, 10],
      ['foo', 400, 410],
      ['donk', 0, 1],
    ])
  })
})
