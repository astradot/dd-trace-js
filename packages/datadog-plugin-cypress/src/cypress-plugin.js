'use strict'

const {
  TEST_STATUS,
  TEST_IS_RUM_ACTIVE,
  TEST_CODE_OWNERS,
  getTestEnvironmentMetadata,
  CI_APP_ORIGIN,
  getTestParentSpan,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  getTestCommonTags,
  getTestSessionCommonTags,
  getTestModuleCommonTags,
  getTestSuiteCommonTags,
  TEST_SUITE_ID,
  TEST_MODULE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_SOURCE_START,
  finishAllTraceSpans,
  getCoveredFilenamesFromCoverage,
  getTestSuitePath,
  addIntelligentTestRunnerSpanTags,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  ITR_CORRELATION_ID,
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  getTestSessionName,
  TEST_SESSION_NAME,
  TEST_LEVEL_EVENT_TYPES,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_HAS_FAILED_ALL_RETRIES,
  getLibraryCapabilitiesTags,
  TEST_RETRY_REASON_TYPES,
  getPullRequestDiff,
  getModifiedTestsFromDiff,
  TEST_IS_MODIFIED,
  getPullRequestBaseBranch
} = require('../../dd-trace/src/plugins/util/test')
const { isMarkedAsUnskippable } = require('../../datadog-plugin-jest/src/util')
const { ORIGIN_KEY, COMPONENT } = require('../../dd-trace/src/constants')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')
const { appClosing: appClosingTelemetry } = require('../../dd-trace/src/telemetry')
const log = require('../../dd-trace/src/log')

const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_ITR_FORCED_TO_RUN,
  TELEMETRY_CODE_COVERAGE_EMPTY,
  TELEMETRY_ITR_UNSKIPPABLE,
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_ITR_SKIPPED,
  TELEMETRY_TEST_SESSION
} = require('../../dd-trace/src/ci-visibility/telemetry')

const {
  GIT_REPOSITORY_URL,
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  CI_PROVIDER_NAME,
  CI_WORKSPACE_PATH,
  GIT_COMMIT_MESSAGE,
  GIT_TAG,
  GIT_PULL_REQUEST_BASE_BRANCH_SHA,
  GIT_COMMIT_HEAD_SHA,
  GIT_PULL_REQUEST_BASE_BRANCH,
  GIT_COMMIT_HEAD_MESSAGE
} = require('../../dd-trace/src/plugins/util/tags')
const {
  OS_VERSION,
  OS_PLATFORM,
  OS_ARCHITECTURE,
  RUNTIME_NAME,
  RUNTIME_VERSION
} = require('../../dd-trace/src/plugins/util/env')
const { DD_MAJOR } = require('../../../version')

const TEST_FRAMEWORK_NAME = 'cypress'

const CYPRESS_STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  skipped: 'skip'
}

function getSessionStatus (summary) {
  if (summary.totalFailed !== undefined && summary.totalFailed > 0) {
    return 'fail'
  }
  if (summary.totalSkipped !== undefined && summary.totalSkipped === summary.totalTests) {
    return 'skip'
  }
  return 'pass'
}

function getCypressVersion (details) {
  if (details?.cypressVersion) {
    return details.cypressVersion
  }
  if (details?.config?.version) {
    return details.config.version
  }
  return ''
}

function getRootDir (details) {
  if (details?.config) {
    return details.config.projectRoot || details.config.repoRoot || process.cwd()
  }
  return process.cwd()
}

function getCypressCommand (details) {
  if (!details) {
    return TEST_FRAMEWORK_NAME
  }
  return `${TEST_FRAMEWORK_NAME} ${details.specPattern || ''}`
}

function getLibraryConfiguration (tracer, testConfiguration) {
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getLibraryConfiguration) {
      return resolve({ err: new Error('Test Optimization was not initialized correctly') })
    }

    tracer._tracer._exporter.getLibraryConfiguration(testConfiguration, (err, libraryConfig) => {
      resolve({ err, libraryConfig })
    })
  })
}

function getSkippableTests (tracer, testConfiguration) {
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getSkippableSuites) {
      return resolve({ err: new Error('Test Optimization was not initialized correctly') })
    }
    tracer._tracer._exporter.getSkippableSuites(testConfiguration, (err, skippableTests, correlationId) => {
      resolve({
        err,
        skippableTests,
        correlationId
      })
    })
  })
}

