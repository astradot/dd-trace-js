'use strict'

const fs = require('fs')
const path = require('path')

const FormData = require('../../../exporters/common/form-data')
const request = require('../../../exporters/common/request')
const { getEnvironmentVariable } = require('../../../config-helper')

const log = require('../../../log')
const { isFalse } = require('../../../util')
const {
  getLatestCommits,
  getRepositoryUrl,
  generatePackFilesForCommits,
  getCommitsRevList,
  isShallowRepository,
  unshallowRepository,
  isGitAvailable
} = require('../../../plugins/util/git')

const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS,
  TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS_MS,
  TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS_ERRORS,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_NUM,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_MS,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_ERRORS,
  TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_BYTES
} = require('../../../ci-visibility/telemetry')

const isValidSha1 = (sha) => /^[0-9a-f]{40}$/.test(sha)
const isValidSha256 = (sha) => /^[0-9a-f]{64}$/.test(sha)

function validateCommits (commits) {
  return commits.map(({ id: commitSha, type }) => {
    if (type !== 'commit') {
      throw new Error('Invalid commit type response')
    }
    if (isValidSha1(commitSha) || isValidSha256(commitSha)) {
      return commitSha.replaceAll(/[^0-9a-f]+/g, '')
    }
    throw new Error('Invalid commit format')
  })
}

function getCommonRequestOptions (url) {
  return {
    method: 'POST',
    headers: {
      'dd-api-key': getEnvironmentVariable('DD_API_KEY')
    },
    timeout: 15_000,
    url
  }
}

/**
 * This function posts the SHAs of the commits of the last month
 * The response are the commits for which the backend already has information
 * This response is used to know which commits can be ignored from there on
 */
function getCommitsToUpload ({ url, repositoryUrl, latestCommits, isEvpProxy, evpProxyPrefix }, callback) {
  const commonOptions = getCommonRequestOptions(url)

  const options = {
    ...commonOptions,
    headers: {
      ...commonOptions.headers,
      'Content-Type': 'application/json'
    },
    path: '/api/v2/git/repository/search_commits'
  }

  if (isEvpProxy) {
    options.path = `${evpProxyPrefix}/api/v2/git/repository/search_commits`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
    delete options.headers['dd-api-key']
  }

  const localCommitData = JSON.stringify({
    meta: {
      repository_url: repositoryUrl
    },
    data: latestCommits.map(commit => ({
      id: commit,
      type: 'commit'
    }))
  })

  incrementCountMetric(TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS)
  const startTime = Date.now()
  request(localCommitData, options, (err, response, statusCode) => {
    distributionMetric(TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS_MS, {}, Date.now() - startTime)
    if (err) {
      incrementCountMetric(TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS_ERRORS, { statusCode })
      const error = new Error(`Error fetching commits to exclude: ${err.message}`)
      return callback(error)
    }
    let alreadySeenCommits
    try {
      alreadySeenCommits = validateCommits(JSON.parse(response).data)
    } catch (e) {
      incrementCountMetric(TELEMETRY_GIT_REQUESTS_SEARCH_COMMITS_ERRORS, { errorType: 'network' })
      return callback(new Error(`Can't parse commits to exclude response: ${e.message}`))
    }
    log.debug('There are %s commits to exclude.', alreadySeenCommits.length)
    const commitsToInclude = latestCommits.filter((commit) => !alreadySeenCommits.includes(commit))
    log.debug('There are %s commits to include.', commitsToInclude.length)

    if (!commitsToInclude.length) {
      return callback(null, [])
    }

    const commitsToUpload = getCommitsRevList(alreadySeenCommits, commitsToInclude)

    if (commitsToUpload === null) {
      return callback(new Error('git rev-list failed'))
    }

    callback(null, commitsToUpload)
  })
}

/**
 * This function uploads a git packfile
 */
