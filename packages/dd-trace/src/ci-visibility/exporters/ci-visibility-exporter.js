'use strict'

const URL = require('url').URL

const { sendGitMetadata: sendGitMetadataRequest } = require('./git/git_metadata')
const { getLibraryConfiguration: getLibraryConfigurationRequest } = require('../requests/get-library-configuration')
const { getSkippableSuites: getSkippableSuitesRequest } = require('../intelligent-test-runner/get-skippable-suites')
const { getKnownTests: getKnownTestsRequest } = require('../early-flake-detection/get-known-tests')
const { getTestManagementTests: getTestManagementTestsRequest } =
  require('../test-management/get-test-management-tests')
const log = require('../../log')
const AgentInfoExporter = require('../../exporters/common/agent-info-exporter')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../../plugins/util/tags')

function getTestConfigurationTags (tags) {
  if (!tags) {
    return {}
  }
  return Object.keys(tags).reduce((acc, key) => {
    if (key.startsWith('test.configuration.')) {
      const [, configKey] = key.split('test.configuration.')
      acc[configKey] = tags[key]
    }
    return acc
  }, {})
}

function getIsTestSessionTrace (trace) {
  return trace.some(span =>
    span.type === 'test_session_end' || span.type === 'test_suite_end' || span.type === 'test_module_end'
  )
}

const GIT_UPLOAD_TIMEOUT = 60_000 // 60 seconds
const CAN_USE_CI_VIS_PROTOCOL_TIMEOUT = GIT_UPLOAD_TIMEOUT

class CiVisibilityExporter extends AgentInfoExporter {
  constructor (config) {
    super(config)
    this._timer = undefined
    this._coverageTimer = undefined
    this._logsTimer = undefined
    this._coverageBuffer = []
    // The library can use new features like ITR and test suite level visibility
    // AKA CI Vis Protocol
    this._canUseCiVisProtocol = false

    const gitUploadTimeoutId = setTimeout(() => {
      this._resolveGit(new Error('Timeout while uploading git metadata'))
    }, GIT_UPLOAD_TIMEOUT).unref()

    const canUseCiVisProtocolTimeoutId = setTimeout(() => {
      this._resolveCanUseCiVisProtocol(false)
    }, CAN_USE_CI_VIS_PROTOCOL_TIMEOUT).unref()

    this._gitUploadPromise = new Promise(resolve => {
      this._resolveGit = (err) => {
        clearTimeout(gitUploadTimeoutId)
        resolve(err)
      }
    })

    this._canUseCiVisProtocolPromise = new Promise(resolve => {
      this._resolveCanUseCiVisProtocol = (canUseCiVisProtocol) => {
        clearTimeout(canUseCiVisProtocolTimeoutId)
        this._canUseCiVisProtocol = canUseCiVisProtocol
        resolve(canUseCiVisProtocol)
      }
    })

    process.once('beforeExit', () => {
      if (this._writer) {
        this._writer.flush()
      }
      if (this._coverageWriter) {
        this._coverageWriter.flush()
      }
      if (this._logsWriter) {
        this._logsWriter.flush()
      }
    })
  }

  shouldRequestSkippableSuites () {
    return !!(this._config.isIntelligentTestRunnerEnabled &&
      this._canUseCiVisProtocol &&
      this._libraryConfig?.isSuitesSkippingEnabled)
  }

  shouldRequestKnownTests () {
    return !!(
      this._canUseCiVisProtocol &&
      this._libraryConfig?.isKnownTestsEnabled
    )
  }

  shouldRequestTestManagementTests () {
    return !!(
      this._canUseCiVisProtocol &&
      this._config.isTestManagementEnabled &&
      this._libraryConfig?.isTestManagementEnabled
    )
  }

  shouldRequestLibraryConfiguration () {
    return this._config.isIntelligentTestRunnerEnabled
  }

  canReportSessionTraces () {
    return this._canUseCiVisProtocol
  }

  canReportCodeCoverage () {
    return this._canUseCiVisProtocol
  }

  getRequestConfiguration (testConfiguration) {
    return {
      url: this._getApiUrl(),
      env: this._config.env,
      service: this._config.service,
      isEvpProxy: !!this._isUsingEvpProxy,
      isGzipCompatible: this._isGzipCompatible,
      evpProxyPrefix: this.evpProxyPrefix,
      custom: getTestConfigurationTags(this._config.tags),
      ...testConfiguration
    }
  }

