const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')

module.exports = class Variables extends Diffable {
  constructor (...args) {
    super(...args)

    if (this.entries) {
      this.entries.forEach((variable) => {
        variable.name = variable.name.toUpperCase()
      })
    }
  }

  /**
   * Look up existing variables for a given repository.
   * Strips API-only metadata fields (created_at, updated_at) so that
   * changed() can do a clean value comparison.
   *
   * @see {@link https://docs.github.com/en/rest/actions/variables?apiVersion=2022-11-28#list-repository-variables}
   * @returns {Promise<Array.<{name: string, value: string}>>}
   */
  find () {
    this.log.debug(`Finding repo vars for ${this.repo.owner}/${this.repo.repo}`)
    return this.github.request('GET /repos/:org/:repo/actions/variables', {
      org: this.repo.owner,
      repo: this.repo.repo
    }).then(({ data: { variables } }) => variables.map(({ name, value }) => ({ name, value })))
  }

  /**
   * Identify which existing variable matches the desired attrs by name.
   *
   * @param {object} existing An existing variable from the API
   * @param {object} attrs    A variable defined as code
   * @returns {boolean}
   */
  comparator (existing, attrs) {
    return existing.name === attrs.name
  }

  /**
   * Return true if the existing variable's value differs from the desired value.
   *
   * @param {object} existing The existing variable from the API
   * @param {object} attrs    The variable defined as code
   * @returns {boolean}
   */
  changed (existing, attrs) {
    return existing.value !== attrs.value
  }

  /**
   * Update an existing variable with a new value.
   *
   * @param {object} existing The existing variable from the API
   * @param {object} attrs    The desired variable state defined as code
   *
   * @see {@link https://docs.github.com/en/rest/actions/variables?apiVersion=2022-11-28#update-a-repository-variable}
   * @returns {Promise}
   */
  update (existing, attrs) {
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, null, `Update variable ${attrs.name}`)
      ])
    }
    return this.github.request('PATCH /repos/:org/:repo/actions/variables/:variable_name', {
      org: this.repo.owner,
      repo: this.repo.repo,
      variable_name: attrs.name.toUpperCase(),
      value: attrs.value.toString()
    })
  }

  /**
   * Add a new variable to the repository.
   *
   * @param {object} attrs The variable to add, with name and value
   *
   * @see {@link https://docs.github.com/en/rest/actions/variables?apiVersion=2022-11-28#create-a-repository-variable}
   * @returns {Promise}
   */
  add (attrs) {
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, null, `Add variable ${attrs.name}`)
      ])
    }
    return this.github.request('POST /repos/:org/:repo/actions/variables', {
      org: this.repo.owner,
      repo: this.repo.repo,
      name: attrs.name.toUpperCase(),
      value: attrs.value.toString()
    })
  }

  /**
   * Remove a variable that is no longer defined as code.
   *
   * @param {object} existing The existing variable to remove
   *
   * @see {@link https://docs.github.com/en/rest/actions/variables?apiVersion=2022-11-28#delete-a-repository-variable}
   * @returns {Promise}
   */
  remove (existing) {
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, null, `Remove variable ${existing.name}`)
      ])
    }
    return this.github.request('DELETE /repos/:org/:repo/actions/variables/:variable_name', {
      org: this.repo.owner,
      repo: this.repo.repo,
      variable_name: existing.name.toUpperCase()
    })
  }
}
