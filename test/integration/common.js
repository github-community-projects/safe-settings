const { createProbot } = require('probot')
const nock = require('nock')
const any = require('@travi/any')
const settingsBot = require('../../index')
const settings = require('../../lib/settings')

nock.disableNetConnect()

const repository = {
  default_branch: 'master',
  name: 'botland',
  owner: {
    name: 'bkeepers-inc',
    email: null
  }
}

function loadInstance () {
  // Probot 13's `createProbot` only reads `overrides`/`defaults`/`env`, so the
  // old positional `{ id, cert, githubToken }` args were silently dropped,
  // leaving no credentials and making `@octokit/auth-app` throw
  // "appId option is required". Provide dummy credentials via `overrides`.
  // Using a `githubToken` selects Octokit's token auth strategy, which avoids
  // the app-auth JWT/installation-token calls that the nock scopes don't mock.
  //
  // The app also runs `info()` on load, which lists app installations. Stub
  // that startup call with an empty list so it resolves cleanly under
  // `nock.disableNetConnect()` without interfering with the per-test scopes.
  nock('https://api.github.com')
    .persist()
    .get('/app/installations')
    .query(true)
    .reply(200, [])

  const probot = createProbot({
    overrides: {
      appId: 1,
      githubToken: 'test'
    }
  })
  probot.load(settingsBot)

  return probot
}

function initializeNock () {
  return nock('https://api.github.com')
}

function teardownNock (githubScope) {
  expect(githubScope.isDone()).toBe(true)

  nock.cleanAll()
}

function buildPushEvent () {
  return {
    name: 'push',
    payload: {
      ref: 'refs/heads/master',
      repository,
      commits: [{ modified: [settings.FILE_PATH], added: [] }]
    }
  }
}

function buildRepositoryEditedEvent () {
  return {
    name: 'repository.edited',
    payload: {
      changes: { default_branch: { from: any.word() } },
      repository
    }
  }
}

function buildRepositoryCreatedEvent () {
  return {
    name: 'repository.created',
    payload: { repository }
  }
}

function buildTriggerEvent () {
  return any.fromList([buildPushEvent(), buildRepositoryCreatedEvent(), buildRepositoryEditedEvent()])
}

module.exports = {
  loadInstance,
  initializeNock,
  teardownNock,
  buildTriggerEvent,
  buildRepositoryCreatedEvent,
  buildRepositoryEditedEvent,
  repository
}
