/* eslint-disable no-undef */
// Fail tests that produce unexpected console.error output.
// This ensures that caught-but-logged errors in production code don't
// silently slip through the test suite (e.g. TypeError inside a catch block
// that logs via this.log.error = console.error).
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    throw new Error(`Unexpected console.error call in test: ${args.join(' ')}`)
  })
})

afterEach(() => {
  jest.restoreAllMocks()
})