  // We can't call the skippable endpoint until git upload has finished,
  // hence the this._gitUploadPromise.then
  getSkippableSuites (testConfiguration, callback) {
    if (!this.shouldRequestSkippableSuites()) {
      return callback(null, [])
    }
    this._gitUploadPromise.then(gitUploadError => {
      if (gitUploadError) {
        return callback(gitUploadError, [])
      }
      getSkippableSuitesRequest(this.getRequestConfiguration(testConfiguration), callback)
    })
  }

  getKnownTests (testConfiguration, callback) {
    if (!this.shouldRequestKnownTests()) {
      return callback(null)
    }
    getKnownTestsRequest(this.getRequestConfiguration(testConfiguration), callback)
  }

  getTestManagementTests (testConfiguration, callback) {
    if (!this.shouldRequestTestManagementTests()) {
      return callback(null)
    }
    getTestManagementTestsRequest(this.getRequestConfiguration(testConfiguration), callback)
  }

  /**
   * We can't request library configuration until we know whether we can use the
   * CI Visibility Protocol, hence the this._canUseCiVisProtocol promise.
   */
  getLibraryConfiguration (testConfiguration, callback) {
    const { repositoryUrl } = testConfiguration
    this.sendGitMetadata(repositoryUrl)
    if (!this.shouldRequestLibraryConfiguration()) {
      return callback(null, {})
    }
    this._canUseCiVisProtocolPromise.then((canUseCiVisProtocol) => {
      if (!canUseCiVisProtocol) {
        return callback(null, {})
      }
      const configuration = this.getRequestConfiguration(testConfiguration)

      getLibraryConfigurationRequest(configuration, (err, libraryConfig) => {
        /**
         * **Important**: this._libraryConfig remains empty in testing frameworks
         * where the tests run in a subprocess, like Jest,
         * because `getLibraryConfiguration` is called only once in the main process.
         */
        this._libraryConfig = this.filterConfiguration(libraryConfig)

        if (err) {
          callback(err, {})
        } else if (libraryConfig?.requireGit) {
          // If the backend requires git, we'll wait for the upload to finish and request settings again
          this._gitUploadPromise.then(gitUploadError => {
            if (gitUploadError) {
              return callback(gitUploadError, {})
            }
            getLibraryConfigurationRequest(configuration, (err, finalLibraryConfig) => {
              this._libraryConfig = this.filterConfiguration(finalLibraryConfig)
              callback(err, this._libraryConfig)
            })
          })
        } else {
          callback(null, this._libraryConfig)
        }
      })
    })
  }

  // Takes into account potential kill switches
  filterConfiguration (remoteConfiguration) {
    if (!remoteConfiguration) {
      return {}
    }
    const {
      isCodeCoverageEnabled,
      isSuitesSkippingEnabled,
      isItrEnabled,
      requireGit,
      isEarlyFlakeDetectionEnabled,
      earlyFlakeDetectionNumRetries,
      earlyFlakeDetectionFaultyThreshold,
      isFlakyTestRetriesEnabled,
      isDiEnabled,
      isKnownTestsEnabled,
      isTestManagementEnabled,
      testManagementAttemptToFixRetries,
      isImpactedTestsEnabled
    } = remoteConfiguration
    return {
      isCodeCoverageEnabled,
      isSuitesSkippingEnabled,
      isItrEnabled,
      requireGit,
      isEarlyFlakeDetectionEnabled: isEarlyFlakeDetectionEnabled && this._config.isEarlyFlakeDetectionEnabled,
      earlyFlakeDetectionNumRetries,
      earlyFlakeDetectionFaultyThreshold,
      isFlakyTestRetriesEnabled: isFlakyTestRetriesEnabled && this._config.isFlakyTestRetriesEnabled,
      flakyTestRetriesCount: this._config.flakyTestRetriesCount,
      isDiEnabled: isDiEnabled && this._config.isTestDynamicInstrumentationEnabled,
      isKnownTestsEnabled,
      isTestManagementEnabled: isTestManagementEnabled && this._config.isTestManagementEnabled,
      testManagementAttemptToFixRetries:
        testManagementAttemptToFixRetries ?? this._config.testManagementAttemptToFixRetries,
      isImpactedTestsEnabled: isImpactedTestsEnabled && this._config.isImpactedTestsEnabled
    }
  }

