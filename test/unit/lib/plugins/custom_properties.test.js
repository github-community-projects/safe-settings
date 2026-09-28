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

    log = { debug: jest.fn(), info: jest.fn(), error: console.error }
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

      // const plugin = configure([{ name: 'Test', value: 'test' }])
      // await plugin.update({ name: 'test', value: 'old' }, { name: 'test', value: 'test' })

      // expect(github.request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/properties/values', {
      //   owner,
      //   repo,
      //   properties: [
      //     {
      //       property_name: 'test',
      //       value: 'test'
      //     }
      //   ]
      // })
    })
  })
})
