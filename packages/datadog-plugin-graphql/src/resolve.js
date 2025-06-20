'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const dc = require('dc-polyfill')

const collapsedPathSym = Symbol('collapsedPaths')

class GraphQLResolvePlugin extends TracingPlugin {
  static get id () { return 'graphql' }
  static get operation () { return 'resolve' }

  start ({ info, context, args }) {
    const path = getPath(info, this.config)

    if (!shouldInstrument(this.config, path)) return
    const computedPathString = path.join('.')

    if (this.config.collapse) {
      if (context.fields[computedPathString]) return

      if (!context[collapsedPathSym]) {
        context[collapsedPathSym] = {}
      } else if (context[collapsedPathSym][computedPathString]) {
        return
      }

      context[collapsedPathSym][computedPathString] = true
    }

    const document = context.source
    const fieldNode = info.fieldNodes.find(fieldNode => fieldNode.kind === 'Field')
    const loc = this.config.source && document && fieldNode && fieldNode.loc
    const source = loc && document.slice(loc.start, loc.end)

    const span = this.startSpan('graphql.resolve', {
      service: this.config.service,
      resource: `${info.fieldName}:${info.returnType}`,
      type: 'graphql',
      meta: {
        'graphql.field.name': info.fieldName,
        'graphql.field.path': computedPathString,
        'graphql.field.type': info.returnType.name,
        'graphql.source': source
      }
    })

    if (fieldNode && this.config.variables && fieldNode.arguments) {
      const variables = this.config.variables(info.variableValues)

      fieldNode.arguments
        .filter(arg => arg.value?.name && arg.value.kind === 'Variable' && variables[arg.value.name.value])
        .forEach(arg => {
          const name = arg.value.name.value
          span.setTag(`graphql.variables.${name}`, variables[name])
        })
    }

    if (this.resolverStartCh.hasSubscribers) {
      this.resolverStartCh.publish({ context, resolverInfo: getResolverInfo(info, args) })
    }
  }

  constructor (...args) {
    super(...args)

    this.addTraceSub('updateField', ({ field, info, err }) => {
      const path = getPath(info, this.config)

      if (!shouldInstrument(this.config, path)) return

      const span = this.activeSpan
      field.finishTime = span._getTime ? span._getTime() : 0
      field.error = field.error || err
    })

    this.resolverStartCh = dc.channel('datadog:graphql:resolver:start')
  }

  configure (config) {
    // this will disable resolve subscribers if `config.depth` is set to 0
    super.configure(config.depth === 0 ? false : config)
  }

  finish (finishTime) {
    this.activeSpan.finish(finishTime)
  }
}

// helpers

function shouldInstrument (config, path) {
  let depth = 0
  for (const item of path) {
    if (typeof item === 'string') {
      depth += 1
    }
  }

  return config.depth < 0 || config.depth >= depth
}

function getPath (info, config) {
  const responsePathAsArray = config.collapse
    ? withCollapse(pathToArray)
    : pathToArray
  return responsePathAsArray(info && info.path)
}

function pathToArray (path) {
  const flattened = []
  let curr = path
  while (curr) {
    flattened.push(curr.key)
    curr = curr.prev
  }
  return flattened.reverse()
}

function withCollapse (responsePathAsArray) {
  return function () {
    return responsePathAsArray.apply(this, arguments)
      .map(segment => typeof segment === 'number' ? '*' : segment)
  }
}

function getResolverInfo (info, args) {
  let resolverInfo = null
  const resolverVars = {}

  if (args) {
    Object.assign(resolverVars, args)
  }

  let hasResolvers = false
  const directives = info.fieldNodes?.[0]?.directives
  if (Array.isArray(directives)) {
    for (const directive of directives) {
      const argList = {}
      for (const argument of directive.arguments) {
        argList[argument.name.value] = argument.value.value
      }

      if (directive.arguments.length > 0) {
        hasResolvers = true
        resolverVars[directive.name.value] = argList
      }
    }
  }

  if (hasResolvers || args && Object.keys(resolverVars).length) {
    resolverInfo = { [info.fieldName]: resolverVars }
  }

  return resolverInfo
}

module.exports = GraphQLResolvePlugin
