'use strict'
const request = require('../../../exporters/common/request')
const { safeJSONStringify } = require('../../../exporters/common/util')
const log = require('../../../log')
const { getEnvironmentVariable } = require('../../../config-helper')

const { AgentlessCiVisibilityEncoder } = require('../../../encode/agentless-ci-visibility')
const BaseWriter = require('../../../exporters/common/writer')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS,
  TELEMETRY_ENDPOINT_PAYLOAD_BYTES,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
  TELEMETRY_ENDPOINT_PAYLOAD_DROPPED
} = require('../../../ci-visibility/telemetry')

class Writer extends BaseWriter {
  constructor ({ url, tags, evpProxyPrefix = '' }) {
    super(...arguments)
    const { 'runtime-id': runtimeId, env, service } = tags
    this._url = url
    this._encoder = new AgentlessCiVisibilityEncoder(this, { runtimeId, env, service })
    this._evpProxyPrefix = evpProxyPrefix
  }

  _sendPayload (data, _, done) {
    const options = {
      path: '/api/v2/citestcycle',
      method: 'POST',
      headers: {
        'dd-api-key': getEnvironmentVariable('DD_API_KEY'),
        'Content-Type': 'application/msgpack'
      },
      timeout: 15_000,
      url: this._url
    }

    if (this._evpProxyPrefix) {
      options.path = `${this._evpProxyPrefix}/api/v2/citestcycle`
      delete options.headers['dd-api-key']
      options.headers['X-Datadog-EVP-Subdomain'] = 'citestcycle-intake'
    }

    log.debug(() => `Request to the intake: ${safeJSONStringify(options)}`)

    const startRequestTime = Date.now()

    incrementCountMetric(TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS, { endpoint: 'test_cycle' })
    distributionMetric(TELEMETRY_ENDPOINT_PAYLOAD_BYTES, { endpoint: 'test_cycle' }, Buffer.byteLength(data))

    request(data, options, (err, res, statusCode) => {
      distributionMetric(
        TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
        { endpoint: 'test_cycle' },
        Date.now() - startRequestTime
      )
      if (err) {
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
          { endpoint: 'test_cycle', statusCode }
        )
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
          { endpoint: 'test_cycle' }
        )
        log.error('Error sending CI agentless payload', err)
        done()
        return
      }
      log.debug('Response from the intake:', res)
      done()
    })
  }

  addMetadataTags (tags) {
    this._encoder.addMetadataTags(tags)
  }
}

module.exports = Writer
