'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: '@elastic/transport', file: 'lib/Transport.js', versions: ['>=8'] }, (exports) => {
  shimmer.wrap(exports.default.prototype, 'request', createWrapRequest('elasticsearch'))
  shimmer.wrap(exports.default.prototype, 'getConnection', createWrapGetConnection('elasticsearch'))
  return exports
})

addHook({ name: '@elastic/elasticsearch', file: 'lib/Transport.js', versions: ['>=5.6.16 <8', '>=8'] }, Transport => {
  shimmer.wrap(Transport.prototype, 'request', createWrapRequest('elasticsearch'))
  shimmer.wrap(Transport.prototype, 'getConnection', createWrapGetConnection('elasticsearch'))
  return Transport
})

addHook({ name: 'elasticsearch', file: 'src/lib/transport.js', versions: ['>=10'] }, Transport => {
  shimmer.wrap(Transport.prototype, 'request', createWrapRequest('elasticsearch'))
  return Transport
})

addHook({ name: 'elasticsearch', file: 'src/lib/connection_pool.js', versions: ['>=10'] }, ConnectionPool => {
  shimmer.wrap(ConnectionPool.prototype, 'select', createWrapSelect('elasticsearch'))
  return ConnectionPool
})

function createWrapGetConnection (name) {
  const connectCh = channel(`apm:${name}:query:connect`)
  return function wrapRequest (request) {
    return function () {
      const connection = request.apply(this, arguments)
      if (connectCh.hasSubscribers && connection && connection.url) {
        connectCh.publish(connection.url)
      }
      return connection
    }
  }
}

function createWrapSelect () {
  const connectCh = channel('apm:elasticsearch:query:connect')
  return function wrapRequest (request) {
    return function () {
      if (arguments.length === 1) {
        const cb = arguments[0]
        arguments[0] = shimmer.wrapFunction(cb, cb => function (err, connection) {
          if (connectCh.hasSubscribers && connection && connection.host) {
            connectCh.publish({ hostname: connection.host.host, port: connection.host.port })
          }
          cb(err, connection)
        })
      }
      return request.apply(this, arguments)
    }
  }
}

function createWrapRequest (name) {
  const startCh = channel(`apm:${name}:query:start`)
  const finishCh = channel(`apm:${name}:query:finish`)
  const errorCh = channel(`apm:${name}:query:error`)

  return function wrapRequest (request) {
    return function (params, options, cb) {
      if (!startCh.hasSubscribers) {
        return request.apply(this, arguments)
      }

      if (!params) return request.apply(this, arguments)

      const ctx = { params }
      return startCh.runStores(ctx, () => {
        try {
          const lastIndex = arguments.length - 1
          cb = arguments[lastIndex]

          if (typeof cb === 'function') {
            arguments[lastIndex] = shimmer.wrapFunction(cb, cb => function (error) {
              if (error) {
                ctx.error = error
                errorCh.publish(ctx)
              }
              return finishCh.runStores(ctx, cb, null, ...arguments)
            })
            return request.apply(this, arguments)
          }
          const promise = request.apply(this, arguments)
          if (promise && typeof promise.then === 'function') {
            const onResolve = () => finish(ctx)
            const onReject = e => finish(ctx, e)

            promise.then(onResolve, onReject)
          } else {
            finish(ctx)
          }
          return promise
        } catch (err) {
          err.stack // trigger getting the stack at the original throwing point
          errorCh.publish(err)

          throw err
        }
      })
    }
  }

  function finish (ctx, error) {
    if (error) {
      ctx.error = error
      errorCh.publish(error)
    }
    return finishCh.runStores(ctx, () => {})
  }
}

module.exports = { createWrapRequest, createWrapGetConnection }
