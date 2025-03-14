'use strict'

const constants = require('./constants')
const log = require('./log')
const ERROR_MESSAGE = constants.ERROR_MESSAGE
const ERROR_STACK = constants.ERROR_STACK
const ERROR_TYPE = constants.ERROR_TYPE

function add (carrier, keyValuePairs) {
  if (!carrier || !keyValuePairs) return

  if (Array.isArray(keyValuePairs)) {
    return keyValuePairs.forEach(tags => add(carrier, tags))
  }
  try {
    if (typeof keyValuePairs === 'string') {
      const segments = keyValuePairs.split(',')
      for (const segment of segments) {
        const separatorIndex = segment.indexOf(':')

        let value = ''
        let key = segment
        if (separatorIndex !== -1) {
          key = segment.slice(0, separatorIndex)
          value = segment.slice(separatorIndex + 1)
        }

        carrier[key.trim()] = value.trim()
      }
    } else {
      // HACK: to ensure otel.recordException does not influence trace.error
      if (ERROR_MESSAGE in keyValuePairs || ERROR_STACK in keyValuePairs || ERROR_TYPE in keyValuePairs) {
        if (!('doNotSetTraceError' in keyValuePairs)) {
          carrier.setTraceError = true
        }
      }
      Object.assign(carrier, keyValuePairs)
    }
  } catch (e) {
    log.error('Error adding tags', e)
  }
}

module.exports = { add }
