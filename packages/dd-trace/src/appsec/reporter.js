'use strict'

const Limiter = require('../rate_limiter')
const { storage } = require('../../../datadog-core')
const web = require('../plugins/util/web')
const { ipHeaderList } = require('../plugins/util/ip_extractor')
const {
  incrementWafInitMetric,
  incrementWafUpdatesMetric,
  incrementWafRequestsMetric,
  updateWafRequestsMetricTags,
  updateRaspRequestsMetricTags,
  updateRaspRuleSkippedMetricTags,
  updateRateLimitedMetric,
  getRequestMetrics
} = require('./telemetry')
const zlib = require('zlib')
const { keepTrace } = require('../priority_sampler')
const { ASM } = require('../standalone/product')

// default limiter, configurable with setRateLimit()
let limiter = new Limiter(100)

const metricsQueue = new Map()

// following header lists are ordered in the same way the spec orders them, it doesn't matter but it's easier to compare
const contentHeaderList = [
  'content-length',
  'content-type',
  'content-encoding',
  'content-language'
]

const EVENT_HEADERS_MAP = mapHeaderAndTags([
  ...ipHeaderList,
  'x-forwarded',
  'forwarded',
  'via',
  ...contentHeaderList,
  'host',
  'accept-encoding',
  'accept-language'
], 'http.request.headers.')

const identificationHeaders = [
  'x-amzn-trace-id',
  'cloudfront-viewer-ja3-fingerprint',
  'cf-ray',
  'x-cloud-trace-context',
  'x-appgw-trace-id',
  'x-sigsci-requestid',
  'x-sigsci-tags',
  'akamai-user-risk'
]

// these request headers are always collected - it breaks the expected spec orders
const REQUEST_HEADERS_MAP = mapHeaderAndTags([
  'content-type',
  'user-agent',
  'accept',
  ...identificationHeaders
], 'http.request.headers.')

const RESPONSE_HEADERS_MAP = mapHeaderAndTags(contentHeaderList, 'http.response.headers.')

function mapHeaderAndTags (headerList, tagPrefix) {
  return new Map(headerList.map(headerName => [headerName, `${tagPrefix}${formatHeaderName(headerName)}`]))
}

function filterHeaders (headers, map) {
  const result = {}

  if (!headers) return result

  for (const [headerName, tagName] of map) {
    const headerValue = headers[headerName]
    if (headerValue) {
      result[tagName] = '' + headerValue
    }
  }

  return result
}

function formatHeaderName (name) {
  return name
    .trim()
    .slice(0, 200)
    .replace(/[^a-zA-Z0-9_\-:/]/g, '_')
    .toLowerCase()
}

function reportWafInit (wafVersion, rulesVersion, diagnosticsRules = {}, success = false) {
  if (success) {
    metricsQueue.set('_dd.appsec.waf.version', wafVersion)

    metricsQueue.set('_dd.appsec.event_rules.loaded', diagnosticsRules.loaded?.length || 0)
    metricsQueue.set('_dd.appsec.event_rules.error_count', diagnosticsRules.failed?.length || 0)
    if (diagnosticsRules.failed?.length) {
      metricsQueue.set('_dd.appsec.event_rules.errors', JSON.stringify(diagnosticsRules.errors))
    }
  }

  incrementWafInitMetric(wafVersion, rulesVersion, success)
}

function reportMetrics (metrics, raspRule) {
  const store = storage('legacy').getStore()
  const rootSpan = store?.req && web.root(store.req)

  if (!rootSpan) return

  if (metrics.rulesVersion) {
    rootSpan.setTag('_dd.appsec.event_rules.version', metrics.rulesVersion)
  }

  if (raspRule) {
    updateRaspRequestsMetricTags(metrics, store.req, raspRule)
  } else {
    updateWafRequestsMetricTags(metrics, store.req)
  }

  reportTruncationMetrics(rootSpan, metrics)
}

function reportTruncationMetrics (rootSpan, metrics) {
  if (metrics.maxTruncatedString) {
    rootSpan.setTag('_dd.appsec.truncated.string_length', metrics.maxTruncatedString)
  }

  if (metrics.maxTruncatedContainerSize) {
    rootSpan.setTag('_dd.appsec.truncated.container_size', metrics.maxTruncatedContainerSize)
  }

  if (metrics.maxTruncatedContainerDepth) {
    rootSpan.setTag('_dd.appsec.truncated.container_depth', metrics.maxTruncatedContainerDepth)
  }
}

