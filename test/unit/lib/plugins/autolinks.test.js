const Autolinks = require('../../../../lib/plugins/autolinks')

describe('Autolinks', () => {
  const repo = { owner: 'owner', repo: 'repo' }
  let github

  function configure (config) {
    const log = { debug: jest.fn(), info: jest.fn(), error: console.error }
    const nop = false
    const errors = []
    return new Autolinks(nop, github, repo, config, log, errors)
  }

  beforeEach(() => {
    github = {
      rest: {
        repos: {
          listAutolinks: jest.fn().mockResolvedValue([]),
          createAutolink: jest.fn().mockResolvedValue(),
          deleteAutolink: jest.fn().mockResolvedValue()
        }
      }
    }
  })

  describe('sync', () => {
    it('syncs autolinks', () => {
      const plugin = configure([
        { key_prefix: 'ADD-', url_template: 'https://test/<num>' },
        { key_prefix: 'SAME-', url_template: 'https://test/<num>' },
        { key_prefix: 'NEW_URL-', url_template: 'https://new-url/<num>' },
        { key_prefix: 'SAME_ALPHA-UNDEFINED-', url_template: 'https://test/<num>' },
        { key_prefix: 'SAME_ALPHA-FALSE-', url_template: 'https://test/<num>', is_alphanumeric: false },
        { key_prefix: 'SAME_ALPHA-TRUE-', url_template: 'https://test/<num>', is_alphanumeric: true },
        { key_prefix: 'NEW_ALPHA-UNDEFINED-', url_template: 'https://test/<num>' },
        { key_prefix: 'NEW_ALPHA-FALSE-', url_template: 'https://test/<num>', is_alphanumeric: false },
        { key_prefix: 'NEW_ALPHA-TRUE-', url_template: 'https://test/<num>', is_alphanumeric: true }
      ])

      github.rest.repos.listAutolinks.mockResolvedValueOnce({
        data: [
          { id: '1', key_prefix: 'SAME-', url_template: 'https://test/<num>', is_alphanumeric: true },
          { id: '2', key_prefix: 'REMOVE-', url_template: 'https://test/<num>', is_alphanumeric: true },
          { id: '3', key_prefix: 'NEW_URL-', url_template: 'https://current-url/<num>', is_alphanumeric: true },
          { id: '4', key_prefix: 'SAME_ALPHA-UNDEFINED-', url_template: 'https://test/<num>', is_alphanumeric: true },
          { id: '5', key_prefix: 'SAME_ALPHA-FALSE-', url_template: 'https://test/<num>', is_alphanumeric: false },
          { id: '6', key_prefix: 'SAME_ALPHA-TRUE-', url_template: 'https://test/<num>', is_alphanumeric: true },
          { id: '7', key_prefix: 'NEW_ALPHA-UNDEFINED-', url_template: 'https://test/<num>', is_alphanumeric: false },
          { id: '8', key_prefix: 'NEW_ALPHA-FALSE-', url_template: 'https://test/<num>', is_alphanumeric: true },
          { id: '9', key_prefix: 'NEW_ALPHA-TRUE-', url_template: 'https://test/<num>', is_alphanumeric: false }
        ]
      })

      return plugin.sync().then(() => {
        expect(github.rest.repos.createAutolink).toHaveBeenCalledWith({
          key_prefix: 'ADD-',
          url_template: 'https://test/<num>',
          is_alphanumeric: true,
          ...repo
        })

        expect(github.rest.repos.deleteAutolink).toHaveBeenCalledWith({
          autolink_id: '2',
          ...repo
        })

        expect(github.rest.repos.deleteAutolink).toHaveBeenCalledWith({
          autolink_id: '3',
          ...repo
        })
        expect(github.rest.repos.createAutolink).toHaveBeenCalledWith({
          key_prefix: 'NEW_URL-',
          url_template: 'https://new-url/<num>',
          is_alphanumeric: true,
          ...repo
        })

        expect(github.rest.repos.deleteAutolink).not.toHaveBeenCalledWith({
          autolink_id: '4',
          ...repo
        })
        expect(github.rest.repos.createAutolink).not.toHaveBeenCalledWith({
          key_prefix: 'SAME_ALPHA-UNDEFINED-',
          url_template: 'https://test/<num>',
          is_alphanumeric: true,
          ...repo
        })

        expect(github.rest.repos.deleteAutolink).not.toHaveBeenCalledWith({
          autolink_id: '5',
          ...repo
        })
        expect(github.rest.repos.createAutolink).not.toHaveBeenCalledWith({
          key_prefix: 'SAME_ALPHA-FALSE-',
          url_template: 'https://test/<num>',
          is_alphanumeric: false,
          ...repo
        })

        expect(github.rest.repos.deleteAutolink).not.toHaveBeenCalledWith({
          autolink_id: '6',
          ...repo
        })
        expect(github.rest.repos.createAutolink).not.toHaveBeenCalledWith({
          key_prefix: 'SAME_ALPHA-TRUE-',
          url_template: 'https://test/<num>',
          is_alphanumeric: true,
          ...repo
        })

        expect(github.rest.repos.deleteAutolink).toHaveBeenCalledWith({
          autolink_id: '7',
          ...repo
        })
        expect(github.rest.repos.createAutolink).toHaveBeenCalledWith({
          key_prefix: 'NEW_ALPHA-UNDEFINED-',
          url_template: 'https://test/<num>',
          is_alphanumeric: true,
          ...repo
        })

        expect(github.rest.repos.deleteAutolink).toHaveBeenCalledWith({
          autolink_id: '8',
          ...repo
        })
        expect(github.rest.repos.createAutolink).toHaveBeenCalledWith({
          key_prefix: 'NEW_ALPHA-FALSE-',
          url_template: 'https://test/<num>',
          is_alphanumeric: false,
          ...repo
        })

        expect(github.rest.repos.deleteAutolink).toHaveBeenCalledWith({
          autolink_id: '9',
          ...repo
        })
        expect(github.rest.repos.createAutolink).toHaveBeenCalledWith({
          key_prefix: 'NEW_ALPHA-TRUE-',
          url_template: 'https://test/<num>',
          is_alphanumeric: true,
          ...repo
        })

        expect(github.rest.repos.deleteAutolink).toHaveBeenCalledTimes(5)
        expect(github.rest.repos.createAutolink).toHaveBeenCalledTimes(5)
      })
    })
  })
})
