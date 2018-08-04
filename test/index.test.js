const promisify = require('util.promisify')
const _ = require('lodash')
const { BufferCache } = require('../src/index')

describe('super duper cache', () => {
  jest.setTimeout(500)
  it(`can fetch a single chunk`, async () => {
    const fetch = async () => Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const cache = new BufferCache({ fetch })
    const got = await cache.get('http://foo.com/', 0, 10)
    expect(got[0]).toEqual(0)
    expect(got[9]).toEqual(9)
    expect(got.length).toEqual(10)
  })

  it('can fetch a bunch of things in a single aggregated call', async () => {
    const calls = []
    const fetch = async (url, start, end) => {
      calls.push([url, start, end])
      const add = url === 'bar' ? 1000 : 0
      return _.range(0, 500)
        .slice(start, end)
        .map(n => add + n)
    }
    const cache = new BufferCache({ fetch, chunkSize: 10 })
    const results = await Promise.all([
      cache.get('foo', 4, 10),
      cache.get('foo', 0, 1),
      cache.get('bar', 0, 5),
      cache.get('foo', 80, 10),
    ])
    await promisify(setTimeout)(150)
    const got2 = await cache.get('foo', 0, 3)
    const got3 = await cache.get('foo', 400, 10)
    expect(JSON.parse(JSON.stringify(results))).toEqual([
      [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      [0],
      [1000, 1001, 1002, 1003, 1004],
      [80, 81, 82, 83, 84, 85, 86, 87, 88, 89],
    ])
    expect(got2).toEqual([0, 1, 2])
    expect(got3).toEqual([400, 401, 402, 403, 404, 405, 406, 407, 408, 409])
    expect(calls).toEqual([['foo', 0, 90], ['bar', 0, 10], ['foo', 400, 410]])
  })
})
