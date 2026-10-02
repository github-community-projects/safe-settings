const AppOctokitClient = require('../../../lib/appOctokitClient')

describe('AppOctokitClient', () => {
  let github
  let log
  let client

  beforeEach(() => {
    log = {
      debug: jest.fn(),
      error: jest.fn()
    }

    github = {
      paginate: jest.fn(),
      request: jest.fn().mockResolvedValue({ data: {} })
    }
    github.request.endpoint = {
      merge: jest.fn().mockReturnValue({})
    }

    client = new AppOctokitClient({
      github,
      enterpriseSlug: 'my-enterprise',
      log
    })
  })

  describe('listOrgInstallations', () => {
    it('returns org installations', async () => {
      github.paginate.mockResolvedValue([
        { id: 1, app_slug: 'app-a', repository_selection: 'all' },
        { id: 3, app_slug: 'app-c', repository_selection: 'selected' }
      ])

      const result = await client.listOrgInstallations('my-org')
      expect(result).toHaveLength(2)
      expect(result[0].app_slug).toBe('app-a')
      expect(github.request.endpoint.merge).toHaveBeenCalledWith(
        'GET /enterprises/{enterprise}/apps/organizations/{org}/installations',
        expect.objectContaining({ enterprise: 'my-enterprise', org: 'my-org' })
      )
    })

    it('throws descriptive error on 403', async () => {
      github.paginate.mockRejectedValue({ status: 403, message: 'Forbidden' })

      await expect(client.listOrgInstallations('my-org'))
        .rejects.toThrow(/enterprise/)
    })

    it('throws descriptive error on 404', async () => {
      github.paginate.mockRejectedValue({ status: 404, message: 'Not Found' })

      await expect(client.listOrgInstallations('my-org'))
        .rejects.toThrow(/enterprise/)
    })
  })

  describe('setRepositorySelection', () => {
    it("toggles to 'all' without repositories", async () => {
      await client.setRepositorySelection('my-org', 123, 'all')
      expect(github.request).toHaveBeenCalledWith(
        'PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories',
        expect.objectContaining({
          org: 'my-org',
          installation_id: 123,
          repository_selection: 'all'
        })
      )
      const callArgs = github.request.mock.calls[0][1]
      expect(callArgs.repositories).toBeUndefined()
    })

    it("toggles to 'selected' with repository names", async () => {
      await client.setRepositorySelection('my-org', 123, 'selected', ['repo-a', 'repo-b'])
      expect(github.request).toHaveBeenCalledWith(
        'PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories',
        expect.objectContaining({
          repository_selection: 'selected',
          repositories: ['repo-a', 'repo-b']
        })
      )
    })
  })

  describe('addReposToInstallation', () => {
    it('does nothing for empty array', async () => {
      await client.addReposToInstallation('my-org', 123, [])
      expect(github.request).not.toHaveBeenCalled()
    })

    it('sends single batch for <= 50 repos using names', async () => {
      const names = Array.from({ length: 10 }, (_, i) => `repo-${i}`)
      await client.addReposToInstallation('my-org', 123, names)
      expect(github.request).toHaveBeenCalledTimes(1)
      expect(github.request).toHaveBeenCalledWith(
        'PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories/add',
        expect.objectContaining({
          repositories: names,
          installation_id: 123,
          org: 'my-org'
        })
      )
    })

    it('batches into chunks of 50', async () => {
      const names = Array.from({ length: 120 }, (_, i) => `repo-${i}`)
      await client.addReposToInstallation('my-org', 123, names)
      expect(github.request).toHaveBeenCalledTimes(3) // 50 + 50 + 20
    })
  })

  describe('removeReposFromInstallation', () => {
    it('does nothing for empty array', async () => {
      await client.removeReposFromInstallation('my-org', 123, [])
      expect(github.request).not.toHaveBeenCalled()
    })

    it('uses the remove endpoint with names', async () => {
      await client.removeReposFromInstallation('my-org', 123, ['repo-a'])
      expect(github.request).toHaveBeenCalledWith(
        'PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories/remove',
        expect.objectContaining({ repositories: ['repo-a'] })
      )
    })

    it('batches into chunks of 50', async () => {
      const names = Array.from({ length: 75 }, (_, i) => `repo-${i}`)
      await client.removeReposFromInstallation('my-org', 123, names)
      expect(github.request).toHaveBeenCalledTimes(2) // 50 + 25
    })
  })

  describe('_chunk', () => {
    it('splits array into correct chunks', () => {
      expect(client._chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    })

    it('returns single chunk for small array', () => {
      expect(client._chunk([1, 2], 50)).toEqual([[1, 2]])
    })

    it('returns empty array for empty input', () => {
      expect(client._chunk([], 50)).toEqual([])
    })
  })
})
