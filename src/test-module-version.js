var la = require('lazy-ass')
var check = require('check-more-types')
var verify = check.verify
var q = require('q')
var _ = require('lodash')
var semver = require('semver')
var quote = require('quote')
var installModule = require('./module-install')
var reportSuccess = require('./report').reportSuccess
var reportFailure = require('./report').reportFailure
const {getTestCommand} = require('./utils')
const path = require('path')
const debug = require('debug')('next-update')
var stats = require('./stats')

var cleanVersions = require('./registry').cleanVersions
check.verify.fn(cleanVersions, 'cleanVersions should be a function')

var revertModules = require('./revert')
check.verify.fn(revertModules, 'revert is not a function, but ' +
    JSON.stringify(revertModules))

var npmTest = require('./npm-test').test
var execTest = require('./exec-test')
var report = require('./report-available')
var filterAllowed = require('./filter-allowed-updates')

// expect array of objects, each {name, versions (Array) }
// returns promise
function testModulesVersions (options, available) {
  verify.object(options, 'missing options')
  verify.array(available, 'expected array of available modules')

  var cleaned = cleanVersions(options.modules)
    // console.log('cleaned', cleaned);
    // var listed = _.zipObject(cleaned);
  var names = _.pluck(cleaned, 'name')
  var listed = _.zipObject(names, cleaned)

    /*
    console.log('testing module versions');
    console.log('current versions', listed);
    console.log('options', options);
    console.log('available', available);
    */

  var allowed = filterAllowed(listed, available, options)
  la(check.array(allowed), 'could not filter allowed updates', listed, available, options)

  if (available.length && !allowed.length) {
    console.log('No updates allowed using option', quote(options.allow || options.allowed))
    console.log(available.length + ' available updates filtered')
    return q(listed)
  }

    // console.log('allowed', allowed);
  return q.when(report(allowed, listed, options))
        .then(function testInstalls () {
            // console.log('testing installs');
          if (options.all) {
            var install = installAll(allowed, options)
            console.assert(install, 'could not get install all promise')
            var test = testPromise(options, options.command)
            console.assert(test, 'could not get test promise for command', options.command)
                // console.dir(listed);
                // console.dir(options.modules);

            var installThenTest = install.then(test)
            if (options.keep) {
              return installThenTest
            }

            var revert = revertModules.bind(null, listed)
            console.assert(revert, 'could not get revert promise')
            return installThenTest.then(revert)
          }

          return installEachTestRevert(listed, allowed,
                options.command, options.color, options.keep, options.tldr)
        })
}

// returns promise, does not revert
function installAll (available, options) {
  verify.array(available, 'expected array')

  var installFunctions = available.map(function (nameVersions) {
    var name = nameVersions.name
    var version = nameVersions.versions[0]
    verify.string(name, 'missing module name from ' +
            JSON.stringify(nameVersions))
    verify.string(version, 'missing module version from ' +
            JSON.stringify(nameVersions))

    var installOptions = {
      name: name,
      version: version,
      keep: options.keep,
      tldr: options.tldr
    }
    var installFunction = installModule.bind(null, installOptions)
    return installFunction
  })
  var installAllPromise = installFunctions.reduce(q.when, q())
  return installAllPromise
}

function installEachTestRevert (listed, available, command, color, keep, tldr) {
  verify.object(listed, 'expected listed object')
  verify.array(available, 'expected array')

  const packageFilename = path.resolve('./package.json')
  const getCommand = _.partial(getTestCommand, packageFilename)

  var checkModulesFunctions = available.map(function (nameVersion) {
    var name = nameVersion.name
    la(check.unemptyString(name), 'missing name', nameVersion)
    var currentVersion = listed[name].version
    la(check.string(currentVersion), 'cannot find current version for', name,
            'among current dependencies', listed)

    var installOptions = {
      name: name,
      version: currentVersion,
      keep: keep,
      tldr: tldr
    }
    var revertFunction = installModule.bind(null, installOptions)

    const testCommand = getCommand(name) || command
    debug('module %s should use test command "%s"', name, testCommand)
    var checkModuleFunction = testModuleVersions.bind(null, {
      moduleVersions: nameVersion,
      revertFunction: revertFunction,
      command: testCommand,
      color: color,
      currentVersion: currentVersion,
      keep: keep,
      tldr: tldr
    })
    return checkModuleFunction
  })
  var checkAllPromise = checkModulesFunctions.reduce(q.when, q())
  return checkAllPromise
}

