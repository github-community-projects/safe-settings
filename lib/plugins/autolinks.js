/* eslint-disable camelcase */
const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')

module.exports = class Autolinks extends Diffable {
  // constructor (...args) {
  //   super(...args)
  // }

  async find () {
    const { data } = await this.github.rest.repos.listAutolinks(this.repo)
    return data
  }

  comparator (existing, attr) {
    return existing.key_prefix === attr.key_prefix
  }

  changed (existing, attr) {
    // is_alphanumeric was added mid-2023. In order to continue to support settings yamls which dont specify this
    // attribute, consider an unset is_alphanumeric as `true` (since that is the default value in the API)
    // https://docs.github.com/en/rest/repos/autolinks?apiVersion=2026-03-10#create-an-autolink-reference-for-a-repository
    const isAlphaNumericMatch = attr.is_alphanumeric === undefined
      ? existing.is_alphanumeric // === true, the default
      : attr.is_alphanumeric === existing.is_alphanumeric
    return existing.url_template !== attr.url_template || !isAlphaNumericMatch
  }

  async update (existing, attr) {
    await this.remove(existing)
    return this.add(attr)
  }

  async add ({ key_prefix, url_template, is_alphanumeric = true }) {
    const attrs = {
      ...this.repo,
      key_prefix,
      url_template,
      is_alphanumeric
    }

    if (this.nop) {
      return new NopCommand(
        this.constructor.name,
        this.repo,
        this.github.rest.repos.createAutolink.endpoint(attrs),
        'Add autolink'
      )
    }

    try {
      return this.github.rest.repos.createAutolink(attrs)
    } catch (e) {
      if (e?.response?.data?.errors?.[0]?.code === 'already_exists') {
        this.log.debug(`Did not update ${key_prefix}, as it already exists`)
        return
      }
      throw e
    }
  }

  async remove ({ id }) {
    const attrs = {
      ...this.repo,
      autolink_id: id
    }
    if (this.nop) {
      return new NopCommand(
        this.constructor.name,
        this.repo,
        this.github.rest.repos.deleteAutolink.endpoint(attrs),
        'Remove autolink'
      )
    }
    return this.github.rest.repos.deleteAutolink(attrs)
  }
}