  sendGitMetadata (repositoryUrl) {
    if (!this._config.isGitUploadEnabled) {
      return
    }
    this._canUseCiVisProtocolPromise.then((canUseCiVisProtocol) => {
      if (!canUseCiVisProtocol) {
        return
      }
      sendGitMetadataRequest(
        this._getApiUrl(),
        { isEvpProxy: !!this._isUsingEvpProxy, evpProxyPrefix: this.evpProxyPrefix },
        repositoryUrl,
        (err) => {
          if (err) {
            log.error('Error uploading git metadata: %s', err.message)
          } else {
            log.debug('Successfully uploaded git metadata')
          }
          this._resolveGit(err)
        }
      )
    })
  }

  export (trace) {
    // Until it's initialized, we just store the traces as is
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return
    }
    if (!this.canReportSessionTraces() && getIsTestSessionTrace(trace)) {
      return
    }
    this._export(trace)
  }

  exportCoverage (formattedCoverage) {
    // Until it's initialized, we just store the coverages as is
    if (!this._isInitialized) {
      this._coverageBuffer.push(formattedCoverage)
      return
    }
    if (!this.canReportCodeCoverage()) {
      return
    }

    this._export(formattedCoverage, this._coverageWriter, '_coverageTimer')
  }

  formatLogMessage (testConfiguration, logMessage) {
    const {
      [GIT_REPOSITORY_URL]: gitRepositoryUrl,
      [GIT_COMMIT_SHA]: gitCommitSha
    } = testConfiguration

    const { service, env, version } = this._config

    return {
      ddtags: [
        ...(logMessage.ddtags || []),
        `${GIT_REPOSITORY_URL}:${gitRepositoryUrl}`,
        `${GIT_COMMIT_SHA}:${gitCommitSha}`
      ].join(','),
      level: 'error',
      service,
      dd: {
        ...(logMessage.dd || []),
        service,
        env,
        version
      },
      ddsource: 'dd_debugger',
      ...logMessage
    }
  }

  // DI logs
  exportDiLogs (testConfiguration, logMessage) {
    // TODO: could we lose logs if it's not initialized?
    if (!this._config.isTestDynamicInstrumentationEnabled || !this._isInitialized || !this._canForwardLogs) {
      return
    }

    this._export(
      this.formatLogMessage(testConfiguration, logMessage),
      this._logsWriter,
      '_logsTimer'
    )
  }

  flush (done = () => {}) {
    if (!this._isInitialized) {
      return done()
    }

    // TODO: safe to do them at once? Or do we want to do them one by one?
    const writers = [
      this._writer,
      this._coverageWriter,
      this._logsWriter
    ].filter(Boolean)

    let remaining = writers.length

    if (remaining === 0) {
      return done()
    }

    const onFlushComplete = () => {
      remaining -= 1
      if (remaining === 0) {
        done()
      }
    }

    writers.forEach(writer => writer.flush(onFlushComplete))
  }

  exportUncodedCoverages () {
    this._coverageBuffer.forEach(oldCoveragePayload => {
      this.exportCoverage(oldCoveragePayload)
    })
    this._coverageBuffer = []
  }

  _setUrl (url, coverageUrl = url) {
    try {
      url = new URL(url)
      coverageUrl = new URL(coverageUrl)
      this._url = url
      this._coverageUrl = coverageUrl
      this._writer.setUrl(url)
      this._coverageWriter.setUrl(coverageUrl)
    } catch (e) {
      log.error('Error setting CI exporter url', e)
    }
  }

  _getApiUrl () {
    return this._url
  }

  // By the time addMetadataTags is called, the agent info request might not have finished
  addMetadataTags (tags) {
    if (this._writer?.addMetadataTags) {
      this._writer.addMetadataTags(tags)
    } else {
      this._canUseCiVisProtocolPromise.then(() => {
        if (this._writer?.addMetadataTags) {
          this._writer.addMetadataTags(tags)
        }
      })
    }
  }
}

module.exports = CiVisibilityExporter
