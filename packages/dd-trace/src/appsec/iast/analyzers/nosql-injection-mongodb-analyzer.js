'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { NOSQL_MONGODB_INJECTION } = require('../vulnerabilities')
const { getRanges, addSecureMark } = require('../taint-tracking/operations')
const { getNodeModulesPaths } = require('../path-line')
const { storage } = require('../../../../../datadog-core')
const { getIastContext } = require('../iast-context')
const { HTTP_REQUEST_PARAMETER, HTTP_REQUEST_BODY } = require('../taint-tracking/source-types')

const EXCLUDED_PATHS_FROM_STACK = getNodeModulesPaths('mongodb', 'mongoose', 'mquery')
const { NOSQL_MONGODB_INJECTION_MARK } = require('../taint-tracking/secure-marks')
const { iterateObjectStrings } = require('../utils')

class NosqlInjectionMongodbAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(NOSQL_MONGODB_INJECTION)
    this.sanitizedObjects = new WeakSet()
  }

  onConfigure () {
    this.configureSanitizers()

    const onStart = ({ filters }) => {
      const store = storage('legacy').getStore()
      if (store && !store.nosqlAnalyzed && filters?.length) {
        filters.forEach(filter => {
          this.analyze({ filter }, store)
        })
      }

      return store
    }

    const onStartAndEnterWithStore = (message) => {
      const store = onStart(message || {})
      if (store) {
        storage('legacy').enterWith({ ...store, nosqlAnalyzed: true, nosqlParentStore: store })
      }
    }

    const onFinish = () => {
      const store = storage('legacy').getStore()
      if (store?.nosqlParentStore) {
        storage('legacy').enterWith(store.nosqlParentStore)
      }
    }

    this.addSub('datadog:mongodb:collection:filter:start', onStart)

    this.addSub('datadog:mongoose:model:filter:start', onStartAndEnterWithStore)
    this.addSub('datadog:mongoose:model:filter:finish', onFinish)

    this.addSub('datadog:mquery:filter:prepare', onStart)
    this.addSub('tracing:datadog:mquery:filter:start', onStartAndEnterWithStore)
    this.addSub('tracing:datadog:mquery:filter:asyncEnd', onFinish)
  }

  configureSanitizers () {
    this.addNotSinkSub('datadog:express-mongo-sanitize:filter:finish', ({ sanitizedProperties, req }) => {
      const store = storage('legacy').getStore()
      const iastContext = getIastContext(store)

      if (iastContext) { // do nothing if we are not in an iast request
        sanitizedProperties.forEach(key => {
          iterateObjectStrings(req[key], function (value, levelKeys) {
            if (typeof value === 'string') {
              let parentObj = req[key]
              const levelsLength = levelKeys.length

              for (let i = 0; i < levelsLength; i++) {
                const currentLevelKey = levelKeys[i]

                if (i === levelsLength - 1) {
                  parentObj[currentLevelKey] = addSecureMark(iastContext, value, NOSQL_MONGODB_INJECTION_MARK)
                } else {
                  parentObj = parentObj[currentLevelKey]
                }
              }
            }
          })
        })
      }
    })

    this.addNotSinkSub('datadog:express-mongo-sanitize:sanitize:finish', ({ sanitizedObject }) => {
      const store = storage('legacy').getStore()
      const iastContext = getIastContext(store)

      if (iastContext) { // do nothing if we are not in an iast request
        iterateObjectStrings(sanitizedObject, function (value, levelKeys, parent, lastKey) {
          try {
            parent[lastKey] = addSecureMark(iastContext, value, NOSQL_MONGODB_INJECTION_MARK)
          } catch {
            // if it is a readonly property, do nothing
          }
        })
      }
    })

    this.addNotSinkSub('datadog:mongoose:sanitize-filter:finish', ({ sanitizedObject }) => {
      this.sanitizedObjects.add(sanitizedObject)
    })
  }

  _isVulnerableRange (range) {
    const rangeType = range?.iinfo?.type
    return rangeType === HTTP_REQUEST_PARAMETER || rangeType === HTTP_REQUEST_BODY
  }

  _isVulnerable (value, iastContext) {
    if (value?.filter && iastContext) {
      let isVulnerable = false

      if (this.sanitizedObjects.has(value.filter)) {
        return false
      }

      const rangesByKey = {}
      const allRanges = []

      iterateObjectStrings(value.filter, (val, nextLevelKeys) => {
        let ranges = getRanges(iastContext, val)
        if (ranges?.length) {
          const filteredRanges = []

          ranges = this._filterSecureRanges(ranges)
          if (!ranges.length) {
            this._incrementSuppressedMetric(iastContext)
          }

          for (const range of ranges) {
            if (this._isVulnerableRange(range)) {
              isVulnerable = true
              filteredRanges.push(range)
            }
          }

          if (filteredRanges.length > 0) {
            rangesByKey[nextLevelKeys.join('.')] = filteredRanges
            allRanges.push(...filteredRanges)
          }
        }
      }, [], 4)

      if (isVulnerable) {
        value.rangesToApply = rangesByKey
        value.ranges = allRanges
      }

      return isVulnerable
    }
    return false
  }

  _getEvidence (value, iastContext) {
    return { value: value.filter, rangesToApply: value.rangesToApply, ranges: value.ranges }
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS_FROM_STACK
  }
}

module.exports = new NosqlInjectionMongodbAnalyzer()
