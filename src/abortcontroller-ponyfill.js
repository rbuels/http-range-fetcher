/* eslint-disable */
if (typeof AbortController === 'undefined') {
  const {
    AbortController,
    AbortSignal,
  } = require('abortcontroller-polyfill/dist/cjs-ponyfill')
  module.exports = { AbortController, AbortSignal }
} else {
  module.exports = { AbortController, AbortSignal }
}
