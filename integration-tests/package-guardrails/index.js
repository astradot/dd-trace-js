'use strict'

try {
  const P = require('bluebird')

  const isWrapped = P.prototype._then.toString().includes('AsyncResource')

  // eslint-disable-next-line no-console
  console.log(isWrapped)
} catch (e) {
  const fastify = require('fastify')

  // eslint-disable-next-line no-console
  console.log(fastify.toString().startsWith('function fastifyWithTrace'))
}
if (global._ddtrace) {
  // eslint-disable-next-line no-console
  console.log('instrumentation source:', global._ddtrace._tracer._config.instrumentationSource)
}
