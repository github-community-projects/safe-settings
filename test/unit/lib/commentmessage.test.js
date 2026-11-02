const { Eta } = require('eta')
const template = require('../../../lib/commentmessage')

describe('commentmessage', () => {
  const eta = new Eta({ views: 'lib' })

  it('separates the changes details block from the errors heading with a blank line', async () => {
    const out = await eta.renderString(template, {
      reposProcessed: { a: 1 },
      reposAffected: 1,
      checkRunDetails: '<details>changes</details>',
      errors: {},
      infos: {}
    })
    expect(out).toContain('</details>\n\n### Breakdown of errors')
  })
})
