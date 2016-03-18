var assertExists = require('./assertExists');
var invalidateModifiedFiles = require('./invalidateModifiedFiles');
var packagePathForPackageFile = require('./packageFilePathUtils').packagePathForPackageFile;
var packageFileForPackagePath = require('./packageFilePathUtils').packageFileForPackagePath;

function invalidatePackageCache(mtimes, cache, done) {
  assertExists(mtimes);

  invalidateModifiedFiles(mtimes, Object.keys(cache).map(packageFileForPackagePath), function(file) {
    delete cache[packagePathForPackageFile(file)];
  }, done);
}


module.exports = invalidatePackageCache;
