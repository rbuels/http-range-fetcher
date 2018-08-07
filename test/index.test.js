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
      const add = url === 'bar' ? 100 : 0
      return {
        headers: { 'content-range': `${start}-${end}/256` },
        responseDate: new Date(),
        buffer: Buffer.from(
          _.range(0, 256)
            .slice(start, end)
            .map(n => add + n),
        ),
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
    const got3 = await cache.getRange('foo', 200, 10)
    expect(JSON.parse(JSON.stringify(results.map(r => r.buffer)))).toEqual([
      [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      [0],
      [100, 101, 102, 103, 104],
      [80, 81, 82, 83, 84, 85, 86, 87, 88, 89],
    ])

    expect(got2.headers).toEqual({
      'content-length': 2,
      'content-range': '0-1/256',
      'x-resource-length': '256',
    })
    expect(got2.buffer).toEqual([0, 1, 2])

    // check that we can convert the butter to an arraybuffer OK
    const byteArray = new Uint8Array(toArrayBuffer(got2.buffer))
    expect(byteArray[0]).toEqual(0)
    expect(byteArray[1]).toEqual(1)
    expect(byteArray[2]).toEqual(2)
    expect(byteArray.length).toEqual(3)
    expect(Array.from(byteArray)).toEqual([0, 1, 2])

    expect(got3.buffer).toEqual([
      200,
      201,
      202,
      203,
      204,
      205,
      206,
      207,
      208,
      209,
    ])
    expect(await cache.stat('foo')).toEqual({ size: 256 })
    expect(calls).toEqual([['foo', 0, 90], ['bar', 0, 10], ['foo', 200, 210]])
    expect(await cache.stat('donk')).toEqual({ size: 256 })
    expect(calls).toEqual([
      ['foo', 0, 90],
      ['bar', 0, 10],
      ['foo', 200, 210],
      ['donk', 0, 1],
    ])
  })

  it('can fetch a whole file', async () => {
    const calls = []
    const fetch = async (url, start, end) => {
      calls.push([url, start, end])
      return {
        headers: { 'content-range': `${start}-${end}/20` },
        responseDate: new Date(),
        buffer: _.range(0, 20)
          .slice(start, end)
          .map(n => n),
      }
    }
    const cache = new HttpRangeCache({ fetch, chunkSize: 10 })
    const got2 = await cache.getRange('foo')
    expect(got2.buffer).toEqual(_.range(0, 20))
    expect(calls).toEqual([['foo', 0, 1], ['foo', 0, 20]])

    cache.reset()
    calls.length = 0

    const got = await cache.getRange('foo', 0, 20)
    expect(got.buffer).toEqual(_.range(0, 20))
    const got3 = await cache.getRange('foo')
    expect(got3.buffer).toEqual(_.range(0, 20))
    expect(calls).toEqual([['foo', 0, 20]])
  })
})
