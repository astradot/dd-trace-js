'use strict'

const fs = require('fs')
const Path = require('path')
const agent = require('../../../plugins/agent')
const Sampler = require('../../../../src/sampler')
const { DogStatsDClient } = require('../../../../src/dogstatsd')
const { NoopExternalLogger } = require('../../../../src/external-logger/src')

const nock = require('nock')
const { expectedLLMObsLLMSpanEvent, deepEqualWithMockValues } = require('../../util')
const chai = require('chai')
const semver = require('semver')
const LLMObsSpanWriter = require('../../../../src/llmobs/writers/spans')

const { expect } = chai

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const baseOpenAITestsPath = '../../../../../datadog-plugin-openai/test/'

const satisfiesTools = version => semver.intersects('>4.16.0', version)
const satisfiesStream = version => semver.intersects('>4.1.0', version)

describe('integrations', () => {
  let openai
  let azureOpenai
  let deepseekOpenai

  describe('openai', () => {
    before(() => {
      sinon.stub(LLMObsSpanWriter.prototype, 'append')

      // reduce errors related to too many listeners
      process.removeAllListeners('beforeExit')

      sinon.stub(DogStatsDClient.prototype, '_add')
      sinon.stub(NoopExternalLogger.prototype, 'log')
      sinon.stub(Sampler.prototype, 'isSampled').returns(true)

      LLMObsSpanWriter.prototype.append.reset()

      return agent.load('openai', {}, {
        llmobs: {
          mlApp: 'test',
          agentlessEnabled: false
        }
      })
    })

    afterEach(() => {
      nock.cleanAll()
      LLMObsSpanWriter.prototype.append.reset()
    })

    after(() => {
      sinon.restore()
      require('../../../../../dd-trace').llmobs.disable() // unsubscribe from all events
      // delete require.cache[require.resolve('../../../../dd-trace')]
      return agent.close({ ritmReset: false, wipe: true })
    })

    // TODO: Remove the range cap once we support openai 5
    withVersions('openai', 'openai', '>=4 <5', version => {
      const moduleRequirePath = `../../../../../../versions/openai@${version}`

      beforeEach(() => {
        const requiredModule = require(moduleRequirePath)
        const module = requiredModule.get()

        const OpenAI = module

        openai = new OpenAI({
          apiKey: 'test'
        })

        const AzureOpenAI = OpenAI.AzureOpenAI ?? OpenAI
        if (OpenAI.AzureOpenAI) {
          azureOpenai = new AzureOpenAI({
            endpoint: 'https://dd.openai.azure.com/',
            apiKey: 'test',
            apiVersion: '2024-05-01-preview'
          })
        } else {
          azureOpenai = new OpenAI({
            baseURL: 'https://dd.openai.azure.com/',
            apiKey: 'test',
            apiVersion: '2024-05-01-preview'
          })
        }

        deepseekOpenai = new OpenAI({
          baseURL: 'https://api.deepseek.com/',
          apiKey: 'test'
        })
      })

      it('submits a completion span', async () => {
        nock('https://api.openai.com:443')
          .post('/v1/completions')
          .reply(200, {
            model: 'text-davinci-002',
            choices: [{
              text: 'I am doing well, how about you?',
              index: 0,
              logprobs: null,
              finish_reason: 'length'
            }],
            usage: { prompt_tokens: 3, completion_tokens: 16, total_tokens: 19 }
          }, [])

        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createCompletion',
            inputMessages: [
              { content: 'How are you?' }
            ],
            outputMessages: [
              { content: 'I am doing well, how about you?' }
            ],
            tokenMetrics: { input_tokens: 3, output_tokens: 16, total_tokens: 19 },
            modelName: 'text-davinci-002',
            modelProvider: 'openai',
            metadata: {},
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await openai.completions.create({
          model: 'text-davinci-002',
          prompt: 'How are you?'
        })

        await checkSpan
      })

      it('submits a chat completion span', async () => {
        nock('https://api.openai.com:443')
          .post('/v1/chat/completions')
          .reply(200, {
            id: 'chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN',
            object: 'chat.completion',
            created: 1684188020,
            model: 'gpt-3.5-turbo-0301',
            usage: {
              prompt_tokens: 37,
              completion_tokens: 10,
              total_tokens: 47
            },
            choices: [{
              message: {
                role: 'assistant',
                content: 'I am doing well, how about you?'
              },
              finish_reason: 'length',
              index: 0
            }]
          }, [])

        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createChatCompletion',
            inputMessages: [
              { role: 'system', content: 'You are a helpful assistant' },
              { role: 'user', content: 'How are you?' }
            ],
            outputMessages: [
              { role: 'assistant', content: 'I am doing well, how about you?' }
            ],
            tokenMetrics: { input_tokens: 37, output_tokens: 10, total_tokens: 47 },
            modelName: 'gpt-3.5-turbo-0301',
            modelProvider: 'openai',
            metadata: {},
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await openai.chat.completions.create({
          model: 'gpt-3.5-turbo-0301',
          messages: [
            { role: 'system', content: 'You are a helpful assistant' },
            { role: 'user', content: 'How are you?' }
          ]
        })

        await checkSpan
      })

      it('submits an embedding span', async () => {
        nock('https://api.openai.com:443')
          .post('/v1/embeddings')
          .reply(200, {
            object: 'list',
            data: [{
              object: 'embedding',
              index: 0,
              embedding: [-0.0034387498, -0.026400521]
            }],
            model: 'text-embedding-ada-002-v2',
            usage: {
              prompt_tokens: 2,
              total_tokens: 2
            }
          }, [])

        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'embedding',
            name: 'OpenAI.createEmbedding',
            inputDocuments: [
              { text: 'Hello, world!' }
            ],
            outputValue: '[1 embedding(s) returned with size 2]',
            tokenMetrics: { input_tokens: 2, total_tokens: 2 },
            modelName: 'text-embedding-ada-002-v2',
            modelProvider: 'openai',
            metadata: { encoding_format: 'float' },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await openai.embeddings.create({
          model: 'text-embedding-ada-002-v2',
          input: 'Hello, world!',
          encoding_format: 'float'
        })

        await checkSpan
      })

      if (satisfiesTools(version)) {
        it('submits a chat completion span with tools', async () => {
          nock('https://api.openai.com:443')
            .post('/v1/chat/completions')
            .reply(200, {
              id: 'chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN',
              object: 'chat.completion',
              created: 1684188020,
              model: 'gpt-3.5-turbo-0301',
              usage: {
                prompt_tokens: 37,
                completion_tokens: 10,
                total_tokens: 47
              },
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'THOUGHT: I will use the "extract_fictional_info" tool',
                  tool_calls: [
                    {
                      id: 'tool-1',
                      type: 'function',
                      function: {
                        name: 'extract_fictional_info',
                        arguments: '{"name":"SpongeBob","origin":"Bikini Bottom"}'
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls',
                index: 0
              }]
            }, [])

          const checkSpan = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

            const expected = expectedLLMObsLLMSpanEvent({
              span,
              spanKind: 'llm',
              name: 'OpenAI.createChatCompletion',
              modelName: 'gpt-3.5-turbo-0301',
              modelProvider: 'openai',
              inputMessages: [{ role: 'user', content: 'What is SpongeBob SquarePants\'s origin?' }],
              outputMessages: [{
                role: 'assistant',
                content: 'THOUGHT: I will use the "extract_fictional_info" tool',
                tool_calls: [
                  {
                    name: 'extract_fictional_info',
                    arguments: {
                      name: 'SpongeBob',
                      origin: 'Bikini Bottom'
                    },
                    tool_id: 'tool-1',
                    type: 'function'
                  }
                ]
              }],
              metadata: { tool_choice: 'auto' },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
              tokenMetrics: { input_tokens: 37, output_tokens: 10, total_tokens: 47 }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          await openai.chat.completions.create({
            model: 'gpt-3.5-turbo-0301',
            messages: [{ role: 'user', content: 'What is SpongeBob SquarePants\'s origin?' }],
            tools: [{ type: 'function', functiin: { /* this doesn't matter */} }],
            tool_choice: 'auto'
          })

          await checkSpan
        })
      }

      if (satisfiesStream(version)) {
        it('submits a streamed completion span', async () => {
          nock('https://api.openai.com:443')
            .post('/v1/completions')
            .reply(200, function () {
              return fs.createReadStream(Path.join(
                __dirname, baseOpenAITestsPath, 'streamed-responses/completions.simple.txt'
              ))
            }, {
              'Content-Type': 'text/plain',
              'openai-organization': 'kill-9'
            })

          const checkSpan = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

            const expected = expectedLLMObsLLMSpanEvent({
              span,
              spanKind: 'llm',
              name: 'OpenAI.createCompletion',
              inputMessages: [
                { content: 'Can you say this is a test?' }
              ],
              outputMessages: [
                { content: ' this is a test.' }
              ],
              tokenMetrics: { input_tokens: 8, output_tokens: 5, total_tokens: 13 },
              modelName: 'text-davinci-002',
              modelProvider: 'openai',
              metadata: { temperature: 0.5, stream: true },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          const stream = await openai.completions.create({
            model: 'text-davinci-002',
            prompt: 'Can you say this is a test?',
            temperature: 0.5,
            stream: true
          })

          for await (const part of stream) {
            expect(part).to.have.property('choices')
            expect(part.choices[0]).to.have.property('text')
          }

          await checkSpan
        })

        it('submits a streamed chat completion span', async () => {
          nock('https://api.openai.com:443')
            .post('/v1/chat/completions')
            .reply(200, function () {
              return fs.createReadStream(Path.join(
                __dirname, baseOpenAITestsPath, 'streamed-responses/chat.completions.simple.txt'
              ))
            }, {
              'Content-Type': 'text/plain',
              'openai-organization': 'kill-9'
            })

          const checkSpan = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

            const expected = expectedLLMObsLLMSpanEvent({
              span,
              spanKind: 'llm',
              name: 'OpenAI.createChatCompletion',
              inputMessages: [
                { role: 'user', content: 'Hello' }
              ],
              outputMessages: [
                { role: 'assistant', content: 'Hello! How can I assist you today?' }
              ],
              tokenMetrics: { input_tokens: 1, output_tokens: 9, total_tokens: 10 },
              modelName: 'gpt-3.5-turbo-0301',
              modelProvider: 'openai',
              metadata: { stream: true },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          const stream = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo-0301',
            messages: [{ role: 'user', content: 'Hello' }],
            stream: true
          })

          for await (const part of stream) {
            expect(part).to.have.property('choices')
            expect(part.choices[0]).to.have.property('delta')
          }

          await checkSpan
        })

        if (satisfiesTools(version)) {
          it('submits a chat completion span with tools stream', async () => {
            nock('https://api.openai.com:443')
              .post('/v1/chat/completions')
              .reply(200, function () {
                return fs.createReadStream(Path.join(
                  __dirname, baseOpenAITestsPath, 'streamed-responses/chat.completions.tool.and.content.txt'
                ))
              }, {
                'Content-Type': 'text/plain',
                'openai-organization': 'kill-9'
              })

            const checkSpan = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                name: 'OpenAI.createChatCompletion',
                modelName: 'gpt-3.5-turbo-0301',
                modelProvider: 'openai',
                inputMessages: [{ role: 'user', content: 'What function would you call to finish this?' }],
                outputMessages: [{
                  role: 'assistant',
                  content: 'THOUGHT: Hi',
                  tool_calls: [
                    {
                      name: 'finish',
                      arguments: { answer: '5' },
                      type: 'function',
                      tool_id: 'call_Tg0o5wgoNSKF2iggAPmfWwem'
                    }
                  ]
                }],
                metadata: { tool_choice: 'auto', stream: true },
                tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
                tokenMetrics: { input_tokens: 9, output_tokens: 5, total_tokens: 14 }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            const stream = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo-0301',
              messages: [{ role: 'user', content: 'What function would you call to finish this?' }],
              tools: [{ type: 'function', function: { /* this doesn't matter */ } }],
              tool_choice: 'auto',
              stream: true
            })

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('delta')
            }

            await checkSpan
          })
        }
      }

      it('submits a completion span with an error', async () => {
        nock('https://api.openai.com:443')
          .post('/v1/completions')
          .reply(400, {})

        let error
        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createCompletion',
            inputMessages: [{ content: 'Hello' }],
            outputMessages: [{ content: '' }],
            modelName: 'gpt-3.5-turbo',
            modelProvider: 'openai',
            metadata: { max_tokens: 50 },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
            error,
            errorType: error.type || error.name,
            errorMessage: error.message,
            errorStack: error.stack
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        try {
          await openai.completions.create({
            model: 'gpt-3.5-turbo',
            prompt: 'Hello',
            max_tokens: 50
          })
        } catch (e) {
          error = e
        }

        await checkSpan
      })

      it('submits a chat completion span with an error', async () => {
        nock('https://api.openai.com:443')
          .post('/v1/chat/completions')
          .reply(400, {})

        let error
        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createChatCompletion',
            inputMessages: [{ role: 'user', content: 'Hello' }],
            outputMessages: [{ content: '' }],
            modelName: 'gpt-3.5-turbo',
            modelProvider: 'openai',
            metadata: { max_tokens: 50 },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
            error,
            errorType: error.type || error.name,
            errorMessage: error.message,
            errorStack: error.stack
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        try {
          await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 50
          })
        } catch (e) {
          error = e
        }

        await checkSpan
      })

      it('submits an AzureOpenAI completion', async () => {
        const isFromAzureOpenAIClass = azureOpenai.constructor.name === 'AzureOpenAI'
        const postEndpoint = isFromAzureOpenAIClass
          ? '//openai/deployments/some-model/chat/completions'
          : '/chat/completions'
        const query = isFromAzureOpenAIClass
          ? { 'api-version': '2024-05-01-preview' }
          : {}

        nock('https://dd.openai.azure.com:443')
          .post(postEndpoint)
          .query(query)
          .reply(200, {})

        const checkSpan = agent.assertSomeTraces(traces => {
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          expect(spanEvent).to.have.property('name', 'AzureOpenAI.createChatCompletion')
          expect(spanEvent.meta).to.have.property('model_provider', 'azure_openai')
        })

        await azureOpenai.chat.completions.create({
          model: 'some-model',
          messages: []
        })

        await checkSpan
      })

      it('submits an DeepSeek completion', async () => {
        nock('https://api.deepseek.com:443')
          .post('/chat/completions')
          .reply(200, {})

        const checkSpan = agent.assertSomeTraces(traces => {
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          expect(spanEvent).to.have.property('name', 'DeepSeek.createChatCompletion')
          expect(spanEvent.meta).to.have.property('model_provider', 'deepseek')
        })

        await deepseekOpenai.chat.completions.create({
          model: 'some-model',
          messages: []
        })

        await checkSpan
      })
    })
  })
})
