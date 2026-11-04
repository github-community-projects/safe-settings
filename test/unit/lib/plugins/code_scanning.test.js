const CodeScanning = require('../../../../lib/plugins/code_scanning')
const { isEmptyChange } = require('../../../../lib/settings')

describe('CodeScanning', () => {
  const repo = { owner: 'owner', repo: 'repo' }
  let github
  let log
  let errors

  function configure (config, nop = false) {
    return new CodeScanning(nop, github, repo, config, log, errors)
  }

  function currentSetup (data) {
    github.rest.codeScanning.getDefaultSetup.mockResolvedValueOnce({ data })
  }

  beforeEach(() => {
    log = { debug: jest.fn(), info: jest.fn(), error: jest.fn() }
    errors = []
    const updateDefaultSetup = jest.fn().mockResolvedValue({ status: 202, data: {} })
    updateDefaultSetup.endpoint = jest.fn(params => ({ url: 'https://api.github.com/repos/owner/repo/code-scanning/default-setup', body: params }))
    github = {
      rest: {
        codeScanning: {
          getDefaultSetup: jest.fn(),
          updateDefaultSetup
        }
      }
    }
  })

  describe('sync', () => {
    it('does nothing without a default_setup config', async () => {
      const results = await configure({}).sync()

      expect(results).toEqual([])
      expect(github.rest.codeScanning.getDefaultSetup).not.toHaveBeenCalled()
    })

    it('enables default setup with the declared fields', async () => {
      currentSetup({ state: 'not-configured', languages: [], query_suite: 'default' })
      const plugin = configure({ default_setup: { state: 'configured', query_suite: 'extended', languages: ['csharp', 'actions'] } })

      await plugin.sync()

      expect(github.rest.codeScanning.updateDefaultSetup).toHaveBeenCalledWith({
        ...repo,
        state: 'configured',
        query_suite: 'extended',
        languages: ['csharp', 'actions']
      })
      expect(plugin.hasChanges).toBe(true)
    })

    it('does not update when the declared fields match, whatever the language order', async () => {
      currentSetup({ state: 'configured', languages: ['actions', 'csharp'], query_suite: 'default', threat_model: 'remote', schedule: 'weekly' })
      const plugin = configure({ default_setup: { state: 'configured', languages: ['csharp', 'actions'] } })

      await plugin.sync()

      expect(github.rest.codeScanning.updateDefaultSetup).not.toHaveBeenCalled()
      expect(plugin.hasChanges).toBe(false)
    })

    it('updates when a declared field differs', async () => {
      currentSetup({ state: 'configured', languages: ['csharp'], query_suite: 'default', threat_model: 'remote' })

      await configure({ default_setup: { state: 'configured', threat_model: 'remote_and_local' } }).sync()

      expect(github.rest.codeScanning.updateDefaultSetup).toHaveBeenCalledWith({
        ...repo,
        state: 'configured',
        threat_model: 'remote_and_local'
      })
    })

    it('ignores duplicate languages when comparing', async () => {
      currentSetup({ state: 'configured', languages: ['actions', 'csharp'] })

      await configure({ default_setup: { state: 'configured', languages: ['csharp', 'actions', 'csharp'] } }).sync()

      expect(github.rest.codeScanning.updateDefaultSetup).not.toHaveBeenCalled()
    })

    it('updates when the configured languages differ', async () => {
      currentSetup({ state: 'configured', languages: ['csharp'], query_suite: 'default' })

      await configure({ default_setup: { state: 'configured', languages: ['csharp', 'actions'] } }).sync()

      expect(github.rest.codeScanning.updateDefaultSetup).toHaveBeenCalledWith({
        ...repo,
        state: 'configured',
        languages: ['csharp', 'actions']
      })
    })

    it('disables default setup and sends only the state', async () => {
      currentSetup({ state: 'configured', languages: ['csharp'], query_suite: 'default' })

      await configure({ default_setup: { state: 'not-configured', query_suite: 'extended' } }).sync()

      expect(github.rest.codeScanning.updateDefaultSetup).toHaveBeenCalledWith({ ...repo, state: 'not-configured' })
    })

    it('ignores the other fields when default setup is already disabled', async () => {
      currentSetup({ state: 'not-configured', languages: [], query_suite: 'default' })

      await configure({ default_setup: { state: 'not-configured', query_suite: 'extended' } }).sync()

      expect(github.rest.codeScanning.updateDefaultSetup).not.toHaveBeenCalled()
    })

    it('records an error when the update is rejected', async () => {
      currentSetup({ state: 'not-configured', languages: [] })
      github.rest.codeScanning.updateDefaultSetup.mockRejectedValueOnce({ status: 403, message: 'Code Security must be enabled for this repository to use code scanning.' })

      const results = await configure({ default_setup: { state: 'configured' } }).sync()

      expect(results).toEqual([])
      expect(errors).toHaveLength(1)
      expect(errors[0].msg).toContain('403 Code Security must be enabled')
    })
  })

  describe('declaredLanguages', () => {
    it('returns the languages of the highest-priority layer that declares them', () => {
      expect(CodeScanning.declaredLanguages([
        { default_setup: { languages: ['csharp', 'actions'] } },
        { default_setup: { state: 'configured' } },
        { default_setup: { languages: ['csharp'] } }
      ])).toEqual(['csharp'])
    })

    it('keeps an empty list so a layer can clear the inherited languages', () => {
      expect(CodeScanning.declaredLanguages([{ default_setup: { languages: ['csharp'] } }, undefined, { default_setup: { languages: [] } }])).toEqual([])
    })

    it('returns undefined when no layer declares languages', () => {
      expect(CodeScanning.declaredLanguages([undefined, {}, { default_setup: { state: 'configured' } }])).toBeUndefined()
    })
  })

  describe('nop', () => {
    it('reports the change without updating', async () => {
      currentSetup({ state: 'not-configured', languages: [] })

      const results = await configure({ default_setup: { state: 'configured', languages: ['csharp'] } }, true).sync()

      expect(github.rest.codeScanning.updateDefaultSetup).not.toHaveBeenCalled()
      expect(results).toHaveLength(1)
      expect(results[0].plugin).toBe('code_scanning')
      expect(results[0].type).toBe('INFO')
      expect(results[0].action.modifications).toEqual({ state: 'configured', languages: ['csharp'] })
      expect(results[0].action.deletions).toEqual({ state: 'not-configured', languages: [] })
      expect(results[0].body).toEqual({ ...repo, state: 'configured', languages: ['csharp'] })
    })

    it.each([
      ['languages', { languages: ['csharp'] }, { languages: [] }, ['csharp']],
      ['runner_label', { runner_type: 'labeled', runner_label: 'code-scanning' }, { runner_label: null }, 'code-scanning']
    ])('reports clearing %s as a deletion the report keeps', async (field, current, cleared, previous) => {
      currentSetup({ state: 'configured', ...current })

      const results = await configure({ default_setup: { state: 'configured', ...cleared } }, true).sync()

      expect(results).toHaveLength(1)
      expect(results[0].action.modifications).toEqual({})
      expect(results[0].action.deletions).toEqual({ [field]: previous })
      expect(results[0].body).toEqual({ ...repo, state: 'configured', ...cleared })
      expect(isEmptyChange(results[0].action)).toBe(false)
    })

    it('reports errors as ERROR results', async () => {
      github.rest.codeScanning.getDefaultSetup.mockRejectedValueOnce({ status: 403, message: 'Forbidden' })

      const results = await configure({ default_setup: { state: 'configured' } }, true).sync()

      expect(results).toHaveLength(1)
      expect(results[0].plugin).toBe('code_scanning')
      expect(results[0].type).toBe('ERROR')
      expect(errors).toHaveLength(0)
    })

    it('ignores a missing repository', async () => {
      github.rest.codeScanning.getDefaultSetup.mockRejectedValueOnce({ status: 404, message: 'Not Found' })

      const results = await configure({ default_setup: { state: 'configured' } }, true).sync()

      expect(results).toEqual([])
    })
  })
})
