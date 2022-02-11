//@ts-nocheck
/* eslint-disable */

import {
  AbortController as ponyfillAbortController,
  AbortSignal as ponyfillAbortSignal,
} from 'abortcontroller-polyfill/dist/cjs-ponyfill'
var getGlobal = function () {
  // the only reliable means to get the global object is
  // `Function('return this')()`
  // However, this causes CSP violations in Chrome apps.
  if (typeof self !== 'undefined') {
    return self
  }
  if (typeof window !== 'undefined') {
    return window
  }
  if (typeof global !== 'undefined') {
    return global
  }
  throw new Error('unable to locate global object')
}

//@ts-ignore
let AbortController =
  typeof getGlobal().AbortController === 'undefined'
    ? ponyfillAbortController
    : getGlobal().AbortController
//@ts-ignore
let AbortSignal =
  typeof getGlobal().AbortController === 'undefined'
    ? ponyfillAbortSignal
    : getGlobal().AbortSignal

export { AbortController, AbortSignal }
