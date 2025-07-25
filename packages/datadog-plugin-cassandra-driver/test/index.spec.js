'use strict'

const semver = require('semver')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_TYPE, ERROR_MESSAGE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema, rawExpectedSchema } = require('./naming')
const { assertObjectContains } = require('../../../integration-tests/helpers')

describe('Plugin', () => {
  let cassandra
  let tracer

  describe('cassandra-driver', () => {
    withVersions('cassandra-driver', 'cassandra-driver', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        global.tracer = tracer
      })

      describe('without configuration', () => {
        let client

        before(() => {
          return agent.load('cassandra-driver')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          cassandra = require(`../../../versions/cassandra-driver@${version}`).get()

          client = new cassandra.Client({
            contactPoints: ['127.0.0.1'],
            localDataCenter: 'datacenter1',
            keyspace: 'system'
          })

          client.connect(done)
        })

        afterEach(done => {
          client.shutdown(done)
        })

        withPeerService(
          () => tracer,
          'cassandra-driver',
          (done) => client.execute('SELECT now() FROM local;', done),
          '127.0.0.1',
          'db.cassandra.contact.points'
        )

        it('should do automatic instrumentation', done => {
          const query = 'SELECT now() FROM local;'
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: query,
              type: 'cassandra',
              meta: {
                'db.type': 'cassandra',
                'span.kind': 'client',
                'out.host': '127.0.0.1',
                'cassandra.query': query,
                'cassandra.keyspace': 'system',
                component: 'cassandra-driver',
                'network.destination.port': '9042',
                'db.cassandra.contact.points': '127.0.0.1'
              }
            })
            .then(done)
            .catch(done)

          client.execute(query, err => err && done(err))
        })

        it('should support batch queries', done => {
          const id = '1234'
          const queries = [
            { query: 'INSERT INTO test.test (id) VALUES (?)', params: [id] },
            `UPDATE test.test SET test='test' WHERE id='${id}';`
          ]

          agent
            .assertFirstTraceSpan({
              resource: `${queries[0].query}; ${queries[1]}`
            })
            .then(done)
            .catch(done)

          client.batch(queries, { prepare: true }, err => err && done(err))
        })

        it('should support batch queries without a callback', done => {
          const id = '1234'
          const queries = [
            { query: 'INSERT INTO test.test (id) VALUES (?)', params: [id] },
            `UPDATE test.test SET test='test' WHERE id='${id}';`
          ]

          agent
            .assertFirstTraceSpan({
              resource: `${queries[0].query}; ${queries[1]}`
            })
            .then(done)
            .catch(done)

          try {
            client.batch(queries, { prepare: true })
          } catch (e) {
            // older versions require a callback
          }
        })

        it('should handle errors', done => {
          let error

          agent
            .assertFirstTraceSpan((trace) => {
              assertObjectContains(trace, {
                meta: {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_STACK]: error.stack,
                  component: 'cassandra-driver'
                }
              })
            })
            .then(done)
            .catch(done)

          client.execute('INVALID;', err => {
            error = err
          })
        })

        it('should run the callback in the parent context', done => {
          const scope = tracer.scope()
          const childOf = tracer.startSpan('test')

          scope.activate(childOf, () => {
            client.execute('SELECT now() FROM local;', () => {
              expect(tracer.scope().active()).to.equal(childOf)
              done()
            })
          })
        })

        it('should run the batch callback in the parent context', done => {
          const scope = tracer.scope()
          const childOf = tracer.startSpan('test')

          scope.activate(childOf, () => {
            client.batch(['UPDATE test.test SET test=\'test\' WHERE id=\'1234\';'], () => {
              expect(tracer.scope().active()).to.equal(childOf)
              done()
            })
          })
        })

        withNamingSchema(
          done => client.execute('SELECT now() FROM local;', err => err && done(err)),
          rawExpectedSchema.outbound
        )
      })

      describe('with configuration', () => {
        let client

        before(() => {
          return agent.load('cassandra-driver', { service: 'custom' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          cassandra = require(`../../../versions/cassandra-driver@${version}`).get()

          client = new cassandra.Client({
            contactPoints: ['127.0.0.1'],
            localDataCenter: 'datacenter1',
            keyspace: 'system'
          })

          client.keyspace

          client.connect(done)
        })

        afterEach(done => {
          client.shutdown(done)
        })

        it('should be configured with the correct values', done => {
          agent.assertFirstTraceSpan({
            service: 'custom'
          })
            .then(done)
            .catch(done)

          client.execute('SELECT now() FROM local;', err => err && done(err))
        })

        withNamingSchema(
          done => client.execute('SELECT now() FROM local;', err => err && done(err)),
          {
            v0: {
              opName: 'cassandra.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'cassandra.query',
              serviceName: 'custom'
            }
          }
        )
      })

      // Promise support added in 3.2.0
      if (semver.intersects(version, '>=3.2.0')) {
        describe('with the promise API', () => {
          let client

          before(() => {
            return agent.load('cassandra-driver')
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          beforeEach(done => {
            cassandra = require(`../../../versions/cassandra-driver@${version}`).get()

            client = new cassandra.Client({
              contactPoints: ['127.0.0.1'],
              localDataCenter: 'datacenter1',
              keyspace: 'system'
            })

            client.keyspace

            client.connect(done)
          })

          afterEach(done => {
            client.shutdown(done)
          })

          it('should do automatic instrumentation', done => {
            const query = 'SELECT now() FROM local;'

            agent
              .assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: query,
                type: 'cassandra',
                meta: {
                  'db.type': 'cassandra',
                  'span.kind': 'client',
                  'out.host': '127.0.0.1',
                  'cassandra.query': query,
                  'cassandra.keyspace': 'system',
                  component: 'cassandra-driver',
                  'network.destination.port': '9042'
                }
              })
              .then(done)
              .catch(done)

            client.execute(query)
              .catch(done)
          })

          it('should support batch queries', done => {
            const id = '1234'
            const queries = [
              { query: 'INSERT INTO test.test (id) VALUES (?)', params: [id] },
              `UPDATE test.test SET test='test' WHERE id='${id}';`
            ]

            agent
              .assertFirstTraceSpan({
                resource: `${queries[0].query}; ${queries[1]}`
              })
              .then(done)
              .catch(done)

            client.batch(queries, { prepare: true })
              .catch(done)
          })
        })
      }
    })
  })
})
