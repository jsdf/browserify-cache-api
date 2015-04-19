var assertExists = require('./assertExists');
var invalidateModifiedFiles = require('./invalidateModifiedFiles');

function invalidatePackageCache(mtimes, cache, done) {
  assertExists(mtimes);

  invalidateModifiedFiles(mtimes, Object.keys(cache).map(packageFileForPackagePath), function(file) {
    delete cache[packagePathForPackageFile(file)];
  }, done)
}

var packagePathTrimLength = '/package.json'.length;

function packagePathForPackageFile(packageFilepath) {
  packageFilepath.slice(0, packageFilepath.length - packageFileTrimLength);
}

function packageFileForPackagePath(packagePath) {
  return path.join(packagePath, 'package.json');
}

module.exports = invalidatePackageCache;
