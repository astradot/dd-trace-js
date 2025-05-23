'use strict'

const axios = require('axios')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { getNextLineNumber } = require('../../dd-trace/test/plugins/helpers')
const { NODE_MAJOR } = require('../../../version')

describe('Plugin', () => {
  let fastify
  let app

  describe('fastify', () => {
    withVersions('fastify', 'fastify', (version, _, specificVersion) => {
      if (NODE_MAJOR <= 18 && semver.satisfies(specificVersion, '>=5')) return
      afterEach(() => {
        app.close()
      })

      withExports('fastify', version, ['default', 'fastify'], '>=3', getExport => {
        beforeEach(() => {
          fastify = getExport()
          app = fastify()

          if (semver.intersects(version, '>=3')) {
            return app.register(require('../../../versions/middie').get())
          }
        })

        describe('code origin for spans disabled', () => {
          const config = { codeOriginForSpans: { enabled: false } }

          describe(`with tracer config ${JSON.stringify(config)}`, () => {
            before(() => agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], config))

            after(() => agent.close({ ritmReset: false, wipe: true }))

            it('should not add code_origin tag on entry spans', async () => {
              app.get('/user', function (request, reply) {
                reply.send()
              })

              await app.listen(getListenOptions())

              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const spans = traces[0]
                  const tagNames = Object.keys(spans[0].meta)
                  expect(tagNames).to.all.not.match(/code_origin/)
                }),
                axios.get(`http://localhost:${app.server.address().port}/user`)
              ])
            })
          })
        })

        describe('code origin for spans enabled', () => {
          if (semver.satisfies(specificVersion, '<4')) return // TODO: Why doesn't it work on older versions?

          const configs = [{}, { codeOriginForSpans: { enabled: true } }]

          for (const config of configs) {
            describe(`with tracer config ${JSON.stringify(config)}`, () => {
              before(() => agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }], config))

              after(() => agent.close({ ritmReset: false, wipe: true }))

              it('should add code_origin tag on entry spans when feature is enabled', async () => {
                let routeRegisterLine

                // Wrap in a named function to have at least one frame with a function name
                function wrapperFunction () {
                  routeRegisterLine = String(getNextLineNumber())
                  app.get('/user', function userHandler (request, reply) {
                    reply.send()
                  })
                }

                const callWrapperLine = String(getNextLineNumber())
                wrapperFunction()

                await app.listen(getListenOptions())

                await Promise.all([
                  agent.assertSomeTraces(traces => {
                    const spans = traces[0]
                    const tags = spans[0].meta

                    expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                    expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'wrapperFunction')
                    expect(tags).to.not.have.property('_dd.code_origin.frames.0.type')

                    expect(tags).to.have.property('_dd.code_origin.frames.1.file', __filename)
                    expect(tags).to.have.property('_dd.code_origin.frames.1.line', callWrapperLine)
                    expect(tags).to.have.property('_dd.code_origin.frames.1.column').to.match(/^\d+$/)
                    expect(tags).to.not.have.property('_dd.code_origin.frames.1.method')
                    expect(tags).to.have.property('_dd.code_origin.frames.1.type', 'Context')

                    expect(tags).to.not.have.property('_dd.code_origin.frames.2.file')
                  }),
                  axios.get(`http://localhost:${app.server.address().port}/user`)
                ])
              })

              it('should point to where actual route handler is configured, not the prefix', async () => {
                let routeRegisterLine

                app.register(function v1Handler (app, opts, done) {
                  routeRegisterLine = String(getNextLineNumber())
                  app.get('/user', function userHandler (request, reply) {
                    reply.send()
                  })
                  done()
                }, { prefix: '/v1' })

                await app.listen(getListenOptions())

                await Promise.all([
                  agent.assertSomeTraces(traces => {
                    const spans = traces[0]
                    const tags = spans[0].meta

                    expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                    expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'v1Handler')
                    expect(tags).to.not.have.property('_dd.code_origin.frames.0.type')

                    expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
                  }),
                  axios.get(`http://localhost:${app.server.address().port}/v1/user`)
                ])
              })

              it('should point to route handler even if passed through a middleware', async function testCase () {
                app.use(function middleware (req, res, next) {
                  next()
                })

                const routeRegisterLine = String(getNextLineNumber())
                app.get('/user', function userHandler (request, reply) {
                  reply.send()
                })

                await app.listen(getListenOptions())

                await Promise.all([
                  agent.assertSomeTraces(traces => {
                    const spans = traces[0]
                    const tags = spans[0].meta

                    expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                    expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'testCase')
                    expect(tags).to.have.property('_dd.code_origin.frames.0.type', 'Context')

                    expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
                  }),
                  axios.get(`http://localhost:${app.server.address().port}/user`)
                ])
              })

              // TODO: In Fastify, the route is resolved before the middleware is called, so we actually can get the
              // line number of where the route handler is defined. However, this might not be the right choice and it
              // might be better to point to the middleware.
              it.skip('should point to middleware if middleware responds early', async function testCase () {
                const middlewareRegisterLine = String(getNextLineNumber())
                app.use(function middleware (req, res, next) {
                  res.end()
                })

                app.get('/user', function userHandler (request, reply) {
                  reply.send()
                })

                await app.listen(getListenOptions())

                await Promise.all([
                  agent.assertSomeTraces(traces => {
                    const spans = traces[0]
                    const tags = spans[0].meta

                    expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                    expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.line', middlewareRegisterLine)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                    expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'testCase')
                    expect(tags).to.have.property('_dd.code_origin.frames.0.type', 'Context')

                    expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
                  }),
                  axios.get(`http://localhost:${app.server.address().port}/user`)
                ])
              })
            })
          }
        })
      })
    })
  })
})

// Required by Fastify 1.0.0
function getListenOptions () {
  return { host: 'localhost', port: 0 }
}
