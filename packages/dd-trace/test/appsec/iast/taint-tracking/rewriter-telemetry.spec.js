'use strict'

const proxyquire = require('proxyquire')

const { INSTRUMENTED_PROPAGATION } = require('../../../../src/appsec/iast/telemetry/iast-metric')
const { Verbosity } = require('../../../../src/appsec/iast/telemetry/verbosity')

describe('rewriter telemetry', () => {
  let iastTelemetry, rewriter, getRewriteFunction, incrementTelemetryIfNeeded
  let instrumentedPropagationInc

  beforeEach(() => {
    iastTelemetry = {
      add: sinon.spy()
    }
    const rewriterTelemetry = proxyquire('../../../../src/appsec/iast/taint-tracking/rewriter-telemetry', {
      '../telemetry': iastTelemetry
    })
    getRewriteFunction = rewriterTelemetry.getRewriteFunction
    incrementTelemetryIfNeeded = rewriterTelemetry.incrementTelemetryIfNeeded
    rewriter = {
      rewrite: (content) => {
        return {
          content: content + 'rewritten',
          metrics: {
            instrumentedPropagation: 2
          }
        }
      }
    }
    instrumentedPropagationInc = sinon.stub(INSTRUMENTED_PROPAGATION, 'inc')
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should not increase any metrics with OFF verbosity', () => {
    iastTelemetry.verbosity = Verbosity.OFF

    const rewriteFn = getRewriteFunction(rewriter)
    rewriteFn('const a = b + c', 'test.js')

    expect(instrumentedPropagationInc).to.not.be.called
  })

  it('should increase information metrics with MANDATORY verbosity', () => {
    iastTelemetry.verbosity = Verbosity.MANDATORY

    const rewriteFn = getRewriteFunction(rewriter)
    const result = rewriteFn('const a = b + c', 'test.js')

    expect(instrumentedPropagationInc).to.be.calledOnceWith(undefined, result.metrics.instrumentedPropagation)
  })

  it('should increase information metrics with INFORMATION verbosity', () => {
    iastTelemetry.verbosity = Verbosity.INFORMATION

    const rewriteFn = getRewriteFunction(rewriter)
    const result = rewriteFn('const a = b + c', 'test.js')

    expect(instrumentedPropagationInc).to.be.calledOnceWith(undefined, result.metrics.instrumentedPropagation)
  })

  it('should increase debug metrics with DEBUG verbosity', () => {
    iastTelemetry.verbosity = Verbosity.DEBUG

    const rewriteFn = getRewriteFunction(rewriter)
    const result = rewriteFn('const a = b + c', 'test.js')

    expect(instrumentedPropagationInc).to.be.calledOnceWith(undefined, result.metrics.instrumentedPropagation)
  })

  describe('incrementTelemetryIfNeeded', () => {
    it('should not increment telemetry when verbosity is OFF', () => {
      iastTelemetry.verbosity = Verbosity.OFF
      const metrics = {
        instrumentedPropagation: 2
      }
      incrementTelemetryIfNeeded(metrics)

      expect(instrumentedPropagationInc).not.to.be.called
    })

    it('should increment telemetry when verbosity is not OFF', () => {
      iastTelemetry.verbosity = Verbosity.DEBUG
      const metrics = {
        instrumentedPropagation: 2
      }
      incrementTelemetryIfNeeded(metrics)

      expect(instrumentedPropagationInc).to.be.calledOnceWith(undefined, metrics.instrumentedPropagation)
    })
  })
})
