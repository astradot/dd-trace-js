'use strict'

const Analyzer = require('./vulnerability-analyzer')

const SC_MOVED_PERMANENTLY = 301
const SC_MOVED_TEMPORARILY = 302
const SC_NOT_MODIFIED = 304
const SC_TEMPORARY_REDIRECT = 307
const SC_NOT_FOUND = 404
const SC_GONE = 410
const SC_INTERNAL_SERVER_ERROR = 500

const IGNORED_RESPONSE_STATUS_LIST = new Set([SC_MOVED_PERMANENTLY, SC_MOVED_TEMPORARILY, SC_NOT_MODIFIED,
  SC_TEMPORARY_REDIRECT, SC_NOT_FOUND, SC_GONE, SC_INTERNAL_SERVER_ERROR])
const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml']

class MissingHeaderAnalyzer extends Analyzer {
  constructor (type, headerName) {
    super(type)

    this.headerName = headerName
  }

  onConfigure () {
    this.addSub({
      channelName: 'datadog:iast:response-end',
      moduleName: 'http'
    }, (data) => this.analyze(data))
  }

  _getHeaderValues (res, storedHeaders, headerName) {
    headerName = headerName.toLowerCase()
    const headerValue = res.getHeader(headerName) || storedHeaders[headerName]
    if (Array.isArray(headerValue)) {
      return headerValue
    }
    return headerValue ? [headerValue.toString()] : []
  }

  _getLocation () {}

  _checkOCE (context) {
    return true
  }

  _createHashSource (type, evidence, location) {
    return `${type}:${this.config.tracerConfig.service}`
  }

  _getEvidence ({ res, storedHeaders }) {
    const headerValues = this._getHeaderValues(res, storedHeaders, this.headerName)
    let value
    if (headerValues.length === 1) {
      value = headerValues[0]
    } else if (headerValues.length > 0) {
      value = JSON.stringify(headerValues)
    }
    return { value }
  }

  _isVulnerable ({ req, res, storedHeaders }, context) {
    if (!IGNORED_RESPONSE_STATUS_LIST.has(res.statusCode) && this._isResponseHtml(res, storedHeaders)) {
      return this._isVulnerableFromRequestAndResponse(req, res, storedHeaders)
    }
    return false
  }

  _isVulnerableFromRequestAndResponse (req, res, storedHeaders) {
    return false
  }

  _isResponseHtml (res, storedHeaders) {
    const contentTypes = this._getHeaderValues(res, storedHeaders, 'content-type')
    return contentTypes.some(contentType => {
      return contentType && HTML_CONTENT_TYPES.some(htmlContentType => {
        return htmlContentType === contentType || contentType.startsWith(htmlContentType + ';')
      })
    })
  }
}

module.exports = { MissingHeaderAnalyzer }
