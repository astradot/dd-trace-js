const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  getTestSessionName,
  getIsFaultyEarlyFlakeDetection,
  TEST_SOURCE_FILE,
  TEST_IS_RETRY,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_CODE_OWNERS,
  TEST_LEVEL_EVENT_TYPES,
  TEST_SESSION_NAME,
  TEST_SOURCE_START,
  TEST_IS_NEW,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_HAS_FAILED_ALL_RETRIES,
  getLibraryCapabilitiesTags,
  TEST_RETRY_REASON_TYPES
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_TEST_SESSION
} = require('../../dd-trace/src/ci-visibility/telemetry')

// Milliseconds that we subtract from the error test duration
// so that they do not overlap with the following test
// This is because there's some loss of resolution.
const MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION = 5

class VitestPlugin extends CiPlugin {
  static get id () {
    return 'vitest'
  }

  constructor (...args) {
    super(...args)

    this.taskToFinishTime = new WeakMap()

    this.addSub('ci:vitest:test:is-new', ({ knownTests, testSuiteAbsolutePath, testName, onDone }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const testsForThisTestSuite = knownTests[testSuite] || []
      onDone(!testsForThisTestSuite.includes(testName))
    })

    this.addSub('ci:vitest:test:is-attempt-to-fix', ({
      testManagementTests,
      testSuiteAbsolutePath,
      testName,
      onDone
    }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const { isAttemptToFix } = this.getTestProperties(testManagementTests, testSuite, testName)

      onDone(isAttemptToFix ?? false)
    })

    this.addSub('ci:vitest:test:is-disabled', ({ testManagementTests, testSuiteAbsolutePath, testName, onDone }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const { isDisabled } = this.getTestProperties(testManagementTests, testSuite, testName)

      onDone(isDisabled)
    })

    this.addSub('ci:vitest:test:is-quarantined', ({ testManagementTests, testSuiteAbsolutePath, testName, onDone }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const { isQuarantined } = this.getTestProperties(testManagementTests, testSuite, testName)

      onDone(isQuarantined)
    })

    this.addSub('ci:vitest:is-early-flake-detection-faulty', ({
      knownTests,
      testFilepaths,
      onDone
    }) => {
      const isFaulty = getIsFaultyEarlyFlakeDetection(
        testFilepaths.map(testFilepath => getTestSuitePath(testFilepath, this.repositoryRoot)),
        knownTests,
        this.libraryConfig.earlyFlakeDetectionFaultyThreshold
      )
      onDone(isFaulty)
    })

    this.addSub('ci:vitest:test:start', ({
      testName,
      testSuiteAbsolutePath,
      isRetry,
      isNew,
      isAttemptToFix,
      isQuarantined,
      isDisabled,
      mightHitProbe,
      isRetryReasonEfd,
      isRetryReasonAttemptToFix,
      isRetryReasonAtr
    }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const store = storage('legacy').getStore()

      const extraTags = {
        [TEST_SOURCE_FILE]: testSuite
      }
      if (isRetry) {
        extraTags[TEST_IS_RETRY] = 'true'
        if (isRetryReasonAttemptToFix) {
          extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.atf
        } else if (isRetryReasonEfd) {
          extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.efd
        } else if (isRetryReasonAtr) {
          extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.atr
        } else {
          extraTags[TEST_RETRY_REASON] = TEST_RETRY_REASON_TYPES.ext
        }
      }
      if (isNew) {
        extraTags[TEST_IS_NEW] = 'true'
      }
      if (isAttemptToFix) {
        extraTags[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] = 'true'
      }
      if (isQuarantined) {
        extraTags[TEST_MANAGEMENT_IS_QUARANTINED] = 'true'
      }
      if (isDisabled) {
        extraTags[TEST_MANAGEMENT_IS_DISABLED] = 'true'
      }

      const span = this.startTestSpan(
        testName,
        testSuite,
        this.testSuiteSpan,
        extraTags
      )

      this.enter(span, store)

      // TODO: there might be multiple tests for which mightHitProbe is true, so activeTestSpan
      // might be wrongly overwritten.
      if (mightHitProbe) {
        this.activeTestSpan = span
      }
    })

    this.addSub('ci:vitest:test:finish-time', ({ status, task, attemptToFixPassed }) => {
      const store = storage('legacy').getStore()
      const span = store?.span

      // we store the finish time to finish at a later hook
      // this is because the test might fail at a `afterEach` hook
      if (span) {
        span.setTag(TEST_STATUS, status)

        if (attemptToFixPassed) {
          span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
        }

        this.taskToFinishTime.set(task, span._getTime())
      }
    })

    this.addSub('ci:vitest:test:pass', ({ task }) => {
      const store = storage('legacy').getStore()
      const span = store?.span

      if (span) {
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
          hasCodeowners: !!span.context()._tags[TEST_CODE_OWNERS]
        })
        span.setTag(TEST_STATUS, 'pass')
        span.finish(this.taskToFinishTime.get(task))
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:vitest:test:error', ({ duration, error, shouldSetProbe, promises, hasFailedAllRetries }) => {
      const store = storage('legacy').getStore()
      const span = store?.span

      if (span) {
        if (shouldSetProbe && this.di) {
          const probeInformation = this.addDiProbe(error)
          if (probeInformation) {
            const { file, line, stackIndex, setProbePromise } = probeInformation
            this.runningTestProbe = { file, line }
            this.testErrorStackIndex = stackIndex
            promises.setProbePromise = setProbePromise
          }
        }
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
          hasCodeowners: !!span.context()._tags[TEST_CODE_OWNERS]
        })
        span.setTag(TEST_STATUS, 'fail')

        if (error) {
          span.setTag('error', error)
        }
        if (hasFailedAllRetries) {
          span.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
        }
        if (duration) {
          span.finish(span._startTime + duration - MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION) // milliseconds
        } else {
          span.finish() // `duration` is empty for retries, so we'll use clock time
        }
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:vitest:test:skip', ({ testName, testSuiteAbsolutePath, isNew, isDisabled }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const testSpan = this.startTestSpan(
        testName,
        testSuite,
        this.testSuiteSpan,
        {
          [TEST_SOURCE_FILE]: testSuite,
          [TEST_SOURCE_START]: 1, // we can't get the proper start line in vitest
          [TEST_STATUS]: 'skip',
          ...(isDisabled ? { [TEST_MANAGEMENT_IS_DISABLED]: 'true' } : {}),
          ...(isNew ? { [TEST_IS_NEW]: 'true' } : {})
        }
      )
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
        hasCodeowners: !!testSpan.context()._tags[TEST_CODE_OWNERS]
      })
      testSpan.finish()
    })

    this.addSub('ci:vitest:test-suite:start', ({
      testSuiteAbsolutePath,
      frameworkVersion
    }) => {
      this.command = process.env.DD_CIVISIBILITY_TEST_COMMAND
      this.frameworkVersion = frameworkVersion
      const testSessionSpanContext = this.tracer.extract('text_map', {
        'x-datadog-trace-id': process.env.DD_CIVISIBILITY_TEST_SESSION_ID,
        'x-datadog-parent-id': process.env.DD_CIVISIBILITY_TEST_MODULE_ID
      })

      // test suites run in a different process, so they also need to init the metadata dictionary
      const testSessionName = getTestSessionName(this.config, this.command, this.testEnvironmentMetadata)
      const metadataTags = {}
      for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
        metadataTags[testLevel] = {
          [TEST_SESSION_NAME]: testSessionName
        }
      }
      if (this.tracer._exporter.addMetadataTags) {
        const libraryCapabilitiesTags = getLibraryCapabilitiesTags(this.constructor.id)
        metadataTags.test = {
          ...metadataTags.test,
          ...libraryCapabilitiesTags
        }
        this.tracer._exporter.addMetadataTags(metadataTags)
      }

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
        'vitest'
      )
      testSuiteMetadata[TEST_SOURCE_FILE] = testSuite
      testSuiteMetadata[TEST_SOURCE_START] = 1

      const codeOwners = this.getCodeOwners(testSuiteMetadata)
      if (codeOwners) {
        testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      const testSuiteSpan = this.tracer.startSpan('vitest.test_suite', {
        childOf: testSessionSpanContext,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      const store = storage('legacy').getStore()
      this.enter(testSuiteSpan, store)
      this.testSuiteSpan = testSuiteSpan
    })

    this.addSub('ci:vitest:test-suite:finish', ({ status, onFinish }) => {
      const store = storage('legacy').getStore()
      const span = store?.span
      if (span) {
        span.setTag(TEST_STATUS, status)
        span.finish()
        finishAllTraceSpans(span)
      }
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
      // TODO: too frequent flush - find for method in worker to decrease frequency
      this.tracer._exporter.flush(onFinish)
      if (this.runningTestProbe) {
        this.removeDiProbe(this.runningTestProbe)
      }
    })

    this.addSub('ci:vitest:test-suite:error', ({ error }) => {
      const store = storage('legacy').getStore()
      const span = store?.span
      if (span && error) {
        span.setTag('error', error)
        span.setTag(TEST_STATUS, 'fail')
      }
    })

    this.addSub('ci:vitest:session:finish', ({
      status,
      error,
      testCodeCoverageLinesTotal,
      isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty,
      isTestManagementTestsEnabled,
      onFinish
    }) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      if (error) {
        this.testModuleSpan.setTag('error', error)
        this.testSessionSpan.setTag('error', error)
      }
      if (testCodeCoverageLinesTotal) {
        this.testModuleSpan.setTag(TEST_CODE_COVERAGE_LINES_PCT, testCodeCoverageLinesTotal)
        this.testSessionSpan.setTag(TEST_CODE_COVERAGE_LINES_PCT, testCodeCoverageLinesTotal)
      }
      if (isEarlyFlakeDetectionEnabled) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
      }
      if (isEarlyFlakeDetectionFaulty) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')
      }
      if (isTestManagementTestsEnabled) {
        this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
      }
      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)
      this.telemetry.count(TELEMETRY_TEST_SESSION, {
        provider: this.ciProviderName,
        autoInjected: !!process.env.DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER
      })
      this.tracer._exporter.flush(onFinish)
    })
  }

  getTestProperties (testManagementTests, testSuite, testName) {
    const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } =
      testManagementTests?.vitest?.suites?.[testSuite]?.tests?.[testName]?.properties || {}

    return { isAttemptToFix, isDisabled, isQuarantined }
  }
}

module.exports = VitestPlugin
