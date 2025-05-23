/* eslint-disable no-console */
const tracer = require('../packages/dd-trace')
const { isTrue, isFalse } = require('../packages/dd-trace/src/util')
const log = require('../packages/dd-trace/src/log')

const isJestWorker = !!process.env.JEST_WORKER_ID
const isCucumberWorker = !!process.env.CUCUMBER_WORKER_ID
const isMochaWorker = !!process.env.MOCHA_WORKER_ID

const isPlaywrightWorker = !!process.env.DD_PLAYWRIGHT_WORKER

const packageManagers = [
  'npm',
  'yarn',
  'pnpm'
]

const isPackageManager = () => {
  return packageManagers.some(packageManager => process.argv[1]?.includes(`bin/${packageManager}`))
}

const options = {
  startupLogs: false,
  isCiVisibility: true,
  flushInterval: isJestWorker ? 0 : 5000
}

let shouldInit = !isFalse(process.env.DD_CIVISIBILITY_ENABLED)

if (isPackageManager()) {
  log.debug('dd-trace is not initialized in a package manager.')
  shouldInit = false
}

const isAgentlessEnabled = isTrue(process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED)

if (isAgentlessEnabled) {
  if (process.env.DATADOG_API_KEY || process.env.DD_API_KEY) {
    options.experimental = {
      exporter: 'datadog'
    }
  } else {
    console.error('DD_CIVISIBILITY_AGENTLESS_ENABLED is set, but neither ' +
      'DD_API_KEY nor DATADOG_API_KEY are set in your environment, so ' +
      'dd-trace will not be initialized.')
    shouldInit = false
  }
} else {
  options.experimental = {
    exporter: 'agent_proxy'
  }
}

if (isJestWorker) {
  options.experimental = {
    exporter: 'jest_worker'
  }
}

if (isCucumberWorker) {
  options.experimental = {
    exporter: 'cucumber_worker'
  }
}

if (isMochaWorker) {
  options.experimental = {
    exporter: 'mocha_worker'
  }
}

if (isPlaywrightWorker) {
  options.experimental = {
    exporter: 'playwright_worker'
  }
}

if (shouldInit) {
  tracer.init(options)
  tracer.use('fs', false)
  tracer.use('child_process', false)
}

module.exports = tracer
