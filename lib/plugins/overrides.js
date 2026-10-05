const ErrorStash = require('./errorStash')

module.exports = class Overrides extends ErrorStash {
  // Find all object references for a given key from the source.
  static getObjectRef (source, dataKey) {
    const results = []
    const traverse = (obj) => {
      for (const key in obj) {
        if (key === dataKey) {
          results.push(obj)
        } else if (Array.isArray(obj[key])) {
          obj[key].forEach(element => traverse(element))
        } else if (typeof obj[key] === 'object' && obj[key]) {
          traverse(obj[key])
        }
      }
    }
    traverse(source)
    return results
  }

  // Find the parent object reference for a given child object and
  // allow the option to remove the parent object from the source.
  static getParentObjectRef (source, child, remove = false) {
    let parent = null
    const traverse = (obj, parentObj = null, parentKey = '') => {
      for (const key in obj) {
        if (obj[key] === child) {
          parent = obj
          if (remove && parentObj && parentKey) {
            delete parentObj[parentKey]
          }
        } else if (Array.isArray(obj[key])) {
          obj[key].forEach((element, index) => {
            if (element === child) {
              parent = obj[key]
              if (remove) {
                obj[key].splice(index, 1)
              }
              return
            }
            traverse(element)
          })
        } else if (typeof obj[key] === 'object' && obj[key]) {
          traverse(obj[key], obj, key)
        }
      }
    }
    traverse(source)
    return parent
  }

  // Traverse the source and remove the top level parent object
  static removeTopLevelParent (source, child, levels) {
    let parent = child
    for (let i = 0; i < levels; i++) {
      if (i + 1 === levels) {
        parent = Overrides.getParentObjectRef(source, parent, true)
      } else {
        parent = Overrides.getParentObjectRef(source, parent, false)
      }
    }
  }

  // When {{EXTERNALLY_DEFINED}} is found in the override value, retain the
  // existing value from GitHub. If GitHub does not have a value, then
  //   - A/ If the action is delete, then remove the top level parent object
  //        and the override value from the source.
  //   - B/ Otherwise, initialise the value to an appropriate value.
  // Note:
  //   - The admin settings could define multiple status check rules for a
  //     ruleset, but the GitHub API retains one only, i.e. the last one.
  //   - The PUT method for rulesets (update) allows for multiple overrides.
  //   - The POST method for rulesets (create) allows for one override only.
  static removeOverrides (overrides, source, existing) {
    Object.entries(overrides).forEach(([override, props]) => {
      const sourceRefs = Overrides.getObjectRef(source, override)
      const data = JSON.stringify(sourceRefs)

      if (data.includes('{{EXTERNALLY_DEFINED}}')) {
        const existingRefs = Overrides.getObjectRef(existing, override)
        sourceRefs.forEach(sourceRef => {
          if (existingRefs[0]) {
            sourceRef[override] = existingRefs[0][override]
          } else if (props.action === 'delete') {
            Overrides.removeTopLevelParent(source, sourceRef[override], props.parents)
            delete sourceRef[override]
          } else if (props.type === 'array') {
            sourceRef[override] = []
          } else if (props.type === 'dict') {
            sourceRef[override] = {}
          } else {
            throw new Error(`Unknown type ${props.type} for ${override}`)
          }
        })
      }
    })
    return source
  }
}