function getKnownTests (tracer, testConfiguration) {
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getKnownTests) {
      return resolve({ err: new Error('Test Optimization was not initialized correctly') })
    }
    tracer._tracer._exporter.getKnownTests(testConfiguration, (err, knownTests) => {
      resolve({
        err,
        knownTests
      })
    })
  })
}

function getTestManagementTests (tracer, testConfiguration) {
  return new Promise(resolve => {
    if (!tracer._tracer._exporter?.getTestManagementTests) {
      return resolve({ err: new Error('Test Optimization was not initialized correctly') })
    }
    tracer._tracer._exporter.getTestManagementTests(testConfiguration, (err, testManagementTests) => {
      resolve({
        err,
        testManagementTests
      })
    })
  })
}

function getModifiedTests (testEnvironmentMetadata) {
  const {
    [GIT_PULL_REQUEST_BASE_BRANCH]: pullRequestBaseBranch,
    [GIT_PULL_REQUEST_BASE_BRANCH_SHA]: pullRequestBaseBranchSha,
    [GIT_COMMIT_HEAD_SHA]: commitHeadSha
  } = testEnvironmentMetadata

  const baseBranchSha = pullRequestBaseBranchSha || getPullRequestBaseBranch(pullRequestBaseBranch)

  if (baseBranchSha) {
    const diff = getPullRequestDiff(baseBranchSha, commitHeadSha)
    const modifiedTests = getModifiedTestsFromDiff(diff)
    if (modifiedTests) {
      return modifiedTests
    }
  }

  throw new Error('Modified tests could not be retrieved')
}

function getSuiteStatus (suiteStats) {
  if (!suiteStats) {
    return 'skip'
  }
  if (suiteStats.failures !== undefined && suiteStats.failures > 0) {
    return 'fail'
  }
  if (suiteStats.tests !== undefined &&
    (suiteStats.tests === suiteStats.pending || suiteStats.tests === suiteStats.skipped)) {
    return 'skip'
  }
  return 'pass'
}

class CypressPlugin {
  _isInit = false
  testEnvironmentMetadata = getTestEnvironmentMetadata(TEST_FRAMEWORK_NAME)

  finishedTestsByFile = {}
  testStatuses = {}

  isTestsSkipped = false
  isSuitesSkippingEnabled = false
  isCodeCoverageEnabled = false
  isFlakyTestRetriesEnabled = false
  isEarlyFlakeDetectionEnabled = false
  isKnownTestsEnabled = false
  earlyFlakeDetectionNumRetries = 0
  testsToSkip = []
  skippedTests = []
  hasForcedToRunSuites = false
  hasUnskippableSuites = false
  unskippableSuites = []
  knownTests = []
  isTestManagementTestsEnabled = false
  testManagementAttemptToFixRetries = 0
  isImpactedTestsEnabled = false
  modifiedTests = []

  constructor () {
    const {
      [GIT_REPOSITORY_URL]: repositoryUrl,
      [GIT_COMMIT_SHA]: sha,
      [OS_VERSION]: osVersion,
      [OS_PLATFORM]: osPlatform,
      [OS_ARCHITECTURE]: osArchitecture,
      [RUNTIME_NAME]: runtimeName,
      [RUNTIME_VERSION]: runtimeVersion,
      [GIT_BRANCH]: branch,
      [CI_PROVIDER_NAME]: ciProviderName,
      [CI_WORKSPACE_PATH]: repositoryRoot,
      [GIT_COMMIT_MESSAGE]: commitMessage,
      [GIT_TAG]: tag,
      [GIT_PULL_REQUEST_BASE_BRANCH_SHA]: pullRequestBaseSha,
      [GIT_COMMIT_HEAD_SHA]: commitHeadSha,
      [GIT_COMMIT_HEAD_MESSAGE]: commitHeadMessage
    } = this.testEnvironmentMetadata

    this.repositoryRoot = repositoryRoot || process.cwd()
    this.ciProviderName = ciProviderName
    this.codeOwnersEntries = getCodeOwnersFileEntries(repositoryRoot)

    this.testConfiguration = {
      repositoryUrl,
      sha,
      osVersion,
      osPlatform,
      osArchitecture,
      runtimeName,
      runtimeVersion,
      branch,
      testLevel: 'test',
      commitMessage,
      tag,
      pullRequestBaseSha,
      commitHeadSha,
      commitHeadMessage
    }
  }

