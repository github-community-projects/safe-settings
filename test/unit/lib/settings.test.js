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

  function createSettings(config) {
    const settings = new Settings(false, stubContext, mockRepo, config, mockRef, mockSubOrg)
    return settings;
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
     `).toString('base64');
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
        //mockSubOrg = jest.fn().mockReturnValue(['suborg1', 'suborg2'])
        mockSubOrg = undefined
        settings = createSettings(stubConfig)
        jest.spyOn(settings, 'loadConfigMap').mockImplementation(() => [{ name: "frontend", path: ".github/suborgs/frontend.yml" }])
        jest.spyOn(settings, 'loadYaml').mockImplementation(() => subOrgConfig)
        jest.spyOn(settings, 'getReposForTeam').mockImplementation(() => [{ name: 'repo-test' }])
        jest.spyOn(settings, 'getSubOrgRepositories').mockImplementation(() => [{ repository_name: 'repo-for-property' }])

        const subOrgConfigs = await settings.getSubOrgConfigs()
        expect(settings.loadConfigMap).toHaveBeenCalledTimes(1)

        // Get own properties of subOrgConfigs
        const ownProperties = Object.getOwnPropertyNames(subOrgConfigs);
        expect(ownProperties.length).toEqual(3)
      })

      it("Should throw an error when a repo is found in multiple suborgs configs'", async () => {
        //mockSubOrg = jest.fn().mockReturnValue(['suborg1', 'suborg2'])
        mockSubOrg = undefined
        settings = createSettings(stubConfig)
        jest.spyOn(settings, 'loadConfigMap').mockImplementation(() => [{ name: "frontend", path: ".github/suborgs/frontend.yml" }, { name: "backend", path: ".github/suborgs/backend.yml" }])
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
    let settings;

    beforeEach(() => {
      Settings.fileCache = {};
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
      };
      settings = createSettings({});
    });

    it('should return parsed YAML content when file is fetched successfully', async () => {
      // Given
      const filePath = 'path/to/file.yml';
      const content = Buffer.from('key: value').toString('base64');
      jest.spyOn(settings.github.rest.repos, 'getContent').mockResolvedValue({
        data: { content },
        headers: { etag: 'etag123' }
      });

      // When
      const result = await settings.loadYaml(filePath);

      // Then
      expect(result).toEqual({ key: 'value' });
      expect(Settings.fileCache[`${mockRepo.owner}/${filePath}`]).toEqual({
        etag: 'etag123',
        data: { content }
      });
    });

    it('should return cached content when file has not changed (304 response)', async () => {
      // Given
      const filePath = 'path/to/file.yml';
      const content = Buffer.from('key: value').toString('base64');
      Settings.fileCache[`${mockRepo.owner}/${filePath}`] = { etag: 'etag123', data: { content } };
      jest.spyOn(settings.github.rest.repos, 'getContent').mockRejectedValue({ status: 304 });

      // When
      const result = await settings.loadYaml(filePath);

      // Then
      expect(result).toEqual({ key: 'value' });
      expect(settings.github.rest.repos.getContent).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { 'If-None-Match': 'etag123' } })
      );
    });

    it('should not return cached content when the cache is for another org', async () => {
      // Given
      const filePath = 'path/to/file.yml';
      const content = Buffer.from('key: value').toString('base64');
      const wrongContent = Buffer.from('wrong: content').toString('base64');
      Settings.fileCache['another-org/path/to/file.yml'] = { etag: 'etag123', data: { wrongContent } };
      jest.spyOn(settings.github.rest.repos, 'getContent').mockResolvedValue({
        data: { content },
        headers: { etag: 'etag123' }
      });

      // When
      const result = await settings.loadYaml(filePath);

      // Then
      expect(result).toEqual({ key: 'value' });
    })

    it('should return null when the file path is a folder', async () => {
      // Given
      const filePath = 'path/to/folder';
      jest.spyOn(settings.github.rest.repos, 'getContent').mockResolvedValue({
        data: []
      });

      // When
      const result = await settings.loadYaml(filePath);

      // Then
      expect(result).toBeNull();
    });

    it('should return null when the file is a symlink or submodule', async () => {
      // Given
      const filePath = 'path/to/symlink';
      jest.spyOn(settings.github.rest.repos, 'getContent').mockResolvedValue({
        data: { content: null }
      });

      // When
      const result = await settings.loadYaml(filePath);

      // Then
      expect(result).toBeUndefined();
    });

    it('should handle 404 errors gracefully and return null', async () => {
      // Given
      const filePath = 'path/to/nonexistent.yml';
      jest.spyOn(settings.github.rest.repos, 'getContent').mockRejectedValue({ status: 404 });

      // When
      const result = await settings.loadYaml(filePath);

      // Then
      expect(result).toBeNull();
    });

    it('should throw an error for non-404 exceptions when not in nop mode', async () => {
      // Given
      const filePath = 'path/to/error.yml';
      jest.spyOn(settings.github.rest.repos, 'getContent').mockRejectedValue(new Error('Unexpected error'));

      // When / Then
      await expect(settings.loadYaml(filePath)).rejects.toThrow('Unexpected error');
    });

    it('should log and append NopCommand for non-404 exceptions in nop mode', async () => {
      // Given
      const filePath = 'path/to/error.yml';
      settings.nop = true;
      jest.spyOn(settings.github.rest.repos, 'getContent').mockRejectedValue(new Error('Unexpected error'));
      jest.spyOn(settings, 'appendToResults');

      // When
      const result = await settings.loadYaml(filePath);

      // Then
      expect(result).toBeUndefined();
      expect(settings.appendToResults).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'ERROR',
            action: expect.objectContaining({
              msg: expect.stringContaining('Unexpected error')
            })
          })
        ])
      );
    });
  });

  describe('updateRepos - archived repo skipping', () => {
    const Archive = require('../../../lib/plugins/archive')

    let settings
    let mockRepoSync
    let originalRepoPlugin

    beforeEach(() => {
      // Preserve the original RepoPlugin so it can be restored after each test
      originalRepoPlugin = Settings.PLUGINS.repository

      // Replace RepoPlugin with a mock constructor whose sync() we can assert on
      mockRepoSync = jest.fn().mockResolvedValue([])
      Settings.PLUGINS.repository = jest.fn().mockImplementation(() => ({
        sync: mockRepoSync
      }))

      // Build a Settings instance that will enter the `if (repoConfig)` branch:
      //   config.repository must be defined so repoConfig is truthy
      settings = new Settings(
        false,
        stubContext,
        { owner: 'test-org', repo: 'test-repo' },
        { repository: { name: 'test-repo' } },
        'main'
      )

      // Pre-set subOrgConfigs so updateRepos() does not call the async getSubOrgConfigs()
      settings.subOrgConfigs = {}

      // Pre-set repoConfigs so getRepoOverrideConfig() does not throw on undefined
      settings.repoConfigs = {}
    })

    afterEach(() => {
      // Restore the real RepoPlugin and all prototype spies
      Settings.PLUGINS.repository = originalRepoPlugin
      jest.restoreAllMocks()
    })

    it('updateRepos when repo is already archived and not being unarchived does not call RepoPlugin sync', async () => {
      // Arrange
      jest.spyOn(Archive.prototype, 'getState').mockResolvedValue({
        isArchived: true,
        shouldArchive: false,
        shouldUnarchive: false
      })

      // Act
      await settings.updateRepos({ owner: 'test-org', repo: 'test-repo' })

      // Assert
      expect(mockRepoSync).not.toHaveBeenCalled()
    })

    it('updateRepos when repo is archived but is being unarchived calls RepoPlugin sync', async () => {
      // Arrange
      jest.spyOn(Archive.prototype, 'getState').mockResolvedValue({
        isArchived: true,
        shouldArchive: false,
        shouldUnarchive: true
      })
      jest.spyOn(Archive.prototype, 'sync').mockResolvedValue([])

      // Act
      await settings.updateRepos({ owner: 'test-org', repo: 'test-repo' })

      // Assert
      expect(mockRepoSync).toHaveBeenCalledTimes(1)
    })

    it('updateRepos when repo is not archived calls RepoPlugin sync', async () => {
      // Arrange
      jest.spyOn(Archive.prototype, 'getState').mockResolvedValue({
        isArchived: false,
        shouldArchive: false,
        shouldUnarchive: false
      })

      // Act
      await settings.updateRepos({ owner: 'test-org', repo: 'test-repo' })

      // Assert
      expect(mockRepoSync).toHaveBeenCalledTimes(1)
    })
  }) // updateRepos - archived repo skipping
}) // Settings Tests
