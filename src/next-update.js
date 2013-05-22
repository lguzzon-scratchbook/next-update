var path = require('path');
var _ = require('lodash');
var async = require('async');

var allVersions = require('./npm').allVersions;

function nextUpdate() {
    var workingDirectory = process.cwd();
    console.log('working directory', workingDirectory);

    var workingPackage = require(path.join(workingDirectory, 'package.json'));
    var dependencies = workingPackage.dependencies || {};
    var devDependencies = workingPackage.devDependencies || {};
    _.extend(dependencies, devDependencies);

    var nameVersionPairs = _.pairs(dependencies);
    console.log('all dependencies\n', nameVersionPairs);

    console.log('fetching dependencies details');
    async.map(nameVersionPairs, allVersions, function (err, results) {
        if (err) {
            console.error('ERROR fetching versions ' + err);
            throw err;
        }
        console.log(results);
        console.log('all done');
    });
}

module.exports = nextUpdate;