  // Init function returns a promise that resolves with the Cypress configuration
  // Depending on the received configuration, the Cypress configuration can be modified:
  // for example, to enable retries for failed tests.
  init (tracer, cypressConfig) {
    this._isInit = true
    this.tracer = tracer
    this.cypressConfig = cypressConfig

    // we have to do it here because the tracer is not initialized in the constructor
    this.testEnvironmentMetadata[DD_TEST_IS_USER_PROVIDED_SERVICE] =
      tracer._tracer._config.isServiceUserProvided ? 'true' : 'false'

    this.libraryConfigurationPromise = getLibraryConfiguration(this.tracer, this.testConfiguration)
      .then((libraryConfigurationResponse) => {
        if (libraryConfigurationResponse.err) {
          log.error('Cypress plugin library config response error', libraryConfigurationResponse.err)
        } else {
          const {
            libraryConfig: {
              isSuitesSkippingEnabled,
              isCodeCoverageEnabled,
              isEarlyFlakeDetectionEnabled,
              earlyFlakeDetectionNumRetries,
              isFlakyTestRetriesEnabled,
              flakyTestRetriesCount,
              isKnownTestsEnabled,
              isTestManagementEnabled,
              testManagementAttemptToFixRetries,
              isImpactedTestsEnabled
            }
          } = libraryConfigurationResponse
          this.isSuitesSkippingEnabled = isSuitesSkippingEnabled
          this.isCodeCoverageEnabled = isCodeCoverageEnabled
          this.isEarlyFlakeDetectionEnabled = isEarlyFlakeDetectionEnabled
          this.earlyFlakeDetectionNumRetries = earlyFlakeDetectionNumRetries
          this.isKnownTestsEnabled = isKnownTestsEnabled
          if (isFlakyTestRetriesEnabled) {
            this.isFlakyTestRetriesEnabled = true
            this.cypressConfig.retries.runMode = flakyTestRetriesCount
          }
          this.isTestManagementTestsEnabled = isTestManagementEnabled
          this.testManagementAttemptToFixRetries = testManagementAttemptToFixRetries
          this.isImpactedTestsEnabled = isImpactedTestsEnabled
        }
        return this.cypressConfig
      })
    return this.libraryConfigurationPromise
  }

  getIsTestModified (testSuiteAbsolutePath) {
    const relativeTestSuitePath = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
    if (!this.modifiedTests) {
      return false
    }
    const lines = this.modifiedTests[relativeTestSuitePath]
    if (!lines) {
      return false
    }
    return lines.length > 0
  }

  getTestSuiteProperties (testSuite) {
    return this.testManagementTests?.cypress?.suites?.[testSuite]?.tests || {}
  }

  getTestProperties (testSuite, testName) {
    const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } =
      this.getTestSuiteProperties(testSuite)?.[testName]?.properties || {}

