const Labels = require('../../../../lib/plugins/labels')

describe('Labels', () => {
  let github
  let log

  function configure (config) {
    const nop = false
    return new Labels(nop, github, { owner: 'bkeepers', repo: 'test' }, config, log)
  }

  beforeEach(() => {
    github = {
      paginate: jest.fn().mockImplementation(() => Promise.resolve()),
      rest: {
        repos: {
          get: jest.fn().mockImplementation(() => Promise.resolve({}))
        },
        issues: {
          listLabelsForRepo: {
            endpoint: {
              merge: jest.fn().mockImplementation(() => {})
            }
          },
          createLabel: jest.fn().mockImplementation(() => Promise.resolve()),
          deleteLabel: jest.fn().mockImplementation(() => Promise.resolve()),
          updateLabel: jest.fn().mockImplementation(() => Promise.resolve())
        }
      }
    }
    log = { debug: jest.fn(), info: jest.fn(), error: console.error }
  })

  describe('sync', () => {
    it('syncs labels', () => {
      github.paginate.mockReturnValueOnce(Promise.resolve([
        { name: 'no-change', color: 'FF0000', description: '' },
        { name: 'new-color', color: 0, description: '' }, // YAML treats `color: 000000` as an integer
        { name: 'new-description', color: '000000', description: '' },
        { name: 'update-me', color: '0000FF', description: '' },
        { name: 'delete-me', color: '000000', description: '' }
      ]))

      const plugin = configure([
        { name: 'no-change', color: 'FF0000', description: '' },
        { name: 'new-name', oldname: 'update-me', color: 'FFFFFF', description: '' },
        { name: 'new-color', color: '999999', description: '' },
        { name: 'new-description', color: '#000000', description: 'Hello world' },
        { name: 'added', description: '' }
      ])

      return plugin.sync().then(() => {
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Applying Labels changes to bkeepers/test'))

        expect(github.rest.issues.deleteLabel).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          name: 'delete-me',
          headers: { accept: 'application/vnd.github.symmetra-preview+json' }
        })

        expect(github.rest.issues.createLabel).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          name: 'added',
          description: '',
          headers: { accept: 'application/vnd.github.symmetra-preview+json' }
        })

        expect(github.rest.issues.updateLabel).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          current_name: 'update-me',
          name: 'new-name',
          color: 'FFFFFF',
          description: '',
          headers: { accept: 'application/vnd.github.symmetra-preview+json' }
        })

        expect(github.rest.issues.updateLabel).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          current_name: 'new-color',
          name: 'new-color',
          color: '999999',
          description: '',
          headers: { accept: 'application/vnd.github.symmetra-preview+json' }
        })

        expect(github.rest.issues.updateLabel).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          current_name: 'new-description',
          name: 'new-description',
          color: '000000',
          description: 'Hello world',
          headers: { accept: 'application/vnd.github.symmetra-preview+json' }
        })

        expect(github.rest.issues.deleteLabel).toHaveBeenCalledTimes(1)
        expect(github.rest.issues.updateLabel).toHaveBeenCalledTimes(3)
        expect(github.rest.issues.createLabel).toHaveBeenCalledTimes(1)
      })
    })

    it('does not delete excluded labels', () => {
      github.paginate.mockReturnValueOnce(Promise.resolve([
        { name: 'no-change', color: 'FF0000', description: '' },
        { name: 'keep-me', color: '000000', description: '' },
        { name: 'things-to-keep', color: '000000', description: '' },
        { name: 'released on @7.x.x', color: '000000', description: '' },
        { name: 'update-me', color: '0000FF', description: '' },
        { name: 'delete-me', color: '000000', description: '' }
      ]))

      const plugin = configure({
        exclude: [
          { name: 'keep' },
          { name: '^released' }
        ],
        include: [
          { name: 'no-change', color: 'FF0000', description: '' },
          { name: 'new-name', oldname: 'update-me', color: 'FFFFFF', description: '' },
          { name: 'added', description: '' }
        ]
      })

      return plugin.sync().then(() => {
        expect(github.rest.issues.deleteLabel).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          name: 'delete-me',
          headers: { accept: 'application/vnd.github.symmetra-preview+json' }
        })

        expect(github.rest.issues.updateLabel).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          current_name: 'update-me',
          name: 'new-name',
          color: 'FFFFFF',
          description: '',
          headers: { accept: 'application/vnd.github.symmetra-preview+json' }
        })

        expect(github.rest.issues.deleteLabel).toHaveBeenCalledTimes(1)
        expect(github.rest.issues.updateLabel).toHaveBeenCalledTimes(1)
        expect(github.rest.issues.createLabel).toHaveBeenCalledTimes(1)
      })
    })

    it('pads colors that YAML read as numbers', () => {
      github.paginate.mockReturnValueOnce(Promise.resolve([]))

      const plugin = configure([
        { name: 'black', color: 0, description: '' }, // YAML treats `color: 000000` as 0
        { name: 'almost-black', color: 1, description: '' } // YAML treats `color: 000001` as 1
      ])

      return plugin.sync().then(() => {
        const createdColors = github.rest.issues.createLabel.mock.calls.map(([params]) => params.color)
        expect(createdColors).toEqual(['000000', '000001'])
      })
    })

    describe('invalid colors', () => {
      // YAML treats `color: 5319e7` as 5319 × 10^7
      const config = [{ name: 'hello-world', color: 5319e7, description: '' }]
      const expectedMessage = "Label 'hello-world' has invalid color '53190000000'. Colors must be 6 hex characters, e.g. '5319e7'. Quote the value in YAML so it isn't read as a number."

      it('reports an error instead of creating the label', () => {
        github.paginate.mockReturnValueOnce(Promise.resolve([]))
        log.error = jest.fn()
        const errors = []
        const plugin = new Labels(false, github, { owner: 'bkeepers', repo: 'test' }, config, log, errors)

        return plugin.sync().then(() => {
          expect(github.rest.issues.createLabel).not.toHaveBeenCalled()
          expect(errors).toEqual([expect.objectContaining({ msg: expectedMessage, plugin: 'Labels' })])
        })
      })

      it('reports an error instead of updating the label', () => {
        github.paginate.mockReturnValueOnce(Promise.resolve([{ name: 'hello-world', color: '5319e7', description: '' }]))
        log.error = jest.fn()
        const errors = []
        const plugin = new Labels(false, github, { owner: 'bkeepers', repo: 'test' }, config, log, errors)

        return plugin.sync().then(() => {
          expect(github.rest.issues.updateLabel).not.toHaveBeenCalled()
          expect(errors).toEqual([expect.objectContaining({ msg: expectedMessage })])
        })
      })

      it('shows the error in the dry-run', () => {
        github.paginate.mockReturnValueOnce(Promise.resolve([]))
        const plugin = new Labels(true, github, { owner: 'bkeepers', repo: 'test' }, config, log, [])

        return plugin.sync().then(results => {
          expect(results.flat()).toContainEqual(expect.objectContaining({ type: 'ERROR', action: expect.objectContaining({ msg: expectedMessage }) }))
        })
      })

      it('reports a quoted non-hex color as written, without padding it', () => {
        github.paginate.mockReturnValueOnce(Promise.resolve([]))
        log.error = jest.fn()
        const errors = []
        const plugin = new Labels(false, github, { owner: 'bkeepers', repo: 'test' }, [{ name: 'hello-world', color: 'red', description: '' }], log, errors)

        return plugin.sync().then(() => {
          expect(github.rest.issues.createLabel).not.toHaveBeenCalled()
          expect(errors).toEqual([expect.objectContaining({ msg: expect.stringContaining("invalid color 'red'. Colors must be 6 hex characters") })])
        })
      })
    })
  })
})
