const CustomProperties = require('../../../../lib/plugins/custom_properties')

describe('CustomProperties', () => {
  const nop = false
  let github
  let log

  const owner = 'test-owner'
  const repo = 'test-repo'

  function configure (config) {
    return new CustomProperties(nop, github, { owner, repo }, config, log, [])
  }

  beforeEach(() => {
    github = {
      paginate: jest.fn(),
      request: jest.fn()
    }

    github.request.endpoint = jest.fn((route, params) => ({
      url: `/repos/${params.owner}/${params.repo}/properties/values`,
      body: { properties: params.properties }
    }))
    log = { debug: jest.fn(), info: jest.fn(), error: jest.fn() }
  })

  describe('Custom Properties plugin', () => {
    it('should normalize entries when instantiated', () => {
      const plugin = configure([{ name: 'Test', value: 'test' }])
      expect(plugin.entries).toEqual([{ name: 'test', value: 'test' }])
    })

    it('should normalize entries with property_name when instantiated', () => {
      const plugin = configure([{ property_name: 'ent-ownership', value: 'expert-services' }])
      expect(plugin.entries).toEqual([{ name: 'ent-ownership', value: 'expert-services' }])
    })

    it('should fetch and normalize custom properties successfully', async () => {
      const mockResponse = [
        { property_name: 'Test1', value: 'value1' },
        { property_name: 'Test2', value: 'value2' }
      ]

      github.paginate.mockResolvedValue(mockResponse)

      const plugin = configure()
      const result = await plugin.find()

      expect(github.paginate).toHaveBeenCalledWith(
        'GET /repos/{owner}/{repo}/properties/values',
        {
          owner,
          repo,
          per_page: 100
        }
      )

      expect(result).toEqual([
        { name: 'test1', value: 'value1' },
        { name: 'test2', value: 'value2' }
      ])
    })

    it('should normalize paginated custom properties when property name shape differs', async () => {
      const mockResponse = [
        { name: 'Owner', value: 'My Team' },
        { property_name: 'Criticality', value: 'High' },
        { value: 'ignored' }
      ]

      github.paginate.mockResolvedValue(mockResponse)

      const plugin = configure()
      const result = await plugin.find()

      expect(result).toEqual([
        { name: 'owner', value: 'My Team' },
        { name: 'criticality', value: 'High' }
      ])
    })

    it('should sync', async () => {
      const mockResponse = [
        { property_name: 'no-change', value: 'no-change' },
        { property_name: 'new-value', value: '' },
        { property_name: 'update-value', value: 'update-value' },
        { property_name: 'delete-value', value: 'update-value' }
      ]

      github.paginate.mockResolvedValue(mockResponse)

      const plugin = configure([
        { name: 'no-change', value: 'no-change' },
        { name: 'new-value', value: 'new-value' },
        { name: 'update-value', value: 'new-value' },
        { name: 'delete-value', value: null }
      ])

      return plugin.sync().then(() => {
        expect(github.paginate).toHaveBeenCalledWith(
          'GET /repos/{owner}/{repo}/properties/values',
          {
            owner,
            repo,
            per_page: 100
          }
        )
        expect(github.request).not.toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/properties/values', {
          owner,
          repo,
          properties: [
            {
              property_name: 'no-change',
              value: 'no-change'
            }
          ]
        })
        expect(github.request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/properties/values', {
          owner,
          repo,
          properties: [
            {
              property_name: 'new-value',
              value: 'new-value'
            }
          ]
        })
        expect(github.request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/properties/values', {
          owner,
          repo,
          properties: [
            {
              property_name: 'update-value',
              value: 'new-value'
            }
          ]
        })
        expect(github.request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/properties/values', {
          owner,
          repo,
          properties: [
            {
              property_name: 'delete-value',
              value: null
            }
          ]
        })
      })
    })
  })

  describe('include/exclude ownership', () => {
    const record = (name, value = 'old') => ({ property_name: name, value })
    const writes = () => github.request.mock.calls.map(([route, params]) => {
      expect(route).toBe('PATCH /repos/{owner}/{repo}/properties/values')
      expect(params).toMatchObject({ owner, repo })
      return params.properties[0]
    })

    it('creates, updates and clears only managed properties; include wins', async () => {
      github.paginate.mockResolvedValue([
        record('external-owner'), record('external-managed'), record('obsolete'), record('unchanged', 'same')
      ])
      const plugin = configure({
        include: [
          { name: 'created', value: 'new' },
          { name: 'EXTERNAL-MANAGED', value: 'new' },
          { name: 'unchanged', value: 'same' }
        ],
        exclude: [{ name: '^EXTERNAL-' }]
      })
      await plugin.sync()
      expect(writes()).toEqual(expect.arrayContaining([
        record('created', 'new'), record('external-managed', 'new'), record('obsolete', null)
      ]))
      expect(writes()).toHaveLength(3)
      expect(plugin.errors).toEqual([])
    })

    it('exclude-only preserves matches and clears unmatched properties', async () => {
      github.paginate.mockResolvedValue([record('external-owner'), record('obsolete')])
      await configure({ exclude: [{ name: '^external-' }] }).sync()
      expect(writes()).toEqual([record('obsolete', null)])
    })

    it('an empty exclusion list clears all undeclared values', async () => {
      github.paginate.mockResolvedValue([record('obsolete')])
      await configure({ exclude: [] }).sync()
      expect(writes()).toEqual([record('obsolete', null)])
    })

    it('explicit included null wins over exclusion and clears the value', async () => {
      github.paginate.mockResolvedValue([record('external-owner')])
      await configure({
        include: [{ name: 'external-owner', value: null }],
        exclude: [{ name: '.*' }]
      }).sync()
      expect(writes()).toEqual([record('external-owner', null)])
    })

    it('keeps regex escape/class semantics while matching names case-insensitively', async () => {
      github.paginate.mockResolvedValue([record('OWNER-ABC'), record('OWNER-123'), record('UPPER')])
      await configure({ exclude: [{ name: '^OWNER-\\D+$' }, { name: '^[A-Z]+$' }] }).sync()
      expect(writes()).toEqual([record('owner-123', null)])
    })

    it('supports aliases and complete multi-value writes', async () => {
      github.paginate.mockResolvedValue([record('services', ['old']), { name: 'OWNER', value: 'old' }])
      await configure({
        include: [{ property_name: 'SERVICES', value: ['api', 'worker'] }, { name: 'owner', value: 'new' }]
      }).sync()
      expect(writes()).toEqual(expect.arrayContaining([record('services', ['api', 'worker']), record('owner', 'new')]))
      expect(writes()).toHaveLength(2)
    })

    it.each([null, undefined])('keeps %s configuration a no-op', async config => {
      const plugin = configure(config)
      await plugin.sync()
      expect(github.paginate).not.toHaveBeenCalled()
      expect(github.request).not.toHaveBeenCalled()
    })

    it('retains legacy plain-array clearing behavior', async () => {
      github.paginate.mockResolvedValue([record('unmanaged'), record('managed')])
      await configure([{ property_name: 'MANAGED', value: 'new' }]).sync()
      expect(writes()).toEqual(expect.arrayContaining([record('unmanaged', null), record('managed', 'new')]))
      expect(writes()).toHaveLength(2)
    })

    it('does not report protected-only differences as changes', async () => {
      github.paginate.mockResolvedValue([record('external-owner')])
      const plugin = new CustomProperties(true, github, { owner, repo }, { exclude: [{ name: '.*' }] }, log, [])
      expect(await plugin.sync()).toBeUndefined()
      expect(plugin.hasChanges).toBe(false)
      expect(github.request.endpoint).not.toHaveBeenCalled()
      expect(github.request).not.toHaveBeenCalled()
    })

    it('omits protected properties from NOP summaries and PATCH commands', async () => {
      github.paginate.mockResolvedValue([record('external-owner'), record('obsolete')])
      const plugin = new CustomProperties(true, github, { owner, repo }, {
        exclude: [{ name: '^external-' }]
      }, log, [])
      const commands = await plugin.sync()
      expect(commands[0].action.deletions).toEqual([{ name: 'obsolete', value: 'old' }])
      expect(JSON.stringify(commands)).not.toContain('external-owner')
      expect(commands.filter(command => command.endpoint).map(command => command.body)).toEqual([
        { properties: [record('obsolete', null)] }
      ])
      expect(github.request).not.toHaveBeenCalled()
    })

    it('additive mode still applies includes without clearing unmatched values', async () => {
      github.paginate.mockResolvedValue([record('external-owner'), record('obsolete'), record('managed')])
      const plugin = configure({
        include: [{ name: 'managed', value: 'new' }],
        exclude: [{ name: '^external-' }]
      })
      plugin.additive = true
      await plugin.sync()
      expect(writes()).toEqual([record('managed', 'new')])
    })

    it.each([
      {}, false, 12, 'invalid', { unknown: [] }, { include: null }, { exclude: null },
      { include: 'invalid', exclude: [] }, { include: [], exclude: '*' },
      { include: [], exclude: [null] }, { exclude: [{}] }, { exclude: [{ name: 3 }] },
      { exclude: [{ name: '*' }] }, { exclude: [{ name: '[' }] }, { exclude: [{ name: '' }] },
      { exclude: [{ name: '.*', typo: true }] }, { include: [null] }, { include: ['bad'] },
      { include: [{ value: 'missing name' }] }, { include: [{ name: 'missing-value' }] },
      { include: [{ name: 'bad', value: [1] }] }, { include: [{ name: 'bad', value: {} }] }
    ].map(config => [config]))('fails closed without throwing for malformed config %j', async config => {
      github.paginate.mockResolvedValue([record('external-owner'), record('obsolete')])
      const plugin = configure(config)
      await plugin.sync()
      expect(plugin.errors.length).toBeGreaterThan(0)
      expect(plugin.errors[0]).toMatchObject({ owner, repo, plugin: 'CustomProperties' })
      expect(log.error).toHaveBeenCalled()
      expect(plugin.hasChanges).toBe(false)
      expect(github.request).not.toHaveBeenCalled()
    })

    it.each([false, true])('applies safe included values, never null clears, after config errors (nop=%s)', async nop => {
      github.paginate.mockResolvedValue([record('owner'), record('explicit-clear'), record('obsolete')])
      const plugin = new CustomProperties(nop, github, { owner, repo }, {
        include: [{ name: 'owner', value: 'new' }, { name: 'explicit-clear', value: null }, { name: 'bad' }],
        exclude: [{ name: '*' }]
      }, log, [])
      const commands = await plugin.sync()
      expect(plugin.errors).toHaveLength(2)
      if (nop) {
        expect(JSON.stringify(commands)).not.toContain('explicit-clear')
        expect(JSON.stringify(commands)).not.toContain('obsolete')
        expect(commands.filter(command => command.endpoint).map(command => command.body)).toEqual([
          { properties: [record('owner', 'new')] }
        ])
      } else {
        expect(writes()).toEqual([record('owner', 'new')])
      }
    })
  })
})
