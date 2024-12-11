interface MyHeaders {
  expires: string
  date?: Date
  pragma: string
  'content-range'?: string
  'last-modified': string
  'cache-control': string
}

export interface ChunkResponse {
  buffer: Uint8Array
  headers?: MyHeaders
  requestDate: Date
  responseDate: Date
}

export function parseCacheControl(field: string) {
  if (typeof field !== 'string') {
    return {}
  }

  const parsed = {} as Record<string, string | number | boolean>
  const invalid = field.toLowerCase().replace(
    // eslint-disable-next-line no-control-regex
    /(?:^|(?:\s*,\s*))([^\x00-\x20\(\)<>@\,;\:\\"\/\[\]\?\=\{\}\x7F]+)(?:\=(?:([^\x00-\x20\(\)<>@\,;\:\\"\/\[\]\?\=\{\}\x7F]+)|(?:\"((?:[^"\\]|\\.)*)\")))?/g,
    (match, fieldName, three, four) => {
      const value = three || four
      parsed[fieldName] = value ? value.toLowerCase() : true
      return ''
    },
  )

  if (invalid) {
    return {}
  }

  // parse any things that seem to be numbers
  Object.keys(parsed).forEach(key => {
    if (/^[\d]+$/.test(`${parsed[key]}`)) {
      try {
        const num = parseInt(`${parsed[key]}`, 10)
        if (!Number.isNaN(num)) {
          parsed[key] = num
        }
      } catch (e) {
        /* ignore */
      }
    }
  })

  return parsed
}

export class CacheSemantics {
  minimumTTL: number
  constructor({ minimumTTL }: { minimumTTL: number }) {
    this.minimumTTL = minimumTTL
  }

  calculateChunkExpirationDate(chunkResponse: ChunkResponse) {
    const {
      headers = {} as MyHeaders,
      requestDate,
      responseDate,
    } = chunkResponse
    const { date, pragma } = headers
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    let baselineDate = responseDate || requestDate
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!baselineDate) {
      if (!date) {
        return undefined
      }
      baselineDate = new Date(date)
    }

    const basePlus = (ttl: number) => new Date(baselineDate.getTime() + ttl)

    // results that are not really cacheable expire after the minimum time to live
    if (/\bno-cache\b/.test(pragma || '')) {
      return basePlus(this.minimumTTL)
    }

    const cacheControl = parseCacheControl(headers['cache-control'] || '')
    if (
      cacheControl['no-cache'] ||
      cacheControl['no-store'] ||
      cacheControl['must-revalidate']
    ) {
      return basePlus(this.minimumTTL)
    }

    if (cacheControl['max-age'] !== undefined) {
      const ttl = +cacheControl['max-age'] * 1000 // max-age is in seconds
      return basePlus(Math.max(ttl, this.minimumTTL))
    } else if (this._coerceToDate(headers.expires)) {
      return this._coerceToDate(headers.expires)
    } else if (this._coerceToDate(headers['last-modified'])) {
      const lastModified = this._coerceToDate(headers['last-modified'])
      const ttl = (baselineDate.getTime() - (lastModified?.getTime() || 0)) / 10
      return basePlus(ttl)
    }

    // otherwise, we just cache forever
    return undefined
  }

  _coerceToDate(thing: Date | string | number) {
    if (thing) {
      if (thing instanceof Date) {
        return thing
      }
      if (typeof thing === 'string' || typeof thing === 'number') {
        return new Date(thing)
      }
    }
    return undefined
  }

  /**
   * check whether a cached chunk response is still valid and can be used
   */
  cachedChunkIsValid(chunkResponse: ChunkResponse) {
    const expiration = this.calculateChunkExpirationDate(chunkResponse)
    return !expiration || new Date() <= expiration
  }

  /**
   * check whether the response for this chunk fetch can be cached (always
   * returns true now)
   */
  chunkIsCacheable(_arg?: any) {
    // right now, we are caching everything, we just give it a very short
    // time to live if it's not supposed to be cached
    return true
  }
}
