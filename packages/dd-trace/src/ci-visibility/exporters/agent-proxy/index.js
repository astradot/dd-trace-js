'use strict'

const AgentWriter = require('../../../exporters/agent/writer')
const AgentlessWriter = require('../agentless/writer')
const CoverageWriter = require('../agentless/coverage-writer')
const CiVisibilityExporter = require('../ci-visibility-exporter')

const AGENT_EVP_PROXY_PATH_PREFIX = '/evp_proxy/v'
const AGENT_EVP_PROXY_PATH_REGEX = /\/evp_proxy\/v(\d+)\/?/
const AGENT_DEBUGGER_INPUT = '/debugger/v1/input'

function getLatestEvpProxyVersion (err, agentInfo) {
  if (err) {
    return 0
  }
  return agentInfo.endpoints.reduce((acc, endpoint) => {
    if (endpoint.includes(AGENT_EVP_PROXY_PATH_PREFIX)) {
      const version = Number(endpoint.replace(AGENT_EVP_PROXY_PATH_REGEX, '$1'))
      if (Number.isNaN(version)) {
        return acc
      }
      return Math.max(version, acc)
    }
    return acc
  }, 0)
}

function getCanForwardDebuggerLogs (err, agentInfo) {
  return !err && agentInfo.endpoints.includes(AGENT_DEBUGGER_INPUT)
}

class AgentProxyCiVisibilityExporter extends CiVisibilityExporter {
  constructor (config) {
    super(config)

    const {
      tags,
      prioritySampler,
      lookup,
      protocolVersion,
      headers,
      isTestDynamicInstrumentationEnabled
    } = config

    this.getAgentInfo((err, agentInfo) => {
      this._isInitialized = true
      let latestEvpProxyVersion = getLatestEvpProxyVersion(err, agentInfo)
      const isEvpCompatible = latestEvpProxyVersion >= 2
      const isGzipCompatible = latestEvpProxyVersion >= 4

      // v3 does not work well citestcycle, so we downgrade to v2
      if (latestEvpProxyVersion === 3) {
        latestEvpProxyVersion = 2
      }

      const evpProxyPrefix = `${AGENT_EVP_PROXY_PATH_PREFIX}${latestEvpProxyVersion}`
      if (isEvpCompatible) {
        this._isUsingEvpProxy = true
        this.evpProxyPrefix = evpProxyPrefix
        this._writer = new AgentlessWriter({
          url: this._url,
          tags,
          evpProxyPrefix
        })
        this._coverageWriter = new CoverageWriter({
          url: this._url,
          evpProxyPrefix
        })
        if (isTestDynamicInstrumentationEnabled) {
          const canFowardLogs = getCanForwardDebuggerLogs(err, agentInfo)
          if (canFowardLogs) {
            const DynamicInstrumentationLogsWriter = require('../agentless/di-logs-writer')
            this._logsWriter = new DynamicInstrumentationLogsWriter({
              url: this._url,
              tags,
              isAgentProxy: true
            })
            this._canForwardLogs = true
          }
        }
      } else {
        this._writer = new AgentWriter({
          url: this._url,
          prioritySampler,
          lookup,
          protocolVersion,
          headers
        })
        // coverages will never be used, so we discard them
        this._coverageBuffer = []
      }
      this._resolveCanUseCiVisProtocol(isEvpCompatible)
      this.exportUncodedTraces()
      this.exportUncodedCoverages()
      this._isGzipCompatible = isGzipCompatible
    })
  }

  setUrl (url, coverageUrl) {
    this._setUrl(url, coverageUrl)
  }
}

module.exports = AgentProxyCiVisibilityExporter
