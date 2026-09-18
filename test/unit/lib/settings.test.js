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

  describe('handleResults - PR comment dedupe', () => {
    function changeResult (repo) {
      return {
        type: 'INFO',
        plugin: 'Repository',
        repo,
        action: { additions: {}, deletions: {}, modifications: { name: repo } }
      }
    }

    function createSettingsWithDedupeEnabled (config) {
      const previousValue = process.env.PR_COMMENT_DEDUPE_ENABLED
      jest.resetModules()
      process.env.PR_COMMENT_DEDUPE_ENABLED = 'true'
      const SettingsWithDedupeEnabled = require('../../../lib/settings')
      if (previousValue === undefined) {
        delete process.env.PR_COMMENT_DEDUPE_ENABLED
      } else {
        process.env.PR_COMMENT_DEDUPE_ENABLED = previousValue
      }
      jest.resetModules()

      return new SettingsWithDedupeEnabled(true, stubContext, mockRepo, config, mockRef, mockSubOrg)
    }

    beforeEach(() => {
      stubContext.payload.check_run = {
        id: 1,
        check_suite: { pull_requests: [{ number: 42 }] }
      }
      stubContext.payload.repository = { owner: { login: 'test' }, name: 'test-repo' }
      stubContext.octokit.rest.issues = {
        listComments: jest.fn(),
        createComment: jest.fn().mockResolvedValue({ data: { id: 999, user: { id: 12345 } } })
      }
      stubContext.octokit.rest.checks = {
        update: jest.fn().mockResolvedValue({})
      }
      stubContext.octokit.graphql = jest.fn().mockResolvedValue({})
      stubContext.octokit.paginate = jest.fn().mockResolvedValue([])
    })

    it('does not list or minimize previous comments by default', async () => {
      const settings = createSettings({})
      settings.nop = true
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.paginate).not.toHaveBeenCalled()
      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('minimizes a stale matching bot comment and creates a fresh one when PR_COMMENT_DEDUPE_ENABLED=true', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 100, node_id: 'node-100', user: { type: 'User', id: 1 }, body: 'unrelated comment' },
        { id: 200, node_id: 'node-200', user: { type: 'Bot', id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nold diff' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).toHaveBeenCalledTimes(2)
      expect(stubContext.octokit.graphql.mock.calls[0][1]).toEqual({ ids: ['node-200'] })
      expect(stubContext.octokit.graphql.mock.calls[1][1]).toEqual({ id: 'node-200' })
      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('minimizes every stale matching comment when several exist from repeat runs', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nfirst' },
        { id: 2, node_id: 'node-2', user: { id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nsecond' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).toHaveBeenCalledTimes(3)
      expect(stubContext.octokit.graphql.mock.calls.slice(1).map(call => call[1])).toEqual([
        { id: 'node-1' },
        { id: 'node-2' }
      ])
    })

    it('does not re-minimize a comment that is already minimized', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nold diff' }
      ])
      stubContext.octokit.graphql.mockResolvedValue({ nodes: [{ id: 'node-1', isMinimized: true }] })
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).toHaveBeenCalledTimes(1)
      expect(stubContext.octokit.graphql.mock.calls[0][1]).toEqual({ ids: ['node-1'] })
    })

    it('only minimizes the not-yet-minimized comment out of several stale matches', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nfirst' },
        { id: 2, node_id: 'node-2', user: { id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nsecond' }
      ])
      stubContext.octokit.graphql.mockResolvedValueOnce({
        nodes: [
          { id: 'node-1', isMinimized: true },
          { id: 'node-2', isMinimized: false }
        ]
      })
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).toHaveBeenCalledTimes(2)
      expect(stubContext.octokit.graphql.mock.calls[0][1]).toEqual({ ids: ['node-1', 'node-2'] })
      expect(stubContext.octokit.graphql.mock.calls[1][1]).toEqual({ id: 'node-2' })
    })

    it('batches the isMinimized lookup into groups of 100 node IDs', async () => {
      const manyComments = Array.from({ length: 150 }, (_, index) => ({
        id: index + 1,
        node_id: `node-${index + 1}`,
        user: { id: 12345 },
        body: '#### :robot: Safe-Settings config changes detected:\nrepeat'
      }))
      stubContext.octokit.paginate.mockResolvedValue(manyComments)
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      const nodeQueryCalls = stubContext.octokit.graphql.mock.calls.filter(call => call[1].ids)
      expect(nodeQueryCalls).toHaveLength(2)
      expect(nodeQueryCalls[0][1].ids).toHaveLength(100)
      expect(nodeQueryCalls[1][1].ids).toHaveLength(50)
    })

    it('creates a comment without minimizing when no existing comment matches the heading', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', body: 'just a regular review comment' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('does not re-minimize the comment it just created', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 999, node_id: 'node-999', user: { id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nbrand new' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
    })

    it('does not minimize a comment created after its own, to avoid overlapping runs hiding each other', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1000, node_id: 'node-1000', user: { type: 'Bot', id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nnewer concurrent run' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
    })

    it('still creates the new comment when minimizing a previous one fails', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nold diff' }
      ])
      stubContext.octokit.graphql
        .mockResolvedValueOnce({ nodes: [{ id: 'node-1', isMinimized: false }] })
        .mockRejectedValueOnce(new Error('boom'))
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('still creates the new comment when listing previous comments fails', async () => {
      stubContext.octokit.paginate.mockRejectedValue(new Error('rate limited'))
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('does not minimize a human comment that merely quotes the heading', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { type: 'User' }, body: 'Quoting the bot: "#### :robot: Safe-Settings config changes detected:" is odd phrasing' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('does not minimize a different bot comment that merely quotes the heading', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { id: 99999 }, body: 'Some other bot noticed: "#### :robot: Safe-Settings config changes detected:" in passing' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('does not minimize a different bot comment that starts with the exact same heading', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { type: 'Bot', id: 99999 }, body: '#### :robot: Safe-Settings config changes detected:\nfrom some other app' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('does not attempt any reconciliation when the new comment has no user identity', async () => {
      stubContext.octokit.rest.issues.createComment.mockResolvedValue({ data: { id: 999 } })
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { type: 'Bot', id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nold diff' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('does not attempt to minimize a matching comment with no node_id', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, user: { id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nold diff' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
      expect(stubContext.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    })

    it('creates the new comment before minimizing the previous one, so a create failure never leaves the PR with no visible comment', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { id: 12345 }, body: '#### :robot: Safe-Settings config changes detected:\nold diff' }
      ])
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await settings.handleResults()

      const createOrder = stubContext.octokit.rest.issues.createComment.mock.invocationCallOrder[0]
      const minimizeOrder = stubContext.octokit.graphql.mock.invocationCallOrder[0]
      expect(createOrder).toBeLessThan(minimizeOrder)
    })

    it('does not attempt to minimize anything when creating the new comment fails', async () => {
      stubContext.octokit.paginate.mockResolvedValue([
        { id: 1, node_id: 'node-1', user: { type: 'Bot' }, body: '#### :robot: Safe-Settings config changes detected:\nold diff' }
      ])
      stubContext.octokit.rest.issues.createComment.mockRejectedValue(new Error('boom'))
      const settings = createSettingsWithDedupeEnabled({})
      settings.results = [changeResult('test-repo')]

      await expect(settings.handleResults()).rejects.toThrow('boom')

      expect(stubContext.octokit.paginate).not.toHaveBeenCalled()
      expect(stubContext.octokit.graphql).not.toHaveBeenCalled()
    })
  })
}) // Settings Tests
