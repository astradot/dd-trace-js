'use strict'

const { USER_ID } = require('../addresses')
const waf = require('../waf')
const { getRootSpan } = require('./utils')
const { block, getBlockingAction } = require('../blocking')
const { storage } = require('../../../../datadog-core')
const { setUserTags } = require('./set_user')
const log = require('../../log')

function isUserBlocked (user) {
  const results = waf.run({ persistent: { [USER_ID]: user.id } })
  return !!getBlockingAction(results?.actions)
}

function checkUserAndSetUser (tracer, user) {
  if (!user || !user.id) {
    log.warn('[ASM] Invalid user provided to isUserBlocked')
    return false
  }

  const rootSpan = getRootSpan(tracer)
  if (rootSpan) {
    if (!rootSpan.context()._tags['usr.id']) {
      setUserTags(user, rootSpan)
    }
  } else {
    log.warn('[ASM] Root span not available in isUserBlocked')
  }

  return isUserBlocked(user)
}

function blockRequest (tracer, req, res) {
  if (!req || !res) {
    const store = storage('legacy').getStore()
    if (store) {
      req = req || store.req
      res = res || store.res
    }
  }

  if (!req || !res) {
    log.warn('[ASM] Requests or response object not available in blockRequest')
    return false
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in blockRequest')
    return false
  }

  return block(req, res, rootSpan)
}

module.exports = {
  checkUserAndSetUser,
  blockRequest
}
