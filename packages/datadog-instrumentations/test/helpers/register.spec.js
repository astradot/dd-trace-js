'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const Module = require('module')

describe('register', () => {
  let hooksMock
  let HookMock
  let originalModuleProtoRequire

  const clearRegisterCache = () => {
    const registerPath = require.resolve('../../src/helpers/register')
    delete require.cache[registerPath]
  }

  beforeEach(() => {
    delete process.env.DD_TRACE_CONFLUENTINC_KAFKA_JAVASCRIPT_ENABLED
    delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS

    hooksMock = {
      '@confluentinc/kafka-javascript': {
        disabled: true,
        fn: sinon.stub().returns('hooked')
      },
      'mongodb-core': {
        fn: sinon.stub().returns('hooked')
      }
    }

    HookMock = sinon.stub()

    const registerPath = require.resolve('../../src/helpers/register')
    originalModuleProtoRequire = Module.prototype.require

    Module.prototype.require = function (request) {
      if (this.filename === registerPath) {
        const stubs = {
          './hooks': hooksMock,
          './hook': HookMock
        }
        return stubs[request] || originalModuleProtoRequire.call(this, request)
      }
      return originalModuleProtoRequire.call(this, request)
    }

    clearRegisterCache()
  })

  afterEach(() => {
    sinon.restore()
    Module.prototype.require = originalModuleProtoRequire
    clearRegisterCache()
  })

  const loadRegisterWithEnv = (env = undefined) => {
    env = env || {}
    clearRegisterCache()
    Object.entries(env).forEach(([key, value]) => {
      process.env[key] = value
    })
    require('../../src/helpers/register')
  }

  const runHookCallbacks = (hookMock) => {
    for (let i = 0; i < hookMock.callCount; i++) {
      const callback = hookMock.args[i][2]
      const moduleName = hookMock.args[i][0][0]
      const moduleExports = 'original'
      const result = callback(moduleExports, moduleName, '/path/to/module', '1.0.0')
      expect(result).to.equal('original')
    }
  }

  it('should skip hooks that are disabled by default and process enabled hooks', () => {
    loadRegisterWithEnv()

    expect(HookMock.callCount).to.equal(1)
    expect(HookMock.args[0]).to.deep.include(['mongodb-core'], { internals: undefined })

    runHookCallbacks(HookMock)

    expect(hooksMock['@confluentinc/kafka-javascript'].fn).to.not.have.been.called
    expect(hooksMock['mongodb-core'].fn).to.have.been.called
  })

  it('should enable disabled hooks when DD_TRACE_[pkg]_ENABLED is true', () => {
    loadRegisterWithEnv({ DD_TRACE_CONFLUENTINC_KAFKA_JAVASCRIPT_ENABLED: 'true' })

    expect(HookMock.callCount).to.equal(2)
    expect(HookMock.args[0]).to.deep.include(['@confluentinc/kafka-javascript'], { internals: undefined })
    expect(HookMock.args[1]).to.deep.include(['mongodb-core'], { internals: undefined })

    runHookCallbacks(HookMock)

    expect(hooksMock['@confluentinc/kafka-javascript'].fn).to.have.been.called
    expect(hooksMock['mongodb-core'].fn).to.have.been.called
  })

  it('should not enable disabled hooks when DD_TRACE_[pkg]_ENABLED is false', () => {
    loadRegisterWithEnv({ DD_TRACE_CONFLUENTINC_KAFKA_JAVASCRIPT_ENABLED: 'false' })

    expect(HookMock.callCount).to.equal(1)
    expect(HookMock.args[0]).to.deep.include(['mongodb-core'], { internals: undefined })

    runHookCallbacks(HookMock)

    expect(hooksMock['@confluentinc/kafka-javascript'].fn).to.not.have.been.called
    expect(hooksMock['mongodb-core'].fn).to.have.been.called
  })

  it('should disable hooks that are disabled by DD_TRACE_[pkg]_ENABLED=false', () => {
    loadRegisterWithEnv({ DD_TRACE_MONGODB_CORE_ENABLED: 'false' })

    expect(HookMock.callCount).to.equal(0)

    runHookCallbacks(HookMock)

    expect(hooksMock['@confluentinc/kafka-javascript'].fn).to.not.have.been.called
    expect(hooksMock['mongodb-core'].fn).to.not.have.been.called
  })

  it('should disable hooks that are disabled by DD_TRACE_DISABLED_INSTRUMENTATIONS', () => {
    loadRegisterWithEnv({ DD_TRACE_DISABLED_INSTRUMENTATIONS: 'mongodb-core,@confluentinc/kafka-javascript' })

    expect(HookMock.callCount).to.equal(0)

    runHookCallbacks(HookMock)

    expect(hooksMock['@confluentinc/kafka-javascript'].fn).to.not.have.been.called
    expect(hooksMock['mongodb-core'].fn).to.not.have.been.called
  })
})
