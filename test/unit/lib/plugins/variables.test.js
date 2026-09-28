const { when } = require('jest-when')
const Variables = require('../../../../lib/plugins/variables')
const NopCommand = require('../../../../lib/nopcommand')

describe('Variables', () => {
  let github
  const org = 'bkeepers'
  const repo = 'test'

  function configure (nop = false, entries = [{ name: 'test', value: 'test' }]) {
    const log = { debug: jest.fn(), info: jest.fn(), error: console.error }
    const errors = []
    return new Variables(nop, github, { owner: org, repo }, entries, log, errors)
  }

  beforeEach(() => {
    github = {
      request: jest.fn().mockReturnValue(Promise.resolve(true))
    }
  })

  describe('constructor', () => {
    it('should uppercase entry names', () => {
      const plugin = configure(false, [{ name: 'lower_case', value: 'val' }])
      expect(plugin.entries[0].name).toBe('LOWER_CASE')
    })
  })

  describe('find', () => {
    it('should return only name and value fields', async () => {
      when(github.request)
        .calledWith('GET /repos/:org/:repo/actions/variables', { org, repo })
        .mockResolvedValue({
          data: {
            variables: [{ name: 'VAR1', value: 'val1', created_at: '2024-01-01', updated_at: '2024-01-02' }]
          }
        })

      const plugin = configure()
      const result = await plugin.find()

      expect(result).toEqual([{ name: 'VAR1', value: 'val1' }])
    })
  })

  describe('changed', () => {
    it('should return true when values differ', () => {
      const plugin = configure()
      expect(plugin.changed({ name: 'X', value: 'old' }, { name: 'X', value: 'new' })).toBe(true)
    })

    it('should return false when values match', () => {
      const plugin = configure()
      expect(plugin.changed({ name: 'X', value: 'same' }, { name: 'X', value: 'same' })).toBe(false)
    })
  })

  describe('sync', () => {
    it('should add new and remove stale variables', () => {
      const plugin = configure()

      when(github.request)
        .calledWith('GET /repos/:org/:repo/actions/variables', { org, repo })
        .mockResolvedValue({
          data: {
            variables: [{ name: 'DELETE_ME', value: 'test' }]
          }
        })

      return plugin.sync().then(() => {
        expect(github.request).toHaveBeenCalledWith(
          'DELETE /repos/:org/:repo/actions/variables/:variable_name',
          expect.objectContaining({ org, repo, variable_name: 'DELETE_ME' })
        )

        expect(github.request).toHaveBeenCalledWith(
          'POST /repos/:org/:repo/actions/variables',
          expect.objectContaining({ org, repo, name: 'TEST', value: 'test' })
        )
      })
    })

    it('should return NopCommands and not mutate when nop is true', async () => {
      const plugin = configure(true)

      when(github.request)
        .calledWith('GET /repos/:org/:repo/actions/variables', { org, repo })
        .mockResolvedValue({
          data: {
            variables: [{ name: 'EXISTING_VAR', value: 'existing-value' }]
          }
        })

      const result = await plugin.sync()

      expect(github.request).toHaveBeenCalledWith('GET /repos/:org/:repo/actions/variables', { org, repo })
      expect(github.request).not.toHaveBeenCalledWith(
        expect.stringMatching(/^(POST|PATCH|DELETE)/),
        expect.anything()
      )

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
      const flat = result.flat()
      flat.forEach(cmd => expect(cmd).toBeInstanceOf(NopCommand))
    })

    it('should return NopCommand results when updating via sync', async () => {
      const plugin = configure(true, [{ name: 'TEST', value: 'new-value' }])

      when(github.request)
        .calledWith('GET /repos/:org/:repo/actions/variables', { org, repo })
        .mockResolvedValue({
          data: {
            variables: [{ name: 'TEST', value: 'old-value' }]
          }
        })

      const result = await plugin.sync()

      expect(github.request).not.toHaveBeenCalledWith(
        expect.stringMatching(/^(POST|PATCH|DELETE)/),
        expect.anything()
      )

      expect(Array.isArray(result)).toBe(true)
      const flat = result.flat()
      flat.forEach(cmd => expect(cmd).toBeInstanceOf(NopCommand))
    })
  })

  describe('add', () => {
    it('should return NopCommand array when nop is true', async () => {
      const plugin = configure(true)
      const result = await plugin.add({ name: 'NEW_VAR', value: 'new-value' })

      expect(Array.isArray(result)).toBe(true)
      expect(result[0]).toBeInstanceOf(NopCommand)
      expect(result[0].plugin).toBe('Variables')
      expect(github.request).not.toHaveBeenCalled()
    })

    it('should make POST request when nop is false', async () => {
      const plugin = configure(false)
      await plugin.add({ name: 'NEW_VAR', value: 'new-value' })

      expect(github.request).toHaveBeenCalledWith(
        'POST /repos/:org/:repo/actions/variables',
        expect.objectContaining({ org, repo, name: 'NEW_VAR', value: 'new-value' })
      )
    })
  })

  describe('remove', () => {
    it('should return NopCommand array when nop is true', async () => {
      const plugin = configure(true)
      const result = await plugin.remove({ name: 'EXISTING_VAR', value: 'existing-value' })

      expect(Array.isArray(result)).toBe(true)
      expect(result[0]).toBeInstanceOf(NopCommand)
      expect(result[0].plugin).toBe('Variables')
      expect(github.request).not.toHaveBeenCalled()
    })

    it('should make DELETE request when nop is false', async () => {
      const plugin = configure(false)
      await plugin.remove({ name: 'EXISTING_VAR', value: 'existing-value' })

      expect(github.request).toHaveBeenCalledWith(
        'DELETE /repos/:org/:repo/actions/variables/:variable_name',
        expect.objectContaining({ org, repo, variable_name: 'EXISTING_VAR' })
      )
    })
  })

  describe('update', () => {
    it('should return NopCommand array when nop is true', async () => {
      const plugin = configure(true)
      const result = await plugin.update(
        { name: 'VAR1', value: 'old-value' },
        { name: 'VAR1', value: 'new-value' }
      )

      expect(Array.isArray(result)).toBe(true)
      expect(result[0]).toBeInstanceOf(NopCommand)
      expect(result[0].plugin).toBe('Variables')
      expect(github.request).not.toHaveBeenCalled()
    })

    it('should make PATCH request when nop is false', async () => {
      const plugin = configure(false)
      await plugin.update(
        { name: 'VAR1', value: 'old-value' },
        { name: 'VAR1', value: 'new-value' }
      )

      expect(github.request).toHaveBeenCalledWith(
        'PATCH /repos/:org/:repo/actions/variables/:variable_name',
        expect.objectContaining({ org, repo, variable_name: 'VAR1', value: 'new-value' })
      )
    })
  })
})