function reportAttack (attackData) {
  const store = storage('legacy').getStore()
  const req = store?.req
  const rootSpan = web.root(req)
  if (!rootSpan) return

  const currentTags = rootSpan.context()._tags

  const newTags = {
    'appsec.event': 'true'
  }

  if (limiter.isAllowed()) {
    keepTrace(rootSpan, ASM)
  } else {
    updateRateLimitedMetric(req)
  }

  // TODO: maybe add this to format.js later (to take decision as late as possible)
  if (!currentTags['_dd.origin']) {
    newTags['_dd.origin'] = 'appsec'
  }

  const currentJson = currentTags['_dd.appsec.json']

  // merge JSON arrays without parsing them
  if (currentJson) {
    newTags['_dd.appsec.json'] = currentJson.slice(0, -2) + ',' + attackData.slice(1) + '}'
  } else {
    newTags['_dd.appsec.json'] = '{"triggers":' + attackData + '}'
  }

  if (req.socket) {
    newTags['network.client.ip'] = req.socket.remoteAddress
  }

  rootSpan.addTags(newTags)
}

function isFingerprintDerivative (derivative) {
  return derivative.startsWith('_dd.appsec.fp')
}

function reportDerivatives (derivatives) {
  if (!derivatives) return

  const req = storage('legacy').getStore()?.req
  const rootSpan = web.root(req)

  if (!rootSpan) return

  const tags = {}
  for (let [tag, value] of Object.entries(derivatives)) {
    if (!isFingerprintDerivative(tag)) {
      const gzippedValue = zlib.gzipSync(JSON.stringify(value))
      value = gzippedValue.toString('base64')
    }
    tags[tag] = value
  }

  rootSpan.addTags(tags)
}

function finishRequest (req, res) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (metricsQueue.size) {
    rootSpan.addTags(Object.fromEntries(metricsQueue))

    keepTrace(rootSpan, ASM)

    metricsQueue.clear()
  }

  const metrics = getRequestMetrics(req)

  if (metrics?.duration) {
    rootSpan.setTag('_dd.appsec.waf.duration', metrics.duration)
  }

  if (metrics?.durationExt) {
    rootSpan.setTag('_dd.appsec.waf.duration_ext', metrics.durationExt)
  }

  if (metrics?.wafErrorCode) {
    rootSpan.setTag('_dd.appsec.waf.error', metrics.wafErrorCode)
  }

  if (metrics?.wafTimeouts) {
    rootSpan.setTag('_dd.appsec.waf.timeouts', metrics.wafTimeouts)
  }

  if (metrics?.raspDuration) {
    rootSpan.setTag('_dd.appsec.rasp.duration', metrics.raspDuration)
  }

  if (metrics?.raspDurationExt) {
    rootSpan.setTag('_dd.appsec.rasp.duration_ext', metrics.raspDurationExt)
  }

  if (metrics?.raspErrorCode) {
    rootSpan.setTag('_dd.appsec.rasp.error', metrics.raspErrorCode)
  }

  if (metrics?.raspTimeouts) {
    rootSpan.setTag('_dd.appsec.rasp.timeout', metrics.raspTimeouts)
  }

  if (metrics?.raspEvalCount) {
    rootSpan.setTag('_dd.appsec.rasp.rule.eval', metrics.raspEvalCount)
  }

  incrementWafRequestsMetric(req)

  // collect some headers even when no attack is detected
  const mandatoryTags = filterHeaders(req.headers, REQUEST_HEADERS_MAP)
  rootSpan.addTags(mandatoryTags)

  const tags = rootSpan.context()._tags
  if (!shouldCollectEventHeaders(tags)) return

  const newTags = filterHeaders(res.getHeaders(), RESPONSE_HEADERS_MAP)
  Object.assign(newTags, filterHeaders(req.headers, EVENT_HEADERS_MAP))

  if (tags['appsec.event'] === 'true' && typeof req.route?.path === 'string') {
    newTags['http.endpoint'] = req.route.path
  }

  rootSpan.addTags(newTags)
}

function shouldCollectEventHeaders (tags = {}) {
  if (tags['appsec.event'] === 'true') {
    return true
  }

  for (const tagName of Object.keys(tags)) {
    if (tagName.startsWith('appsec.events.')) {
      return true
    }
  }

  return false
}

function setRateLimit (rateLimit) {
  limiter = new Limiter(rateLimit)
}

module.exports = {
  metricsQueue,
  filterHeaders,
  formatHeaderName,
  reportWafInit,
  reportMetrics,
  reportAttack,
  reportWafUpdate: incrementWafUpdatesMetric,
  reportRaspRuleSkipped: updateRaspRuleSkippedMetricTags,
  reportDerivatives,
  finishRequest,
  setRateLimit,
  mapHeaderAndTags
}
