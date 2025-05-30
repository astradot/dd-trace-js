'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { IAST_TRANSACTION_ID } = require('../iast-context')
const log = require('../../../log')

function taintObject (iastContext, object, type) {
  let result = object
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (transactionId) {
    const queue = [{ parent: null, property: null, value: object }]
    const visited = new WeakSet()

    while (queue.length > 0) {
      const { parent, property, value, key } = queue.pop()
      if (value === null) {
        continue
      }

      try {
        if (typeof value === 'string') {
          const tainted = TaintedUtils.newTaintedString(transactionId, value, property, type)
          if (parent) {
            parent[key] = tainted
          } else {
            result = tainted
          }
        } else if (typeof value === 'object' && !visited.has(value)) {
          visited.add(value)

          for (const key of Object.keys(value)) {
            queue.push({ parent: value, property: property ? `${property}.${key}` : key, value: value[key], key })
          }
        }
      } catch (e) {
        log.error('[ASM] Error in taintObject when visiting property : %s', property, e)
      }
    }
  }
  return result
}

module.exports = {
  taintObject
}
