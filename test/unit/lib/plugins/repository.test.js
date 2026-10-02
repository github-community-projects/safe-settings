const Repository = require('../../../../lib/plugins/repository')
const env = require('../../../../lib/env')

describe('Repository', () => {
  const github = {
    rest: {
      repos: {
        get: jest.fn().mockResolvedValue({
          data: {
            topics: []
          }
        }),
        getBranch: jest.fn().mockResolvedValue({ data: { name: 'main', commit: { sha: 'abc123' } } }),
        update: jest.fn().mockResolvedValue(),
        renameBranch: jest.fn().mockResolvedValue(),
        replaceAllTopics: jest.fn().mockResolvedValue()
      },
      git: {
        createRef: jest.fn().mockResolvedValue()
      }
    }
  }
  const log = jest.fn()
  log.debug = jest.fn()
  log.error = jest.fn()
  log.info = jest.fn()

  function configure (config) {
    const nop = false
    const errors = []
    return new Repository(nop, github, { owner: 'bkeepers', repo: 'test' }, config, 1, log, errors)
  }

  describe('sync', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('syncs repository settings', () => {
      const plugin = configure({
        name: 'test',
        description: 'Hello World!',
        topics: []
      })
      return plugin.sync().then(() => {
        expect(github.rest.repos.update).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          name: 'test',
          description: 'Hello World!',
          mediaType: { previews: ['nebula-preview'] }
        })
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Applying repository settings changes to bkeepers/test'))
      })
    })

    it('handles renames', () => {
      const plugin = configure({
        name: 'new-name'
      })
      return plugin.sync().then(() => {
        expect(github.rest.repos.update).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          name: 'new-name',
          mediaType: { previews: ['nebula-preview'] }
        })
      })
    })

    it('syncs topics', () => {
      const plugin = configure({
        topics: ['foo', 'bar']
      })

      return plugin.sync().then(() => {
        expect(github.rest.repos.replaceAllTopics).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          names: ['foo', 'bar'],
          mediaType: {
            previews: ['mercy']
          }
        })
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Applying topic changes to bkeepers/test'))
      })
    })
  })

  describe('default_branch reconciliation', () => {
    const originalFlag = env.CREATE_DEFAULT_BRANCH

    beforeEach(() => {
      jest.clearAllMocks()
      github.rest.repos.get.mockResolvedValue({
        data: {
          name: 'test',
          default_branch: 'master',
          topics: []
        }
      })
    })

    afterEach(() => {
      env.CREATE_DEFAULT_BRANCH = originalFlag
    })

    describe('when CREATE_DEFAULT_BRANCH is disabled (default)', () => {
      beforeEach(() => {
        env.CREATE_DEFAULT_BRANCH = false
      })

      it('renames the current default branch when the configured branch is missing', () => {
        github.rest.repos.getBranch.mockRejectedValueOnce({ status: 404 })
        const plugin = configure({ default_branch: 'main' })
        return plugin.sync().then(() => {
          expect(github.rest.repos.renameBranch).toHaveBeenCalledWith({
            owner: 'bkeepers',
            repo: 'test',
            branch: 'master',
            new_name: 'main'
          })
          expect(github.rest.git.createRef).not.toHaveBeenCalled()
        })
      })
    })

    describe('when CREATE_DEFAULT_BRANCH is enabled', () => {
      beforeEach(() => {
        env.CREATE_DEFAULT_BRANCH = true
      })

      it('creates the branch off the current default and promotes it without renaming', () => {
        // First getBranch call (for the configured branch) 404s; the second
        // (for the current default) returns its SHA.
        github.rest.repos.getBranch
          .mockRejectedValueOnce({ status: 404 })
          .mockResolvedValueOnce({ data: { name: 'master', commit: { sha: 'deadbeef' } } })
        const plugin = configure({ default_branch: 'main' })
        return plugin.sync().then(() => {
          expect(github.rest.git.createRef).toHaveBeenCalledWith({
            owner: 'bkeepers',
            repo: 'test',
            ref: 'refs/heads/main',
            sha: 'deadbeef'
          })
          expect(github.rest.repos.update).toHaveBeenCalledWith({
            owner: 'bkeepers',
            repo: 'test',
            default_branch: 'main'
          })
          expect(github.rest.repos.renameBranch).not.toHaveBeenCalled()
        })
      })

      it('only sets the default branch when the configured branch already exists', () => {
        github.rest.repos.getBranch.mockResolvedValueOnce({ data: { name: 'main', commit: { sha: 'abc123' } } })
        const plugin = configure({ default_branch: 'main' })
        return plugin.sync().then(() => {
          expect(github.rest.git.createRef).not.toHaveBeenCalled()
          expect(github.rest.repos.renameBranch).not.toHaveBeenCalled()
          expect(github.rest.repos.update).toHaveBeenCalledWith({
            owner: 'bkeepers',
            repo: 'test',
            default_branch: 'main'
          })
        })
      })

      it('propagates errors when branch creation fails instead of swallowing them', () => {
        github.rest.git.createRef.mockRejectedValueOnce({ status: 422, message: 'boom' })
        const errors = []
        const plugin = new Repository(false, github, { owner: 'bkeepers', repo: 'test' }, { default_branch: 'main' }, 1, log, errors)
        const resArray = []
        return expect(plugin.createDefaultBranch('master', 'main', resArray)).rejects.toEqual({ status: 422, message: 'boom' }).then(() => {
          // The failure is recorded rather than silently swallowed, and the
          // default branch is never updated when branch creation fails.
          expect(errors).toHaveLength(1)
          expect(github.rest.repos.update).not.toHaveBeenCalled()
        })
      })
    })
  })
})
