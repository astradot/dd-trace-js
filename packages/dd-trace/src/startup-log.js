'use strict'

const { info, warn } = require('./log/writer')

const os = require('os')
const { inspect } = require('util')
const tracerVersion = require('../../../package.json').version

const errors = {}
let config
let pluginManager
let samplingRules = []
let alreadyRan = false

function getIntegrationsAndAnalytics () {
  const integrations = new Set()
  const extras = {}
  for (const pluginName in pluginManager._pluginsByName) {
    integrations.add(pluginName)
  }
  extras.integrations_loaded = [...integrations]
  return extras
}

function startupLog ({ agentError } = {}) {
  if (!config || !pluginManager) {
    return
  }

  if (alreadyRan) {
    return
  }

  alreadyRan = true

  if (!config.startupLogs) {
    return
  }

  const out = tracerInfo({ agentError })

  if (agentError) {
    out.agent_error = agentError.message
  }

  info('DATADOG TRACER CONFIGURATION - ' + out)
  if (agentError) {
    warn('DATADOG TRACER DIAGNOSTIC - Agent Error: ' + agentError.message)
    errors.agentError = {
      code: agentError.code ?? '',
      message: `Agent Error:${agentError.message}`
    }
  }
}

function tracerInfo () {
  const url = config.url || `http://${config.hostname || 'localhost'}:${config.port}`

  const out = {
    [inspect.custom] () {
      return String(this)
    },
    toString () {
      return JSON.stringify(this)
    }
  }

  out.date = new Date().toISOString()
  out.os_name = os.type()
  out.os_version = os.release()
  out.architecture = os.arch()
  out.version = tracerVersion
  out.lang = 'nodejs'
  out.lang_version = process.versions.node
  out.env = config.env
  out.enabled = config.enabled
  out.service = config.service
  out.agent_url = url
  out.debug = !!config.debug
  out.sample_rate = config.sampler.sampleRate
  out.sampling_rules = samplingRules
  out.tags = config.tags
  if (config.tags && config.tags.version) {
    out.dd_version = config.tags.version
  }

  out.log_injection_enabled = !!config.logInjection
  out.runtime_metrics_enabled = !!config.runtimeMetrics
  const profilingEnabled = config.profiling?.enabled
  out.profiling_enabled = profilingEnabled === 'true' || profilingEnabled === 'auto'
  Object.assign(out, getIntegrationsAndAnalytics())

  out.appsec_enabled = !!config.appsec.enabled

  // // This next bunch is for features supported by other tracers, but not this
  // // one. They may be implemented in the future.

  // out.enabled_cli
  // out.sampling_rules_error
  // out.integration_XXX_analytics_enabled
  // out.integration_XXX_sample_rate
  // out.service_mapping
  // out.service_mapping_error

  return out
}

function setStartupLogConfig (aConfig) {
  config = aConfig
}

function setStartupLogPluginManager (thePluginManager) {
  pluginManager = thePluginManager
}

function setSamplingRules (theRules) {
  samplingRules = theRules
}

module.exports = {
  startupLog,
  setStartupLogConfig,
  setStartupLogPluginManager,
  setSamplingRules,
  tracerInfo,
  errors
}
