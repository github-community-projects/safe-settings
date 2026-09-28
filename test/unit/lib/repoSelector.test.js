const RepoSelector = require('../../../lib/repoSelector')

describe('RepoSelector', () => {
  let github
  let log

  beforeEach(() => {
    log = {
      debug: jest.fn(),
      error: jest.fn()
    }

    github = {
      paginate: jest.fn(),
      rest: {
        teams: {
          listReposInOrg: {
            endpoint: {
              merge: jest.fn().mockReturnValue({})
            }
          }
        }
      },
      request: {
        endpoint: jest.fn().mockReturnValue({})
      }
    }
  })

  describe('resolve', () => {
    it('returns empty set for null criteria', async () => {
      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve(null)
      expect(result).toEqual(new Set())
    })

    it('returns empty set for empty criteria', async () => {
      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve({})
      expect(result).toEqual(new Set())
    })
  })

  describe('getAllRepos', () => {
    it('returns all repo names from installation', async () => {
      github.paginate.mockResolvedValue([
        { name: 'repo-a' },
        { name: 'repo-b' },
        { name: 'repo-c' }
      ])

      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve({ all: true })
      expect(result).toEqual(new Set(['repo-a', 'repo-b', 'repo-c']))
    })
  })

  describe('resolveByName', () => {
    it('returns explicit repo names directly', async () => {
      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve({ names: ['repo-a', 'repo-b'] })
      expect(result).toEqual(new Set(['repo-a', 'repo-b']))
      expect(github.paginate).not.toHaveBeenCalled()
    })

    it('resolves glob patterns against all repos', async () => {
      github.paginate.mockResolvedValue([
        { name: 'api-service' },
        { name: 'api-gateway' },
        { name: 'web-frontend' }
      ])

      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve({ names: ['api-*'] })
      expect(result).toEqual(new Set(['api-service', 'api-gateway']))
    })
  })

  describe('resolveByTeam', () => {
    it('returns repos from team membership', async () => {
      github.paginate.mockResolvedValue([
        { name: 'team-repo-1' },
        { name: 'team-repo-2' }
      ])

      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve({ teams: ['my-team'] })
      expect(result).toEqual(new Set(['team-repo-1', 'team-repo-2']))
    })

    it('unions repos from multiple teams', async () => {
      github.paginate
        .mockResolvedValueOnce([{ name: 'repo-a' }, { name: 'repo-b' }])
        .mockResolvedValueOnce([{ name: 'repo-b' }, { name: 'repo-c' }])

      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve({ teams: ['team-1', 'team-2'] })
      expect(result).toEqual(new Set(['repo-a', 'repo-b', 'repo-c']))
    })
  })

  describe('resolveByCustomProperties', () => {
    it('returns repos matching property values', async () => {
      github.paginate.mockResolvedValue([
        { repository_name: 'prop-repo-1' },
        { repository_name: 'prop-repo-2' }
      ])

      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve({
        custom_properties: [{ environment: 'production' }]
      })
      expect(result).toEqual(new Set(['prop-repo-1', 'prop-repo-2']))
    })
  })

  describe('combined criteria', () => {
    it('unions results from multiple criteria types', async () => {
      // First call: teams resolution
      github.paginate
        .mockResolvedValueOnce([{ name: 'team-repo' }])
        // Second call: custom properties
        .mockResolvedValueOnce([{ repository_name: 'prop-repo' }])

      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve({
        names: ['explicit-repo'],
        teams: ['my-team'],
        custom_properties: [{ tier: 'critical' }]
      })
      expect(result).toEqual(new Set(['explicit-repo', 'team-repo', 'prop-repo']))
    })

    it('all=true takes precedence over other criteria', async () => {
      github.paginate.mockResolvedValue([
        { name: 'repo-1' },
        { name: 'repo-2' }
      ])

      const selector = new RepoSelector(github, 'my-org', log)
      const result = await selector.resolve({
        all: true,
        names: ['specific-repo'],
        teams: ['my-team']
      })
      // Should return all repos, not filter by names/teams
      expect(result).toEqual(new Set(['repo-1', 'repo-2']))
      // paginate called once for getAllRepos, not for teams
      expect(github.paginate).toHaveBeenCalledTimes(1)
    })
  })
})
