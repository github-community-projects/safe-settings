/* eslint-disable no-undef */
class Octokit {}
const Settings = require('../../../lib/settings')
const yaml = require('js-yaml')
// jest.mock('../../../lib/settings', () => {
//   const OriginalSettings = jest.requireActual('../../../lib/settings')
//   //const orginalSettingsInstance = new OriginalSettings(false, stubContext, mockRepo, config, mockRef, mockSubOrg)
//   return OriginalSettings
// })

describe('Settings Tests', () => {
  let stubContext
  let mockRepo
  let stubConfig
  let mockRef
  let mockSubOrg
  let subOrgConfig

  function createSettings (config) {
    const settings = new Settings(false, stubContext, mockRepo, config, mockRef, mockSubOrg)
    return settings
  }

  beforeEach(() => {
    const mockOctokit = jest.mocked(Octokit)
    const content = Buffer.from(`
suborgrepos:
- new-repo
#- test*
#- secret*

suborgteams:
- core

suborgproperties:
- EDP: true
- do_no_delete: true

teams:
  - name: core
    permission: bypass
  - name: docss
    permission: pull
  - name: docs
    permission: pull

validator:
  pattern: '[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+.*'

repository:
  # A comma-separated list of topics to set on the repository
  topics:
  - frontend
     `).toString('base64')
    mockOctokit.rest = {
      repos: {
        getContent: jest.fn().mockResolvedValue({ data: { content } })
      }
    }

    mockOctokit.request = {
      endpoint: jest.fn().mockReturnValue({})
    }

    mockOctokit.paginate = jest.fn().mockResolvedValue([])

    stubContext = {
      payload: {
        installation: {
          id: 123
        }
      },
      octokit: mockOctokit,
      log: {
        debug: jest.fn((msg) => {
          console.log(msg)
        }),
        info: jest.fn((msg) => {
          console.log(msg)
        }),
        error: jest.fn((msg) => {
          console.log(msg)
        })
      }
    }

    mockRepo = { owner: 'test', repo: 'test-repo' }
    mockRef = 'main'
    mockSubOrg = 'frontend'
  })

  describe('restrictedRepos', () => {
    describe('restrictedRepos not defined', () => {
      beforeEach(() => {
        stubConfig = {
          restrictedRepos: {
          }
        }
      })

      it('Allow repositories being configured', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo')).toEqual(false)
        expect(settings.isRestricted('another-repo')).toEqual(false)
      })

      it('Do not allow default excluded repositories being configured', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('.github')).toEqual(false)
        expect(settings.isRestricted('safe-settings')).toEqual(false)
        expect(settings.isRestricted('admin')).toEqual(false)
      })
    })

    describe('restrictedRepos.exclude defined', () => {
      beforeEach(() => {
        stubConfig = {
          restrictedRepos: {
            exclude: ['foo', '*-test', 'personal-*']
          }
        }
      })

      it('Skipping excluded repository from being configured', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('foo')).toEqual(true)
      })

      it('Skipping excluded repositories matching regex in restrictedRepos.exclude', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo-test')).toEqual(true)
        expect(settings.isRestricted('personal-repo')).toEqual(true)
      })

      it('Allowing repositories not matching regex in restrictedRepos.exclude', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo-test-data')).toEqual(false)
        expect(settings.isRestricted('personalization-repo')).toEqual(false)
      })
    })

    describe('restrictedRepos.include defined', () => {
      beforeEach(() => {
        stubConfig = {
          restrictedRepos: {
            include: ['foo', '*-test', 'personal-*']
          }
        }
      })

      it('Allowing repository from being configured', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('foo')).toEqual(false)
      })

      it('Allowing repositories matching regex in restrictedRepos.include', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo-test')).toEqual(false)
        expect(settings.isRestricted('personal-repo')).toEqual(false)
      })

      it('Skipping repositories not matching regex in restrictedRepos.include', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo-test-data')).toEqual(true)
        expect(settings.isRestricted('personalization-repo')).toEqual(true)
      })
    })

    describe('restrictedRepos not defined', () => {
      it('Throws TypeError if restrictedRepos not defined', () => {
        stubConfig = {}
        settings = createSettings(stubConfig)
        expect(() => settings.isRestricted('my-repo')).toThrow('Cannot read properties of undefined (reading \'include\')')
      })

      it('Throws TypeError if restrictedRepos is null', () => {
        stubConfig = {
          restrictedRepos: null
        }
        settings = createSettings(stubConfig)
        expect(() => settings.isRestricted('my-repo')).toThrow('Cannot read properties of null (reading \'include\')')
      })

      it('Allowing all repositories if restrictedRepos is empty', () => {
        stubConfig = {
          restrictedRepos: []
        }
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo')).toEqual(false)
      })
    })
  }) // restrictedRepos

  describe('getRepoOverrideConfig', () => {
    describe('repository defined in a file using the .yaml extension', () => {
      beforeEach(() => {
        stubConfig = {
          repoConfigs: {
            'repository.yaml': { repository: { name: 'repository', config: 'config1' } }
          }
        }
      })

      it('Picks up a repository defined in file using the .yaml extension', () => {
        settings = createSettings(stubConfig)
        settings.repoConfigs = stubConfig.repoConfigs
        const repoConfig = settings.getRepoOverrideConfig('repository')

        expect(typeof repoConfig).toBe('object')
        expect(repoConfig).not.toBeNull()
        expect(Object.keys(repoConfig).length).toBeGreaterThan(0)
      })
    })

    describe('repository defined in a file using the .yml extension', () => {
      beforeEach(() => {
        stubConfig = {
          repoConfigs: {
            'repository.yml': { repository: { name: 'repository', config: 'config1' } }
          }
        }
      })

      it('Picks up a repository defined in file using the .yml extension', () => {
        settings = createSettings(stubConfig)
        settings.repoConfigs = stubConfig.repoConfigs
        const repoConfig = settings.getRepoOverrideConfig('repository')

        expect(typeof repoConfig).toBe('object')
        expect(repoConfig).not.toBeNull()
        expect(Object.keys(repoConfig).length).toBeGreaterThan(0)
      })
    })
  }) // repoOverrideConfig
  describe('loadConfigs', () => {
    describe('load suborg configs', () => {
      beforeEach(() => {
        stubConfig = {
          restrictedRepos: {
          }
        }
        subOrgConfig = yaml.load(`
          suborgrepos:
          - new-repo

          suborgproperties:
          - EDP: true
          - do_no_delete: true

          teams:
            - name: core
              permission: bypass
            - name: docss
              permission: pull
            - name: docs
              permission: pull

          validator:
            pattern: '[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+.*'

          repository:
            # A comma-separated list of topics to set on the repository
            topics:
            - frontend

          `)
      })

      it("Should load configMap for suborgs'", async () => {
        // mockSubOrg = jest.fn().mockReturnValue(['suborg1', 'suborg2'])
        mockSubOrg = undefined
        settings = createSettings(stubConfig)
        jest.spyOn(settings, 'loadConfigMap').mockImplementation(() => [{ name: 'frontend', path: '.github/suborgs/frontend.yml' }])
        jest.spyOn(settings, 'loadYaml').mockImplementation(() => subOrgConfig)
        jest.spyOn(settings, 'getReposForTeam').mockImplementation(() => [{ name: 'repo-test' }])
        jest.spyOn(settings, 'getSubOrgRepositories').mockImplementation(() => [{ repository_name: 'repo-for-property' }])

        const subOrgConfigs = await settings.getSubOrgConfigs()
        expect(settings.loadConfigMap).toHaveBeenCalledTimes(1)

        // Get own properties of subOrgConfigs
        const ownProperties = Object.getOwnPropertyNames(subOrgConfigs)
        expect(ownProperties.length).toEqual(3)
      })

      it("Should throw an error when a repo is found in multiple suborgs configs'", async () => {
        // mockSubOrg = jest.fn().mockReturnValue(['suborg1', 'suborg2'])
        mockSubOrg = undefined
        settings = createSettings(stubConfig)
        jest.spyOn(settings, 'loadConfigMap').mockImplementation(() => [{ name: 'frontend', path: '.github/suborgs/frontend.yml' }, { name: 'backend', path: '.github/suborgs/backend.yml' }])
        jest.spyOn(settings, 'loadYaml').mockImplementation(() => subOrgConfig)
        jest.spyOn(settings, 'getReposForTeam').mockImplementation(() => [{ name: 'repo-test' }])
        jest.spyOn(settings, 'getSubOrgRepositories').mockImplementation(() => [{ repository_name: 'repo-for-property' }])

        expect(async () => await settings.getSubOrgConfigs()).rejects.toThrow('Multiple suborg configs for new-repo in .github/suborgs/backend.yml and .github/suborgs/frontend.yml')
        // try {
        //   await settings.getSubOrgConfigs()
        // } catch (e) {
        //   console.log(e)
        // }
      })
    })

    describe('repo-scoped suborg config resolution', () => {
      // When syncing a single repo (not a suborg config change), getSubOrgConfigs(repo)
      // should resolve membership by inspecting only that repo's teams/properties,
      // instead of enumerating every repo of every suborg across the org.
      beforeEach(() => {
        // No suborg => subOrgConfigMap is not set => repo-scoped path is eligible
        mockSubOrg = undefined
        stubConfig = { restrictedRepos: {} }
        subOrgConfig = yaml.load(`
          suborgrepos:
          - new-repo

          suborgteams:
          - core

          suborgproperties:
          - EDP: true
          - do_no_delete: true

          repository:
            topics:
            - frontend
          `)
      })

      function createRepoScopedSettings () {
        settings = createSettings(stubConfig)
        jest.spyOn(settings, 'loadConfigMap').mockImplementation(() => [{ name: 'frontend', path: '.github/suborgs/frontend.yml' }])
        jest.spyOn(settings, 'loadYaml').mockImplementation(() => subOrgConfig)
        // org-wide resolvers should NOT be used on the repo-scoped path
        jest.spyOn(settings, 'getReposForTeam').mockResolvedValue([{ name: 'repo-test' }])
        jest.spyOn(settings, 'getSubOrgRepositories').mockResolvedValue([{ repository_name: 'repo-for-property' }])
        return settings
      }

      it('matches by suborgrepos glob without any repo API calls', async () => {
        settings = createRepoScopedSettings()
        const getReposTeams = jest.spyOn(settings, 'getReposTeams').mockResolvedValue([])
        const getRepoProps = jest.spyOn(settings, 'getRepoCustomPropertyValues').mockResolvedValue([])

        const subOrgConfigs = await settings.getSubOrgConfigs({ owner: 'test', repo: 'new-repo' })

        expect(subOrgConfigs['new-repo']).toBeDefined()
        expect(subOrgConfigs['new-repo'].source).toEqual('.github/suborgs/frontend.yml')
        // glob matched first, so teams/properties are never queried
        expect(getReposTeams).not.toHaveBeenCalled()
        expect(getRepoProps).not.toHaveBeenCalled()
        // org-wide resolvers are never used
        expect(settings.getReposForTeam).not.toHaveBeenCalled()
        expect(settings.getSubOrgRepositories).not.toHaveBeenCalled()
      })

      it('matches by team membership using the repo-scoped teams endpoint', async () => {
        settings = createRepoScopedSettings()
        const getReposTeams = jest.spyOn(settings, 'getReposTeams').mockResolvedValue([{ slug: 'core' }])
        const getRepoProps = jest.spyOn(settings, 'getRepoCustomPropertyValues').mockResolvedValue([])

        const subOrgConfigs = await settings.getSubOrgConfigs({ owner: 'test', repo: 'some-repo' })

        expect(subOrgConfigs['some-repo']).toBeDefined()
        expect(getReposTeams).toHaveBeenCalledTimes(1)
        // team matched, so properties are never queried
        expect(getRepoProps).not.toHaveBeenCalled()
        expect(settings.getReposForTeam).not.toHaveBeenCalled()
      })

      it('matches by custom property using the repo-scoped properties endpoint', async () => {
        settings = createRepoScopedSettings()
        const getReposTeams = jest.spyOn(settings, 'getReposTeams').mockResolvedValue([])
        const getRepoProps = jest.spyOn(settings, 'getRepoCustomPropertyValues').mockResolvedValue([{ property_name: 'EDP', value: 'true' }])

        const subOrgConfigs = await settings.getSubOrgConfigs({ owner: 'test', repo: 'some-repo' })

        expect(subOrgConfigs['some-repo']).toBeDefined()
        expect(getReposTeams).toHaveBeenCalledTimes(1)
        expect(getRepoProps).toHaveBeenCalledTimes(1)
        expect(settings.getSubOrgRepositories).not.toHaveBeenCalled()
      })

      it('returns no config when the repo matches nothing', async () => {
        settings = createRepoScopedSettings()
        jest.spyOn(settings, 'getReposTeams').mockResolvedValue([{ slug: 'other-team' }])
        jest.spyOn(settings, 'getRepoCustomPropertyValues').mockResolvedValue([{ property_name: 'EDP', value: 'false' }])

        const subOrgConfigs = await settings.getSubOrgConfigs({ owner: 'test', repo: 'some-repo' })

        expect(Object.keys(subOrgConfigs)).toHaveLength(0)
      })

      it('falls back to the org-wide path when processing a suborg config change', async () => {
        settings = createRepoScopedSettings()
        settings.subOrgConfigMap = [{ path: '.github/suborgs/frontend.yml' }]
        const getReposTeams = jest.spyOn(settings, 'getReposTeams').mockResolvedValue([])
        const getRepoProps = jest.spyOn(settings, 'getRepoCustomPropertyValues').mockResolvedValue([])

        await settings.getSubOrgConfigs({ owner: 'test', repo: 'new-repo' })

        // org-wide resolvers are used; repo-scoped ones are not
        expect(settings.getReposForTeam).toHaveBeenCalled()
        expect(settings.getSubOrgRepositories).toHaveBeenCalled()
        expect(getReposTeams).not.toHaveBeenCalled()
        expect(getRepoProps).not.toHaveBeenCalled()
      })
    })

    describe('repoMatchesProperties', () => {
      beforeEach(() => {
        mockSubOrg = undefined
        settings = createSettings({ restrictedRepos: {} })
      })

      it('coerces YAML booleans/numbers to match the API string values', () => {
        expect(settings.repoMatchesProperties([{ property_name: 'EDP', value: 'true' }], [{ EDP: true }])).toBe(true)
        expect(settings.repoMatchesProperties([{ property_name: 'tier', value: '2' }], [{ tier: 2 }])).toBe(true)
      })

      it('matches property names case-insensitively', () => {
        // GitHub may return the property name in a different case than the config declares
        expect(settings.repoMatchesProperties([{ property_name: 'edp', value: 'true' }], [{ EDP: true }])).toBe(true)
        expect(settings.repoMatchesProperties([{ property_name: 'EDP', value: 'true' }], [{ edp: true }])).toBe(true)
      })

      it('returns false when the property is absent or the value differs', () => {
        expect(settings.repoMatchesProperties([{ property_name: 'EDP', value: 'false' }], [{ EDP: true }])).toBe(false)
        expect(settings.repoMatchesProperties([], [{ EDP: true }])).toBe(false)
      })

      it('matches multi-select property values that contain the expected value', () => {
        expect(settings.repoMatchesProperties([{ property_name: 'envs', value: ['dev', 'prod'] }], [{ envs: 'prod' }])).toBe(true)
        expect(settings.repoMatchesProperties([{ property_name: 'envs', value: ['dev'] }], [{ envs: 'prod' }])).toBe(false)
      })
    })

    describe('getRepoCustomPropertyValues', () => {
      beforeEach(() => {
        mockSubOrg = undefined
      })

      it('paginates the repo-scoped custom properties endpoint', async () => {
        const endpoint = jest.fn()
        stubContext.octokit.rest.repos.customPropertiesForReposGetRepositoryValues = endpoint
        settings = createSettings({ restrictedRepos: {} })
        stubContext.octokit.paginate.mockResolvedValue([{ property_name: 'Team', value: 'DevOps' }])

        const values = await settings.getRepoCustomPropertyValues({ owner: 'test', repo: 'test-repo' })

        expect(stubContext.octokit.paginate).toHaveBeenCalledWith(endpoint, {
          owner: 'test',
          repo: 'test-repo',
          per_page: 100
        })
        expect(values).toEqual([{ property_name: 'Team', value: 'DevOps' }])
      })

      it('throws instead of paginating an undefined route when the octokit method is missing', async () => {
        // A renamed/removed octokit method must not silently degrade: paginate(undefined, ...)
        // requests the API root and returns junk, making every suborgproperties match fail.
        delete stubContext.octokit.rest.repos.customPropertiesForReposGetRepositoryValues
        settings = createSettings({ restrictedRepos: {} })

        await expect(settings.getRepoCustomPropertyValues({ owner: 'test', repo: 'test-repo' }))
          .rejects.toThrow('customPropertiesForReposGetRepositoryValues is not available')
        expect(stubContext.octokit.paginate).not.toHaveBeenCalled()
      })
    })
  }) // loadConfigs

  describe('loadYaml', () => {
    let settings

    beforeEach(() => {
      Settings.fileCache = {}
      stubContext = {
        octokit: {
          rest: {
            repos: {
              getContent: jest.fn()
            }
          },
          request: jest.fn(),
          paginate: jest.fn()
        },
        log: {
          debug: jest.fn(),
          info: jest.fn(),
          error: jest.fn()
        },
        payload: {
          installation: {
            id: 123
          }
        }
      }
      settings = createSettings({})
    })

    it('should return parsed YAML content when file is fetched successfully', async () => {
      // Given
      const filePath = 'path/to/file.yml'
      const content = Buffer.from('key: value').toString('base64')
      jest.spyOn(settings.github.rest.repos, 'getContent').mockResolvedValue({
        data: { content },
        headers: { etag: 'etag123' }
      })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toEqual({ key: 'value' })
      expect(Settings.fileCache[`${mockRepo.owner}/${filePath}`]).toEqual({
        etag: 'etag123',
        data: { content }
      })
    })

    it('should return cached content when file has not changed (304 response)', async () => {
      // Given
      const filePath = 'path/to/file.yml'
      const content = Buffer.from('key: value').toString('base64')
      Settings.fileCache[`${mockRepo.owner}/${filePath}`] = { etag: 'etag123', data: { content } }
      jest.spyOn(settings.github.rest.repos, 'getContent').mockRejectedValue({ status: 304 })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toEqual({ key: 'value' })
      expect(settings.github.rest.repos.getContent).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { 'If-None-Match': 'etag123' } })
      )
    })

    it('should not return cached content when the cache is for another org', async () => {
      // Given
      const filePath = 'path/to/file.yml'
      const content = Buffer.from('key: value').toString('base64')
      const wrongContent = Buffer.from('wrong: content').toString('base64')
      Settings.fileCache['another-org/path/to/file.yml'] = { etag: 'etag123', data: { wrongContent } }
      jest.spyOn(settings.github.rest.repos, 'getContent').mockResolvedValue({
        data: { content },
        headers: { etag: 'etag123' }
      })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toEqual({ key: 'value' })
    })

    it('should return null when the file path is a folder', async () => {
      // Given
      const filePath = 'path/to/folder'
      jest.spyOn(settings.github.rest.repos, 'getContent').mockResolvedValue({
        data: []
      })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toBeNull()
    })

    it('should return null when the file is a symlink or submodule', async () => {
      // Given
      const filePath = 'path/to/symlink'
      jest.spyOn(settings.github.rest.repos, 'getContent').mockResolvedValue({
        data: { content: null }
      })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toBeUndefined()
    })

    it('should handle 404 errors gracefully and return null', async () => {
      // Given
      const filePath = 'path/to/nonexistent.yml'
      jest.spyOn(settings.github.rest.repos, 'getContent').mockRejectedValue({ status: 404 })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toBeNull()
    })

    it('should throw an error for non-404 exceptions when not in nop mode', async () => {
      // Given
      const filePath = 'path/to/error.yml'
      jest.spyOn(settings.github.rest.repos, 'getContent').mockRejectedValue(new Error('Unexpected error'))

      // When / Then
      await expect(settings.loadYaml(filePath)).rejects.toThrow('Unexpected error')
    })

    it('should log and append NopCommand for non-404 exceptions in nop mode', async () => {
      // Given
      const filePath = 'path/to/error.yml'
      settings.nop = true
      jest.spyOn(settings.github.rest.repos, 'getContent').mockRejectedValue(new Error('Unexpected error'))
      jest.spyOn(settings, 'appendToResults')

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toBeUndefined()
      expect(settings.appendToResults).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'ERROR',
            action: expect.objectContaining({
              msg: expect.stringContaining('Unexpected error')
            })
          })
        ])
      )
    })
  })

  describe('getAllMatchingSubOrgSources', () => {
    it('returns an empty set when subOrgConfigs is undefined', () => {
      const settings = createSettings({})
      settings.subOrgConfigs = undefined
      const result = settings.getAllMatchingSubOrgSources('any-repo')
      expect(result).toBeInstanceOf(Set)
      expect(result.size).toBe(0)
    })

    it('returns an empty set when no suborg matches', () => {
      const settings = createSettings({})
      settings.subOrgConfigs = {
        'frontend-*': { source: '.github/suborgs/frontend.yml' }
      }
      const result = settings.getAllMatchingSubOrgSources('backend-repo')
      expect(result.size).toBe(0)
    })

    it('returns a single-entry set when one suborg glob matches', () => {
      const settings = createSettings({})
      settings.subOrgConfigs = {
        'frontend-*': { source: '.github/suborgs/frontend.yml' },
        'backend-*': { source: '.github/suborgs/backend.yml' }
      }
      const result = settings.getAllMatchingSubOrgSources('frontend-app')
      expect(result.size).toBe(1)
      expect(result.has('.github/suborgs/frontend.yml')).toBe(true)
    })

    it('does not alter getSubOrgConfig single-match behavior', () => {
      const settings = createSettings({})
      settings.subOrgConfigs = {
        'frontend-*': { source: '.github/suborgs/frontend.yml', tag: 'A' }
      }
      const before = settings.getSubOrgConfig('frontend-app')
      settings.getAllMatchingSubOrgSources('frontend-app')
      const after = settings.getSubOrgConfig('frontend-app')
      expect(after).toBe(before)
      expect(after.tag).toBe('A')
    })
  })

  describe('shouldConsiderReevaluation', () => {
    let settings
    const repo = { owner: 'o', repo: 'foo' }
    beforeEach(() => {
      settings = createSettings({})
      settings.repoConfigs = {}
    })

    describe('with changeSignals (preferred path)', () => {
      it('returns true when teams plugin reported changes', () => {
        expect(settings.shouldConsiderReevaluation(repo, null, { teamsChanged: true })).toBe(true)
      })

      it('returns true when custom_properties plugin reported changes', () => {
        expect(settings.shouldConsiderReevaluation(repo, null, { propertiesChanged: true })).toBe(true)
      })

      it('returns true on repository rename', () => {
        expect(settings.shouldConsiderReevaluation(repo, null, { renamed: true })).toBe(true)
      })

      it('returns true on repository create', () => {
        expect(settings.shouldConsiderReevaluation(repo, null, { created: true })).toBe(true)
      })

      it('returns false when all change signals are false (steady state)', () => {
        // Pre-existing team that is already on the repo -> diffable reports no
        // changes -> we must NOT trigger a re-eval reload.
        settings.repoConfigs = { 'foo.yml': { teams: [{ name: 'core' }] } }
        const signals = { teamsChanged: false, propertiesChanged: false, renamed: false, created: false }
        expect(settings.shouldConsiderReevaluation(repo, { name: 'foo' }, signals)).toBe(false)
      })
    })

    describe('without changeSignals (fallback)', () => {
      it('returns false when there is no repo-yml entry', () => {
        expect(settings.shouldConsiderReevaluation(repo, null)).toBe(false)
        expect(settings.shouldConsiderReevaluation(repo, undefined)).toBe(false)
      })

      it('returns false when repo-yml has no teams/properties and no rename', () => {
        settings.repoConfigs = { 'foo.yml': { repository: { name: 'foo' } } }
        expect(settings.shouldConsiderReevaluation(repo, { name: 'foo' })).toBe(false)
      })

      it('returns true when repo-yml has teams', () => {
        settings.repoConfigs = { 'foo.yml': { teams: [{ name: 'core' }] } }
        expect(settings.shouldConsiderReevaluation(repo, { name: 'foo' })).toBe(true)
      })

      it('returns true when repo-yml has custom_properties', () => {
        settings.repoConfigs = { 'foo.yaml': { custom_properties: [{ name: 'EDP', value: 'true' }] } }
        expect(settings.shouldConsiderReevaluation(repo, { name: 'foo' })).toBe(true)
      })

      it('returns true on rename via repo.oldname', () => {
        expect(settings.shouldConsiderReevaluation({ owner: 'o', repo: 'new', oldname: 'old' }, null)).toBe(true)
      })

      it('returns true on rename via repoConfig.oldname', () => {
        expect(settings.shouldConsiderReevaluation(repo, { name: 'new', oldname: 'old' })).toBe(true)
      })
    })
  })

  describe('maybeReevaluateSuborg', () => {
    it('is a no-op when reevaluateOnChange is false', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = false
      settings.repoConfigs = { 'r.yml': { teams: [{ name: 'core' }] } }
      const reloadSpy = jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r' }, { name: 'r' }, new Set())
      expect(reloadSpy).not.toHaveBeenCalled()
    })

    it('is a no-op when repo-yml has no triggers (teams/properties/rename)', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      settings.repoConfigs = { 'r.yml': { repository: { name: 'r' } } }
      const reloadSpy = jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r' }, { name: 'r' }, new Set())
      expect(reloadSpy).not.toHaveBeenCalled()
    })

    it('is a no-op when changeSignals report no plugin changes (preexisting team)', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      // repo-yml has teams, but plugin reported no change (team already on repo)
      settings.repoConfigs = { 'r.yml': { teams: [{ name: 'core' }] } }
      const reloadSpy = jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      const updateSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue()
      const signals = { teamsChanged: false, propertiesChanged: false, renamed: false, created: false }
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r' }, { name: 'r' }, new Set(), signals)
      expect(reloadSpy).not.toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('stops when the matched suborg source set is stable (no new sources)', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      settings.subOrgConfigs = { 'r*': { source: '.github/suborgs/x.yml' } }
      const updateSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue()
      jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      // pre = post = {x.yml} -> stable, no recursion
      const pre = new Set(['.github/suborgs/x.yml'])
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r1' }, { name: 'r1' }, pre, { teamsChanged: true })
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('recurses once when a new suborg source appears, then stops at depth cap', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      // After reload, a new suborg matches r1
      settings.subOrgConfigs = { 'r*': { source: '.github/suborgs/new.yml' } }
      settings.repoConfigs = { 'r1.yml': { teams: [{ name: 't' }] } }
      jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      jest.spyOn(settings, 'getRepoConfigs').mockResolvedValue({ 'r1.yml': { teams: [{ name: 't' }] } })
      const updateSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue()
      const pre = new Set() // pre-apply: nothing matched
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r1' }, { name: 'r1' }, pre, { teamsChanged: true })
      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(settings.reevaluationDepth.get('r1')).toBe(1)
    })

    it('recurses once when a previously matched suborg source disappears', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      settings.subOrgConfigs = {}
      settings.repoConfigs = { 'r1.yml': { custom_properties: [{ property_name: 'team', value: 'other' }] } }
      jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      jest.spyOn(settings, 'getRepoConfigs').mockResolvedValue({ 'r1.yml': { custom_properties: [{ property_name: 'team', value: 'other' }] } })
      const updateSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue()
      const pre = new Set(['.github/suborgs/old.yml'])
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r1' }, { name: 'r1' }, pre, { propertiesChanged: true })
      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(settings.reevaluationDepth.get('r1')).toBe(1)
    })

    it('respects MAX_REEVALUATION_DEPTH and logs a warning', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      settings.reevaluationDepth.set('r1', 1) // already at cap
      settings.repoConfigs = { 'r1.yml': { teams: [{ name: 't' }] } }
      stubContext.log.warn = jest.fn()
      const reloadSpy = jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      const updateSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue()
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r1' }, { name: 'r1' }, new Set(), { teamsChanged: true })
      expect(reloadSpy).not.toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
      expect(stubContext.log.warn).toHaveBeenCalledWith(expect.stringContaining('max depth'))
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // disable_plugins
  // ────────────────────────────────────────────────────────────────────────
  describe('disable_plugins', () => {
    const DeploymentConfig = require('../../../lib/deploymentConfig')
    let savedDeploymentDisable
    let savedPlugins

    beforeEach(() => {
      savedDeploymentDisable = DeploymentConfig.config && DeploymentConfig.config.disable_plugins
      if (DeploymentConfig.config) delete DeploymentConfig.config.disable_plugins
      savedPlugins = { ...Settings.PLUGINS }
    })

    afterEach(() => {
      if (DeploymentConfig.config) {
        if (savedDeploymentDisable !== undefined) {
          DeploymentConfig.config.disable_plugins = savedDeploymentDisable
        } else {
          delete DeploymentConfig.config.disable_plugins
        }
      }
      Object.keys(Settings.PLUGINS).forEach(k => { Settings.PLUGINS[k] = savedPlugins[k] })
    })

    // ── normalizeDisableEntries ──────────────────────────────────────────
    describe('normalizeDisableEntries', () => {
      it('1. string shorthand defaults target=all and sets declaredAt', () => {
        const settings = createSettings({})
        const out = settings.normalizeDisableEntries(['labels'], 'org')
        expect(out).toEqual([{ plugin: 'labels', target: 'all', declaredAt: 'org' }])
      })

      it('2. object form preserves each of self|children|all', () => {
        const settings = createSettings({})
        const out = settings.normalizeDisableEntries([
          { plugin: 'rulesets', target: 'self' },
          { plugin: 'branches', target: 'children' },
          { plugin: 'labels', target: 'all' }
        ], 'org')
        expect(out).toEqual([
          { plugin: 'rulesets', target: 'self', declaredAt: 'org' },
          { plugin: 'branches', target: 'children', declaredAt: 'org' },
          { plugin: 'labels', target: 'all', declaredAt: 'org' }
        ])
      })

      it('3. unknown plugin name throws descriptive error', () => {
        const settings = createSettings({})
        expect(() => settings.normalizeDisableEntries(['nope'], 'org'))
          .toThrow(/unknown plugin 'nope'/)
      })

      it('4. invalid target throws', () => {
        const settings = createSettings({})
        expect(() => settings.normalizeDisableEntries([{ plugin: 'labels', target: 'bogus' }], 'org'))
          .toThrow(/invalid target 'bogus'/)
      })

      it('5. repository and archive are accepted as plugin names', () => {
        const settings = createSettings({})
        const out = settings.normalizeDisableEntries(['repository', 'archive'], 'org')
        expect(out.map(e => e.plugin).sort()).toEqual(['archive', 'repository'])
      })

      it('6. at declaredAt=repo, target=children normalizes to all', () => {
        const settings = createSettings({})
        const out = settings.normalizeDisableEntries([{ plugin: 'labels', target: 'children' }], 'repo')
        expect(out).toEqual([{ plugin: 'labels', target: 'all', declaredAt: 'repo' }])
      })
    })

    // ── computeStripMap ──────────────────────────────────────────────────
    describe('computeStripMap', () => {
      const repoName = 'my-repo'

      it('7. empty configs produce empty map (all four levels are empty sets)', () => {
        const settings = createSettings({})
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        for (const level of ['deployment', 'org', 'suborg', 'repo']) {
          expect(sm.get(level).size).toBe(0)
        }
      })

      it('8. org target:self for rulesets strips only the org layer', () => {
        const settings = createSettings({ disable_plugins: [{ plugin: 'rulesets', target: 'self' }] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect([...sm.get('org')]).toEqual(['rulesets'])
        expect(sm.get('suborg').size).toBe(0)
        expect(sm.get('repo').size).toBe(0)
        expect(sm.get('deployment').size).toBe(0)
      })

      it('9. org target:children for branches strips suborg+repo', () => {
        const settings = createSettings({ disable_plugins: [{ plugin: 'branches', target: 'children' }] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect(sm.get('org').size).toBe(0)
        expect([...sm.get('suborg')]).toEqual(['branches'])
        expect([...sm.get('repo')]).toEqual(['branches'])
      })

      it('10. org target:all for labels strips org+suborg+repo', () => {
        const settings = createSettings({ disable_plugins: ['labels'] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect([...sm.get('org')]).toEqual(['labels'])
        expect([...sm.get('suborg')]).toEqual(['labels'])
        expect([...sm.get('repo')]).toEqual(['labels'])
      })

      it('11. suborg target:all contributes only when a suborg matches the repo', () => {
        const settings = createSettings({})
        settings.subOrgConfigs = {
          [repoName]: { disable_plugins: ['teams'], source: '.github/suborgs/x.yml' }
        }
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect([...sm.get('suborg')]).toEqual(['teams'])
        expect([...sm.get('repo')]).toEqual(['teams'])

        const sm2 = settings.computeStripMap('other-repo')
        expect(sm2.get('suborg').size).toBe(0)
        expect(sm2.get('repo').size).toBe(0)
      })

      it('12. repo-declared target:all only strips repo layer', () => {
        const settings = createSettings({})
        settings.subOrgConfigs = {}
        settings.repoConfigs = { [`${repoName}.yml`]: { disable_plugins: ['labels'] } }
        const sm = settings.computeStripMap(repoName)
        expect(sm.get('org').size).toBe(0)
        expect(sm.get('suborg').size).toBe(0)
        expect([...sm.get('repo')]).toEqual(['labels'])
      })

      it('13. deployment target:children strips org+suborg+repo', () => {
        DeploymentConfig.config.disable_plugins = [{ plugin: 'milestones', target: 'children' }]
        const settings = createSettings({})
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect(sm.get('deployment').size).toBe(0)
        expect([...sm.get('org')]).toEqual(['milestones'])
        expect([...sm.get('suborg')]).toEqual(['milestones'])
        expect([...sm.get('repo')]).toEqual(['milestones'])
      })

      it('14. union across layers: org self + repo all → org and repo both contain plugin', () => {
        const settings = createSettings({ disable_plugins: [{ plugin: 'labels', target: 'self' }] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = { [`${repoName}.yml`]: { disable_plugins: ['labels'] } }
        const sm = settings.computeStripMap(repoName)
        expect([...sm.get('org')]).toEqual(['labels'])
        expect(sm.get('suborg').size).toBe(0)
        expect([...sm.get('repo')]).toEqual(['labels'])
      })
    })

    // ── childPluginsList integration ─────────────────────────────────────
    describe('childPluginsList integration', () => {
      it('15. org disables custom_properties (target:all) → not in plugin list even with repo override', () => {
        const settings = createSettings({
          disable_plugins: ['custom_properties'],
          custom_properties: [{ property_name: 'a', value: '1' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = { 'foo.yml': { custom_properties: [{ property_name: 'b', value: '2' }] } }
        const list = settings.childPluginsList({ repo: 'foo' })
        const pluginNames = list.map(([P]) => Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(pluginNames).not.toContain('custom_properties')
      })

      it('16. suborg-declared branches + suborg disable_plugins:branches → stripped for matched repo only', () => {
        // Per the matrix, suborg target:all strips suborg+repo (NOT org).
        // So we put branches only at suborg level for a meaningful test.
        const settings = createSettings({})
        settings.subOrgConfigs = {
          'matched-repo': {
            disable_plugins: ['branches'],
            branches: [{ name: 'main', protection: {} }],
            source: '.github/suborgs/x.yml'
          },
          'other-repo': {
            // different suborg without disable; still declares branches
            branches: [{ name: 'main', protection: {} }],
            source: '.github/suborgs/y.yml'
          }
        }
        settings.repoConfigs = {}
        const matched = settings.childPluginsList({ repo: 'matched-repo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        const other = settings.childPluginsList({ repo: 'other-repo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(matched).not.toContain('branches')
        expect(other).toContain('branches')
      })

      it('17. repo-level labels + repo disable_plugins:labels → stripped for that repo only', () => {
        // Repo target:all strips only the repo layer (matrix). To demonstrate
        // scoping we put labels in each repo's own yml so the strip is effective.
        const settings = createSettings({})
        settings.subOrgConfigs = {}
        settings.repoConfigs = {
          'foo.yml': { disable_plugins: ['labels'], labels: { include: [{ name: 'bug' }] } },
          'bar.yml': { labels: { include: [{ name: 'bug' }] } }
        }
        const foo = settings.childPluginsList({ repo: 'foo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        const bar = settings.childPluginsList({ repo: 'bar' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(foo).not.toContain('labels')
        expect(bar).toContain('labels')
      })

      it('18. org target:children for variables: org-level variables still run per-repo (documented nuance)', () => {
        // target:children strips from suborg+repo only; merged repo plugin
        // config still inherits the org-level variables → plugin DOES run.
        const settings = createSettings({
          disable_plugins: [{ plugin: 'variables', target: 'children' }],
          variables: [{ name: 'FOO', value: 'bar' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const names = settings.childPluginsList({ repo: 'foo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(names).toContain('variables')
      })

      it('19. org target:all for variables: variables plugin is fully suppressed', () => {
        const settings = createSettings({
          disable_plugins: [{ plugin: 'variables', target: 'all' }],
          variables: [{ name: 'FOO', value: 'bar' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const names = settings.childPluginsList({ repo: 'foo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(names).not.toContain('variables')
      })
    })

    // ── updateOrg integration ────────────────────────────────────────────
    describe('updateOrg integration', () => {
      function stubPlugin () {
        const sync = jest.fn().mockResolvedValue([])
        const ctor = jest.fn().mockImplementation(() => ({ sync }))
        return { ctor, sync }
      }

      it('20. org disable rulesets (target:self) → rulesets plugin NOT invoked', async () => {
        const { ctor } = stubPlugin()
        Settings.PLUGINS.rulesets = ctor
        const settings = createSettings({
          disable_plugins: [{ plugin: 'rulesets', target: 'self' }],
          rulesets: [{ name: 'foo' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        await settings.updateOrg()
        expect(ctor).not.toHaveBeenCalled()
      })

      it('21. org disable custom_repository_roles (shorthand) → plugin NOT invoked', async () => {
        const { ctor } = stubPlugin()
        Settings.PLUGINS.custom_repository_roles = ctor
        const settings = createSettings({
          disable_plugins: ['custom_repository_roles'],
          custom_repository_roles: [{ name: 'sec' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        await settings.updateOrg()
        expect(ctor).not.toHaveBeenCalled()
      })

      it('22. deployment disable rulesets overrides org config that wants rulesets', async () => {
        DeploymentConfig.config.disable_plugins = ['rulesets']
        const { ctor } = stubPlugin()
        Settings.PLUGINS.rulesets = ctor
        const settings = createSettings({ rulesets: [{ name: 'foo' }] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        await settings.updateOrg()
        expect(ctor).not.toHaveBeenCalled()
      })

      it('23. org custom_repository_roles receives additive=true when listed in additive_plugins', async () => {
        const instances = []
        const ctor = jest.fn().mockImplementation(function () {
          this.sync = jest.fn().mockResolvedValue([])
          instances.push(this)
        })
        Settings.PLUGINS.custom_repository_roles = ctor

        const settings = createSettings({
          additive_plugins: ['custom_repository_roles'],
          custom_repository_roles: [{ name: 'sec' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        await settings.updateOrg()

        expect(instances).toHaveLength(1)
        expect(instances[0].additive).toBe(true)
      })
    })

    // ── updateRepos integration ──────────────────────────────────────────
    describe('updateRepos integration', () => {
      it('24. org disable repository → RepoPlugin not instantiated', async () => {
        const repoSync = jest.fn().mockResolvedValue([])
        const repoCtor = jest.fn().mockImplementation(() => ({ sync: repoSync, renamed: false, created: false }))
        Settings.PLUGINS.repository = repoCtor
        const settings = createSettings({
          disable_plugins: ['repository'],
          repository: { name: 'will-not-be-used' }
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        // Avoid running child plugins (their internal logic isn't under test).
        jest.spyOn(settings, 'childPluginsList').mockReturnValue([])
        await settings.updateRepos({ owner: 'o', repo: 'r' })
        expect(repoCtor).not.toHaveBeenCalled()
      })

      it('24. org disable archive → archive plugin getState NOT invoked', async () => {
        const Archive = require('../../../lib/plugins/archive')
        const getStateSpy = jest.spyOn(Archive.prototype, 'getState').mockResolvedValue({ shouldArchive: false, shouldUnarchive: false })
        // RepoPlugin still runs; stub it to a no-op constructor.
        const repoSync = jest.fn().mockResolvedValue([])
        Settings.PLUGINS.repository = jest.fn().mockImplementation(() => ({ sync: repoSync, renamed: false, created: false }))
        const settings = createSettings({
          disable_plugins: ['archive'],
          repository: { name: 'r' }
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        jest.spyOn(settings, 'childPluginsList').mockReturnValue([])
        await settings.updateRepos({ owner: 'o', repo: 'r' })
        expect(getStateSpy).not.toHaveBeenCalled()
        getStateSpy.mockRestore()
      })
    })

    // ── cascade enforcement ──────────────────────────────────────────────
    describe('cascade enforcement', () => {
      it('25. org target:all labels; repo declares empty disable_plugins → labels still disabled', () => {
        const settings = createSettings({
          disable_plugins: ['labels'],
          labels: { include: [{ name: 'bug' }] }
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = { 'foo.yml': { disable_plugins: [] } }
        const names = settings.childPluginsList({ repo: 'foo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(names).not.toContain('labels')
      })
    })

    // ── NOP mode ─────────────────────────────────────────────────────────
    describe('NOP mode', () => {
      it('26. each strip produces a NopCommand with type=INFO and plugin/level info', () => {
        const settings = new Settings(true, stubContext, mockRepo, {
          disable_plugins: ['labels'],
          labels: { include: [{ name: 'bug' }] }
        }, mockRef)
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        settings.childPluginsList({ repo: 'foo' })
        const nopEntries = settings.results.filter(r => r && r.plugin === 'disable_plugins')
        expect(nopEntries.length).toBeGreaterThan(0)
        expect(nopEntries[0].type).toBe('INFO')
        expect(nopEntries[0].action.msg).toMatch(/labels/)
        expect(nopEntries[0].action.msg).toMatch(/declared by/)
      })

      it('27. dedup retains all disable_plugins NopCommands when multiple plugins are disabled for the same repo', () => {
        // Disable both labels and teams at org level for all layers.
        const settings = new Settings(true, stubContext, mockRepo, {
          disable_plugins: ['labels', 'teams'],
          labels: [{ name: 'bug', color: 'red' }],
          teams: [{ name: 'core', permission: 'push' }]
        }, mockRef)
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        settings.childPluginsList({ repo: 'foo' })
        const nopEntries = settings.results.filter(r => r && r.plugin === 'disable_plugins')
        // Both 'labels' and 'teams' disable messages must survive; the old
        // dedup (key = type+repo+plugin+endpoint) would drop one of them
        // because they share the same empty endpoint. The new key adds
        // action.msg, so each unique message is kept.
        const msgs = nopEntries.map(r => r.action.msg)
        expect(msgs.some(m => /labels/.test(m))).toBe(true)
        expect(msgs.some(m => /teams/.test(m))).toBe(true)
      })

      it.each([
        ['without a check run', {}],
        ['without a repository', { check_run: { id: 123 } }]
      ])('28. full-sync dry run %s logs a value-free summary instead of updating a check run', async (_description, payload) => {
        stubContext.payload = { installation: { id: 123 }, ...payload }
        stubContext.octokit.checks = { update: jest.fn().mockResolvedValue({}) }

        const settings = new Settings(true, stubContext, mockRepo, {}, mockRef)
        settings.results = [{
          type: 'INFO',
          plugin: 'Variables',
          repo: 'test/test-repo',
          endpoint: '',
          action: {
            msg: 'Changes found',
            additions: {},
            modifications: { MY_VAR: { value: 'plain-value' } },
            deletions: {}
          }
        }]

        await settings.handleResults()

        expect(stubContext.log.info).toHaveBeenCalledWith(expect.stringContaining('Changes found'))
        expect(stubContext.log.info).not.toHaveBeenCalledWith(expect.stringContaining('plain-value'))
        expect(stubContext.log.debug).toHaveBeenCalledWith({ results: settings.results }, 'Dry-run results')
        expect(stubContext.octokit.checks.update).not.toHaveBeenCalled()
      })

      it('28. base-config filtering preserves org-rulesets informational NopCommands', async () => {
        stubContext.payload.repository = { owner: { login: 'test' }, name: 'safe-settings' }
        stubContext.payload.check_run = { id: 123, check_suite: { pull_requests: [{ number: 456 }] } }
        stubContext.octokit.rest.checks = { update: jest.fn().mockResolvedValue({}) }
        stubContext.octokit.rest.issues = { createComment: jest.fn().mockResolvedValue({}) }

        const settings = new Settings(true, stubContext, mockRepo, {
          rulesets: [{ name: 'managed', enforcement: 'disabled' }]
        }, mockRef)
        settings.baseConfig = {
          rulesets: [{ name: 'managed', enforcement: 'active' }]
        }
        settings.results = [{
          type: 'INFO',
          plugin: 'Rulesets',
          repo: 'test (org)',
          endpoint: '',
          action: {
            msg: 'Additive mode active: 1 deletion(s) suppressed by additive_plugins',
            additions: null,
            modifications: null,
            deletions: null
          }
        }]

        await settings.handleResults()

        expect(stubContext.octokit.rest.checks.update).toHaveBeenCalled()
        const summary = stubContext.octokit.rest.checks.update.mock.calls[0][0].output.summary
        expect(summary).toMatch(/Informational messages/)
        expect(summary).toMatch(/suppressed by additive_plugins/)
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  describe('additive_plugins', () => {
    // ── Settings.ADDITIVE_PLUGINS constant ───────────────────────────────
    describe('Settings.ADDITIVE_PLUGINS', () => {
      it('28. contains all 11 additive plugin names', () => {
        const expected = new Set([
          'labels', 'collaborators', 'teams', 'milestones', 'autolinks',
          'environments', 'custom_properties', 'variables', 'rulesets',
          'custom_repository_roles', 'app_installations'
        ])
        expect(Settings.ADDITIVE_PLUGINS).toEqual(expected)
      })

      it('29. does NOT include non-Diffable plugins', () => {
        expect(Settings.ADDITIVE_PLUGINS.has('repository')).toBe(false)
        expect(Settings.ADDITIVE_PLUGINS.has('archive')).toBe(false)
        expect(Settings.ADDITIVE_PLUGINS.has('branches')).toBe(false)
        expect(Settings.ADDITIVE_PLUGINS.has('validator')).toBe(false)
      })
    })

    // ── normalizeAdditivePlugins ─────────────────────────────────────────
    describe('normalizeAdditivePlugins', () => {
      it('30. returns empty Set when additive_plugins is absent', () => {
        const settings = createSettings({})
        expect(settings.normalizeAdditivePlugins().size).toBe(0)
      })

      it('31. returns correct Set for valid plugin names', () => {
        const settings = createSettings({ additive_plugins: ['labels', 'teams', 'milestones'] })
        const result = settings.normalizeAdditivePlugins()
        expect(result).toEqual(new Set(['labels', 'teams', 'milestones']))
      })

      it('32. all 11 additive plugins are accepted without error', () => {
        const all = [...Settings.ADDITIVE_PLUGINS]
        const settings = createSettings({ additive_plugins: all })
        const logErrorSpy = jest.spyOn(settings, 'logError').mockImplementation(() => {})
        const result = settings.normalizeAdditivePlugins()
        expect(result.size).toBe(11)
        expect(logErrorSpy).not.toHaveBeenCalled()
        logErrorSpy.mockRestore()
      })

      it('33. unknown plugin name logs error and is excluded from Set', () => {
        const settings = createSettings({ additive_plugins: ['labels', 'nope-plugin'] })
        const logErrorSpy = jest.spyOn(settings, 'logError').mockImplementation(() => {})
        const result = settings.normalizeAdditivePlugins()
        expect(result.has('labels')).toBe(true)
        expect(result.has('nope-plugin')).toBe(false)
        expect(logErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/unknown or non-Diffable plugin 'nope-plugin'/))
        logErrorSpy.mockRestore()
      })

      it('34. non-Diffable plugin name (branches) logs error and is excluded', () => {
        const settings = createSettings({ additive_plugins: ['branches'] })
        const logErrorSpy = jest.spyOn(settings, 'logError').mockImplementation(() => {})
        const result = settings.normalizeAdditivePlugins()
        expect(result.has('branches')).toBe(false)
        expect(logErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/unknown or non-Diffable plugin 'branches'/))
        logErrorSpy.mockRestore()
      })

      it('35. non-string entries log error and are skipped', () => {
        const settings = createSettings({ additive_plugins: ['labels', 42, null] })
        const logErrorSpy = jest.spyOn(settings, 'logError').mockImplementation(() => {})
        const result = settings.normalizeAdditivePlugins()
        expect(result).toEqual(new Set(['labels']))
        expect(logErrorSpy).toHaveBeenCalledTimes(2) // 42 + null
        logErrorSpy.mockRestore()
      })

      it('36. non-array value logs error and returns empty Set', () => {
        const settings = createSettings({ additive_plugins: 'labels' })
        const logErrorSpy = jest.spyOn(settings, 'logError').mockImplementation(() => {})
        const result = settings.normalizeAdditivePlugins()
        expect(result.size).toBe(0)
        expect(logErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/must be an array/))
        logErrorSpy.mockRestore()
      })
    })

    // ── childPluginsList returns triplets ────────────────────────────────
    describe('childPluginsList triplets', () => {
      it('37. each entry includes section name as 3rd element', () => {
        const settings = createSettings({ labels: [{ name: 'bug', color: 'red' }] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const list = settings.childPluginsList({ repo: 'foo' })
        expect(list.length).toBeGreaterThan(0)
        list.forEach(entry => {
          expect(entry.length).toBe(3)
          expect(typeof entry[2]).toBe('string')
          expect(entry[2]).toMatch(/^[a-z_]+$/)
        })
      })

      it('38. section names map to the correct Settings.PLUGINS keys', () => {
        const settings = createSettings({
          labels: [{ name: 'bug', color: 'red' }],
          teams: [{ name: 'core', permission: 'push' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const list = settings.childPluginsList({ repo: 'foo' })
        list.forEach(([Plugin, , section]) => {
          expect(Settings.PLUGINS[section]).toBe(Plugin)
        })
      })
    })

    // ── updateRepos integration: additive flag threading ─────────────────
    describe('updateRepos integration: additive flag', () => {
      it('processes changed repo configs that were not returned by the installation repository list', async () => {
        const settings = createSettings({ restrictedRepos: {} })
        const updateReposSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue([])

        settings.processedRepoNames = new Set(['existing-repo'])

        await settings.updateChangedRepoConfigs([
          { owner: 'test', repo: 'existing-repo' },
          { owner: 'test', repo: 'new-repo' },
          { owner: 'test', repo: 'new-repo' }
        ])

        expect(updateReposSpy).toHaveBeenCalledTimes(1)
        expect(updateReposSpy).toHaveBeenCalledWith({ owner: 'test', repo: 'new-repo' })
      })

      it('39. plugin listed in additive_plugins has additive=true set before sync()', async () => {
        const instances = []
        const syncMock = jest.fn().mockResolvedValue([])
        const LabelsCtor = jest.fn().mockImplementation(function (...args) {
          this.sync = syncMock
          this.hasChanges = false
          instances.push(this)
        })
        const savedLabels = Settings.PLUGINS.labels
        Settings.PLUGINS.labels = LabelsCtor

        const repoSync = jest.fn().mockResolvedValue([])
        Settings.PLUGINS.repository = jest.fn().mockImplementation(() => ({
          sync: repoSync, renamed: false, created: false
        }))

        try {
          const settings = createSettings({
            additive_plugins: ['labels'],
            labels: [{ name: 'bug', color: 'red' }]
          })
          settings.subOrgConfigs = {}
          settings.repoConfigs = {}
          // Clear subOrgConfigMap so the "suborg-change early return" in
          // updateRepos does not fire (mockSubOrg='frontend' sets it in ctor).
          settings.subOrgConfigMap = null
          // Mock childPluginsList to return just the labels triplet so we can
          // control what updateRepos sees without mocking all other plugins.
          jest.spyOn(settings, 'childPluginsList').mockReturnValue([
            [LabelsCtor, [{ name: 'bug', color: 'red' }], 'labels']
          ])
          jest.spyOn(settings, 'maybeReevaluateSuborg').mockResolvedValue(undefined)
          await settings.updateRepos({ owner: 'o', repo: 'r' })
          expect(instances.length).toBeGreaterThan(0)
          // Every labels instance must have additive=true
          instances.forEach(inst => expect(inst.additive).toBe(true))
        } finally {
          Settings.PLUGINS.labels = savedLabels
        }
      })

      it('40. plugin NOT in additive_plugins has additive=false (default)', async () => {
        const instances = []
        const syncMock = jest.fn().mockResolvedValue([])
        const TeamsCtor = jest.fn().mockImplementation(function (...args) {
          this.sync = syncMock
          this.hasChanges = false
          instances.push(this)
        })
        const savedTeams = Settings.PLUGINS.teams
        Settings.PLUGINS.teams = TeamsCtor

        Settings.PLUGINS.repository = jest.fn().mockImplementation(() => ({
          sync: jest.fn().mockResolvedValue([]), renamed: false, created: false
        }))

        try {
          const settings = createSettings({
            additive_plugins: ['labels'], // teams is NOT listed
            teams: [{ name: 'core', permission: 'push' }]
          })
          settings.subOrgConfigs = {}
          settings.repoConfigs = {}
          // Clear subOrgConfigMap so the "suborg-change early return" does not fire.
          settings.subOrgConfigMap = null
          jest.spyOn(settings, 'childPluginsList').mockReturnValue([
            [TeamsCtor, [{ name: 'core', permission: 'push' }], 'teams']
          ])
          jest.spyOn(settings, 'maybeReevaluateSuborg').mockResolvedValue(undefined)
          await settings.updateRepos({ owner: 'o', repo: 'r' })
          expect(instances.length).toBeGreaterThan(0)
          instances.forEach(inst => expect(inst.additive).toBe(false))
        } finally {
          Settings.PLUGINS.teams = savedTeams
        }
      })
    })

    // ── Diffable.sync() additive behaviour ───────────────────────────────
    describe('Diffable.sync() additive behaviour', () => {
      const Diffable = require('../../../lib/plugins/diffable')

      // Minimal concrete Diffable subclass for testing.
      class TestDiffable extends Diffable {
        constructor (nop, entries) {
          super(nop, {}, { owner: 'o', repo: 'r' }, entries, { debug: jest.fn(), info: jest.fn(), error: jest.fn() }, [])
        }

        find () { return Promise.resolve(this._existing || []) }
        comparator (a, b) { return a.name === b.name }
        changed (a, b) { return a.value !== b.value }
        add (attrs) { return Promise.resolve([]) }
        update (existing, attrs) { return Promise.resolve([]) }
        remove (existing) { return Promise.resolve([]) }
      }

      it('41. additive=false → remove() is called for unmatched existing entries', async () => {
        const plugin = new TestDiffable(false, [{ name: 'keep', value: '1' }])
        plugin._existing = [
          { name: 'keep', value: '1' },
          { name: 'gone', value: '2' } // this one has no match in entries
        ]
        plugin.additive = false
        const removeSpy = jest.spyOn(plugin, 'remove').mockResolvedValue([])
        await plugin.sync()
        expect(removeSpy).toHaveBeenCalledTimes(1)
        expect(removeSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'gone' }))
        removeSpy.mockRestore()
      })

      it('42. additive=true → remove() is NOT called even when existing entries have no YAML match', async () => {
        const plugin = new TestDiffable(false, [{ name: 'keep', value: '1' }])
        plugin._existing = [
          { name: 'keep', value: '1' },
          { name: 'gone', value: '2' }
        ]
        plugin.additive = true
        const removeSpy = jest.spyOn(plugin, 'remove').mockResolvedValue([])
        await plugin.sync()
        expect(removeSpy).not.toHaveBeenCalled()
        removeSpy.mockRestore()
      })

      it('43. additive=true → add() is still called for new YAML entries', async () => {
        const plugin = new TestDiffable(false, [
          { name: 'existing', value: '1' },
          { name: 'new-entry', value: '2' }
        ])
        plugin._existing = [{ name: 'existing', value: '1' }]
        plugin.additive = true
        const addSpy = jest.spyOn(plugin, 'add').mockResolvedValue([])
        const removeSpy = jest.spyOn(plugin, 'remove').mockResolvedValue([])
        await plugin.sync()
        expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'new-entry' }))
        expect(removeSpy).not.toHaveBeenCalled()
        addSpy.mockRestore()
        removeSpy.mockRestore()
      })

      it('44. additive=true → update() is still called for changed entries', async () => {
        const plugin = new TestDiffable(false, [{ name: 'item', value: 'new' }])
        plugin._existing = [{ name: 'item', value: 'old' }]
        plugin.additive = true
        const updateSpy = jest.spyOn(plugin, 'update').mockResolvedValue([])
        const removeSpy = jest.spyOn(plugin, 'remove').mockResolvedValue([])
        await plugin.sync()
        expect(updateSpy).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'item', value: 'old' }),
          expect.objectContaining({ name: 'item', value: 'new' })
        )
        expect(removeSpy).not.toHaveBeenCalled()
        updateSpy.mockRestore()
        removeSpy.mockRestore()
      })

      it('45. NOP mode + additive=true + deletions present → INFO NopCommand about suppressed deletions', async () => {
        const plugin = new TestDiffable(true, [{ name: 'keep', value: '1' }])
        plugin._existing = [
          { name: 'keep', value: '1' },
          { name: 'gone', value: '2' }
        ]
        plugin.additive = true
        const result = await plugin.sync()
        const suppressed = result.flat().filter(cmd =>
          cmd && cmd.type === 'INFO' && /suppressed by additive_plugins/i.test(cmd.action.msg)
        )
        expect(suppressed.length).toBeGreaterThan(0)
        expect(suppressed[0].action.msg).toMatch(/1 deletion/)
      })

      it('46. NOP mode + additive=true + NO deletions → no suppressed message emitted', async () => {
        const plugin = new TestDiffable(true, [{ name: 'item', value: '1' }])
        plugin._existing = [{ name: 'item', value: '1' }] // identical → no changes at all
        plugin.additive = true
        const result = await plugin.sync()
        if (result) {
          const suppressed = result.flat().filter(cmd =>
            cmd && cmd.action && /suppressed by additive_plugins/i.test(cmd.action.msg)
          )
          expect(suppressed.length).toBe(0)
        }
        // result may be undefined (no changes) which is also correct
      })
    })
  })

  describe('getReposRemovedFromSubOrgTargeting', () => {
    let settings

    beforeEach(() => {
      stubConfig = { restrictedRepos: {} }
      settings = createSettings(stubConfig)
    })

    it('returns empty result when no changedSubOrgs provided', async () => {
      const result = await settings.getReposRemovedFromSubOrgTargeting([], 'prev-sha')
      expect(result.repos).toEqual([])
      expect(result.previousPluginSections).toEqual([])
    })

    it('returns empty result when no baseRef provided', async () => {
      const result = await settings.getReposRemovedFromSubOrgTargeting([{ path: '.github/suborgs/frontend.yml' }], null)
      expect(result.repos).toEqual([])
      expect(result.previousPluginSections).toEqual([])
    })

    it('identifies repos removed from suborgrepos targeting', async () => {
      // Previous config had repo-a and repo-b in suborgrepos
      const previousContent = Buffer.from(yaml.dump({
        suborgrepos: ['repo-a', 'repo-b'],
        teams: [{ name: 'core', permission: 'push' }]
      })).toString('base64')

      stubContext.octokit.rest.repos.getContent = jest.fn().mockImplementation((params) => {
        if (params.ref === 'prev-sha') {
          return Promise.resolve({ data: { content: previousContent } })
        }
        // Current config: default mock (has new-repo in suborgrepos)
        const currentContent = Buffer.from(yaml.dump({
          suborgrepos: ['repo-b'],
          teams: [{ name: 'core', permission: 'push' }]
        })).toString('base64')
        return Promise.resolve({ data: { content: currentContent } })
      })

      // Mock installation repos for glob resolution
      stubContext.octokit.paginate = jest.fn().mockResolvedValue([
        { name: 'repo-a', owner: { login: 'test' } },
        { name: 'repo-b', owner: { login: 'test' } }
      ])

      // Current subOrgConfigs only has repo-b (repo-a was removed from targeting)
      settings.subOrgConfigs = {
        'repo-b': { source: '.github/suborgs/frontend.yml' }
      }

      const result = await settings.getReposRemovedFromSubOrgTargeting(
        [{ path: '.github/suborgs/frontend.yml', name: 'frontend' }],
        'prev-sha'
      )

      expect(result.repos).toContain('repo-a')
      expect(result.repos).not.toContain('repo-b')
      expect(result.previousPluginSections).toContain('teams')
    })

    it('identifies repos removed from suborgrepos glob targeting', async () => {
      const previousContent = Buffer.from(yaml.dump({
        suborgrepos: ['team-*'],
        teams: [{ name: 'core', permission: 'push' }]
      })).toString('base64')

      stubContext.octokit.rest.repos.getContent = jest.fn().mockImplementation((params) => {
        if (params.ref === 'prev-sha') {
          return Promise.resolve({ data: { content: previousContent } })
        }
        return Promise.resolve({ data: { content: previousContent } })
      })

      stubContext.octokit.paginate = jest.fn().mockResolvedValue([
        { owner: { login: 'test' }, name: 'team-a1' },
        { owner: { login: 'test' }, name: 'team-b1' },
        { owner: { login: 'test' }, name: 'other' }
      ])

      // Current targeting only matches team-a*
      settings.subOrgConfigs = {
        'team-a*': { source: '.github/suborgs/frontend.yml' }
      }

      const result = await settings.getReposRemovedFromSubOrgTargeting(
        [{ path: '.github/suborgs/frontend.yml', name: 'frontend' }],
        'prev-sha'
      )

      expect(result.repos).toContain('team-b1')
      expect(result.repos).not.toContain('team-a1')
      expect(result.repos).not.toContain('other')
    })

    it('identifies repos removed from suborgteams targeting', async () => {
      // Previous config used suborgteams: [team-a]
      const previousContent = Buffer.from(yaml.dump({
        suborgteams: ['team-a'],
        teams: [{ name: 'core', permission: 'push' }]
      })).toString('base64')

      stubContext.octokit.rest.repos.getContent = jest.fn().mockImplementation((params) => {
        if (params.ref === 'prev-sha') {
          return Promise.resolve({ data: { content: previousContent } })
        }
        return Promise.resolve({ data: { content: previousContent } })
      })

      // Mock getReposForTeam to return repos for team-a
      settings.getReposForTeam = jest.fn().mockResolvedValue([
        { name: 'team-repo-1' },
        { name: 'team-repo-2' }
      ])

      // Current subOrgConfigs: only team-repo-1 still matches (team-repo-2 was removed)
      settings.subOrgConfigs = {
        'team-repo-1': { source: '.github/suborgs/frontend.yml' }
      }

      const result = await settings.getReposRemovedFromSubOrgTargeting(
        [{ path: '.github/suborgs/frontend.yml', name: 'frontend' }],
        'prev-sha'
      )

      expect(result.repos).toContain('team-repo-2')
      expect(result.repos).not.toContain('team-repo-1')
    })

    it('identifies repos removed from suborgproperties targeting', async () => {
      // Previous config used suborgproperties
      const previousContent = Buffer.from(yaml.dump({
        suborgproperties: [{ EDP: true }],
        teams: [{ name: 'core', permission: 'push' }]
      })).toString('base64')

      stubContext.octokit.rest.repos.getContent = jest.fn().mockImplementation((params) => {
        if (params.ref === 'prev-sha') {
          return Promise.resolve({ data: { content: previousContent } })
        }
        return Promise.resolve({ data: { content: previousContent } })
      })

      // Mock getSubOrgRepositories to return repos with the property
      settings.getSubOrgRepositories = jest.fn().mockResolvedValue([
        { repository_name: 'prop-repo-1' },
        { repository_name: 'prop-repo-2' }
      ])

      // Current subOrgConfigs: only prop-repo-1 still matches
      settings.subOrgConfigs = {
        'prop-repo-1': { source: '.github/suborgs/frontend.yml' }
      }

      const result = await settings.getReposRemovedFromSubOrgTargeting(
        [{ path: '.github/suborgs/frontend.yml', name: 'frontend' }],
        'prev-sha'
      )

      expect(result.repos).toContain('prop-repo-2')
      expect(result.repos).not.toContain('prop-repo-1')
    })

    it('deduplicates removed repos across multiple suborg files', async () => {
      const previousContent = Buffer.from(yaml.dump({
        suborgrepos: ['repo-a', 'repo-b']
      })).toString('base64')

      stubContext.octokit.rest.repos.getContent = jest.fn().mockResolvedValue({
        data: { content: previousContent }
      })

      // Mock installation repos for glob resolution
      stubContext.octokit.paginate = jest.fn().mockResolvedValue([
        { name: 'repo-a', owner: { login: 'test' } },
        { name: 'repo-b', owner: { login: 'test' } }
      ])

      // Neither repo matches current targeting
      settings.subOrgConfigs = {}

      const result = await settings.getReposRemovedFromSubOrgTargeting(
        [
          { path: '.github/suborgs/frontend.yml', name: 'frontend' },
          { path: '.github/suborgs/frontend.yml', name: 'frontend' } // duplicate
        ],
        'prev-sha'
      )

      // Should be deduplicated
      const repoACount = result.repos.filter(r => r === 'repo-a').length
      expect(repoACount).toBe(1)
    })

    it('handles 404 gracefully when previous file does not exist', async () => {
      stubContext.octokit.rest.repos.getContent = jest.fn().mockRejectedValue(
        Object.assign(new Error('Not Found'), { status: 404 })
      )

      settings.subOrgConfigs = {}

      const result = await settings.getReposRemovedFromSubOrgTargeting(
        [{ path: '.github/suborgs/new-suborg.yml', name: 'new-suborg' }],
        'prev-sha'
      )

      expect(result).toEqual({ repos: [], previousPluginSections: [] })
    })
  })

  describe('_buildAppChangesFromDelta', () => {
    let settings
    const AppOctokitClient = require('../../../lib/appOctokitClient')
    const RepoSelector = require('../../../lib/repoSelector')

    beforeEach(() => {
      stubConfig = { restrictedRepos: {} }
      settings = createSettings(stubConfig)
      // Map app slug -> installation id
      jest.spyOn(AppOctokitClient.prototype, 'listOrgInstallations').mockResolvedValue([
        { app_slug: 'my-app', id: 42 }
      ])
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('skips an app when suborg targeting and app_installations are unchanged', async () => {
      // Same targeting resolves to the same repos in both versions
      jest.spyOn(RepoSelector.prototype, 'resolve').mockResolvedValue(new Set(['repo-a', 'repo-b']))

      // Current suborg config: app present
      settings.subOrgConfigs = {
        frontend: {
          suborgrepos: ['repo-a', 'repo-b'],
          app_installations: [{ app_slug: 'my-app' }]
        }
      }
      // Previous version (baseRef): identical app_installations
      settings.loadYamlFromRef = jest.fn().mockResolvedValue({
        suborgrepos: ['repo-a', 'repo-b'],
        app_installations: [{ app_slug: 'my-app' }]
      })

      const result = await settings._buildAppChangesFromDelta(
        settings.github,
        'my-enterprise',
        [{ repo: 'frontend', path: '.github/suborgs/frontend.yml' }],
        [],
        'prev-sha'
      )

      // No churn: nothing to add or remove
      expect(result).toEqual([])
    })

    it('emits only the targeting diff when suborg repos change', async () => {
      // previous: repo-a, repo-b ; current: repo-b, repo-c
      jest.spyOn(RepoSelector.prototype, 'resolve')
        .mockResolvedValueOnce(new Set(['repo-b', 'repo-c'])) // current
        .mockResolvedValueOnce(new Set(['repo-a', 'repo-b'])) // previous

      settings.subOrgConfigs = {
        frontend: {
          suborgrepos: ['repo-b', 'repo-c'],
          app_installations: [{ app_slug: 'my-app' }]
        }
      }
      settings.loadYamlFromRef = jest.fn().mockResolvedValue({
        suborgrepos: ['repo-a', 'repo-b'],
        app_installations: [{ app_slug: 'my-app' }]
      })

      const result = await settings._buildAppChangesFromDelta(
        settings.github,
        'my-enterprise',
        [{ repo: 'frontend', path: '.github/suborgs/frontend.yml' }],
        [],
        'prev-sha'
      )

      expect(result).toHaveLength(1)
      expect(result[0].app_slug).toBe('my-app')
      expect(result[0].repository_selection.sort()).toEqual(['repo-c'])
      expect(result[0].repository_unselection.sort()).toEqual(['repo-a'])
    })

    it('skips apps configured at the org level (org entry implies all repos)', async () => {
      jest.spyOn(RepoSelector.prototype, 'resolve').mockResolvedValue(new Set(['repo-a']))

      settings.config = {
        ...settings.config,
        app_installations: [{ app_slug: 'my-app' }]
      }
      settings.subOrgConfigs = {
        frontend: { suborgrepos: ['repo-a'], app_installations: [{ app_slug: 'my-app' }] }
      }
      settings.loadYamlFromRef = jest.fn().mockResolvedValue({})

      const result = await settings._buildAppChangesFromDelta(
        settings.github,
        'my-enterprise',
        [{ repo: 'frontend', path: '.github/suborgs/frontend.yml' }],
        [],
        'prev-sha'
      )

      expect(result).toEqual([])
    })
  })
}) // Settings Tests
