'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const log = require('../../dd-trace/src/log')

class OracledbPlugin extends DatabasePlugin {
  static get id () { return 'oracledb' }
  static get system () { return 'oracle' }
  static get peerServicePrecursors () { return ['db.instance', 'db.hostname'] }

  start ({ query, connAttrs }) {
    const service = this.serviceName({ pluginConfig: this.config, params: connAttrs })
    // Users can pass either connectString or connectionString
    const url = getUrl(connAttrs.connectString || connAttrs.connectionString)

    this.startSpan(this.operationName(), {
      service,
      resource: query,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.user': this.config.user,
        'db.instance': url.pathname && url.pathname.slice(1),
        'db.hostname': url.hostname,
        [CLIENT_PORT_KEY]: url.port
      }
    })
  }
}

// TODO: Avoid creating an error since it's a heavy operation.
function getUrl (connectString) {
  try {
    return new URL(`http://${connectString}`)
  } catch (e) {
    log.error('Invalid oracle connection string', e)
    return {}
  }
}

module.exports = OracledbPlugin
