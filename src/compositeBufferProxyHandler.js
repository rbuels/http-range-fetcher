/**
 * ES6 Proxy handler that makes an array of cached chunks
 * look like a single flat buffer
 */
class CompositeBuffer {
  /**
   *
   * @param {number} offset offset relative to the beginning of the first chunk
   * @param {number} chunkSize assumed size of each chunk
   */
  constructor(offset, chunkSize, length) {
    this._offset = offset
    this._chunkSize = chunkSize
    this._length = length
  }

  length() {
    return this._length
  }

  static get [Symbol.species]() {
    return this
  }
  static get [Symbol.isConcatSpreadable]() {
    return true
  }

  get(target, name) {
    if (name === 'length') return this.length(target)
    if (name === 'constructor') return CompositeBuffer.prototype.constructor

    if (
      name.charCodeAt &&
      name.charCodeAt(0) >= 48 &&
      name.charCodeAt(0) <= 57
    ) {
      // "name" has a number as the first char, so let's try to treat it like
      // an array index
      const index = parseInt(name, 10)
      if (index === Number.NaN) return undefined
      const offsetIndex = index + this._offset
      const chunkNumber = Math.floor(offsetIndex / this._chunkSize)
      const chunkIndex = offsetIndex - chunkNumber * this._chunkSize
      return target[chunkNumber][chunkIndex]
    }
    return undefined
  }
}

module.exports = CompositeBuffer