    return { isAttemptToFix, isDisabled, isQuarantined }
  }

  getTestSuiteSpan ({ testSuite, testSuiteAbsolutePath }) {
    const testSuiteSpanMetadata =
      getTestSuiteCommonTags(this.command, this.frameworkVersion, testSuite, TEST_FRAMEWORK_NAME)

    this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')

    if (testSuiteAbsolutePath) {
      const testSourceFile = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      testSuiteSpanMetadata[TEST_SOURCE_FILE] = testSourceFile
      testSuiteSpanMetadata[TEST_SOURCE_START] = 1
      const codeOwners = this.getTestCodeOwners({ testSuite, testSourceFile })
      if (codeOwners) {
        testSuiteSpanMetadata[TEST_CODE_OWNERS] = codeOwners
      }
    }

    return this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_suite`, {
      childOf: this.testModuleSpan,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...this.testEnvironmentMetadata,
        ...testSuiteSpanMetadata
      },
      integrationName: TEST_FRAMEWORK_NAME
    })
  }

  getTestSpan ({ testName, testSuite, isUnskippable, isForcedToRun, testSourceFile, isDisabled, isQuarantined }) {
    const testSuiteTags = {
      [TEST_COMMAND]: this.command,
      [TEST_COMMAND]: this.command,
      [TEST_MODULE]: TEST_FRAMEWORK_NAME
    }
    if (this.testSuiteSpan) {
      testSuiteTags[TEST_SUITE_ID] = this.testSuiteSpan.context().toSpanId()
    }
    if (this.testSessionSpan && this.testModuleSpan) {
      testSuiteTags[TEST_SESSION_ID] = this.testSessionSpan.context().toTraceId()
      testSuiteTags[TEST_MODULE_ID] = this.testModuleSpan.context().toSpanId()
      // If testSuiteSpan couldn't be created, we'll use the testModuleSpan as the parent
      if (!this.testSuiteSpan) {
        testSuiteTags[TEST_SUITE_ID] = this.testModuleSpan.context().toSpanId()
      }
    }

    const childOf = getTestParentSpan(this.tracer)
    const {
      resource,
      ...testSpanMetadata
    } = getTestCommonTags(testName, testSuite, this.cypressConfig.version, TEST_FRAMEWORK_NAME)

    if (testSourceFile) {
      testSpanMetadata[TEST_SOURCE_FILE] = testSourceFile
    }

    const codeOwners = this.getTestCodeOwners({ testSuite, testSourceFile })
    if (codeOwners) {
      testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    if (isUnskippable) {
      this.hasUnskippableSuites = true
      incrementCountMetric(TELEMETRY_ITR_UNSKIPPABLE, { testLevel: 'suite' })
      testSpanMetadata[TEST_ITR_UNSKIPPABLE] = 'true'
    }

    if (isForcedToRun) {
      this.hasForcedToRunSuites = true
      incrementCountMetric(TELEMETRY_ITR_FORCED_TO_RUN, { testLevel: 'suite' })
      testSpanMetadata[TEST_ITR_FORCED_RUN] = 'true'
    }

    if (isDisabled) {
      testSpanMetadata[TEST_MANAGEMENT_IS_DISABLED] = 'true'
    }

    if (isQuarantined) {
      testSpanMetadata[TEST_MANAGEMENT_IS_QUARANTINED] = 'true'
    }

    this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'test', { hasCodeOwners: !!codeOwners })

    return this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test`, {
      childOf,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        [ORIGIN_KEY]: CI_APP_ORIGIN,
        ...testSpanMetadata,
        ...this.testEnvironmentMetadata,
        ...testSuiteTags
      },
      integrationName: TEST_FRAMEWORK_NAME
    })
  }

  ciVisEvent (name, testLevel, tags = {}) {
    incrementCountMetric(name, {
      testLevel,
      testFramework: 'cypress',
      isUnsupportedCIProvider: !this.ciProviderName,
      ...tags
    })
  }

  async beforeRun (details) {
    // We need to make sure that the plugin is initialized before running the tests
    // This is for the case where the user has not returned the promise from the init function
    await this.libraryConfigurationPromise
    this.command = getCypressCommand(details)
    this.frameworkVersion = getCypressVersion(details)
    this.rootDir = getRootDir(details)

    if (this.isKnownTestsEnabled) {
      const knownTestsResponse = await getKnownTests(
        this.tracer,
        this.testConfiguration
      )
      if (knownTestsResponse.err) {
        log.error('Cypress known tests response error', knownTestsResponse.err)
        this.isEarlyFlakeDetectionEnabled = false
        this.isKnownTestsEnabled = false
      } else {
        // We use TEST_FRAMEWORK_NAME for the name of the module
        this.knownTestsByTestSuite = knownTestsResponse.knownTests[TEST_FRAMEWORK_NAME]
      }
    }

    if (this.isSuitesSkippingEnabled) {
      const skippableTestsResponse = await getSkippableTests(
        this.tracer,
        this.testConfiguration
      )
      if (skippableTestsResponse.err) {
        log.error('Cypress skippable tests response error', skippableTestsResponse.err)
      } else {
        const { skippableTests, correlationId } = skippableTestsResponse
        this.testsToSkip = skippableTests || []
        this.itrCorrelationId = correlationId
        incrementCountMetric(TELEMETRY_ITR_SKIPPED, { testLevel: 'test' }, this.testsToSkip.length)
      }
    }

    if (this.isTestManagementTestsEnabled) {
      const testManagementTestsResponse = await getTestManagementTests(
        this.tracer,
        this.testConfiguration
      )
      if (testManagementTestsResponse.err) {
        log.error('Cypress test management tests response error', testManagementTestsResponse.err)
        this.isTestManagementTestsEnabled = false
      } else {
        this.testManagementTests = testManagementTestsResponse.testManagementTests
      }
    }

    if (this.isImpactedTestsEnabled) {
      try {
        this.modifiedTests = getModifiedTests(this.testEnvironmentMetadata)
      } catch (error) {
        log.error(error)
        this.isImpactedTestsEnabled = false
      }
    }

    // `details.specs` are test files
    details.specs?.forEach(({ absolute, relative }) => {
      const isUnskippableSuite = isMarkedAsUnskippable({ path: absolute })
      if (isUnskippableSuite) {
        this.unskippableSuites.push(relative)
      }
    })

    const childOf = getTestParentSpan(this.tracer)

    const testSessionSpanMetadata =
      getTestSessionCommonTags(this.command, this.frameworkVersion, TEST_FRAMEWORK_NAME)
    const testModuleSpanMetadata =
      getTestModuleCommonTags(this.command, this.frameworkVersion, TEST_FRAMEWORK_NAME)

    if (this.isEarlyFlakeDetectionEnabled) {
      testSessionSpanMetadata[TEST_EARLY_FLAKE_ENABLED] = 'true'
    }

    const trimmedCommand = DD_MAJOR < 6 ? this.command : 'cypress run'

    const testSessionName = getTestSessionName(
      this.tracer._tracer._config,
      trimmedCommand,
      this.testEnvironmentMetadata
    )

    if (this.tracer._tracer._exporter?.addMetadataTags) {
      const metadataTags = {}
      for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
        metadataTags[testLevel] = {
          [TEST_SESSION_NAME]: testSessionName
        }
      }
      const libraryCapabilitiesTags = getLibraryCapabilitiesTags(this.constructor.id, false, this.frameworkVersion)
      metadataTags.test = {
        ...metadataTags.test,
        ...libraryCapabilitiesTags
      }

      this.tracer._tracer._exporter.addMetadataTags(metadataTags)
    }

    this.testSessionSpan = this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_session`, {
      childOf,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...this.testEnvironmentMetadata,
        ...testSessionSpanMetadata
      },
      integrationName: TEST_FRAMEWORK_NAME
    })
    this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'session')

    this.testModuleSpan = this.tracer.startSpan(`${TEST_FRAMEWORK_NAME}.test_module`, {
      childOf: this.testSessionSpan,
      tags: {
        [COMPONENT]: TEST_FRAMEWORK_NAME,
        ...this.testEnvironmentMetadata,
        ...testModuleSpanMetadata
      },
      integrationName: TEST_FRAMEWORK_NAME
    })
    this.ciVisEvent(TELEMETRY_EVENT_CREATED, 'module')

    return details
  }

  afterRun (suiteStats) {
    if (!this._isInit) {
      log.warn('Attemping to call afterRun without initializating the plugin first')
      return
    }
    if (this.testSessionSpan && this.testModuleSpan) {
      const testStatus = getSessionStatus(suiteStats)
      this.testModuleSpan.setTag(TEST_STATUS, testStatus)
      this.testSessionSpan.setTag(TEST_STATUS, testStatus)

      addIntelligentTestRunnerSpanTags(
        this.testSessionSpan,
        this.testModuleSpan,
        {
          isSuitesSkipped: this.isTestsSkipped,
          isSuitesSkippingEnabled: this.isSuitesSkippingEnabled,
          isCodeCoverageEnabled: this.isCodeCoverageEnabled,
          skippingType: 'test',
          skippingCount: this.skippedTests.length,
          hasForcedToRunSuites: this.hasForcedToRunSuites,
          hasUnskippableSuites: this.hasUnskippableSuites
        }
      )

      if (this.isTestManagementTestsEnabled) {
        this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
      }

      this.testModuleSpan.finish()
      this.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      incrementCountMetric(TELEMETRY_TEST_SESSION, {
        provider: this.ciProviderName,
        autoInjected: !!getEnvironmentVariable('DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER')
      })

      finishAllTraceSpans(this.testSessionSpan)
    }

    return new Promise(resolve => {
      const exporter = this.tracer._tracer._exporter
      if (!exporter) {
        return resolve(null)
      }
      if (exporter.flush) {
        exporter.flush(() => {
          appClosingTelemetry()
          resolve(null)
        })
      } else if (exporter._writer) {
        exporter._writer.flush(() => {
          appClosingTelemetry()
          resolve(null)
        })
      }
    })
  }

  afterSpec (spec, results) {
    const { tests, stats } = results || {}
    const cypressTests = tests || []
    const finishedTests = this.finishedTestsByFile[spec.relative] || []

    if (!this.testSuiteSpan) {
      // dd:testSuiteStart hasn't been triggered for whatever reason
      // We will create the test suite span on the spot if that's the case
      log.warn('There was an error creating the test suite event.')
      this.testSuiteSpan = this.getTestSuiteSpan({
        testSuite: spec.relative,
        testSuiteAbsolutePath: spec.absolute
      })
    }

    // Get tests that didn't go through `dd:afterEach`
    // and create a skipped test span for each of them
    cypressTests.filter(({ title }) => {
      const cypressTestName = title.join(' ')
      const isTestFinished = finishedTests.find(({ testName }) => cypressTestName === testName)

      return !isTestFinished
    }).forEach(({ title }) => {
      const cypressTestName = title.join(' ')
      const isSkippedByItr = this.testsToSkip.find(test =>
        cypressTestName === test.name && spec.relative === test.suite
      )
      const testSourceFile = spec.absolute && this.repositoryRoot
        ? getTestSuitePath(spec.absolute, this.repositoryRoot)
        : spec.relative

      const skippedTestSpan = this.getTestSpan({ testName: cypressTestName, testSuite: spec.relative, testSourceFile })

      skippedTestSpan.setTag(TEST_STATUS, 'skip')
      if (isSkippedByItr) {
        skippedTestSpan.setTag(TEST_SKIPPED_BY_ITR, 'true')
      }
      if (this.itrCorrelationId) {
        skippedTestSpan.setTag(ITR_CORRELATION_ID, this.itrCorrelationId)
      }

      const { isDisabled, isQuarantined } = this.getTestProperties(spec.relative, cypressTestName)

      if (isDisabled) {
        skippedTestSpan.setTag(TEST_MANAGEMENT_IS_DISABLED, 'true')
      } else if (isQuarantined) {
        skippedTestSpan.setTag(TEST_MANAGEMENT_IS_QUARANTINED, 'true')
      }

      skippedTestSpan.finish()
    })

    // Make sure that reported test statuses are the same as Cypress reports.
    // This is not always the case, such as when an `after` hook fails:
    // Cypress will report the last run test as failed, but we don't know that yet at `dd:afterEach`
    let latestError

    const finishedTestsByTestName = finishedTests.reduce((acc, finishedTest) => {
      if (!acc[finishedTest.testName]) {
        acc[finishedTest.testName] = []
      }
      acc[finishedTest.testName].push(finishedTest)
      return acc
    }, {})

    Object.entries(finishedTestsByTestName).forEach(([testName, finishedTestAttempts]) => {
      finishedTestAttempts.forEach((finishedTest, attemptIndex) => {
        // TODO: there could be multiple if there have been retries!
        // potentially we need to match the test status!
        const cypressTest = cypressTests.find(test => test.title.join(' ') === testName)
        if (!cypressTest) {
          return
        }
        // finishedTests can include multiple tests with the same name if they have been retried
        // by early flake detection. Cypress is unaware of this so .attempts does not necessarily have
        // the same length as `finishedTestAttempts`
        let cypressTestStatus = CYPRESS_STATUS_TO_TEST_STATUS[cypressTest.state]
        if (cypressTest.attempts && cypressTest.attempts[attemptIndex]) {
          cypressTestStatus = CYPRESS_STATUS_TO_TEST_STATUS[cypressTest.attempts[attemptIndex].state]
          const isAtrRetry = attemptIndex > 0 &&
            this.isFlakyTestRetriesEnabled &&
            !finishedTest.isAttemptToFix &&
            !finishedTest.isEfdRetry
          if (attemptIndex > 0) {
            finishedTest.testSpan.setTag(TEST_IS_RETRY, 'true')
            if (finishedTest.isEfdRetry) {
              finishedTest.testSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
            } else if (isAtrRetry) {
              finishedTest.testSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atr)
            } else {
              finishedTest.testSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.ext)
            }
          }
        }
        if (cypressTest.displayError) {
          latestError = new Error(cypressTest.displayError)
        }
        // Update test status
        if (cypressTestStatus !== finishedTest.testStatus) {
          finishedTest.testSpan.setTag(TEST_STATUS, cypressTestStatus)
          finishedTest.testSpan.setTag('error', latestError)
        }
        if (this.itrCorrelationId) {
          finishedTest.testSpan.setTag(ITR_CORRELATION_ID, this.itrCorrelationId)
        }
        const testSourceFile = spec.absolute && this.repositoryRoot
          ? getTestSuitePath(spec.absolute, this.repositoryRoot)
          : spec.relative
        if (testSourceFile) {
          finishedTest.testSpan.setTag(TEST_SOURCE_FILE, testSourceFile)
        }
        const codeOwners = this.getTestCodeOwners({ testSuite: spec.relative, testSourceFile })

        if (codeOwners) {
          finishedTest.testSpan.setTag(TEST_CODE_OWNERS, codeOwners)
        }

        finishedTest.testSpan.finish(finishedTest.finishTime)
      })
    })

    if (this.testSuiteSpan) {
      const status = getSuiteStatus(stats)
      this.testSuiteSpan.setTag(TEST_STATUS, status)

      if (latestError) {
        this.testSuiteSpan.setTag('error', latestError)
      }
      this.testSuiteSpan.finish()
      this.testSuiteSpan = null
      this.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
    }
  }

  getTasks () {
    return {
      'dd:testSuiteStart': ({ testSuite, testSuiteAbsolutePath }) => {
        const suitePayload = {
          isEarlyFlakeDetectionEnabled: this.isEarlyFlakeDetectionEnabled,
          knownTestsForSuite: this.knownTestsByTestSuite?.[testSuite] || [],
          earlyFlakeDetectionNumRetries: this.earlyFlakeDetectionNumRetries,
          isKnownTestsEnabled: this.isKnownTestsEnabled,
          isTestManagementEnabled: this.isTestManagementTestsEnabled,
          testManagementAttemptToFixRetries: this.testManagementAttemptToFixRetries,
          testManagementTests: this.getTestSuiteProperties(testSuite),
          isImpactedTestsEnabled: this.isImpactedTestsEnabled,
          isModifiedTest: this.getIsTestModified(testSuiteAbsolutePath),
          repositoryRoot: this.repositoryRoot
        }

        if (this.testSuiteSpan) {
          return suitePayload
        }
        this.testSuiteSpan = this.getTestSuiteSpan({ testSuite, testSuiteAbsolutePath })
        return suitePayload
      },
      'dd:beforeEach': (test) => {
        const { testName, testSuite } = test
        const shouldSkip = this.testsToSkip.some(test => {
          return testName === test.name && testSuite === test.suite
        })
        const isUnskippable = this.unskippableSuites.includes(testSuite)
        const isForcedToRun = shouldSkip && isUnskippable
        const { isAttemptToFix, isDisabled, isQuarantined } = this.getTestProperties(testSuite, testName)
        // skip test
        if (shouldSkip && !isUnskippable) {
          this.skippedTests.push(test)
          this.isTestsSkipped = true
          return { shouldSkip: true }
        }

        // TODO: I haven't found a way to trick cypress into ignoring a test
        // The way we'll implement quarantine in cypress is by skipping the test altogether
        if (!isAttemptToFix && (isDisabled || isQuarantined)) {
          return { shouldSkip: true }
        }

        if (!this.activeTestSpan) {
          this.activeTestSpan = this.getTestSpan({
            testName,
            testSuite,
            isUnskippable,
            isForcedToRun,
            isDisabled,
            isQuarantined
          })
        }

        return this.activeTestSpan ? { traceId: this.activeTestSpan.context().toTraceId() } : {}
      },
      'dd:afterEach': ({ test, coverage }) => {
        if (!this.activeTestSpan) {
          log.warn('There is no active test span in dd:afterEach handler')
          return null
        }
        const {
          state,
          error,
          isRUMActive,
          testSourceLine,
          testSuite,
          testSuiteAbsolutePath,
          testName,
          isNew,
          isEfdRetry,
          isAttemptToFix,
          isModified
        } = test
        if (coverage && this.isCodeCoverageEnabled && this.tracer._tracer._exporter?.exportCoverage) {
          const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
          const relativeCoverageFiles = [...coverageFiles, testSuiteAbsolutePath].map(
            file => getTestSuitePath(file, this.repositoryRoot || this.rootDir)
          )
          if (!relativeCoverageFiles.length) {
            incrementCountMetric(TELEMETRY_CODE_COVERAGE_EMPTY)
          }
          distributionMetric(TELEMETRY_CODE_COVERAGE_NUM_FILES, {}, relativeCoverageFiles.length)
          const { _traceId, _spanId } = this.testSuiteSpan.context()
          const formattedCoverage = {
            sessionId: _traceId,
            suiteId: _spanId,
            testId: this.activeTestSpan.context()._spanId,
            files: relativeCoverageFiles
          }
          this.tracer._tracer._exporter.exportCoverage(formattedCoverage)
        }
        const testStatus = CYPRESS_STATUS_TO_TEST_STATUS[state]
        this.activeTestSpan.setTag(TEST_STATUS, testStatus)

        // Save the test status to know if it has passed all retries
        if (this.testStatuses[testName]) {
          this.testStatuses[testName].push(testStatus)
        } else {
          this.testStatuses[testName] = [testStatus]
        }
        const testStatuses = this.testStatuses[testName]

        if (error) {
          this.activeTestSpan.setTag('error', error)
        }
        if (isRUMActive) {
          this.activeTestSpan.setTag(TEST_IS_RUM_ACTIVE, 'true')
        }
        if (testSourceLine) {
          this.activeTestSpan.setTag(TEST_SOURCE_START, testSourceLine)
        }
        if (isNew) {
          this.activeTestSpan.setTag(TEST_IS_NEW, 'true')
          if (isEfdRetry) {
            this.activeTestSpan.setTag(TEST_IS_RETRY, 'true')
            this.activeTestSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
          }
        }
        if (isModified) {
          this.activeTestSpan.setTag(TEST_IS_MODIFIED, 'true')
          if (isEfdRetry) {
            this.activeTestSpan.setTag(TEST_IS_RETRY, 'true')
            this.activeTestSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
          }
        }
        if (isAttemptToFix) {
          this.activeTestSpan.setTag(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX, 'true')
          if (testStatuses.length > 1) {
            this.activeTestSpan.setTag(TEST_IS_RETRY, 'true')
            this.activeTestSpan.setTag(TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atf)
          }
          const isLastAttempt = testStatuses.length === this.testManagementAttemptToFixRetries + 1
          if (isLastAttempt) {
            if (testStatuses.includes('fail')) {
              this.activeTestSpan.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
            }
            if (testStatuses.every(status => status === 'fail')) {
              this.activeTestSpan.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
            } else if (testStatuses.every(status => status === 'pass')) {
              this.activeTestSpan.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
            }
          }
        }

        const finishedTest = {
          testName,
          testStatus,
          finishTime: this.activeTestSpan._getTime(), // we store the finish time here
          testSpan: this.activeTestSpan,
          isEfdRetry,
          isAttemptToFix
        }
        if (this.finishedTestsByFile[testSuite]) {
          this.finishedTestsByFile[testSuite].push(finishedTest)
        } else {
          this.finishedTestsByFile[testSuite] = [finishedTest]
        }
        // test spans are finished at after:spec
        this.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
          hasCodeOwners: !!this.activeTestSpan.context()._tags[TEST_CODE_OWNERS],
          isNew,
          isRum: isRUMActive,
          browserDriver: 'cypress'
        })
        this.activeTestSpan = null

        return null
      },
      'dd:addTags': (tags) => {
        if (this.activeTestSpan) {
          this.activeTestSpan.addTags(tags)
        }
        return null
      }
    }
  }

  getTestCodeOwners ({ testSuite, testSourceFile }) {
    if (testSourceFile) {
      return getCodeOwnersForFilename(testSourceFile, this.codeOwnersEntries)
    }
    return getCodeOwnersForFilename(testSuite, this.codeOwnersEntries)
  }
}

module.exports = new CypressPlugin()
