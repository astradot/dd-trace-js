'use strict'

const shimmer = require('../../../../../../datadog-shimmer')
const { getIastContext } = require('../../iast-context')
const { KAFKA_MESSAGE_KEY, KAFKA_MESSAGE_VALUE } = require('../source-types')
const { newTaintedObject, newTaintedString } = require('../operations')
const { SourceIastPlugin } = require('../../iast-plugin')

class KafkaConsumerIastPlugin extends SourceIastPlugin {
  onConfigure () {
    this.addSub({ channelName: 'dd-trace:kafkajs:consumer:afterStart', tag: [KAFKA_MESSAGE_KEY, KAFKA_MESSAGE_VALUE] },
      ({ message, currentStore }) => this.taintKafkaMessage(message, currentStore)
    )
  }

  getToStringWrap (toString, iastContext, type) {
    return function () {
      const res = toString.apply(this, arguments)
      return newTaintedString(iastContext, res, undefined, type)
    }
  }

  taintKafkaMessage (message, currentStore) {
    const iastContext = getIastContext(currentStore)

    if (iastContext && message) {
      const { key, value } = message

      if (key !== null && typeof key === 'object') {
        shimmer.wrap(key, 'toString',
          toString => this.getToStringWrap(toString, iastContext, KAFKA_MESSAGE_KEY))

        newTaintedObject(iastContext, key, undefined, KAFKA_MESSAGE_KEY)
      }

      if (value !== null && typeof value === 'object') {
        shimmer.wrap(value, 'toString',
          toString => this.getToStringWrap(toString, iastContext, KAFKA_MESSAGE_VALUE))

        newTaintedObject(iastContext, value, undefined, KAFKA_MESSAGE_VALUE)
      }
    }
  }
}

module.exports = new KafkaConsumerIastPlugin()
