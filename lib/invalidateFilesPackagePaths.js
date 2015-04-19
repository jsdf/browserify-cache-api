var fs = require('fs');
var path = require('path');
var assert = require('assert');
var async = require('async');

var assertExists = require('./assertExists');

// this is a big complex blob of code to deal with the small edge case where
// the package associated with a file changes (due to the addition or deletion
// of a package.json file) and the previous file => package association has 
// been cached, and thus needs to be invalidated
function invalidateFilesPackagePaths(filesPackagePaths, done) {
  assertExists(filesPackagePaths);
  var packagePathsFiles = invertFilesPackagePaths(filesPackagePaths);
  var foundPackageDirs = {};

  // invalidate files contained by intermediate dir from filesPackagePaths
  // and also remove from filesToCheck mutatively
  function invalidateFilesForInterstitialDir(filesToCheck, interstitialDir) {
    for (var i = filesToCheck.length-1; i >= 0; i--) {
      var filepath = filesToCheck[i];
      if (filepath.indexOf(interstitialDir) === 0) {
        delete filesPackagePaths[filepath]
        filesToCheck.splice(i, 1);
      }
    }
  }

  var packagePathsToCheck = Object.keys(packagePathsFiles).filter(function(pkgdir) {
    // anything in a node_modules dir isn't likely to have it's parent package change
    return pkgdir.indexOf('node_modules') == -1;
  });

  async.each(packagePathsToCheck, function(pkgdir, pkgdirDone) {
    fs.exists(packageFileForPackagePath(pkgdir), function(exists) {
      if (!exists) {
        // invalidate file in filesPackagePaths but don't bother figuring out new package path
        Object.keys(packagePathsFiles[pkgdir]).forEach(function(filepath) { delete filesPackagePaths[filepath]; });
        return pkgdirDone();
      }

      // could still be a new package in an interstitial dir between current package path and file
      foundPackageDirs[pkgdir] = true;
      var filesToCheck = Object.keys(packagePathsFiles[pkgdir]);
      var interstitialDirs = getInterstitialDirs(pkgdir, filesToCheck);

      async.each(interstitialDirs, function(interstitialDir, interstitialDirDone) {
        // return fast unless any left to invalidate which are contained by this intermediate dir
        if (!(
          filesToCheck.length 
          && filesToCheck.some(function(filepath){ return filepath.indexOf(interstitialDir) === 0; })
        )) return interstitialDirDone();

        // invalidate and return fast if this dir is known to now be a package path
        if (foundPackageDirs[interstitialDir]) {
          invalidateFilesForInterstitialDir(filesToCheck, interstitialDir);
          return interstitialDirDone();
        }

        fs.exists(packageFileForPackagePath(interstitialDir), function(exists) {
          if (exists) {
            foundPackageDirs[interstitialDir] = true;
            invalidateFilesForInterstitialDir(filesToCheck, interstitialDir);
          }
          interstitialDirDone();
        });
      }, pkgdirDone);
    });
  }, function(err) { done(null); }); // don't really care about errors
}

// get all directories between a common base and a list of files
function getInterstitialDirs(base, files) {
  return Object.keys(files.reduce(function(interstitialDirs, filepath) {
    var interstitialDir = filepath;
    while (
      (interstitialDir = path.dirname(interstitialDir))
      && interstitialDir !== base
      && !interstitialDirs[interstitialDir]
    ) {
      interstitialDirs[interstitialDir] = true;
    }
    return interstitialDirs;
  }, {}));
}

function invertFilesPackagePaths(filesPackagePaths) {
  var index = -1,
      props = Object.keys(filesPackagePaths),
      length = props.length,
      result = {};

  while (++index < length) {
    var key = props[index];
    var filepath = filesPackagePaths[key];
    result[filepath] = result[filepath] || {};
    result[filepath][key] = true;
  }
  return result;
}

module.exports = invalidateFilesPackagePaths;
