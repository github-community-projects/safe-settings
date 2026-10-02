/* eslint-disable no-undef */

const { when } = require('jest-when')
const Branches = require('../../../../lib/plugins/branches')

describe('Branches', () => {
  let github
  const log = jest.fn()
  log.debug = jest.fn()
  log.error = jest.fn()
  log.info = jest.fn()

  function configure (config) {
    const nop = false
    const errors = []
    return new Branches(nop, github, { owner: 'bkeepers', repo: 'test' }, config, log, errors)
  }

  beforeEach(() => {
    github = {
      rest: {
        repos: {
          get: jest.fn().mockResolvedValue({
            data: {
              default_branch: 'main'
            }
          }),
          getBranchProtection: jest.fn().mockResolvedValue({
            data: {
              enforce_admins: { enabled: false }
            }
          }),
          updateBranchProtection: jest.fn().mockImplementation(() => Promise.resolve('updateBranchProtection')),
          deleteBranchProtection: jest.fn().mockImplementation(() => Promise.resolve('deleteBranchProtection'))
        }
      }
    }
  })

  describe('sync', () => {
    it('syncs branch protection settings', () => {
      const plugin = configure(
        [{
          name: 'master',
          protection: {
            required_status_checks: {
              strict: true,
              contexts: ['travis-ci']
            },
            enforce_admins: true,
            required_pull_request_reviews: {
              require_code_owner_reviews: true
            }
          }
        }]
      )

      return plugin.sync().then(() => {
        expect(github.rest.repos.updateBranchProtection).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          branch: 'master',
          required_status_checks: {
            strict: true,
            contexts: ['travis-ci']
          },
          enforce_admins: true,
          required_pull_request_reviews: {
            require_code_owner_reviews: true
          },
          restrictions: null,
          headers: { accept: 'application/vnd.github.hellcat-preview+json,application/vnd.github.luke-cage-preview+json,application/vnd.github.zzzax-preview+json' }
        })
      })
    })

    it('logs the applied branch protection change at info level', () => {
      const plugin = configure(
        [{
          name: 'master',
          protection: { enforce_admins: true }
        }]
      )

      return plugin.sync().then(() => {
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Applying branch protection changes to master branch of bkeepers/test'))
      })
    })

    describe('when the "protection" config is empty object', () => {
      it('removes branch protection', () => {
        const plugin = configure(
          [{
            name: 'master',
            protection: {}
          }]
        )

        return plugin.sync().then(() => {
          expect(github.rest.repos.updateBranchProtection).not.toHaveBeenCalled()
          expect(github.rest.repos.deleteBranchProtection).toHaveBeenCalledWith({
            owner: 'bkeepers',
            repo: 'test',
            branch: 'master'
          })
        })
      })
    })

    describe('when the "protection" config is set to `null`', () => {
      it('removes branch protection', () => {
        const plugin = configure(
          [{
            name: 'master',
            protection: null
          }]
        )

        return plugin.sync().then(() => {
          expect(github.rest.repos.updateBranchProtection).not.toHaveBeenCalled()
          expect(github.rest.repos.deleteBranchProtection).toHaveBeenCalledWith({
            owner: 'bkeepers',
            repo: 'test',
            branch: 'master'
          })
        })
      })
    })

    describe('when the "protection" config is set to an empty array', () => {
      it('removes branch protection', () => {
        const plugin = configure(
          [{
            name: 'master',
            protection: []
          }]
        )

        return plugin.sync().then(() => {
          expect(github.rest.repos.updateBranchProtection).not.toHaveBeenCalled()
          expect(github.rest.repos.deleteBranchProtection).toHaveBeenCalledWith({
            owner: 'bkeepers',
            repo: 'test',
            branch: 'master'
          })
        })
      })
    })

    describe('when the "protection" config is set to `false`', () => {
      it('removes branch protection', () => {
        const plugin = configure(
          [{
            name: 'master',
            protection: false
          }]
        )

        return plugin.sync().then(() => {
          expect(github.rest.repos.updateBranchProtection).not.toHaveBeenCalled()
          expect(github.rest.repos.deleteBranchProtection).toHaveBeenCalledWith({
            owner: 'bkeepers',
            repo: 'test',
            branch: 'master'
          })
        })
      })
    })

    describe('when the "protection" key is not present', () => {
      it('makes no change to branch protection', () => {
        const plugin = configure(
          [{
            name: 'master'
          }]
        )

        return plugin.sync().then(() => {
          expect(github.rest.repos.updateBranchProtection).not.toHaveBeenCalled()
          expect(github.rest.repos.deleteBranchProtection).not.toHaveBeenCalled()
        })
      })
    })

    describe('when {{EXTERNALLY_DEFINED}} is present in "required_status_checks" and no status checks exist in GitHub', () => {
      it('it initialises the status checks with an empty list', () => {
        const plugin = configure(
          [{
            name: 'main',
            protection: {
              required_status_checks: {
                strict: true,
                contexts: ['{{travis-ci', '{{EXTERNALLY_DEFINED}}']
              }
            }
          }]
        )

        return plugin.sync().then(() => {
          expect(github.rest.repos.updateBranchProtection).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'bkeepers',
            repo: 'test',
            branch: 'main',
            required_status_checks: {
              strict: true,
              contexts: []
            },
            // Existing enforce_admins should be preserved from GitHub
            enforce_admins: false,
            restrictions: null,
            headers: { accept: 'application/vnd.github.hellcat-preview+json,application/vnd.github.luke-cage-preview+json,application/vnd.github.zzzax-preview+json' }
          }))
        })
      })
    })

    describe('when existing protection has restrictions', () => {
      it('preserves restrictions from GitHub when config omits them', () => {
        github.rest.repos.getBranchProtection = jest.fn().mockResolvedValue({
          data: {
            enforce_admins: { enabled: true },
            required_status_checks: {
              strict: false,
              contexts: ['ci-check'],
              checks: []
            },
            restrictions: {
              url: 'https://api.github.com/...',
              users: [{ login: 'user1' }, { login: 'user2' }],
              teams: [{ slug: 'team-a' }],
              apps: [{ slug: 'app-bot' }]
            }
          }
        })

        // Config only specifies enforce_admins, omits restrictions
        const plugin = configure([{
          name: 'main',
          protection: {
            enforce_admins: false
          }
        }])

        return plugin.sync().then(() => {
          expect(github.rest.repos.updateBranchProtection).toHaveBeenCalledWith(
            expect.objectContaining({
              owner: 'bkeepers',
              repo: 'test',
              branch: 'main',
              enforce_admins: false,
              // Existing restrictions should be preserved from GitHub
              restrictions: {
                users: ['user1', 'user2'],
                teams: ['team-a'],
                apps: ['app-bot']
              },
              // Existing required_status_checks should be preserved from GitHub
              required_status_checks: {
                strict: false,
                contexts: ['ci-check'],
                checks: []
              }
            })
          )
        })
      })

      it('normalizes restrictions and defaults missing arrays when preserving from GitHub', () => {
        github.rest.repos.getBranchProtection = jest.fn().mockResolvedValue({
          data: {
            enforce_admins: { enabled: true },
            restrictions: {
              url: 'https://api.github.com/...',
              users: [{ login: 'user1' }]
            }
          }
        })

        const plugin = configure([{
          name: 'main',
          protection: {
            enforce_admins: false
          }
        }])

        return plugin.sync().then(() => {
          const payload = github.rest.repos.updateBranchProtection.mock.calls[0][0]
          expect(payload.restrictions).toEqual({
            users: ['user1'],
            teams: [],
            apps: []
          })
          expect(payload.restrictions.url).toBeUndefined()
        })
      })
    })

    describe('when {{EXTERNALLY_DEFINED}} is present in "required_status_checks" and status checks exist in GitHub', () => {
      it('it retains the status checks from GitHub', () => {
        github.rest.repos.getBranchProtection = jest.fn().mockResolvedValue({
          data: {
            enforce_admins: { enabled: false },
            required_status_checks: {
              contexts: ['check-1', 'check-2']
            }
          }
        })
        const plugin = configure(
          [{
            name: 'main',
            protection: {
              required_status_checks: {
                strict: true,
                contexts: ['{{travis-ci', '{{EXTERNALLY_DEFINED}}']
              }
            }
          }]
        )

        return plugin.sync().then(() => {
          expect(github.rest.repos.updateBranchProtection).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'bkeepers',
            repo: 'test',
            branch: 'main',
            required_status_checks: {
              strict: true,
              contexts: ['check-1', 'check-2']
            },
            enforce_admins: false,
            restrictions: null,
            headers: { accept: 'application/vnd.github.hellcat-preview+json,application/vnd.github.luke-cage-preview+json,application/vnd.github.zzzax-preview+json' }
          }))
        })
      })
    })

    describe('when multiple branches are configured', () => {
      it('applies mixed updates, additions and deletions once without writing unchanged branches', async () => {
        when(github.rest.repos.getBranchProtection)
          .calledWith(expect.objectContaining({ branch: 'new' }))
          .mockRejectedValue({ status: 404 })
        const plugin = configure([
          { name: 'default', protection: { enforce_admins: true } },
          { name: 'new', protection: { enforce_admins: true } },
          { name: 'unchanged', protection: { enforce_admins: false } },
          { name: 'removed', protection: null },
          { name: 'unmanaged' }
        ])

        await plugin.sync()

        expect(github.rest.repos.updateBranchProtection.mock.calls.map(([params]) => params.branch)).toEqual(['main', 'new'])
        expect(github.rest.repos.deleteBranchProtection).toHaveBeenCalledTimes(1)
        expect(github.rest.repos.deleteBranchProtection).toHaveBeenCalledWith({
          owner: 'bkeepers', repo: 'test', branch: 'removed'
        })
      })

      it('updates them each appropriately', () => {
        const plugin = configure(
          [
            {
              name: 'master',
              protection: { enforce_admins: true }
            },
            {
              name: 'other',
              protection: { enforce_admins: false }
            }
          ]
        )

        when(github.rest.repos.getBranchProtection)
          .calledWith(expect.objectContaining({
            branch: 'other'
          })).mockResolvedValue({
            data: {
              enforce_admins: { enabled: true }
            }
          })

        return plugin.sync().then(() => {
          expect(github.rest.repos.updateBranchProtection).toHaveBeenCalledTimes(2)

          expect(github.rest.repos.updateBranchProtection).toHaveBeenLastCalledWith({
            owner: 'bkeepers',
            repo: 'test',
            branch: 'other',
            enforce_admins: false,
            required_status_checks: null,
            restrictions: null,
            headers: { accept: 'application/vnd.github.hellcat-preview+json,application/vnd.github.luke-cage-preview+json,application/vnd.github.zzzax-preview+json' }
          })
        })
      })
    })
  })

  describe('in nop mode', () => {
    function configureNop (config) {
      return new Branches(true, github, { owner: 'bkeepers', repo: 'test' }, config, log, [])
    }

    beforeEach(() => {
      github.rest.repos.updateBranchProtection.endpoint = jest.fn().mockImplementation(params => {
        return { url: 'updateBranchProtection', body: params }
      })
      github.rest.repos.deleteBranchProtection.endpoint = jest.fn().mockImplementation(params => {
        return { url: 'deleteBranchProtection', body: params }
      })
    })

    it.each([['main', 'develop'], ['develop', 'main']])(
      'reports each branch change once when %s resolves before %s',
      async (first, second) => {
        const pending = {}
        github.rest.repos.getBranchProtection.mockImplementation(({ branch }) =>
          new Promise(resolve => { pending[branch] = resolve }))
        const plugin = configureNop([
          { name: 'default', protection: { enforce_admins: true } },
          { name: 'develop', protection: { enforce_admins: true } }
        ])

        const sync = plugin.sync()
        await Promise.resolve()
        pending[first]({ data: { enforce_admins: { enabled: false } } })
        await Promise.resolve()
        pending[second]({ data: { enforce_admins: { enabled: false } } })
        const results = await sync

        expect(results).toHaveLength(4)
        expect(new Set(results).size).toBe(4)
        expect(results.filter(result => !result.endpoint).map(result => result.action.msg)).toEqual([
          'The following changes will be applied to the branch protection for main branch',
          'The following changes will be applied to the branch protection for develop branch'
        ])
        expect(results.filter(result => result.endpoint).map(result => ({
          branch: result.body.branch, msg: result.action.msg
        }))).toEqual([
          { branch: 'main', msg: 'Update Branch Protection' },
          { branch: 'develop', msg: 'Update Branch Protection' }
        ])
        expect(github.rest.repos.updateBranchProtection).not.toHaveBeenCalled()
        expect(github.rest.repos.deleteBranchProtection).not.toHaveBeenCalled()
      }
    )

    it('keeps mixed update, add, delete and error results local to their branches', async () => {
      when(github.rest.repos.getBranchProtection)
        .calledWith(expect.objectContaining({ branch: 'new' }))
        .mockRejectedValue({ status: 404 })
      when(github.rest.repos.getBranchProtection)
        .calledWith(expect.objectContaining({ branch: 'forbidden' }))
        .mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
      const plugin = configureNop([
        { name: 'default', protection: { enforce_admins: true } },
        { name: 'new', protection: { enforce_admins: true } },
        { name: 'unchanged', protection: { enforce_admins: false } },
        { name: 'removed', protection: null },
        { name: 'empty', protection: {} },
        { name: 'forbidden', protection: { enforce_admins: true } },
        { name: 'unmanaged' }
      ])

      const results = await plugin.sync()

      expect(results).toHaveLength(6)
      expect(results.filter(result => result.endpoint).map(result => ({
        branch: result.body.branch, msg: result.action.msg, type: result.type
      }))).toEqual([
        { branch: 'main', msg: 'Update Branch Protection', type: 'INFO' },
        { branch: 'new', msg: 'Add Branch Protection', type: 'INFO' },
        { branch: 'removed', msg: 'Delete Branch Protection', type: 'INFO' },
        { branch: 'empty', msg: 'Delete Branch Protection', type: 'INFO' },
        { branch: 'forbidden', msg: 'Error: Forbidden', type: 'ERROR' }
      ])
      expect(github.rest.repos.updateBranchProtection).not.toHaveBeenCalled()
      expect(github.rest.repos.deleteBranchProtection).not.toHaveBeenCalled()
    })

    describe('when branch protection already exists', () => {
      it('labels the NopCommand as an update and names the branch in the diff message', () => {
        const plugin = configureNop(
          [{
            name: 'master',
            protection: { enforce_admins: true }
          }]
        )

        return plugin.sync().then(res => {
          const messages = res.map(nopCommand => nopCommand.action.msg)
          expect(messages).toContain('Update Branch Protection')
          expect(messages).not.toContain('Add Branch Protection')
          const diffMessage = messages.find(msg => typeof msg === 'string' && msg.includes('will be applied to the branch protection'))
          expect(diffMessage).toBeDefined()
          expect(diffMessage).toContain('for master branch')
          expect(diffMessage).not.toContain('undefined')
        })
      })
    })

    describe('when branch protection does not exist yet', () => {
      it('labels the NopCommand as an add', () => {
        github.rest.repos.getBranchProtection = jest.fn().mockRejectedValue({ status: 404 })
        const plugin = configureNop(
          [{
            name: 'master',
            protection: { enforce_admins: true }
          }]
        )

        return plugin.sync().then(res => {
          const messages = res.map(nopCommand => nopCommand.action.msg)
          expect(messages).toContain('Add Branch Protection')
          expect(messages).not.toContain('Update Branch Protection')
        })
      })
    })
  })

  describe.skip('return values', () => {
    it('returns updateBranchProtection Promise', () => {
      const plugin = configure(
        [{
          name: 'master',
          protection: { enforce_admins: true }
        }]
      )

      return plugin.sync().then(result => {
        expect(result.length).toBe(1)
        expect(result[0]).toBe('updateBranchProtection')
      })
    })
    it('returns deleteBranchProtection Promise', () => {
      const plugin = configure(
        [{
          name: 'master',
          protection: null
        }]
      )

      return plugin.sync().then(result => {
        expect(result.length).toBe(1)
        expect(result[0]).toBe('deleteBranchProtection')
      })
    })
  })
})
