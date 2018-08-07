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

  _getConcatenation(target) {
    if (!this._concatenation) {
      let buffers = target
      if (this._offset) {
        buffers = [...target]
        buffers[0] = buffers[0].slice(this._offset)
      }
      this._concatenation = Buffer.concat(buffers).slice(0, this._length)
    }
    return this._concatenation
  }

  buffer(target) {
    return this._getConcatenation(target).buffer
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
    if (name === 'buffer') return this.buffer(target)
    if (name === 'byteOffset') return this._getConcatenation().byteOffset
    if (name === 'byteLength') return this._getConcatenation().byteLength

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