function uploadPackFile ({ url, isEvpProxy, evpProxyPrefix, packFileToUpload, repositoryUrl, headCommit }, callback) {
  const form = new FormData()

  const pushedSha = JSON.stringify({
    data: {
      id: headCommit,
      type: 'commit'
    },
    meta: {
      repository_url: repositoryUrl
    }
  })

  form.append('pushedSha', pushedSha, { contentType: 'application/json' })

  try {
    const packFileContent = fs.readFileSync(packFileToUpload)
    // The original filename includes a random prefix, so we remove it here
    const [, filename] = path.basename(packFileToUpload).split('-')
    form.append('packfile', packFileContent, {
      filename,
      contentType: 'application/octet-stream'
    })
  } catch {
    callback(new Error(`Could not read "${packFileToUpload}"`))
    return
  }

  const commonOptions = getCommonRequestOptions(url)

  const options = {
    ...commonOptions,
    path: '/api/v2/git/repository/packfile',
    headers: {
      ...commonOptions.headers,
      ...form.getHeaders()
    }
  }

  if (isEvpProxy) {
    options.path = `${evpProxyPrefix}/api/v2/git/repository/packfile`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
    delete options.headers['dd-api-key']
  }

  incrementCountMetric(TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES)

  const uploadSize = form.size()

  const startTime = Date.now()
  request(form, options, (err, _, statusCode) => {
    distributionMetric(TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_MS, {}, Date.now() - startTime)
    if (err) {
      incrementCountMetric(TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_ERRORS, { statusCode })
      const error = new Error(`Could not upload packfiles: status code ${statusCode}: ${err.message}`)
      return callback(error, uploadSize)
    }
    callback(null, uploadSize)
  })
}

function generateAndUploadPackFiles ({
  url,
  isEvpProxy,
  evpProxyPrefix,
  commitsToUpload,
  repositoryUrl,
  headCommit
}, callback) {
  log.debug('There are %s commits to upload', commitsToUpload.length)

  const packFilesToUpload = generatePackFilesForCommits(commitsToUpload)

  log.debug('Uploading %s packfiles.', packFilesToUpload.length)

  if (!packFilesToUpload.length) {
    return callback(new Error('Failed to generate packfiles'))
  }

  distributionMetric(TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_NUM, {}, packFilesToUpload.length)
  let packFileIndex = 0
  let totalUploadedBytes = 0
  // This uploads packfiles sequentially
  const uploadPackFileCallback = (err, byteLength) => {
    totalUploadedBytes += byteLength
    if (err || packFileIndex === packFilesToUpload.length) {
      distributionMetric(TELEMETRY_GIT_REQUESTS_OBJECT_PACKFILES_BYTES, {}, totalUploadedBytes)
      return callback(err)
    }
    return uploadPackFile(
      {
        packFileToUpload: packFilesToUpload[packFileIndex++],
        url,
        isEvpProxy,
        evpProxyPrefix,
        repositoryUrl,
        headCommit
      },
      uploadPackFileCallback
    )
  }

  uploadPackFile(
    {
      packFileToUpload: packFilesToUpload[packFileIndex++],
      url,
      isEvpProxy,
      evpProxyPrefix,
      repositoryUrl,
      headCommit
    },
    uploadPackFileCallback
  )
}

/**
 * This function uploads git metadata to CI Visibility's backend.
*/
function sendGitMetadata (url, { isEvpProxy, evpProxyPrefix }, configRepositoryUrl, callback) {
  if (!isGitAvailable()) {
    return callback(new Error('Git is not available'))
  }
  let repositoryUrl = configRepositoryUrl
  if (!repositoryUrl) {
    repositoryUrl = getRepositoryUrl()
  }

  log.debug('Uploading git history for repository', repositoryUrl)

  if (!repositoryUrl) {
    return callback(new Error('Repository URL is empty'))
  }

  let latestCommits = getLatestCommits()
  log.debug('There were %s commits since last month.', latestCommits.length)

  const getOnFinishGetCommitsToUpload = (hasCheckedShallow) => (err, commitsToUpload) => {
    if (err) {
      return callback(err)
    }

    if (!commitsToUpload.length) {
      log.debug('No commits to upload')
      return callback(null)
    }

    // If it has already unshallowed or the clone is not shallow, we move on
    if (hasCheckedShallow || !isShallowRepository()) {
      const [headCommit] = latestCommits
      return generateAndUploadPackFiles({
        url,
        isEvpProxy,
        evpProxyPrefix,
        commitsToUpload,
        repositoryUrl,
        headCommit
      }, callback)
    }
    // Otherwise we unshallow and get commits to upload again
    log.debug('It is shallow clone, unshallowing...')
    if (!isFalse(getEnvironmentVariable('DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED'))) {
      unshallowRepository(false)
    }

    // The latest commits change after unshallowing
    latestCommits = getLatestCommits()
    getCommitsToUpload({
      url,
      repositoryUrl,
      latestCommits,
      isEvpProxy,
      evpProxyPrefix
    }, getOnFinishGetCommitsToUpload(true))
  }

  getCommitsToUpload({
    url,
    repositoryUrl,
    latestCommits,
    isEvpProxy,
    evpProxyPrefix
  }, getOnFinishGetCommitsToUpload(false))
}

module.exports = {
  sendGitMetadata
}