// test particular dependency with multiple versions
// returns promise
function testModuleVersions (options, results) {
  verify.object(options, 'missing options')
  var nameVersions = options.moduleVersions
  var restoreVersionFunc = options.revertFunction

  var name = nameVersions.name
  var versions = nameVersions.versions
  verify.string(name, 'expected name string')
  verify.array(versions, 'expected versions array')
  results = results || []
  verify.array(results, 'expected results array')
  if (!semver.valid(options.currentVersion)) {
    throw new Error('do not have current version for ' + name)
  }

  var deferred = q.defer()
  var checkPromises = versions.map(function (version) {
    return testModuleVersion.bind(null, {
      name: name,
      version: version,
      command: options.command,
      color: options.color,
      currentVersion: options.currentVersion,
      tldr: options.tldr
    })
  })
  var checkAllPromise = checkPromises.reduce(q.when, q())
  if (options.keep) {
    debug('keep working updates for %s', name)
    checkAllPromise = checkAllPromise.then(function (result) {
      verify.array(result, 'expected array of results', result)
      var lastSuccess = _.last(_.filter(result, { works: true }))
      if (lastSuccess) {
        console.log('keeping last working version', lastSuccess.name + '@' + lastSuccess.version)
        return installModule({
          name: lastSuccess.name,
          version: lastSuccess.version,
          keep: true,
          tldr: options.tldr
        }, result)
      } else {
        return restoreVersionFunc().then(function () {
                    // console.log('returning result after reverting', result);
          return q(result)
        })
      }
    })
  } else {
    checkAllPromise = checkAllPromise
            .then(restoreVersionFunc, (err) => {
              console.error('Could not check all versions')
              console.error(err)
              throw err
            })
  }
  checkAllPromise
        .then(function (result) {
          debug('got result')
          debug(result)
          check.verify.array(result, 'could not get result array')
          results.push(result)
          deferred.resolve(results)
        }, function (error) {
          console.error('could not check', nameVersions, error)
          deferred.reject(error)
        })

  return deferred.promise
}

var logLine = (function formLine () {
  var n = process.stdout.isTTY ? process.stdout.columns : 40
  n = n || 40
  verify.positiveNumber(n, 'expected to get terminal width, got ' + n)
  var k
  var str = ''
  for (k = 0; k < n; k += 1) {
    str += '-'
  }
  return function () {
    console.log(str)
  }
}())

// checks specific module@version
// returns promise
function testModuleVersion (options, results) {
  verify.object(options, 'missing test module options')
  verify.string(options.name, 'missing module name')
  verify.string(options.version, 'missing version string')
  verify.unemptyString(options.currentVersion, 'missing current version')

  if (options.command) {
    verify.string(options.command, 'expected command string')
  }
    // console.log('options', options);

  results = results || []
  verify.array(results, 'missing previous results array')

  var nameVersion = options.name + '@' + options.version

  if (!options.tldr) {
    console.log('\ntesting', nameVersion)
  }

  var result = {
    name: options.name,
    version: options.version,
    from: options.currentVersion,
    works: true
  }

  var test = testPromise(options, options.command)
  console.assert(test, 'could not get test promise for command', options.command)

  var deferred = q.defer()

  var getSuccess = stats.getSuccessStats({
    name: options.name,
    from: options.currentVersion,
    to: options.version
  })

  getSuccess
        .then(stats.printStats.bind(null, options), function () {
          console.log('could not get update stats', options.name)
        })
        .then(function () {
          return installModule({
            name: options.name,
            version: options.version,
            keep: false,
            tldr: options.tldr
          })
        })
        .then(test)
        .then(function () {
          reportSuccess(nameVersion + ' works', options.color)

          stats.sendUpdateResult({
            name: options.name,
            from: options.currentVersion,
            to: options.version,
            success: true
          })
          results.push(result)
          deferred.resolve(results)
        }, function (error) {
          reportFailure(nameVersion + ' tests failed :(', options.color)

          debug('sending stats results')
          stats.sendUpdateResult({
            name: options.name,
            from: options.currentVersion,
            to: options.version,
            success: false
          })

          debug('checking error code', error.code)
          verify.number(error.code, 'expected code in error ' +
                JSON.stringify(error, null, 2))

          var horizontalLine = options.tldr ? _.noop : logLine

          horizontalLine()
          if (!options.tldr) {
            console.error('test finished with exit code', error.code)
            verify.string(error.errors, 'expected errors string in error ' +
                    JSON.stringify(error, null, 2))
            console.error(error.errors)
          }

          horizontalLine()

          result.works = false
          results.push(result)
          deferred.resolve(results)
        })
  return deferred.promise
}

function testPromise (options, command) {
  var testFunction = npmTest.bind(null, options)
  if (command) {
    verify.unemptyString(command, 'expected string command, not ' + command)
    testFunction = execTest.bind(null, options, command)
  } else {
    debug('missing test command')
  }
  return testFunction
}

module.exports = {
  testModulesVersions: testModulesVersions,
  testModuleVersion: testModuleVersion,
  testPromise: testPromise
}
