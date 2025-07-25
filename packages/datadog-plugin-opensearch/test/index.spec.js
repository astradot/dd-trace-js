'use strict'

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let opensearch
  let tracer

  withVersions('opensearch', ['opensearch', '@opensearch-project/opensearch'], (version, moduleName) => {
    const metaModule = require(`../../../versions/${moduleName}@${version}`)

    describe('opensearch', () => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        let client

        before(() => {
          return agent.load('opensearch')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          opensearch = metaModule.get()

          client = new opensearch.Client({
            node: 'http://127.0.0.1:9201'
          })
        })

        afterEach(() => {
          unbreakThen(Promise.prototype)
        })

        it('should sanitize the resource name', done => {
          agent
            .assertFirstTraceSpan({
              resource: 'POST /logstash-?.?.?/_search'
            })
            .then(done)
            .catch(done)

          client.search({
            index: 'logstash-2000.01.01',
            body: {}
          })
        })

        it('should set the correct tags', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              meta: {
                'db.type': 'opensearch',
                'span.kind': 'client',
                'opensearch.method': 'POST',
                'opensearch.url': '/docs/_search',
                'opensearch.body': '{"query":{"match_all":{}}}',
                component: 'opensearch',
                'out.host': '127.0.0.1'
              }
            })
            .then(done)
            .catch(done)

          client.search({
            index: 'docs',
            sort: 'name',
            size: 100,
            body: {
              query: {
                match_all: {}
              }
            }
          })
        })

        it('should set the correct tags on msearch', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0].meta).to.have.property('db.type', 'opensearch')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('opensearch.method', 'POST')
              expect(traces[0][0].meta).to.have.property('opensearch.url', '/_msearch')
              expect(traces[0][0].meta).to.have.property(
                'opensearch.body',
                '[{"index":"docs"},{"query":{"match_all":{}}},{"index":"docs2"},{"query":{"match_all":{}}}]'
              )
              expect(traces[0][0].meta).to.have.property('opensearch.params', '{"size":100}')
              expect(traces[0][0].meta).to.have.property('component', 'opensearch')
              expect(traces[0][0].meta).to.have.property('_dd.integration', 'opensearch')
            })
            .then(done)
            .catch(done)

          client.msearch({
            size: 100,
            body: [
              { index: 'docs' },
              {
                query: {
                  match_all: {}
                }
              },
              { index: 'docs2' },
              {
                query: {
                  match_all: {}
                }
              }
            ]
          })
        })

        it('should skip tags for unavailable fields', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.not.have.property('opensearch.body')
            })
            .then(done)
            .catch(done)

          client.ping().catch(done)
        })

        it('should do automatic instrumentation', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'HEAD /')
              expect(traces[0][0]).to.have.property('type', 'elasticsearch')
              expect(traces[0][0].meta).to.have.property('component', 'opensearch')
            })
            .then(done)
            .catch(done)

          client.ping().catch(done)
        })

        it('should propagate context', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('parent_id')
              expect(traces[0][0].parent_id).to.not.be.null
            })
            .then(done)
            .catch(done)

          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            client.ping()
              .then(() => span.finish())
              .catch(done)
          })
        })

        it('should handle errors', done => {
          let error

          agent.assertSomeTraces(traces => {
            expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
            expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
            expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
            expect(traces[0][0].meta).to.have.property('component', 'opensearch')
          })
            .then(done)
            .catch(done)

          client.search({ index: 'invalid' })
            .catch(err => {
              error = err
            })
        })

        it('should support aborting the query', () => {
          expect(() => {
            const promise = client.ping()

            if (promise.abort) {
              promise.abort()
            }
          }).not.to.throw()
        })

        it('should work with userland promises', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'HEAD /')
              expect(traces[0][0]).to.have.property('type', 'elasticsearch')
            })
            .then(done)
            .catch(done)

          breakThen(Promise.prototype)

          client.ping().catch(done)
        })

        withNamingSchema(
          () => {
            client.search({ index: 'logstash-2000.01.01', body: {} })
          },
          rawExpectedSchema.outbound
        )
      })

      describe('with configuration', () => {
        let client

        before(() => {
          return agent.load('opensearch', {
            service: 'custom',
            hooks: {
              query: (span, params) => {
                span.addTags({ 'opensearch.params': 'foo', 'opensearch.method': params.method })
              }
            }
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          opensearch = require(`../../../versions/${moduleName}@${version}`).get()
          client = new opensearch.Client({
            node: 'http://127.0.0.1:9201'
          })
        })

        withPeerService(
          () => tracer,
          'opensearch',
          () => client.search({
            index: 'docs',
            sort: 'name',
            size: 100,
            body: {
              query: {
                match_all: {}
              }
            }
          }).catch(() => {
            // Ignore index_not_found_exception for peer service assertion
          }),
          '127.0.0.1',
          'out.host'
        )

        it('should be configured with the correct values', done => {
          client.search({
            index: 'docs',
            sort: 'name',
            size: 100,
            body: {
              query: {
                match_all: {}
              }
            }
          })

          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: 'custom',
              meta: {
                'opensearch.params': 'foo',
                'opensearch.method': 'POST',
                component: 'opensearch'
              }
            })
            .then(done)
            .catch(done)

          client.ping().catch(done)
        })

        withNamingSchema(
          () => {
            client.search({ index: 'logstash-2000.01.01', body: {} })
          },
          {
            v0: {
              opName: 'opensearch.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'opensearch.query',
              serviceName: 'custom'
            }
          }
        )
      })
    })
  })
})
